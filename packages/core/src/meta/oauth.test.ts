import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, oauthFlows, socialAccounts, type Db } from '@app/db';
import { decryptAccount } from '../accounts';
import { createLogger } from '../log';
import { finishMetaOAuth, friendlyOAuthError, pickPage, startMetaOAuth } from './oauth';
import {
  APP_SECRET,
  FakeGraph,
  PAGE_TOKEN,
  SHORT_TOKEN,
  USER_TOKEN,
  graphError,
  testEnv,
} from './test-utils';

const DB_URL = process.env.TEST_DATABASE_URL;
if (!DB_URL) {
  console.warn('TEST_DATABASE_URL is not set: skipping Meta OAuth database tests.');
}

const env = testEnv();
const ALL_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'pages_read_user_content',
  'business_management',
  'instagram_basic',
  'instagram_content_publish',
];

const PAGE_A = {
  id: '111',
  name: 'Travel Page',
  access_token: PAGE_TOKEN,
  tasks: ['MANAGE', 'CREATE_CONTENT'],
  picture: { data: { url: 'https://cdn.example.com/a.jpg' } },
  instagram_business_account: {
    id: '999',
    username: 'traveller',
    profile_picture_url: 'https://cdn.example.com/ig.jpg',
  },
};
const PAGE_B = {
  id: '222',
  name: 'Old Page',
  access_token: 'EAAOTHERPAGETOKENxxxxxxxxxxxxxxx',
  tasks: ['CREATE_CONTENT'],
};

function metaApi(opts: { pages?: unknown[]; scopes?: string[]; valid?: boolean } = {}) {
  return new FakeGraph()
    .on('GET', /\/v27\.0\/oauth\/access_token\?/, (c) =>
      c.params.get('grant_type') === 'fb_exchange_token'
        ? { access_token: USER_TOKEN, token_type: 'bearer', expires_in: 5183944 }
        : { access_token: SHORT_TOKEN, token_type: 'bearer', expires_in: 3600 },
    )
    .on('GET', /\/v27\.0\/debug_token\?/, () => ({
      data: {
        app_id: '1234567890',
        is_valid: opts.valid ?? true,
        scopes: opts.scopes ?? ALL_SCOPES,
        expires_at: Math.floor(Date.now() / 1000) + 5183944,
        data_access_expires_at: 1_800_000_000,
        user_id: '42',
      },
    }))
    .on('GET', /\/v27\.0\/me\/accounts\?/, () => ({ data: opts.pages ?? [PAGE_A] }));
}

describe('meta oauth helpers', () => {
  it('maps the cancel redirect to a friendly message', () => {
    expect(friendlyOAuthError({ error: 'access_denied', errorReason: 'user_denied' })).toMatch(
      /cancelled/,
    );
    expect(friendlyOAuthError({ error: 'server_error', errorDescription: 'Oops' })).toBe(
      'Facebook login failed: Oops',
    );
  });

  it('prefers a postable Page with Instagram linked', () => {
    expect(pickPage([PAGE_B, PAGE_A])?.id).toBe('111');
    expect(pickPage([{ ...PAGE_A, tasks: ['ANALYZE'] }, PAGE_B])?.id).toBe('222');
    expect(pickPage([])).toBeUndefined();
  });
});

describe.skipIf(!DB_URL)('meta oauth flow (database)', () => {
  let db: Db;

  beforeEach(async () => {
    db = getDb(DB_URL);
    await db.delete(socialAccounts);
    await db.delete(oauthFlows);
  });

  afterAll(async () => {
    await closeDb();
  });

  async function stateFrom(url: string) {
    return new URL(url).searchParams.get('state')!;
  }

  it('builds the dialog URL with config_id (Facebook Login for Business) or scope', async () => {
    const withConfig = await startMetaOAuth(
      { db, env: testEnv({ META_LOGIN_CONFIG_ID: 'cfg-77' }) },
      { redirectTo: '/settings' },
    );
    const u = new URL(withConfig);
    expect(u.origin + u.pathname).toBe('https://www.facebook.com/v27.0/dialog/oauth');
    expect(u.searchParams.get('client_id')).toBe('1234567890');
    expect(u.searchParams.get('redirect_uri')).toBe(
      'https://sched.example.com/api/oauth/meta/callback',
    );
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('config_id')).toBe('cfg-77');
    expect(u.searchParams.has('scope')).toBe(false);
    expect(u.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const withScope = new URL(await startMetaOAuth({ db, env }));
    expect(withScope.searchParams.get('scope')).toBe(ALL_SCOPES.join(','));
    expect(withScope.searchParams.has('config_id')).toBe(false);
    expect(withScope.toString()).not.toContain(APP_SECRET);
  });

  it('rejects starting when not configured', async () => {
    await expect(startMetaOAuth({ db, env: testEnv({ META_APP_SECRET: '' }) })).rejects.toThrow(
      /META_APP_ID/,
    );
  });

  it('full callback with one Page: token chain, stores Facebook + Instagram', async () => {
    const graph = metaApi();
    const state = await stateFrom(await startMetaOAuth({ db, env }));
    const res = await finishMetaOAuth({ db, env, fetch: graph.fetch }, { code: 'CODE1', state });
    expect(res).toEqual({ redirectTo: '/settings?connected=meta' });

    // Token chain
    const [exchange, longLived] = graph.find('GET', /oauth\/access_token/);
    expect(Object.fromEntries(exchange!.params)).toEqual({
      client_id: '1234567890',
      redirect_uri: 'https://sched.example.com/api/oauth/meta/callback',
      client_secret: APP_SECRET,
      code: 'CODE1',
    });
    expect(Object.fromEntries(longLived!.params)).toEqual({
      grant_type: 'fb_exchange_token',
      client_id: '1234567890',
      client_secret: APP_SECRET,
      fb_exchange_token: SHORT_TOKEN,
    });
    const dbg = graph.find('GET', /debug_token/)[0]!;
    expect(dbg.params.get('input_token')).toBe(USER_TOKEN);
    expect(dbg.params.get('access_token')).toBe(`1234567890|${APP_SECRET}`);
    const accounts = graph.find('GET', /me\/accounts/)[0]!;
    expect(accounts.params.get('access_token')).toBe(USER_TOKEN);
    expect(accounts.params.get('appsecret_proof')).toMatch(/^[0-9a-f]{64}$/);
    expect(accounts.params.get('fields')).toBe(
      'id,name,access_token,tasks,picture{url},instagram_business_account{id,username,profile_picture_url}',
    );

    const rows = await db.select().from(socialAccounts);
    const fb = rows.find((r) => r.platform === 'facebook')!;
    const ig = rows.find((r) => r.platform === 'instagram')!;
    expect(fb).toMatchObject({
      externalId: '111',
      displayName: 'Travel Page',
      authKind: 'meta_fb_login',
      avatarUrl: 'https://cdn.example.com/a.jpg',
      accessExpiresAt: null,
    });
    expect(fb.meta).toMatchObject({ pageId: '111', pageName: 'Travel Page', otherPages: [] });
    expect(fb.dataAccessExpiresAt?.getTime()).toBe(1_800_000_000_000);
    expect(fb.scopes).toEqual(ALL_SCOPES);
    // Tokens are encrypted at rest.
    expect(fb.accessTokenEnc).not.toContain(PAGE_TOKEN);
    const fbCreds = decryptAccount(fb);
    expect(fbCreds.accessToken).toBe(PAGE_TOKEN);
    expect(fbCreds.userAccessToken).toBe(USER_TOKEN);

    expect(ig).toMatchObject({ externalId: '999', displayName: 'traveller' });
    expect(ig.meta).toEqual({
      igUserId: '999',
      igUsername: 'traveller',
      pageId: '111',
      pageAccountId: fb.id,
    });
    expect(decryptAccount(ig).accessToken).toBe(PAGE_TOKEN);

    // The state is single-use.
    const replay = await finishMetaOAuth({ db, env, fetch: graph.fetch }, { code: 'CODE1', state });
    expect(replay.error).toMatch(/expired or was already used/);
  });

  it('two Pages: picks the one with Instagram and remembers the other', async () => {
    const graph = metaApi({ pages: [PAGE_B, PAGE_A] });
    const state = await stateFrom(await startMetaOAuth({ db, env }));
    const res = await finishMetaOAuth({ db, env, fetch: graph.fetch }, { code: 'C', state });
    expect(res.error).toBeUndefined();
    const rows = await db.select().from(socialAccounts);
    expect(rows).toHaveLength(2);
    const fb = rows.find((r) => r.platform === 'facebook')!;
    expect(fb.externalId).toBe('111');
    expect(fb.meta.otherPages).toEqual([{ id: '222', name: 'Old Page' }]);
  });

  it('Page without Instagram: connects Facebook only, with a notice', async () => {
    const graph = metaApi({ pages: [PAGE_B] });
    const state = await stateFrom(
      await startMetaOAuth({ db, env }, { redirectTo: '/settings#accounts' }),
    );
    const res = await finishMetaOAuth({ db, env, fetch: graph.fetch }, { code: 'C', state });
    expect(res.error).toBeUndefined();
    expect(res.redirectTo).toMatch(/^\/settings\?connected=meta&notice=/);
    const rows = await db.select().from(socialAccounts);
    expect(rows.map((r) => r.platform)).toEqual(['facebook']);
  });

  it('missing permissions → error naming them, nothing stored', async () => {
    const graph = metaApi({ scopes: ['pages_show_list', 'instagram_basic'] });
    const state = await stateFrom(await startMetaOAuth({ db, env }));
    const res = await finishMetaOAuth({ db, env, fetch: graph.fetch }, { code: 'C', state });
    expect(res.error).toMatch(/pages_read_engagement, pages_manage_posts/);
    expect(res.redirectTo.startsWith('/settings?error=')).toBe(true);
    expect(await db.select().from(socialAccounts)).toHaveLength(0);
  });

  it('missing Instagram permissions → Facebook stored, error names them', async () => {
    const graph = metaApi({
      scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
    });
    const state = await stateFrom(await startMetaOAuth({ db, env }));
    const res = await finishMetaOAuth({ db, env, fetch: graph.fetch }, { code: 'C', state });
    expect(res.error).toMatch(/instagram_basic, instagram_content_publish/);
    const rows = await db.select().from(socialAccounts);
    expect(rows.map((r) => r.platform)).toEqual(['facebook']);
  });

  it('user cancelled / no Pages / bad code / unknown state', async () => {
    let state = await stateFrom(await startMetaOAuth({ db, env }));
    const cancelled = await finishMetaOAuth(
      { db, env },
      { code: '', state, error: 'access_denied', errorReason: 'user_denied' },
    );
    expect(cancelled.error).toMatch(/cancelled/);
    expect(new URL(cancelled.redirectTo, 'http://x').searchParams.get('error')).toMatch(
      /cancelled/,
    );

    state = await stateFrom(await startMetaOAuth({ db, env }));
    const none = await finishMetaOAuth(
      { db, env, fetch: metaApi({ pages: [] }).fetch },
      { code: 'C', state },
    );
    expect(none.error).toMatch(/No Facebook Page/);

    state = await stateFrom(await startMetaOAuth({ db, env }));
    const badCode = new FakeGraph().on('GET', /oauth\/access_token/, () =>
      graphError(100, { subcode: 36009, message: 'This authorization code has been used.' }),
    );
    const bad = await finishMetaOAuth({ db, env, fetch: badCode.fetch }, { code: 'C', state });
    expect(bad.error).toMatch(/authorization code has been used/);

    const unknown = await finishMetaOAuth({ db, env }, { code: 'C', state: 'not-a-real-state' });
    expect(unknown.error).toMatch(/expired/);
    expect(unknown.redirectTo.startsWith('/settings?error=')).toBe(true);
  });

  it('never logs or returns tokens', async () => {
    const lines: string[] = [];
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      }),
    );
    try {
      const log = createLogger('test');
      // Success path
      let state = await stateFrom(await startMetaOAuth({ db, env }));
      const ok = await finishMetaOAuth(
        { db, env, log, fetch: metaApi().fetch },
        { code: 'C', state },
      );
      // Failure path where Meta echoes a token in its error text
      state = await stateFrom(await startMetaOAuth({ db, env }));
      const leaky = new FakeGraph().on('GET', /oauth\/access_token/, () =>
        graphError(190, { message: `Invalid OAuth access token ${SHORT_TOKEN}` }),
      );
      const fail = await finishMetaOAuth(
        { db, env, log, fetch: leaky.fetch },
        { code: 'C', state },
      );
      const out = JSON.stringify({ lines, ok, fail });
      for (const secret of [PAGE_TOKEN, USER_TOKEN, SHORT_TOKEN, APP_SECRET]) {
        expect(out).not.toContain(secret);
      }
      expect(lines.length).toBeGreaterThan(0);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
