'use client';

/**
 * List view = the video library: newest first, status filter chips (the six statuses plus
 * "Not scheduled yet") and a search box over filenames and captions. Filters live in the URL.
 */
import Link from 'next/link';
import { DISPLAY_STATUS_ICON, DISPLAY_STATUS_LABEL } from '@app/core/status';
import { EmptyState } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { CardMenu } from './CardMenu';
import { useCalendar } from './context';
import { PlatformStatusChip } from './PlatformStatus';
import { Thumb } from './Thumb';
import { LIST_FILTERS, type CalendarPost, type ListFilter } from './types';
import { dayLabelLong } from './calendar-math';

function filterLabel(f: ListFilter): string {
  return f === 'unscheduled' ? 'Not scheduled yet' : DISPLAY_STATUS_LABEL[f];
}

function listHref(filter: ListFilter | null, query: string): string {
  const p = new URLSearchParams({ view: 'list' });
  if (filter) p.set('status', filter);
  if (query) p.set('q', query);
  return `/calendar?${p.toString()}`;
}

export function ListView({
  posts,
  filter,
  query,
  truncated,
}: {
  posts: CalendarPost[];
  filter: ListFilter | null;
  query: string;
  truncated: boolean;
}) {
  return (
    <div className="space-y-3">
      <form action="/calendar" method="get" role="search" className="flex gap-2">
        <input type="hidden" name="view" value="list" />
        {filter ? <input type="hidden" name="status" value={filter} /> : null}
        <label htmlFor="cal-search" className="sr-only">
          Search videos
        </label>
        <input
          id="cal-search"
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Search filename or caption"
          className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 text-sm placeholder:text-muted focus:border-accent focus:outline-none"
        />
        <button className="h-10 rounded-lg border border-border bg-surface px-4 text-sm font-medium hover:bg-surface-2">
          Search
        </button>
      </form>

      <nav aria-label="Filter by status" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <ul className="flex gap-1.5 whitespace-nowrap pb-1 sm:flex-wrap">
          <li>
            <FilterChip href={listHref(null, query)} active={filter === null}>
              All
            </FilterChip>
          </li>
          {LIST_FILTERS.map((f) => (
            <li key={f}>
              <FilterChip href={listHref(f, query)} active={filter === f}>
                {f === 'unscheduled' ? null : (
                  <span aria-hidden className="mr-1">
                    {DISPLAY_STATUS_ICON[f]}
                  </span>
                )}
                {filterLabel(f)}
              </FilterChip>
            </li>
          ))}
        </ul>
      </nav>

      {posts.length === 0 ? (
        <EmptyState title={query || filter ? 'No videos match' : 'No videos yet'}>
          {query || filter ? (
            <Link href="/calendar?view=list" className="text-accent hover:underline">
              Clear filters
            </Link>
          ) : (
            <Link href="/" className="text-accent hover:underline">
              Upload your first video
            </Link>
          )}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border overflow-visible rounded-[--radius-card] border border-border bg-surface">
          {posts.map((p) => (
            <ListRow key={p.id} post={p} />
          ))}
        </ul>
      )}
      {truncated ? (
        <p className="text-xs text-muted">
          Showing the newest 500 videos. Search to find older ones.
        </p>
      ) : null}
    </div>
  );
}

function FilterChip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium',
        active
          ? 'border-accent bg-accent text-accent-fg'
          : 'border-border bg-surface text-text hover:bg-surface-2',
      )}
    >
      {children}
    </Link>
  );
}

function ListRow({ post }: { post: CalendarPost }) {
  const { openPost, tzLabel } = useCalendar();
  const unscheduled = !post.scheduledAt;
  const isDraft = unscheduled || post.targets.every((t) => t.display === 'draft');
  return (
    <li className="flex items-start gap-3 p-3">
      <button
        type="button"
        onClick={() => openPost(post.id)}
        className="flex min-w-0 flex-1 items-start gap-3 text-left"
      >
        <Thumb url={post.thumbUrl} className="w-11" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium" title={post.filename}>
            {post.filename}
          </span>
          {post.snippet ? (
            <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{post.snippet}</span>
          ) : null}
          <span className="mt-1 block text-xs tabular-nums">
            {unscheduled ? (
              <span className="text-muted">Not scheduled yet</span>
            ) : (
              <>
                {dayLabelLong(post.localDate!)}, {post.localTime} {tzLabel}
                {post.overdue ? <span className="text-warn"> · Draft · overdue</span> : null}
              </>
            )}
            {post.processingLabel ? (
              <span className="text-muted"> · {post.processingLabel}…</span>
            ) : null}
          </span>
          <span className="mt-1.5 flex flex-wrap gap-1">
            {post.targets.map((t) => (
              <PlatformStatusChip
                key={t.id}
                platform={t.platform}
                display={t.display}
                overdue={t.overdue}
                detail={t.attention}
              />
            ))}
          </span>
        </span>
      </button>
      <CardMenu post={post} isDraft={isDraft && unscheduled} />
    </li>
  );
}
