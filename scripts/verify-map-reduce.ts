/**
 * One-off verification: upload the large fixture (>24k chars) and confirm the
 * digest service engages the map-reduce path (server logs "[digest] mapped
 * part i/N") and returns a valid structured digest. Self-cleaning.
 * Run: bun scripts/verify-map-reduce.ts
 */
const BASE = 'http://localhost:3000';

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 200)}`);
  return body as Record<string, unknown>;
}

async function main() {
  // 1. workspace
  const ws = await api('/api/v1/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `mapreduce-verify-${Date.now()}`, description: 'digest map-reduce verification' }),
  });
  const wsId = (ws.workspace as { id: string }).id;
  console.log(`✓ workspace ${wsId}`);

  try {
    // 2. upload large fixture
    const bytes = await Bun.file('/tmp/large-doc.pdf').bytes();
    const form = new FormData();
    form.append('files', new Blob([bytes], { type: 'application/pdf' }), 'large-doc.pdf');
    const up = await api(`/api/v1/workspaces/${wsId}/documents/upload`, { method: 'POST', body: form });
    const doc = (up.documents as Array<{ id: string }>)[0];
    console.log(`✓ upload accepted — ${doc.id}`);

    // 3. poll until COMPLETED (bounded ~120s)
    const deadline = Date.now() + 120_000;
    let status = 'PENDING';
    let last = '';
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const st = (await api(`/api/v1/documents/${doc.id}/status`)) as { status: string; progress: number; chunkCount: number; statusDetail?: string };
      if (st.statusDetail !== last) { last = st.statusDetail ?? ''; console.log(`  … ${st.progress}% ${st.statusDetail ?? st.status}`); }
      status = st.status;
      if (status === 'COMPLETED') { console.log(`✓ ingestion completed — ${st.chunkCount} chunks`); break; }
      if (status === 'FAILED') throw new Error('ingestion failed');
    }
    if (status !== 'COMPLETED') throw new Error('ingestion timeout');

    // 4. generate digest (force) — should hit the map-reduce path
    console.log('  … generating digest (map-reduce expected, this takes a while)');
    const t0 = Date.now();
    const sum = (await api(`/api/v1/documents/${doc.id}/summary?force=1`, { method: 'POST' })) as {
      summary: { overview: string; keyPoints: string[]; entities: string[]; suggestedQuestions: string[] };
      basis: { chunkCount: number; charCount: number };
    };
    console.log(`✓ digest generated in ${((Date.now() - t0) / 1000).toFixed(1)}s — basis ${sum.basis.chunkCount} chunks / ${sum.basis.charCount} chars`);
    console.log(`  overview: ${sum.summary.overview.slice(0, 110)}…`);
    console.log(`  keyPoints: ${sum.summary.keyPoints.length}, entities: ${sum.summary.entities.length}, questions: ${sum.summary.suggestedQuestions.length}`);

    // 5. share-to-chat sanity (new endpoint, round 10)
    const shared = await api(`/api/v1/documents/${doc.id}/summary/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const msg = (shared as { message: { role: string } }).message;
    const chat = (shared as { chat: { id: string; title: string } }).chat;
    console.log(`✓ digest shared → role=${msg.role} chat="${chat.title}"`);

    console.log('VERIFY OK');
  } finally {
    await api(`/api/v1/workspaces/${wsId}`, { method: 'DELETE' });
    console.log('✓ cleanup');
  }
}

main().catch((e) => { console.error(`VERIFY FAILED: ${e instanceof Error ? e.message : e}`); process.exit(1); });
