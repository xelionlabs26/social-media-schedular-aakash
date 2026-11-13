/**
 * Instagram Reels publisher (Instagram API with Facebook Login). Instagram has no native
 * scheduling, so this is always app mode: create a resumable REELS container shortly before the
 * slot, upload the bytes to rupload.facebook.com, poll until FINISHED, then media_publish at the
 * slot.
 *
 * Docs:
 * - https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/content-publishing
 * - Container fields: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-container
 * - media_publish (config_issue): https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media_publish
 */
import type { PublishMode } from '@app/db';
import {
  PlatformError,
  RULES,
  isPlatformError,
  type ModeInput,
  type PlatformPublisher,
  type PublishInput,
  type ReconcileResult,
  type StepResult,
} from '../platforms';
import {
  IG_RECREATE_CONTAINER_SUBCODES,
  mapGraphError,
  parseContainerStatusCode,
  type GraphErrorDetails,
} from './errors';
import type { GraphClient } from './graph';
import { isNotFound, logFailure, logStepSafe, type MetaRuntime } from './runtime';
import { publicVideoUrl, publishKey, videoSize } from './video';

/** Meta suggests polling about once a minute; we start a little faster for short clips. */
const POLL_SEC = 30;
/** When the quota is used up we look again after this long (the window is rolling 24 h). */
const QUOTA_RETRY_SEC = 60 * 60;

type ContainerStatusCode = 'IN_PROGRESS' | 'FINISHED' | 'PUBLISHED' | 'ERROR' | 'EXPIRED';

interface ContainerStatus {
  id?: string;
  status_code?: ContainerStatusCode;
  status?: string;
}

interface IgMedia {
  id: string;
  permalink?: string;
  timestamp?: string;
  caption?: string;
}

interface Ctx {
  input: PublishInput;
  client: GraphClient;
  token: string;
  igUserId: string;
}

function ctxFor(rt: MetaRuntime, input: PublishInput): Ctx {
  const igUserId = input.account.meta.igUserId ?? input.account.externalId;
  if (!igUserId) {
    throw new PlatformError('auth', 'No Instagram account is connected. Reconnect Facebook.');
  }
  return { input, client: rt.client(input.signal), token: input.account.accessToken, igUserId };
}

/** Parses Instagram timestamps like "2026-11-13T12:30:00+0000". */
export function parseIgTimestamp(ts: string | undefined): Date | null {
  if (!ts) return null;
  const d = new Date(ts.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(d.getTime()) ? null : d;
}

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

async function getContainer(ctx: Ctx, id: string): Promise<ContainerStatus> {
  return ctx.client.get<ContainerStatus>(
    id,
    { fields: 'status_code,status' },
    ctx.token,
    'Instagram container status',
  );
}

async function clearContainer(ctx: Ctx): Promise<void> {
  await ctx.input.saveProgress({ remoteContainerId: null, remoteUploadOffset: null });
}

/** Thumb offset in ms, dropped if it is outside the video (that would fail with 2207057). */
function thumbOffset(input: PublishInput): number | undefined {
  const ms = input.target.options?.thumbOffsetMs ?? input.asset.coverFrameMs ?? undefined;
  if (ms == null || ms < 0) return undefined;
  if (input.asset.durationMs != null && ms >= input.asset.durationMs) return undefined;
  return Math.round(ms);
}

async function createContainer(ctx: Ctx): Promise<string> {
  const { input } = ctx;
  const shareToFeed =
    input.target.options?.shareToFeed ?? input.settings.instagramDefaults?.shareToFeed ?? true;
  let res: { id?: string };
  try {
    res = await ctx.client.post<{ id?: string }>(
      `${ctx.igUserId}/media`,
      {
        media_type: 'REELS',
        upload_type: 'resumable',
        caption: input.text.body || undefined,
        share_to_feed: shareToFeed,
        thumb_offset: thumbOffset(input),
      },
      ctx.token,
      'Instagram container',
    );
  } catch (err) {
    return logFailure(input, 'create_container', err);
  }
  await input.recordApiCall('ig_container');
  if (!res.id) throw new PlatformError('retryable', 'Instagram did not return a container id.');
  await input.saveProgress({ remoteContainerId: res.id, remoteUploadOffset: null });
  await logStepSafe(input, 'create_container', {
    outcome: 'ok',
    message: 'Instagram Reel container created',
    responseExcerpt: { containerId: res.id },
  });
  return res.id;
}

/**
 * Sends the video bytes to the container. Instagram documents no "bytes received" query for
 * these uploads, so a resumed upload re-sends the whole file from offset 0.
 */
async function uploadToContainer(ctx: Ctx, containerId: string): Promise<void> {
  const { input } = ctx;
  const size = await videoSize(input.storage, input.asset);
  try {
    const url = await publicVideoUrl(input.storage, input.asset);
    if (url) {
      await ctx.client.rupload(
        'ig-api-upload',
        containerId,
        ctx.token,
        { fileUrl: url },
        'Instagram upload',
      );
    } else {
      const body = await input.storage.openReadStream(publishKey(input.asset));
      await ctx.client.rupload(
        'ig-api-upload',
        containerId,
        ctx.token,
        { offset: 0, fileSize: size, body },
        'Instagram upload',
      );
    }
  } catch (err) {
    // A rejected upload leaves a useless container; start fresh next time.
    if (isPlatformError(err) && err.category !== 'retryable') await clearContainer(ctx);
    return logFailure(input, 'upload', err);
  }
  // remoteUploadOffset = size marks "bytes delivered" so a retry never uploads twice.
  await input.saveProgress({ remoteUploadOffset: size });
  await logStepSafe(input, 'upload', { outcome: 'ok', message: 'Video uploaded to Instagram' });
}

function containerError(st: ContainerStatus): PlatformError {
  const code = parseContainerStatusCode(st.status);
  const err = mapGraphError(
    undefined,
    { message: st.status || 'Instagram could not process the video', error_subcode: code },
    undefined,
    'Instagram processing',
  );
  // An ERROR container is final: anything retryable means "make a new container".
  if (err.category === 'retryable' || (code && IG_RECREATE_CONTAINER_SUBCODES.has(code))) {
    return new PlatformError('retryable', err.message, {
      code: err.code ?? 'container_error',
      retryAfterSec: 60,
      details: err.details,
    });
  }
  if (err.category === 'fatal' && !code) {
    return new PlatformError('invalid', err.message, {
      code: 'container_error',
      details: err.details,
    });
  }
  return err;
}

type Readiness =
  | { state: 'ready'; containerId: string }
  | { state: 'published'; containerId: string }
  | { state: 'wait'; result: StepResult };

/**
 * Brings the container to FINISHED: creates it, uploads, and checks status. Resumable from the
 * saved remoteContainerId / remoteUploadOffset.
 */
async function ensureContainer(ctx: Ctx): Promise<Readiness> {
  const { input } = ctx;
  let containerId = input.target.remoteContainerId;
  let uploaded = containerId != null && input.target.remoteUploadOffset != null;

  if (containerId) {
    let st: ContainerStatus | null;
    try {
      st = await getContainer(ctx, containerId);
    } catch (err) {
      if (!isNotFound(err)) return logFailure(input, 'poll', err);
      st = null;
    }
    switch (st?.status_code) {
      case 'FINISHED':
        return { state: 'ready', containerId };
      case 'PUBLISHED':
        return { state: 'published', containerId };
      case 'ERROR': {
        const err = containerError(st);
        if (err.category === 'retryable') await clearContainer(ctx);
        return logFailure(input, 'poll', err);
      }
      case 'IN_PROGRESS':
        if (uploaded) return waitResult('Instagram is processing the video');
        break; // container exists but bytes never arrived: upload below
      default:
        // EXPIRED (not published within 24 h) or gone: start over with a new container.
        await clearContainer(ctx);
        await logStepSafe(input, 'poll', {
          outcome: 'retryable',
          message: `Instagram container ${st?.status_code ?? 'missing'}; creating a new one`,
        });
        containerId = null;
        uploaded = false;
    }
  }

  if (!containerId) containerId = await createContainer(ctx);
  if (!uploaded) await uploadToContainer(ctx, containerId);

  const st = await getContainer(ctx, containerId).catch((err) => logFailure(input, 'poll', err));
  if (st.status_code === 'FINISHED') return { state: 'ready', containerId };
  if (st.status_code === 'ERROR') {
    const err = containerError(st);
    if (err.category === 'retryable') await clearContainer(ctx);
    return logFailure(input, 'poll', err);
  }
  return waitResult('Instagram is processing the video');
}

function waitResult(reason: string): Readiness {
  return { state: 'wait', result: { kind: 'wait', retryInSec: POLL_SEC, reason } };
}

/** Throws a quota error when the rolling 24 h publishing quota is used up. */
async function checkQuota(ctx: Ctx): Promise<void> {
  // https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit
  const res = await ctx.client.get<{
    data?: Array<{
      quota_usage?: number;
      config?: { quota_total?: number; quota_duration?: number };
    }>;
  }>(
    `${ctx.igUserId}/content_publishing_limit`,
    { fields: 'quota_usage,config' },
    ctx.token,
    'Instagram quota',
  );
  const row = res.data?.[0];
  const usage = Number(row?.quota_usage ?? 0);
  const total = Number(row?.config?.quota_total ?? RULES.instagram.publishesPer24hAssumed);
  if (usage >= total) {
    throw new PlatformError(
      'quota',
      `Instagram's daily publishing limit is used up (${usage}/${total} in the last 24 h).`,
      { code: 'ig_quota', retryAfterSec: QUOTA_RETRY_SEC, details: { usage, total } },
    );
  }
}

async function permalinkFor(ctx: Ctx, mediaId: string): Promise<string | undefined> {
  try {
    const res = await ctx.client.get<{ permalink?: string }>(
      mediaId,
      { fields: 'permalink' },
      ctx.token,
      'Instagram permalink',
    );
    return res.permalink;
  } catch {
    // The post is live; a missing link is cosmetic.
    return undefined;
  }
}

/**
 * After a container reports PUBLISHED but we never saved the media id (crash / timeout), find
 * the media among the latest posts: caption match first, then a single post in the time window.
 */
async function findPublishedMedia(ctx: Ctx): Promise<IgMedia | undefined> {
  const { input } = ctx;
  const res = await ctx.client.get<{ data?: IgMedia[] }>(
    `${ctx.igUserId}/media`,
    { fields: 'id,permalink,timestamp,caption', limit: 10 },
    ctx.token,
    'Instagram recent media',
  );
  const media = res.data ?? [];
  const from = new Date(
    (input.target.prepareAt ?? input.scheduledAt).getTime() - 30 * 60_000,
  ).getTime();
  const recent = media.filter((m) => (parseIgTimestamp(m.timestamp)?.getTime() ?? 0) >= from);
  const prefix = normalize(input.text.body).slice(0, 60);
  if (prefix) {
    const hit = recent.find((m) => m.caption && normalize(m.caption).startsWith(prefix));
    if (hit) return hit;
  }
  return recent.length === 1 ? recent[0] : undefined;
}

async function publishedResult(ctx: Ctx, note?: string): Promise<StepResult> {
  const found = await findPublishedMedia(ctx);
  if (!found) {
    return { kind: 'done', note: note ?? 'published (link not found yet)' };
  }
  await ctx.input.saveProgress({ remoteMediaId: found.id, remoteUrl: found.permalink ?? null });
  return { kind: 'done', remoteMediaId: found.id, remoteUrl: found.permalink, note };
}

const CONFIG_ISSUE_NOTES: Record<string, string> = {
  CAPTION_NOT_ATTACHED: 'caption not attached',
  USER_TAGGING_FAILURE: 'user tags not attached',
};

export function createInstagramPublisher(rt: MetaRuntime): PlatformPublisher {
  return {
    platform: 'instagram',

    chooseMode(): PublishMode {
      return 'app';
    },

    prepareAt({ scheduledAt, now }: ModeInput & { mode: PublishMode }): Date {
      const at = new Date(scheduledAt.getTime() - RULES.instagram.containerLeadMinutes * 60_000);
      return at < now ? now : at;
    },

    async prepare(input) {
      const ctx = ctxFor(rt, input);
      const r = await ensureContainer(ctx);
      if (r.state === 'wait') return r.result;
      return { kind: 'done' };
    },

    async publish(input) {
      const ctx = ctxFor(rt, input);
      if (input.target.remoteMediaId) {
        return {
          kind: 'done',
          remoteMediaId: input.target.remoteMediaId,
          remoteUrl: input.target.remoteUrl ?? undefined,
        };
      }
      const r = await ensureContainer(ctx);
      if (r.state === 'wait') return r.result;
      if (r.state === 'published') return publishedResult(ctx);

      try {
        await checkQuota(ctx);
      } catch (err) {
        return logFailure(input, 'publish', err);
      }

      let res: { id?: string; config_issue?: string };
      try {
        res = await ctx.client.post<{ id?: string; config_issue?: string }>(
          `${ctx.igUserId}/media_publish`,
          { creation_id: r.containerId },
          ctx.token,
          'Instagram publish',
        );
      } catch (err) {
        const d = (isPlatformError(err) ? err.details : undefined) as GraphErrorDetails | undefined;
        if (d && (d.code === 9007 || d.subcode === 2207027)) {
          // "Media not ready": the container isn't FINISHED yet. Not a failure.
          return { kind: 'wait', retryInSec: POLL_SEC, reason: 'Instagram media not ready yet' };
        }
        return logFailure(input, 'publish', err);
      }
      await input.recordApiCall('ig_publish');
      if (!res.id) {
        // The docs say: no id → check the container. Reconcile will find it.
        throw new PlatformError('retryable', 'Instagram did not return a media id.', {
          code: 'no_media_id',
          retryAfterSec: 30,
        });
      }
      await input.saveProgress({ remoteMediaId: res.id });
      const note = res.config_issue
        ? (CONFIG_ISSUE_NOTES[res.config_issue] ??
          res.config_issue.toLowerCase().replace(/_/g, ' '))
        : undefined;
      const remoteUrl = await permalinkFor(ctx, res.id);
      if (remoteUrl) await input.saveProgress({ remoteUrl });
      await logStepSafe(input, 'publish', {
        outcome: 'ok',
        message: note ? `Published to Instagram (${note})` : 'Published to Instagram',
        responseExcerpt: { mediaId: res.id, configIssue: res.config_issue },
      });
      // Partial success (e.g. caption not attached) is still a publish: never retry it.
      return { kind: 'done', remoteMediaId: res.id, remoteUrl, note };
    },

    async reconcile(input): Promise<ReconcileResult> {
      const ctx = ctxFor(rt, input);
      if (input.target.remoteMediaId) {
        return {
          published: true,
          remoteMediaId: input.target.remoteMediaId,
          remoteUrl:
            input.target.remoteUrl ?? (await permalinkFor(ctx, input.target.remoteMediaId)),
        };
      }
      const containerId = input.target.remoteContainerId;
      if (!containerId) return { published: false };
      let st: ContainerStatus;
      try {
        st = await getContainer(ctx, containerId);
      } catch (err) {
        if (isNotFound(err)) return { published: false };
        throw err;
      }
      if (st.status_code !== 'PUBLISHED') return { published: false };
      const found = await findPublishedMedia(ctx);
      if (found) {
        await input.saveProgress({ remoteMediaId: found.id, remoteUrl: found.permalink ?? null });
      }
      return { published: true, remoteMediaId: found?.id, remoteUrl: found?.permalink };
    },

    async cancel(input) {
      // Never delete published media here. Unpublished containers can't be deleted via the API;
      // they expire on their own after 24 h, so we just forget them.
      if (input.target.remoteMediaId || input.target.status === 'published') return;
      if (!input.target.remoteContainerId) return;
      await input.saveProgress({ remoteContainerId: null, remoteUploadOffset: null });
      await logStepSafe(input, 'cancel', {
        outcome: 'ok',
        message: 'Unpublished Instagram container discarded (it expires on its own)',
      });
    },

    async update() {
      // Containers are cheap: the engine discards and recreates with the new text.
      return false;
    },
  };
}
