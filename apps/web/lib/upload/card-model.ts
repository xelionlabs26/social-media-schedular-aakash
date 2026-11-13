/**
 * Turns a batch item (server data) plus the browser's upload state into what one card shows:
 * status word + detail, progress, metadata and the action buttons. Pure and client-safe.
 */
import type { AssetWarning, Platform } from '@app/db';
import { PLATFORM_LABELS } from '@app/core/platforms';
import type { PostCard } from '@app/core/posts';
import { PROCESSING_STEP_LABEL, type DisplayStatus } from '@app/core/status';
import type { UploadItem } from './queue';
import type { BatchItem } from './types';

export type CardPhase =
  /** Upload being registered with the server (no asset id yet). */
  | 'preparing'
  /** The browser is sending (or about to send) the bytes. */
  | 'uploading'
  /** The browser gave up after the retries. */
  | 'upload_failed'
  /** Asset row says "uploading" but this browser has no file for it (page was reloaded). */
  | 'interrupted'
  /** Uploaded; everything else comes from the server. */
  | 'server';

export interface CardModel {
  phase: CardPhase;
  status: DisplayStatus;
  detail: string | null;
  /** 0–100 while uploading. */
  progress: number | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  thumb: string | null;
  warnings: AssetWarning[];
  /** Scheduled time to show (post time, or the earliest target time). */
  when: Date | null;
  /** Targets have different times ("Different time per app"). */
  whenVaries: boolean;
  platforms: Array<{ platform: Platform; status: DisplayStatus; label: string }>;
  canEdit: boolean;
  canRetryProcessing: boolean;
  /** Every target is still a draft (the card's own time picker may be shown). */
  allDrafts: boolean;
}

export interface LocalInfo {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  thumb: string | null;
}

const SEVERITY_RANK: Record<AssetWarning['severity'], number> = { block: 0, warn: 1, info: 2 };

function earliest(dates: Array<Date | null>): Date | null {
  const valid = dates.filter((d): d is Date => d instanceof Date);
  if (!valid.length) return null;
  return new Date(Math.min(...valid.map((d) => d.getTime())));
}

function postDetail(post: PostCard): string | null {
  const { asset } = post;
  if (post.display === 'processing') {
    if (asset.processingStep) return PROCESSING_STEP_LABEL[asset.processingStep];
    return asset.status === 'uploaded' ? 'Waiting to start' : null;
  }
  if (post.display === 'needs_attention') {
    if (asset.status === 'failed') return asset.error || 'Video could not be processed';
    const t = post.targets.find((x) => x.display === 'needs_attention');
    return t ? `${PLATFORM_LABELS[t.platform]}: ${t.attention ?? 'needs attention'}` : null;
  }
  if (post.display === 'draft' && post.targets.some((t) => t.overdue)) return 'overdue';
  if (post.display === 'published') return null;
  return null;
}

export function buildCardModel(
  item: Pick<BatchItem, 'assetStatus' | 'thumbUrl' | 'post'> | null,
  upload: UploadItem | undefined,
  local: LocalInfo | undefined,
): CardModel {
  const post = item?.post ?? null;
  const asset = post?.asset;
  const model: CardModel = {
    phase: 'server',
    status: post?.display ?? 'processing',
    detail: null,
    progress: null,
    durationMs: asset?.durationMs ?? local?.durationMs ?? null,
    width: asset?.width ?? local?.width ?? null,
    height: asset?.height ?? local?.height ?? null,
    thumb: item?.thumbUrl ?? local?.thumb ?? null,
    warnings: [...(asset?.warnings ?? [])].sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
    ),
    when: null,
    whenVaries: false,
    platforms: (post?.targets ?? []).map((t) => ({
      platform: t.platform,
      status: t.display,
      label: PLATFORM_LABELS[t.platform],
    })),
    canEdit: Boolean(post),
    canRetryProcessing: asset?.status === 'failed',
    allDrafts: Boolean(post?.targets.length) && post!.targets.every((t) => t.status === 'draft'),
  };

  if (post) {
    const targetTimes = post.targets.map((t) => t.scheduledAt);
    model.when = post.scheduledAt ?? earliest(targetTimes);
    const distinct = new Set(
      targetTimes.filter((d): d is Date => d instanceof Date).map((d) => d.getTime()),
    );
    model.whenVaries = distinct.size > 1;
    model.detail = postDetail(post);
    return model;
  }

  // No post yet: the upload hasn't completed (or completed moments ago).
  if (!item) {
    model.phase = 'preparing';
    model.detail = 'Preparing upload';
    model.progress = 0;
    return model;
  }
  if (!upload || upload.phase === 'canceled') {
    if (item.assetStatus === 'uploading') {
      model.phase = 'interrupted';
      model.status = 'needs_attention';
      model.detail = 'Upload interrupted';
    } else {
      model.detail = 'Finishing upload';
    }
    return model;
  }
  const pct = upload.total > 0 ? Math.floor((upload.loaded / upload.total) * 100) : 0;
  switch (upload.phase) {
    case 'queued':
      model.phase = 'uploading';
      model.detail = 'Waiting to upload';
      model.progress = 0;
      break;
    case 'uploading':
      model.phase = 'uploading';
      model.detail = upload.error ? `Uploading ${pct}% · ${upload.error}` : `Uploading ${pct}%`;
      model.progress = pct;
      break;
    case 'finalizing':
    case 'done':
      model.phase = upload.phase === 'done' ? 'server' : 'uploading';
      model.detail = 'Finishing upload';
      model.progress = 100;
      break;
    case 'failed':
      model.phase = 'upload_failed';
      model.status = 'needs_attention';
      model.detail = upload.error ?? 'Upload failed';
      break;
  }
  return model;
}
