/**
 * The dispatcher runs every minute (PLAN.md §5.4). The schedule lives in post_targets, not in
 * the job queue: each pass picks targets whose prepare_at / scheduled_at / next_attempt_at has
 * arrived and queues one job per target (target queues hold one job per target, so re-sending
 * every minute is a cheap no-op).
 */
import { and, asc, eq, isNotNull, isNull, lte, or, type SQL } from 'drizzle-orm';
import { mediaAssets, postTargets, posts, socialAccounts } from '@app/db';
import { getSettings } from '../../settings';
import { SCHEDULING } from '../config';
import { hasRemote, lateDecision } from '../model';
import {
  enqueue,
  getPublisher,
  loadBundle,
  publishingEnabled,
  type EngineCtx,
  type TargetQueue,
} from './context';
import { finalizeDeletedPost } from './steps';
import { casUpdate, markMissed } from './transitions';

const lockFree = (now: Date) =>
  or(isNull(postTargets.lockedUntil), lte(postTargets.lockedUntil, now));
const attemptDue = (now: Date) =>
  or(isNull(postTargets.nextAttemptAt), lte(postTargets.nextAttemptAt, now));
const notDeleted = and(eq(posts.id, postTargets.postId), isNull(posts.deletedAt));

export async function dispatch(ctx: EngineCtx): Promise<void> {
  const now = ctx.deps.now();
  await finalizeDeleted(ctx);
  if (!publishingEnabled(ctx, 'dispatch')) return;
  await resumeReconnected(ctx, now);
  await assignModes(ctx, now);
  await queueDue(ctx, now);
}

/**
 * Soft-deleted posts: remove them once nothing remote is pending. Their cancels are queued by
 * deletePost and re-queued by the watchdog until the platform copy is gone.
 */
async function finalizeDeleted(ctx: EngineCtx): Promise<void> {
  const rows = await ctx.deps.db
    .select({ id: posts.id })
    .from(posts)
    .where(isNotNull(posts.deletedAt))
    .orderBy(asc(posts.deletedAt))
    .limit(SCHEDULING.batchSize);
  for (const { id } of rows) {
    try {
      await finalizeDeletedPost(ctx, id);
    } catch (err) {
      ctx.log.warn('could not remove deleted post yet', { postId: id, err });
    }
  }
}

/** The owner reconnected the account: paused (needs_reauth) posts continue on their own. */
async function resumeReconnected(ctx: EngineCtx, now: Date): Promise<void> {
  const rows = await ctx.deps.db
    .select({ target: postTargets })
    .from(postTargets)
    .innerJoin(posts, notDeleted)
    .innerJoin(
      socialAccounts,
      and(eq(socialAccounts.id, postTargets.socialAccountId), eq(socialAccounts.status, 'active')),
    )
    .where(and(eq(postTargets.status, 'needs_reauth'), lockFree(now)))
    .limit(SCHEDULING.batchSize);
  for (const { target: t } of rows) {
    const row = await casUpdate(ctx.deps.db, t, now, {
      status: 'scheduled',
      attentionReason: null,
      lastError: null,
      lastErrorCode: null,
      attempts: 0,
      nextAttemptAt: null,
      ...(hasRemote(t) ? {} : { publishMode: null, prepareAt: null }),
    });
    if (row) ctx.log.info('account reconnected; target resumes', { targetId: t.id });
  }
}

/** Scheduled targets get their publish mode and preparation time from the platform publisher. */
async function assignModes(ctx: EngineCtx, now: Date): Promise<void> {
  const rows = await ctx.deps.db
    .select({ target: postTargets, asset: mediaAssets })
    .from(postTargets)
    .innerJoin(posts, notDeleted)
    .innerJoin(mediaAssets, eq(mediaAssets.id, posts.assetId))
    .where(
      and(
        eq(postTargets.status, 'scheduled'),
        or(isNull(postTargets.publishMode), isNull(postTargets.prepareAt)),
        isNotNull(postTargets.scheduledAt),
        lockFree(now),
      ),
    )
    .orderBy(asc(postTargets.scheduledAt))
    .limit(SCHEDULING.batchSize);
  for (const { target: t, asset } of rows) {
    const pub = getPublisher(ctx, t.platform);
    if (!pub.ok) {
      ctx.log.warn('no publisher; target waits', { targetId: t.id, platform: t.platform });
      continue;
    }
    try {
      const input = { scheduledAt: t.scheduledAt!, now, asset, target: t };
      const mode = t.publishMode ?? pub.publisher.chooseMode(input);
      const prepareAt = pub.publisher.prepareAt({ ...input, mode });
      await casUpdate(ctx.deps.db, t, now, { publishMode: mode, prepareAt });
    } catch (err) {
      ctx.log.warn('could not choose publish mode', { targetId: t.id, err });
    }
  }
}

async function dueTargets(ctx: EngineCtx, now: Date, where: SQL) {
  return ctx.deps.db
    .select({ target: postTargets })
    .from(postTargets)
    .innerJoin(posts, notDeleted)
    .where(and(where, lockFree(now), attemptDue(now)))
    .orderBy(asc(postTargets.scheduledAt))
    .limit(SCHEDULING.batchSize);
}

async function queueDue(ctx: EngineCtx, now: Date): Promise<void> {
  const settings = await getSettings(ctx.deps.db);
  const queue = async (q: TargetQueue, ids: string[]) => {
    for (const id of ids) await enqueue(ctx, q, id);
  };

  // Prepare: upload / container / hand over (and resume after a wait or retry).
  const prepare = await dueTargets(
    ctx,
    now,
    and(
      eq(postTargets.status, 'scheduled'),
      isNotNull(postTargets.publishMode),
      or(lte(postTargets.prepareAt, now), eq(postTargets.needsSync, true)),
    )!,
  );
  const prepareIds: string[] = [];
  for (const { target: t } of prepare) {
    // Missed policy for posts we would still have to publish ourselves.
    if ((!hasRemote(t) || t.publishMode === 'app') && lateDecision(t, settings, now) === 'missed') {
      const b = await loadBundle(ctx, t.id);
      if (b) await markMissed(ctx, b);
      continue;
    }
    prepareIds.push(t.id);
  }
  await queue('prepare-target', prepareIds);

  // Sync: an owner change to an item the platform already holds.
  const sync = await dueTargets(
    ctx,
    now,
    and(eq(postTargets.status, 'prepared'), eq(postTargets.needsSync, true))!,
  );
  await queue(
    'prepare-target',
    sync.map((r) => r.target.id),
  );

  // App mode: publish at the time.
  const publish = await dueTargets(
    ctx,
    now,
    and(
      eq(postTargets.status, 'prepared'),
      eq(postTargets.needsSync, false),
      eq(postTargets.publishMode, 'app'),
      lte(postTargets.scheduledAt, now),
    )!,
  );
  const publishIds: string[] = [];
  for (const { target: t } of publish) {
    if (lateDecision(t, settings, now) === 'missed') {
      const b = await loadBundle(ctx, t.id);
      if (b) await markMissed(ctx, b);
      continue;
    }
    publishIds.push(t.id);
  }
  await queue('publish-target', publishIds);

  // Native mode: check it really went live a few minutes after the time.
  const verify = await dueTargets(
    ctx,
    now,
    and(
      eq(postTargets.status, 'prepared'),
      eq(postTargets.needsSync, false),
      eq(postTargets.publishMode, 'native'),
      lte(postTargets.scheduledAt, new Date(now.getTime() - SCHEDULING.verifyDelayMs)),
    )!,
  );
  await queue(
    'publish-target',
    verify.map((r) => r.target.id),
  );

  // A publish that ended without an answer (crash, retryable check): reconcile it.
  const publishing = await dueTargets(ctx, now, eq(postTargets.status, 'publishing'));
  await queue(
    'reconcile-target',
    publishing.map((r) => r.target.id),
  );
}
