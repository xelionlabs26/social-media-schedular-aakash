/**
 * Pure helpers about target state shared by the services and the engine.
 */
import type { MissedPolicy, Platform, PostTarget, TargetStatus } from '@app/db';
import { PLATFORM_LABELS } from '../platforms/rules';
import { charCount } from '../text';
import { SCHEDULING } from './config';

/** Statuses that occupy a posting slot (collisions, rolling-window limits). */
export const SLOT_OCCUPYING_STATUSES: TargetStatus[] = [
  'scheduled',
  'preparing',
  'prepared',
  'publishing',
  'published',
];

/** A worker is running a platform call for the target right now. */
export const IN_FLIGHT_STATUSES: TargetStatus[] = ['preparing', 'publishing'];

type RemoteFields = Pick<PostTarget, 'remoteContainerId' | 'remoteUploadUri' | 'remoteMediaId'>;

/** Something exists on the platform (container, upload session or video) for this target. */
export function hasRemote(t: RemoteFields): boolean {
  return Boolean(t.remoteContainerId || t.remoteUploadUri || t.remoteMediaId);
}

/**
 * The target was handed to a platform: a later change must be pushed there (needsSync) or the
 * remote item removed (cancel). Published targets are final and never handed back.
 */
export function isHandedOver(t: RemoteFields & Pick<PostTarget, 'status'>): boolean {
  if (t.status === 'published') return false;
  return IN_FLIGHT_STATUSES.includes(t.status) || t.status === 'prepared' || hasRemote(t);
}

export const CLEARED_REMOTE = {
  remoteContainerId: null,
  remoteUploadUri: null,
  remoteUploadOffset: null,
  remoteMediaId: null,
  remoteUrl: null,
} as const;

export function isLocked(t: Pick<PostTarget, 'lockedUntil'>, now: Date): boolean {
  return t.lockedUntil !== null && t.lockedUntil.getTime() > now.getTime();
}

export type LateDecision = 'on_time' | 'publish_late' | 'missed';

/**
 * Missed-post policy (PLAN.md §5.8). A post is "late" when we are past its time by more than a
 * few minutes and the delay was not one the engine chose on purpose (retry backoff, polling,
 * quota wait); those keep going as long as their own schedule is honored.
 */
export function lateDecision(
  t: Pick<PostTarget, 'scheduledAt' | 'nextAttemptAt'>,
  settings: { missedPolicy: MissedPolicy; lateGraceMinutes: number },
  now: Date,
): LateDecision {
  if (!t.scheduledAt) return 'on_time';
  const lateBy = now.getTime() - t.scheduledAt.getTime();
  if (lateBy <= SCHEDULING.missedAfterMs) return 'on_time';
  if (t.nextAttemptAt && now.getTime() - t.nextAttemptAt.getTime() <= SCHEDULING.missedAfterMs) {
    return 'on_time';
  }
  switch (settings.missedPolicy) {
    case 'publish_late':
      return 'publish_late';
    case 'publish_late_or_ask':
      return lateBy <= settings.lateGraceMinutes * 60_000 ? 'publish_late' : 'missed';
    case 'ask':
    case 'skip':
    default:
      return 'missed';
  }
}

export const platformLabel = (p: Platform): string => PLATFORM_LABELS[p];

/** Short human name of a post for alerts: YouTube title, first caption line, or the file name. */
export function postName(
  target: Pick<PostTarget, 'title' | 'body'>,
  asset: { filename: string },
): string {
  const firstLine =
    target.body
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? '';
  const name = target.title.trim() || firstLine || asset.filename;
  return charCount(name) > 50 ? `${Array.from(name).slice(0, 49).join('')}…` : name;
}

export function truncate(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
