'use client';

/**
 * The batch settings bar (PLAN.md §3.2 step 3): Post to [IG][YT][FB] · When · Notes for AI ·
 * [Apply to all N]. New uploads always use the bar's current values; existing cards change
 * only through "Apply to all" (with a confirmation that lists every change).
 */
import Link from 'next/link';
import { useId } from 'react';
import type { Platform } from '@app/db';
import { PLATFORM_ORDER } from '@app/core/platforms';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import { NOTES_MAX_CHARS } from '@/lib/upload/constants';
import type { AccountsByPlatform, BatchSettings, WhenRule } from '@/lib/upload/types';

const TOGGLE_LABEL: Record<Platform, { short: string; long: string; color: string }> = {
  instagram: { short: 'IG Reel', long: 'Instagram Reel', color: 'text-ig' },
  youtube: { short: 'YT Short', long: 'YouTube Short', color: 'text-yt' },
  facebook: { short: 'FB Page', long: 'Facebook Page Reel', color: 'text-fb' },
};

const WHEN_OPTIONS: Array<{ mode: WhenRule['mode']; label: string }> = [
  { mode: 'next_free', label: 'Next free slot from' },
  { mode: 'pick', label: 'Pick date & time on each card' },
  { mode: 'draft', label: 'Save as drafts' },
];

export function BatchBar({
  settings,
  onChange,
  accounts,
  today,
  cardCount,
  dirty,
  onApply,
  applying,
}: {
  settings: BatchSettings;
  onChange: (next: BatchSettings) => void;
  accounts: AccountsByPlatform;
  today: string;
  cardCount: number;
  /** The bar differs from what the cards were last given. */
  dirty: boolean;
  onApply: () => void;
  applying: boolean;
}) {
  const id = useId();
  const togglePlatform = (p: Platform) => {
    const on = settings.platforms.includes(p);
    const platforms = on
      ? settings.platforms.filter((x) => x !== p)
      : PLATFORM_ORDER.filter((x) => x === p || settings.platforms.includes(x));
    onChange({ ...settings, platforms });
  };
  const setWhen = (when: WhenRule) => onChange({ ...settings, when });
  const startDate = settings.when.startDate ?? today;

  return (
    <section
      aria-label="Batch settings"
      className="space-y-4 rounded-xl border border-border bg-surface p-4"
    >
      {/* Post to */}
      <div
        role="group"
        aria-labelledby={`${id}-postto`}
        className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4"
      >
        <span id={`${id}-postto`} className="w-24 shrink-0 text-sm font-medium sm:pt-2">
          Post to
        </span>
        <div className="flex flex-wrap gap-2">
          {PLATFORM_ORDER.map((p) => {
            const on = settings.platforms.includes(p);
            const acct = accounts[p];
            const hint =
              acct.state === 'connected'
                ? null
                : acct.state === 'needs_reauth'
                  ? 'reconnect needed'
                  : 'not connected';
            return (
              <div key={p} className="flex flex-col items-start">
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => togglePlatform(p)}
                  className={cn(
                    'inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition',
                    on
                      ? 'border-accent bg-accent/10 text-text'
                      : 'border-border bg-surface text-muted hover:bg-surface-2',
                  )}
                  title={TOGGLE_LABEL[p].long}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'flex h-4 w-4 items-center justify-center rounded border text-[10px] leading-none',
                      on ? 'border-accent bg-accent text-accent-fg' : 'border-border',
                    )}
                  >
                    {on ? '✓' : ''}
                  </span>
                  <span className={on ? TOGGLE_LABEL[p].color : undefined}>
                    {TOGGLE_LABEL[p].short}
                  </span>
                </button>
                {hint ? (
                  <Link
                    href="/settings#accounts"
                    className="mt-0.5 pl-1 text-[11px] text-warn hover:underline"
                  >
                    {hint}
                  </Link>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      {settings.platforms.length === 0 ? (
        <p className="text-xs text-danger" role="alert">
          Pick at least one platform.
        </p>
      ) : null}

      {/* When */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
        <span id={`${id}-when`} className="w-24 shrink-0 text-sm font-medium sm:pt-1">
          When
        </span>
        <div
          role="radiogroup"
          aria-labelledby={`${id}-when`}
          className="flex min-w-0 flex-1 flex-col gap-2"
        >
          {WHEN_OPTIONS.map((o) => (
            <div key={o.mode} className="flex flex-wrap items-center gap-2 text-sm">
              <label className="inline-flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name={`${id}-when-mode`}
                  className="h-4 w-4 accent-[var(--color-accent)]"
                  checked={settings.when.mode === o.mode}
                  onChange={() =>
                    setWhen(o.mode === 'next_free' ? { mode: o.mode, startDate } : { mode: o.mode })
                  }
                />
                {o.label}
              </label>
              {o.mode === 'next_free' ? (
                <>
                  <Input
                    type="date"
                    aria-label="First day to fill"
                    className="h-8 max-w-44 px-2"
                    min={today}
                    value={startDate}
                    disabled={settings.when.mode !== 'next_free'}
                    onChange={(e) =>
                      setWhen({ mode: 'next_free', startDate: e.target.value || today })
                    }
                  />
                  <Link
                    href="/settings#posting-times"
                    className="text-xs text-accent hover:underline"
                  >
                    Change posting times
                  </Link>
                </>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      {/* Notes */}
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-4">
        <label htmlFor={`${id}-notes`} className="w-24 shrink-0 text-sm font-medium sm:pt-2">
          Notes for AI <span className="block text-xs font-normal text-muted">optional</span>
        </label>
        <Textarea
          id={`${id}-notes`}
          rows={2}
          maxLength={NOTES_MAX_CHARS}
          className="min-h-16"
          placeholder="Names, places, series… e.g. Goa trip with Rahul, day 2"
          value={settings.notes}
          onChange={(e) => onChange({ ...settings, notes: e.target.value })}
        />
      </div>

      {cardCount > 0 ? (
        <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center sm:justify-end">
          {dirty ? (
            <p className="text-xs text-muted sm:mr-auto">
              New uploads use these settings. Apply them to the {cardCount} video
              {cardCount === 1 ? '' : 's'} here too?
            </p>
          ) : null}
          <Button
            onClick={onApply}
            loading={applying}
            disabled={settings.platforms.length === 0}
            variant={dirty ? 'primary' : 'secondary'}
          >
            Apply to all {cardCount}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
