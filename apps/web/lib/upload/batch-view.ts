/**
 * Read side of the Upload screen: page data, the batch's cards, account connection states.
 * Server-only (database + storage).
 */
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import {
  batches,
  mediaAssets,
  mediaFrames,
  posts,
  socialAccounts,
  type Db,
  type Platform,
} from '@app/db';
import type { ServiceDeps } from '@app/core/deps';
import { getPostCards } from '@app/core/posts';
import { getSettings } from '@app/core/settings';
import { PLATFORM_ORDER } from '@app/core/platforms';
import type { Storage } from '@app/core/storage';
import { todayInTz } from './time';
import type { AccountsByPlatform, BatchItem, BatchView, UploadPageData } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Thumbnails and the editor's video stay valid long enough for a long editing session. */
export const READ_URL_TTL_SEC = 2 * 3600;

/**
 * Makes a signed URL usable from the browser. Local-driver URLs are built from APP_URL, which
 * may not match the address the owner opened (e.g. a forwarded Codespaces port), so they are
 * turned into same-origin paths. S3/R2 URLs are already absolute and public.
 */
export function browserUrl(url: string, storage: Pick<Storage, 'driver'>, appUrl: string): string {
  if (storage.driver !== 'local') return url;
  const base = appUrl.replace(/\/+$/, '');
  return url.startsWith(`${base}/`) ? url.slice(base.length) : url;
}

export async function signedReadUrl(
  deps: Pick<ServiceDeps, 'storage' | 'env'>,
  key: string,
): Promise<string> {
  const url = await deps.storage.getReadUrl(key, { expiresInSec: READ_URL_TTL_SEC });
  return browserUrl(url, deps.storage, deps.env.APP_URL);
}

/** Connection state per platform ("not connected" hints on the batch bar and editor). */
export async function loadAccounts(db: Db): Promise<AccountsByPlatform> {
  const rows = await db
    .select({
      platform: socialAccounts.platform,
      status: socialAccounts.status,
      displayName: socialAccounts.displayName,
    })
    .from(socialAccounts)
    .where(ne(socialAccounts.status, 'disabled'));
  const out = {} as AccountsByPlatform;
  for (const p of PLATFORM_ORDER) {
    const mine = rows.filter((r) => r.platform === p);
    const active = mine.find((r) => r.status === 'active');
    if (active) out[p] = { state: 'connected', name: active.displayName || null };
    else if (mine.length) out[p] = { state: 'needs_reauth', name: mine[0]!.displayName || null };
    else out[p] = { state: 'not_connected', name: null };
  }
  return out;
}

/** First AI frame per asset (the "hook" frame), as signed URLs. */
async function loadThumbs(deps: ServiceDeps, assetIds: string[]): Promise<Map<string, string>> {
  const thumbs = new Map<string, string>();
  if (assetIds.length === 0) return thumbs;
  const frames = await deps.db
    .selectDistinctOn([mediaFrames.assetId], { assetId: mediaFrames.assetId, key: mediaFrames.key })
    .from(mediaFrames)
    .where(inArray(mediaFrames.assetId, assetIds))
    .orderBy(mediaFrames.assetId, asc(mediaFrames.idx));
  await Promise.all(
    frames.map(async (f) => {
      try {
        thumbs.set(f.assetId, await signedReadUrl(deps, f.key));
      } catch (err) {
        deps.log.warn('Could not sign thumbnail URL', { assetId: f.assetId, err });
      }
    }),
  );
  return thumbs;
}

/** Every card of a batch, in the owner's order. null when the batch doesn't exist. */
export async function loadBatchView(deps: ServiceDeps, batchId: string): Promise<BatchView | null> {
  if (!isUuid(batchId)) return null;
  const { db } = deps;
  const batch = (await db.select().from(batches).where(eq(batches.id, batchId)).limit(1))[0];
  if (!batch) return null;

  const assets = await db
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.batchId, batchId))
    .orderBy(asc(mediaAssets.sortIndex), asc(mediaAssets.createdAt));
  const assetIds = assets.map((a) => a.id);

  const postRows = assetIds.length
    ? await db
        .select({ id: posts.id, assetId: posts.assetId, deletedAt: posts.deletedAt })
        .from(posts)
        .where(inArray(posts.assetId, assetIds))
    : [];
  const deleted = new Set(postRows.filter((p) => p.deletedAt).map((p) => p.assetId));
  const livePostIds = postRows.filter((p) => !p.deletedAt).map((p) => p.id);

  const [cards, thumbs] = await Promise.all([
    livePostIds.length
      ? getPostCards(db, { postIds: livePostIds, order: 'sort' }, deps.now())
      : Promise.resolve([]),
    loadThumbs(deps, assetIds),
  ]);
  const cardByAsset = new Map(cards.map((c) => [c.asset.id, c]));

  const items: BatchItem[] = assets
    .filter((a) => !deleted.has(a.id))
    .map((a) => ({
      assetId: a.id,
      filename: a.filename,
      sizeBytes: a.sizeBytes,
      assetStatus: a.status,
      sortIndex: a.sortIndex,
      createdAt: a.createdAt,
      notes: a.notes,
      thumbUrl: thumbs.get(a.id) ?? null,
      post: cardByAsset.get(a.id) ?? null,
    }));

  return {
    batch: {
      id: batch.id,
      settings: {
        platforms: batch.platforms,
        notes: batch.notes,
        when: batch.slotRule ?? { mode: 'next_free' },
      },
    },
    items,
  };
}

export async function loadUploadPageData(
  deps: ServiceDeps,
  batchId: string | null | undefined,
): Promise<UploadPageData> {
  const settings = await getSettings(deps.db);
  const [accounts, view] = await Promise.all([
    loadAccounts(deps.db),
    batchId ? loadBatchView(deps, batchId) : Promise.resolve(null),
  ]);
  const defaults = settings.defaultPlatforms.filter((p): p is Platform =>
    PLATFORM_ORDER.includes(p),
  );
  return {
    timezone: settings.timezone,
    today: todayInTz(settings.timezone, deps.now()),
    defaultPlatforms: defaults.length ? defaults : [...PLATFORM_ORDER],
    accounts,
    view,
  };
}

/** The post id of an asset, if it has a live (not deleted) post. */
export async function livePostIdForAsset(db: Db, assetId: string): Promise<string | null> {
  const row = (
    await db
      .select({ id: posts.id })
      .from(posts)
      .where(and(eq(posts.assetId, assetId), isNull(posts.deletedAt)))
      .limit(1)
  )[0];
  return row?.id ?? null;
}
