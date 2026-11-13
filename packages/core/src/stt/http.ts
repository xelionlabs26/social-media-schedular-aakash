/**
 * HTTP plumbing shared by the STT providers: timeouts, error classification and a small
 * in-process retry loop that honors Retry-After. Longer waits are left to the job queue.
 */
import type { SttProvider } from '@app/db';
import { SttError, type ProviderOptions } from './types';

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Never block a worker longer than this inside one call; beyond it the job queue retries. */
const MAX_INLINE_WAIT_MS = 30_000;
const MAX_DETAIL_CHARS = 300;

/**
 * Billing problems are reported in different ways: Deepgram 402 ASR_PAYMENT_REQUIRED,
 * Sarvam 402 `insufficient_quota_error` (older docs: 429), OpenAI 429 `insufficient_quota`
 * ("You exceeded your current quota, please check your plan and billing details").
 * They are not worth retrying. A plain rate limit (Sarvam `rate_limit_exceeded_error`, whose
 * title also says "Quota Exceeded") must stay retryable, hence RATE_LIMIT_RE.
 */
const SPEND_RE =
  /insufficient[_ ]quota|exceeded your (current )?quota|(not enough|insufficient|out of|no remaining) credits?|credit balance|billing|payment[_ ]required|insufficient[_ ](funds|balance)|out of balance/i;
const RATE_LIMIT_RE = /rate[_ ]limit/i;

function looksLikeSpend(text: string): boolean {
  return SPEND_RE.test(text) && !RATE_LIMIT_RE.test(text);
}

const TRANSIENT_422_RE = /try again|unable to read the entire|interrupted/i;

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Parses Retry-After (delta seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

/** Pulls a human-readable message out of the different provider error bodies. */
export function extractErrorDetail(body: string): string {
  let detail = body;
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    const err = json.error;
    if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>;
      detail = [e.code, e.message].filter((v) => typeof v === 'string').join(': ') || body;
    } else if (typeof err === 'string') {
      detail = err;
    } else if (typeof json.err_msg === 'string') {
      detail = [json.err_code, json.err_msg].filter((v) => typeof v === 'string').join(': ');
    } else if (typeof json.message === 'string') {
      detail = json.message;
    } else if (typeof json.detail === 'string') {
      detail = json.detail;
    }
  } catch {
    // Not JSON (e.g. AssemblyAI's plain-text 422, or a proxy HTML page): use the raw text.
  }
  return detail.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_CHARS);
}

/** Removes the API key from text in case a provider echoes request headers back. */
export function scrub(text: string, secret: string | undefined): string {
  if (!secret || secret.length < 6) return text;
  return text.split(secret).join('[redacted]');
}

/**
 * Maps an HTTP failure to an SttError category:
 * 401/403 → config, 402 or billing wording → spend, 408/429/5xx → retryable, rest → fatal.
 */
export function classifyHttpError(
  provider: SttProvider,
  status: number,
  body: string,
  retryAfterMs?: number,
  secret?: string,
): SttError {
  const detail = scrub(extractErrorDetail(body), secret);
  const message = `${provider} speech-to-text failed (HTTP ${status})${detail ? `: ${detail}` : ''}`;
  if (status === 402 || looksLikeSpend(body)) return new SttError('spend', message, status);
  if (status === 401 || status === 403) return new SttError('config', message, status);
  // An interrupted upload (AssemblyAI 422 "Upload failed, please try again", Deepgram 422
  // ASR_UNPROCESSABLE_ENTITY "Unable to read the entire client request") is worth another try.
  if (status === 422 && TRANSIENT_422_RE.test(body)) {
    return new SttError('retryable', message, status, retryAfterMs);
  }
  if (status === 408 || status === 429 || status >= 500) {
    return new SttError('retryable', message, status, retryAfterMs);
  }
  return new SttError('fatal', message, status);
}

/** Message-only variant for providers that report failures inside a 200 body. */
export function classifyMessage(provider: SttProvider, detail: string): SttError {
  const message = `${provider} speech-to-text failed: ${detail.slice(0, MAX_DETAIL_CHARS)}`;
  return new SttError(looksLikeSpend(detail) ? 'spend' : 'fatal', message);
}

export interface RequestSpec {
  provider: SttProvider;
  url: string;
  method?: 'GET' | 'POST';
  headers: Record<string, string>;
  /** A factory, because a body (FormData/stream) may only be readable once per attempt. */
  body?: () => NonNullable<RequestInit['body']>;
  /** The API key, only so it can be scrubbed from error messages. */
  secret?: string;
}

/**
 * Sends one request with a timeout, retrying retryable failures a few times (honoring
 * Retry-After). Resolves with the parsed JSON body of a 2xx response; throws SttError otherwise.
 */
export async function requestJson<T>(
  spec: RequestSpec,
  opts: ProviderOptions = {},
  signal?: AbortSignal,
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const sleep = opts.sleep ?? defaultSleep;
  let lastError: SttError | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await requestOnce<T>(spec, opts, signal);
    } catch (err) {
      if (!(err instanceof SttError) || err.category !== 'retryable') throw err;
      lastError = err;
      if (attempt === maxAttempts) break;
      const wait = err.retryAfterMs ?? 1000 * 2 ** (attempt - 1);
      // A long Retry-After is better served by the job queue than by holding a worker slot.
      if (wait > MAX_INLINE_WAIT_MS) break;
      await sleep(wait, signal);
    }
  }
  throw lastError!;
}

async function requestOnce<T>(
  spec: RequestSpec,
  opts: ProviderOptions,
  signal?: AbortSignal,
): Promise<T> {
  const doFetch = opts.fetch ?? fetch;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await doFetch(spec.url, {
      method: spec.method ?? 'POST',
      headers: spec.headers,
      body: spec.body?.(),
      signal: combined,
    });
  } catch (err) {
    // The caller cancelled: propagate their reason untouched instead of asking for a retry.
    if (signal?.aborted) throw signal.reason;
    const what = timeout.aborted ? 'timed out' : 'network error';
    const detail = err instanceof Error ? scrub(err.message, spec.secret) : String(err);
    throw new SttError('retryable', `${spec.provider} speech-to-text ${what}: ${detail}`);
  }

  const text = await readText(res, spec, signal);
  if (!res.ok) {
    throw classifyHttpError(
      spec.provider,
      res.status,
      text,
      parseRetryAfter(res.headers.get('retry-after')),
      spec.secret,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    // A 2xx with a non-JSON body is usually a proxy or gateway page; it may work next time.
    throw new SttError(
      'retryable',
      `${spec.provider} speech-to-text returned an unreadable response (HTTP ${res.status})`,
      res.status,
    );
  }
}

async function readText(res: Response, spec: RequestSpec, signal?: AbortSignal): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    const detail = err instanceof Error ? err.message : String(err);
    throw new SttError(
      'retryable',
      `${spec.provider} speech-to-text response was cut off: ${scrub(detail, spec.secret)}`,
      res.status,
    );
  }
}
