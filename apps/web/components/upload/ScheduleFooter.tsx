'use client';

/**
 * Sticky footer: [Schedule N videos →]. Disabled with a visible reason when nothing is ready,
 * lists the cards it leaves out, and always says that nothing is posted before this click.
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ScheduleState } from '@/lib/upload/readiness';
import { formatWhen } from '@/lib/upload/time';
import type { ScheduleSummary } from '@/lib/upload/types';
import { ArrowRightIcon } from './icons';

export function ScheduleFooter({
  state,
  whenText,
  busy,
  onSchedule,
}: {
  state: ScheduleState;
  whenText: string;
  busy: boolean;
  onSchedule: () => void;
}) {
  const [showLeftOut, setShowLeftOut] = useState(false);
  const leftOut = state.needsAttention.length;
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 backdrop-blur">
      {showLeftOut && leftOut ? (
        <ul className="mx-auto max-h-40 max-w-6xl space-y-0.5 overflow-y-auto px-4 pt-3 text-xs sm:px-6">
          {state.needsAttention.map((n) => (
            <li key={n.assetId} className="text-danger">
              <span className="font-medium break-all">{n.filename}</span>: {n.reason}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-6">
        <div className="min-w-0 flex-1 text-xs text-muted">
          <p className="font-medium text-text">Nothing is posted until you click this.</p>
          <p className="truncate">
            {state.disabledReason ?? whenText}
            {state.processing && !state.disabledReason
              ? ` · ${state.processing} still processing`
              : ''}
            {state.uploading && !state.disabledReason ? ` · ${state.uploading} uploading` : ''}
          </p>
          {leftOut ? (
            <button
              type="button"
              className="text-danger hover:underline"
              aria-expanded={showLeftOut}
              onClick={() => setShowLeftOut((v) => !v)}
            >
              ! {leftOut} need{leftOut === 1 ? 's' : ''} attention and will be left out
            </button>
          ) : null}
        </div>
        <Button
          variant="primary"
          className="w-full sm:w-auto"
          disabled={state.disabledReason !== null}
          loading={busy}
          onClick={onSchedule}
          aria-describedby="schedule-reason"
        >
          {state.buttonLabel}
          <ArrowRightIcon className="h-4 w-4" />
        </Button>
        <span id="schedule-reason" className="sr-only">
          {state.disabledReason ?? whenText}
        </span>
      </div>
    </div>
  );
}

/** Inline result of the last Schedule click (skipped reasons and warnings stay readable). */
export function ScheduleResultPanel({
  summary,
  timezone,
  draftMode,
  onDismiss,
}: {
  summary: ScheduleSummary;
  timezone: string;
  draftMode: boolean;
  onDismiss: () => void;
}) {
  const n = summary.scheduled.length;
  return (
    <section
      aria-label="Schedule result"
      className="rounded-xl border border-border bg-surface p-4 text-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="font-medium">
          {draftMode
            ? `Saved ${n} draft${n === 1 ? '' : 's'}.`
            : `Scheduled ${n} video${n === 1 ? '' : 's'}.`}
          {summary.skipped.length ? ` ${summary.skipped.length} skipped.` : ''}
        </p>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-md px-2 text-muted hover:bg-surface-2"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
      {summary.scheduled.length ? (
        <ul className="mt-2 space-y-0.5 text-xs text-muted">
          {summary.scheduled.slice(0, 20).map((s) => (
            <li key={s.postId}>
              <span className="break-all text-text">{s.filename}</span> ·{' '}
              {formatWhen(s.at, timezone)}
            </li>
          ))}
          {summary.scheduled.length > 20 ? (
            <li>…and {summary.scheduled.length - 20} more</li>
          ) : null}
        </ul>
      ) : null}
      {summary.skipped.length ? (
        <ul className="mt-2 space-y-0.5 text-xs text-danger">
          {summary.skipped.map((s) => (
            <li key={s.postId}>
              <span className="font-medium break-all">{s.filename}</span>: {s.reason}
            </li>
          ))}
        </ul>
      ) : null}
      {summary.warnings.length ? (
        <ul className="mt-2 space-y-0.5 text-xs text-warn">
          {summary.warnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
