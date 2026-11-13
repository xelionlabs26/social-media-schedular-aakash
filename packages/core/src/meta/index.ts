/**
 * Meta: Facebook Login for Business + Facebook Page (Reels/videos) + Instagram (Reels).
 * (Module owner: meta.)
 *
 * Graph host https://graph.facebook.com/{GRAPH_VERSION}; bytes go to rupload.facebook.com.
 */
import type { PlatformIntegration } from '../platforms';
import { createFacebookPublisher } from './facebook';
import { checkFacebookHealth, checkInstagramHealth, revokeMeta } from './health';
import { createInstagramPublisher } from './instagram';
import { createMetaRuntime, type MetaRuntimeOptions } from './runtime';

export {
  META_SCOPES,
  finishMetaOAuth,
  friendlyOAuthError,
  metaOAuthConfigured,
  metaRedirectUri,
  pickPage,
  safeReturnPath,
  startMetaOAuth,
  type MetaOAuthDeps,
  type MetaPage,
} from './oauth';
export { mapGraphError, scrubSecrets, regainAccessSeconds } from './errors';
export { qualifiesAsReel, facebookKind } from './video';
export { FACEBOOK_REQUIRED_SCOPES, INSTAGRAM_REQUIRED_SCOPES } from './health';
export type { MetaRuntimeOptions } from './runtime';

/** Builds the Facebook integration (tests inject fetch / env). */
export function createFacebookIntegration(opts: MetaRuntimeOptions = {}): PlatformIntegration {
  const rt = createMetaRuntime(opts);
  const publisher = createFacebookPublisher(rt);
  return {
    platform: 'facebook',
    publisher,
    checkHealth: (account) => checkFacebookHealth(rt, account),
    revoke: (account) => revokeMeta(rt, account),
  };
}

/** Builds the Instagram integration (tests inject fetch / env). */
export function createInstagramIntegration(opts: MetaRuntimeOptions = {}): PlatformIntegration {
  const rt = createMetaRuntime(opts);
  const publisher = createInstagramPublisher(rt);
  return {
    platform: 'instagram',
    publisher,
    checkHealth: (account) => checkInstagramHealth(rt, account),
    // Instagram shares the Facebook login: revoking it would also cut off the Page. Disconnecting
    // Instagram only forgets its stored token (accounts.disconnectAccount); revoke via Facebook.
    revoke: async () => {},
  };
}

export const facebookIntegration: PlatformIntegration = createFacebookIntegration();
export const instagramIntegration: PlatformIntegration = createInstagramIntegration();
