/**
 * Database tests for the Calendar/Settings loaders. Needs a migrated Postgres database:
 *   TEST_DATABASE_URL=postgres://scheduler:scheduler@localhost:5432/test_ui_calendar
 * The tables used here are emptied before each test.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  aiGenerations,
  closeDb,
  getDb,
  mediaAssets,
  mediaFrames,
  postTargets,
  posts,
  type Db,
  type Platform,
  type TargetStatus,
} from '@app/db';
import type { ServiceDeps } from '@app/core/deps';
import { getEnv } from '@app/core/env';
import { createLogger } from '@app/core/log';
import { createPostForAsset } from '@app/core/posts';
import { getSettings } from '@app/core/settings';
import type { Storage } from '@app/core/storage';
import { localToUtc } from '@app/core/time';
import { aiCostThisMonth } from '../settings/data';
import { loadCalendarData } from './data';

const url = process.env.TEST_DATABASE_URL;
const NOW = new Date('2026-11-13T06:00:00Z'); // Fri 13 Nov 2026, 11:30 IST

function fakeDeps(db: Db): ServiceDeps {
  const storage = {
    driver: 'local',
    publicReadUrls: false,
    getReadUrl: async (key: string) => `https://files.test/${key}`,
  } as unknown as Storage;
  return {
    db,
    storage,
    env: getEnv({ NODE_ENV: 'test' }),
    log: createLogger('test'),
    jobs: { send: async () => null },
    now: () => NOW,
  };
}

async function makePost(
  db: Db,
  filename: string,
  at: Date | null,
  targets: Array<{
    platform: Platform;
    status: TargetStatus;
    reason?: 'reconnect' | 'upload_failed';
  }>,
  extra: { body?: string } = {},
) {
  const [asset] = await db
    .insert(mediaAssets)
    .values({
      filename,
      contentType: 'video/mp4',
      sizeBytes: 1,
      originalKey: `uploads/${filename}`,
      status: 'ready',
    })
    .returning();
  const settings = await getSettings(db);
  const { post } = await createPostForAsset(db, {
    assetId: asset!.id,
    platforms: targets.map((t) => t.platform),
    settings,
  });
  await db.update(posts).set({ scheduledAt: at }).where(eq(posts.id, post.id));
  for (const t of targets) {
    await db
      .update(postTargets)
      .set({
        status: t.status,
        attentionReason: t.reason ?? null,
        scheduledAt: at,
        body: extra.body ?? '',
      })
      .where(sql`${postTargets.postId} = ${post.id} and ${postTargets.platform} = ${t.platform}`);
  }
  return { postId: post.id, assetId: asset!.id };
}

describe.skipIf(!url)('calendar + settings loaders (database)', () => {
  const db = url ? getDb(url) : (undefined as unknown as Db);

  beforeEach(async () => {
    await db.execute(
      sql`truncate posts, post_targets, media_assets, media_frames, ai_generations, posting_slots, social_accounts cascade`,
    );
    await getSettings(db);
  });

  afterAll(async () => {
    if (url) await closeDb();
  });

  it('loads a week in IST with drafts, attention items and thumbnails', async () => {
    const tz = 'Asia/Kolkata';
    // Monday 00:15 IST is still Sunday in UTC: must be in this week.
    const early = await makePost(db, 'early.mp4', localToUtc('2026-11-09', '00:15', tz), [
      { platform: 'instagram', status: 'scheduled' },
    ]);
    // Next Monday 00:15 IST: outside.
    await makePost(db, 'next-week.mp4', localToUtc('2026-11-16', '00:15', tz), [
      { platform: 'instagram', status: 'scheduled' },
    ]);
    const broken = await makePost(db, 'broken.mp4', localToUtc('2026-11-14', '18:00', tz), [
      { platform: 'instagram', status: 'scheduled' },
      { platform: 'youtube', status: 'needs_reauth', reason: 'reconnect' },
    ]);
    const draft = await makePost(db, 'draft.mp4', null, [
      { platform: 'facebook', status: 'draft' },
    ]);
    await db.insert(mediaFrames).values([
      {
        assetId: early.assetId,
        idx: 3,
        tMs: 3000,
        key: 'frames/e/03.jpg',
        width: 1,
        height: 1,
        source: 'uniform',
      },
      {
        assetId: early.assetId,
        idx: 0,
        tMs: 500,
        key: 'frames/e/00.jpg',
        width: 1,
        height: 1,
        source: 'hook',
      },
    ]);

    const data = await loadCalendarData(fakeDeps(db), {
      view: 'week',
      date: '2026-11-13',
      filter: null,
      query: '',
    });

    expect(data.today).toBe('2026-11-13');
    expect(data.tzLabel).toBe('IST');
    expect(data.posts.map((p) => p.filename).sort()).toEqual(['broken.mp4', 'early.mp4']);
    const e = data.posts.find((p) => p.id === early.postId)!;
    expect(e.localDate).toBe('2026-11-09');
    expect(e.localTime).toBe('00:15');
    expect(e.thumbUrl).toBe('https://files.test/frames/e/00.jpg');
    const b = data.posts.find((p) => p.id === broken.postId)!;
    expect(b.display).toBe('needs_attention');
    expect(b.thumbUrl).toBeNull();
    expect(data.drafts.map((p) => p.id)).toEqual([draft.postId]);
    expect(data.attention).toHaveLength(1);
    expect(data.attention[0]).toMatchObject({
      postId: broken.postId,
      platform: 'youtube',
      reconnect: true,
      message: 'Reconnect YouTube',
    });
  });

  it('filters and searches the list view', async () => {
    await makePost(db, 'goa_beach.mp4', localToUtc('2026-11-10', '18:00', 'Asia/Kolkata'), [
      { platform: 'instagram', status: 'published' },
    ]);
    await makePost(db, 'gym.mp4', null, [{ platform: 'instagram', status: 'draft' }], {
      body: 'Aaj PR toot gaya',
    });
    const deps = fakeDeps(db);
    const load = (filter: 'published' | 'unscheduled' | null, query = '') =>
      loadCalendarData(deps, { view: 'list', date: null, filter, query });

    expect((await load(null)).posts.map((p) => p.filename)).toEqual(['gym.mp4', 'goa_beach.mp4']);
    expect((await load('published')).posts.map((p) => p.filename)).toEqual(['goa_beach.mp4']);
    expect((await load('unscheduled')).posts.map((p) => p.filename)).toEqual(['gym.mp4']);
    expect((await load(null, 'toot')).posts.map((p) => p.filename)).toEqual(['gym.mp4']);
    expect((await load('published', 'toot')).posts).toHaveLength(0);
  });

  it('sums AI cost since the 1st of the month in the app time zone', async () => {
    const { assetId } = await makePost(db, 'a.mp4', null, [
      { platform: 'instagram', status: 'draft' },
    ]);
    const base = { assetId, kind: 'full' as const, model: 'm', promptVersion: 'v1' };
    await db.insert(aiGenerations).values([
      // 1 Nov 00:10 IST = 31 Oct 18:40 UTC: counts in November (IST).
      { ...base, costUsd: 0.05, createdAt: new Date('2026-10-31T18:40:00Z') },
      { ...base, costUsd: 0.02, createdAt: new Date('2026-11-12T10:00:00Z') },
      // 31 Oct 23:00 IST: October.
      { ...base, costUsd: 1, createdAt: new Date('2026-10-31T17:30:00Z') },
    ]);
    expect(await aiCostThisMonth(fakeDeps(db), 'Asia/Kolkata')).toBeCloseTo(0.07, 5);
  });
});

if (!url) {
  // eslint-disable-next-line no-console
  console.warn('Skipping database tests: set TEST_DATABASE_URL to a migrated database.');
}
