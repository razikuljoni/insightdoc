/**
 * InsightDoc — Shared client-side upload validation (spec §2.2)
 * Used by both the inline UploadZone and the global drag-and-drop manager so
 * the acceptance rules can never drift between entry points.
 */
import { MAX_FILE_SIZE_BYTES, formatBytes } from './types';

export interface FileValidationError {
  fileName: string;
  error: string;
}

export interface FileValidationResult {
  valid: File[];
  errors: FileValidationError[];
}

/** Acceptance rules: PDF only (name or MIME), non-empty, ≤ 50MB. */
export function validatePdfFiles(files: File[]): FileValidationResult {
  const errors: FileValidationError[] = [];
  const valid = files.filter((f) => {
    if (f.size > MAX_FILE_SIZE_BYTES) {
      errors.push({
        fileName: f.name,
        error: `Exceeds 50MB limit (${formatBytes(f.size)})`,
      });
      return false;
    }
    if (f.size === 0) {
      errors.push({ fileName: f.name, error: 'File is empty' });
      return false;
    }
    if (!f.name.toLowerCase().endsWith('.pdf') && f.type !== 'application/pdf') {
      errors.push({ fileName: f.name, error: 'Only PDF files are accepted' });
      return false;
    }
    return true;
  });
  return { valid, errors };
}

/** Deduplicate a DataTransfer file list against names already queued this drag. */
export function dedupeByName(files: File[], existing: Set<string>): FileValidationResult {
  const errors: FileValidationError[] = [];
  const valid = files.filter((f) => {
    if (existing.has(f.name)) {
      errors.push({ fileName: f.name, error: 'Already in this batch' });
      return false;
    }
    return true;
  });
  return { valid, errors };
}
