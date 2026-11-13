'use client';

/** Small building blocks shared by the Settings sections. */
import { useRouter } from 'next/navigation';
import { useCallback, useId, useTransition, type ReactNode } from 'react';
import { useToast } from '@/components/ui/toast';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import type { ActionResult } from '@/components/calendar/action-result';

/** Runs a server action with a pending flag, a toast and a page refresh on success. */
export function useSettingsAction() {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const run = useCallback(
    <T,>(fn: () => Promise<ActionResult<T>>, onOk?: (data: T | undefined) => void) => {
      startTransition(async () => {
        try {
          const res = await fn();
          if (res.ok) {
            toast(res.message ?? 'Saved', 'ok');
            onOk?.(res.data);
            router.refresh();
          } else {
            toast(res.error, 'error');
          }
        } catch {
          toast('Could not reach the server. Check your connection and try again.', 'error');
        }
      });
    },
    [router, toast],
  );
  return { pending, run };
}

export function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-28">
      <Card className="p-4 sm:p-5">
        <h2 id={`${id}-title`} className="text-base font-semibold">
          {title}
        </h2>
        {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
        <div className="mt-4">{children}</div>
      </Card>
    </section>
  );
}

/** Checkbox + label (+ hint), 40px tall touch target. */
export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex min-h-10 items-start gap-2.5 py-1">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
      />
      <label htmlFor={id} className="text-sm leading-snug">
        {label}
        {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
      </label>
    </div>
  );
}

/** Footer with the Save button; shows "Unsaved changes" while dirty. */
export function SaveBar({
  dirty,
  pending,
  onSave,
  label = 'Save',
  children,
}: {
  dirty: boolean;
  pending: boolean;
  onSave: () => void;
  label?: string;
  children?: ReactNode;
}) {
  return (
    <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
      {children}
      {dirty ? <span className="mr-auto text-xs text-warn">Unsaved changes</span> : null}
      <button
        type="button"
        onClick={onSave}
        disabled={!dirty || pending}
        aria-busy={pending || undefined}
        className={cn(
          'inline-flex h-10 items-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg hover:opacity-90',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        {pending ? 'Saving…' : label}
      </button>
    </div>
  );
}

/** Group heading inside a section. */
export function SubHeading({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 mt-5 text-sm font-semibold first:mt-0">{children}</h3>;
}

/** Monospace .env key names. */
export function EnvKeys({ keys }: { keys: string[] }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {keys.map((k) => (
        <code key={k} className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">
          {k}
        </code>
      ))}
    </span>
  );
}

/** Stable deep-equality for small JSON-able form states (dirty check). */
export function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
