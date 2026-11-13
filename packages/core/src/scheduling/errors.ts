/**
 * Errors the scheduling services throw to the UI. The message is written for the owner and can
 * be shown as-is; `code` lets the UI pick a style (e.g. reload the editor on a version conflict).
 */
export type SchedulingErrorCode =
  | 'not_found'
  /** The target changed since the editor loaded it (expectedVersion mismatch). */
  | 'version_conflict'
  /** The target is being published right now or is already published. */
  | 'locked'
  /** The request can't be done as asked (bad time, nothing to retry, invalid text...). */
  | 'invalid';

export class SchedulingError extends Error {
  readonly code: SchedulingErrorCode;
  constructor(code: SchedulingErrorCode, message: string) {
    super(message);
    this.name = 'SchedulingError';
    this.code = code;
  }
}

export const isSchedulingError = (e: unknown): e is SchedulingError => e instanceof SchedulingError;
