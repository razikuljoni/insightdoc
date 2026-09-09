/**
 * GET  /api/v1/chats?workspaceId=... — list sessions in a workspace
 * POST /api/v1/chats — create a new chat session (spec §2.3 conversational memory)
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/server/bootstrap';
import { recordAudit } from '@/server/audit';
import { z } from 'zod';
import type { ChatSessionDTO } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const user = await getCurrentUser();
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get('workspaceId');
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }

    const membership = await db.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId: user.id, workspaceId } },
    });
    if (!membership) {
      return NextResponse.json({ error: 'Workspace not found or access denied' }, { status: 404 });
    }

    const sessions = await db.chatSession.findMany({
      where: { workspaceId },
      include: { _count: { select: { messages: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });

    const dto: ChatSessionDTO[] = sessions.map((s) => ({
      id: s.id,
      title: s.title,
      workspaceId: s.workspaceId,
      pinnedAt: s.pinnedAt ? s.pinnedAt.toISOString() : null,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      messageCount: s._count.messages,
    }));

    return NextResponse.json({ chats: dto });
  } catch (error) {
    console.error('[GET /chats]', error);
    return NextResponse.json({ error: 'Failed to list chats' }, { status: 500 });
  }
}

const CreateChatSchema = z.object({
  workspaceId: z.string().min(1),
  title: z.string().max(120).optional(),
});

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    const body: unknown = await request.json();
    const parsed = CreateChatSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
    }

    const membership = await db.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId: user.id, workspaceId: parsed.data.workspaceId } },
    });
    if (!membership) {
      return NextResponse.json({ error: 'Workspace not found or access denied' }, { status: 404 });
    }

    const session = await db.chatSession.create({
      data: {
        workspaceId: parsed.data.workspaceId,
        userId: user.id,
        title: parsed.data.title ?? 'New Chat',
      },
    });

    await recordAudit({
      workspaceId: parsed.data.workspaceId,
      actorEmail: user.email,
      action: 'chat.create',
      targetType: 'chat',
      targetId: session.id,
    });

    const dto: ChatSessionDTO = {
      id: session.id,
      title: session.title,
      workspaceId: session.workspaceId,
      pinnedAt: session.pinnedAt ? session.pinnedAt.toISOString() : null,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      messageCount: 0,
    };
    return NextResponse.json({ chat: dto }, { status: 201 });
  } catch (error) {
    console.error('[POST /chats]', error);
    return NextResponse.json({ error: 'Failed to create chat' }, { status: 500 });
  }
}
