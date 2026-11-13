/**
 * Helpers for the database-backed tests of this folder (not a test file itself).
 * Uses TEST_DATABASE_URL; every test creates and deletes its own rows, so the database can be
 * shared with other test suites (no global truncation).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { batches, getDb, mediaAssets, socialAccounts, type Db } from '@app/db';
import type { ServiceDeps } from '@app/core/deps';
import { getEnv } from '@app/core/env';
import type { JobPayloads } from '@app/core/jobs';
import type { Logger } from '@app/core/log';
import { LocalStorage } from '@app/core/storage';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DB_URL) {
  console.warn(
    '[ui-upload] TEST_DATABASE_URL is not set: database tests are skipped. ' +
      'Create a database, run `pnpm db:migrate` against it and set TEST_DATABASE_URL.',
  );
}

const silent: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silent,
};

export interface SentJob {
  queue: keyof JobPayloads;
  data: unknown;
  options: unknown;
}

export interface TestDeps extends ServiceDeps {
  sent: SentJob[];
  /** Temp STORAGE_DIR for this suite. */
  dir: string;
  /** Make jobs.send throw (as when the worker never created its queues). */
  failJobs: boolean;
  storage: LocalStorage;
}

export async function createTestDeps(): Promise<TestDeps> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ui-upload-db-'));
  const appUrl = 'http://localhost:3101';
  const deps: TestDeps = {
    db: getDb(TEST_DB_URL),
    storage: new LocalStorage(dir, appUrl),
    env: { ...getEnv(), APP_URL: appUrl, STORAGE_DRIVER: 'local', STORAGE_DIR: dir },
    log: silent,
    now: () => new Date(),
    sent: [],
    dir,
    failJobs: false,
    jobs: {
      send: async (queue, data, options) => {
        if (deps.failJobs) throw new Error(`Queue ${queue} does not exist`);
        deps.sent.push({ queue, data, options });
        return 'job-id';
      },
    },
  };
  return deps;
}

/** Deletes batches (and their assets, posts, targets, frames, attempts) and temp files. */
export async function cleanup(deps: TestDeps, batchIds: string[], accountIds: string[] = []) {
  const db: Db = deps.db;
  if (batchIds.length) {
    await db.delete(mediaAssets).where(inArray(mediaAssets.batchId, batchIds));
    await db.delete(batches).where(inArray(batches.id, batchIds));
  }
  for (const id of accountIds) await db.delete(socialAccounts).where(eq(socialAccounts.id, id));
  await rm(deps.dir, { recursive: true, force: true });
}
