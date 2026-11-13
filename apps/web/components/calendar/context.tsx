'use client';

/**
 * Shared Calendar state for the client components: drag & drop, opening the editor and running
 * server actions with a toast + refresh.
 */
import { createContext, useContext } from 'react';
import type { ActionResult } from './action-result';

export interface DragItem {
  postId: string;
  /** 'post' = already on the calendar (keeps its time); 'draft' = from the drafts tray. */
  kind: 'post' | 'draft';
}

export interface DropTarget {
  date: string;
  /** Set when dropped on a free-slot marker: take that slot's time. */
  time?: string;
}

export interface CalendarCtx {
  timezone: string;
  tzLabel: string;
  today: string;
  now: Date;
  pending: boolean;
  drag: DragItem | null;
  setDrag: (d: DragItem | null) => void;
  drop: (target: DropTarget, item?: DragItem | null) => void;
  openPost: (postId: string) => void;
  runAction: (fn: () => Promise<ActionResult<unknown>>) => void;
}

export const CalendarContext = createContext<CalendarCtx | null>(null);

export function useCalendar(): CalendarCtx {
  const ctx = useContext(CalendarContext);
  if (!ctx) throw new Error('useCalendar must be used inside CalendarClient');
  return ctx;
}

/** Props that make an element a drop zone for calendar cards. */
export function useDropZone(
  target: DropTarget,
  onHover: (hovering: boolean) => void,
): {
  onDragOver: React.DragEventHandler;
  onDragEnter: React.DragEventHandler;
  onDragLeave: React.DragEventHandler;
  onDrop: React.DragEventHandler;
} {
  const { drag, drop } = useCalendar();
  return {
    onDragOver: (e) => {
      if (!drag) return;
      e.preventDefault(); // allows dropping
      e.dataTransfer.dropEffect = 'move';
    },
    onDragEnter: (e) => {
      if (!drag) return;
      e.preventDefault();
      onHover(true);
    },
    onDragLeave: (e) => {
      // Ignore leave events fired when moving over a child element.
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      onHover(false);
    },
    onDrop: (e) => {
      e.preventDefault();
      e.stopPropagation();
      onHover(false);
      drop(target);
    },
  };
}
