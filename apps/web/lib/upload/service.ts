/**
 * Write side of the Upload screen. Server-only; every function takes ServiceDeps so tests can
 * run it against a real database with fake jobs and a temp storage directory. The server
 * actions in lib/actions/upload.ts add auth + input validation on top.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, max } from 'drizzle-orm';
import { batches, mediaAssets, postTargets, posts, type MediaAsset, type Platform } from '@app/db';
import type { ServiceDeps } from '@app/core/deps';
import { createPostForAsset, getPostCards } from '@app/core/posts';
import { schedulePosts, type ScheduleRequest } from '@app/core/scheduling';
import { getSettings } from '@app/core/settings';
import { keys, type UploadTarget } from '@app/core/storage';
import { PLATFORM_LABELS } from '@app/core/platforms';
import { planTargetChanges } from './apply-plan';
import { browserUrl, livePostIdForAsset } from './batch-view';
import { LOCAL_CHUNK_BYTES } from './constants';
import { UserError } from './errors';
import { compareNames, formatBytes, storageExtension, videoTypeFor } from './format';
import type { BatchSettings, ScheduleSummary, StartedUpload, WhenRule } from './types';

export interface FileMeta {
  name: string;
  size: number;
  type: string;
}

/** Strips control characters (they break logs and some platform APIs) and trims. */
export function cleanFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f]/g, '').trim() || 'video';
}

function browserTarget(deps: ServiceDeps, target: UploadTarget): StartedUpload['target'] {
  return { ...target, url: browserUrl(target.url, deps.storage, deps.env.APP_URL) };
}

function uploadExtras(deps: ServiceDeps): Pick<StartedUpload, 'chunkSize'> {
  return deps.storage.driver === 'local' ? { chunkSize: LOCAL_CHUNK_BYTES } : {};
}

function acceptedType(file: FileMeta) {
  const type = videoTypeFor(file.name, file.type);
  if (!type) throw new UserError(`${file.name} is not an MP4 or MOV video.`, 'validation');
  return type;
}

// ---------------------------------------------------------------------------------------------
// Starting and finishing uploads
// ---------------------------------------------------------------------------------------------

/**
 * Creates (or reuses) the batch and one `media_assets` row per file, and signs an upload URL for
 * each. sortIndex follows the filename order; createdAt follows the order the files were
 * picked (the "Selection" sort), one millisecond apart.
 */
export async function createUploadBatch(
  deps: ServiceDeps,
  input: { files: FileMeta[]; settings: BatchSettings; batchId?: string | null },
): Promise<{ batchId: string; items: StartedUpload[] }> {
  const files = input.files.map((f, index) => {
    const name = cleanFilename(f.name);
    const type = acceptedType({ ...f, name });
    return { name, size: f.size, type, ext: storageExtension(name, type), index };
  });
  const nameRank = new Map(
    [...files]
      .sort((a, b) => compareNames(a.name, b.name) || a.index - b.index)
      .map((f, rank) => [f.index, rank]),
  );
  const { platforms, notes, when } = input.settings;
  const now = deps.now();

  return deps.db.transaction(async (tx) => {
    let batchId: string | undefined;
    if (input.batchId) {
      // New files join the batch on screen and pick up the bar's current settings.
      const updated = await tx
        .update(batches)
        .set({ platforms, notes, slotRule: when })
        .where(eq(batches.id, input.batchId))
        .returning({ id: batches.id });
      batchId = updated[0]?.id;
    }
    if (!batchId) {
      const inserted = await tx
        .insert(batches)
        .values({ platforms, notes, slotRule: when })
        .returning({ id: batches.id });
      batchId = inserted[0]!.id;
    }

    const [agg] = await tx
      .select({ top: max(mediaAssets.sortIndex) })
      .from(mediaAssets)
      .where(eq(mediaAssets.batchId, batchId));
    const base = agg?.top === null || agg?.top === undefined ? 0 : agg.top + 1;

    const rows = files.map((f) => {
      const id = randomUUID();
      return {
        id,
        batchId: batchId!,
        filename: f.name,
        contentType: f.type,
        sizeBytes: f.size,
        originalKey: keys.original(id, f.ext),
        status: 'uploading' as const,
        notes,
        sortIndex: base + nameRank.get(f.index)!,
        createdAt: new Date(now.getTime() + f.index),
      };
    });
    await tx.insert(mediaAssets).values(rows);

    // Signing happens inside the transaction: if it fails, no orphan "uploading" rows remain.
    const issuedAt = now.getTime();
    const items: StartedUpload[] = [];
    for (const [i, r] of rows.entries()) {
      const target = await deps.storage.createUploadTarget(r.originalKey, r.contentType);
      items.push({
        assetId: r.id,
        index: files[i]!.index,
        sortIndex: r.sortIndex,
        target: browserTarget(deps, target),
        issuedAt,
        ...uploadExtras(deps),
      });
    }
    return { batchId, items };
  });
}

async function getAsset(deps: ServiceDeps, assetId: string): Promise<MediaAsset> {
  const asset = (
    await deps.db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId)).limit(1)
  )[0];
  if (!asset) throw new UserError('This video no longer exists.', 'not_found');
  return asset;
}

/** A fresh signed URL for the same file (the old one expired or was rejected). */
export async function renewUploadTarget(
  deps: ServiceDeps,
  assetId: string,
): Promise<Omit<StartedUpload, 'index' | 'sortIndex'>> {
  const asset = await getAsset(deps, assetId);
  if (asset.status !== 'uploading') {
    throw new UserError('This video has already been uploaded.', 'validation');
  }
  const target = await deps.storage.createUploadTarget(asset.originalKey, asset.contentType);
  return {
    assetId,
    target: browserTarget(deps, target),
    issuedAt: deps.now().getTime(),
    ...uploadExtras(deps),
  };
}

/**
 * "Choose file again" on an interrupted upload: the owner picked a file (maybe a different
 * one), so forget any partial bytes and point the asset at the new file.
 */
export async function restartUpload(
  deps: ServiceDeps,
  input: { assetId: string; file: FileMeta },
): Promise<Omit<StartedUpload, 'index' | 'sortIndex'>> {
  const asset = await getAsset(deps, input.assetId);
  if (asset.status !== 'uploading') {
    throw new UserError('This video has already been uploaded.', 'validation');
  }
  const name = cleanFilename(input.file.name);
  const type = acceptedType({ ...input.file, name });
  const originalKey = keys.original(asset.id, storageExtension(name, type));
  await deps.storage.deletePrefix(`uploads/${asset.id}/`);
  await deps.db
    .update(mediaAssets)
    .set({ filename: name, contentType: type, sizeBytes: input.file.size, originalKey })
    .where(and(eq(mediaAssets.id, asset.id), eq(mediaAssets.status, 'uploading')));
  const target = await deps.storage.createUploadTarget(originalKey, type);
  return {
    assetId: asset.id,
    target: browserTarget(deps, target),
    issuedAt: deps.now().getTime(),
    ...uploadExtras(deps),
  };
}

/**
 * The browser finished sending the bytes: check them, mark the asset uploaded, create the post
 * with one draft target per batch platform, and queue processing. Idempotent.
 */
export async function completeAssetUpload(
  deps: ServiceDeps,
  assetId: string,
): Promise<{ postId: string; warning?: string }> {
  const asset = await getAsset(deps, assetId);
  if (asset.status !== 'uploading') {
    const postId = await livePostIdForAsset(deps.db, asset.id);
    if (postId) return { postId };
  } else {
    const info = await deps.storage.head(asset.originalKey);
    if (!info)
      throw new UserError('The upload did not arrive. Sending it again…', 'upload_missing');
    if (info.size !== asset.sizeBytes) {
      throw new UserError(
        `Upload incomplete (${formatBytes(info.size)} of ${formatBytes(asset.sizeBytes)}).`,
        'size_mismatch',
      );
    }
    await deps.db
      .update(mediaAssets)
      .set({ status: 'uploaded', error: null })
      .where(and(eq(mediaAssets.id, asset.id), eq(mediaAssets.status, 'uploading')));
  }

  const settings = await getSettings(deps.db);
  const batch = asset.batchId
    ? (await deps.db.select().from(batches).where(eq(batches.id, asset.batchId)).limit(1))[0]
    : undefined;
  const platforms = batch?.platforms.length ? batch.platforms : settings.defaultPlatforms;
  const { post } = await createPostForAsset(deps.db, {
    assetId: asset.id,
    batchId: asset.batchId,
    platforms,
    settings,
  });

  try {
    await deps.jobs.send('process-asset', { assetId: asset.id }, { singletonKey: asset.id });
  } catch (err) {
    // The upload itself is safe; processing starts once the worker (and its queues) run.
    deps.log.warn('Could not queue process-asset', { assetId: asset.id, err });
    return {
      postId: post.id,
      warning: 'Uploaded. Processing starts when the background worker is running.',
    };
  }
  return { postId: post.id };
}

/** Removes a video whose upload never finished (no post exists yet). */
export async function removeUnfinishedUpload(deps: ServiceDeps, assetId: string): Promise<void> {
  const asset = (
    await deps.db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId)).limit(1)
  )[0];
  if (!asset) return;
  if (asset.status !== 'uploading' || (await livePostIdForAsset(deps.db, asset.id))) {
    throw new UserError('This video is already uploaded. Delete it from its editor.', 'validation');
  }
  await deps.db
    .delete(mediaAssets)
    .where(and(eq(mediaAssets.id, asset.id), eq(mediaAssets.status, 'uploading')));
  for (const prefix of keys.assetPrefixes(asset.id)) {
    await deps.storage.deletePrefix(prefix).catch((err: unknown) => {
      deps.log.warn('Could not delete storage prefix', { prefix, err });
    });
  }
}

/** Puts a video whose processing failed back into the queue. */
export async function retryAssetProcessing(deps: ServiceDeps, assetId: string): Promise<void> {
  const asset = await getAsset(deps, assetId);
  if (asset.status !== 'failed' && asset.status !== 'uploaded') {
    throw new UserError('This video is not waiting for a retry.', 'validation');
  }
  await deps.db
    .update(mediaAssets)
    .set({ status: 'uploaded', processingStep: null, error: null })
    .where(eq(mediaAssets.id, asset.id));
  try {
    await deps.jobs.send('process-asset', { assetId: asset.id }, { singletonKey: asset.id });
  } catch (err) {
    deps.log.warn('Could not queue process-asset', { assetId: asset.id, err });
    throw new UserError('Could not start processing. Is the background worker running?');
  }
}

// ---------------------------------------------------------------------------------------------
// AI text jobs
// ---------------------------------------------------------------------------------------------

/**
 * Queues the AI for a ready asset (all targets, or only `platforms`) and shows the card as
 * "Processing · Writing captions" until generateForAsset sets the asset back to 'ready'.
 * Returns false when the asset isn't ready (its pipeline will write the text anyway).
 */
export async function queueTextGeneration(
  deps: ServiceDeps,
  assetId: string,
  platforms?: Platform[],
): Promise<boolean> {
  const flipped = await deps.db
    .update(mediaAssets)
    .set({ status: 'processing', processingStep: 'generate', error: null })
    .where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.status, 'ready')))
    .returning({ id: mediaAssets.id });
  if (flipped.length === 0) return false;
  try {
    await deps.jobs.send('generate-text', platforms ? { assetId, platforms } : { assetId }, {
      singletonKey: assetId,
    });
    return true;
  } catch (err) {
    await deps.db
      .update(mediaAssets)
      .set({ status: 'ready', processingStep: null })
      .where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.status, 'processing')));
    deps.log.warn('Could not queue generate-text', { assetId, err });
    throw new UserError('Could not start the AI. Is the background worker running?', 'unavailable');
  }
}

// ---------------------------------------------------------------------------------------------
// Batch bar: Apply to all
// ---------------------------------------------------------------------------------------------

export interface ApplyResult {
  changedCards: number;
  addedTargets: number;
  removedTargets: number;
  /** Targets left in place because they are past the draft stage. */
  kept: Array<{ filename: string; platform: Platform; reason: string }>;
  textJobs: number;
  warnings: string[];
}

/**
 * Applies the batch bar to every card: saves the batch settings, sets each video's notes, adds
 * missing platforms (draft targets; the AI writes their text) and deletes draft targets of
 * platforms that were turned off. Targets that are already scheduled or later are kept.
 */
export async function applyBatchSettings(
  deps: ServiceDeps,
  input: { batchId: string; settings: BatchSettings; rewriteReady?: boolean },
): Promise<ApplyResult> {
  const { db } = deps;
  const { platforms, notes, when } = input.settings;
  const updated = await db
    .update(batches)
    .set({ platforms, notes, slotRule: when })
    .where(eq(batches.id, input.batchId))
    .returning({ id: batches.id });
  if (!updated.length) throw new UserError('This batch no longer exists.', 'not_found');

  const settings = await getSettings(db);
  const assets = await db.select().from(mediaAssets).where(eq(mediaAssets.batchId, input.batchId));
  const allPosts = assets.length
    ? await db
        .select()
        .from(posts)
        .where(
          inArray(
            posts.assetId,
            assets.map((a) => a.id),
          ),
        )
    : [];
  // Deleted posts (and their videos) are hidden from the screen; leave them alone.
  const deletedAssetIds = new Set(allPosts.filter((p) => p.deletedAt).map((p) => p.assetId));
  const postRows = allPosts.filter((p) => !p.deletedAt);
  const targets = postRows.length
    ? await db
        .select()
        .from(postTargets)
        .where(
          inArray(
            postTargets.postId,
            postRows.map((p) => p.id),
          ),
        )
    : [];

  const result: ApplyResult = {
    changedCards: 0,
    addedTargets: 0,
    removedTargets: 0,
    kept: [],
    textJobs: 0,
    warnings: [],
  };
  for (const asset of assets) {
    if (deletedAssetIds.has(asset.id)) continue;
    let changed = false;
    const notesChanged = asset.notes !== notes;
    if (notesChanged) {
      await db.update(mediaAssets).set({ notes }).where(eq(mediaAssets.id, asset.id));
      changed = true;
    }
    const post = postRows.find((p) => p.assetId === asset.id);
    if (!post) {
      // Still uploading: completeUpload creates the targets from the (updated) batch row.
      if (changed) result.changedCards += 1;
      continue;
    }
    const mine = targets.filter((t) => t.postId === post.id);
    const plan = planTargetChanges(mine, platforms);

    if (plan.remove.length) {
      const removed = await db
        .delete(postTargets)
        .where(
          and(
            inArray(
              postTargets.id,
              plan.remove.map((t) => t.id),
            ),
            eq(postTargets.status, 'draft'),
          ),
        )
        .returning({ id: postTargets.id });
      result.removedTargets += removed.length;
      changed ||= removed.length > 0;
    }
    for (const t of plan.keep) {
      result.kept.push({
        filename: asset.filename,
        platform: t.platform,
        reason: `${PLATFORM_LABELS[t.platform]} is already ${t.status === 'published' ? 'published' : 'scheduled'}`,
      });
    }
    if (plan.add.length) {
      // A canceled target blocks re-adding its platform (unique post+platform); it is history.
      const canceled = mine.filter((t) => t.status === 'canceled' && plan.add.includes(t.platform));
      if (canceled.length) {
        await db.delete(postTargets).where(
          inArray(
            postTargets.id,
            canceled.map((t) => t.id),
          ),
        );
      }
      await createPostForAsset(db, {
        assetId: asset.id,
        batchId: post.batchId,
        platforms: plan.add,
        settings,
      });
      result.addedTargets += plan.add.length;
      changed = true;
    }

    if (asset.status === 'ready') {
      const rewriteAll = Boolean(input.rewriteReady) && notesChanged;
      if (rewriteAll || plan.add.length) {
        try {
          if (await queueTextGeneration(deps, asset.id, rewriteAll ? undefined : plan.add)) {
            result.textJobs += 1;
          }
        } catch (err) {
          result.warnings.push(
            `${asset.filename}: ${err instanceof Error ? err.message : 'could not start the AI'}`,
          );
        }
      }
    }
    if (changed) result.changedCards += 1;
  }
  // De-duplicate repeated warnings (e.g. the worker is down for every card).
  result.warnings = [...new Set(result.warnings.map((w) => w.replace(/^[^:]+: /, '')))];
  return result;
}

// ---------------------------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------------------------

/** Saves the card order (drag & drop or the Order menu): sortIndex = position. */
export async function reorderBatch(
  deps: ServiceDeps,
  input: { batchId: string; assetIds: string[] },
): Promise<void> {
  if (new Set(input.assetIds).size !== input.assetIds.length) {
    throw new UserError('Each video can appear only once in the order.', 'validation');
  }
  await deps.db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(eq(mediaAssets.batchId, input.batchId));
    const inBatch = new Set(rows.map((r) => r.id));
    if (input.assetIds.some((id) => !inBatch.has(id))) {
      throw new UserError('Some videos are not part of this batch. Refresh the page.', 'conflict');
    }
    for (const [i, id] of input.assetIds.entries()) {
      await tx.update(mediaAssets).set({ sortIndex: i }).where(eq(mediaAssets.id, id));
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Schedule (footer button)
// ---------------------------------------------------------------------------------------------

/** The time a dated draft was picked for (post time, or the earliest target time). */
function pickedTimes(card: Awaited<ReturnType<typeof getPostCards>>[number]) {
  const drafts = card.targets.filter((t) => t.status === 'draft');
  const times = drafts.map((t) => t.scheduledAt).filter((d): d is Date => d instanceof Date);
  const at =
    card.scheduledAt ??
    (times.length ? new Date(Math.min(...times.map((d) => d.getTime()))) : null);
  const distinct = new Set(times.map((d) => d.getTime()));
  let perPlatformAt: Partial<Record<Platform, Date>> | undefined;
  if (distinct.size > 1) {
    perPlatformAt = {};
    for (const t of drafts) if (t.scheduledAt) perPlatformAt[t.platform] = t.scheduledAt;
  }
  return { at, perPlatformAt };
}

/**
 * The footer's "Schedule N videos": the owner's explicit consent (PLAN.md §9). Uses the batch
 * bar's When choice. postIds are in card order, so "next free slot" fills slots in that order.
 */
export async function scheduleBatch(
  deps: ServiceDeps,
  input: { batchId: string; postIds: string[]; when: WhenRule },
): Promise<ScheduleSummary> {
  const { db } = deps;
  await db.update(batches).set({ slotRule: input.when }).where(eq(batches.id, input.batchId));

  const cards = await getPostCards(db, { postIds: input.postIds }, deps.now());
  const byId = new Map(cards.map((c) => [c.id, c]));
  const ordered = input.postIds
    .map((id) => byId.get(id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c) && c!.batchId === input.batchId);
  const filename = (postId: string) => byId.get(postId)?.asset.filename ?? 'video';
  const summary: ScheduleSummary = { scheduled: [], skipped: [], warnings: [] };
  for (const id of input.postIds) {
    if (!ordered.some((c) => c.id === id)) {
      summary.skipped.push({ postId: id, filename: filename(id), reason: 'Not in this batch' });
    }
  }
  if (ordered.length === 0) return summary;

  const merge = (res: Awaited<ReturnType<typeof schedulePosts>>) => {
    summary.scheduled.push(...res.scheduled.map((s) => ({ ...s, filename: filename(s.postId) })));
    summary.skipped.push(...res.skipped.map((s) => ({ ...s, filename: filename(s.postId) })));
    summary.warnings.push(...res.warnings);
  };

  if (input.when.mode !== 'pick') {
    const req: ScheduleRequest = { postIds: ordered.map((c) => c.id), mode: input.when.mode };
    if (input.when.mode === 'next_free' && input.when.startDate) {
      req.startDate = input.when.startDate;
    }
    merge(await schedulePosts(deps, req));
  } else {
    // "Pick date & time on each card": every card carries its own (dated draft) time.
    const now = deps.now().getTime();
    for (const card of ordered) {
      const { at, perPlatformAt } = pickedTimes(card);
      if (!at) {
        summary.skipped.push({
          postId: card.id,
          filename: card.asset.filename,
          reason: 'No date & time picked yet',
        });
        continue;
      }
      if (at.getTime() <= now) {
        summary.skipped.push({
          postId: card.id,
          filename: card.asset.filename,
          reason: 'The picked time has already passed',
        });
        continue;
      }
      merge(
        await schedulePosts(deps, {
          postIds: [card.id],
          mode: 'pick',
          at,
          ...(perPlatformAt ? { perPlatformAt } : {}),
        }),
      );
    }
  }
  summary.warnings = [...new Set(summary.warnings)];
  return summary;
}
