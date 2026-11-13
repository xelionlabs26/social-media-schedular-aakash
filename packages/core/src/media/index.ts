/**
 * Video pipeline: probe, validate, normalize, frames, audio. (Module owner: media.)
 * Runs in the worker. Uses ffprobe/ffmpeg from env.FFPROBE_PATH / env.FFMPEG_PATH.
 *
 * Flow for one upload (PLAN.md §4.2, §7):
 *   original (storage) → ffprobe → warnings → remux or normalize → master (storage)
 *   → AI frames (storage + media_frames) → status stays 'processing', step 'transcribe'.
 * Scratch files live in WORK_DIR/<assetId>/ and are removed when the step ends.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import {
  batches,
  mediaAssets,
  mediaFrames,
  postTargets,
  posts,
  type AssetWarning,
  type MediaAsset,
  type Platform,
  type ProcessingStep,
} from '@app/db';
import type { ServiceDeps } from '../deps';
import { getEnv } from '../env';
import { getSettings } from '../settings';
import { keys, streamToBuffer } from '../storage';
import {
  detectScenes,
  extractFrame,
  frameSize,
  framePath,
  planFrames,
  type SceneCut,
} from './frames';
import { InvalidVideoError, isHdrTransfer, runProbe } from './probe';
import {
  MediaToolError,
  MediaToolExitError,
  MediaToolTimeoutError,
  listFilters,
  runTool,
} from './process';
import {
  normalizeArgs,
  normalizeTimeoutMs,
  planMaster,
  remuxArgs,
  type FilterSupport,
} from './transcode';
import type { AiFrame, ExtractedAudio, ProbeResult } from './types';
import { WARNING_CODES, videoWarnings as computeWarnings } from './warnings';

export type { AiFrame, ExtractedAudio, ProbeResult } from './types';
export { InvalidVideoError, isHdrTransfer, parseProbe } from './probe';
export { planMaster, fpsWindow, type MasterPlan } from './transcode';
export { planFrames, frameSize } from './frames';
export { WARNING_CODES, formatDuration } from './warnings';
export {
  MediaToolError,
  MediaToolExitError,
  MediaToolSpawnError,
  MediaToolTimeoutError,
} from './process';

/** Sanity limit: longer uploads are rejected outright (no platform flow needs them). */
export const MAX_DURATION_MS = 60 * 60_000;
const REMUX_TIMEOUT_MS = 5 * 60_000;
const AUDIO_TIMEOUT_MS = 10 * 60_000;
const INT32_MAX = 2_147_483_647;

/** Runs ffprobe and normalizes its JSON. Throws InvalidVideoError for non-video files. */
export async function probeVideo(
  filePath: string,
  deps?: Pick<ServiceDeps, 'env'>,
): Promise<ProbeResult> {
  return runProbe(filePath, deps?.env ?? getEnv());
}

/** Platform warnings shown on the card before scheduling (see RULES). */
export function videoWarnings(probe: ProbeResult, platforms: Platform[]): AssetWarning[] {
  return computeWarnings(probe, platforms);
}

// ---------------------------------------------------------------------------------------------
// processAsset
// ---------------------------------------------------------------------------------------------

export interface ProcessAssetOptions {
  /** Re-run even when the asset was already processed (e.g. "Retry processing" on a ready asset). */
  force?: boolean;
}

/** A failure that is the video's fault: the asset is marked failed with this message. */
class AssetFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetFailure';
  }
}

type Stage = 'download' | 'probe' | 'normalize' | 'frames' | 'upload';

const STAGE_MESSAGES: Record<Stage, string> = {
  download: 'Could not read the uploaded file. Please upload it again.',
  probe: 'Not a valid video file',
  normalize:
    'Could not convert this video. The file may be damaged or use a format we cannot read.',
  frames: 'Could not read pictures from this video. The file may be damaged.',
  upload: 'Could not save the processed video.',
};

/**
 * Full pipeline for an uploaded asset: probe → warnings → normalize (or fast-path remux) →
 * master in storage → AI frames in storage + media_frames rows. Updates media_assets
 * (status/processingStep/probe fields/warnings/masterKey/error). Returns ok=false and marks the
 * asset failed when the video can't be processed.
 *
 * Idempotent: a re-run redoes the work and replaces the master and frames. If the asset is
 * already past this step (processing → transcribe/generate with a master and frames) it returns
 * without redoing anything (ok=true only while it still waits for transcription); a 'ready' asset is left alone (ok=false, skipped=true)
 * unless `force` is set, so a duplicate job can't restart transcription and overwrite text.
 *
 * Throws only for transient problems (storage/network/disk, ffmpeg missing) so the job retries.
 */
export async function processAsset(
  deps: ServiceDeps,
  assetId: string,
  opts: ProcessAssetOptions = {},
): Promise<{ ok: boolean; skipped?: boolean }> {
  const log = deps.log.child('media');
  const asset = await loadAsset(deps, assetId);
  if (!asset) {
    log.warn('processAsset: asset not found', { assetId });
    return { ok: false };
  }
  if (asset.purgedAt) {
    log.warn('processAsset: media already purged', { assetId });
    return { ok: false, skipped: true };
  }
  if (!opts.force) {
    if (asset.status === 'ready') return { ok: false, skipped: true };
    if (await alreadyProcessed(deps, asset)) {
      // Still waiting for transcription: ok=true so the caller (re)queues it, which covers a
      // worker crash between this step and enqueueing the next. Once text generation has
      // started, transcription is done; re-queueing it would redo work, so report ok=false.
      return { ok: asset.processingStep === 'transcribe', skipped: true };
    }
  }

  const workDir = assetWorkDir(deps, assetId);
  let stage: Stage = 'download';
  try {
    await fs.rm(workDir, { recursive: true, force: true });
    await fs.mkdir(workDir, { recursive: true });
    await setStep(deps, assetId, 'probe', { error: null });

    // 1. Download the original.
    if (!(await deps.storage.head(asset.originalKey))) {
      throw new AssetFailure('The uploaded file is missing. Please upload it again.');
    }
    const originalPath = path.join(workDir, `original${safeExt(asset.originalKey)}`);
    await deps.storage.downloadToFile(asset.originalKey, originalPath);

    // 2. Probe + sanity limits + first warnings (shown while the master is being made).
    stage = 'probe';
    const probe = await runProbe(originalPath, deps.env);
    assertSane(probe);
    const platforms = await assetPlatforms(deps, asset);
    await deps.db
      .update(mediaAssets)
      .set({ ...probeColumns(probe), warnings: computeWarnings(probe, platforms) })
      .where(eq(mediaAssets.id, assetId));

    // 3. Master: remux when the original already meets every rule, else re-encode.
    stage = 'normalize';
    await setStep(deps, assetId, 'normalize');
    const masterPath = path.join(workDir, 'master.mp4');
    const plan = planMaster(probe, platforms);
    log.info('master plan', { assetId, mode: plan.mode, reasons: plan.reasons });
    await makeMaster(deps, originalPath, masterPath, probe, plan.mode);
    await fs.rm(originalPath, { force: true }); // free disk space early

    const master = await runProbe(masterPath, deps.env);
    if (master.durationMs <= 0) throw new AssetFailure('Video has no frames');

    stage = 'upload';
    const masterKey = keys.master(assetId);
    await deps.storage.putFile(masterKey, masterPath, 'video/mp4');
    // Final warnings describe what will be uploaded (the master). Conversion notes about the
    // original (HDR) are kept so the owner knows why colors may look different.
    const warnings = mergeWarnings(
      computeWarnings(master, platforms),
      computeWarnings(probe, platforms).filter((w) => w.code === WARNING_CODES.hdrConverted),
    );
    await deps.db
      .update(mediaAssets)
      .set({ ...probeColumns(master), warnings, masterKey, processingStep: 'frames' })
      .where(eq(mediaAssets.id, assetId));

    // 4. Frames for the AI.
    stage = 'frames';
    await makeFrames(deps, assetId, masterPath, master, workDir);

    await setStep(deps, assetId, 'transcribe');
    log.info('asset processed', { assetId, mode: plan.mode, durationMs: master.durationMs });
    return { ok: true };
  } catch (err) {
    const message = failureMessage(err, stage);
    if (message === null) throw err;
    log.warn('asset processing failed', {
      assetId,
      stage,
      error: err instanceof Error ? err.message : String(err),
      stderr: err instanceof MediaToolError ? err.stderrTail.slice(-1000) : undefined,
    });
    await deps.db
      .update(mediaAssets)
      .set({ status: 'failed', processingStep: null, error: message })
      .where(eq(mediaAssets.id, assetId));
    return { ok: false };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function makeMaster(
  deps: ServiceDeps,
  input: string,
  output: string,
  probe: ProbeResult,
  mode: 'remux' | 'normalize',
): Promise<void> {
  const ffmpeg = deps.env.FFMPEG_PATH;
  if (mode === 'remux') {
    try {
      await runTool(ffmpeg, remuxArgs(input, output, probe), { timeoutMs: REMUX_TIMEOUT_MS });
      return;
    } catch (err) {
      // An odd container can refuse a stream copy into MP4; re-encoding still works then.
      if (!(err instanceof MediaToolExitError) || isDiskFull(err)) throw err;
      deps.log.child('media').warn('remux failed, normalizing instead', { error: err.message });
    }
  }
  const filters = await filterSupport(ffmpeg);
  if (isHdrTransfer(probe.colorTransfer) && !filters.zscale) {
    deps.log
      .child('media')
      .warn('ffmpeg has no zscale filter; using the approximate colorspace HDR fallback');
  }
  await runTool(ffmpeg, normalizeArgs(input, output, probe, filters), {
    timeoutMs: normalizeTimeoutMs(probe.durationMs),
  });
}

async function filterSupport(ffmpegPath: string): Promise<FilterSupport> {
  const names = await listFilters(ffmpegPath);
  return {
    zscale: names.has('zscale'),
    tonemap: names.has('tonemap'),
    colorspace: names.has('colorspace'),
  };
}

async function makeFrames(
  deps: ServiceDeps,
  assetId: string,
  masterPath: string,
  master: ProbeResult,
  workDir: string,
): Promise<void> {
  const ffmpeg = deps.env.FFMPEG_PATH;
  let scenes: SceneCut[] = [];
  try {
    scenes = await detectScenes(ffmpeg, masterPath, master.durationMs);
  } catch (err) {
    // Scene frames are a bonus; the hook + uniform frames are enough for the AI.
    if (!(err instanceof MediaToolExitError || err instanceof MediaToolTimeoutError)) throw err;
    deps.log.child('media').warn('scene detection failed', { assetId, error: err.message });
  }

  const size = frameSize(master.width, master.height);
  const extracted: Array<{ tMs: number; source: AiFrame['source']; file: string }> = [];
  for (const planned of planFrames(master.durationMs, scenes)) {
    const file = framePath(workDir, extracted.length);
    if (await extractFrame(ffmpeg, masterPath, planned.tMs, size, file)) {
      extracted.push({ ...planned, file });
    }
  }
  if (extracted.length === 0) throw new AssetFailure('Video has no frames');

  // Replace old frame files (a re-run may produce fewer frames than before).
  await deps.storage.deletePrefix(framesPrefix(assetId));
  const rows: Array<typeof mediaFrames.$inferInsert> = [];
  for (const [idx, f] of extracted.entries()) {
    const key = keys.frame(assetId, idx);
    await deps.storage.putFile(key, f.file, 'image/jpeg');
    rows.push({
      assetId,
      idx,
      tMs: f.tMs,
      key,
      width: size.width,
      height: size.height,
      source: f.source,
    });
  }
  await deps.db.transaction(async (tx) => {
    await tx.delete(mediaFrames).where(eq(mediaFrames.assetId, assetId));
    await tx.insert(mediaFrames).values(rows);
  });
}

function assertSane(probe: ProbeResult): void {
  if (probe.durationMs <= 0) throw new AssetFailure('Video has no frames');
  if (probe.durationMs > MAX_DURATION_MS) {
    throw new AssetFailure('Video is longer than 60 minutes. Please upload a shorter clip.');
  }
}

/** Human-readable failure message, or null when the error is transient (caller rethrows). */
function failureMessage(err: unknown, stage: Stage): string | null {
  if (err instanceof AssetFailure) return err.message;
  if (err instanceof InvalidVideoError) return err.message;
  if (err instanceof MediaToolTimeoutError) {
    return 'Processing took too long. The video may be damaged or too large.';
  }
  if (err instanceof MediaToolExitError) {
    if (isDiskFull(err)) return null;
    return STAGE_MESSAGES[stage];
  }
  return null;
}

function isDiskFull(err: MediaToolError): boolean {
  return /no space left on device/i.test(err.stderrTail);
}

async function alreadyProcessed(deps: ServiceDeps, asset: MediaAsset): Promise<boolean> {
  if (asset.status !== 'processing') return false;
  if (asset.processingStep !== 'transcribe' && asset.processingStep !== 'generate') return false;
  if (!asset.masterKey) return false;
  const frame = await deps.db
    .select({ id: mediaFrames.id })
    .from(mediaFrames)
    .where(eq(mediaFrames.assetId, asset.id))
    .limit(1);
  return frame.length > 0 && (await deps.storage.head(asset.masterKey)) !== null;
}

/**
 * Platforms the warnings and the fast-path check consider: the post's live targets, else the
 * batch's platforms, else the default platforms from Settings.
 */
async function assetPlatforms(deps: ServiceDeps, asset: MediaAsset): Promise<Platform[]> {
  const rows = await deps.db
    .select({ platform: postTargets.platform })
    .from(postTargets)
    .innerJoin(posts, eq(posts.id, postTargets.postId))
    .where(
      and(eq(posts.assetId, asset.id), isNull(posts.deletedAt), ne(postTargets.status, 'canceled')),
    );
  if (rows.length) return unique(rows.map((r) => r.platform));
  if (asset.batchId) {
    const batch = await deps.db
      .select({ platforms: batches.platforms })
      .from(batches)
      .where(eq(batches.id, asset.batchId))
      .limit(1);
    if (batch[0]?.platforms.length) return unique(batch[0].platforms);
  }
  return unique((await getSettings(deps.db)).defaultPlatforms);
}

function probeColumns(p: ProbeResult) {
  return {
    durationMs: p.durationMs,
    width: p.width,
    height: p.height,
    rotation: p.rotation,
    fps: p.fps,
    vcodec: p.vcodec,
    acodec: p.acodec,
    hasAudio: p.hasAudio,
    colorTransfer: p.colorTransfer,
    bitrate: p.bitrate === null ? null : Math.min(p.bitrate, INT32_MAX),
  };
}

function mergeWarnings(...lists: AssetWarning[][]): AssetWarning[] {
  const out: AssetWarning[] = [];
  for (const w of lists.flat()) {
    if (!out.some((x) => x.code === w.code && x.platform === w.platform)) out.push(w);
  }
  return out;
}

async function setStep(
  deps: ServiceDeps,
  assetId: string,
  step: ProcessingStep,
  extra: Partial<Pick<MediaAsset, 'error'>> = {},
): Promise<void> {
  await deps.db
    .update(mediaAssets)
    .set({ status: 'processing', processingStep: step, ...extra })
    .where(eq(mediaAssets.id, assetId));
}

async function loadAsset(deps: ServiceDeps, assetId: string): Promise<MediaAsset | undefined> {
  const rows = await deps.db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId)).limit(1);
  return rows[0];
}

async function requireAsset(deps: ServiceDeps, assetId: string): Promise<MediaAsset> {
  const asset = await loadAsset(deps, assetId);
  if (!asset) throw new Error(`Media asset ${assetId} not found`);
  return asset;
}

function assetWorkDir(deps: ServiceDeps, assetId: string): string {
  // assetId is a uuid from our own database; the check keeps a bad id from escaping WORK_DIR.
  if (!/^[0-9a-f-]{36}$/i.test(assetId)) throw new Error(`Invalid asset id: ${assetId}`);
  return path.resolve(deps.env.WORK_DIR, assetId);
}

/** ".mov" from "uploads/<id>/original.mov" (only simple extensions; default ".mp4"). */
function safeExt(key: string): string {
  const ext = path.extname(key).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '.mp4';
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

// ---------------------------------------------------------------------------------------------
// Audio, frames, purge
// ---------------------------------------------------------------------------------------------

/** Compressed mono 16 kHz audio for speech-to-text, or null when the video has no audio. */
export async function extractAudio(
  deps: ServiceDeps,
  assetId: string,
): Promise<ExtractedAudio | null> {
  const asset = await requireAsset(deps, assetId);
  if (asset.hasAudio === false) return null;
  if (!asset.masterKey) throw new Error(`Media asset ${assetId} has no master file yet`);

  const workDir = assetWorkDir(deps, assetId);
  const localMaster = path.join(workDir, 'master.mp4');
  const downloaded = !(await fileExists(localMaster));
  if (downloaded) await deps.storage.downloadToFile(asset.masterKey, localMaster);

  // Output sits outside WORK_DIR/<assetId>/ so a later processAsset run can't delete it while
  // the caller (speech-to-text) is still reading it. The caller deletes it.
  const audioDir = path.resolve(deps.env.WORK_DIR, 'audio');
  await fs.mkdir(audioDir, { recursive: true });
  const outPath = path.join(audioDir, `${assetId}-${randomUUID().slice(0, 8)}.m4a`);
  try {
    const master = await runProbe(localMaster, deps.env);
    if (!master.hasAudio) {
      // The stored flag was unknown (or stale); remember the answer for the next run.
      await deps.db.update(mediaAssets).set({ hasAudio: false }).where(eq(mediaAssets.id, assetId));
      return null;
    }
    await runTool(
      deps.env.FFMPEG_PATH,
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        '-y',
        '-i',
        `file:${localMaster}`,
        '-map',
        '0:a:0',
        '-vn',
        // Speech-to-text only needs mono 16 kHz; 48 kbps AAC ≈ 0.36 MB per minute (PLAN §4.2).
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'aac',
        '-b:a',
        '48k',
        '-movflags',
        '+faststart',
        '-f',
        'mp4',
        `file:${outPath}`,
      ],
      { timeoutMs: AUDIO_TIMEOUT_MS },
    );
    const audio = await runProbe(outPath, deps.env).catch(() => null);
    const st = await fs.stat(outPath);
    return {
      path: outPath,
      mimeType: 'audio/mp4',
      durationMs: audio?.durationMs || master.durationMs,
      sizeBytes: st.size,
    };
  } catch (err) {
    await fs.rm(outPath, { force: true });
    throw err;
  } finally {
    if (downloaded) await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Loads the stored AI frames (JPEG bytes) in order. */
export async function loadFramesForAi(deps: ServiceDeps, assetId: string): Promise<AiFrame[]> {
  const rows = await deps.db
    .select()
    .from(mediaFrames)
    .where(eq(mediaFrames.assetId, assetId))
    .orderBy(asc(mediaFrames.idx));
  const frames: AiFrame[] = [];
  for (const row of rows) {
    const jpeg = await streamToBuffer(await deps.storage.openReadStream(row.key));
    frames.push({ idx: row.idx, tMs: row.tMs, source: row.source, jpeg });
  }
  return frames;
}

/**
 * Deletes the asset's original/master/covers from storage and sets purged_at.
 * Frames are kept on purpose: they are small and the calendar uses them as thumbnails.
 */
export async function purgeAssetMedia(deps: ServiceDeps, assetId: string): Promise<void> {
  const keepPrefix = framesPrefix(assetId);
  for (const prefix of keys.assetPrefixes(assetId)) {
    if (prefix === keepPrefix) continue;
    await deps.storage.deletePrefix(prefix);
  }
  await deps.db
    .update(mediaAssets)
    .set({ purgedAt: deps.now() })
    .where(eq(mediaAssets.id, assetId));
}

/** "frames/<assetId>/": derived from keys.frame so it follows the storage key layout. */
function framesPrefix(assetId: string): string {
  return `${path.posix.dirname(keys.frame(assetId, 0))}/`;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}
