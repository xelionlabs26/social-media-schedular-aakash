'use client';

/**
 * History (collapsed): what the app tried for each platform and what the platform answered,
 * newest first. Loaded when first opened.
 */
import { useState } from 'react';
import { PlatformChip } from '@/components/ui/badges';
import { cn } from '@/lib/cn';
import { getPostHistoryAction } from '@/lib/actions/posts';
import { formatWhen } from '@/lib/upload/time';
import type { HistoryEntry } from '@/lib/upload/types';

const STEP_LABEL: Record<HistoryEntry['step'], string> = {
  prepare: 'Prepare',
  upload: 'Upload',
  create_container: 'Create container',
  poll: 'Check processing',
  publish: 'Publish',
  verify: 'Verify',
  reconcile: 'Check before retry',
  update: 'Update',
  cancel: 'Cancel',
};

const OUTCOME: Record<HistoryEntry['outcome'], { icon: string; word: string; cls: string }> = {
  ok: { icon: '✓', word: 'OK', cls: 'text-ok' },
  retryable: { icon: '↻', word: 'Will retry', cls: 'text-warn' },
  fatal: { icon: '!', word: 'Failed', cls: 'text-danger' },
};

export function HistorySection({ postId, timezone }: { postId: string; timezone: string }) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    const res = await getPostHistoryAction(postId);
    setLoading(false);
    if (res.ok) setEntries(res.entries);
    else setError(res.error);
  };

  return (
    <details
      className="rounded-lg border border-border"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open && entries === null && !loading)
          void load();
      }}
    >
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium select-none">
        History{entries ? ` (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'})` : ''}
      </summary>
      <div className="px-3 pb-3 text-xs">
        {loading ? <p className="text-muted">Loading…</p> : null}
        {error ? (
          <p className="text-danger">
            {error}{' '}
            <button type="button" className="underline" onClick={() => void load()}>
              Try again
            </button>
          </p>
        ) : null}
        {entries && entries.length === 0 ? (
          <p className="text-muted">Nothing has been sent to the platforms yet.</p>
        ) : null}
        {entries && entries.length > 0 ? (
          <ol className="divide-y divide-border">
            {entries.map((h) => {
              const o = OUTCOME[h.outcome];
              return (
                <li key={h.id} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-3">
                  <span className="shrink-0 tabular-nums text-muted sm:w-36">
                    {formatWhen(h.at, timezone)}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <PlatformChip platform={h.platform} />
                      <span>{STEP_LABEL[h.step] ?? h.step}</span>
                      <span className={cn('font-medium', o.cls)}>
                        <span aria-hidden>{o.icon}</span> {o.word}
                      </span>
                      {h.httpStatus ? (
                        <span className="text-muted">HTTP {h.httpStatus}</span>
                      ) : null}
                      {h.platformCode ? (
                        <span className="text-muted">code {h.platformCode}</span>
                      ) : null}
                    </span>
                    {h.message ? <span className="break-words text-muted">{h.message}</span> : null}
                  </span>
                </li>
              );
            })}
          </ol>
        ) : null}
      </div>
    </details>
  );
}
