'use client';

/**
 * "Apply to all" confirmation: lists exactly which cards change and how, before saving
 * (PLAN.md §3.2: "A confirmation lists exactly which cards will change").
 */
import { PLATFORM_LABELS } from '@app/core/platforms';
import { ConfirmDialog } from '@/components/ui/confirm';
import type { ApplyPlan } from '@/lib/upload/apply-plan';
import { formatLocalDate } from '@/lib/upload/time';
import type { WhenRule } from '@/lib/upload/types';

export function describeWhen(when: WhenRule, tz: string): string {
  if (when.mode === 'pick') return 'Pick date & time on each card';
  if (when.mode === 'draft') return 'Save as drafts';
  return when.startDate
    ? `Next free slot from ${formatLocalDate(when.startDate, tz)}`
    : 'Next free slot';
}

export function ApplyDialog({
  open,
  plan,
  timezone,
  rewriteReady,
  onRewriteReadyChange,
  loading,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  plan: ApplyPlan | null;
  timezone: string;
  rewriteReady: boolean;
  onRewriteReadyChange: (v: boolean) => void;
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!plan) return null;
  const changing = plan.changes.filter((c) => c.add.length || c.remove.length || c.notesChanged);
  const title = plan.hasChanges
    ? `Apply to ${changing.length} of ${plan.total} video${plan.total === 1 ? '' : 's'}?`
    : 'Nothing to change';
  return (
    <ConfirmDialog
      open={open}
      title={title}
      confirmLabel={plan.hasChanges ? 'Apply' : 'OK'}
      loading={loading}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {plan.hasChanges ? (
        <div className="space-y-3">
          {plan.when ? (
            <p>
              <span className="font-medium text-text">When:</span>{' '}
              {describeWhen(plan.when.to, timezone)}{' '}
              <span className="text-xs">(was: {describeWhen(plan.when.from, timezone)})</span>
            </p>
          ) : null}
          {plan.changes.length ? (
            <ul
              className="max-h-64 space-y-1.5 overflow-y-auto rounded-lg border border-border p-2"
              aria-label="Cards that change"
            >
              {plan.changes.map((c) => (
                <li key={c.assetId} className="text-xs leading-relaxed">
                  <span className="font-medium break-all text-text">{c.filename}</span>
                  <span className="block">
                    {[
                      ...c.add.map((p) => `+ ${PLATFORM_LABELS[p]}`),
                      ...c.remove.map((p) => `− ${PLATFORM_LABELS[p]} (draft deleted)`),
                      c.notesChanged ? 'notes updated' : null,
                      ...c.keep.map(
                        (k) =>
                          `${PLATFORM_LABELS[k.platform]} kept (already ${k.status === 'published' ? 'published' : 'scheduled'})`,
                      ),
                      c.pendingUpload && (c.add.length || c.remove.length)
                        ? 'platforms apply when the upload finishes'
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {plan.unchanged > 0 ? (
            <p className="text-xs">
              {plan.unchanged} video{plan.unchanged === 1 ? '' : 's'} already match.
            </p>
          ) : null}
          {changing.some((c) => c.add.length) ? (
            <p className="text-xs">The AI writes the text for newly added platforms.</p>
          ) : null}
          {plan.readyWithNewNotes > 0 ? (
            <label className="flex items-start gap-2 text-xs text-text">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
                checked={rewriteReady}
                onChange={(e) => onRewriteReadyChange(e.target.checked)}
              />
              <span>
                Also rewrite the texts of the {plan.readyWithNewNotes} video
                {plan.readyWithNewNotes === 1 ? '' : 's'} already written, using the new notes (text
                you typed yourself is kept).
              </span>
            </label>
          ) : null}
        </div>
      ) : (
        <p>Every video already uses these settings.</p>
      )}
    </ConfirmDialog>
  );
}
