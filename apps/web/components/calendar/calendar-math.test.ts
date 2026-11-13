import { describe, expect, it } from 'vitest';
import {
  addMonths,
  dropTimeForDay,
  freeSlotTimes,
  groupByLocalDate,
  isLocalDate,
  isLocalTime,
  isPastLocal,
  localRangeFor,
  monthGrid,
  moveToLocalDate,
  parseDateParam,
  parseView,
  shiftDate,
  slotTimesFor,
  startOfWeek,
  todayIn,
  utcRangeFor,
  viewTitle,
  weekDays,
} from './calendar-math';

const IST = 'Asia/Kolkata';
const LONDON = 'Europe/London';

describe('URL params', () => {
  it('parses the view with a week default', () => {
    expect(parseView('month')).toBe('month');
    expect(parseView('list')).toBe('list');
    expect(parseView('year')).toBe('week');
    expect(parseView(undefined)).toBe('week');
    expect(parseView(['month', 'list'])).toBe('month');
  });

  it('accepts only real dates', () => {
    expect(isLocalDate('2026-11-13')).toBe(true);
    expect(isLocalDate('2028-02-29')).toBe(true);
    expect(isLocalDate('2026-02-29')).toBe(false);
    expect(isLocalDate('2026-13-01')).toBe(false);
    expect(isLocalDate('2026-1-01')).toBe(false);
    expect(isLocalDate('1999-01-01')).toBe(false);
    expect(parseDateParam('nope', '2026-11-13')).toBe('2026-11-13');
    expect(parseDateParam('2026-12-01', '2026-11-13')).toBe('2026-12-01');
  });

  it('accepts only HH:MM 24h times', () => {
    expect(isLocalTime('18:00')).toBe(true);
    expect(isLocalTime('00:00')).toBe(true);
    expect(isLocalTime('23:59')).toBe(true);
    expect(isLocalTime('24:00')).toBe(false);
    expect(isLocalTime('9:00')).toBe(false);
    expect(isLocalTime('18:60')).toBe(false);
  });
});

describe('today in a time zone', () => {
  it('uses IST, not UTC, for the date', () => {
    // 20:00 UTC on 13 Nov is 01:30 on 14 Nov in IST.
    expect(todayIn(IST, new Date('2026-11-13T20:00:00Z'))).toBe('2026-11-14');
    expect(todayIn('UTC', new Date('2026-11-13T20:00:00Z'))).toBe('2026-11-13');
  });
});

describe('week grid (Monday start)', () => {
  it('finds the Monday of the week', () => {
    expect(startOfWeek('2026-11-13')).toBe('2026-11-09'); // Fri -> Mon
    expect(startOfWeek('2026-11-09')).toBe('2026-11-09'); // Mon
    expect(startOfWeek('2026-11-15')).toBe('2026-11-09'); // Sun belongs to the week before
  });

  it('lists Mon..Sun across a month/year boundary', () => {
    expect(weekDays('2026-12-31')).toEqual([
      '2026-12-28',
      '2026-12-29',
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
      '2027-01-03',
    ]);
  });

  it('computes the UTC range of an IST week', () => {
    const r = utcRangeFor('week', '2026-11-13', IST)!;
    // Monday 00:00 IST = Sunday 18:30 UTC.
    expect(r.from.toISOString()).toBe('2026-11-08T18:30:00.000Z');
    expect(r.to.toISOString()).toBe('2026-11-15T18:30:00.000Z');
  });

  it('has a 7-day range across a DST change (one hour shorter in London)', () => {
    const r = utcRangeFor('week', '2026-03-29', LONDON)!;
    expect(r.from.toISOString()).toBe('2026-03-23T00:00:00.000Z');
    // Monday 30 Mar 00:00 BST = 29 Mar 23:00 UTC.
    expect(r.to.toISOString()).toBe('2026-03-29T23:00:00.000Z');
  });

  it('navigates by whole weeks', () => {
    expect(shiftDate('week', '2026-11-13', 1)).toBe('2026-11-16');
    expect(shiftDate('week', '2026-11-13', -1)).toBe('2026-11-02');
  });

  it('titles the week', () => {
    expect(viewTitle('week', '2026-11-13')).toBe('9 – 15 Nov 2026');
    expect(viewTitle('week', '2026-12-01')).toBe('30 Nov – 6 Dec 2026');
    expect(viewTitle('week', '2026-12-31')).toBe('28 Dec 2026 – 3 Jan 2027');
  });
});

describe('month grid', () => {
  it('covers November 2026 in whole Monday weeks', () => {
    const g = monthGrid('2026-11-13');
    // 1 Nov 2026 is a Sunday, so the grid starts on Mon 26 Oct.
    expect(g[0]![0]).toBe('2026-10-26');
    expect(g[0]![6]).toBe('2026-11-01');
    expect(g[g.length - 1]![6]).toBe('2026-12-06');
    expect(g).toHaveLength(6);
    for (const w of g) expect(w).toHaveLength(7);
  });

  it('uses 4 rows for February 2027 (starts on Monday, 28 days)', () => {
    const g = monthGrid('2027-02-10');
    expect(g).toHaveLength(4);
    expect(g[0]![0]).toBe('2027-02-01');
    expect(g[3]![6]).toBe('2027-02-28');
  });

  it('range ends after the last grid day', () => {
    expect(localRangeFor('month', '2026-11-13')).toEqual({
      start: '2026-10-26',
      endExclusive: '2026-12-07',
    });
    expect(localRangeFor('list', '2026-11-13')).toBeNull();
  });

  it('navigates by months and clamps the day', () => {
    expect(shiftDate('month', '2026-11-13', 1)).toBe('2026-12-01');
    expect(shiftDate('month', '2026-01-31', -1)).toBe('2025-12-01');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(viewTitle('month', '2026-11-13')).toBe('November 2026');
  });
});

describe('moving a post to another day keeps its local time', () => {
  it('IST (no DST)', () => {
    const at = new Date('2026-11-15T12:30:00Z'); // 18:00 IST on Sun 15 Nov
    const moved = moveToLocalDate(at, '2026-11-20', IST);
    expect(moved.toISOString()).toBe('2026-11-20T12:30:00.000Z'); // 18:00 IST
  });

  it('IST across a date line in UTC (late night)', () => {
    const at = new Date('2026-11-15T18:45:00Z'); // 00:15 IST on Mon 16 Nov
    const moved = moveToLocalDate(at, '2026-11-18', IST);
    expect(moved.toISOString()).toBe('2026-11-17T18:45:00.000Z'); // 00:15 IST on 18 Nov
  });

  it('Europe/London across the spring-forward change', () => {
    const at = new Date('2026-03-28T18:00:00Z'); // 18:00 GMT, Sat 28 Mar
    const moved = moveToLocalDate(at, '2026-03-30', LONDON);
    expect(moved.toISOString()).toBe('2026-03-30T17:00:00.000Z'); // 18:00 BST
  });

  it('Europe/London across the fall-back change', () => {
    const at = new Date('2026-10-24T17:00:00Z'); // 18:00 BST, Sat 24 Oct
    const moved = moveToLocalDate(at, '2026-10-26', LONDON);
    expect(moved.toISOString()).toBe('2026-10-26T18:00:00.000Z'); // 18:00 GMT
  });

  it('takes a slot time when given', () => {
    const at = new Date('2026-11-15T12:30:00Z');
    expect(moveToLocalDate(at, '2026-11-16', IST, '09:15').toISOString()).toBe(
      '2026-11-16T03:45:00.000Z',
    );
  });

  it('rejects bad input', () => {
    expect(() => moveToLocalDate(new Date(), '2026-02-30', IST)).toThrow();
    expect(() => moveToLocalDate(new Date(), '2026-02-03', IST, '25:00')).toThrow();
  });
});

describe('grouping and free slots', () => {
  it('groups instants by IST date', () => {
    const items = [
      { id: 'a', at: '2026-11-15T12:30:00Z' }, // 15 Nov 18:00 IST
      { id: 'b', at: '2026-11-15T18:45:00Z' }, // 16 Nov 00:15 IST
      { id: 'c', at: null },
    ];
    const g = groupByLocalDate(items, (i) => i.at, IST);
    expect(g.get('2026-11-15')!.map((i) => i.id)).toEqual(['a']);
    expect(g.get('2026-11-16')!.map((i) => i.id)).toEqual(['b']);
    expect(g.size).toBe(2);
  });

  it('uses daily 18:00 when no slots exist', () => {
    expect(slotTimesFor('2026-11-13', [])).toEqual(['18:00']);
  });

  it('uses only the slots of that weekday', () => {
    const slots = [
      { weekday: 5, time: '19:00' }, // Friday
      { weekday: 5, time: '09:00' },
      { weekday: 6, time: '11:00' },
    ];
    expect(slotTimesFor('2026-11-13', slots)).toEqual(['09:00', '19:00']); // Fri
    expect(slotTimesFor('2026-11-12', slots)).toEqual([]); // Thu
  });

  it('hides taken and past slots', () => {
    const slots = [
      { weekday: 5, time: '09:00' },
      { weekday: 5, time: '19:00' },
    ];
    expect(freeSlotTimes('2026-11-13', slots, ['19:00'])).toEqual(['09:00']);
    const now = new Date('2026-11-13T06:00:00Z'); // 11:30 IST on Fri 13 Nov
    expect(freeSlotTimes('2026-11-13', slots, [], { now, tz: IST })).toEqual(['19:00']);
    expect(freeSlotTimes('2026-11-06', slots, [], { now, tz: IST })).toEqual([]);
  });

  it('chooses the drop time for a draft', () => {
    const slots = [
      { weekday: 5, time: '09:00' },
      { weekday: 5, time: '19:00' },
    ];
    const now = new Date('2026-11-01T00:00:00Z');
    expect(dropTimeForDay('2026-11-13', slots, ['09:00'], { now, tz: IST })).toBe('19:00');
    // All taken: stack on the first slot still ahead (scheduler applies the min gap).
    expect(dropTimeForDay('2026-11-13', slots, ['09:00', '19:00'], { now, tz: IST })).toBe('09:00');
    // Past day: nothing.
    const later = new Date('2026-11-20T00:00:00Z');
    expect(dropTimeForDay('2026-11-13', slots, [], { now: later, tz: IST })).toBeNull();
    // Day without slots in a non-empty grid.
    expect(dropTimeForDay('2026-11-12', slots, [], { now, tz: IST })).toBeNull();
  });

  it('detects past local times', () => {
    const now = new Date('2026-11-13T12:30:00Z'); // 18:00 IST
    expect(isPastLocal('2026-11-13', '17:59', IST, now)).toBe(true);
    expect(isPastLocal('2026-11-13', '18:01', IST, now)).toBe(false);
  });
});
