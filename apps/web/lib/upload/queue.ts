/**
 * Browser upload queue: N files at a time, per-file retry with backoff, cancel, and a
 * "finalize" step (the completeUpload server action) after the bytes arrive.
 *
 * The network transport is injected (XHR in the browser, a fake in tests), so this file is pure
 * TypeScript with no DOM access. React reads it through `subscribe` + `getSnapshot`
 * (useSyncExternalStore).
 */
import { UPLOAD_CONCURRENCY, UPLOAD_MAX_ATTEMPTS, UPLOAD_TARGET_MAX_AGE_MS } from './constants';
import { backoffDelayMs, UploadCanceledError, UploadError, uploadErrorMessage } from './retry';

export type UploadPhase = 'queued' | 'uploading' | 'finalizing' | 'done' | 'failed' | 'canceled';

export interface UploadTargetInfo {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
}

export interface UploadJob {
  /** Asset id. */
  id: string;
  file: Blob;
  target: UploadTargetInfo;
  /** When `target` was signed (ms since epoch). */
  issuedAt: number;
  /** Local storage driver: send the file in chunks of this many bytes. */
  chunkSize?: number;
}

export interface UploadItem {
  id: string;
  phase: UploadPhase;
  loaded: number;
  total: number;
  /** Tries started so far. */
  attempt: number;
  error: string | null;
}

export type UploadTransport = (
  job: UploadJob,
  ctx: { signal: AbortSignal; onProgress: (loadedBytes: number) => void },
) => Promise<void>;

export type FinalizeOutcome =
  | { ok: true }
  /** reupload = the stored file is missing or incomplete, so the bytes must be sent again. */
  | { ok: false; error: string; reupload: boolean };

export interface UploadQueueOptions {
  transport: UploadTransport;
  finalize: (id: string) => Promise<FinalizeOutcome>;
  /** Fresh signed URL for a file (called when the old one is too old or was rejected). */
  renewTarget?: (id: string) => Promise<{ target: UploadTargetInfo; chunkSize?: number }>;
  concurrency?: number;
  maxAttempts?: number;
  targetMaxAgeMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  backoff?: (attempt: number) => number;
  /** Called once when a file is fully uploaded and finalized. */
  onDone?: (id: string) => void;
  /** Progress notifications are batched to at most one per this many ms. */
  progressThrottleMs?: number;
}

interface Entry {
  job: UploadJob;
  phase: UploadPhase;
  loaded: number;
  attempt: number;
  error: string | null;
  /** Bytes are in storage; only the finalize step is left. */
  uploaded: boolean;
  /** The last try was rejected for an expired/invalid URL. */
  wantsNewTarget: boolean;
  controller: AbortController | null;
}

/** Thrown when finalize fails without needing a re-upload (retry the finalize step only). */
class FinalizeError extends Error {
  constructor(
    message: string,
    public readonly reupload: boolean,
  ) {
    super(message);
    this.name = 'FinalizeError';
  }
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new UploadCanceledError());
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new UploadCanceledError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

export class UploadQueue {
  private readonly entries = new Map<string, Entry>();
  /** FIFO of ids, in the order they were added. */
  private readonly order: string[] = [];
  private active = 0;
  private listeners = new Set<() => void>();
  private snapshot: UploadItem[] = [];
  private snapshotStale = true;
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly opts: Required<
    Omit<UploadQueueOptions, 'renewTarget' | 'onDone' | 'transport' | 'finalize'>
  > &
    Pick<UploadQueueOptions, 'renewTarget' | 'onDone' | 'transport' | 'finalize'>;

  constructor(options: UploadQueueOptions) {
    this.opts = {
      concurrency: UPLOAD_CONCURRENCY,
      maxAttempts: UPLOAD_MAX_ATTEMPTS,
      targetMaxAgeMs: UPLOAD_TARGET_MAX_AGE_MS,
      now: () => Date.now(),
      sleep: defaultSleep,
      backoff: (attempt) => backoffDelayMs(attempt),
      progressThrottleMs: 150,
      ...options,
    };
  }

  // ---- React store interface ---------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): UploadItem[] => {
    if (this.snapshotStale) {
      this.snapshot = this.order
        .map((id) => this.entries.get(id))
        .filter((e): e is Entry => Boolean(e))
        .map((e) => ({
          id: e.job.id,
          phase: e.phase,
          loaded: e.loaded,
          total: e.job.file.size,
          attempt: e.attempt,
          error: e.error,
        }));
      this.snapshotStale = false;
    }
    return this.snapshot;
  };

  get(id: string): UploadItem | undefined {
    return this.getSnapshot().find((i) => i.id === id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  // ---- Commands ----------------------------------------------------------------------------

  /** Adds files (ignores ids already in the queue) and starts uploading. */
  add(jobs: UploadJob[]): void {
    for (const job of jobs) {
      if (this.entries.has(job.id)) continue;
      this.entries.set(job.id, {
        job,
        phase: 'queued',
        loaded: 0,
        attempt: 0,
        error: null,
        uploaded: false,
        wantsNewTarget: false,
        controller: null,
      });
      this.order.push(job.id);
    }
    this.changed();
    this.pump();
  }

  /** Starts a failed (or canceled) file again with a fresh set of tries. */
  retry(id: string): void {
    const e = this.entries.get(id);
    if (!e || (e.phase !== 'failed' && e.phase !== 'canceled')) return;
    e.phase = 'queued';
    e.attempt = 0;
    e.error = null;
    this.changed();
    this.pump();
  }

  /** Stops a queued or running upload. */
  cancel(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    if (e.phase === 'queued' || e.phase === 'failed') {
      e.phase = 'canceled';
      this.changed();
    } else if (e.phase === 'uploading' || e.phase === 'finalizing') {
      e.controller?.abort();
    }
  }

  /** Forgets a file (cancels it first if needed). */
  remove(id: string): void {
    this.cancel(id);
    this.entries.delete(id);
    const idx = this.order.indexOf(id);
    if (idx >= 0) this.order.splice(idx, 1);
    this.changed();
  }

  /** True while any file is queued, uploading or finalizing. */
  isBusy(): boolean {
    for (const e of this.entries.values()) {
      if (e.phase === 'queued' || e.phase === 'uploading' || e.phase === 'finalizing') return true;
    }
    return false;
  }

  /** Cancels everything (page unload). */
  dispose(): void {
    for (const id of [...this.order]) this.cancel(id);
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.listeners.clear();
  }

  // ---- Internals ---------------------------------------------------------------------------

  private changed(): void {
    this.snapshotStale = true;
    if (this.progressTimer) {
      clearTimeout(this.progressTimer);
      this.progressTimer = null;
    }
    for (const l of this.listeners) l();
  }

  /** Progress events arrive many times a second; batch them so React renders calmly. */
  private progressChanged(): void {
    this.snapshotStale = true;
    if (this.progressTimer) return;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      for (const l of this.listeners) l();
    }, this.opts.progressThrottleMs);
  }

  private pump(): void {
    while (this.active < this.opts.concurrency) {
      const next = this.order.map((id) => this.entries.get(id)).find((e) => e?.phase === 'queued');
      if (!next) return;
      this.active += 1;
      next.phase = 'uploading';
      this.changed();
      void this.run(next).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  private async run(e: Entry): Promise<void> {
    const controller = new AbortController();
    e.controller = controller;
    const { signal } = controller;
    try {
      for (;;) {
        e.attempt += 1;
        e.error = null;
        this.changed();
        try {
          if (!e.uploaded) await this.upload(e, signal);
          e.phase = 'finalizing';
          e.loaded = e.job.file.size;
          this.changed();
          const outcome = await this.opts.finalize(e.job.id).catch((err: unknown) => {
            // A failed server-action call (network) is worth retrying without re-uploading.
            throw new FinalizeError(err instanceof Error ? err.message : 'Could not save', false);
          });
          if (signal.aborted) throw new UploadCanceledError();
          if (!outcome.ok) throw new FinalizeError(outcome.error, outcome.reupload);
          e.phase = 'done';
          this.changed();
          this.opts.onDone?.(e.job.id);
          return;
        } catch (err) {
          if (signal.aborted || err instanceof UploadCanceledError) throw new UploadCanceledError();
          const retryable = this.noteFailure(e, err);
          if (!retryable || e.attempt >= this.opts.maxAttempts) {
            e.phase = 'failed';
            e.error = err instanceof FinalizeError ? err.message : uploadErrorMessage(err);
            this.changed();
            return;
          }
          e.phase = 'uploading';
          e.error = 'Retrying…';
          this.changed();
          await this.opts.sleep(this.opts.backoff(e.attempt), signal);
        }
      }
    } catch (err) {
      if (err instanceof UploadCanceledError || signal.aborted) {
        e.phase = 'canceled';
        e.error = null;
        this.changed();
        return;
      }
      e.phase = 'failed';
      e.error = uploadErrorMessage(err);
      this.changed();
    } finally {
      e.controller = null;
    }
  }

  private async upload(e: Entry, signal: AbortSignal): Promise<void> {
    const tooOld = this.opts.now() - e.job.issuedAt > this.opts.targetMaxAgeMs;
    if (this.opts.renewTarget && (e.wantsNewTarget || tooOld)) {
      const renewed = await this.opts.renewTarget(e.job.id);
      e.job = { ...e.job, ...renewed, issuedAt: this.opts.now() };
      e.wantsNewTarget = false;
    }
    e.loaded = 0;
    this.changed();
    await this.opts.transport(e.job, {
      signal,
      onProgress: (loaded) => {
        e.loaded = Math.min(loaded, e.job.file.size);
        this.progressChanged();
      },
    });
    e.uploaded = true;
  }

  /** Records what the failure means for the next try; returns whether to retry at all. */
  private noteFailure(e: Entry, err: unknown): boolean {
    if (err instanceof FinalizeError) {
      if (err.reupload) e.uploaded = false;
      return true;
    }
    if (err instanceof UploadError) {
      if (err.needsNewTarget) e.wantsNewTarget = true;
      return err.retryable;
    }
    // Unknown errors (e.g. renewTarget's server action failed on a flaky network): retry.
    return true;
  }
}
