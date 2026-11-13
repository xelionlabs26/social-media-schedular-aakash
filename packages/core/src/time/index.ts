/**
 * Time-zone helpers. Everything is stored in UTC; the owner works in app_settings.timezone
 * (default Asia/Kolkata / IST). Pure functions: safe for client components.
 */
import { TZDate } from '@date-fns/tz';
import { format as fmt } from 'date-fns';

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

/** Converts a local date ('YYYY-MM-DD') + time ('HH:MM') in `tz` to a UTC Date. */
export function localToUtc(date: string, time: string, tz: string = DEFAULT_TIMEZONE): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  if (![y, m, d, hh, mm].every(Number.isFinite))
    throw new Error(`Invalid local date/time: ${date} ${time}`);
  return new Date(new TZDate(y, m - 1, d, hh, mm, 0, 0, tz).getTime());
}

/** The local calendar parts of an instant in `tz`. */
export function toLocalParts(at: Date, tz: string = DEFAULT_TIMEZONE) {
  const z = new TZDate(at.getTime(), tz);
  return {
    date: fmt(z, 'yyyy-MM-dd'),
    time: fmt(z, 'HH:mm'),
    weekday: z.getDay(), // 0 = Sunday
    year: z.getFullYear(),
    month: z.getMonth() + 1,
    day: z.getDate(),
    hour: z.getHours(),
    minute: z.getMinutes(),
  };
}

/** Formats an instant in `tz` with a date-fns pattern. */
export function formatInTz(at: Date, pattern: string, tz: string = DEFAULT_TIMEZONE): string {
  return fmt(new TZDate(at.getTime(), tz), pattern);
}

/** e.g. "Sat 15 Nov, 18:00 IST" */
export function formatShort(at: Date, tz: string = DEFAULT_TIMEZONE): string {
  return `${formatInTz(at, 'EEE d MMM, HH:mm', tz)} ${tzAbbrev(tz)}`;
}

export function tzAbbrev(tz: string): string {
  if (tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta') return 'IST';
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName');
    return part?.value ?? tz;
  } catch {
    return tz;
  }
}

/** Adds whole days to a local date string. */
export function addLocalDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** Weekday (0 = Sunday) of a local date string. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Key of the YouTube quota day (quota resets at midnight Pacific time). */
export function pacificDayKey(at: Date): string {
  return formatInTz(at, 'yyyy-MM-dd', 'America/Los_Angeles');
}

/** Start of the current Pacific-time day as a UTC instant. */
export function startOfPacificDay(at: Date): Date {
  return localToUtc(pacificDayKey(at), '00:00', 'America/Los_Angeles');
}

export const minutes = (n: number) => n * 60_000;
export const hours = (n: number) => n * 3_600_000;
export const days = (n: number) => n * 86_400_000;
