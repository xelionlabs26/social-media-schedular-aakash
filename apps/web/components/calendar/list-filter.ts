/**
 * List-view filters (status chips + search). Pure helpers working on minimal shapes so they can
 * be unit tested without the database.
 */
import type { DisplayStatus } from '@app/core/status';
import { LIST_FILTERS, type ListFilter } from './types';

export function parseListFilter(value: string | string[] | undefined | null): ListFilter | null {
  const v = Array.isArray(value) ? value[0] : value;
  return (LIST_FILTERS as readonly string[]).includes(v ?? '') ? (v as ListFilter) : null;
}

/** Trimmed search text, capped so a pasted essay can't slow the page down. */
export function parseQuery(value: string | string[] | undefined | null): string {
  const v = Array.isArray(value) ? value[0] : value;
  return (v ?? '').trim().slice(0, 100);
}

export interface FilterablePost {
  scheduledAt: string | Date | null;
  display: DisplayStatus;
  targets: Array<{ display: DisplayStatus; scheduledAt: string | Date | null }>;
}

/** True when the post has no time at all (neither the post nor any platform). */
export function isUnscheduled(p: FilterablePost): boolean {
  return !p.scheduledAt && p.targets.every((t) => !t.scheduledAt);
}

/**
 * A post matches a status chip if the post or ANY of its platforms has that status, so
 * "Published" finds a video that is live on Instagram even while YouTube needs attention.
 */
export function matchesFilter(p: FilterablePost, filter: ListFilter | null): boolean {
  if (!filter) return true;
  if (filter === 'unscheduled') return isUnscheduled(p);
  return p.display === filter || p.targets.some((t) => t.display === filter);
}

export interface SearchablePost {
  filename: string;
  targets: Array<{ title: string; body: string; hashtags: string[] }>;
}

/** Case-insensitive search over filename, titles, captions and hashtags. Every word must match. */
export function matchesQuery(p: SearchablePost, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [p.filename, ...p.targets.flatMap((t) => [t.title, t.body, t.hashtags.join(' ')])]
    .join('\n')
    .toLowerCase();
  return words.every((w) => hay.includes(w.replace(/^#/, '')));
}
