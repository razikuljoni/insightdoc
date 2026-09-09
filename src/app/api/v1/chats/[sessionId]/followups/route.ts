/**
 * POST /api/v1/chats/:sessionId/followups — LLM-generated suggested questions
 *
 * Reads the most recent user/assistant exchange of the session and asks the
 * model to propose exactly 3 short, document-grounded follow-up questions.
 * Best-effort by design: the client silently hides the feature on failure.
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/server/bootstrap';
import { FollowupsResponseSchema } from '@/lib/types';
import { getZAI } from '@/server/zai';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const LLM_MODEL = 'insightdoc-llm';

const FOLLOWUP_PROMPT = `You suggest follow-up questions for an enterprise document Q&A assistant.
Given the latest exchange between a user and the assistant, propose exactly 3 follow-up questions the user might naturally ask next.
Rules:
- Each question must be answerable from the SAME document library already retrieved in this conversation.
- Reference concrete topics, figures, sections or documents mentioned in the conversation when possible.
- Each question must be a single sentence, max 90 characters, ending with a question mark.
- Output ONLY a JSON array of exactly 3 strings. No markdown, no commentary.`;

export async function POST(
  _request: Request,
  ctx: { params: Promise<{ sessionId: string }> },
) {
  try {
    const { sessionId } = await ctx.params;
    const user = await getCurrentUser();

    const session = await db.chatSession.findUnique({
      where: { id: sessionId },
      include: {
        workspace: { include: { members: { where: { userId: user.id } } } },
      },
    });
    if (!session || session.workspace.members.length === 0) {
      return NextResponse.json({ error: 'Chat session not found or access denied' }, { status: 404 });
    }

    const recent = await db.chatMessage.findMany({
      where: { chatSessionId: sessionId },
      orderBy: { createdAt: 'desc' },
      take: 4,
    });
    const ordered = [...recent].reverse().filter((m) => m.role !== 'system');
    const hasAssistant = ordered.some((m) => m.role === 'assistant');
    if (!hasAssistant) {
      return NextResponse.json({ error: 'No answer to follow up on yet' }, { status: 409 });
    }

    const transcript = ordered
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.replace(/\s+/g, ' ').slice(0, 1200)}`)
      .join('\n\n');

    const zai = await getZAI();

    const completion = await zai.chat.completions.create({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: FOLLOWUP_PROMPT },
        { role: 'user', content: `Latest exchange in the conversation:\n\n${transcript}` },
      ],
      temperature: 0.7,
      stream: false,
      thinking: { type: 'disabled' },
    });

    const raw =
      (completion as { choices?: Array<{ message?: { content?: string } }> })
        ?.choices?.[0]?.message?.content ?? '';

    // Robust JSON extraction — models occasionally wrap arrays in prose/fences
    const jsonMatch = /\[[\s\S]*\]/.exec(raw);
    let suggestions: string[] = [];
    if (jsonMatch) {
      try {
        const parsed: unknown = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed)) {
          suggestions = parsed
            .filter((s): s is string => typeof s === 'string')
            .map((s) => s.replace(/\s+/g, ' ').trim())
            .filter((s) => s.length > 0 && s.length <= 140)
            .slice(0, 3);
        }
      } catch {
        // fall through to line-based extraction below
      }
    }
    if (suggestions.length === 0) {
      suggestions = raw
        .split('\n')
        .map((l) => l.replace(/^[-*\d.\s"'`]+|["'`]+$/g, '').trim())
        .filter((l) => l.length > 8 && l.includes('?'))
        .slice(0, 3);
    }

    if (suggestions.length === 0) {
      return NextResponse.json({ error: 'Could not generate suggestions' }, { status: 502 });
    }

    return NextResponse.json(FollowupsResponseSchema.parse({ suggestions }));
  } catch (error) {
    console.error('[POST /chats/:id/followups]', error);
    return NextResponse.json({ error: 'Failed to generate follow-ups' }, { status: 500 });
  }
}
