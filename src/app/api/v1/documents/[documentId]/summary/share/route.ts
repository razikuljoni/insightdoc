/**
 * POST /api/v1/documents/:documentId/summary/share — post the cached AI digest
 * into a chat as a persisted 'note' message (role='note').
 *
 * Notes are visible, copyable conversation artifacts that do NOT pollute the
 * LLM transcript (the stream route only feeds user/assistant roles back to
 * the model). A new session titled "Digest — <doc title>" is created when no
 * sessionId is provided. Every workspace member (incl. VIEWER) may share —
 * this is an annotation-style action, not content mutation.
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/server/bootstrap';
import { recordAudit } from '@/server/audit';
import {
  ChatMessageDTOSchema,
  ChatSessionDTOSchema,
  DigestNoteContentSchema,
  ShareDigestSchema,
} from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  ctx: { params: Promise<{ documentId: string }> },
) {
  try {
    const { documentId } = await ctx.params;
    const user = await getCurrentUser();

    const document = await db.document.findUnique({
      where: { id: documentId },
      include: { workspace: { include: { members: { where: { userId: user.id } } } } },
    });
    if (!document || document.workspace.members.length === 0) {
      return NextResponse.json({ error: 'Document not found or access denied' }, { status: 404 });
    }

    const body: unknown = await request.json().catch(() => ({}));
    const parsedBody = ShareDigestSchema.safeParse(body ?? {});
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: parsedBody.error.issues[0]?.message ?? 'Invalid share payload' },
        { status: 400 },
      );
    }

    // Digest must exist (cached) — we share the analyst artifact, not regenerate.
    if (!document.summary || !document.summaryAt) {
      return NextResponse.json(
        { error: 'No digest to share yet — generate one in the document inspector first' },
        { status: 409 },
      );
    }
    let digest: unknown;
    try {
      digest = JSON.parse(document.summary);
    } catch {
      return NextResponse.json({ error: 'Cached digest is corrupt — regenerate it first' }, { status: 500 });
    }
    const digestParsed = DigestNoteContentSchema.shape.digest.safeParse(digest);
    if (!digestParsed.success) {
      return NextResponse.json({ error: 'Cached digest is corrupt — regenerate it first' }, { status: 500 });
    }

    // Target session: explicit (same workspace, member-visible) or fresh.
    let session: {
      id: string;
      title: string;
      workspaceId: string;
      pinnedAt: Date | null;
      createdAt: Date;
    } | null = null;
    let createdChat = false;
    if (parsedBody.data.sessionId) {
      const found = await db.chatSession.findUnique({
        where: { id: parsedBody.data.sessionId },
        include: { workspace: { include: { members: { where: { userId: user.id } } } } },
      });
      if (!found || found.workspace.members.length === 0) {
        return NextResponse.json({ error: 'Chat session not found or access denied' }, { status: 404 });
      }
      if (found.workspaceId !== document.workspaceId) {
        return NextResponse.json(
          { error: 'Target chat belongs to a different workspace — open it there and retry' },
          { status: 400 },
        );
      }
      session = {
        id: found.id,
        title: found.title,
        workspaceId: found.workspaceId,
        pinnedAt: found.pinnedAt,
        createdAt: found.createdAt,
      };
    } else {
      const title = `Digest — ${document.title}`.slice(0, 120);
      const created = await db.chatSession.create({
        data: {
          title,
          workspaceId: document.workspaceId,
          userId: user.id,
        },
      });
      createdChat = true;
      session = {
        id: created.id,
        title: created.title,
        workspaceId: created.workspaceId,
        pinnedAt: created.pinnedAt,
        createdAt: created.createdAt,
      };
      await recordAudit({
        workspaceId: document.workspaceId,
        actorEmail: user.email,
        action: 'chat.create',
        targetType: 'chat_session',
        targetId: session.id,
      });
    }

    const noteContent = DigestNoteContentSchema.parse({
      kind: 'digest' as const,
      documentId: document.id,
      documentTitle: document.title,
      digest: digestParsed.data,
      model: document.summaryModel ?? 'insightdoc-llm',
      generatedAt: (document.summaryAt ?? new Date()).toISOString(),
    });

    const message = await db.chatMessage.create({
      data: {
        chatSessionId: session.id,
        role: 'note',
        content: JSON.stringify(noteContent),
      },
    });
    await db.chatSession.update({
      where: { id: session.id },
      data: { updatedAt: new Date() },
    });

    await recordAudit({
      workspaceId: document.workspaceId,
      actorEmail: user.email,
      action: 'digest.share',
      targetType: 'document',
      targetId: document.id,
      detail: { sessionId: session.id, createdChat },
    });

    const messageCount = await db.chatMessage.count({ where: { chatSessionId: session.id } });
    const chatDto = ChatSessionDTOSchema.parse({
      id: session.id,
      title: session.title,
      workspaceId: session.workspaceId,
      pinnedAt: session.pinnedAt ? session.pinnedAt.toISOString() : null,
      createdAt: session.createdAt.toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount,
    });
    const messageDto = ChatMessageDTOSchema.parse({
      id: message.id,
      role: 'note',
      content: message.content,
      citations: null,
      tokenUsage: null,
      latencyMs: null,
      retrievalInfo: null,
      feedback: null,
      createdAt: message.createdAt.toISOString(),
    });

    return NextResponse.json({ chat: chatDto, message: messageDto, createdChat });
  } catch (error) {
    console.error('[POST /documents/:id/summary/share]', error);
    return NextResponse.json({ error: 'Failed to share digest' }, { status: 500 });
  }
}
