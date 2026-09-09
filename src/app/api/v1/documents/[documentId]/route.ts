/**
 * GET    /api/v1/documents/:documentId — document detail
 * PATCH  /api/v1/documents/:documentId — rename / re-title (ADMIN|MEMBER)
 * DELETE /api/v1/documents/:documentId — remove document + file + chunks (cascade)
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/server/bootstrap';
import { recordAudit } from '@/server/audit';
import { deleteDocumentFile } from '@/server/storage';
import { DocumentDTOSchema, parseDocumentTags, UpdateDocumentSchema } from '@/lib/types';

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

    const parsed = DocumentDTOSchema.safeParse({
      id: document.id,
      title: document.title,
      fileName: document.fileName,
      fileSize: document.fileSize,
      pageCount: document.pageCount,
      status: document.status,
      progress: document.progress,
      statusDetail: document.statusDetail,
      errorMessage: document.errorMessage,
      chunkCount: document.chunkCount,
      tokenCount: document.tokenCount,
      starred: document.starred,
      ocrPages: document.ocrPages,
      tags: parseDocumentTags(document.tags),
      workspaceId: document.workspaceId,
      createdAt: document.createdAt.toISOString(),
      updatedAt: document.updatedAt.toISOString(),
    });
    if (!parsed.success) {
      return NextResponse.json({ error: 'Document data corrupt' }, { status: 500 });
    }
    return NextResponse.json({ document: parsed.data });
  } catch (error) {
    console.error('[GET /documents/:id]', error);
    return NextResponse.json({ error: 'Failed to fetch document' }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ documentId: string }> },
) {
  try {
    const { documentId } = await ctx.params;
    const user = await getCurrentUser();

    const body: unknown = await request.json().catch(() => null);
    const parsedBody = UpdateDocumentSchema.safeParse(body);
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: parsedBody.error.issues[0]?.message ?? 'Invalid update payload' },
        { status: 400 },
      );
    }

    const document = await db.document.findUnique({
      where: { id: documentId },
      include: { workspace: { include: { members: { where: { userId: user.id } } } } },
    });
    if (!document || document.workspace.members.length === 0) {
      return NextResponse.json({ error: 'Document not found or access denied' }, { status: 404 });
    }
    const role = document.workspace.members[0].role;
    if (role === 'VIEWER') {
      return NextResponse.json({ error: 'Viewers cannot edit documents (RBAC)' }, { status: 403 });
    }

    const previousTitle = document.title;
    const previousStarred = document.starred;
    const previousTags = parseDocumentTags(document.tags);
    // Dedupe + order-stable when tags are provided.
    const nextTags = parsedBody.data.tags !== undefined
      ? Array.from(new Set(parsedBody.data.tags))
      : undefined;
    const updated = await db.document.update({
      where: { id: documentId },
      data: {
        ...(parsedBody.data.title !== undefined ? { title: parsedBody.data.title } : {}),
        ...(parsedBody.data.starred !== undefined ? { starred: parsedBody.data.starred } : {}),
        ...(nextTags !== undefined ? { tags: JSON.stringify(nextTags) } : {}),
      },
    });

    if (parsedBody.data.title !== undefined && parsedBody.data.title !== previousTitle) {
      await recordAudit({
        workspaceId: document.workspaceId,
        actorEmail: user.email,
        action: 'document.rename',
        targetType: 'document',
        targetId: documentId,
        detail: { from: previousTitle, to: parsedBody.data.title },
      });
    }
    if (parsedBody.data.starred !== undefined && parsedBody.data.starred !== previousStarred) {
      await recordAudit({
        workspaceId: document.workspaceId,
        actorEmail: user.email,
        action: parsedBody.data.starred ? 'document.star' : 'document.unstar',
        targetType: 'document',
        targetId: documentId,
        detail: { title: updated.title },
      });
    }
    if (nextTags !== undefined && JSON.stringify(nextTags) !== JSON.stringify(previousTags)) {
      await recordAudit({
        workspaceId: document.workspaceId,
        actorEmail: user.email,
        action: 'document.tag',
        targetType: 'document',
        targetId: documentId,
        detail: { from: previousTags, to: nextTags },
      });
    }

    const parsed = DocumentDTOSchema.safeParse({
      id: updated.id,
      title: updated.title,
      fileName: updated.fileName,
      fileSize: updated.fileSize,
      pageCount: updated.pageCount,
      status: updated.status,
      progress: updated.progress,
      statusDetail: updated.statusDetail,
      errorMessage: updated.errorMessage,
      chunkCount: updated.chunkCount,
      tokenCount: updated.tokenCount,
      starred: updated.starred,
      ocrPages: updated.ocrPages,
      tags: parseDocumentTags(updated.tags),
      workspaceId: updated.workspaceId,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    });
    if (!parsed.success) {
      return NextResponse.json({ error: 'Document data corrupt' }, { status: 500 });
    }
    return NextResponse.json({ document: parsed.data });
  } catch (error) {
    console.error('[PATCH /documents/:id]', error);
    return NextResponse.json({ error: 'Failed to update document' }, { status: 500 });
  }
}

export async function DELETE(
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
    const role = document.workspace.members[0].role;
    if (role === 'VIEWER') {
      return NextResponse.json({ error: 'Viewers cannot delete documents (RBAC)' }, { status: 403 });
    }

    await db.document.delete({ where: { id: documentId } }); // chunks cascade
    await deleteDocumentFile(document.fileUrl);

    await recordAudit({
      workspaceId: document.workspaceId,
      actorEmail: user.email,
      action: 'document.delete',
      targetType: 'document',
      targetId: documentId,
      detail: { fileName: document.fileName },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[DELETE /documents/:id]', error);
    return NextResponse.json({ error: 'Failed to delete document' }, { status: 500 });
  }
}
