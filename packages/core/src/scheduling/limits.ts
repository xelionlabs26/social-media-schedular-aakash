/**
 * Daily platform limits (PLAN.md §5.6). Counted from api_calls on the day the API call is made,
 * not the publish day:
 * - YouTube: uploads (videos.insert) per Pacific-time day, kept at RULES.youtube.uploadsPerDaySafe.
 * - Facebook: Reel uploads per rolling 24 h per Page (RULES.facebook.reelsPer24h).
 * - Instagram: API posts per rolling 24 h; the publisher reads the live quota, we only warn.
 */
import {
  and,
  asc,
  count,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  apiCalls,
  postTargets,
  posts,
  type ApiCallKind,
  type Db,
  type Platform,
  type PostTarget,
} from '@app/db';
import { RULES } from '../platforms/rules';
import {
  addLocalDays,
  formatShort,
  hours,
  localToUtc,
  minutes,
  pacificDayKey,
  startOfPacificDay,
} from '../time';
import { SCHEDULING } from './config';
import { SLOT_OCCUPYING_STATUSES } from './model';

const PACIFIC = RULES.youtube.quotaTimezone;

/** Start of the Pacific-time day `offset` days after the one containing `at`. */
export function pacificDayStart(at: Date, offset = 0): Date {
  if (offset === 0) return startOfPacificDay(at);
  return localToUtc(addLocalDays(pacificDayKey(at), offset), '00:00', PACIFIC);
}

/** No remote item yet: the next prepare makes the (capped) upload call. */
const noRemoteSql = and(
  isNull(postTargets.remoteContainerId),
  isNull(postTargets.remoteUploadUri),
  isNull(postTargets.remoteMediaId),
)!;

/** Platforms whose uploads the engine throttles itself. */
export const CAPPED_PLATFORMS: Platform[] = ['youtube', 'facebook'];

interface CapRule {
  kind: ApiCallKind;
  limit: number;
  windowStart: Date;
  /** Facebook counts per Page; YouTube per Google project (every channel). */
  perAccount: boolean;
}

function capRule(platform: Platform, now: Date): CapRule | null {
  if (platform === 'youtube') {
    return {
      kind: 'yt_insert',
      limit: RULES.youtube.uploadsPerDaySafe,
      windowStart: startOfPacificDay(now),
      perAccount: false,
    };
  }
  if (platform === 'facebook') {
    return {
      kind: 'fb_reel_start',
      limit: RULES.facebook.reelsPer24h,
      windowStart: new Date(now.getTime() - hours(24)),
      perAccount: true,
    };
  }
  return null;
}

export interface CapCheck {
  capped: boolean;
  /** When an upload slot opens again (only when capped). */
  opensAt?: Date;
  used: number;
  limit: number;
}

/**
 * Can this target make its upload call now? Counts calls already made in the window, uploads in
 * flight that have not recorded their call yet, and due uploads with an earlier publish time
 * (earliest publish time goes first). Run it under the platform's advisory lock (see
 * `capLockKey`) together with the lock acquisition, so two workers can't both take the last slot.
 */
export async function checkUploadCap(
  db: Db,
  target: Pick<PostTarget, 'id' | 'platform' | 'socialAccountId' | 'scheduledAt'>,
  now: Date,
): Promise<CapCheck> {
  const rule = capRule(target.platform, now);
  if (!rule) return { capped: false, used: 0, limit: Infinity };
  const accountCond = (
    col: typeof apiCalls.socialAccountId | typeof postTargets.socialAccountId,
  ) => (rule.perAccount && target.socialAccountId ? eq(col, target.socialAccountId) : undefined);

  const [calls] = await db
    .select({ n: count() })
    .from(apiCalls)
    .where(
      and(
        eq(apiCalls.kind, rule.kind),
        gte(apiCalls.at, rule.windowStart),
        accountCond(apiCalls.socialAccountId),
      ),
    );
  const sameScope: SQL[] = [
    eq(postTargets.platform, target.platform),
    sql`${postTargets.id} <> ${target.id}`,
    noRemoteSql,
  ];
  const acc = accountCond(postTargets.socialAccountId);
  if (acc) sameScope.push(acc);

  const [inFlight] = await db
    .select({ n: count() })
    .from(postTargets)
    .where(and(...sameScope, eq(postTargets.status, 'preparing')));

  const scheduledAt = target.scheduledAt ?? now;
  const [earlier] = await db
    .select({ n: count() })
    .from(postTargets)
    .innerJoin(posts, and(eq(posts.id, postTargets.postId), isNull(posts.deletedAt)))
    .where(
      and(
        ...sameScope,
        eq(postTargets.status, 'scheduled'),
        isNotNull(postTargets.publishMode),
        lte(postTargets.prepareAt, now),
        or(isNull(postTargets.nextAttemptAt), lte(postTargets.nextAttemptAt, now)),
        or(isNull(postTargets.lockedUntil), lte(postTargets.lockedUntil, now)),
        or(
          sql`${postTargets.scheduledAt} < ${scheduledAt}`,
          and(eq(postTargets.scheduledAt, scheduledAt), sql`${postTargets.id} < ${target.id}`),
        ),
      ),
    );

  const used = (calls?.n ?? 0) + (inFlight?.n ?? 0);
  const ahead = used + (earlier?.n ?? 0);
  if (ahead < rule.limit) return { capped: false, used, limit: rule.limit };

  let opensAt: Date;
  if (target.platform === 'youtube') {
    opensAt = new Date(pacificDayStart(now, 1).getTime() + minutes(1));
  } else {
    // The k-th oldest call in the window has to age out before a slot frees up for us.
    const k = ahead - rule.limit + 1;
    const [oldest] = await db
      .select({ at: apiCalls.at })
      .from(apiCalls)
      .where(
        and(
          eq(apiCalls.kind, rule.kind),
          gte(apiCalls.at, rule.windowStart),
          accountCond(apiCalls.socialAccountId),
        ),
      )
      .orderBy(asc(apiCalls.at))
      .offset(k - 1)
      .limit(1);
    opensAt = oldest
      ? new Date(oldest.at.getTime() + hours(24) + minutes(1))
      : new Date(now.getTime() + minutes(15));
  }
  return { capped: true, opensAt, used, limit: rule.limit };
}

/** Advisory-lock key that serializes cap checks of one platform (and Page). */
export function capLockKey(target: Pick<PostTarget, 'platform' | 'socialAccountId'>): string {
  return target.platform === 'facebook'
    ? `upload-cap:facebook:${target.socialAccountId ?? 'none'}`
    : `upload-cap:${target.platform}`;
}

/**
 * Latest moment the upload may start so the post still goes out on time. YouTube needs the
 * video handed over (with its publish time) a little before the time; Facebook falls back to
 * "upload as draft, publish at the time" (app mode), so it only needs to start before the time.
 */
export function uploadDeadline(platform: Platform, scheduledAt: Date): Date {
  return platform === 'youtube'
    ? new Date(scheduledAt.getTime() - SCHEDULING.uploadDeadlineLeadMs)
    : scheduledAt;
}

// ---------------------------------------------------------------------------------------------
// Schedule-time warnings ("Schedule" click)
// ---------------------------------------------------------------------------------------------

/**
 * Warns when any rolling 24 h window that contains one of the new times holds more posts than
 * the platform allows through its API (Facebook 30 Reels, Instagram ~50 posts).
 */
export async function rollingWindowWarnings(
  db: Db,
  newTimes: Array<{ platform: Platform; at: Date }>,
  tz: string,
): Promise<string[]> {
  const warnings: string[] = [];
  const checks: Array<{
    platform: Platform;
    limit: number;
    text: (n: number, from: Date) => string;
  }> = [
    {
      platform: 'facebook',
      limit: RULES.facebook.reelsPer24h,
      text: (n, from) =>
        `Facebook: ${n} posts within 24 hours from ${formatShort(from, tz)}, but Facebook allows ${RULES.facebook.reelsPer24h} Reels per 24 hours through its API. Some uploads will wait; spread them out if they must go out on time.`,
    },
    {
      platform: 'instagram',
      limit: RULES.instagram.publishesPer24hAssumed,
      text: (n, from) =>
        `Instagram: ${n} posts within 24 hours from ${formatShort(from, tz)}, but Instagram allows about ${RULES.instagram.publishesPer24hAssumed} API posts per 24 hours. Posts over the limit may fail; spread them out.`,
    },
  ];
  for (const check of checks) {
    const mine = newTimes.filter((n) => n.platform === check.platform).map((n) => n.at.getTime());
    if (mine.length === 0) continue;
    const lo = new Date(Math.min(...mine) - hours(24));
    const hi = new Date(Math.max(...mine) + hours(24));
    const rows = await db
      .select({ at: postTargets.scheduledAt })
      .from(postTargets)
      .innerJoin(posts, and(eq(posts.id, postTargets.postId), isNull(posts.deletedAt)))
      .where(
        and(
          eq(postTargets.platform, check.platform),
          inArray(postTargets.status, SLOT_OCCUPYING_STATUSES),
          gte(postTargets.scheduledAt, lo),
          lte(postTargets.scheduledAt, hi),
        ),
      );
    const times = rows.map((r) => r.at!.getTime()).sort((a, b) => a - b);
    // Sliding window [times[i], times[i] + 24 h): the busiest window that touches a new time.
    let worst: { n: number; from: number } | null = null;
    for (let i = 0, j = 0; i < times.length; i++) {
      while (j < times.length && times[j]! - times[i]! < hours(24)) j++;
      const n = j - i;
      const touchesNew = mine.some((m) => m >= times[i]! && m - times[i]! < hours(24));
      if (n > check.limit && touchesNew && (!worst || n > worst.n)) worst = { n, from: times[i]! };
    }
    if (worst) warnings.push(check.text(worst.n, new Date(worst.from)));
  }
  return warnings;
}

export interface YoutubeUploadPlan {
  /** Uploads per Pacific day, in order (index 0 = today). */
  perDay: Array<{ dayStart: Date; count: number }>;
  /** Targets that can't be uploaded before their time even if uploads start right away. */
  impossible: string[];
}

/**
 * Simulates the throttled YouTube upload queue (earliest publish time first, at most
 * uploadsPerDaySafe per Pacific day) for every YouTube target still waiting to be uploaded.
 */
export async function planYoutubeUploads(db: Db, now: Date): Promise<YoutubeUploadPlan> {
  const cap = RULES.youtube.uploadsPerDaySafe;
  const pending = await db
    .select({ id: postTargets.id, scheduledAt: postTargets.scheduledAt })
    .from(postTargets)
    .innerJoin(posts, and(eq(posts.id, postTargets.postId), isNull(posts.deletedAt)))
    .where(
      and(
        eq(postTargets.platform, 'youtube'),
        eq(postTargets.status, 'scheduled'),
        isNotNull(postTargets.scheduledAt),
        noRemoteSql,
      ),
    )
    .orderBy(asc(postTargets.scheduledAt), asc(postTargets.id));
  const [calls] = await db
    .select({ n: count() })
    .from(apiCalls)
    .where(and(eq(apiCalls.kind, 'yt_insert'), gte(apiCalls.at, startOfPacificDay(now))));
  const [inFlight] = await db
    .select({ n: count() })
    .from(postTargets)
    .where(
      and(eq(postTargets.platform, 'youtube'), eq(postTargets.status, 'preparing'), noRemoteSql),
    );
  const usedToday = (calls?.n ?? 0) + (inFlight?.n ?? 0);

  const perDay: YoutubeUploadPlan['perDay'] = [];
  const impossible: string[] = [];
  let day = 0;
  let usedOnDay = usedToday;
  for (const t of pending) {
    while (usedOnDay >= cap) {
      day++;
      usedOnDay = 0;
    }
    usedOnDay++;
    // Dense list: days without uploads (e.g. today, when its quota is used up) stay at 0.
    while (perDay.length <= day) {
      perDay.push({ dayStart: pacificDayStart(now, perDay.length), count: 0 });
    }
    perDay[day]!.count++;
    const uploadAt = day === 0 ? now : perDay[day]!.dayStart;
    if (uploadAt.getTime() > uploadDeadline('youtube', t.scheduledAt!).getTime())
      impossible.push(t.id);
  }
  return { perDay, impossible };
}

/** Null when every pending upload can go up today. */
export function describeYoutubeSpread(plan: YoutubeUploadPlan, tz: string): string | null {
  const later = plan.perDay.slice(1).filter((d) => d.count > 0);
  if (later.length === 0) return null;
  const today = plan.perDay[0]?.count ?? 0;
  const parts = [
    ...(today ? [`${today} now`] : []),
    ...later.map((d) => `${d.count} from ${formatShort(d.dayStart, tz)}`),
  ];
  return `YouTube allows about ${RULES.youtube.uploadsPerDaySafe} uploads per day, so uploads are spread out: ${parts.join(', ')}. Each video still goes live at its own time.`;
}
