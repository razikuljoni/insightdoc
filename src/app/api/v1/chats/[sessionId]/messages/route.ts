/**
 * PATCH  /api/v1/chats/:sessionId/messages — set/clear a quality signal (👍/👎)
 *        on an assistant answer. Body: { messageId, feedback: 'UP'|'DOWN'|null }.
 *        Feedback is an annotation, not a content edit, so every workspace role
 *        (incl. VIEWER) may submit it; toggling the same value clears it client-
 *        side by sending null.
 * DELETE /api/v1/chats/:sessionId/messages?fromMessageId=<id>&keepAnchor=<bool>
 *        Truncates a conversation turn: removes the referenced message AND every
 *        message created after it. Powers "Regenerate answer".
 *
 * Ordering uses (createdAt, id) because messages in one session can share
 * second-resolution timestamps; `id` breaks ties deterministically.
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/server/bootstrap';
import { recordAudit } from '@/server/audit';
import { SetMessageFeedbackSchema } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** Resolve the session for `sessionId` and assert `user` is a member. */
async function requireSessionMember(sessionId: string, userId: string) {
  return db.chatSession.findUnique({
    where: { id: sessionId },
    include: { workspace: { include: { members: { where: { userId } } } } },
  });
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ sessionId: string }> },
) {
  try {
    const { sessionId } = await ctx.params;
    const user = await getCurrentUser();

    const body: unknown = await request.json().catch(() => null);
    const parsed = SetMessageFeedbackSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid feedback payload' },
        { status: 400 },
      );
    }

    const session = await requireSessionMember(sessionId, user.id);
    if (!session || session.workspace.members.length === 0) {
      return NextResponse.json({ error: 'Chat session not found or access denied' }, { status: 404 });
    }

    const message = await db.chatMessage.findFirst({
      where: { id: parsed.data.messageId, chatSessionId: sessionId },
    });
    if (!message) {
      return NextResponse.json({ error: 'Message not found in this session' }, { status: 404 });
    }
    if (message.role !== 'assistant') {
      return NextResponse.json({ error: 'Feedback can only be set on assistant answers' }, { status: 400 });
    }

    const updated = await db.chatMessage.update({
      where: { id: message.id },
      data: { feedback: parsed.data.feedback },
    });

    // Audit only meaningful transitions (not every toggle-off spam).
    if (parsed.data.feedback !== null) {
      await recordAudit({
        workspaceId: session.workspaceId,
        actorEmail: user.email,
        action: 'message.feedback',
        targetType: 'chat_message',
        targetId: message.id,
        detail: { feedback: parsed.data.feedback, sessionId },
      });
    }

    return NextResponse.json({ ok: true, messageId: updated.id, feedback: updated.feedback });
  } catch (error) {
    console.error('[PATCH /chats/:id/messages]', error);
    return NextResponse.json({ error: 'Failed to set message feedback' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ sessionId: string }> },
) {
  try {
    const { sessionId } = await ctx.params;
    const user = await getCurrentUser();

    const url = new URL(request.url);
    const fromMessageId = url.searchParams.get('fromMessageId');
    if (!fromMessageId) {
      return NextResponse.json({ error: 'fromMessageId query parameter is required' }, { status: 400 });
    }
    const keepAnchor = url.searchParams.get('keepAnchor') !== 'false';

    const session = await requireSessionMember(sessionId, user.id);
    if (!session || session.workspace.members.length === 0) {
      return NextResponse.json({ error: 'Chat session not found or access denied' }, { status: 404 });
    }
    const role = session.workspace.members[0].role;
    if (role === 'VIEWER') {
      return NextResponse.json({ error: 'Viewers cannot modify chats (RBAC)' }, { status: 403 });
    }

    const anchor = await db.chatMessage.findFirst({
      where: { id: fromMessageId, chatSessionId: sessionId },
    });
    if (!anchor) {
      return NextResponse.json({ error: 'Message not found in this session' }, { status: 404 });
    }

    // Order the full session, find the anchor, then cut the tail.
    const messages = await db.chatMessage.findMany({
      where: { chatSessionId: sessionId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    const anchorIdx = messages.findIndex((m) => m.id === fromMessageId);
    if (anchorIdx === -1) {
      return NextResponse.json({ error: 'Message ordering failed' }, { status: 500 });
    }

    const cutoff = keepAnchor ? anchorIdx : anchorIdx + 1;
    const toDelete = messages.slice(cutoff).map((m) => m.id);

    if (toDelete.length > 0) {
      await db.chatMessage.deleteMany({ where: { id: { in: toDelete } } });
      await db.chatSession.update({
        where: { id: sessionId },
        data: { updatedAt: new Date() },
      });

      await recordAudit({
        workspaceId: session.workspaceId,
        actorEmail: user.email,
        action: 'chat.truncate',
        targetType: 'chat_session',
        targetId: sessionId,
        detail: { fromMessageId, keepAnchor, removed: toDelete.length },
      });
    }

    return NextResponse.json({ ok: true, removed: toDelete.length });
  } catch (error) {
    console.error('[DELETE /chats/:id/messages]', error);
    return NextResponse.json({ error: 'Failed to truncate messages' }, { status: 500 });
  }
}
