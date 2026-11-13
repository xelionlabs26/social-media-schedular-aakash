/**
 * Server-side loader for the Settings page. Returns only what the forms need: no tokens, no
 * secret values (for missing integrations we list the .env key NAMES to add).
 */
import { asc, gte, sum } from 'drizzle-orm';
import {
  aiGenerations,
  postingSlots,
  templates,
  type AppSettings,
  type Platform,
  type SocialAccount,
} from '@app/db';
import { listAccounts } from '@app/core/accounts';
import type { ServiceDeps } from '@app/core/deps';
import { integrationStatus, type Env } from '@app/core/env';
import { getSettings } from '@app/core/settings';
import { localToUtc, toLocalParts, tzAbbrev } from '@app/core/time';
import { TEMPLATE_SLOTS, type SlotRow, type TemplateInput } from './schemas';

export interface AccountView {
  id: string;
  platform: Platform;
  name: string;
  handle: string | null;
  status: SocialAccount['status'];
  accessExpiresAt: string | null;
  dataAccessExpiresAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export interface IntegrationView {
  configured: boolean;
  /** .env key names still missing (never values). */
  missingKeys: string[];
}

export interface SettingsData {
  settings: Pick<
    AppSettings,
    | 'timezone'
    | 'defaultPlatforms'
    | 'brandVoice'
    | 'exampleCaptions'
    | 'bannedWords'
    | 'emojiLevel'
    | 'captionScript'
    | 'hashtagCounts'
    | 'aiModel'
    | 'aiEffort'
    | 'sttProvider'
    | 'youtubeDefaults'
    | 'instagramDefaults'
    | 'facebookDefaults'
    | 'missedPolicy'
    | 'lateGraceMinutes'
    | 'minGapMinutes'
    | 'keepOriginals'
    | 'purgeAfterDays'
    | 'notifyChannel'
    | 'telegramChatId'
    | 'notifyEmail'
    | 'dailyDigest'
  >;
  tzLabel: string;
  accounts: { youtube: AccountView[]; meta: AccountView[] };
  integrations: {
    youtube: IntegrationView;
    meta: IntegrationView;
    telegram: IntegrationView;
    email: IntegrationView;
    ai: IntegrationView & { mock: boolean };
    stt: Record<'openai' | 'deepgram' | 'sarvam' | 'assemblyai', boolean>;
  };
  slots: SlotRow[];
  templates: TemplateInput[];
  aiCostThisMonthUsd: number;
  monthLabel: string;
}

function missing(env: Env, keys: Array<keyof Env>): string[] {
  return keys.filter((k) => !env[k]) as string[];
}

function toAccountView(a: SocialAccount): AccountView {
  const handle =
    a.platform === 'instagram' && a.meta.igUsername
      ? `@${a.meta.igUsername}`
      : a.platform === 'youtube' && a.meta.channelId
        ? a.meta.channelId
        : null;
  return {
    id: a.id,
    platform: a.platform,
    name:
      a.displayName ||
      (a.platform === 'youtube' ? a.meta.channelTitle : a.meta.pageName) ||
      a.externalId,
    handle,
    status: a.status,
    accessExpiresAt: a.accessExpiresAt?.toISOString() ?? null,
    dataAccessExpiresAt: a.dataAccessExpiresAt?.toISOString() ?? null,
    lastCheckedAt: a.lastCheckedAt?.toISOString() ?? null,
    lastError: a.lastError ? a.lastError.slice(0, 300) : null,
  };
}

/** Sum of ai_generations.cost_usd since the 1st of this month 00:00 in the app time zone. */
export async function aiCostThisMonth(deps: ServiceDeps, tz: string): Promise<number> {
  const local = toLocalParts(deps.now(), tz);
  const since = localToUtc(`${local.date.slice(0, 7)}-01`, '00:00', tz);
  const [row] = await deps.db
    .select({ total: sum(aiGenerations.costUsd) })
    .from(aiGenerations)
    .where(gte(aiGenerations.createdAt, since));
  return Number(row?.total ?? 0);
}

export async function loadSettingsData(deps: ServiceDeps): Promise<SettingsData> {
  const { db, env } = deps;
  const settings = await getSettings(db);
  const status = integrationStatus(env);
  const tokenKey = missing(env, ['TOKEN_ENC_KEY']);
  const youtubeMissing = [
    ...missing(env, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']),
    ...tokenKey,
  ];
  // The Meta login button needs the Login Configuration id as well as the app id/secret.
  const metaMissing = [
    ...missing(env, ['META_APP_ID', 'META_APP_SECRET', 'META_LOGIN_CONFIG_ID']),
    ...tokenKey,
  ];

  const [accounts, slots, tplRows, cost] = await Promise.all([
    listAccounts(db),
    db
      .select({ id: postingSlots.id, weekday: postingSlots.weekday, time: postingSlots.time })
      .from(postingSlots)
      .orderBy(asc(postingSlots.weekday), asc(postingSlots.time)),
    db.select().from(templates),
    aiCostThisMonth(deps, settings.timezone),
  ]);

  const active = accounts.filter((a) => a.status !== 'disabled').map(toAccountView);
  const tpl = TEMPLATE_SLOTS.map(({ platform, field }) => {
    const row = tplRows.find((t) => t.platform === platform && t.field === field);
    return {
      platform,
      field,
      pattern: row?.pattern ?? '',
      mode: row?.mode ?? 'ai_only',
      enabled: row?.enabled ?? false,
    };
  });

  const local = toLocalParts(deps.now(), settings.timezone);
  const monthLabel = new Date(Date.UTC(local.year, local.month - 1, 1)).toLocaleString('en-GB', {
    month: 'long',
    timeZone: 'UTC',
  });

  return {
    settings: {
      timezone: settings.timezone,
      defaultPlatforms: settings.defaultPlatforms,
      brandVoice: settings.brandVoice,
      exampleCaptions: settings.exampleCaptions,
      bannedWords: settings.bannedWords,
      emojiLevel: settings.emojiLevel,
      captionScript: settings.captionScript,
      hashtagCounts: settings.hashtagCounts,
      aiModel: settings.aiModel,
      aiEffort: settings.aiEffort,
      sttProvider: settings.sttProvider,
      youtubeDefaults: settings.youtubeDefaults,
      instagramDefaults: settings.instagramDefaults,
      facebookDefaults: settings.facebookDefaults,
      missedPolicy: settings.missedPolicy,
      lateGraceMinutes: settings.lateGraceMinutes,
      minGapMinutes: settings.minGapMinutes,
      keepOriginals: settings.keepOriginals,
      purgeAfterDays: settings.purgeAfterDays,
      notifyChannel: settings.notifyChannel,
      telegramChatId: settings.telegramChatId,
      notifyEmail: settings.notifyEmail,
      dailyDigest: settings.dailyDigest,
    },
    tzLabel: tzAbbrev(settings.timezone),
    accounts: {
      youtube: active.filter((a) => a.platform === 'youtube'),
      meta: active
        .filter((a) => a.platform !== 'youtube')
        .sort((a, b) => Number(a.platform !== 'facebook') - Number(b.platform !== 'facebook')),
    },
    integrations: {
      youtube: { configured: youtubeMissing.length === 0, missingKeys: youtubeMissing },
      meta: { configured: metaMissing.length === 0, missingKeys: metaMissing },
      telegram: { configured: status.telegram, missingKeys: missing(env, ['TELEGRAM_BOT_TOKEN']) },
      email: {
        configured: status.email,
        missingKeys: missing(env, ['RESEND_API_KEY', 'NOTIFY_FROM_EMAIL']),
      },
      ai: {
        configured: status.ai,
        mock: status.aiMock,
        missingKeys: missing(env, ['ANTHROPIC_API_KEY']),
      },
      stt: status.stt,
    },
    slots,
    templates: tpl,
    aiCostThisMonthUsd: cost,
    monthLabel,
  };
}
