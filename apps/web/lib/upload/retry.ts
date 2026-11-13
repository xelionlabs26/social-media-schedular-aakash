/**
 * Retry policy for browser uploads. Pure and client-safe.
 */

/**
 * Delay before retry number `attempt` (1 = first retry): 1 s, 3 s, 9 s … capped at `maxMs`,
 * with ±20 % jitter so parallel uploads that failed together don't retry in lockstep.
 */
export function backoffDelayMs(
  attempt: number,
  opts: { baseMs?: number; factor?: number; maxMs?: number; random?: () => number } = {},
): number {
  const { baseMs = 1000, factor = 3, maxMs = 30_000, random = Math.random } = opts;
  const raw = Math.min(maxMs, baseMs * factor ** Math.max(0, attempt - 1));
  const jitter = 0.8 + random() * 0.4;
  return Math.round(raw * jitter);
}

/**
 * Whether an HTTP status from a storage PUT is worth retrying. 0 = network error / aborted by
 * the stall timer. 403 is retried too because it usually means the signed URL expired; the
 * queue asks for a fresh URL before the next try.
 */
export function isRetryableStatus(status: number): boolean {
  return (
    status === 0 ||
    status === 403 ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

/** Error raised by an upload transport. */
export class UploadError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
    /** The signed URL was rejected (likely expired): get a new one before retrying. */
    public readonly needsNewTarget = status === 403,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/** Thrown when the user cancels; never retried. */
export class UploadCanceledError extends Error {
  constructor() {
    super('Upload canceled');
    this.name = 'UploadCanceledError';
  }
}

/** Human message for a failed upload, shown on the card. */
export function uploadErrorMessage(err: unknown): string {
  if (err instanceof UploadError) {
    if (err.status === 0) return 'Upload failed (network)';
    if (err.status === 403) return 'Upload link expired';
    if (err.status === 413) return 'File is too large';
    if (err.status === 415) return 'File type not accepted';
    if (err.status >= 500) return 'Storage server error';
    return err.message || `Upload failed (HTTP ${err.status})`;
  }
  if (err instanceof Error && err.message) return err.message;
  return 'Upload failed';
}
