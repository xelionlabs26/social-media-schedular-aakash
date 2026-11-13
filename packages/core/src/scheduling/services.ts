/**
 * Scheduling services called by the web app (server actions). They only change the database and
 * queue jobs; every platform call happens in the worker (engine). Rows are locked with
 * SELECT … FOR UPDATE inside a transaction, so a concurrent engine step either waits for the
 * owner's change or sees it.
 *
 * Rule for targets already handed to a platform (status preparing/prepared, or remote ids that
 * are not published): a text/time/options change sets needs_sync and the engine pushes it;
 * unscheduling queues 'cancel-target'. Published targets never change.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  mediaAssets,
  postTargets,
  posts,
  socialAccounts,
  type AppSettings,
  type Db,
  type MediaAsset,
  type Platform,
  type Post,
  type PostTarget,
  type SocialAccount,
  type TargetOptions,
  type TargetTextSources,
} from '@app/db';
import type { ServiceDeps } from '../deps';
import { targetJobOptions } from '../jobs';
import { PLATFORM_ORDER, RULES } from '../platforms/rules';
import { getSettings } from '../settings';
import { normalizeHashtags, validateTargetText, type TextIssue } from '../text';
import { formatShort } from '../time';
import { SCHEDULING } from './config';
import { SchedulingError } from './errors';
import { describeYoutubeSpread, planYoutubeUploads, rollingWindowWarnings } from './limits';
import { hasRemote, isHandedOver, platformLabel } from './model';
import { SlotFinder } from './slots';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface ScheduleRequest {
  postIds: string[];
  /** next_free: fill posting slots; pick: exact time(s); draft: keep as drafts (optionally dated). */
  mode: 'next_free' | 'pick' | 'draft';
  /** next_free: local date (YYYY-MM-DD, app timezone) to start from. Default: today. */
  startDate?: string;
  /** pick: one time for all given posts. */
  at?: Date;
  /** pick: per-platform override ("Different time per app"). */
  perPlatformAt?: Partial<Record<Platform, Date>>;
}

export interface ScheduleResult {
  scheduled: Array<{ postId: string; at: Date }>;
  skipped: Array<{ postId: string; reason: string }>;
  /** Human-readable warnings (e.g. "YouTube uploads spread over 2 days"). */
  warnings: string[];
}

/** A time the owner picks may be at most this far in the past ("now" from a slow form). */
const PAST_TOLERANCE_MS = 60_000;

const version = sql`${postTargets.version} + 1`;
const postVersion = sql`${posts.version} + 1`;

// ---------------------------------------------------------------------------------------------
// Small shared steps
// ---------------------------------------------------------------------------------------------

async function sendDispatchNow(deps: ServiceDeps): Promise<void> {
  try {
    await deps.jobs.send('dispatch', {}, { singletonKey: 'dispatch-now' });
  } catch (err) {
    // The every-minute cron picks the change up anyway.
    deps.log.warn('could not queue an immediate dispatch', { err });
  }
}

async function sendCancels(deps: ServiceDeps, targetIds: string[]): Promise<void> {
  for (const targetId of targetIds) {
    try {
      await deps.jobs.send('cancel-target', { targetId }, targetJobOptions(targetId));
    } catch (err) {
      // The watchdog re-queues cancels for drafts that still have remote items.
      deps.log.warn('could not queue cancel-target', { targetId, err });
    }
  }
}

function assertFutureTime(at: Date, now: Date): void {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new SchedulingError('invalid', 'Pick a valid date and time.');
  }
  if (at.getTime() < now.getTime() - PAST_TOLERANCE_MS) {
    throw new SchedulingError(
      'invalid',
      'That time has already passed. Pick a time in the future.',
    );
  }
}

async function lockPost(
  tx: Tx,
  postId: string,
): Promise<{ post: Post; asset: MediaAsset } | undefined> {
  const rows = await tx
    .select({ post: posts, asset: mediaAssets })
    .from(posts)
    .innerJoin(mediaAssets, eq(mediaAssets.id, posts.assetId))
    .where(eq(posts.id, postId))
    .for('update', { of: posts });
  return rows[0];
}

async function lockTargets(tx: Tx, postId: string): Promise<PostTarget[]> {
  const rows = await tx
    .select()
    .from(postTargets)
    .where(eq(postTargets.postId, postId))
    .orderBy(asc(postTargets.id))
    .for('update');
  return rows.sort(
    (a, b) => PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform),
  );
}

async function lockTarget(tx: Tx, targetId: string): Promise<PostTarget | undefined> {
  const rows = await tx
    .select()
    .from(postTargets)
    .where(eq(postTargets.id, targetId))
    .for('update');
  return rows[0];
}

/**
 * The account a target publishes with: its own if still usable, otherwise the platform's active
 * account (the owner may have connected the platform after uploading the video).
 */
function resolveAccount(t: PostTarget, accounts: SocialAccount[]): SocialAccount | undefined {
  const own = t.socialAccountId ? accounts.find((a) => a.id === t.socialAccountId) : undefined;
  if (own?.status === 'active') return own;
  return accounts.find((a) => a.platform === t.platform && a.status === 'active') ?? own;
}

/** Why a target can't be scheduled right now (null = it can). */
function blockingReason(
  t: PostTarget,
  asset: MediaAsset,
  account: SocialAccount | undefined,
): string | null {
  const label = platformLabel(t.platform);
  if (!account || account.status === 'disabled') return `${label} is not connected`;
  if (account.status !== 'active') return `${label} needs reconnecting`;
  const issue = validateTargetText(t.platform, t, { fbKind: t.options.fbKind }).find(
    (i) => i.severity === 'block',
  );
  if (issue) return `${label}: ${issue.message}`;
  const videoBlock = asset.warnings.find(
    (w) => w.severity === 'block' && (!w.platform || w.platform === t.platform),
  );
  if (videoBlock) return `${label}: ${videoBlock.message}`;
  return null;
}

/**
 * Fields that (re)arm a target for publishing at `at`. A target already handed to the platform
 * keeps its remote item and gets needs_sync, so the engine moves it instead of uploading twice.
 */
function armPatch(t: PostTarget, at: Date, accountId: string) {
  const base = {
    scheduledAt: at,
    socialAccountId: accountId,
    attentionReason: null,
    lastError: null,
    lastErrorCode: null,
    attempts: 0,
    nextAttemptAt: null,
    version,
  };
  if (t.status === 'preparing' || t.status === 'prepared') return { ...base, needsSync: true };
  if (hasRemote(t)) {
    return { ...base, status: 'scheduled' as const, needsSync: true, prepareAt: null };
  }
  return {
    ...base,
    status: 'scheduled' as const,
    publishMode: null,
    prepareAt: null,
    needsSync: false,
  };
}

/** Fields that pause a target (draft); its remote item, if any, is removed by cancel-target. */
const pausePatch = {
  status: 'draft' as const,
  publishMode: null,
  prepareAt: null,
  needsSync: false,
  attempts: 0,
  nextAttemptAt: null,
  attentionReason: null,
  lastError: null,
  lastErrorCode: null,
  version,
};

async function recomputePostTime(tx: Tx, postId: string): Promise<void> {
  await tx
    .update(posts)
    .set({
      scheduledAt: sql`(select min(${postTargets.scheduledAt}) from ${postTargets} where ${postTargets.postId} = ${postId} and ${postTargets.status} <> 'canceled')`,
      version: postVersion,
    })
    .where(eq(posts.id, postId));
}

// ---------------------------------------------------------------------------------------------
// Next free slot
// ---------------------------------------------------------------------------------------------

/** Next free posting-slot instants (UTC) starting at a local date, honoring min gap & existing posts. */
export async function nextFreeSlots(
  deps: ServiceDeps,
  input: { count: number; startDate?: string; platforms?: Platform[] },
): Promise<Date[]> {
  const settings = await getSettings(deps.db);
  const finder = await SlotFinder.load(deps.db, settings, {
    now: deps.now(),
    startDate: input.startDate,
  });
  const platforms = input.platforms?.length ? input.platforms : [...PLATFORM_ORDER];
  const n = Math.max(0, Math.min(Math.floor(input.count), 500));
  return finder.peek(n, platforms);
}

// ---------------------------------------------------------------------------------------------
// Schedule (the owner's consent click)
// ---------------------------------------------------------------------------------------------

interface PostOutcome {
  scheduled?: { postId: string; at: Date };
  skipped?: { postId: string; reason: string };
  warnings: string[];
  cancels: string[];
  newTimes: Array<{ targetId: string; platform: Platform; at: Date; postId: string }>;
}

interface ScheduleCtx {
  deps: ServiceDeps;
  req: ScheduleRequest;
  now: Date;
  settings: AppSettings;
  accounts: SocialAccount[];
  finder?: SlotFinder;
}

/** The owner's explicit "Schedule" click: sets times, approves, validates, queues preparation. */
export async function schedulePosts(
  deps: ServiceDeps,
  req: ScheduleRequest,
): Promise<ScheduleResult> {
  const now = deps.now();
  const result: ScheduleResult = { scheduled: [], skipped: [], warnings: [] };
  if (req.mode === 'pick') {
    if (!req.at && !Object.values(req.perPlatformAt ?? {}).some(Boolean)) {
      throw new SchedulingError('invalid', 'Pick a date and time.');
    }
    if (req.at && Number.isNaN(new Date(req.at).getTime())) {
      throw new SchedulingError('invalid', 'Pick a valid date and time.');
    }
  }
  const ids = [...new Set(req.postIds)];
  if (ids.length === 0) return result;

  const settings = await getSettings(deps.db);
  // Bulk scheduling fills slots in the order of the cards (asset sort index).
  const ordered = await deps.db
    .select({ id: posts.id })
    .from(posts)
    .innerJoin(mediaAssets, eq(mediaAssets.id, posts.assetId))
    .where(inArray(posts.id, ids))
    .orderBy(asc(mediaAssets.sortIndex), asc(mediaAssets.createdAt), asc(posts.id));
  const found = new Set(ordered.map((r) => r.id));
  for (const id of ids) {
    if (!found.has(id)) result.skipped.push({ postId: id, reason: 'Post not found.' });
  }

  const ctx: ScheduleCtx = {
    deps,
    req,
    now,
    settings,
    accounts: await deps.db.select().from(socialAccounts),
    finder:
      req.mode === 'next_free'
        ? await SlotFinder.load(deps.db, settings, {
            now,
            startDate: req.startDate,
            excludePostIds: ids,
          })
        : undefined,
  };

  const cancels: string[] = [];
  const newTimes: PostOutcome['newTimes'] = [];
  for (const { id } of ordered) {
    const outcome = await deps.db.transaction((tx) => scheduleOne(tx, ctx, id));
    if (outcome.scheduled) result.scheduled.push(outcome.scheduled);
    if (outcome.skipped) result.skipped.push(outcome.skipped);
    result.warnings.push(...outcome.warnings);
    cancels.push(...outcome.cancels);
    newTimes.push(...outcome.newTimes);
  }

  if (newTimes.length) {
    result.warnings.push(...(await limitWarnings(ctx, newTimes)));
  }
  await sendCancels(deps, cancels);
  if (result.scheduled.length || cancels.length) await sendDispatchNow(deps);
  return result;
}

async function scheduleOne(tx: Tx, ctx: ScheduleCtx, postId: string): Promise<PostOutcome> {
  const out: PostOutcome = { warnings: [], cancels: [], newTimes: [] };
  const skip = (reason: string) => ({ ...out, skipped: { postId, reason } });
  const locked = await lockPost(tx, postId);
  if (!locked) return skip('Post not found.');
  const { post, asset } = locked;
  if (post.deletedAt) return skip('Post was deleted.');
  if (asset.status !== 'ready') {
    return skip(
      asset.status === 'failed'
        ? 'The video could not be processed.'
        : 'The video is still processing.',
    );
  }
  const targets = (await lockTargets(tx, postId)).filter((t) => t.status !== 'canceled');
  if (targets.length === 0) return skip('No platforms selected.');

  if (ctx.req.mode === 'draft') return saveAsDraft(tx, ctx, post, targets, out);

  const eligible: Array<{ target: PostTarget; accountId: string }> = [];
  const reasons: string[] = [];
  for (const t of targets) {
    if (t.status === 'published') continue;
    if (t.status === 'publishing') {
      out.warnings.push(
        `${asset.filename} · ${platformLabel(t.platform)}: being published right now, not changed.`,
      );
      continue;
    }
    const account = resolveAccount(t, ctx.accounts);
    const reason = blockingReason(t, asset, account);
    if (reason) {
      reasons.push(reason);
      out.warnings.push(`${asset.filename} · ${reason}. Left as a draft.`);
      continue;
    }
    eligible.push({ target: t, accountId: account!.id });
  }
  if (eligible.length === 0) {
    return skip(reasons.join('; ') || 'Already published on every selected platform.');
  }

  // Times per target.
  const times = new Map<string, Date>();
  if (ctx.req.mode === 'next_free') {
    const slot = ctx.finder!.take(eligible.map((e) => e.target.platform));
    if (!slot) {
      out.warnings.push(
        `${asset.filename}: no free posting slot in the next 12 months. Add a posting time in Settings.`,
      );
      return skip('No free posting slot.');
    }
    for (const e of eligible) times.set(e.target.id, slot);
  } else {
    for (const e of [...eligible]) {
      const raw = ctx.req.perPlatformAt?.[e.target.platform] ?? ctx.req.at;
      const at = raw ? new Date(raw) : undefined;
      const label = platformLabel(e.target.platform);
      if (!at || Number.isNaN(at.getTime())) {
        out.warnings.push(`${asset.filename} · ${label}: no time chosen. Left as a draft.`);
        eligible.splice(eligible.indexOf(e), 1);
      } else if (at.getTime() < ctx.now.getTime() - PAST_TOLERANCE_MS) {
        out.warnings.push(
          `${asset.filename} · ${label}: that time has already passed. Left as a draft.`,
        );
        eligible.splice(eligible.indexOf(e), 1);
      } else {
        times.set(e.target.id, at < ctx.now ? ctx.now : at);
      }
    }
    if (eligible.length === 0) return skip('No valid time chosen.');
  }

  for (const { target, accountId } of eligible) {
    const at = times.get(target.id)!;
    await tx
      .update(postTargets)
      .set(armPatch(target, at, accountId))
      .where(eq(postTargets.id, target.id));
    out.newTimes.push({ targetId: target.id, platform: target.platform, at, postId });
  }
  const common = new Date(Math.min(...[...times.values()].map((d) => d.getTime())));
  await tx
    .update(posts)
    .set({ scheduledAt: common, approvedAt: ctx.now, version: postVersion })
    .where(eq(posts.id, postId));
  return { ...out, scheduled: { postId, at: common } };
}

/** "Save as draft": keeps (or sets) the date; anything scheduled is paused. */
async function saveAsDraft(
  tx: Tx,
  ctx: ScheduleCtx,
  post: Post,
  targets: PostTarget[],
  out: PostOutcome,
): Promise<PostOutcome> {
  for (const t of targets) {
    if (t.status === 'published' || t.status === 'publishing') continue;
    const at = ctx.req.perPlatformAt?.[t.platform] ?? ctx.req.at ?? t.scheduledAt;
    const pause = ['scheduled', 'preparing', 'prepared'].includes(t.status);
    await tx
      .update(postTargets)
      .set(pause ? { ...pausePatch, scheduledAt: at } : { scheduledAt: at, version })
      .where(eq(postTargets.id, t.id));
    if (pause && isHandedOver(t)) out.cancels.push(t.id);
  }
  await tx
    .update(posts)
    .set({ approvedAt: null, version: postVersion })
    .where(eq(posts.id, post.id));
  await recomputePostTime(tx, post.id);
  return out;
}

/** Rolling-window and YouTube upload-queue warnings; YouTube posts that can't make it fail now. */
async function limitWarnings(
  ctx: ScheduleCtx,
  newTimes: PostOutcome['newTimes'],
): Promise<string[]> {
  const { deps, settings, now } = ctx;
  const tz = settings.timezone;
  const warnings = await rollingWindowWarnings(deps.db, newTimes, tz);
  if (newTimes.some((n) => n.platform === 'youtube')) {
    const plan = await planYoutubeUploads(deps.db, now);
    const spread = describeYoutubeSpread(plan, tz);
    if (spread) warnings.push(spread);
    // PLAN.md §5.6: a queued upload that can't happen before its publish time turns the card
    // "Needs attention" when you click Schedule, not on the day.
    const mine = newTimes.filter(
      (n) => n.platform === 'youtube' && plan.impossible.includes(n.targetId),
    );
    for (const n of mine) {
      await deps.db
        .update(postTargets)
        .set({
          status: 'failed',
          attentionReason: 'quota',
          lastError:
            'YouTube daily upload limit: it cannot be uploaded before its time. Pick a later time.',
        })
        .where(and(eq(postTargets.id, n.targetId), eq(postTargets.status, 'scheduled')));
      warnings.push(
        `YouTube: the post at ${formatShort(n.at, tz)} can't be uploaded in time (at most ${RULES.youtube.uploadsPerDaySafe} uploads per day). Pick a later time.`,
      );
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------------------------
// Reschedule / drafts / delete
// ---------------------------------------------------------------------------------------------

/** Drag on the calendar / edit time. platform = only that target ("Different time per app"). */
export async function reschedulePost(
  deps: ServiceDeps,
  input: { postId: string; at: Date; platform?: Platform },
): Promise<void> {
  const now = deps.now();
  const at = new Date(input.at);
  assertFutureTime(at, now);
  const when = at < now ? now : at;
  const accounts = await deps.db.select().from(socialAccounts);

  await deps.db.transaction(async (tx) => {
    const locked = await lockPost(tx, input.postId);
    if (!locked || locked.post.deletedAt) throw new SchedulingError('not_found', 'Post not found.');
    const { post, asset } = locked;
    const all = await lockTargets(tx, input.postId);
    const targets = all.filter(
      (t) => t.status !== 'canceled' && (!input.platform || t.platform === input.platform),
    );
    if (input.platform && targets.length === 0) {
      throw new SchedulingError(
        'not_found',
        `This post has no ${platformLabel(input.platform)} version.`,
      );
    }
    for (const t of targets) {
      if (t.status === 'published') continue;
      if (t.status === 'publishing') {
        if (input.platform) {
          throw new SchedulingError(
            'locked',
            `${platformLabel(t.platform)} is publishing this post right now.`,
          );
        }
        continue;
      }
      await tx
        .update(postTargets)
        .set(reschedulePatch(t, when, post, asset, accounts))
        .where(eq(postTargets.id, t.id));
    }
    if (input.platform) await recomputePostTime(tx, post.id);
    else
      await tx
        .update(posts)
        .set({ scheduledAt: when, version: postVersion })
        .where(eq(posts.id, post.id));
  });
  await sendDispatchNow(deps);
}

function reschedulePatch(
  t: PostTarget,
  at: Date,
  post: Post,
  asset: MediaAsset,
  accounts: SocialAccount[],
) {
  switch (t.status) {
    case 'draft':
    case 'needs_reauth': // resumes by itself once the account is reconnected
      return { scheduledAt: at, version };
    case 'failed':
    case 'missed': {
      // Moving a failed post to a new time re-arms it when it was approved and is valid now.
      const account = resolveAccount(t, accounts);
      if (post.approvedAt && !blockingReason(t, asset, account))
        return armPatch(t, at, account!.id);
      return { scheduledAt: at, version };
    }
    case 'scheduled':
      if (!hasRemote(t)) return { scheduledAt: at, publishMode: null, prepareAt: null, version };
      return { scheduledAt: at, needsSync: true, version };
    default: // preparing / prepared: the engine moves the platform's copy
      return { scheduledAt: at, needsSync: true, version };
  }
}

/** "Move to drafts": unschedules (cancels anything already handed to a platform). */
export async function moveToDrafts(deps: ServiceDeps, input: { postId: string }): Promise<void> {
  const cancels: string[] = [];
  await deps.db.transaction(async (tx) => {
    const locked = await lockPost(tx, input.postId);
    if (!locked || locked.post.deletedAt) throw new SchedulingError('not_found', 'Post not found.');
    for (const t of await lockTargets(tx, input.postId)) {
      // A target being published right now finishes; published ones never change.
      if (['published', 'publishing', 'canceled'].includes(t.status)) continue;
      await tx.update(postTargets).set(pausePatch).where(eq(postTargets.id, t.id));
      if (isHandedOver(t)) cancels.push(t.id);
    }
    await tx
      .update(posts)
      .set({ approvedAt: null, version: postVersion })
      .where(eq(posts.id, input.postId));
  });
  await sendCancels(deps, cancels);
}

/** Deletes the post (cancels remote scheduled items first) and its media. */
export async function deletePost(deps: ServiceDeps, input: { postId: string }): Promise<void> {
  const cancels: string[] = [];
  const now = deps.now();
  await deps.db.transaction(async (tx) => {
    const locked = await lockPost(tx, input.postId);
    if (!locked) throw new SchedulingError('not_found', 'Post not found.');
    if (locked.post.deletedAt) return; // already deleted: nothing to do
    for (const t of await lockTargets(tx, input.postId)) {
      if (['published', 'publishing', 'canceled'].includes(t.status)) continue;
      await tx
        .update(postTargets)
        .set({ ...pausePatch, status: 'canceled' })
        .where(eq(postTargets.id, t.id));
      if (isHandedOver(t)) cancels.push(t.id);
    }
    await tx
      .update(posts)
      .set({ deletedAt: now, approvedAt: null, version: postVersion })
      .where(eq(posts.id, input.postId));
  });
  await sendCancels(deps, cancels);
  // The engine removes the post and its media once nothing remote is pending.
  await sendDispatchNow(deps);
}

// ---------------------------------------------------------------------------------------------
// Needs-attention fixes
// ---------------------------------------------------------------------------------------------

/** Needs-attention fixes: retry now (checks the platform first) or move to the next free slot. */
export async function retryTarget(
  deps: ServiceDeps,
  input: { targetId: string; mode: 'now' | 'next_free' },
): Promise<void> {
  const now = deps.now();
  const accounts = await deps.db.select().from(socialAccounts);
  let reconcile = false;

  // The free slot is looked up before the transaction (read-only; a race only skips a slot).
  let slot: Date | null = null;
  if (input.mode === 'next_free') {
    const [row] = await deps.db
      .select({ platform: postTargets.platform })
      .from(postTargets)
      .where(eq(postTargets.id, input.targetId));
    if (!row) throw new SchedulingError('not_found', 'Post not found.');
    const settings = await getSettings(deps.db);
    slot = (await SlotFinder.load(deps.db, settings, { now })).take([row.platform]);
    if (!slot) {
      throw new SchedulingError(
        'invalid',
        'No free posting slot in the next 12 months. Add a posting time in Settings.',
      );
    }
  }

  await deps.db.transaction(async (tx) => {
    // Same lock order as the other services (post, then targets) so they can't deadlock.
    const [ref] = await tx
      .select({ postId: postTargets.postId })
      .from(postTargets)
      .where(eq(postTargets.id, input.targetId));
    if (!ref) throw new SchedulingError('not_found', 'Post not found.');
    const locked = await lockPost(tx, ref.postId);
    if (!locked || locked.post.deletedAt)
      throw new SchedulingError('not_found', 'Post was deleted.');
    const t = await lockTarget(tx, input.targetId);
    if (!t) throw new SchedulingError('not_found', 'Post not found.');
    const { asset } = locked;
    const label = platformLabel(t.platform);
    if (t.status === 'published') return; // already live: nothing to retry
    if (t.status === 'publishing' || t.status === 'preparing') {
      throw new SchedulingError('locked', `${label} is working on this post right now.`);
    }
    if (t.status === 'draft' || t.status === 'canceled') {
      throw new SchedulingError('invalid', 'This post is not scheduled. Schedule it first.');
    }
    if (asset.status !== 'ready') {
      throw new SchedulingError('invalid', 'The video is not ready.');
    }
    const account = resolveAccount(t, accounts);
    const reason = blockingReason(t, asset, account);
    if (reason) throw new SchedulingError('invalid', `${reason}.`);

    // "Retry now" keeps a future time (e.g. a failed upload for tomorrow) and turns a past one
    // into "now" (e.g. a missed Instagram post).
    const at = slot ?? (t.scheduledAt && t.scheduledAt > now ? t.scheduledAt : now);

    const patch = { ...armPatch(t, at, account!.id) } as Record<string, unknown>;
    if (input.mode === 'now' && hasRemote(t)) {
      // Something may already be on the platform: check it before preparing again. The grace
      // delay stops the dispatcher from racing the reconcile job (it takes over if the job is lost).
      Object.assign(patch, {
        status: t.status === 'prepared' ? 'prepared' : 'scheduled',
        needsSync: t.scheduledAt?.getTime() !== at.getTime() || t.needsSync,
        nextAttemptAt: new Date(now.getTime() + SCHEDULING.reconcileGraceMs),
      });
      reconcile = true;
    }
    await tx.update(postTargets).set(patch).where(eq(postTargets.id, t.id));
    await tx
      .update(posts)
      .set({ approvedAt: now, version: postVersion })
      .where(eq(posts.id, t.postId));
    await recomputePostTime(tx, t.postId);
  });

  if (reconcile) {
    try {
      await deps.jobs.send(
        'reconcile-target',
        { targetId: input.targetId },
        targetJobOptions(input.targetId),
      );
    } catch (err) {
      deps.log.warn('could not queue reconcile-target', { targetId: input.targetId, err });
    }
  }
  await sendDispatchNow(deps);
}

// ---------------------------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------------------------

/** Failures that are about the text itself: fixing the text clears them back to draft. */
const TEXT_FAILURES = ['ai_failed', 'write_manually', 'invalid_text'];

function cleanTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.replace(/[<>,]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

function sameOptions(a: TargetOptions, b: TargetOptions): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof TargetOptions>;
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

/** Saves edited text/options from the editor (marks fields 'manual'; updates natively scheduled items). */
export async function updateTargetText(
  deps: ServiceDeps,
  input: {
    targetId: string;
    patch: {
      title?: string;
      body?: string;
      hashtags?: string[];
      tags?: string[];
      options?: TargetOptions;
    };
    expectedVersion?: number;
  },
): Promise<{ version: number; issues: TextIssue[] }> {
  let queueSync = false;
  const result = await deps.db.transaction(async (tx) => {
    const t = await lockTarget(tx, input.targetId);
    if (!t) throw new SchedulingError('not_found', 'Post not found.');
    const label = platformLabel(t.platform);
    if (input.expectedVersion !== undefined && input.expectedVersion !== t.version) {
      throw new SchedulingError(
        'version_conflict',
        `This ${label} text was changed somewhere else after you opened it. Reload to see the latest version, then edit again.`,
      );
    }
    if (t.status === 'published') {
      throw new SchedulingError(
        'locked',
        `Already published on ${label}; the text can't be changed here.`,
      );
    }
    if (t.status === 'publishing') {
      throw new SchedulingError(
        'locked',
        `${label} is publishing this post right now. Try again in a minute.`,
      );
    }
    if (t.status === 'canceled') throw new SchedulingError('not_found', 'Post was deleted.');

    const p = input.patch;
    const next = {
      title: p.title ?? t.title,
      body: p.body ?? t.body,
      hashtags: p.hashtags ? normalizeHashtags(p.hashtags) : t.hashtags,
      tags: p.tags ? cleanTags(p.tags) : t.tags,
    };
    const options: TargetOptions = p.options ? { ...t.options, ...p.options } : t.options;
    const sources: TargetTextSources = { ...t.textSources };
    let textChanged = false;
    for (const field of ['title', 'body'] as const) {
      if (next[field] !== t[field]) ((sources[field] = 'manual'), (textChanged = true));
    }
    for (const field of ['hashtags', 'tags'] as const) {
      if (!sameList(next[field], t[field])) ((sources[field] = 'manual'), (textChanged = true));
    }
    const optionsChanged = !sameOptions(options, t.options);
    const issues = validateTargetText(t.platform, next, { fbKind: options.fbKind });
    if (!textChanged && !optionsChanged) return { version: t.version, issues };

    const valid = !issues.some((i) => i.severity === 'block');
    const clearFailure =
      t.status === 'failed' && valid && TEXT_FAILURES.includes(t.attentionReason ?? '');
    const sync = isHandedOver(t);
    queueSync = sync;
    const rows = await tx
      .update(postTargets)
      .set({
        ...next,
        options,
        textSources: sources,
        version,
        ...(sync ? { needsSync: true } : {}),
        ...(clearFailure
          ? {
              status: 'draft' as const,
              attentionReason: null,
              lastError: null,
              lastErrorCode: null,
            }
          : {}),
      })
      .where(eq(postTargets.id, t.id))
      .returning({ version: postTargets.version });
    return { version: rows[0]!.version, issues };
  });
  if (queueSync) await sendDispatchNow(deps);
  return result;
}
