/**
 * Master file: fast-path remux or full normalize (PLAN.md §7).
 *
 * The master is what every platform receives, so it must satisfy the strictest selected
 * platform. Remuxing (no re-encode) is preferred because it is fast and lossless, but only when
 * the original already meets every rule; phone clips with a variable frame rate, HDR or rotation
 * get normalized.
 *
 * ffmpeg references:
 * - https://ffmpeg.org/ffmpeg.html (-map, -c copy, -fps_mode, -map_metadata)
 * - https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv (-movflags +faststart,
 *   -use_editlist)
 * - https://ffmpeg.org/ffmpeg-filters.html (scale, fps, zscale, tonemap, colorspace, yadif)
 * - https://trac.ffmpeg.org/wiki/Encode/H.264 (crf / preset / maxrate+bufsize)
 */
import type { Platform } from '@app/db';
import { RULES } from '../platforms/rules';
import { isHdrTransfer } from './probe';
import type { ProbeResult } from './types';

const FAST_PATH_VCODECS = new Set(['h264', 'hevc']);
/** 8-bit 4:2:0. `yuvj420p` is the same layout with full-range flag (common from phones). */
const FAST_PATH_PIX_FMTS = new Set(['yuv420p', 'yuvj420p']);
const MAX_AUDIO_SAMPLE_RATE = 48_000;
/** Normalized output frame rate: inside every platform's range and fine for talking videos. */
export const NORMALIZED_FPS = 30;

export interface MasterPlan {
  mode: 'remux' | 'normalize';
  /** Why normalization is needed (empty for remux); logged for debugging. */
  reasons: string[];
}

/** Frame-rate window of the strictest selected platform. */
export function fpsWindow(platforms: Platform[]): { min: number; max: number } {
  if (platforms.includes('facebook')) {
    return { min: RULES.facebook.reel.minFps, max: RULES.facebook.reel.maxFps };
  }
  return { min: RULES.instagram.video.minFps, max: RULES.instagram.video.maxFps };
}

/** Decides remux vs normalize. Every rule must hold for the fast path. */
export function planMaster(probe: ProbeResult, platforms: Platform[]): MasterPlan {
  const reasons: string[] = [];
  const ig = RULES.instagram.video;

  if (!FAST_PATH_VCODECS.has(probe.vcodec ?? '')) reasons.push(`video codec ${probe.vcodec}`);
  if (!FAST_PATH_PIX_FMTS.has(probe.pixFmt ?? '') || (probe.bitDepth ?? 8) !== 8) {
    reasons.push(`pixel format ${probe.pixFmt}`);
  }
  if (probe.interlaced) reasons.push('interlaced');
  if (probe.isVfr) reasons.push('variable frame rate');
  const win = fpsWindow(platforms);
  // Small tolerance: 23.976 must pass the 23–60 window, 59.94 the 60 limit.
  if (probe.fps === null || probe.fps < win.min - 0.05 || probe.fps > win.max + 0.05) {
    reasons.push(`frame rate ${probe.fps ?? 'unknown'}`);
  }
  if (probe.bitrate === null || probe.bitrate > ig.maxBitrateBps) {
    reasons.push(`bitrate ${probe.bitrate ?? 'unknown'}`);
  }
  if (probe.sizeBytes > ig.maxBytes) reasons.push('file over 300 MB');
  if (probe.hasAudio) {
    if (probe.acodec !== 'aac') reasons.push(`audio codec ${probe.acodec}`);
    if (probe.audioSampleRate === null || probe.audioSampleRate > MAX_AUDIO_SAMPLE_RATE) {
      reasons.push(`audio sample rate ${probe.audioSampleRate ?? 'unknown'}`);
    }
  }
  if (Math.max(probe.width, probe.height) > ig.maxWidthPx) reasons.push('larger than 1920 px');
  // Not in the PLAN list but implied by it: HDR must be tone-mapped (a 10-bit check catches most
  // HDR, but 8-bit HLG exists), and rotation metadata is applied to the pixels because not every
  // platform honors the display matrix.
  if (isHdrTransfer(probe.colorTransfer)) reasons.push(`HDR (${probe.colorTransfer})`);
  if (probe.rotation !== 0) reasons.push(`rotation ${probe.rotation}`);
  if (probe.width % 2 !== 0 || probe.height % 2 !== 0) reasons.push('odd dimensions');

  return { mode: reasons.length ? 'normalize' : 'remux', reasons };
}

/** ffmpeg args for the lossless fast path. */
export function remuxArgs(input: string, output: string, probe: ProbeResult): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-i',
    `file:${input}`,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c',
    'copy',
    // Phone files carry GPS location and device tags; don't publish them.
    '-map_metadata',
    '-1',
    // Apple players (and some platform previews) only play HEVC in MP4 with the hvc1 tag.
    ...(probe.vcodec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    `file:${output}`,
  ];
}

export interface FilterSupport {
  zscale: boolean;
  tonemap: boolean;
  colorspace: boolean;
}

/** Target box: portrait (and square) clips fit 1080×1920, landscape clips 1920×1080. */
export function outputBox(width: number, height: number): { maxW: number; maxH: number } {
  return width > height ? { maxW: 1920, maxH: 1080 } : { maxW: 1080, maxH: 1920 };
}

/**
 * Video filter chain for normalize. ffmpeg auto-rotates decoded frames before this chain, so
 * `probe.width/height` (display size) are what the filters see.
 */
export function normalizeVideoFilter(probe: ProbeResult, filters: FilterSupport): string {
  const chain: string[] = [];
  if (probe.interlaced) chain.push('yadif=mode=send_frame');

  if (isHdrTransfer(probe.colorTransfer)) chain.push(...toneMapFilters(probe, filters));

  const { maxW, maxH } = outputBox(probe.width, probe.height);
  if (probe.width > maxW || probe.height > maxH) {
    // Scale DOWN only, keep the shape (never crop or pad), even dimensions for yuv420p.
    chain.push(
      `scale=w=${maxW}:h=${maxH}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    );
  } else {
    chain.push('scale=w=trunc(iw/2)*2:h=trunc(ih/2)*2');
  }
  chain.push(`fps=${NORMALIZED_FPS}`, 'format=yuv420p');
  return chain.join(',');
}

/**
 * HDR (HLG / PQ) → SDR BT.709.
 * Preferred: zscale (libzimg) to linear light, Hable tone curve, back to BT.709. This is the
 * standard ffmpeg recipe; see the zscale and tonemap sections of ffmpeg-filters.
 * Fallback without zscale: the `colorspace` filter. It has no HLG/PQ curves, so we treat the
 * input as BT.2020 10-bit SDR. HLG is designed to look acceptable that way; PQ will look flatter,
 * which is still better than uploading untagged HDR.
 */
function toneMapFilters(probe: ProbeResult, filters: FilterSupport): string[] {
  const transferIn = probe.colorTransfer === 'smpte2084' ? 'smpte2084' : 'arib-std-b67';
  const matrixIn = probe.colorSpace === 'bt2020c' ? 'bt2020c' : 'bt2020nc';
  if (filters.zscale && filters.tonemap) {
    return [
      `zscale=tin=${transferIn}:min=${matrixIn}:pin=bt2020:rin=tv:t=linear:npl=100`,
      'format=gbrpf32le',
      'zscale=p=bt709',
      'tonemap=tonemap=hable:desat=0',
      'zscale=t=bt709:m=bt709:r=tv',
    ];
  }
  if (filters.colorspace) {
    return ['colorspace=all=bt709:iall=bt2020:itrc=bt2020-10:format=yuv420p'];
  }
  return [];
}

/** ffmpeg args for the full normalize (re-encode) path. */
export function normalizeArgs(
  input: string,
  output: string,
  probe: ProbeResult,
  filters: FilterSupport,
): string[] {
  const hdr = isHdrTransfer(probe.colorTransfer);
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-i',
    `file:${input}`,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-map_metadata',
    '-1',
    '-vf',
    normalizeVideoFilter(probe, filters),
    '-fps_mode',
    'cfr',
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-maxrate',
    '20M',
    '-bufsize',
    '40M',
    '-pix_fmt',
    'yuv420p',
    // Keyframe every 2 s: platforms re-encode anyway, but regular GOPs make their seeking happy.
    '-g',
    String(NORMALIZED_FPS * 2),
    ...(hdr ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'] : []),
    ...(probe.hasAudio
      ? ['-c:a', 'aac', '-profile:a', 'aac_low', '-ar', '48000', '-ac', '2', '-b:a', '128k']
      : ['-an']),
    // No edit lists: some platform ingesters mis-handle them (A/V offset, black first frame).
    '-use_editlist',
    '0',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    `file:${output}`,
  ];
}

/** Generous timeout for a re-encode; stays under the 1 h process-asset job expiry. */
export function normalizeTimeoutMs(durationMs: number): number {
  return Math.min(50 * 60_000, 5 * 60_000 + durationMs * 4);
}
