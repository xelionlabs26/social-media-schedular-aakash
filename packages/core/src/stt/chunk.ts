/**
 * Splits audio into pieces a provider accepts (Sarvam's sync API: ≤30 s; OpenAI: ≤25 MB).
 * A ~60 s clip is only split for Sarvam; everything else passes through untouched.
 *
 * Cuts are spread evenly (70 s → 3 × ~23 s rather than 29 + 29 + 12) and moved into a nearby
 * pause when ffmpeg's silencedetect finds one, so words are less likely to be cut in half.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SttError } from './types';

export interface ChunkLimits {
  /** Longest chunk allowed, in seconds. */
  maxSeconds?: number;
  /** Largest chunk allowed, in bytes. */
  maxBytes?: number;
}

export interface FfmpegConfig {
  ffmpegPath: string;
  ffprobePath: string;
  /** Scratch directory; chunk files go into a fresh sub-directory that cleanup() removes. */
  workDir: string;
}

export interface AudioChunk {
  path: string;
  mimeType: string;
  startMs: number;
  durationMs: number;
}

export interface ChunkedAudio {
  chunks: AudioChunk[];
  /** Deletes any files this helper created. Safe to call more than once. */
  cleanup(): Promise<void>;
}

export interface Silence {
  startMs: number;
  endMs: number;
}

export interface Segment {
  startMs: number;
  durationMs: number;
}

/** Keep byte-based chunks a little under the cap: bitrate is never perfectly constant. */
const BYTE_SAFETY = 0.9;
/** Pauses shorter than this are often just gaps between words. */
const SILENCE_MIN_SECONDS = 0.3;
const SILENCE_NOISE_DB = -35;
const STDERR_TAIL_CHARS = 4000;

const EXT_BY_MIME: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/m4a': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.m4a',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'audio/ogg': '.ogg',
  'audio/webm': '.webm',
};

const MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm',
};

/** A file name with an extension that matches the audio, because OpenAI infers the format from it. */
export function uploadFilename(filePath: string, mimeType: string): string {
  const base = path.basename(filePath);
  if (path.extname(base)) return base;
  return `${base || 'audio'}${EXT_BY_MIME[mimeType.toLowerCase()] ?? '.mp3'}`;
}

/**
 * Plans chunk boundaries. Each chunk is ≤ maxMs, the number of chunks is the minimum possible,
 * and a cut lands in the middle of a pause when one is within reach of the even-split point.
 */
export function planSegments(
  durationMs: number,
  maxMs: number,
  silences: Silence[] = [],
): Segment[] {
  if (!(maxMs > 0)) throw new Error('maxMs must be positive');
  const total = Math.max(0, Math.round(durationMs));
  const segments: Segment[] = [];
  let start = 0;
  while (total - start > maxMs) {
    const remaining = total - start;
    const n = Math.ceil(remaining / maxMs);
    const ideal = start + remaining / n;
    // Never cut so early that the rest needs an extra chunk, and keep chunks reasonably long.
    const lo = Math.max(start + maxMs * 0.5, total - (n - 1) * maxMs);
    const hi = start + maxMs;
    let cut = ideal;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const s of silences) {
      const mid = (s.startMs + s.endMs) / 2;
      const distance = Math.abs(mid - ideal);
      if (mid >= lo && mid <= hi && distance < bestDistance) {
        cut = mid;
        bestDistance = distance;
      }
    }
    cut = Math.round(cut);
    segments.push({ startMs: start, durationMs: cut - start });
    start = cut;
  }
  segments.push({ startMs: start, durationMs: total - start });
  return segments;
}

/** Parses `silence_start` / `silence_end` lines from ffmpeg's silencedetect filter. */
export function parseSilences(stderr: string, durationMs?: number): Silence[] {
  const out: Silence[] = [];
  let open: number | undefined;
  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (startMatch) {
      open = Math.max(0, Number(startMatch[1]) * 1000);
      continue;
    }
    const endMatch = /silence_end:\s*([\d.]+)/.exec(line);
    if (endMatch && open !== undefined) {
      out.push({ startMs: open, endMs: Number(endMatch[1]) * 1000 });
      open = undefined;
    }
  }
  // Silence that runs to the end of the file has no silence_end line.
  if (open !== undefined && durationMs !== undefined && durationMs > open) {
    out.push({ startMs: open, endMs: durationMs });
  }
  return out.filter((s) => Number.isFinite(s.startMs) && Number.isFinite(s.endMs));
}

/**
 * Returns the audio as one or more chunks within the limits. When no split is needed the
 * original file is returned as the single chunk (and cleanup() leaves it alone).
 */
export async function chunkAudio(
  input: { filePath: string; mimeType: string; durationMs?: number },
  limits: ChunkLimits,
  config: FfmpegConfig,
  signal?: AbortSignal,
): Promise<ChunkedAudio> {
  const sizeBytes = (await fs.stat(input.filePath)).size;
  let durationMs = input.durationMs && input.durationMs > 0 ? input.durationMs : 0;
  const tooLong = () => limits.maxSeconds !== undefined && durationMs > limits.maxSeconds * 1000;
  const tooBig = limits.maxBytes !== undefined && sizeBytes > limits.maxBytes;
  // Unknown duration: ask ffprobe, but only when a time limit could apply.
  if (!durationMs && (limits.maxSeconds !== undefined || tooBig)) {
    durationMs = await probeDurationMs(input.filePath, config, signal);
  }

  const single: ChunkedAudio = {
    chunks: [{ path: input.filePath, mimeType: input.mimeType, startMs: 0, durationMs }],
    cleanup: async () => {},
  };
  if (!tooLong() && !tooBig) return single;

  let maxMs = limits.maxSeconds !== undefined ? limits.maxSeconds * 1000 : Infinity;
  if (tooBig && limits.maxBytes !== undefined) {
    // Assume a roughly constant bitrate (true for the compressed track the media module makes).
    maxMs = Math.min(maxMs, Math.floor((durationMs * limits.maxBytes * BYTE_SAFETY) / sizeBytes));
  }
  if (!(maxMs >= 1000)) {
    throw new SttError('fatal', 'Audio is too large to split into chunks the provider accepts');
  }

  const silences = await detectSilences(input.filePath, durationMs, config, signal);
  const segments = planSegments(durationMs, maxMs, silences);

  await fs.mkdir(config.workDir, { recursive: true });
  const dir = await fs.mkdtemp(path.join(config.workDir, 'stt-chunks-'));
  const cleanup = () => fs.rm(dir, { recursive: true, force: true });
  try {
    let chunks: AudioChunk[];
    try {
      chunks = await cutSegments(input, segments, dir, config, 'copy', signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      // Stream copy can fail for odd containers; re-encoding to FLAC always works and every
      // provider accepts it.
      chunks = await cutSegments(input, segments, dir, config, 'flac', signal);
    }
    if (limits.maxBytes !== undefined) {
      for (const chunk of chunks) {
        if ((await fs.stat(chunk.path)).size > limits.maxBytes) {
          throw new SttError('fatal', 'An audio chunk is still over the provider size limit');
        }
      }
    }
    return { chunks, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

async function cutSegments(
  input: { filePath: string; mimeType: string },
  segments: Segment[],
  dir: string,
  config: FfmpegConfig,
  mode: 'copy' | 'flac',
  signal?: AbortSignal,
): Promise<AudioChunk[]> {
  const sourceExt = path.extname(input.filePath).toLowerCase();
  const ext = mode === 'flac' ? '.flac' : sourceExt || EXT_BY_MIME[input.mimeType] || '.flac';
  const mimeType =
    mode === 'flac' ? 'audio/flac' : (MIME_BY_EXT[ext] ?? input.mimeType ?? 'audio/flac');
  const codec = mode === 'flac' || ext === '.flac' ? ['-c:a', 'flac'] : ['-c:a', 'copy'];
  const chunks: AudioChunk[] = [];
  for (const [i, seg] of segments.entries()) {
    const out = path.join(dir, `chunk-${String(i).padStart(3, '0')}${ext}`);
    await runFfmpeg(
      config.ffmpegPath,
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        '-y',
        // -ss before -i seeks the input; with audio-only streams every packet is a sync point.
        '-ss',
        msToSeconds(seg.startMs),
        '-i',
        input.filePath,
        '-t',
        msToSeconds(seg.durationMs),
        '-map',
        '0:a:0',
        '-vn',
        ...codec,
        out,
      ],
      signal,
    );
    const stat = await fs.stat(out);
    if (stat.size === 0) throw new SttError('fatal', 'ffmpeg wrote an empty audio chunk');
    chunks.push({ path: out, mimeType, startMs: seg.startMs, durationMs: seg.durationMs });
  }
  return chunks;
}

/** Finds pauses with ffmpeg's silencedetect. Failure only means cuts are not pause-aligned. */
async function detectSilences(
  filePath: string,
  durationMs: number,
  config: FfmpegConfig,
  signal?: AbortSignal,
): Promise<Silence[]> {
  try {
    const { stderr } = await runFfmpeg(
      config.ffmpegPath,
      [
        '-hide_banner',
        '-nostdin',
        '-nostats',
        '-i',
        filePath,
        '-vn',
        '-af',
        `silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_MIN_SECONDS}`,
        '-f',
        'null',
        '-',
      ],
      signal,
      { keepFullStderr: true },
    );
    return parseSilences(stderr, durationMs);
  } catch (err) {
    if (signal?.aborted) throw err;
    return [];
  }
}

async function probeDurationMs(
  filePath: string,
  config: FfmpegConfig,
  signal?: AbortSignal,
): Promise<number> {
  const { stdout } = await runFfmpeg(
    config.ffprobePath,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath],
    signal,
  );
  const seconds = Number(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new SttError('fatal', 'Could not read the audio duration');
  }
  return Math.round(seconds * 1000);
}

function msToSeconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

/** Runs ffmpeg/ffprobe without a shell. Errors carry a short stderr tail, never the full output. */
export function runFfmpeg(
  bin: string,
  args: string[],
  signal?: AbortSignal,
  opts: { keepFullStderr?: boolean } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      stderr += d;
      if (!opts.keepFullStderr && stderr.length > STDERR_TAIL_CHARS * 2) {
        stderr = stderr.slice(-STDERR_TAIL_CHARS);
      }
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (signal?.aborted) return reject(signal.reason);
      if (err.code === 'ENOENT') {
        return reject(
          new SttError('fatal', `${path.basename(bin)} was not found (check FFMPEG_PATH)`),
        );
      }
      reject(new SttError('fatal', `${path.basename(bin)} failed to start: ${err.message}`));
    });
    child.on('close', (code) => {
      if (signal?.aborted) return reject(signal.reason);
      if (code === 0) return resolve({ stdout, stderr });
      const tail = stderr.trim().slice(-500);
      reject(new SttError('fatal', `${path.basename(bin)} exited with code ${code}: ${tail}`));
    });
  });
}
