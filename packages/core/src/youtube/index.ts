/**
 * YouTube: Google OAuth + YouTube Data API publisher. (Module owner: youtube.)
 */
import type { Db } from '@app/db';
import type { Env } from '../env';
import { NotImplementedError } from '../deps';
import type { PlatformIntegration } from '../platforms';

export function googleOAuthConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

/** Redirect URI registered in Google Cloud: `${APP_URL}/api/oauth/google/callback`. */
export const googleRedirectUri = (env: Env) => `${env.APP_URL}/api/oauth/google/callback`;

/** Returns the Google consent URL (creates the one-time state + PKCE verifier). */
export async function startGoogleOAuth(
  _deps: { db: Db; env: Env },
  _opts: { redirectTo?: string } = {},
): Promise<string> {
  throw new NotImplementedError('youtube.startGoogleOAuth');
}

/** Handles the callback: verifies state, exchanges the code, stores the channel account. */
export async function finishGoogleOAuth(
  _deps: { db: Db; env: Env },
  _params: { code: string; state: string; error?: string },
): Promise<{ redirectTo: string; error?: string }> {
  throw new NotImplementedError('youtube.finishGoogleOAuth');
}

export const youtubeIntegration: PlatformIntegration = {
  platform: 'youtube',
  get publisher(): never {
    throw new NotImplementedError('youtube.publisher');
  },
  async checkHealth() {
    throw new NotImplementedError('youtube.checkHealth');
  },
};
