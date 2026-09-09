/**
 * GET /api/v1/documents/:documentId/status — ingestion status polling (spec §5.1)
 * Response: { status, progress, pageCount, chunkCount, errorMessage }
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/server/bootstrap';
import { getQueue } from '@/server/queue';

export const dynamic = 'force-dynamic';

export async function GET(
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

    const queue = await getQueue();
    const queueJob = queue.getActiveByDocumentId(documentId);

    return NextResponse.json({
      status: document.status,
      progress: document.progress,
      statusDetail: document.statusDetail,
      pageCount: document.pageCount,
      chunkCount: document.chunkCount,
      tokenCount: document.tokenCount,
      errorMessage: document.errorMessage,
      queued: Boolean(queueJob),
    });
  } catch (error) {
    console.error('[GET /documents/:id/status]', error);
    return NextResponse.json({ error: 'Failed to fetch status' }, { status: 500 });
  }
}
