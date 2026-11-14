/**
 * Google OAuth for YouTube: authorization-code flow with PKCE (S256), one-time state and
 * offline access (refresh token).
 * https://developers.google.com/identity/protocols/oauth2/web-server
 * PKCE parameters: https://developers.google.com/identity/protocols/oauth2/native-app#step1-code-verifier
 */
import { and, eq, ne } from 'drizzle-orm';
import { socialAccounts, type Db } from '@app/db';
import type { Env } from '../env';
import {
  consumeOauthFlow,
  createOauthFlow,
  disconnectAccount,
  pkcePair,
  upsertSocialAccount,
} from '../accounts';
import { isPlatformError } from '../platforms';
import type { Logger } from '../log';
import {
  GOOGLE_AUTH_URL,
  GoogleSession,
  GoogleTokenError,
  YOUTUBE_SCOPE,
  channelAvatar,
  defaultFetch,
  expiryFrom,
  getMyChannel,
  postTokenEndpoint,
  revokeGoogleToken,
  type FetchFn,
} from './api';

export function googleOAuthConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

/** Redirect URI registered in Google Cloud: `${APP_URL}/api/oauth/google/callback`. */
export const googleRedirectUri = (env: Env) => `${env.APP_URL}/api/oauth/google/callback`;

/** Where the owner lands after connecting (the Settings screen shows the result). */
export const DEFAULT_OAUTH_RETURN = '/settings';

/** Only same-site relative paths are allowed as post-login destinations (no open redirect). */
export function safeReturnPath(path: string | undefined | null): string {
  if (!path || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    return DEFAULT_OAUTH_RETURN;
  }
  return path;
}

/** Appends a query parameter to a relative path that may already have a query string. */
export function withQuery(path: string, params: Record<string, string>): string {
  const [base, query = ''] = path.split('?', 2) as [string, string?];
  const qs = new URLSearchParams(query);
  for (const [k, v] of Object.entries(params)) qs.set(k, v);
  return `${base}?${qs.toString()}`;
}

export interface GoogleOAuthDeps {
  db: Db;
  env: Env;
  /** Injected in tests. */
  fetch?: FetchFn;
  log?: Logger;
  now?: () => Date;
}

/** Returns the Google consent URL (creates the one-time state + PKCE verifier). */
export async function startGoogleOAuth(
  deps: GoogleOAuthDeps,
  opts: { redirectTo?: string } = {},
): Promise<string> {
  if (!googleOAuthConfigured(deps.env)) {
    throw new Error('Google sign-in is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).');
  }
  const { verifier, challenge } = pkcePair();
  const state = await createOauthFlow(deps.db, 'google', {
    codeVerifier: verifier,
    redirectTo: safeReturnPath(opts.redirectTo),
  });
  const params = new URLSearchParams({
    client_id: deps.env.GOOGLE_CLIENT_ID!,
    redirect_uri: googleRedirectUri(deps.env),
    response_type: 'code',
    scope: YOUTUBE_SCOPE,
    // offline + consent: Google returns a refresh token every time the owner connects.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/** Messages shown on the Settings screen. */
export const OAUTH_ERRORS = {
  notConfigured:
    'YouTube is not set up yet. Paste the Google app keys under Settings → Setup first.',
  denied: 'You cancelled the Google permission screen, so YouTube was not connected.',
  googleError: 'Google could not complete the sign-in. Please try Connect YouTube again.',
  badState: 'This sign-in link expired or was already used. Please click Connect YouTube again.',
  noCode: 'Google did not return a sign-in code. Please try Connect YouTube again.',
  exchangeFailed: 'Google did not accept the sign-in code. Please click Connect YouTube again.',
  scopeMissing:
    'YouTube was not connected because the permission "Manage your YouTube videos" was not ticked. Click Connect YouTube again and allow it.',
  noChannel:
    'This Google account has no YouTube channel. Create a channel on youtube.com (or pick the right account), then connect again.',
  noRefreshToken:
    "Google did not give this app a long-term login. Open https://myaccount.google.com/permissions, remove this app's access, then click Connect YouTube again.",
  temporary:
    'Google or YouTube had a temporary problem. Please try Connect YouTube again in a minute.',
} as const;

/**
 * Handles the callback: verifies state, exchanges the code, checks the granted scope, reads the
 * channel and stores the account.
 *
 * `redirectTo` is a complete relative URL for the browser: the stored return path plus
 * `?connected=youtube` on success or `?error=<message>` on failure. `error` repeats the message
 * for logging.
 */
export async function finishGoogleOAuth(
  deps: GoogleOAuthDeps,
  params: { code: string; state: string; error?: string },
): Promise<{ redirectTo: string; error?: string }> {
  const fetchFn = deps.fetch ?? defaultFetch;
  const now = deps.now ?? (() => new Date());
  let returnPath = DEFAULT_OAUTH_RETURN;
  const fail = (error: string, extra?: Record<string, unknown>) => {
    deps.log?.warn('Google OAuth failed', { error, ...extra });
    return { redirectTo: withQuery(returnPath, { error }), error };
  };

  if (!googleOAuthConfigured(deps.env)) return fail(OAUTH_ERRORS.notConfigured);

  // Consume the state even when Google reports an error, so it can never be reused.
  const flow = params.state ? await consumeOauthFlow(deps.db, 'google', params.state) : null;
  if (flow?.redirectTo) returnPath = safeReturnPath(flow.redirectTo);

  if (params.error) {
    // https://developers.google.com/identity/protocols/oauth2/web-server#handlingresponse
    return fail(params.error === 'access_denied' ? OAUTH_ERRORS.denied : OAUTH_ERRORS.googleError, {
      googleError: params.error,
    });
  }
  if (!flow || !flow.codeVerifier) return fail(OAUTH_ERRORS.badState);
  if (!params.code) return fail(OAUTH_ERRORS.noCode);

  // 1. Exchange the code (PKCE: the verifier proves we started this flow).
  let tokens;
  try {
    tokens = await postTokenEndpoint(fetchFn, {
      code: params.code,
      client_id: deps.env.GOOGLE_CLIENT_ID!,
      client_secret: deps.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: googleRedirectUri(deps.env),
      grant_type: 'authorization_code',
      code_verifier: flow.codeVerifier,
    });
  } catch (err) {
    if (err instanceof GoogleTokenError) {
      return fail(OAUTH_ERRORS.exchangeFailed, {
        oauthError: err.oauthError,
        httpStatus: err.httpStatus,
      });
    }
    return fail(OAUTH_ERRORS.temporary, { reason: errMessage(err) });
  }

  // Revokes the grant we just received when we can't use it, so no unused access lingers.
  const discard = async () => {
    try {
      await revokeGoogleToken(fetchFn, tokens.refresh_token ?? tokens.access_token);
    } catch (err) {
      deps.log?.warn('Could not revoke an unused Google token', { reason: errMessage(err) });
    }
  };

  // 2. Granular consent: the owner may untick the YouTube permission.
  const scopes = (tokens.scope ?? '').split(' ').filter(Boolean);
  if (!scopes.includes(YOUTUBE_SCOPE)) {
    await discard();
    return fail(OAUTH_ERRORS.scopeMissing, { scopes });
  }

  // 3. Which channel did the owner pick?
  const expiresAt = expiryFrom(now(), tokens.expires_in);
  const session = new GoogleSession(
    { accessToken: tokens.access_token, accessExpiresAt: expiresAt, refreshToken: undefined },
    { fetch: fetchFn, client: null, now },
  );
  let channel;
  try {
    channel = await getMyChannel(session);
  } catch (err) {
    await discard();
    if (isPlatformError(err) && err.code === 'youtubeSignupRequired')
      return fail(OAUTH_ERRORS.noChannel);
    return fail(OAUTH_ERRORS.temporary, { reason: errMessage(err) });
  }
  if (!channel) {
    await discard();
    return fail(OAUTH_ERRORS.noChannel);
  }

  // 4. A refresh token is essential (uploads run unattended). With prompt=consent Google sends
  //    one, but if it doesn't and we don't already hold one for this channel, ask to reset.
  if (!tokens.refresh_token) {
    const existing = await deps.db
      .select({ refreshTokenEnc: socialAccounts.refreshTokenEnc })
      .from(socialAccounts)
      .where(and(eq(socialAccounts.platform, 'youtube'), eq(socialAccounts.externalId, channel.id)))
      .limit(1);
    if (!existing[0]?.refreshTokenEnc) return fail(OAUTH_ERRORS.noRefreshToken);
  }

  const channelTitle = channel.snippet?.title ?? 'YouTube channel';
  const account = await upsertSocialAccount(deps.db, {
    platform: 'youtube',
    authKind: 'google',
    externalId: channel.id,
    displayName: channelTitle,
    avatarUrl: channelAvatar(channel),
    accessToken: tokens.access_token,
    accessExpiresAt: expiresAt,
    refreshToken: tokens.refresh_token ?? null,
    scopes,
    meta: { channelId: channel.id, channelTitle },
  });

  // v1 supports one YouTube channel: connecting a different one retires the old row (its
  // tokens are forgotten; scheduled posts must be reconnected to the new channel).
  const others = await deps.db
    .select({ id: socialAccounts.id })
    .from(socialAccounts)
    .where(
      and(
        eq(socialAccounts.platform, 'youtube'),
        ne(socialAccounts.id, account.id),
        ne(socialAccounts.status, 'disabled'),
      ),
    );
  for (const other of others) await disconnectAccount(deps.db, other.id);

  deps.log?.info('YouTube connected', { accountId: account.id, channelId: channel.id });
  return { redirectTo: withQuery(returnPath, { connected: 'youtube' }) };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
