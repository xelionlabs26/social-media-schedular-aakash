'use client';

/**
 * Calendar screen (client part): header with prev/next/today and Week|Month|List, the
 * needs-attention banner, the current view, the drafts tray and the post editor drawer.
 * Data comes from the server page; after any change we refresh it with router.refresh().
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState, useTransition } from 'react';
import { PostEditorDrawer } from '@/components/post-editor/PostEditorDrawer';
import { useToast } from '@/components/ui/toast';
import { reschedulePostAction, scheduleDraftOnDayAction } from '@/lib/actions/calendar';
import { cn } from '@/lib/cn';
import type { ActionResult } from './action-result';
import { AttentionBanner } from './AttentionBanner';
import { CALENDAR_VIEWS, shiftDate, viewTitle, type CalendarView } from './calendar-math';
import { CalendarContext, type CalendarCtx, type DragItem, type DropTarget } from './context';
import { ListView } from './ListView';
import { MonthView } from './MonthView';
import { DraftChip } from './PostTile';
import type { CalendarData, CalendarPost } from './types';
import { WeekView } from './WeekView';

const VIEW_LABEL: Record<CalendarView, string> = { week: 'Week', month: 'Month', list: 'List' };

function href(view: CalendarView, date?: string) {
  return date ? `/calendar?view=${view}&date=${date}` : `/calendar?view=${view}`;
}

export function CalendarClient({
  data,
  initialPostId,
}: {
  data: CalendarData;
  initialPostId?: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [drag, setDrag] = useState<DragItem | null>(null);
  const [openPostId, setOpenPostId] = useState<string | null>(initialPostId ?? null);
  const now = useMemo(() => new Date(data.nowIso), [data.nowIso]);

  const runAction = useCallback(
    (fn: () => Promise<ActionResult<unknown>>) => {
      startTransition(async () => {
        try {
          const res = await fn();
          if (res.ok) {
            toast(res.message ?? 'Done', 'ok');
            router.refresh();
          } else {
            toast(res.error, 'error');
          }
        } catch {
          // Network failure or the server rejected the request before our action ran.
          toast('Could not reach the server. Check your connection and try again.', 'error');
        }
      });
    },
    [router, toast],
  );

  const drop = useCallback(
    (target: DropTarget, item?: DragItem | null) => {
      const d = item ?? drag;
      setDrag(null);
      if (!d) return;
      runAction(() =>
        d.kind === 'draft'
          ? scheduleDraftOnDayAction(d.postId, target.date, target.time)
          : reschedulePostAction(d.postId, target.date, target.time),
      );
    },
    [drag, runAction],
  );

  const ctx: CalendarCtx = {
    timezone: data.timezone,
    tzLabel: data.tzLabel,
    today: data.today,
    now,
    pending,
    drag,
    setDrag,
    drop,
    openPost: setOpenPostId,
    runAction,
  };

  const { view, date } = data;
  const onClose = useCallback(() => setOpenPostId(null), []);
  const onChanged = useCallback(() => router.refresh(), [router]);

  return (
    <CalendarContext.Provider value={ctx}>
      <div className="space-y-3">
        <header className="flex flex-wrap items-center gap-2">
          {view !== 'list' ? (
            <div className="flex items-center gap-1">
              <Link
                href={href(view, shiftDate(view, date, -1))}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-surface hover:bg-surface-2"
                aria-label={view === 'week' ? 'Previous week' : 'Previous month'}
              >
                ‹
              </Link>
              <Link
                href={href(view, shiftDate(view, date, 1))}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-surface hover:bg-surface-2"
                aria-label={view === 'week' ? 'Next week' : 'Next month'}
              >
                ›
              </Link>
              <Link
                href={href(view, data.today)}
                className="inline-flex h-9 items-center rounded-lg border border-border bg-surface px-3 text-sm hover:bg-surface-2"
              >
                Today
              </Link>
            </div>
          ) : null}
          <h1
            className="order-first w-full min-w-0 truncate text-lg font-semibold sm:order-none sm:w-auto sm:flex-1"
            aria-live="polite"
          >
            {viewTitle(view, date)}
            <span className="ml-2 text-xs font-normal text-muted">{data.tzLabel}</span>
          </h1>
          {pending ? (
            <span className="text-xs text-muted" role="status">
              Saving…
            </span>
          ) : null}
          <nav
            aria-label="Calendar view"
            className="ml-auto flex rounded-lg border border-border bg-surface p-0.5"
          >
            {CALENDAR_VIEWS.map((v) => (
              <Link
                key={v}
                href={v === 'list' ? href(v) : href(v, date)}
                aria-current={v === view ? 'page' : undefined}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium',
                  v === view ? 'bg-surface-2 text-text' : 'text-muted hover:text-text',
                )}
              >
                {VIEW_LABEL[v]}
              </Link>
            ))}
          </nav>
          <Link
            href="/"
            className="inline-flex h-9 items-center rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg hover:opacity-90"
          >
            + New
          </Link>
        </header>

        <AttentionBanner items={data.attention} />

        {view === 'week' ? <WeekView date={date} posts={data.posts} slots={data.slots} /> : null}
        {view === 'month' ? <MonthView date={date} posts={data.posts} /> : null}
        {view === 'list' ? (
          <ListView
            posts={data.posts}
            filter={data.filter}
            query={data.query}
            truncated={data.truncated}
          />
        ) : null}

        {view !== 'list' ? <DraftsTray drafts={data.drafts} /> : null}
      </div>
      <PostEditorDrawer postId={openPostId} onClose={onClose} onChanged={onChanged} />
    </CalendarContext.Provider>
  );
}

function DraftsTray({ drafts }: { drafts: CalendarPost[] }) {
  return (
    <section
      aria-labelledby="drafts-title"
      className="rounded-[--radius-card] border border-border bg-surface p-3"
    >
      <h2 id="drafts-title" className="text-sm font-semibold">
        Drafts (no date){' '}
        <span className="font-normal text-muted">
          {drafts.length > 0 ? '· drag onto a day, or use ⋯ → Schedule on' : '· nothing waiting'}
        </span>
      </h2>
      {drafts.length > 0 ? (
        <ul className="-mx-3 mt-2 flex gap-2 overflow-x-auto px-3 pb-1">
          {drafts.map((p) => (
            <li key={p.id}>
              <DraftChip post={p} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
