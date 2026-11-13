/**
 * Result shape returned by the Calendar/Settings server actions, and the mapping from thrown
 * errors to friendly sentences. Pure (checks error names instead of importing server classes),
 * so client components can import the type and server actions the helpers.
 */

export type ActionResult<T = undefined> =
  { ok: true; message?: string; data?: T } | { ok: false; error: string };

const MAX_ERROR_CHARS = 200;

/** A sentence the owner can act on. Never includes stack traces or secrets. */
export function friendlyError(e: unknown, what = 'That'): string {
  const err = e instanceof Error ? e : null;
  switch (err?.name) {
    case 'NotImplementedError':
      return `${what} is not built yet.`;
    case 'UnauthorizedError':
      return 'Your session ended. Please log in again.';
    case 'ConfigError':
      // ConfigError messages only name the missing .env key, never a value.
      return err!.message;
    case 'UserError':
      return err!.message;
    default:
      return `${what} failed. Please try again.`;
  }
}

/** Thrown inside actions for problems the owner should read as-is. */
export class UserError extends Error {
  constructor(message: string) {
    super(message.slice(0, MAX_ERROR_CHARS));
    this.name = 'UserError';
  }
}

export function ok<T>(message?: string, data?: T): ActionResult<T> {
  return { ok: true, message, data };
}

export function fail(error: string): { ok: false; error: string } {
  return { ok: false, error: error.slice(0, MAX_ERROR_CHARS) };
}
