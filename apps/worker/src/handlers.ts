/**
 * Job handlers: thin wrappers that call the core services. Each handler throws to let pg-boss
 * retry (retryable errors only) and returns normally when the job is done or permanently failed
 * (the services record failures in the database themselves).
 */
import type { ServiceDeps } from '@app/core/deps';
import { QUEUES, type JobPayloads, type QueueName } from '@app/core/jobs';
import { extractAudio, processAsset } from '@app/core/media';
import { SttError, transcribeAsset } from '@app/core/stt';
import { AiError, generateForAsset } from '@app/core/ai';
import { notify } from '@app/core/notify';
import type { Engine } from '@app/core/scheduling';
import { promises as fs } from 'node:fs';
import { addAssetWarning, markAssetFailed, markTextFailed, noTranscriptWarning } from './failures';

/** Job metadata the handlers may use (pg-boss `includeMetadata`). */
export interface JobMeta {
  id: string;
  retryCount: number;
  retryLimit?: number;
  /** For dead-lettered jobs: the queue the job originally failed on. */
  sourceName?: string | null;
}

export type Handler<Q extends QueueName> = (data: JobPayloads[Q], meta?: JobMeta) => Promise<void>;
export type HandlerMap = { [Q in QueueName]?: Handler<Q> };

const AI_REASON = {
  spend: 'spend_limit',
  refusal: 'write_manually',
  config: 'ai_failed',
  fatal: 'ai_failed',
} as const;

export function createHandlers(deps: ServiceDeps, engine: Engine): HandlerMap {
  const continueWithoutTranscript = async (assetId: string, detail: string) => {
    // A transcript is optional: captions are then written from frames + notes (PLAN.md §4.2).
    await addAssetWarning(deps, assetId, noTranscriptWarning(detail));
    await deps.jobs.send(QUEUES.generateText, { assetId }, { singletonKey: assetId });
  };

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
      } catch (err) {
        // Only retryable speech-to-text errors go back to pg-boss; the rest won't fix themselves.
        if (!(err instanceof SttError) || err.category === 'retryable') throw err;
        deps.log.warn('speech-to-text failed; continuing without a transcript', {
          assetId,
          category: err.category,
          message: err.message,
        });
        await continueWithoutTranscript(assetId, err.message);
        return;
      } finally {
        if (audio) await fs.rm(audio.path, { force: true });
      }
      await deps.jobs.send(QUEUES.generateText, { assetId }, { singletonKey: assetId });
    },
    [QUEUES.generateText]: async ({ assetId, platforms }) => {
      try {
        await generateForAsset(deps, assetId, { platforms });
      } catch (err) {
        if (!(err instanceof AiError) || err.category === 'retryable') throw err;
        deps.log.warn('AI text failed; not retrying', {
          assetId,
          category: err.category,
          message: err.message,
        });
        await markTextFailed(deps, assetId, AI_REASON[err.category], err.message);
      }
    },
    [QUEUES.prepareTarget]: async ({ targetId }) => engine.prepareTarget(targetId),
    [QUEUES.publishTarget]: async ({ targetId }) => engine.publishTarget(targetId),
    [QUEUES.reconcileTarget]: async ({ targetId }) => engine.reconcileTarget(targetId),
    [QUEUES.cancelTarget]: async ({ targetId }) => engine.cancelTarget(targetId),
    [QUEUES.notify]: async (job) => {
      const res = await notify(deps, job);
      // Network trouble / rate limit: let pg-boss retry (the dedupe key prevents doubles).
      if (!res.sent && res.retryable) throw new Error(res.reason ?? 'alert send failed');
    },
    [QUEUES.dispatch]: async () => engine.dispatch(),
    [QUEUES.watchdog]: async () => engine.watchdog(),
    [QUEUES.tokenHealth]: async () => engine.tokenHealth(),
    [QUEUES.purgeMedia]: async () => engine.purgeMedia(),
    [QUEUES.dailyDigest]: async () => engine.dailyDigest(),
    [QUEUES.deadLetter]: async (data, meta) => {
      // pg-boss gave up on a job after all its retries.
      const source = meta?.sourceName ?? 'unknown';
      const assetId = typeof data.assetId === 'string' ? data.assetId : undefined;
      deps.log.error('Job failed permanently', { queue: source, data });
      if (!assetId) return; // target jobs: the engine's state is in the database (watchdog)
      if (source === QUEUES.processAsset) {
        await markAssetFailed(deps, assetId, 'processing failed after several tries.');
      } else if (source === QUEUES.transcribeAsset) {
        await continueWithoutTranscript(assetId, 'the service kept failing');
      } else if (source === QUEUES.generateText) {
        await markTextFailed(deps, assetId, 'ai_failed', 'the AI service kept failing.');
      }
    },
  };
}
