/**
 * InsightDoc — Embedding Service (spec §2.2 / §3.1)
 *
 * The spec targets OpenAI `text-embedding-3-small` (1536 dims). This sandbox has
 * no outbound embedding endpoint, so we ship a deterministic local embedder with
 * the SAME interface and dimension (1536). `EmbeddingService` is the only seam —
 * swapping in a remote provider is a one-file change.
 *
 * Design: hashed feature hashing (a.k.a. "hashing trick") over stemmed unigrams
 * + bigrams, sub-linear TF weighting, and L2 normalization — producing vectors
 * that live on the unit sphere, exactly what cosine similarity expects.
 */
import { createHash } from 'crypto';
import { stemTokenize } from '@/lib/tokenizer';

export const EMBEDDING_DIMENSIONS = 1536;
export const EMBEDDING_MODEL_ID = 'local-hashed-bow-1536-v2';

/** Deterministic 32-bit hash (FNV-1a) — stable across process restarts. */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

interface HashedEmbedderOptions {
  dimensions?: number;
}

class LocalHashedEmbedder {
  private readonly dims: number;

  constructor(options: HashedEmbedderOptions = {}) {
    this.dims = options.dimensions ?? EMBEDDING_DIMENSIONS;
  }

  /**
   * Embed a batch of documents. Returns L2-normalized float32-compatible arrays.
   * Deterministic and CPU-bound, hence synchronous; the interface stays async
   * so a remote provider can be dropped in without touching callers.
   */
  embed(texts: string[]): number[][] {
    return texts.map((text) => this.embedOne(text));
  }

  embedOne(text: string): number[] {
    const vector = new Array<number>(this.dims).fill(0);
    const tokens = stemTokenize(text);

    if (tokens.length === 0) return vector;

    // Term frequencies over unigrams + bigrams
    const tf = new Map<string, number>();
    const bump = (key: string, weight: number) => tf.set(key, (tf.get(key) ?? 0) + weight);

    for (let i = 0; i < tokens.length; i++) {
      bump(tokens[i], 1);
      if (i > 0) bump(`${tokens[i - 1]}_${tokens[i]}`, 0.6); // bigram, slightly down-weighted
    }

    for (const [term, freq] of tf) {
      // Sub-linear TF (1 + ln f) dampens repetitive PDF boilerplate
      const weight = 1 + Math.log(freq);
      const idx = fnv1a(term) % this.dims;
      const sign = (fnv1a(`s:${term}`) & 1) === 0 ? 1 : -1;
      vector[idx] += sign * weight;
    }

    return l2Normalize(vector);
  }
}

export function l2Normalize(vector: number[]): number[] {
  let norm = 0;
  for (const v of vector) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vector;
  return vector.map((v) => v / norm);
}

/**
 * Public seam. To switch to a remote embedding API, implement this interface
 * and export it here — no other module needs to change.
 */
export interface EmbeddingService {
  embed(texts: string[]): Promise<number[][]>;
  readonly model: string;
  readonly dimensions: number;
}

class LocalEmbeddingService implements EmbeddingService {
  private readonly embedder = new LocalHashedEmbedder();
  readonly model = EMBEDDING_MODEL_ID;
  readonly dimensions = EMBEDDING_DIMENSIONS;

  async embed(texts: string[]): Promise<number[][]> {
    // Guard against pathological batch sizes
    const BATCH = 64;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const slice = texts.slice(i, i + BATCH);
      out.push(...(await this.embedder.embed(slice)));
    }
    return out;
  }
}

/** Module-level singleton (survives HMR via globalThis). */
const globalForEmbeddings = globalThis as unknown as { __insightdocEmbeddings?: EmbeddingService };
export const embeddings: EmbeddingService =
  globalForEmbeddings.__insightdocEmbeddings ?? new LocalEmbeddingService();
globalForEmbeddings.__insightdocEmbeddings = embeddings;

// ─── Vector math (pgvector substitutes, spec §5.2 `<=>` operator) ────────────

/** Cosine distance, equivalent to pgvector `<=>` on unit-normalized vectors. */
export function cosineDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  return 1 - cosineDistance(a, b);
}

export function encodeVector(vector: number[]): string {
  return JSON.stringify(vector);
}

export function decodeVector(json: string | null | undefined): number[] | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) && typeof parsed[0] === 'number' ? (parsed as number[]) : null;
  } catch {
    return null;
  }
}
