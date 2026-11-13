/**
 * What happens when a pipeline step gives up for good (non-retryable error, or pg-boss ran out
 * of retries and moved the job to the dead-letter queue). The card must never stay "Processing"
 * forever: it shows what went wrong and what the owner can do.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { mediaAssets, postTargets, posts, type AssetWarning, type AttentionReason } from '@app/db';
import type { ServiceDeps } from '@app/core/deps';
import type { NotifyJob } from '@app/core/jobs';

async function alert(deps: ServiceDeps, job: NotifyJob): Promise<void> {
  try {
    await deps.jobs.send('notify', { link: `${deps.env.APP_URL}/`, ...job });
  } catch (err) {
    deps.log.warn('could not queue alert', { kind: job.kind, err });
  }
}

/** Video processing failed for good: the card shows "Video could not be processed". */
export async function markAssetFailed(
  deps: ServiceDeps,
  assetId: string,
  message: string,
): Promise<void> {
  const rows = await deps.db
    .update(mediaAssets)
    .set({ status: 'failed', processingStep: null, error: message })
    .where(
      and(
        eq(mediaAssets.id, assetId),
        inArray(mediaAssets.status, ['uploading', 'uploaded', 'processing']),
      ),
    )
    .returning({ filename: mediaAssets.filename });
  if (!rows[0]) return;
  await alert(deps, {
    kind: 'processing_failed',
    message: `'${rows[0].filename}' could not be processed: ${message}`,
    dedupeKey: `processing_failed:${assetId}`,
  });
}

/** Adds a card warning unless one with the same code is already there. */
export async function addAssetWarning(
  deps: ServiceDeps,
  assetId: string,
  warning: AssetWarning,
): Promise<void> {
  const [asset] = await deps.db
    .select({ warnings: mediaAssets.warnings })
    .from(mediaAssets)
    .where(eq(mediaAssets.id, assetId));
  if (!asset || asset.warnings.some((w) => w.code === warning.code)) return;
  await deps.db
    .update(mediaAssets)
    .set({ warnings: [...asset.warnings, warning] })
    .where(eq(mediaAssets.id, assetId));
}

export const noTranscriptWarning = (detail: string): AssetWarning => ({
  code: 'no_transcript',
  severity: 'info',
  message: `Speech-to-text failed (${detail.slice(0, 120)}); captions were written from the video frames and your notes.`,
});

/**
 * AI text could not be written for good. The video itself is fine, so the asset becomes 'ready'
 * (the owner can write the text by hand) and its draft targets show the reason.
 */
export async function markTextFailed(
  deps: ServiceDeps,
  assetId: string,
  reason: Extract<AttentionReason, 'ai_failed' | 'spend_limit' | 'write_manually'>,
  message: string,
): Promise<void> {
  await deps.db
    .update(mediaAssets)
    .set({ status: 'ready', processingStep: null })
    .where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.status, 'processing')));
  const failed = await deps.db
    .update(postTargets)
    .set({ status: 'failed', attentionReason: reason, lastError: message.slice(0, 500) })
    .where(
      and(
        eq(postTargets.status, 'draft'),
        inArray(
          postTargets.postId,
          sql`(select ${posts.id} from ${posts} where ${posts.assetId} = ${assetId})`,
        ),
      ),
    )
    .returning({ id: postTargets.id });
  if (failed.length === 0) return;
  const [asset] = await deps.db
    .select({ filename: mediaAssets.filename })
    .from(mediaAssets)
    .where(eq(mediaAssets.id, assetId));
  await alert(deps, {
    kind: reason === 'spend_limit' ? 'spend_limit' : 'processing_failed',
    message:
      reason === 'spend_limit'
        ? `AI paused: spend limit reached. '${asset?.filename ?? 'A video'}' has no captions yet.`
        : `AI could not write the text for '${asset?.filename ?? 'a video'}': ${message} Write it manually or try Regenerate.`,
    dedupeKey: `${reason}:${assetId}`,
  });
}
