import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../log';
import { RETRY_MAX_TOKENS, callClaude, finalText, toAiError } from './client';
import { buildRequest } from './prompt';
import { fakeClient, fakeMessage, sampleOutput } from './test-helpers';
import { AiError } from './types';

const log = createLogger('test');

function apiError(status: number, type: string, message: string, extra: object = {}, headers = {}) {
  return Anthropic.APIError.generate(
    status,
    { type: 'error', error: { type, message, ...extra } },
    message,
    new Headers(headers),
  );
}

describe('toAiError', () => {
  it('maps a ramp-limit 429 to retryable and honors retry-after', () => {
    const e = toAiError(
      apiError(
        429,
        'rate_limit_error',
        'ramp',
        { details: { error_code: 'ramp_limit_exceeded' } },
        {
          'retry-after': '17',
        },
      ),
    );
    expect(e.category).toBe('retryable');
    expect(e.retryAfterSec).toBe(17);
  });

  it('maps a plain 429 to retryable', () => {
    expect(toAiError(apiError(429, 'rate_limit_error', 'slow down')).category).toBe('retryable');
  });

  it('maps the tier spend cap (429 enforced_spend_limit_reached) to spend', () => {
    const e = toAiError(
      apiError(429, 'rate_limit_error', 'You have reached your API usage limits', {
        details: { error_code: 'enforced_spend_limit_reached' },
      }),
    );
    expect(e.category).toBe('spend');
  });

  it('maps the owner-set spend limit (400) and low credit to spend', () => {
    expect(
      toAiError(
        apiError(
          400,
          'invalid_request_error',
          'You have reached your specified API usage limits. You will regain access on 2026-12-01',
        ),
      ).category,
    ).toBe('spend');
    expect(
      toAiError(
        apiError(
          400,
          'invalid_request_error',
          'Your credit balance is too low to access the Anthropic API.',
        ),
      ).category,
    ).toBe('spend');
    expect(toAiError(apiError(402, 'billing_error', 'billing')).category).toBe('spend');
  });

  it('maps other 400s to fatal', () => {
    expect(toAiError(apiError(400, 'invalid_request_error', 'bad schema')).category).toBe('fatal');
  });

  it('maps 401/403 to config without leaking details', () => {
    const e = toAiError(apiError(401, 'authentication_error', 'invalid x-api-key'));
    expect(e.category).toBe('config');
    expect(e.message).toContain('ANTHROPIC_API_KEY');
    expect(toAiError(apiError(403, 'permission_error', 'nope')).category).toBe('config');
  });

  it('maps 5xx, 529 and connection errors to retryable', () => {
    expect(toAiError(apiError(500, 'api_error', 'oops')).category).toBe('retryable');
    expect(toAiError(apiError(529, 'overloaded_error', 'busy')).category).toBe('retryable');
    expect(toAiError(new Anthropic.APIConnectionError({ message: 'reset' })).category).toBe(
      'retryable',
    );
    expect(toAiError(new Anthropic.APIConnectionTimeoutError()).category).toBe('retryable');
  });

  it('passes AiError through and maps unknown errors to fatal', () => {
    const a = new AiError('refusal', 'no');
    expect(toAiError(a)).toBe(a);
    expect(toAiError(new Error('boom')).category).toBe('fatal');
  });
});

function params(model = 'claude-opus-5-5') {
  return buildRequest({ model, effort: 'low', system: 'sys', videoBlocks: [], task: 'task' });
}

describe('callClaude', () => {
  it('parses a normal response and reports usage for every response', async () => {
    const client = fakeClient([fakeMessage(sampleOutput())]);
    const seen: string[] = [];
    const res = await callClaude(client, params(), {
      log,
      onResponse: (_m, id) => seen.push(String(id)),
    });
    expect(res.output.youtube.title).toBe('Chai mein ye daala aur sab hairan');
    expect(res.requestId).toBe('req_1');
    expect(seen).toEqual(['req_1']);
  });

  it('turns a refusal into AiError(refusal) without a client retry on Opus (server fallback)', async () => {
    const client = fakeClient([fakeMessage('', { stop: 'refusal' })]);
    await expect(callClaude(client, params(), { log, onResponse: () => {} })).rejects.toMatchObject(
      { category: 'refusal' },
    );
    expect(client.calls).toHaveLength(1);
  });

  it('retries a refusal once on Haiku (no server fallback)', async () => {
    const client = fakeClient([
      fakeMessage('', { stop: 'refusal', model: 'claude-haiku-5-5' }),
      fakeMessage(sampleOutput(), { model: 'claude-haiku-5-5' }),
    ]);
    const res = await callClaude(client, params('claude-haiku-5-5'), { log, onResponse: () => {} });
    expect(res.output.summary).toBeTruthy();
    expect(client.calls).toHaveLength(2);
  });

  it('retries max_tokens once with more room, then gives up', async () => {
    const ok = fakeClient([
      fakeMessage('{"trunc', { stop: 'max_tokens' }),
      fakeMessage(sampleOutput()),
    ]);
    const counted: number[] = [];
    await callClaude(ok, params(), { log, onResponse: () => counted.push(1) });
    expect(ok.calls[0]!.max_tokens).toBe(12_000);
    expect(ok.calls[1]!.max_tokens).toBe(RETRY_MAX_TOKENS);
    expect(counted).toHaveLength(2);

    const bad = fakeClient([
      fakeMessage('{', { stop: 'max_tokens' }),
      fakeMessage('{', { stop: 'max_tokens' }),
    ]);
    await expect(callClaude(bad, params(), { log, onResponse: () => {} })).rejects.toMatchObject({
      category: 'fatal',
    });
  });

  it('rejects invalid JSON and wrong shapes as fatal', async () => {
    await expect(
      callClaude(fakeClient([fakeMessage('not json')]), params(), { log, onResponse: () => {} }),
    ).rejects.toMatchObject({ category: 'fatal' });
    const wrong = { ...sampleOutput(), reasoning: 'x' };
    await expect(
      callClaude(fakeClient([fakeMessage(wrong)]), params(), { log, onResponse: () => {} }),
    ).rejects.toMatchObject({ category: 'fatal' });
  });

  it('maps thrown SDK errors', async () => {
    const client = fakeClient([apiError(529, 'overloaded_error', 'busy')]);
    await expect(callClaude(client, params(), { log, onResponse: () => {} })).rejects.toMatchObject(
      {
        category: 'retryable',
      },
    );
  });
});

describe('finalText', () => {
  it('reads only the text after the last fallback block', () => {
    const m = fakeMessage('{"a":2}', {
      contentPrefix: [
        { type: 'text', text: '{"a":1', citations: null },
        { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } },
      ],
    });
    expect(finalText(m)).toBe('{"a":2}');
  });
});
