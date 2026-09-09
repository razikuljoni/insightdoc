/**
 * InsightDoc — Hybrid Retrieval Engine (spec §2.3)
 *
 * Dual-stage retrieval:
 *   1. Parallel candidate generation — semantic cosine similarity (pgvector
 *      equivalent) + sparse BM25 full-text ranking.
 *   2. Fusion & re-ranking — Reciprocal Rank Fusion (RRF) blended with
 *      normalized scores, then diversity-aware top-K selection. This mirrors
 *      the "Cross-Encoder re-ranker" stage; the interface is identical, so a
 *      Cohere Rerank call can be layered in later without touching callers.
 */
import { cosineSimilarity, decodeVector, embeddings } from '@/lib/embeddings';
import { stemTokenize } from '@/lib/tokenizer';
import type { Citation } from '@/lib/types';

export interface RetrievedChunk {
  id: string;
  documentId: string;
  content: string;
  pageNumber: number;
  chunkIndex: number;
  metadata: { heading?: string } | null;
  documentTitle: string;
  vectorScore: number | null; // cosine similarity 0..1
  bm25Score: number | null;
  fusedScore: number;
}

export interface RetrievalOptions {
  /** Semantic candidates to pull before fusion. */
  vectorTopK?: number;
  /** BM25 candidates to pull before fusion. */
  keywordTopK?: number;
  /** Final re-ranked context count (spec §2.3: top 5). */
  finalTopK?: number;
  /** Fetch scope; empty array = all completed docs in workspace. */
  documentIds?: string[];
}

export interface RetrievableChunkRow {
  id: string;
  documentId: string;
  content: string;
  pageNumber: number;
  chunkIndex: number;
  metadataJson: string | null;
  embeddingJson: string | null;
  documentTitle: string;
}

const DEFAULTS = { vectorTopK: 20, keywordTopK: 20, finalTopK: 5 } as const;
const RRF_K = 60; // standard RRF constant

// ─── BM25 ────────────────────────────────────────────────────────────────────

const BM25_K1 = 1.2;
const BM25_B = 0.75;

interface Bm25Index {
  docTermFreqs: Map<string, number>[]; // per-doc term -> tf (stemmed)
  docLengths: number[];
  avgDocLength: number;
  idf: (term: string) => number;
}

export function buildBm25Index(rows: { content: string }[]): Bm25Index {
  const docTermFreqs: Map<string, number>[] = [];
  const docLengths: number[] = [];
  const df = new Map<string, number>();

  for (const row of rows) {
    const terms = stemTokenize(row.content);
    docLengths.push(terms.length);
    const tf = new Map<string, number>();
    for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1);
    for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    docTermFreqs.push(tf);
  }

  const totalLength = docLengths.reduce((a, b) => a + b, 0);
  const avgDocLength = rows.length > 0 ? totalLength / rows.length : 0;
  const N = rows.length;

  return {
    docTermFreqs,
    docLengths,
    avgDocLength,
    idf: (term: string) => {
      const n = df.get(term) ?? 0;
      if (n === 0) return 0;
      return Math.log(1 + (N - n + 0.5) / (n + 0.5));
    },
  };
}

export function bm25Search(
  index: Bm25Index,
  query: string,
  topK: number,
): Array<{ index: number; score: number }> {
  const queryTerms = [...new Set(stemTokenize(query))];
  if (queryTerms.length === 0 || index.docLengths.length === 0) return [];

  const scores: Array<{ index: number; score: number }> = [];

  for (let d = 0; d < index.docLengths.length; d++) {
    const tfMap = index.docTermFreqs[d];
    const docLen = index.docLengths[d];
    let score = 0;

    for (const term of queryTerms) {
      const tf = tfMap.get(term);
      if (!tf) continue;
      const idf = index.idf(term);
      const tfNorm =
        (tf * (BM25_K1 + 1)) /
        (tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / (index.avgDocLength || 1))));
      score += idf * tfNorm;
    }

    if (score > 0) scores.push({ index: d, score });
  }

  return scores.sort((a, b) => b.score - a.score).slice(0, topK);
}

// ─── Fusion & Rerank ─────────────────────────────────────────────────────────

function parseMetadata(json: string | null): { heading?: string } | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return typeof parsed.heading === 'string' ? { heading: parsed.heading } : null;
  } catch {
    return null;
  }
}

/** Min-max normalize a score list to 0..1 (robust to BM25's unbounded scale). */
function normalizeScores(values: number[]): number[] {
  if (values.length === 0) return values;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max - min < 1e-9) return values.map(() => 0.5);
  return values.map((v) => (v - min) / (max - min));
}

/**
 * Reciprocal Rank Fusion blended with min-max normalized scores.
 * Weighted 60/40 toward the semantic channel (embedding relevance is the
 * stronger prior for paraphrased questions; BM25 anchors exact terminology).
 */
export function fuseCandidates(
  vectorHits: Array<{ row: RetrievableChunkRow; score: number }>,
  keywordHits: Array<{ row: RetrievableChunkRow; score: number }>,
): RetrievedChunk[] {
  const byId = new Map<string, RetrievedChunk>();

  const ensure = (row: RetrievableChunkRow): RetrievedChunk => {
    let entry = byId.get(row.id);
    if (!entry) {
      entry = {
        id: row.id,
        documentId: row.documentId,
        content: row.content,
        pageNumber: row.pageNumber,
        chunkIndex: row.chunkIndex,
        metadata: parseMetadata(row.metadataJson),
        documentTitle: row.documentTitle,
        vectorScore: null,
        bm25Score: null,
        fusedScore: 0,
      };
      byId.set(row.id, entry);
    }
    return entry;
  };

  vectorHits.forEach((hit) => {
    ensure(hit.row).vectorScore = hit.score;
  });
  keywordHits.forEach((hit) => {
    ensure(hit.row).bm25Score = hit.score;
  });

  // RRF component
  vectorHits.forEach((hit, rank) => {
    const entry = byId.get(hit.row.id)!;
    entry.fusedScore += 0.6 * (1 / (RRF_K + rank + 1));
  });
  keywordHits.forEach((hit, rank) => {
    const entry = byId.get(hit.row.id)!;
    entry.fusedScore += 0.4 * (1 / (RRF_K + rank + 1));
  });

  return [...byId.values()];
}

/**
 * Lightweight re-ranker: cross-signal agreement bonus, query-term coverage
 * (content + heading), and near-duplicate suppression via greedy MMR-style
 * selection. In production this is where a Cohere Rerank / cross-encoder
 * call slots in.
 */
export function rerankCandidates(
  candidates: RetrievedChunk[],
  query: string,
  topK: number,
): RetrievedChunk[] {
  const queryTerms = new Set(stemTokenize(query));

  for (const c of candidates) {
    const vector = c.vectorScore ?? 0;
    const bm25 = c.bm25Score ?? 0;
    const terms = stemTokenize(c.content);
    const uniqueTerms = new Set(terms);

    // Heading terms count at double weight — a match in "SECTION 3. REVENUE
    // RECOGNITION" is a much stronger intent signal than body-text mentions.
    const headingTerms = c.metadata?.heading ? stemTokenize(c.metadata.heading) : [];
    let coverage = 0;
    for (const t of queryTerms) {
      if (uniqueTerms.has(t)) coverage += 1;
      if (headingTerms.includes(t)) coverage += 1;
    }
    const coverageRatio = queryTerms.size > 0 ? Math.min(coverage / (queryTerms.size * 2), 1) : 0;
    const headingHit = headingTerms.some((t) => queryTerms.has(t)) ? 0.06 : 0;

    // Signals: semantic similarity, lexical relevance, term coverage,
    // plus a small bonus when both channels agree (cross-signal confidence).
    const agreement = c.vectorScore !== null && c.bm25Score !== null ? 0.08 : 0;
    c.fusedScore =
      0.55 * vector + 0.2 * Math.min(bm25, 1) + 0.2 * coverageRatio + agreement + headingHit;
  }

  const sorted = [...candidates].sort((a, b) => b.fusedScore - a.fusedScore);
  return selectDiverse(sorted, topK);
}

// Jaccard threshold above which two chunks are considered the same passage
// (happens when the same source document is uploaded twice under different
// titles — content-hash de-dup cannot catch those).
const DUPLICATE_JACCARD = 0.82;

function tokenSetOf(chunk: RetrievedChunk): Set<string> {
  return new Set(stemTokenize(chunk.content));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/**
 * Greedy diversity-aware top-K: skip candidates that are near-verbatim
 * repeats of something already selected, but backfill with them if the pool
 * cannot otherwise fill K slots (tiny corpora must not return fewer hits).
 */
function selectDiverse(sorted: RetrievedChunk[], topK: number): RetrievedChunk[] {
  if (sorted.length <= topK) return sorted;

  const selected: RetrievedChunk[] = [];
  const selectedTokens: Set<string>[] = [];
  const skipped: RetrievedChunk[] = [];

  for (const candidate of sorted) {
    if (selected.length >= topK) break;
    const tokens = tokenSetOf(candidate);
    const isDuplicate = selectedTokens.some((s) => jaccard(tokens, s) >= DUPLICATE_JACCARD);
    if (isDuplicate) {
      skipped.push(candidate);
      continue;
    }
    selected.push(candidate);
    selectedTokens.push(tokens);
  }

  // Backfill if deduplication drained the pool below K.
  for (const candidate of skipped) {
    if (selected.length >= topK) break;
    selected.push(candidate);
  }
  return selected;
}

// ─── Main Entry ──────────────────────────────────────────────────────────────

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  citations: Citation[];
  stats: {
    vectorHits: number;
    keywordHits: number;
    fusedCandidates: number;
    rerankedTopK: number;
    retrieveMs: number;
    rerankMs: number;
  };
}

function snippetFor(content: string, maxChars = 320): string {
  const clean = content.replace(/\s+/g, ' ').trim();
  return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars).trimEnd()}…`;
}

/**
 * Execute hybrid retrieval over pre-fetched chunk rows.
 * Rows are fetched by the caller (API route) so this module stays pure/testable.
 */
export async function retrieve(
  query: string,
  rows: RetrievableChunkRow[],
  options: RetrievalOptions = {},
): Promise<RetrievalResult> {
  const opts = { ...DEFAULTS, ...options };
  const t0 = Date.now();

  if (rows.length === 0) {
    return {
      chunks: [],
      citations: [],
      stats: {
        vectorHits: 0,
        keywordHits: 0,
        fusedCandidates: 0,
        rerankedTopK: 0,
        retrieveMs: 0,
        rerankMs: 0,
      },
    };
  }

  // 1a. Semantic channel — cosine similarity (pgvector `<=>` equivalent)
  const [queryVector] = await embeddings.embed([query]);
  const vectorScored: Array<{ row: RetrievableChunkRow; score: number }> = [];
  for (const row of rows) {
    const vector = decodeVector(row.embeddingJson);
    if (!vector) continue;
    vectorScored.push({ row, score: cosineSimilarity(queryVector, vector) });
  }
  vectorScored.sort((a, b) => b.score - a.score);
  const vectorHits = vectorScored.slice(0, opts.vectorTopK);

  // 1b. Lexical channel — BM25
  const index = buildBm25Index(rows);
  const bm25Raw = bm25Search(index, query, opts.keywordTopK);
  const normalizedBm25 = normalizeScores(bm25Raw.map((h) => h.score));
  const keywordHits = bm25Raw.map((hit, i) => ({
    row: rows[hit.index],
    score: normalizedBm25[i],
  }));

  const retrieveMs = Date.now() - t0;

  // 2. Fusion + re-rank
  const t1 = Date.now();
  const fused = fuseCandidates(vectorHits, keywordHits);
  const reranked = rerankCandidates(fused, query, opts.finalTopK);
  const rerankMs = Date.now() - t1;

  const citations: Citation[] = reranked.map((c) => ({
    documentId: c.documentId,
    documentTitle: c.documentTitle,
    pageNumber: c.pageNumber,
    snippet: snippetFor(c.content),
    score: Math.round(Math.min(1, Math.max(0, c.fusedScore)) * 100) / 100,
    chunkId: c.id,
  }));

  return {
    chunks: reranked,
    citations,
    stats: {
      vectorHits: vectorHits.length,
      keywordHits: keywordHits.length,
      fusedCandidates: fused.length,
      rerankedTopK: reranked.length,
      retrieveMs,
      rerankMs,
    },
  };
}
