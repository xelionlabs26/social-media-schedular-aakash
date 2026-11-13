/** Shared types of the media module (re-exported from `@app/core/media`). */

export interface ProbeResult {
  durationMs: number;
  /** Display size after applying rotation. */
  width: number;
  height: number;
  /** Clockwise degrees the player rotates the coded picture: 0, 90, 180 or 270. */
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
  /** Video stream bitrate (bits/s) when the container reports it, else the overall bitrate. */
  bitrate: number | null;
  formatName: string | null;
  sizeBytes: number;
  /** Color primaries / matrix (e.g. 'bt2020', 'bt2020nc'); used for HDR tone mapping. */
  colorPrimaries?: string | null;
  colorSpace?: string | null;
  audioChannels?: number | null;
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
