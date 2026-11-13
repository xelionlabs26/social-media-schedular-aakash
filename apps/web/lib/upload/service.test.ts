/**
 * Upload screen services against a real database (TEST_DATABASE_URL) and a temp STORAGE_DIR.
 */
import { stat } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  batches,
  mediaAssets,
  mediaFrames,
  postTargets,
  posts,
  socialAccounts,
  type Platform,
} from '@app/db';
import { NotImplementedError } from '@app/core/deps';
import { loadAccounts, loadBatchView, loadUploadPageData } from './batch-view';
import { LOCAL_CHUNK_BYTES } from './constants';
import {
  applyBatchSettings,
  completeAssetUpload,
  createUploadBatch,
  queueTextGeneration,
  removeUnfinishedUpload,
  renewUploadTarget,
  reorderBatch,
  restartUpload,
  retryAssetProcessing,
  scheduleBatch,
} from './service';
import { cleanup, createTestDeps, TEST_DB_URL, type TestDeps } from './test-support';
import type { BatchSettings } from './types';

const settings: BatchSettings = {
  platforms: ['instagram', 'youtube', 'facebook'],
  notes: 'Goa trip with Rahul, day 2',
  when: { mode: 'next_free', startDate: '2026-11-15' },
};

describe.skipIf(!TEST_DB_URL)('upload services (database)', () => {
  let deps: TestDeps;
  const batchIds: string[] = [];
  const accountIds: string[] = [];

  beforeAll(async () => {
    deps = await createTestDeps();
  });
  afterAll(async () => {
    if (deps) await cleanup(deps, batchIds, accountIds);
  });

  async function newBatch(names: string[], s: BatchSettings = settings) {
    const res = await createUploadBatch(deps, {
      files: names.map((name) => ({
        name,
        size: 5,
        type: name.endsWith('.mov') ? '' : 'video/mp4',
      })),
      settings: s,
    });
    batchIds.push(res.batchId);
    return res;
  }

  /** Uploads 5 bytes for an asset and completes it. */
  async function uploadAndComplete(assetId: string) {
    const [asset] = await deps.db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
    await deps.storage.putBuffer(asset!.originalKey, Buffer.from('12345'));
    return completeAssetUpload(deps, assetId);
  }

  async function setReady(assetId: string) {
    await deps.db
      .update(mediaAssets)
      .set({ status: 'ready', processingStep: null })
      .where(eq(mediaAssets.id, assetId));
  }

  it('creates the batch and assets, sorted by name, with signed same-origin upload URLs', async () => {
    const res = await newBatch(['clip 10.mp4', 'clip 2.mov', 'clip 1.mp4']);
    const [batch] = await deps.db.select().from(batches).where(eq(batches.id, res.batchId));
    expect(batch).toMatchObject({
      platforms: settings.platforms,
      notes: settings.notes,
      slotRule: settings.when,
    });

    expect(res.items.map((i) => [i.index, i.sortIndex])).toEqual([
      [0, 2],
      [1, 1],
      [2, 0],
    ]);
    for (const item of res.items) {
      expect(item.target.url).toMatch(/^\/api\/uploads\/local\?key=uploads%2F/);
      expect(item.chunkSize).toBe(LOCAL_CHUNK_BYTES);
    }
    const assets = await deps.db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.batchId, res.batchId));
    const byName = Object.fromEntries(assets.map((a) => [a.filename, a]));
    expect(byName['clip 2.mov']).toMatchObject({
      status: 'uploading',
      contentType: 'video/quicktime',
      originalKey: `uploads/${byName['clip 2.mov']!.id}/original.mov`,
      notes: settings.notes,
      sizeBytes: 5,
    });
    // createdAt follows the order the files were picked ("Selection").
    const created = ['clip 10.mp4', 'clip 2.mov', 'clip 1.mp4'].map((n) =>
      byName[n]!.createdAt.getTime(),
    );
    expect([...created].sort((a, b) => a - b)).toEqual(created);

    // More files join the same batch after the existing cards.
    const more = await createUploadBatch(deps, {
      files: [{ name: 'a.mp4', size: 5, type: 'video/mp4' }],
      settings: { ...settings, platforms: ['youtube'] },
      batchId: res.batchId,
    });
    expect(more.batchId).toBe(res.batchId);
    expect(more.items[0]!.sortIndex).toBe(3);
    const [updated] = await deps.db.select().from(batches).where(eq(batches.id, res.batchId));
    expect(updated!.platforms).toEqual(['youtube']);
  });

  it('rejects non-videos without leaving rows behind', async () => {
    await expect(
      createUploadBatch(deps, {
        files: [
          { name: 'ok.mp4', size: 1, type: 'video/mp4' },
          { name: 'doc.pdf', size: 1, type: 'application/pdf' },
        ],
        settings,
      }),
    ).rejects.toMatchObject({ name: 'UserError', code: 'validation' });
  });

  it('completes an upload only when the stored size matches, then creates the post and queues processing', async () => {
    const { items } = await newBatch(['01_beach.mp4']);
    const assetId = items[0]!.assetId;

    await expect(completeAssetUpload(deps, assetId)).rejects.toMatchObject({
      code: 'upload_missing',
    });
    const [asset] = await deps.db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
    await deps.storage.putBuffer(asset!.originalKey, Buffer.from('123'));
    await expect(completeAssetUpload(deps, assetId)).rejects.toMatchObject({
      code: 'size_mismatch',
    });

    deps.sent.length = 0;
    const done = await uploadAndComplete(assetId);
    const [after] = await deps.db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
    expect(after!.status).toBe('uploaded');
    const targets = await deps.db
      .select()
      .from(postTargets)
      .where(eq(postTargets.postId, done.postId));
    expect(targets.map((t) => t.platform).sort()).toEqual(['facebook', 'instagram', 'youtube']);
    expect(targets.every((t) => t.status === 'draft')).toBe(true);
    expect(targets.find((t) => t.platform === 'youtube')!.options).toMatchObject({
      privacy: 'public',
    });
    expect(deps.sent).toEqual([
      { queue: 'process-asset', data: { assetId }, options: { singletonKey: assetId } },
    ]);

    // Idempotent: a repeated call returns the same post and queues nothing new.
    const again = await completeAssetUpload(deps, assetId);
    expect(again.postId).toBe(done.postId);
    expect(deps.sent).toHaveLength(1);
  });

  it('keeps the upload when the job queue is unavailable and says so', async () => {
    const { items } = await newBatch(['02_gym.mp4']);
    deps.failJobs = true;
    try {
      const res = await uploadAndComplete(items[0]!.assetId);
      expect(res.warning).toMatch(/worker/);
      const [asset] = await deps.db
        .select()
        .from(mediaAssets)
        .where(eq(mediaAssets.id, items[0]!.assetId));
      expect(asset!.status).toBe('uploaded');
    } finally {
      deps.failJobs = false;
    }
  });

  it('shows a batch’s cards with thumbnails and hides deleted posts', async () => {
    const { batchId, items } = await newBatch(['a.mp4', 'b.mp4', 'c.mp4']);
    const [a, b, c] = [...items].sort((x, y) => x.sortIndex - y.sortIndex);
    const doneA = await uploadAndComplete(a!.assetId);
    const doneC = await uploadAndComplete(c!.assetId);
    await deps.db.insert(mediaFrames).values([
      {
        assetId: a!.assetId,
        idx: 1,
        tMs: 2000,
        key: `frames/${a!.assetId}/01.jpg`,
        width: 576,
        height: 1024,
        source: 'uniform',
      },
      {
        assetId: a!.assetId,
        idx: 0,
        tMs: 500,
        key: `frames/${a!.assetId}/00.jpg`,
        width: 576,
        height: 1024,
        source: 'hook',
      },
    ]);
    await deps.db.update(posts).set({ deletedAt: new Date() }).where(eq(posts.id, doneC.postId));

    const view = (await loadBatchView(deps, batchId))!;
    expect(view.batch.settings).toEqual(settings);
    expect(view.items.map((i) => i.assetId)).toEqual([a!.assetId, b!.assetId]);
    expect(view.items[0]!.post?.id).toBe(doneA.postId);
    expect(view.items[0]!.post?.display).toBe('processing');
    expect(view.items[0]!.thumbUrl).toMatch(/^\/api\/files\?key=frames%2F.+%2F00\.jpg/);
    expect(view.items[1]).toMatchObject({ assetStatus: 'uploading', post: null, thumbUrl: null });

    expect(await loadBatchView(deps, '00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(await loadBatchView(deps, 'not-a-uuid')).toBeNull();
    const page = await loadUploadPageData(deps, batchId);
    expect(page.timezone).toBe('Asia/Kolkata');
    expect(page.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(page.view?.items).toHaveLength(2);
  });

  it('reports account connection per platform', async () => {
    const [acct] = await deps.db
      .insert(socialAccounts)
      .values({
        platform: 'youtube',
        authKind: 'google',
        externalId: `test-${Date.now()}`,
        displayName: 'My Channel',
      })
      .returning();
    accountIds.push(acct!.id);
    const accounts = await loadAccounts(deps.db);
    expect(accounts.youtube).toEqual({ state: 'connected', name: expect.any(String) });
  });

  it('applies the batch bar to every card and lists what it kept', async () => {
    const { batchId, items } = await newBatch(['x.mp4', 'y.mp4'], {
      ...settings,
      platforms: ['instagram', 'youtube'],
      notes: '',
    });
    const [x, y] = [...items].sort((p, q) => p.sortIndex - q.sortIndex);
    const doneX = await uploadAndComplete(x!.assetId);
    await setReady(x!.assetId);
    await deps.db
      .update(postTargets)
      .set({ status: 'scheduled', scheduledAt: new Date(Date.now() + 86_400_000) })
      .where(and(eq(postTargets.postId, doneX.postId), eq(postTargets.platform, 'youtube')));

    deps.sent.length = 0;
    const next: BatchSettings = {
      platforms: ['facebook'],
      notes: 'Goa trip',
      when: { mode: 'pick' },
    };
    const res = await applyBatchSettings(deps, { batchId, settings: next, rewriteReady: true });
    expect(res).toMatchObject({ changedCards: 2, addedTargets: 1, removedTargets: 1, textJobs: 1 });
    expect(res.kept).toEqual([
      { filename: 'x.mp4', platform: 'youtube', reason: 'YouTube is already scheduled' },
    ]);

    const targets = await deps.db
      .select()
      .from(postTargets)
      .where(eq(postTargets.postId, doneX.postId));
    expect(targets.map((t) => [t.platform, t.status]).sort()).toEqual([
      ['facebook', 'draft'],
      ['youtube', 'scheduled'],
    ]);
    const assets = await deps.db.select().from(mediaAssets).where(eq(mediaAssets.batchId, batchId));
    expect(assets.every((a) => a.notes === 'Goa trip')).toBe(true);
    expect(assets.find((a) => a.id === x!.assetId)).toMatchObject({
      status: 'processing',
      processingStep: 'generate',
    });
    // Notes changed + "rewrite" ticked: every non-manual field is rewritten (no platform filter).
    expect(deps.sent).toEqual([
      {
        queue: 'generate-text',
        data: { assetId: x!.assetId },
        options: { singletonKey: x!.assetId },
      },
    ]);
    const [batch] = await deps.db.select().from(batches).where(eq(batches.id, batchId));
    expect(batch).toMatchObject({ platforms: ['facebook'], slotRule: { mode: 'pick' } });

    // The still-uploading card gets its targets from the updated batch when it completes.
    const doneY = await uploadAndComplete(y!.assetId);
    const yTargets = await deps.db
      .select()
      .from(postTargets)
      .where(eq(postTargets.postId, doneY.postId));
    expect(yTargets.map((t) => t.platform)).toEqual(['facebook'] as Platform[]);
  });

  it('queues only the new platform’s text when a platform is added without rewriting', async () => {
    const { batchId, items } = await newBatch(['z.mp4'], {
      ...settings,
      platforms: ['instagram'],
      notes: '',
    });
    await uploadAndComplete(items[0]!.assetId);
    await setReady(items[0]!.assetId);
    deps.sent.length = 0;
    await applyBatchSettings(deps, {
      batchId,
      settings: { platforms: ['instagram', 'youtube'], notes: 'new', when: { mode: 'draft' } },
      rewriteReady: false,
    });
    expect(deps.sent).toEqual([
      {
        queue: 'generate-text',
        data: { assetId: items[0]!.assetId, platforms: ['youtube'] },
        options: { singletonKey: items[0]!.assetId },
      },
    ]);
  });

  it('reverts the "writing" state when the AI job cannot be queued', async () => {
    const { items } = await newBatch(['w.mp4']);
    await uploadAndComplete(items[0]!.assetId);
    await setReady(items[0]!.assetId);
    deps.failJobs = true;
    try {
      await expect(queueTextGeneration(deps, items[0]!.assetId)).rejects.toMatchObject({
        code: 'unavailable',
      });
    } finally {
      deps.failJobs = false;
    }
    const [asset] = await deps.db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, items[0]!.assetId));
    expect(asset!.status).toBe('ready');
    // Not ready yet: nothing to do (the pipeline writes the text anyway).
    const { items: other } = await newBatch(['v.mp4']);
    expect(await queueTextGeneration(deps, other[0]!.assetId)).toBe(false);
  });

  it('saves a new order and refuses foreign or repeated ids', async () => {
    const { batchId, items } = await newBatch(['1.mp4', '2.mp4', '3.mp4']);
    const ids = items.map((i) => i.assetId);
    await reorderBatch(deps, { batchId, assetIds: [ids[2]!, ids[0]!, ids[1]!] });
    const rows = await deps.db.select().from(mediaAssets).where(eq(mediaAssets.batchId, batchId));
    const sort = Object.fromEntries(rows.map((r) => [r.id, r.sortIndex]));
    expect([sort[ids[2]!], sort[ids[0]!], sort[ids[1]!]]).toEqual([0, 1, 2]);
    await expect(
      reorderBatch(deps, { batchId, assetIds: [ids[0]!, '00000000-0000-4000-8000-000000000000'] }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      reorderBatch(deps, { batchId, assetIds: [ids[0]!, ids[0]!] }),
    ).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('removes, restarts and renews unfinished uploads', async () => {
    const { items } = await newBatch(['r1.mp4', 'r2.mp4']);
    const [r1, r2] = items;

    // Restart with a different file: partial bytes are wiped, the row follows the new file.
    const partial = `${deps.storage.pathFor(`uploads/${r1!.assetId}/original.mp4`)}.partial`;
    await deps.storage.putBuffer(`uploads/${r1!.assetId}/original.mp4.partial`, Buffer.from('xx'));
    const restarted = await restartUpload(deps, {
      assetId: r1!.assetId,
      file: { name: 'r1-new.mov', size: 9, type: 'video/quicktime' },
    });
    expect(restarted.target.url).toContain(
      encodeURIComponent(`uploads/${r1!.assetId}/original.mov`),
    );
    await expect(stat(partial)).rejects.toThrow();
    const [row] = await deps.db.select().from(mediaAssets).where(eq(mediaAssets.id, r1!.assetId));
    expect(row).toMatchObject({
      filename: 'r1-new.mov',
      sizeBytes: 9,
      contentType: 'video/quicktime',
    });

    const renewed = await renewUploadTarget(deps, r2!.assetId);
    expect(renewed.target.url).toMatch(/^\/api\/uploads\/local\?/);

    await removeUnfinishedUpload(deps, r2!.assetId);
    expect(
      await deps.db.select().from(mediaAssets).where(eq(mediaAssets.id, r2!.assetId)),
    ).toHaveLength(0);

    await uploadAndComplete(r1!.assetId).catch(() => undefined); // size differs: still uploading
    await deps.storage.putBuffer(row!.originalKey.replace('.mp4', '.mov'), Buffer.alloc(9));
    await completeAssetUpload(deps, r1!.assetId);
    await expect(removeUnfinishedUpload(deps, r1!.assetId)).rejects.toMatchObject({
      code: 'validation',
    });
    await expect(renewUploadTarget(deps, r1!.assetId)).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('retries processing for failed videos only', async () => {
    const { items } = await newBatch(['f.mp4']);
    const id = items[0]!.assetId;
    await uploadAndComplete(id);
    await deps.db
      .update(mediaAssets)
      .set({ status: 'failed', error: 'ffprobe failed' })
      .where(eq(mediaAssets.id, id));
    deps.sent.length = 0;
    await retryAssetProcessing(deps, id);
    const [asset] = await deps.db.select().from(mediaAssets).where(eq(mediaAssets.id, id));
    expect(asset).toMatchObject({ status: 'uploaded', error: null });
    expect(deps.sent.map((s) => s.queue)).toEqual(['process-asset']);
    await setReady(id);
    await expect(retryAssetProcessing(deps, id)).rejects.toMatchObject({ name: 'UserError' });
  });

  it('pick mode skips cards without a (future) time; other modes go to the scheduler', async () => {
    const { batchId, items } = await newBatch(['p1.mp4', 'p2.mp4']);
    const done = [];
    for (const it of items) {
      done.push(await uploadAndComplete(it.assetId));
      await setReady(it.assetId);
    }
    const past = new Date(Date.now() - 3600_000);
    await deps.db.update(posts).set({ scheduledAt: past }).where(eq(posts.id, done[1]!.postId));

    const summary = await scheduleBatch(deps, {
      batchId,
      postIds: [...done.map((d) => d.postId), '00000000-0000-4000-8000-000000000000'],
      when: { mode: 'pick' },
    });
    expect(summary.scheduled).toEqual([]);
    expect(summary.skipped.map((s) => s.reason)).toEqual([
      'Not in this batch',
      'No date & time picked yet',
      'The picked time has already passed',
    ]);
    const [batch] = await deps.db.select().from(batches).where(eq(batches.id, batchId));
    expect(batch!.slotRule).toEqual({ mode: 'pick' });

    // The scheduling module is a stub in this worktree: its error reaches the action layer.
    await expect(
      scheduleBatch(deps, {
        batchId,
        postIds: done.map((d) => d.postId),
        when: { mode: 'next_free' },
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});
