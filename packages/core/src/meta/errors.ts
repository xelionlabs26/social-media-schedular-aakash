/**
 * Maps Meta Graph API errors to the engine's PlatformError categories.
 *
 * Sources (checked 13 Nov 2026):
 * - Error shape + codes: https://developers.facebook.com/docs/graph-api/guides/error-handling
 * - Throttling codes + X-Business-Use-Case-Usage:
 *   https://developers.facebook.com/docs/graph-api/overview/rate-limiting
 * - Reels spec errors (1363040/1363127/1363128/1363129):
 *   https://developers.facebook.com/docs/video-api/guides/reels-publishing
 * - Page video errors (382/389/6000/6001): https://developers.facebook.com/docs/graph-api/reference/page/videos/
 * - Instagram 2207xxx subcodes:
 *   https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/error-codes
 */
import { PlatformError, type PlatformErrorCategory } from '../platforms';

/** The `error` object of a Graph API error response. */
export interface GraphErrorBody {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_user_title?: string;
  error_user_msg?: string;
  fbtrace_id?: string;
  is_transient?: boolean;
}

/** Details attached to every PlatformError we create (never contains tokens). */
export interface GraphErrorDetails {
  code?: number;
  subcode?: number;
  type?: string;
  fbtraceId?: string;
  httpStatus?: number;
  /** Raw platform message (sanitized), kept for the History panel. */
  platformMessage?: string;
}

/** Removes anything that looks like a token from text we keep or show. */
export function scrubSecrets(text: string): string {
  return (
    text
      // Meta tokens start with EAA (user/page tokens) or are app tokens "appid|secret".
      .replace(/EAA[A-Za-z0-9]{10,}/g, '[redacted]')
      .replace(/\b\d{6,}\|[A-Za-z0-9_-]{10,}/g, '[redacted]')
      .replace(
        /(access_token|client_secret|fb_exchange_token|appsecret_proof|input_token|code)=([^&\s"]+)/gi,
        '$1=[redacted]',
      )
      .replace(/(OAuth|Bearer)\s+[A-Za-z0-9._|-]{10,}/g, '$1 [redacted]')
  );
}

/** Friendly messages for errors the owner can act on. */
const FRIENDLY: Record<number, string> = {
  // Facebook Reels spec errors
  1363040: 'Facebook rejected the video: the aspect ratio must be between 16:9 and 9:16.',
  1363127: 'Facebook rejected the video: the resolution must be at least 540×960.',
  1363128: 'Facebook rejected the video: a Reel must be 3–90 seconds long.',
  1363129: 'Facebook rejected the video: the frame rate must be 24–60 fps.',
  // Page video errors
  382: 'Facebook says the video file is too small.',
  6000: 'Facebook could not process the video file. Try re-uploading or another file.',
  506: 'Facebook rejected this as a duplicate post.',
  368: 'Facebook temporarily blocked this action (policy). Check the Page in Facebook.',
  // Instagram subcodes
  2207004: 'Instagram: the image is larger than 8 MB.',
  2207005: 'Instagram: unsupported image format.',
  2207009: 'Instagram: the aspect ratio is outside the accepted range.',
  2207010: 'Instagram: the caption is too long (max 2,200 characters, 30 hashtags, 20 @mentions).',
  2207026: 'Instagram: unsupported video format (use MP4 or MOV, H.264/HEVC, AAC).',
  2207042: 'Instagram: the daily publishing limit is reached. Try again tomorrow.',
  2207050:
    'Instagram: the account is inactive, checkpointed or restricted. Open the Instagram app and complete any required steps.',
  2207051: 'Instagram flagged this publish as spam. Contact Instagram support if it is a mistake.',
  2207057: 'Instagram: the cover time (thumb offset) is outside the video length.',
};

/** Instagram subcodes where retrying (usually with a new container) fixes it. */
const IG_RETRYABLE_SUBCODES = new Set([
  2207001, // server error
  2207003, // download timed out
  2207006, // media not found (create a new container)
  2207008, // container not found / expired during publish
  2207020, // media expired (new container)
  2207027, // media not ready yet
  2207032, // media creation failed (re-create container)
  2207052, // media URI could not be fetched
  2207053, // unknown upload error (new container)
]);

/** Subcodes that mean "make a new container" rather than "try the same call again". */
export const IG_RECREATE_CONTAINER_SUBCODES = new Set([
  2207006, 2207008, 2207020, 2207032, 2207053,
]);

const AUTH_SUBCODES = new Set([458, 459, 460, 463, 464, 467, 492]);
const THROTTLE_CODES = new Set([4, 17, 32, 341, 613]);

function isThrottleCode(code: number): boolean {
  // 80000–80014 are the business use case (BUC) throttling codes (80001 Pages, 80002 Instagram).
  return THROTTLE_CODES.has(code) || (code >= 80000 && code <= 80014);
}

function categorize(code: number | undefined, subcode: number | undefined, err: GraphErrorBody) {
  const sub = subcode ?? 0;
  // Instagram subcodes are the most specific, so they win.
  if (sub === 2207042) return 'quota' as const;
  if (sub === 2207050 || sub === 2207051) return 'fatal' as const;
  if (IG_RETRYABLE_SUBCODES.has(sub)) return 'retryable' as const;
  if (sub >= 2207000 && sub < 2208000) return 'invalid' as const;
  if (sub >= 1363000 && sub < 1364000) return 'invalid' as const;
  if (code === undefined) return undefined;
  if (code >= 1363000 && code < 1364000) return 'invalid' as const;
  if (code === 190 || code === 102) return 'auth' as const;
  if (err.type === 'OAuthException' && AUTH_SUBCODES.has(sub)) return 'auth' as const;
  if (code === 10 || (code >= 200 && code <= 299)) return 'auth' as const;
  if (isThrottleCode(code)) return 'retryable' as const;
  if (code === 1 || code === 2 || code === -1 || code === -2) return 'retryable' as const;
  if (code === 9007) return 'retryable' as const; // media not ready
  if (code === 389 || code === 6001 || code === 9004) return 'retryable' as const;
  if (code === 368) return 'fatal' as const;
  if (code === 100 || code === 352 || code === 382 || code === 506 || code === 6000)
    return 'invalid' as const;
  if (code >= 36000 && code <= 36004) return 'invalid' as const;
  if (code === 9) return 'quota' as const;
  if (err.is_transient) return 'retryable' as const;
  return undefined;
}

/**
 * Reads `estimated_time_to_regain_access` (minutes) from the X-Business-Use-Case-Usage header.
 * Format: {"<business-id>": [{"type": "pages", "estimated_time_to_regain_access": 19, ...}]}
 */
export function regainAccessSeconds(headers: Headers | undefined): number | undefined {
  const raw = headers?.get('x-business-use-case-usage');
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<
      string,
      Array<{ estimated_time_to_regain_access?: number }>
    >;
    let maxMin = 0;
    for (const entries of Object.values(parsed)) {
      for (const e of Array.isArray(entries) ? entries : []) {
        maxMin = Math.max(maxMin, Number(e.estimated_time_to_regain_access) || 0);
      }
    }
    return maxMin > 0 ? maxMin * 60 : undefined;
  } catch {
    return undefined;
  }
}

function defaultRetryAfter(code: number | undefined, subcode: number | undefined) {
  if (code === 9007 || subcode === 2207027) return 30;
  if (code !== undefined && isThrottleCode(code)) return 15 * 60;
  return undefined;
}

/** Builds a PlatformError from a Graph `error` object (or a bare HTTP failure). */
export function mapGraphError(
  httpStatus: number | undefined,
  err: GraphErrorBody | undefined,
  headers?: Headers,
  context?: string,
): PlatformError {
  const e = err ?? {};
  const code = typeof e.code === 'number' ? e.code : undefined;
  const subcode = typeof e.error_subcode === 'number' ? e.error_subcode : undefined;
  let category: PlatformErrorCategory | undefined = categorize(code, subcode, e);
  if (!category) {
    if (httpStatus === undefined || httpStatus >= 500 || httpStatus === 429) category = 'retryable';
    else if (httpStatus === 401) category = 'auth';
    else category = 'fatal';
  }

  const platformMessage = scrubSecrets(
    (e.error_user_msg || e.message || (httpStatus ? `HTTP ${httpStatus}` : 'Network error')).trim(),
  );
  const friendly =
    (subcode !== undefined && FRIENDLY[subcode]) || (code !== undefined && FRIENDLY[code]);
  let message = friendly || platformMessage;
  if (!friendly) {
    if (category === 'auth')
      message = `Meta login problem: ${platformMessage}. Reconnect Facebook in Settings.`;
    else if (category === 'invalid' && code === 100)
      message = `Meta rejected a parameter: ${platformMessage}`;
  }
  if (context) message = `${context}: ${message}`;

  const details: GraphErrorDetails = {
    code,
    subcode,
    type: e.type,
    fbtraceId: e.fbtrace_id,
    httpStatus,
    platformMessage,
  };
  return new PlatformError(category, message, {
    code: code !== undefined ? String(subcode ? `${code}/${subcode}` : code) : undefined,
    httpStatus,
    retryAfterSec:
      category === 'retryable' || category === 'quota'
        ? (regainAccessSeconds(headers) ?? defaultRetryAfter(code, subcode))
        : undefined,
    details,
  });
}

/** fetch() itself failed (DNS, reset, timeout): always retryable. */
export function networkError(cause: unknown, context?: string): PlatformError {
  const reason =
    cause instanceof Error
      ? cause.name === 'TimeoutError' || cause.name === 'AbortError'
        ? 'request timed out'
        : scrubSecrets(cause.message)
      : 'network error';
  return new PlatformError('retryable', `${context ? `${context}: ` : ''}${reason}`, {
    code: 'network',
    details: { platformMessage: reason },
  });
}

/** Extracts the numeric code at the end of an IG container `status` string, e.g. "... (2207026)". */
export function parseContainerStatusCode(status: string | undefined): number | undefined {
  if (!status) return undefined;
  const m = status.match(/(\d{4,7})(?!.*\d)/);
  return m ? Number(m[1]) : undefined;
}
