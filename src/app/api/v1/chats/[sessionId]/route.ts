/**
 * GET    /api/v1/chats/:sessionId — full message history (with citations)
 * PATCH  /api/v1/chats/:sessionId — rename session (ADMIN|MEMBER)
 * DELETE /api/v1/chats/:sessionId — delete session
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/server/bootstrap';
import { recordAudit } from '@/server/audit';
import { ChatMessageDTOSchema, UpdateChatSchema } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET(
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
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!session || session.workspace.members.length === 0) {
      return NextResponse.json({ error: 'Chat session not found or access denied' }, { status: 404 });
    }

    const messages = session.messages
      .map((m) => {
        let citations: unknown = null;
        if (m.citationsJson) {
          try {
            const arr: unknown = JSON.parse(m.citationsJson);
            if (Array.isArray(arr)) citations = arr;
          } catch {
            citations = null;
          }
        }
        let retrievalInfo: unknown = null;
        if (m.retrievalInfoJson) {
          try {
            retrievalInfo = JSON.parse(m.retrievalInfoJson);
          } catch {
            retrievalInfo = null;
          }
        }
        return ChatMessageDTOSchema.safeParse({
          id: m.id,
          role: m.role,
          content: m.content,
          citations: citations ? citations : null,
          tokenUsage: m.tokenUsage,
          latencyMs: m.latencyMs,
          retrievalInfo,
          feedback: m.feedback === 'UP' || m.feedback === 'DOWN' ? m.feedback : null,
          createdAt: m.createdAt.toISOString(),
        });
      })
      .filter((r) => r.success)
      .map((r) => r.data);

    return NextResponse.json({
      session: {
        id: session.id,
        title: session.title,
        workspaceId: session.workspaceId,
        pinnedAt: session.pinnedAt ? session.pinnedAt.toISOString() : null,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
        messageCount: messages.length,
      },
      messages,
    });
  } catch (error) {
    console.error('[GET /chats/:id]', error);
    return NextResponse.json({ error: 'Failed to load chat' }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ sessionId: string }> },
) {
  try {
    const { sessionId } = await ctx.params;
    const user = await getCurrentUser();

    const body: unknown = await request.json().catch(() => null);
    const parsedBody = UpdateChatSchema.safeParse(body);
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: parsedBody.error.issues[0]?.message ?? 'Invalid update payload' },
        { status: 400 },
      );
    }

    const session = await db.chatSession.findUnique({
      where: { id: sessionId },
      include: { workspace: { include: { members: { where: { userId: user.id } } } } },
    });
    if (!session || session.workspace.members.length === 0) {
      return NextResponse.json({ error: 'Chat session not found or access denied' }, { status: 404 });
    }
    const role = session.workspace.members[0].role;
    if (role === 'VIEWER') {
      return NextResponse.json({ error: 'Viewers cannot edit chats (RBAC)' }, { status: 403 });
    }

    const { title, pinned } = parsedBody.data;
    const updated = await db.chatSession.update({
      where: { id: sessionId },
      data: {
        ...(title !== undefined ? { title } : {}),
        ...(pinned !== undefined ? { pinnedAt: pinned ? new Date() : null } : {}),
      },
    });

    if (title !== undefined) {
      await recordAudit({
        workspaceId: session.workspaceId,
        actorEmail: user.email,
        action: 'chat.rename',
        targetType: 'chat_session',
        targetId: sessionId,
        detail: { to: title },
      });
    }
    if (pinned !== undefined) {
      await recordAudit({
        workspaceId: session.workspaceId,
        actorEmail: user.email,
        action: pinned ? 'chat.pin' : 'chat.unpin',
        targetType: 'chat_session',
        targetId: sessionId,
      });
    }

    const messageCount = await db.chatMessage.count({ where: { chatSessionId: sessionId } });
    return NextResponse.json({
      chat: {
        id: updated.id,
        title: updated.title,
        workspaceId: updated.workspaceId,
        pinnedAt: updated.pinnedAt ? updated.pinnedAt.toISOString() : null,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
        messageCount,
      },
    });
  } catch (error) {
    console.error('[PATCH /chats/:id]', error);
    return NextResponse.json({ error: 'Failed to update chat' }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  ctx: { params: Promise<{ sessionId: string }> },
) {
  try {
    const { sessionId } = await ctx.params;
    const user = await getCurrentUser();

    const session = await db.chatSession.findUnique({
      where: { id: sessionId },
      include: { workspace: { include: { members: { where: { userId: user.id } } } } },
    });
    if (!session || session.workspace.members.length === 0) {
      return NextResponse.json({ error: 'Chat session not found or access denied' }, { status: 404 });
    }

    await db.chatSession.delete({ where: { id: sessionId } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[DELETE /chats/:id]', error);
    return NextResponse.json({ error: 'Failed to delete chat' }, { status: 500 });
  }
}
