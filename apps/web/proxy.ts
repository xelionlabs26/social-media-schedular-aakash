/**
 * Runs before every request: sends signed-out visitors to /login.
 * (Cheap check of the signed cookie only; pages and actions re-check against the database.)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, readSessionToken } from './lib/session';

const PUBLIC_PREFIXES = [
  '/login',
  '/privacy',
  '/terms',
  '/data-deletion',
  '/api/health',
  // Signed URLs (HMAC in the query string), used by the browser uploader and by platforms.
  '/api/uploads/local',
  '/api/files',
];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }
  const session = await readSessionToken(request.cookies.get(SESSION_COOKIE)?.value).catch(
    () => null,
  );
  if (session) return NextResponse.next();
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
