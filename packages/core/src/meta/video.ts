/**
 * Video helpers shared by the Facebook and Instagram publishers: which file to send, its size,
 * and whether a clip qualifies as a Facebook Reel.
 */
import type { AppSettings, MediaAsset, PostTarget } from '@app/db';
import { PlatformError, RULES } from '../platforms';
import type { Storage } from '../storage';

/** Key of the file we publish (the normalized master; the original if there is no master). */
export function publishKey(asset: MediaAsset): string {
  return asset.masterKey ?? asset.originalKey;
}

export async function videoSize(storage: Storage, asset: MediaAsset): Promise<number> {
  const key = publishKey(asset);
  const info = await storage.head(key);
  if (!info || info.size <= 0) {
    throw new PlatformError('fatal', 'The video file is missing from storage.', {
      code: 'file_missing',
    });
  }
  return info.size;
}

/** A signed URL Meta can fetch, valid long enough for its fetcher (≥ 1 h, PLAN.md §5.2). */
export async function publicVideoUrl(storage: Storage, asset: MediaAsset): Promise<string | null> {
  if (!storage.publicReadUrls) return null;
  return storage.getReadUrl(publishKey(asset), { expiresInSec: 3 * 3600 });
}

/** Display width/height after rotation metadata. */
function displayDims(asset: MediaAsset): { w: number; h: number } | null {
  if (!asset.width || !asset.height) return null;
  const rotated = Math.abs(asset.rotation ?? 0) % 180 === 90;
  return rotated ? { w: asset.height, h: asset.width } : { w: asset.width, h: asset.height };
}

/**
 * Reel when 3–90 s, aspect between 16:9 and 9:16, at least 540×960 and 24–60 fps
 * (https://developers.facebook.com/docs/video-api/guides/reels-publishing, "Video specifications").
 * Missing probe data counts as "fits": the owner's videos are vertical ~60 s clips, and Meta
 * will still reject a bad file with a clear spec error.
 */
export function qualifiesAsReel(asset: MediaAsset): boolean {
  const r = RULES.facebook.reel;
  if (asset.durationMs != null) {
    const sec = asset.durationMs / 1000;
    if (sec < r.minSec || sec > r.maxSec) return false;
  }
  const dims = displayDims(asset);
  if (dims) {
    const ratio = dims.w / dims.h;
    if (ratio > 16 / 9 + 1e-3 || ratio < 9 / 16 - 1e-3) return false;
    if (Math.min(dims.w, dims.h) < r.minWidth || Math.max(dims.w, dims.h) < r.minHeight)
      return false;
  }
  if (asset.fps != null && (asset.fps < r.minFps - 0.5 || asset.fps > r.maxFps + 0.5)) return false;
  return true;
}

export function facebookKind(
  target: PostTarget,
  settings: AppSettings,
  asset: MediaAsset,
): 'reel' | 'video' {
  const kind = target.options?.fbKind ?? settings.facebookDefaults?.kind ?? 'auto';
  if (kind === 'reel' || kind === 'video') return kind;
  return qualifiesAsReel(asset) ? 'reel' : 'video';
}

/** Unix seconds. */
export const unixSeconds = (d: Date) => Math.floor(d.getTime() / 1000);
