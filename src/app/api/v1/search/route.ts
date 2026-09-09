/**
 * POST /api/v1/search — cross-document semantic search (spec §2.3 scoped search)
 *
 * Runs the hybrid retrieval engine (BM25 + cosine + RRF + rerank) over a
 * workspace (optionally scoped to specific documents) and returns ranked
 * passage results for the Search view. Larger topK than chat since results
 * are browsed, not synthesized.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/server/bootstrap';
import { recordAudit } from '@/server/audit';
import { retrieve, type RetrievableChunkRow } from '@/server/rag/retriever';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SearchSchema = z.object({
  workspaceId: z.string().min(1),
  query: z.string().min(1).max(2000),
  documentIds: z.array(z.string()).optional().default([]),
  topK: z.number().int().min(1).max(30).optional().default(12),
});

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    const body: unknown = await request.json();
    const parsed = SearchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid search payload', issues: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const { workspaceId, query, documentIds, topK } = parsed.data;

    const membership = await db.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId: user.id, workspaceId } },
    });
    if (!membership) {
      return NextResponse.json({ error: 'Workspace not found or access denied' }, { status: 404 });
    }

    const completedDocs = await db.document.findMany({
      where: {
        workspaceId,
        status: 'COMPLETED',
        ...(documentIds.length > 0 ? { id: { in: documentIds } } : {}),
      },
      select: { id: true, title: true },
    });

    if (completedDocs.length === 0) {
      return NextResponse.json({
        results: [],
        stats: { vectorHits: 0, keywordHits: 0, fusedCandidates: 0, rerankedTopK: 0, retrieveMs: 0, rerankMs: 0 },
      });
    }

    const rows: RetrievableChunkRow[] = (
      await db.documentChunk.findMany({
        where: { documentId: { in: completedDocs.map((d) => d.id) } },
        orderBy: [{ documentId: 'asc' }, { chunkIndex: 'asc' }],
      })
    ).map((c) => ({
      id: c.id,
      documentId: c.documentId,
      content: c.content,
      pageNumber: c.pageNumber,
      chunkIndex: c.chunkIndex,
      metadataJson: c.metadataJson,
      embeddingJson: c.embeddingJson,
      documentTitle: completedDocs.find((d) => d.id === c.documentId)?.title ?? 'Unknown',
    }));

    const result = await retrieve(query, rows, { finalTopK: topK });

    await recordAudit({
      workspaceId,
      actorEmail: user.email,
      action: 'search.query',
      targetType: 'workspace',
      targetId: workspaceId,
      detail: { queryChars: query.length, results: result.chunks.length },
    });

    return NextResponse.json({
      results: result.citations,
      stats: result.stats,
    });
  } catch (error) {
    console.error('[POST /search]', error);
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  }
}
