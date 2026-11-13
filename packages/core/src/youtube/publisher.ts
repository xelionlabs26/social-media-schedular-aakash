/**
 * YouTube Shorts publisher (YouTube Data API v3), PLAN.md §5.2.
 *
 * - native (public): resumable upload as `private` + `publishAt`; YouTube publishes at the time.
 *   publish() later only verifies the video went public.
 * - native (private): uploaded as private; nothing else happens at the time.
 * - app (unlisted): YouTube can only schedule a switch to *public*, so we upload private and
 *   publish() switches it to unlisted at the time.
 *
 * Uploads resume from the saved session URI after a crash (308 + Range), and restart when the
 * session expired (404/410). A Short is any video ≤3 min that is square or vertical; no flag.
 */
import { Readable } from 'node:stream';
import type { PublishMode } from '@app/db';
import { getEnv, type Env } from '../env';
import {
  PlatformError,
  type ModeInput,
  type PlatformPublisher,
  type PublishInput,
  type ReconcileResult,
  type StepResult,
} from '../platforms';
import { RULES } from '../platforms/rules';
import { charCount, stripAngleBrackets, utf8Bytes, youtubeTagsLength } from '../text';
import {
  GoogleSession,
  YT_API,
  YT_UPLOAD_URL,
  defaultFetch,
  getVideo,
  mapApiError,
  networkError,
  readBody,
  shortsUrl,
  type FetchFn,
  type GoogleClient,
  type YtVideo,
  type YtVideoSnippet,
  type YtVideoStatus,
} from './api';

/** After the publish time, how long we keep waiting for YouTube to flip the video public. */
export const VERIFY_GRACE_MS = 30 * 60_000;
/** Below this lead time we publish immediately instead of setting publishAt. */
export const MIN_SCHEDULE_LEAD_MS = 60_000;
const PROCESSING_POLL_SEC = 30;

export interface YoutubePublisherOptions {
  fetch?: FetchFn;
  /** Defaults to GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET from the environment. */
  env?: () => Env;
}

type Privacy = 'public' | 'unlisted' | 'private';

/** Per-target options over the app-wide YouTube defaults. */
export function resolveYoutubeOptions(input: Pick<PublishInput, 'target' | 'settings'>) {
  const d = input.settings.youtubeDefaults;
  const o = input.target.options ?? {};
  return {
    privacy: (o.privacy ?? d.privacy) as Privacy,
    categoryId: o.categoryId ?? d.categoryId,
    madeForKids: o.madeForKids ?? d.madeForKids,
    notifySubscribers: o.notifySubscribers ?? d.notifySubscribers,
    syntheticMedia: o.syntheticMedia ?? d.syntheticMedia,
    defaultLanguage: o.defaultLanguage ?? d.defaultLanguage,
  };
}

/** YouTube wants RFC 3339 in UTC; we send whole seconds with a 'Z'. */
export const toYoutubeTime = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * The privacy/publishAt pair for the upload (and for updates while still private).
 * ALWAYS includes privacyStatus: if it's missing, YouTube publishes the video immediately.
 */
export function buildPrivacy(
  privacy: Privacy,
  scheduledAt: Date,
  now: Date,
): { privacyStatus: Privacy; publishAt?: string } {
  if (privacy === 'public') {
    if (scheduledAt.getTime() - now.getTime() > MIN_SCHEDULE_LEAD_MS) {
      return { privacyStatus: 'private', publishAt: toYoutubeTime(scheduledAt) };
    }
    return { privacyStatus: 'public' };
  }
  // unlisted is switched on by publish() at the time; private stays private.
  return { privacyStatus: 'private' };
}

/** Title/description/tags checked against YouTube's limits (validation normally blocks earlier). */
export function buildSnippet(
  input: Pick<PublishInput, 'text' | 'target' | 'settings'>,
): YtVideoSnippet {
  const opts = resolveYoutubeOptions(input);
  const title = stripAngleBrackets(input.text.title).replace(/\s+/g, ' ').trim();
  if (!title)
    throw new PlatformError('invalid', 'The YouTube title is empty.', { code: 'empty_title' });
  if (charCount(title) > RULES.youtube.titleMaxChars) {
    throw new PlatformError(
      'invalid',
      `The YouTube title is ${charCount(title)} characters; the limit is ${RULES.youtube.titleMaxChars}.`,
      { code: 'title_too_long' },
    );
  }
  const description = stripAngleBrackets(input.text.body).trim();
  if (utf8Bytes(description) > RULES.youtube.descriptionMaxBytes) {
    throw new PlatformError(
      'invalid',
      `The YouTube description is ${utf8Bytes(description)} bytes; the limit is ${RULES.youtube.descriptionMaxBytes} (Hindi letters use 3 bytes each).`,
      { code: 'description_too_long' },
    );
  }
  return {
    title,
    description,
    tags: fitTags(input.text.tags),
    categoryId: opts.categoryId,
    defaultLanguage: opts.defaultLanguage,
    defaultAudioLanguage: opts.defaultLanguage,
  };
}

/** Cleans tags and drops trailing ones until they fit 500 characters (tags are optional extras). */
export function fitTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = stripAngleBrackets(raw).replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    if (youtubeTagsLength([...out, t]) > RULES.youtube.tagsMaxChars) break;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

/** The full resource sent with videos.insert. */
export function buildInsertResource(input: PublishInput): {
  snippet: YtVideoSnippet;
  status: YtVideoStatus;
} {
  const opts = resolveYoutubeOptions(input);
  return {
    snippet: buildSnippet(input),
    status: {
      ...buildPrivacy(opts.privacy, input.scheduledAt, input.now),
      selfDeclaredMadeForKids: opts.madeForKids,
      containsSyntheticMedia: opts.syntheticMedia,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Upload helpers
// ---------------------------------------------------------------------------------------------

type UploadState =
  | { kind: 'incomplete'; nextByte: number }
  | { kind: 'complete'; video: YtVideo }
  | { kind: 'expired' };

/** Parses `Range: bytes=0-999` from a 308 → next byte to send (0 when absent). */
export function nextByteFromRange(range: string | null): number {
  const m = range?.match(/bytes=(\d+)-(\d+)/);
  return m ? Number(m[2]) + 1 : 0;
}

async function interpretUploadResponse(res: Response, now: Date): Promise<UploadState> {
  if (res.status === 200 || res.status === 201) {
    const body = (await readBody(res)) as YtVideo | undefined;
    if (!body || typeof body !== 'object' || typeof body.id !== 'string') {
      throw new PlatformError('retryable', 'YouTube finished the upload but returned no video id.');
    }
    return { kind: 'complete', video: body };
  }
  if (res.status === 308) {
    await res.body?.cancel().catch(() => undefined);
    return { kind: 'incomplete', nextByte: nextByteFromRange(res.headers.get('range')) };
  }
  // https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
  // 404 = session expired; 410 Gone is what Google's upload servers send for dead sessions too.
  if (res.status === 404 || res.status === 410) {
    await res.body?.cancel().catch(() => undefined);
    return { kind: 'expired' };
  }
  throw mapApiError(res.status, await readBody(res), res, now, 'Uploading the video to YouTube');
}

export function createYoutubePublisher(options: YoutubePublisherOptions = {}): PlatformPublisher {
  const fetchFn = options.fetch ?? defaultFetch;
  const env = options.env ?? (() => getEnv());

  const googleClient = (): GoogleClient | null => {
    const e = env();
    return e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET
      ? { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET }
      : null;
  };

  const sessionFor = (input: PublishInput) =>
    new GoogleSession(input.account, {
      fetch: fetchFn,
      client: googleClient(),
      // Advance the clock from input.now so long uploads still refresh correctly.
      now: clockFrom(input.now),
      onTokenRefreshed: input.onTokenRefreshed?.bind(input),
      signal: input.signal,
    });

  /** Starts a resumable session; returns the session URI (Location header). */
  async function initUpload(
    session: GoogleSession,
    input: PublishInput,
    total: number,
  ): Promise<string> {
    const opts = resolveYoutubeOptions(input);
    const resource = buildInsertResource(input);
    const qs = new URLSearchParams({
      uploadType: 'resumable',
      part: 'snippet,status',
      // notifySubscribers is a query parameter, not part of the resource.
      // https://developers.google.com/youtube/v3/docs/videos/insert#parameters
      notifySubscribers: String(opts.notifySubscribers),
    });
    const res = await session.send(
      `${YT_UPLOAD_URL}?${qs}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Length': String(total),
          'X-Upload-Content-Type': 'video/mp4',
        },
        body: JSON.stringify(resource),
      },
      'Starting the YouTube upload',
    );
    if (!res.ok) {
      throw mapApiError(
        res.status,
        await readBody(res),
        res,
        session.now(),
        'Starting the YouTube upload',
      );
    }
    await res.body?.cancel().catch(() => undefined);
    const location = res.headers.get('location');
    if (!location)
      throw new PlatformError('retryable', 'YouTube did not return an upload session.');
    return location;
  }

  /** Asks the session how many bytes it already has (empty PUT with `bytes *\/TOTAL`). */
  async function queryUpload(
    session: GoogleSession,
    uri: string,
    total: number,
  ): Promise<UploadState> {
    const res = await session.send(
      uri,
      {
        method: 'PUT',
        headers: { 'Content-Length': '0', 'Content-Range': `bytes */${total}` },
        redirect: 'manual',
      },
      'Checking the YouTube upload',
    );
    return interpretUploadResponse(res, session.now());
  }

  /** Streams bytes [from, total) from storage to the session. */
  async function putBytes(
    session: GoogleSession,
    input: PublishInput,
    uri: string,
    from: number,
    total: number,
  ): Promise<UploadState> {
    const token = await session.token();
    const key = input.asset.masterKey!;
    const stream = await input.storage.openReadStream(key, from > 0 ? { start: from } : undefined);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'video/mp4',
      'Content-Length': String(total - from),
    };
    if (from > 0) headers['Content-Range'] = `bytes ${from}-${total - 1}/${total}`;
    let res: Response;
    try {
      res = await fetchFn(uri, {
        method: 'PUT',
        headers,
        body: Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>,
        // Required by Node's fetch for streamed request bodies.
        duplex: 'half',
        redirect: 'manual',
        signal: input.signal,
      } as RequestInit & { duplex: 'half' });
    } catch (err) {
      stream.destroy();
      throw networkError(err, 'Uploading the video to YouTube', input.signal);
    }
    if (res.status === 401) {
      // A streamed body can't be replayed: refresh now; the next attempt resumes the session.
      await res.body?.cancel().catch(() => undefined);
      await session.refresh();
      throw new PlatformError(
        'retryable',
        'YouTube login expired during the upload; it will resume.',
        {
          httpStatus: 401,
        },
      );
    }
    return interpretUploadResponse(res, session.now());
  }

  async function onUploaded(input: PublishInput, video: YtVideo, total: number): Promise<void> {
    await input.saveProgress({
      remoteMediaId: video.id,
      remoteUrl: shortsUrl(video.id),
      remoteUploadUri: null,
      remoteUploadOffset: total,
    });
    await input.logStep('upload', {
      outcome: 'ok',
      message: `Uploaded to YouTube (video ${video.id}).`,
    });
  }

  /** videos.list(status, processingDetails) → done / wait / PlatformError('invalid'). */
  async function checkProcessing(
    session: GoogleSession,
    input: PublishInput,
    videoId: string,
  ): Promise<StepResult> {
    const video = await getVideo(session, videoId, ['status', 'processingDetails']);
    if (!video) {
      // Right after upload the video can lag in videos.list; the engine retries with backoff.
      throw new PlatformError('retryable', 'The uploaded video is not visible on YouTube yet.', {
        code: 'video_not_found',
      });
    }
    const st = video.status ?? {};
    const pd = video.processingDetails ?? {};
    if (st.uploadStatus === 'rejected') {
      throw new PlatformError(
        'invalid',
        `YouTube rejected the video: ${describeReason(st.rejectionReason)}.`,
        {
          code: `rejected_${st.rejectionReason ?? 'unknown'}`,
        },
      );
    }
    if (st.uploadStatus === 'failed' || st.uploadStatus === 'deleted') {
      throw new PlatformError(
        'invalid',
        `YouTube could not process the video: ${describeReason(st.failureReason ?? st.uploadStatus)}.`,
        {
          code: `failed_${st.failureReason ?? st.uploadStatus}`,
        },
      );
    }
    if (pd.processingStatus === 'failed' || pd.processingStatus === 'terminated') {
      throw new PlatformError(
        'invalid',
        `YouTube could not process the video: ${describeReason(pd.processingFailureReason ?? pd.processingStatus)}.`,
        {
          code: `processing_${pd.processingFailureReason ?? pd.processingStatus}`,
        },
      );
    }
    if (pd.processingStatus === 'succeeded' || st.uploadStatus === 'processed') {
      await input.logStep('poll', {
        outcome: 'ok',
        message: 'YouTube finished processing the video.',
      });
      return { kind: 'done', remoteMediaId: videoId, remoteUrl: shortsUrl(videoId) };
    }
    const leftMs = Number(pd.processingProgress?.timeLeftMs);
    const retryInSec =
      Number.isFinite(leftMs) && leftMs > 0
        ? Math.min(120, Math.max(15, Math.ceil(leftMs / 1000)))
        : PROCESSING_POLL_SEC;
    return { kind: 'wait', retryInSec, reason: 'YouTube is processing the video' };
  }

  async function clearUploadSession(input: PublishInput): Promise<void> {
    await input.saveProgress({ remoteUploadUri: null, remoteUploadOffset: null });
  }

  const publisher: PlatformPublisher = {
    platform: 'youtube',

    chooseMode(input: ModeInput): PublishMode {
      // YouTube can only schedule "private → public"; unlisted needs our worker at the time.
      return input.target.options?.privacy === 'unlisted' ? 'app' : 'native';
    },

    prepareAt(input) {
      // Upload as early as possible; the engine throttles uploads against the daily caps.
      return input.now;
    },

    async prepare(input) {
      const session = sessionFor(input);
      if (input.target.remoteMediaId)
        return checkProcessing(session, input, input.target.remoteMediaId);

      if (!input.asset.masterKey) {
        throw new PlatformError(
          'fatal',
          'The video is not ready for upload yet (no processed file).',
          {
            code: 'no_master',
          },
        );
      }
      const info = await input.storage.head(input.asset.masterKey);
      if (!info || info.size <= 0) {
        throw new PlatformError('fatal', 'The video file is missing from storage.', {
          code: 'master_missing',
        });
      }
      const total = info.size;

      let uri = input.target.remoteUploadUri ?? null;
      let from = 0;
      if (uri) {
        const state = await queryUpload(session, uri, total);
        if (state.kind === 'complete') {
          await onUploaded(input, state.video, total);
          return checkProcessing(session, input, state.video.id);
        }
        if (state.kind === 'expired') {
          await clearUploadSession(input);
          uri = null;
        } else {
          from = state.nextByte;
          await input.saveProgress({ remoteUploadOffset: from });
        }
      }
      if (!uri) {
        uri = await initUpload(session, input, total);
        await input.recordApiCall('yt_insert');
        await input.saveProgress({ remoteUploadUri: uri, remoteUploadOffset: 0 });
        from = 0;
      }

      const result =
        from >= total
          ? await queryUpload(session, uri, total)
          : await putBytes(session, input, uri, from, total);
      if (result.kind === 'complete') {
        await onUploaded(input, result.video, total);
        return checkProcessing(session, input, result.video.id);
      }
      if (result.kind === 'expired') {
        await clearUploadSession(input);
        return {
          kind: 'wait',
          retryInSec: 5,
          reason: 'YouTube upload session expired; starting again',
        };
      }
      // Partial upload (connection dropped mid-stream): remember the offset and resume soon.
      await input.saveProgress({ remoteUploadOffset: result.nextByte });
      return { kind: 'wait', retryInSec: 5, reason: 'YouTube upload incomplete; resuming' };
    },

    async publish(input) {
      const session = sessionFor(input);
      const videoId = input.target.remoteMediaId;
      if (!videoId) {
        throw new PlatformError('fatal', 'Nothing was uploaded to YouTube for this post.', {
          code: 'no_video',
        });
      }
      const opts = resolveYoutubeOptions(input);
      const now = session.now();
      const video = await getVideo(session, videoId, ['status']);
      if (!video) {
        throw new PlatformError('fatal', 'The video was deleted on YouTube.', {
          code: 'video_not_found',
        });
      }
      const st = video.status ?? {};
      const url = shortsUrl(videoId);

      if (opts.privacy === 'unlisted') {
        if (st.privacyStatus === 'unlisted' || st.privacyStatus === 'public') {
          return { kind: 'done', remoteMediaId: videoId, remoteUrl: url };
        }
        await updateVideo(session, video, {
          status: { ...writableStatus(st), privacyStatus: 'unlisted', publishAt: undefined },
        });
        await input.logStep('publish', {
          outcome: 'ok',
          message: 'Set the YouTube video to unlisted.',
        });
        return { kind: 'done', remoteMediaId: videoId, remoteUrl: url };
      }

      if (opts.privacy === 'private') {
        return { kind: 'done', remoteMediaId: videoId, remoteUrl: url, note: 'private on YouTube' };
      }

      // Public: YouTube flips it at publishAt; we only verify.
      if (st.privacyStatus === 'public') {
        await input.logStep('verify', {
          outcome: 'ok',
          message: 'The video is public on YouTube.',
        });
        return { kind: 'done', remoteMediaId: videoId, remoteUrl: url };
      }
      if (st.privacyStatus === 'unlisted') {
        // The owner changed it by hand in YouTube Studio; respect that.
        return {
          kind: 'done',
          remoteMediaId: videoId,
          remoteUrl: url,
          note: 'unlisted on YouTube',
        };
      }
      const dueAt = st.publishAt ? new Date(st.publishAt) : input.scheduledAt;
      if (now.getTime() < dueAt.getTime() + VERIFY_GRACE_MS) {
        const untilDue = Math.ceil((dueAt.getTime() - now.getTime()) / 1000);
        return {
          kind: 'wait',
          retryInSec: untilDue > 0 ? untilDue + 60 : 120,
          reason: 'Waiting for YouTube to publish the video',
        };
      }
      throw new PlatformError(
        'fatal',
        'The video is still private on YouTube 30 minutes after its publish time (channel strike or policy?). Check YouTube Studio.',
        { code: 'still_private' },
      );
    },

    async reconcile(input): Promise<ReconcileResult> {
      const session = sessionFor(input);
      let videoId = input.target.remoteMediaId ?? null;
      if (!videoId && input.target.remoteUploadUri && input.asset.masterKey) {
        const info = await input.storage.head(input.asset.masterKey);
        if (info) {
          const state = await queryUpload(session, input.target.remoteUploadUri, info.size);
          if (state.kind === 'complete') {
            await onUploaded(input, state.video, info.size);
            videoId = state.video.id;
          }
        }
      }
      if (!videoId) return { published: false };
      const video = await getVideo(session, videoId, ['status']);
      if (!video) return { published: false };
      const st = video.status ?? {};
      const desired = resolveYoutubeOptions(input).privacy;
      const url = shortsUrl(videoId);
      const published =
        st.privacyStatus === 'public' ||
        (desired !== 'public' && st.privacyStatus === desired && !st.publishAt) ||
        (desired === 'public' && st.privacyStatus === 'unlisted');
      const scheduled = st.privacyStatus === 'private' && Boolean(st.publishAt);
      return { published, scheduled, remoteMediaId: videoId, remoteUrl: url };
    },

    async cancel(input) {
      const session = sessionFor(input);
      let videoId = input.target.remoteMediaId ?? null;
      // An upload may have completed without us seeing the response: find its video first.
      if (!videoId && input.target.remoteUploadUri && input.asset.masterKey) {
        const info = await input.storage.head(input.asset.masterKey);
        if (info) {
          const state = await queryUpload(session, input.target.remoteUploadUri, info.size).catch(
            () => null,
          );
          if (state?.kind === 'complete') videoId = state.video.id;
        }
      }
      if (videoId) {
        const video = await getVideo(session, videoId, ['status']);
        // Never delete a video that is already live: removing a post here must not erase
        // published content (PLAN.md §9 data deletion).
        if (video && video.status?.privacyStatus !== 'private') {
          await input.logStep('cancel', {
            outcome: 'ok',
            message: 'The video is already live on YouTube, so it was left there.',
          });
          return;
        }
        if (video) {
          // https://developers.google.com/youtube/v3/docs/videos/delete (204; 404 = already gone)
          const res = await session.send(
            `${YT_API}/videos?${new URLSearchParams({ id: videoId })}`,
            { method: 'DELETE' },
            'Deleting the YouTube video',
          );
          if (!res.ok && res.status !== 404) {
            throw mapApiError(
              res.status,
              await readBody(res),
              res,
              session.now(),
              'Deleting the YouTube video',
            );
          }
          await res.body?.cancel().catch(() => undefined);
        }
      }
      await input.saveProgress({
        remoteMediaId: null,
        remoteUrl: null,
        remoteUploadUri: null,
        remoteUploadOffset: null,
      });
      await input.logStep('cancel', { outcome: 'ok', message: 'Removed from YouTube.' });
    },

    async update(input) {
      const videoId = input.target.remoteMediaId;
      // Metadata is fixed once the upload session started; the engine re-prepares instead.
      if (!videoId) return false;
      const session = sessionFor(input);
      const video = await getVideo(session, videoId, ['snippet', 'status']);
      if (!video) return false;
      const opts = resolveYoutubeOptions(input);
      const fresh = buildSnippet(input);
      const snippet: YtVideoSnippet = {
        ...writableSnippet(video.snippet ?? {}),
        title: fresh.title,
        description: fresh.description,
        tags: fresh.tags,
        categoryId: fresh.categoryId,
        defaultLanguage: fresh.defaultLanguage,
        defaultAudioLanguage: fresh.defaultAudioLanguage,
      };
      const current = video.status ?? {};
      let status: YtVideoStatus = {
        ...writableStatus(current),
        selfDeclaredMadeForKids: opts.madeForKids,
        containsSyntheticMedia: opts.syntheticMedia,
      };
      // Time/privacy can only change while the video is still private (never published).
      if (current.privacyStatus === 'private') {
        const p = buildPrivacy(opts.privacy, input.scheduledAt, session.now());
        status = { ...status, privacyStatus: p.privacyStatus, publishAt: p.publishAt };
      }
      await updateVideo(session, video, { snippet, status });
      await input.logStep('update', { outcome: 'ok', message: 'Updated the video on YouTube.' });
      return true;
    },
  };

  return publisher;
}

// ---------------------------------------------------------------------------------------------
// Read-modify-write helpers (videos.update erases omitted writable fields)
// ---------------------------------------------------------------------------------------------

// https://developers.google.com/youtube/v3/docs/videos/update#request-body
const SNIPPET_WRITABLE = [
  'title',
  'description',
  'tags',
  'categoryId',
  'defaultLanguage',
  'defaultAudioLanguage',
] as const;
const STATUS_WRITABLE = [
  'privacyStatus',
  'publishAt',
  'license',
  'embeddable',
  'publicStatsViewable',
  'selfDeclaredMadeForKids',
  'containsSyntheticMedia',
] as const;

export function writableSnippet(s: YtVideoSnippet): YtVideoSnippet {
  const out: YtVideoSnippet = {};
  for (const k of SNIPPET_WRITABLE)
    if (s[k] !== undefined) (out as Record<string, unknown>)[k] = s[k];
  return out;
}

export function writableStatus(s: YtVideoStatus): YtVideoStatus {
  const out: YtVideoStatus = {};
  for (const k of STATUS_WRITABLE)
    if (s[k] !== undefined) (out as Record<string, unknown>)[k] = s[k];
  return out;
}

async function updateVideo(
  session: GoogleSession,
  video: YtVideo,
  parts: { snippet?: YtVideoSnippet; status?: YtVideoStatus },
): Promise<YtVideo> {
  const partNames = Object.keys(parts).filter((k) => parts[k as keyof typeof parts]);
  const body: Record<string, unknown> = { id: video.id };
  if (parts.snippet) body.snippet = parts.snippet;
  if (parts.status) body.status = stripUndefined(parts.status);
  // https://developers.google.com/youtube/v3/docs/videos/update (50 quota units)
  return session.json<YtVideo>(
    `${YT_API}/videos?${new URLSearchParams({ part: partNames.join(',') })}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(body),
    },
    'Updating the YouTube video',
  );
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

const REASON_TEXT: Record<string, string> = {
  claim: 'a copyright claim',
  copyright: 'copyright infringement',
  duplicate: 'it is a duplicate of a video already on the channel',
  inappropriate: 'inappropriate content',
  legal: 'a legal reason',
  length: 'it is too long',
  termsOfUse: 'a Terms of Use violation',
  trademark: 'a trademark issue',
  uploaderAccountClosed: 'the channel is closed',
  uploaderAccountSuspended: 'the channel is suspended',
  codec: 'the video codec is not supported',
  conversion: 'the video could not be converted',
  emptyFile: 'the file is empty',
  invalidFile: 'the file is not a valid video',
  tooSmall: 'the file is too small',
  uploadAborted: 'the upload was aborted',
  transcodeFailed: 'transcoding failed',
  uploadFailed: 'the upload failed',
  streamingFailed: 'streaming failed',
};

function describeReason(reason: string | undefined): string {
  return (reason && REASON_TEXT[reason]) ?? reason ?? 'unknown reason';
}

/** A clock that starts at `start` and advances in real time (keeps tests deterministic). */
function clockFrom(start: Date): () => Date {
  const offset = start.getTime() - Date.now();
  return () => new Date(Date.now() + offset);
}
