/**
 * Plain-English warnings shown on the video card before scheduling (PLAN.md §2 and §7).
 *
 * Severities:
 * - block: the platform will reject the video; that platform can't be scheduled.
 * - warn:  it will post, but probably not how the owner expects (e.g. not as a Short).
 * - info:  good to know (e.g. posts as a normal Page video instead of a Reel).
 *
 * Codes are stable snake_case identifiers; the UI and other modules may match on them.
 */
import type { AssetWarning, Platform } from '@app/db';
import { RULES } from '../platforms/rules';
import { isHdrTransfer } from './probe';
import type { ProbeResult } from './types';

export const WARNING_CODES = {
  over60s: 'over_60s',
  ytNotShortLong: 'yt_not_short_long',
  ytNotShortLandscape: 'yt_not_short_landscape',
  fbReelTooLong: 'fb_reel_too_long',
  fbReelAspect: 'fb_reel_aspect',
  fbReelTooSmall: 'fb_reel_too_small',
  fbReelFps: 'fb_reel_fps',
  fbTooShort: 'fb_too_short',
  fbTooLong: 'fb_too_long',
  fbTooLarge: 'fb_too_large',
  igTooShort: 'ig_too_short',
  igTooLong: 'ig_too_long',
  igTooLarge: 'ig_too_large',
  noAudio: 'no_audio',
  hdrConverted: 'hdr_converted',
} as const;

const C = WARNING_CODES;
/** Aspect ratios within 1% of the 9:16 / 16:9 bounds still count (encoders round sizes). */
const ASPECT_TOLERANCE = 0.01;

export function videoWarnings(probe: ProbeResult, platforms: Platform[]): AssetWarning[] {
  const out: AssetWarning[] = [];
  const has = (p: Platform) => platforms.includes(p);
  const sec = probe.durationMs / 1000;
  const length = formatDuration(probe.durationMs);
  const landscape = probe.width > probe.height;

  if (has('youtube')) {
    if (sec > RULES.youtube.copyrightBlockOverSec) {
      out.push({
        code: C.over60s,
        platform: 'youtube',
        severity: 'warn',
        message:
          `${length} long: YouTube blocks Shorts over 1 minute worldwide if they get any ` +
          `copyright claim (e.g. popular music). Trim it in your phone's editor, or keep it if ` +
          `there's no copyrighted music.`,
      });
    }
    if (sec > RULES.youtube.shortMaxSec) {
      out.push({
        code: C.ytNotShortLong,
        platform: 'youtube',
        severity: 'warn',
        message: `${length} long: YouTube won't treat it as a Short (Shorts are up to 3 minutes).`,
      });
    }
    if (landscape) {
      out.push({
        code: C.ytNotShortLandscape,
        platform: 'youtube',
        severity: 'warn',
        message:
          "Wide (landscape) video: YouTube won't treat it as a Short. Shorts must be vertical or square.",
      });
    }
  }

  if (has('facebook')) {
    const reel = RULES.facebook.reel;
    const notReel = 'will post as a normal Page video, not a Reel.';
    if (sec < reel.minSec) {
      out.push({
        code: C.fbTooShort,
        platform: 'facebook',
        severity: 'block',
        message: `${length} long: Facebook needs videos of at least ${reel.minSec} seconds.`,
      });
    } else if (sec > RULES.facebook.video.maxSec) {
      out.push({
        code: C.fbTooLong,
        platform: 'facebook',
        severity: 'block',
        message: `${length} long: too long for Facebook (max ${RULES.facebook.video.maxSec / 60} minutes).`,
      });
    } else if (sec > reel.maxSec) {
      out.push({
        code: C.fbReelTooLong,
        platform: 'facebook',
        severity: 'info',
        message: `${length} long: too long for a Facebook Reel (max ${reel.maxSec} s), ${notReel}`,
      });
    }
    if (probe.sizeBytes > RULES.facebook.video.maxBytes) {
      out.push({
        code: C.fbTooLarge,
        platform: 'facebook',
        severity: 'block',
        message: `File is ${formatMb(probe.sizeBytes)}: too large for Facebook (max 2 GB).`,
      });
    }
    const ratio = probe.width / probe.height;
    if (ratio < (9 / 16) * (1 - ASPECT_TOLERANCE) || ratio > (16 / 9) * (1 + ASPECT_TOLERANCE)) {
      out.push({
        code: C.fbReelAspect,
        platform: 'facebook',
        severity: 'info',
        message: `Shape ${probe.width}×${probe.height} is outside 9:16 to 16:9, so Facebook ${notReel}`,
      });
    }
    const short = Math.min(probe.width, probe.height);
    const long = Math.max(probe.width, probe.height);
    if (short < reel.minWidth || long < reel.minHeight) {
      out.push({
        code: C.fbReelTooSmall,
        platform: 'facebook',
        severity: 'info',
        message: `${probe.width}×${probe.height} is smaller than 540×960, so Facebook ${notReel}`,
      });
    }
    if (probe.fps !== null && (probe.fps < reel.minFps - 0.01 || probe.fps > reel.maxFps + 0.01)) {
      out.push({
        code: C.fbReelFps,
        platform: 'facebook',
        severity: 'info',
        message: `${formatFps(probe.fps)} fps is outside 24–60 fps, so Facebook ${notReel}`,
      });
    }
  }

  if (has('instagram')) {
    const ig = RULES.instagram.video;
    if (sec < ig.minSec) {
      out.push({
        code: C.igTooShort,
        platform: 'instagram',
        severity: 'block',
        message: `${length} long: Instagram needs Reels of at least ${ig.minSec} seconds.`,
      });
    } else if (sec > ig.maxSec) {
      out.push({
        code: C.igTooLong,
        platform: 'instagram',
        severity: 'block',
        message: `${length} long: too long for an Instagram Reel (max ${ig.maxSec / 60} minutes).`,
      });
    }
    if (probe.sizeBytes > ig.maxBytes) {
      out.push({
        code: C.igTooLarge,
        platform: 'instagram',
        severity: 'warn',
        message:
          `File is ${formatMb(probe.sizeBytes)} after conversion: Instagram accepts up to 300 MB, ` +
          `so the upload will likely fail. Trim or compress it in your phone's editor.`,
      });
    }
  }

  if (!probe.hasAudio) {
    out.push({
      code: C.noAudio,
      severity: 'info',
      message: 'No sound in this video. Captions will be written from the pictures only.',
    });
  }
  if (isHdrTransfer(probe.colorTransfer)) {
    out.push({
      code: C.hdrConverted,
      severity: 'info',
      message:
        'HDR video: colors will be converted to normal (SDR) so they look right on every platform.',
    });
  }
  return out;
}

/** 130000 → "2:10", 5000 → "0:05". */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function formatFps(fps: number): string {
  return Number.isInteger(fps) ? String(fps) : fps.toFixed(2);
}
