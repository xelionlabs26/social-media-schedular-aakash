/**
 * Server-side loader for the Calendar screen: turns PostCards into lean view models, signs
 * thumbnail URLs and collects the needs-attention list. Server-only (database + storage).
 */
import { asc, inArray } from 'drizzle-orm';
import { mediaFrames, postingSlots, type Db, type PostTarget } from '@app/db';
import type { ServiceDeps } from '@app/core/deps';
import { getAttentionTargets, getPostCards, type PostCard } from '@app/core/posts';
import { getSettings } from '@app/core/settings';
import { PROCESSING_STEP_LABEL, attentionMessage } from '@app/core/status';
import { toLocalParts, tzAbbrev } from '@app/core/time';
import { todayIn, utcRangeFor, type CalendarView } from './calendar-math';
import { matchesFilter, matchesQuery } from './list-filter';
import type { AttentionItem, CalendarData, CalendarPost, ListFilter, SlotView } from './types';

const LIST_LIMIT = 500;
const DRAFTS_LIMIT = 100;
const THUMB_URL_TTL_SEC = 2 * 60 * 60;

/** Post time, or the earliest platform time when only targets carry one. */
function effectiveTime(card: PostCard): Date | null {
  if (card.scheduledAt) return card.scheduledAt;
  const times = card.targets
    .map((t) => t.scheduledAt)
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => a.getTime() - b.getTime());
  return times[0] ?? null;
}

function firstLine(text: string): string {
  return (text.split('\n').find((l) => l.trim() !== '') ?? '').trim().slice(0, 140);
}

function snippetOf(card: PostCard): string {
  const yt = card.targets.find((t) => t.platform === 'youtube');
  if (yt?.title) return yt.title.slice(0, 140);
  for (const t of card.targets) {
    const line = firstLine(t.body);
    if (line) return line;
  }
  return '';
}

function isMovable(card: PostCard): boolean {
  if (card.targets.some((t) => t.status === 'publishing')) return false;
  if (card.targets.length > 0 && card.targets.every((t) => t.status === 'published')) return false;
  return true;
}

export function toCalendarPost(card: PostCard, tz: string, thumbUrl: string | null): CalendarPost {
  const at = effectiveTime(card);
  const local = at ? toLocalParts(at, tz) : null;
  return {
    id: card.id,
    filename: card.asset.filename,
    thumbUrl,
    scheduledAt: at?.toISOString() ?? null,
    localDate: local?.date ?? null,
    localTime: local?.time ?? null,
    display: card.display,
    overdue: card.targets.some((t) => t.overdue),
    processingLabel:
      card.asset.status === 'processing' && card.asset.processingStep
        ? PROCESSING_STEP_LABEL[card.asset.processingStep]
        : card.asset.status === 'uploading'
          ? 'Uploading'
          : null,
    snippet: snippetOf(card),
    durationMs: card.asset.durationMs,
    createdAt: card.createdAt.toISOString(),
    movable: isMovable(card),
    targets: card.targets.map((t) => ({
      id: t.id,
      platform: t.platform,
      status: t.status,
      display: t.display,
      overdue: t.overdue,
      attention: t.attention,
      scheduledAt: t.scheduledAt?.toISOString() ?? null,
      remoteUrl: t.remoteUrl,
    })),
  };
}

/** Signed URL of each asset's first AI frame (lowest idx). Missing/unsignable = no thumbnail. */
async function thumbnailUrls(deps: ServiceDeps, assetIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (assetIds.length === 0) return out;
  const frames = await deps.db
    .selectDistinctOn([mediaFrames.assetId], { assetId: mediaFrames.assetId, key: mediaFrames.key })
    .from(mediaFrames)
    .where(inArray(mediaFrames.assetId, assetIds))
    .orderBy(mediaFrames.assetId, asc(mediaFrames.idx));
  await Promise.all(
    frames.map(async (f) => {
      try {
        out.set(
          f.assetId,
          await deps.storage.getReadUrl(f.key, { expiresInSec: THUMB_URL_TTL_SEC }),
        );
      } catch (e) {
        deps.log.warn('calendar: thumbnail url failed', { assetId: f.assetId, error: e });
      }
    }),
  );
  return out;
}

async function toPosts(deps: ServiceDeps, cards: PostCard[], tz: string) {
  const thumbs = await thumbnailUrls(
    deps,
    cards.map((c) => c.asset.id),
  );
  return cards.map((c) => toCalendarPost(c, tz, thumbs.get(c.asset.id) ?? null));
}

function attentionReasonFor(t: PostTarget) {
  if (t.status === 'needs_reauth') return 'reconnect' as const;
  if (t.status === 'missed') return t.attentionReason ?? ('missed' as const);
  return t.attentionReason;
}

export async function loadAttention(db: Db): Promise<AttentionItem[]> {
  const rows = await getAttentionTargets(db);
  return rows.map(({ target, asset }) => {
    const reason = attentionReasonFor(target);
    return {
      targetId: target.id,
      postId: target.postId,
      platform: target.platform,
      filename: asset.filename,
      message: attentionMessage(reason, target.platform),
      lastError: target.lastError ? target.lastError.slice(0, 200) : null,
      scheduledAt: target.scheduledAt?.toISOString() ?? null,
      reconnect: reason === 'reconnect' || reason === 'not_connected',
    };
  });
}

export async function loadSlots(db: Db): Promise<SlotView[]> {
  const rows = await db
    .select({ weekday: postingSlots.weekday, time: postingSlots.time })
    .from(postingSlots)
    .orderBy(asc(postingSlots.weekday), asc(postingSlots.time));
  return rows;
}

export async function loadCalendarData(
  deps: ServiceDeps,
  input: { view: CalendarView; date: string | null; filter: ListFilter | null; query: string },
): Promise<CalendarData> {
  const { db } = deps;
  const settings = await getSettings(db);
  const tz = settings.timezone;
  const now = deps.now();
  const today = todayIn(tz, now);
  const date = input.date ?? today;

  let posts: CalendarPost[] = [];
  let drafts: CalendarPost[] = [];
  let truncated = false;

  if (input.view === 'list') {
    const cards = await getPostCards(db, { order: 'created', limit: LIST_LIMIT }, now);
    truncated = cards.length >= LIST_LIMIT;
    const searched = cards.filter((c) =>
      matchesQuery({ filename: c.asset.filename, targets: c.targets }, input.query),
    );
    posts = (await toPosts(deps, searched, tz)).filter((p) => matchesFilter(p, input.filter));
  } else {
    const range = utcRangeFor(input.view, date, tz)!;
    const [inRange, unscheduled] = await Promise.all([
      getPostCards(db, { from: range.from, to: range.to }, now),
      getPostCards(db, { unscheduled: true, order: 'created', limit: DRAFTS_LIMIT }, now),
    ]);
    // A post without its own time but with per-platform times is on the calendar, not a draft.
    const trayCards = unscheduled.filter((c) => c.targets.every((t) => !t.scheduledAt));
    const all = await toPosts(deps, [...inRange, ...trayCards], tz);
    posts = all.slice(0, inRange.length);
    drafts = all.slice(inRange.length);
  }

  const [attention, slots] = await Promise.all([loadAttention(db), loadSlots(db)]);

  return {
    view: input.view,
    date,
    today,
    timezone: tz,
    tzLabel: tzAbbrev(tz),
    nowIso: now.toISOString(),
    posts,
    drafts,
    attention,
    slots,
    filter: input.filter,
    query: input.query,
    truncated,
  };
}
