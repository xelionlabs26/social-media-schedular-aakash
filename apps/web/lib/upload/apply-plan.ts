/**
 * "Apply to all": works out exactly which cards change, so the confirmation dialog can list
 * them before anything is saved (PLAN.md §3.2 step 3). The server applies the same rules
 * (service.applyBatchSettings uses planTargetChanges). Pure and client-safe.
 */
import type { AssetStatus, Platform, TargetStatus } from '@app/db';
import { PLATFORM_ORDER } from '@app/core/platforms';
import type { BatchSettings, WhenRule } from './types';

/** Which targets to add, delete (drafts only) and keep (past draft) to match `platforms`. */
export function planTargetChanges<T extends { platform: Platform; status: TargetStatus }>(
  targets: T[],
  platforms: Platform[],
) {
  const active = targets.filter((t) => t.status !== 'canceled');
  const have = new Set(active.map((t) => t.platform));
  const extra = active.filter((t) => !platforms.includes(t.platform));
  return {
    add: PLATFORM_ORDER.filter((p) => platforms.includes(p) && !have.has(p)),
    remove: extra.filter((t) => t.status === 'draft'),
    keep: extra.filter((t) => t.status !== 'draft'),
  };
}

export interface ApplyCardInput {
  assetId: string;
  filename: string;
  notes: string;
  assetStatus: AssetStatus;
  /** null while the upload hasn't finished (no targets yet). */
  targets: Array<{ platform: Platform; status: TargetStatus }> | null;
}

export interface ApplyCardChange {
  assetId: string;
  filename: string;
  add: Platform[];
  remove: Platform[];
  /** Platforms turned off but left in place because they are scheduled or later. */
  keep: Array<{ platform: Platform; status: TargetStatus }>;
  notesChanged: boolean;
  /** Upload not finished: it simply takes the new settings when it completes. */
  pendingUpload: boolean;
}

export interface ApplyPlan {
  /** Cards that change (or keep something), in card order. */
  changes: ApplyCardChange[];
  unchanged: number;
  total: number;
  /** Batch-level "When" change, applied when the owner clicks Schedule. */
  when: { from: WhenRule; to: WhenRule } | null;
  /** Ready videos whose notes change (offer "also rewrite their texts"). */
  readyWithNewNotes: number;
  hasChanges: boolean;
}

export function sameWhen(a: WhenRule, b: WhenRule): boolean {
  if (a.mode !== b.mode) return false;
  return a.mode !== 'next_free' || (a.startDate ?? '') === (b.startDate ?? '');
}

export function computeApplyPlan(
  cards: ApplyCardInput[],
  next: BatchSettings,
  savedWhen: WhenRule | null,
): ApplyPlan {
  const notes = next.notes.trim();
  const changes: ApplyCardChange[] = [];
  let readyWithNewNotes = 0;
  for (const c of cards) {
    const notesChanged = c.notes.trim() !== notes;
    const plan = c.targets
      ? planTargetChanges(c.targets, next.platforms)
      : { add: [], remove: [], keep: [] };
    const change: ApplyCardChange = {
      assetId: c.assetId,
      filename: c.filename,
      add: plan.add,
      remove: plan.remove.map((t) => t.platform),
      keep: plan.keep.map((t) => ({ platform: t.platform, status: t.status })),
      notesChanged,
      pendingUpload: c.targets === null,
    };
    if (notesChanged && c.assetStatus === 'ready') readyWithNewNotes += 1;
    if (change.add.length || change.remove.length || change.keep.length || notesChanged) {
      changes.push(change);
    }
  }
  const when =
    savedWhen && !sameWhen(savedWhen, next.when) ? { from: savedWhen, to: next.when } : null;
  return {
    changes,
    unchanged: cards.length - changes.length,
    total: cards.length,
    when,
    readyWithNewNotes,
    hasChanges:
      changes.some((c) => c.add.length || c.remove.length || c.notesChanged) || when !== null,
  };
}
