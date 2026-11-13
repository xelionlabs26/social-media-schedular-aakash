'use server';

/**
 * Server actions for the post editor drawer (also used by the Calendar). Each one:
 * requireOwner() first (runAction), zod-checked input, `{ ok: false, error }` instead of
 * throwing. Text and schedule changes go through core/scheduling so targets already handed to a
 * platform are kept in sync by the engine.
 */
import { z } from 'zod';
import { PLATFORMS, type Platform } from '@app/db';
import { refineField } from '@app/core/ai';
import { normalizeHashtags } from '@app/core/text';
import {
  deletePost,
  moveToDrafts,
  schedulePosts,
  updateTargetText,
  type ScheduleRequest,
} from '@app/core/scheduling';
import { runAction } from '@/lib/upload/action-runner';
import { NOTES_MAX_CHARS, TRANSCRIPT_MAX_CHARS } from '@/lib/upload/constants';
import { cleanTags } from '@/lib/upload/fields';
import {
  addPlatformToPost,
  loadEditorData,
  loadPostHistory,
  refineAndSave,
  rewriteAllTexts,
  saveAssetTexts,
  setDraftTimes,
  type TextPatch,
} from '@/lib/upload/post-service';
import type { ActionResult, EditorData, HistoryEntry, ScheduleSummary } from '@/lib/upload/types';
import { getPostCard } from '@app/core/posts';

const Id = z.uuid();
const PlatformSchema = z.enum(PLATFORMS);
const IsoInstant = z.iso.datetime({ offset: true });

const OptionsSchema = z
  .object({
    privacy: z.enum(['public', 'unlisted', 'private']).optional(),
    categoryId: z.string().max(10).optional(),
    madeForKids: z.boolean().optional(),
    notifySubscribers: z.boolean().optional(),
    syntheticMedia: z.boolean().optional(),
    defaultLanguage: z.string().max(20).optional(),
    shareToFeed: z.boolean().optional(),
    thumbOffsetMs: z.number().int().min(0).optional(),
    fbKind: z.enum(['reel', 'video']).optional(),
  })
  .strict();

/**
 * Hard caps only stop abuse. Platform limits are *not* enforced here: an over-limit draft must
 * still save (the editor shows it in red and scheduling refuses it), or the owner loses text.
 */
const PatchSchema = z
  .object({
    title: z.string().max(2_000).optional(),
    body: z.string().max(30_000).optional(),
    hashtags: z.array(z.string().max(200)).max(60).optional(),
    tags: z.array(z.string().max(200)).max(200).optional(),
    options: OptionsSchema.optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'Nothing to save')
  .transform((p): TextPatch => {
    const out: TextPatch = { ...p };
    if (p.hashtags) out.hashtags = normalizeHashtags(p.hashtags);
    if (p.tags) out.tags = cleanTags(p.tags);
    return out;
  });

const PerPlatformTimes = z
  .object({
    instagram: IsoInstant.nullable().optional(),
    youtube: IsoInstant.nullable().optional(),
    facebook: IsoInstant.nullable().optional(),
  })
  .strict();

function toDates(
  per: z.infer<typeof PerPlatformTimes> | undefined,
): Partial<Record<Platform, Date | null>> | undefined {
  if (!per) return undefined;
  const out: Partial<Record<Platform, Date | null>> = {};
  for (const p of PLATFORMS) {
    const v = per[p];
    if (v !== undefined) out[p] = v === null ? null : new Date(v);
  }
  return out;
}

// ---- Load ----------------------------------------------------------------------------------------

/** The editor's data: PostCard, signed video URL, time zone, limits, accounts. */
export async function getPostCardAction(
  postId: string,
): Promise<ActionResult<{ data: EditorData }>> {
  return runAction('getPostCard', async (deps) => ({
    data: await loadEditorData(deps, Id.parse(postId)),
  }));
}

/** History section (lazy): publish attempts, newest first. */
export async function getPostHistoryAction(
  postId: string,
): Promise<ActionResult<{ entries: HistoryEntry[] }>> {
  return runAction('getPostHistory', async (deps) => ({
    entries: await loadPostHistory(deps, Id.parse(postId)),
  }));
}

// ---- Text ----------------------------------------------------------------------------------------

/** Autosave of one target's text/options (optimistic concurrency with expectedVersion). */
export async function saveTargetText(input: {
  targetId: string;
  patch: TextPatch;
  expectedVersion?: number;
}): Promise<ActionResult<{ version: number }>> {
  return runAction('saveTargetText', async (deps) => {
    const parsed = z
      .object({
        targetId: Id,
        patch: PatchSchema,
        expectedVersion: z.number().int().min(0).optional(),
      })
      .parse(input);
    return updateTargetText(deps, parsed);
  });
}

/** Regenerate / ⋯ menu: the AI rewrites one field, which is then saved like an edit. */
export async function refineFieldAction(input: {
  targetId: string;
  field: 'title' | 'body' | 'hashtags' | 'tags';
  action: 'regenerate' | 'shorter' | 'longer' | 'casual' | 'formal' | 'viral';
  expectedVersion?: number;
}): Promise<ActionResult<{ patch: TextPatch; version: number }>> {
  return runAction('refineField', async (deps) => {
    const parsed = z
      .object({
        targetId: Id,
        field: z.enum(['title', 'body', 'hashtags', 'tags']),
        action: z.enum(['regenerate', 'shorter', 'longer', 'casual', 'formal', 'viral']),
        expectedVersion: z.number().int().min(0).optional(),
      })
      .parse(input);
    return refineAndSave(deps, { refineField, updateTargetText }, parsed);
  });
}

/** Saves the transcript and/or notes (transcript edits are marked transcriptEdited). */
export async function saveAssetTextAction(input: {
  postId: string;
  transcript?: string;
  notes?: string;
}): Promise<ActionResult> {
  return runAction('saveAssetText', async (deps) => {
    const parsed = z
      .object({
        postId: Id,
        transcript: z.string().max(TRANSCRIPT_MAX_CHARS).optional(),
        notes: z.string().max(NOTES_MAX_CHARS).optional(),
      })
      .parse(input);
    await saveAssetTexts(deps, parsed);
    return {};
  });
}

/** "Rewrite all texts" after transcript/notes changes. */
export async function rewriteAllTextsAction(input: {
  postId: string;
  transcript?: string;
  notes?: string;
}): Promise<ActionResult> {
  return runAction('rewriteAllTexts', async (deps) => {
    const parsed = z
      .object({
        postId: Id,
        transcript: z.string().max(TRANSCRIPT_MAX_CHARS).optional(),
        notes: z.string().max(NOTES_MAX_CHARS).optional(),
      })
      .parse(input);
    await rewriteAllTexts(deps, parsed);
    return {};
  });
}

/** "+ add platform". */
export async function addPlatformAction(input: {
  postId: string;
  platform: Platform;
}): Promise<ActionResult<{ warning?: string }>> {
  return runAction('addPlatform', async (deps) => {
    const parsed = z.object({ postId: Id, platform: PlatformSchema }).parse(input);
    return addPlatformToPost(deps, parsed);
  });
}

// ---- Time & schedule -----------------------------------------------------------------------------

/** Dated draft (card time picker / editor When while the post is a draft). */
export async function setDraftTimeAction(input: {
  postId: string;
  at: string | null;
  perPlatformAt?: Partial<Record<Platform, string | null>>;
}): Promise<ActionResult> {
  return runAction('setDraftTime', async (deps) => {
    const parsed = z
      .object({ postId: Id, at: IsoInstant.nullable(), perPlatformAt: PerPlatformTimes.optional() })
      .parse(input);
    await setDraftTimes(deps, {
      postId: parsed.postId,
      at: parsed.at ? new Date(parsed.at) : null,
      perPlatformAt: toDates(parsed.perPlatformAt),
    });
    return {};
  });
}

/** "Save & schedule": the chosen time ('pick'), or the next free slot when none is set. */
export async function schedulePostAction(input: {
  postId: string;
  at?: string | null;
  perPlatformAt?: Partial<Record<Platform, string | null>>;
}): Promise<ActionResult<{ summary: ScheduleSummary }>> {
  return runAction('schedulePost', async (deps) => {
    const parsed = z
      .object({
        postId: Id,
        at: IsoInstant.nullable().optional(),
        perPlatformAt: PerPlatformTimes.optional(),
      })
      .parse(input);
    const perPlatform = Object.fromEntries(
      Object.entries(toDates(parsed.perPlatformAt) ?? {}).filter(([, v]) => v instanceof Date),
    ) as Partial<Record<Platform, Date>>;
    const times = Object.values(perPlatform).map((d) => d.getTime());
    const at = parsed.at
      ? new Date(parsed.at)
      : times.length
        ? new Date(Math.min(...times))
        : undefined;
    const req: ScheduleRequest = at
      ? {
          postIds: [parsed.postId],
          mode: 'pick',
          at,
          ...(times.length ? { perPlatformAt: perPlatform } : {}),
        }
      : { postIds: [parsed.postId], mode: 'next_free' };
    const res = await schedulePosts(deps, req);
    const filename = (await getPostCard(deps.db, parsed.postId))?.asset.filename ?? 'video';
    return {
      summary: {
        scheduled: res.scheduled.map((s) => ({ ...s, filename })),
        skipped: res.skipped.map((s) => ({ ...s, filename })),
        warnings: res.warnings,
      },
    };
  });
}

/** "Move to drafts". */
export async function moveToDraftsAction(postId: string): Promise<ActionResult> {
  return runAction('moveToDrafts', async (deps) => {
    await moveToDrafts(deps, { postId: Id.parse(postId) });
    return {};
  });
}

/** "Delete" (after the confirm dialog). */
export async function deletePostAction(postId: string): Promise<ActionResult> {
  return runAction('deletePost', async (deps) => {
    await deletePost(deps, { postId: Id.parse(postId) });
    return {};
  });
}
