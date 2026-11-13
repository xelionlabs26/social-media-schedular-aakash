'use client';

/**
 * Red "Needs attention" bar (PLAN.md §3.4): each failing platform target with its plain reason
 * and the fixes [Reconnect] [Retry now] [Next free slot] [Open].
 */
import Link from 'next/link';
import { useState } from 'react';
import { formatShort } from '@app/core/time';
import { retryTargetAction } from '@/lib/actions/calendar';
import { Button } from '@/components/ui/button';
import { PlatformChip } from '@/components/ui/badges';
import { useCalendar } from './context';
import type { AttentionItem } from './types';

const COLLAPSED = 3;

export function AttentionBanner({ items }: { items: AttentionItem[] }) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const shown = expanded ? items : items.slice(0, COLLAPSED);
  return (
    <section
      aria-labelledby="attention-title"
      className="rounded-[--radius-card] border border-danger/40 bg-danger/5 p-3"
    >
      <h2
        id="attention-title"
        className="flex items-center gap-2 text-sm font-semibold text-danger"
      >
        <span
          aria-hidden
          className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-danger text-xs text-white"
        >
          !
        </span>
        {items.length} need{items.length === 1 ? 's' : ''} attention
      </h2>
      <ul className="mt-2 space-y-2">
        {shown.map((it) => (
          <AttentionRow key={it.targetId} item={it} />
        ))}
      </ul>
      {items.length > COLLAPSED ? (
        <button
          type="button"
          className="mt-2 text-xs font-medium text-danger hover:underline"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      ) : null}
    </section>
  );
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const { openPost, runAction, pending, timezone } = useCalendar();
  return (
    <li className="rounded-lg bg-surface p-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <PlatformChip platform={item.platform} />
        <span className="min-w-0 max-w-full truncate font-medium" title={item.filename}>
          ‘{item.filename}’
        </span>
        <span className="text-danger">
          <span aria-hidden>! </span>
          {item.message}
        </span>
        {item.scheduledAt ? (
          <span className="text-xs text-muted">
            {formatShort(new Date(item.scheduledAt), timezone)}
          </span>
        ) : null}
      </div>
      {item.lastError ? (
        <p className="mt-1 line-clamp-2 text-xs text-muted" title={item.lastError}>
          {item.lastError}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {item.reconnect ? (
          <Link
            href="/settings#accounts"
            className="inline-flex h-8 items-center rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg hover:opacity-90"
          >
            Reconnect
          </Link>
        ) : null}
        <Button
          size="sm"
          disabled={pending}
          onClick={() => runAction(() => retryTargetAction(item.targetId, 'now'))}
        >
          Retry now
        </Button>
        <Button
          size="sm"
          disabled={pending}
          onClick={() => runAction(() => retryTargetAction(item.targetId, 'next_free'))}
        >
          Next free slot
        </Button>
        <Button size="sm" variant="ghost" onClick={() => openPost(item.postId)}>
          Open
        </Button>
      </div>
    </li>
  );
}
