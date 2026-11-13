'use client';

/**
 * Chips input for hashtags and YouTube tags: Enter or comma adds, Backspace on an empty input
 * removes the last chip, pasting a list splits it, each chip has its own remove button.
 */
import { useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { splitChips } from '@/lib/upload/fields';

export function ChipsInput({
  id,
  kind,
  values,
  onChange,
  max,
  readOnly,
  describedBy,
  placeholder,
  onBlur,
}: {
  id: string;
  kind: 'hashtags' | 'tags';
  values: string[];
  onChange: (next: string[]) => void;
  /** Stop adding at this many chips (hashtags). */
  max?: number;
  readOnly?: boolean;
  describedBy?: string;
  placeholder?: string;
  onBlur?: () => void;
}) {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const full = max !== undefined && values.length >= max;
  const prefix = kind === 'hashtags' ? '#' : '';

  const add = (raw: string) => {
    const incoming = splitChips(raw, kind);
    if (!incoming.length) return;
    const seen = new Set(values.map((v) => v.toLowerCase()));
    const next = [...values];
    for (const chip of incoming) {
      if (max !== undefined && next.length >= max) break;
      if (seen.has(chip.toLowerCase())) continue;
      seen.add(chip.toLowerCase());
      next.push(chip);
    }
    if (next.length !== values.length) onChange(next);
  };

  const remove = (idx: number) => {
    onChange(values.filter((_, i) => i !== idx));
    input.current?.focus();
  };

  return (
    <div
      className={cn(
        'flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1.5 focus-within:border-accent',
        readOnly && 'opacity-60',
      )}
      onClick={() => input.current?.focus()}
    >
      {values.map((v, i) => (
        <span
          key={`${v}-${i}`}
          className="inline-flex max-w-full items-center gap-1 rounded-md bg-surface-2 py-0.5 pr-1 pl-2 text-xs"
        >
          <span className="truncate">
            {prefix}
            {v}
          </span>
          {!readOnly ? (
            <button
              type="button"
              className="rounded px-1 text-muted hover:bg-border hover:text-text"
              aria-label={`Remove ${prefix}${v}`}
              onClick={(e) => {
                e.stopPropagation();
                remove(i);
              }}
            >
              ×
            </button>
          ) : null}
        </span>
      ))}
      {!readOnly ? (
        <input
          ref={input}
          id={id}
          value={text}
          aria-describedby={describedBy}
          disabled={full && !text}
          placeholder={
            full
              ? `Limit reached (${max})`
              : (placeholder ?? (kind === 'hashtags' ? 'Add hashtag' : 'Add tag'))
          }
          className="h-7 min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-muted disabled:cursor-not-allowed"
          onChange={(e) => {
            const v = e.target.value;
            // A typed separator finishes the chip.
            const sep = kind === 'tags' ? /[,\n]/ : /[\s,#]/;
            if (sep.test(v.slice(-1)) && v.trim().replace(/[#,]/g, '')) {
              add(v);
              setText('');
            } else {
              setText(v);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(text);
              setText('');
            } else if (e.key === 'Backspace' && text === '' && values.length) {
              e.preventDefault();
              onChange(values.slice(0, -1));
            }
          }}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text');
            if (/[,\n]/.test(pasted) || (kind === 'hashtags' && /\s|#/.test(pasted.trim()))) {
              e.preventDefault();
              add(text + pasted);
              setText('');
            }
          }}
          onBlur={() => {
            if (text.trim()) {
              add(text);
              setText('');
            }
            onBlur?.();
          }}
        />
      ) : null}
    </div>
  );
}
