/**
 * POST /api/v1/chats/:sessionId/stream — RAG query with SSE streaming (spec §5.2)
 *
 * Pipeline: validate → persist user turn → hybrid retrieval (BM25 + cosine + RRF)
 * → prompt synthesis with strict grounding → z-ai LLM token stream → SSE frames
 * (citations → retrieval → token* → done) → persist assistant turn + usage ledger.
 *
 * SSE frame contract:
 *   event: citations   data: Citation[]
 *   event: retrieval   data: RetrievalInfo
 *   event: token       data: { delta }
 *   event: done        data: { messageId, totalTokens, latencyMs }
 *   event: error       data: { message, recoverable }
 */
import { db } from '@/lib/db';
import { getCurrentUser } from '@/server/bootstrap';
import { recordAudit, recordUsage } from '@/server/audit';
import { retrieve, type RetrievableChunkRow } from '@/server/rag/retriever';
import { StreamQuerySchema, type Citation, type SSEFrame } from '@/lib/types';
import { estimateTokens } from '@/lib/tokenizer';
import { getAIClient, getAIModel } from '@/server/ai';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const MEMORY_WINDOW = 10; // conversational memory depth (spec §2.3)
const CONTEXT_SNIPPET_CHARS = 1200;
const LLM_MODEL = getAIModel();

const SYSTEM_PROMPT = `You are InsightDoc, a rigorous enterprise document intelligence assistant.
You answer questions using ONLY the numbered context snippets retrieved from the user's document library.

Rules:
1. Ground every factual claim in the provided context. Cite sources inline immediately after the claim using bracketed markers like [1] or [2][3], matching the context numbers.
2. If the context does not contain the answer, say so plainly and suggest what document section might contain it. Never invent facts, figures, or page references.
3. Quote exact figures, clause numbers, dates, and defined terms verbatim when they appear in context.
4. Structure long answers with short paragraphs or bullet lists for scannability.
5. Be concise and precise: this is used by legal, financial, and engineering professionals.
6. When asked for summaries, lead with the key takeaway in one sentence.`;

function buildContextBlock(chunks: Array<{ id: string; content: string; pageNumber: number; documentTitle: string; metadata: { heading?: string } | null }>): string {
  return chunks
    .map((c, i) => {
      const heading = c.metadata?.heading ? ` — section "${c.metadata.heading}"` : '';
      const body = c.content.replace(/\s+/g, ' ').slice(0, CONTEXT_SNIPPET_CHARS);
      return `[${i + 1}] Document "${c.documentTitle}" (page ${c.pageNumber}${heading}):\n${body}`;
    })
    .join('\n\n');
}

function encodeFrame(frame: SSEFrame): string {
  return `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

/** Parse the z-ai SDK's OpenAI-compatible SSE body into content deltas. */
async function* iterateTokenDeltas(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are newline-delimited; be resilient to partial lines
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string | null } }>;
          };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) yield delta;
        } catch {
          // Skip malformed chunk — streaming must not crash on a bad frame
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await ctx.params;
  const startedAt = Date.now();

  const user = await getCurrentUser().catch(() => null);
  if (!user) return Response.json({ error: 'Session initialization failed' }, { status: 500 });

  const body: unknown = await request.json().catch(() => null);
  const parsed = StreamQuerySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'Invalid query payload', issues: parsed.error.flatten() }, { status: 400 });
  }
  const { message, documentIds, temperature } = parsed.data;

  const session = await db.chatSession.findUnique({
    where: { id: sessionId },
    include: { workspace: { include: { members: { where: { userId: user.id } } } } },
  });
  if (!session || session.workspace.members.length === 0) {
    return Response.json({ error: 'Chat session not found or access denied' }, { status: 404 });
  }
  const workspaceId = session.workspaceId;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (frame: SSEFrame) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(encodeFrame(frame)));
        } catch {
          // Client disconnected mid-stream — keep consuming/persisting the turn
          closed = true;
        }
      };
      const finish = () => {
        if (closed) return;
        try {
          controller.close();
        } catch {
          /* already closed by the runtime on client disconnect */
        }
        closed = true;
      };
      const fail = (msg: string, recoverable = false) => {
        send({ event: 'error', data: { message: msg, recoverable } });
        finish();
      };

      try {
        // ── 1. Persist the user turn ──────────────────────────────────────
        await db.chatMessage.create({
          data: { chatSessionId: sessionId, role: 'user', content: message },
        });

        const messageCount = await db.chatMessage.count({ where: { chatSessionId: sessionId } });
        if (messageCount === 1 && session.title === 'New Chat') {
          await db.chatSession.update({
            where: { id: sessionId },
            data: { title: message.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New Chat' },
          });
        }

        // ── 2. Fetch retrieval scope ──────────────────────────────────────
        const completedDocs = await db.document.findMany({
          where: {
            workspaceId,
            status: 'COMPLETED',
            ...(documentIds.length > 0 ? { id: { in: documentIds } } : {}),
          },
          select: { id: true, title: true },
        });

        const chunkRows: RetrievableChunkRow[] =
          completedDocs.length > 0
            ? (
                await db.documentChunk.findMany({
                  where: { documentId: { in: completedDocs.map((d) => d.id) } },
                  orderBy: [{ documentId: 'asc' }, { chunkIndex: 'asc' }],
                })
              ).map((c) => ({
                id: c.id,
                documentId: c.documentId,
                content: c.content,
                pageNumber: c.pageNumber,
                chunkIndex: c.chunkIndex,
                metadataJson: c.metadataJson,
                embeddingJson: c.embeddingJson,
                documentTitle: completedDocs.find((d) => d.id === c.documentId)?.title ?? 'Unknown document',
              }))
            : [];

        // ── 3. Hybrid retrieval + rerank ──────────────────────────────────
        const result = await retrieve(message, chunkRows, { finalTopK: 5 });
        send({ event: 'citations', data: result.citations });
        send({ event: 'retrieval', data: result.stats });

        await recordAudit({
          workspaceId,
          actorEmail: user.email,
          action: 'chat.query',
          targetType: 'chat',
          targetId: sessionId,
          detail: { questionChars: message.length, sources: result.citations.length },
        });

        // ── 4. Conversational memory + prompt synthesis ───────────────────
        const history = await db.chatMessage.findMany({
          where: { chatSessionId: sessionId },
          orderBy: { createdAt: 'desc' },
          take: MEMORY_WINDOW,
        });
        const historyTurns = [...history]
          .reverse()
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .slice(0, -1) // exclude the just-saved user turn; it's the final message
          .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content.slice(0, 1500) }));

        const contextBlock =
          result.chunks.length > 0
            ? buildContextBlock(result.chunks)
            : 'No indexed document content is available for this query.';

        const llmMessages = [
          { role: 'system' as const, content: SYSTEM_PROMPT },
          ...historyTurns,
          {
            role: 'user' as const,
            content: `Context snippets from the document library:\n\n${contextBlock}\n\n---\nUser question: ${message}`,
          },
        ];

        const promptTokens = llmMessages.reduce((sum, m) => sum + estimateTokens(m.content), 0);

        // ── 5. Stream LLM tokens ──────────────────────────────────────────
        const ai = await getAIClient();

        let completion: unknown;
        try {
          completion = await ai.chat.completions.create({
            model: LLM_MODEL,
            messages: llmMessages,
            temperature,
            stream: true,
            thinking: { type: 'disabled' },
          });
        } catch (llmError) {
          fail(
            `The answer service failed to start (${llmError instanceof Error ? llmError.message : 'unknown'}). Please retry.`,
            true,
          );
          return;
        }

        if (!(completion instanceof ReadableStream)) {
          // Non-streaming fallback: synthesize a token stream from the full text
          const full = (completion as { choices?: Array<{ message?: { content?: string } }> })
            ?.choices?.[0]?.message?.content;
          if (typeof full === 'string' && full.length > 0) {
            send({ event: 'token', data: { delta: full } });
            const totalTokens = promptTokens + estimateTokens(full);
            const saved = await db.chatMessage.create({
              data: {
                chatSessionId: sessionId,
                role: 'assistant',
                content: full,
                citationsJson: JSON.stringify(result.citations),
                retrievalInfoJson: JSON.stringify(result.stats),
                tokenUsage: totalTokens,
                latencyMs: Date.now() - startedAt,
              },
            });
            await recordUsage({
              userId: user.id,
              workspaceId,
              kind: 'chat',
              model: LLM_MODEL,
              promptTokens,
              completionTokens: estimateTokens(full),
            });
            send({
              event: 'done',
              data: { messageId: saved.id, totalTokens, latencyMs: Date.now() - startedAt },
            });
            finish();
            return;
          }
          fail('The answer service returned an empty response. Please retry.', true);
          return;
        }

        let answer = '';
        for await (const delta of iterateTokenDeltas(completion as ReadableStream<Uint8Array>)) {
          answer += delta;
          send({ event: 'token', data: { delta } });
        }

        if (answer.trim().length === 0) {
          fail('The answer stream ended without content. Please retry.', true);
          return;
        }

        // ── 6. Persist assistant turn + ledger ────────────────────────────
        const completionTokens = estimateTokens(answer);
        const totalTokens = promptTokens + completionTokens;
        const saved = await db.chatMessage.create({
          data: {
            chatSessionId: sessionId,
            role: 'assistant',
            content: answer,
            citationsJson: JSON.stringify(result.citations),
            retrievalInfoJson: JSON.stringify(result.stats),
            tokenUsage: totalTokens,
            latencyMs: Date.now() - startedAt,
          },
        });
        await db.chatSession.update({ where: { id: sessionId }, data: { updatedAt: new Date() } });
        await recordUsage({
          userId: user.id,
          workspaceId,
          kind: 'chat',
          model: LLM_MODEL,
          promptTokens,
          completionTokens,
        });

        send({
          event: 'done',
          data: { messageId: saved.id, totalTokens, latencyMs: Date.now() - startedAt },
        });
        finish();
      } catch (error) {
        console.error('[POST /chats/:id/stream]', error);
        fail(
          `Streaming failed: ${error instanceof Error ? error.message : 'unknown error'}`,
          true,
        );
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
