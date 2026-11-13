/**
 * Serializable view models shared by the Upload screen, the post editor and their server
 * actions. Types only (client-safe).
 */
import type { AssetStatus, Platform, PublishAttempt, SlotRule } from '@app/db';
import type { PostCard } from '@app/core/posts';
import type { UploadTargetInfo } from './queue';

/** The batch bar's "When" choice (same shape as batches.slot_rule). */
export type WhenRule = SlotRule;

export interface BatchSettings {
  platforms: Platform[];
  notes: string;
  when: WhenRule;
}

/** One card on the Upload screen: an asset, plus its post once the upload completed. */
export interface BatchItem {
  assetId: string;
  filename: string;
  sizeBytes: number;
  assetStatus: AssetStatus;
  sortIndex: number;
  createdAt: Date;
  notes: string;
  /** Signed read URL of the first AI frame (null until frames exist). */
  thumbUrl: string | null;
  /** null while the file is still uploading (posts are created when the upload completes). */
  post: PostCard | null;
}

export interface BatchView {
  batch: { id: string; settings: BatchSettings };
  items: BatchItem[];
}

export type AccountConnection = 'connected' | 'needs_reauth' | 'not_connected';

export interface AccountState {
  state: AccountConnection;
  /** Channel / Page / @handle, when connected. */
  name: string | null;
}

export type AccountsByPlatform = Record<Platform, AccountState>;

export interface UploadPageData {
  timezone: string;
  /** Today's date in the app time zone (YYYY-MM-DD). */
  today: string;
  defaultPlatforms: Platform[];
  accounts: AccountsByPlatform;
  view: BatchView | null;
}

/** What startUploads returns for each file (same order as the request). */
export interface StartedUpload {
  assetId: string;
  /** Position of the file in the request. */
  index: number;
  sortIndex: number;
  target: UploadTargetInfo;
  /** ms since epoch when the target was signed. */
  issuedAt: number;
  /** Local driver only: upload in chunks of this many bytes. */
  chunkSize?: number;
}

export interface EditorData {
  card: PostCard;
  timezone: string;
  /** Signed URL of the master (or the original until the master exists). */
  videoUrl: string | null;
  videoSource: 'master' | 'original' | null;
  transcriptEdited: boolean;
  /** Hashtag limit per platform (settings, capped by the platform rule). */
  hashtagMax: Record<Platform, number>;
  accounts: AccountsByPlatform;
}

export interface HistoryEntry {
  id: string;
  at: Date;
  platform: Platform;
  attemptNo: number;
  step: PublishAttempt['step'];
  outcome: PublishAttempt['outcome'];
  httpStatus: number | null;
  platformCode: string | null;
  message: string | null;
}

export interface ScheduleSummary {
  scheduled: Array<{ postId: string; at: Date; filename: string }>;
  skipped: Array<{ postId: string; reason: string; filename: string }>;
  warnings: string[];
}

export type ActionErrorCode =
  | 'unauthorized'
  | 'validation'
  | 'not_found'
  | 'not_implemented'
  | 'conflict'
  | 'upload_missing'
  | 'size_mismatch'
  | 'unavailable'
  | 'error';

export interface ActionError {
  ok: false;
  error: string;
  code: ActionErrorCode;
}

export type ActionResult<T extends object = object> = ({ ok: true } & T) | ActionError;
