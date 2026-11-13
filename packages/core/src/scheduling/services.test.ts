import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { apiCalls, posts, socialAccounts, type Platform, type SocialAccount } from '@app/db';
import {
  deletePost,
  moveToDrafts,
  reschedulePost,
  retryTarget,
  schedulePosts,
  updateTargetText,
} from './services';
import {
  FakeClock,
  getTarget,
  makeDeps,
  openTestDb,
  seedAccount,
  seedPost,
  type TestDb,
} from './test-helpers';

const tdb = await openTestDb('services');
if (!tdb) console.warn('TEST_DATABASE_URL is not set: skipping database tests in services.test.ts');
const SKIP_NOTE = tdb ? '' : ' [skipped: TEST_DATABASE_URL is not set]';

const ALL: Platform[] = ['instagram', 'youtube', 'facebook'];

describe.skipIf(!tdb)(`scheduling services${SKIP_NOTE}`, () => {
  const { db } = tdb ?? ({} as TestDb);
  let clock: FakeClock;
  let accounts: Record<Platform, SocialAccount>;
  const seed = (
    opts: Omit<Parameters<typeof seedPost>[1], 'platforms'> & { platforms?: Platform[] } = {},
  ) => seedPost(db, { platforms: ALL, accounts, ...opts });

  beforeEach(async () => {
    await tdb!.reset();
    clock = new FakeClock('2026-11-13T06:00:00Z'); // Fri 13 Nov 2026, 11:30 IST
    accounts = {
      instagram: await seedAccount(db, 'instagram'),
      youtube: await seedAccount(db, 'youtube'),
      facebook: await seedAccount(db, 'facebook'),
    };
  });
  afterAll(async () => {
    await tdb?.close();
  });

  const getPost = async (id: string) => (await db.select().from(posts).where(eq(posts.id, id)))[0]!;

  describe('schedulePosts', () => {
    it('fills the next free slots in card order and queues an immediate dispatch', async () => {
      const second = await seed({ asset: { sortIndex: 2 } });
      const first = await seed({ asset: { sortIndex: 1 } });
      const deps = makeDeps(db, clock);

      const res = await schedulePosts(deps, {
        postIds: [second.post.id, first.post.id],
        mode: 'next_free',
      });

      expect(res.skipped).toEqual([]);
      expect(res.scheduled).toEqual([
        { postId: first.post.id, at: new Date('2026-11-13T12:30:00Z') },
        { postId: second.post.id, at: new Date('2026-11-14T12:30:00Z') },
      ]);
      for (const t of Object.values(first.targets)) {
        const row = await getTarget(db, t.id);
        expect(row).toMatchObject({
          status: 'scheduled',
          publishMode: null,
          prepareAt: null,
          needsSync: false,
        });
        expect(row.scheduledAt).toEqual(new Date('2026-11-13T12:30:00Z'));
        expect(row.version).toBe(t.version + 1);
      }
      const post = await getPost(first.post.id);
      expect(post.approvedAt).toEqual(clock.now());
      expect(post.scheduledAt).toEqual(new Date('2026-11-13T12:30:00Z'));
      expect(deps.jobs.of('dispatch')).toHaveLength(1);
      expect(deps.jobs.of('dispatch')[0]!.options).toEqual({ singletonKey: 'dispatch-now' });
    });

    it('keeps a post in its own slot when it is scheduled again', async () => {
      const p = await seed();
      const deps = makeDeps(db, clock);
      await schedulePosts(deps, { postIds: [p.post.id], mode: 'next_free' });
      const again = await schedulePosts(deps, { postIds: [p.post.id], mode: 'next_free' });
      expect(again.scheduled).toEqual([
        { postId: p.post.id, at: new Date('2026-11-13T12:30:00Z') },
      ]);
    });

    it('uses a different time per app when asked', async () => {
      const p = await seed({ platforms: ['instagram', 'youtube'] });
      const deps = makeDeps(db, clock);
      const ig = new Date('2026-11-14T13:00:00Z');
      const yt = new Date('2026-11-14T12:00:00Z');
      const res = await schedulePosts(deps, {
        postIds: [p.post.id],
        mode: 'pick',
        at: ig,
        perPlatformAt: { youtube: yt },
      });
      expect(res.scheduled).toEqual([{ postId: p.post.id, at: yt }]);
      expect((await getTarget(db, p.targets.instagram.id)).scheduledAt).toEqual(ig);
      expect((await getTarget(db, p.targets.youtube.id)).scheduledAt).toEqual(yt);
    });

    it('leaves targets with problems as drafts and says why', async () => {
      await db
        .update(socialAccounts)
        .set({ status: 'needs_reauth' })
        .where(eq(socialAccounts.id, accounts.instagram.id));
      const p = await seed({
        accounts: { ...accounts, facebook: null },
        perTarget: { youtube: { title: '' } },
      });
      const deps = makeDeps(db, clock);
      // Facebook has no account on the target and none connected → not connected.
      await db.delete(socialAccounts).where(eq(socialAccounts.id, accounts.facebook.id));

      const res = await schedulePosts(deps, {
        postIds: [p.post.id],
        mode: 'pick',
        at: new Date('2026-11-14T12:30:00Z'),
      });

      expect(res.scheduled).toEqual([]);
      expect(res.skipped[0]!.reason).toMatch(/Instagram needs reconnecting/);
      expect(res.skipped[0]!.reason).toMatch(/YouTube: Title is required/);
      expect(res.skipped[0]!.reason).toMatch(/Facebook is not connected/);
      for (const t of Object.values(p.targets))
        expect((await getTarget(db, t.id)).status).toBe('draft');
      expect(res.warnings).toHaveLength(3);
    });

    it('skips only the platform a video warning blocks', async () => {
      const p = await seed({
        asset: {
          warnings: [
            {
              code: 'fb_reel_too_long',
              platform: 'facebook',
              severity: 'block',
              message: 'Too long for a Facebook Reel.',
            },
          ],
        },
      });
      const deps = makeDeps(db, clock);
      const res = await schedulePosts(deps, { postIds: [p.post.id], mode: 'next_free' });
      expect(res.scheduled).toHaveLength(1);
      expect(res.warnings.join(' ')).toMatch(/Facebook: Too long for a Facebook Reel/);
      expect((await getTarget(db, p.targets.facebook.id)).status).toBe('draft');
      expect((await getTarget(db, p.targets.youtube.id)).status).toBe('scheduled');
    });

    it('attaches the platform account connected after the upload', async () => {
      const p = await seed({ platforms: ['youtube'], accounts: { youtube: null } });
      const deps = makeDeps(db, clock);
      const res = await schedulePosts(deps, { postIds: [p.post.id], mode: 'next_free' });
      expect(res.scheduled).toHaveLength(1);
      expect((await getTarget(db, p.targets.youtube.id)).socialAccountId).toBe(accounts.youtube.id);
    });

    it('skips videos that are not ready, deleted posts, unknown ids and past times', async () => {
      const processing = await seed({ asset: { status: 'processing' } });
      const deleted = await seed({ post: { deletedAt: new Date('2026-11-12T00:00:00Z') } });
      const ok = await seed();
      const deps = makeDeps(db, clock);
      const res = await schedulePosts(deps, {
        postIds: [processing.post.id, deleted.post.id, '00000000-0000-0000-0000-000000000000'],
        mode: 'next_free',
      });
      expect(res.scheduled).toEqual([]);
      expect(res.skipped.map((s) => s.reason).sort()).toEqual([
        'Post not found.',
        'Post was deleted.',
        'The video is still processing.',
      ]);
      expect(deps.jobs.of('dispatch')).toHaveLength(0);

      const past = await schedulePosts(deps, {
        postIds: [ok.post.id],
        mode: 'pick',
        at: new Date('2026-11-13T05:00:00Z'),
      });
      expect(past.scheduled).toEqual([]);
      expect(past.warnings[0]).toMatch(/already passed/);
    });

    it('re-scheduling something already handed over marks it for sync instead of uploading again', async () => {
      const p = await seed({
        platforms: ['youtube'],
        target: {
          status: 'prepared',
          publishMode: 'native',
          remoteMediaId: 'vid1',
          scheduledAt: new Date('2026-11-14T12:30:00Z'),
        },
      });
      const deps = makeDeps(db, clock);
      await schedulePosts(deps, {
        postIds: [p.post.id],
        mode: 'pick',
        at: new Date('2026-11-15T12:30:00Z'),
      });
      const t = await getTarget(db, p.targets.youtube.id);
      expect(t).toMatchObject({ status: 'prepared', needsSync: true, remoteMediaId: 'vid1' });
      expect(t.scheduledAt).toEqual(new Date('2026-11-15T12:30:00Z'));
    });

    it('"Save as draft" keeps the date, pauses scheduled targets and cancels handed-over ones', async () => {
      const p = await seed({
        platforms: ['instagram', 'youtube'],
        post: { approvedAt: new Date('2026-11-12T00:00:00Z') },
        perTarget: {
          instagram: { status: 'scheduled', scheduledAt: new Date('2026-11-14T12:30:00Z') },
          youtube: {
            status: 'prepared',
            publishMode: 'native',
            remoteMediaId: 'vid1',
            scheduledAt: new Date('2026-11-14T12:30:00Z'),
          },
        },
      });
      const deps = makeDeps(db, clock);
      const at = new Date('2026-11-20T12:30:00Z');
      await schedulePosts(deps, { postIds: [p.post.id], mode: 'draft', at });
      for (const t of Object.values(p.targets)) {
        const row = await getTarget(db, t.id);
        expect(row.status).toBe('draft');
        expect(row.scheduledAt).toEqual(at);
      }
      expect(deps.jobs.of('cancel-target').map((j) => j.data.targetId)).toEqual([
        p.targets.youtube.id,
      ]);
      expect((await getPost(p.post.id)).approvedAt).toBeNull();
    });

    it('warns when Facebook would get more than 30 Reels in 24 hours', async () => {
      for (let i = 0; i < 30; i++) {
        await seed({
          platforms: ['facebook'],
          target: { status: 'scheduled', scheduledAt: new Date(Date.UTC(2026, 10, 14, 0, i * 10)) },
        });
      }
      const p = await seed({ platforms: ['facebook'] });
      const deps = makeDeps(db, clock);
      const res = await schedulePosts(deps, {
        postIds: [p.post.id],
        mode: 'pick',
        at: new Date('2026-11-14T12:30:00Z'),
      });
      expect(res.scheduled).toHaveLength(1);
      expect(res.warnings.join('\n')).toMatch(/Facebook: 31 posts within 24 hours/);
    });

    it('says how YouTube uploads are spread and flags posts that cannot be uploaded in time', async () => {
      // 50 uploads already made in today's Pacific day (Thu 12 Nov PST).
      await db.insert(apiCalls).values(
        Array.from({ length: 50 }, () => ({
          platform: 'youtube' as const,
          kind: 'yt_insert' as const,
          at: new Date('2026-11-13T05:00:00Z'),
        })),
      );
      const later = await seed({ platforms: ['youtube'] });
      const soon = await seed({ platforms: ['youtube'] });
      const deps = makeDeps(db, clock);

      const res1 = await schedulePosts(deps, {
        postIds: [later.post.id],
        mode: 'pick',
        at: new Date('2026-11-14T12:30:00Z'),
      });
      expect(res1.warnings.join('\n')).toMatch(
        /uploads are spread out: 1 from Fri 13 Nov, 13:30 IST/,
      );
      expect((await getTarget(db, later.targets.youtube.id)).status).toBe('scheduled');

      // Next upload slot opens at Pacific midnight (08:00Z); 07:00Z is too early.
      const res2 = await schedulePosts(deps, {
        postIds: [soon.post.id],
        mode: 'pick',
        at: new Date('2026-11-13T07:00:00Z'),
      });
      expect(res2.warnings.join('\n')).toMatch(/can't be uploaded in time/);
      expect(await getTarget(db, soon.targets.youtube.id)).toMatchObject({
        status: 'failed',
        attentionReason: 'quota',
      });
    });
  });

  describe('reschedulePost', () => {
    it('moves scheduled targets, syncs handed-over ones and never touches published ones', async () => {
      const p = await seed({
        perTarget: {
          instagram: {
            status: 'scheduled',
            publishMode: 'app',
            prepareAt: new Date('2026-11-14T12:15:00Z'),
            scheduledAt: new Date('2026-11-14T12:30:00Z'),
          },
          youtube: {
            status: 'prepared',
            publishMode: 'native',
            remoteMediaId: 'vid1',
            scheduledAt: new Date('2026-11-14T12:30:00Z'),
          },
          facebook: {
            status: 'published',
            scheduledAt: new Date('2026-11-12T12:30:00Z'),
            publishedAt: new Date('2026-11-12T12:30:00Z'),
          },
        },
      });
      const deps = makeDeps(db, clock);
      const at = new Date('2026-11-16T12:30:00Z');
      await reschedulePost(deps, { postId: p.post.id, at });
      expect(await getTarget(db, p.targets.instagram.id)).toMatchObject({
        scheduledAt: at,
        publishMode: null,
        prepareAt: null,
        status: 'scheduled',
      });
      expect(await getTarget(db, p.targets.youtube.id)).toMatchObject({
        scheduledAt: at,
        needsSync: true,
        status: 'prepared',
      });
      expect((await getTarget(db, p.targets.facebook.id)).scheduledAt).toEqual(
        new Date('2026-11-12T12:30:00Z'),
      );
      expect((await getPost(p.post.id)).scheduledAt).toEqual(at);
      expect(deps.jobs.of('dispatch')).toHaveLength(1);
    });

    it('moves one platform only and refuses while it is publishing or for a past time', async () => {
      const p = await seed({
        target: { status: 'scheduled', scheduledAt: new Date('2026-11-14T12:30:00Z') },
        perTarget: {
          facebook: { status: 'publishing', lockedUntil: new Date('2026-11-13T06:10:00Z') },
        },
      });
      const deps = makeDeps(db, clock);
      const at = new Date('2026-11-14T15:00:00Z');
      await reschedulePost(deps, { postId: p.post.id, at, platform: 'youtube' });
      expect((await getTarget(db, p.targets.youtube.id)).scheduledAt).toEqual(at);
      expect((await getTarget(db, p.targets.instagram.id)).scheduledAt).toEqual(
        new Date('2026-11-14T12:30:00Z'),
      );
      await expect(
        reschedulePost(deps, { postId: p.post.id, at, platform: 'facebook' }),
      ).rejects.toMatchObject({ code: 'locked' });
      await expect(
        reschedulePost(deps, { postId: p.post.id, at: new Date('2026-11-13T05:00:00Z') }),
      ).rejects.toMatchObject({ code: 'invalid' });
    });
  });

  describe('moveToDrafts / deletePost', () => {
    const handedOver = () =>
      seed({
        post: { approvedAt: new Date('2026-11-12T00:00:00Z') },
        perTarget: {
          instagram: { status: 'scheduled', scheduledAt: new Date('2026-11-14T12:30:00Z') },
          youtube: {
            status: 'prepared',
            publishMode: 'native',
            remoteMediaId: 'vid1',
            scheduledAt: new Date('2026-11-14T12:30:00Z'),
          },
          facebook: {
            status: 'published',
            remoteMediaId: 'fb1',
            publishedAt: new Date('2026-11-12T12:30:00Z'),
          },
        },
      });

    it('moveToDrafts pauses everything not published and cancels what the platform holds', async () => {
      const p = await handedOver();
      const deps = makeDeps(db, clock);
      await moveToDrafts(deps, { postId: p.post.id });
      expect(await getTarget(db, p.targets.instagram.id)).toMatchObject({
        status: 'draft',
        scheduledAt: new Date('2026-11-14T12:30:00Z'),
      });
      expect(await getTarget(db, p.targets.youtube.id)).toMatchObject({
        status: 'draft',
        remoteMediaId: 'vid1',
      });
      expect((await getTarget(db, p.targets.facebook.id)).status).toBe('published');
      expect(deps.jobs.of('cancel-target').map((j) => j.data.targetId)).toEqual([
        p.targets.youtube.id,
      ]);
      expect(deps.jobs.of('cancel-target')[0]!.options).toEqual({
        singletonKey: p.targets.youtube.id,
      });
      expect((await getPost(p.post.id)).approvedAt).toBeNull();
    });

    it('deletePost soft-deletes, cancels and is idempotent', async () => {
      const p = await handedOver();
      const deps = makeDeps(db, clock);
      await deletePost(deps, { postId: p.post.id });
      expect((await getPost(p.post.id)).deletedAt).toEqual(clock.now());
      expect((await getTarget(db, p.targets.instagram.id)).status).toBe('canceled');
      expect((await getTarget(db, p.targets.youtube.id)).status).toBe('canceled');
      expect((await getTarget(db, p.targets.facebook.id)).status).toBe('published');
      expect(deps.jobs.of('cancel-target').map((j) => j.data.targetId)).toEqual([
        p.targets.youtube.id,
      ]);
      expect(deps.jobs.of('dispatch')).toHaveLength(1);
      await deletePost(deps, { postId: p.post.id });
      expect(deps.jobs.of('cancel-target')).toHaveLength(1);
    });
  });

  describe('updateTargetText', () => {
    it('saves manual edits, bumps the version and returns the limit issues', async () => {
      const p = await seed({ platforms: ['instagram'] });
      const deps = makeDeps(db, clock);
      const t = p.targets.instagram;
      const res = await updateTargetText(deps, {
        targetId: t.id,
        patch: {
          body: 'Naya caption',
          hashtags: ['#Goa Trip', 'goatrip', 'a', 'b', 'c', 'd', 'e'],
        },
        expectedVersion: t.version,
      });
      expect(res.version).toBe(t.version + 1);
      expect(res.issues.map((i) => i.code)).toEqual(['too_many_hashtags']);
      const row = await getTarget(db, t.id);
      expect(row.body).toBe('Naya caption');
      expect(row.hashtags).toEqual(['GoaTrip', 'a', 'b', 'c', 'd', 'e']);
      expect(row.textSources).toEqual({ body: 'manual', hashtags: 'manual' });
      expect(deps.jobs.sent).toHaveLength(0); // nothing handed over: no sync
    });

    it('rejects a stale editor and published or publishing targets', async () => {
      const p = await seed({
        perTarget: { youtube: { status: 'published' }, facebook: { status: 'publishing' } },
      });
      const deps = makeDeps(db, clock);
      const ig = p.targets.instagram;
      await updateTargetText(deps, {
        targetId: ig.id,
        patch: { body: 'one' },
        expectedVersion: ig.version,
      });
      await expect(
        updateTargetText(deps, {
          targetId: ig.id,
          patch: { body: 'two' },
          expectedVersion: ig.version,
        }),
      ).rejects.toMatchObject({
        code: 'version_conflict',
      });
      await expect(
        updateTargetText(deps, { targetId: p.targets.youtube.id, patch: { title: 'x' } }),
      ).rejects.toMatchObject({ code: 'locked' });
      await expect(
        updateTargetText(deps, { targetId: p.targets.facebook.id, patch: { body: 'x' } }),
      ).rejects.toMatchObject({ code: 'locked' });
    });

    it('clears an AI failure back to draft once the text is valid', async () => {
      const p = await seed({
        platforms: ['youtube'],
        target: { status: 'failed', attentionReason: 'write_manually', title: '', body: '' },
      });
      const deps = makeDeps(db, clock);
      const t = p.targets.youtube;
      await updateTargetText(deps, { targetId: t.id, patch: { body: 'Story only' } });
      expect((await getTarget(db, t.id)).status).toBe('failed'); // title still empty → still blocked
      await updateTargetText(deps, { targetId: t.id, patch: { title: 'Ek kahani' } });
      expect(await getTarget(db, t.id)).toMatchObject({
        status: 'draft',
        attentionReason: null,
        title: 'Ek kahani',
      });
    });

    it('marks handed-over targets for sync and wakes the dispatcher', async () => {
      const p = await seed({
        platforms: ['youtube'],
        target: { status: 'prepared', publishMode: 'native', remoteMediaId: 'vid1' },
      });
      const deps = makeDeps(db, clock);
      await updateTargetText(deps, {
        targetId: p.targets.youtube.id,
        patch: { tags: ['goa', 'Goa', ' travel '], options: { privacy: 'unlisted' } },
      });
      const row = await getTarget(db, p.targets.youtube.id);
      expect(row).toMatchObject({ needsSync: true, status: 'prepared', tags: ['goa', 'travel'] });
      expect(row.options.privacy).toBe('unlisted');
      expect(deps.jobs.of('dispatch')).toHaveLength(1);
    });
  });

  describe('retryTarget', () => {
    it('"Retry now" on a missed post publishes it now', async () => {
      const p = await seed({
        platforms: ['instagram'],
        target: {
          status: 'missed',
          attentionReason: 'missed',
          publishMode: 'app',
          scheduledAt: new Date('2026-11-13T02:00:00Z'),
        },
      });
      const deps = makeDeps(db, clock);
      await retryTarget(deps, { targetId: p.targets.instagram.id, mode: 'now' });
      const row = await getTarget(db, p.targets.instagram.id);
      expect(row).toMatchObject({
        status: 'scheduled',
        attentionReason: null,
        publishMode: null,
        attempts: 0,
      });
      expect(row.scheduledAt).toEqual(clock.now());
      expect((await getPost(p.post.id)).approvedAt).toEqual(clock.now());
      expect(deps.jobs.of('dispatch')).toHaveLength(1);
      expect(deps.jobs.of('reconcile-target')).toHaveLength(0);
    });

    it('"Retry now" checks the platform first when something reached it', async () => {
      const p = await seed({
        platforms: ['youtube'],
        target: {
          status: 'failed',
          attentionReason: 'platform_error',
          publishMode: 'native',
          remoteMediaId: 'vid1',
          scheduledAt: new Date('2026-11-14T12:30:00Z'),
          attempts: 6,
        },
      });
      const deps = makeDeps(db, clock);
      await retryTarget(deps, { targetId: p.targets.youtube.id, mode: 'now' });
      const row = await getTarget(db, p.targets.youtube.id);
      expect(row).toMatchObject({ status: 'scheduled', attempts: 0, remoteMediaId: 'vid1' });
      expect(row.scheduledAt).toEqual(new Date('2026-11-14T12:30:00Z')); // future time kept
      expect(row.nextAttemptAt).toEqual(new Date(clock.now().getTime() + 2 * 60_000));
      expect(deps.jobs.of('reconcile-target').map((j) => j.data.targetId)).toEqual([
        p.targets.youtube.id,
      ]);
    });

    it('"Next free slot" moves it to the next free slot for its platform', async () => {
      const p = await seed({
        platforms: ['youtube'],
        target: {
          status: 'failed',
          attentionReason: 'quota',
          scheduledAt: new Date('2026-11-13T07:00:00Z'),
        },
      });
      const deps = makeDeps(db, clock);
      await retryTarget(deps, { targetId: p.targets.youtube.id, mode: 'next_free' });
      expect(await getTarget(db, p.targets.youtube.id)).toMatchObject({
        status: 'scheduled',
        scheduledAt: new Date('2026-11-13T12:30:00Z'),
      });
    });

    it('refuses drafts and accounts that still need reconnecting', async () => {
      const p = await seed({
        perTarget: {
          instagram: { status: 'draft' },
          youtube: { status: 'needs_reauth', scheduledAt: new Date('2026-11-14T12:30:00Z') },
        },
      });
      await db
        .update(socialAccounts)
        .set({ status: 'needs_reauth' })
        .where(eq(socialAccounts.id, accounts.youtube.id));
      const deps = makeDeps(db, clock);
      await expect(
        retryTarget(deps, { targetId: p.targets.instagram.id, mode: 'now' }),
      ).rejects.toMatchObject({ code: 'invalid' });
      await expect(
        retryTarget(deps, { targetId: p.targets.youtube.id, mode: 'now' }),
      ).rejects.toThrow(/YouTube needs reconnecting/);
    });
  });
});
