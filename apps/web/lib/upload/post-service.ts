/**
 * Server side of the post editor drawer: loading a post, transcript/notes, adding a platform,
 * dated drafts, history and the AI refine round-trip. Server-only, deps passed explicitly.
 */
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import {
  mediaAssets,
  postTargets,
  posts,
  publishAttempts,
  type Platform,
  type TargetOptions,
} from '@app/db';
import type { ServiceDeps } from '@app/core/deps';
import { createPostForAsset, getPostCard } from '@app/core/posts';
import { getSettings } from '@app/core/settings';
import { RULES } from '@app/core/platforms';
import type { RefineAction, RefineField } from '@app/core/ai';
import { loadAccounts, signedReadUrl } from './batch-view';
import { UserError } from './errors';
import { queueTextGeneration } from './service';
import type { EditorData, HistoryEntry } from './types';

async function getLivePost(deps: ServiceDeps, postId: string) {
  const post = (
    await deps.db
      .select()
      .from(posts)
      .where(and(eq(posts.id, postId), isNull(posts.deletedAt)))
      .limit(1)
  )[0];
  if (!post) throw new UserError('This post no longer exists.', 'not_found');
  return post;
}

/** Everything the editor needs for one post. */
export async function loadEditorData(deps: ServiceDeps, postId: string): Promise<EditorData> {
  const card = await getPostCard(deps.db, postId);
  if (!card) throw new UserError('This post no longer exists.', 'not_found');
  const [asset] = await deps.db
    .select({
      masterKey: mediaAssets.masterKey,
      originalKey: mediaAssets.originalKey,
      status: mediaAssets.status,
      transcriptEdited: mediaAssets.transcriptEdited,
      purgedAt: mediaAssets.purgedAt,
    })
    .from(mediaAssets)
    .where(eq(mediaAssets.id, card.asset.id))
    .limit(1);
  const settings = await getSettings(deps.db);

  let videoUrl: string | null = null;
  let videoSource: EditorData['videoSource'] = null;
  if (asset && !asset.purgedAt && asset.status !== 'uploading') {
    // Prefer the platform-safe master (plays everywhere); the original until it exists.
    const key = asset.masterKey ?? asset.originalKey;
    try {
      videoUrl = await signedReadUrl(deps, key);
      videoSource = asset.masterKey ? 'master' : 'original';
    } catch (err) {
      deps.log.warn('Could not sign video URL', { postId, err });
    }
  }

  const counts = settings.hashtagCounts;
  return {
    card,
    timezone: settings.timezone,
    videoUrl,
    videoSource,
    transcriptEdited: asset?.transcriptEdited ?? false,
    hashtagMax: {
      instagram: Math.min(
        counts.instagram?.max ?? RULES.instagram.hashtagsMax,
        RULES.instagram.hashtagsMax,
      ),
      youtube: counts.youtube?.max ?? 3,
      facebook: counts.facebook?.max ?? 0,
    },
    accounts: await loadAccounts(deps.db),
  };
}

/** Saves the transcript and/or notes. A changed transcript is marked as edited by the owner. */
export async function saveAssetTexts(
  deps: ServiceDeps,
  input: { postId: string; transcript?: string; notes?: string },
): Promise<void> {
  const post = await getLivePost(deps, input.postId);
  const [asset] = await deps.db
    .select({ transcript: mediaAssets.transcript, notes: mediaAssets.notes })
    .from(mediaAssets)
    .where(eq(mediaAssets.id, post.assetId))
    .limit(1);
  if (!asset) throw new UserError('This video no longer exists.', 'not_found');
  const patch: Partial<typeof mediaAssets.$inferInsert> = {};
  if (input.transcript !== undefined && input.transcript !== (asset.transcript ?? '')) {
    patch.transcript = input.transcript;
    patch.transcriptEdited = true;
  }
  if (input.notes !== undefined && input.notes !== asset.notes) patch.notes = input.notes;
  if (Object.keys(patch).length === 0) return;
  await deps.db.update(mediaAssets).set(patch).where(eq(mediaAssets.id, post.assetId));
}

/** "Rewrite all texts": save transcript/notes, then let the AI rewrite every non-manual field. */
export async function rewriteAllTexts(
  deps: ServiceDeps,
  input: { postId: string; transcript?: string; notes?: string },
): Promise<void> {
  await saveAssetTexts(deps, input);
  const post = await getLivePost(deps, input.postId);
  const [asset] = await deps.db
    .select({ status: mediaAssets.status })
    .from(mediaAssets)
    .where(eq(mediaAssets.id, post.assetId))
    .limit(1);
  if (asset?.status === 'processing' || asset?.status === 'uploaded') {
    throw new UserError('The AI is already writing this video’s texts. Your changes are saved.');
  }
  if (asset?.status !== 'ready') {
    throw new UserError('This video could not be processed, so the AI cannot write its texts.');
  }
  await queueTextGeneration(deps, post.assetId);
}

/** "+ add platform": a draft target for a platform the post doesn't have; the AI writes it. */
export async function addPlatformToPost(
  deps: ServiceDeps,
  input: { postId: string; platform: Platform },
): Promise<{ warning?: string }> {
  const post = await getLivePost(deps, input.postId);
  const existing = await deps.db
    .select({ id: postTargets.id, status: postTargets.status })
    .from(postTargets)
    .where(and(eq(postTargets.postId, post.id), eq(postTargets.platform, input.platform)));
  if (existing.some((t) => t.status !== 'canceled')) return {};
  if (existing.length) {
    // A canceled target would block the new one (unique post+platform).
    await deps.db.delete(postTargets).where(
      inArray(
        postTargets.id,
        existing.map((t) => t.id),
      ),
    );
  }
  const settings = await getSettings(deps.db);
  await createPostForAsset(deps.db, {
    assetId: post.assetId,
    batchId: post.batchId,
    platforms: [input.platform],
    settings,
  });
  try {
    await queueTextGeneration(deps, post.assetId, [input.platform]);
  } catch (err) {
    return { warning: err instanceof Error ? err.message : 'Could not start the AI.' };
  }
  return {};
}

/**
 * Dated draft: stores the picked time on draft targets without scheduling anything (the owner
 * schedules later with the footer button or "Save & schedule"). Targets past the draft stage
 * are not touched; their time changes only through scheduling.
 */
export async function setDraftTimes(
  deps: ServiceDeps,
  input: {
    postId: string;
    at: Date | null;
    perPlatformAt?: Partial<Record<Platform, Date | null>>;
  },
): Promise<void> {
  const post = await getLivePost(deps, input.postId);
  const targets = await deps.db
    .select({ id: postTargets.id, platform: postTargets.platform, status: postTargets.status })
    .from(postTargets)
    .where(and(eq(postTargets.postId, post.id), ne(postTargets.status, 'canceled')));
  const drafts = targets.filter((t) => t.status === 'draft');
  if (drafts.length === 0) {
    throw new UserError('This post is already scheduled. Use “Save & schedule” to change it.');
  }
  const timeFor = (p: Platform) =>
    input.perPlatformAt && p in input.perPlatformAt ? (input.perPlatformAt[p] ?? null) : input.at;

  await deps.db.transaction(async (tx) => {
    for (const t of drafts) {
      await tx
        .update(postTargets)
        .set({ scheduledAt: timeFor(t.platform) })
        .where(and(eq(postTargets.id, t.id), eq(postTargets.status, 'draft')));
    }
    if (drafts.length === targets.length) {
      const times = drafts.map((t) => timeFor(t.platform)).filter((d): d is Date => d !== null);
      const postAt = input.perPlatformAt
        ? times.length
          ? new Date(Math.min(...times.map((d) => d.getTime())))
          : null
        : input.at;
      await tx.update(posts).set({ scheduledAt: postAt }).where(eq(posts.id, post.id));
    }
  });
}

/** History section: every attempt for the post's targets, newest first. */
export async function loadPostHistory(
  deps: ServiceDeps,
  postId: string,
  limit = 100,
): Promise<HistoryEntry[]> {
  const rows = await deps.db
    .select({ attempt: publishAttempts, platform: postTargets.platform })
    .from(publishAttempts)
    .innerJoin(postTargets, eq(postTargets.id, publishAttempts.targetId))
    .where(eq(postTargets.postId, postId))
    .orderBy(desc(publishAttempts.startedAt))
    .limit(limit);
  // responseExcerpt is never sent to the browser: platform responses can echo identifiers.
  return rows.map(({ attempt: a, platform }) => ({
    id: a.id,
    at: a.startedAt,
    platform,
    attemptNo: a.attemptNo,
    step: a.step,
    outcome: a.outcome,
    httpStatus: a.httpStatus,
    platformCode: a.platformCode,
    message: a.message ? Array.from(a.message).slice(0, 300).join('') : null,
  }));
}

export interface TextPatch {
  title?: string;
  body?: string;
  hashtags?: string[];
  tags?: string[];
  options?: TargetOptions;
}

export interface EditorServices {
  refineField: (
    deps: ServiceDeps,
    input: { targetId: string; field: RefineField; action: RefineAction },
  ) => Promise<{ title?: string; body?: string; hashtags?: string[]; tags?: string[] }>;
  updateTargetText: (
    deps: ServiceDeps,
    input: { targetId: string; patch: TextPatch; expectedVersion?: number },
  ) => Promise<{ version: number }>;
}

/** Regenerate / ⋯ menu: ask the AI for one field, then save it like an edit. */
export async function refineAndSave(
  deps: ServiceDeps,
  services: EditorServices,
  input: { targetId: string; field: RefineField; action: RefineAction; expectedVersion?: number },
): Promise<{ patch: TextPatch; version: number }> {
  const out = await services.refineField(deps, {
    targetId: input.targetId,
    field: input.field,
    action: input.action,
  });
  const value = out[input.field];
  if (value === undefined) throw new UserError('The AI returned nothing for this field.');
  const patch: TextPatch = { [input.field]: value };
  const { version } = await services.updateTargetText(deps, {
    targetId: input.targetId,
    patch,
    ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
  });
  return { patch, version };
}
