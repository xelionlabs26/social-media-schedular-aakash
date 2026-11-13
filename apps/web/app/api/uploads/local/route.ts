/**
 * Browser uploads for the local storage driver (signed PUT URLs from LocalStorage).
 * Public route (see proxy.ts): the HMAC signature in the query string authorizes the request.
 */
import { getEnv } from '@app/core/env';
import { getStorage } from '@app/core/storage';
import { handleLocalUpload } from '@/lib/upload/local-routes';

export const dynamic = 'force-dynamic';

export async function PUT(request: Request): Promise<Response> {
  const env = getEnv();
  // Never build the storage client unless this driver is active (S3 settings may be missing).
  if (env.STORAGE_DRIVER !== 'local') {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  return handleLocalUpload(request, { driver: env.STORAGE_DRIVER, storage: getStorage() });
}
