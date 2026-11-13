'use client';

/**
 * A post card on the calendar: thumbnail, local time, filename and one status chip per
 * platform. Drag it to another day (pointer) or use the ⋯ menu's "Move to…" (keyboard/touch).
 */
import { StatusBadge } from '@/components/ui/badges';
import { cn } from '@/lib/cn';
import { CardMenu } from './CardMenu';
import { useCalendar } from './context';
import { PlatformStatusChip } from './PlatformStatus';
import { Thumb } from './Thumb';
import type { CalendarPost } from './types';

function useDraggable(post: CalendarPost, kind: 'post' | 'draft') {
  const { setDrag } = useCalendar();
  const canDrag = post.movable && post.display !== 'processing';
  return {
    draggable: canDrag,
    onDragStart: (e: React.DragEvent) => {
      if (!canDrag) return;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', post.id);
      setDrag({ postId: post.id, kind });
    },
    onDragEnd: () => setDrag(null),
  };
}

/** Week / day card. */
export function PostTile({ post }: { post: CalendarPost }) {
  const { openPost, drag, tzLabel } = useCalendar();
  const dnd = useDraggable(post, 'post');
  const isDraft = post.display === 'draft' && post.targets.every((t) => t.display === 'draft');
  return (
    <div
      {...dnd}
      className={cn(
        'group relative rounded-lg border border-border bg-surface p-1.5 shadow-sm',
        dnd.draggable && 'cursor-grab active:cursor-grabbing',
        drag?.postId === post.id && 'opacity-50',
        post.display === 'needs_attention' && 'border-danger/40',
      )}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={() => openPost(post.id)}
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
          aria-label={`Open ${post.filename}${post.localTime ? `, ${post.localTime} ${tzLabel}` : ''}`}
        >
          <Thumb url={post.thumbUrl} className="w-9" />
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-semibold tabular-nums">
              {post.localTime ?? '–'}
            </span>
            <span
              className="line-clamp-2 block text-xs text-muted [overflow-wrap:anywhere]"
              title={post.filename}
            >
              {post.filename}
            </span>
          </span>
        </button>
        <CardMenu post={post} isDraft={false} className="-mr-1 -mt-0.5" />
      </div>
      {post.processingLabel ? (
        <p className="mt-1 truncate text-[11px] text-muted">{post.processingLabel}…</p>
      ) : null}
      <div className="mt-1.5 flex flex-wrap gap-1">
        {isDraft || post.display === 'processing' ? (
          <StatusBadge
            status={post.display}
            detail={post.overdue ? 'overdue' : null}
            className="text-[11px]"
          />
        ) : (
          post.targets.map((t) => (
            <PlatformStatusChip
              key={t.id}
              platform={t.platform}
              display={t.display}
              overdue={t.overdue}
              detail={t.attention}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** Compact entry for month cells: time + filename, then one icon per platform. */
export function PostLine({ post }: { post: CalendarPost }) {
  const { openPost, drag } = useCalendar();
  const dnd = useDraggable(post, 'post');
  return (
    <div
      {...dnd}
      className={cn(
        'rounded px-1 py-0.5 text-[11px] hover:bg-surface-2',
        dnd.draggable && 'cursor-grab',
        drag?.postId === post.id && 'opacity-50',
      )}
    >
      <button
        type="button"
        onClick={() => openPost(post.id)}
        className="flex w-full min-w-0 items-center gap-1 text-left"
        title={`${post.localTime ?? ''} ${post.filename}`}
      >
        <span className="font-semibold tabular-nums">{post.localTime}</span>
        <span className="min-w-0 flex-1 truncate text-muted">{post.filename}</span>
      </button>
      <StatusIcons post={post} />
    </div>
  );
}

/** Icons only (one per platform) with a screen-reader sentence. */
export function StatusIcons({ post }: { post: CalendarPost }) {
  return (
    <span className="mt-0.5 flex flex-wrap gap-0.5">
      {post.targets.map((t) => (
        <PlatformStatusChip
          key={t.id}
          platform={t.platform}
          display={t.display}
          overdue={t.overdue}
          detail={t.attention}
          compact
        />
      ))}
    </span>
  );
}

/** Drafts tray item. */
export function DraftChip({ post }: { post: CalendarPost }) {
  const { openPost, drag } = useCalendar();
  const dnd = useDraggable(post, 'draft');
  return (
    <div
      {...dnd}
      className={cn(
        'flex w-44 shrink-0 items-center gap-2 rounded-lg border border-border bg-surface p-1.5',
        dnd.draggable && 'cursor-grab active:cursor-grabbing',
        drag?.postId === post.id && 'opacity-50',
      )}
    >
      <button
        type="button"
        onClick={() => openPost(post.id)}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <Thumb url={post.thumbUrl} className="w-8" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium" title={post.filename}>
            {post.filename}
          </span>
          <StatusBadge status={post.display} className="mt-0.5 px-1.5 text-[10px]" />
          {post.processingLabel ? (
            <span className="block truncate text-[10px] text-muted">{post.processingLabel}…</span>
          ) : null}
        </span>
      </button>
      <CardMenu post={post} isDraft className="self-start" />
    </div>
  );
}
