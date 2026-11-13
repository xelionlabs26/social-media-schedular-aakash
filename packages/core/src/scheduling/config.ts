/**
 * Tunables of the scheduling engine (PLAN.md §5). One place so the services, the engine and the
 * tests agree on every number.
 */
import { minutes, hours } from '../time';

export const SCHEDULING = {
  /** "Next free slot" never offers an instant earlier than now + this. */
  minLeadMs: minutes(15),
  /** Posting time used when the owner has not set up a weekly grid (PLAN.md §11 B2.1). */
  defaultSlotTime: '18:00',
  /** How far ahead "Next free slot" looks before giving up. */
  slotSearchDays: 366,

  /** Retryable platform errors: 6 tries over ~1 hour (PLAN.md §5.5). */
  maxAttempts: 6,
  backoffBaseSec: 120,
  backoffMaxSec: 1800,
  /** Quota errors without a Retry-After hint wait this long. */
  defaultQuotaRetrySec: 3600,

  /**
   * Delays up to this are re-enqueued with pg-boss `startAfter`. Longer delays are left to the
   * once-a-minute dispatcher, which reads `next_attempt_at` from the database. Keeping queued
   * jobs short-lived means a "Retry now" or an edit never waits behind a far-deferred job (target
   * queues allow one queued job per target).
   */
  shortDelaySec: 120,

  /** Native mode: check the platform really published this long after the time. */
  verifyDelayMs: minutes(5),
  /** A post this late (and not delayed on purpose by a retry) counts as missed (§5.8). */
  missedAfterMs: minutes(5),
  /** Stop polling a platform that keeps saying "still processing" this long after the time. */
  waitLimitMs: hours(6),
  /** A native upload must be handed over at least this long before the publish time. */
  uploadDeadlineLeadMs: minutes(10),
  /** "Retry now": give the reconcile job this long before the dispatcher prepares again. */
  reconcileGraceMs: minutes(2),

  /** Lock durations equal the pg-boss job expiry of each queue (core/jobs QUEUE_OPTIONS). */
  lockMs: {
    prepare: minutes(60),
    publish: minutes(15),
    reconcile: minutes(5),
    cancel: minutes(5),
  },

  /** Token-health: warn when a login expires within this many days (§5.7). */
  expiryWarnDays: 10,
  /** Pre-flight check window before app-mode posts (§5.8). */
  preflightMs: minutes(60),
  /** Upper bound of rows handled per dispatcher/watchdog pass. */
  batchSize: 200,
} as const;

/** Backoff for the n-th failed attempt (1-based): 2, 4, 8, 16, 30 min — about an hour in total. */
export function backoffSec(attempt: number, retryAfterSec?: number): number {
  const exp = SCHEDULING.backoffBaseSec * 2 ** Math.max(0, attempt - 1);
  return Math.max(Math.min(exp, SCHEDULING.backoffMaxSec), retryAfterSec ?? 0);
}
