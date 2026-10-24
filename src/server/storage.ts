/**
 * InsightDoc — Local Object Storage (spec §3.1 S3/R2 substitute)
 *
 * Same conceptual interface as presigned-URL object storage: files are written
 * under a storage root with UUID keys and streamed back through an API route.
 */
import { createHash } from 'crypto';
import { mkdir, unlink, writeFile } from 'fs/promises';
import path from 'path';

// Vercel's serverless filesystem is read-only except /tmp (upload failed
// in production with `ENOENT: mkdir '/var/task/storage'`). Local dev keeps
// the repo-local folder so files persist on disk.
const STORAGE_ROOT = process.env.VERCEL
  ? path.join('/tmp', 'insightdoc-uploads')
  : path.join(process.cwd(), 'storage', 'uploads');

export async function ensureStorageRoot(): Promise<string> {
  await mkdir(STORAGE_ROOT, { recursive: true });
  return STORAGE_ROOT;
}

export function storageKeyFor(documentId: string): string {
  return `uploads/${documentId}.pdf`;
}

export function absolutePathFor(key: string): string {
  // key is always server-generated (`uploads/<uuid>.pdf`) — no user traversal risk
  return path.join(STORAGE_ROOT, path.basename(key));
}

export async function writeDocumentFile(documentId: string, bytes: Buffer): Promise<{ key: string; checksum: string; size: number }> {
  await ensureStorageRoot();
  const key = storageKeyFor(documentId);
  const abs = absolutePathFor(key);
  await writeFile(abs, bytes);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  return { key, checksum, size: bytes.byteLength };
}

export async function readDocumentFile(key: string): Promise<Buffer> {
  const abs = absolutePathFor(key);
  return import('fs/promises').then((fs) => fs.readFile(abs));
}

export async function deleteDocumentFile(key: string): Promise<void> {
  try {
    await unlink(absolutePathFor(key));
  } catch (error) {
    // Already gone — deletion is idempotent
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
