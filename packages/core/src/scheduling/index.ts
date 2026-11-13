/**
 * Scheduling: posting slots, schedule/reschedule services used by the UI, and the publishing
 * engine used by the worker. (Module owner: scheduler.)
 */
import type { Platform, TargetOptions } from '@app/db';
import { NotImplementedError, type ServiceDeps } from '../deps';
import type { Integrations } from '../platforms';

export interface ScheduleRequest {
  postIds: string[];
  /** next_free: fill posting slots; pick: exact time(s); draft: keep as drafts (optionally dated). */
  mode: 'next_free' | 'pick' | 'draft';
  /** next_free: local date (YYYY-MM-DD, app timezone) to start from. Default: today. */
  startDate?: string;
  /** pick: one time for all given posts. */
  at?: Date;
  /** pick: per-platform override ("Different time per app"). */
  perPlatformAt?: Partial<Record<Platform, Date>>;
}

export interface ScheduleResult {
  scheduled: Array<{ postId: string; at: Date }>;
  skipped: Array<{ postId: string; reason: string }>;
  /** Human-readable warnings (e.g. "YouTube uploads spread over 2 days"). */
  warnings: string[];
}

/** The owner's explicit "Schedule" click: sets times, approves, validates, queues preparation. */
export async function schedulePosts(
  _deps: ServiceDeps,
  _req: ScheduleRequest,
): Promise<ScheduleResult> {
  throw new NotImplementedError('scheduling.schedulePosts');
}

/** Drag on the calendar / edit time. platform = only that target ("Different time per app"). */
export async function reschedulePost(
  _deps: ServiceDeps,
  _input: { postId: string; at: Date; platform?: Platform },
): Promise<void> {
  throw new NotImplementedError('scheduling.reschedulePost');
}

/** "Move to drafts": unschedules (cancels anything already handed to a platform). */
export async function moveToDrafts(_deps: ServiceDeps, _input: { postId: string }): Promise<void> {
  throw new NotImplementedError('scheduling.moveToDrafts');
}

/** Deletes the post (cancels remote scheduled items first) and its media. */
export async function deletePost(_deps: ServiceDeps, _input: { postId: string }): Promise<void> {
  throw new NotImplementedError('scheduling.deletePost');
}

/** Needs-attention fixes: retry now (checks the platform first) or move to the next free slot. */
export async function retryTarget(
  _deps: ServiceDeps,
  _input: { targetId: string; mode: 'now' | 'next_free' },
): Promise<void> {
  throw new NotImplementedError('scheduling.retryTarget');
}

/** Saves edited text/options from the editor (marks fields 'manual'; updates natively scheduled items). */
export async function updateTargetText(
  _deps: ServiceDeps,
  _input: {
    targetId: string;
    patch: {
      title?: string;
      body?: string;
      hashtags?: string[];
      tags?: string[];
      options?: TargetOptions;
    };
    expectedVersion?: number;
  },
): Promise<{ version: number }> {
  throw new NotImplementedError('scheduling.updateTargetText');
}

/** Next free posting-slot instants (UTC) starting at a local date, honoring min gap & existing posts. */
export async function nextFreeSlots(
  _deps: ServiceDeps,
  _input: { count: number; startDate?: string; platforms?: Platform[] },
): Promise<Date[]> {
  throw new NotImplementedError('scheduling.nextFreeSlots');
}

export interface Engine {
  /** Every minute: queue prepare/publish for due targets, detect missed posts. */
  dispatch(): Promise<void>;
  prepareTarget(targetId: string): Promise<void>;
  publishTarget(targetId: string): Promise<void>;
  reconcileTarget(targetId: string): Promise<void>;
  cancelTarget(targetId: string): Promise<void>;
  /** Every 5 minutes: unstick targets whose lock expired. */
  watchdog(): Promise<void>;
  /** Daily: token health / refresh, expiry warnings. */
  tokenHealth(): Promise<void>;
  /** Daily: delete media N days after everything published. */
  purgeMedia(): Promise<void>;
  dailyDigest(): Promise<void>;
}

export function createEngine(_deps: ServiceDeps, _integrations: Integrations): Engine {
  throw new NotImplementedError('scheduling.createEngine');
}
