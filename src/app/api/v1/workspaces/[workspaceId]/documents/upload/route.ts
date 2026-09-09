/**
 * POST /api/v1/workspaces/:workspaceId/documents/upload (spec §5.1, adapted)
 *
 * Sandbox adaptation of the presigned-URL flow: the client uploads multipart
 * directly to this route, which persists the PDF to local object storage,
 * creates the Document row (PENDING), and enqueues an ingestion job.
 * Response shape mirrors the spec: { documentId, fileKey }.
 */
import { NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/server/bootstrap';
import { recordAudit } from '@/server/audit';
import { getQueue } from '@/server/queue';
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
    const queue = await getQueue();

    for (const file of files) {
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

        const { key } = await writeDocumentFile(doc.id, bytes);
        await db.document.update({ where: { id: doc.id }, data: { fileUrl: key } });

        queue.enqueue('document.process', {
          documentId: doc.id,
          workspaceId,
          userId: user.id,
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
        errors.push({
          fileName: file.name,
          error: fileError instanceof Error ? fileError.message : 'Upload failed',
        });
      }
    }

    return NextResponse.json(
      { documents: created, errors },
      { status: created.length > 0 ? 201 : 400 },
    );
  } catch (error) {
    console.error('[POST upload]', error);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
