/**
 * Settings: option lists, zod schemas and posting-slot helpers. Shared by the Settings forms
 * (client) and the server actions in lib/actions/settings.ts, which re-validate everything.
 * Pure module: safe for client components.
 */
import { z } from 'zod';
import {
  CAPTION_SCRIPTS,
  MISSED_POLICIES,
  NOTIFY_CHANNELS,
  PLATFORMS,
  STT_PROVIDERS,
  type CaptionScript,
  type Platform,
  type SttProvider,
} from '@app/db/schema';
import { RULES } from '@app/core/platforms';

// ---------------------------------------------------------------------------------------------
// Option lists (labels shown in the UI)
// ---------------------------------------------------------------------------------------------

/** PLAN.md §4.3 / §4.9: per-video cost estimates shown next to each model. */
export const AI_MODELS = [
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    cost: '~5–8¢ per video',
    note: 'best writing, ~2× the cost',
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    cost: '~3–4¢ per video',
    note: 'good writing, half the cost',
  },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', cost: '~0.1–0.2¢ per video', note: '' },
] as const;
export type AiModelId = (typeof AI_MODELS)[number]['id'];
const AI_MODEL_IDS = AI_MODELS.map((m) => m.id) as [AiModelId, ...AiModelId[]];

export const AI_EFFORTS = ['low', 'medium', 'high'] as const;
export const EMOJI_LEVELS = ['none', 'light', 'heavy'] as const;

export const CAPTION_SCRIPT_LABEL: Record<CaptionScript, string> = {
  hinglish_roman: 'Hinglish (Roman letters)',
  english: 'English',
  hindi_devanagari: 'Hindi (Devanagari)',
};

export const STT_LABEL: Record<SttProvider, string> = {
  openai: 'OpenAI gpt-transcribe',
  deepgram: 'Deepgram Nova-3',
  sarvam: 'Sarvam AI (saaras)',
  assemblyai: 'AssemblyAI',
  mock: 'Mock (testing only)',
};

/** .env keys each speech-to-text provider needs. */
export const STT_ENV_KEY: Record<Exclude<SttProvider, 'mock'>, string> = {
  openai: 'OPENAI_API_KEY',
  deepgram: 'DEEPGRAM_API_KEY',
  sarvam: 'SARVAM_API_KEY',
  assemblyai: 'ASSEMBLYAI_API_KEY',
};

/**
 * Common YouTube category ids. The ids are global; the live list per region comes from
 * videoCategories.list (https://developers.google.com/youtube/v3/docs/videoCategories/list).
 * '22' (People & Blogs) is the default (PLAN.md §11 B2).
 */
export const YOUTUBE_CATEGORIES = [
  { id: '22', label: 'People & Blogs' },
  { id: '24', label: 'Entertainment' },
  { id: '23', label: 'Comedy' },
  { id: '19', label: 'Travel & Events' },
  { id: '26', label: 'Howto & Style' },
  { id: '27', label: 'Education' },
  { id: '17', label: 'Sports' },
  { id: '10', label: 'Music' },
  { id: '1', label: 'Film & Animation' },
  { id: '2', label: 'Autos & Vehicles' },
  { id: '15', label: 'Pets & Animals' },
  { id: '20', label: 'Gaming' },
  { id: '25', label: 'News & Politics' },
  { id: '28', label: 'Science & Technology' },
  { id: '29', label: 'Nonprofits & Activism' },
] as const;
const YOUTUBE_CATEGORY_IDS = YOUTUBE_CATEGORIES.map((c) => c.id) as [string, ...string[]];

export const YOUTUBE_LANGUAGES = [
  { id: 'hi', label: 'Hindi' },
  { id: 'en', label: 'English' },
  { id: 'en-IN', label: 'English (India)' },
] as const;

export const MISSED_POLICY_LABEL: Record<(typeof MISSED_POLICIES)[number], string> = {
  publish_late_or_ask: 'Publish late if within the grace time, otherwise ask me',
  publish_late: 'Always publish late',
  ask: 'Always ask me',
  skip: 'Skip the post',
};

export const TEMPLATE_TOKENS = ['{ai_title}', '{ai_body}', '{n}', '{date}', '{filename}'] as const;
export const TEMPLATE_MODES = ['ai_only', 'template_only', 'template_ai'] as const;
export const TEMPLATE_MODE_LABEL: Record<(typeof TEMPLATE_MODES)[number], string> = {
  ai_only: 'AI only',
  template_only: 'Template only',
  template_ai: 'Template + AI',
};

/** The template rows shown in Settings (Instagram has no title). */
export const TEMPLATE_SLOTS: Array<{ platform: Platform; field: 'title' | 'body'; label: string }> =
  [
    { platform: 'instagram', field: 'body', label: 'Instagram caption' },
    { platform: 'youtube', field: 'title', label: 'YouTube title' },
    { platform: 'youtube', field: 'body', label: 'YouTube description' },
    { platform: 'facebook', field: 'body', label: 'Facebook text' },
    { platform: 'facebook', field: 'title', label: 'Facebook title (normal Page videos only)' },
  ];

// ---------------------------------------------------------------------------------------------
// Posting slots
// ---------------------------------------------------------------------------------------------

/** Monday-first display order of weekdays (0 = Sunday, as stored). */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
export const WEEKDAY_NAME = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Normalizes a typed time to 'HH:MM' (24 h). Accepts '18:00', '9:05', '9', '6 pm', '6:30pm'.
 * Returns null when it isn't a valid time.
 */
export function normalizeTime(input: string): string | null {
  const m = /^\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*$/i.exec(input);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  const ampm = m[3]?.toLowerCase();
  if (min > 59) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === 'am') h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
  } else if (h > 23) {
    return null;
  }
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export const SlotAddSchema = z.object({
  time: z.string().transform((v, ctx) => {
    const t = normalizeTime(v);
    if (!t) {
      ctx.addIssue({ code: 'custom', message: 'Enter a time like 18:00' });
      return z.NEVER;
    }
    return t;
  }),
  weekdays: z
    .array(z.number().int().min(0).max(6))
    .min(1, 'Choose at least one day')
    .transform((days) => [...new Set(days)].sort()),
});
export type SlotAddInput = z.input<typeof SlotAddSchema>;

export interface SlotRow {
  id: string;
  weekday: number;
  time: string;
}

/** Slots grouped per weekday, Monday first, times sorted. */
export function groupSlotsByWeekday(slots: SlotRow[]) {
  return WEEKDAY_ORDER.map((weekday) => ({
    weekday,
    name: WEEKDAY_NAME[weekday]!,
    short: WEEKDAY_SHORT[weekday]!,
    slots: slots.filter((s) => s.weekday === weekday).sort((a, b) => a.time.localeCompare(b.time)),
  }));
}

// ---------------------------------------------------------------------------------------------
// Section schemas
// ---------------------------------------------------------------------------------------------

const platformEnum = z.enum(PLATFORMS);
const captionScriptEnum = z.enum(CAPTION_SCRIPTS);

const hashtagRange = (maxAllowed: number) =>
  z
    .object({
      min: z.number().int().min(0).max(maxAllowed),
      max: z.number().int().min(0).max(maxAllowed),
    })
    .refine((r) => r.min <= r.max, { message: 'Min must not be more than max', path: ['min'] });

/** Instagram is capped at 5 (RULES); YouTube ignores every hashtag past 60, we keep it small. */
export const HASHTAG_MAX: Record<Platform, number> = {
  instagram: RULES.instagram.hashtagsMax,
  youtube: 10,
  facebook: 10,
};

export const AiStyleSchema = z.object({
  brandVoice: z.string().trim().max(4000, 'Keep the brand voice under 4,000 characters'),
  exampleCaptions: z.string().trim().max(10000, 'Keep examples under 10,000 characters'),
  bannedWords: z.string().trim().max(2000, 'Keep banned words under 2,000 characters'),
  emojiLevel: z.enum(EMOJI_LEVELS),
  captionScript: z.object({
    instagram: captionScriptEnum,
    youtube: captionScriptEnum,
    facebook: captionScriptEnum,
  }),
  hashtagCounts: z.object({
    instagram: hashtagRange(HASHTAG_MAX.instagram),
    youtube: hashtagRange(HASHTAG_MAX.youtube),
    facebook: hashtagRange(HASHTAG_MAX.facebook),
  }),
  aiModel: z.enum(AI_MODEL_IDS),
  aiEffort: z.enum(AI_EFFORTS),
  sttProvider: z.enum(STT_PROVIDERS),
});
export type AiStyleInput = z.infer<typeof AiStyleSchema>;

const TOKEN_RE = /\{[^{}]*\}/g;

/** Tokens in a pattern that aren't supported (e.g. '{caption}'). */
export function unknownTemplateTokens(pattern: string): string[] {
  const found = pattern.match(TOKEN_RE) ?? [];
  return [...new Set(found.filter((t) => !(TEMPLATE_TOKENS as readonly string[]).includes(t)))];
}

export const TemplateSchema = z
  .object({
    platform: platformEnum,
    field: z.enum(['title', 'body']),
    pattern: z.string().max(5000, 'Pattern is too long'),
    mode: z.enum(TEMPLATE_MODES),
    enabled: z.boolean(),
  })
  .superRefine((t, ctx) => {
    if (t.platform === 'instagram' && t.field === 'title') {
      ctx.addIssue({ code: 'custom', message: 'Instagram has no title', path: ['field'] });
    }
    const unknown = unknownTemplateTokens(t.pattern);
    if (unknown.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['pattern'],
        message: `Unknown token ${unknown.join(', ')}. Use ${TEMPLATE_TOKENS.join(' ')}`,
      });
    }
    if (t.enabled && t.mode !== 'ai_only' && t.pattern.trim() === '') {
      ctx.addIssue({ code: 'custom', path: ['pattern'], message: 'Write a pattern first' });
    }
    if (
      t.enabled &&
      t.mode === 'template_ai' &&
      !t.pattern.includes('{ai_title}') &&
      !t.pattern.includes('{ai_body}')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['pattern'],
        message: 'Template + AI needs {ai_title} or {ai_body} in the pattern',
      });
    }
    if (t.platform === 'youtube' && t.field === 'title' && /[<>]/.test(t.pattern)) {
      ctx.addIssue({
        code: 'custom',
        path: ['pattern'],
        message: 'YouTube titles cannot contain < or >',
      });
    }
  });
export type TemplateInput = z.infer<typeof TemplateSchema>;

export const TemplatesSchema = z
  .array(TemplateSchema)
  .max(TEMPLATE_SLOTS.length)
  .refine(
    (list) => new Set(list.map((t) => `${t.platform}.${t.field}`)).size === list.length,
    'Each platform field can have one template',
  );

/** Telegram chat ids are integers (negative for groups/channels). */
const TELEGRAM_CHAT_ID_RE = /^-?\d{1,20}$/;

export const NotificationsSchema = z
  .object({
    notifyChannel: z.enum(NOTIFY_CHANNELS),
    telegramChatId: z
      .string()
      .trim()
      .refine(
        (v) => v === '' || TELEGRAM_CHAT_ID_RE.test(v),
        'A chat id is a number, e.g. 123456789',
      )
      .transform((v) => (v === '' ? null : v)),
    notifyEmail: z
      .string()
      .trim()
      .refine((v) => v === '' || z.email().safeParse(v).success, 'Enter a valid email address')
      .transform((v) => (v === '' ? null : v.toLowerCase())),
    dailyDigest: z.boolean(),
  })
  .superRefine((n, ctx) => {
    if (n.notifyChannel === 'email' && !n.notifyEmail) {
      ctx.addIssue({ code: 'custom', path: ['notifyEmail'], message: 'Add the email address' });
    }
  });
export type NotificationsInput = z.input<typeof NotificationsSchema>;

/** True if the runtime knows this IANA time zone. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const DefaultsSchema = z.object({
  defaultPlatforms: z
    .array(platformEnum)
    .min(1, 'Choose at least one platform')
    .transform((list) => PLATFORMS.filter((p) => list.includes(p))),
  youtubeDefaults: z.object({
    privacy: z.enum(['public', 'unlisted', 'private']),
    categoryId: z.enum(YOUTUBE_CATEGORY_IDS),
    madeForKids: z.boolean(),
    notifySubscribers: z.boolean(),
    syntheticMedia: z.boolean(),
    defaultLanguage: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/, 'Use a code like hi'),
  }),
  instagramDefaults: z.object({ shareToFeed: z.boolean() }),
  facebookDefaults: z.object({ kind: z.enum(['auto', 'reel', 'video']) }),
  missedPolicy: z.enum(MISSED_POLICIES),
  lateGraceMinutes: z
    .number()
    .int()
    .min(0, 'Use 0 or more minutes')
    .max(24 * 60, 'Use at most 24 hours (1440 minutes)'),
  minGapMinutes: z.number().int().min(0).max(240, 'Use at most 240 minutes'),
  keepOriginals: z.boolean(),
  purgeAfterDays: z.number().int().min(1, 'Use at least 1 day').max(365, 'Use at most 365 days'),
  timezone: z.string().refine(isValidTimeZone, 'Unknown time zone'),
});
export type DefaultsInput = z.infer<typeof DefaultsSchema>;

/** First zod issue as a friendly sentence, e.g. "Instagram max: Too big". */
export function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue?.message ?? 'Please check the form';
}
