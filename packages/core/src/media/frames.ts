/**
 * Still frames for the AI (PLAN.md §4.1): 1 hook frame at ~0.5 s + 7 evenly spaced (5%..95%)
 * + up to 4 scene changes, deduplicated, long edge 1024 px (576×1024 for 9:16), JPEG.
 *
 * Claude bills images by ceil(w/28)×ceil(h/28) tokens, so 576×1024 ≈ 777 tokens per frame.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runTool } from './process';

export type FrameSource = 'hook' | 'uniform' | 'scene';

export interface PlannedFrame {
  tMs: number;
  source: FrameSource;
}

export interface SceneCut {
  tMs: number;
  score: number;
}

export const HOOK_FRAME_MS = 500;
export const UNIFORM_FRAMES = 7;
export const MAX_SCENE_FRAMES = 4;
/** Scene-change threshold for ffmpeg's `select='gt(scene,X)'` (0..1; 0.35 ≈ a hard cut). */
export const SCENE_THRESHOLD = 0.35;
/** Frames closer than this to an already chosen frame add nothing for the AI. */
export const MIN_FRAME_GAP_MS = 500;
export const FRAME_LONG_EDGE = 1024;
/** Keep seeks this far before the end: seeking to the exact end returns no frame. */
const END_MARGIN_MS = 100;

/**
 * Pure: which timestamps to grab. Priority hook > uniform > scene (strongest cuts first) when
 * deduplicating, then sorted by time.
 */
export function planFrames(durationMs: number, scenes: SceneCut[]): PlannedFrame[] {
  if (durationMs <= 0) return [];
  const lastMs = Math.max(0, durationMs - END_MARGIN_MS);
  const clamp = (t: number) => Math.round(Math.min(Math.max(t, 0), lastMs));

  const candidates: PlannedFrame[] = [
    // Very short clips: the hook frame is the middle rather than past the end.
    { tMs: clamp(Math.min(HOOK_FRAME_MS, durationMs / 2)), source: 'hook' },
  ];
  for (let i = 0; i < UNIFORM_FRAMES; i++) {
    const fraction = 0.05 + (0.9 * i) / (UNIFORM_FRAMES - 1);
    candidates.push({ tMs: clamp(durationMs * fraction), source: 'uniform' });
  }
  const strongest = [...scenes]
    .filter((s) => s.tMs >= 0 && s.tMs <= durationMs)
    .sort((a, b) => b.score - a.score);
  for (const s of strongest) candidates.push({ tMs: clamp(s.tMs), source: 'scene' });

  const chosen: PlannedFrame[] = [];
  let sceneCount = 0;
  for (const c of candidates) {
    if (c.source === 'scene' && sceneCount >= MAX_SCENE_FRAMES) break;
    if (chosen.some((x) => Math.abs(x.tMs - c.tMs) < MIN_FRAME_GAP_MS)) continue;
    chosen.push(c);
    if (c.source === 'scene') sceneCount++;
  }
  return chosen.sort((a, b) => a.tMs - b.tMs);
}

/**
 * Output size with the long edge at 1024 (never upscaled), even numbers, shape kept.
 * 1080×1920 → 576×1024; 1920×1080 → 1024×576.
 */
export function frameSize(width: number, height: number): { width: number; height: number } {
  const long = Math.max(width, height);
  const scale = long > FRAME_LONG_EDGE ? FRAME_LONG_EDGE / long : 1;
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

/** Parses `metadata=mode=print` output: "frame:0 pts:.. pts_time:2.0" + "lavfi.scene_score=0.4". */
export function parseSceneOutput(output: string): SceneCut[] {
  const cuts: SceneCut[] = [];
  let pending: number | null = null;
  for (const line of output.split(/\r?\n/)) {
    const time = /pts_time:([0-9.]+)/.exec(line);
    if (time?.[1]) {
      pending = Number(time[1]);
      continue;
    }
    const score = /lavfi\.scene_score=([0-9.]+)/.exec(line);
    if (score?.[1] && pending !== null && Number.isFinite(pending)) {
      cuts.push({ tMs: Math.round(pending * 1000), score: Number(score[1]) });
      pending = null;
    }
  }
  return cuts;
}

/** Runs ffmpeg's scene detector on a small copy of the picture (fast; scores barely change). */
export async function detectScenes(
  ffmpegPath: string,
  input: string,
  durationMs: number,
): Promise<SceneCut[]> {
  const { stdout } = await runTool(
    ffmpegPath,
    [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-i',
      `file:${input}`,
      '-map',
      '0:v:0',
      '-an',
      '-vf',
      // metadata=print with file=- writes "frame/pts_time" + "lavfi.scene_score" lines to stdout.
      // https://ffmpeg.org/ffmpeg-filters.html#select_002c-aselect and #metadata_002c-ametadata
      `scale=w=160:h=-2,select='gt(scene,${SCENE_THRESHOLD})',metadata=mode=print:file=-`,
      '-fps_mode',
      'vfr',
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: Math.min(20 * 60_000, 2 * 60_000 + durationMs) },
  );
  return parseSceneOutput(stdout);
}

/**
 * Grabs one JPEG at `tMs`. Returns false when ffmpeg produced no image (e.g. the timestamp is
 * past the last decodable frame), so the caller can skip that frame.
 */
export async function extractFrame(
  ffmpegPath: string,
  input: string,
  tMs: number,
  size: { width: number; height: number },
  outPath: string,
): Promise<boolean> {
  await fs.rm(outPath, { force: true });
  await runTool(
    ffmpegPath,
    [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-y',
      // Input seeking (before -i) is fast and frame-accurate when transcoding.
      '-ss',
      (tMs / 1000).toFixed(3),
      '-i',
      `file:${input}`,
      '-map',
      '0:v:0',
      '-frames:v',
      '1',
      '-vf',
      `scale=w=${size.width}:h=${size.height},format=yuvj420p`,
      '-q:v',
      '3',
      '-f',
      'image2',
      `file:${outPath}`,
    ],
    { timeoutMs: 60_000 },
  );
  try {
    const st = await fs.stat(outPath);
    return st.size > 0;
  } catch {
    return false;
  }
}

export function framePath(workDir: string, idx: number): string {
  return path.join(workDir, `frame-${String(idx).padStart(2, '0')}.jpg`);
}
