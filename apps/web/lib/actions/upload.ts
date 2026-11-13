'use server';

/**
 * Server actions for the Upload screen. Each one: requireOwner() first (runAction), zod-checked
 * input, a small serializable result, and `{ ok: false, error }` instead of throwing.
 */
import { z } from 'zod';
import { PLATFORMS, type Platform } from '@app/db';
import { runAction } from '@/lib/upload/action-runner';
import { loadBatchView } from '@/lib/upload/batch-view';
import {
  FILENAME_MAX_CHARS,
  MAX_FILE_BYTES,
  MAX_FILES_PER_CALL,
  NOTES_MAX_CHARS,
} from '@/lib/upload/constants';
import { UserError } from '@/lib/upload/errors';
import {
  applyBatchSettings,
  completeAssetUpload,
  createUploadBatch,
  removeUnfinishedUpload,
  renewUploadTarget,
  reorderBatch,
  restartUpload,
  retryAssetProcessing,
  scheduleBatch,
  type ApplyResult,
} from '@/lib/upload/service';
import { isRealDate } from '@/lib/upload/time';
import type {
  ActionResult,
  BatchSettings,
  BatchView,
  ScheduleSummary,
  StartedUpload,
  WhenRule,
} from '@/lib/upload/types';

// ---- Input schemas (not exported: a 'use server' file may only export async functions) -------

const Id = z.uuid();

const FileSchema = z.object({
  name: z.string().trim().min(1).max(FILENAME_MAX_CHARS),
  size: z
    .number()
    .int()
    .positive('The file is empty')
    .max(MAX_FILE_BYTES, 'Files can be at most 2 GB'),
  type: z.string().max(100),
});

const WhenSchema = z
  .object({
    mode: z.enum(['next_free', 'pick', 'draft']),
    startDate: z.string().refine(isRealDate, 'Use a date like 2026-11-15').optional(),
  })
  .transform((w): WhenRule =>
    w.mode === 'next_free' && w.startDate
      ? { mode: w.mode, startDate: w.startDate }
      : { mode: w.mode },
  );

const PlatformList = z
  .array(z.enum(PLATFORMS))
  .min(1, 'Pick at least one platform')
  .max(PLATFORMS.length)
  // Stable display order, no duplicates.
  .transform((list) => PLATFORMS.filter((p) => list.includes(p)) as Platform[]);

const BatchSettingsSchema = z.object({
  platforms: PlatformList,
  notes: z
    .string()
    .max(NOTES_MAX_CHARS)
    .transform((s) => s.trim()),
  when: WhenSchema,
});

// ---- Uploads ---------------------------------------------------------------------------------

/**
 * Creates the batch (or adds to `batchId`) and one asset per file, and returns a signed upload
 * target per file, in request order.
 */
export async function startUploads(
  files: Array<{ name: string; size: number; type: string }>,
  batch: BatchSettings,
  batchId?: string | null,
): Promise<ActionResult<{ batchId: string; items: StartedUpload[] }>> {
  return runAction('startUploads', async (deps) => {
    const parsedFiles = z
      .array(FileSchema)
      .min(1, 'Choose at least one video')
      .max(MAX_FILES_PER_CALL, `Up to ${MAX_FILES_PER_CALL} videos at a time`)
      .parse(files);
    const settings = BatchSettingsSchema.parse(batch);
    const existing = batchId ? Id.parse(batchId) : null;
    return createUploadBatch(deps, { files: parsedFiles, settings, batchId: existing });
  });
}

/** The browser finished the PUT: verify, create the post, queue processing. */
export async function completeUpload(
  assetId: string,
): Promise<ActionResult<{ postId: string; warning?: string }>> {
  return runAction('completeUpload', (deps) => completeAssetUpload(deps, Id.parse(assetId)));
}

/** A fresh signed URL for a file still uploading (the previous one expired). */
export async function renewUpload(
  assetId: string,
): Promise<ActionResult<{ upload: Omit<StartedUpload, 'index' | 'sortIndex'> }>> {
  return runAction('renewUpload', async (deps) => ({
    upload: await renewUploadTarget(deps, Id.parse(assetId)),
  }));
}

/** "Choose file again" on an interrupted upload. */
export async function restartUploadAction(
  assetId: string,
  file: { name: string; size: number; type: string },
): Promise<ActionResult<{ upload: Omit<StartedUpload, 'index' | 'sortIndex'> }>> {
  return runAction('restartUpload', async (deps) => ({
    upload: await restartUpload(deps, { assetId: Id.parse(assetId), file: FileSchema.parse(file) }),
  }));
}

/** Cancel / Remove for a video whose upload never finished. */
export async function removeUploadAction(assetId: string): Promise<ActionResult> {
  return runAction('removeUpload', async (deps) => {
    await removeUnfinishedUpload(deps, Id.parse(assetId));
    return {};
  });
}

/** "Retry" on a video whose processing failed. */
export async function retryProcessingAction(assetId: string): Promise<ActionResult> {
  return runAction('retryProcessing', async (deps) => {
    await retryAssetProcessing(deps, Id.parse(assetId));
    return {};
  });
}

// ---- Batch -------------------------------------------------------------------------------------

/** Polled every 3 s while something is processing. */
export async function getBatchCardsAction(
  batchId: string,
): Promise<ActionResult<{ view: BatchView }>> {
  return runAction('getBatchCards', async (deps) => {
    const view = await loadBatchView(deps, Id.parse(batchId));
    if (!view) throw new UserError('This batch no longer exists.', 'not_found');
    return { view };
  });
}

/** "Apply to all N". */
export async function applyToAllAction(input: {
  batchId: string;
  settings: BatchSettings;
  rewriteReady?: boolean;
}): Promise<ActionResult<{ result: ApplyResult }>> {
  return runAction('applyToAll', async (deps) => {
    const parsed = z
      .object({
        batchId: Id,
        settings: BatchSettingsSchema,
        rewriteReady: z.boolean().optional(),
      })
      .parse(input);
    return { result: await applyBatchSettings(deps, parsed) };
  });
}

/** Drag to reorder / the Order menu. */
export async function reorderAction(batchId: string, assetIds: string[]): Promise<ActionResult> {
  return runAction('reorder', async (deps) => {
    await reorderBatch(deps, {
      batchId: Id.parse(batchId),
      assetIds: z.array(Id).min(1).max(1000).parse(assetIds),
    });
    return {};
  });
}

/** The footer's "Schedule N videos". */
export async function scheduleBatchAction(input: {
  batchId: string;
  postIds: string[];
  when: WhenRule;
}): Promise<ActionResult<{ summary: ScheduleSummary }>> {
  return runAction('scheduleBatch', async (deps) => {
    const parsed = z
      .object({ batchId: Id, postIds: z.array(Id).min(1).max(1000), when: WhenSchema })
      .parse(input);
    return { summary: await scheduleBatch(deps, parsed) };
  });
}
