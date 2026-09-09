/**
 * InsightDoc — Semantic Chunking Pipeline (spec §2.2)
 *
 * Sliding-window chunking with ~1000 token windows and ~200 token overlap,
 * respecting PAGE boundaries so every chunk maps to exactly one page — this is
 * what enables precise page-level citation deep-linking (spec §2.3).
 * Long paragraphs are split on sentence boundaries before hard character cuts.
 */
import { estimateTokens } from '@/lib/tokenizer';

export interface ChunkInput {
  /** Ordered page texts, index 0 == page 1. */
  pages: string[];
}

export interface RawChunk {
  content: string;
  pageNumber: number;
  chunkIndex: number;
  tokenCount: number;
  /** First heading-like line on the page, used for context in prompts. */
  heading: string | null;
}

export const CHUNK_SIZE_TOKENS = 1000; // spec §2.2
export const CHUNK_OVERLAP_TOKENS = 200; // spec §2.2

const MIN_CHUNK_TOKENS = 48; // avoid degenerate 1-word chunks

function detectHeading(pageText: string): string | null {
  const firstLines = pageText.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3);
  for (const line of firstLines) {
    const headingLike =
      line.length >= 3 &&
      line.length <= 120 &&
      (line === line.toUpperCase() || /^\d+(\.\d+)*\s/.test(line) || /^(chapter|section|article|part)\b/i.test(line));
    if (headingLike) return line;
  }
  return firstLines[0]?.slice(0, 120) ?? null;
}

/** Split raw page text into sentence-aligned segments no longer than maxTokens. */
function splitToSegments(pageText: string, maxTokens: number): string[] {
  const normalized = pageText.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!normalized) return [];

  const sentences = normalized.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/g);
  const segments: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (current.length > 0) {
      segments.push(current.join(' ').trim());
      current = [];
      currentTokens = 0;
    }
  };

  for (const sentence of sentences) {
    const sentenceTokens = estimateTokens(sentence);

    // Single oversized sentence → hard split on word boundary
    if (sentenceTokens > maxTokens) {
      flush();
      const words = sentence.split(/\s+/);
      let buf: string[] = [];
      let bufTokens = 0;
      for (const word of words) {
        const wTokens = estimateTokens(word) + 1;
        if (bufTokens + wTokens > maxTokens && buf.length > 0) {
          segments.push(buf.join(' '));
          buf = [];
          bufTokens = 0;
        }
        buf.push(word);
        bufTokens += wTokens;
      }
      if (buf.length > 0) segments.push(buf.join(' '));
      continue;
    }

    if (currentTokens + sentenceTokens > maxTokens && current.length > 0) flush();
    current.push(sentence);
    currentTokens += sentenceTokens;
  }
  flush();

  return segments.filter((s) => s.length > 0);
}

/**
 * Produce page-scoped sliding-window chunks.
 * Windows never span pages; overlap is applied in token space within a page.
 */
export function chunkPages({ pages }: ChunkInput): RawChunk[] {
  const chunks: RawChunk[] = [];
  let chunkIndex = 0;

  pages.forEach((pageText, pageIdx) => {
    const pageNumber = pageIdx + 1;
    const heading = detectHeading(pageText);
    const pageTokens = estimateTokens(pageText);

    // Whole page fits in one window → single chunk, no split needed
    if (pageTokens <= CHUNK_SIZE_TOKENS) {
      const content = pageText.trim();
      if (content) {
        chunks.push({ content, pageNumber, chunkIndex: chunkIndex++, tokenCount: pageTokens, heading });
      }
      return;
    }

    const segments = splitToSegments(pageText, CHUNK_SIZE_TOKENS);
    if (segments.length === 0) return;

    // Merge segments into sliding windows with token-space overlap
    const windows: string[] = [];
    let windowParts: string[] = [];
    let windowTokens = 0;

    const flushWindow = () => {
      if (windowParts.length > 0) {
        windows.push(windowParts.join(' ').trim());
        windowParts = [];
        windowTokens = 0;
      }
    };

    for (const segment of segments) {
      const segTokens = estimateTokens(segment);
      if (windowTokens + segTokens > CHUNK_SIZE_TOKENS && windowParts.length > 0) {
        flushWindow();
        // Re-seed next window with trailing context (~overlap tokens)
        const overlapParts: string[] = [];
        let overlapTokens = 0;
        for (let i = windowParts.length - 1; i >= 0; i--) {
          const part = windowParts[i];
          const t = estimateTokens(part);
          if (overlapTokens + t > CHUNK_OVERLAP_TOKENS) break;
          overlapParts.unshift(part);
          overlapTokens += t;
        }
        windowParts = overlapParts;
        windowTokens = overlapTokens;
      }
      windowParts.push(segment);
      windowTokens += segTokens;
    }
    flushWindow();

    for (const content of windows) {
      const tokenCount = estimateTokens(content);
      if (tokenCount < MIN_CHUNK_TOKENS && windows.length > 1) {
        // Merge orphan tail into previous chunk instead of emitting a stub
        const prev = chunks[chunks.length - 1];
        if (prev && prev.pageNumber === pageNumber) {
          prev.content = `${prev.content}\n${content}`;
          prev.tokenCount += tokenCount;
          continue;
        }
      }
      chunks.push({ content, pageNumber, chunkIndex: chunkIndex++, tokenCount, heading });
    }
  });

  return chunks;
}
