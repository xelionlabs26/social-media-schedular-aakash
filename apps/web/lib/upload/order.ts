/**
 * Card order (the order "Next free slot" fills slots in). Pure and client-safe.
 *   name      – natural filename order (default; how startUploads assigns sortIndex)
 *   selection – the order the files were picked or dropped
 *   added     – newest uploads first
 *   custom    – whatever drag & drop produced
 */
import { compareNames } from './format';

export type OrderMode = 'name' | 'selection' | 'added' | 'custom';

export const ORDER_LABELS: Record<OrderMode, string> = {
  name: 'Name',
  selection: 'Selection',
  added: 'Date added',
  custom: 'Custom',
};

export interface Orderable {
  assetId: string;
  filename: string;
  createdAt: Date | string;
  sortIndex: number;
}

const time = (d: Date | string) => (d instanceof Date ? d.getTime() : new Date(d).getTime());

/** Asset ids sorted for a mode ('custom' keeps the current sortIndex order). */
export function sortForMode<T extends Orderable>(items: T[], mode: OrderMode): string[] {
  const list = [...items];
  if (mode === 'name') {
    list.sort(
      (a, b) => compareNames(a.filename, b.filename) || time(a.createdAt) - time(b.createdAt),
    );
  } else if (mode === 'selection') {
    list.sort((a, b) => time(a.createdAt) - time(b.createdAt) || a.sortIndex - b.sortIndex);
  } else if (mode === 'added') {
    list.sort((a, b) => time(b.createdAt) - time(a.createdAt) || a.sortIndex - b.sortIndex);
  } else {
    list.sort((a, b) => a.sortIndex - b.sortIndex || time(a.createdAt) - time(b.createdAt));
  }
  return list.map((i) => i.assetId);
}

/** Which mode the current order matches (name first, as it's the default). */
export function detectOrder<T extends Orderable>(items: T[]): OrderMode {
  const current = sortForMode(items, 'custom').join();
  for (const mode of ['name', 'selection', 'added'] as const) {
    if (sortForMode(items, mode).join() === current) return mode;
  }
  return 'custom';
}

/** Applies an id order as sortIndex 0..n-1 (ids not listed keep their place after them). */
export function applyOrder<T extends Orderable>(items: T[], ids: string[]): T[] {
  const pos = new Map(ids.map((id, i) => [id, i]));
  return items
    .map((it) => ({ ...it, sortIndex: pos.get(it.assetId) ?? ids.length + it.sortIndex }))
    .sort((a, b) => a.sortIndex - b.sortIndex);
}

/** Moves `key` to position `to` (clamped). Returns the same array when nothing moves. */
export function moveKey(keys: string[], key: string, to: number): string[] {
  const from = keys.indexOf(key);
  if (from < 0) return keys;
  const target = Math.max(0, Math.min(keys.length - 1, to));
  if (target === from) return keys;
  const next = keys.filter((k) => k !== key);
  next.splice(target, 0, key);
  return next;
}
