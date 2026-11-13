'use client';

/**
 * Month view: Monday-start grid. Wide screens list up to 3 posts per day (drag to move);
 * phones show a count + the worst status per day, and tapping a day opens its week.
 */
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { DISPLAY_STATUS_ICON, DISPLAY_STATUS_LABEL, summarizeStatuses } from '@app/core/status';
import { cn } from '@/lib/cn';
import { WEEK_HEADER, dayLabelLong, isSameMonth, monthGrid } from './calendar-math';
import { useCalendar, useDropZone } from './context';
import { PostLine } from './PostTile';
import type { CalendarPost } from './types';

const MAX_LINES = 3;

export function MonthView({ date, posts }: { date: string; posts: CalendarPost[] }) {
  const weeks = useMemo(() => monthGrid(date), [date]);
  const byDay = useMemo(() => {
    const m = new Map<string, CalendarPost[]>();
    for (const p of posts) {
      if (!p.localDate) continue;
      m.set(p.localDate, [...(m.get(p.localDate) ?? []), p]);
    }
    for (const list of m.values())
      list.sort((a, b) => (a.localTime ?? '').localeCompare(b.localTime ?? ''));
    return m;
  }, [posts]);

  return (
    <div className="overflow-hidden rounded-[--radius-card] border border-border bg-surface">
      <div className="grid grid-cols-7 border-b border-border bg-surface-2 text-center text-[11px] font-semibold text-muted">
        {WEEK_HEADER.map((d) => (
          <div key={d} className="py-1.5">
            {d}
          </div>
        ))}
      </div>
      <div role="grid" aria-label="Month" className="grid grid-cols-7">
        {weeks.flat().map((d, i) => (
          <MonthCell
            key={d}
            date={d}
            inMonth={isSameMonth(d, date)}
            posts={byDay.get(d) ?? []}
            col={i % 7}
          />
        ))}
      </div>
    </div>
  );
}

function MonthCell({
  date,
  inMonth,
  posts,
  col,
}: {
  date: string;
  inMonth: boolean;
  posts: CalendarPost[];
  col: number;
}) {
  const { today, drag } = useCalendar();
  const [hover, setHover] = useState(false);
  const zone = useDropZone({ date }, setHover);
  const day = Number(date.slice(8));
  const isToday = date === today;
  const worst = posts.length ? summarizeStatuses(posts.map((p) => p.display)) : null;
  const weekHref = `/calendar?view=week&date=${date}`;

  return (
    <div
      role="gridcell"
      aria-label={`${dayLabelLong(date)}: ${posts.length} video${posts.length === 1 ? '' : 's'}`}
      {...zone}
      className={cn(
        'min-h-14 min-w-0 border-b border-border p-0.5 sm:min-h-24 sm:p-1',
        col > 0 && 'border-l',
        !inMonth && 'bg-surface-2/50 text-muted',
        hover && drag && 'ring-2 ring-inset ring-accent',
      )}
    >
      {/* Phones: tap the day to open its week. */}
      <Link href={weekHref} className="flex h-full flex-col items-center gap-0.5 sm:hidden">
        <DayNumber day={day} isToday={isToday} />
        {worst ? (
          <span
            className={cn(
              'text-[10px] leading-none',
              worst === 'needs_attention' ? 'font-bold text-danger' : 'text-muted',
            )}
          >
            <span aria-hidden>{DISPLAY_STATUS_ICON[worst]}</span>
            {posts.length}
            <span className="sr-only"> {DISPLAY_STATUS_LABEL[worst]}</span>
          </span>
        ) : null}
      </Link>
      {/* Wider screens: the posts themselves. */}
      <div className="hidden sm:block">
        <Link
          href={weekHref}
          className="mb-0.5 inline-block"
          aria-label={`Open week of ${dayLabelLong(date)}`}
        >
          <DayNumber day={day} isToday={isToday} />
        </Link>
        <div className="flex flex-col gap-px">
          {posts.slice(0, MAX_LINES).map((p) => (
            <PostLine key={p.id} post={p} />
          ))}
          {posts.length > MAX_LINES ? (
            <Link href={weekHref} className="px-1 text-[11px] text-accent hover:underline">
              +{posts.length - MAX_LINES} more
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function DayNumber({ day, isToday }: { day: number; isToday: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex h-6 w-6 items-center justify-center rounded-full text-xs tabular-nums',
        isToday && 'bg-accent font-semibold text-accent-fg',
      )}
    >
      {day}
    </span>
  );
}
