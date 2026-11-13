/**
 * End-to-end tests of processAsset / extractAudio / loadFramesForAi / purgeAssetMedia against a
 * real Postgres (TEST_DATABASE_URL) and LocalStorage in a temp directory.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb, mediaAssets, mediaFrames, type Db, type Platform } from '@app/db';
import type { ServiceDeps } from '../deps';
import { getEnv } from '../env';
import { createLogger } from '../log';
import { createPostForAsset } from '../posts';
import { getSettings } from '../settings';
import { LocalStorage, keys } from '../storage';
import { extractAudio, loadFramesForAi, probeVideo, processAsset, purgeAssetMedia } from './index';
import { hasFfmpeg, makeFixtures, type Fixtures } from './test-fixtures';

const DB_URL = process.env.TEST_DATABASE_URL;
if (!DB_URL) {
  console.warn('[media] TEST_DATABASE_URL is not set: skipping the database pipeline tests.');
}

describe.skipIf(!DB_URL || !hasFfmpeg())('media pipeline (Postgres + ffmpeg)', () => {
  let fx: Fixtures;
  let root: string;
  let db: Db;
  let storage: LocalStorage;
  let deps: ServiceDeps;
  const created: string[] = [];

  beforeAll(async () => {
    fx = await makeFixtures();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'media-pipeline-'));
    db = getDb(DB_URL);
    storage = new LocalStorage(path.join(root, 'storage'), 'http://localhost:3000');
    const env = getEnv({ ...process.env, WORK_DIR: path.join(root, 'work') });
    deps = {
      db,
      storage,
      env,
      log: createLogger('test'),
      jobs: { send: async () => null },
      now: () => new Date('2026-11-13T10:00:00Z'),
    };
  }, 60_000);

  afterAll(async () => {
    if (db && created.length) {
      for (const id of created) await db.delete(mediaAssets).where(eq(mediaAssets.id, id));
    }
    await closeDb();
    if (fx) await fs.rm(fx.dir, { recursive: true, force: true });
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  /** Uploads a fixture as an asset's original and inserts the media_assets row. */
  async function upload(file: string, opts: { platforms?: Platform[]; ext?: string } = {}) {
    const id = randomUUID();
    const originalKey = keys.original(id, opts.ext ?? 'mp4');
    await storage.putFile(originalKey, file);
    const size = (await fs.stat(file)).size;
    await db.insert(mediaAssets).values({
      id,
      filename: path.basename(file),
      contentType: 'video/mp4',
      sizeBytes: size,
      originalKey,
      status: 'uploaded',
    });
    created.push(id);
    if (opts.platforms) {
      await createPostForAsset(db, {
        assetId: id,
        platforms: opts.platforms,
        settings: await getSettings(db),
      });
    }
    return id;
  }

  async function asset(id: string) {
    return (await db.select().from(mediaAssets).where(eq(mediaAssets.id, id)))[0]!;
  }

  async function frames(id: string) {
    return db
      .select()
      .from(mediaFrames)
      .where(eq(mediaFrames.assetId, id))
      .orderBy(asc(mediaFrames.idx));
  }

  async function workDirIsClean(id: string) {
    await expect(fs.stat(path.join(deps.env.WORK_DIR, id))).rejects.toThrow();
  }

  it('remuxes a compliant portrait clip, makes frames, and leaves the step at transcribe', async () => {
    const id = await upload(fx.portrait, { platforms: ['instagram', 'youtube', 'facebook'] });
    const res = await processAsset(deps, id);
    expect(res).toEqual({ ok: true });

    const a = await asset(id);
    expect(a).toMatchObject({
      status: 'processing',
      processingStep: 'transcribe',
      error: null,
      masterKey: keys.master(id),
      width: 1080,
      height: 1920,
      rotation: 0,
      vcodec: 'h264',
      acodec: 'aac',
      hasAudio: true,
      fps: 30,
    });
    expect(a.durationMs).toBeGreaterThan(4900);
    // 5 s clip: Instagram and Facebook need ≥3 s, so nothing to warn about.
    expect(a.warnings).toEqual([]);

    // The master exists in storage and plays (ffprobe reads it, faststart = moov before mdat).
    const masterFile = storage.pathFor(a.masterKey!);
    const master = await probeVideo(masterFile, deps);
    expect(master).toMatchObject({ vcodec: 'h264', width: 1080, height: 1920, hasAudio: true });
    const head = (await fs.readFile(masterFile)).subarray(0, 64 * 1024).toString('latin1');
    expect(head.indexOf('moov')).toBeGreaterThanOrEqual(0);
    expect(head.indexOf('moov')).toBeLessThan(
      head.indexOf('mdat') === -1 ? Infinity : head.indexOf('mdat'),
    );

    const rows = await frames(id);
    // 5 s clip: the 0.25 s uniform frame is dropped as too close to the 0.5 s hook frame.
    expect(rows).toHaveLength(7);
    expect(rows[0]).toMatchObject({ idx: 0, source: 'hook', tMs: 500, width: 576, height: 1024 });
    expect(rows.filter((r) => r.source === 'uniform')).toHaveLength(6);
    for (const [i, r] of rows.entries()) {
      expect(r.idx).toBe(i);
      expect(r.key).toBe(keys.frame(id, i));
      const jpeg = await fs.readFile(storage.pathFor(r.key));
      expect(jpeg.subarray(0, 2).toString('hex')).toBe('ffd8');
    }
    await workDirIsClean(id);

    // AI frames load in order with their bytes.
    const ai = await loadFramesForAi(deps, id);
    expect(ai.map((f) => f.idx)).toEqual(rows.map((r) => r.idx));
    expect(ai[0]!.jpeg.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(ai[0]!.source).toBe('hook');
  });

  it('is idempotent: a re-run neither duplicates frames nor redoes finished work', async () => {
    const id = await upload(fx.scenes, { platforms: ['instagram'] });
    expect(await processAsset(deps, id)).toEqual({ ok: true });
    const first = await frames(id);
    // 10 s clip: hook (0.5 s) + 6 uniform (the 5% one at 0.5 s duplicates the hook) + the 2
    // hard cuts (2.7 s, 5.7 s).
    const cuts = first.filter((f) => f.source === 'scene').map((f) => f.tMs);
    expect(cuts).toHaveLength(2);
    expect(Math.abs(cuts[0]! - 2700)).toBeLessThan(100);
    expect(Math.abs(cuts[1]! - 5700)).toBeLessThan(100);
    expect(first.filter((f) => f.source === 'uniform')).toHaveLength(6);
    expect(first).toHaveLength(9);

    // Duplicate job while the asset waits for transcription: no work, ok so the chain continues.
    expect(await processAsset(deps, id)).toEqual({ ok: true, skipped: true });
    expect((await frames(id)).map((f) => f.id)).toEqual(first.map((f) => f.id));

    // Forced re-run: everything is replaced, same frame count, no leftovers.
    expect(await processAsset(deps, id, { force: true })).toEqual({ ok: true });
    const second = await frames(id);
    expect(second.map((f) => f.tMs)).toEqual(first.map((f) => f.tMs));
    expect(second.map((f) => f.id)).not.toEqual(first.map((f) => f.id));
    const files = await fs.readdir(path.dirname(storage.pathFor(keys.frame(id, 0))));
    expect(files).toHaveLength(second.length);

    // Once text generation has started, a duplicate job must not re-queue transcription.
    await db.update(mediaAssets).set({ processingStep: 'generate' }).where(eq(mediaAssets.id, id));
    expect(await processAsset(deps, id)).toEqual({ ok: false, skipped: true });
    expect((await frames(id)).map((f) => f.id)).toEqual(second.map((f) => f.id));

    // A ready asset is left alone unless forced.
    await db
      .update(mediaAssets)
      .set({ status: 'ready', processingStep: null })
      .where(eq(mediaAssets.id, id));
    expect(await processAsset(deps, id)).toEqual({ ok: false, skipped: true });
    expect((await asset(id)).status).toBe('ready');
  });

  it('normalizes landscape, rotated, HDR and silent clips with the right warnings', async () => {
    const land = await upload(fx.landscape, { platforms: ['youtube', 'facebook'] });
    expect((await processAsset(deps, land)).ok).toBe(true);
    const a = await asset(land);
    expect([a.width, a.height]).toEqual([1920, 1080]);
    expect(a.warnings.map((w) => w.code)).toEqual(['yt_not_short_landscape']);
    expect((await frames(land))[0]).toMatchObject({ width: 1024, height: 576 });

    const rot = await upload(fx.rotated, { platforms: ['instagram'] });
    expect((await processAsset(deps, rot)).ok).toBe(true);
    const r = await asset(rot);
    expect(r).toMatchObject({ width: 1080, height: 1920, rotation: 0, fps: 30 });
    const rMaster = await probeVideo(storage.pathFor(r.masterKey!), deps);
    expect(rMaster).toMatchObject({ width: 1080, height: 1920, rotation: 0 });

    const hdr = await upload(fx.hdr10bit, { platforms: ['instagram'] });
    expect((await processAsset(deps, hdr)).ok).toBe(true);
    const h = await asset(hdr);
    expect(h.colorTransfer).toBe('bt709');
    expect(h.warnings.map((w) => w.code)).toEqual(['ig_too_short', 'hdr_converted']);

    // No post yet → default platforms from Settings (all three).
    const silent = await upload(fx.silent);
    expect((await processAsset(deps, silent)).ok).toBe(true);
    const s = await asset(silent);
    expect(s.hasAudio).toBe(false);
    expect(s.warnings.map((w) => w.code)).toContain('no_audio');
    const master = await probeVideo(storage.pathFor(s.masterKey!), deps);
    expect(master.hasAudio).toBe(false);
    expect(await extractAudio(deps, silent)).toBeNull();
  });

  it('extracts mono 16 kHz AAC audio for speech-to-text', async () => {
    const id = await upload(fx.portrait, { platforms: ['instagram'] });
    expect((await processAsset(deps, id)).ok).toBe(true);
    const audio = await extractAudio(deps, id);
    expect(audio).not.toBeNull();
    expect(audio!.mimeType).toBe('audio/mp4');
    expect(audio!.path.startsWith(path.resolve(deps.env.WORK_DIR))).toBe(true);
    expect(audio!.path.endsWith('.m4a')).toBe(true);
    expect(audio!.durationMs).toBeGreaterThan(4500);
    expect(audio!.sizeBytes).toBe((await fs.stat(audio!.path)).size);
    expect(audio!.sizeBytes).toBeLessThan(100 * 1024);
    const p = await probeVideo(audio!.path, deps).catch((e: Error) => e);
    // Audio-only file: no video stream, so probeVideo refuses it; check with raw ffprobe instead.
    expect(p).toBeInstanceOf(Error);
    const { execFileSync } = await import('node:child_process');
    const info = JSON.parse(
      execFileSync(deps.env.FFPROBE_PATH, [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_streams',
        audio!.path,
      ]).toString(),
    ) as { streams: Array<{ codec_name: string; sample_rate: string; channels: number }> };
    expect(info.streams).toHaveLength(1);
    expect(info.streams[0]).toMatchObject({ codec_name: 'aac', sample_rate: '16000', channels: 1 });
    await fs.rm(audio!.path);
    await workDirIsClean(id);
  });

  it('marks garbage, missing and empty uploads as failed with a readable error', async () => {
    const bad = await upload(fx.garbage, { platforms: ['instagram'] });
    expect(await processAsset(deps, bad)).toEqual({ ok: false });
    expect(await asset(bad)).toMatchObject({
      status: 'failed',
      processingStep: null,
      error: 'Not a valid video file',
      masterKey: null,
    });
    expect(await frames(bad)).toEqual([]);
    await workDirIsClean(bad);

    const missing = await upload(fx.portrait);
    await storage.delete((await asset(missing)).originalKey);
    expect(await processAsset(deps, missing)).toEqual({ ok: false });
    expect((await asset(missing)).error).toContain('missing');

    // A failed asset can be retried (e.g. after re-upload) and then succeeds.
    await storage.putFile((await asset(missing)).originalKey, fx.portrait);
    expect(await processAsset(deps, missing)).toEqual({ ok: true });
    expect(await asset(missing)).toMatchObject({ status: 'processing', error: null });

    expect(await processAsset(deps, randomUUID())).toEqual({ ok: false });
  });

  it('rethrows transient storage errors instead of failing the asset', async () => {
    const id = await upload(fx.portrait);
    const flaky: ServiceDeps = {
      ...deps,
      storage: Object.assign(Object.create(storage) as LocalStorage, {
        putFile: async () => {
          throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        },
      }),
    };
    await expect(processAsset(flaky, id)).rejects.toThrow('socket hang up');
    expect((await asset(id)).status).toBe('processing');
    await workDirIsClean(id);
    // The retry (normal storage) completes.
    expect((await processAsset(deps, id)).ok).toBe(true);
  });

  it('purges the original and master but keeps the frames', async () => {
    const id = await upload(fx.portrait, { platforms: ['youtube'] });
    expect((await processAsset(deps, id)).ok).toBe(true);
    const a = await asset(id);
    await storage.putBuffer(keys.cover(id), Buffer.from('jpeg'));

    await purgeAssetMedia(deps, id);
    expect(await storage.head(a.originalKey)).toBeNull();
    expect(await storage.head(a.masterKey!)).toBeNull();
    expect(await storage.head(keys.cover(id))).toBeNull();
    expect(await storage.head(keys.frame(id, 0))).not.toBeNull();
    expect((await asset(id)).purgedAt?.toISOString()).toBe('2026-11-13T10:00:00.000Z');
    expect((await loadFramesForAi(deps, id)).length).toBeGreaterThan(0);
    // Processing a purged asset is refused.
    expect(await processAsset(deps, id, { force: true })).toEqual({ ok: false, skipped: true });
  });
});
