/**
 * Runtime shared by the Meta integrations: how they get configuration and an HTTP client.
 * Injectable so tests (and the worker) can pass a fake fetch / env / clock.
 */
import { getEnv, type Env } from '../env';
import { PlatformError, isPlatformError, type PublishInput } from '../platforms';
import type { GraphErrorDetails } from './errors';
import { GraphClient, type FetchFn } from './graph';

export interface MetaRuntimeOptions {
  /** Defaults to the process environment. */
  env?: () => Env;
  fetch?: FetchFn;
}

export interface MetaRuntime {
  env(): Env;
  client(signal?: AbortSignal): GraphClient;
}

export function createMetaRuntime(opts: MetaRuntimeOptions = {}): MetaRuntime {
  const env = opts.env ?? (() => getEnv());
  return {
    env,
    client(signal) {
      const e = env();
      return new GraphClient({
        version: e.GRAPH_VERSION,
        appSecret: e.META_APP_SECRET,
        fetch: opts.fetch,
        signal,
      });
    },
  };
}

/** "Object does not exist" (code 100 / subcode 33) or HTTP 404. */
export function isNotFound(err: unknown): boolean {
  if (!isPlatformError(err)) return false;
  const d = (err.details ?? {}) as GraphErrorDetails;
  return err.httpStatus === 404 || (d.code === 100 && d.subcode === 33);
}

/** Logs a platform step to the History panel without letting a logging failure break publishing. */
export async function logStepSafe(
  input: PublishInput,
  step: Parameters<PublishInput['logStep']>[0],
  log: Parameters<PublishInput['logStep']>[1],
): Promise<void> {
  try {
    await input.logStep(step, log);
  } catch {
    // History is best-effort; the engine records the overall outcome itself.
  }
}

/** Logs a failed step (with the safe error excerpt) and rethrows. */
export async function logFailure(
  input: PublishInput,
  step: Parameters<PublishInput['logStep']>[0],
  err: unknown,
): Promise<never> {
  if (isPlatformError(err)) {
    await logStepSafe(input, step, {
      outcome: err.category === 'retryable' ? 'retryable' : 'fatal',
      httpStatus: err.httpStatus,
      platformCode: err.code,
      message: err.message,
      responseExcerpt: err.details,
    });
  }
  throw err;
}

export function requirePageId(input: PublishInput): string {
  const id = input.account.meta.pageId ?? input.account.externalId;
  if (!id) throw new PlatformError('auth', 'No Facebook Page is connected. Reconnect Facebook.');
  return id;
}
