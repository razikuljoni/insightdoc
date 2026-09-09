/**
 * GET /api/v1/documents/:documentId/file — stream the stored PDF
 * Supports HTTP Range requests so pdf.js can fetch incrementally.
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/server/bootstrap';
import { readDocumentFile } from '@/server/storage';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
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

    const bytes = await readDocumentFile(document.fileUrl);
    const total = bytes.byteLength;
    const range = request.headers.get('range');

    const baseHeaders: Record<string, string> = {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${encodeURIComponent(document.fileName)}"`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
    };

    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      if (match) {
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
        if (start <= end && start < total) {
          const slice = bytes.subarray(start, end + 1);
          return new NextResponse(new Uint8Array(slice), {
            status: 206,
            headers: {
              ...baseHeaders,
              'Content-Range': `bytes ${start}-${end}/${total}`,
              'Content-Length': String(slice.byteLength),
            },
          });
        }
      }
    }

    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(total) },
    });
  } catch (error) {
    console.error('[GET /documents/:id/file]', error);
    return NextResponse.json({ error: 'File not available' }, { status: 404 });
  }
}
