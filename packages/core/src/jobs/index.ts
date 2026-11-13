/**
 * Background job contract (pg-boss). Queue names, payloads and per-queue options live here so the
 * web app (which only sends jobs) and the worker (which runs them) agree.
 */
import { PgBoss, type QueueOptions, type SendOptions } from 'pg-boss';
import { getEnv } from '../env';

export const QUEUES = {
  /** Probe, validate, normalize, extract frames + audio. */
  processAsset: 'process-asset',
  /** Speech-to-text. */
  transcribeAsset: 'transcribe-asset',
  /** One Claude call that writes every platform's text for the asset. */
  generateText: 'generate-text',
  /** Upload / create container / hand over to native scheduler. Re-sent while 'wait'. */
  prepareTarget: 'prepare-target',
  /** Final publish (app mode) or post-publish verification (native mode). */
  publishTarget: 'publish-target',
  /** Check the platform before retrying an ambiguous failure. */
  reconcileTarget: 'reconcile-target',
  /** Cancel a target on the platform (unschedule / delete container). */
  cancelTarget: 'cancel-target',
  notify: 'notify',
  // crons
  dispatch: 'dispatch',
  watchdog: 'watchdog',
  tokenHealth: 'token-health',
  purgeMedia: 'purge-media',
  dailyDigest: 'daily-digest',
  deadLetter: 'failed-jobs',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface AssetJob {
  assetId: string;
}
export interface GenerateTextJob {
  assetId: string;
  /** Only these platforms (default: all targets of the asset's post). */
  platforms?: Array<'instagram' | 'youtube' | 'facebook'>;
}
export interface TargetJob {
  targetId: string;
}
export interface NotifyJob {
  kind:
    | 'publish_failed'
    | 'needs_reauth'
    | 'token_expiring'
    | 'missed'
    | 'spend_limit'
    | 'quota'
    | 'digest'
    | 'test'
    | 'processing_failed';
  message: string;
  targetId?: string;
  /** Same key is sent at most once. */
  dedupeKey?: string;
  /** Deep link into the app. */
  link?: string;
}

export interface JobPayloads {
  'process-asset': AssetJob;
  'transcribe-asset': AssetJob;
  'generate-text': GenerateTextJob;
  'prepare-target': TargetJob;
  'publish-target': TargetJob;
  'reconcile-target': TargetJob;
  'cancel-target': TargetJob;
  notify: NotifyJob;
  dispatch: Record<string, never>;
  watchdog: Record<string, never>;
  'token-health': Record<string, never>;
  'purge-media': Record<string, never>;
  'daily-digest': Record<string, never>;
  'failed-jobs': Record<string, unknown>;
}

/** Queue options. pg-boss defaults (15 min expiry, 2 retries) are too small for video work. */
export const QUEUE_OPTIONS: Record<
  QueueName,
  QueueOptions & { policy?: 'standard' | 'exclusive' | 'singleton' }
> = {
  'process-asset': { expireInSeconds: 3600, retryLimit: 2, retryDelay: 30, retryBackoff: true },
  'transcribe-asset': { expireInSeconds: 900, retryLimit: 4, retryDelay: 30, retryBackoff: true },
  'generate-text': {
    expireInSeconds: 600,
    retryLimit: 4,
    retryDelay: 20,
    retryBackoff: true,
    retryDelayMax: 600,
  },
  'prepare-target': {
    policy: 'exclusive',
    expireInSeconds: 3600,
    retryLimit: 6,
    retryDelay: 60,
    retryBackoff: true,
    retryDelayMax: 1800,
  },
  'publish-target': {
    policy: 'exclusive',
    expireInSeconds: 900,
    retryLimit: 6,
    retryDelay: 60,
    retryBackoff: true,
    retryDelayMax: 1800,
  },
  'reconcile-target': { policy: 'exclusive', expireInSeconds: 300, retryLimit: 3, retryDelay: 60 },
  'cancel-target': {
    policy: 'exclusive',
    expireInSeconds: 300,
    retryLimit: 5,
    retryDelay: 60,
    retryBackoff: true,
  },
  notify: { expireInSeconds: 120, retryLimit: 5, retryDelay: 30, retryBackoff: true },
  dispatch: { expireInSeconds: 120, retryLimit: 0 },
  watchdog: { expireInSeconds: 300, retryLimit: 0 },
  'token-health': { expireInSeconds: 600, retryLimit: 2, retryDelay: 300 },
  'purge-media': { expireInSeconds: 1800, retryLimit: 1 },
  'daily-digest': { expireInSeconds: 300, retryLimit: 1 },
  'failed-jobs': { expireInSeconds: 300, retryLimit: 0 },
};

/** Crons (timezone = app timezone, set by the worker from settings/env). */
export const CRONS: Array<{ queue: QueueName; cron: string }> = [
  { queue: 'dispatch', cron: '* * * * *' },
  { queue: 'watchdog', cron: '*/5 * * * *' },
  { queue: 'token-health', cron: '17 3 * * *' },
  { queue: 'purge-media', cron: '37 4 * * *' },
  { queue: 'daily-digest', cron: '3 21 * * *' },
];

/** Options to use when sending a job for a specific target (one active job per target). */
export function targetJobOptions(targetId: string, extra: SendOptions = {}): SendOptions {
  return { singletonKey: targetId, ...extra };
}

let sender: PgBoss | undefined;
let senderStarting: Promise<PgBoss> | undefined;

/**
 * A pg-boss instance that only sends jobs (no maintenance, no cron, no migrations). Used by the
 * web app. The worker creates and migrates the schema.
 */
export async function getJobSender(connectionString = getEnv().DATABASE_URL): Promise<PgBoss> {
  if (sender) return sender;
  if (!connectionString) throw new Error('DATABASE_URL is not set.');
  senderStarting ??= (async () => {
    const boss = new PgBoss({
      connectionString,
      supervise: false,
      schedule: false,
      migrate: false,
      max: 3,
    });
    boss.on('error', (err) => console.error('[pg-boss sender]', err));
    await boss.start();
    sender = boss;
    return boss;
  })();
  return senderStarting;
}

export async function sendJob<Q extends keyof JobPayloads>(
  queue: Q,
  data: JobPayloads[Q],
  options: SendOptions = {},
): Promise<string | null> {
  const boss = await getJobSender();
  return boss.send(queue, data as object, options);
}
