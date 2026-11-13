import path from 'node:path';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getTranscriber, isSttConfigured } from './registry';
import { ASSEMBLYAI_MODEL, assemblyAiTranscriptBody } from './providers/assemblyai';
import { deepgramUrl } from './providers/deepgram';
import { mockTranscript } from './providers/mock';
import { OPENAI_TRANSCRIBE_MODEL } from './providers/openai';
import { sarvamLanguageCode } from './providers/sarvam';
import { fakeFetch, json, makeAudio, makeTempDir, noSleep, testEnv } from './test-helpers';
import { SttError, type TranscribeInput } from './types';

const KEYS = {
  OPENAI_API_KEY: 'sk-openai-SECRET-0000000001',
  DEEPGRAM_API_KEY: 'dg-SECRET-0000000002',
  SARVAM_API_KEY: 'sarvam-SECRET-0000000003',
  ASSEMBLYAI_API_KEY: 'aai-SECRET-0000000004',
};
const ALL_KEYS = Object.values(KEYS);

const tmp = makeTempDir('stt-providers-');
const env = testEnv({ ...KEYS, WORK_DIR: path.join(tmp.dir, 'work') });
let short: string;
let long: string;

beforeAll(() => {
  short = makeAudio(path.join(tmp.dir, 'short.m4a'), 5);
  long = makeAudio(path.join(tmp.dir, 'long.m4a'), 70);
});
afterAll(() => tmp.remove());

function input(overrides: Partial<TranscribeInput> = {}): TranscribeInput {
  return {
    filePath: short,
    mimeType: 'audio/mp4',
    durationMs: 5_000,
    languageHints: ['hi', 'en'],
    keywords: ['Rahul', 'Baga Beach'],
    ...overrides,
  };
}

function expectNoKeys(text: string) {
  for (const key of ALL_KEYS) expect(text).not.toContain(key);
}

async function failure(p: Promise<unknown>): Promise<SttError> {
  const err = await p.then(
    () => {
      throw new Error('expected a failure');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SttError);
  return err as SttError;
}

describe('registry', () => {
  it('reports configuration per provider', () => {
    const bare = testEnv();
    expect(isSttConfigured('openai', bare)).toBe(false);
    expect(isSttConfigured('mock', bare)).toBe(true);
    expect(isSttConfigured('sarvam', env)).toBe(true);
  });

  it("throws SttError('config') when the key is missing", () => {
    const bare = testEnv();
    for (const name of ['openai', 'deepgram', 'sarvam', 'assemblyai'] as const) {
      expect(() => getTranscriber(name, bare)).toThrowError(
        expect.objectContaining({ category: 'config' }),
      );
    }
    expect(getTranscriber('mock', bare).name).toBe('mock');
    expect(() => getTranscriber('nope' as never, env)).toThrowError(SttError);
  });
});

describe('openai gpt-transcribe', () => {
  it('posts multipart with model, languages[] and keywords[]', async () => {
    const { fetch, calls } = fakeFetch([
      json({
        text: ' Namaste dosto, aaj Baga Beach chalte hain ',
        languages: [{ code: 'hi' }, { code: 'en' }],
      }),
    ]);
    const stt = getTranscriber('openai', env, { fetch, sleep: noSleep });
    const out = await stt.transcribe(input({ keywords: ['Rahul', 'Baga Beach'] }));

    expect(out).toEqual({
      provider: 'openai',
      text: 'Namaste dosto, aaj Baga Beach chalte hain',
      language: 'hi,en',
    });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(call.method).toBe('POST');
    expect(call.headers.get('authorization')).toBe(`Bearer ${KEYS.OPENAI_API_KEY}`);
    // fetch sets the multipart boundary itself.
    expect(call.headers.get('content-type')).toBeNull();
    const form = call.body as FormData;
    expect(form.get('model')).toBe(OPENAI_TRANSCRIBE_MODEL);
    expect(form.getAll('languages[]')).toEqual(['hi', 'en']);
    expect(form.getAll('keywords[]')).toEqual(['Rahul', 'Baga Beach']);
    expect(form.get('language')).toBeNull();
    const file = form.get('file') as File;
    expect(file.name).toBe('short.m4a');
    expect(file.type).toBe('audio/mp4');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(readFileSync(short));
  });

  it('maps errors without leaking the key', async () => {
    const { fetch } = fakeFetch([
      json(
        {
          error: {
            message: 'Incorrect API key provided: sk-openai-SECRET-0000000001',
            code: 'invalid_api_key',
          },
        },
        401,
      ),
    ]);
    const err = await failure(getTranscriber('openai', env, { fetch }).transcribe(input()));
    expect(err.category).toBe('config');
    expectNoKeys(err.message);
  });

  it('maps insufficient_quota to spend', async () => {
    const { fetch } = fakeFetch([
      json(
        {
          error: {
            message: 'You exceeded your current quota',
            type: 'insufficient_quota',
            code: 'insufficient_quota',
          },
        },
        429,
      ),
    ]);
    const err = await failure(getTranscriber('openai', env, { fetch }).transcribe(input()));
    expect(err.category).toBe('spend');
  });
});

describe('deepgram nova-3', () => {
  it('builds the multilingual URL with one keyterm per term', () => {
    const url = new URL(
      deepgramUrl({ languageHints: ['hi', 'en'], keywords: ['Baga Beach', 'Rahul'] }),
    );
    expect(url.origin + url.pathname).toBe('https://api.deepgram.com/v1/listen');
    expect(url.searchParams.get('model')).toBe('nova-3');
    expect(url.searchParams.get('language')).toBe('multi');
    expect(url.searchParams.get('smart_format')).toBe('true');
    expect(url.searchParams.getAll('keyterm')).toEqual(['Baga Beach', 'Rahul']);
    const single = new URL(deepgramUrl({ languageHints: ['hi-IN'], keywords: [] }));
    expect(single.searchParams.get('language')).toBe('hi');
    expect(single.searchParams.has('keyterm')).toBe(false);
  });

  it('posts the raw audio with a Token header', async () => {
    const { fetch, calls } = fakeFetch([
      json({
        metadata: { request_id: 'r1' },
        results: {
          channels: [
            { alternatives: [{ transcript: 'Hello दोस्तों, kaise ho', languages: ['hi', 'en'] }] },
          ],
        },
      }),
    ]);
    const out = await getTranscriber('deepgram', env, { fetch }).transcribe(input());
    expect(out).toEqual({ provider: 'deepgram', text: 'Hello दोस्तों, kaise ho', language: 'hi,en' });
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.headers.get('authorization')).toBe(`Token ${KEYS.DEEPGRAM_API_KEY}`);
    expect(call.headers.get('content-type')).toBe('audio/mp4');
    expect(Buffer.from(call.body as Uint8Array)).toEqual(readFileSync(short));
    expect(call.url).not.toContain(KEYS.DEEPGRAM_API_KEY);
  });

  it('maps 402 ASR_PAYMENT_REQUIRED to spend and 401 to config', async () => {
    const pay = fakeFetch([
      json(
        {
          err_code: 'ASR_PAYMENT_REQUIRED',
          err_msg: 'Project does not have enough credits',
          request_id: 'x',
        },
        402,
      ),
    ]);
    expect(
      (await failure(getTranscriber('deepgram', env, { fetch: pay.fetch }).transcribe(input())))
        .category,
    ).toBe('spend');
    const auth = fakeFetch([
      json({ err_code: 'INVALID_AUTH', err_msg: 'Invalid credentials.' }, 401),
    ]);
    const err = await failure(
      getTranscriber('deepgram', env, { fetch: auth.fetch }).transcribe(input()),
    );
    expect(err.category).toBe('config');
    expectNoKeys(err.message);
  });
});

describe('sarvam saaras', () => {
  it('picks the Indian language as the codemix base', () => {
    expect(sarvamLanguageCode(['hi', 'en'])).toBe('hi-IN');
    expect(sarvamLanguageCode(['en'])).toBe('en-IN');
    expect(sarvamLanguageCode([])).toBe('unknown');
    expect(sarvamLanguageCode(['fr'])).toBe('unknown');
  });

  it('sends a short clip in one request with the subscription key header', async () => {
    const { fetch, calls } = fakeFetch([
      json({ request_id: 'r1', transcript: 'मेरा phone number है', language_code: 'hi-IN' }),
    ]);
    const out = await getTranscriber('sarvam', env, { fetch }).transcribe(input());
    expect(out).toEqual({ provider: 'sarvam', text: 'मेरा phone number है', language: 'hi' });
    const call = calls[0]!;
    expect(call.url).toBe('https://api.sarvam.ai/speech-to-text');
    expect(call.headers.get('api-subscription-key')).toBe(KEYS.SARVAM_API_KEY);
    expect(call.headers.get('authorization')).toBeNull();
    const form = call.body as FormData;
    expect(form.get('model')).toBe('saaras:v4');
    expect(form.get('mode')).toBe('codemix');
    expect(form.get('language_code')).toBe('hi-IN');
    expect(JSON.parse(form.get('keyterms') as string)).toEqual(['Rahul', 'Baga Beach']);
    expect((form.get('file') as File).name).toBe('short.m4a');
  });

  it('splits a 70 s clip into 3 sequential requests and joins the text', async () => {
    const sizes: number[] = [];
    const { fetch, calls } = fakeFetch(
      ['pehla hissa', 'doosra hissa', 'teesra hissa'].map((t, i) => () => {
        return json({ request_id: `r${i}`, transcript: t, language_code: 'hi-IN' });
      }),
    );
    const wrapped = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const file = (init?.body as FormData).get('file') as File;
      sizes.push(file.size);
      return fetch(url, init);
    }) as unknown as typeof globalThis.fetch;
    const out = await getTranscriber('sarvam', env, { fetch: wrapped }).transcribe(
      input({ filePath: long, durationMs: 70_000, keywords: [] }),
    );
    expect(calls).toHaveLength(3);
    expect(out.text).toBe('pehla hissa doosra hissa teesra hissa');
    expect(sizes.every((s) => s > 0)).toBe(true);
    expect((calls[0]!.body as FormData).get('keyterms')).toBeNull();
  });

  it('maps 403 to config and a rate limit to retryable', async () => {
    const auth = fakeFetch([
      json({ error: { message: 'Invalid API key', code: 'invalid_api_key_error' } }, 403),
    ]);
    const e1 = await failure(
      getTranscriber('sarvam', env, { fetch: auth.fetch }).transcribe(input()),
    );
    expect(e1.category).toBe('config');
    expectNoKeys(e1.message);
    const busy = fakeFetch([
      json({ error: { message: 'Quota exceeded', code: 'rate_limit_exceeded_error' } }, 429),
    ]);
    const e2 = await failure(
      getTranscriber('sarvam', env, { fetch: busy.fetch, maxAttempts: 1 }).transcribe(input()),
    );
    expect(e2.category).toBe('retryable');
  });
});

describe('assemblyai universal-3.5 pro', () => {
  it('builds the code-switching request body', () => {
    expect(
      assemblyAiTranscriptBody('u', { languageHints: ['hi', 'en'], keywords: ['Rahul'] }),
    ).toEqual({
      audio_url: 'u',
      punctuate: true,
      format_text: true,
      speech_models: [ASSEMBLYAI_MODEL],
      language_codes: ['hi', 'en'],
      keyterms_prompt: ['Rahul'],
    });
    const auto = assemblyAiTranscriptBody('u', { languageHints: [], keywords: [] });
    expect(auto.language_detection).toBe(true);
    expect(auto.keyterms_prompt).toBeUndefined();
    expect(
      assemblyAiTranscriptBody('u', { languageHints: ['hi'], keywords: [] }).language_code,
    ).toBe('hi');
  });

  it('uploads, creates and polls until completed', async () => {
    const { fetch, calls } = fakeFetch([
      json({ upload_url: 'https://cdn.assemblyai.com/upload/abc' }),
      json({ id: 't1', status: 'queued' }),
      json({ id: 't1', status: 'processing' }),
      json({
        id: 't1',
        status: 'completed',
        text: 'Namaste, welcome back',
        language_codes: ['hi', 'en'],
      }),
    ]);
    const sleep = vi.fn(noSleep);
    const out = await getTranscriber('assemblyai', env, {
      fetch,
      sleep,
      pollIntervalMs: 10,
    }).transcribe(input());
    expect(out).toEqual({
      provider: 'assemblyai',
      text: 'Namaste, welcome back',
      language: 'hi,en',
    });

    const [upload, create, poll1, poll2] = calls;
    expect(upload!.url).toBe('https://api.assemblyai.com/v2/upload');
    expect(upload!.headers.get('authorization')).toBe(KEYS.ASSEMBLYAI_API_KEY);
    expect(upload!.headers.get('content-type')).toBe('application/octet-stream');
    expect(Buffer.from(upload!.body as Uint8Array)).toEqual(readFileSync(short));

    expect(create!.url).toBe('https://api.assemblyai.com/v2/transcript');
    expect(create!.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(create!.body as string)).toMatchObject({
      audio_url: 'https://cdn.assemblyai.com/upload/abc',
      speech_models: ['universal-3-5-pro'],
      language_codes: ['hi', 'en'],
      keyterms_prompt: ['Rahul', 'Baga Beach'],
    });
    expect(poll1!.method).toBe('GET');
    expect(poll1!.url).toBe('https://api.assemblyai.com/v2/transcript/t1');
    expect(poll2!.url).toBe('https://api.assemblyai.com/v2/transcript/t1');
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('maps a transcript error status to fatal', async () => {
    const { fetch } = fakeFetch([
      json({ upload_url: 'https://cdn.assemblyai.com/upload/abc' }),
      json({ id: 't1', status: 'error', error: 'File does not appear to contain audio.' }),
    ]);
    const err = await failure(
      getTranscriber('assemblyai', env, { fetch, sleep: noSleep }).transcribe(input()),
    );
    expect(err.category).toBe('fatal');
    expect(err.message).toContain('does not appear to contain audio');
  });

  it('gives the job queue a retry when polling takes too long', async () => {
    const { fetch } = fakeFetch([
      json({ upload_url: 'https://cdn.assemblyai.com/upload/abc' }),
      json({ id: 't1', status: 'queued' }),
      json({ id: 't1', status: 'processing' }),
      json({ id: 't1', status: 'processing' }),
    ]);
    const err = await failure(
      getTranscriber('assemblyai', env, {
        fetch,
        sleep: noSleep,
        pollIntervalMs: 10,
        maxPollMs: 20,
      }).transcribe(input()),
    );
    expect(err.category).toBe('retryable');
  });

  it('maps an auth error from the upload without leaking the key', async () => {
    const { fetch } = fakeFetch([
      json({ error: 'Authentication error, API token missing/invalid', status: 'error' }, 401),
    ]);
    const err = await failure(getTranscriber('assemblyai', env, { fetch }).transcribe(input()));
    expect(err.category).toBe('config');
    expect(err.message).toContain('Authentication error');
    expectNoKeys(err.message);
  });
});

describe('mock', () => {
  it('is deterministic and needs no network', async () => {
    const stt = getTranscriber('mock', testEnv());
    const a = await stt.transcribe(input({ durationMs: 61_200 }));
    const b = await stt.transcribe(input({ durationMs: 61_200 }));
    expect(a).toEqual(b);
    expect(a.text).toBe(mockTranscript({ durationMs: 61_200, keywords: ['Rahul', 'Baga Beach'] }));
    expect(a.text).toContain('61s');
    expect(a.language).toBe('hi,en');
  });
});
