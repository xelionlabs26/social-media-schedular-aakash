'use client';

/**
 * [Regenerate] + [⋯] (Shorter · Longer · More casual · More formal · More viral) for one field
 * (PLAN.md §4.7). Each choice rewrites only that field, within its limit.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { MoreIcon, SparkIcon } from '@/components/upload/icons';

export type RefineChoice = 'regenerate' | 'shorter' | 'longer' | 'casual' | 'formal' | 'viral';

const MENU: Array<{ action: Exclude<RefineChoice, 'regenerate'>; label: string }> = [
  { action: 'shorter', label: 'Shorter' },
  { action: 'longer', label: 'Longer' },
  { action: 'casual', label: 'More casual' },
  { action: 'formal', label: 'More formal' },
  { action: 'viral', label: 'More viral' },
];

export function RefineControls({
  fieldLabel,
  busy,
  disabled,
  onRefine,
}: {
  fieldLabel: string;
  busy: boolean;
  disabled?: boolean;
  onRefine: (action: RefineChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!open) return;
    items.current[0]?.focus();
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    const list = items.current.filter(Boolean) as HTMLButtonElement[];
    const idx = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      // Don't let Escape also close the drawer.
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(idx + 1) % list.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[(idx - 1 + list.length) % list.length]?.focus();
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  return (
    <div ref={wrap} className="relative flex items-center gap-1">
      <Button
        size="sm"
        variant="ghost"
        loading={busy}
        disabled={disabled}
        onClick={() => onRefine('regenerate')}
        aria-label={`Regenerate ${fieldLabel}`}
      >
        {!busy ? <SparkIcon className="h-3.5 w-3.5" /> : null}
        Regenerate
      </Button>
      {/* Plain button: the kit's Button doesn't forward refs, and focus returns here. */}
      <button
        ref={trigger}
        type="button"
        className="inline-flex h-8 items-center justify-center rounded-lg px-2 text-text transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={disabled || busy}
        aria-label={`More ways to rewrite ${fieldLabel}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreIcon className="h-4 w-4" />
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={`Rewrite ${fieldLabel}`}
          onKeyDown={onMenuKey}
          className="absolute top-full right-0 z-20 mt-1 w-40 rounded-lg border border-border bg-surface py-1 shadow-lg"
        >
          {MENU.map((m, i) => (
            <button
              key={m.action}
              ref={(el) => {
                items.current[i] = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="block w-full px-3 py-1.5 text-left text-sm hover:bg-surface-2 focus:bg-surface-2 focus:outline-none"
              onClick={() => {
                close();
                onRefine(m.action);
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
