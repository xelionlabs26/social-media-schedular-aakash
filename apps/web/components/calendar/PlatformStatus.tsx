import type { Platform } from '@app/db/schema';
import { DISPLAY_STATUS_ICON, DISPLAY_STATUS_LABEL, type DisplayStatus } from '@app/core/status';
import { cn } from '@/lib/cn';

const SHORT_PLATFORM: Record<Platform, string> = { instagram: 'IG', youtube: 'YT', facebook: 'FB' };
const PLATFORM_NAME: Record<Platform, string> = {
  instagram: 'Instagram',
  youtube: 'YouTube',
  facebook: 'Facebook',
};

/** Short words for the compact calendar chips (PLAN.md §3.6: "IG ✓ Pub", "YT ! Fix"). */
export const SHORT_STATUS: Record<DisplayStatus, string> = {
  processing: 'Proc',
  draft: 'Draft',
  scheduled: 'Sch',
  publishing: 'Send',
  published: 'Pub',
  needs_attention: 'Fix',
};

const TONE: Record<DisplayStatus, string> = {
  processing: 'text-muted',
  draft: 'text-text',
  scheduled: 'text-info',
  publishing: 'text-warn',
  published: 'text-ok',
  needs_attention: 'text-danger font-semibold',
};

/**
 * One platform's status in a compact chip: platform + icon + short word. The full sentence is
 * in the accessible name and tooltip, so color is never the only signal.
 */
export function PlatformStatusChip({
  platform,
  display,
  overdue,
  detail,
  compact,
  className,
}: {
  platform: Platform;
  display: DisplayStatus;
  overdue?: boolean;
  detail?: string | null;
  /** Icon only (month view). */
  compact?: boolean;
  className?: string;
}) {
  const full = `${PLATFORM_NAME[platform]}: ${DISPLAY_STATUS_LABEL[display]}${
    overdue ? ' (overdue)' : ''
  }${detail ? `. ${detail}` : ''}`;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 whitespace-nowrap rounded border border-border bg-surface px-1 py-px text-[11px] leading-4',
        TONE[display],
        className,
      )}
      title={full}
    >
      <span className="sr-only">{full}</span>
      <span aria-hidden className="font-semibold text-muted">
        {SHORT_PLATFORM[platform]}
      </span>
      <span aria-hidden>{DISPLAY_STATUS_ICON[display]}</span>
      {compact ? null : <span aria-hidden>{SHORT_STATUS[display]}</span>}
    </span>
  );
}

export function platformName(p: Platform): string {
  return PLATFORM_NAME[p];
}
