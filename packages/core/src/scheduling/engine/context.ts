/**
 * Engine plumbing: loading a target with everything a platform step needs, building the
 * PublishInput the integrations receive, and queuing follow-up jobs and alerts.
 */
import { eq } from 'drizzle-orm';
import {
  apiCalls,
  mediaAssets,
  postTargets,
  posts,
  publishAttempts,
  socialAccounts,
  type AppSettings,
  type Db,
  type MediaAsset,
  type Platform,
  type Post,
  type PostTarget,
  type PublishAttempt,
  type PublishMode,
  type SocialAccount,
} from '@app/db';
import { decryptAccount, saveAccessToken } from '../../accounts';
import type { ServiceDeps } from '../../deps';
import { targetJobOptions, type NotifyJob } from '../../jobs';
import { redact, type Logger } from '../../log';
import {
  PlatformError,
  type AccountCredentials,
  type FinalText,
  type Integrations,
  type PlatformPublisher,
  type PublishInput,
  type RemoteProgress,
  type StepLog,
} from '../../platforms';
import { getSettings } from '../../settings';
import { composeFinalBody, stripAngleBrackets } from '../../text';
import { SCHEDULING } from '../config';
import { platformLabel, truncate } from '../model';

export type TargetQueue =
  'prepare-target' | 'publish-target' | 'reconcile-target' | 'cancel-target';

export interface EngineCtx {
  deps: ServiceDeps;
  integrations: Integrations;
  log: Logger;
}

/** A target with its post, video, account and the app settings. */
export interface Bundle {
  target: PostTarget;
  post: Post;
  asset: MediaAsset;
  account: SocialAccount | null;
  settings: AppSettings;
}

export async function loadBundle(ctx: EngineCtx, targetId: string): Promise<Bundle | null> {
  const rows = await ctx.deps.db
    .select({ target: postTargets, post: posts, asset: mediaAssets, account: socialAccounts })
    .from(postTargets)
    .innerJoin(posts, eq(posts.id, postTargets.postId))
    .innerJoin(mediaAssets, eq(mediaAssets.id, posts.assetId))
    .leftJoin(socialAccounts, eq(socialAccounts.id, postTargets.socialAccountId))
    .where(eq(postTargets.id, targetId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { ...row, settings: await getSettings(ctx.deps.db) };
}

export function publishingEnabled(ctx: EngineCtx, what: string, targetId?: string): boolean {
  if (ctx.deps.env.PUBLISHING_ENABLED) return true;
  ctx.log.info('dry run: PUBLISHING_ENABLED=false, no platform call made', {
    step: what,
    targetId,
  });
  return false;
}

/** The platform's publisher, or the reason there is none (missing or unfinished integration). */
export function getPublisher(
  ctx: EngineCtx,
  platform: Platform,
): { ok: true; publisher: PlatformPublisher } | { ok: false; message: string } {
  try {
    const integration = ctx.integrations[platform];
    if (!integration) throw new Error('no integration');
    return { ok: true, publisher: integration.publisher };
  } catch {
    return { ok: false, message: `Publishing to ${platformLabel(platform)} is not available.` };
  }
}

// ---------------------------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------------------------

/**
 * Decrypted credentials for the account. An Instagram row may not hold a token of its own: it
 * then uses the Page token of the Facebook row named in meta.pageAccountId.
 */
export async function resolveCredentials(
  db: Db,
  account: SocialAccount,
): Promise<{ creds: AccountCredentials; tokenOwner: SocialAccount }> {
  const label = platformLabel(account.platform);
  const decrypt = (row: SocialAccount) => {
    try {
      return decryptAccount(row);
    } catch {
      throw new PlatformError('auth', `The saved ${label} login could not be read. Reconnect it.`, {
        code: 'token_unreadable',
      });
    }
  };
  if (account.accessTokenEnc) return { creds: decrypt(account), tokenOwner: account };
  const pageAccountId = account.meta.pageAccountId;
  if (typeof pageAccountId === 'string') {
    const [page] = await db
      .select()
      .from(socialAccounts)
      .where(eq(socialAccounts.id, pageAccountId));
    if (page?.accessTokenEnc) {
      if (page.status !== 'active') {
        throw new PlatformError('auth', 'The Facebook Page login needs reconnecting.', {
          code: 'page_needs_reauth',
        });
      }
      const pc = decrypt(page);
      return {
        creds: {
          ...pc,
          accountId: account.id,
          platform: account.platform,
          externalId: account.externalId,
          scopes: account.scopes.length ? account.scopes : pc.scopes,
          meta: { ...page.meta, ...account.meta },
        },
        tokenOwner: page,
      };
    }
  }
  throw new PlatformError('auth', `${label} has no saved login. Reconnect it.`, {
    code: 'no_token',
  });
}

// ---------------------------------------------------------------------------------------------
// PublishInput
// ---------------------------------------------------------------------------------------------

/** Text sent to the platform: YouTube forbids < and >; hashtags are appended to the body. */
export function finalText(t: PostTarget): FinalText {
  const youtube = t.platform === 'youtube';
  return {
    title: youtube ? stripAngleBrackets(t.title.trim()) : t.title.trim(),
    body: composeFinalBody(t.platform, t.body, t.hashtags),
    tags: youtube ? t.tags.map((tag) => stripAngleBrackets(tag).trim()).filter(Boolean) : t.tags,
  };
}

const REMOTE_KEYS = [
  'remoteContainerId',
  'remoteUploadUri',
  'remoteUploadOffset',
  'remoteMediaId',
  'remoteUrl',
] as const;

function pickRemote(patch: RemoteProgress): RemoteProgress {
  const out: Record<string, unknown> = {};
  for (const k of REMOTE_KEYS) if (patch[k] !== undefined) out[k] = patch[k];
  return out as RemoteProgress;
}

/** Response excerpts are redacted and capped so History never stores tokens or huge bodies. */
function excerpt(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  const clean = redact(value);
  const json = JSON.stringify(clean) ?? '';
  return json.length > 4000 ? { truncated: json.slice(0, 4000) } : clean;
}

export async function logAttempt(
  ctx: EngineCtx,
  targetId: string,
  attemptNo: number,
  step: PublishAttempt['step'],
  log: StepLog,
  startedAt?: Date,
): Promise<void> {
  try {
    const now = ctx.deps.now();
    await ctx.deps.db.insert(publishAttempts).values({
      targetId,
      attemptNo,
      step,
      outcome: log.outcome,
      httpStatus: log.httpStatus ?? null,
      platformCode: log.platformCode ?? null,
      message: log.message ? truncate(log.message, 1000) : null,
      responseExcerpt: excerpt(log.responseExcerpt),
      startedAt: startedAt ?? now,
      finishedAt: now,
    });
  } catch (err) {
    // History is informational: never fail a platform step because the log row failed.
    ctx.log.warn('could not write publish attempt', { targetId, step, err });
  }
}

/**
 * Builds the input for one platform step. `target` inside it is a copy kept up to date by
 * saveProgress, so a later call in the same step sees the remote ids saved earlier.
 */
export async function buildInput(
  ctx: EngineCtx,
  b: Bundle,
  mode: PublishMode,
  lockMs: number,
): Promise<PublishInput> {
  const { db } = ctx.deps;
  if (!b.account) {
    throw new PlatformError('auth', `${platformLabel(b.target.platform)} is not connected.`, {
      code: 'not_connected',
    });
  }
  const { creds, tokenOwner } = await resolveCredentials(db, b.account);
  const target: PostTarget = { ...b.target };
  const attemptNo = target.attempts + 1;
  const accountId = b.account.id;
  return {
    target,
    asset: b.asset,
    settings: b.settings,
    account: creds,
    storage: ctx.deps.storage,
    text: finalText(target),
    scheduledAt: target.scheduledAt ?? ctx.deps.now(),
    now: ctx.deps.now(),
    mode,
    // Remote ids are written by id only (no status check): they must never be lost, even when
    // the owner changed the target meanwhile (the engine then cancels them).
    async saveProgress(patch) {
      const clean = pickRemote(patch);
      if (Object.keys(clean).length === 0) return;
      await db.update(postTargets).set(clean).where(eq(postTargets.id, target.id));
      Object.assign(target, clean);
    },
    async recordApiCall(kind) {
      await db.insert(apiCalls).values({
        platform: target.platform,
        socialAccountId: accountId,
        kind,
        targetId: target.id,
        at: ctx.deps.now(),
      });
    },
    logStep: (step, log) => logAttempt(ctx, target.id, attemptNo, step, log),
    async onTokenRefreshed(accessToken, expiresAt) {
      await saveAccessToken(db, tokenOwner, accessToken, expiresAt);
    },
    // Stop the platform call before our lock runs out, so the watchdog never takes over a step
    // that is still running.
    signal: AbortSignal.timeout(Math.max(lockMs - 30_000, 30_000)),
  };
}

// ---------------------------------------------------------------------------------------------
// Jobs and alerts
// ---------------------------------------------------------------------------------------------

/**
 * Queues a target job. Delays longer than SCHEDULING.shortDelaySec are not queued: the
 * dispatcher picks the target up from its next_attempt_at / prepare_at / scheduled_at.
 */
export async function enqueue(
  ctx: EngineCtx,
  queue: TargetQueue,
  targetId: string,
  delayMs = 0,
): Promise<void> {
  if (delayMs > SCHEDULING.shortDelaySec * 1000) return;
  const extra = delayMs > 0 ? { startAfter: Math.ceil(delayMs / 1000) } : {};
  try {
    await ctx.deps.jobs.send(queue, { targetId }, targetJobOptions(targetId, extra));
  } catch (err) {
    ctx.log.warn('could not queue job; the dispatcher will pick it up', { queue, targetId, err });
  }
}

export type Alert = Omit<NotifyJob, 'link'> & { link?: string };

/** Queues an owner alert (deduplicated by dedupeKey in core/notify). Never throws. */
export async function alert(ctx: EngineCtx, job: Alert): Promise<void> {
  try {
    await ctx.deps.jobs.send('notify', {
      ...job,
      link: job.link ?? `${ctx.deps.env.APP_URL}/calendar`,
    });
  } catch (err) {
    ctx.log.warn('could not queue alert', { kind: job.kind, err });
  }
}
