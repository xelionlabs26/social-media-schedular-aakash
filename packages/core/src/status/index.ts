/**
 * The six status words the UI shows (PLAN.md §3.9), derived from internal state.
 * Pure functions: safe for client components.
 */
import type { AssetStatus, AttentionReason, Platform, ProcessingStep, TargetStatus } from '@app/db';

export type DisplayStatus =
  'processing' | 'draft' | 'scheduled' | 'publishing' | 'published' | 'needs_attention';

export const DISPLAY_STATUS_LABEL: Record<DisplayStatus, string> = {
  processing: 'Processing',
  draft: 'Draft',
  scheduled: 'Scheduled',
  publishing: 'Publishing',
  published: 'Published',
  needs_attention: 'Needs attention',
};

export const DISPLAY_STATUS_ICON: Record<DisplayStatus, string> = {
  processing: '⟳',
  draft: '✎',
  scheduled: '◷',
  publishing: '↑',
  published: '✓',
  needs_attention: '!',
};

export const PROCESSING_STEP_LABEL: Record<ProcessingStep, string> = {
  probe: 'Checking video',
  normalize: 'Converting video',
  frames: 'Analyzing',
  transcribe: 'Transcribing speech',
  generate: 'Writing captions',
};

const PLATFORM_NAME: Record<Platform, string> = {
  instagram: 'Instagram',
  youtube: 'YouTube',
  facebook: 'Facebook',
};

export function attentionMessage(
  reason: AttentionReason | null | undefined,
  platform?: Platform,
): string {
  const p = platform ? PLATFORM_NAME[platform] : 'the account';
  switch (reason) {
    case 'reconnect':
      return `Reconnect ${p}`;
    case 'upload_failed':
      return 'Upload failed';
    case 'processing_failed':
      return 'Video could not be processed';
    case 'transcribe_failed':
      return 'Speech-to-text failed';
    case 'ai_failed':
      return 'AI text failed';
    case 'spend_limit':
      return 'AI paused: spend limit';
    case 'write_manually':
      return 'Write text manually';
    case 'invalid_text':
      return 'Text breaks a platform limit';
    case 'invalid_video':
      return `Video not accepted by ${p}`;
    case 'quota':
      return `${p} daily limit reached`;
    case 'missed':
      return 'Missed: server was down';
    case 'not_connected':
      return `Connect ${p}`;
    case 'platform_error':
      return `${p} returned an error`;
    default:
      return 'Needs attention';
  }
}

export function targetDisplayStatus(
  status: TargetStatus,
  scheduledAt?: Date | null,
): DisplayStatus {
  switch (status) {
    case 'draft':
    case 'canceled':
      return 'draft';
    case 'scheduled':
    case 'preparing':
    case 'prepared':
      return 'scheduled';
    case 'publishing':
      return 'publishing';
    case 'published':
      return 'published';
    case 'failed':
    case 'missed':
    case 'needs_reauth':
      return 'needs_attention';
    default: {
      void scheduledAt;
      return 'draft';
    }
  }
}

/**
 * Status of a target as the owner sees it, taking the asset pipeline into account
 * (a target is "Processing" while its video is still being uploaded/analyzed).
 */
export function displayStatusFor(input: {
  assetStatus: AssetStatus;
  targetStatus: TargetStatus;
  scheduledAt?: Date | null;
}): DisplayStatus {
  if (input.assetStatus === 'failed') return 'needs_attention';
  if (input.assetStatus !== 'ready' && input.targetStatus === 'draft') return 'processing';
  return targetDisplayStatus(input.targetStatus, input.scheduledAt);
}

/** "Draft · overdue": a dated draft whose time has passed. */
export function isOverdueDraft(
  status: TargetStatus,
  scheduledAt: Date | null | undefined,
  now = new Date(),
) {
  return status === 'draft' && !!scheduledAt && scheduledAt.getTime() < now.getTime();
}

/** Worst-first ordering used to summarize several targets in one badge. */
const RANK: Record<DisplayStatus, number> = {
  needs_attention: 0,
  processing: 1,
  publishing: 2,
  draft: 3,
  scheduled: 4,
  published: 5,
};

export function summarizeStatuses(statuses: DisplayStatus[]): DisplayStatus {
  if (statuses.length === 0) return 'draft';
  return statuses.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));
}
