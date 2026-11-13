import type { Platform } from '@app/db';
import { DISPLAY_STATUS_ICON, DISPLAY_STATUS_LABEL, type DisplayStatus } from '@app/core/status';
import { cn } from '@/lib/cn';

const STATUS_STYLE: Record<DisplayStatus, string> = {
  processing: 'bg-surface-2 text-muted',
  draft: 'bg-surface-2 text-text',
  scheduled: 'bg-info/10 text-info',
  publishing: 'bg-warn/10 text-warn',
  published: 'bg-ok/10 text-ok',
  needs_attention: 'bg-danger/10 text-danger',
};

/** Icon + word, never color alone. */
export function StatusBadge({
  status,
  detail,
  className,
}: {
  status: DisplayStatus;
  detail?: string | null;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        STATUS_STYLE[status],
        className,
      )}
      title={detail ?? undefined}
    >
      <span aria-hidden>{DISPLAY_STATUS_ICON[status]}</span>
      {DISPLAY_STATUS_LABEL[status]}
      {detail ? <span className="font-normal">· {detail}</span> : null}
    </span>
  );
}

const PLATFORM_STYLE: Record<Platform, { label: string; short: string; color: string }> = {
  instagram: { label: 'Instagram', short: 'IG', color: 'text-ig border-ig/30' },
  youtube: { label: 'YouTube', short: 'YT', color: 'text-yt border-yt/30' },
  facebook: { label: 'Facebook', short: 'FB', color: 'text-fb border-fb/30' },
};

export function PlatformChip({
  platform,
  full,
  className,
}: {
  platform: Platform;
  full?: boolean;
  className?: string;
}) {
  const p = PLATFORM_STYLE[platform];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-semibold tracking-wide',
        p.color,
        className,
      )}
      title={p.label}
    >
      {full ? p.label : p.short}
    </span>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'warn' | 'danger' | 'ok' | 'info';
}) {
  const tones = {
    neutral: 'bg-surface-2 text-muted',
    warn: 'bg-warn/10 text-warn',
    danger: 'bg-danger/10 text-danger',
    ok: 'bg-ok/10 text-ok',
    info: 'bg-info/10 text-info',
  };
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs', tones[tone])}>
      {children}
    </span>
  );
}
