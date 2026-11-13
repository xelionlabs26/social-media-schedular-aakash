/**
 * Token health (daily check) and revoke for the Meta accounts.
 *
 * debug_token: https://developers.facebook.com/docs/graph-api/reference/debug_token/
 * (input_token = token to inspect, access_token = app token "app_id|app_secret").
 * Data access expiry: https://developers.facebook.com/docs/facebook-login/auth-vs-data
 */
import type { Env } from '../env';
import { isPlatformError, type AccountCredentials, type AccountHealth } from '../platforms';
import type { GraphClient } from './graph';
import type { MetaRuntime } from './runtime';

export const FACEBOOK_REQUIRED_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
] as const;
export const INSTAGRAM_REQUIRED_SCOPES = ['instagram_basic', 'instagram_content_publish'] as const;

export interface DebugTokenData {
  app_id?: string;
  type?: string;
  is_valid?: boolean;
  /** Unix seconds; 0 = never. */
  expires_at?: number;
  data_access_expires_at?: number;
  scopes?: string[];
  user_id?: string;
  profile_id?: string;
  error?: { code?: number; message?: string; subcode?: number };
}

export function appAccessToken(env: Env): string | null {
  if (!env.META_APP_ID || !env.META_APP_SECRET) return null;
  return `${env.META_APP_ID}|${env.META_APP_SECRET}`;
}

/** GET /debug_token with the app token (the app token itself goes in access_token). */
export async function debugToken(
  client: GraphClient,
  env: Env,
  inputToken: string,
): Promise<DebugTokenData> {
  const appToken = appAccessToken(env);
  if (!appToken) throw new Error('META_APP_ID / META_APP_SECRET are not set');
  const res = await client.get<{ data?: DebugTokenData }>(
    'debug_token',
    { input_token: inputToken, access_token: appToken },
    undefined,
    'Meta token check',
  );
  return res.data ?? {};
}

export const unixToDate = (s: number | undefined): Date | null =>
  s && s > 0 ? new Date(s * 1000) : null;

export function missingScopes(granted: string[] | undefined, required: readonly string[]) {
  const set = new Set(granted ?? []);
  return required.filter((s) => !set.has(s));
}

async function checkMetaToken(
  rt: MetaRuntime,
  account: AccountCredentials,
  required: readonly string[],
  extra?: (client: GraphClient) => Promise<void>,
): Promise<AccountHealth> {
  const env = rt.env();
  if (!appAccessToken(env)) {
    return {
      status: 'error',
      message: 'The Meta app is not configured (META_APP_ID / META_APP_SECRET).',
    };
  }
  const client = rt.client();
  try {
    const d = await debugToken(client, env, account.accessToken);
    const scopes = d.scopes ?? [];
    const dataAccessExpiresAt = unixToDate(d.data_access_expires_at);
    const accessExpiresAt = unixToDate(d.expires_at);
    const base = { scopes, dataAccessExpiresAt, accessExpiresAt };
    if (!d.is_valid) {
      return {
        ...base,
        status: 'needs_reauth',
        message: `The Facebook login is no longer valid${d.error?.message ? ` (${d.error.message})` : ''}. Reconnect Facebook.`,
      };
    }
    if (env.META_APP_ID && d.app_id && d.app_id !== env.META_APP_ID) {
      return {
        ...base,
        status: 'needs_reauth',
        message: 'The token belongs to a different Meta app.',
      };
    }
    const missing = missingScopes(scopes, required);
    if (missing.length) {
      return {
        ...base,
        status: 'needs_reauth',
        message: `Missing permissions: ${missing.join(', ')}. Reconnect Facebook and allow them.`,
      };
    }
    if (dataAccessExpiresAt && dataAccessExpiresAt.getTime() <= Date.now()) {
      return {
        ...base,
        status: 'needs_reauth',
        message: 'Meta data access expired (90 days without login). Reconnect Facebook.',
      };
    }
    if (extra) await extra(client);
    return { ...base, status: 'ok' };
  } catch (err) {
    if (isPlatformError(err) && err.category === 'auth') {
      return { status: 'needs_reauth', message: err.message };
    }
    return {
      status: 'error',
      message: isPlatformError(err) ? err.message : 'Could not reach Facebook to check the login.',
    };
  }
}

export function checkFacebookHealth(rt: MetaRuntime, account: AccountCredentials) {
  return checkMetaToken(rt, account, FACEBOOK_REQUIRED_SCOPES);
}

export function checkInstagramHealth(rt: MetaRuntime, account: AccountCredentials) {
  const igUserId = account.meta.igUserId ?? account.externalId;
  return checkMetaToken(
    rt,
    account,
    [...INSTAGRAM_REQUIRED_SCOPES, 'pages_read_engagement'],
    async (client) => {
      // A cheap read that proves the Page token can still reach the Instagram account.
      await client.get(igUserId, { fields: 'username' }, account.accessToken, 'Instagram account');
    },
  );
}

/**
 * Disconnect: DELETE /{user-id}/permissions (here /me, with the long-lived user token) removes
 * the app's grant for this person (Facebook Page and Instagram together). Already-revoked tokens
 * are fine.
 * https://developers.facebook.com/docs/facebook-login/guides/permissions/request-revoke
 */
export async function revokeMeta(rt: MetaRuntime, account: AccountCredentials): Promise<void> {
  if (!account.userAccessToken) return;
  try {
    await rt.client().delete('me/permissions', {}, account.userAccessToken, 'Meta revoke');
  } catch (err) {
    if (isPlatformError(err) && err.category === 'auth') return; // already revoked / expired
    throw err;
  }
}
