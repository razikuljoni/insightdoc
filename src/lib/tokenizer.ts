/**
 * Lightweight English tokenizer + stopword list.
 * Shared by the BM25 scorer and the hashed embedder so feature spaces stay aligned.
 */

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in',
  'into', 'is', 'it', 'no', 'not', 'of', 'on', 'or', 'such', 'that', 'the',
  'their', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'will',
  'with', 'from', 'has', 'have', 'had', 'which', 'were', 'would', 'its',
  'also', 'than', 'them', 'we', 'our', 'you', 'your', 'can', 'may', 'shall',
  'any', 'all', 'each', 'other', 'more', 'most', 'some', 'both', 'per',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Snowball-ish suffix stripping — cheap stemmer good enough for IR ranking. */
export function stem(token: string): string {
  let t = token;
  if (t.length > 4 && t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (t.length > 4 && t.endsWith('sses')) return t.slice(0, -2);
  // Verbal/nasal endings that pluralize via "es" (matches → match, boxes → box)
  if (t.length > 4 && /(ch|sh|x|z|s)es$/.test(t) && !t.endsWith('ses')) return t.slice(0, -2);
  // Generic singular: strip final "s" so "revenues" → "revenue" matches "revenue".
  // Guarded against latin/identity endings (ss, us, is) and tiny words.
  if (
    t.length > 3 &&
    t.endsWith('s') &&
    !t.endsWith('ss') &&
    !t.endsWith('us') &&
    !t.endsWith('is')
  ) {
    return t.slice(0, -1);
  }
  if (t.length > 4 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 3 && t.endsWith('ed')) return t.slice(0, -2);
  if (t.length > 4 && t.endsWith('ly')) return t.slice(0, -2);
  if (t.length > 4 && t.endsWith('ment')) return t.slice(0, -4);
  if (t.length > 4 && t.endsWith('ness')) return t.slice(0, -4);
  return t;
}

export function stemTokenize(text: string): string[] {
  return tokenize(text).map(stem);
}

/** Rough token estimate (~4 chars/token) — consistent across cost tracking. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
