/**
 * GET /api/oauth/google/callback?code=…&state=… (or ?error=access_denied&state=…)
 * Google redirects here after the consent screen. Stores the YouTube channel and sends the
 * owner back to Settings with ?connected=youtube or ?error=<message>.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { OAUTH_ERRORS, finishGoogleOAuth } from '@app/core/youtube';
import { isOwner } from '@/lib/auth';
import { getDeps } from '@/lib/deps';

export const dynamic = 'force-dynamic';

function redirect(path: string, base: string) {
  const res = NextResponse.redirect(new URL(path, base), { status: 302 });
  // The URL we came from carries a one-time code: never cache this response.
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

export async function GET(request: NextRequest) {
  const deps = getDeps();
  // The owner started this flow while signed in; the session cookie (SameSite=Lax) comes back
  // with Google's top-level redirect. Anyone else is sent to the login page.
  if (!(await isOwner())) return redirect('/login', deps.env.APP_URL);

  const sp = request.nextUrl.searchParams;
  try {
    const result = await finishGoogleOAuth(
      { db: deps.db, env: deps.env, log: deps.log },
      {
        code: sp.get('code') ?? '',
        state: sp.get('state') ?? '',
        error: sp.get('error') ?? undefined,
      },
    );
    return redirect(result.redirectTo, deps.env.APP_URL);
  } catch (err) {
    deps.log.error('Google OAuth callback crashed', { error: err });
    return redirect(
      `/settings?${new URLSearchParams({ error: OAUTH_ERRORS.temporary })}`,
      deps.env.APP_URL,
    );
  }
}
