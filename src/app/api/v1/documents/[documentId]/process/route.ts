/**
 * POST /api/v1/documents/:documentId/process — (re)trigger ingestion (spec §5.1)
 * Used for retrying FAILED documents or re-embedding after a pipeline change.
 */
import { NextResponse, after } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/server/bootstrap';
import { recordAudit } from '@/server/audit';

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
    // A PROCESSING doc whose updatedAt is >10 min old has no live job:
    // on Vercel the in-process queue used to freeze with the function, so
    // such docs were stuck forever and this endpoint refused them (409).
    // Legit processing (text PDFs: seconds, OCR: <60s) never takes 10 min.
    if (document.status === 'PROCESSING') {
      const stale = Date.now() - document.updatedAt.getTime() > 10 * 60 * 1000;
      if (!stale) {
        return NextResponse.json({ error: 'Document is already processing' }, { status: 409 });
      }
    }

    await db.document.update({
      where: { id: documentId },
      data: { status: 'PENDING', progress: 0, errorMessage: null },
    });

    // Same fix as the upload route: run in `after()` so Vercel keeps the
    // function alive until ingestion finishes, instead of freezing a
    // fire-and-forget queue job. Note: this only helps docs whose file
    // still exists — a doc whose /tmp file died with its upload invocation
    // will fail here with "file not found" and be marked FAILED; delete
    // and re-upload those instead.
    after(async () => {
      try {
        const { processDocumentJob } = await import('@/server/worker/document-processor');
        await processDocumentJob({
          documentId,
          workspaceId: document.workspaceId,
          userId: user.id,
        });
      } catch (error) {
        console.error(`[after reprocess] document ${documentId} failed:`, error);
      }
    });

    await recordAudit({
      workspaceId: document.workspaceId,
      actorEmail: user.email,
      action: 'document.reprocess',
      targetType: 'document',
      targetId: documentId,
    });

    return NextResponse.json({
      message: 'Processing started',
      jobId: `document.process:${documentId}:${Date.now()}`,
    });
  } catch (error) {
    console.error('[POST /documents/:id/process]', error);
    return NextResponse.json({ error: 'Failed to start processing' }, { status: 500 });
  }
}
