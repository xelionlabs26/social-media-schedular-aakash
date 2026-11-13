/**
 * Typed environment configuration. Every integration is optional: if its keys are missing the
 * feature shows a "not configured" hint instead of crashing, so the app runs locally with only
 * DATABASE_URL + the auth settings.
 */
import { z } from 'zod';

const optional = () =>
  z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
    );

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Public base URL of the web app, no trailing slash (OAuth redirects, signed upload URLs). */
  APP_URL: z
    .string()
    .default('http://localhost:3000')
    .transform((v) => v.replace(/\/+$/, '')),
  DATABASE_URL: optional(),

  // ---- Owner login --------------------------------------------------------------------------
  OWNER_EMAIL: optional(),
  /** scrypt hash from `pnpm hash-password`. */
  OWNER_PASSWORD_HASH: optional(),
  /** ≥32 random chars; signs session cookies and upload URLs. */
  AUTH_SECRET: optional(),

  // ---- Token encryption ----------------------------------------------------------------------
  /** 32 random bytes, base64. `openssl rand -base64 32` */
  TOKEN_ENC_KEY: optional(),
  TOKEN_ENC_KEY_VERSION: z.coerce.number().int().min(1).default(1),

  // ---- Storage --------------------------------------------------------------------------------
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_DIR: z.string().default('.data/storage'),
  S3_ENDPOINT: optional(), // R2: https://<ACCOUNT_ID>.r2.cloudflarestorage.com
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: optional(),
  S3_ACCESS_KEY_ID: optional(),
  S3_SECRET_ACCESS_KEY: optional(),
  /** Scratch space for ffmpeg. */
  WORK_DIR: z.string().default('.data/work'),

  // ---- AI -------------------------------------------------------------------------------------
  ANTHROPIC_API_KEY: optional(),
  /** Use canned AI output instead of calling Claude (local development without a key). */
  AI_MOCK: bool(false),

  // ---- Speech-to-text ------------------------------------------------------------------------
  OPENAI_API_KEY: optional(),
  DEEPGRAM_API_KEY: optional(),
  SARVAM_API_KEY: optional(),
  ASSEMBLYAI_API_KEY: optional(),

  // ---- Google / YouTube ---------------------------------------------------------------------
  GOOGLE_CLIENT_ID: optional(),
  GOOGLE_CLIENT_SECRET: optional(),

  // ---- Meta (Facebook Page + Instagram) -----------------------------------------------------
  META_APP_ID: optional(),
  META_APP_SECRET: optional(),
  META_LOGIN_CONFIG_ID: optional(),
  GRAPH_VERSION: z.string().default('v27.0'),

  // ---- Notifications -------------------------------------------------------------------------
  TELEGRAM_BOT_TOKEN: optional(),
  RESEND_API_KEY: optional(),
  NOTIFY_FROM_EMAIL: optional(),

  // ---- Worker ----------------------------------------------------------------------------------
  /** Set to false to run the web app without publishing anything (dry run). */
  PUBLISHING_ENABLED: bool(true),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function getEnv(source: Record<string, string | undefined> = process.env): Env {
  if (cached && source === process.env) return cached;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  if (source === process.env) cached = parsed.data;
  return parsed.data;
}

/** For tests. */
export function resetEnvCache(): void {
  cached = undefined;
}

export function requireEnv<K extends keyof Env>(key: K, hint?: string): NonNullable<Env[K]> {
  const value = getEnv()[key];
  if (value === undefined || value === null || value === '') {
    throw new ConfigError(key as string, hint);
  }
  return value as NonNullable<Env[K]>;
}

/** Thrown when an optional integration is used without its configuration. */
export class ConfigError extends Error {
  constructor(
    public readonly key: string,
    hint?: string,
  ) {
    super(`${key} is not set${hint ? ` (${hint})` : ''}. Add it to your .env file.`);
    this.name = 'ConfigError';
  }
}

/** Which integrations are configured (shown in Settings). */
export function integrationStatus(env: Env = getEnv()) {
  return {
    ai: Boolean(env.ANTHROPIC_API_KEY) || env.AI_MOCK,
    aiMock: env.AI_MOCK,
    stt: {
      openai: Boolean(env.OPENAI_API_KEY),
      deepgram: Boolean(env.DEEPGRAM_API_KEY),
      sarvam: Boolean(env.SARVAM_API_KEY),
      assemblyai: Boolean(env.ASSEMBLYAI_API_KEY),
    },
    youtube: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    meta: Boolean(env.META_APP_ID && env.META_APP_SECRET),
    storage: env.STORAGE_DRIVER,
    telegram: Boolean(env.TELEGRAM_BOT_TOKEN),
    email: Boolean(env.RESEND_API_KEY && env.NOTIFY_FROM_EMAIL),
    tokenEncryption: Boolean(env.TOKEN_ENC_KEY),
  };
}
