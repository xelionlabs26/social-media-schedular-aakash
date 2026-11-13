/**
 * Background housekeeping: the watchdog (every 5 min), the daily token-health check, media
 * purge and the optional "tomorrow's posts" digest.
 */
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { mediaAssets, postTargets, posts, socialAccounts, type SocialAccount } from '@app/db';
import { purgeAssetMedia } from '../../media';
import type { AccountHealth } from '../../platforms';
import { getSettings } from '../../settings';
import { addLocalDays, days, formatInTz, formatShort, localToUtc, toLocalParts } from '../../time';
import { SCHEDULING } from '../config';
import { hasRemote, platformLabel, postName, truncate } from '../model';
import { alert, enqueue, publishingEnabled, resolveCredentials, type EngineCtx } from './context';
import { classify, flagAccount } from './transitions';

const lockExpired = (now: Date) =>
  and(isNotNull(postTargets.lockedUntil), lte(postTargets.lockedUntil, now));
const notDeleted = and(eq(posts.id, postTargets.postId), isNull(posts.deletedAt));

// ---------------------------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------------------------

/**
 * Unsticks targets whose lock expired (the worker died mid-step): an interrupted prepare goes
 * back to 'scheduled' (it resumes from the saved remote progress), an interrupted publish is
 * reconciled (never publish twice). Also re-queues pending cancels and runs the T−60 min
 * pre-flight check for posts we publish ourselves.
 */
export async function watchdog(ctx: EngineCtx): Promise<void> {
  if (!publishingEnabled(ctx, 'watchdog')) return;
  const { db } = ctx.deps;
  const now = ctx.deps.now();

  const stuckPreparing = await db
    .select({ id: postTargets.id, lockedUntil: postTargets.lockedUntil })
    .from(postTargets)
    .where(and(eq(postTargets.status, 'preparing'), lockExpired(now)))
    .limit(SCHEDULING.batchSize);
  for (const s of stuckPreparing) {
    const rows = await db
      .update(postTargets)
      .set({ status: 'scheduled', lockedUntil: null })
      .where(
        and(
          eq(postTargets.id, s.id),
          eq(postTargets.status, 'preparing'),
          eq(postTargets.lockedUntil, s.lockedUntil!),
        ),
      )
      .returning({ id: postTargets.id });
    if (rows[0]) {
      ctx.log.warn('watchdog: prepare was interrupted; it will resume', { targetId: s.id });
      await enqueue(ctx, 'prepare-target', s.id);
    }
  }

  const stuckPublishing = await db
    .select({ id: postTargets.id })
    .from(postTargets)
    .where(
      and(
        eq(postTargets.status, 'publishing'),
        or(isNull(postTargets.lockedUntil), lte(postTargets.lockedUntil, now)),
        or(isNull(postTargets.nextAttemptAt), lte(postTargets.nextAttemptAt, now)),
      ),
    )
    .limit(SCHEDULING.batchSize);
  for (const s of stuckPublishing) {
    ctx.log.warn('watchdog: publish ended without an answer; checking the platform', {
      targetId: s.id,
    });
    await enqueue(ctx, 'reconcile-target', s.id);
  }

  // Locks left behind by a reconcile/cancel that died (their status did not change).
  await db
    .update(postTargets)
    .set({ lockedUntil: null })
    .where(and(notInArray(postTargets.status, ['preparing', 'publishing']), lockExpired(now)));

  // Drafts and deleted posts whose platform copy still has to be removed.
  const pendingCancels = await db
    .select()
    .from(postTargets)
    .where(
      and(
        inArray(postTargets.status, ['draft', 'canceled']),
        or(
          isNotNull(postTargets.remoteContainerId),
          isNotNull(postTargets.remoteUploadUri),
          isNotNull(postTargets.remoteMediaId),
        ),
        or(isNull(postTargets.lockedUntil), lte(postTargets.lockedUntil, now)),
        or(isNull(postTargets.nextAttemptAt), lte(postTargets.nextAttemptAt, now)),
      ),
    )
    .limit(SCHEDULING.batchSize);
  for (const t of pendingCancels) if (hasRemote(t)) await enqueue(ctx, 'cancel-target', t.id);

  await preflight(ctx, now);
}

/** T−60 min: alert early when a post we must publish ourselves can't go out (PLAN.md §5.8). */
async function preflight(ctx: EngineCtx, now: Date): Promise<void> {
  const settings = await getSettings(ctx.deps.db);
  const rows = await ctx.deps.db
    .select({ target: postTargets, asset: mediaAssets, account: socialAccounts })
    .from(postTargets)
    .innerJoin(posts, notDeleted)
    .innerJoin(mediaAssets, eq(mediaAssets.id, posts.assetId))
    .leftJoin(socialAccounts, eq(socialAccounts.id, postTargets.socialAccountId))
    .where(
      and(
        inArray(postTargets.status, ['scheduled', 'prepared']),
        gt(postTargets.scheduledAt, now),
        lte(postTargets.scheduledAt, new Date(now.getTime() + SCHEDULING.preflightMs)),
      ),
    )
    .limit(SCHEDULING.batchSize);
  for (const { target: t, asset, account } of rows) {
    const weSend = t.publishMode === 'app' || (t.status === 'scheduled' && !hasRemote(t));
    if (!weSend) continue;
    const label = platformLabel(t.platform);
    const problem =
      !account || account.status === 'disabled'
        ? `${label} is not connected`
        : account.status !== 'active'
          ? `${label} needs reconnecting`
          : asset.status !== 'ready' || asset.purgedAt
            ? 'the video is not available'
            : null;
    if (!problem) continue;
    await alert(ctx, {
      kind: account && account.status === 'needs_reauth' ? 'needs_reauth' : 'publish_failed',
      targetId: t.id,
      message: `${label}: '${postName(t, asset)}' is due at ${formatShort(t.scheduledAt!, settings.timezone)} but ${problem}. Fix it now so it can go out on time.`,
      dedupeKey: `preflight:${t.id}:${t.scheduledAt!.getTime()}`,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Token health
// ---------------------------------------------------------------------------------------------

/**
 * Daily: every active account's integration proves its token works (Google refreshes inside the
 * integration). Broken logins pause their posts; logins that expire within 10 days get an alert.
 */
export async function tokenHealth(ctx: EngineCtx): Promise<void> {
  const { db } = ctx.deps;
  const now = ctx.deps.now();
  const settings = await getSettings(db);
  const accounts = await db.select().from(socialAccounts);
  for (const account of accounts) {
    if (account.status === 'disabled') continue;
    if (account.status === 'needs_reauth') {
      // Already broken: a daily reminder (deduplicated per day).
      await flagAccount(ctx, account, account.lastError ?? 'the login is no longer valid.');
      continue;
    }
    const integration = ctx.integrations[account.platform];
    if (!integration) continue;
    let health: AccountHealth;
    try {
      const { creds } = await resolveCredentials(db, account);
      health = await integration.checkHealth(creds);
    } catch (err) {
      const e = classify(err);
      health = { status: e.category === 'auth' ? 'needs_reauth' : 'error', message: e.message };
    }
    await db
      .update(socialAccounts)
      .set({
        lastCheckedAt: now,
        lastError:
          health.status === 'ok' ? null : truncate(health.message ?? 'Health check failed.'),
        ...(health.scopes ? { scopes: health.scopes } : {}),
        ...(health.accessExpiresAt !== undefined
          ? { accessExpiresAt: health.accessExpiresAt }
          : {}),
        ...(health.dataAccessExpiresAt !== undefined
          ? { dataAccessExpiresAt: health.dataAccessExpiresAt }
          : {}),
      })
      .where(eq(socialAccounts.id, account.id));
    if (health.status === 'needs_reauth') {
      await flagAccount(ctx, account, health.message ?? 'the login is no longer valid.');
      continue;
    }
    if (health.status === 'error') {
      ctx.log.warn('token health check failed (will retry tomorrow)', {
        accountId: account.id,
        platform: account.platform,
        message: health.message,
      });
      continue;
    }
    await warnExpiry(ctx, account, health, now, settings.timezone);
  }
}

async function warnExpiry(
  ctx: EngineCtx,
  account: SocialAccount,
  health: AccountHealth,
  now: Date,
  tz: string,
): Promise<void> {
  const dataAccess =
    health.dataAccessExpiresAt !== undefined
      ? health.dataAccessExpiresAt
      : account.dataAccessExpiresAt;
  // A Google access token lives one hour and is refreshed automatically: not worth an alert.
  const access =
    account.authKind === 'google'
      ? null
      : health.accessExpiresAt !== undefined
        ? health.accessExpiresAt
        : account.accessExpiresAt;
  const soonest = [dataAccess, access]
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  if (!soonest || soonest.getTime() - now.getTime() > days(SCHEDULING.expiryWarnDays)) return;
  const label = platformLabel(account.platform);
  const when = soonest <= now ? 'has expired' : `expires ${formatShort(soonest, tz)}`;
  await alert(ctx, {
    kind: 'token_expiring',
    message: `${label} login ${when}. Reconnect it in Settings to keep posting.`,
    dedupeKey: `expiring:${account.id}:${soonest.toISOString().slice(0, 10)}`,
    link: `${ctx.deps.env.APP_URL}/settings`,
  });
}

// ---------------------------------------------------------------------------------------------
// Media purge
// ---------------------------------------------------------------------------------------------

/** Daily: delete video files N days after every platform published (unless keepOriginals). */
export async function purgeMedia(ctx: EngineCtx): Promise<void> {
  const { db } = ctx.deps;
  const settings = await getSettings(db);
  if (settings.keepOriginals) return;
  const cutoff = new Date(ctx.deps.now().getTime() - days(settings.purgeAfterDays));
  const rows = await db
    .select({ assetId: mediaAssets.id })
    .from(mediaAssets)
    .innerJoin(posts, and(eq(posts.assetId, mediaAssets.id), isNull(posts.deletedAt)))
    .where(
      and(
        isNull(mediaAssets.purgedAt),
        sql`exists (select 1 from ${postTargets} t where t.post_id = ${posts.id} and t.status = 'published')`,
        sql`not exists (select 1 from ${postTargets} t where t.post_id = ${posts.id} and t.status not in ('published', 'canceled'))`,
        sql`(select max(coalesce(t.published_at, t.updated_at)) from ${postTargets} t where t.post_id = ${posts.id}) <= ${cutoff}`,
      ),
    )
    .orderBy(asc(mediaAssets.createdAt))
    .limit(SCHEDULING.batchSize);
  for (const { assetId } of rows) {
    try {
      await purgeAssetMedia(ctx.deps, assetId);
      ctx.log.info('media purged', { assetId });
    } catch (err) {
      ctx.log.warn('media purge failed (will retry tomorrow)', { assetId, err });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Daily digest
// ---------------------------------------------------------------------------------------------

/** "Tomorrow's posts" summary, sent in the evening when Settings → Notifications asks for it. */
export async function dailyDigest(ctx: EngineCtx): Promise<void> {
  const { db } = ctx.deps;
  const settings = await getSettings(db);
  if (!settings.dailyDigest) return;
  const tz = settings.timezone;
  const now = ctx.deps.now();
  const tomorrow = addLocalDays(toLocalParts(now, tz).date, 1);
  const from = localToUtc(tomorrow, '00:00', tz);
  const to = localToUtc(addLocalDays(tomorrow, 1), '00:00', tz);

  const rows = await db
    .select({ target: postTargets, asset: mediaAssets })
    .from(postTargets)
    .innerJoin(posts, notDeleted)
    .innerJoin(mediaAssets, eq(mediaAssets.id, posts.assetId))
    .where(
      and(
        inArray(postTargets.status, ['scheduled', 'preparing', 'prepared']),
        sql`${postTargets.scheduledAt} >= ${from}`,
        sql`${postTargets.scheduledAt} < ${to}`,
      ),
    )
    .orderBy(asc(postTargets.scheduledAt));
  const [attention] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(postTargets)
    .innerJoin(posts, notDeleted)
    .where(inArray(postTargets.status, ['failed', 'missed', 'needs_reauth']));

  // One line per post: time, platforms, name.
  const byPost = new Map<string, { at: Date; platforms: string[]; name: string }>();
  for (const { target: t, asset } of rows) {
    const line = byPost.get(t.postId) ?? {
      at: t.scheduledAt!,
      platforms: [],
      name: postName(t, asset),
    };
    line.platforms.push(platformLabel(t.platform));
    if (t.scheduledAt! < line.at) line.at = t.scheduledAt!;
    byPost.set(t.postId, line);
  }
  const day = formatInTz(from, 'EEE d MMM', tz);
  const lines = [...byPost.values()].sort((a, b) => a.at.getTime() - b.at.getTime());
  const shown = lines
    .slice(0, 20)
    .map((l) => `${formatInTz(l.at, 'HH:mm', tz)} ${l.platforms.join(', ')} · ${l.name}`);
  const message = [
    lines.length
      ? `Tomorrow (${day}): ${lines.length} post${lines.length === 1 ? '' : 's'} scheduled.`
      : `Nothing is scheduled for tomorrow (${day}).`,
    ...shown,
    ...(lines.length > shown.length ? [`+${lines.length - shown.length} more`] : []),
    ...(attention && attention.n > 0
      ? [
          `! ${attention.n} post${attention.n === 1 ? '' : 's'} need${attention.n === 1 ? 's' : ''} attention.`,
        ]
      : []),
  ].join('\n');
  await alert(ctx, { kind: 'digest', message, dedupeKey: `digest:${tomorrow}` });
}
