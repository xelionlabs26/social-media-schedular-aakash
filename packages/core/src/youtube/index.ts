/**
 * YouTube: Google OAuth + YouTube Data API publisher. (Module owner: youtube.)
 *
 * - oauth.ts:     Connect YouTube (consent URL, callback, account storage).
 * - publisher.ts: resumable upload, native scheduling (private + publishAt), verify, edit, delete.
 * - api.ts:       token refresh, request helper, Google error → PlatformError mapping.
 */
import { getDb } from '@app/db';
import { getEnv, type Env } from '../env';
import { saveAccessToken } from '../accounts';
import {
  isPlatformError,
  type AccountCredentials,
  type AccountHealth,
  type PlatformIntegration,
  type PlatformPublisher,
} from '../platforms';
import {
  GoogleSession,
  YOUTUBE_SCOPE,
  defaultFetch,
  getMyChannel,
  revokeGoogleToken,
  type FetchFn,
} from './api';
import { createYoutubePublisher } from './publisher';

export {
  googleOAuthConfigured,
  googleRedirectUri,
  startGoogleOAuth,
  finishGoogleOAuth,
  safeReturnPath,
  withQuery,
  OAUTH_ERRORS,
  type GoogleOAuthDeps,
} from './oauth';
export {
  createYoutubePublisher,
  buildInsertResource,
  buildPrivacy,
  resolveYoutubeOptions,
  toYoutubeTime,
  type YoutubePublisherOptions,
} from './publisher';
export {
  YOUTUBE_SCOPE,
  mapApiError as mapYoutubeApiError,
  refreshAccessToken,
  shortsUrl,
} from './api';

export interface YoutubeIntegrationOptions {
  fetch?: FetchFn;
  env?: () => Env;
  now?: () => Date;
  /**
   * Persists a token refreshed during checkHealth (the contract passes no PublishInput there).
   * Default: core/accounts saveAccessToken on the shared database.
   */
  saveToken?: (account: AccountCredentials, accessToken: string, expiresAt: Date) => Promise<void>;
}

export function createYoutubeIntegration(
  options: YoutubeIntegrationOptions = {},
): PlatformIntegration {
  const fetchFn = options.fetch ?? defaultFetch;
  const env = options.env ?? (() => getEnv());
  const now = options.now ?? (() => new Date());
  const saveToken =
    options.saveToken ??
    ((account: AccountCredentials, token: string, expiresAt: Date) =>
      saveAccessToken(getDb(), { id: account.accountId, platform: 'youtube' }, token, expiresAt));
  let publisher: PlatformPublisher | undefined;

  return {
    platform: 'youtube',

    get publisher() {
      publisher ??= createYoutubePublisher({ fetch: fetchFn, env });
      return publisher;
    },

    /** Refresh if needed + channels.list mine=true (1 quota unit) → ok / needs_reauth / error. */
    async checkHealth(account): Promise<AccountHealth> {
      const e = env();
      const session = new GoogleSession(account, {
        fetch: fetchFn,
        client:
          e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET
            ? { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET }
            : null,
        now,
        onTokenRefreshed: (token, expiresAt) => saveToken(account, token, expiresAt),
      });
      const scopes = account.scopes;
      if (!scopes.includes(YOUTUBE_SCOPE)) {
        return {
          status: 'needs_reauth',
          message: 'The YouTube permission is missing. Reconnect YouTube.',
          scopes,
        };
      }
      try {
        const channel = await getMyChannel(session);
        if (!channel) {
          return {
            status: 'needs_reauth',
            message: 'No YouTube channel found for this login. Reconnect YouTube.',
          };
        }
        if (account.externalId && channel.id !== account.externalId) {
          return {
            status: 'needs_reauth',
            message: 'This login now points to a different YouTube channel. Reconnect YouTube.',
          };
        }
        return { status: 'ok', accessExpiresAt: session.tokenExpiresAt, scopes };
      } catch (err) {
        if (isPlatformError(err) && err.category === 'auth') {
          return { status: 'needs_reauth', message: err.message, scopes };
        }
        return { status: 'error', message: err instanceof Error ? err.message : String(err) };
      }
    },

    /** Disconnect: revoking the refresh token revokes the whole grant. */
    async revoke(account) {
      const token = account.refreshToken ?? account.accessToken;
      if (!token) return;
      await revokeGoogleToken(fetchFn, token);
    },
  };
}

export const youtubeIntegration: PlatformIntegration = createYoutubeIntegration();
