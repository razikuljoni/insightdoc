/**
 * GET /api/v1/activity?workspaceId=&limit= — workspace-scoped activity feed
 * Maps the audit trail to a friendly timeline for the Dashboard:
 * document uploads, renames, deletions, retries, chat queries and searches.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/server/bootstrap';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  workspaceId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export interface ActivityEvent {
  id: string;
  action: string;
  actorEmail: string;
  targetType: string;
  targetId: string | null;
  createdAt: string;
}

export async function GET(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    const parsed = QuerySchema.safeParse({
      workspaceId: request.nextUrl.searchParams.get('workspaceId') ?? '',
      limit: request.nextUrl.searchParams.get('limit') ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid query parameters' }, { status: 400 });
    }
    const { workspaceId, limit } = parsed.data;

    // RBAC: caller must be a member of the workspace
    const membership = await db.workspaceMember.findFirst({
      where: { userId: user.id, workspaceId },
      select: { id: true },
    });
    if (!membership) {
      return NextResponse.json({ error: 'Workspace not found or access denied' }, { status: 403 });
    }

    const logs = await db.auditLog.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    const events: ActivityEvent[] = logs.map((a) => ({
      id: a.id,
      action: a.action,
      actorEmail: a.actorEmail,
      targetType: a.targetType ?? 'unknown',
      targetId: a.targetId ?? null,
      createdAt: a.createdAt.toISOString(),
    }));

    return NextResponse.json({ events });
  } catch (error) {
    console.error('[GET /activity]', error);
    return NextResponse.json({ error: 'Failed to load activity' }, { status: 500 });
  }
}
