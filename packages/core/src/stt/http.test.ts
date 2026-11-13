import { describe, expect, it, vi } from 'vitest';
import {
  classifyHttpError,
  classifyMessage,
  extractErrorDetail,
  parseRetryAfter,
  requestJson,
  scrub,
} from './http';
import { fakeFetch, json, noSleep } from './test-helpers';
import { SttError } from './types';

const KEY = 'sk-test-SECRET-1234567890';

describe('classifyHttpError', () => {
  it.each([
    [401, '{"err_code":"INVALID_AUTH","err_msg":"Invalid credentials."}', 'config'],
    [403, '{"error":{"message":"Invalid API key","code":"invalid_api_key_error"}}', 'config'],
    [
      402,
      '{"err_code":"ASR_PAYMENT_REQUIRED","err_msg":"Project does not have enough credits"}',
      'spend',
    ],
    [
      429,
      '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}',
      'spend',
    ],
    [429, '{"error":{"message":"Credits exhausted","code":"insufficient_quota_error"}}', 'spend'],
    [
      429,
      '{"error":{"message":"Quota exceeded","code":"rate_limit_exceeded_error","request_id":"r1"}}',
      'retryable',
    ],
    [
      429,
      '{"error":{"message":"Rate limit reached. Add a payment method at /account/billing"}}',
      'retryable',
    ],
    [408, 'timeout', 'retryable'],
    [500, '<html>oops</html>', 'retryable'],
    [503, '{"error":{"message":"Service overloaded"}}', 'retryable'],
    [422, 'Upload failed, please try again.', 'retryable'],
    [400, '{"err_code":"Bad Request","err_msg":"corrupt or unsupported data"}', 'fatal'],
    [413, 'too large', 'fatal'],
    [422, '{"error":{"message":"invalid language_code"}}', 'fatal'],
  ] as const)('HTTP %i → %s', (status, body, category) => {
    const err = classifyHttpError('deepgram', status, body);
    expect(err).toBeInstanceOf(SttError);
    expect(err.category).toBe(category);
    expect(err.httpStatus).toBe(status);
  });

  it('keeps Retry-After on retryable errors and never echoes the key', () => {
    const err = classifyHttpError(
      'openai',
      429,
      `{"error":{"message":"slow down ${KEY}"}}`,
      5000,
      KEY,
    );
    expect(err.retryAfterMs).toBe(5000);
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain('[redacted]');
  });

  it('classifies messages from 200 bodies', () => {
    expect(classifyMessage('assemblyai', 'Insufficient balance').category).toBe('spend');
    expect(classifyMessage('assemblyai', 'File does not appear to contain audio').category).toBe(
      'fatal',
    );
  });
});

describe('helpers', () => {
  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('garbage')).toBeUndefined();
    const now = Date.parse('2026-11-13T10:00:00Z');
    expect(parseRetryAfter('Fri, 13 Nov 2026 10:00:10 GMT', now)).toBe(10_000);
  });

  it('extracts error details from each provider shape', () => {
    expect(extractErrorDetail('{"error":{"code":"x","message":"m"}}')).toBe('x: m');
    expect(extractErrorDetail('{"err_code":"E","err_msg":"msg"}')).toBe('E: msg');
    expect(extractErrorDetail('{"error":"Authentication error"}')).toBe('Authentication error');
    expect(extractErrorDetail('{"detail":"Not found"}')).toBe('Not found');
    expect(extractErrorDetail('plain   text')).toBe('plain text');
    expect(extractErrorDetail('x'.repeat(1000))).toHaveLength(300);
  });

  it('scrubs secrets', () => {
    expect(scrub(`a ${KEY} b`, KEY)).toBe('a [redacted] b');
    expect(scrub('abc', undefined)).toBe('abc');
  });
});

describe('requestJson', () => {
  const spec = {
    provider: 'openai' as const,
    url: 'https://example.test/x',
    headers: { Authorization: `Bearer ${KEY}` },
    secret: KEY,
    body: () => 'payload',
  };

  it('retries retryable failures, honoring Retry-After', async () => {
    const { fetch, calls } = fakeFetch([
      json({ error: { message: 'busy' } }, 503, { 'retry-after': '2' }),
      new TypeError('fetch failed'),
      json({ text: 'ok' }),
    ]);
    const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => {});
    const out = await requestJson<{ text: string }>(spec, { fetch, sleep, maxAttempts: 3 });
    expect(out.text).toBe('ok');
    expect(calls).toHaveLength(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 2000]);
    // The body factory is called once per attempt.
    expect(calls.every((c) => c.body === 'payload')).toBe(true);
  });

  it('gives up after maxAttempts with a retryable error', async () => {
    const { fetch } = fakeFetch([json({}, 500), json({}, 502)]);
    await expect(
      requestJson(spec, { fetch, sleep: noSleep, maxAttempts: 2 }),
    ).rejects.toMatchObject({ category: 'retryable', httpStatus: 502 });
  });

  it('leaves long Retry-After waits to the job queue', async () => {
    const { fetch, calls } = fakeFetch([json({}, 429, { 'retry-after': '120' })]);
    await expect(requestJson(spec, { fetch, sleep: noSleep })).rejects.toMatchObject({
      category: 'retryable',
      retryAfterMs: 120_000,
    });
    expect(calls).toHaveLength(1);
  });

  it('does not retry config, spend or fatal errors', async () => {
    for (const [status, category] of [
      [401, 'config'],
      [402, 'spend'],
      [400, 'fatal'],
    ] as const) {
      const { fetch, calls } = fakeFetch([json({ error: { message: 'no' } }, status)]);
      await expect(requestJson(spec, { fetch, sleep: noSleep })).rejects.toMatchObject({
        category,
      });
      expect(calls).toHaveLength(1);
    }
  });

  it('turns a timeout into a retryable error', async () => {
    const hanging = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    ) as unknown as typeof fetch;
    await expect(
      requestJson(spec, { fetch: hanging, sleep: noSleep, timeoutMs: 20, maxAttempts: 1 }),
    ).rejects.toMatchObject({
      category: 'retryable',
      message: expect.stringContaining('timed out'),
    });
  });

  it('propagates the caller abort without retrying', async () => {
    const controller = new AbortController();
    const reason = new Error('shutdown');
    const hanging = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    ) as unknown as typeof fetch;
    const p = requestJson(spec, { fetch: hanging, sleep: noSleep }, controller.signal);
    controller.abort(reason);
    await expect(p).rejects.toBe(reason);
    expect(hanging).toHaveBeenCalledTimes(1);
  });

  it('never leaks the key in network error messages', async () => {
    const { fetch } = fakeFetch([new Error(`connect failed for ${KEY}`)]);
    const err = (await requestJson(spec, { fetch, sleep: noSleep, maxAttempts: 1 }).catch(
      (e: unknown) => e,
    )) as SttError;
    expect(err.category).toBe('retryable');
    expect(err.message).not.toContain(KEY);
  });

  it('treats a non-JSON 2xx as retryable', async () => {
    const { fetch } = fakeFetch([new Response('<html>gateway</html>', { status: 200 })]);
    await expect(
      requestJson(spec, { fetch, sleep: noSleep, maxAttempts: 1 }),
    ).rejects.toMatchObject({ category: 'retryable' });
  });
});
