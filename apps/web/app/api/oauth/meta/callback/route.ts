/**
 * GET /api/oauth/meta/callback: Facebook redirects here after the login dialog with
 * ?code&state (or ?error=access_denied&error_reason=user_denied&error_description=...).
 * Stores the Page + linked Instagram account, then 302 to /settings?connected=meta or ?error=...
 */
import { NextResponse, type NextRequest } from 'next/server';
import { finishMetaOAuth } from '@app/core/meta';
import { UnauthorizedError, requireOwner } from '@/lib/auth';
import { getDeps } from '@/lib/deps';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const deps = getDeps();
  try {
    await requireOwner();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.redirect(new URL('/login', deps.env.APP_URL), { status: 302 });
    }
    throw err;
  }
  const q = request.nextUrl.searchParams;
  let redirectTo: string;
  try {
    const res = await finishMetaOAuth(
      { db: deps.db, env: deps.env, log: deps.log },
      {
        code: q.get('code') ?? '',
        state: q.get('state') ?? '',
        error: q.get('error') ?? undefined,
        errorReason: q.get('error_reason') ?? undefined,
        errorDescription: q.get('error_description') ?? undefined,
      },
    );
    redirectTo = res.redirectTo;
  } catch (err) {
    deps.log.error('Meta login callback failed', {
      error: err instanceof Error ? err.message : 'unknown',
    });
    redirectTo = `/settings?error=${encodeURIComponent('Could not finish the Facebook login. Try again.')}`;
  }
  // finishMetaOAuth only returns same-site relative paths.
  return NextResponse.redirect(new URL(redirectTo, deps.env.APP_URL), { status: 302 });
}
