/**
 * GET  /api/v1/documents/:documentId/summary — cached AI digest (404 if none)
 * POST /api/v1/documents/:documentId/summary[?force=1] — generate/regenerate
 *
 * The digest is grounded in the document's own indexed chunks (ordered by
 * page → chunk, capped by a character budget) and returns a structured
 * payload: overview, key points, entities and suggested follow-up questions.
 * The result is cached on the Document row (summary/summaryAt/summaryModel)
 * and invalidated automatically when the document changes (updatedAt check).
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/server/bootstrap';
import { recordAudit, recordUsage } from '@/server/audit';
import { estimateTokens } from '@/lib/tokenizer';
import { DocumentSummaryPayloadSchema, DocumentSummaryResponseSchema, type DocumentSummaryResponse } from '@/lib/types';
import { getAIClient, getAIModel } from '@/server/ai';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const LLM_MODEL = getAIModel();
/** Character budget for the grounded context (~6k tokens). */
const MAX_CONTEXT_CHARS = 24_000;

function loadContext(
  chunks: Array<{ content: string; pageNumber: number; chunkIndex: number }>,
): { text: string; chunkCount: number; charCount: number; truncated: boolean } {
  const parts: string[] = [];
  let used = 0;
  let count = 0;
  for (const c of chunks) {
    const piece = `[page ${c.pageNumber}]\n${c.content.trim()}`;
    if (used + piece.length > MAX_CONTEXT_CHARS) break;
    parts.push(piece);
    used += piece.length;
    count++;
  }
  return { text: parts.join('\n\n'), chunkCount: count, charCount: used, truncated: count < chunks.length };
}

/** Map-reduce for oversized docs: ≤4 partial notes passes + a reduce pass. */
const MAP_PART_CHARS = 20_000;
const MAP_MAX_PARTS = 4;

function splitParts(
  chunks: Array<{ content: string; pageNumber: number; chunkIndex: number }>,
): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let used = 0;
  for (const c of chunks) {
    const piece = `[page ${c.pageNumber}]\n${c.content.trim()}`;
    if (used + piece.length > MAP_PART_CHARS && current.length > 0 && parts.length < MAP_MAX_PARTS - 1) {
      parts.push(current.join('\n\n'));
      current = [];
      used = 0;
    }
    current.push(piece);
    used += piece.length;
    if (parts.length === MAP_MAX_PARTS - 1 && used > MAP_PART_CHARS) break; // cap the last part
  }
  if (current.length > 0 && parts.length < MAP_MAX_PARTS) parts.push(current.join('\n\n'));
  return parts;
}

function extractJson(raw: string): unknown {
  const cleaned = raw.replace(/```json/gi, '```').trim();
  const fenced = /```([\s\S]*?)```/.exec(cleaned);
  const candidate = (fenced ? fenced[1] : cleaned).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Single plain-completion call (no streaming, thinking off). */
async function complete(prompt: string, system: string): Promise<string> {
  const ai = await getAIClient();
  const completion = (await ai.chat.completions.create({
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
    thinking: { type: 'disabled' },
  })) as { choices?: Array<{ message?: { content?: string } }> };
  return completion?.choices?.[0]?.message?.content ?? '';
}

async function generateDigest(context: string, title: string): Promise<unknown> {
  const ai = await getAIClient();

  const instruction = `You are InsightDoc's document analyst. Read the extracted passages of the document "${title}" below and produce a concise, strictly factual digest.

Return ONLY a JSON object with this exact shape:
{
  "overview": "2-3 sentence summary of what this document is and what it covers",
  "keyPoints": ["5-8 concrete facts, figures or commitments taken faithfully from the text"],
  "entities": ["up to 10 named organizations, people, products, standards or sections"],
  "suggestedQuestions": ["3 sharp questions an analyst should ask next about this document"]
}
Rules:
- Use only information present in the passages; never invent figures.
- Keep every string plain text (no markdown).
- If the passages are truncated, cover what is visible.

DOCUMENT PASSAGES:
${context}`;

  const messages: Array<{ role: 'system' | 'user'; content: string }> = [
    { role: 'system', content: 'You output strict JSON only. No prose, no code fences.' },
    { role: 'user', content: instruction },
  ];

  let completion: unknown;
  try {
    completion = await ai.chat.completions.create({
      model: LLM_MODEL,
      messages,
      temperature: 0.2,
      thinking: { type: 'disabled' },
    });
  } catch (error) {
    throw new Error(`Digest service failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }

  const raw =
    (completion as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message
      ?.content ?? '';
  return extractJson(typeof raw === 'string' ? raw : '');
}

async function requireDocument(documentId: string, userId: string) {
  return db.document.findUnique({
    where: { id: documentId },
    include: { workspace: { include: { members: { where: { userId } } } } },
  });
}

function buildResponse(
  documentId: string,
  summary: unknown,
  generatedAt: Date,
  model: string,
  basis: { chunkCount: number; charCount: number },
  cached: boolean,
): DocumentSummaryResponse {
  return DocumentSummaryResponseSchema.parse({
    documentId,
    summary,
    generatedAt: generatedAt.toISOString(),
    model,
    basis,
    cached,
  });
}

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ documentId: string }> },
) {
  try {
    const { documentId } = await ctx.params;
    const user = await getCurrentUser();
    const document = await requireDocument(documentId, user.id);
    if (!document || document.workspace.members.length === 0) {
      return NextResponse.json({ error: 'Document not found or access denied' }, { status: 404 });
    }
    if (!document.summary || !document.summaryAt) {
      return NextResponse.json({ error: 'No digest generated yet' }, { status: 404 });
    }
    let summary: unknown;
    try {
      summary = JSON.parse(document.summary);
    } catch {
      return NextResponse.json({ error: 'Cached digest is corrupt' }, { status: 500 });
    }
    const parsed = DocumentSummaryPayloadSchema.safeParse(summary);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Cached digest is corrupt' }, { status: 500 });
    }
    return NextResponse.json(
      buildResponse(
        document.id,
        parsed.data,
        document.summaryAt,
        document.summaryModel ?? LLM_MODEL,
        { chunkCount: document.chunkCount, charCount: 0 },
        true,
      ),
    );
  } catch (error) {
    console.error('[GET /documents/:id/summary]', error);
    return NextResponse.json({ error: 'Failed to load digest' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ documentId: string }> },
) {
  try {
    const { documentId } = await ctx.params;
    const user = await getCurrentUser();
    const document = await requireDocument(documentId, user.id);
    if (!document || document.workspace.members.length === 0) {
      return NextResponse.json({ error: 'Document not found or access denied' }, { status: 404 });
    }
    const role = document.workspace.members[0].role;
    if (role === 'VIEWER') {
      return NextResponse.json(
        { error: 'Viewers cannot generate digests (RBAC)' },
        { status: 403 },
      );
    }
    if (document.status !== 'COMPLETED' || document.chunkCount === 0) {
      return NextResponse.json(
        { error: 'Digest needs an indexed document — wait for ingestion to complete first' },
        { status: 409 },
      );
    }

    // Serve the cached digest unless the caller forces regeneration or the
    // document changed after the digest was produced (re-index/rename).
    const force = request.nextUrl.searchParams.get('force') === '1';
    const fresh = Boolean(
      document.summary && document.summaryAt && document.summaryAt.getTime() >= document.updatedAt.getTime(),
    );
    if (!force && fresh) {
      try {
        const cached = buildResponse(
          document.id,
          JSON.parse(document.summary as string),
          document.summaryAt as Date,
          document.summaryModel ?? LLM_MODEL,
          { chunkCount: document.chunkCount, charCount: 0 },
          true,
        );
        return NextResponse.json(cached);
      } catch {
        /* corrupt cache → fall through and regenerate */
      }
    }

    const chunks = await db.documentChunk.findMany({
      where: { documentId: document.id },
      orderBy: [{ pageNumber: 'asc' }, { chunkIndex: 'asc' }],
      select: { content: true, pageNumber: true, chunkIndex: true },
    });
    if (chunks.length === 0) {
      return NextResponse.json({ error: 'Document has no indexed content' }, { status: 409 });
    }

    const context = loadContext(chunks);
    const startedAt = Date.now();

    // Oversized docs (context truncated): map — per-part bullet notes, then
    // reduce — final digest from the notes plus the document's opening pages.
    let digestContext = context.text;
    if (context.truncated) {
      const parts = splitParts(chunks);
      const notes: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        const note = await complete(
          `Summarize this excerpt (part ${i + 1}/${parts.length}) of the document "${document.title}" into 5-8 terse bullet lines. Keep every figure, date, name and commitment. Plain text only.\n\n${parts[i]}`,
          'You are a precise document analyst. Output terse factual bullets only.',
        );
        notes.push(`[part ${i + 1} notes]\n${note.trim()}`);
        console.log(`[digest] mapped part ${i + 1}/${parts.length} of document ${documentId}`);
      }
      digestContext = `${notes.join('\n\n')}\n\n${context.text}`;
    }

    let payloadRaw: unknown = await generateDigest(digestContext, document.title);
    let parsed = DocumentSummaryPayloadSchema.safeParse(payloadRaw);
    if (!parsed.success) {
      // One strict retry — models occasionally wrap keys in prose.
      payloadRaw = await generateDigest(digestContext, document.title);
      parsed = DocumentSummaryPayloadSchema.safeParse(payloadRaw);
    }
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'The digest response was malformed — please try again' },
        { status: 502 },
      );
    }

    const generatedAt = new Date();
    await db.document.update({
      where: { id: document.id },
      data: {
        summary: JSON.stringify(parsed.data),
        summaryAt: generatedAt,
        summaryModel: LLM_MODEL,
      },
    });

    const promptTokens = estimateTokens(digestContext) + 120;
    const completionTokens =
      estimateTokens(parsed.data.overview)
      + parsed.data.keyPoints.reduce((s, k) => s + estimateTokens(k), 0)
      + parsed.data.entities.reduce((s, k) => s + estimateTokens(k), 0)
      + parsed.data.suggestedQuestions.reduce((s, k) => s + estimateTokens(k), 0);
    await recordUsage({
      userId: user.id,
      workspaceId: document.workspaceId,
      kind: 'chat',
      model: LLM_MODEL,
      promptTokens,
      completionTokens,
    });
    await recordAudit({
      workspaceId: document.workspaceId,
      actorEmail: user.email,
      action: 'document.summary',
      targetType: 'document',
      targetId: document.id,
      detail: {
        chunks: context.chunkCount,
        latencyMs: Date.now() - startedAt,
        cached: false,
      },
    });

    return NextResponse.json(
      buildResponse(
        document.id,
        parsed.data,
        generatedAt,
        LLM_MODEL,
        { chunkCount: context.chunkCount, charCount: context.charCount },
        false,
      ),
    );
  } catch (error) {
    console.error('[POST /documents/:id/summary]', error);
    return NextResponse.json({ error: 'Failed to generate digest' }, { status: 500 });
  }
}
