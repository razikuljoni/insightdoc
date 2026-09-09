/**
 * GET /api/v1/documents/:documentId/chunks — paginated chunk inspector
 * Powers the document detail dialog (view exactly what the index holds).
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/server/bootstrap';

export const dynamic = 'force-dynamic';

const CHUNK_PREVIEW_CHARS = 600;

export async function GET(
  request: Request,
  ctx: { params: Promise<{ documentId: string }> },
) {
  try {
    const { documentId } = await ctx.params;
    const user = await getCurrentUser();
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);
    const pageSize = Math.min(50, Math.max(1, Number(searchParams.get('pageSize') ?? '20') || 20));

    const document = await db.document.findUnique({
      where: { id: documentId },
      include: { workspace: { include: { members: { where: { userId: user.id } } } } },
    });
    if (!document || document.workspace.members.length === 0) {
      return NextResponse.json({ error: 'Document not found or access denied' }, { status: 404 });
    }

    const [total, chunks] = await Promise.all([
      db.documentChunk.count({ where: { documentId } }),
      db.documentChunk.findMany({
        where: { documentId },
        orderBy: { chunkIndex: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          pageNumber: true,
          chunkIndex: true,
          content: true,
          metadataJson: true,
        },
      }),
    ]);

    return NextResponse.json({
      total,
      page,
      pageSize,
      chunks: chunks.map((c) => {
        let heading: string | null = null;
        let tokenCount: number | null = null;
        try {
          if (c.metadataJson) {
            const meta = JSON.parse(c.metadataJson) as { heading?: string; tokenCount?: number };
            heading = meta.heading ?? null;
            tokenCount = meta.tokenCount ?? null;
          }
        } catch {
          /* malformed metadata — ignore */
        }
        return {
          id: c.id,
          pageNumber: c.pageNumber,
          chunkIndex: c.chunkIndex,
          heading,
          tokenCount,
          preview:
            c.content.length > CHUNK_PREVIEW_CHARS
              ? `${c.content.slice(0, CHUNK_PREVIEW_CHARS).trimEnd()}…`
              : c.content,
        };
      }),
    });
  } catch (error) {
    console.error('[GET /documents/:id/chunks]', error);
    return NextResponse.json({ error: 'Failed to load chunks' }, { status: 500 });
  }
}
