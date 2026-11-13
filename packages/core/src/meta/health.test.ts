import { describe, expect, it } from 'vitest';
import { createFacebookIntegration, createInstagramIntegration } from './index';
import {
  APP_SECRET,
  FakeGraph,
  PAGE_TOKEN,
  USER_TOKEN,
  fbAccount,
  graphError,
  igAccount,
  testEnv,
} from './test-utils';

const env = testEnv();
const future = Math.floor(Date.now() / 1000) + 60 * 86400;
const ALL_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'instagram_basic',
  'instagram_content_publish',
];

function debug(data: Record<string, unknown>) {
  return () => ({ data: { app_id: '1234567890', ...data } });
}

describe('meta checkHealth', () => {
  it('ok when the Page token is valid with all permissions', async () => {
    const graph = new FakeGraph().on(
      'GET',
      /debug_token/,
      debug({ is_valid: true, scopes: ALL_SCOPES, expires_at: 0, data_access_expires_at: future }),
    );
    const fb = createFacebookIntegration({ env: () => env, fetch: graph.fetch });
    const res = await fb.checkHealth(fbAccount());
    expect(res.status).toBe('ok');
    expect(res.accessExpiresAt).toBeNull();
    expect(res.dataAccessExpiresAt?.getTime()).toBe(future * 1000);
    const call = graph.calls[0]!;
    expect(call.url.searchParams.get('input_token')).toBe(PAGE_TOKEN);
    expect(call.url.searchParams.get('access_token')).toBe(`1234567890|${APP_SECRET}`);
  });

  it('needs_reauth when invalid, missing permissions or data access expired', async () => {
    const graph = new FakeGraph()
      .once('GET', /debug_token/, debug({ is_valid: false, error: { message: 'Session expired' } }))
      .once('GET', /debug_token/, debug({ is_valid: true, scopes: ['pages_show_list'] }))
      .once(
        'GET',
        /debug_token/,
        debug({ is_valid: true, scopes: ALL_SCOPES, data_access_expires_at: 1000 }),
      );
    const fb = createFacebookIntegration({ env: () => env, fetch: graph.fetch });
    const a = await fb.checkHealth(fbAccount());
    expect(a.status).toBe('needs_reauth');
    const b = await fb.checkHealth(fbAccount());
    expect(b).toMatchObject({
      status: 'needs_reauth',
      message: expect.stringContaining('pages_manage_posts'),
    });
    expect((await fb.checkHealth(fbAccount())).status).toBe('needs_reauth');
  });

  it('instagram also proves the IG account is reachable', async () => {
    const graph = new FakeGraph()
      .on('GET', /debug_token/, debug({ is_valid: true, scopes: ALL_SCOPES }))
      .once('GET', /\/999\?/, () => ({ username: 'me', id: '999' }))
      .once('GET', /\/999\?/, () => graphError(190, { message: 'Error validating access token' }));
    const ig = createInstagramIntegration({ env: () => env, fetch: graph.fetch });
    expect((await ig.checkHealth(igAccount())).status).toBe('ok');
    expect(graph.find('GET', /\/999\?/)[0]!.url.searchParams.get('fields')).toBe('username');
    expect((await ig.checkHealth(igAccount())).status).toBe('needs_reauth');
  });

  it('reports error (not reauth) on network trouble, and when not configured', async () => {
    const graph = new FakeGraph().on('GET', /debug_token/, () => new Response('', { status: 503 }));
    const fb = createFacebookIntegration({ env: () => env, fetch: graph.fetch });
    expect((await fb.checkHealth(fbAccount())).status).toBe('error');
    const unconfigured = createFacebookIntegration({
      env: () => testEnv({ META_APP_SECRET: '' }),
      fetch: graph.fetch,
    });
    expect((await unconfigured.checkHealth(fbAccount())).status).toBe('error');
  });
});

describe('meta revoke', () => {
  it('DELETE /me/permissions with the user token; already revoked is fine', async () => {
    const graph = new FakeGraph()
      .once('DELETE', /\/me\/permissions/, () => ({ success: true }))
      .once('DELETE', /\/me\/permissions/, () => graphError(190, { message: 'expired' }));
    const fb = createFacebookIntegration({ env: () => env, fetch: graph.fetch });
    await fb.revoke!(fbAccount());
    expect(graph.calls[0]!.url.searchParams.get('access_token')).toBe(USER_TOKEN);
    await expect(fb.revoke!(fbAccount())).resolves.toBeUndefined();
    // Instagram revoke never touches the shared Facebook grant.
    const ig = createInstagramIntegration({ env: () => env, fetch: graph.fetch });
    await ig.revoke!(igAccount());
    expect(graph.calls).toHaveLength(2);
  });
});
