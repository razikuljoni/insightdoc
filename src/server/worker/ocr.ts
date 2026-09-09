/**
 * InsightDoc — OCR fallback engine (server-side)
 *
 * Recovers a synthetic text layer for image-only ("scanned") PDFs:
 *   1. Rasterize each page with unpdf's `renderPageAsImage` (@napi-rs/canvas
 *      backend — no native compilation, no system-font dependency for image
 *      pages).
 *   2. Recognize glyphs with a singleton tesseract.js worker (eng model data
 *      is downloaded once and cached under `.tesseract-cache/`).
 *
 * Bounds: at most OCR_MAX_PAGES pages per document (configurable), 2× scale
 * (~144 dpi — the accuracy/cost sweet spot for body text). The tesseract
 * worker persists across queue jobs; terminate it only on process shutdown.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Set INSIGHTDOC_OCR=0 to disable the fallback (docs fail as SCANNED_PDF again). */
export function isOcrEnabled(): boolean {
  return process.env.INSIGHTDOC_OCR !== '0';
}

const OCR_MAX_PAGES = Number(process.env.INSIGHTDOC_OCR_MAX_PAGES ?? 12);
const OCR_SCALE = 2;
/** Average non-whitespace chars/page required to accept the OCR layer. */
export const OCR_MIN_CHARS_PER_PAGE = 12;
const TESS_CACHE_DIR = path.join(process.cwd(), '.tesseract-cache');

type TessWorker = Awaited<ReturnType<typeof import('tesseract.js').createWorker>>;

let workerPromise: Promise<TessWorker> | null = null;

async function getOcrWorker(): Promise<TessWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      try {
        fs.mkdirSync(TESS_CACHE_DIR, { recursive: true });
      } catch {
        /* cache dir is best-effort — tesseract falls back to temp */
      }
      return createWorker('eng', 1, {
        cachePath: TESS_CACHE_DIR,
        logger: () => {}, // keep stdout quiet; progress is reported via callback
      });
    })();
    // If initialization ever rejects, allow a future retry.
    workerPromise.catch(() => {
      workerPromise = null;
    });
  }
  return workerPromise;
}

export interface OcrResult {
  /** Recognized text per processed page (index 0 = page 1). */
  pages: string[];
  /** How many pages were OCRed (≤ page count). */
  processedPages: number;
  /** True when the document has more pages than we processed. */
  truncated: boolean;
}

/**
 * OCR the first `min(pageCount, OCR_MAX_PAGES)` pages of `bytes`.
 * `onPage` fires after each page (1-based page number, chars recovered) so
 * the caller can stream progress updates into the ingestion bar.
 */
export async function ocrPdf(
  bytes: Buffer,
  pageCount: number,
  onPage?: (pageNumber: number, charCount: number, processedPages: number) => void | Promise<void>,
): Promise<OcrResult> {
  const { renderPageAsImage } = await import('unpdf');
  const worker = await getOcrWorker();

  const limit = Math.min(Math.max(pageCount, 1), OCR_MAX_PAGES);
  const pages: string[] = [];

  for (let p = 1; p <= limit; p++) {
    const image = await renderPageAsImage(new Uint8Array(bytes), p, {
      scale: OCR_SCALE,
      canvasImport: () => import('@napi-rs/canvas'),
    });
    const { data } = await worker.recognize(Buffer.from(image));
    const text = typeof data.text === 'string' ? data.text : '';
    pages.push(text);
    await onPage?.(p, text.replace(/\s+/g, '').length, p);
  }

  return { pages, processedPages: limit, truncated: limit < pageCount };
}

/** Avg non-whitespace chars per processed page — the accept/reject signal. */
export function ocrQuality(pages: string[]): number {
  if (pages.length === 0) return 0;
  const chars = pages.reduce((sum, p) => sum + p.replace(/\s+/g, '').length, 0);
  return chars / pages.length;
}

/** Shutdown hook — not wired to process events; queue teardown can call it. */
export async function terminateOcrWorker(): Promise<void> {
  if (!workerPromise) return;
  const worker = await workerPromise;
  await worker.terminate();
  workerPromise = null;
}
