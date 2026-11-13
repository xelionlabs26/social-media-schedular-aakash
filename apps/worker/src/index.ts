/**
 * Background worker: video processing, speech-to-text, AI text and the publishing engine.
 * Runs migrations on start, creates the pg-boss queues and crons, then processes jobs.
 */
import { PgBoss } from 'pg-boss';
import { closeDb, getDb } from '@app/db';
import { runMigrations } from '@app/db/migrate';
import { getEnv } from '@app/core';
import { defaultDeps } from '@app/core/deps';
import { CRONS, QUEUES, QUEUE_OPTIONS, type QueueName } from '@app/core/jobs';
import { createLogger } from '@app/core/log';
import { getSettings } from '@app/core/settings';
import { createEngine } from '@app/core/scheduling';
import { createIntegrations } from './integrations';
import { createHandlers, type JobMeta } from './handlers';
import { WorkerJobs } from './jobs';

const log = createLogger('worker');

/** Local concurrency per queue (ffmpeg is CPU/RAM heavy: one at a time). */
const CONCURRENCY: Partial<Record<QueueName, number>> = {
  'process-asset': 1,
  'transcribe-asset': 2,
  'generate-text': 2,
  'prepare-target': 2,
  'publish-target': 3,
};

async function main() {
  const env = getEnv();
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');

  await runMigrations(env.DATABASE_URL);
  log.info('Migrations applied');

  const boss = new PgBoss({ connectionString: env.DATABASE_URL, max: 8 });
  boss.on('error', (err) => log.error('pg-boss error', { err }));
  await boss.start();

  const jobs = new WorkerJobs(boss, log);
  const deps = defaultDeps({ db: getDb(env.DATABASE_URL), log, jobs: jobs.sender });
  const settings = await getSettings(deps.db);

  // Queues (idempotent).
  const existing = new Set((await boss.getQueues()).map((q) => q.name));
  // The dead-letter queue must exist before queues that point to it.
  const queueNames = [
    QUEUES.deadLetter,
    ...Object.values(QUEUES).filter((n) => n !== QUEUES.deadLetter),
  ];
  for (const name of queueNames) {
    const { policy, ...opts } = QUEUE_OPTIONS[name];
    const deadLetter = name === QUEUES.deadLetter ? undefined : QUEUES.deadLetter;
    if (!existing.has(name)) {
      await boss.createQueue(name, {
        ...opts,
        ...(policy ? { policy } : {}),
        ...(deadLetter ? { deadLetter } : {}),
      });
    } else {
      await boss.updateQueue(name, { ...opts, ...(deadLetter ? { deadLetter } : {}) });
    }
  }

  // Crons in the owner's time zone.
  for (const { queue, cron } of CRONS) {
    await boss.schedule(queue, cron, {}, { tz: settings.timezone });
  }

  const engine = createEngine(deps, createIntegrations());
  const handlers = createHandlers(deps, engine);

  for (const [name, handler] of Object.entries(handlers) as Array<
    [QueueName, (d: unknown, meta?: JobMeta) => Promise<void>]
  >) {
    await boss.work(
      name,
      {
        localConcurrency: CONCURRENCY[name] ?? 1,
        pollingIntervalSeconds: 2,
        includeMetadata: true,
      },
      async (batch) => {
        for (const job of batch) {
          const started = Date.now();
          const meta: JobMeta = {
            id: job.id,
            retryCount: job.retryCount,
            retryLimit: job.retryLimit,
            sourceName: job.sourceName,
          };
          try {
            await jobs.run(job, () => handler(job.data, meta));
            log.debug('job done', { queue: name, id: job.id, ms: Date.now() - started });
          } catch (err) {
            log.warn('job failed (will retry if attempts remain)', {
              queue: name,
              id: job.id,
              err,
            });
            throw err;
          }
        }
      },
    );
  }

  log.info('Worker started', {
    timezone: settings.timezone,
    publishing: env.PUBLISHING_ENABLED,
    storage: env.STORAGE_DRIVER,
  });

  const shutdown = async (signal: string) => {
    log.info('Shutting down', { signal });
    await boss.stop({ graceful: true, timeout: 30_000 }).catch(() => {});
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(async (err) => {
  log.error('Worker crashed on start', { err });
  await closeDb().catch(() => {});
  process.exit(1);
});
