'use client';

/**
 * Reorderable card list. Pointer events (not HTML5 drag & drop) so dragging works with a mouse
 * *and* a finger; the handle also moves its card with the arrow keys. The order decides which
 * card gets the earliest free slot, so every change is saved (onReorder).
 */
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { moveKey } from '@/lib/upload/order';
import { GripIcon } from './icons';

interface DragState {
  key: string;
  pointerId: number;
  initial: string[];
}

export function CardList<T>({
  items,
  keyOf,
  labelOf,
  canReorder,
  onReorder,
  renderCard,
}: {
  items: T[];
  keyOf: (item: T) => string;
  labelOf: (item: T) => string;
  canReorder: (item: T) => boolean;
  /** Called with the full new key order after a drag or a keyboard move. */
  onReorder: (keys: string[]) => void;
  renderCard: (item: T, drag: { handle: ReactNode; dragging: boolean }) => ReactNode;
}) {
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const nodes = useRef(new Map<string, HTMLLIElement>());

  const keys = items.map(keyOf);
  const byKey = new Map(items.map((it) => [keyOf(it), it]));
  // While dragging, show the live order; keys that appeared meanwhile go last.
  const order = dragOrder
    ? [...dragOrder.filter((k) => byKey.has(k)), ...keys.filter((k) => !dragOrder.includes(k))]
    : keys;

  const finish = useCallback(
    (state: DragState | null, finalOrder: string[] | null) => {
      setDrag(null);
      setDragOrder(null);
      if (state && finalOrder && finalOrder.join() !== state.initial.join()) onReorder(finalOrder);
    },
    [onReorder],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>, key: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ key, pointerId: e.pointerId, initial: keys });
    setDragOrder(keys);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!drag || e.pointerId !== drag.pointerId || !dragOrder) return;
    // Find the slot under the pointer by comparing with the other cards' midpoints.
    let target = 0;
    for (const k of dragOrder) {
      if (k === drag.key) continue;
      const rect = nodes.current.get(k)?.getBoundingClientRect();
      if (rect && e.clientY > rect.top + rect.height / 2) target += 1;
    }
    const next = moveKey(dragOrder, drag.key, target);
    if (next !== dragOrder) setDragOrder(next);
    // Scroll when the pointer nears the screen edge so long lists can be reordered.
    const edge = 72;
    if (e.clientY < edge) window.scrollBy(0, -12);
    else if (e.clientY > window.innerHeight - edge) window.scrollBy(0, 12);
  };

  const onPointerEnd = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    finish(drag, e.type === 'pointercancel' ? null : dragOrder);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, key: string, label: string) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const from = keys.indexOf(key);
    const next = moveKey(keys, key, from + (e.key === 'ArrowUp' ? -1 : 1));
    if (next === keys) return;
    setAnnouncement(`${label} moved to position ${next.indexOf(key) + 1} of ${next.length}`);
    onReorder(next);
  };

  return (
    <>
      <ol className="space-y-2" aria-label="Videos in this batch">
        {order.map((key) => {
          const item = byKey.get(key)!;
          const label = labelOf(item);
          const reorderable = canReorder(item);
          const handle = reorderable ? (
            <button
              type="button"
              aria-label={`Reorder ${label}`}
              aria-describedby="reorder-hint"
              title="Drag to reorder (or use the arrow keys)"
              className="-ml-1 flex w-6 shrink-0 cursor-grab touch-none items-center justify-center self-stretch rounded-md text-muted hover:bg-surface-2 hover:text-text active:cursor-grabbing"
              onPointerDown={(e) => onPointerDown(e, key)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerEnd}
              onPointerCancel={onPointerEnd}
              onKeyDown={(e) => onKeyDown(e, key, label)}
            >
              <GripIcon className="h-4 w-4" />
            </button>
          ) : (
            <span className="-ml-1 w-6 shrink-0" aria-hidden />
          );
          return (
            <li
              key={key}
              ref={(el) => {
                if (el) nodes.current.set(key, el);
                else nodes.current.delete(key);
              }}
              className={cn(drag?.key === key && 'opacity-95')}
            >
              {renderCard(item, { handle, dragging: drag?.key === key })}
            </li>
          );
        })}
      </ol>
      <p id="reorder-hint" className="sr-only">
        Drag the handle, or press the up and down arrow keys, to change the posting order.
      </p>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </>
  );
}
