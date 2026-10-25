/**
 * POST /api/v1/workspaces/:workspaceId/documents/upload (spec §5.1, adapted)
 *
 * Sandbox adaptation of the presigned-URL flow: the client uploads multipart
 * directly to this route, which persists the PDF to local object storage,
 * creates the Document row (PENDING), and enqueues an ingestion job.
 * Response shape mirrors the spec: { documentId, fileKey }.
 */
import { NextResponse, after } from 'next/server';
import { createHash } from 'crypto';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/server/bootstrap';
import { recordAudit } from '@/server/audit';
import { writeDocumentFile } from '@/server/storage';
import { MAX_FILE_SIZE_BYTES, parseDocumentTags, type DocumentDTO } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"

function looksLikePdf(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && PDF_MAGIC.every((b, i) => bytes[i] === b);
}

function toDto(d: {
  id: string; title: string; fileName: string; fileSize: number; pageCount: number;
  status: string; progress: number; statusDetail: string | null; errorMessage: string | null;
  chunkCount: number;
  tokenCount: number; starred: boolean; ocrPages: number; tags: string | null;
  workspaceId: string; createdAt: Date; updatedAt: Date;
}): DocumentDTO {
  return {
    id: d.id, title: d.title, fileName: d.fileName, fileSize: d.fileSize,
    pageCount: d.pageCount, status: d.status as DocumentDTO['status'], progress: d.progress,
    statusDetail: d.statusDetail, errorMessage: d.errorMessage, chunkCount: d.chunkCount,
    tokenCount: d.tokenCount,
    starred: d.starred, ocrPages: d.ocrPages, tags: parseDocumentTags(d.tags),
    workspaceId: d.workspaceId,
    createdAt: d.createdAt.toISOString(), updatedAt: d.updatedAt.toISOString(),
  };
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await ctx.params;
    const user = await getCurrentUser();

    // RBAC check (spec §2.1) — MEMBER and above may upload
    const membership = await db.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId: user.id, workspaceId } },
    });
    if (!membership) {
      return NextResponse.json({ error: 'Workspace not found or access denied' }, { status: 404 });
    }
    if (membership.role === 'VIEWER') {
      return NextResponse.json({ error: 'Viewers cannot upload documents (RBAC)' }, { status: 403 });
    }

    const formData = await request.formData();
    const files = formData.getAll('files').filter((f): f is File => f instanceof File);
    const single = formData.get('file');
    if (single instanceof File) files.push(single);

    if (files.length === 0) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 });
    }

    const created: DocumentDTO[] = [];
    const errors: Array<{ fileName: string; error: string }> = [];

    for (const file of files) {
      let createdDocId: string | null = null;
      try {
        if (file.size === 0) throw new Error('File is empty');
        if (file.size > MAX_FILE_SIZE_BYTES) {
          throw new Error(`File exceeds the 50MB limit (got ${Math.round(file.size / 1024 / 1024)}MB)`);
        }

        const bytes = Buffer.from(await file.arrayBuffer());
        if (!looksLikePdf(bytes)) {
          throw new Error('Invalid file: only real PDF documents are accepted');
        }

        // Content-hash de-dup: reject exact re-uploads that are already queued,
        // indexing or indexed. FAILED documents are allowed through so users can
        // retry a broken upload by simply uploading the file again.
        const checksum = createHash('sha256').update(bytes).digest('hex');
        const duplicate = await db.document.findFirst({
          where: {
            workspaceId,
            checksum,
            status: { not: 'FAILED' },
          },
          select: { id: true, title: true, status: true },
        });
        if (duplicate) {
          throw new Error(
            `Duplicate: this file's content already exists as "${duplicate.title}" (${duplicate.status.toLowerCase()}) — nothing re-indexed`,
          );
        }

        const title = file.name.replace(/\.pdf$/i, '').slice(0, 180) || 'Untitled document';
        const doc = await db.document.create({
          data: {
            title,
            fileName: file.name,
            fileSize: file.size,
            fileUrl: 'pending',
            mimeType: file.type || 'application/pdf',
            status: 'PENDING',
            progress: 0,
            checksum,
            workspaceId,
          },
        });

        createdDocId = doc.id;
        const { key } = await writeDocumentFile(doc.id, bytes);
        await db.document.update({ where: { id: doc.id }, data: { fileUrl: key } });

        // Run ingestion in `after()`, not in a fire-and-forget in-process
        // queue. On Vercel the function is frozen as soon as this route
        // returns 201, so a background queue job is suspended mid-flight
        // and the document stays PROCESSING forever (seen live: one doc
        // stuck at 2%, another at 32%, no error, no progress for hours).
        // `after()` keeps the function alive until the job finishes, in
        // the SAME invocation — which also matters because the file lives
        // in that invocation's /tmp. processDocumentJob already marks the
        // doc FAILED with the real error if it throws.
        after(async () => {
          try {
            const { processDocumentJob } = await import('@/server/worker/document-processor');
            await processDocumentJob({ documentId: doc.id, workspaceId, userId: user.id });
          } catch (error) {
            console.error(`[after upload] document ${doc.id} failed:`, error);
          }
        });

        created.push(toDto(doc));
        await recordAudit({
          workspaceId,
          actorEmail: user.email,
          action: 'document.upload',
          targetType: 'document',
          targetId: doc.id,
          detail: { fileName: file.name, fileSize: file.size, checksum },
        });
      } catch (fileError) {
        const message = fileError instanceof Error ? fileError.message : 'Upload failed';
        // Don't leave a PENDING orphan behind: the row was created before
        // the file write, and a PENDING row blocks re-upload as "Duplicate"
        // and shows as "processing" forever (no job was ever enqueued).
        // Marking it FAILED lets the UI show the real error and lets the
        // user retry the same file (dedupe excludes FAILED rows).
        if (createdDocId) {
          await db.document
            .update({
              where: { id: createdDocId },
              data: { status: 'FAILED', progress: 100, errorMessage: message },
            })
            .catch(() => {});
        }
        errors.push({ fileName: file.name, error: message });
      }
    }

    return NextResponse.json(
      {
        documents: created,
        errors,
        // api-client's generic handler reads only `error`, so surface the
        // first per-file error here too instead of a bare "Upload failed (400)".
        ...(created.length === 0 && errors.length > 0 ? { error: errors[0].error } : {}),
      },
      { status: created.length > 0 ? 201 : 400 },
    );
  } catch (error) {
    console.error('[POST upload]', error);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
