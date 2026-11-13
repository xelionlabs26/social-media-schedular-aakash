/**
 * Database schema (PostgreSQL, Drizzle ORM).
 *
 * The database is the source of truth for everything the app does: what was uploaded, what text
 * each platform gets, when it is scheduled and what happened when we tried to publish it.
 * pg-boss keeps its own job tables in the `pgboss` schema.
 *
 * All instants are `timestamptz` (UTC). Local wall-clock values (posting slots) are stored as text
 * and interpreted in `app_settings.timezone`.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------------------------
// Shared value lists (kept as text columns + TS unions, so migrations stay simple)
// ---------------------------------------------------------------------------------------------

export const PLATFORMS = ['instagram', 'youtube', 'facebook'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const CAPTION_SCRIPTS = ['hinglish_roman', 'english', 'hindi_devanagari'] as const;
export type CaptionScript = (typeof CAPTION_SCRIPTS)[number];

export const ASSET_STATUSES = ['uploading', 'uploaded', 'processing', 'ready', 'failed'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

/** Which pipeline step an asset is in while `status = 'processing'` (shown on the card). */
export const PROCESSING_STEPS = ['probe', 'normalize', 'frames', 'transcribe', 'generate'] as const;
export type ProcessingStep = (typeof PROCESSING_STEPS)[number];

/**
 * Internal per-platform target status. The UI collapses these into six words
 * (see `@app/core` `displayStatus`).
 */
export const TARGET_STATUSES = [
  'draft', // text ready (or being written), not scheduled
  'scheduled', // has scheduled_at; nothing sent to the platform yet
  'preparing', // worker is uploading / creating the container (locked)
  'prepared', // native: handed to the platform with a publish time; IG: container FINISHED
  'publishing', // final publish call in flight (locked)
  'published', // live
  'failed', // needs attention (see attention_reason)
  'missed', // the worker was down at publish time (see missed policy)
  'needs_reauth', // the account's login must be reconnected
  'canceled', // removed by the owner
] as const;
export type TargetStatus = (typeof TARGET_STATUSES)[number];

export const ATTENTION_REASONS = [
  'reconnect', // token invalid / permission missing
  'upload_failed',
  'processing_failed', // ffmpeg / probe failure
  'transcribe_failed',
  'ai_failed',
  'spend_limit', // Anthropic / STT spend limit or empty balance
  'write_manually', // AI refused
  'invalid_text', // text breaks a platform limit
  'invalid_video', // video breaks a platform rule
  'quota', // daily cap reached and the post can't go out in time
  'missed', // worker was down at publish time
  'platform_error', // fatal error returned by the platform
  'not_connected', // platform selected but no account connected
] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

export const PUBLISH_MODES = ['native', 'app'] as const;
export type PublishMode = (typeof PUBLISH_MODES)[number];

export const ACCOUNT_STATUSES = ['active', 'needs_reauth', 'disabled'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const TEXT_SOURCES = ['ai', 'manual', 'template'] as const;
export type TextSource = (typeof TEXT_SOURCES)[number];

export const STT_PROVIDERS = ['openai', 'deepgram', 'sarvam', 'assemblyai', 'mock'] as const;
export type SttProvider = (typeof STT_PROVIDERS)[number];

export const MISSED_POLICIES = ['publish_late_or_ask', 'publish_late', 'skip', 'ask'] as const;
export type MissedPolicy = (typeof MISSED_POLICIES)[number];

export const NOTIFY_CHANNELS = ['telegram', 'email', 'none'] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

export const ATTEMPT_OUTCOMES = ['ok', 'retryable', 'fatal'] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/** Kinds of rate-limited platform calls we count in rolling windows (see `api_calls`). */
export const API_CALL_KINDS = [
  'yt_insert', // YouTube videos.insert (100/day per Google project, Pacific-time day)
  'fb_reel_start', // POST /{page-id}/video_reels upload_phase=start (30 per rolling 24 h per Page)
  'fb_video', // POST /{page-id}/videos
  'ig_container', // POST /{ig-user-id}/media (400 per rolling 24 h)
  'ig_publish', // POST /{ig-user-id}/media_publish (quota read live; 50 assumed)
] as const;
export type ApiCallKind = (typeof API_CALL_KINDS)[number];

// ---------------------------------------------------------------------------------------------
// JSON column shapes
// ---------------------------------------------------------------------------------------------

export type PerPlatform<T> = Record<Platform, T>;

export interface HashtagRange {
  min: number;
  max: number;
}

export interface YoutubeDefaults {
  privacy: 'public' | 'unlisted' | 'private';
  categoryId: string; // '22' = People & Blogs
  madeForKids: boolean;
  notifySubscribers: boolean;
  syntheticMedia: boolean; // "altered or synthetic content" disclosure; AI-written text alone = false
  defaultLanguage: string; // BCP-47, e.g. 'hi'
}

export interface InstagramDefaults {
  shareToFeed: boolean;
}

export interface FacebookDefaults {
  /** 'auto' = Reel when 3–90 s and vertical-ish, normal Page video otherwise. */
  kind: 'auto' | 'reel' | 'video';
}

export interface AssetWarning {
  code: string; // e.g. 'over_60s', 'not_vertical', 'no_audio', 'fb_reel_too_long'
  platform?: Platform;
  severity: 'info' | 'warn' | 'block';
  message: string;
}

/** Per-target options. Every field optional; missing = use app_settings defaults. */
export interface TargetOptions {
  // YouTube
  privacy?: 'public' | 'unlisted' | 'private';
  categoryId?: string;
  madeForKids?: boolean;
  notifySubscribers?: boolean;
  syntheticMedia?: boolean;
  defaultLanguage?: string;
  // Instagram
  shareToFeed?: boolean;
  thumbOffsetMs?: number;
  // Facebook
  fbKind?: 'reel' | 'video';
}

export interface TargetTextSources {
  title?: TextSource;
  body?: TextSource;
  hashtags?: TextSource;
  tags?: TextSource;
}

export interface SlotRule {
  mode: 'next_free' | 'pick' | 'draft';
  /** Local date (YYYY-MM-DD in app timezone) to start filling slots from. */
  startDate?: string;
}

export interface AccountMeta {
  // YouTube
  channelId?: string;
  channelTitle?: string;
  // Facebook / Instagram
  pageId?: string;
  pageName?: string;
  igUserId?: string;
  igUsername?: string;
  /** For the instagram row: the facebook social_accounts.id whose Page token it uses. */
  pageAccountId?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------------------------

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/** Single-row settings table (id is always 1). */
export const appSettings = pgTable(
  'app_settings',
  {
    id: integer('id').primaryKey().default(1),
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    defaultPlatforms: text('default_platforms')
      .array()
      .$type<Platform[]>()
      .notNull()
      .default(sql`ARRAY['instagram','youtube','facebook']::text[]`),
    brandVoice: text('brand_voice').notNull().default(''),
    exampleCaptions: text('example_captions').notNull().default(''),
    bannedWords: text('banned_words').notNull().default(''),
    emojiLevel: text('emoji_level').$type<'none' | 'light' | 'heavy'>().notNull().default('light'),
    captionScript: jsonb('caption_script').$type<PerPlatform<CaptionScript>>().notNull().default({
      instagram: 'hinglish_roman',
      youtube: 'hinglish_roman',
      facebook: 'hinglish_roman',
    }),
    hashtagCounts: jsonb('hashtag_counts')
      .$type<PerPlatform<HashtagRange>>()
      .notNull()
      .default({
        instagram: { min: 3, max: 5 },
        youtube: { min: 2, max: 3 },
        facebook: { min: 0, max: 0 },
      }),
    aiModel: text('ai_model').notNull().default('claude-sonnet-5-5'),
    aiEffort: text('ai_effort').$type<'low' | 'medium' | 'high'>().notNull().default('low'),
    sttProvider: text('stt_provider').$type<SttProvider>().notNull().default('deepgram'),
    youtubeDefaults: jsonb('youtube_defaults').$type<YoutubeDefaults>().notNull().default({
      privacy: 'public',
      categoryId: '22',
      madeForKids: false,
      notifySubscribers: true,
      syntheticMedia: false,
      defaultLanguage: 'hi',
    }),
    instagramDefaults: jsonb('instagram_defaults')
      .$type<InstagramDefaults>()
      .notNull()
      .default({ shareToFeed: true }),
    facebookDefaults: jsonb('facebook_defaults')
      .$type<FacebookDefaults>()
      .notNull()
      .default({ kind: 'auto' }),
    missedPolicy: text('missed_policy')
      .$type<MissedPolicy>()
      .notNull()
      .default('publish_late_or_ask'),
    lateGraceMinutes: integer('late_grace_minutes').notNull().default(120),
    minGapMinutes: integer('min_gap_minutes').notNull().default(5),
    keepOriginals: boolean('keep_originals').notNull().default(false),
    purgeAfterDays: integer('purge_after_days').notNull().default(7),
    notifyChannel: text('notify_channel').$type<NotifyChannel>().notNull().default('telegram'),
    telegramChatId: text('telegram_chat_id'),
    notifyEmail: text('notify_email'),
    dailyDigest: boolean('daily_digest').notNull().default(false),
    /** Bumping this logs out every session. */
    sessionVersion: integer('session_version').notNull().default(1),
    privacyAcceptedAt: timestamp('privacy_accepted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [check('app_settings_singleton', sql`${t.id} = 1`)],
);

/** Weekly posting-time grid used by "Next free slot". */
export const postingSlots = pgTable(
  'posting_slots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 0 = Sunday … 6 = Saturday (in app timezone). */
    weekday: smallint('weekday').notNull(),
    /** Local wall-clock time 'HH:MM' in app timezone. */
    time: text('time').notNull(),
    /** null = every platform. */
    platforms: text('platforms').array().$type<Platform[]>(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('posting_slots_weekday_time').on(t.weekday, t.time),
    check('posting_slots_weekday_range', sql`${t.weekday} between 0 and 6`),
  ],
);

/** Optional fixed-text templates (off by default). */
export const templates = pgTable(
  'templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    platform: text('platform').$type<Platform>().notNull(),
    /** 'title' (YouTube) or 'body' (IG caption / YT description / FB text). */
    field: text('field').$type<'title' | 'body'>().notNull(),
    /** Tokens: {ai_title} {ai_body} {n} {date} {filename} */
    pattern: text('pattern').notNull().default(''),
    mode: text('mode')
      .$type<'ai_only' | 'template_only' | 'template_ai'>()
      .notNull()
      .default('ai_only'),
    enabled: boolean('enabled').notNull().default(false),
    /** Running number used by the {n} token. */
    counter: integer('counter').notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex('templates_platform_field').on(t.platform, t.field)],
);

export const socialAccounts = pgTable(
  'social_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    platform: text('platform').$type<Platform>().notNull(),
    authKind: text('auth_kind').$type<'google' | 'meta_fb_login'>().notNull(),
    /** YouTube channel id, Facebook Page id or Instagram user id. */
    externalId: text('external_id').notNull(),
    displayName: text('display_name').notNull().default(''),
    avatarUrl: text('avatar_url'),
    /** AES-256-GCM ciphertext (see @app/core crypto). Page token for facebook/instagram. */
    accessTokenEnc: text('access_token_enc'),
    /** Google refresh token. */
    refreshTokenEnc: text('refresh_token_enc'),
    /** Meta long-lived user token (~60 days), kept for re-deriving the Page token. */
    userAccessTokenEnc: text('user_access_token_enc'),
    keyVersion: smallint('key_version').notNull().default(1),
    accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }),
    /** Meta data-access expiry (90 days after last user activity). */
    dataAccessExpiresAt: timestamp('data_access_expires_at', { withTimezone: true }),
    scopes: text('scopes')
      .array()
      .$type<string[]>()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    meta: jsonb('meta').$type<AccountMeta>().notNull().default({}),
    status: text('status').$type<AccountStatus>().notNull().default('active'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastError: text('last_error'),
    ...timestamps,
  },
  (t) => [uniqueIndex('social_accounts_platform_external').on(t.platform, t.externalId)],
);

/** One-time OAuth state (CSRF) + PKCE verifier. */
export const oauthFlows = pgTable('oauth_flows', {
  stateHash: text('state_hash').primaryKey(),
  provider: text('provider').$type<'google' | 'meta'>().notNull(),
  codeVerifierEnc: text('code_verifier_enc'),
  redirectTo: text('redirect_to'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const batches = pgTable('batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name'),
  platforms: text('platforms').array().$type<Platform[]>().notNull(),
  notes: text('notes').notNull().default(''),
  slotRule: jsonb('slot_rule').$type<SlotRule>().notNull().default({ mode: 'next_free' }),
  ...timestamps,
});

export const mediaAssets = pgTable(
  'media_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id').references(() => batches.id, { onDelete: 'set null' }),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256'),
    /** Storage key of the uploaded original. */
    originalKey: text('original_key').notNull(),
    /** Storage key of the platform-safe master (may equal a remux of the original). */
    masterKey: text('master_key'),
    status: text('status').$type<AssetStatus>().notNull().default('uploading'),
    processingStep: text('processing_step').$type<ProcessingStep>(),
    durationMs: integer('duration_ms'),
    width: integer('width'),
    height: integer('height'),
    rotation: integer('rotation'),
    fps: doublePrecision('fps'),
    vcodec: text('vcodec'),
    acodec: text('acodec'),
    hasAudio: boolean('has_audio'),
    colorTransfer: text('color_transfer'),
    bitrate: integer('bitrate'),
    warnings: jsonb('warnings').$type<AssetWarning[]>().notNull().default([]),
    transcript: text('transcript'),
    transcriptLang: text('transcript_lang'),
    transcriptProvider: text('transcript_provider'),
    transcriptEdited: boolean('transcript_edited').notNull().default(false),
    /** Owner notes for the AI (names, places, what the video is about). */
    notes: text('notes').notNull().default(''),
    /** Cover frame picked by the AI (ms from start), used as Instagram thumb_offset. */
    coverFrameMs: integer('cover_frame_ms'),
    error: text('error'),
    sortIndex: integer('sort_index').notNull().default(0),
    purgedAt: timestamp('purged_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('media_assets_status').on(t.status), index('media_assets_batch').on(t.batchId)],
);

export const mediaFrames = pgTable(
  'media_frames',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => mediaAssets.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    tMs: integer('t_ms').notNull(),
    key: text('key').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    source: text('source').$type<'hook' | 'uniform' | 'scene'>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('media_frames_asset_idx').on(t.assetId, t.idx)],
);

export const aiGenerations = pgTable(
  'ai_generations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => mediaAssets.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'full' | 'field'>().notNull(),
    /** For kind='field': e.g. 'youtube.title'. */
    field: text('field'),
    instruction: text('instruction'),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    effort: text('effort'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    stopReason: text('stop_reason'),
    requestId: text('request_id'),
    output: jsonb('output').$type<unknown>(),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ai_generations_asset').on(t.assetId),
    index('ai_generations_created').on(t.createdAt),
  ],
);

/** One post per uploaded video. Platform-specific state lives in post_targets. */
export const posts = pgTable(
  'posts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => mediaAssets.id, { onDelete: 'cascade' }),
    batchId: uuid('batch_id').references(() => batches.id, { onDelete: 'set null' }),
    /** Common scheduled time (targets may override with their own scheduled_at). */
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    /** When the owner clicked Schedule (explicit consent, required by YouTube policy). */
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    /**
     * Soft delete: set by "Delete"; the engine cancels anything already handed to a platform,
     * then removes the row and its media. Hidden from the UI immediately.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    version: integer('version').notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex('posts_asset').on(t.assetId), index('posts_scheduled').on(t.scheduledAt)],
);

export const postTargets = pgTable(
  'post_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    platform: text('platform').$type<Platform>().notNull(),
    socialAccountId: uuid('social_account_id').references(() => socialAccounts.id, {
      onDelete: 'set null',
    }),
    status: text('status').$type<TargetStatus>().notNull().default('draft'),
    attentionReason: text('attention_reason').$type<AttentionReason>(),
    /** Small informational note, e.g. 'caption not attached' after a partial IG success. */
    note: text('note'),
    publishMode: text('publish_mode').$type<PublishMode>(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    /** When the worker should start preparing (upload / container). */
    prepareAt: timestamp('prepare_at', { withTimezone: true }),
    /** YouTube title (also Facebook title for normal Page videos). */
    title: text('title').notNull().default(''),
    /** IG caption body / YouTube description / Facebook text, WITHOUT hashtags. */
    body: text('body').notNull().default(''),
    /** Appended to the body at publish time (IG caption, YT description). Without '#'. */
    hashtags: text('hashtags')
      .array()
      .$type<string[]>()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    /** YouTube tags. */
    tags: text('tags')
      .array()
      .$type<string[]>()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    textSources: jsonb('text_sources').$type<TargetTextSources>().notNull().default({}),
    options: jsonb('options').$type<TargetOptions>().notNull().default({}),
    /** Stable per-target key, used as the pg-boss singletonKey and logged with every attempt. */
    idempotencyKey: uuid('idempotency_key').notNull().defaultRandom(),
    /** IG container id / FB video id while preparing. */
    remoteContainerId: text('remote_container_id'),
    /** YouTube resumable session URI (encrypted not needed: short-lived, no secret). */
    remoteUploadUri: text('remote_upload_uri'),
    remoteUploadOffset: bigint('remote_upload_offset', { mode: 'number' }),
    /** Final remote id: YouTube videoId, IG media id, FB video id. */
    remoteMediaId: text('remote_media_id'),
    remoteUrl: text('remote_url'),
    /**
     * Text/time/options changed after the target was handed to the platform (status preparing or
     * prepared). The engine pushes the change (publisher.update) or cancels and prepares again.
     */
    needsSync: boolean('needs_sync').notNull().default(false),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    lastError: text('last_error'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    version: integer('version').notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('post_targets_post_platform').on(t.postId, t.platform),
    uniqueIndex('post_targets_idempotency').on(t.idempotencyKey),
    index('post_targets_status_prepare').on(t.status, t.prepareAt),
    index('post_targets_status_scheduled').on(t.status, t.scheduledAt),
  ],
);

/** Every step the worker attempted for a target (shown in the editor's History section). */
export const publishAttempts = pgTable(
  'publish_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    targetId: uuid('target_id')
      .notNull()
      .references(() => postTargets.id, { onDelete: 'cascade' }),
    attemptNo: integer('attempt_no').notNull(),
    step: text('step')
      .$type<
        | 'prepare'
        | 'upload'
        | 'create_container'
        | 'poll'
        | 'publish'
        | 'verify'
        | 'reconcile'
        | 'update'
        | 'cancel'
      >()
      .notNull(),
    outcome: text('outcome').$type<AttemptOutcome>().notNull(),
    httpStatus: integer('http_status'),
    platformCode: text('platform_code'),
    message: text('message'),
    responseExcerpt: jsonb('response_excerpt').$type<unknown>(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('publish_attempts_target').on(t.targetId)],
);

/** Rolling-window counter for platform rate limits. */
export const apiCalls = pgTable(
  'api_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    platform: text('platform').$type<Platform>().notNull(),
    socialAccountId: uuid('social_account_id').references(() => socialAccounts.id, {
      onDelete: 'cascade',
    }),
    kind: text('kind').$type<ApiCallKind>().notNull(),
    targetId: uuid('target_id').references(() => postTargets.id, { onDelete: 'set null' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('api_calls_kind_at').on(t.kind, t.at)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    targetId: uuid('target_id').references(() => postTargets.id, { onDelete: 'set null' }),
    channel: text('channel').$type<NotifyChannel>().notNull(),
    /** De-duplication key: the same key is never sent twice. */
    dedupeKey: text('dedupe_key'),
    payload: jsonb('payload').$type<unknown>().notNull().default({}),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('notifications_dedupe').on(t.dedupeKey)],
);

/** Login attempts for rate limiting the owner login form. */
export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ip: text('ip').notNull(),
    success: boolean('success').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('login_attempts_ip_at').on(t.ip, t.at)],
);

// ---------------------------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------------------------

export type AppSettings = typeof appSettings.$inferSelect;
export type PostingSlot = typeof postingSlots.$inferSelect;
export type Template = typeof templates.$inferSelect;
export type SocialAccount = typeof socialAccounts.$inferSelect;
export type OauthFlow = typeof oauthFlows.$inferSelect;
export type Batch = typeof batches.$inferSelect;
export type MediaAsset = typeof mediaAssets.$inferSelect;
export type MediaFrame = typeof mediaFrames.$inferSelect;
export type AiGeneration = typeof aiGenerations.$inferSelect;
export type Post = typeof posts.$inferSelect;
export type PostTarget = typeof postTargets.$inferSelect;
export type PublishAttempt = typeof publishAttempts.$inferSelect;
export type ApiCall = typeof apiCalls.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
