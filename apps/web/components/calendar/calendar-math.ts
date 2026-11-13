/**
 * Calendar math: views, week/month grids, ranges and "move to another day" in the owner's time
 * zone. Pure functions working on local date strings ('YYYY-MM-DD') so they are safe for client
 * components and easy to test. Weeks start on Monday (PLAN.md §3.6 wireframe).
 */
import { addLocalDays, localToUtc, toLocalParts, weekdayOf } from '@app/core/time';

export const CALENDAR_VIEWS = ['week', 'month', 'list'] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseView(value: string | string[] | undefined | null): CalendarView {
  const v = Array.isArray(value) ? value[0] : value;
  return (CALENDAR_VIEWS as readonly string[]).includes(v ?? '') ? (v as CalendarView) : 'week';
}

/** True for a real calendar date in 'YYYY-MM-DD' form (rejects 2026-02-30). */
export function isLocalDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (
    y >= 2000 &&
    y <= 2100 &&
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === mo - 1 &&
    dt.getUTCDate() === d
  );
}

/** True for a 24-hour 'HH:MM' wall-clock time. */
export function isLocalTime(value: unknown): value is string {
  return typeof value === 'string' && TIME_RE.test(value);
}

/** The ?date= param if valid, otherwise today's local date. */
export function parseDateParam(value: string | string[] | undefined | null, today: string): string {
  const v = Array.isArray(value) ? value[0] : value;
  return isLocalDate(v) ? v : today;
}

/** Today's local date in `tz`. */
export function todayIn(tz: string, now: Date = new Date()): string {
  return toLocalParts(now, tz).date;
}

/** Monday of the week containing `date`. */
export function startOfWeek(date: string): string {
  const wd = weekdayOf(date); // 0 = Sunday
  const back = (wd + 6) % 7; // Monday -> 0, Sunday -> 6
  return addLocalDays(date, -back);
}

/** The 7 local dates (Mon..Sun) of the week containing `date`. */
export function weekDays(date: string): string[] {
  const start = startOfWeek(date);
  return Array.from({ length: 7 }, (_, i) => addLocalDays(start, i));
}

export function firstOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function daysInMonth(date: string): number {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const first = `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-01`;
  // Clamp the day (31 Jan + 1 month -> 28/29 Feb).
  const day = Math.min(d, daysInMonth(first));
  return `${first.slice(0, 8)}${String(day).padStart(2, '0')}`;
}

/**
 * Month grid: whole Monday-start weeks covering the month of `date` (4–6 rows of 7 dates).
 * Days outside the month are included so the grid is rectangular.
 */
export function monthGrid(date: string): string[][] {
  const first = firstOfMonth(date);
  const last = `${date.slice(0, 8)}${String(daysInMonth(date)).padStart(2, '0')}`;
  const start = startOfWeek(first);
  const weeks: string[][] = [];
  for (let cursor = start; cursor <= last; cursor = addLocalDays(cursor, 7)) {
    weeks.push(weekDays(cursor));
  }
  return weeks;
}

export function isSameMonth(a: string, b: string): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

/** Local date range [start, endExclusive) shown by a view. List view has no date range. */
export function localRangeFor(
  view: CalendarView,
  date: string,
): { start: string; endExclusive: string } | null {
  if (view === 'week') {
    const start = startOfWeek(date);
    return { start, endExclusive: addLocalDays(start, 7) };
  }
  if (view === 'month') {
    const weeks = monthGrid(date);
    const start = weeks[0]![0]!;
    const lastWeek = weeks[weeks.length - 1]!;
    return { start, endExclusive: addLocalDays(lastWeek[6]!, 1) };
  }
  return null;
}

/** UTC range [from, to) for a view, for getPostCards({from, to}). */
export function utcRangeFor(
  view: CalendarView,
  date: string,
  tz: string,
): { from: Date; to: Date } | null {
  const r = localRangeFor(view, date);
  if (!r) return null;
  return { from: localToUtc(r.start, '00:00', tz), to: localToUtc(r.endExclusive, '00:00', tz) };
}

/** Date for the prev/next buttons. */
export function shiftDate(view: CalendarView, date: string, dir: -1 | 1): string {
  if (view === 'month') return addMonths(firstOfMonth(date), dir);
  if (view === 'week') return addLocalDays(startOfWeek(date), 7 * dir);
  return date;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Monday-first header labels. */
export const WEEK_HEADER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function parts(date: string) {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return { y, m, d };
}

/** e.g. "Mon 10" */
export function dayLabel(date: string): string {
  return `${WEEKDAYS_SHORT[weekdayOf(date)]} ${parts(date).d}`;
}

/** e.g. "Sat 15 Nov" */
export function dayLabelLong(date: string): string {
  const { m, d } = parts(date);
  return `${WEEKDAYS_SHORT[weekdayOf(date)]} ${d} ${MONTHS[m - 1]}`;
}

/** Header title: "Nov 2026" (month), "10 – 16 Nov 2026" (week), "All videos" (list). */
export function viewTitle(view: CalendarView, date: string): string {
  if (view === 'list') return 'All videos';
  if (view === 'month') {
    const { y, m } = parts(date);
    return `${MONTHS_LONG[m - 1]} ${y}`;
  }
  const days = weekDays(date);
  const a = parts(days[0]!);
  const b = parts(days[6]!);
  if (a.y !== b.y) return `${a.d} ${MONTHS[a.m - 1]} ${a.y} – ${b.d} ${MONTHS[b.m - 1]} ${b.y}`;
  if (a.m !== b.m) return `${a.d} ${MONTHS[a.m - 1]} – ${b.d} ${MONTHS[b.m - 1]} ${b.y}`;
  return `${a.d} – ${b.d} ${MONTHS[b.m - 1]} ${b.y}`;
}

/**
 * Moves an instant to another local day, keeping its local wall-clock time in `tz`
 * (PLAN.md §3.5: "the date changes and the time stays"). Pass `time` to take a slot's time.
 *
 * In zones with DST the UTC offset may differ between the two days; we re-resolve the local
 * time on the new day so 18:00 stays 18:00. A time that doesn't exist on the new day (spring
 * forward gap) is resolved by @date-fns/tz to the next valid instant.
 */
export function moveToLocalDate(at: Date, newDate: string, tz: string, time?: string): Date {
  if (!isLocalDate(newDate)) throw new Error(`Invalid date: ${newDate}`);
  if (time !== undefined && !isLocalTime(time)) throw new Error(`Invalid time: ${time}`);
  const keep = toLocalParts(at, tz).time;
  return localToUtc(newDate, time ?? keep, tz);
}

/** Groups items by the local date of their instant. Items without an instant are skipped. */
export function groupByLocalDate<T>(
  items: T[],
  instant: (item: T) => Date | string | null | undefined,
  tz: string,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const raw = instant(item);
    if (!raw) continue;
    const at = typeof raw === 'string' ? new Date(raw) : raw;
    if (Number.isNaN(at.getTime())) continue;
    const key = toLocalParts(at, tz).date;
    const list = out.get(key);
    if (list) list.push(item);
    else out.set(key, [item]);
  }
  return out;
}

export interface SlotLike {
  weekday: number; // 0 = Sunday
  time: string; // 'HH:MM'
}

/** PLAN.md §11 B2: empty grid = every day at 18:00 (local). */
export const DEFAULT_SLOT_TIME = '18:00';

/** Posting-slot times for one local date, sorted. Empty grid means the default 18:00. */
export function slotTimesFor(date: string, slots: SlotLike[]): string[] {
  if (slots.length === 0) return [DEFAULT_SLOT_TIME];
  const wd = weekdayOf(date);
  return [...new Set(slots.filter((s) => s.weekday === wd).map((s) => s.time))].sort();
}

/**
 * Free slot times on a date: slot times with no post at that local time (and not in the past
 * when `now` is given). Used for the faint "free HH:MM" markers and for dropping drafts.
 */
export function freeSlotTimes(
  date: string,
  slots: SlotLike[],
  occupiedTimes: Iterable<string>,
  opts: { now?: Date; tz?: string } = {},
): string[] {
  const taken = new Set(occupiedTimes);
  let times = slotTimesFor(date, slots).filter((t) => !taken.has(t));
  if (opts.now && opts.tz) {
    const nowLocal = toLocalParts(opts.now, opts.tz);
    if (date < nowLocal.date) return [];
    if (date === nowLocal.date) times = times.filter((t) => t > nowLocal.time);
  }
  return times;
}

/**
 * The time a draft dropped on a day gets: the first free slot; if every slot is taken, the first
 * slot that is still ahead (the scheduler enforces the minimum gap); null when the day has no
 * slot left in the future (dropping on a past day).
 */
export function dropTimeForDay(
  date: string,
  slots: SlotLike[],
  occupiedTimes: Iterable<string>,
  opts: { now?: Date; tz?: string } = {},
): string | null {
  const free = freeSlotTimes(date, slots, occupiedTimes, opts);
  if (free[0]) return free[0];
  const ahead = freeSlotTimes(date, slots, [], opts);
  return ahead[0] ?? null;
}

/** True when the local date + time in `tz` is before `now`. */
export function isPastLocal(date: string, time: string, tz: string, now: Date): boolean {
  return localToUtc(date, time, tz).getTime() <= now.getTime();
}
