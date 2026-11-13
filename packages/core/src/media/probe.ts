/**
 * ffprobe wrapper: turns ffprobe's JSON into a small, normalized ProbeResult.
 *
 * ffprobe docs: https://ffmpeg.org/ffprobe.html (JSON writer, -show_format, -show_streams).
 */
import { promises as fs } from 'node:fs';
import type { Env } from '../env';
import { MediaToolExitError, runTool } from './process';
import type { ProbeResult } from './types';

/** The file is not something we can treat as a video. The message is shown to the owner. */
export class InvalidVideoError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InvalidVideoError';
  }
}

/** The subset of ffprobe's JSON we read. Everything is optional: ffprobe omits unknown values. */
export interface FfprobeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  bits_per_raw_sample?: string;
  field_order?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  color_transfer?: string;
  color_primaries?: string;
  color_space?: string;
  sample_rate?: string;
  channels?: number;
  bit_rate?: string;
  duration?: string;
  nb_frames?: string;
  disposition?: { attached_pic?: number };
  tags?: Record<string, string>;
  side_data_list?: Array<{ side_data_type?: string; rotation?: number }>;
}

export interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { format_name?: string; duration?: string; size?: string; bit_rate?: string };
}

/** Formats ffprobe reports for still images (a photo renamed to .mp4 is not a video). */
const IMAGE_FORMAT_RE = /(^|,)(image2|[a-z0-9]+_pipe|gif|apng|webp)(,|$)/;
const IMAGE_CODECS = new Set(['mjpeg', 'png', 'bmp', 'gif', 'webp', 'tiff', 'jpegxl', 'apng']);

const PROBE_TIMEOUT_MS = 30_000;

/** Runs ffprobe on a local file and normalizes the result. */
export async function runProbe(
  filePath: string,
  env: Pick<Env, 'FFPROBE_PATH'>,
): Promise<ProbeResult> {
  const stat = await fs.stat(filePath);
  const { stdout } = await runTool(
    env.FFPROBE_PATH,
    [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      // Plain path after `-i`-less positional arg; `file:` prefix stops a name like "http:..." or
      // "-foo" from being read as a protocol or an option.
      `file:${filePath}`,
    ],
    { timeoutMs: PROBE_TIMEOUT_MS },
  ).catch((err: unknown) => {
    // ffprobe exits non-zero when it can't find any media structure in the file.
    if (err instanceof MediaToolExitError) {
      throw new InvalidVideoError('Not a valid video file', { cause: err });
    }
    throw err;
  });
  let json: FfprobeOutput;
  try {
    json = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    throw new InvalidVideoError('Not a valid video file');
  }
  return parseProbe(json, stat.size);
}

/** Pure: normalizes ffprobe JSON. Throws InvalidVideoError when there is no usable video. */
export function parseProbe(json: FfprobeOutput, fileSizeBytes: number): ProbeResult {
  const streams = json.streams ?? [];
  const format = json.format ?? {};
  // Skip cover art ("attached_pic") which ffprobe lists as a video stream in audio files.
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video || !video.width || !video.height) {
    throw new InvalidVideoError('Not a valid video file');
  }
  const formatName = format.format_name ?? null;
  if (
    (formatName && IMAGE_FORMAT_RE.test(formatName)) ||
    IMAGE_CODECS.has(video.codec_name ?? '')
  ) {
    throw new InvalidVideoError('This is a picture, not a video');
  }
  const audio = streams.find((s) => s.codec_type === 'audio');

  const rotation = readRotation(video);
  const swap = rotation === 90 || rotation === 270;
  const avg = parseRate(video.avg_frame_rate);
  const real = parseRate(video.r_frame_rate);
  const fps = avg ?? real;
  const durationSec = num(format.duration) ?? num(video.duration) ?? 0;

  return {
    durationMs: Math.max(0, Math.round(durationSec * 1000)),
    width: swap ? video.height : video.width,
    height: swap ? video.width : video.height,
    rotation,
    fps: fps !== null ? round(fps, 3) : null,
    isVfr: avg !== null && real !== null && Math.abs(real - avg) / avg > 0.01,
    vcodec: video.codec_name ?? null,
    pixFmt: video.pix_fmt ?? null,
    bitDepth: bitDepthOf(video.pix_fmt, video.bits_per_raw_sample),
    interlaced: isInterlaced(video.field_order),
    acodec: audio?.codec_name ?? null,
    audioSampleRate: num(audio?.sample_rate),
    hasAudio: Boolean(audio),
    colorTransfer: video.color_transfer ?? null,
    colorPrimaries: video.color_primaries ?? null,
    colorSpace: video.color_space ?? null,
    audioChannels: audio?.channels ?? null,
    bitrate: int(video.bit_rate) ?? int(format.bit_rate),
    formatName,
    sizeBytes: fileSizeBytes || int(format.size) || 0,
  };
}

/**
 * Clockwise display rotation in degrees (0/90/180/270).
 * Newer ffmpeg reports a "Display Matrix" side data entry whose `rotation` is counter-clockwise
 * (an iPhone portrait clip shows -90); older files/builds carry a `rotate` tag that is clockwise.
 */
function readRotation(video: FfprobeStream): number {
  const matrix = video.side_data_list?.find(
    (d) => d.side_data_type === 'Display Matrix' && typeof d.rotation === 'number',
  );
  let cw: number | null = null;
  if (matrix && typeof matrix.rotation === 'number') cw = -matrix.rotation;
  else if (video.tags?.rotate !== undefined) cw = Number(video.tags.rotate);
  if (cw === null || !Number.isFinite(cw)) return 0;
  // Snap to the nearest quarter turn: arbitrary angles don't occur in camera files.
  const snapped = Math.round(cw / 90) * 90;
  return ((snapped % 360) + 360) % 360;
}

/** "30000/1001" → 29.97; "0/0" or garbage → null. */
export function parseRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [n, d] = rate.split('/').map(Number);
  if (n === undefined || !Number.isFinite(n) || n <= 0) return null;
  const den = d === undefined ? 1 : d;
  if (!Number.isFinite(den) || den <= 0) return null;
  return n / den;
}

/** yuv420p → 8, yuv420p10le → 10, p010le → 10, otherwise bits_per_raw_sample or 8. */
export function bitDepthOf(pixFmt: string | undefined, rawBits?: string): number | null {
  if (!pixFmt) return num(rawBits);
  const planar = /p(\d{2})(le|be)?$/.exec(pixFmt);
  if (planar?.[1]) return Number(planar[1]);
  const semi = /^p0(\d{2})(le|be)?$/.exec(pixFmt);
  if (semi?.[1]) return Number(semi[1]);
  return num(rawBits) ?? 8;
}

function isInterlaced(fieldOrder: string | undefined): boolean {
  return fieldOrder !== undefined && ['tt', 'bb', 'tb', 'bt'].includes(fieldOrder);
}

/** True for HLG (iPhone HDR) and PQ (HDR10 / Dolby Vision base layer) transfer curves. */
export function isHdrTransfer(colorTransfer: string | null | undefined): boolean {
  return colorTransfer === 'arib-std-b67' || colorTransfer === 'smpte2084';
}

function num(v: string | number | undefined | null): number | null {
  if (v === undefined || v === null || v === '' || v === 'N/A') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function int(v: string | undefined): number | null {
  const n = num(v);
  return n === null ? null : Math.round(n);
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
