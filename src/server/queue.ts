/**
 * InsightDoc — In-Process Background Job Queue (spec §3.1 BullMQ substitute)
 *
 * The sandbox has no Redis, so ingestion jobs run in a process-wide singleton
 * queue (cached on globalThis so Next.js HMR cannot duplicate workers).
 * Features kept from the BullMQ design:
 *   - decoupled producer/consumer (enqueue returns immediately; API never blocks)
 *   - per-job retry with exponential backoff + jitter
 *   - concurrency cap
 *   - job state observable through the DB (Document.status / progress)
 */

export type JobType = 'document.process';

export interface JobPayload {
  documentId: string;
  workspaceId: string;
  userId: string;
}

export type JobStatus = 'queued' | 'active' | 'completed' | 'failed';

export interface Job {
  id: string;
  type: JobType;
  payload: JobPayload;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  enqueuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  lastError?: string;
}

type JobHandler = (job: Job) => Promise<void>;

interface QueueOptions {
  concurrency?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
}

const DEFAULTS: Required<QueueOptions> = {
  concurrency: 2,
  maxAttempts: 3,
  baseBackoffMs: 1500,
};

function backoffMs(attempt: number, base: number): number {
  const exp = base * 2 ** (attempt - 1);
  const jitter = exp * 0.2 * Math.random();
  return Math.min(exp + jitter, 30_000);
}

/**
 * Throw for failures that no number of retries can fix (scanned PDFs,
 * password-protected files, dimension misconfigurations...). The queue
 * fails the job immediately instead of burning the retry budget.
 */
export class NonRetryableError extends Error {
  readonly code: string;
  constructor(message: string, code = 'NON_RETRYABLE') {
    super(message);
    this.name = 'NonRetryableError';
    this.code = code;
  }
}

class JobQueue {
  private readonly pending: Job[] = [];
  private readonly active = new Map<string, Job>();
  private readonly handler: JobHandler;
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private draining = false;
  private readonly listeners = new Set<(jobId: string) => void>();

  constructor(handler: JobHandler, options: QueueOptions = {}) {
    const merged = { ...DEFAULTS, ...options };
    this.handler = handler;
    this.concurrency = merged.concurrency;
    this.maxAttempts = merged.maxAttempts;
    this.baseBackoffMs = merged.baseBackoffMs;
  }

  enqueue(type: JobType, payload: JobPayload): Job {
    const job: Job = {
      id: `${type}:${payload.documentId}:${Date.now()}`,
      type,
      payload,
      status: 'queued',
      attempts: 0,
      maxAttempts: this.maxAttempts,
      enqueuedAt: Date.now(),
    };
    this.pending.push(job);
    setImmediate(() => void this.drain());
    return job;
  }

  get stats() {
    return {
      queued: this.pending.length,
      active: this.active.size,
      concurrency: this.concurrency,
    };
  }

  getActiveByDocumentId(documentId: string): Job | undefined {
    for (const job of this.active.values()) {
      if (job.payload.documentId === documentId) return job;
    }
    return this.pending.find((j) => j.payload.documentId === documentId);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    try {
      while (this.pending.length > 0 && this.active.size < this.concurrency) {
        const job = this.pending.shift()!;
        this.run(job);
      }
    } finally {
      this.draining = false;
      // If more work arrived while finishing, drain again on next tick
      if (this.pending.length > 0 && this.active.size < this.concurrency) {
        setImmediate(() => void this.drain());
      }
    }
  }

  private run(job: Job): void {
    job.status = 'active';
    job.attempts += 1;
    job.startedAt = Date.now();
    this.active.set(job.id, job);
    this.notify();

    void (async () => {
      try {
        await this.handler(job);
        job.status = 'completed';
        job.finishedAt = Date.now();
      } catch (error) {
        job.lastError = error instanceof Error ? error.message : String(error);
        job.status = 'failed';
        job.finishedAt = Date.now();

        const nonRetryable =
          error instanceof NonRetryableError ||
          (error instanceof Error && error.name === 'NonRetryableError');

        if (!nonRetryable && job.attempts < job.maxAttempts) {
          const delay = backoffMs(job.attempts, this.baseBackoffMs);
          console.warn(
            `[queue] job ${job.id} failed (attempt ${job.attempts}/${job.maxAttempts}), retrying in ${Math.round(delay)}ms: ${job.lastError}`,
          );
          // Re-queue with fresh status; attempts carried over
          job.status = 'queued';
          setTimeout(() => {
            this.pending.push(job);
            void this.drain();
          }, delay);
        } else {
          console.error(
            `[queue] job ${job.id} ${nonRetryable ? 'not retryable' : 'permanently failed after ' + job.attempts + ' attempts'}: ${job.lastError}`,
          );
        }
      } finally {
        this.active.delete(job.id);
        this.notify();
        void this.drain();
      }
    })();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener('');
      } catch {
        /* listener errors must not affect the queue */
      }
    }
  }

  onChange(listener: (jobId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

// ─── Singleton wiring ────────────────────────────────────────────────────────

export interface QueueSnapshot {
  queued: number;
  active: number;
}

/**
 * Returns the process-wide queue, constructing it (and its document-processing
 * handler) on first use. Dynamic import avoids cycles with the worker module.
 */
export async function getQueue(): Promise<JobQueue> {
  const g = globalThis as unknown as { __insightdocQueue?: JobQueue };
  if (g.__insightdocQueue) return g.__insightdocQueue;

  const { processDocumentJob } = await import('@/server/worker/document-processor');
  const queue = new JobQueue(
    async (job) => {
      await processDocumentJob(job.payload);
    },
    { concurrency: 2, maxAttempts: 3 },
  );
  g.__insightdocQueue = queue;
  return queue;
}

export function queueSnapshot(queue: JobQueue): QueueSnapshot {
  return queue.stats;
}
