/**
 * Dependencies passed to every service function. Keeping them explicit makes the services easy
 * to test (fake clock, fake job sender, temp storage) and keeps globals out of business logic.
 */
import type { SendOptions } from 'pg-boss';
import { getDb, type Db } from '@app/db';
import { getEnv, type Env } from '../env';
import { getStorage, type Storage } from '../storage';
import { createLogger, type Logger } from '../log';
import { sendJob, type JobPayloads } from '../jobs';

export interface JobSender {
  send<Q extends keyof JobPayloads>(
    queue: Q,
    data: JobPayloads[Q],
    options?: SendOptions,
  ): Promise<string | null>;
}

export interface ServiceDeps {
  db: Db;
  storage: Storage;
  env: Env;
  log: Logger;
  jobs: JobSender;
  now: () => Date;
}

export function defaultDeps(overrides: Partial<ServiceDeps> = {}): ServiceDeps {
  return {
    db: overrides.db ?? getDb(),
    storage: overrides.storage ?? getStorage(),
    env: overrides.env ?? getEnv(),
    log: overrides.log ?? createLogger('app'),
    jobs: overrides.jobs ?? { send: (q, d, o) => sendJob(q, d, o) },
    now: overrides.now ?? (() => new Date()),
  };
}

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}
