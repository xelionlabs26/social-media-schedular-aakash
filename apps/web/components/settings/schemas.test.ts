import { describe, expect, it } from 'vitest';
import {
  AiStyleSchema,
  DefaultsSchema,
  NotificationsSchema,
  SlotAddSchema,
  TemplateSchema,
  TemplatesSchema,
  groupSlotsByWeekday,
  isValidTimeZone,
  normalizeTime,
  unknownTemplateTokens,
} from './schemas';

describe('normalizeTime', () => {
  it.each([
    ['18:00', '18:00'],
    ['9:05', '09:05'],
    ['9', '09:00'],
    ['09.30', '09:30'],
    ['6 pm', '18:00'],
    ['6:30PM', '18:30'],
    ['12 am', '00:00'],
    ['12pm', '12:00'],
    [' 23:59 ', '23:59'],
  ])('%s -> %s', (input, out) => {
    expect(normalizeTime(input)).toBe(out);
  });

  it.each(['24:00', '18:60', '13 pm', '0 am', 'abc', '', '18:0', '1800'])('rejects %s', (v) => {
    expect(normalizeTime(v)).toBeNull();
  });
});

describe('SlotAddSchema', () => {
  it('normalizes time and dedupes weekdays', () => {
    const r = SlotAddSchema.parse({ time: '6pm', weekdays: [5, 1, 5] });
    expect(r).toEqual({ time: '18:00', weekdays: [1, 5] });
  });

  it('rejects a bad time or no days', () => {
    expect(SlotAddSchema.safeParse({ time: '25:00', weekdays: [1] }).success).toBe(false);
    expect(SlotAddSchema.safeParse({ time: '18:00', weekdays: [] }).success).toBe(false);
    expect(SlotAddSchema.safeParse({ time: '18:00', weekdays: [7] }).success).toBe(false);
  });
});

describe('groupSlotsByWeekday', () => {
  it('orders Monday first with sorted times', () => {
    const g = groupSlotsByWeekday([
      { id: 'a', weekday: 0, time: '10:00' },
      { id: 'b', weekday: 1, time: '18:00' },
      { id: 'c', weekday: 1, time: '09:00' },
    ]);
    expect(g.map((d) => d.short)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(g[0]!.slots.map((s) => s.time)).toEqual(['09:00', '18:00']);
    expect(g[6]!.slots.map((s) => s.id)).toEqual(['a']);
  });
});

const aiStyle = {
  brandVoice: 'Warm, funny, story-first',
  exampleCaptions: '',
  bannedWords: 'crazy',
  emojiLevel: 'light',
  captionScript: { instagram: 'hinglish_roman', youtube: 'english', facebook: 'hindi_devanagari' },
  hashtagCounts: {
    instagram: { min: 3, max: 5 },
    youtube: { min: 2, max: 3 },
    facebook: { min: 0, max: 0 },
  },
  aiModel: 'claude-opus-5-5',
  aiEffort: 'low',
  sttProvider: 'openai',
};

describe('AiStyleSchema', () => {
  it('accepts the defaults', () => {
    expect(AiStyleSchema.safeParse(aiStyle).success).toBe(true);
  });

  it('caps Instagram hashtags at 5', () => {
    const r = AiStyleSchema.safeParse({
      ...aiStyle,
      hashtagCounts: { ...aiStyle.hashtagCounts, instagram: { min: 3, max: 6 } },
    });
    expect(r.success).toBe(false);
  });

  it('requires min <= max', () => {
    const r = AiStyleSchema.safeParse({
      ...aiStyle,
      hashtagCounts: { ...aiStyle.hashtagCounts, youtube: { min: 4, max: 2 } },
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown models, efforts and providers', () => {
    expect(AiStyleSchema.safeParse({ ...aiStyle, aiModel: 'gpt-5' }).success).toBe(false);
    expect(AiStyleSchema.safeParse({ ...aiStyle, aiEffort: 'max' }).success).toBe(false);
    expect(AiStyleSchema.safeParse({ ...aiStyle, sttProvider: 'whisper' }).success).toBe(false);
    expect(AiStyleSchema.safeParse({ ...aiStyle, sttProvider: 'mock' }).success).toBe(true);
  });
});

describe('TemplateSchema', () => {
  const base = {
    platform: 'youtube',
    field: 'title',
    pattern: '',
    mode: 'ai_only',
    enabled: false,
  };

  it('accepts the default (off, AI only, empty)', () => {
    expect(TemplateSchema.safeParse(base).success).toBe(true);
  });

  it('finds unknown tokens', () => {
    expect(unknownTemplateTokens('{ai_title} | {caption} {n}')).toEqual(['{caption}']);
    expect(TemplateSchema.safeParse({ ...base, pattern: 'Ep {num}' }).success).toBe(false);
  });

  it('needs a pattern when a template mode is on', () => {
    expect(
      TemplateSchema.safeParse({ ...base, enabled: true, mode: 'template_only' }).success,
    ).toBe(false);
    expect(
      TemplateSchema.safeParse({
        ...base,
        enabled: true,
        mode: 'template_only',
        pattern: 'Day {n}',
      }).success,
    ).toBe(true);
  });

  it('needs an AI token for Template + AI', () => {
    const on = { ...base, enabled: true, mode: 'template_ai' };
    expect(TemplateSchema.safeParse({ ...on, pattern: 'Day {n}' }).success).toBe(false);
    expect(TemplateSchema.safeParse({ ...on, pattern: '{ai_title} | Day {n}' }).success).toBe(true);
  });

  it('rejects < > in YouTube titles and Instagram titles', () => {
    expect(TemplateSchema.safeParse({ ...base, pattern: '<b>{ai_title}' }).success).toBe(false);
    expect(TemplateSchema.safeParse({ ...base, platform: 'instagram' }).success).toBe(false);
  });

  it('allows one template per platform field', () => {
    expect(TemplatesSchema.safeParse([base, base]).success).toBe(false);
    expect(TemplatesSchema.safeParse([base, { ...base, field: 'body' }]).success).toBe(true);
  });
});

describe('NotificationsSchema', () => {
  it('normalizes empty values to null', () => {
    const r = NotificationsSchema.parse({
      notifyChannel: 'telegram',
      telegramChatId: '',
      notifyEmail: '',
      dailyDigest: false,
    });
    expect(r.telegramChatId).toBeNull();
    expect(r.notifyEmail).toBeNull();
  });

  it('accepts group chat ids and validates email', () => {
    expect(
      NotificationsSchema.safeParse({
        notifyChannel: 'telegram',
        telegramChatId: '-1001234567890',
        notifyEmail: 'Me@Example.com',
        dailyDigest: true,
      }).success,
    ).toBe(true);
    expect(
      NotificationsSchema.safeParse({
        notifyChannel: 'telegram',
        telegramChatId: '@me',
        notifyEmail: '',
        dailyDigest: true,
      }).success,
    ).toBe(false);
    expect(
      NotificationsSchema.safeParse({
        notifyChannel: 'none',
        telegramChatId: '',
        notifyEmail: 'not-an-email',
        dailyDigest: false,
      }).success,
    ).toBe(false);
  });

  it('requires an email for the email channel', () => {
    expect(
      NotificationsSchema.safeParse({
        notifyChannel: 'email',
        telegramChatId: '',
        notifyEmail: '',
        dailyDigest: false,
      }).success,
    ).toBe(false);
  });
});

describe('DefaultsSchema', () => {
  const defaults = {
    defaultPlatforms: ['facebook', 'instagram'],
    youtubeDefaults: {
      privacy: 'public',
      categoryId: '22',
      madeForKids: false,
      notifySubscribers: true,
      syntheticMedia: false,
      defaultLanguage: 'hi',
    },
    instagramDefaults: { shareToFeed: true },
    facebookDefaults: { kind: 'auto' },
    missedPolicy: 'publish_late_or_ask',
    lateGraceMinutes: 120,
    minGapMinutes: 5,
    keepOriginals: false,
    purgeAfterDays: 7,
    timezone: 'Asia/Kolkata',
  };

  it('accepts the B2 defaults and orders platforms', () => {
    const r = DefaultsSchema.parse(defaults);
    expect(r.defaultPlatforms).toEqual(['instagram', 'facebook']);
  });

  it('rejects bad values', () => {
    expect(DefaultsSchema.safeParse({ ...defaults, defaultPlatforms: [] }).success).toBe(false);
    expect(DefaultsSchema.safeParse({ ...defaults, timezone: 'Mars/Base' }).success).toBe(false);
    expect(DefaultsSchema.safeParse({ ...defaults, purgeAfterDays: 0 }).success).toBe(false);
    expect(DefaultsSchema.safeParse({ ...defaults, lateGraceMinutes: 2000 }).success).toBe(false);
    expect(
      DefaultsSchema.safeParse({
        ...defaults,
        youtubeDefaults: { ...defaults.youtubeDefaults, categoryId: '999' },
      }).success,
    ).toBe(false);
  });

  it('knows time zones', () => {
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('Nope/Nowhere')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});
