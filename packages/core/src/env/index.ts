/**
 * Typed environment configuration. Every integration is optional: if its keys are missing the
 * feature shows a "not configured" hint instead of crashing, so the app runs locally with only
 * DATABASE_URL + the auth settings.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Directory that contains pnpm-workspace.yaml. The web app and the worker run from different
 * folders (apps/web, apps/worker), so relative data paths are resolved from here; otherwise
 * each process would read and write its own copy of `.data`.
 */
export function repoRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

const dataPath = (def: string) =>
  z
    .string()
    .default(def)
    .transform((v) => (path.isAbsolute(v) ? v : path.join(repoRoot(), v)));

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
  STORAGE_DIR: dataPath('.data/storage'),
  S3_ENDPOINT: optional(), // R2: https://<ACCOUNT_ID>.r2.cloudflarestorage.com
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: optional(),
  S3_ACCESS_KEY_ID: optional(),
  S3_SECRET_ACCESS_KEY: optional(),
  /** Scratch space for ffmpeg. */
  WORK_DIR: dataPath('.data/work'),

  // ---- AI -------------------------------------------------------------------------------------
  ANTHROPIC_API_KEY: optional(),
  /** Only for API keys not scoped to a workspace (wrkspc_...). */
  ANTHROPIC_WORKSPACE_ID: optional(),
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

/**
 * Keys the owner can paste in Settings instead of .env (stored encrypted in `app_keys`, see
 * core/keys). Only these names are accepted from the database.
 */
export const UI_KEY_NAMES = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'META_APP_ID',
  'META_APP_SECRET',
  'META_LOGIN_CONFIG_ID',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_WORKSPACE_ID',
  'DEEPGRAM_API_KEY',
  'OPENAI_API_KEY',
  'SARVAM_API_KEY',
  'ASSEMBLYAI_API_KEY',
  'TELEGRAM_BOT_TOKEN',
] as const satisfies ReadonlyArray<keyof Env>;
export type UiKeyName = (typeof UI_KEY_NAMES)[number];
export type SavedKeys = Partial<Record<UiKeyName, string>>;

let cached: Env | undefined;

/**
 * Saved keys live on globalThis: Next.js can load this module more than once in one process
 * (server components, route handlers), and every copy must see the same keys.
 */
interface KeyState {
  saved: SavedKeys;
  version: number;
  loadedAt: number;
  merged?: { version: number; base: Env; env: Env };
}
const STATE = Symbol.for('app.savedKeys');
function keyState(): KeyState {
  const g = globalThis as { [STATE]?: KeyState };
  return (g[STATE] ??= { saved: {}, version: 0, loadedAt: 0 });
}

function parseEnv(source: Record<string, string | undefined>): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}

/**
 * The process environment plus keys saved in Settings. A key set in the environment always
 * wins. Passing another source (tests) parses just that source, without saved keys.
 */
export function getEnv(source: Record<string, string | undefined> = process.env): Env {
  if (source !== process.env) return parseEnv(source);
  cached ??= parseEnv(source);
  const state = keyState();
  if (state.merged?.version !== state.version || state.merged.base !== cached) {
    state.merged = {
      version: state.version,
      base: cached,
      env: applySavedKeys(cached, state.saved),
    };
  }
  return state.merged.env;
}

/** The environment alone, without keys saved in Settings. */
export function getBaseEnv(): Env {
  return (cached ??= parseEnv(process.env));
}

/** Fills keys the environment leaves empty with the saved ones. */
export function applySavedKeys(base: Env, saved: SavedKeys): Env {
  const env: Env = { ...base };
  for (const name of UI_KEY_NAMES) {
    const value = saved[name]?.trim();
    if (value && !base[name]) env[name] = value;
  }
  // AI_MOCK means "sample captions until there is a Claude key": a key saved in Settings
  // switches real captions on (a key in .env keeps the old meaning, so developers can still mock).
  if (!base.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY) env.AI_MOCK = false;
  return env;
}

/** Replaces the saved keys this process uses (called by core/keys after reading the database). */
export function setSavedKeys(saved: SavedKeys, loadedAt = Date.now()): void {
  const state = keyState();
  const clean: SavedKeys = {};
  for (const name of UI_KEY_NAMES) {
    const v = saved[name]?.trim();
    if (v) clean[name] = v;
  }
  state.saved = clean;
  state.version += 1;
  state.loadedAt = loadedAt;
}

export function savedKeysLoadedAt(): number {
  return keyState().loadedAt;
}

export function getSavedKeys(): SavedKeys {
  return { ...keyState().saved };
}

/** For tests. */
export function resetEnvCache(): void {
  cached = undefined;
  const state = keyState();
  state.saved = {};
  state.version += 1;
  state.loadedAt = 0;
  state.merged = undefined;
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
    super(`${key} is not set${hint ? ` (${hint})` : ''}. Add it in Settings or in .env.`);
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
