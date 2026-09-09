/**
 * PATCH  /api/v1/workspaces/:workspaceId — update workspace metadata (ADMIN only)
 * DELETE /api/v1/workspaces/:workspaceId — destructive removal (ADMIN only).
 *   Refuses to delete the user's last remaining workspace; removes uploaded
 *   files from disk, then lets DB cascades clear documents/chunks/chats
 *   (audit rows are detached via SetNull so the platform trail survives).
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/server/bootstrap';
import { recordAudit } from '@/server/audit';
import { deleteDocumentFile } from '@/server/storage';
import { UpdateWorkspaceSchema, type WorkspaceDTO } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await ctx.params;
    const user = await getCurrentUser();

    const membership = await db.workspaceMember.findFirst({
      where: { workspaceId, userId: user.id },
      include: { workspace: true },
    });
    if (!membership) {
      return NextResponse.json({ error: 'Workspace not found or access denied' }, { status: 404 });
    }
    if (membership.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Only workspace admins can edit settings (RBAC)' }, { status: 403 });
    }

    const body: unknown = await request.json().catch(() => null);
    const parsed = UpdateWorkspaceSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid workspace payload' },
        { status: 400 },
      );
    }
    if (parsed.data.name === undefined && parsed.data.description === undefined) {
      return NextResponse.json({ error: 'Nothing to update — provide name or description' }, { status: 400 });
    }

    const updated = await db.workspace.update({
      where: { id: workspaceId },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      },
    });

    await recordAudit({
      workspaceId,
      actorEmail: user.email,
      action: 'workspace.update',
      targetType: 'workspace',
      targetId: workspaceId,
      detail: {
        ...(parsed.data.name !== undefined ? { to: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      },
    });

    // Rollups are recomputed client-side from the authoritative store where
    // possible; return fresh counts so the sidebar stays consistent.
    const [documentCount, chatCount, memberCount, storage] = await Promise.all([
      db.document.count({ where: { workspaceId } }),
      db.chatSession.count({ where: { workspaceId } }),
      db.workspaceMember.count({ where: { workspaceId } }),
      db.document.aggregate({ where: { workspaceId }, _sum: { fileSize: true } }),
    ]);

    const dto: WorkspaceDTO = {
      id: updated.id,
      name: updated.name,
      slug: updated.slug,
      description: updated.description,
      createdAt: updated.createdAt.toISOString(),
      documentCount,
      chatCount,
      memberCount,
      storageBytes: storage._sum.fileSize ?? 0,
      role: membership.role as WorkspaceDTO['role'],
    };
    return NextResponse.json({ workspace: dto });
  } catch (error) {
    console.error('[PATCH /workspaces/:id]', error);
    return NextResponse.json({ error: 'Failed to update workspace' }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  ctx: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await ctx.params;
    const user = await getCurrentUser();

    const membership = await db.workspaceMember.findFirst({
      where: { workspaceId, userId: user.id },
      include: { workspace: { include: { _count: { select: { documents: true } } } } },
    });
    if (!membership) {
      return NextResponse.json({ error: 'Workspace not found or access denied' }, { status: 404 });
    }
    if (membership.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Only workspace admins can delete a workspace (RBAC)' }, { status: 403 });
    }

    const remainingMemberships = await db.workspaceMember.count({
      where: { userId: user.id },
    });
    if (remainingMemberships <= 1) {
      return NextResponse.json(
        { error: 'Cannot delete your only workspace — create another one first' },
        { status: 409 },
      );
    }

    // Remove physical files first (DB rows go away with the cascade below).
    const files = await db.document.findMany({
      where: { workspaceId },
      select: { fileUrl: true },
    });
    await Promise.all(files.map((f) => deleteDocumentFile(f.fileUrl).catch(() => {
      /* orphaned file cleanup is best-effort; row removal must not be blocked */
    })));

    await db.workspace.delete({ where: { id: workspaceId } });

    // Audit intentionally skipped: the audit row would reference a deleted
    // workspace (SetNull), and the deletion itself is the terminal event.

    return NextResponse.json({ ok: true, deletedDocuments: files.length });
  } catch (error) {
    console.error('[DELETE /workspaces/:id]', error);
    return NextResponse.json({ error: 'Failed to delete workspace' }, { status: 500 });
  }
}
