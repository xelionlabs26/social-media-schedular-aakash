'use client';

/**
 * One video = one card (PLAN.md §3.6): thumbnail, name, length, shape, platforms, time, status
 * with the current step, upload progress, warnings, the first lines of the texts, and [Edit].
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { AssetWarning, Platform } from '@app/db';
import type { PostCard, TargetCard } from '@app/core/posts';
import { RULES } from '@app/core/platforms';
import { charCount, composeFinalBody } from '@app/core/text';
import { DISPLAY_STATUS_ICON, DISPLAY_STATUS_LABEL } from '@app/core/status';
import { Badge, PlatformChip, StatusBadge } from '@/components/ui/badges';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import type { CardModel } from '@/lib/upload/card-model';
import { FILE_INPUT_ACCEPT } from '@/lib/upload/constants';
import { firstLine, formatBytes, formatDuration, shapeLabel } from '@/lib/upload/format';
import {
  formatWhen,
  localInputToUtc,
  minLocalInput,
  utcToLocalInput,
  zoneLabel,
} from '@/lib/upload/time';
import { BlockIcon, FilmIcon, InfoIcon, WarnIcon } from './icons';

export interface AssetCardProps {
  filename: string;
  sizeBytes: number;
  model: CardModel;
  post: PostCard | null;
  timezone: string;
  /** "Pick date & time on each card" is selected in the batch bar. */
  pickMode: boolean;
  dragHandle?: ReactNode;
  dragging?: boolean;
  onEdit?: () => void;
  onRetryUpload?: () => void;
  onCancelUpload?: () => void;
  onRemove?: () => void;
  onReselect?: (file: File) => void;
  onRetryProcessing?: () => void;
  onPickTime?: (at: Date | null) => Promise<boolean>;
}

export function AssetCard(props: AssetCardProps) {
  const { filename, sizeBytes, model, post, timezone } = props;
  const shape = shapeLabel(model.width, model.height);
  const headingId = useId();
  return (
    <article
      aria-labelledby={headingId}
      className={cn(
        'flex gap-3 rounded-xl border border-border bg-surface p-3 transition-shadow',
        props.dragging && 'relative z-10 shadow-lg ring-2 ring-accent',
      )}
    >
      {props.dragHandle}
      <Thumb src={model.thumb} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-start gap-2">
          <h3
            id={headingId}
            className="min-w-0 flex-1 truncate text-sm font-semibold"
            title={filename}
          >
            {filename}
          </h3>
          {model.canEdit && props.onEdit ? (
            <Button size="sm" onClick={props.onEdit} aria-label={`Edit ${filename}`}>
              Edit
            </Button>
          ) : null}
        </div>

        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span>{formatDuration(model.durationMs)}</span>
          {shape ? <Badge>{shape}</Badge> : null}
          <span>{formatBytes(sizeBytes)}</span>
        </p>

        {model.platforms.length || model.when ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {model.platforms.map((p) => (
              <span key={p.platform} className="inline-flex items-center gap-0.5">
                <PlatformChip platform={p.platform} />
                <span
                  className={cn(
                    'text-[11px]',
                    p.status === 'needs_attention' ? 'text-danger' : 'text-muted',
                  )}
                  aria-hidden
                >
                  {DISPLAY_STATUS_ICON[p.status]}
                </span>
                <span className="sr-only">
                  {p.label}: {DISPLAY_STATUS_LABEL[p.status]}
                </span>
              </span>
            ))}
            {model.when ? (
              <span className="text-xs tabular-nums text-text">
                {formatWhen(model.when, timezone)}
                {model.whenVaries ? <span className="text-muted"> · varies by app</span> : null}
              </span>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge
            status={model.status}
            detail={model.detail}
            className="max-w-full truncate"
          />
        </div>

        {model.progress !== null ? (
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
            role="progressbar"
            aria-label={`Upload progress for ${filename}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={model.progress}
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-300"
              style={{ width: `${model.progress}%` }}
            />
          </div>
        ) : null}

        <Warnings warnings={model.warnings} />
        {post && post.asset.status === 'ready' ? <TextPreview targets={post.targets} /> : null}

        {props.pickMode && post && model.allDrafts && props.onPickTime ? (
          <CardTimePicker
            filename={filename}
            timezone={timezone}
            value={model.when}
            onCommit={props.onPickTime}
          />
        ) : null}

        <CardActions {...props} />
      </div>
    </article>
  );
}

function Thumb({ src }: { src: string | null }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  return (
    <div className="flex aspect-[9/16] w-14 shrink-0 self-start items-center justify-center overflow-hidden rounded-lg bg-surface-2 text-muted sm:w-16">
      {src && !broken ? (
        // Plain <img>: signed storage URLs change and need no Next image optimization.
        <img
          src={src}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setBroken(true)}
        />
      ) : (
        <FilmIcon className="h-6 w-6" />
      )}
    </div>
  );
}

const WARN_STYLE: Record<AssetWarning['severity'], { icon: ReactNode; cls: string; word: string }> =
  {
    block: { icon: <BlockIcon />, cls: 'text-danger', word: 'Problem' },
    warn: { icon: <WarnIcon />, cls: 'text-warn', word: 'Warning' },
    info: { icon: <InfoIcon />, cls: 'text-muted', word: 'Note' },
  };

function Warnings({ warnings }: { warnings: AssetWarning[] }) {
  const [all, setAll] = useState(false);
  if (!warnings.length) return null;
  const shown = all ? warnings : warnings.slice(0, 2);
  return (
    <ul className="space-y-0.5">
      {shown.map((w, i) => {
        const s = WARN_STYLE[w.severity];
        return (
          <li
            key={`${w.code}-${w.platform ?? ''}-${i}`}
            className={cn('flex gap-1.5 text-xs', s.cls)}
          >
            <span className="mt-0.5 shrink-0">{s.icon}</span>
            <span className="min-w-0">
              <span className="sr-only">{s.word}: </span>
              {w.message}
            </span>
          </li>
        );
      })}
      {warnings.length > 2 ? (
        <li>
          <button
            type="button"
            className="text-xs text-accent hover:underline"
            onClick={() => setAll((v) => !v)}
            aria-expanded={all}
          >
            {all ? 'Show fewer' : `+${warnings.length - 2} more`}
          </button>
        </li>
      ) : null}
    </ul>
  );
}

function MiniCounter({ value, max, what }: { value: number; max: number; what: string }) {
  const over = value > max;
  return (
    <span
      className={cn(
        'shrink-0 text-[11px] tabular-nums',
        over ? 'font-semibold text-danger' : 'text-muted',
      )}
      title={`${what}: ${value} of ${max}`}
    >
      {value}/{max}
      {over ? <span className="sr-only"> (over the limit)</span> : null}
    </span>
  );
}

function PreviewLine({
  platform,
  label,
  text,
  value,
  max,
}: {
  platform: Platform;
  label: string;
  text: string;
  value: number;
  max: number;
}) {
  return (
    <li className="flex items-baseline gap-2 text-xs">
      <PlatformChip platform={platform} className="shrink-0" />
      <span className={cn('min-w-0 flex-1 truncate', text ? 'text-text' : 'italic text-muted')}>
        <span className="sr-only">{label}: </span>
        {text ? `“${text}”` : 'No text yet'}
      </span>
      <MiniCounter value={value} max={max} what={label} />
    </li>
  );
}

function TextPreview({ targets }: { targets: TargetCard[] }) {
  const ig = targets.find((t) => t.platform === 'instagram');
  const yt = targets.find((t) => t.platform === 'youtube');
  const fb = targets.find((t) => t.platform === 'facebook');
  if (!ig && !yt && !fb) return null;
  return (
    <ul className="space-y-1 border-t border-border pt-1.5">
      {ig ? (
        <PreviewLine
          platform="instagram"
          label="Instagram caption"
          text={firstLine(ig.body)}
          value={charCount(composeFinalBody('instagram', ig.body, ig.hashtags))}
          max={RULES.instagram.captionMaxChars}
        />
      ) : null}
      {yt ? (
        <PreviewLine
          platform="youtube"
          label="YouTube title"
          text={firstLine(yt.title)}
          value={charCount(yt.title.trim())}
          max={RULES.youtube.titleMaxChars}
        />
      ) : null}
      {!ig && !yt && fb ? (
        <PreviewLine
          platform="facebook"
          label="Facebook text"
          text={firstLine(fb.body)}
          value={charCount(composeFinalBody('facebook', fb.body, fb.hashtags))}
          max={RULES.facebook.descriptionMaxChars}
        />
      ) : null}
    </ul>
  );
}

function CardTimePicker({
  filename,
  timezone,
  value,
  onCommit,
}: {
  filename: string;
  timezone: string;
  value: Date | null;
  onCommit: (at: Date | null) => Promise<boolean>;
}) {
  const id = useId();
  const committed = utcToLocalInput(value, timezone);
  const [text, setText] = useState(committed);
  const [saving, setSaving] = useState(false);
  const last = useRef(committed);
  // Follow server changes (e.g. the editor set a time) unless the owner is mid-edit.
  useEffect(() => {
    if (committed !== last.current) {
      last.current = committed;
      setText(committed);
    }
  }, [committed]);

  const commit = async () => {
    if (text === last.current) return;
    const at = text ? localInputToUtc(text, timezone) : null;
    if (text && !at) return;
    setSaving(true);
    const ok = await onCommit(at);
    setSaving(false);
    if (ok) last.current = text;
    else setText(last.current);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <label htmlFor={id} className="text-xs font-medium">
        Post at ({zoneLabel(timezone)})
      </label>
      <input
        id={id}
        type="datetime-local"
        className="h-8 rounded-lg border border-border bg-surface px-2 text-xs text-text focus:border-accent focus:outline-none"
        value={text}
        min={minLocalInput(timezone)}
        aria-describedby={`${id}-hint`}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit();
        }}
      />
      <span id={`${id}-hint`} className="text-[11px] text-muted" aria-live="polite">
        {saving ? 'Saving…' : text ? '' : `Pick a time for ${filename}`}
      </span>
    </div>
  );
}

function CardActions(props: AssetCardProps) {
  const { model, filename } = props;
  const reselect = useRef<HTMLInputElement>(null);
  const buttons: ReactNode[] = [];
  if (model.phase === 'upload_failed') {
    if (props.onRetryUpload)
      buttons.push(
        <Button key="retry" size="sm" variant="primary" onClick={props.onRetryUpload}>
          Retry
        </Button>,
      );
    if (props.onRemove)
      buttons.push(
        <Button key="remove" size="sm" variant="ghost" onClick={props.onRemove}>
          Remove
        </Button>,
      );
  } else if (model.phase === 'uploading' || model.phase === 'preparing') {
    if (props.onCancelUpload)
      buttons.push(
        <Button key="cancel" size="sm" variant="ghost" onClick={props.onCancelUpload}>
          Cancel
        </Button>,
      );
  } else if (model.phase === 'interrupted') {
    if (props.onReselect)
      buttons.push(
        <Button
          key="reselect"
          size="sm"
          variant="primary"
          onClick={() => reselect.current?.click()}
        >
          Choose file again
        </Button>,
      );
    if (props.onRemove)
      buttons.push(
        <Button key="remove" size="sm" variant="ghost" onClick={props.onRemove}>
          Remove
        </Button>,
      );
  } else if (model.canRetryProcessing && props.onRetryProcessing) {
    buttons.push(
      <Button key="retryp" size="sm" onClick={props.onRetryProcessing}>
        Retry processing
      </Button>,
    );
  }
  if (!buttons.length) return null;
  return (
    <div className="flex flex-wrap gap-2 pt-1" aria-label={`Actions for ${filename}`} role="group">
      {buttons}
      {model.phase === 'interrupted' && props.onReselect ? (
        <input
          ref={reselect}
          type="file"
          accept={FILE_INPUT_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) props.onReselect?.(file);
          }}
        />
      ) : null}
    </div>
  );
}
