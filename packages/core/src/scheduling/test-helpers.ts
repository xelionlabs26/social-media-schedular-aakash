/**
 * Test helpers for the scheduling and notify tests: an isolated database per test file, a fake
 * clock, a job sender that records what was queued, scriptable fake platform integrations and
 * fixtures. Not used by production code.
 */
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import type { SendOptions } from 'pg-boss';
import {
  appSettings,
  mediaAssets,
  postTargets,
  posts,
  schema,
  socialAccounts,
  type AccountStatus,
  type ApiCallKind,
  type Db,
  type MediaAsset,
  type Platform,
  type Post,
  type PostTarget,
  type PublishMode,
  type SocialAccount,
} from '@app/db';
import { upsertSocialAccount } from '../accounts';
import type { JobSender, ServiceDeps } from '../deps';
import { getEnv } from '../env';
import type { JobPayloads } from '../jobs';
import type { Logger } from '../log';
import type {
  AccountHealth,
  FinalText,
  PlatformIntegration,
  PlatformPublisher,
  PublishInput,
  ReconcileResult,
  StepResult,
} from '../platforms';
import { LocalStorage } from '../storage';
import type { Engine } from './engine';

// ---------------------------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------------------------

export interface TestDb {
  db: Db;
  reset(): Promise<void>;
  close(): Promise<void>;
}

const APP_TABLES = [
  'app_settings',
  'posting_slots',
  'templates',
  'social_accounts',
  'oauth_flows',
  'batches',
  'media_assets',
  'media_frames',
  'ai_generations',
  'posts',
  'post_targets',
  'publish_attempts',
  'api_calls',
  'notifications',
  'login_attempts',
];

/**
 * A database of its own for one test file (`<TEST_DATABASE_URL db>_<name>`), created and
 * migrated on first use. Other modules' tests share TEST_DATABASE_URL itself, so truncating
 * tables here can never disturb them (and vice versa). Returns null when TEST_DATABASE_URL is
 * not set.
 */
export async function openTestDb(name: string): Promise<TestDb | null> {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) return null;
  const url = new URL(base);
  const dbName = `${url.pathname.replace(/^\//, '')}_${name}`.replace(/[^a-zA-Z0-9_]/g, '_');
  // drizzle creates the pg pool from a connection string (pg is not a direct dependency here).
  const admin = drizzle({ connection: { connectionString: base, max: 1 } });
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await admin.execute(sql.raw(`create database "${dbName}"`));
        break;
      } catch (err) {
        const e = err as { code?: string; cause?: { code?: string } };
        const code = e.code ?? e.cause?.code;
        if (code === '42P04') break; // already exists
        // 55006: template1 busy because another test file is creating its database.
        if (code === '55006' && attempt < 10) {
          await new Promise((r) => setTimeout(r, 200 + Math.random() * 300));
          continue;
        }
        throw err;
      }
    }
  } finally {
    await admin.$client.end();
  }
  url.pathname = `/${dbName}`;
  const client = drizzle({
    connection: { connectionString: url.toString(), max: 5 },
    schema,
    casing: 'snake_case',
  });
  const db = client as unknown as Db;
  const require = createRequire(import.meta.url);
  const migrationsFolder = path.join(
    path.dirname(require.resolve('@app/db/migrate')),
    '..',
    'drizzle',
  );
  await migrate(db, { migrationsFolder });
  return {
    db,
    async reset() {
      await db.execute(sql.raw(`truncate ${APP_TABLES.join(', ')} restart identity cascade`));
      await db.insert(appSettings).values({ id: 1 });
    },
    close: () => client.$client.end(),
  };
}

// ---------------------------------------------------------------------------------------------
// Clock, jobs, logger, deps
// ---------------------------------------------------------------------------------------------

export class FakeClock {
  private t: number;
  constructor(start: Date | string) {
    this.t = new Date(start).getTime();
  }
  now = (): Date => new Date(this.t);
  set(at: Date | string): void {
    this.t = new Date(at).getTime();
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface SentJob {
  queue: keyof JobPayloads;
  data: Record<string, unknown>;
  options?: SendOptions;
  sentAt: Date;
  done?: boolean;
}

export class RecordingJobs implements JobSender {
  readonly sent: SentJob[] = [];
  constructor(private readonly clock: FakeClock) {}

  async send<Q extends keyof JobPayloads>(
    queue: Q,
    data: JobPayloads[Q],
    options?: SendOptions,
  ): Promise<string | null> {
    this.sent.push({
      queue,
      data: data as Record<string, unknown>,
      options,
      sentAt: this.clock.now(),
    });
    return `job-${this.sent.length}`;
  }

  of(queue: keyof JobPayloads): SentJob[] {
    return this.sent.filter((j) => j.queue === queue);
  }

  /** Alerts queued so far (notify jobs). */
  alerts(): Array<JobPayloads['notify']> {
    return this.of('notify').map((j) => j.data as unknown as JobPayloads['notify']);
  }

  clear(): void {
    this.sent.length = 0;
  }
}

export interface MemoryLogger extends Logger {
  lines: Array<{ level: string; msg: string; data?: Record<string, unknown> }>;
}

export function memoryLogger(): MemoryLogger {
  const lines: MemoryLogger['lines'] = [];
  const logger: MemoryLogger = {
    lines,
    debug: (msg, data) => void lines.push({ level: 'debug', msg, data }),
    info: (msg, data) => void lines.push({ level: 'info', msg, data }),
    warn: (msg, data) => void lines.push({ level: 'warn', msg, data }),
    error: (msg, data) => void lines.push({ level: 'error', msg, data }),
    child: () => logger,
  };
  return logger;
}

export function makeDeps(
  db: Db,
  clock: FakeClock,
  envOverrides: Record<string, string | undefined> = {},
): ServiceDeps & { jobs: RecordingJobs; log: MemoryLogger } {
  const storageDir = mkdtempSync(path.join(tmpdir(), 'sched-test-'));
  return {
    db,
    storage: new LocalStorage(storageDir, 'http://localhost:3000'),
    env: getEnv({
      ...process.env,
      APP_URL: 'https://app.test',
      PUBLISHING_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: undefined,
      RESEND_API_KEY: undefined,
      NOTIFY_FROM_EMAIL: undefined,
      ...envOverrides,
    }),
    log: memoryLogger(),
    jobs: new RecordingJobs(clock),
    now: clock.now,
  };
}

// ---------------------------------------------------------------------------------------------
// Fake platform integrations
// ---------------------------------------------------------------------------------------------

type Step<T> = T | Error | ((input: PublishInput) => T | Promise<T>);
type Method = 'prepare' | 'publish' | 'reconcile' | 'cancel' | 'update';

export interface FakeCall {
  method: Method;
  targetId: string;
  text: FinalText;
  mode: PublishMode;
  scheduledAt: Date;
  remoteMediaId: string | null;
  remoteContainerId: string | null;
}

const UPLOAD_KIND: Record<Platform, ApiCallKind> = {
  youtube: 'yt_insert',
  facebook: 'fb_reel_start',
  instagram: 'ig_container',
};

/**
 * A scriptable publisher. Defaults behave like a well-working platform:
 * native (YouTube/Facebook-like): prepare uploads (records the capped API call), saves the
 * remote video id and returns done; publish (= verify) returns done.
 * app (Instagram-like): prepare creates a container (remoteContainerId) and returns done;
 * publish returns done with a media id. Queue results per method in `script`.
 */
export class FakePublisher implements PlatformPublisher {
  readonly calls: FakeCall[] = [];
  readonly script: {
    prepare: Array<Step<StepResult>>;
    publish: Array<Step<StepResult>>;
    reconcile: Array<Step<ReconcileResult>>;
    cancel: Array<Step<void>>;
    update: Array<Step<boolean>>;
  } = {
    prepare: [],
    publish: [],
    reconcile: [],
    cancel: [],
    update: [],
  };
  update?: (input: PublishInput) => Promise<boolean>;

  constructor(
    readonly platform: Platform,
    readonly mode: PublishMode,
    opts: { supportsUpdate?: boolean } = {},
  ) {
    if (opts.supportsUpdate)
      this.update = (input) => this.run<boolean>('update', input, () => true);
  }

  count(method: Method): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  private async run<T>(
    method: Method,
    input: PublishInput,
    fallback: (i: PublishInput) => T | Promise<T>,
  ): Promise<T> {
    this.calls.push({
      method,
      targetId: input.target.id,
      text: input.text,
      mode: input.mode,
      scheduledAt: input.scheduledAt,
      remoteMediaId: input.target.remoteMediaId,
      remoteContainerId: input.target.remoteContainerId,
    });
    const step = (this.script[method] as Array<Step<unknown>>).shift() as Step<T> | undefined;
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return (step as (i: PublishInput) => T | Promise<T>)(input);
    if (step !== undefined) return step;
    return fallback(input);
  }

  chooseMode(): PublishMode {
    return this.mode;
  }

  prepareAt(input: { scheduledAt: Date; now: Date; mode: PublishMode }): Date {
    return input.mode === 'app' ? new Date(input.scheduledAt.getTime() - 15 * 60_000) : input.now;
  }

  prepare(input: PublishInput): Promise<StepResult> {
    return this.run<StepResult>('prepare', input, async (i) => {
      const id = `${this.platform}-${i.target.id.slice(0, 8)}`;
      if (this.mode === 'app') {
        if (!i.target.remoteContainerId) {
          await i.recordApiCall(UPLOAD_KIND[this.platform]);
          await i.saveProgress({ remoteContainerId: `container-${id}` });
        }
        return { kind: 'done' };
      }
      if (!i.target.remoteMediaId) {
        await i.recordApiCall(UPLOAD_KIND[this.platform]);
        await i.saveProgress({ remoteMediaId: `video-${id}` });
      }
      return { kind: 'done', remoteUrl: `https://${this.platform}.test/${id}` };
    });
  }

  publish(input: PublishInput): Promise<StepResult> {
    return this.run<StepResult>('publish', input, async (i) => {
      const id = `${this.platform}-${i.target.id.slice(0, 8)}`;
      if (this.mode === 'app') await i.recordApiCall('ig_publish');
      return {
        kind: 'done',
        remoteMediaId: `media-${id}`,
        remoteUrl: `https://${this.platform}.test/p/${id}`,
      };
    });
  }

  reconcile(input: PublishInput): Promise<ReconcileResult> {
    return this.run<ReconcileResult>('reconcile', input, () => ({ published: false }));
  }

  cancel(input: PublishInput): Promise<void> {
    return this.run<void>('cancel', input, () => undefined);
  }
}

export function fakeIntegration(
  publisher: FakePublisher,
  health: (account: { accountId: string }) => AccountHealth | Promise<AccountHealth> = () => ({
    status: 'ok',
  }),
): PlatformIntegration & { healthChecks: string[] } {
  const healthChecks: string[] = [];
  return {
    platform: publisher.platform,
    publisher,
    healthChecks,
    async checkHealth(account) {
      healthChecks.push(account.accountId);
      return health(account);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

export async function seedAccount(
  db: Db,
  platform: Platform,
  opts: { status?: AccountStatus; externalId?: string } = {},
): Promise<SocialAccount> {
  const row = await upsertSocialAccount(db, {
    platform,
    authKind: platform === 'youtube' ? 'google' : 'meta_fb_login',
    externalId: opts.externalId ?? `${platform}-ext`,
    displayName: `My ${platform}`,
    accessToken: `token-${platform}`,
    refreshToken: platform === 'youtube' ? 'refresh-youtube' : null,
    scopes: [],
    meta: {},
  });
  if (opts.status && opts.status !== 'active') {
    const [updated] = await db
      .update(socialAccounts)
      .set({ status: opts.status })
      .where(eq(socialAccounts.id, row.id))
      .returning();
    return updated!;
  }
  return row;
}

export const VALID_TEXT: Record<
  Platform,
  { title: string; body: string; hashtags: string[]; tags: string[] }
> = {
  youtube: {
    title: 'Goa mein ek sunset ne sab badal diya',
    body: 'Socha tha normal sunset hoga…',
    hashtags: ['goa'],
    tags: ['goa', 'sunset'],
  },
  instagram: {
    title: '',
    body: 'Socha tha normal sunset hoga… phir ye hua',
    hashtags: ['goa', 'travel'],
    tags: [],
  },
  facebook: { title: '', body: 'Goa ka sunset, ek dum alag.', hashtags: [], tags: [] },
};

let seq = 0;

export async function seedPost(
  db: Db,
  opts: {
    platforms: Platform[];
    /** Account per platform (null = not connected). */
    accounts?: Partial<Record<Platform, SocialAccount | null>>;
    asset?: Partial<typeof mediaAssets.$inferInsert>;
    target?: Partial<typeof postTargets.$inferInsert>;
    perTarget?: Partial<Record<Platform, Partial<typeof postTargets.$inferInsert>>>;
    post?: Partial<typeof posts.$inferInsert>;
  },
): Promise<{ post: Post; asset: MediaAsset; targets: Record<Platform, PostTarget> }> {
  seq++;
  const [asset] = await db
    .insert(mediaAssets)
    .values({
      filename: `clip-${seq}.mp4`,
      contentType: 'video/mp4',
      sizeBytes: 1_000_000,
      originalKey: `uploads/a${seq}/original.mp4`,
      masterKey: `media/a${seq}/master.mp4`,
      status: 'ready',
      durationMs: 58_000,
      width: 1080,
      height: 1920,
      sortIndex: seq,
      ...opts.asset,
    })
    .returning();
  const [post] = await db
    .insert(posts)
    .values({ assetId: asset!.id, ...opts.post })
    .returning();
  const targets = {} as Record<Platform, PostTarget>;
  for (const platform of opts.platforms) {
    const account = opts.accounts?.[platform];
    const [t] = await db
      .insert(postTargets)
      .values({
        postId: post!.id,
        platform,
        socialAccountId: account === undefined ? null : (account?.id ?? null),
        ...VALID_TEXT[platform],
        ...opts.target,
        ...opts.perTarget?.[platform],
      })
      .returning();
    targets[platform] = t!;
  }
  return { post: post!, asset: asset!, targets };
}

export async function getTarget(db: Db, id: string): Promise<PostTarget> {
  const [t] = await db.select().from(postTargets).where(eq(postTargets.id, id));
  if (!t) throw new Error(`target ${id} not found`);
  return t;
}

const RUNNABLE = new Set([
  'prepare-target',
  'publish-target',
  'reconcile-target',
  'cancel-target',
  'dispatch',
]);

/**
 * Runs queued engine jobs like the worker would: oldest first, only once their startAfter has
 * passed on the fake clock. Returns the jobs it ran.
 */
export async function runJobs(
  jobs: RecordingJobs,
  engine: Engine,
  clock: FakeClock,
  maxJobs = 100,
): Promise<SentJob[]> {
  const ran: SentJob[] = [];
  for (let i = 0; i < maxJobs; i++) {
    const now = clock.now().getTime();
    const next = jobs.sent.find((j) => {
      if (j.done || !RUNNABLE.has(j.queue)) return false;
      const after = j.options?.startAfter;
      const delaySec = typeof after === 'number' ? after : 0;
      return j.sentAt.getTime() + delaySec * 1000 <= now;
    });
    if (!next) return ran;
    next.done = true;
    ran.push(next);
    const id = next.data.targetId as string;
    if (next.queue === 'prepare-target') await engine.prepareTarget(id);
    else if (next.queue === 'publish-target') await engine.publishTarget(id);
    else if (next.queue === 'reconcile-target') await engine.reconcileTarget(id);
    else if (next.queue === 'cancel-target') await engine.cancelTarget(id);
    else if (next.queue === 'dispatch') await engine.dispatch();
  }
  throw new Error(`runJobs: more than ${maxJobs} jobs; is something looping?`);
}

/** Marks every queued job as handled (tests that only look at the database). */
export function drop(jobs: RecordingJobs): void {
  for (const j of jobs.sent) j.done = true;
}
