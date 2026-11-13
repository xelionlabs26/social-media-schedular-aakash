/**
 * "Next free slot": the owner's weekly posting-time grid (posting_slots, local HH:MM per weekday
 * in the app time zone) turned into concrete UTC instants, skipping instants that are too soon or
 * that collide with posts already planned on the same platform(s).
 */
import { and, eq, gte, inArray, isNotNull, isNull, notInArray } from 'drizzle-orm';
import {
  PLATFORMS,
  postTargets,
  posts,
  postingSlots,
  type AppSettings,
  type Db,
  type Platform,
} from '@app/db';
import { addLocalDays, localToUtc, toLocalParts, weekdayOf } from '../time';
import { SCHEDULING } from './config';
import { SchedulingError } from './errors';
import { SLOT_OCCUPYING_STATUSES } from './model';

export interface SlotRule {
  weekday: number;
  time: string;
  /** null/empty = every platform. */
  platforms: Platform[] | null;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertLocalDate(date: string): void {
  if (!DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new SchedulingError('invalid', `Invalid date "${date}" (expected YYYY-MM-DD).`);
  }
}

/** Daily 18:00 when the owner has not set up a grid (PLAN.md §11 B2.1). */
export function defaultSlotRules(): SlotRule[] {
  return [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    time: SCHEDULING.defaultSlotTime,
    platforms: null,
  }));
}

/** A slot restricted to some platforms is used only for posts going to a subset of them. */
export function slotAppliesTo(slot: SlotRule, platforms: Platform[]): boolean {
  if (!slot.platforms || slot.platforms.length === 0) return true;
  return platforms.every((p) => slot.platforms!.includes(p));
}

/**
 * Slot instants in ascending order, `days` local days from `startDate`. Uses the time-zone
 * helpers, so a slot keeps its wall-clock time across DST changes; a wall-clock time that maps to
 * the same instant as an earlier one (DST overlap) is yielded once.
 */
export function* slotInstants(opts: {
  rules: SlotRule[];
  tz: string;
  startDate: string;
  days: number;
  platforms: Platform[];
}): Generator<Date> {
  const byWeekday = new Map<number, string[]>();
  for (const rule of opts.rules) {
    if (!TIME_RE.test(rule.time) || !slotAppliesTo(rule, opts.platforms)) continue;
    const list = byWeekday.get(rule.weekday) ?? [];
    if (!list.includes(rule.time)) list.push(rule.time);
    byWeekday.set(rule.weekday, list);
  }
  if (byWeekday.size === 0) return;
  let last = -Infinity;
  for (let i = 0; i < opts.days; i++) {
    const date = addLocalDays(opts.startDate, i);
    const instants = (byWeekday.get(weekdayOf(date)) ?? [])
      .map((time) => localToUtc(date, time, opts.tz))
      .sort((a, b) => a.getTime() - b.getTime());
    for (const at of instants) {
      if (at.getTime() <= last) continue;
      last = at.getTime();
      yield at;
    }
  }
}

/** Planned/published instants (ms) per platform. */
export type BusyMap = Map<Platform, number[]>;

export function collides(at: number, platforms: Platform[], busy: BusyMap, gapMs: number): boolean {
  for (const p of platforms) {
    for (const b of busy.get(p) ?? []) if (Math.abs(b - at) < gapMs) return true;
  }
  return false;
}

/** Minimum distance between two posts on the same platform (never below one minute). */
export const gapMsOf = (settings: Pick<AppSettings, 'minGapMinutes'>) =>
  Math.max(settings.minGapMinutes, 1) * 60_000;

/**
 * Finds free slots and remembers the ones it hands out, so a bulk "Schedule" spreads posts
 * across consecutive slots instead of giving every post the same one.
 */
export class SlotFinder {
  private constructor(
    private readonly rules: SlotRule[],
    private readonly busy: BusyMap,
    private readonly tz: string,
    private readonly startDate: string,
    private readonly earliest: number,
    private readonly gapMs: number,
  ) {}

  static async load(
    db: Db,
    settings: AppSettings,
    /** excludePostIds: posts being (re)scheduled don't block their own current time. */
    opts: { now: Date; startDate?: string; excludePostIds?: string[] },
  ): Promise<SlotFinder> {
    const tz = settings.timezone;
    const startDate = opts.startDate ?? toLocalParts(opts.now, tz).date;
    assertLocalDate(startDate);
    const rows = await db.select().from(postingSlots);
    const rules: SlotRule[] = rows.length
      ? rows.map((r) => ({ weekday: r.weekday, time: r.time, platforms: r.platforms }))
      : defaultSlotRules();
    const gapMs = gapMsOf(settings);
    const from = new Date(
      Math.min(localToUtc(startDate, '00:00', tz).getTime(), opts.now.getTime()) - gapMs,
    );
    const busy = await loadBusy(db, from, opts.excludePostIds);
    return new SlotFinder(
      rules,
      busy,
      tz,
      startDate,
      opts.now.getTime() + SCHEDULING.minLeadMs,
      gapMs,
    );
  }

  /** The next `count` free instants for these platforms (does not reserve them). */
  peek(count: number, platforms: Platform[]): Date[] {
    const out: Date[] = [];
    const taken: BusyMap = new Map(Array.from(this.busy, ([p, list]) => [p, [...list]]));
    for (const at of this.candidates(platforms)) {
      if (out.length >= count) break;
      if (collides(at.getTime(), platforms, taken, this.gapMs)) continue;
      out.push(at);
      for (const p of platforms) taken.set(p, [...(taken.get(p) ?? []), at.getTime()]);
    }
    return out;
  }

  /** The next free instant for these platforms, reserved for the rest of this finder's life. */
  take(platforms: Platform[]): Date | null {
    const at = this.peek(1, platforms)[0] ?? null;
    if (at)
      for (const p of platforms) this.busy.set(p, [...(this.busy.get(p) ?? []), at.getTime()]);
    return at;
  }

  private *candidates(platforms: Platform[]): Generator<Date> {
    for (const at of slotInstants({
      rules: this.rules,
      tz: this.tz,
      startDate: this.startDate,
      days: SCHEDULING.slotSearchDays,
      platforms,
    })) {
      if (at.getTime() >= this.earliest) yield at;
    }
  }
}

/** Targets that occupy a time (scheduled … published) from `from` on, grouped by platform. */
export async function loadBusy(
  db: Db,
  from: Date,
  excludePostIds: string[] = [],
): Promise<BusyMap> {
  const rows = await db
    .select({ platform: postTargets.platform, at: postTargets.scheduledAt })
    .from(postTargets)
    .innerJoin(posts, and(eq(posts.id, postTargets.postId), isNull(posts.deletedAt)))
    .where(
      and(
        inArray(postTargets.status, SLOT_OCCUPYING_STATUSES),
        isNotNull(postTargets.scheduledAt),
        gte(postTargets.scheduledAt, from),
        excludePostIds.length ? notInArray(postTargets.postId, excludePostIds) : undefined,
      ),
    );
  const busy: BusyMap = new Map(PLATFORMS.map((p) => [p, [] as number[]]));
  for (const r of rows) if (r.at) busy.get(r.platform)!.push(r.at.getTime());
  return busy;
}
