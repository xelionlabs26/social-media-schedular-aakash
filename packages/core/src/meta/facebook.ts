/**
 * Facebook Page publisher: Reels (Reels Publishing API) and normal Page videos (Video API).
 *
 * Native mode (10 min – 29 days ahead): upload early and let Facebook publish at the time
 *   (Reels: video_state=SCHEDULED; videos: published=false + scheduled_publish_time).
 * App mode (< 10 min ahead): upload now, call finish with video_state=PUBLISHED at the slot, so
 *   the post never goes out early.
 *
 * Docs:
 * - https://developers.facebook.com/docs/video-api/guides/reels-publishing
 * - https://developers.facebook.com/docs/graph-api/reference/page/videos/
 */
import type { PublishMode } from '@app/db';
import {
  PlatformError,
  RULES,
  type ModeInput,
  type PlatformPublisher,
  type PublishInput,
  type ReconcileResult,
  type StepResult,
} from '../platforms';
import type { GraphClient } from './graph';
import { isNotFound, logFailure, logStepSafe, requirePageId, type MetaRuntime } from './runtime';
import { facebookKind, publicVideoUrl, publishKey, unixSeconds, videoSize } from './video';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** Meta's minimum lead for scheduled_publish_time. */
const NATIVE_MIN_MS = RULES.facebook.scheduleMinMinutes * MIN;
/** We push to Facebook this long before the slot when the slot is > 29 days out. */
const PUSH_AHEAD_MS = 28 * DAY;
/** Margin over Meta's 10-minute minimum so a slow upload can't push us under it at finish. */
const FINISH_SAFETY_MS = 60_000;
/** Non-resumable (multipart / file_url) Page video upload cap. */
const NON_RESUMABLE_MAX_BYTES = 1024 * 1024 * 1024;
/** Re-check processing after this many seconds. */
const POLL_SEC = 30;
/** After the slot, how long a natively scheduled item may lag before we flag it. */
const NATIVE_LATE_GRACE_MS = 30 * MIN;

export interface FbVideoStatus {
  id?: string;
  permalink_url?: string;
  status?: {
    video_status?: string;
    uploading_phase?: {
      status?: string;
      /** Meta's spelling. */
      bytes_transfered?: number | string;
      bytes_transferred?: number | string;
      errors?: Array<{ code?: number; message?: string }>;
    };
    processing_phase?: { status?: string; error?: { message?: string } };
    publishing_phase?: {
      status?: string;
      publish_status?: string;
      publish_time?: number;
      error?: { message?: string };
    };
  };
}

interface Ctx {
  input: PublishInput;
  client: GraphClient;
  token: string;
  pageId: string;
}

function ctxFor(rt: MetaRuntime, input: PublishInput): Ctx {
  return {
    input,
    client: rt.client(input.signal),
    token: input.account.accessToken,
    pageId: requirePageId(input),
  };
}

/** Absolute permalink (Graph sometimes returns a path like "/reel/123"). */
export function absoluteFbUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return url.startsWith('/') ? `https://www.facebook.com${url}` : url;
}

/** Returns a plain-English error if any phase failed, else null. */
export function fbStatusError(s: FbVideoStatus): string | null {
  const st = s.status;
  if (!st) return null;
  const phaseErr =
    st.processing_phase?.error?.message ??
    st.publishing_phase?.error?.message ??
    st.uploading_phase?.errors?.[0]?.message;
  if (st.video_status === 'error' || st.video_status === 'upload_failed') {
    return `Facebook could not process the video${phaseErr ? `: ${phaseErr}` : '.'}`;
  }
  if (st.processing_phase?.status === 'error' || st.publishing_phase?.status === 'error') {
    return `Facebook could not publish the video${phaseErr ? `: ${phaseErr}` : '.'}`;
  }
  if (st.publishing_phase?.publish_status === 'error') {
    return `Facebook reported a publishing error${phaseErr ? `: ${phaseErr}` : '.'}`;
  }
  return null;
}

const publishStatus = (s: FbVideoStatus) => s.status?.publishing_phase?.publish_status;

async function getStatus(ctx: Ctx, videoId: string): Promise<FbVideoStatus> {
  return ctx.client.get<FbVideoStatus>(
    videoId,
    { fields: 'status,permalink_url' },
    ctx.token,
    'Facebook status',
  );
}

function bytesTransferred(s: FbVideoStatus): number {
  const up = s.status?.uploading_phase;
  const n = Number(up?.bytes_transfered ?? up?.bytes_transferred ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ---------------------------------------------------------------------------------------------
// Reels
// ---------------------------------------------------------------------------------------------

/** upload_phase=start → video_id. Counted against the 30 Reels / 24 h Page limit. */
async function startReel(ctx: Ctx): Promise<string> {
  const res = await ctx.client.post<{ video_id?: string }>(
    `${ctx.pageId}/video_reels`,
    { upload_phase: 'start' },
    ctx.token,
    'Facebook Reel start',
  );
  await ctx.input.recordApiCall('fb_reel_start');
  if (!res.video_id) throw new PlatformError('retryable', 'Facebook did not return a video id.');
  await ctx.input.saveProgress({
    remoteContainerId: res.video_id,
    remoteUploadOffset: null,
    remoteMediaId: null,
    remoteUrl: null,
  });
  await logStepSafe(ctx.input, 'prepare', {
    outcome: 'ok',
    message: 'Facebook Reel upload session started',
    responseExcerpt: { videoId: res.video_id },
  });
  return res.video_id;
}

/** Forget a dead upload session so the next attempt starts over. */
async function clearReelSession(ctx: Ctx) {
  await ctx.input.saveProgress({
    remoteContainerId: null,
    remoteUploadOffset: null,
    remoteMediaId: null,
  });
}

/**
 * Uploads (or resumes uploading) the bytes for a Reel session. `remoteUploadOffset === size`
 * marks a finished upload so we never send the file twice.
 */
async function ensureReelUploaded(ctx: Ctx, videoId: string): Promise<void> {
  const { input } = ctx;
  const size = await videoSize(input.storage, input.asset);
  if (input.target.remoteUploadOffset === size) return;

  let offset = 0;
  if (input.target.remoteContainerId === videoId) {
    // Resuming after a crash: ask Meta how many bytes it already has.
    const s = await getStatus(ctx, videoId);
    if (s.status?.video_status === 'expired') {
      await clearReelSession(ctx);
      throw new PlatformError('retryable', 'Facebook upload session expired; starting over.', {
        code: 'session_expired',
        retryAfterSec: 5,
      });
    }
    const phase = s.status?.uploading_phase?.status;
    offset = bytesTransferred(s);
    if (phase === 'completed' || phase === 'complete' || offset >= size) {
      await input.saveProgress({ remoteUploadOffset: size });
      return;
    }
  }

  try {
    const url = await publicVideoUrl(input.storage, input.asset);
    if (url && offset === 0) {
      await ctx.client.rupload(
        'video-upload',
        videoId,
        ctx.token,
        { fileUrl: url },
        'Facebook upload',
      );
    } else {
      const body = await input.storage.openReadStream(
        publishKey(input.asset),
        offset > 0 ? { start: offset } : undefined,
      );
      await ctx.client.rupload(
        'video-upload',
        videoId,
        ctx.token,
        { offset, fileSize: size, body },
        'Facebook upload',
      );
    }
  } catch (err) {
    return logFailure(input, 'upload', err);
  }
  await input.saveProgress({ remoteUploadOffset: size });
  await logStepSafe(input, 'upload', {
    outcome: 'ok',
    message: offset > 0 ? `Upload resumed at byte ${offset}` : 'Video uploaded to Facebook',
  });
}

/** upload_phase=finish. Native: SCHEDULED with a time; app mode: PUBLISHED now. */
async function finishReel(
  ctx: Ctx,
  videoId: string,
  state: 'SCHEDULED' | 'PUBLISHED',
): Promise<void> {
  const { input } = ctx;
  const params: Record<string, string | number | undefined> = {
    upload_phase: 'finish',
    video_id: videoId,
    video_state: state,
    description: input.text.body || undefined,
    title: input.text.title?.trim() || undefined,
  };
  if (state === 'SCHEDULED') params.scheduled_publish_time = unixSeconds(input.scheduledAt);
  try {
    await ctx.client.post(`${ctx.pageId}/video_reels`, params, ctx.token, 'Facebook Reel finish');
  } catch (err) {
    return logFailure(input, state === 'SCHEDULED' ? 'prepare' : 'publish', err);
  }
  // remoteMediaId marks "finish was accepted" so a retry never calls finish twice.
  await input.saveProgress({ remoteMediaId: videoId });
  await logStepSafe(input, state === 'SCHEDULED' ? 'prepare' : 'publish', {
    outcome: 'ok',
    message:
      state === 'SCHEDULED'
        ? `Reel handed to Facebook for ${input.scheduledAt.toISOString()}`
        : 'Reel publish requested',
  });
}

// ---------------------------------------------------------------------------------------------
// Normal Page videos
// ---------------------------------------------------------------------------------------------

async function createPageVideo(ctx: Ctx, schedule: Date | null): Promise<string> {
  const { input } = ctx;
  const params: Record<string, string | number | boolean | undefined> = {
    title: input.text.title?.trim() || undefined,
    description: input.text.body || undefined,
  };
  if (schedule) {
    params.published = false;
    params.scheduled_publish_time = unixSeconds(schedule);
  } else {
    params.published = true;
  }
  const size = await videoSize(input.storage, input.asset);
  const url = await publicVideoUrl(input.storage, input.asset);
  let res: { id?: string; video_id?: string };
  try {
    if (url) {
      res = await ctx.client.post(
        `${ctx.pageId}/videos`,
        { ...params, file_url: url },
        ctx.token,
        'Facebook video',
      );
    } else {
      if (size > NON_RESUMABLE_MAX_BYTES) {
        throw new PlatformError(
          'invalid',
          'This video is over 1 GB. Facebook needs public storage (S3/R2) to fetch files this large.',
          { code: 'too_large_for_direct_upload' },
        );
      }
      const body = await input.storage.openReadStream(publishKey(input.asset));
      res = await ctx.client.postMultipart(
        `${ctx.pageId}/videos`,
        params,
        ctx.token,
        {
          field: 'source',
          filename: input.asset.filename || 'video.mp4',
          contentType: 'video/mp4',
          size,
          body,
        },
        'Facebook video',
      );
    }
  } catch (err) {
    return logFailure(input, 'upload', err);
  }
  await input.recordApiCall('fb_video');
  const id = res.id ?? res.video_id;
  if (!id) throw new PlatformError('fatal', 'Facebook did not return a video id.');
  await input.saveProgress({ remoteContainerId: id, remoteMediaId: id, remoteUploadOffset: size });
  await logStepSafe(input, 'upload', {
    outcome: 'ok',
    message: schedule
      ? `Video handed to Facebook for ${schedule.toISOString()}`
      : 'Video published to Facebook',
    responseExcerpt: { videoId: id },
  });
  return id;
}

// ---------------------------------------------------------------------------------------------
// Polling / verification
// ---------------------------------------------------------------------------------------------

/** Turns a status read into a step result for a video that was handed over. */
function evaluate(
  s: FbVideoStatus,
  videoId: string,
  expect: 'scheduled' | 'published',
): StepResult {
  const err = fbStatusError(s);
  if (err) throw new PlatformError('invalid', err, { code: 'fb_processing_error' });
  const ps = publishStatus(s);
  if (ps === 'published') {
    return { kind: 'done', remoteMediaId: videoId, remoteUrl: absoluteFbUrl(s.permalink_url) };
  }
  if (expect === 'scheduled' && ps === 'scheduled') {
    return { kind: 'done', remoteMediaId: videoId };
  }
  return {
    kind: 'wait',
    retryInSec: POLL_SEC,
    reason: `Facebook is processing the video (${s.status?.video_status ?? 'unknown'})`,
  };
}

async function poll(ctx: Ctx, videoId: string, expect: 'scheduled' | 'published') {
  let s: FbVideoStatus;
  try {
    s = await getStatus(ctx, videoId);
  } catch (err) {
    return logFailure(ctx.input, 'poll', err);
  }
  return evaluate(s, videoId, expect);
}

/** Native finish would land under Meta's 10-minute minimum. */
function tooLateForNative(input: PublishInput): boolean {
  return input.scheduledAt.getTime() - input.now.getTime() < NATIVE_MIN_MS + FINISH_SAFETY_MS;
}

function waitUntilSlot(input: PublishInput): StepResult {
  const sec = Math.ceil((input.scheduledAt.getTime() - input.now.getTime()) / 1000);
  return {
    kind: 'wait',
    retryInSec: Math.max(5, Math.min(sec, 60)),
    reason: 'Too close to the slot for Facebook scheduling; publishing at the time instead',
  };
}

// ---------------------------------------------------------------------------------------------
// Publisher
// ---------------------------------------------------------------------------------------------

export function createFacebookPublisher(rt: MetaRuntime): PlatformPublisher {
  function kindOf(input: PublishInput) {
    return facebookKind(input.target, input.settings, input.asset);
  }

  async function prepareReel(ctx: Ctx, mode: PublishMode): Promise<StepResult> {
    const { input } = ctx;
    let videoId = input.target.remoteContainerId;
    if (!videoId) videoId = await startReel(ctx);
    await ensureReelUploaded(ctx, videoId);
    // App mode: bytes are in; the PUBLISHED finish happens in publish() at the slot.
    if (mode === 'app') return { kind: 'done' };

    if (!input.target.remoteMediaId) {
      // Crash safety: finish may have been accepted before we saved it.
      const s = await getStatus(ctx, videoId);
      const ps = publishStatus(s);
      if (ps === 'scheduled' || ps === 'published') {
        await input.saveProgress({ remoteMediaId: videoId });
        return evaluate(s, videoId, 'scheduled');
      }
      if (tooLateForNative(input)) {
        if (input.now < input.scheduledAt) return waitUntilSlot(input);
        await finishReel(ctx, videoId, 'PUBLISHED');
        return poll(ctx, videoId, 'published');
      }
      await finishReel(ctx, videoId, 'SCHEDULED');
    }
    return poll(ctx, videoId, 'scheduled');
  }

  async function prepareVideo(ctx: Ctx, mode: PublishMode): Promise<StepResult> {
    const { input } = ctx;
    // App mode: nothing can be staged without going live (no draft for Page videos), so the
    // upload happens in publish() at the slot.
    if (mode === 'app') {
      await videoSize(input.storage, input.asset);
      return { kind: 'done' };
    }
    let videoId = input.target.remoteMediaId;
    if (!videoId) {
      if (tooLateForNative(input)) {
        if (input.now < input.scheduledAt) return waitUntilSlot(input);
        videoId = await createPageVideo(ctx, null);
        return poll(ctx, videoId, 'published');
      }
      videoId = await createPageVideo(ctx, input.scheduledAt);
    }
    return poll(ctx, videoId, 'scheduled');
  }

  return {
    platform: 'facebook',

    chooseMode({ scheduledAt, now }: ModeInput): PublishMode {
      return scheduledAt.getTime() - now.getTime() >= NATIVE_MIN_MS ? 'native' : 'app';
    },

    prepareAt({ scheduledAt, now, mode }: ModeInput & { mode: PublishMode }): Date {
      if (mode === 'native') {
        const maxAheadMs = RULES.facebook.scheduleMaxDays * DAY;
        if (scheduledAt.getTime() - now.getTime() > maxAheadMs) {
          return new Date(scheduledAt.getTime() - PUSH_AHEAD_MS);
        }
      }
      return now;
    },

    async prepare(input) {
      const ctx = ctxFor(rt, input);
      return kindOf(input) === 'reel'
        ? prepareReel(ctx, input.mode)
        : prepareVideo(ctx, input.mode);
    },

    async publish(input) {
      const ctx = ctxFor(rt, input);
      const kind = kindOf(input);

      if (input.mode === 'native') {
        const videoId = input.target.remoteMediaId ?? input.target.remoteContainerId;
        if (!videoId) {
          throw new PlatformError('fatal', 'Nothing was handed to Facebook for this post.', {
            code: 'not_prepared',
          });
        }
        const res = await poll(ctx, videoId, 'published');
        if (
          res.kind === 'wait' &&
          input.now.getTime() - input.scheduledAt.getTime() > NATIVE_LATE_GRACE_MS
        ) {
          throw new PlatformError(
            'fatal',
            'Facebook has not published the scheduled video 30 minutes after its time. Check the Page in Meta Business Suite.',
            { code: 'native_not_live' },
          );
        }
        return res.kind === 'wait'
          ? { kind: 'wait', retryInSec: 120, reason: 'Waiting for Facebook to publish' }
          : res;
      }

      if (kind === 'reel') {
        let videoId = input.target.remoteContainerId;
        if (!videoId) videoId = await startReel(ctx);
        await ensureReelUploaded(ctx, videoId);
        if (!input.target.remoteMediaId) {
          const s = await getStatus(ctx, videoId);
          const ps = publishStatus(s);
          if (ps === 'published' || ps === 'scheduled') {
            await input.saveProgress({ remoteMediaId: videoId });
            return evaluate(s, videoId, 'published');
          }
          await finishReel(ctx, videoId, 'PUBLISHED');
        }
        return poll(ctx, videoId, 'published');
      }

      const videoId = input.target.remoteMediaId ?? (await createPageVideo(ctx, null));
      return poll(ctx, videoId, 'published');
    },

    async reconcile(input): Promise<ReconcileResult> {
      const videoId = input.target.remoteMediaId ?? input.target.remoteContainerId;
      if (!videoId) return { published: false };
      const ctx = ctxFor(rt, input);
      let s: FbVideoStatus;
      try {
        s = await getStatus(ctx, videoId);
      } catch (err) {
        if (isNotFound(err)) return { published: false };
        throw err;
      }
      const ps = publishStatus(s);
      if (ps === 'published') {
        return {
          published: true,
          remoteMediaId: videoId,
          remoteUrl: absoluteFbUrl(s.permalink_url),
        };
      }
      if (ps === 'scheduled') return { published: false, scheduled: true, remoteMediaId: videoId };
      return { published: false };
    },

    async cancel(input) {
      const videoId = input.target.remoteMediaId ?? input.target.remoteContainerId;
      if (!videoId || input.target.status === 'published') return;
      const ctx = ctxFor(rt, input);
      try {
        const s = await getStatus(ctx, videoId);
        // Never delete something that is already live (deleting a post is the owner's call).
        if (publishStatus(s) === 'published') return;
        await ctx.client.delete(videoId, {}, ctx.token, 'Facebook delete');
      } catch (err) {
        if (!isNotFound(err)) return logFailure(input, 'cancel', err);
      }
      await input.saveProgress({
        remoteContainerId: null,
        remoteMediaId: null,
        remoteUploadOffset: null,
        remoteUrl: null,
      });
      await logStepSafe(input, 'cancel', { outcome: 'ok', message: 'Removed from Facebook' });
    },

    async update() {
      // Editing a scheduled Reel in place isn't documented: the engine cancels and re-prepares.
      return false;
    },
  };
}
