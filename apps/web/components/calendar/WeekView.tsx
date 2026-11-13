'use client';

/**
 * Week view: 7 columns (Mon..Sun) on wide screens, a stacked day list on phones. Each day shows
 * its posts by time plus faint "free HH:MM" markers for empty posting slots. Days and markers
 * are drop zones.
 */
import { useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { dayLabel, dayLabelLong, freeSlotTimes, weekDays } from './calendar-math';
import { useCalendar, useDropZone } from './context';
import { PostTile } from './PostTile';
import type { CalendarPost, SlotView } from './types';

type Entry = { kind: 'post'; time: string; post: CalendarPost } | { kind: 'free'; time: string };

export function WeekView({
  date,
  posts,
  slots,
}: {
  date: string;
  posts: CalendarPost[];
  slots: SlotView[];
}) {
  const days = useMemo(() => weekDays(date), [date]);
  const byDay = useMemo(() => {
    const m = new Map<string, CalendarPost[]>();
    for (const p of posts) {
      if (!p.localDate) continue;
      m.set(p.localDate, [...(m.get(p.localDate) ?? []), p]);
    }
    return m;
  }, [posts]);

  return (
    <div
      className="grid grid-cols-1 gap-2 lg:grid-cols-7 lg:gap-0 lg:overflow-hidden lg:rounded-[--radius-card] lg:border lg:border-border"
      role="list"
      aria-label="Week"
    >
      {days.map((d, i) => (
        <DayColumn key={d} date={d} posts={byDay.get(d) ?? []} slots={slots} first={i === 0} />
      ))}
    </div>
  );
}

function DayColumn({
  date,
  posts,
  slots,
  first,
}: {
  date: string;
  posts: CalendarPost[];
  slots: SlotView[];
  first: boolean;
}) {
  const { today, now, timezone, drag } = useCalendar();
  const [hover, setHover] = useState(false);
  const zone = useDropZone({ date }, setHover);
  const isToday = date === today;
  const isPast = date < today;

  const entries = useMemo<Entry[]>(() => {
    const occupied = posts.map((p) => p.localTime).filter((t): t is string => !!t);
    const free = freeSlotTimes(date, slots, occupied, { now, tz: timezone });
    const list: Entry[] = [
      ...posts.map((p) => ({ kind: 'post' as const, time: p.localTime ?? '', post: p })),
      ...free.map((time) => ({ kind: 'free' as const, time })),
    ];
    return list.sort((a, b) => a.time.localeCompare(b.time));
  }, [posts, slots, date, now, timezone]);

  return (
    <section
      role="listitem"
      aria-label={dayLabelLong(date)}
      {...zone}
      className={cn(
        'flex min-w-0 flex-col rounded-[--radius-card] border border-border bg-surface lg:min-h-80 lg:rounded-none lg:border-0',
        !first && 'lg:border-l lg:border-border',
        isPast && 'bg-surface/60',
        hover && drag && 'ring-2 ring-inset ring-accent',
      )}
    >
      <h3
        className={cn(
          'flex items-center justify-between px-2 py-1.5 text-xs font-semibold lg:border-b lg:border-border',
          (entries.length > 0 || !isPast) && 'border-b border-border',
          isToday ? 'text-accent' : isPast ? 'text-muted' : 'text-text',
        )}
      >
        <span>
          <span className="lg:hidden">{dayLabelLong(date)}</span>
          <span className="hidden lg:inline">{dayLabel(date)}</span>
        </span>
        {isToday ? <span className="rounded bg-accent/10 px-1.5 text-[10px]">Today</span> : null}
      </h3>
      <div
        className={cn(
          'flex flex-1 flex-col gap-1.5 p-1.5',
          entries.length === 0 && isPast && 'max-lg:hidden',
        )}
      >
        {entries.length === 0 ? (
          isPast ? null : (
            <p className="px-1 py-1 text-xs text-muted lg:py-3">Nothing planned</p>
          )
        ) : (
          entries.map((e) =>
            e.kind === 'post' ? (
              <PostTile key={e.post.id} post={e.post} />
            ) : (
              <FreeSlot key={`free-${e.time}`} date={date} time={e.time} />
            ),
          )
        )}
      </div>
    </section>
  );
}

/** Faint "free 18:00" marker; dropping on it takes that time. */
function FreeSlot({ date, time }: { date: string; time: string }) {
  const { drag } = useCalendar();
  const [hover, setHover] = useState(false);
  const zone = useDropZone({ date, time }, setHover);
  return (
    <div
      {...zone}
      className={cn(
        'rounded-md border border-dashed px-2 py-1 text-center text-[11px] tabular-nums',
        hover && drag ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted/80',
      )}
      title={`Free posting time ${time}. Drop a card here to use it.`}
    >
      free {time}
    </div>
  );
}
