import { describe, expect, it } from 'vitest';
import {
  formatLocalDate,
  formatWhen,
  isRealDate,
  localInputToUtc,
  minLocalInput,
  todayInTz,
  utcToLocalInput,
  zoneLabel,
} from './time';

const IST = 'Asia/Kolkata';

describe('datetime-local <-> UTC in the app time zone', () => {
  it('reads an IST wall-clock time as the right instant (UTC+5:30)', () => {
    expect(localInputToUtc('2026-11-15T18:00', IST)?.toISOString()).toBe(
      '2026-11-15T12:30:00.000Z',
    );
    // Seconds are accepted (some browsers add them) and ignored.
    expect(localInputToUtc('2026-11-15T18:00:30', IST)?.toISOString()).toBe(
      '2026-11-15T12:30:00.000Z',
    );
    // Midnight IST is the previous UTC day.
    expect(localInputToUtc('2026-11-16T00:15', IST)?.toISOString()).toBe(
      '2026-11-15T18:45:00.000Z',
    );
  });

  it('shows an instant as IST input text, regardless of the device zone', () => {
    expect(utcToLocalInput(new Date('2026-11-15T12:30:00Z'), IST)).toBe('2026-11-15T18:00');
    expect(utcToLocalInput('2026-11-15T18:45:00.000Z', IST)).toBe('2026-11-16T00:15');
    expect(utcToLocalInput(null, IST)).toBe('');
    expect(utcToLocalInput('not a date', IST)).toBe('');
  });

  it('round-trips, including across a DST change in other zones', () => {
    for (const v of ['2026-03-08T01:30', '2026-03-08T03:30', '2026-11-01T01:30']) {
      const at = localInputToUtc(v, 'America/New_York')!;
      expect(utcToLocalInput(at, 'America/New_York')).toBe(v);
    }
    const v = '2026-12-31T23:59';
    expect(utcToLocalInput(localInputToUtc(v, IST), IST)).toBe(v);
  });

  it('rejects malformed or impossible input', () => {
    expect(localInputToUtc('', IST)).toBeNull();
    expect(localInputToUtc('2026-02-30T10:00', IST)).toBeNull();
    expect(localInputToUtc('2026-11-15T24:00', IST)).toBeNull();
    expect(localInputToUtc('2026-11-15 18:00', IST)).toBeNull();
    expect(isRealDate('2028-02-29')).toBe(true);
    expect(isRealDate('2027-02-29')).toBe(false);
  });

  it('knows today, the earliest pickable minute and display labels in IST', () => {
    const now = new Date('2026-11-13T20:00:20Z'); // 01:30:20 IST on the 14th
    expect(todayInTz(IST, now)).toBe('2026-11-14');
    expect(minLocalInput(IST, now)).toBe('2026-11-14T01:31');
    expect(formatWhen(new Date('2026-11-15T12:30:00Z'), IST)).toBe('Sun 15 Nov, 18:00 IST');
    expect(formatWhen(null, IST)).toBe('—');
    expect(formatLocalDate('2026-11-15', IST)).toBe('Sun 15 Nov');
    expect(zoneLabel(IST)).toBe('IST');
  });
});
