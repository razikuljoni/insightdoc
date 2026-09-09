/**
 * InsightDoc — Document Processing Worker (spec §7 Phase 2)
 *
 * Pipeline: fetch file → extract text per page (pdf text layer via unpdf) →
 * semantic chunking (page-scoped sliding window) → batch embedding generation →
 * transactional persistence. Progress is persisted at every stage so the UI
 * can render a live ingestion bar, and failures mark the document FAILED with
 * a human-readable error message before the queue's retry logic takes over.
 */
import { chunkPages } from '@/lib/chunker';
import { db } from '@/lib/db';
import { embeddings, encodeVector, EMBEDDING_MODEL_ID, EMBEDDING_DIMENSIONS } from '@/lib/embeddings';
import { estimateTokens } from '@/lib/tokenizer';
import { DOCUMENT_ERROR_CODES } from '@/lib/types';
import { recordAudit, recordUsage } from '@/server/audit';
import { NonRetryableError } from '@/server/queue';
import { readDocumentFile } from '@/server/storage';
import { isOcrEnabled, OCR_MIN_CHARS_PER_PAGE, ocrPdf, ocrQuality } from '@/server/worker/ocr';

/** Extract text page-by-page using the PDF text layer (unpdf → pdfjs). */
async function extractPages(bytes: Buffer): Promise<{ pages: string[]; pageCount: number }> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [String(text)];
  return { pages, pageCount: pdf.numPages };
}

export async function processDocumentJob(payload: {
  documentId: string;
  workspaceId: string;
  userId: string;
}): Promise<void> {
  const { documentId } = payload;
  const document = await db.document.findUnique({ where: { id: documentId } });
  if (!document) {
    throw new Error(`Document ${documentId} not found`);
  }

  try {
    // ── Stage 0: claim job ────────────────────────────────────────────────
    await db.document.update({
      where: { id: documentId },
      data: { status: 'PROCESSING', progress: 2, statusDetail: 'Queued → starting extraction', errorMessage: null },
    });

    // ── Stage 1: read stored file ─────────────────────────────────────────
    const bytes = await readDocumentFile(document.fileUrl);
    await setProgress(documentId, 8, 'Reading stored file');

    // ── Stage 2: page-level text extraction ───────────────────────────────
    let pages: string[];
    let pageCount: number;
    try {
      const extracted = await extractPages(bytes);
      pages = extracted.pages;
      pageCount = extracted.pageCount;
    } catch (error) {
      throw new NonRetryableError(
        `${DOCUMENT_ERROR_CODES.EXTRACTION_FAILED} PDF text extraction failed `
          + `(${error instanceof Error ? error.message : 'unknown error'}). The file may be `
          + `corrupted, password-protected, or not a valid PDF.`,
        'EXTRACTION_FAILED',
      );
    }
    await db.document.update({ where: { id: documentId }, data: { pageCount } });
    await setProgress(documentId, 22, `Extracted ${pageCount} page${pageCount === 1 ? '' : 's'} — checking text layer`);

    // ── Stage 2.5: scanned-PDF (no text layer) detection + OCR fallback ────
    // pdfjs still "extracts" whitespace/control fragments from image-only
    // pages, so both the chunk count AND the raw character volume must be
    // near-zero before classifying the file as scanned. When OCR is enabled
    // (default), the pages are rasterized and run through tesseract; the
    // recovered text replaces the empty layer and the pipeline continues.
    const totalChars = pages.reduce((sum, p) => sum + p.replace(/\s+/g, '').length, 0);
    const SCANNED_MIN_CHARS_PER_PAGE = 24;
    let ocrPages = 0;
    let ocrTruncated = false;
    if (totalChars < SCANNED_MIN_CHARS_PER_PAGE * Math.max(pageCount, 1)) {
      if (!isOcrEnabled()) {
        throw new NonRetryableError(
          `${DOCUMENT_ERROR_CODES.SCANNED_PDF} Only ${totalChars} extractable characters across `
            + `${pageCount} page(s) — no text layer and OCR fallback is disabled. `
            + `Re-run the file through an OCR tool or upload a text-based PDF.`,
          'SCANNED_PDF',
        );
      }

      console.log(`[worker] document ${documentId}: no text layer (${totalChars} chars / ${pageCount} pages) — starting OCR fallback`);
      const ocrLimit = Math.min(Math.max(pageCount, 1), 12);
      let ocrResult: Awaited<ReturnType<typeof ocrPdf>>;
      try {
        ocrResult = await ocrPdf(bytes, pageCount, async (page, chars, processed) => {
          // 22→32% maps to OCR progress; keep the bar alive on slow pages.
          await setProgress(
            documentId,
            22 + Math.round((processed / ocrLimit) * 10),
            `Scanned PDF detected — OCR page ${page}/${ocrLimit} (tesseract)`,
          );
          console.log(`[worker] OCR page ${page}/${ocrLimit}: ${chars} chars`);
        });
      } catch (error) {
        throw new NonRetryableError(
          `${DOCUMENT_ERROR_CODES.SCANNED_PDF} OCR fallback failed: `
            + `${error instanceof Error ? error.message : 'unknown error'}. `
            + `Upload a text-based PDF or retry later.`,
          'OCR_FAILED',
        );
      }

      if (ocrQuality(ocrResult.pages) < OCR_MIN_CHARS_PER_PAGE) {
        throw new NonRetryableError(
          `${DOCUMENT_ERROR_CODES.SCANNED_PDF} OCR recovered too little text (avg `
            + `${Math.round(ocrQuality(ocrResult.pages) * 10) / 10} chars/page over `
            + `${ocrResult.processedPages} page(s)). The scan may be blank, rotated or too low-quality.`,
          'SCANNED_PDF',
        );
      }

      pages = ocrResult.pages;
      pageCount = ocrResult.processedPages; // index only what we OCRed
      ocrPages = ocrResult.processedPages;
      ocrTruncated = ocrResult.truncated;
      await db.document.update({ where: { id: documentId }, data: { pageCount } });
      await recordAudit({
        workspaceId: document.workspaceId,
        actorEmail: 'system@insightdoc',
        action: 'document.ocr',
        targetType: 'document',
        targetId: documentId,
        detail: { pages: ocrPages, truncated: ocrTruncated },
      });
    }
    await setProgress(documentId, 32, 'Chunking text (1000/200 sliding window)');

    // ── Stage 3: semantic chunking ────────────────────────────────────────
    const rawChunks = chunkPages({ pages });
    if (rawChunks.length === 0) {
      throw new NonRetryableError(
        `${DOCUMENT_ERROR_CODES.SCANNED_PDF} Text was extracted but produced zero indexable `
          + `chunks. The document may be blank or contain only page furniture.`,
        'SCANNED_PDF',
      );
    }
    const totalTokens = rawChunks.reduce((sum, c) => sum + c.tokenCount, 0);
    await setProgress(documentId, 32, `Built ${rawChunks.length} chunk${rawChunks.length === 1 ? '' : 's'} — starting embedding`);

    // ── Stage 4: embedding generation (batched, progress per batch) ───────
    await db.documentChunk.deleteMany({ where: { documentId } }); // idempotent re-processing

    const BATCH = 32;
    let embeddedTokens = 0;
    for (let i = 0; i < rawChunks.length; i += BATCH) {
      const batch = rawChunks.slice(i, i + BATCH);
      const vectors = await embeddings.embed(batch.map((c) => c.content));

      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j];
        const vector = vectors[j];
        if (vector.length !== EMBEDDING_DIMENSIONS) {
          throw new NonRetryableError(
            `Embedding dimension mismatch: expected ${EMBEDDING_DIMENSIONS}, got ${vector.length}`,
            'EMBEDDING_DIM_MISMATCH',
          );
        }
        await db.documentChunk.create({
          data: {
            documentId,
            content: chunk.content,
            pageNumber: chunk.pageNumber,
            chunkIndex: chunk.chunkIndex,
            metadataJson: JSON.stringify({ heading: chunk.heading, tokenCount: chunk.tokenCount }),
            embeddingJson: encodeVector(vector),
          },
        });
      }

      embeddedTokens += batch.reduce((sum, c) => sum + c.tokenCount, 0);
      // 32%→88% maps to embedding progress
      const progress = 32 + Math.round(((i + batch.length) / rawChunks.length) * 56);
      await setProgress(
        documentId,
        progress,
        `Embedding chunks ${i + batch.length}/${rawChunks.length} (1536-dim)`,
      );
    }

    // ── Stage 5: usage ledger + finalize ──────────────────────────────────
    await recordUsage({
      userId: payload.userId,
      workspaceId: payload.workspaceId,
      kind: 'embedding',
      model: EMBEDDING_MODEL_ID,
      promptTokens: embeddedTokens,
      completionTokens: 0,
    });

    await db.document.update({
      where: { id: documentId },
      data: {
        status: 'COMPLETED',
        progress: 100,
        chunkCount: rawChunks.length,
        tokenCount: totalTokens,
        embeddingModel: EMBEDDING_MODEL_ID,
        ocrPages,
        statusDetail: null,
        errorMessage: null,
      },
    });

    console.log(
      `[worker] document ${documentId} processed: ${pageCount} pages${ocrPages > 0 ? ` (OCR×${ocrPages}${ocrTruncated ? ', truncated' : ''})` : ''} → ${rawChunks.length} chunks → ${embeddedTokens} tokens embedded`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown processing error';
    console.error(`[worker] document ${documentId} failed: ${message}`);
    await db.document.update({
      where: { id: documentId },
      data: { status: 'FAILED', progress: 100, statusDetail: null, errorMessage: message },
    });
    throw error; // propagate so the queue retry/backoff engages
  }
}

async function setProgress(documentId: string, progress: number, statusDetail?: string | null): Promise<void> {
  await db.document
    .update({
      where: { id: documentId },
      data: { progress, ...(statusDetail !== undefined ? { statusDetail } : {}) },
    })
    .catch(() => {
      /* progress updates are best-effort */
    });
}

/** Convenience guard used by upload routes to keep token accounting honest. */
export function isProcessableMime(mimeType: string): boolean {
  return mimeType === 'application/pdf' || mimeType === 'application/x-pdf';
}

export { estimateTokens };
