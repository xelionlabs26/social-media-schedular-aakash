/**
 * The worker's job sender.
 *
 * Target queues use pg-boss's 'exclusive' policy with singletonKey = target id: one queued or
 * active job per target. A handler that re-queues its own target (a platform said "wait 30 s",
 * or a retry with backoff) would be dropped by that rule while its own job is still active. So a
 * send for the running job's own queue + key is held back, the job is completed, and then the
 * send goes out. The database stays the source of truth: if the process dies in between, the
 * dispatcher picks the target up from next_attempt_at within a minute.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PgBoss, SendOptions } from 'pg-boss';
import type { JobSender } from '@app/core/deps';
import type { Logger } from '@app/core/log';

interface RunningJob {
  queue: string;
  singletonKey: string | null;
  deferred: Array<{ queue: string; data: object; options: SendOptions }>;
}

export interface JobRef {
  id: string;
  name: string;
  singletonKey?: string | null;
}

export class WorkerJobs {
  private readonly running = new AsyncLocalStorage<RunningJob>();

  constructor(
    private readonly boss: Pick<PgBoss, 'send' | 'complete'>,
    private readonly log: Logger,
  ) {}

  readonly sender: JobSender = {
    send: (queue, data, options) => this.send(queue, data as object, options ?? {}),
  };

  private async send(queue: string, data: object, options: SendOptions): Promise<string | null> {
    const job = this.running.getStore();
    if (job && job.queue === queue && job.singletonKey === (options.singletonKey ?? null)) {
      job.deferred.push({ queue, data, options });
      return null;
    }
    return this.boss.send(queue, data, options);
  }

  /** Runs a handler; re-sends of its own queue + key go out after the job is completed. */
  async run(job: JobRef, handler: () => Promise<void>): Promise<void> {
    const ctx: RunningJob = {
      queue: job.name,
      singletonKey: job.singletonKey ?? null,
      deferred: [],
    };
    await this.running.run(ctx, handler);
    if (ctx.deferred.length === 0) return;
    // Settling the job ourselves is supported: pg-boss's own completion afterwards is a no-op.
    await this.boss.complete(job.name, job.id);
    for (const d of ctx.deferred) {
      try {
        await this.boss.send(d.queue, d.data, d.options);
      } catch (err) {
        this.log.warn('could not re-queue job; the dispatcher will pick it up', {
          queue: d.queue,
          err,
        });
      }
    }
  }
}
