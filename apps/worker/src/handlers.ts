/**
 * Job handlers: thin wrappers that call the core services. Each handler throws to let pg-boss
 * retry (retryable errors) and returns normally when the job is done or permanently failed
 * (the services record failures in the database themselves).
 */
import type { ServiceDeps } from '@app/core/deps';
import { QUEUES, type JobPayloads, type QueueName } from '@app/core/jobs';
import { extractAudio, processAsset } from '@app/core/media';
import { transcribeAsset } from '@app/core/stt';
import { generateForAsset } from '@app/core/ai';
import { notify } from '@app/core/notify';
import type { Engine } from '@app/core/scheduling';
import { promises as fs } from 'node:fs';

export type Handler<Q extends QueueName> = (data: JobPayloads[Q]) => Promise<void>;
export type HandlerMap = { [Q in QueueName]?: Handler<Q> };

export function createHandlers(deps: ServiceDeps, engine: Engine): HandlerMap {
  return {
    [QUEUES.processAsset]: async ({ assetId }) => {
      const res = await processAsset(deps, assetId);
      if (res.ok)
        await deps.jobs.send(QUEUES.transcribeAsset, { assetId }, { singletonKey: assetId });
    },
    [QUEUES.transcribeAsset]: async ({ assetId }) => {
      const audio = await extractAudio(deps, assetId);
      try {
        await transcribeAsset(deps, assetId, audio);
      } finally {
        if (audio) await fs.rm(audio.path, { force: true });
      }
      await deps.jobs.send(QUEUES.generateText, { assetId }, { singletonKey: assetId });
    },
    [QUEUES.generateText]: async ({ assetId, platforms }) => {
      await generateForAsset(deps, assetId, { platforms });
    },
    [QUEUES.prepareTarget]: async ({ targetId }) => engine.prepareTarget(targetId),
    [QUEUES.publishTarget]: async ({ targetId }) => engine.publishTarget(targetId),
    [QUEUES.reconcileTarget]: async ({ targetId }) => engine.reconcileTarget(targetId),
    [QUEUES.cancelTarget]: async ({ targetId }) => engine.cancelTarget(targetId),
    [QUEUES.notify]: async (job) => {
      await notify(deps, job);
    },
    [QUEUES.dispatch]: async () => engine.dispatch(),
    [QUEUES.watchdog]: async () => engine.watchdog(),
    [QUEUES.tokenHealth]: async () => engine.tokenHealth(),
    [QUEUES.purgeMedia]: async () => engine.purgeMedia(),
    [QUEUES.dailyDigest]: async () => engine.dailyDigest(),
    [QUEUES.deadLetter]: async (data) => {
      deps.log.error('Job failed permanently', { data });
    },
  };
}
