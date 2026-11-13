import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, MediaAsset, PostTarget, TargetOptions } from '@app/db';
import { getEnv } from '../env';
import { LocalStorage, keys } from '../storage';
import { PlatformError, type PublishInput, type RemoteProgress, type StepLog } from '../platforms';
import { YT_API, YT_UPLOAD_URL, GOOGLE_TOKEN_URL } from './api';
import {
  buildInsertResource,
  buildPrivacy,
  createYoutubePublisher,
  fitTags,
  toYoutubeTime,
} from './publisher';
import { FakeFetch, apiError, emptyResponse, jsonResponse } from './test-helpers';

const ACCESS = 'ya29.ACCESS-TOKEN-SECRET';
const REFRESH = '1//REFRESH-TOKEN-SECRET';
const NEW_ACCESS = 'ya29.NEW-ACCESS-SECRET';
const SESSION_URI =
  'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=SESSION1';
const SESSION_URI_2 =
  'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=SESSION2';
const VIDEO_ID = 'vid123';

const NOW = new Date('2026-11-14T10:00:00.000Z');
const SLOT = new Date('2026-11-14T12:30:00.000Z'); // 18:00 IST

const env = () =>
  getEnv({
    GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'CLIENT-SECRET-VALUE',
  });

let dir: string;
let storage: LocalStorage;
const ASSET_ID = '11111111-1111-4111-8111-111111111111';
const VIDEO = randomBytes(300 * 1024);

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'yt-test-'));
  storage = new LocalStorage(dir, 'http://localhost:3000');
  await storage.putBuffer(keys.master(ASSET_ID), VIDEO);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const settings = {
  youtubeDefaults: {
    privacy: 'public',
    categoryId: '22',
    madeForKids: false,
    notifySubscribers: true,
    syntheticMedia: false,
    defaultLanguage: 'hi',
  },
} as unknown as AppSettings;

interface Harness {
  input: PublishInput;
  progress: RemoteProgress[];
  steps: Array<{ step: string; log: StepLog }>;
  apiCalls: string[];
  refreshed: Array<{ token: string; expiresAt: Date }>;
}

function harness(
  opts: {
    target?: Partial<PostTarget>;
    options?: TargetOptions;
    now?: Date;
    scheduledAt?: Date;
    accessExpiresAt?: Date | null;
    mode?: 'native' | 'app';
  } = {},
): Harness {
  const progress: RemoteProgress[] = [];
  const steps: Array<{ step: string; log: StepLog }> = [];
  const apiCalls: string[] = [];
  const refreshed: Array<{ token: string; expiresAt: Date }> = [];
  const target = {
    id: 'target-1',
    platform: 'youtube',
    options: opts.options ?? {},
    remoteUploadUri: null,
    remoteUploadOffset: null,
    remoteMediaId: null,
    remoteUrl: null,
    remoteContainerId: null,
    ...opts.target,
  } as PostTarget;
  const input: PublishInput = {
    target,
    asset: {
      id: ASSET_ID,
      masterKey: keys.master(ASSET_ID),
      contentType: 'video/mp4',
    } as MediaAsset,
    settings,
    account: {
      accountId: 'acc-1',
      platform: 'youtube',
      externalId: 'UC123',
      accessToken: ACCESS,
      accessExpiresAt:
        opts.accessExpiresAt === undefined
          ? new Date((opts.now ?? NOW).getTime() + 3600_000)
          : opts.accessExpiresAt,
      refreshToken: REFRESH,
      scopes: ['https://www.googleapis.com/auth/youtube.force-ssl'],
      meta: { channelId: 'UC123' },
    },
    storage,
    text: {
      title: 'Socha tha normal sunset hoga… phir ye hua',
      body: 'Goa ki ek shaam.\n\n#goa #sunset',
      tags: ['goa', 'sunset', 'travel vlog'],
    },
    scheduledAt: opts.scheduledAt ?? SLOT,
    now: opts.now ?? NOW,
    mode: opts.mode ?? 'native',
    saveProgress: async (p) => {
      progress.push(p);
      Object.assign(target, p);
    },
    recordApiCall: async (k) => {
      apiCalls.push(k);
    },
    logStep: async (step, log) => {
      steps.push({ step, log });
    },
    onTokenRefreshed: async (token, expiresAt) => {
      refreshed.push({ token, expiresAt });
    },
  };
  return { input, progress, steps, apiCalls, refreshed };
}

const videosList = (video: Record<string, unknown>) =>
  jsonResponse({ items: [{ id: VIDEO_ID, ...video }] });

let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];
beforeEach(() => {
  consoleSpies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => undefined),
  );
});
afterEach(() => {
  // Tokens must never reach any log line.
  for (const spy of consoleSpies) {
    const text = JSON.stringify(spy.mock.calls);
    for (const secret of [ACCESS, REFRESH, NEW_ACCESS, 'CLIENT-SECRET-VALUE'])
      expect(text).not.toContain(secret);
    spy.mockRestore();
  }
});

function expectNoSecrets(h: Harness) {
  const text = JSON.stringify({ p: h.progress, s: h.steps, a: h.apiCalls });
  for (const secret of [ACCESS, REFRESH, NEW_ACCESS, 'CLIENT-SECRET-VALUE'])
    expect(text).not.toContain(secret);
}

describe('publish time rules', () => {
  it('schedules public posts as private + publishAt in UTC with a Z suffix', () => {
    expect(buildPrivacy('public', SLOT, NOW)).toEqual({
      privacyStatus: 'private',
      publishAt: '2026-11-14T12:30:00Z',
    });
    expect(toYoutubeTime(new Date('2026-11-14T12:30:00.123Z'))).toBe('2026-11-14T12:30:00Z');
  });

  it('publishes immediately when the time is now or past', () => {
    expect(buildPrivacy('public', NOW, NOW)).toEqual({ privacyStatus: 'public' });
    expect(buildPrivacy('public', new Date(NOW.getTime() - 60_000), NOW)).toEqual({
      privacyStatus: 'public',
    });
  });

  it('uploads unlisted and private posts as private without publishAt', () => {
    expect(buildPrivacy('unlisted', SLOT, NOW)).toEqual({ privacyStatus: 'private' });
    expect(buildPrivacy('private', SLOT, NOW)).toEqual({ privacyStatus: 'private' });
  });

  it('always sends privacyStatus and the disclosure flags', () => {
    const { input } = harness();
    const res = buildInsertResource(input);
    expect(res.status).toEqual({
      privacyStatus: 'private',
      publishAt: '2026-11-14T12:30:00Z',
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia: false,
    });
    expect(res.snippet).toMatchObject({
      title: 'Socha tha normal sunset hoga… phir ye hua',
      categoryId: '22',
      defaultLanguage: 'hi',
      defaultAudioLanguage: 'hi',
      tags: ['goa', 'sunset', 'travel vlog'],
    });
  });

  it('rejects empty or too-long titles and strips < >', () => {
    const { input } = harness();
    expect(() => buildInsertResource({ ...input, text: { ...input.text, title: '  ' } })).toThrow(
      PlatformError,
    );
    expect(() =>
      buildInsertResource({ ...input, text: { ...input.text, title: 'x'.repeat(101) } }),
    ).toThrow(/100/);
    expect(
      buildInsertResource({ ...input, text: { ...input.text, title: 'a <b> c' } }).snippet.title,
    ).toBe('a b c');
  });

  it('fits tags within 500 characters', () => {
    const tags = Array.from({ length: 100 }, (_, i) => `tag${i}word`);
    const fitted = fitTags(tags);
    expect(fitted.length).toBeLessThan(100);
    expect(fitted.join(',').length).toBeLessThanOrEqual(500);
  });

  it('chooses app mode only for unlisted', () => {
    const p = createYoutubePublisher({ fetch: new FakeFetch().fetch, env });
    const base = { scheduledAt: SLOT, now: NOW, asset: {} as MediaAsset };
    expect(p.chooseMode({ ...base, target: { options: {} } as PostTarget })).toBe('native');
    expect(
      p.chooseMode({ ...base, target: { options: { privacy: 'unlisted' } } as PostTarget }),
    ).toBe('app');
    expect(p.prepareAt({ ...base, target: {} as PostTarget, mode: 'native' })).toEqual(NOW);
  });
});

describe('prepare: resumable upload', () => {
  it('starts a session, uploads the bytes, then waits for processing and finishes', async () => {
    const f = new FakeFetch()
      .once('POST', YT_UPLOAD_URL, emptyResponse(200, { Location: SESSION_URI }))
      .once(
        'PUT',
        SESSION_URI,
        jsonResponse({ id: VIDEO_ID, status: { uploadStatus: 'uploaded' } }, 201),
      )
      .once(
        'GET',
        `${YT_API}/videos`,
        videosList({
          status: { uploadStatus: 'uploaded', privacyStatus: 'private' },
          processingDetails: {
            processingStatus: 'processing',
            processingProgress: { timeLeftMs: '40000' },
          },
        }),
      )
      .once(
        'GET',
        `${YT_API}/videos`,
        videosList({
          status: {
            uploadStatus: 'processed',
            privacyStatus: 'private',
            publishAt: '2026-11-14T12:30:00Z',
          },
          processingDetails: { processingStatus: 'succeeded' },
        }),
      );
    const p = createYoutubePublisher({ fetch: f.fetch, env });
    const h = harness();

    const first = await p.prepare(h.input);
    expect(first).toEqual({
      kind: 'wait',
      retryInSec: 40,
      reason: 'YouTube is processing the video',
    });

    // Init request.
    const init = f.callsTo('POST', YT_UPLOAD_URL)[0]!;
    const url = new URL(init.url);
    expect(url.searchParams.get('uploadType')).toBe('resumable');
    expect(url.searchParams.get('part')).toBe('snippet,status');
    expect(url.searchParams.get('notifySubscribers')).toBe('true');
    expect(init.headers['x-upload-content-length']).toBe(String(VIDEO.length));
    expect(init.headers['x-upload-content-type']).toBe('video/mp4');
    expect(init.headers.authorization).toBe(`Bearer ${ACCESS}`);
    const resource = JSON.parse(init.body!);
    expect(resource.status.privacyStatus).toBe('private');
    expect(resource.status.publishAt).toBe('2026-11-14T12:30:00Z');

    // Upload request: whole file, no Content-Range.
    const put = f.callsTo('PUT', SESSION_URI)[0]!;
    expect(put.headers['content-length']).toBe(String(VIDEO.length));
    expect(put.headers['content-type']).toBe('video/mp4');
    expect(put.headers['content-range']).toBeUndefined();
    expect(put.bytes!.equals(VIDEO)).toBe(true);

    expect(h.apiCalls).toEqual(['yt_insert']);
    expect(h.progress[0]).toEqual({ remoteUploadUri: SESSION_URI, remoteUploadOffset: 0 });
    expect(h.progress).toContainEqual({
      remoteMediaId: VIDEO_ID,
      remoteUrl: `https://www.youtube.com/shorts/${VIDEO_ID}`,
      remoteUploadUri: null,
      remoteUploadOffset: VIDEO.length,
    });

    // Next call polls only (no new upload) and finishes.
    const second = await p.prepare(h.input);
    expect(second).toEqual({
      kind: 'done',
      remoteMediaId: VIDEO_ID,
      remoteUrl: `https://www.youtube.com/shorts/${VIDEO_ID}`,
    });
    expect(f.callsTo('POST', YT_UPLOAD_URL)).toHaveLength(1);
    expect(h.apiCalls).toEqual(['yt_insert']);
    const poll = new URL(f.callsTo('GET', `${YT_API}/videos`)[1]!.url);
    expect(poll.searchParams.get('part')).toBe('status,processingDetails');
    expect(poll.searchParams.get('id')).toBe(VIDEO_ID);
    expectNoSecrets(h);
  });

  it('resumes from the byte after the 308 Range header', async () => {
    const f = new FakeFetch()
      .once('PUT', SESSION_URI, emptyResponse(308, { Range: 'bytes=0-99999' }))
      .once('PUT', SESSION_URI, jsonResponse({ id: VIDEO_ID }, 201))
      .once('GET', `${YT_API}/videos`, videosList({ status: { uploadStatus: 'processed' } }));
    const p = createYoutubePublisher({ fetch: f.fetch, env });
    const h = harness({ target: { remoteUploadUri: SESSION_URI, remoteUploadOffset: 0 } });

    const res = await p.prepare(h.input);
    expect(res.kind).toBe('done');

    const [query, upload] = f.callsTo('PUT', SESSION_URI);
    expect(query!.headers['content-range']).toBe(`bytes */${VIDEO.length}`);
    expect(query!.headers['content-length']).toBe('0');
    expect(upload!.headers['content-range']).toBe(
      `bytes 100000-${VIDEO.length - 1}/${VIDEO.length}`,
    );
    expect(upload!.headers['content-length']).toBe(String(VIDEO.length - 100000));
    expect(upload!.bytes!.equals(VIDEO.subarray(100000))).toBe(true);
    // No new session, no extra quota.
    expect(f.callsTo('POST', YT_UPLOAD_URL)).toHaveLength(0);
    expect(h.apiCalls).toEqual([]);
    expect(h.progress).toContainEqual({ remoteUploadOffset: 100000 });
  });

  it('recognizes an upload that already completed before a crash', async () => {
    const f = new FakeFetch()
      .once('PUT', SESSION_URI, jsonResponse({ id: VIDEO_ID }, 201))
      .once(
        'GET',
        `${YT_API}/videos`,
        videosList({
          status: { uploadStatus: 'uploaded' },
          processingDetails: { processingStatus: 'processing' },
        }),
      );
    const p = createYoutubePublisher({ fetch: f.fetch, env });
    const h = harness({ target: { remoteUploadUri: SESSION_URI } });
    const res = await p.prepare(h.input);
    expect(res).toMatchObject({ kind: 'wait' });
    expect(h.input.target.remoteMediaId).toBe(VIDEO_ID);
    expect(f.calls.filter((c) => c.bytes && c.bytes.length > 0)).toHaveLength(0);
  });

  it('restarts with a new session when the old one expired (404)', async () => {
    const f = new FakeFetch()
      .once('PUT', SESSION_URI, apiError(404, 'notFound'))
      .once('POST', YT_UPLOAD_URL, emptyResponse(200, { Location: SESSION_URI_2 }))
      .once('PUT', SESSION_URI_2, jsonResponse({ id: VIDEO_ID }, 201))
      .once(
        'GET',
        `${YT_API}/videos`,
        videosList({ processingDetails: { processingStatus: 'succeeded' } }),
      );
    const p = createYoutubePublisher({ fetch: f.fetch, env });
    const h = harness({ target: { remoteUploadUri: SESSION_URI, remoteUploadOffset: 5000 } });
    const res = await p.prepare(h.input);
    expect(res.kind).toBe('done');
    expect(h.progress[0]).toEqual({ remoteUploadUri: null, remoteUploadOffset: null });
    expect(h.progress[1]).toEqual({ remoteUploadUri: SESSION_URI_2, remoteUploadOffset: 0 });
    expect(h.apiCalls).toEqual(['yt_insert']);
    expect(f.callsTo('PUT', SESSION_URI_2)[0]!.bytes!.equals(VIDEO)).toBe(true);
  });

  it('treats 410 Gone as an expired session too', async () => {
    const f = new FakeFetch()
      .once('PUT', SESSION_URI, emptyResponse(410))
      .once('POST', YT_UPLOAD_URL, emptyResponse(200, { Location: SESSION_URI_2 }))
      .once('PUT', SESSION_URI_2, emptyResponse(308, { Range: 'bytes=0-1023' }));
    const p = createYoutubePublisher({ fetch: f.fetch, env });
    const h = harness({ target: { remoteUploadUri: SESSION_URI } });
    const res = await p.prepare(h.input);
    // The connection delivered only part of the file: resume later from byte 1024.
    expect(res).toMatchObject({ kind: 'wait' });
    expect(h.input.target.remoteUploadUri).toBe(SESSION_URI_2);
    expect(h.input.target.remoteUploadOffset).toBe(1024);
  });

  it('sends notifySubscribers=false and the chosen privacy for private posts', async () => {
    const f = new FakeFetch()
      .once('POST', YT_UPLOAD_URL, emptyResponse(200, { Location: SESSION_URI }))
      .once('PUT', SESSION_URI, jsonResponse({ id: VIDEO_ID }, 201))
      .once(
        'GET',
        `${YT_API}/videos`,
        videosList({ processingDetails: { processingStatus: 'succeeded' } }),
      );
    const p = createYoutubePublisher({ fetch: f.fetch, env });
    const h = harness({
      options: { privacy: 'private', notifySubscribers: false, madeForKids: true },
    });
    await p.prepare(h.input);
    const init = f.callsTo('POST', YT_UPLOAD_URL)[0]!;
    expect(new URL(init.url).searchParams.get('notifySubscribers')).toBe('false');
    expect(JSON.parse(init.body!).status).toEqual({
      privacyStatus: 'private',
      selfDeclaredMadeForKids: true,
      containsSyntheticMedia: false,
    });
  });

  it('maps rejected and failed processing to invalid errors', async () => {
    const p = (resp: Response) =>
      createYoutubePublisher({
        fetch: new FakeFetch().once('GET', `${YT_API}/videos`, resp).fetch,
        env,
      });
    const h = harness({ target: { remoteMediaId: VIDEO_ID } });
    await expect(
      p(videosList({ status: { uploadStatus: 'rejected', rejectionReason: 'duplicate' } })).prepare(
        h.input,
      ),
    ).rejects.toMatchObject({
      category: 'invalid',
      code: 'rejected_duplicate',
      message: expect.stringMatching(/duplicate/),
    });
    await expect(
      p(videosList({ status: { uploadStatus: 'failed', failureReason: 'codec' } })).prepare(
        h.input,
      ),
    ).rejects.toMatchObject({ category: 'invalid', code: 'failed_codec' });
    await expect(
      p(
        videosList({
          status: { uploadStatus: 'uploaded' },
          processingDetails: {
            processingStatus: 'failed',
            processingFailureReason: 'transcodeFailed',
          },
        }),
      ).prepare(h.input),
    ).rejects.toMatchObject({ category: 'invalid', code: 'processing_transcodeFailed' });
  });

  it('maps a quota error on session start and records no quota use', async () => {
    const f = new FakeFetch().once('POST', YT_UPLOAD_URL, apiError(403, 'quotaExceeded'));
    const p = createYoutubePublisher({ fetch: f.fetch, env });
    const h = harness();
    const err = await p.prepare(h.input).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.category).toBe('quota');
    expect(err.retryAfterSec).toBeGreaterThan(0);
    expect(h.apiCalls).toEqual([]);
  });
});

describe('token refresh', () => {
  it('refreshes before use when the token expires within 2 minutes', async () => {
    const f = new FakeFetch()
      .once(
        'POST',
        GOOGLE_TOKEN_URL,
        jsonResponse({
          access_token: NEW_ACCESS,
          expires_in: 3599,
          scope: 'x',
          token_type: 'Bearer',
        }),
      )
      .once(
        'GET',
        `${YT_API}/videos`,
        videosList({ processingDetails: { processingStatus: 'succeeded' } }),
      );
    const p = createYoutubePublisher({ fetch: f.fetch, env });
    const h = harness({
      target: { remoteMediaId: VIDEO_ID },
      accessExpiresAt: new Date(NOW.getTime() + 60_000),
    });
    await p.prepare(h.input);
    const tok = f.callsTo('POST', GOOGLE_TOKEN_URL)[0]!;
    const form = new URLSearchParams(tok.body);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe(REFRESH);
    expect(form.get('client_id')).toBe('client-id.apps.googleusercontent.com');
    expect(form.get('client_secret')).toBe('CLIENT-SECRET-VALUE');
    expect(f.callsTo('GET', `${YT_API}/videos`)[0]!.headers.authorization).toBe(
      `Bearer ${NEW_ACCESS}`,
    );
    expect(h.refreshed).toHaveLength(1);
    expect(h.refreshed[0]!.token).toBe(NEW_ACCESS);
    expect(h.refreshed[0]!.expiresAt.getTime()).toBeGreaterThan(NOW.getTime() + 3000_000);
    expectNoSecrets(h);
  });

  it('refreshes once after a 401 and retries the request', async () => {
    const f = new FakeFetch()
      .once('GET', `${YT_API}/videos`, apiError(401, 'authError', 'Invalid Credentials'))
      .once('POST', GOOGLE_TOKEN_URL, jsonResponse({ access_token: NEW_ACCESS, expires_in: 3599 }))
      .once(
        'GET',
        `${YT_API}/videos`,
        videosList({ processingDetails: { processingStatus: 'succeeded' } }),
      );
    const p = createYoutubePublisher({ fetch: f.fetch, env });
    const h = harness({ target: { remoteMediaId: VIDEO_ID } });
    expect((await p.prepare(h.input)).kind).toBe('done');
    expect(h.refreshed).toHaveLength(1);
  });

  it('gives up with an auth error when the second try is also 401', async () => {
    const f = new FakeFetch()
      .always('GET', `${YT_API}/videos`, apiError(401, 'authError'))
      .once('POST', GOOGLE_TOKEN_URL, jsonResponse({ access_token: NEW_ACCESS, expires_in: 3599 }));
    const p = createYoutubePublisher({ fetch: f.fetch, env });
    const h = harness({ target: { remoteMediaId: VIDEO_ID } });
    await expect(p.prepare(h.input)).rejects.toMatchObject({ category: 'auth' });
    expect(f.callsTo('POST', GOOGLE_TOKEN_URL)).toHaveLength(1);
  });

  it('maps invalid_grant to an auth error without leaking the token', async () => {
    const f = new FakeFetch().once(
      'POST',
      GOOGLE_TOKEN_URL,
      jsonResponse(
        { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
        400,
      ),
    );
    const p = createYoutubePublisher({ fetch: f.fetch, env });
    const h = harness({
      target: { remoteMediaId: VIDEO_ID },
      accessExpiresAt: new Date(NOW.getTime() - 1000),
    });
    const err = await p.prepare(h.input).catch((e) => e);
    expect(err).toMatchObject({ category: 'auth', code: 'invalid_grant' });
    expect(JSON.stringify({ m: err.message, d: err.details })).not.toContain(REFRESH);
  });

  it('treats a token-endpoint outage as retryable', async () => {
    const f = new FakeFetch().once(
      'POST',
      GOOGLE_TOKEN_URL,
      jsonResponse({ error: 'backend' }, 503),
    );
    const p = createYoutubePublisher({ fetch: f.fetch, env });
    const h = harness({
      target: { remoteMediaId: VIDEO_ID },
      accessExpiresAt: new Date(NOW.getTime() - 1000),
    });
    await expect(p.prepare(h.input)).rejects.toMatchObject({ category: 'retryable' });
  });

  it('refreshes after a 401 during the byte upload and asks to resume', async () => {
    const f = new FakeFetch()
      .once('PUT', SESSION_URI, emptyResponse(308, { Range: 'bytes=0-9' }))
      .once('PUT', SESSION_URI, apiError(401, 'authError'))
      .once('POST', GOOGLE_TOKEN_URL, jsonResponse({ access_token: NEW_ACCESS, expires_in: 3599 }));
    const p = createYoutubePublisher({ fetch: f.fetch, env });
    const h = harness({ target: { remoteUploadUri: SESSION_URI } });
    await expect(p.prepare(h.input)).rejects.toMatchObject({
      category: 'retryable',
      httpStatus: 401,
    });
    expect(h.refreshed).toHaveLength(1);
    // The session is kept so the next attempt resumes.
    expect(h.input.target.remoteUploadUri).toBe(SESSION_URI);
  });
});

describe('publish (verify / unlisted switch)', () => {
  const at = (iso: string) => new Date(iso);

  it('is done when YouTube made the video public', async () => {
    const f = new FakeFetch().once(
      'GET',
      `${YT_API}/videos`,
      videosList({ status: { privacyStatus: 'public' } }),
    );
    const p = createYoutubePublisher({ fetch: f.fetch, env });
    const h = harness({ target: { remoteMediaId: VIDEO_ID }, now: at('2026-11-14T12:35:00Z') });
    expect(await p.publish(h.input)).toEqual({
      kind: 'done',
      remoteMediaId: VIDEO_ID,
      remoteUrl: `https://www.youtube.com/shorts/${VIDEO_ID}`,
    });
  });

  it('waits while still private and the publish time is close', async () => {
    const f = new FakeFetch().always(
      'GET',
      `${YT_API}/videos`,
      videosList({ status: { privacyStatus: 'private', publishAt: '2026-11-14T12:30:00Z' } }),
    );
    const p = createYoutubePublisher({ fetch: f.fetch, env });
    const before = await p.publish(
      harness({ target: { remoteMediaId: VIDEO_ID }, now: at('2026-11-14T12:29:00Z') }).input,
    );
    expect(before).toMatchObject({ kind: 'wait', retryInSec: 120 });
    const after = await p.publish(
      harness({ target: { remoteMediaId: VIDEO_ID }, now: at('2026-11-14T12:40:00Z') }).input,
    );
    expect(after).toMatchObject({ kind: 'wait', retryInSec: 120 });
  });

  it('fails when still private 30 minutes after the publish time', async () => {
    const f = new FakeFetch().once(
      'GET',
      `${YT_API}/videos`,
      videosList({ status: { privacyStatus: 'private', publishAt: '2026-11-14T12:30:00Z' } }),
    );
    const p = createYoutubePublisher({ fetch: f.fetch, env });
    const h = harness({ target: { remoteMediaId: VIDEO_ID }, now: at('2026-11-14T13:01:00Z') });
    await expect(p.publish(h.input)).rejects.toMatchObject({
      category: 'fatal',
      code: 'still_private',
      message: expect.stringMatching(/still private/),
    });
  });

  it('fails when the video was deleted on YouTube', async () => {
    const f = new FakeFetch().once('GET', `${YT_API}/videos`, jsonResponse({ items: [] }));
    const p = createYoutubePublisher({ fetch: f.fetch, env });
    const h = harness({ target: { remoteMediaId: VIDEO_ID } });
    await expect(p.publish(h.input)).rejects.toMatchObject({
      category: 'fatal',
      code: 'video_not_found',
    });
  });

  it('switches an unlisted post from private to unlisted at the time, keeping other status fields', async () => {
    const f = new FakeFetch()
      .once(
        'GET',
        `${YT_API}/videos`,
        videosList({
          status: {
            uploadStatus: 'processed',
            privacyStatus: 'private',
            license: 'youtube',
            embeddable: false,
            publicStatsViewable: true,
            selfDeclaredMadeForKids: false,
            madeForKids: false,
          },
        }),
      )
      .once('PUT', `${YT_API}/videos`, (c) => jsonResponse(JSON.parse(c.body!)));
    const p = createYoutubePublisher({ fetch: f.fetch, env });
    const h = harness({
      target: { remoteMediaId: VIDEO_ID },
      options: { privacy: 'unlisted' },
      mode: 'app',
      now: SLOT,
    });
    expect((await p.publish(h.input)).kind).toBe('done');
    const put = f.callsTo('PUT', `${YT_API}/videos`)[0]!;
    expect(new URL(put.url).searchParams.get('part')).toBe('status');
    expect(JSON.parse(put.body!)).toEqual({
      id: VIDEO_ID,
      status: {
        privacyStatus: 'unlisted',
        license: 'youtube',
        embeddable: false,
        publicStatsViewable: true,
        selfDeclaredMadeForKids: false,
      },
    });
  });
});

describe('update: read-modify-write', () => {
  it('changes only text and time, and resends every writable field', async () => {
    const current = {
      snippet: {
        title: 'Old title',
        description: 'Old description',
        tags: ['old'],
        categoryId: '22',
        defaultLanguage: 'hi',
        defaultAudioLanguage: 'hi',
        channelId: 'UC123',
        publishedAt: '2026-11-13T00:00:00Z',
        thumbnails: { default: { url: 'x' } },
        localized: { title: 'Old title' },
      },
      status: {
        uploadStatus: 'processed',
        privacyStatus: 'private',
        publishAt: '2026-11-14T12:30:00Z',
        license: 'creativeCommon',
        embeddable: true,
        publicStatsViewable: false,
        selfDeclaredMadeForKids: false,
        madeForKids: false,
      },
    };
    const f = new FakeFetch()
      .once('GET', `${YT_API}/videos`, videosList(current))
      .once('PUT', `${YT_API}/videos`, (c) => jsonResponse(JSON.parse(c.body!)));
    const p = createYoutubePublisher({ fetch: f.fetch, env });
    const newTime = new Date('2026-11-15T12:30:00Z');
    const h = harness({ target: { remoteMediaId: VIDEO_ID }, scheduledAt: newTime });
    h.input.text = { title: 'New <hook> title', body: 'New body', tags: ['new', 'tags'] };

    expect(await p.update!(h.input)).toBe(true);

    const get = new URL(f.callsTo('GET', `${YT_API}/videos`)[0]!.url);
    expect(get.searchParams.get('part')).toBe('snippet,status');
    const put = f.callsTo('PUT', `${YT_API}/videos`)[0]!;
    expect(new URL(put.url).searchParams.get('part')).toBe('snippet,status');
    expect(JSON.parse(put.body!)).toEqual({
      id: VIDEO_ID,
      snippet: {
        title: 'New hook title',
        description: 'New body',
        tags: ['new', 'tags'],
        categoryId: '22',
        defaultLanguage: 'hi',
        defaultAudioLanguage: 'hi',
      },
      status: {
        privacyStatus: 'private',
        publishAt: '2026-11-15T12:30:00Z',
        license: 'creativeCommon',
        embeddable: true,
        publicStatsViewable: false,
        selfDeclaredMadeForKids: false,
        containsSyntheticMedia: false,
      },
    });
    expect(h.steps.map((s) => s.step)).toContain('update');
  });

  it('does not touch privacy/publishAt once the video is public', async () => {
    const f = new FakeFetch()
      .once(
        'GET',
        `${YT_API}/videos`,
        videosList({
          snippet: { title: 'T', categoryId: '22' },
          status: { privacyStatus: 'public', embeddable: true },
        }),
      )
      .once('PUT', `${YT_API}/videos`, (c) => jsonResponse(JSON.parse(c.body!)));
    const p = createYoutubePublisher({ fetch: f.fetch, env });
    const h = harness({ target: { remoteMediaId: VIDEO_ID } });
    await p.update!(h.input);
    const body = JSON.parse(f.callsTo('PUT', `${YT_API}/videos`)[0]!.body!);
    expect(body.status.privacyStatus).toBe('public');
    expect(body.status.publishAt).toBeUndefined();
    expect(body.status.embeddable).toBe(true);
  });

  it('returns false before the upload finished (engine re-prepares)', async () => {
    const p = createYoutubePublisher({ fetch: new FakeFetch().fetch, env });
    expect(await p.update!(harness({ target: { remoteUploadUri: SESSION_URI } }).input)).toBe(
      false,
    );
  });

  it('maps invalidPublishAt to a plain-English invalid error', async () => {
    const f = new FakeFetch()
      .once(
        'GET',
        `${YT_API}/videos`,
        videosList({
          snippet: { title: 'T', categoryId: '22' },
          status: { privacyStatus: 'private' },
        }),
      )
      .once('PUT', `${YT_API}/videos`, apiError(400, 'invalidPublishAt'));
    const p = createYoutubePublisher({ fetch: f.fetch, env });
    await expect(
      p.update!(harness({ target: { remoteMediaId: VIDEO_ID } }).input),
    ).rejects.toMatchObject({
      category: 'invalid',
      code: 'invalidPublishAt',
      message: expect.stringMatching(/publish time/),
    });
  });
});

describe('reconcile and cancel', () => {
  it('reports scheduled for private + publishAt and published for public', async () => {
    const f = new FakeFetch()
      .once(
        'GET',
        `${YT_API}/videos`,
        videosList({ status: { privacyStatus: 'private', publishAt: '2026-11-14T12:30:00Z' } }),
      )
      .once('GET', `${YT_API}/videos`, videosList({ status: { privacyStatus: 'public' } }));
    const p = createYoutubePublisher({ fetch: f.fetch, env });
    const h = harness({ target: { remoteMediaId: VIDEO_ID } });
    expect(await p.reconcile(h.input)).toMatchObject({
      published: false,
      scheduled: true,
      remoteMediaId: VIDEO_ID,
    });
    expect(await p.reconcile(h.input)).toMatchObject({ published: true, scheduled: false });
  });

  it('finds the video of a completed upload session', async () => {
    const f = new FakeFetch()
      .once('PUT', SESSION_URI, jsonResponse({ id: VIDEO_ID }, 200))
      .once(
        'GET',
        `${YT_API}/videos`,
        videosList({ status: { privacyStatus: 'private', publishAt: '2026-11-14T12:30:00Z' } }),
      );
    const p = createYoutubePublisher({ fetch: f.fetch, env });
    const h = harness({ target: { remoteUploadUri: SESSION_URI } });
    expect(await p.reconcile(h.input)).toMatchObject({ scheduled: true, remoteMediaId: VIDEO_ID });
    expect(h.input.target.remoteMediaId).toBe(VIDEO_ID);
  });

  it('is not published when nothing was uploaded', async () => {
    const p = createYoutubePublisher({ fetch: new FakeFetch().fetch, env });
    expect(await p.reconcile(harness().input)).toEqual({ published: false });
  });

  it('deletes a private video and clears the remote ids', async () => {
    const f = new FakeFetch()
      .once('GET', `${YT_API}/videos`, videosList({ status: { privacyStatus: 'private' } }))
      .once('DELETE', `${YT_API}/videos`, emptyResponse(204));
    const p = createYoutubePublisher({ fetch: f.fetch, env });
    const h = harness({ target: { remoteMediaId: VIDEO_ID } });
    await p.cancel(h.input);
    expect(new URL(f.callsTo('DELETE', `${YT_API}/videos`)[0]!.url).searchParams.get('id')).toBe(
      VIDEO_ID,
    );
    expect(h.input.target.remoteMediaId).toBeNull();
  });

  it('does not throw when the video is already gone', async () => {
    const f = new FakeFetch().once('GET', `${YT_API}/videos`, jsonResponse({ items: [] }));
    const p = createYoutubePublisher({ fetch: f.fetch, env });
    await expect(
      p.cancel(harness({ target: { remoteMediaId: VIDEO_ID } }).input),
    ).resolves.toBeUndefined();
    const f2 = new FakeFetch()
      .once('GET', `${YT_API}/videos`, videosList({ status: { privacyStatus: 'private' } }))
      .once('DELETE', `${YT_API}/videos`, apiError(404, 'videoNotFound'));
    const p2 = createYoutubePublisher({ fetch: f2.fetch, env });
    await expect(
      p2.cancel(harness({ target: { remoteMediaId: VIDEO_ID } }).input),
    ).resolves.toBeUndefined();
  });

  it('never deletes a video that is already live', async () => {
    const f = new FakeFetch().once(
      'GET',
      `${YT_API}/videos`,
      videosList({ status: { privacyStatus: 'public' } }),
    );
    const p = createYoutubePublisher({ fetch: f.fetch, env });
    await p.cancel(harness({ target: { remoteMediaId: VIDEO_ID } }).input);
    expect(f.callsTo('DELETE', `${YT_API}/videos`)).toHaveLength(0);
  });
});
