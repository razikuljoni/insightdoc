/**
 * InsightDoc — Bootstrap & Session Helpers
 *
 * The spec's auth layer (Clerk/NextAuth) is replaced by a sandbox-friendly
 * demo session: a deterministic first-run seed creates the platform owner
 * ("Analyst") plus a starter workspace. Every API route resolves the same
 * current user, keeping the RBAC plumbing (roles per workspace) real.
 */
import { db } from '@/lib/db';
import { EMBEDDING_MODEL_ID } from '@/lib/embeddings';
import { slugify } from '@/lib/types';
import { getQueue } from '@/server/queue';

const DEMO_EMAIL = 'analyst@insightdoc.local';
const g = globalThis as unknown as { __insightdocBootstrapped?: boolean };

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export async function getCurrentUser(): Promise<SessionUser> {
  await ensureSeeded();
  const user = await db.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (!user) throw new Error('Bootstrap failed: demo user missing');
  return { id: user.id, email: user.email, name: user.name ?? 'Analyst' };
}

export async function ensureSeeded(): Promise<void> {
  if (g.__insightdocBootstrapped) return;

  const user = await db.user.upsert({
    where: { email: DEMO_EMAIL },
    update: {},
    create: { email: DEMO_EMAIL, name: 'Senior Analyst' },
  });

  const existingWorkspace = await db.workspaceMember.findFirst({
    where: { userId: user.id },
  });

  if (!existingWorkspace) {
    const workspace = await db.workspace.create({
      data: {
        name: 'Q4 Financial Review',
        slug: slugify(`q4-financial-review-${Date.now().toString(36)}`),
        description: 'Default workspace — quarterly filings, risk disclosures and analyst notes.',
      },
    });
    await db.workspaceMember.create({
      data: { userId: user.id, workspaceId: workspace.id, role: 'ADMIN' },
    });
  }

  g.__insightdocBootstrapped = true;

  // Transparent reindex: documents whose stored vectors were produced by an
  // older embedding model (tokenizer/embedder upgrades) are silently
  // re-queued so retrieval quality never silently degrades. Runs at most
  // once per process; the queue's concurrency cap keeps it gentle.
  void reindexStaleEmbeddingDocs(user.id).catch((error) => {
    console.error('[bootstrap] stale-embedding reindex failed:', error);
  });
}

async function reindexStaleEmbeddingDocs(userId: string): Promise<void> {
  const stale = await db.document.findMany({
    where: { status: 'COMPLETED', embeddingModel: { not: EMBEDDING_MODEL_ID } },
    select: { id: true, workspaceId: true, fileName: true },
  });
  if (stale.length === 0) return;

  const queue = await getQueue();
  for (const doc of stale) {
    await db.document.update({
      where: { id: doc.id },
      data: { status: 'PENDING', progress: 0, errorMessage: null },
    });
    queue.enqueue('document.process', {
      documentId: doc.id,
      workspaceId: doc.workspaceId,
      userId,
    });
  }
  console.log(
    `[bootstrap] re-enqueued ${stale.length} document(s) for re-index after embedding model upgrade → ${EMBEDDING_MODEL_ID}`,
  );
}
