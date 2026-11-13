/**
 * GET /api/oauth/google/start[?next=/settings] → 302 to Google's consent screen.
 * Owner only. When Google keys are missing, returns to Settings with an explanation.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  OAUTH_ERRORS,
  googleOAuthConfigured,
  safeReturnPath,
  startGoogleOAuth,
  withQuery,
} from '@app/core/youtube';
import { isOwner } from '@/lib/auth';
import { getDeps } from '@/lib/deps';

export const dynamic = 'force-dynamic';

function redirect(path: string, base: string) {
  const res = NextResponse.redirect(new URL(path, base), { status: 302 });
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

export async function GET(request: NextRequest) {
  const deps = getDeps();
  if (!(await isOwner())) return redirect('/login', deps.env.APP_URL);

  const next = safeReturnPath(request.nextUrl.searchParams.get('next'));
  if (!googleOAuthConfigured(deps.env)) {
    return redirect(withQuery(next, { error: OAUTH_ERRORS.notConfigured }), deps.env.APP_URL);
  }
  try {
    const url = await startGoogleOAuth(deps, { redirectTo: next });
    const res = NextResponse.redirect(url, { status: 302 });
    res.headers.set('Cache-Control', 'no-store');
    return res;
  } catch (err) {
    deps.log.error('Could not start Google OAuth', { error: err });
    return redirect(withQuery(next, { error: OAUTH_ERRORS.temporary }), deps.env.APP_URL);
  }
}
