import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { postingSlots } from '@app/db';
import { updateSettings } from '../settings';
import { backoffSec } from './config';
import { lateDecision, isHandedOver } from './model';
import { nextFreeSlots } from './services';
import { defaultSlotRules, slotInstants } from './slots';
import {
  FakeClock,
  makeDeps,
  openTestDb,
  seedAccount,
  seedPost,
  type TestDb,
} from './test-helpers';

const iso = (dates: Date[]) => dates.map((d) => d.toISOString());

describe('slot instants (pure)', () => {
  it('turns the daily 18:00 IST default into 12:30 UTC', () => {
    const got = [
      ...slotInstants({
        rules: defaultSlotRules(),
        tz: 'Asia/Kolkata',
        startDate: '2026-11-13',
        days: 2,
        platforms: ['youtube'],
      }),
    ];
    expect(iso(got)).toEqual(['2026-11-13T12:30:00.000Z', '2026-11-14T12:30:00.000Z']);
  });

  it('keeps the wall-clock time across a DST change', () => {
    // US DST ends on Sun 1 Nov 2026: 18:00 is 22:00Z the day before and 23:00Z after.
    const got = [
      ...slotInstants({
        rules: defaultSlotRules(),
        tz: 'America/New_York',
        startDate: '2026-10-31',
        days: 2,
        platforms: ['youtube'],
      }),
    ];
    expect(iso(got)).toEqual(['2026-10-31T22:00:00.000Z', '2026-11-01T23:00:00.000Z']);
  });

  it('uses platform-restricted slots only for posts going to those platforms', () => {
    const rules = [{ weekday: 5, time: '07:00', platforms: ['youtube' as const] }];
    const args = { rules, tz: 'Asia/Kolkata', startDate: '2026-11-13', days: 1 };
    expect([...slotInstants({ ...args, platforms: ['youtube'] })]).toHaveLength(1);
    expect([...slotInstants({ ...args, platforms: ['youtube', 'instagram'] })]).toHaveLength(0);
  });
});

describe('model helpers (pure)', () => {
  const settings = { missedPolicy: 'publish_late_or_ask' as const, lateGraceMinutes: 120 };
  const at = new Date('2026-11-13T12:30:00Z');
  const plus = (min: number) => new Date(at.getTime() + min * 60_000);

  it('applies the missed-post policy', () => {
    expect(lateDecision({ scheduledAt: at, nextAttemptAt: null }, settings, plus(3))).toBe(
      'on_time',
    );
    expect(lateDecision({ scheduledAt: at, nextAttemptAt: null }, settings, plus(60))).toBe(
      'publish_late',
    );
    expect(lateDecision({ scheduledAt: at, nextAttemptAt: null }, settings, plus(121))).toBe(
      'missed',
    );
    expect(
      lateDecision(
        { scheduledAt: at, nextAttemptAt: null },
        { ...settings, missedPolicy: 'ask' },
        plus(10),
      ),
    ).toBe('missed');
    expect(
      lateDecision(
        { scheduledAt: at, nextAttemptAt: null },
        { ...settings, missedPolicy: 'publish_late' },
        plus(600),
      ),
    ).toBe('publish_late');
    // A delay the engine chose (retry backoff) that is being honored is not "missed".
    expect(lateDecision({ scheduledAt: at, nextAttemptAt: plus(200) }, settings, plus(201))).toBe(
      'on_time',
    );
  });

  it('backs off 2, 4, 8, 16, 30 minutes and honors Retry-After', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffSec(n))).toEqual([120, 240, 480, 960, 1800, 1800]);
    expect(backoffSec(1, 900)).toBe(900);
  });

  it('knows when a target was handed to a platform', () => {
    const base = { remoteContainerId: null, remoteUploadUri: null, remoteMediaId: null };
    expect(isHandedOver({ ...base, status: 'scheduled' })).toBe(false);
    expect(isHandedOver({ ...base, status: 'prepared' })).toBe(true);
    expect(isHandedOver({ ...base, status: 'failed', remoteMediaId: 'v1' })).toBe(true);
    expect(isHandedOver({ ...base, status: 'published', remoteMediaId: 'v1' })).toBe(false);
  });
});

const tdb = await openTestDb('slots');
if (!tdb) console.warn('TEST_DATABASE_URL is not set: skipping database tests in slots.test.ts');
const SKIP_NOTE = tdb ? '' : ' [skipped: TEST_DATABASE_URL is not set]';

describe.skipIf(!tdb)(`nextFreeSlots (database)${SKIP_NOTE}`, () => {
  const { db } = tdb ?? ({} as TestDb);
  let clock: FakeClock;
  beforeAll(async () => {
    await tdb!.reset();
  });
  beforeEach(async () => {
    await tdb!.reset();
    clock = new FakeClock('2026-11-13T06:00:00Z'); // Fri 13 Nov, 11:30 IST
  });
  afterAll(async () => {
    await tdb?.close();
  });

  it('defaults to daily 18:00 IST from today', async () => {
    const deps = makeDeps(db, clock);
    expect(iso(await nextFreeSlots(deps, { count: 3 }))).toEqual([
      '2026-11-13T12:30:00.000Z',
      '2026-11-14T12:30:00.000Z',
      '2026-11-15T12:30:00.000Z',
    ]);
  });

  it('skips slots less than 15 minutes away', async () => {
    clock.set('2026-11-13T12:20:00Z'); // 17:50 IST
    const deps = makeDeps(db, clock);
    expect(iso(await nextFreeSlots(deps, { count: 1 }))).toEqual(['2026-11-14T12:30:00.000Z']);
  });

  it('uses the weekly grid from a start date', async () => {
    await db.insert(postingSlots).values([
      { weekday: 1, time: '09:00' },
      { weekday: 1, time: '20:30' },
      { weekday: 3, time: '09:00' },
    ]);
    const deps = makeDeps(db, clock);
    expect(iso(await nextFreeSlots(deps, { count: 4, startDate: '2026-11-16' }))).toEqual([
      '2026-11-16T03:30:00.000Z',
      '2026-11-16T15:00:00.000Z',
      '2026-11-18T03:30:00.000Z',
      '2026-11-23T03:30:00.000Z',
    ]);
  });

  it('skips slots within the minimum gap of posts on the same platform', async () => {
    const yt = await seedAccount(db, 'youtube');
    await seedPost(db, {
      platforms: ['youtube'],
      accounts: { youtube: yt },
      target: { status: 'scheduled', scheduledAt: new Date('2026-11-13T12:33:00Z') }, // 18:03 IST
    });
    const deps = makeDeps(db, clock);
    expect(iso(await nextFreeSlots(deps, { count: 1, platforms: ['youtube'] }))).toEqual([
      '2026-11-14T12:30:00.000Z',
    ]);
    // Another platform is not affected by the YouTube post.
    expect(iso(await nextFreeSlots(deps, { count: 1, platforms: ['instagram'] }))).toEqual([
      '2026-11-13T12:30:00.000Z',
    ]);
    // With a 2-minute gap the post 3 minutes away no longer collides.
    await updateSettings(db, { minGapMinutes: 2 });
    expect(iso(await nextFreeSlots(deps, { count: 1, platforms: ['youtube'] }))).toEqual([
      '2026-11-13T12:30:00.000Z',
    ]);
  });

  it('ignores drafts and deleted posts', async () => {
    await seedPost(db, {
      platforms: ['youtube'],
      target: { status: 'draft', scheduledAt: new Date('2026-11-13T12:30:00Z') },
    });
    await seedPost(db, {
      platforms: ['youtube'],
      post: { deletedAt: new Date('2026-11-12T00:00:00Z') },
      target: { status: 'scheduled', scheduledAt: new Date('2026-11-13T12:30:00Z') },
    });
    const deps = makeDeps(db, clock);
    expect(iso(await nextFreeSlots(deps, { count: 1, platforms: ['youtube'] }))).toEqual([
      '2026-11-13T12:30:00.000Z',
    ]);
  });

  it('rejects a malformed start date', async () => {
    const deps = makeDeps(db, clock);
    await expect(nextFreeSlots(deps, { count: 1, startDate: '13/11/2026' })).rejects.toThrow(
      /Invalid date/,
    );
  });
});
