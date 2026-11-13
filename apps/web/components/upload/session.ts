/**
 * The browser's upload state for this tab, kept outside React so uploads keep going (and stay
 * visible) when the owner opens the Calendar and comes back. One instance per tab, created
 * lazily in the browser only.
 */
import { completeUpload, renewUpload } from '@/lib/actions/upload';
import { UploadQueue, type UploadItem, type UploadTargetInfo } from '@/lib/upload/queue';
import { xhrTransport } from '@/lib/upload/xhr';
import { createProber, type LocalProbe } from './probe';

export interface LocalFile {
  localKey: string;
  file: File;
}

export interface SessionSnapshot {
  uploads: UploadItem[];
  /** By asset id. */
  locals: Record<string, LocalFile>;
  /** By local key. */
  probes: Record<string, LocalProbe>;
}

export interface SessionHandlers {
  /** completeUpload succeeded for an asset (its post now exists). */
  onFinalized?: (assetId: string, postId: string, warning?: string) => void;
}

export const EMPTY_SNAPSHOT: SessionSnapshot = { uploads: [], locals: {}, probes: {} };

export class UploadSession {
  readonly queue: UploadQueue;
  handlers: SessionHandlers = {};
  private locals: Record<string, LocalFile> = {};
  private probes: Record<string, LocalProbe> = {};
  private listeners = new Set<() => void>();
  private snapshot: SessionSnapshot = EMPTY_SNAPSHOT;
  private readonly prober = createProber(2);

  constructor() {
    this.queue = new UploadQueue({
      transport: xhrTransport,
      finalize: async (assetId) => {
        const res = await completeUpload(assetId);
        if (res.ok) {
          this.handlers.onFinalized?.(assetId, res.postId, res.warning);
          return { ok: true };
        }
        return {
          ok: false,
          error: res.error,
          reupload: res.code === 'upload_missing' || res.code === 'size_mismatch',
        };
      },
      renewTarget: async (assetId) => {
        const res = await renewUpload(assetId);
        if (!res.ok) throw new Error(res.error);
        return { target: res.upload.target, chunkSize: res.upload.chunkSize };
      },
    });
    this.queue.subscribe(() => this.emit());
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SessionSnapshot => this.snapshot;

  /** Reads length/shape/thumbnail of a picked file in the background. */
  probe(localKey: string, file: File): void {
    if (this.probes[localKey]) return;
    void this.prober(file).then((probe) => {
      this.probes = { ...this.probes, [localKey]: probe };
      this.emit();
    });
  }

  /** Starts uploading files the server has registered. */
  start(
    uploads: Array<{
      assetId: string;
      local: LocalFile;
      target: UploadTargetInfo;
      chunkSize?: number;
    }>,
  ): void {
    const locals = { ...this.locals };
    for (const u of uploads) {
      locals[u.assetId] = u.local;
      // A re-selected file replaces whatever the queue still remembers for that asset.
      if (this.queue.has(u.assetId)) this.queue.remove(u.assetId);
    }
    this.locals = locals;
    this.queue.add(
      uploads.map((u) => ({
        id: u.assetId,
        file: u.local.file,
        target: u.target,
        issuedAt: Date.now(),
        ...(u.chunkSize ? { chunkSize: u.chunkSize } : {}),
      })),
    );
    this.emit();
  }

  /** Stops and forgets an upload (Cancel / Remove). */
  forget(assetId: string): void {
    this.queue.remove(assetId);
    if (this.locals[assetId]) {
      const { [assetId]: _gone, ...rest } = this.locals;
      void _gone;
      this.locals = rest;
    }
    this.emit();
  }

  private emit(): void {
    this.snapshot = {
      uploads: this.queue.getSnapshot(),
      locals: this.locals,
      probes: this.probes,
    };
    for (const l of this.listeners) l();
  }
}

let session: UploadSession | null = null;

/** The tab's upload session (browser only). */
export function getUploadSession(): UploadSession {
  session ??= new UploadSession();
  return session;
}
