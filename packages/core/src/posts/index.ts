/**
 * Post queries shared by the Upload screen, the Calendar and the worker.
 * Server-only (uses the database).
 */
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import {
  mediaAssets,
  postTargets,
  posts,
  socialAccounts,
  type AppSettings,
  type Db,
  type MediaAsset,
  type Platform,
  type Post,
  type PostTarget,
  type TargetOptions,
} from '@app/db';
import { PLATFORM_ORDER } from '../platforms/rules';
import {
  attentionMessage,
  displayStatusFor,
  isOverdueDraft,
  summarizeStatuses,
  type DisplayStatus,
} from '../status';
import { validateTargetText, type TextIssue } from '../text';

/** Default per-target options for a platform, from settings. */
export function defaultTargetOptions(platform: Platform, settings: AppSettings): TargetOptions {
  if (platform === 'youtube') {
    const d = settings.youtubeDefaults;
    return {
      privacy: d.privacy,
      categoryId: d.categoryId,
      madeForKids: d.madeForKids,
      notifySubscribers: d.notifySubscribers,
      syntheticMedia: d.syntheticMedia,
      defaultLanguage: d.defaultLanguage,
    };
  }
  if (platform === 'instagram') return { shareToFeed: settings.instagramDefaults.shareToFeed };
  return {};
}

/**
 * Creates the post and one draft target per platform for a freshly uploaded asset.
 * Idempotent: calling it again adds missing platforms only.
 */
export async function createPostForAsset(
  db: Db,
  input: { assetId: string; batchId?: string | null; platforms: Platform[]; settings: AppSettings },
): Promise<{ post: Post; targets: PostTarget[] }> {
  return db.transaction(async (tx) => {
    let post = (await tx.select().from(posts).where(eq(posts.assetId, input.assetId)).limit(1))[0];
    if (!post) {
      post = (
        await tx
          .insert(posts)
          .values({ assetId: input.assetId, batchId: input.batchId ?? null })
          .returning()
      )[0]!;
    }
    const accounts = await tx.select().from(socialAccounts);
    for (const platform of input.platforms) {
      const account = accounts.find((a) => a.platform === platform && a.status !== 'disabled');
      await tx
        .insert(postTargets)
        .values({
          postId: post.id,
          platform,
          socialAccountId: account?.id ?? null,
          options: defaultTargetOptions(platform, input.settings),
        })
        .onConflictDoNothing({ target: [postTargets.postId, postTargets.platform] });
    }
    const targets = await tx.select().from(postTargets).where(eq(postTargets.postId, post.id));
    return { post, targets };
  });
}

export interface TargetCard {
  id: string;
  platform: Platform;
  status: PostTarget['status'];
  display: DisplayStatus;
  overdue: boolean;
  attention: string | null;
  note: string | null;
  scheduledAt: Date | null;
  publishMode: PostTarget['publishMode'];
  title: string;
  body: string;
  hashtags: string[];
  tags: string[];
  options: TargetOptions;
  textSources: PostTarget['textSources'];
  remoteUrl: string | null;
  publishedAt: Date | null;
  lastError: string | null;
  issues: TextIssue[];
  connected: boolean;
  version: number;
}

export interface PostCard {
  id: string;
  batchId: string | null;
  scheduledAt: Date | null;
  approvedAt: Date | null;
  display: DisplayStatus;
  asset: Pick<
    MediaAsset,
    | 'id'
    | 'filename'
    | 'status'
    | 'processingStep'
    | 'durationMs'
    | 'width'
    | 'height'
    | 'warnings'
    | 'transcript'
    | 'notes'
    | 'error'
    | 'coverFrameMs'
    | 'sizeBytes'
    | 'sortIndex'
    | 'createdAt'
  >;
  targets: TargetCard[];
  createdAt: Date;
}

export interface PostCardFilter {
  postIds?: string[];
  batchId?: string;
  /** Posts whose (post or any target) scheduled time is in [from, to). */
  from?: Date;
  to?: Date;
  /** Only posts with no scheduled time (drafts tray). */
  unscheduled?: boolean;
  limit?: number;
  order?: 'scheduled' | 'created' | 'sort';
}

function toTargetCard(t: PostTarget, asset: MediaAsset, now: Date): TargetCard {
  const display = displayStatusFor({
    assetStatus: asset.status,
    targetStatus: t.status,
    scheduledAt: t.scheduledAt,
  });
  return {
    id: t.id,
    platform: t.platform,
    status: t.status,
    display,
    overdue: isOverdueDraft(t.status, t.scheduledAt, now),
    attention:
      display === 'needs_attention'
        ? attentionMessage(
            asset.status === 'failed'
              ? 'processing_failed'
              : t.status === 'needs_reauth'
                ? 'reconnect'
                : t.attentionReason,
            t.platform,
          )
        : null,
    note: t.note,
    scheduledAt: t.scheduledAt,
    publishMode: t.publishMode,
    title: t.title,
    body: t.body,
    hashtags: t.hashtags,
    tags: t.tags,
    options: t.options,
    textSources: t.textSources,
    remoteUrl: t.remoteUrl,
    publishedAt: t.publishedAt,
    lastError: t.lastError,
    issues: validateTargetText(t.platform, t, { fbKind: t.options.fbKind }),
    connected: Boolean(t.socialAccountId),
    version: t.version,
  };
}

export async function getPostCards(
  db: Db,
  filter: PostCardFilter = {},
  now = new Date(),
): Promise<PostCard[]> {
  const where: SQL[] = [isNull(posts.deletedAt)];
  if (filter.postIds?.length) where.push(inArray(posts.id, filter.postIds));
  if (filter.batchId) where.push(eq(posts.batchId, filter.batchId));
  if (filter.unscheduled) where.push(isNull(posts.scheduledAt));
  if (filter.from && filter.to) {
    const inRange = and(gte(posts.scheduledAt, filter.from), lt(posts.scheduledAt, filter.to));
    const targetInRange = sql`exists (select 1 from ${postTargets} pt where pt.post_id = ${posts.id} and pt.scheduled_at >= ${filter.from} and pt.scheduled_at < ${filter.to})`;
    where.push(or(inRange, targetInRange)!);
  }
  const orderBy =
    filter.order === 'created'
      ? [desc(posts.createdAt)]
      : filter.order === 'sort'
        ? [asc(mediaAssets.sortIndex), asc(mediaAssets.createdAt)]
        : [asc(posts.scheduledAt), asc(posts.createdAt)];

  const rows = await db
    .select({ post: posts, asset: mediaAssets })
    .from(posts)
    .innerJoin(mediaAssets, eq(mediaAssets.id, posts.assetId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(...orderBy)
    .limit(filter.limit ?? 500);
  if (rows.length === 0) return [];

  const targets = await db
    .select()
    .from(postTargets)
    .where(
      and(
        inArray(
          postTargets.postId,
          rows.map((r) => r.post.id),
        ),
        sql`${postTargets.status} <> 'canceled'`,
      ),
    );

  return rows.map(({ post, asset }) => {
    const ts = targets
      .filter((t) => t.postId === post.id)
      .sort((a, b) => PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform))
      .map((t) => toTargetCard(t, asset, now));
    return {
      id: post.id,
      batchId: post.batchId,
      scheduledAt: post.scheduledAt,
      approvedAt: post.approvedAt,
      display: ts.length
        ? summarizeStatuses(ts.map((t) => t.display))
        : asset.status === 'ready'
          ? 'draft'
          : asset.status === 'failed'
            ? 'needs_attention'
            : 'processing',
      asset: {
        id: asset.id,
        filename: asset.filename,
        status: asset.status,
        processingStep: asset.processingStep,
        durationMs: asset.durationMs,
        width: asset.width,
        height: asset.height,
        warnings: asset.warnings,
        transcript: asset.transcript,
        notes: asset.notes,
        error: asset.error,
        coverFrameMs: asset.coverFrameMs,
        sizeBytes: asset.sizeBytes,
        sortIndex: asset.sortIndex,
        createdAt: asset.createdAt,
      },
      targets: ts,
      createdAt: post.createdAt,
    };
  });
}

export async function getPostCard(db: Db, postId: string): Promise<PostCard | undefined> {
  return (await getPostCards(db, { postIds: [postId] }))[0];
}

/** Targets that need the owner's attention (Calendar banner). */
export async function getAttentionTargets(db: Db) {
  return db
    .select({ target: postTargets, asset: mediaAssets })
    .from(postTargets)
    .innerJoin(posts, eq(posts.id, postTargets.postId))
    .innerJoin(mediaAssets, eq(mediaAssets.id, posts.assetId))
    .where(
      and(
        inArray(postTargets.status, ['failed', 'missed', 'needs_reauth']),
        isNull(posts.deletedAt),
      ),
    )
    .orderBy(asc(postTargets.scheduledAt))
    .limit(50);
}
