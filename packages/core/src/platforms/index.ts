/**
 * Contract between the scheduling engine and each platform integration.
 *
 * The engine (core/scheduling) owns the database state machine, locking, retries, quotas and
 * notifications. A platform integration only talks to its platform's API and reports what
 * happened through the return values and the callbacks in `PublishInput`.
 */
import type {
  ApiCallKind,
  AccountMeta,
  AppSettings,
  MediaAsset,
  Platform,
  PostTarget,
  PublishAttempt,
  PublishMode,
} from '@app/db';
import type { Storage } from '../storage';

export * from './rules';

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/**
 * - retryable: network errors, 5xx, rate limits, "still processing". Engine retries with backoff.
 * - auth:      token invalid / revoked / permission missing. Engine marks the account
 *              needs_reauth and pauses its targets.
 * - quota:     a daily/rolling cap was hit. Engine delays (retryAfterSec) or flags 'quota'.
 * - invalid:   the video or text breaks a platform rule. Not retried.
 * - fatal:     anything else that won't fix itself. Not retried.
 */
export type PlatformErrorCategory = 'retryable' | 'auth' | 'quota' | 'invalid' | 'fatal';

export class PlatformError extends Error {
  readonly category: PlatformErrorCategory;
  readonly code?: string;
  readonly httpStatus?: number;
  readonly retryAfterSec?: number;
  readonly details?: unknown;

  constructor(
    category: PlatformErrorCategory,
    message: string,
    opts: {
      code?: string;
      httpStatus?: number;
      retryAfterSec?: number;
      details?: unknown;
      cause?: unknown;
    } = {},
  ) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'PlatformError';
    this.category = category;
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.retryAfterSec = opts.retryAfterSec;
    this.details = opts.details;
  }
}

export const isPlatformError = (e: unknown): e is PlatformError => e instanceof PlatformError;

// ---------------------------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------------------------

/** Decrypted credentials for one social account (never leaves the server). */
export interface AccountCredentials {
  accountId: string;
  platform: Platform;
  externalId: string;
  /** Google access token, or the Facebook Page token (also used for Instagram). */
  accessToken: string;
  accessExpiresAt: Date | null;
  /** Google refresh token. */
  refreshToken?: string;
  /** Meta long-lived user token. */
  userAccessToken?: string;
  scopes: string[];
  meta: AccountMeta;
}

/** Final text the engine computed for the target (templates applied, hashtags appended). */
export interface FinalText {
  title: string;
  /** Body with hashtags already appended (see composeFinalBody). */
  body: string;
  tags: string[];
}

export type RemoteProgress = Partial<
  Pick<
    PostTarget,
    'remoteContainerId' | 'remoteUploadUri' | 'remoteUploadOffset' | 'remoteMediaId' | 'remoteUrl'
  >
>;

export interface StepLog {
  outcome: 'ok' | 'retryable' | 'fatal';
  httpStatus?: number;
  platformCode?: string;
  message?: string;
  responseExcerpt?: unknown;
}

export interface PublishInput {
  target: PostTarget;
  asset: MediaAsset;
  settings: AppSettings;
  account: AccountCredentials;
  storage: Storage;
  text: FinalText;
  /** When the post should go live. */
  scheduledAt: Date;
  now: Date;
  mode: PublishMode;
  /** Persist remote ids/offsets immediately so a crash can resume and retries don't duplicate. */
  saveProgress(patch: RemoteProgress): Promise<void>;
  /** Count a rate-limited call (see RULES and api_calls). Call right after the request is sent. */
  recordApiCall(kind: ApiCallKind): Promise<void>;
  /** Append a row to publish_attempts (shown in the editor's History). */
  logStep(step: PublishAttempt['step'], log: StepLog): Promise<void>;
  /** Google: persist a refreshed access token. */
  onTokenRefreshed?(accessToken: string, expiresAt: Date): Promise<void>;
  signal?: AbortSignal;
}

export type StepResult =
  /** The step finished. For native prepare this means "accepted with a publish time". */
  | {
      kind: 'done';
      remoteMediaId?: string;
      remoteUrl?: string;
      /** Shown on the card, e.g. 'caption not attached'. */
      note?: string;
    }
  /** Not finished yet (e.g. platform still processing): call the same step again later. */
  | { kind: 'wait'; retryInSec: number; reason?: string };

export interface ReconcileResult {
  /** The post is live on the platform. */
  published: boolean;
  /** The platform has it scheduled (native mode). */
  scheduled?: boolean;
  remoteMediaId?: string;
  remoteUrl?: string;
}

export interface ModeInput {
  scheduledAt: Date;
  now: Date;
  asset: MediaAsset;
  target: PostTarget;
}

export interface PlatformPublisher {
  readonly platform: Platform;
  /** 'native' = upload early and let the platform publish; 'app' = we publish at the time. */
  chooseMode(input: ModeInput): PublishMode;
  /** When the engine should start `prepare` (e.g. IG: scheduledAt − 15 min; YT: as soon as possible). */
  prepareAt(input: ModeInput & { mode: PublishMode }): Date;
  /**
   * native: upload and hand over the publish time. app: upload / create container until it's
   * ready to publish. Returns 'wait' while the platform is still processing; the engine calls
   * prepare() again later. Must be resumable using target.remote* fields.
   */
  prepare(input: PublishInput): Promise<StepResult>;
  /** app mode: the final publish call at scheduledAt. native: called after scheduledAt to verify. */
  publish(input: PublishInput): Promise<StepResult>;
  /** Before any retry of a final step: is it already live / scheduled on the platform? */
  reconcile(input: PublishInput): Promise<ReconcileResult>;
  /** Remove a natively scheduled item or an unpublished container. Must not throw if already gone. */
  cancel(input: PublishInput): Promise<void>;
  /**
   * Push changed text / time to an item that was already handed to the platform. Return false if
   * not supported; the engine then cancels and prepares again.
   */
  update?(input: PublishInput): Promise<boolean>;
}

export interface AccountHealth {
  status: 'ok' | 'needs_reauth' | 'error';
  message?: string;
  accessExpiresAt?: Date | null;
  dataAccessExpiresAt?: Date | null;
  scopes?: string[];
}

export interface PlatformIntegration {
  readonly platform: Platform;
  readonly publisher: PlatformPublisher;
  /** Cheap call that proves the token works (daily health check). */
  checkHealth(account: AccountCredentials): Promise<AccountHealth>;
  /** Revoke the token on the platform (Disconnect). Must not throw if already revoked. */
  revoke?(account: AccountCredentials): Promise<void>;
}

export type Integrations = Partial<Record<Platform, PlatformIntegration>>;
