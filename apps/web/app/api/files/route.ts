/**
 * Signed file downloads for the local storage driver (video playback with Range support,
 * thumbnails, and files the worker or a platform fetches).
 * Public route (see proxy.ts): the HMAC signature in the query string authorizes the request.
 */
import { getEnv } from '@app/core/env';
import { getStorage } from '@app/core/storage';
import { handleLocalFile } from '@/lib/upload/local-routes';

export const dynamic = 'force-dynamic';

function deps() {
  const env = getEnv();
  return env.STORAGE_DRIVER === 'local'
    ? { driver: env.STORAGE_DRIVER, storage: getStorage() }
    : null;
}

export async function GET(request: Request): Promise<Response> {
  const d = deps();
  if (!d) return Response.json({ error: 'Forbidden' }, { status: 403 });
  return handleLocalFile(request, d);
}

export async function HEAD(request: Request): Promise<Response> {
  const d = deps();
  if (!d) return new Response(null, { status: 403 });
  return handleLocalFile(request, d, { head: true });
}
