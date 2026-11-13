/**
 * Post editor services against a real database (TEST_DATABASE_URL).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { mediaAssets, postTargets, posts, publishAttempts } from '@app/db';
import {
  addPlatformToPost,
  loadEditorData,
  loadPostHistory,
  refineAndSave,
  rewriteAllTexts,
  saveAssetTexts,
  setDraftTimes,
} from './post-service';
import { completeAssetUpload, createUploadBatch } from './service';
import { cleanup, createTestDeps, TEST_DB_URL, type TestDeps } from './test-support';

describe.skipIf(!TEST_DB_URL)('post editor services (database)', () => {
  let deps: TestDeps;
  const batchIds: string[] = [];

  beforeAll(async () => {
    deps = await createTestDeps();
  });
  afterAll(async () => {
    if (deps) await cleanup(deps, batchIds);
  });

  /** A processed ("ready") video with Hinglish texts on IG + YT. */
  async function readyPost(
    platforms: Array<'instagram' | 'youtube' | 'facebook'> = ['instagram', 'youtube'],
  ) {
    const { batchId, items } = await createUploadBatch(deps, {
      files: [{ name: '01_beach.mp4', size: 4, type: 'video/mp4' }],
      settings: { platforms, notes: '', when: { mode: 'next_free' } },
    });
    batchIds.push(batchId);
    const assetId = items[0]!.assetId;
    const [asset] = await deps.db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
    await deps.storage.putBuffer(asset!.originalKey, Buffer.from('1234'));
    const { postId } = await completeAssetUpload(deps, assetId);
    await deps.db
      .update(mediaAssets)
      .set({
        status: 'ready',
        transcript: 'Socha tha normal sunset hoga',
        durationMs: 58_000,
        width: 1080,
        height: 1920,
      })
      .where(eq(mediaAssets.id, assetId));
    await deps.db
      .update(postTargets)
      .set({
        body: 'Socha tha normal sunset hoga… phir ye hua 😳',
        hashtags: ['goa'],
        title: 'Goa mein ek sunset ne sab badal diya',
      })
      .where(eq(postTargets.postId, postId));
    deps.sent.length = 0;
    return { assetId, postId, originalKey: asset!.originalKey };
  }

  it('loads the editor data with a playable video URL and limits', async () => {
    const { postId, assetId } = await readyPost();
    const data = await loadEditorData(deps, postId);
    expect(data.card.id).toBe(postId);
    expect(data.card.targets.map((t) => t.platform)).toEqual(['instagram', 'youtube']);
    expect(data.videoSource).toBe('original');
    expect(data.videoUrl).toMatch(/^\/api\/files\?key=uploads%2F/);
    expect(data.timezone).toBe('Asia/Kolkata');
    expect(data.hashtagMax.instagram).toBeLessThanOrEqual(5);
    expect(data.transcriptEdited).toBe(false);

    await deps.db
      .update(mediaAssets)
      .set({ masterKey: `media/${assetId}/master.mp4` })
      .where(eq(mediaAssets.id, assetId));
    const withMaster = await loadEditorData(deps, postId);
    expect(withMaster.videoSource).toBe('master');
    expect(withMaster.videoUrl).toContain(encodeURIComponent(`media/${assetId}/master.mp4`));

    await expect(
      loadEditorData(deps, '00000000-0000-4000-8000-000000000000'),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('saves transcript edits (marked as edited) and notes', async () => {
    const { postId, assetId } = await readyPost();
    await saveAssetTexts(deps, { postId, transcript: 'Socha tha normal sunset hoga', notes: '' });
    let [asset] = await deps.db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
    expect(asset!.transcriptEdited).toBe(false); // unchanged text is not an edit

    await saveAssetTexts(deps, {
      postId,
      transcript: 'Socha tha Rahul ke saath normal sunset hoga',
      notes: 'Rahul',
    });
    [asset] = await deps.db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
    expect(asset).toMatchObject({
      transcript: 'Socha tha Rahul ke saath normal sunset hoga',
      transcriptEdited: true,
      notes: 'Rahul',
    });
  });

  it('"Rewrite all texts" saves, shows Writing and queues the AI once', async () => {
    const { postId, assetId } = await readyPost();
    await rewriteAllTexts(deps, { postId, notes: 'Goa, day 2' });
    const [asset] = await deps.db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
    expect(asset).toMatchObject({
      status: 'processing',
      processingStep: 'generate',
      notes: 'Goa, day 2',
    });
    expect(deps.sent).toEqual([
      { queue: 'generate-text', data: { assetId }, options: { singletonKey: assetId } },
    ]);
    await expect(rewriteAllTexts(deps, { postId })).rejects.toMatchObject({ name: 'UserError' });
  });

  it('adds a platform as a draft target and asks the AI for its text', async () => {
    const { postId, assetId } = await readyPost(['instagram']);
    // A canceled Facebook target from earlier must not block adding Facebook again.
    await deps.db.insert(postTargets).values({ postId, platform: 'facebook', status: 'canceled' });
    await addPlatformToPost(deps, { postId, platform: 'facebook' });
    const targets = await deps.db.select().from(postTargets).where(eq(postTargets.postId, postId));
    expect(targets.map((t) => [t.platform, t.status]).sort()).toEqual([
      ['facebook', 'draft'],
      ['instagram', 'draft'],
    ]);
    expect(deps.sent).toEqual([
      {
        queue: 'generate-text',
        data: { assetId, platforms: ['facebook'] },
        options: { singletonKey: assetId },
      },
    ]);
    // Adding an existing platform is a no-op.
    await addPlatformToPost(deps, { postId, platform: 'instagram' });
    expect(deps.sent).toHaveLength(1);
  });

  it('stores dated drafts, one time or per app, without touching scheduled targets', async () => {
    const { postId } = await readyPost(['instagram', 'youtube', 'facebook']);
    const at = new Date('2026-11-15T12:30:00Z');
    await setDraftTimes(deps, { postId, at });
    let targets = await deps.db.select().from(postTargets).where(eq(postTargets.postId, postId));
    expect(targets.every((t) => t.scheduledAt?.toISOString() === at.toISOString())).toBe(true);
    let [post] = await deps.db.select().from(posts).where(eq(posts.id, postId));
    expect(post!.scheduledAt?.toISOString()).toBe(at.toISOString());

    const later = new Date('2026-11-16T12:30:00Z');
    await setDraftTimes(deps, {
      postId,
      at: null,
      perPlatformAt: { instagram: later, youtube: at, facebook: null },
    });
    targets = await deps.db.select().from(postTargets).where(eq(postTargets.postId, postId));
    const byP = Object.fromEntries(
      targets.map((t) => [t.platform, t.scheduledAt?.toISOString() ?? null]),
    );
    expect(byP).toEqual({
      instagram: later.toISOString(),
      youtube: at.toISOString(),
      facebook: null,
    });
    [post] = await deps.db.select().from(posts).where(eq(posts.id, postId));
    expect(post!.scheduledAt?.toISOString()).toBe(at.toISOString());

    // A scheduled target keeps its time; only drafts move.
    await deps.db
      .update(postTargets)
      .set({ status: 'scheduled' })
      .where(and(eq(postTargets.postId, postId), eq(postTargets.platform, 'youtube')));
    await setDraftTimes(deps, { postId, at: later });
    targets = await deps.db.select().from(postTargets).where(eq(postTargets.postId, postId));
    expect(targets.find((t) => t.platform === 'youtube')!.scheduledAt?.toISOString()).toBe(
      at.toISOString(),
    );
    expect(targets.find((t) => t.platform === 'facebook')!.scheduledAt?.toISOString()).toBe(
      later.toISOString(),
    );

    await deps.db
      .update(postTargets)
      .set({ status: 'scheduled' })
      .where(eq(postTargets.postId, postId));
    await expect(setDraftTimes(deps, { postId, at })).rejects.toMatchObject({ name: 'UserError' });
  });

  it('lists the publish history newest first without platform response bodies', async () => {
    const { postId } = await readyPost();
    const targets = await deps.db.select().from(postTargets).where(eq(postTargets.postId, postId));
    const yt = targets.find((t) => t.platform === 'youtube')!;
    const ig = targets.find((t) => t.platform === 'instagram')!;
    await deps.db.insert(publishAttempts).values([
      {
        targetId: yt.id,
        attemptNo: 1,
        step: 'upload',
        outcome: 'retryable',
        httpStatus: 503,
        message: 'Backend error',
        startedAt: new Date('2026-11-14T10:00:00Z'),
        responseExcerpt: { secret: 'x' },
      },
      {
        targetId: yt.id,
        attemptNo: 2,
        step: 'upload',
        outcome: 'ok',
        startedAt: new Date('2026-11-14T10:05:00Z'),
      },
      {
        targetId: ig.id,
        attemptNo: 1,
        step: 'create_container',
        outcome: 'fatal',
        platformCode: '9004',
        message: 'x'.repeat(400),
        startedAt: new Date('2026-11-14T09:00:00Z'),
      },
    ]);
    const history = await loadPostHistory(deps, postId);
    expect(history.map((h) => [h.platform, h.step, h.outcome])).toEqual([
      ['youtube', 'upload', 'ok'],
      ['youtube', 'upload', 'retryable'],
      ['instagram', 'create_container', 'fatal'],
    ]);
    expect(history[1]).toMatchObject({ httpStatus: 503, message: 'Backend error' });
    expect(history[2]!.message).toHaveLength(300);
    expect(JSON.stringify(history)).not.toContain('secret');
  });

  it('refine: asks the AI for one field and saves it with the expected version', async () => {
    const refineField = vi.fn(async () => ({ title: 'Ek sunset, aur sab badal gaya' }));
    const updateTargetText = vi.fn(async () => ({ version: 4 }));
    const out = await refineAndSave(
      deps,
      { refineField, updateTargetText },
      { targetId: 't1', field: 'title', action: 'shorter', expectedVersion: 3 },
    );
    expect(out).toEqual({ patch: { title: 'Ek sunset, aur sab badal gaya' }, version: 4 });
    expect(refineField).toHaveBeenCalledWith(deps, {
      targetId: 't1',
      field: 'title',
      action: 'shorter',
    });
    expect(updateTargetText).toHaveBeenCalledWith(deps, {
      targetId: 't1',
      patch: { title: 'Ek sunset, aur sab badal gaya' },
      expectedVersion: 3,
    });
    await expect(
      refineAndSave(
        deps,
        { refineField: async () => ({}), updateTargetText },
        { targetId: 't1', field: 'body', action: 'regenerate' },
      ),
    ).rejects.toMatchObject({ name: 'UserError' });
  });
});
