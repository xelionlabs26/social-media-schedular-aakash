'use server';

/**
 * Calendar mutations: drag to reschedule, schedule a draft by dropping it on a day, move to
 * drafts, and the needs-attention fixes. Every action checks the owner session first and
 * re-validates its input (server actions are reachable by direct POST).
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getPostCard, getPostCards } from '@app/core/posts';
import { moveToDrafts, reschedulePost, retryTarget, schedulePosts } from '@app/core/scheduling';
import { getSettings } from '@app/core/settings';
import { addLocalDays, formatShort, localToUtc, toLocalParts } from '@app/core/time';
import type { Platform } from '@app/db';
import { requireOwner } from '@/lib/auth';
import { getDeps } from '@/lib/deps';
import {
  fail,
  friendlyError,
  ok,
  UserError,
  type ActionResult,
} from '@/components/calendar/action-result';
import {
  dropTimeForDay,
  isLocalDate,
  isLocalTime,
  moveToLocalDate,
} from '@/components/calendar/calendar-math';
import { loadSlots } from '@/components/calendar/data';

const uuid = z.uuid();
const localDate = z.string().refine(isLocalDate, 'Pick a valid date');
const localTime = z.string().refine(isLocalTime, 'Pick a valid time');

function refreshPages() {
  revalidatePath('/calendar');
  revalidatePath('/');
}

/** Runs an action body with auth, logging and friendly errors. */
async function run<T>(
  what: string,
  body: () => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  try {
    await requireOwner();
    const result = await body();
    if (result.ok) refreshPages();
    return result;
  } catch (e) {
    if (e instanceof z.ZodError) return fail(e.issues[0]?.message ?? 'Invalid input');
    const name = e instanceof Error ? e.name : '';
    if (name !== 'UserError' && name !== 'NotImplementedError' && name !== 'UnauthorizedError') {
      getDeps().log.error(`calendar action failed: ${what}`, { error: e });
    }
    return fail(friendlyError(e, what));
  }
}

async function loadMovablePost(postId: string) {
  const card = await getPostCard(getDeps().db, postId);
  if (!card) throw new UserError('This video no longer exists.');
  if (card.targets.some((t) => t.status === 'publishing'))
    throw new UserError('This video is being published right now. Try again in a minute.');
  if (card.targets.length > 0 && card.targets.every((t) => t.status === 'published'))
    throw new UserError('This video is already published everywhere.');
  return card;
}

function assertFuture(at: Date, now: Date) {
  if (at.getTime() <= now.getTime()) {
    throw new UserError('That time has already passed. Pick a later day.');
  }
}

/**
 * Drag a card to another day (PLAN.md §3.5): the date changes and the local time stays. With
 * `time` (dropped on a free-slot marker) the slot's time is used instead. Platforms with their
 * own time ("Different time per app") each keep their own local time.
 */
export async function reschedulePostAction(
  postId: string,
  newLocalDate: string,
  time?: string,
): Promise<ActionResult> {
  return run('Moving the video', async () => {
    const id = uuid.parse(postId);
    const date = localDate.parse(newLocalDate);
    const slotTime = time === undefined ? undefined : localTime.parse(time);
    const deps = getDeps();
    const { timezone: tz } = await getSettings(deps.db);
    const card = await loadMovablePost(id);
    const now = deps.now();

    const base = card.scheduledAt ?? card.targets.find((t) => t.scheduledAt)?.scheduledAt ?? null;
    if (!base) {
      // No time yet: this is a draft; schedule it on that day instead.
      return scheduleOnDay(id, date, slotTime);
    }

    const movable = card.targets.filter((t) => t.status !== 'published' && t.status !== 'canceled');
    const ownTimes = movable.filter(
      (t) => t.scheduledAt && t.scheduledAt.getTime() !== base.getTime(),
    );
    const newAt = moveToLocalDate(base, date, tz, slotTime);
    assertFuture(newAt, now);

    if (ownTimes.length === 0 || slotTime) {
      await reschedulePost(deps, { postId: id, at: newAt });
    } else {
      // Keep each platform's own local time on the new day.
      const moves: Array<{ platform: Platform; at: Date }> = movable.map((t) => ({
        platform: t.platform,
        at: moveToLocalDate(t.scheduledAt ?? base, date, tz),
      }));
      for (const m of moves) assertFuture(m.at, now);
      for (const m of moves)
        await reschedulePost(deps, { postId: id, at: m.at, platform: m.platform });
    }
    return ok(`Moved to ${formatShort(newAt, tz)}`);
  });
}

/** Schedules a draft on a local date at `time`, or at that day's first free posting slot. */
async function scheduleOnDay(postId: string, date: string, time?: string): Promise<ActionResult> {
  const deps = getDeps();
  const { timezone: tz } = await getSettings(deps.db);
  const now = deps.now();
  let chosen = time;
  if (!chosen) {
    const dayStart = localToUtc(date, '00:00', tz);
    const dayEnd = localToUtc(addLocalDays(date, 1), '00:00', tz);
    const [slots, sameDay] = await Promise.all([
      loadSlots(deps.db),
      getPostCards(deps.db, { from: dayStart, to: dayEnd }, now),
    ]);
    const occupied = sameDay
      .filter((c) => c.id !== postId && c.scheduledAt)
      .map((c) => toLocalParts(c.scheduledAt!, tz).time);
    chosen = dropTimeForDay(date, slots, occupied, { now, tz }) ?? undefined;
    if (!chosen) {
      throw new UserError(
        'No posting time left on that day. Add one in Settings → Posting times, or drop it on a later day.',
      );
    }
  }
  const at = localToUtc(date, chosen, tz);
  assertFuture(at, now);
  const result = await schedulePosts(deps, { postIds: [postId], mode: 'pick', at });
  const skipped = result.skipped.find((s) => s.postId === postId);
  if (skipped) throw new UserError(`Not scheduled: ${skipped.reason}`);
  const warning = result.warnings[0];
  return ok(`Scheduled for ${formatShort(at, tz)}${warning ? ` · ${warning}` : ''}`);
}

/** Drafts tray → drop on a day (first free slot) or on a free-slot marker (that time). */
export async function scheduleDraftOnDayAction(
  postId: string,
  newLocalDate: string,
  time?: string,
): Promise<ActionResult> {
  return run('Scheduling the draft', async () => {
    const id = uuid.parse(postId);
    const date = localDate.parse(newLocalDate);
    const slotTime = time === undefined ? undefined : localTime.parse(time);
    const card = await getPostCard(getDeps().db, id);
    if (!card) throw new UserError('This video no longer exists.');
    if (card.display === 'processing')
      throw new UserError('This video is still processing. Schedule it when the text is ready.');
    return scheduleOnDay(id, date, slotTime);
  });
}

/** "Move to drafts" from the card menu: pauses the post. */
export async function moveToDraftsAction(postId: string): Promise<ActionResult> {
  return run('Moving to drafts', async () => {
    const id = uuid.parse(postId);
    await loadMovablePost(id);
    await moveToDrafts(getDeps(), { postId: id });
    return ok('Moved to drafts');
  });
}

/** Needs-attention fixes: [Retry now] and [Next free slot]. */
export async function retryTargetAction(
  targetId: string,
  mode: 'now' | 'next_free',
): Promise<ActionResult> {
  return run(mode === 'now' ? 'Retry' : 'Moving to the next free slot', async () => {
    const id = uuid.parse(targetId);
    const m = z.enum(['now', 'next_free']).parse(mode);
    await retryTarget(getDeps(), { targetId: id, mode: m });
    return ok(
      m === 'now' ? 'Retrying now. The status updates in a moment.' : 'Moved to the next free slot',
    );
  });
}
