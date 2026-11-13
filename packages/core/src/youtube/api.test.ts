import { describe, expect, it } from 'vitest';
import { getEnv } from '../env';
import type { AccountCredentials } from '../platforms';
import {
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  YT_API,
  mapApiError,
  secondsUntilPacificMidnight,
} from './api';
import { createYoutubeIntegration } from './index';
import { nextByteFromRange } from './publisher';
import { FakeFetch, apiError, emptyResponse, jsonResponse } from './test-helpers';

const NOW = new Date('2026-11-14T10:00:00Z'); // 02:00 PST
const body = (reason: string, message = reason) => ({
  error: { code: 0, message, errors: [{ domain: 'youtube', reason, message }] },
});
const noHeaders = { headers: new Headers() };

describe('mapApiError (https://developers.google.com/youtube/v3/docs/errors)', () => {
  const table: Array<[number, string, string]> = [
    [403, 'quotaExceeded', 'quota'],
    [400, 'uploadLimitExceeded', 'quota'],
    [403, 'rateLimitExceeded', 'quota'],
    [403, 'userRateLimitExceeded', 'quota'],
    [429, 'tooManyRequests', 'quota'],
    [401, 'authError', 'auth'],
    [401, 'youtubeSignupRequired', 'auth'],
    [403, 'forbidden', 'auth'],
    [403, 'insufficientPermissions', 'auth'],
    [403, 'youtubeSignupRequired', 'auth'],
    [400, 'invalidTitle', 'invalid'],
    [400, 'invalidDescription', 'invalid'],
    [400, 'invalidTags', 'invalid'],
    [400, 'invalidCategoryId', 'invalid'],
    [400, 'invalidPublishAt', 'invalid'],
    [400, 'invalidVideoMetadata', 'invalid'],
    [400, 'mediaBodyRequired', 'invalid'],
    [403, 'forbiddenPrivacySetting', 'invalid'],
    [400, 'somethingNew', 'invalid'],
    [500, 'backendError', 'retryable'],
    [502, 'badGateway', 'retryable'],
    [503, 'backendError', 'retryable'],
    [404, 'videoNotFound', 'fatal'],
    [409, 'conflict', 'fatal'],
  ];
  it.each(table)('HTTP %i %s → %s', (status, reason, category) => {
    const err = mapApiError(status, body(reason), noHeaders, NOW);
    expect(err.category).toBe(category);
    expect(err.httpStatus).toBe(status);
  });

  it('waits until after Pacific midnight for the daily quota', () => {
    const err = mapApiError(403, body('quotaExceeded'), noHeaders, NOW);
    // 02:00 PST → next midnight is 22 h away (+5 min slack).
    expect(err.retryAfterSec).toBe(22 * 3600 + 300);
    expect(secondsUntilPacificMidnight(new Date('2026-11-15T07:59:00Z'))).toBe(60 + 300);
  });

  it('pauses 24 h on the per-channel upload limit and honors Retry-After on rate limits', () => {
    expect(mapApiError(400, body('uploadLimitExceeded'), noHeaders, NOW).retryAfterSec).toBe(86400);
    const res = { headers: new Headers({ 'Retry-After': '17' }) };
    expect(mapApiError(403, body('rateLimitExceeded'), res, NOW).retryAfterSec).toBe(17);
  });

  it('uses plain-English messages for invalid metadata', () => {
    expect(mapApiError(400, body('invalidTitle'), noHeaders, NOW).message).toMatch(/title/);
    expect(mapApiError(400, body('invalidPublishAt'), noHeaders, NOW).message).toMatch(
      /publish time/,
    );
  });

  it('survives non-JSON bodies', () => {
    const err = mapApiError(502, '<html>Bad Gateway</html>', noHeaders, NOW);
    expect(err.category).toBe('retryable');
  });

  it('parses 308 Range headers', () => {
    expect(nextByteFromRange('bytes=0-999')).toBe(1000);
    expect(nextByteFromRange(null)).toBe(0);
  });
});

const env = () => getEnv({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret' });
const account = (over: Partial<AccountCredentials> = {}): AccountCredentials => ({
  accountId: 'acc-1',
  platform: 'youtube',
  externalId: 'UC123',
  accessToken: 'ya29.OLD',
  accessExpiresAt: new Date(NOW.getTime() + 30_000),
  refreshToken: '1//REFRESH',
  scopes: ['https://www.googleapis.com/auth/youtube.force-ssl'],
  meta: {},
  ...over,
});

describe('checkHealth / revoke', () => {
  it('refreshes an expiring token, saves it and checks the channel', async () => {
    const saved: Array<{ token: string; exp: Date }> = [];
    const f = new FakeFetch()
      .once('POST', GOOGLE_TOKEN_URL, jsonResponse({ access_token: 'ya29.NEW', expires_in: 3599 }))
      .once(
        'GET',
        `${YT_API}/channels`,
        jsonResponse({ items: [{ id: 'UC123', snippet: { title: 'Me' } }] }),
      );
    const integ = createYoutubeIntegration({
      fetch: f.fetch,
      env,
      now: () => NOW,
      saveToken: async (_a, token, exp) => {
        saved.push({ token, exp });
      },
    });
    const health = await integ.checkHealth(account());
    expect(health.status).toBe('ok');
    expect(saved).toHaveLength(1);
    expect(saved[0]!.token).toBe('ya29.NEW');
    const ch = new URL(f.callsTo('GET', `${YT_API}/channels`)[0]!.url);
    expect(ch.searchParams.get('mine')).toBe('true');
    expect(f.callsTo('GET', `${YT_API}/channels`)[0]!.headers.authorization).toBe(
      'Bearer ya29.NEW',
    );
  });

  it('reports needs_reauth on invalid_grant', async () => {
    const f = new FakeFetch().once(
      'POST',
      GOOGLE_TOKEN_URL,
      jsonResponse({ error: 'invalid_grant' }, 400),
    );
    const integ = createYoutubeIntegration({
      fetch: f.fetch,
      env,
      now: () => NOW,
      saveToken: async () => {},
    });
    const health = await integ.checkHealth(account());
    expect(health.status).toBe('needs_reauth');
    expect(health.message).not.toContain('REFRESH');
  });

  it('reports needs_reauth on a 403 insufficientPermissions and error on a 503', async () => {
    const ok = account({ accessExpiresAt: new Date(NOW.getTime() + 3600_000) });
    const f1 = new FakeFetch().once(
      'GET',
      `${YT_API}/channels`,
      apiError(403, 'insufficientPermissions'),
    );
    const i1 = createYoutubeIntegration({
      fetch: f1.fetch,
      env,
      now: () => NOW,
      saveToken: async () => {},
    });
    expect((await i1.checkHealth(ok)).status).toBe('needs_reauth');
    const f2 = new FakeFetch().once('GET', `${YT_API}/channels`, apiError(503, 'backendError'));
    const i2 = createYoutubeIntegration({
      fetch: f2.fetch,
      env,
      now: () => NOW,
      saveToken: async () => {},
    });
    expect((await i2.checkHealth(ok)).status).toBe('error');
  });

  it('reports needs_reauth when the scope is missing (without calling Google)', async () => {
    const f = new FakeFetch();
    const integ = createYoutubeIntegration({
      fetch: f.fetch,
      env,
      now: () => NOW,
      saveToken: async () => {},
    });
    expect((await integ.checkHealth(account({ scopes: [] }))).status).toBe('needs_reauth');
    expect(f.calls).toHaveLength(0);
  });

  it('revokes the refresh token and tolerates an already-revoked token', async () => {
    const f = new FakeFetch()
      .once('POST', GOOGLE_REVOKE_URL, emptyResponse(200))
      .once('POST', GOOGLE_REVOKE_URL, jsonResponse({ error: 'invalid_token' }, 400));
    const integ = createYoutubeIntegration({ fetch: f.fetch, env, now: () => NOW });
    await integ.revoke!(account());
    await expect(integ.revoke!(account())).resolves.toBeUndefined();
    expect(new URL(f.calls[0]!.url).searchParams.get('token')).toBe('1//REFRESH');
  });
});
