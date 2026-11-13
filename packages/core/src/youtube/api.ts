/**
 * Low-level Google / YouTube Data API v3 plumbing shared by the OAuth flow, the publisher and
 * the health check: endpoints, a token holder that refreshes itself, a request helper that
 * retries once after a 401, and the mapping from Google error responses to PlatformError.
 *
 * Everything goes through an injectable `fetch` so tests never touch the network.
 * Tokens are only ever placed in the Authorization header or a form body; they never appear in
 * error messages, PlatformError.details or logs.
 */
import { PlatformError, type AccountCredentials } from '../platforms';
import { localToUtc, pacificDayKey, addLocalDays } from '../time';
import { RULES } from '../platforms/rules';

export type FetchFn = typeof fetch;

/** Resolves the global fetch at call time so `vi.stubGlobal('fetch', …)` works in tests. */
export const defaultFetch: FetchFn = (input, init) => globalThis.fetch(input, init);

// https://developers.google.com/identity/protocols/oauth2/web-server
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
/** Covers upload, status changes, metadata edits and delete (PLAN.md §5.2). */
export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

// https://developers.google.com/youtube/v3/docs
export const YT_API = 'https://www.googleapis.com/youtube/v3';
// https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
export const YT_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';

/** Refresh the access token when it expires within this window. */
export const REFRESH_MARGIN_MS = 2 * 60_000;

export const shortsUrl = (videoId: string) => `https://www.youtube.com/shorts/${videoId}`;

// ---------------------------------------------------------------------------------------------
// Google error bodies
// ---------------------------------------------------------------------------------------------

/**
 * Google JSON error envelope:
 * { "error": { "code": 403, "message": "...", "errors": [{ "domain", "reason", "message" }] } }
 * https://cloud.google.com/apis/design/errors#http_mapping (legacy `errors[]` is what the
 * YouTube Data API still returns; reasons are listed at
 * https://developers.google.com/youtube/v3/docs/errors).
 */
export interface GoogleApiErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ domain?: string; reason?: string; message?: string }>;
  };
}

export interface ParsedApiError {
  reason?: string;
  message?: string;
}

export function parseApiError(body: unknown): ParsedApiError {
  if (!body || typeof body !== 'object') return {};
  const err = (body as GoogleApiErrorBody).error;
  if (!err || typeof err !== 'object') return {};
  const first = Array.isArray(err.errors) ? err.errors[0] : undefined;
  return {
    reason: first?.reason ?? (typeof err.status === 'string' ? err.status : undefined),
    message: first?.message ?? err.message,
  };
}

/** Reads a response body as JSON if possible, otherwise as (short) text. Never throws. */
export async function readBody(res: Response): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 500);
  }
}

function retryAfterHeader(res: Pick<Response, 'headers'>): number | undefined {
  const raw = res.headers.get('retry-after');
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(1, Math.ceil((at - Date.now()) / 1000)) : undefined;
}

/** Seconds until the next midnight in America/Los_Angeles (when YouTube quotas reset). */
export function secondsUntilPacificMidnight(now: Date): number {
  const nextDay = addLocalDays(pacificDayKey(now), 1);
  const midnight = localToUtc(nextDay, '00:00', RULES.youtube.quotaTimezone);
  // A few minutes of slack so we don't hit the boundary before Google's reset is visible.
  return Math.max(60, Math.ceil((midnight.getTime() - now.getTime()) / 1000) + 5 * 60);
}

/** Plain-English messages for 4xx reasons the owner can act on. */
const INVALID_MESSAGES: Record<string, string> = {
  invalidTitle: 'YouTube rejected the title (it is empty, too long or has < or >).',
  invalidDescription: 'YouTube rejected the description (too long or has < or >).',
  invalidTags: 'YouTube rejected the tags (500 characters in total at most).',
  invalidCategoryId: 'The YouTube category is not valid. Pick another category in Settings.',
  invalidPublishAt:
    'YouTube rejected the publish time. A video can only be scheduled while it is private and has never been public.',
  invalidVideoMetadata: 'YouTube needs both a title and a category.',
  defaultLanguageNotSet: 'YouTube needs a default language for this video.',
  mediaBodyRequired: 'The video file did not reach YouTube. It will need to be uploaded again.',
  invalidFilename: 'YouTube rejected the file name.',
  invalidRecordingDetails: 'YouTube rejected the recording details.',
  forbiddenPrivacySetting: 'YouTube does not allow this privacy setting for the video.',
  forbiddenLicenseSetting: 'YouTube does not allow this license setting for the video.',
  forbiddenEmbedSetting: 'YouTube does not allow this embed setting for the video.',
  missingRequiredParameter: 'A required YouTube parameter was missing (app bug).',
  unexpectedParameter: 'YouTube did not accept a parameter (app bug).',
};

const AUTH_REASONS = new Set([
  'forbidden',
  'insufficientPermissions',
  'youtubeSignupRequired',
  'authorizationRequired',
  'authError',
  'channelForbidden',
  'accountDisabled',
]);

const AUTH_MESSAGES: Record<string, string> = {
  insufficientPermissions:
    'YouTube permission is missing. Reconnect YouTube and tick "Manage your YouTube videos".',
  youtubeSignupRequired: 'This Google account has no YouTube channel. Create one, then reconnect.',
  forbidden: 'YouTube refused access to this channel or video. Reconnect YouTube.',
};

/**
 * Maps an HTTP error from the YouTube Data API to a PlatformError.
 * https://developers.google.com/youtube/v3/docs/errors
 */
export function mapApiError(
  status: number,
  body: unknown,
  res: Pick<Response, 'headers'> | undefined,
  now: Date,
  context = 'YouTube request',
): PlatformError {
  const { reason, message } = parseApiError(body);
  const excerpt = typeof body === 'object' ? body : undefined;
  const opts = { code: reason, httpStatus: status, details: excerpt };
  const retryAfter = res ? retryAfterHeader(res) : undefined;
  const platformMsg = message ? ` (${message})` : '';

  // Quota and limits first: uploadLimitExceeded comes back as 400, quotaExceeded as 403.
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
    return new PlatformError(
      'quota',
      'YouTube daily API quota is used up. It resets at midnight Pacific time.',
      {
        ...opts,
        retryAfterSec: secondsUntilPacificMidnight(now),
      },
    );
  }
  if (reason === 'uploadLimitExceeded') {
    // A per-channel limit separate from the API quota; PLAN.md §5.6 pauses uploads for 24 h.
    return new PlatformError(
      'quota',
      'YouTube daily upload limit for this channel was reached. Uploads pause for 24 hours.',
      {
        ...opts,
        retryAfterSec: 24 * 3600,
      },
    );
  }
  if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || status === 429) {
    return new PlatformError('quota', `YouTube is rate limiting requests${platformMsg}.`, {
      ...opts,
      retryAfterSec: retryAfter ?? 60,
    });
  }
  if (status === 401) {
    return new PlatformError(
      'auth',
      AUTH_MESSAGES[reason ?? ''] ?? 'YouTube login is no longer valid. Reconnect YouTube.',
      opts,
    );
  }
  if (status === 403 && reason && AUTH_REASONS.has(reason)) {
    return new PlatformError(
      'auth',
      AUTH_MESSAGES[reason] ??
        `${context} was refused by YouTube${platformMsg}. Reconnect YouTube.`,
      opts,
    );
  }
  if (status >= 500 || status === 408) {
    return new PlatformError('retryable', `YouTube had a temporary problem (HTTP ${status}).`, {
      ...opts,
      retryAfterSec: retryAfter,
    });
  }
  if (status === 404) {
    return new PlatformError('fatal', `${context}: not found on YouTube${platformMsg}.`, opts);
  }
  if (status === 400 || status === 403) {
    const friendly = reason ? INVALID_MESSAGES[reason] : undefined;
    return new PlatformError(
      'invalid',
      friendly ?? `YouTube rejected the request${platformMsg}.`,
      opts,
    );
  }
  return new PlatformError('fatal', `${context} failed with HTTP ${status}${platformMsg}.`, opts);
}

/** fetch() threw (DNS, reset, timeout): always retryable unless we were aborted on purpose. */
export function networkError(err: unknown, context: string, signal?: AbortSignal): PlatformError {
  if (signal?.aborted) {
    return new PlatformError('retryable', `${context} was cancelled.`, { cause: err });
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new PlatformError('retryable', `${context} failed: network error (${msg}).`, {
    code: 'network',
    cause: err,
  });
}

// ---------------------------------------------------------------------------------------------
// OAuth token endpoint
// ---------------------------------------------------------------------------------------------

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

export interface TokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

/** Error from the OAuth token endpoint: { error: 'invalid_grant', error_description: '…' }. */
export class GoogleTokenError extends Error {
  constructor(
    readonly httpStatus: number | undefined,
    readonly oauthError: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'GoogleTokenError';
  }
}

/** POSTs a form to the token endpoint. Throws GoogleTokenError or PlatformError('retryable'). */
export async function postTokenEndpoint(
  fetchFn: FetchFn,
  form: Record<string, string>,
  signal?: AbortSignal,
): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetchFn(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal,
    });
  } catch (err) {
    throw networkError(err, 'Google token request', signal);
  }
  const body = (await readBody(res)) as Record<string, unknown> | string | undefined;
  if (!res.ok) {
    const obj = body && typeof body === 'object' ? body : {};
    const oauthError = typeof obj.error === 'string' ? obj.error : undefined;
    const description =
      typeof obj.error_description === 'string' ? obj.error_description : undefined;
    if (res.status >= 500 || res.status === 429) {
      throw new PlatformError('retryable', `Google token endpoint returned HTTP ${res.status}.`, {
        httpStatus: res.status,
        code: oauthError,
      });
    }
    throw new GoogleTokenError(
      res.status,
      oauthError,
      `Google token request failed: ${oauthError ?? `HTTP ${res.status}`}${description ? ` (${description})` : ''}`,
    );
  }
  if (!body || typeof body !== 'object' || typeof body.access_token !== 'string') {
    throw new PlatformError('retryable', 'Google token endpoint returned an unexpected response.');
  }
  return body as unknown as TokenResponse;
}

/** Turns `expires_in` into an absolute expiry (a little early, to absorb clock skew). */
export function expiryFrom(now: Date, expiresIn: number | undefined): Date | null {
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) return null;
  return new Date(now.getTime() + Math.max(0, expiresIn - 30) * 1000);
}

/**
 * Exchanges a refresh token for a new access token.
 * https://developers.google.com/identity/protocols/oauth2/web-server#offline
 * invalid_grant = revoked, expired (unused 6 months, password change) → 'auth'.
 */
export async function refreshAccessToken(
  fetchFn: FetchFn,
  client: GoogleClient,
  refreshToken: string,
  now: Date,
  signal?: AbortSignal,
): Promise<{ accessToken: string; expiresAt: Date | null; scopes?: string[] }> {
  try {
    const tok = await postTokenEndpoint(
      fetchFn,
      {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      },
      signal,
    );
    return {
      accessToken: tok.access_token,
      expiresAt: expiryFrom(now, tok.expires_in),
      scopes: tok.scope ? tok.scope.split(' ').filter(Boolean) : undefined,
    };
  } catch (err) {
    if (err instanceof GoogleTokenError) {
      if (err.oauthError === 'invalid_grant') {
        throw new PlatformError(
          'auth',
          'Google login expired or was revoked. Reconnect YouTube in Settings.',
          { code: 'invalid_grant', httpStatus: err.httpStatus },
        );
      }
      if (err.oauthError === 'invalid_client' || err.oauthError === 'unauthorized_client') {
        throw new PlatformError(
          'fatal',
          'Google rejected the app credentials (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). Check the server configuration.',
          { code: err.oauthError, httpStatus: err.httpStatus },
        );
      }
      throw new PlatformError(
        'auth',
        'Google could not refresh the YouTube login. Reconnect YouTube.',
        {
          code: err.oauthError,
          httpStatus: err.httpStatus,
        },
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Authenticated API client
// ---------------------------------------------------------------------------------------------

export interface GoogleSessionOptions {
  fetch: FetchFn;
  client: GoogleClient | null;
  now: () => Date;
  /** Called right after a refresh so the new token is persisted. */
  onTokenRefreshed?: (accessToken: string, expiresAt: Date) => Promise<void>;
  signal?: AbortSignal;
}

/**
 * Holds the access token for one account during one publisher step. Refreshes it before use when
 * it is about to expire, and once more after a 401.
 */
export class GoogleSession {
  private accessToken: string;
  private expiresAt: Date | null;
  private refreshed = false;

  constructor(
    private readonly account: Pick<
      AccountCredentials,
      'accessToken' | 'accessExpiresAt' | 'refreshToken'
    >,
    private readonly opts: GoogleSessionOptions,
  ) {
    this.accessToken = account.accessToken;
    this.expiresAt = account.accessExpiresAt;
  }

  get signal(): AbortSignal | undefined {
    return this.opts.signal;
  }

  get fetch(): FetchFn {
    return this.opts.fetch;
  }

  now(): Date {
    return this.opts.now();
  }

  get tokenExpiresAt(): Date | null {
    return this.expiresAt;
  }

  needsRefresh(): boolean {
    if (!this.expiresAt) return false;
    return this.expiresAt.getTime() - this.opts.now().getTime() <= REFRESH_MARGIN_MS;
  }

  /** Returns a usable access token, refreshing first if it expires within 2 minutes. */
  async token(): Promise<string> {
    if (this.needsRefresh()) await this.refresh();
    return this.accessToken;
  }

  async refresh(): Promise<void> {
    if (!this.account.refreshToken) {
      throw new PlatformError('auth', 'No Google refresh token is stored. Reconnect YouTube.', {
        code: 'no_refresh_token',
      });
    }
    if (!this.opts.client) {
      throw new PlatformError(
        'fatal',
        'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set, so the YouTube login cannot be refreshed.',
        { code: 'not_configured' },
      );
    }
    const next = await refreshAccessToken(
      this.opts.fetch,
      this.opts.client,
      this.account.refreshToken,
      this.opts.now(),
      this.opts.signal,
    );
    this.accessToken = next.accessToken;
    this.expiresAt = next.expiresAt;
    this.refreshed = true;
    // Persist right away so the next job doesn't refresh again.
    if (this.opts.onTokenRefreshed) {
      // Google always sends expires_in; assume the usual ~1 h if it ever doesn't.
      const expiresAt = next.expiresAt ?? new Date(this.opts.now().getTime() + 55 * 60_000);
      await this.opts.onTokenRefreshed(next.accessToken, expiresAt);
    }
  }

  /**
   * Sends a request with the bearer token. On 401 refreshes once and repeats (only for
   * replayable bodies: strings or no body). Returns the raw response for any status; network
   * failures become PlatformError('retryable').
   */
  async send(url: string, init: RequestInit = {}, context = 'YouTube request'): Promise<Response> {
    const doFetch = async (): Promise<Response> => {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${await this.token()}`);
      try {
        return await this.opts.fetch(url, { ...init, headers, signal: this.opts.signal });
      } catch (err) {
        throw networkError(err, context, this.opts.signal);
      }
    };
    let res = await doFetch();
    const replayable =
      init.body === undefined || init.body === null || typeof init.body === 'string';
    if (res.status === 401 && replayable && !this.refreshed && this.account.refreshToken) {
      await res.body?.cancel().catch(() => undefined);
      await this.refresh();
      res = await doFetch();
    }
    return res;
  }

  /** send() + JSON parse; non-2xx is mapped to a PlatformError. */
  async json<T>(url: string, init: RequestInit = {}, context = 'YouTube request'): Promise<T> {
    const res = await this.send(url, init, context);
    const body = await readBody(res);
    if (!res.ok) throw mapApiError(res.status, body, res, this.opts.now(), context);
    return (body ?? {}) as T;
  }
}

// ---------------------------------------------------------------------------------------------
// Resource shapes (only the fields we use)
// ---------------------------------------------------------------------------------------------

export interface YtVideoSnippet {
  title?: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  defaultLanguage?: string;
  defaultAudioLanguage?: string;
  [key: string]: unknown;
}

export interface YtVideoStatus {
  uploadStatus?: 'deleted' | 'failed' | 'processed' | 'rejected' | 'uploaded';
  failureReason?: string;
  rejectionReason?: string;
  privacyStatus?: 'private' | 'public' | 'unlisted';
  publishAt?: string;
  license?: string;
  embeddable?: boolean;
  publicStatsViewable?: boolean;
  selfDeclaredMadeForKids?: boolean;
  containsSyntheticMedia?: boolean;
  madeForKids?: boolean;
  [key: string]: unknown;
}

export interface YtProcessingDetails {
  processingStatus?: 'failed' | 'processing' | 'succeeded' | 'terminated';
  processingFailureReason?: string;
  processingProgress?: { partsTotal?: string; partsProcessed?: string; timeLeftMs?: string };
}

export interface YtVideo {
  id: string;
  snippet?: YtVideoSnippet;
  status?: YtVideoStatus;
  processingDetails?: YtProcessingDetails;
}

export interface YtChannel {
  id: string;
  snippet?: {
    title?: string;
    thumbnails?: Record<string, { url?: string } | undefined>;
  };
}

/** videos.list for one id (1 quota unit). Returns null when the video doesn't exist. */
export async function getVideo(
  session: GoogleSession,
  videoId: string,
  parts: string[],
): Promise<YtVideo | null> {
  // https://developers.google.com/youtube/v3/docs/videos/list
  const qs = new URLSearchParams({ part: parts.join(','), id: videoId });
  const res = await session.json<{ items?: YtVideo[] }>(
    `${YT_API}/videos?${qs}`,
    { method: 'GET' },
    'Reading the YouTube video',
  );
  return res.items?.find((v) => v.id === videoId) ?? res.items?.[0] ?? null;
}

/** channels.list mine=true (1 quota unit). Null when the Google account has no channel. */
export async function getMyChannel(session: GoogleSession): Promise<YtChannel | null> {
  // https://developers.google.com/youtube/v3/docs/channels/list
  const res = await session.json<{ items?: YtChannel[] }>(
    `${YT_API}/channels?part=snippet&mine=true`,
    { method: 'GET' },
    'Reading the YouTube channel',
  );
  return res.items?.[0] ?? null;
}

export function channelAvatar(ch: YtChannel): string | null {
  const t = ch.snippet?.thumbnails;
  return t?.medium?.url ?? t?.default?.url ?? t?.high?.url ?? null;
}

/**
 * Revokes a Google token (the refresh token revokes the whole grant).
 * https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke
 * 200 = revoked; 400 = invalid/already revoked (treated as success).
 */
export async function revokeGoogleToken(fetchFn: FetchFn, token: string): Promise<void> {
  let res: Response;
  try {
    res = await fetchFn(`${GOOGLE_REVOKE_URL}?${new URLSearchParams({ token })}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  } catch (err) {
    throw networkError(err, 'Revoking the Google login');
  }
  await res.body?.cancel().catch(() => undefined);
  if (res.ok || res.status === 400) return;
  if (res.status >= 500 || res.status === 429) {
    throw new PlatformError('retryable', `Google revoke endpoint returned HTTP ${res.status}.`, {
      httpStatus: res.status,
    });
  }
  throw new PlatformError('fatal', `Google revoke endpoint returned HTTP ${res.status}.`, {
    httpStatus: res.status,
  });
}
