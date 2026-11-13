/**
 * The platform steps of one target (PLAN.md §5.1–5.5):
 *
 *   scheduled ──prepare──▶ preparing ──done──▶ prepared ──publish──▶ publishing ──▶ published
 *       ▲  └─ wait / retry ◀──┘                    │  (app mode at the time; native: verify)
 *       └──────────── needs_sync: update, or cancel + prepare again ◀┘
 *
 * Each step: load → guard (status, lock, due, preconditions, missed policy) → acquire the lock
 * (compare-and-set) → call the platform → finish (compare-and-set on the lock token).
 * Errors are handled by PlatformError category in handleStepError.
 */
import { and, eq, sql } from 'drizzle-orm';
import {
  mediaAssets,
  postTargets,
  posts,
  publishAttempts,
  type PostTarget,
  type PublishAttempt,
  type TargetStatus,
} from '@app/db';
import { keys } from '../../storage';
import type { PlatformPublisher, PublishInput, ReconcileResult, StepResult } from '../../platforms';
import { validateTargetText } from '../../text';
import { backoffSec, SCHEDULING } from '../config';
import { checkUploadCap, capLockKey, CAPPED_PLATFORMS, uploadDeadline } from '../limits';
import {
  CLEARED_REMOTE,
  hasRemote,
  IN_FLIGHT_STATUSES,
  isLocked,
  lateDecision,
  platformLabel,
  postName,
  truncate,
} from '../model';
import { formatShort } from '../../time';
import {
  alert,
  buildInput,
  enqueue,
  getPublisher,
  loadBundle,
  logAttempt,
  publishingEnabled,
  type Bundle,
  type EngineCtx,
  type TargetQueue,
} from './context';
import {
  acquire,
  casUpdate,
  classify,
  failTarget,
  finish,
  flagAccount,
  handleLostLock,
  invalidReason,
  markMissed,
  markNeedsReauth,
  type Classified,
  type Held,
  type TargetPatch,
} from './transitions';

const LOCK = SCHEDULING.lockMs;
const msUntil = (at: Date, now: Date) => Math.max(0, at.getTime() - now.getTime());

/** Checks that don't need the platform: video, account and text are still good to publish. */
async function preconditionsFail(ctx: EngineCtx, b: Bundle, checkText: boolean): Promise<boolean> {
  const t = b.target;
  const label = platformLabel(t.platform);
  const fail = async (reason: Parameters<typeof failTarget>[3]['reason'], message: string) => {
    await failTarget(ctx, b, null, { reason, message });
    return true;
  };
  if (b.asset.status !== 'ready') return fail('processing_failed', 'The video is not ready.');
  if (b.asset.purgedAt)
    return fail('invalid_video', 'The video file was already deleted from storage.');
  if (!b.account || b.account.status === 'disabled')
    return fail('not_connected', `${label} is not connected.`);
  if (b.account.status === 'needs_reauth') {
    await markNeedsReauth(ctx, b, null, b.account.lastError ?? `${label} needs reconnecting.`);
    return true;
  }
  if (checkText) {
    const issue = validateTargetText(t.platform, t, { fbKind: t.options.fbKind }).find(
      (i) => i.severity === 'block',
    );
    if (issue) return fail('invalid_text', issue.message);
    const videoBlock = b.asset.warnings.find(
      (w) => w.severity === 'block' && (!w.platform || w.platform === t.platform),
    );
    if (videoBlock) return fail('invalid_video', videoBlock.message);
  }
  return false;
}

/** After a successful prepare/sync: queue whatever comes next for this target. */
async function followUp(ctx: EngineCtx, row: PostTarget): Promise<void> {
  const now = ctx.deps.now();
  if (row.needsSync) return enqueue(ctx, 'prepare-target', row.id); // edited during the step
  if (!row.scheduledAt) return;
  const dueAt =
    row.publishMode === 'native'
      ? new Date(row.scheduledAt.getTime() + SCHEDULING.verifyDelayMs)
      : row.scheduledAt;
  await enqueue(ctx, 'publish-target', row.id, msUntil(dueAt, now));
}

// ---------------------------------------------------------------------------------------------
// prepare (upload / container / hand over to the native scheduler) and sync
// ---------------------------------------------------------------------------------------------

export async function prepareTarget(ctx: EngineCtx, targetId: string): Promise<void> {
  if (!publishingEnabled(ctx, 'prepare', targetId)) return;
  const now = ctx.deps.now();
  const b = await loadBundle(ctx, targetId);
  if (!b || b.post.deletedAt) return;
  const t = b.target;
  const original = t.status;
  if (!(original === 'scheduled' || (original === 'prepared' && t.needsSync))) return;
  if (isLocked(t, now) || !t.scheduledAt) return;
  if (t.nextAttemptAt && t.nextAttemptAt > now) {
    return enqueue(ctx, 'prepare-target', t.id, msUntil(t.nextAttemptAt, now));
  }
  const syncing = t.needsSync && (original === 'prepared' || hasRemote(t));
  const fresh = original === 'scheduled' && !hasRemote(t);

  const pub = getPublisher(ctx, t.platform);
  if (!pub.ok) return failTarget(ctx, b, null, { reason: 'platform_error', message: pub.message });
  const publisher = pub.publisher;

  // Mode and preparation time are chosen lazily, and again while nothing was handed over yet,
  // because the right mode depends on how far away the time is (e.g. Facebook < 10 min = app).
  let mode = t.publishMode;
  if (fresh || !mode) {
    const modeInput = { scheduledAt: t.scheduledAt, now, asset: b.asset, target: t };
    mode = publisher.chooseMode(modeInput);
    // A stored prepare_at wins: the dispatcher set it, or a daily cap / quota pause pushed it.
    const dueAt = fresh ? (t.prepareAt ?? publisher.prepareAt({ ...modeInput, mode })) : now;
    if (dueAt > now) {
      if (t.publishMode !== mode || t.prepareAt?.getTime() !== dueAt.getTime()) {
        await casUpdate(ctx.deps.db, t, now, { publishMode: mode, prepareAt: dueAt });
      }
      return enqueue(ctx, 'prepare-target', t.id, msUntil(dueAt, now));
    }
  } else if (original === 'scheduled' && t.prepareAt && t.prepareAt > now && !syncing) {
    return enqueue(ctx, 'prepare-target', t.id, msUntil(t.prepareAt, now));
  }

  if (await preconditionsFail(ctx, b, true)) return;
  // Missed policy, only while we are still the one who has to publish it.
  if (original === 'scheduled' && (!hasRemote(t) || mode === 'app')) {
    if (lateDecision(t, b.settings, now) === 'missed') return markMissed(ctx, b);
  }

  const patch: TargetPatch = {
    status: 'preparing',
    publishMode: mode,
    needsSync: false,
    nextAttemptAt: null,
  };
  let acquired: { row: PostTarget; lock: Date } | null;
  if (fresh && CAPPED_PLATFORMS.includes(t.platform)) {
    // Count and take the upload slot atomically (one advisory lock per platform/Page).
    const res = await ctx.deps.db.transaction(async (tx) => {
      await tx.execute(sqlLock(capLockKey(t)));
      const cap = await checkUploadCap(tx, t, now);
      if (cap.capped) return { cap, acquired: null };
      return { cap: null, acquired: await acquire(tx, t, now, LOCK.prepare, patch) };
    });
    if (res.cap) return handleCapped(ctx, b, mode, res.cap.opensAt!, res.cap);
    acquired = res.acquired;
  } else {
    acquired = await acquire(ctx.deps.db, t, now, LOCK.prepare, patch);
  }
  if (!acquired) return; // someone else moved it; the dispatcher looks again next minute

  b.target = acquired.row;
  const held: Held = { lock: acquired.lock, inFlightStatus: 'preparing' };
  const releaseStatus: TargetStatus = original === 'prepared' ? 'prepared' : 'scheduled';
  try {
    const input = await buildInput(ctx, b, mode, LOCK.prepare);
    if (syncing) await runSync(ctx, b, held, input, publisher, original);
    else await afterPrepare(ctx, b, held, input, await publisher.prepare(input));
  } catch (err) {
    await handleStepError(
      ctx,
      {
        b,
        held,
        step: syncing ? 'update' : 'prepare',
        releaseStatus,
        queue: 'prepare-target',
        syncing,
      },
      err,
    );
  }
}

function sqlLock(key: string) {
  // Transaction-scoped advisory lock: released on commit/rollback.
  return sql`select pg_advisory_xact_lock(hashtext(${key}))`;
}

async function handleCapped(
  ctx: EngineCtx,
  b: Bundle,
  mode: PostTarget['publishMode'],
  opensAt: Date,
  cap: { used: number; limit: number },
): Promise<void> {
  const t = b.target;
  const label = platformLabel(t.platform);
  const per = t.platform === 'youtube' ? 'day' : '24 hours';
  if (opensAt > uploadDeadline(t.platform, t.scheduledAt!)) {
    return failTarget(ctx, b, null, {
      reason: 'quota',
      code: 'daily_cap',
      message: `${label} upload limit reached (${cap.limit} per ${per}); it can't be uploaded before its time. Pick a later time.`,
    });
  }
  const row = await casUpdate(ctx.deps.db, t, ctx.deps.now(), {
    publishMode: mode,
    prepareAt: opensAt,
  });
  if (row) {
    await logAttempt(ctx, t.id, t.attempts + 1, 'prepare', {
      outcome: 'retryable',
      platformCode: 'daily_cap',
      message: `${label} upload limit reached (${cap.used}/${cap.limit} per ${per}); upload moved to ${formatShort(opensAt, b.settings.timezone)}.`,
    });
  }
}

async function afterPrepare(
  ctx: EngineCtx,
  b: Bundle,
  held: Held,
  input: PublishInput,
  res: StepResult,
): Promise<void> {
  if (res.kind === 'wait') return afterWait(ctx, b, held, res, 'scheduled', 'prepare-target');
  // Persist the remote id first, whatever happened to the target meanwhile.
  await input.saveProgress({ remoteMediaId: res.remoteMediaId, remoteUrl: res.remoteUrl });
  const row = await finish(ctx.deps.db, b.target.id, held.lock, held.inFlightStatus, {
    status: 'prepared',
    publishMode: input.mode,
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    lastErrorCode: null,
    attentionReason: null,
    note: res.note ?? input.target.note,
  });
  if (!row) return handleLostLock(ctx, b.target.id, held.lock);
  await followUp(ctx, row);
}

/**
 * Pushes an owner change to an item the platform already has: publisher.update() when the
 * platform supports editing it, otherwise cancel it and prepare again from scratch.
 */
async function runSync(
  ctx: EngineCtx,
  b: Bundle,
  held: Held,
  input: PublishInput,
  publisher: PlatformPublisher,
  original: TargetStatus,
): Promise<void> {
  const updated = publisher.update ? await publisher.update(input) : false;
  if (updated) {
    if (original === 'scheduled') {
      // It was still uploading/processing: carry on with the new text.
      return afterPrepare(ctx, b, held, input, await publisher.prepare(input));
    }
    const row = await finish(ctx.deps.db, b.target.id, held.lock, held.inFlightStatus, {
      status: 'prepared',
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      lastErrorCode: null,
    });
    return row ? followUp(ctx, row) : handleLostLock(ctx, b.target.id, held.lock);
  }
  await publisher.cancel(input);
  await logAttempt(ctx, b.target.id, b.target.attempts + 1, 'cancel', {
    outcome: 'ok',
    message: 'Removed to upload again with the changes.',
  });
  const row = await finish(ctx.deps.db, b.target.id, held.lock, held.inFlightStatus, {
    ...CLEARED_REMOTE,
    status: 'scheduled',
    publishMode: null,
    prepareAt: null,
    attempts: 0,
    nextAttemptAt: null,
  });
  if (!row) {
    // The owner moved it meanwhile; the remote item is gone either way.
    await clearRemote(ctx, b.target.id, held.lock);
    return;
  }
  await enqueue(ctx, 'prepare-target', row.id);
}

/** 'wait' from the platform: come back later (bounded, so nothing polls forever). */
async function afterWait(
  ctx: EngineCtx,
  b: Bundle,
  held: Held,
  res: Extract<StepResult, { kind: 'wait' }>,
  releaseStatus: TargetStatus,
  queue: TargetQueue,
): Promise<void> {
  const now = ctx.deps.now();
  const t = b.target;
  if (t.scheduledAt && now.getTime() - t.scheduledAt.getTime() > SCHEDULING.waitLimitMs) {
    return failTarget(ctx, b, held, {
      reason: 'platform_error',
      code: 'wait_timeout',
      message: `${platformLabel(t.platform)} was still not done ${SCHEDULING.waitLimitMs / 3_600_000} hours after the post's time${res.reason ? ` (${res.reason})` : ''}.`,
    });
  }
  const delayMs = Math.max(1, res.retryInSec) * 1000;
  const row = await finish(ctx.deps.db, t.id, held.lock, held.inFlightStatus, {
    status: releaseStatus,
    nextAttemptAt: new Date(now.getTime() + delayMs),
  });
  if (!row) return handleLostLock(ctx, t.id, held.lock);
  await enqueue(ctx, queue, t.id, delayMs);
}

// ---------------------------------------------------------------------------------------------
// publish (app mode: the final call at the time; native: verify it went live)
// ---------------------------------------------------------------------------------------------

/**
 * True when an earlier publish call may have reached the platform and no reconcile has checked
 * it since. Every app-mode publish call is logged *before* it is sent, so this survives crashes.
 */
async function publishNeedsReconcile(ctx: EngineCtx, targetId: string): Promise<boolean> {
  const res = await ctx.deps.db.execute<{ pending: boolean }>(sql`
    select exists (
      select 1 from ${publishAttempts} p
      where p.target_id = ${targetId} and p.step = 'publish'
        and p.started_at >= coalesce(
          (select max(r.started_at) from ${publishAttempts} r
            where r.target_id = ${targetId} and r.step = 'reconcile' and r.outcome = 'ok'),
          '-infinity'::timestamptz)
    ) as pending`);
  return Boolean(res.rows[0]?.pending);
}

export async function publishTarget(ctx: EngineCtx, targetId: string): Promise<void> {
  if (!publishingEnabled(ctx, 'publish', targetId)) return;
  const now = ctx.deps.now();
  const b = await loadBundle(ctx, targetId);
  if (!b || b.post.deletedAt) return;
  const t = b.target;
  if (t.status !== 'prepared' || isLocked(t, now) || !t.scheduledAt) return;
  if (t.nextAttemptAt && t.nextAttemptAt > now) {
    return enqueue(ctx, 'publish-target', t.id, msUntil(t.nextAttemptAt, now));
  }
  if (t.needsSync) return enqueue(ctx, 'prepare-target', t.id); // push the edit first
  const mode = t.publishMode ?? 'app';
  const dueAt =
    mode === 'native'
      ? new Date(t.scheduledAt.getTime() + SCHEDULING.verifyDelayMs)
      : t.scheduledAt;
  if (dueAt > now) return enqueue(ctx, 'publish-target', t.id, msUntil(dueAt, now));

  const pub = getPublisher(ctx, t.platform);
  if (!pub.ok) return failTarget(ctx, b, null, { reason: 'platform_error', message: pub.message });
  if (await preconditionsFail(ctx, b, false)) return;
  if (mode === 'app' && lateDecision(t, b.settings, now) === 'missed') return markMissed(ctx, b);

  const acquired = await acquire(ctx.deps.db, t, now, LOCK.publish, {
    status: 'publishing',
    nextAttemptAt: null,
  });
  if (!acquired) return;
  b.target = acquired.row;
  const held: Held = { lock: acquired.lock, inFlightStatus: 'publishing' };
  const step = mode === 'app' ? 'publish' : 'verify';
  let attemptRowId: string | undefined;
  try {
    const input = await buildInput(ctx, b, mode, LOCK.publish);
    const publisher = pub.publisher;
    let res: StepResult;
    if (mode === 'app') {
      // Never post twice: if an earlier publish call may have gone through, ask first.
      if (await publishNeedsReconcile(ctx, t.id)) {
        const rec = await publisher.reconcile(input);
        await logReconcile(ctx, b.target, rec);
        if (rec.published) return finishPublished(ctx, b, rec);
      }
      attemptRowId = await startPublishAttempt(ctx, b.target);
      res = await publisher.publish(input);
      await endPublishAttempt(
        ctx,
        attemptRowId,
        res.kind === 'done' ? 'ok' : 'retryable',
        res.kind === 'done' ? 'Published.' : `Not ready yet${res.reason ? `: ${res.reason}` : ''}.`,
      );
    } else {
      res = await publisher.publish(input);
    }
    if (res.kind === 'done') return finishPublished(ctx, b, res);
    await afterWait(ctx, b, held, res, 'prepared', 'publish-target');
  } catch (err) {
    if (attemptRowId) {
      const c = classify(err);
      await endPublishAttempt(
        ctx,
        attemptRowId,
        c.category === 'retryable' ? 'retryable' : 'fatal',
        c.message,
      );
    }
    await handleStepError(
      ctx,
      {
        b,
        held,
        step,
        releaseStatus: 'prepared',
        queue: 'publish-target',
        logged: Boolean(attemptRowId),
        // An app-mode failure before the publish call was sent came from the reconcile check.
        logAs: mode === 'app' && !attemptRowId ? 'reconcile' : step,
      },
      err,
    );
  }
}

async function startPublishAttempt(ctx: EngineCtx, t: PostTarget): Promise<string> {
  // Not swallowed on purpose: without this row a crash could lead to a second post.
  const rows = await ctx.deps.db
    .insert(publishAttempts)
    .values({
      targetId: t.id,
      attemptNo: t.attempts + 1,
      step: 'publish',
      outcome: 'retryable',
      message: 'Publishing…',
      startedAt: ctx.deps.now(),
    })
    .returning({ id: publishAttempts.id });
  return rows[0]!.id;
}

async function endPublishAttempt(
  ctx: EngineCtx,
  id: string,
  outcome: 'ok' | 'retryable' | 'fatal',
  message: string,
): Promise<void> {
  try {
    await ctx.deps.db
      .update(publishAttempts)
      .set({ outcome, message: truncate(message, 1000), finishedAt: ctx.deps.now() })
      .where(eq(publishAttempts.id, id));
  } catch (err) {
    ctx.log.warn('could not update publish attempt', { id, err });
  }
}

async function logReconcile(ctx: EngineCtx, t: PostTarget, rec: ReconcileResult): Promise<void> {
  await logAttempt(ctx, t.id, t.attempts + 1, 'reconcile', {
    outcome: 'ok',
    message: rec.published
      ? 'Checked: already live.'
      : rec.scheduled
        ? 'Checked: scheduled on the platform.'
        : 'Checked: not live yet.',
  });
}

/** Being live is a fact: recorded whatever state the target was in meanwhile. */
async function finishPublished(
  ctx: EngineCtx,
  b: Bundle,
  res: { remoteMediaId?: string; remoteUrl?: string; note?: string },
): Promise<void> {
  const now = ctx.deps.now();
  const t = b.target;
  await ctx.deps.db
    .update(postTargets)
    .set({
      status: 'published',
      publishedAt: now,
      ...(res.remoteMediaId ? { remoteMediaId: res.remoteMediaId } : {}),
      ...(res.remoteUrl ? { remoteUrl: res.remoteUrl } : {}),
      ...(res.note ? { note: res.note } : {}),
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      lastErrorCode: null,
      attentionReason: null,
      needsSync: false,
      lockedUntil: null,
    })
    .where(eq(postTargets.id, t.id));
  ctx.log.info('published', { targetId: t.id, platform: t.platform, note: res.note });
}

// ---------------------------------------------------------------------------------------------
// reconcile (check the platform before retrying, and after a crash mid-publish)
// ---------------------------------------------------------------------------------------------

export async function reconcileTarget(ctx: EngineCtx, targetId: string): Promise<void> {
  if (!publishingEnabled(ctx, 'reconcile', targetId)) return;
  const now = ctx.deps.now();
  const b = await loadBundle(ctx, targetId);
  if (!b) return;
  const t = b.target;
  if (['draft', 'canceled', 'published', 'preparing'].includes(t.status) || isLocked(t, now))
    return;

  if (!hasRemote(t)) {
    // Nothing reached the platform: just let the normal flow continue.
    if (t.status === 'publishing') {
      await casUpdate(ctx.deps.db, t, now, {
        status: 'scheduled',
        publishMode: null,
        prepareAt: null,
      });
    } else if (t.status === 'scheduled' && t.nextAttemptAt) {
      await casUpdate(ctx.deps.db, t, now, { nextAttemptAt: null });
    }
    return;
  }
  if (t.nextAttemptAt && t.nextAttemptAt > now && t.status === 'publishing') {
    return enqueue(ctx, 'reconcile-target', t.id, msUntil(t.nextAttemptAt, now));
  }
  const pub = getPublisher(ctx, t.platform);
  if (!pub.ok) return failTarget(ctx, b, null, { reason: 'platform_error', message: pub.message });
  if (await preconditionsFail(ctx, b, false)) return;

  const acquired = await acquire(ctx.deps.db, t, now, LOCK.reconcile, {});
  if (!acquired) return;
  b.target = acquired.row;
  const held: Held = { lock: acquired.lock, inFlightStatus: t.status };
  try {
    const input = await buildInput(ctx, b, t.publishMode ?? 'app', LOCK.reconcile);
    const rec = await pub.publisher.reconcile(input);
    await logReconcile(ctx, b.target, rec);
    if (rec.published) return finishPublished(ctx, b, rec);
    const common: TargetPatch = {
      nextAttemptAt: null,
      attempts: 0,
      attentionReason: null,
      lastError: null,
      lastErrorCode: null,
      ...(rec.remoteMediaId ? { remoteMediaId: rec.remoteMediaId } : {}),
      ...(rec.remoteUrl ? { remoteUrl: rec.remoteUrl } : {}),
    };
    const patch: TargetPatch = rec.scheduled
      ? { ...common, status: 'prepared', publishMode: 'native' }
      : // Not live: a crashed publish goes back to 'prepared' (publish again, already checked);
        // anything else resumes preparing with the remote progress it has.
        { ...common, status: t.status === 'publishing' ? 'prepared' : 'scheduled' };
    const row = await finish(ctx.deps.db, t.id, held.lock, held.inFlightStatus, patch);
    if (!row) return handleLostLock(ctx, t.id, held.lock);
    if (row.status === 'prepared') await followUp(ctx, row);
    else await enqueue(ctx, 'prepare-target', row.id);
  } catch (err) {
    await handleStepError(
      ctx,
      { b, held, step: 'reconcile', releaseStatus: t.status, queue: 'reconcile-target' },
      err,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// cancel (unschedule / remove the platform's copy)
// ---------------------------------------------------------------------------------------------

export async function cancelTarget(ctx: EngineCtx, targetId: string): Promise<void> {
  if (!publishingEnabled(ctx, 'cancel', targetId)) return;
  const now = ctx.deps.now();
  const b = await loadBundle(ctx, targetId);
  if (!b) return;
  const t = b.target;
  if (!hasRemote(t)) {
    if (b.post.deletedAt) await finalizeDeletedPost(ctx, b.post.id);
    return;
  }
  // Only drafts and deleted posts lose their remote item; a target that is wanted again is
  // moved by the sync flow instead. Published posts are never removed.
  if (t.status !== 'draft' && t.status !== 'canceled') return;
  if (isLocked(t, now)) {
    return enqueue(ctx, 'cancel-target', t.id, msUntil(t.lockedUntil!, now) + 1000);
  }
  if (t.nextAttemptAt && t.nextAttemptAt > now) {
    return enqueue(ctx, 'cancel-target', t.id, msUntil(t.nextAttemptAt, now));
  }
  const pub = getPublisher(ctx, t.platform);
  if (!pub.ok) return giveUpCancel(ctx, b, null, pub.message);
  if (!b.account || b.account.status === 'disabled') {
    return giveUpCancel(ctx, b, null, `${platformLabel(t.platform)} is no longer connected`);
  }
  if (b.account.status === 'needs_reauth') {
    // Try again once the owner reconnects (the watchdog re-queues it).
    await casUpdate(ctx.deps.db, t, now, { nextAttemptAt: new Date(now.getTime() + 3_600_000) });
    return flagAccount(ctx, b.account, b.account.lastError ?? 'login expired');
  }

  const acquired = await acquire(ctx.deps.db, t, now, LOCK.cancel, {});
  if (!acquired) return;
  b.target = acquired.row;
  const held: Held = { lock: acquired.lock, inFlightStatus: t.status };
  try {
    const input = await buildInput(ctx, b, t.publishMode ?? 'app', LOCK.cancel);
    await pub.publisher.cancel(input);
    await logAttempt(ctx, t.id, t.attempts + 1, 'cancel', {
      outcome: 'ok',
      message: `Removed from ${platformLabel(t.platform)}.`,
    });
    await clearRemote(ctx, t.id, held.lock);
    if (b.post.deletedAt) await finalizeDeletedPost(ctx, b.post.id);
  } catch (err) {
    await handleStepError(
      ctx,
      { b, held, step: 'cancel', releaseStatus: t.status, queue: 'cancel-target' },
      err,
    );
  }
}

/** The remote item is gone: forget it (whatever status the owner set meanwhile). */
async function clearRemote(ctx: EngineCtx, targetId: string, lock: Date | null): Promise<void> {
  await ctx.deps.db
    .update(postTargets)
    .set({
      ...CLEARED_REMOTE,
      publishMode: null,
      prepareAt: null,
      needsSync: false,
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      lastErrorCode: null,
      lockedUntil: null,
    })
    .where(
      lock
        ? and(eq(postTargets.id, targetId), eq(postTargets.lockedUntil, lock))
        : eq(postTargets.id, targetId),
    );
}

/** Removing it failed for good: tell the owner to remove it by hand, then let go of it. */
async function giveUpCancel(
  ctx: EngineCtx,
  b: Bundle,
  lock: Date | null,
  reason: string,
): Promise<void> {
  const t = b.target;
  const label = platformLabel(t.platform);
  await alert(ctx, {
    kind: 'publish_failed',
    targetId: t.id,
    message: `${label}: couldn't remove '${postName(t, b.asset)}' (${truncate(reason, 200)}). If it is still scheduled there, delete it in ${label}.`,
    dedupeKey: `cancel_failed:${t.id}:${t.remoteMediaId ?? t.remoteContainerId ?? t.remoteUploadUri ?? ''}`,
  });
  await clearRemote(ctx, t.id, lock);
  if (b.post.deletedAt) await finalizeDeletedPost(ctx, b.post.id);
}

/**
 * Deleted post: once nothing remote is pending (no lock, nothing in flight, no unpublished
 * remote item), delete its media files and the asset row (cascades post, targets, history).
 */
export async function finalizeDeletedPost(ctx: EngineCtx, postId: string): Promise<boolean> {
  const { db } = ctx.deps;
  const now = ctx.deps.now();
  const rows = await db
    .select({ target: postTargets, assetId: posts.assetId, deletedAt: posts.deletedAt })
    .from(posts)
    .leftJoin(postTargets, eq(postTargets.postId, posts.id))
    .where(eq(posts.id, postId));
  const first = rows[0];
  if (!first || !first.deletedAt) return false;
  const pending = rows.some(
    ({ target: t }) =>
      t !== null &&
      (isLocked(t, now) ||
        IN_FLIGHT_STATUSES.includes(t.status) ||
        (t.status !== 'published' && hasRemote(t))),
  );
  if (pending) return false;
  for (const prefix of keys.assetPrefixes(first.assetId))
    await ctx.deps.storage.deletePrefix(prefix);
  await db.delete(mediaAssets).where(eq(mediaAssets.id, first.assetId));
  ctx.log.info('deleted post removed', { postId, assetId: first.assetId });
  return true;
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

interface StepRun {
  b: Bundle;
  held: Held;
  step: 'prepare' | 'update' | 'publish' | 'verify' | 'reconcile' | 'cancel';
  /** Status to go back to when the step will be retried. */
  releaseStatus: TargetStatus;
  queue: TargetQueue;
  /** The step was pushing an owner change: keep needs_sync so it is pushed again. */
  syncing?: boolean;
  /** The step already wrote its History row. */
  logged?: boolean;
  /** History step name when it differs from `step` (e.g. the check before a publish failed). */
  logAs?: PublishAttempt['step'];
}

/**
 * By PlatformError category: retryable → back off (6 tries, then failed 'platform_error');
 * auth → account and its pending posts need_reauth; quota → wait for the window; invalid →
 * failed 'invalid_text'/'invalid_video'; fatal → failed 'platform_error'.
 */
export async function handleStepError(ctx: EngineCtx, run: StepRun, err: unknown): Promise<void> {
  const e = classify(err);
  const t = run.b.target;
  ctx.log.warn('platform step failed', {
    targetId: t.id,
    platform: t.platform,
    step: run.step,
    category: e.category,
    code: e.code,
    httpStatus: e.httpStatus,
    message: e.message,
  });
  if (!run.logged) {
    await logAttempt(ctx, t.id, t.attempts + 1, run.logAs ?? run.step, {
      outcome: e.category === 'retryable' || e.category === 'quota' ? 'retryable' : 'fatal',
      httpStatus: e.httpStatus,
      platformCode: e.code,
      message: e.message,
    });
  }
  if (run.step === 'cancel') return handleCancelError(ctx, run, e);
  const keep: TargetPatch = run.syncing ? { needsSync: true } : {};

  switch (e.category) {
    case 'retryable':
      return retryLater(ctx, run, e, keep);
    case 'auth':
      return markNeedsReauth(ctx, run.b, run.held, e.message, keep);
    case 'quota':
      return quotaLater(ctx, run, e, keep);
    case 'invalid':
      return failTarget(ctx, run.b, run.held, {
        reason: invalidReason(e),
        message: e.message,
        code: e.code,
        extra: keep,
      });
    case 'fatal':
    default:
      return failTarget(ctx, run.b, run.held, {
        reason: 'platform_error',
        message: e.message,
        code: e.code,
        extra: keep,
      });
  }
}

async function retryLater(
  ctx: EngineCtx,
  run: StepRun,
  e: Classified,
  keep: TargetPatch,
): Promise<void> {
  const t = run.b.target;
  const attempts = t.attempts + 1;
  if (attempts >= SCHEDULING.maxAttempts) {
    return failTarget(ctx, run.b, run.held, {
      reason: 'platform_error',
      message: `${e.message} (gave up after ${attempts} tries)`,
      code: e.code,
      extra: { ...keep, attempts },
    });
  }
  const now = ctx.deps.now();
  const delayMs = backoffSec(attempts, e.retryAfterSec) * 1000;
  const row = await finish(ctx.deps.db, t.id, run.held.lock, run.held.inFlightStatus, {
    ...keep,
    status: run.releaseStatus,
    attempts,
    nextAttemptAt: new Date(now.getTime() + delayMs),
    lastError: truncate(e.message),
    lastErrorCode: e.code ?? null,
  });
  if (!row) return handleLostLock(ctx, t.id, run.held.lock);
  await enqueue(ctx, run.queue, t.id, delayMs);
}

async function quotaLater(
  ctx: EngineCtx,
  run: StepRun,
  e: Classified,
  keep: TargetPatch,
): Promise<void> {
  const t = run.b.target;
  const now = ctx.deps.now();
  const until = new Date(
    now.getTime() + (e.retryAfterSec ?? SCHEDULING.defaultQuotaRetrySec) * 1000,
  );
  const label = platformLabel(t.platform);
  const scheduledAt = t.scheduledAt ?? now;
  const preparing = run.step === 'prepare' || run.step === 'update';

  if (preparing && t.platform === 'youtube') await pauseUploads(ctx, 'youtube', until);
  const tooLate = preparing
    ? until > uploadDeadline(t.platform, scheduledAt) && !hasRemote(t)
    : run.step === 'publish' &&
      until.getTime() > scheduledAt.getTime() + run.b.settings.lateGraceMinutes * 60_000;
  if (tooLate) {
    return failTarget(ctx, run.b, run.held, {
      reason: 'quota',
      message: `${label} limit reached: ${e.message}`,
      code: e.code,
      extra: keep,
    });
  }
  const row = await finish(ctx.deps.db, t.id, run.held.lock, run.held.inFlightStatus, {
    ...keep,
    status: run.releaseStatus,
    nextAttemptAt: until,
    ...(preparing && run.releaseStatus === 'scheduled' ? { prepareAt: until } : {}),
    lastError: truncate(`${label} limit reached: ${e.message}`),
    lastErrorCode: e.code ?? null,
  });
  if (!row) return handleLostLock(ctx, t.id, run.held.lock);
  await alert(ctx, {
    kind: 'quota',
    message: `${label} limit reached; posting continues after ${formatShort(until, run.b.settings.timezone)}.`,
    dedupeKey: `quota:${t.platform}:${until.toISOString().slice(0, 13)}`,
  });
}

/**
 * YouTube's uploadLimitExceeded pauses every YouTube upload for the window (PLAN.md §5.6), not
 * just the one that hit it.
 */
async function pauseUploads(ctx: EngineCtx, platform: 'youtube', until: Date): Promise<void> {
  await ctx.deps.db.execute(sql`
    update ${postTargets} set prepare_at = ${until}
    where platform = ${platform} and status = 'scheduled'
      and remote_container_id is null and remote_upload_uri is null and remote_media_id is null
      and (prepare_at is null or prepare_at < ${until})`);
}

async function handleCancelError(ctx: EngineCtx, run: StepRun, e: Classified): Promise<void> {
  const t = run.b.target;
  const now = ctx.deps.now();
  const later = async (delayMs: number, extra: TargetPatch = {}) => {
    const row = await finish(ctx.deps.db, t.id, run.held.lock, run.held.inFlightStatus, {
      ...extra,
      nextAttemptAt: new Date(now.getTime() + delayMs),
      lastError: truncate(e.message),
      lastErrorCode: e.code ?? null,
    });
    if (!row) return handleLostLock(ctx, t.id, run.held.lock);
    await enqueue(ctx, 'cancel-target', t.id, delayMs);
  };
  switch (e.category) {
    case 'retryable': {
      const attempts = t.attempts + 1;
      if (attempts >= SCHEDULING.maxAttempts)
        return giveUpCancel(ctx, run.b, run.held.lock, e.message);
      return later(backoffSec(attempts, e.retryAfterSec) * 1000, { attempts });
    }
    case 'quota':
      return later((e.retryAfterSec ?? SCHEDULING.defaultQuotaRetrySec) * 1000);
    case 'auth':
      if (run.b.account) await flagAccount(ctx, run.b.account, e.message);
      return later(3_600_000);
    default:
      return giveUpCancel(ctx, run.b, run.held.lock, e.message);
  }
}
