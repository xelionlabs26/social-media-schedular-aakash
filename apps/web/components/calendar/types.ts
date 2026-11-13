/**
 * Lean, serializable view models the Calendar server page passes to its client components.
 * (Instants are ISO strings; local date/time are already resolved in the app time zone.)
 */
import type { Platform, TargetStatus } from '@app/db/schema';
import type { DisplayStatus } from '@app/core/status';
import type { CalendarView } from './calendar-math';

export interface CalendarTarget {
  id: string;
  platform: Platform;
  status: TargetStatus;
  display: DisplayStatus;
  overdue: boolean;
  attention: string | null;
  scheduledAt: string | null;
  remoteUrl: string | null;
}

export interface CalendarPost {
  id: string;
  filename: string;
  thumbUrl: string | null;
  /** Post time, or the earliest target time when only targets carry one. */
  scheduledAt: string | null;
  localDate: string | null;
  localTime: string | null;
  display: DisplayStatus;
  /** A dated draft whose time has passed ("Draft · overdue"). */
  overdue: boolean;
  /** Processing step label while the video is being processed. */
  processingLabel: string | null;
  /** First line of the caption/title, for the list view and search hits. */
  snippet: string;
  durationMs: number | null;
  createdAt: string;
  /** False while publishing or when everything is already live. */
  movable: boolean;
  targets: CalendarTarget[];
}

export interface AttentionItem {
  targetId: string;
  postId: string;
  platform: Platform;
  filename: string;
  message: string;
  lastError: string | null;
  scheduledAt: string | null;
  /** Show [Reconnect] (login/permission problems). */
  reconnect: boolean;
}

export interface SlotView {
  weekday: number;
  time: string;
}

/** Filter chips in the List view: the six display statuses plus "Not scheduled yet". */
export const LIST_FILTERS = [
  'processing',
  'draft',
  'scheduled',
  'publishing',
  'published',
  'needs_attention',
  'unscheduled',
] as const;
export type ListFilter = (typeof LIST_FILTERS)[number];

export interface CalendarData {
  view: CalendarView;
  date: string;
  today: string;
  timezone: string;
  tzLabel: string;
  nowIso: string;
  posts: CalendarPost[];
  drafts: CalendarPost[];
  attention: AttentionItem[];
  slots: SlotView[];
  filter: ListFilter | null;
  query: string;
  /** True when the list hit its size cap (older videos not shown). */
  truncated: boolean;
}
