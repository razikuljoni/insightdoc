/**
 * GET /api/v1/documents?workspaceId=... — document library listing
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/server/bootstrap';
import { DocumentDTOSchema, parseDocumentTags } from '@/lib/types';

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

    const documents = await db.document.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });

    const parsed = documents
      .map((d) =>
        DocumentDTOSchema.safeParse({
          id: d.id,
          title: d.title,
          fileName: d.fileName,
          fileSize: d.fileSize,
          pageCount: d.pageCount,
          status: d.status,
          progress: d.progress,
          statusDetail: d.statusDetail,
          errorMessage: d.errorMessage,
          chunkCount: d.chunkCount,
          tokenCount: d.tokenCount,
          starred: d.starred,
          ocrPages: d.ocrPages,
          tags: parseDocumentTags(d.tags),
          workspaceId: d.workspaceId,
          createdAt: d.createdAt.toISOString(),
          updatedAt: d.updatedAt.toISOString(),
        }),
      )
      .filter((r) => r.success)
      .map((r) => r.data);

    return NextResponse.json({ documents: parsed });
  } catch (error) {
    console.error('[GET /documents]', error);
    return NextResponse.json({ error: 'Failed to list documents' }, { status: 500 });
  }
}
