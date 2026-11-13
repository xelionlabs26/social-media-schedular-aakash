/**
 * Settings (PLAN.md §3.1): one page with anchored sections. Accounts · Posting times · AI style ·
 * Templates · Notifications · Defaults.
 */
import { requireOwnerPage } from '@/lib/auth';
import { getDeps } from '@/lib/deps';
import { AccountsSection } from '@/components/settings/AccountsSection';
import { AiStyleSection } from '@/components/settings/AiStyleSection';
import { loadSettingsData } from '@/components/settings/data';
import { DefaultsSection } from '@/components/settings/DefaultsSection';
import { NotificationsSection } from '@/components/settings/NotificationsSection';
import { OAuthNotice } from '@/components/settings/OAuthNotice';
import { PostingTimesSection } from '@/components/settings/PostingTimesSection';
import { AI_MODELS, type AiModelId } from '@/components/settings/schemas';
import { TemplatesSection } from '@/components/settings/TemplatesSection';

export const metadata = { title: 'Settings' };

const SECTIONS = [
  { id: 'accounts', label: 'Accounts' },
  { id: 'posting-times', label: 'Posting times' },
  { id: 'ai', label: 'AI style' },
  { id: 'templates', label: 'Templates' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'defaults', label: 'Defaults' },
];

/** Query params from OAuth callbacks are shown as text only and capped in length. */
function param(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s ? s.slice(0, 200) : null;
}

function timeZoneList(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['Asia/Kolkata', 'UTC'];
  }
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOwnerPage();
  const sp = await searchParams;
  const deps = getDeps();
  const data = await loadSettingsData(deps);
  const s = data.settings;
  // An unknown stored model (e.g. retired) falls back to the default in the form.
  const aiModel: AiModelId = AI_MODELS.some((m) => m.id === s.aiModel)
    ? (s.aiModel as AiModelId)
    : 'claude-sonnet-5-5';

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Settings</h1>
      <nav
        aria-label="Settings sections"
        className="sticky top-14 z-30 -mx-4 overflow-x-auto border-b border-border bg-bg/95 px-4 py-2 backdrop-blur sm:mx-0 sm:rounded-lg sm:border sm:px-2"
      >
        <ul className="flex gap-1 whitespace-nowrap">
          {SECTIONS.map((sec) => (
            <li key={sec.id}>
              <a
                href={`#${sec.id}`}
                className="inline-flex h-8 items-center rounded-md px-2.5 text-sm text-muted hover:bg-surface-2 hover:text-text"
              >
                {sec.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <OAuthNotice connected={param(sp.connected)} error={param(sp.error)} />

      <AccountsSection
        youtube={data.accounts.youtube}
        meta={data.accounts.meta}
        integrations={data.integrations}
        timezone={s.timezone}
        nowIso={deps.now().toISOString()}
      />
      <PostingTimesSection slots={data.slots} tzLabel={data.tzLabel} />
      <AiStyleSection
        initial={{
          brandVoice: s.brandVoice,
          exampleCaptions: s.exampleCaptions,
          bannedWords: s.bannedWords,
          emojiLevel: s.emojiLevel,
          captionScript: s.captionScript,
          hashtagCounts: s.hashtagCounts,
          aiModel,
          aiEffort: s.aiEffort,
          sttProvider: s.sttProvider,
        }}
        sttConfigured={data.integrations.stt}
        ai={data.integrations.ai}
        costUsd={data.aiCostThisMonthUsd}
        monthLabel={data.monthLabel}
      />
      <TemplatesSection initial={data.templates} />
      <NotificationsSection
        initial={{
          notifyChannel: s.notifyChannel,
          telegramChatId: s.telegramChatId ?? '',
          notifyEmail: s.notifyEmail ?? '',
          dailyDigest: s.dailyDigest,
        }}
        telegram={data.integrations.telegram}
        email={data.integrations.email}
      />
      <DefaultsSection
        initial={{
          defaultPlatforms: s.defaultPlatforms,
          youtubeDefaults: s.youtubeDefaults,
          instagramDefaults: s.instagramDefaults,
          facebookDefaults: s.facebookDefaults,
          missedPolicy: s.missedPolicy,
          lateGraceMinutes: s.lateGraceMinutes,
          minGapMinutes: s.minGapMinutes,
          keepOriginals: s.keepOriginals,
          purgeAfterDays: s.purgeAfterDays,
          timezone: s.timezone,
        }}
        timeZones={timeZoneList()}
      />
    </div>
  );
}
