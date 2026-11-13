/**
 * Conversions between UTC instants and the owner's local wall-clock time (app_settings.timezone,
 * IST by default) for <input type="datetime-local"> and <input type="date">. Browsers interpret
 * those inputs in the *device's* zone, so we never hand them a Date: we pass the local text
 * ("2026-11-15T18:00") and convert it with the app zone ourselves. Pure and client-safe.
 */
import { formatInTz, formatShort, localToUtc, toLocalParts, tzAbbrev } from '@app/core/time';

const LOCAL_INPUT_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const toDate = (v: Date | string | null | undefined): Date | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** UTC instant -> "YYYY-MM-DDTHH:mm" in `tz` ('' for no value). */
export function utcToLocalInput(at: Date | string | null | undefined, tz: string): string {
  const d = toDate(at);
  if (!d) return '';
  const p = toLocalParts(d, tz);
  return `${p.date}T${p.time}`;
}

/** "YYYY-MM-DDTHH:mm" in `tz` -> UTC instant (null when empty or malformed). */
export function localInputToUtc(value: string, tz: string): Date | null {
  const m = LOCAL_INPUT_RE.exec(value.trim());
  if (!m) return null;
  const [, date = '', time = ''] = m;
  if (!isRealDate(date)) return null;
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  if (hh > 23 || mm > 59) return null;
  try {
    return localToUtc(date, time, tz);
  } catch {
    return null;
  }
}

/** True for a valid calendar date "YYYY-MM-DD" (rejects 2026-02-30). */
export function isRealDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Today's date "YYYY-MM-DD" in `tz`. */
export function todayInTz(tz: string, now: Date = new Date()): string {
  return toLocalParts(now, tz).date;
}

/** Earliest selectable value for a datetime-local input (now, rounded up to the minute). */
export function minLocalInput(tz: string, now: Date = new Date()): string {
  const rounded = new Date(Math.ceil(now.getTime() / 60_000) * 60_000);
  return utcToLocalInput(rounded, tz);
}

/** "Sat 15 Nov, 18:00 IST" (or "—"). */
export function formatWhen(at: Date | string | null | undefined, tz: string): string {
  const d = toDate(at);
  return d ? formatShort(d, tz) : '—';
}

/** A local date "YYYY-MM-DD" as "Sat 15 Nov". */
export function formatLocalDate(date: string, tz: string): string {
  if (!isRealDate(date)) return date;
  // Noon avoids any DST edge moving the instant to another calendar day.
  return formatInTz(localToUtc(date, '12:00', tz), 'EEE d MMM', tz);
}

/** "IST" for Asia/Kolkata, the short zone name otherwise. */
export const zoneLabel = tzAbbrev;
