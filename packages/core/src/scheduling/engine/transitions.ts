/**
 * Every target state change the engine makes is a compare-and-set:
 *
 * - acquire(): `WHERE status = expected AND version = v AND lock free` and sets locked_until.
 *   The version check means the engine never acts on text/time the owner has since changed.
 * - finish(): `WHERE status = in-flight status AND locked_until = our lock`. It checks the lock
 *   token, not the version: an owner edit made while the upload ran (needs_sync, new version) is
 *   kept and pushed afterwards instead of making the finished upload look like a conflict.
 * - casUpdate(): changes without a lock (mode assignment, missed, pre-checks), same guard as
 *   acquire().
 *
 * The engine never bumps `version`: it counts owner edits, so a background status change never
 * makes the owner's open editor stale.
 */
import { and, eq, isNull, lte, or } from 'drizzle-orm';
import {
  postTargets,
  socialAccounts,
  type AttentionReason,
  type Db,
  type PostTarget,
  type SocialAccount,
  type TargetStatus,
} from '@app/db';
import { setAccountStatus } from '../../accounts';
import { NotImplementedError } from '../../deps';
import { ConfigError } from '../../env';
import { isPlatformError, type PlatformErrorCategory } from '../../platforms';
import { formatShort } from '../../time';
import { hasRemote, platformLabel, postName, truncate } from '../model';
import { alert, enqueue, type Bundle, type EngineCtx } from './context';

export type TargetPatch = Partial<typeof postTargets.$inferInsert>;
type Updater = Pick<Db, 'update'>;

/** A lock value doubles as the lock token, so a little jitter keeps two tokens apart. */
export function newLock(now: Date, ms: number): Date {
  return new Date(now.getTime() + ms + Math.floor(Math.random() * 1000));
}

const lockFree = (now: Date) =>
  or(isNull(postTargets.lockedUntil), lte(postTargets.lockedUntil, now));

export async function acquire(
  db: Updater,
  t: PostTarget,
  now: Date,
  lockMs: number,
  patch: TargetPatch = {},
): Promise<{ row: PostTarget; lock: Date } | null> {
  const lock = newLock(now, lockMs);
  const rows = await db
    .update(postTargets)
    .set({ ...patch, lockedUntil: lock })
    .where(
      and(
        eq(postTargets.id, t.id),
        eq(postTargets.status, t.status),
        eq(postTargets.version, t.version),
        lockFree(now),
      ),
    )
    .returning();
  return rows[0] ? { row: rows[0], lock } : null;
}

export async function finish(
  db: Updater,
  targetId: string,
  lock: Date,
  inFlightStatus: TargetStatus,
  patch: TargetPatch,
): Promise<PostTarget | null> {
  const rows = await db
    .update(postTargets)
    .set({ ...patch, lockedUntil: null })
    .where(
      and(
        eq(postTargets.id, targetId),
        eq(postTargets.status, inFlightStatus),
        eq(postTargets.lockedUntil, lock),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function casUpdate(
  db: Updater,
  t: PostTarget,
  now: Date,
  patch: TargetPatch,
): Promise<PostTarget | null> {
  const rows = await db
    .update(postTargets)
    .set(patch)
    .where(
      and(
        eq(postTargets.id, t.id),
        eq(postTargets.status, t.status),
        eq(postTargets.version, t.version),
        lockFree(now),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Our finish() did not apply: the owner moved the target (draft / delete) while the step ran.
 * Release our lock and remove whatever reached the platform, since the owner no longer wants it.
 */
export async function handleLostLock(ctx: EngineCtx, targetId: string, lock: Date): Promise<void> {
  const { db } = ctx.deps;
  const [row] = await db.select().from(postTargets).where(eq(postTargets.id, targetId));
  if (!row) return;
  if (row.lockedUntil?.getTime() === lock.getTime()) {
    await db
      .update(postTargets)
      .set({ lockedUntil: null })
      .where(and(eq(postTargets.id, targetId), eq(postTargets.lockedUntil, lock)));
  }
  ctx.log.info('target changed while a platform step ran; kept the owner’s change', {
    targetId,
    status: row.status,
  });
  if ((row.status === 'draft' || row.status === 'canceled') && hasRemote(row)) {
    await enqueue(ctx, 'cancel-target', targetId);
  }
}

/** How a step holds the target, for the helpers below. */
export interface Held {
  lock: Date;
  inFlightStatus: TargetStatus;
}

async function apply(
  ctx: EngineCtx,
  b: Bundle,
  held: Held | null,
  patch: TargetPatch,
): Promise<PostTarget | null> {
  const { db } = ctx.deps;
  const row = held
    ? await finish(db, b.target.id, held.lock, held.inFlightStatus, patch)
    : await casUpdate(db, b.target, ctx.deps.now(), patch);
  if (!row && held) await handleLostLock(ctx, b.target.id, held.lock);
  return row;
}

// ---------------------------------------------------------------------------------------------
// Needs attention
// ---------------------------------------------------------------------------------------------

export async function failTarget(
  ctx: EngineCtx,
  b: Bundle,
  held: Held | null,
  f: { reason: AttentionReason; message: string; code?: string; extra?: TargetPatch },
): Promise<void> {
  const row = await apply(ctx, b, held, {
    status: 'failed',
    attentionReason: f.reason,
    lastError: truncate(f.message),
    lastErrorCode: f.code ?? null,
    nextAttemptAt: null,
    ...f.extra,
  });
  if (!row) return;
  const t = b.target;
  ctx.log.warn('target failed', { targetId: t.id, reason: f.reason, code: f.code });
  await alert(ctx, {
    kind: f.reason === 'quota' ? 'quota' : 'publish_failed',
    targetId: t.id,
    message: `${platformLabel(t.platform)}: '${postName(t, b.asset)}' failed: ${f.message}`,
    dedupeKey: `failed:${t.id}:${t.version}:${f.reason}:${t.scheduledAt?.getTime() ?? 0}`,
  });
}

export async function markMissed(ctx: EngineCtx, b: Bundle): Promise<void> {
  const t = b.target;
  const skip = b.settings.missedPolicy === 'skip';
  const when = t.scheduledAt ? formatShort(t.scheduledAt, b.settings.timezone) : 'its time';
  const row = await apply(ctx, b, null, {
    status: 'missed',
    attentionReason: 'missed',
    lastError: `Missed its time (${when}): the server was down.`,
    nextAttemptAt: null,
  });
  if (!row) return;
  ctx.log.warn('target missed', { targetId: t.id, policy: b.settings.missedPolicy });
  const label = platformLabel(t.platform);
  await alert(ctx, {
    kind: 'missed',
    targetId: t.id,
    message: skip
      ? `${label}: '${postName(t, b.asset)}' was skipped: it missed its time (${when}) because the server was down.`
      : `${label}: '${postName(t, b.asset)}' missed its time (${when}): the server was down. Publish it now or pick a new time.`,
    dedupeKey: `missed:${t.id}:${t.scheduledAt?.getTime() ?? 0}`,
  });
}

/**
 * The account's login is broken: the account becomes needs_reauth, every post we would still
 * have to send with it pauses, and the owner gets one alert (per account per day).
 */
export async function flagAccount(
  ctx: EngineCtx,
  account: SocialAccount,
  message: string,
): Promise<void> {
  const { db } = ctx.deps;
  const now = ctx.deps.now();
  const [fresh] = await db.select().from(socialAccounts).where(eq(socialAccounts.id, account.id));
  if (fresh?.status === 'active') {
    await setAccountStatus(db, account.id, 'needs_reauth', truncate(message));
  }
  // Posts a platform already holds with its own schedule (native 'prepared') still go out; only
  // the ones we must still send pause until the owner reconnects.
  await db
    .update(postTargets)
    .set({ status: 'needs_reauth', attentionReason: 'reconnect', nextAttemptAt: null })
    .where(
      and(
        eq(postTargets.socialAccountId, account.id),
        or(
          eq(postTargets.status, 'scheduled'),
          and(eq(postTargets.status, 'prepared'), eq(postTargets.publishMode, 'app')),
        ),
        lockFree(now),
      ),
    );
  const day = now.toISOString().slice(0, 10);
  await alert(ctx, {
    kind: 'needs_reauth',
    message: `${platformLabel(account.platform)} needs reconnecting: ${truncate(message, 200)} Its posts are paused until you reconnect it in Settings.`,
    dedupeKey: `needs_reauth:${account.id}:${day}`,
    link: `${ctx.deps.env.APP_URL}/settings`,
  });
}

export async function markNeedsReauth(
  ctx: EngineCtx,
  b: Bundle,
  held: Held | null,
  message: string,
  extra: TargetPatch = {},
): Promise<void> {
  await apply(ctx, b, held, {
    status: 'needs_reauth',
    attentionReason: 'reconnect',
    lastError: truncate(message),
    nextAttemptAt: null,
    ...extra,
  });
  if (b.account) await flagAccount(ctx, b.account, message);
}

// ---------------------------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------------------------

export interface Classified {
  category: PlatformErrorCategory;
  message: string;
  code?: string;
  httpStatus?: number;
  retryAfterSec?: number;
  details?: unknown;
}

/**
 * PlatformError keeps its category. Anything else is unexpected (network glitch, storage
 * hiccup, bug): it is retried with the normal backoff cap, except missing configuration or an
 * unfinished integration, which retrying can't fix.
 */
export function classify(err: unknown): Classified {
  if (isPlatformError(err)) {
    return {
      category: err.category,
      message: err.message,
      code: err.code,
      httpStatus: err.httpStatus,
      retryAfterSec: err.retryAfterSec,
      details: err.details,
    };
  }
  if (err instanceof NotImplementedError) {
    return {
      category: 'fatal',
      message: 'Publishing to this platform is not available yet.',
      code: 'not_implemented',
    };
  }
  if (err instanceof ConfigError)
    return { category: 'fatal', message: err.message, code: 'config' };
  const e = err instanceof Error ? err : new Error(String(err));
  if (e.name === 'AbortError' || e.name === 'TimeoutError') {
    return {
      category: 'retryable',
      message: 'The platform did not answer in time.',
      code: 'timeout',
    };
  }
  return {
    category: 'retryable',
    message: truncate(e.message || 'Unexpected error', 300),
    code: 'unexpected',
  };
}

/**
 * 'invalid' errors are about either the text or the video. Integrations can say which with
 * details.reason; otherwise the code/message decides.
 */
export function invalidReason(e: Classified): 'invalid_text' | 'invalid_video' {
  const reason = (e.details as { reason?: unknown } | undefined)?.reason;
  if (reason === 'invalid_text' || reason === 'invalid_video') return reason;
  return /title|description|caption|tag|text|metadata|hashtag|mention/i.test(
    `${e.code ?? ''} ${e.message}`,
  )
    ? 'invalid_text'
    : 'invalid_video';
}
