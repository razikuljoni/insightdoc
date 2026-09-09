/**
 * InsightDoc — End-to-end API smoke test (CI-style)
 *
 * Exercises the full platform loop against a running dev server:
 *   workspace create → PDF upload → ingestion poll → hybrid search →
 *   SSE chat (grounded answer + citations) → feedback → star → cleanup
 *
 * Usage:
 *   bun scripts/make-test-pdf.ts /tmp/smoke-e2e.pdf   # prerequisite
 *   bun scripts/smoke.ts                              # default http://localhost:3000
 *   BASE_URL=http://localhost:3000 bun scripts/smoke.ts
 *
 * Exit code 0 = all checks passed; 1 = at least one check failed.
 */
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const PDF_PATH = process.env.SMOKE_PDF ?? '/tmp/smoke-e2e.pdf';

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const checks: Check[] = [];
function check(name: string, ok: boolean, detail?: string) {
  checks.push({ name, ok, detail });
  const mark = ok ? '✓' : '✗';
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text().catch(() => '')}`);
  return (await res.json()) as T;
}

async function main() {
  const started = Date.now();
  console.log(`\nSmoke-testing ${BASE}\n`);

  // ── 0. PDF prerequisite ────────────────────────────────────────────────
  const pdfBytes = await readFile(PDF_PATH).catch(() => null);
  if (!pdfBytes) {
    console.error(`Missing ${PDF_PATH} — run: bun scripts/make-test-pdf.ts ${PDF_PATH}`);
    process.exit(1);
  }
  const checksum = createHash('sha256').update(pdfBytes).digest('hex');

  // ── 1. Workspace ───────────────────────────────────────────────────────
  const ws = await json<{ workspace: { id: string; name: string } }>(
    await fetch(`${BASE}/api/v1/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `Smoke ${new Date().toISOString().slice(0, 16)}`, description: 'E2E smoke test workspace' }),
    }),
  );
  check('workspace created', Boolean(ws.workspace.id), ws.workspace.id.slice(0, 8));

  // ── 2. Upload ──────────────────────────────────────────────────────────
  const form = new FormData();
  form.append('files', new Blob([pdfBytes], { type: 'application/pdf' }), 'smoke-e2e.pdf');
  const upload = await json<{ documents: Array<{ id: string; status: string }> }>(
    await fetch(`${BASE}/api/v1/workspaces/${ws.workspace.id}/documents/upload`, {
      method: 'POST',
      body: form,
    }),
  );
  const doc = upload.documents[0];
  check('upload accepted', Boolean(doc?.id), `status=${doc?.status}`);

  // Duplicate upload must be rejected (content-hash de-dup)
  const dupForm = new FormData();
  dupForm.append('files', new Blob([pdfBytes], { type: 'application/pdf' }), 'smoke-e2e.pdf');
  const dupRes = await fetch(`${BASE}/api/v1/workspaces/${ws.workspace.id}/documents/upload`, {
    method: 'POST',
    body: dupForm,
  });
  const dupJson = (await dupRes.json().catch(() => ({}))) as { errors?: Array<{ error: string }> };
  check(
    'duplicate upload rejected',
    dupJson.errors?.[0]?.error?.toLowerCase().includes('duplicate') === true,
    dupJson.errors?.[0]?.error?.slice(0, 80),
  );

  // ── 3. Ingestion poll (max 30s) ────────────────────────────────────────
  let indexed = false;
  for (let i = 0; i < 60; i++) {
    const st = await json<{ status: string; chunkCount: number; errorMessage: string | null }>(
      await fetch(`${BASE}/api/v1/documents/${doc.id}/status`),
    );
    if (st.status === 'COMPLETED') {
      indexed = st.chunkCount > 0;
      check('ingestion completed', true, `${st.chunkCount} chunks`);
      break;
    }
    if (st.status === 'FAILED') {
      check('ingestion completed', false, st.errorMessage ?? 'unknown');
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!indexed) check('ingestion completed', false, 'timed out after 30s');

  // ── 4. Hybrid search ───────────────────────────────────────────────────
  const search = await json<{ results: Array<{ documentId: string; pageNumber: number; snippet: string; score: number }> }>(
    await fetch(`${BASE}/api/v1/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: ws.workspace.id, query: 'total revenue segment breakdown' }),
    }),
  );
  const revenueHit = search.results.find((r) => r.documentId === doc.id && r.snippet.includes('$1.42 billion'));
  check(
    'hybrid search surfaces revenue passage',
    Boolean(revenueHit),
    `${search.results.length} results, top score ${search.results[0]?.score.toFixed(2) ?? '—'}`,
  );

  // ── 5. SSE chat with grounding ─────────────────────────────────────────
  const chat = await json<{ chat: { id: string } }>(
    await fetch(`${BASE}/api/v1/chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: ws.workspace.id, title: 'Smoke RAG turn' }),
    }),
  );
  check('chat created', Boolean(chat.chat.id));

  const streamRes = await fetch(`${BASE}/api/v1/chats/${chat.chat.id}/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'What was total Q3 revenue and which segment contributed most?' }),
  });
  check('stream endpoint 200', streamRes.ok, String(streamRes.status));

  const rawFrames = (await streamRes.text()).split('\n\n').filter(Boolean);
  if (!rawFrames.some((f) => f.startsWith('event: token'))) {
    console.error('RAW STREAM DUMP:\n', rawFrames.join('\n---\n').slice(0, 1200) || '(empty body)');
  }
  type TokenPayload = { delta?: string };
  type Citation = { pageNumber: number; snippet: string };
  const frames: Array<{ event: string; data: string }> = [];
  for (const raw of rawFrames) {
    const eventLine = raw.match(/^event: (.+)$/m)?.[1]?.trim();
    const dataLine = raw.match(/^data: (.*)$/m)?.[1]?.trim();
    if (!eventLine) continue;
    frames.push({ event: eventLine, data: dataLine ?? '' });
  }
  const citationsFrame = frames.find((f) => f.event === 'citations');
  const citations: Citation[] = (() => {
    try {
      const parsed = JSON.parse(citationsFrame?.data ?? 'null') as Citation[] | null;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();
  const answerText = frames
    .filter((f) => f.event === 'token')
    .map((f) => {
      try {
        return (JSON.parse(f.data) as TokenPayload).delta ?? '';
      } catch {
        return '';
      }
    })
    .join('');
  check('citations frame received', citations.length > 0, `${citations.length} citations`);
  check(
    'answer is grounded ($1.42B + Industrial Automation)',
    answerText.includes('$1.42 billion') && answerText.includes('Industrial Automation'),
    `${answerText.length} chars`,
  );

  // ── 6. Feedback ────────────────────────────────────────────────────────
  const msgs = await json<{ messages: Array<{ id: string; role: string }> }>(
    await fetch(`${BASE}/api/v1/chats/${chat.chat.id}`),
  );
  const answer = msgs.messages.findLast?.((m) => m.role === 'assistant') ?? [...msgs.messages].reverse().find((m) => m.role === 'assistant');
  const fbRes = await fetch(`${BASE}/api/v1/chats/${chat.chat.id}/messages`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId: answer?.id, feedback: 'UP' }),
  });
  check('feedback persisted', fbRes.ok, String(fbRes.status));

  // ── 7. Star document ───────────────────────────────────────────────────
  const star = await json<{ document: { starred: boolean } }>(
    await fetch(`${BASE}/api/v1/documents/${doc.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: true }),
    }),
  );
  check('star persisted', star.document.starred === true);

  // ── 8. Tag management (workspace-wide rename + statusDetail contract) ──
  await fetch(`${BASE}/api/v1/documents/${doc.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: ['smoketag', 'finance'] }),
  });
  const tagOp = await json<{ updated: Array<{ tags: string[] }> }>(
    await fetch(`${BASE}/api/v1/workspaces/${ws.workspace.id}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'rename', from: 'smoketag', to: 'risk' }),
    }),
  );
  check(
    'workspace tag rename applied',
    tagOp.updated.length === 1 && tagOp.updated[0].tags.includes('risk') && !tagOp.updated[0].tags.includes('smoketag'),
    tagOp.updated[0]?.tags.join(','),
  );

  // ── 9. Digest share-to-chat (note message) ─────────────────────────────
  const digest = (await fetch(`${BASE}/api/v1/documents/${doc.id}/summary`, { method: 'POST' }).then((r) =>
    json<{ summary: unknown }>(r).catch(() => null),
  )) as { summary: unknown } | null;
  let shareOk = false;
  let shareDetail = 'digest generation failed';
  if (digest) {
    const share = (await fetch(`${BASE}/api/v1/documents/${doc.id}/summary/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).then((r) => json<{ message: { role: string; content: string }; chat: { id: string; title: string } }>(r).catch(() => null))) as {
      message: { role: string; content: string };
      chat: { id: string; title: string };
    } | null;
    shareOk = share?.message.role === 'note' && share.message.content.includes('"kind":"digest"');
    shareDetail = share ? `role=${share.message.role} chat="${share.chat.title}"` : 'share call failed';
    if (share) {
      await fetch(`${BASE}/api/v1/chats/${share.chat.id}`, { method: 'DELETE' }).catch(() => {});
    }
  }
  check('digest shared to chat as note', shareOk, shareDetail);

  // ── 10. Cleanup ──────────────────────────────────────────────────────────
  await fetch(`${BASE}/api/v1/chats/${chat.chat.id}`, { method: 'DELETE' });
  await fetch(`${BASE}/api/v1/documents/${doc.id}`, { method: 'DELETE' });
  const docsAfter = await json<{ documents: unknown[] }>(
    await fetch(`${BASE}/api/v1/documents?workspaceId=${ws.workspace.id}`),
  );
  check('cleanup removed document', docsAfter.documents.length === 0);
  const wsDelete = await fetch(`${BASE}/api/v1/workspaces/${ws.workspace.id}`, { method: 'DELETE' });
  check('cleanup removed workspace', wsDelete.ok, String(wsDelete.status));

  // ── Summary ────────────────────────────────────────────────────────────
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;
  console.log(`\n${passed}/${checks.length} checks passed in ${((Date.now() - started) / 1000).toFixed(1)}s${failed > 0 ? ` — ${failed} FAILED` : ' — SMOKE OK'}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('\nSmoke test crashed:', error);
  process.exit(1);
});
