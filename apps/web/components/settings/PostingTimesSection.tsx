'use client';

/**
 * Weekly posting-time grid used by "Next free slot" (PLAN.md §3.7). Add a time for every day or
 * chosen weekdays; remove single times or a time from every day.
 */
import { useMemo, useState } from 'react';
import { addSlotsAction, deleteSlotAction, deleteSlotTimeAction } from '@/lib/actions/settings';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import { Section, useSettingsAction } from './parts';
import {
  WEEKDAY_ORDER,
  WEEKDAY_SHORT,
  groupSlotsByWeekday,
  normalizeTime,
  type SlotRow,
} from './schemas';

export function PostingTimesSection({ slots, tzLabel }: { slots: SlotRow[]; tzLabel: string }) {
  const { pending, run } = useSettingsAction();
  const [time, setTime] = useState('18:00');
  const [days, setDays] = useState<number[]>([...WEEKDAY_ORDER]);
  const everyDay = days.length === 7;

  const { daily, perDay } = useMemo(() => {
    const groups = groupSlotsByWeekday(slots);
    const dailyTimes = [...new Set(slots.map((s) => s.time))]
      .filter((t) => groups.every((g) => g.slots.some((s) => s.time === t)))
      .sort();
    return {
      daily: dailyTimes,
      perDay: groups.map((g) => ({
        ...g,
        slots: g.slots.filter((s) => !dailyTimes.includes(s.time)),
      })),
    };
  }, [slots]);

  const toggleDay = (d: number) =>
    setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]));

  const normalized = normalizeTime(time);

  return (
    <Section
      id="posting-times"
      title="Posting times"
      description={`Your weekly grid for "Next free slot". Times are in ${tzLabel}.`}
    >
      <div className="rounded-lg border border-border p-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-36">
            <Label htmlFor="slot-time">Time</Label>
            <Input
              id="slot-time"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              aria-invalid={!normalized || undefined}
            />
          </div>
          <fieldset className="min-w-0">
            <legend className="mb-1 text-sm font-medium">Days</legend>
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                aria-pressed={everyDay}
                onClick={() => setDays(everyDay ? [] : [...WEEKDAY_ORDER])}
                className={cn(
                  'h-10 rounded-lg border px-3 text-sm',
                  everyDay ? 'border-accent bg-accent text-accent-fg' : 'border-border bg-surface',
                )}
              >
                Every day
              </button>
              {WEEKDAY_ORDER.map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={days.includes(d)}
                  onClick={() => toggleDay(d)}
                  className={cn(
                    'h-10 w-11 rounded-lg border text-sm',
                    days.includes(d)
                      ? 'border-accent bg-accent/10 font-semibold text-accent'
                      : 'border-border bg-surface text-muted',
                  )}
                >
                  {WEEKDAY_SHORT[d]}
                </button>
              ))}
            </div>
          </fieldset>
          <Button
            variant="primary"
            loading={pending}
            disabled={!normalized || days.length === 0}
            onClick={() => run(() => addSlotsAction({ time, weekdays: days }))}
          >
            Add time
          </Button>
        </div>
        {!normalized ? <p className="mt-1 text-xs text-danger">Enter a time like 18:00</p> : null}
      </div>

      {slots.length === 0 ? (
        <p className="mt-3 rounded-lg bg-surface-2 p-3 text-sm text-muted">
          Empty = every day 18:00 {tzLabel}. Add times above to use your own grid.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
          {daily.length > 0 ? (
            <SlotRowView label="Every day">
              {daily.map((t) => (
                <TimeChip
                  key={t}
                  time={t}
                  label={`Remove ${t} from every day`}
                  disabled={pending}
                  onRemove={() => run(() => deleteSlotTimeAction(t))}
                />
              ))}
            </SlotRowView>
          ) : null}
          {perDay.map((g) => (
            <SlotRowView key={g.weekday} label={g.name}>
              {g.slots.length === 0 ? (
                <span className="text-xs text-muted">
                  {daily.length ? 'Only the every-day times' : 'No posts on this day'}
                </span>
              ) : (
                g.slots.map((s) => (
                  <TimeChip
                    key={s.id}
                    time={s.time}
                    label={`Remove ${s.time} on ${g.name}`}
                    disabled={pending}
                    onRemove={() => run(() => deleteSlotAction(s.id))}
                  />
                ))
              )}
            </SlotRowView>
          ))}
        </ul>
      )}
    </Section>
  );
}

function SlotRowView({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2">
      <span className="w-24 shrink-0 text-sm font-medium">{label}</span>
      <span className="flex flex-1 flex-wrap gap-1.5">{children}</span>
    </li>
  );
}

function TimeChip({
  time,
  label,
  onRemove,
  disabled,
}: {
  time: string;
  label: string;
  onRemove: () => void;
  disabled: boolean;
}) {
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-surface pl-2.5 text-sm tabular-nums">
      {time}
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label={label}
        className="ml-0.5 inline-flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-danger disabled:opacity-50"
      >
        ✕
      </button>
    </span>
  );
}
