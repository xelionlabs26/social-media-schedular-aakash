/**
 * OAuth tests against a real Postgres (oauth_flows + social_accounts).
 * Run with TEST_DATABASE_URL=postgres://…/test_youtube (migrated with `pnpm db:migrate`).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, oauthFlows, socialAccounts, type Db } from '@app/db';
import { getEnv } from '../env';
import { decryptAccount } from '../accounts';
import { GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL, YOUTUBE_SCOPE, YT_API } from './api';
import { OAUTH_ERRORS, finishGoogleOAuth, safeReturnPath, startGoogleOAuth } from './oauth';
import { FakeFetch, apiError, emptyResponse, jsonResponse } from './test-helpers';

const DB_URL = process.env.TEST_DATABASE_URL;
if (!DB_URL) {
  console.warn(
    '[youtube/oauth.test] TEST_DATABASE_URL is not set: skipping the OAuth database tests.',
  );
}

const env = getEnv({
  APP_URL: 'https://scheduler.example.com/',
  GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'CLIENT-SECRET-VALUE',
});

const CHANNEL = {
  id: 'UC_test_channel',
  snippet: {
    title: 'Aakash Vlogs',
    thumbnails: {
      default: { url: 'https://yt3.example/d.jpg' },
      medium: { url: 'https://yt3.example/m.jpg' },
    },
  },
};

describe.skipIf(!DB_URL)('Google OAuth', () => {
  let db: Db;

  beforeEach(async () => {
    db ??= getDb(DB_URL);
    await db.delete(oauthFlows);
    await db.delete(socialAccounts).where(eq(socialAccounts.platform, 'youtube'));
  });

  afterAll(async () => {
    if (db) {
      await db.delete(oauthFlows);
      await db.delete(socialAccounts).where(eq(socialAccounts.platform, 'youtube'));
    }
    await closeDb();
  });

  async function start(redirectTo?: string) {
    const url = new URL(await startGoogleOAuth({ db, env }, { redirectTo }));
    return { url, state: url.searchParams.get('state')! };
  }

  const tokenOk = (over: Record<string, unknown> = {}) =>
    jsonResponse({
      access_token: 'ya29.ACCESS',
      expires_in: 3599,
      refresh_token: '1//REFRESH',
      scope: `${YOUTUBE_SCOPE} openid`,
      token_type: 'Bearer',
      ...over,
    });

  it('builds the consent URL with PKCE, offline access and state', async () => {
    const { url, state } = await start();
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = url.searchParams;
    expect(p.get('client_id')).toBe('cid.apps.googleusercontent.com');
    expect(p.get('redirect_uri')).toBe('https://scheduler.example.com/api/oauth/google/callback');
    expect(p.get('response_type')).toBe('code');
    expect(p.get('scope')).toBe(YOUTUBE_SCOPE);
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('include_granted_scopes')).toBe('true');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state.length).toBeGreaterThan(20);
    const rows = await db.select().from(oauthFlows);
    expect(rows).toHaveLength(1);
    // Only the hash of the state is stored, and the verifier is encrypted.
    expect(rows[0]!.stateHash).not.toBe(state);
    expect(rows[0]!.codeVerifierEnc).toBeTruthy();
  });

  it('connects the channel on the happy path', async () => {
    const { url, state } = await start('/settings?tab=accounts');
    const f = new FakeFetch()
      .once('POST', GOOGLE_TOKEN_URL, tokenOk())
      .once('GET', `${YT_API}/channels`, jsonResponse({ items: [CHANNEL] }));
    const res = await finishGoogleOAuth({ db, env, fetch: f.fetch }, { code: '4/CODE', state });
    expect(res.error).toBeUndefined();
    expect(res.redirectTo).toBe('/settings?tab=accounts&connected=youtube');

    // Token exchange carried the PKCE verifier matching the challenge.
    const form = new URLSearchParams(f.callsTo('POST', GOOGLE_TOKEN_URL)[0]!.body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('4/CODE');
    expect(form.get('redirect_uri')).toBe(
      'https://scheduler.example.com/api/oauth/google/callback',
    );
    expect(form.get('client_secret')).toBe('CLIENT-SECRET-VALUE');
    const { createHash } = await import('node:crypto');
    const challenge = createHash('sha256').update(form.get('code_verifier')!).digest('base64url');
    expect(challenge).toBe(url.searchParams.get('code_challenge'));

    const ch = f.callsTo('GET', `${YT_API}/channels`)[0]!;
    expect(ch.headers.authorization).toBe('Bearer ya29.ACCESS');
    expect(new URL(ch.url).searchParams.get('mine')).toBe('true');

    const rows = await db
      .select()
      .from(socialAccounts)
      .where(eq(socialAccounts.platform, 'youtube'));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      authKind: 'google',
      externalId: 'UC_test_channel',
      displayName: 'Aakash Vlogs',
      avatarUrl: 'https://yt3.example/m.jpg',
      status: 'active',
      meta: { channelId: 'UC_test_channel', channelTitle: 'Aakash Vlogs' },
    });
    expect(row.scopes).toContain(YOUTUBE_SCOPE);
    // Encrypted at rest.
    expect(row.accessTokenEnc).not.toContain('ya29');
    expect(row.refreshTokenEnc).not.toContain('REFRESH');
    const creds = decryptAccount(row);
    expect(creds.accessToken).toBe('ya29.ACCESS');
    expect(creds.refreshToken).toBe('1//REFRESH');
    expect(row.accessExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 3000_000);

    // The state is single-use.
    const again = await finishGoogleOAuth({ db, env, fetch: f.fetch }, { code: '4/CODE', state });
    expect(again.error).toBe(OAUTH_ERRORS.badState);
  });

  it('explains a cancelled consent screen', async () => {
    const { state } = await start();
    const f = new FakeFetch();
    const res = await finishGoogleOAuth(
      { db, env, fetch: f.fetch },
      { code: '', state, error: 'access_denied' },
    );
    expect(res.error).toBe(OAUTH_ERRORS.denied);
    expect(res.redirectTo).toBe(`/settings?${new URLSearchParams({ error: OAUTH_ERRORS.denied })}`);
    expect(f.calls).toHaveLength(0);
    // The state was consumed.
    const rows = await db.select().from(oauthFlows);
    expect(rows[0]!.usedAt).not.toBeNull();
  });

  it('rejects an unknown state', async () => {
    const res = await finishGoogleOAuth(
      { db, env, fetch: new FakeFetch().fetch },
      { code: 'x', state: 'forged' },
    );
    expect(res.error).toBe(OAUTH_ERRORS.badState);
  });

  it('asks to remove access and reconnect when no refresh token comes back on first connect', async () => {
    const { state } = await start();
    const f = new FakeFetch()
      .once('POST', GOOGLE_TOKEN_URL, tokenOk({ refresh_token: undefined }))
      .once('GET', `${YT_API}/channels`, jsonResponse({ items: [CHANNEL] }));
    const res = await finishGoogleOAuth({ db, env, fetch: f.fetch }, { code: 'c', state });
    expect(res.error).toBe(OAUTH_ERRORS.noRefreshToken);
    expect(res.error).toMatch(/myaccount\.google\.com\/permissions/);
    expect(
      await db.select().from(socialAccounts).where(eq(socialAccounts.platform, 'youtube')),
    ).toHaveLength(0);
  });

  it('keeps the stored refresh token on a reconnect without a new one', async () => {
    let { state } = await start();
    let f = new FakeFetch()
      .once('POST', GOOGLE_TOKEN_URL, tokenOk())
      .once('GET', `${YT_API}/channels`, jsonResponse({ items: [CHANNEL] }));
    await finishGoogleOAuth({ db, env, fetch: f.fetch }, { code: 'c', state });
    ({ state } = await start());
    f = new FakeFetch()
      .once(
        'POST',
        GOOGLE_TOKEN_URL,
        tokenOk({ refresh_token: undefined, access_token: 'ya29.SECOND' }),
      )
      .once('GET', `${YT_API}/channels`, jsonResponse({ items: [CHANNEL] }));
    const res = await finishGoogleOAuth({ db, env, fetch: f.fetch }, { code: 'c', state });
    expect(res.error).toBeUndefined();
    const [row] = await db
      .select()
      .from(socialAccounts)
      .where(eq(socialAccounts.platform, 'youtube'));
    expect(decryptAccount(row!)).toMatchObject({
      accessToken: 'ya29.SECOND',
      refreshToken: '1//REFRESH',
    });
  });

  it('refuses when the YouTube scope was not granted (granular consent) and revokes the grant', async () => {
    const { state } = await start();
    const f = new FakeFetch()
      .once('POST', GOOGLE_TOKEN_URL, tokenOk({ scope: 'openid email' }))
      .once('POST', GOOGLE_REVOKE_URL, emptyResponse(200));
    const res = await finishGoogleOAuth({ db, env, fetch: f.fetch }, { code: 'c', state });
    expect(res.error).toBe(OAUTH_ERRORS.scopeMissing);
    expect(f.callsTo('GET', `${YT_API}/channels`)).toHaveLength(0);
    expect(new URL(f.callsTo('POST', GOOGLE_REVOKE_URL)[0]!.url).searchParams.get('token')).toBe(
      '1//REFRESH',
    );
  });

  it('explains when the Google account has no channel', async () => {
    const { state } = await start();
    const f = new FakeFetch()
      .once('POST', GOOGLE_TOKEN_URL, tokenOk())
      .once('GET', `${YT_API}/channels`, jsonResponse({ items: [] }))
      .once('POST', GOOGLE_REVOKE_URL, emptyResponse(200));
    expect((await finishGoogleOAuth({ db, env, fetch: f.fetch }, { code: 'c', state })).error).toBe(
      OAUTH_ERRORS.noChannel,
    );
    const { state: s2 } = await start();
    const f2 = new FakeFetch()
      .once('POST', GOOGLE_TOKEN_URL, tokenOk())
      .once('GET', `${YT_API}/channels`, apiError(401, 'youtubeSignupRequired'))
      .once('POST', GOOGLE_REVOKE_URL, emptyResponse(200));
    expect(
      (await finishGoogleOAuth({ db, env, fetch: f2.fetch }, { code: 'c', state: s2 })).error,
    ).toBe(OAUTH_ERRORS.noChannel);
  });

  it('reports a rejected code without leaking secrets', async () => {
    const { state } = await start();
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
    const f = new FakeFetch().once(
      'POST',
      GOOGLE_TOKEN_URL,
      jsonResponse({ error: 'invalid_grant', error_description: 'Bad Request' }, 400),
    );
    const res = await finishGoogleOAuth({ db, env, fetch: f.fetch, log }, { code: 'c', state });
    expect(res.error).toBe(OAUTH_ERRORS.exchangeFailed);
    const logged = JSON.stringify([log.warn.mock.calls, log.info.mock.calls, log.error.mock.calls]);
    expect(logged).not.toContain('CLIENT-SECRET-VALUE');
    expect(logged).not.toContain('code_verifier');
  });

  it('retires a previously connected different channel (one channel in v1)', async () => {
    let { state } = await start();
    let f = new FakeFetch()
      .once('POST', GOOGLE_TOKEN_URL, tokenOk())
      .once('GET', `${YT_API}/channels`, jsonResponse({ items: [CHANNEL] }));
    await finishGoogleOAuth({ db, env, fetch: f.fetch }, { code: 'c', state });
    ({ state } = await start());
    f = new FakeFetch()
      .once('POST', GOOGLE_TOKEN_URL, tokenOk())
      .once('GET', `${YT_API}/channels`, jsonResponse({ items: [{ ...CHANNEL, id: 'UC_other' }] }));
    await finishGoogleOAuth({ db, env, fetch: f.fetch }, { code: 'c', state });
    const rows = await db
      .select()
      .from(socialAccounts)
      .where(eq(socialAccounts.platform, 'youtube'));
    expect(rows.find((r) => r.externalId === 'UC_test_channel')!.status).toBe('disabled');
    expect(rows.find((r) => r.externalId === 'UC_other')!.status).toBe('active');
  });
});

describe('safeReturnPath', () => {
  it('allows only same-site relative paths', () => {
    expect(safeReturnPath('/settings')).toBe('/settings');
    expect(safeReturnPath('//evil.com')).toBe('/settings');
    expect(safeReturnPath('https://evil.com')).toBe('/settings');
    expect(safeReturnPath('/\\evil.com')).toBe('/settings');
    expect(safeReturnPath(undefined)).toBe('/settings');
  });
});
