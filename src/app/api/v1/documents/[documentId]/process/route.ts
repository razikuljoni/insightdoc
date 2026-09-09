/**
 * POST /api/v1/documents/:documentId/process — (re)trigger ingestion (spec §5.1)
 * Used for retrying FAILED documents or re-embedding after a pipeline change.
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/server/bootstrap';
import { recordAudit } from '@/server/audit';
import { getQueue } from '@/server/queue';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(
  _request: Request,
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
    if (document.workspace.members[0].role === 'VIEWER') {
      return NextResponse.json({ error: 'Viewers cannot trigger processing (RBAC)' }, { status: 403 });
    }
    if (document.status === 'PROCESSING') {
      return NextResponse.json({ error: 'Document is already processing' }, { status: 409 });
    }

    await db.document.update({
      where: { id: documentId },
      data: { status: 'PENDING', progress: 0, errorMessage: null },
    });

    const queue = await getQueue();
    const job = queue.enqueue('document.process', {
      documentId,
      workspaceId: document.workspaceId,
      userId: user.id,
    });

    await recordAudit({
      workspaceId: document.workspaceId,
      actorEmail: user.email,
      action: 'document.reprocess',
      targetType: 'document',
      targetId: documentId,
    });

    return NextResponse.json({ message: 'Processing started', jobId: job.id });
  } catch (error) {
    console.error('[POST /documents/:id/process]', error);
    return NextResponse.json({ error: 'Failed to start processing' }, { status: 500 });
  }
}
