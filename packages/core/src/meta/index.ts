/**
 * Meta: Facebook Login for Business + Facebook Page (Reels/videos) + Instagram (Reels).
 * (Module owner: meta.)
 */
import type { Db } from '@app/db';
import type { Env } from '../env';
import { NotImplementedError } from '../deps';
import type { PlatformIntegration } from '../platforms';

export function metaOAuthConfigured(env: Env): boolean {
  return Boolean(env.META_APP_ID && env.META_APP_SECRET);
}

/** Redirect URI registered in the Meta app: `${APP_URL}/api/oauth/meta/callback`. */
export const metaRedirectUri = (env: Env) => `${env.APP_URL}/api/oauth/meta/callback`;

export async function startMetaOAuth(
  _deps: { db: Db; env: Env },
  _opts: { redirectTo?: string } = {},
): Promise<string> {
  throw new NotImplementedError('meta.startMetaOAuth');
}

/** Handles the callback: exchanges the code, picks the Page (+ linked IG), stores both accounts. */
export async function finishMetaOAuth(
  _deps: { db: Db; env: Env },
  _params: { code: string; state: string; error?: string },
): Promise<{ redirectTo: string; error?: string }> {
  throw new NotImplementedError('meta.finishMetaOAuth');
}

export const facebookIntegration: PlatformIntegration = {
  platform: 'facebook',
  get publisher(): never {
    throw new NotImplementedError('meta.facebook.publisher');
  },
  async checkHealth() {
    throw new NotImplementedError('meta.facebook.checkHealth');
  },
};

export const instagramIntegration: PlatformIntegration = {
  platform: 'instagram',
  get publisher(): never {
    throw new NotImplementedError('meta.instagram.publisher');
  },
  async checkHealth() {
    throw new NotImplementedError('meta.instagram.checkHealth');
  },
};
