'use client';

/**
 * The "⋯" menu on every card: Open, Move to… (keyboard/touch alternative to drag & drop) and
 * Move to drafts. Drafts get "Schedule on…" instead (first free slot of the chosen day).
 */
import { useEffect, useId, useRef, useState } from 'react';
import {
  moveToDraftsAction,
  reschedulePostAction,
  scheduleDraftOnDayAction,
} from '@/lib/actions/calendar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { useCalendar } from './context';
import type { CalendarPost } from './types';

const MENU_WIDTH = 240;
/** Approximate height, used to open upwards near the bottom of the screen. */
const MENU_HEIGHT = 170;

export function CardMenu({
  post,
  isDraft,
  className,
}: {
  post: CalendarPost;
  isDraft: boolean;
  className?: string;
}) {
  const { openPost, runAction, today, pending } = useCalendar();
  const [open, setOpen] = useState(false);
  // Fixed position computed from the button, so scroll/overflow containers can't clip the menu.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [date, setDate] = useState(
    post.localDate && post.localDate >= today ? post.localDate : today,
  );
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const dateId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  const move = () => {
    setOpen(false);
    runAction(() =>
      isDraft ? scheduleDraftOnDayAction(post.id, date) : reschedulePostAction(post.id, date),
    );
  };

  return (
    <div ref={box} className={cn('relative', className)}>
      <button
        ref={button}
        type="button"
        className="rounded px-1.5 py-0.5 text-sm leading-none text-muted hover:bg-surface-2 hover:text-text"
        aria-label={`Actions for ${post.filename}`}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          if (!open && button.current) {
            const r = button.current.getBoundingClientRect();
            const left = Math.max(
              8,
              Math.min(r.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8),
            );
            const below = r.bottom + 4;
            const top =
              below + MENU_HEIGHT > window.innerHeight
                ? Math.max(8, r.top - MENU_HEIGHT - 4)
                : below;
            setPos({ top, left });
          }
          setOpen((v) => !v);
        }}
        draggable={false}
      >
        ⋯
      </button>
      {open && pos ? (
        <div
          style={{ top: pos.top, left: pos.left, width: MENU_WIDTH }}
          className="fixed z-40 rounded-lg border border-border bg-surface p-2 text-sm shadow-lg"
          onClick={(e) => e.stopPropagation()}
          role="group"
          aria-label={`Actions for ${post.filename}`}
        >
          <button
            type="button"
            className="w-full rounded px-2 py-1.5 text-left hover:bg-surface-2"
            onClick={() => {
              setOpen(false);
              openPost(post.id);
            }}
          >
            Open in editor
          </button>
          {post.movable ? (
            <div className="mt-1 border-t border-border px-2 pt-2">
              <label htmlFor={dateId} className="mb-1 block text-xs font-medium text-muted">
                {isDraft ? 'Schedule on (first free time)' : 'Move to (keeps the time)'}
              </label>
              <div className="flex gap-1.5">
                <input
                  id={dateId}
                  type="date"
                  min={today}
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-sm"
                />
                <Button size="sm" variant="primary" onClick={move} disabled={!date || pending}>
                  {isDraft ? 'Schedule' : 'Move'}
                </Button>
              </div>
            </div>
          ) : null}
          {!isDraft && post.movable && post.scheduledAt ? (
            <button
              type="button"
              className="mt-1 w-full rounded px-2 py-1.5 text-left hover:bg-surface-2"
              onClick={() => {
                setOpen(false);
                runAction(() => moveToDraftsAction(post.id));
              }}
            >
              Move to drafts
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
