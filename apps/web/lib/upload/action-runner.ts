/**
 * Shared wrapper for the Upload/editor server actions: owner check first, then the work, and
 * every error mapped to `{ ok: false, error }` (never thrown to the client, never a secret).
 * Server-only.
 */
import type { ServiceDeps } from '@app/core/deps';
import { createLogger } from '@app/core/log';
import { requireOwner } from '@/lib/auth';
import { getDeps } from '@/lib/deps';
import { toActionError } from './errors';
import type { ActionResult } from './types';

const fallbackLog = createLogger('web:actions');

export async function runAction<T extends object>(
  context: string,
  work: (deps: ServiceDeps) => Promise<T>,
): Promise<ActionResult<T>> {
  let deps: ServiceDeps | undefined;
  try {
    await requireOwner();
    deps = getDeps();
    const out = await work(deps);
    return { ok: true, ...out };
  } catch (err) {
    return toActionError(err, deps?.log ?? fallbackLog, context);
  }
}
