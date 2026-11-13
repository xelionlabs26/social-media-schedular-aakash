'use client';

/**
 * The fields of one platform tab (PLAN.md §3.6): Instagram caption + hashtags + "Also share to
 * feed"; YouTube title + description + hashtags + tags + privacy/kids/notify; Facebook text
 * (+ title for normal Page videos) + a one-time [Copy Instagram caption].
 */
import Link from 'next/link';
import { useId } from 'react';
import type { Platform, TargetOptions } from '@app/db';
import type { TargetCard } from '@app/core/posts';
import { PLATFORM_LABELS } from '@app/core/platforms';
import { validateTargetText } from '@app/core/text';
import { StatusBadge } from '@/components/ui/badges';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/field';
import {
  captionWithoutHashtags,
  FIELD_LABELS,
  fieldMeter,
  fieldsFor,
  type EditorField,
} from '@/lib/upload/fields';
import { formatWhen } from '@/lib/upload/time';
import type { AccountState } from '@/lib/upload/types';
import type { SaveStatus } from './autosave';
import { ChipsInput } from './ChipsInput';
import { FieldBlock } from './FieldBlock';
import type { RefineChoice } from './RefineMenu';

export interface TargetDraft {
  title: string;
  body: string;
  hashtags: string[];
  tags: string[];
  options: TargetOptions;
  version: number;
}

/** Statuses in which the text can no longer change. */
export const LOCKED_STATUSES: TargetCard['status'][] = ['publishing', 'published', 'canceled'];

export function PlatformPanel({
  platform,
  draft,
  card,
  hashtagMax,
  timezone,
  account,
  refiningField,
  save,
  instagramBody,
  onField,
  onOptions,
  onRefine,
  onBlur,
  onReload,
  onKeepMine,
}: {
  platform: Platform;
  draft: TargetDraft;
  card: TargetCard;
  hashtagMax: number;
  timezone: string;
  account: AccountState;
  refiningField: EditorField | null;
  save: { status: SaveStatus; error?: string };
  /** For Facebook's "Copy Instagram caption" (undefined when the post has no Instagram). */
  instagramBody?: string;
  onField: (field: EditorField, value: string | string[]) => void;
  onOptions: (patch: Partial<TargetOptions>) => void;
  onRefine: (field: EditorField, action: RefineChoice) => void;
  onBlur: () => void;
  onReload: () => void;
  onKeepMine: () => void;
}) {
  const id = useId();
  const readOnly = LOCKED_STATUSES.includes(card.status);
  const fbKind = draft.options.fbKind;
  const issues = validateTargetText(platform, draft, { fbKind });
  const fields = fieldsFor(platform, { fbKind });
  const labels = FIELD_LABELS[platform];
  const copyText = instagramBody !== undefined ? captionWithoutHashtags(instagramBody) : null;

  const textField = (field: 'title' | 'body') => (
    <FieldBlock
      key={field}
      label={labels[field]!}
      meter={fieldMeter(platform, field, draft, hashtagMax)}
      issues={issues.filter((i) => i.field === field)}
      refining={refiningField === field}
      readOnly={readOnly}
      onRefine={(a) => onRefine(field, a)}
    >
      {({ inputId, describedBy }) =>
        field === 'title' ? (
          <Input
            id={inputId}
            value={draft.title}
            readOnly={readOnly}
            aria-describedby={describedBy}
            onChange={(e) => onField('title', e.target.value)}
            onBlur={onBlur}
          />
        ) : (
          <Textarea
            id={inputId}
            value={draft.body}
            readOnly={readOnly}
            rows={platform === 'youtube' ? 6 : 7}
            aria-describedby={describedBy}
            onChange={(e) => onField('body', e.target.value)}
            onBlur={onBlur}
          />
        )
      }
    </FieldBlock>
  );

  const chipsField = (field: 'hashtags' | 'tags') => (
    <FieldBlock
      key={field}
      label={labels[field]!}
      meter={fieldMeter(platform, field, draft, hashtagMax)}
      issues={issues.filter((i) => i.field === field)}
      refining={refiningField === field}
      readOnly={readOnly}
      onRefine={(a) => onRefine(field, a)}
    >
      {({ inputId, describedBy }) => (
        <ChipsInput
          id={inputId}
          kind={field}
          values={field === 'hashtags' ? draft.hashtags : draft.tags}
          max={field === 'hashtags' ? hashtagMax : undefined}
          readOnly={readOnly}
          describedBy={describedBy}
          onChange={(next) => onField(field, next)}
          onBlur={onBlur}
        />
      )}
    </FieldBlock>
  );

  return (
    <div className="space-y-5">
      {/* Status of this platform */}
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={card.display} detail={card.overdue ? 'overdue' : card.attention} />
          {card.scheduledAt ? (
            <span className="text-xs text-muted">{formatWhen(card.scheduledAt, timezone)}</span>
          ) : null}
          {card.remoteUrl ? (
            <a
              href={card.remoteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-accent hover:underline"
            >
              View on {PLATFORM_LABELS[platform]} ↗
            </a>
          ) : null}
          <SaveIndicator save={save} onReload={onReload} onKeepMine={onKeepMine} />
        </div>
        {card.note ? <p className="text-xs text-muted">Note: {card.note}</p> : null}
        {account.state !== 'connected' ? (
          <p className="text-xs text-warn">
            {PLATFORM_LABELS[platform]} is{' '}
            {account.state === 'needs_reauth' ? 'disconnected (reconnect needed)' : 'not connected'}
            .{' '}
            <Link href="/settings#accounts" className="underline">
              Connect in Settings
            </Link>
          </p>
        ) : null}
        {readOnly ? (
          <p className="text-xs text-muted">
            {card.status === 'published'
              ? 'Published: the text can no longer be changed here.'
              : 'Being published right now: edits are locked.'}
          </p>
        ) : null}
      </div>

      {platform === 'facebook' && copyText !== null && !readOnly ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={!copyText || copyText === draft.body}
            onClick={() => onField('body', copyText)}
          >
            Copy Instagram caption
          </Button>
          <span className="text-xs text-muted">Copies the caption without its hashtags.</span>
        </div>
      ) : null}

      {fields.map((f) => (f === 'title' || f === 'body' ? textField(f) : chipsField(f)))}

      {/* Options */}
      {platform === 'instagram' ? (
        <Toggle
          id={`${id}-feed`}
          label="Also share to feed"
          hint="The Reel also appears in your main profile grid."
          checked={draft.options.shareToFeed ?? true}
          disabled={readOnly}
          onChange={(v) => onOptions({ shareToFeed: v })}
        />
      ) : null}
      {platform === 'youtube' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor={`${id}-privacy`} className="text-sm font-medium">
              Privacy
            </label>
            <Select
              id={`${id}-privacy`}
              value={draft.options.privacy ?? 'public'}
              disabled={readOnly}
              onChange={(e) =>
                onOptions({ privacy: e.target.value as NonNullable<TargetOptions['privacy']> })
              }
            >
              <option value="public">Public</option>
              <option value="unlisted">Unlisted</option>
              <option value="private">Private</option>
            </Select>
          </div>
          <div className="space-y-3 sm:pt-6">
            <Toggle
              id={`${id}-kids`}
              label="Made for kids"
              checked={draft.options.madeForKids ?? false}
              disabled={readOnly}
              onChange={(v) => onOptions({ madeForKids: v })}
            />
            <Toggle
              id={`${id}-notify`}
              label="Notify subscribers"
              checked={draft.options.notifySubscribers ?? true}
              disabled={readOnly}
              onChange={(v) => onOptions({ notifySubscribers: v })}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Toggle({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        type="checkbox"
        role="switch"
        aria-checked={checked}
        className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
        checked={checked}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div>
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {hint ? (
          <p id={`${id}-hint`} className="text-xs text-muted">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function SaveIndicator({
  save,
  onReload,
  onKeepMine,
}: {
  save: { status: SaveStatus; error?: string };
  onReload: () => void;
  onKeepMine: () => void;
}) {
  const text: Record<SaveStatus, string> = {
    idle: '',
    pending: 'Unsaved changes…',
    saving: 'Saving…',
    saved: 'Saved',
    error: save.error ? `Not saved: ${save.error}` : 'Not saved',
    conflict: save.error ?? 'Changed elsewhere',
  };
  return (
    <span className="ml-auto flex flex-wrap items-center gap-2 text-xs" aria-live="polite">
      <span
        className={
          save.status === 'error' || save.status === 'conflict' ? 'text-danger' : 'text-muted'
        }
      >
        {text[save.status]}
      </span>
      {save.status === 'conflict' ? (
        <>
          <button type="button" className="text-accent underline" onClick={onReload}>
            Load latest
          </button>
          <button type="button" className="text-accent underline" onClick={onKeepMine}>
            Keep mine
          </button>
        </>
      ) : null}
      {save.status === 'error' ? (
        <button type="button" className="text-accent underline" onClick={onKeepMine}>
          Retry
        </button>
      ) : null}
    </span>
  );
}
