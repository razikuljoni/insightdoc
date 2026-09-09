/**
 * POST /api/v1/workspaces/:workspaceId/tags — workspace-wide tag maintenance.
 *
 * Body (discriminated union, see TagOperationSchema):
 *   { action: 'rename', from, to } — rewrites the tag on every document that
 *     carries it. Acts as a merge when `to` already exists on a document
 *     (duplicates collapse, 8-tag cap enforced by parseDocumentTags).
 *   { action: 'delete', from } — strips the tag from every document.
 *
 * RBAC: MEMBER and above (VIEWER is read-only). Every touched document is
 * audited with the resulting tag list; returns the updated DTOs so the client
 * store can upsert them in one pass.
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/server/bootstrap';
import { recordAudit } from '@/server/audit';
import { DocumentDTOSchema, TagOperationSchema, parseDocumentTags, type DocumentDTO } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  ctx: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await ctx.params;
    const user = await getCurrentUser();

    const membership = await db.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId: user.id, workspaceId } },
    });
    if (!membership) {
      return NextResponse.json({ error: 'Workspace not found or access denied' }, { status: 404 });
    }
    if (membership.role === 'VIEWER') {
      return NextResponse.json(
        { error: 'Viewers cannot manage tags (RBAC)' },
        { status: 403 },
      );
    }

    const body: unknown = await request.json().catch(() => null);
    const parsedBody = TagOperationSchema.safeParse(body);
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: parsedBody.error.issues[0]?.message ?? 'Invalid tag operation' },
        { status: 400 },
      );
    }
    const op = parsedBody.data;
    const from = op.from.toLowerCase();

    const documents = await db.document.findMany({ where: { workspaceId } });
    const touched = documents.filter((d) => parseDocumentTags(d.tags).includes(from));
    if (touched.length === 0) {
      return NextResponse.json(
        { error: `No documents carry the tag “${from}”` },
        { status: 404 },
      );
    }

    const updatedDtos: DocumentDTO[] = [];
    for (const doc of touched) {
      const current = parseDocumentTags(doc.tags);
      let next: string[];
      let auditAction: string;
      let detail: Record<string, unknown>;

      if (op.action === 'rename') {
        const to = op.to.toLowerCase();
        if (from === to) {
          return NextResponse.json({ error: 'New tag name is identical to the old one' }, { status: 400 });
        }
        // Replace from→to, then dedupe (merge case) while preserving order.
        next = [...new Set(current.map((t) => (t === from ? to : t)))];
        auditAction = 'document.tag.rename';
        detail = { from, to, documents: 1 };
      } else {
        next = current.filter((t) => t !== from);
        auditAction = 'document.tag.delete';
        detail = { tag: from, documents: 1 };
      }

      const updated = await db.document.update({
        where: { id: doc.id },
        data: { tags: JSON.stringify(next) },
      });

      await recordAudit({
        workspaceId,
        actorEmail: user.email,
        action: auditAction,
        targetType: 'document',
        targetId: doc.id,
        detail,
      });

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
      if (parsed.success) updatedDtos.push(parsed.data);
    }

    return NextResponse.json({ updated: updatedDtos });
  } catch (error) {
    console.error('[POST /workspaces/:id/tags]', error);
    return NextResponse.json({ error: 'Failed to update tags' }, { status: 500 });
  }
}
