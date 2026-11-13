'use client';

/**
 * "When": one datetime in the app time zone (IST), or one per platform with
 * "Different time per app". Values are local "YYYY-MM-DDTHH:mm" strings; the parent converts.
 */
import { useId } from 'react';
import type { Platform } from '@app/db';
import { PLATFORM_LABELS } from '@app/core/platforms';
import { minLocalInput, zoneLabel } from '@/lib/upload/time';

export interface WhenValue {
  common: string;
  perApp: boolean;
  perPlatform: Partial<Record<Platform, string>>;
}

const inputCls =
  'h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text focus:border-accent focus:outline-none sm:w-60';

export function WhenSection({
  timezone,
  platforms,
  value,
  hint,
  disabled,
  onChange,
  onCommit,
}: {
  timezone: string;
  platforms: Platform[];
  value: WhenValue;
  hint: string;
  disabled?: boolean;
  onChange: (v: WhenValue) => void;
  /** Input left (blur): the parent may save a dated draft. */
  onCommit: (v: WhenValue) => void;
}) {
  const id = useId();
  const zone = zoneLabel(timezone);
  const min = minLocalInput(timezone);
  return (
    <section aria-labelledby={`${id}-title`} className="space-y-2">
      <h3 id={`${id}-title`} className="text-sm font-medium">
        When <span className="font-normal text-muted">({zone})</span>
      </h3>
      {!value.perApp ? (
        <div>
          <label htmlFor={`${id}-common`} className="sr-only">
            Date and time ({zone})
          </label>
          <input
            id={`${id}-common`}
            type="datetime-local"
            className={inputCls}
            min={min}
            value={value.common}
            disabled={disabled}
            aria-describedby={`${id}-hint`}
            onChange={(e) => onChange({ ...value, common: e.target.value })}
            onBlur={() => onCommit(value)}
          />
        </div>
      ) : (
        <div className="space-y-2">
          {platforms.map((p) => (
            <div key={p} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
              <label htmlFor={`${id}-${p}`} className="w-24 text-sm">
                {PLATFORM_LABELS[p]}
              </label>
              <input
                id={`${id}-${p}`}
                type="datetime-local"
                className={inputCls}
                min={min}
                value={value.perPlatform[p] ?? ''}
                disabled={disabled}
                aria-describedby={`${id}-hint`}
                onChange={(e) =>
                  onChange({ ...value, perPlatform: { ...value.perPlatform, [p]: e.target.value } })
                }
                onBlur={() => onCommit(value)}
              />
            </div>
          ))}
        </div>
      )}
      {platforms.length > 1 ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--color-accent)]"
            checked={value.perApp}
            disabled={disabled}
            onChange={(e) => {
              const perApp = e.target.checked;
              const next: WhenValue = perApp
                ? {
                    ...value,
                    perApp,
                    perPlatform: Object.fromEntries(
                      platforms.map((p) => [p, value.perPlatform[p] || value.common]),
                    ),
                  }
                : {
                    ...value,
                    perApp,
                    common:
                      value.common ||
                      platforms.map((p) => value.perPlatform[p]).find(Boolean) ||
                      '',
                  };
              onChange(next);
              onCommit(next);
            }}
          />
          Different time per app
        </label>
      ) : null}
      <p id={`${id}-hint`} className="text-xs text-muted" aria-live="polite">
        {hint}
      </p>
    </section>
  );
}
