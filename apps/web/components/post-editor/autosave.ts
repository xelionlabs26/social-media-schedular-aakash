/**
 * Debounced autosave for one target's fields: edits are merged into one pending patch, saved
 * 800 ms after the last keystroke (or at once on blur / before an action), one request at a
 * time. Unsaved edits survive a failed save so nothing typed is lost. Pure TypeScript (timers
 * injectable for tests).
 */

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict';

export type SaveResult = { ok: true } | { ok: false; error: string; conflict?: boolean };

export interface AutosaveOptions<P> {
  delayMs: number;
  save: (patch: P) => Promise<SaveResult>;
  merge: (older: P, newer: P) => P;
  onStatus: (status: SaveStatus, error?: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class AutosaveController<P> {
  private pending: P | null = null;
  private timer: unknown = null;
  private inflight: Promise<void> | null = null;
  private status: SaveStatus = 'idle';
  private disposed = false;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly opts: AutosaveOptions<P>) {
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  getStatus(): SaveStatus {
    return this.status;
  }

  hasUnsaved(): boolean {
    return this.pending !== null || this.inflight !== null;
  }

  /** Records an edit and (re)starts the debounce timer. */
  change(patch: P): void {
    if (this.disposed) return;
    this.pending = this.pending ? this.opts.merge(this.pending, patch) : patch;
    // While in conflict, wait for the owner to choose (reload or keep mine).
    if (this.status === 'conflict') return;
    this.setStatus('pending');
    this.restartTimer();
  }

  /** Saves pending edits now and resolves when everything typed so far is saved (or failed). */
  async flush(): Promise<void> {
    this.stopTimer();
    while (!this.disposed) {
      if (this.inflight) {
        await this.inflight;
        continue;
      }
      if (this.pending === null || this.status === 'conflict') return;
      this.inflight = this.run();
      await this.inflight;
      // Stop after a failure; the edits stay pending for the next try. (getStatus() because
      // run() changed the status while we awaited.)
      const after = this.getStatus();
      if (after === 'error' || after === 'conflict') return;
    }
  }

  /** After a conflict: retry with the pending edits (the caller decides how to save them). */
  async resolveConflict(): Promise<void> {
    if (this.status !== 'conflict') return;
    this.setStatus('pending');
    await this.flush();
  }

  /** Drops unsaved edits (after reloading the server version). */
  discard(): void {
    this.stopTimer();
    this.pending = null;
    this.setStatus('idle');
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimer();
  }

  private async run(): Promise<void> {
    const patch = this.pending!;
    this.pending = null;
    this.setStatus('saving');
    let result: SaveResult;
    try {
      result = await this.opts.save(patch);
    } catch {
      result = { ok: false, error: 'Could not reach the server.' };
    }
    this.inflight = null;
    if (result.ok) {
      if (this.pending !== null) {
        // More typing happened during the save: save that too (after the debounce).
        this.setStatus('pending');
        this.restartTimer();
      } else {
        this.setStatus('saved');
      }
      return;
    }
    // Keep what failed, plus anything typed meanwhile (newer wins).
    this.pending = this.pending ? this.opts.merge(patch, this.pending) : patch;
    this.setStatus(result.conflict ? 'conflict' : 'error', result.error);
  }

  private restartTimer(): void {
    this.stopTimer();
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, this.opts.delayMs);
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private setStatus(status: SaveStatus, error?: string): void {
    this.status = status;
    if (!this.disposed) this.opts.onStatus(status, error);
  }
}
