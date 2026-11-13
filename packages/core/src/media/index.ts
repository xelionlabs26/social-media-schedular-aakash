/**
 * Video pipeline: probe, validate, normalize, frames, audio. (Module owner: media.)
 * Runs in the worker. Uses ffprobe/ffmpeg from env.FFPROBE_PATH / env.FFMPEG_PATH.
 */
import type { AssetWarning, Platform } from '@app/db';
import { NotImplementedError, type ServiceDeps } from '../deps';

export interface ProbeResult {
  durationMs: number;
  /** Display size after applying rotation. */
  width: number;
  height: number;
  rotation: number;
  fps: number | null;
  /** True when the frame rate is variable (phone clips). */
  isVfr: boolean;
  vcodec: string | null;
  pixFmt: string | null;
  bitDepth: number | null;
  interlaced: boolean;
  acodec: string | null;
  audioSampleRate: number | null;
  hasAudio: boolean;
  colorTransfer: string | null;
  bitrate: number | null;
  formatName: string | null;
  sizeBytes: number;
}

export interface AiFrame {
  idx: number;
  tMs: number;
  source: 'hook' | 'uniform' | 'scene';
  jpeg: Buffer;
}

export interface ExtractedAudio {
  /** Local file path inside WORK_DIR (caller may delete it afterwards). */
  path: string;
  mimeType: string;
  durationMs: number;
  sizeBytes: number;
}

/** Runs ffprobe and normalizes its JSON. */
export async function probeVideo(
  _filePath: string,
  _deps?: Pick<ServiceDeps, 'env'>,
): Promise<ProbeResult> {
  throw new NotImplementedError('media.probeVideo');
}

/** Platform warnings shown on the card before scheduling (see RULES). */
export function videoWarnings(_probe: ProbeResult, _platforms: Platform[]): AssetWarning[] {
  throw new NotImplementedError('media.videoWarnings');
}

/**
 * Full pipeline for an uploaded asset: probe → warnings → normalize (or fast-path remux) →
 * master in storage → AI frames in storage + media_frames rows. Updates media_assets
 * (status/processingStep/probe fields/warnings/masterKey/error). Returns ok=false and marks the
 * asset failed when the video can't be processed.
 */
export async function processAsset(_deps: ServiceDeps, _assetId: string): Promise<{ ok: boolean }> {
  throw new NotImplementedError('media.processAsset');
}

/** Compressed mono 16 kHz audio for speech-to-text, or null when the video has no audio. */
export async function extractAudio(
  _deps: ServiceDeps,
  _assetId: string,
): Promise<ExtractedAudio | null> {
  throw new NotImplementedError('media.extractAudio');
}

/** Loads the stored AI frames (JPEG bytes) in order. */
export async function loadFramesForAi(_deps: ServiceDeps, _assetId: string): Promise<AiFrame[]> {
  throw new NotImplementedError('media.loadFramesForAi');
}

/** Deletes the asset's original/master/frames/covers from storage and sets purged_at. */
export async function purgeAssetMedia(_deps: ServiceDeps, _assetId: string): Promise<void> {
  throw new NotImplementedError('media.purgeAssetMedia');
}
