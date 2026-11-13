/**
 * Turns anything a server action can throw into a short message for the owner. Server actions
 * never return stack traces, SQL or platform responses: unknown errors are logged and replaced
 * by a generic sentence. Errors are matched by `name` (not instanceof) so this file stays free
 * of heavy imports and works across bundler module copies.
 */
import { ZodError } from 'zod';
import type { Logger } from '@app/core/log';
import type { ActionError, ActionErrorCode } from './types';

/** An error whose message is written for the owner and safe to show as-is. */
export class UserError extends Error {
  constructor(
    message: string,
    public readonly code: ActionErrorCode = 'error',
  ) {
    super(message);
    this.name = 'UserError';
  }
}

const FEATURE_BY_MODULE: Record<string, string> = {
  scheduling: 'Scheduling',
  ai: 'AI writing',
  media: 'Video processing',
  stt: 'Speech-to-text',
  youtube: 'YouTube publishing',
  meta: 'Facebook/Instagram publishing',
  notify: 'Alerts',
};

/** "scheduling.schedulePosts is not implemented yet" -> "Scheduling isn't available yet …". */
function notImplementedMessage(message: string): string {
  const mod = /^([a-z]+)\./i.exec(message)?.[1]?.toLowerCase() ?? '';
  const feature = FEATURE_BY_MODULE[mod] ?? 'This feature';
  return `${feature} isn't available yet in this version of the app.`;
}

const AI_MESSAGES: Record<string, string> = {
  spend: 'AI paused: the spend limit was reached or the credit balance is empty.',
  refusal: 'The AI declined to write this. Please write it yourself.',
  config: 'AI is not set up (add ANTHROPIC_API_KEY, or set AI_MOCK=true to try it).',
  retryable: 'The AI is busy right now. Try again in a minute.',
  fatal: 'The AI could not write this. Try again or write it yourself.',
};

function isVersionConflict(err: Error & { code?: unknown }): boolean {
  if (/conflict/i.test(err.name) || err.code === 'version_conflict' || err.code === 'conflict') {
    return true;
  }
  return /version/i.test(err.message) && /(conflict|mismatch|changed|stale)/i.test(err.message);
}

export function toActionError(err: unknown, log?: Logger, context?: string): ActionError {
  const fail = (error: string, code: ActionErrorCode): ActionError => ({ ok: false, error, code });

  if (err instanceof ZodError) {
    const first = err.issues[0];
    const where = first?.path.length ? ` (${first.path.join('.')})` : '';
    return fail(`Invalid input${where}: ${first?.message ?? 'check the values'}`, 'validation');
  }
  if (err instanceof Error) {
    const e = err as Error & { code?: unknown; category?: unknown; userMessage?: unknown };
    switch (e.name) {
      case 'UserError':
        return fail(e.message, ((e as UserError).code ?? 'error') as ActionErrorCode);
      case 'UnauthorizedError':
        return fail('Your session has ended. Please log in again.', 'unauthorized');
      case 'NotImplementedError':
        return fail(notImplementedMessage(e.message), 'not_implemented');
      case 'AiError':
        return fail(AI_MESSAGES[String(e.category)] ?? AI_MESSAGES.fatal!, 'error');
      case 'ConfigError':
        return fail(`${e.message}`, 'unavailable');
    }
    if (isVersionConflict(e)) {
      return fail('This was changed somewhere else (another tab or the worker).', 'conflict');
    }
    // Other modules may attach a message meant for the owner.
    if (typeof e.userMessage === 'string' && e.userMessage) return fail(e.userMessage, 'error');
  }
  log?.error(`Action failed${context ? `: ${context}` : ''}`, {
    err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
  });
  return fail('Something went wrong. Please try again.', 'error');
}
