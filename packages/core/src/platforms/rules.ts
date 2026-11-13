/**
 * Platform rules (checked against official docs, 13 Nov 2026 — see PLAN.md §2).
 * One place for every number so validators, the AI prompt and the UI agree.
 */
import type { Platform } from '@app/db';

export const PLATFORM_LABELS: Record<Platform, string> = {
  instagram: 'Instagram',
  youtube: 'YouTube',
  facebook: 'Facebook',
};

export const RULES = {
  instagram: {
    captionMaxChars: 2200,
    /** Instagram announced a 5-hashtag cap in Dec 2025 (API docs still say 30). */
    hashtagsMax: 5,
    mentionsMax: 20,
    video: {
      minSec: 3,
      maxSec: 15 * 60,
      maxBytes: 300 * 1024 * 1024,
      minFps: 23,
      maxFps: 60,
      maxWidthPx: 1920,
      maxBitrateBps: 25_000_000,
    },
    /** Containers expire 24 h after creation; we create them this long before the slot. */
    containerLeadMinutes: 15,
    /** API-published posts per rolling 24 h; the live value is read from content_publishing_limit. */
    publishesPer24hAssumed: 50,
    containersPer24h: 400,
  },
  youtube: {
    titleMaxChars: 100,
    /** Target for AI titles (reads fully on a phone). */
    titleTargetChars: 60,
    descriptionMaxBytes: 5000,
    tagsMaxChars: 500,
    shortMaxSec: 180,
    /** Shorts over 60 s with any Content ID claim are blocked worldwide. */
    copyrightBlockOverSec: 60,
    uploadsPerDay: 100,
    /** We stay below the documented cap to leave room for the hidden per-channel limit. */
    uploadsPerDaySafe: 50,
    quotaTimezone: 'America/Los_Angeles',
  },
  facebook: {
    reel: {
      minSec: 3,
      maxSec: 90,
      minWidth: 540,
      minHeight: 960,
      minFps: 24,
      maxFps: 60,
    },
    video: {
      maxSec: 40 * 60,
      maxBytes: 2 * 1024 * 1024 * 1024,
    },
    reelsPer24h: 30,
    /** Native scheduling window. */
    scheduleMinMinutes: 10,
    scheduleMaxDays: 29,
    descriptionMaxChars: 10_000,
    titleMaxChars: 100,
  },
} as const;

/** Display order. */
export const PLATFORM_ORDER: Platform[] = ['instagram', 'youtube', 'facebook'];
