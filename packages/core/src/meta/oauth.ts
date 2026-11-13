/**
 * Facebook Login for Business (manual, server-side code flow) for the Facebook Page + the
 * Instagram account linked to it.
 *
 * Flow: dialog → callback with ?code → short-lived user token → long-lived user token
 * (fb_exchange_token) → debug_token (granted scopes, data-access expiry) → /me/accounts (Page
 * tokens + linked Instagram account) → store both accounts encrypted.
 *
 * Docs:
 * - Manual flow (dialog, cancel redirect, code exchange):
 *   https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
 * - Facebook Login for Business (config_id replaces scope):
 *   https://developers.facebook.com/docs/facebook-login/facebook-login-for-business
 * - Long-lived tokens: https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
 */
import type { Db } from '@app/db';
import { consumeOauthFlow, createOauthFlow, upsertSocialAccount } from '../accounts';
import { ConfigError, type Env } from '../env';
import type { Logger } from '../log';
import { isPlatformError } from '../platforms';
import { scrubSecrets } from './errors';
import { GraphClient, type FetchFn } from './graph';
import {
  FACEBOOK_REQUIRED_SCOPES,
  INSTAGRAM_REQUIRED_SCOPES,
  debugToken,
  missingScopes,
  unixToDate,
} from './health';

/**
 * Permissions requested when no Login Configuration (config_id) is set. With Facebook Login for
 * Business the configuration in the Meta dashboard lists these instead (PLAN.md Appendix A).
 */
export const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'pages_read_user_content',
  'business_management',
  'instagram_basic',
  'instagram_content_publish',
] as const;

export interface MetaOAuthDeps {
  db: Db;
  env: Env;
  /** Injected in tests. */
  fetch?: FetchFn;
  log?: Logger;
}

export function metaOAuthConfigured(env: Env): boolean {
  return Boolean(env.META_APP_ID && env.META_APP_SECRET);
}

/** Redirect URI registered in the Meta app: `${APP_URL}/api/oauth/meta/callback`. */
export const metaRedirectUri = (env: Env) => `${env.APP_URL}/api/oauth/meta/callback`;

const DEFAULT_RETURN = '/settings';

/** Only same-site relative paths, so the callback can't be turned into an open redirect. */
export function safeReturnPath(path: string | undefined | null): string {
  if (!path || !path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) {
    return DEFAULT_RETURN;
  }
  return path;
}

function withParams(path: string, params: Record<string, string>): string {
  const u = new URL(path, 'http://local.invalid');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return `${u.pathname}${u.search}`;
}

function clientFor(deps: MetaOAuthDeps): GraphClient {
  return new GraphClient({
    version: deps.env.GRAPH_VERSION,
    appSecret: deps.env.META_APP_SECRET,
    fetch: deps.fetch,
  });
}

/** Returns the Facebook login dialog URL (creates the one-time state). */
export async function startMetaOAuth(
  deps: MetaOAuthDeps,
  opts: { redirectTo?: string } = {},
): Promise<string> {
  const { env } = deps;
  if (!metaOAuthConfigured(env)) {
    throw new ConfigError('META_APP_ID', 'META_APP_ID and META_APP_SECRET are needed for Facebook');
  }
  const state = await createOauthFlow(deps.db, 'meta', {
    redirectTo: safeReturnPath(opts.redirectTo),
  });
  const qs = new URLSearchParams({
    client_id: env.META_APP_ID!,
    redirect_uri: metaRedirectUri(env),
    state,
    response_type: 'code',
  });
  if (env.META_LOGIN_CONFIG_ID) {
    // Facebook Login for Business: the configuration carries the permissions and assets.
    qs.set('config_id', env.META_LOGIN_CONFIG_ID);
  } else {
    qs.set('scope', META_SCOPES.join(','));
  }
  return `https://www.facebook.com/${env.GRAPH_VERSION}/dialog/oauth?${qs.toString()}`;
}

/** Maps the dialog's error redirect (?error=access_denied&error_reason=user_denied) to text. */
export function friendlyOAuthError(p: {
  error?: string;
  errorReason?: string;
  errorDescription?: string;
}): string {
  if (p.errorReason === 'user_denied' || p.error === 'access_denied') {
    return 'You cancelled the Facebook login, so nothing was connected.';
  }
  const detail = scrubSecrets((p.errorDescription || p.error || 'unknown error').slice(0, 200));
  return `Facebook login failed: ${detail}`;
}

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

export interface MetaPage {
  id: string;
  name?: string;
  access_token?: string;
  tasks?: string[];
  picture?: { data?: { url?: string } };
  instagram_business_account?: { id: string; username?: string; profile_picture_url?: string };
}

/**
 * Picks the Page to connect: prefer Pages we may post to (CREATE_CONTENT task), then Pages with a
 * linked Instagram account, then the first.
 */
export function pickPage(pages: MetaPage[]): MetaPage | undefined {
  const canPost = (p: MetaPage) => !p.tasks || p.tasks.includes('CREATE_CONTENT');
  return (
    pages.find((p) => canPost(p) && p.instagram_business_account && p.access_token) ??
    pages.find((p) => canPost(p) && p.access_token) ??
    pages.find((p) => p.access_token)
  );
}

async function listPages(client: GraphClient, userToken: string): Promise<MetaPage[]> {
  const res = await client.get<{ data?: MetaPage[] }>(
    'me/accounts',
    {
      fields:
        'id,name,access_token,tasks,picture{url},instagram_business_account{id,username,profile_picture_url}',
      limit: 100,
    },
    userToken,
    'Facebook Pages',
  );
  return res.data ?? [];
}

/** Handles the callback: exchanges the code, picks the Page (+ linked IG), stores both accounts. */
export async function finishMetaOAuth(
  deps: MetaOAuthDeps,
  params: {
    code: string;
    state: string;
    error?: string;
    errorReason?: string;
    errorDescription?: string;
  },
): Promise<{ redirectTo: string; error?: string }> {
  const { db, env } = deps;
  const flow = params.state ? await consumeOauthFlow(db, 'meta', params.state) : null;
  const base = safeReturnPath(flow?.redirectTo);
  const fail = (error: string) => {
    deps.log?.warn('Meta login failed', { error });
    return { redirectTo: withParams(base, { error }), error };
  };

  if (!flow)
    return fail('This Facebook login link expired or was already used. Click Connect again.');
  if (params.error || params.errorReason) return fail(friendlyOAuthError(params));
  if (!params.code) return fail('Facebook did not send a login code. Click Connect again.');
  if (!metaOAuthConfigured(env)) return fail('The Meta app is not configured on the server.');

  const client = clientFor(deps);
  try {
    // 1. Code → short-lived user token (server-side: uses the app secret).
    const short = await client.get<TokenResponse>(
      'oauth/access_token',
      {
        client_id: env.META_APP_ID,
        redirect_uri: metaRedirectUri(env),
        client_secret: env.META_APP_SECRET,
        code: params.code,
      },
      undefined,
      'Facebook code exchange',
    );
    if (!short.access_token) return fail('Facebook did not return an access token.');

    // 2. Short-lived → long-lived user token (~60 days). Page tokens derived from it don't expire.
    const long = await client.get<TokenResponse>(
      'oauth/access_token',
      {
        grant_type: 'fb_exchange_token',
        client_id: env.META_APP_ID,
        client_secret: env.META_APP_SECRET,
        fb_exchange_token: short.access_token,
      },
      undefined,
      'Facebook long-lived token',
    );
    const userToken = long.access_token ?? short.access_token;

    // 3. What was actually granted (people can untick permissions in the dialog).
    const dbg = await debugToken(client, env, userToken);
    if (!dbg.is_valid) return fail('Facebook returned an invalid login. Click Connect again.');
    if (dbg.app_id && dbg.app_id !== env.META_APP_ID) {
      return fail('Facebook returned a login for a different app.');
    }
    const scopes = dbg.scopes ?? [];
    const dataAccessExpiresAt = unixToDate(dbg.data_access_expires_at);
    const missingFb = missingScopes(scopes, FACEBOOK_REQUIRED_SCOPES);
    if (missingFb.length) {
      return fail(
        `Facebook did not grant: ${missingFb.join(', ')}. Click Connect again and keep every permission switched on.`,
      );
    }

    // 4. Pages (with Page tokens) and their linked Instagram accounts.
    const pages = await listPages(client, userToken);
    const page = pickPage(pages);
    if (!page || !page.access_token) {
      return fail(
        'No Facebook Page was shared with the app. Click Connect again and select your Page.',
      );
    }
    const otherPages = pages
      .filter((p) => p.id !== page.id)
      .map((p) => ({
        id: p.id,
        name: p.name ?? '',
        igUsername: p.instagram_business_account?.username,
      }));

    const fbRow = await upsertSocialAccount(db, {
      platform: 'facebook',
      authKind: 'meta_fb_login',
      externalId: page.id,
      displayName: page.name ?? 'Facebook Page',
      avatarUrl: page.picture?.data?.url ?? null,
      accessToken: page.access_token,
      accessExpiresAt: null,
      userAccessToken: userToken,
      dataAccessExpiresAt,
      scopes,
      meta: { pageId: page.id, pageName: page.name, otherPages },
    });

    const ig = page.instagram_business_account;
    if (!ig) {
      deps.log?.info('Meta connected (no Instagram linked)', { pageId: page.id });
      return {
        redirectTo: withParams(base, {
          connected: 'meta',
          notice: `Connected ${page.name ?? 'your Page'}. No Instagram professional account is linked to this Page.`,
        }),
      };
    }

    const missingIg = missingScopes(scopes, INSTAGRAM_REQUIRED_SCOPES);
    if (missingIg.length) {
      return fail(
        `Facebook is connected, but Instagram permissions were not granted: ${missingIg.join(', ')}. Click Connect again and allow them.`,
      );
    }

    await upsertSocialAccount(db, {
      platform: 'instagram',
      authKind: 'meta_fb_login',
      externalId: ig.id,
      displayName: ig.username ?? 'Instagram',
      avatarUrl: ig.profile_picture_url ?? null,
      // Instagram API with Facebook Login uses the Page token.
      accessToken: page.access_token,
      accessExpiresAt: null,
      dataAccessExpiresAt,
      scopes,
      meta: {
        igUserId: ig.id,
        igUsername: ig.username,
        pageId: page.id,
        pageAccountId: fbRow.id,
      },
    });
    deps.log?.info('Meta connected', { pageId: page.id, igUserId: ig.id });
    return { redirectTo: withParams(base, { connected: 'meta' }) };
  } catch (err) {
    const msg = isPlatformError(err)
      ? `Could not finish the Facebook login: ${err.message}`
      : 'Could not finish the Facebook login. Please try again.';
    if (!isPlatformError(err)) {
      deps.log?.error('Meta login crashed', {
        error: err instanceof Error ? scrubSecrets(err.message) : 'unknown',
      });
    }
    return fail(msg);
  }
}
