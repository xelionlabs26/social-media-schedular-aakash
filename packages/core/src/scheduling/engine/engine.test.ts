import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import {
  apiCalls,
  mediaAssets,
  postTargets,
  posts,
  publishAttempts,
  socialAccounts,
  type Platform,
  type SocialAccount,
} from '@app/db';
import { PlatformError, type Integrations } from '../../platforms';
import { purgeAssetMedia } from '../../media';
import { updateSettings } from '../../settings';
import { LocalStorage } from '../../storage';
import { deletePost, moveToDrafts, updateTargetText } from '../services';
import {
  FakeClock,
  FakePublisher,
  fakeIntegration,
  getTarget,
  makeDeps,
  openTestDb,
  runJobs,
  seedAccount,
  seedPost,
  type TestDb,
} from '../test-helpers';
import { createEngine, type Engine } from './index';

vi.mock('../../media', () => ({ purgeAssetMedia: vi.fn(async () => undefined) }));

const tdb = await openTestDb('engine');
if (!tdb) console.warn('TEST_DATABASE_URL is not set: skipping database tests in engine.test.ts');
const SKIP_NOTE = tdb ? '' : ' [skipped: TEST_DATABASE_URL is not set]';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe.skipIf(!tdb)(`publishing engine${SKIP_NOTE}`, () => {
  const { db } = tdb ?? ({} as TestDb);
  let clock: FakeClock;
  let deps: ReturnType<typeof makeDeps>;
  let engine: Engine;
  let yt: FakePublisher;
  let ig: FakePublisher;
  let fb: FakePublisher;
  let integrations: Integrations;
  let accounts: Record<Platform, SocialAccount>;

  const at = (offsetMs: number) => new Date(clock.now().getTime() + offsetMs);
  const run = () => runJobs(deps.jobs, engine, clock);
  const tick = async (ms = 0) => {
    clock.advance(ms);
    await engine.dispatch();
    await run();
  };
  /** A post the owner already approved, scheduled on the given platforms. */
  const scheduled = (
    platforms: Platform[],
    scheduledAt: Date,
    extra: Parameters<typeof seedPost>[1]['target'] = {},
  ) =>
    seedPost(db, {
      platforms,
      accounts,
      post: { approvedAt: clock.now(), scheduledAt },
      target: { status: 'scheduled', scheduledAt, ...extra },
    });
  const rebuild = (env: Record<string, string> = {}) => {
    deps = makeDeps(db, clock, env);
    engine = createEngine(deps, integrations);
  };
  const attempts = (targetId: string) =>
    db.select().from(publishAttempts).where(eq(publishAttempts.targetId, targetId));

  beforeEach(async () => {
    await tdb!.reset();
    clock = new FakeClock('2026-11-13T06:00:00Z'); // Fri 13 Nov 2026, 11:30 IST (Thu 22:00 PST)
    accounts = {
      instagram: await seedAccount(db, 'instagram'),
      youtube: await seedAccount(db, 'youtube'),
      facebook: await seedAccount(db, 'facebook'),
    };
    yt = new FakePublisher('youtube', 'native', { supportsUpdate: true });
    ig = new FakePublisher('instagram', 'app');
    fb = new FakePublisher('facebook', 'native');
    integrations = {
      youtube: fakeIntegration(yt),
      instagram: fakeIntegration(ig),
      facebook: fakeIntegration(fb),
    };
    rebuild();
  });
  afterAll(async () => {
    await tdb?.close();
  });

  describe('happy paths', () => {
    it('native (YouTube-like): uploads early, then verifies after the time', async () => {
      const T = new Date('2026-11-14T12:30:00Z');
      const p = await scheduled(['youtube'], T, { title: 'Goa <sunset> twist', hashtags: ['goa'] });
      const id = p.targets.youtube.id;

      await tick();
      let t = await getTarget(db, id);
      expect(t).toMatchObject({
        status: 'prepared',
        publishMode: 'native',
        lockedUntil: null,
        remoteMediaId: `video-youtube-${id.slice(0, 8)}`,
      });
      expect(yt.calls[0]).toMatchObject({ method: 'prepare', mode: 'native', scheduledAt: T });
      expect(yt.calls[0]!.text.title).toBe('Goa sunset twist');
      expect(yt.calls[0]!.text.body).toBe('Socha tha normal sunset hoga…\n\n#goa');
      const calls = await db.select().from(apiCalls);
      expect(calls).toMatchObject([
        { kind: 'yt_insert', targetId: id, socialAccountId: accounts.youtube.id },
      ]);

      // Nothing more until 5 minutes after the time.
      clock.set(new Date(T.getTime() + 4 * MIN));
      await tick();
      expect(yt.count('publish')).toBe(0);
      await tick(MIN);
      t = await getTarget(db, id);
      expect(t).toMatchObject({
        status: 'published',
        remoteUrl: `https://youtube.test/p/youtube-${id.slice(0, 8)}`,
      });
      expect(t.publishedAt).toEqual(clock.now());
    });

    it('app (Instagram-like): container 15 minutes before, publish at the time', async () => {
      const T = at(HOUR);
      const p = await scheduled(['instagram'], T);
      const id = p.targets.instagram.id;

      await tick();
      expect(await getTarget(db, id)).toMatchObject({
        status: 'scheduled',
        publishMode: 'app',
        prepareAt: new Date(T.getTime() - 15 * MIN),
      });
      expect(ig.calls).toHaveLength(0);

      await tick(45 * MIN);
      expect(await getTarget(db, id)).toMatchObject({
        status: 'prepared',
        remoteContainerId: `container-instagram-${id.slice(0, 8)}`,
      });

      await tick(14 * MIN);
      expect(ig.count('publish')).toBe(0);
      await tick(MIN);
      expect(await getTarget(db, id)).toMatchObject({
        status: 'published',
        remoteMediaId: `media-instagram-${id.slice(0, 8)}`,
      });
      expect(ig.count('publish')).toBe(1);
      expect(ig.count('reconcile')).toBe(0);
      const history = await attempts(id);
      expect(history.find((a) => a.step === 'publish')).toMatchObject({
        outcome: 'ok',
        message: 'Published.',
      });
    });

    it("re-queues the same job after 'wait'", async () => {
      ig.script.prepare.push({ kind: 'wait', retryInSec: 30, reason: 'IN_PROGRESS' });
      const p = await scheduled(['instagram'], at(15 * MIN));
      const id = p.targets.instagram.id;

      await tick();
      const t = await getTarget(db, id);
      expect(t).toMatchObject({ status: 'scheduled', lockedUntil: null });
      expect(t.nextAttemptAt).toEqual(at(30_000));
      const again = deps.jobs.of('prepare-target').at(-1)!;
      expect(again.options).toEqual({ singletonKey: id, startAfter: 30 });

      await run(); // not yet due
      expect(ig.count('prepare')).toBe(1);
      clock.advance(30_000);
      await run();
      expect(ig.count('prepare')).toBe(2);
      expect((await getTarget(db, id)).status).toBe('prepared');
    });
  });

  describe('errors', () => {
    it('backs off on retryable errors and gives up after 6 tries', async () => {
      for (let i = 0; i < 6; i++)
        yt.script.prepare.push(
          new PlatformError('retryable', 'Backend error', { httpStatus: 503 }),
        );
      const p = await scheduled(['youtube'], new Date('2026-11-14T12:30:00Z'));
      const id = p.targets.youtube.id;

      await tick();
      for (const [i, delaySec] of [120, 240, 480, 960, 1800].entries()) {
        const t = await getTarget(db, id);
        expect(t).toMatchObject({
          status: 'scheduled',
          attempts: i + 1,
          lastError: 'Backend error',
        });
        expect(t.nextAttemptAt).toEqual(at(delaySec * 1000));
        await tick(delaySec * 1000);
      }
      const t = await getTarget(db, id);
      expect(t).toMatchObject({ status: 'failed', attentionReason: 'platform_error', attempts: 6 });
      expect(t.lastError).toMatch(/gave up after 6 tries/);
      expect(yt.count('prepare')).toBe(6);
      expect(deps.jobs.alerts()).toMatchObject([{ kind: 'publish_failed', targetId: id }]);
      expect(deps.jobs.alerts()[0]!.message).toMatch(/^YouTube: '.+' failed: Backend error/);
    });

    it('auth errors pause the account and its pending posts, which resume after reconnecting', async () => {
      ig.script.prepare.push(
        new PlatformError('auth', 'Error validating access token', { code: '190' }),
      );
      const a = await scheduled(['instagram'], at(15 * MIN));
      const b = await scheduled(['instagram'], at(26 * HOUR));

      await tick();
      expect(await getTarget(db, a.targets.instagram.id)).toMatchObject({
        status: 'needs_reauth',
        attentionReason: 'reconnect',
      });
      expect(await getTarget(db, b.targets.instagram.id)).toMatchObject({ status: 'needs_reauth' });
      const [account] = await db
        .select()
        .from(socialAccounts)
        .where(eq(socialAccounts.id, accounts.instagram.id));
      expect(account!.status).toBe('needs_reauth');
      const alerts = deps.jobs.alerts().filter((x) => x.kind === 'needs_reauth');
      expect(alerts.length).toBeGreaterThanOrEqual(1);
      expect(new Set(alerts.map((x) => x.dedupeKey)).size).toBe(1);

      // Owner reconnects.
      await db
        .update(socialAccounts)
        .set({ status: 'active' })
        .where(eq(socialAccounts.id, accounts.instagram.id));
      await tick();
      expect((await getTarget(db, a.targets.instagram.id)).status).toBe('prepared');
      expect((await getTarget(db, b.targets.instagram.id)).status).toBe('scheduled');
    });

    it('invalid and fatal errors need attention with the right reason', async () => {
      yt.script.prepare.push(
        new PlatformError('invalid', 'The request metadata specifies an invalid video title.', {
          code: 'invalidTitle',
        }),
      );
      fb.script.prepare.push(new PlatformError('fatal', 'Permission denied', { code: '200' }));
      const y = await scheduled(['youtube'], at(26 * HOUR));
      const f = await scheduled(['facebook'], at(26 * HOUR));
      await tick();
      expect(await getTarget(db, y.targets.youtube.id)).toMatchObject({
        status: 'failed',
        attentionReason: 'invalid_text',
        lastErrorCode: 'invalidTitle',
      });
      expect(await getTarget(db, f.targets.facebook.id)).toMatchObject({
        status: 'failed',
        attentionReason: 'platform_error',
      });
    });

    it('checks the text before uploading', async () => {
      const p = await scheduled(['youtube'], at(26 * HOUR), { title: '' });
      await tick();
      expect(await getTarget(db, p.targets.youtube.id)).toMatchObject({
        status: 'failed',
        attentionReason: 'invalid_text',
      });
      expect(yt.calls).toHaveLength(0);
    });
  });

  describe('daily limits', () => {
    const fillYoutubeQuota = (n: number) =>
      db.insert(apiCalls).values(
        Array.from({ length: n }, () => ({
          platform: 'youtube' as const,
          kind: 'yt_insert' as const,
          at: new Date('2026-11-13T05:00:00Z'),
        })),
      );

    it('pushes YouTube uploads to the next Pacific day when the daily cap is used up', async () => {
      await fillYoutubeQuota(50);
      const p = await scheduled(['youtube'], new Date('2026-11-15T12:30:00Z'));
      const id = p.targets.youtube.id;
      await tick();
      const t = await getTarget(db, id);
      expect(t).toMatchObject({ status: 'scheduled', prepareAt: new Date('2026-11-13T08:01:00Z') });
      expect(yt.count('prepare')).toBe(0);
      expect((await attempts(id))[0]).toMatchObject({
        platformCode: 'daily_cap',
        outcome: 'retryable',
      });

      clock.set('2026-11-13T08:01:00Z'); // a new Pacific day: the old calls no longer count
      await tick();
      expect((await getTarget(db, id)).status).toBe('prepared');
    });

    it('fails with quota when the post can no longer make its time', async () => {
      await fillYoutubeQuota(50);
      const p = await scheduled(['youtube'], new Date('2026-11-13T07:30:00Z'));
      await tick();
      expect(await getTarget(db, p.targets.youtube.id)).toMatchObject({
        status: 'failed',
        attentionReason: 'quota',
      });
      expect(deps.jobs.alerts()).toMatchObject([{ kind: 'quota' }]);
    });

    it('gives the last upload slot to the earliest publish time', async () => {
      await fillYoutubeQuota(49);
      const later = await scheduled(['youtube'], new Date('2026-11-16T12:30:00Z'));
      const earlier = await scheduled(['youtube'], new Date('2026-11-15T12:30:00Z'));
      await engine.dispatch(); // assigns modes; both are due
      await engine.prepareTarget(later.targets.youtube.id);
      expect((await getTarget(db, later.targets.youtube.id)).status).toBe('scheduled');
      await engine.prepareTarget(earlier.targets.youtube.id);
      expect((await getTarget(db, earlier.targets.youtube.id)).status).toBe('prepared');
    });

    it('caps Facebook Reels per rolling 24 hours per Page', async () => {
      const oldest = new Date('2026-11-12T07:00:00Z');
      await db.insert(apiCalls).values(
        Array.from({ length: 30 }, (_, i) => ({
          platform: 'facebook' as const,
          socialAccountId: accounts.facebook.id,
          kind: 'fb_reel_start' as const,
          at: new Date(oldest.getTime() + i * MIN),
        })),
      );
      const p = await scheduled(['facebook'], new Date('2026-11-15T12:30:00Z'));
      await tick();
      expect(await getTarget(db, p.targets.facebook.id)).toMatchObject({
        status: 'scheduled',
        prepareAt: new Date(oldest.getTime() + 24 * HOUR + MIN),
      });
      expect(fb.count('prepare')).toBe(0);
    });

    it("YouTube's uploadLimitExceeded pauses every YouTube upload", async () => {
      yt.script.prepare.push(
        new PlatformError('quota', 'uploadLimitExceeded', {
          retryAfterSec: 24 * 3600,
          code: 'uploadLimitExceeded',
        }),
      );
      const a = await scheduled(['youtube'], new Date('2026-11-16T12:30:00Z'));
      const b = await scheduled(['youtube'], new Date('2026-11-17T12:30:00Z'));
      await tick();
      const until = at(24 * HOUR);
      expect(await getTarget(db, a.targets.youtube.id)).toMatchObject({
        status: 'scheduled',
        prepareAt: until,
      });
      expect(await getTarget(db, b.targets.youtube.id)).toMatchObject({
        status: 'scheduled',
        prepareAt: until,
      });
      expect(yt.count('prepare')).toBe(1);
      expect(deps.jobs.alerts()).toMatchObject([{ kind: 'quota' }]);
    });
  });

  describe('missed posts', () => {
    const preparedIg = (scheduledAt: Date) =>
      scheduled(['instagram'], scheduledAt, {
        status: 'prepared',
        publishMode: 'app',
        remoteContainerId: 'c1',
        prepareAt: new Date(scheduledAt.getTime() - 15 * MIN),
      });

    it('publishes late within the grace period', async () => {
      const p = await preparedIg(at(-30 * MIN));
      await tick();
      expect((await getTarget(db, p.targets.instagram.id)).status).toBe('published');
    });

    it('asks the owner when it is later than the grace period', async () => {
      const p = await preparedIg(at(-3 * HOUR));
      await tick();
      expect(await getTarget(db, p.targets.instagram.id)).toMatchObject({
        status: 'missed',
        attentionReason: 'missed',
      });
      expect(ig.count('publish')).toBe(0);
      expect(deps.jobs.alerts()).toMatchObject([
        { kind: 'missed', targetId: p.targets.instagram.id },
      ]);
    });

    it("always asks with the 'ask' policy", async () => {
      await updateSettings(db, { missedPolicy: 'ask' });
      const p = await preparedIg(at(-10 * MIN));
      await tick();
      expect((await getTarget(db, p.targets.instagram.id)).status).toBe('missed');
    });

    it('a stale publish job that runs hours late does not publish', async () => {
      const p = await preparedIg(at(-3 * HOUR));
      await engine.publishTarget(p.targets.instagram.id);
      expect((await getTarget(db, p.targets.instagram.id)).status).toBe('missed');
      expect(ig.count('publish')).toBe(0);
    });

    it('prepares and publishes right away when the worker was down at preparation time', async () => {
      const p = await scheduled(['instagram'], at(-30 * MIN));
      await tick();
      expect((await getTarget(db, p.targets.instagram.id)).status).toBe('published');
      expect(ig.count('prepare')).toBe(1);
      expect(ig.count('publish')).toBe(1);
    });
  });

  describe('owner changes after hand-over', () => {
    it('pushes an edit with publisher.update when the platform supports it', async () => {
      const p = await scheduled(['youtube'], at(26 * HOUR), {
        status: 'prepared',
        publishMode: 'native',
        remoteMediaId: 'vid1',
      });
      await updateTargetText(deps, {
        targetId: p.targets.youtube.id,
        patch: { title: 'Naya title' },
      });
      await run(); // dispatch-now from the edit
      const t = await getTarget(db, p.targets.youtube.id);
      expect(t).toMatchObject({ status: 'prepared', needsSync: false, remoteMediaId: 'vid1' });
      expect(yt.calls.map((c) => c.method)).toEqual(['update']);
      expect(yt.calls[0]!.text.title).toBe('Naya title');
    });

    it('cancels and prepares again when the platform cannot edit', async () => {
      const p = await scheduled(['facebook'], at(26 * HOUR), {
        status: 'prepared',
        publishMode: 'native',
        remoteMediaId: 'old-video',
        needsSync: true,
      });
      const id = p.targets.facebook.id;
      await tick();
      expect(fb.calls.map((c) => [c.method, c.remoteMediaId])).toEqual([
        ['cancel', 'old-video'],
        ['prepare', null],
      ]);
      expect(await getTarget(db, id)).toMatchObject({
        status: 'prepared',
        needsSync: false,
        remoteMediaId: `video-facebook-${id.slice(0, 8)}`,
      });
    });

    it('keeps an edit made while the upload was running and pushes it afterwards', async () => {
      const p = await scheduled(['youtube'], at(26 * HOUR));
      const id = p.targets.youtube.id;
      yt.script.prepare.push(async (input) => {
        await input.recordApiCall('yt_insert');
        await input.saveProgress({ remoteMediaId: 'vid1' });
        await updateTargetText(deps, { targetId: id, patch: { title: 'Edited mid-upload' } });
        return { kind: 'done' };
      });
      await tick();
      expect(yt.calls.map((c) => c.method)).toEqual(['prepare', 'update']);
      expect(yt.calls[1]!.text.title).toBe('Edited mid-upload');
      expect(await getTarget(db, id)).toMatchObject({
        status: 'prepared',
        needsSync: false,
        title: 'Edited mid-upload',
      });
    });

    it('removes the upload when the owner moved the post to drafts while it was uploading', async () => {
      const p = await scheduled(['youtube'], at(26 * HOUR));
      const id = p.targets.youtube.id;
      yt.script.prepare.push(async (input) => {
        await input.saveProgress({ remoteMediaId: 'vid1' });
        await moveToDrafts(deps, { postId: p.post.id });
        return { kind: 'done' };
      });
      await tick();
      expect(yt.calls.map((c) => [c.method, c.remoteMediaId])).toEqual([
        ['prepare', null],
        ['cancel', 'vid1'],
      ]);
      expect(await getTarget(db, id)).toMatchObject({
        status: 'draft',
        remoteMediaId: null,
        lockedUntil: null,
      });
    });

    it('moveToDrafts removes the scheduled copy from the platform', async () => {
      const p = await scheduled(['youtube'], at(26 * HOUR), {
        status: 'prepared',
        publishMode: 'native',
        remoteMediaId: 'vid1',
      });
      await moveToDrafts(deps, { postId: p.post.id });
      await run();
      expect(yt.calls.map((c) => c.method)).toEqual(['cancel']);
      expect(await getTarget(db, p.targets.youtube.id)).toMatchObject({
        status: 'draft',
        remoteMediaId: null,
        publishMode: null,
      });
      expect((await attempts(p.targets.youtube.id)).map((a) => a.step)).toEqual(['cancel']);
    });

    it('deletePost cancels on the platform, then removes the post and its files', async () => {
      const p = await scheduled(['youtube', 'instagram'], at(26 * HOUR));
      await db
        .update(postTargets)
        .set({ status: 'prepared', publishMode: 'native', remoteMediaId: 'vid1' })
        .where(eq(postTargets.id, p.targets.youtube.id));
      const storage = deps.storage as LocalStorage;
      const file = storage.pathFor(`media/${p.asset.id}/master.mp4`);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'video');

      await deletePost(deps, { postId: p.post.id });
      await run();
      expect(yt.calls.map((c) => c.method)).toEqual(['cancel']);
      expect(await db.select().from(posts).where(eq(posts.id, p.post.id))).toEqual([]);
      expect(await db.select().from(mediaAssets).where(eq(mediaAssets.id, p.asset.id))).toEqual([]);
      expect(existsSync(file)).toBe(false);
    });

    it('a deleted post waits until the platform copy is removed', async () => {
      yt.script.cancel.push(new PlatformError('retryable', 'timeout'));
      const p = await scheduled(['youtube'], at(26 * HOUR), {
        status: 'prepared',
        publishMode: 'native',
        remoteMediaId: 'vid1',
      });
      await deletePost(deps, { postId: p.post.id });
      await run();
      expect(await db.select().from(posts).where(eq(posts.id, p.post.id))).toHaveLength(1);
      expect(await getTarget(db, p.targets.youtube.id)).toMatchObject({
        status: 'canceled',
        remoteMediaId: 'vid1',
        attempts: 1,
      });
      await tick(2 * MIN);
      expect(await db.select().from(posts).where(eq(posts.id, p.post.id))).toEqual([]);
    });
  });

  describe('never post twice', () => {
    it('reconciles before retrying a publish that may have gone through', async () => {
      const T = at(0);
      const p = await scheduled(['instagram'], T, {
        status: 'prepared',
        publishMode: 'app',
        remoteContainerId: 'c1',
      });
      const id = p.targets.instagram.id;
      // The platform published but our request timed out.
      ig.script.publish.push(new PlatformError('retryable', 'Request timed out'));
      ig.script.reconcile.push({
        published: true,
        remoteMediaId: 'm1',
        remoteUrl: 'https://instagram.test/p/m1',
      });

      await tick();
      expect(await getTarget(db, id)).toMatchObject({ status: 'prepared', attempts: 1 });
      await tick(2 * MIN);
      expect(await getTarget(db, id)).toMatchObject({ status: 'published', remoteMediaId: 'm1' });
      expect(ig.calls.map((c) => c.method)).toEqual(['publish', 'reconcile']);
    });

    it('the watchdog reconciles a publish interrupted by a crash, then publishes once', async () => {
      const p = await scheduled(['instagram'], at(-2 * MIN), {
        status: 'publishing',
        publishMode: 'app',
        remoteContainerId: 'c1',
        lockedUntil: at(-MIN),
      });
      const id = p.targets.instagram.id;
      // The crashed attempt had logged its publish call.
      await db.insert(publishAttempts).values({
        targetId: id,
        attemptNo: 1,
        step: 'publish',
        outcome: 'retryable',
        startedAt: at(-2 * MIN),
      });

      await engine.watchdog();
      await run();
      expect(ig.calls.map((c) => c.method)).toEqual(['reconcile', 'publish']);
      expect((await getTarget(db, id)).status).toBe('published');
    });

    it('the watchdog resumes a prepare interrupted by a crash', async () => {
      const p = await scheduled(['youtube'], at(26 * HOUR), {
        status: 'preparing',
        publishMode: 'native',
        remoteUploadUri: 'https://upload.test/session',
        lockedUntil: at(-MIN),
      });
      await engine.watchdog();
      const t = await getTarget(db, p.targets.youtube.id);
      expect(t).toMatchObject({
        status: 'scheduled',
        lockedUntil: null,
        remoteUploadUri: 'https://upload.test/session',
      });
      await run();
      expect(yt.calls[0]).toMatchObject({ method: 'prepare' });
      expect((await getTarget(db, p.targets.youtube.id)).status).toBe('prepared');
      // Resuming an upload never takes a second daily upload slot.
      expect(await db.select().from(apiCalls)).toHaveLength(1);
    });
  });

  it('dry run never calls a platform and leaves targets scheduled', async () => {
    rebuild({ PUBLISHING_ENABLED: 'false' });
    const p = await scheduled(['youtube', 'instagram'], at(10 * MIN));
    await tick();
    await engine.prepareTarget(p.targets.youtube.id);
    await engine.publishTarget(p.targets.instagram.id);
    expect(yt.calls).toHaveLength(0);
    expect(ig.calls).toHaveLength(0);
    expect((await getTarget(db, p.targets.youtube.id)).status).toBe('scheduled');
    expect(deps.log.lines.some((l) => l.msg.startsWith('dry run'))).toBe(true);
  });

  describe('daily jobs', () => {
    it('tokenHealth pauses broken accounts and warns about logins expiring soon', async () => {
      integrations.facebook = fakeIntegration(fb, () => ({
        status: 'needs_reauth',
        message: 'Session has expired',
      }));
      integrations.instagram = fakeIntegration(ig, () => ({
        status: 'ok',
        dataAccessExpiresAt: at(5 * 24 * HOUR),
      }));
      integrations.youtube = fakeIntegration(yt, () => ({
        status: 'ok',
        accessExpiresAt: at(HOUR),
      }));
      rebuild();
      const f = await scheduled(['facebook'], at(26 * HOUR));

      await engine.tokenHealth();

      const rows = await db.select().from(socialAccounts);
      const byPlatform = Object.fromEntries(rows.map((r) => [r.platform, r]));
      expect(byPlatform.facebook).toMatchObject({ status: 'needs_reauth' });
      expect(byPlatform.instagram!.dataAccessExpiresAt).toEqual(at(5 * 24 * HOUR));
      expect(byPlatform.youtube!.lastCheckedAt).toEqual(clock.now());
      expect((await getTarget(db, f.targets.facebook.id)).status).toBe('needs_reauth');
      const kinds = deps.jobs
        .alerts()
        .map((a) => a.kind)
        .sort();
      // The YouTube access token (refreshed automatically) is not worth an alert.
      expect(kinds).toEqual(['needs_reauth', 'token_expiring']);
      expect(deps.jobs.alerts().find((a) => a.kind === 'token_expiring')!.message).toMatch(
        /^Instagram login expires/,
      );
    });

    it('purgeMedia deletes files N days after everything was published', async () => {
      const old = await seedPost(db, {
        platforms: ['youtube'],
        target: { status: 'published', publishedAt: at(-8 * 24 * HOUR) },
      });
      await seedPost(db, {
        platforms: ['youtube'],
        target: { status: 'published', publishedAt: at(-2 * 24 * HOUR) },
      });
      await seedPost(db, {
        platforms: ['youtube', 'instagram'],
        perTarget: {
          youtube: { status: 'published', publishedAt: at(-8 * 24 * HOUR) },
          instagram: { status: 'scheduled' },
        },
      });
      await engine.purgeMedia();
      expect(vi.mocked(purgeAssetMedia).mock.calls.map((c) => c[1])).toEqual([old.asset.id]);

      vi.mocked(purgeAssetMedia).mockClear();
      await updateSettings(db, { keepOriginals: true });
      await engine.purgeMedia();
      expect(purgeAssetMedia).not.toHaveBeenCalled();
    });

    it("dailyDigest sends tomorrow's posts", async () => {
      clock.set('2026-11-13T15:33:00Z'); // 21:03 IST
      await updateSettings(db, { dailyDigest: true });
      await seedPost(db, {
        platforms: ['instagram', 'youtube'],
        accounts,
        target: { status: 'scheduled', scheduledAt: new Date('2026-11-14T12:30:00Z') },
      });
      await seedPost(db, {
        platforms: ['facebook'],
        target: { status: 'failed', attentionReason: 'platform_error' },
      });
      await engine.dailyDigest();
      const [digest] = deps.jobs.alerts();
      expect(digest).toMatchObject({ kind: 'digest', dedupeKey: 'digest:2026-11-14' });
      expect(digest!.message).toBe(
        [
          'Tomorrow (Sat 14 Nov): 1 post scheduled.',
          '18:00 Instagram, YouTube · Socha tha normal sunset hoga… phir ye hua',
          '! 1 post needs attention.',
        ].join('\n'),
      );
    });
  });

  it('records every capped call and every step for the History section', async () => {
    const p = await scheduled(['facebook'], at(26 * HOUR));
    await tick();
    const [call] = await db
      .select()
      .from(apiCalls)
      .where(and(eq(apiCalls.targetId, p.targets.facebook.id), eq(apiCalls.kind, 'fb_reel_start')));
    expect(call).toMatchObject({
      platform: 'facebook',
      socialAccountId: accounts.facebook.id,
      at: clock.now(),
    });
  });
});
