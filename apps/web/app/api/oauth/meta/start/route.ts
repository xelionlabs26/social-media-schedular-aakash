/**
 * GET /api/oauth/meta/start → 302 to the Facebook login dialog (Facebook Login for Business).
 * Optional ?next=/some/path to return somewhere other than /settings afterwards.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { metaOAuthConfigured, safeReturnPath, startMetaOAuth } from '@app/core/meta';
import { UnauthorizedError, requireOwner } from '@/lib/auth';
import { getDeps } from '@/lib/deps';

export const dynamic = 'force-dynamic';

function settingsWithError(appUrl: string, message: string) {
  const url = new URL('/settings', appUrl);
  url.searchParams.set('error', message);
  return NextResponse.redirect(url, { status: 302 });
}

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
  if (!metaOAuthConfigured(deps.env)) {
    return settingsWithError(
      deps.env.APP_URL,
      'Facebook is not set up yet. Paste the Meta app keys under Settings → Setup first.',
    );
  }
  try {
    const next = safeReturnPath(request.nextUrl.searchParams.get('next'));
    const dialogUrl = await startMetaOAuth(deps, { redirectTo: next });
    return NextResponse.redirect(dialogUrl, { status: 302 });
  } catch (err) {
    deps.log.error('Meta login start failed', {
      error: err instanceof Error ? err.message : 'unknown',
    });
    return settingsWithError(deps.env.APP_URL, 'Could not start the Facebook login. Try again.');
  }
}
