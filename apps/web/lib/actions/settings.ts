'use server';

/**
 * Settings mutations. Every action checks the owner session first and re-validates its input
 * with the same zod schemas the forms use (server actions are reachable by direct POST).
 */
import { revalidatePath } from 'next/cache';
import { and, count, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { postingSlots, socialAccounts, templates, type SocialAccount } from '@app/db';
import { decryptAccount, disconnectAccount } from '@app/core/accounts';
import { getBaseEnv, integrationStatus } from '@app/core/env';
import { isUiKeyName, saveKeys, validateKey, type UiKeyName } from '@app/core/keys';
import { facebookIntegration, instagramIntegration } from '@app/core/meta';
import { discoverTelegramChatId, notify } from '@app/core/notify';
import type { PlatformIntegration } from '@app/core/platforms';
import { getSettings, updateSettings } from '@app/core/settings';
import { youtubeIntegration } from '@app/core/youtube';
import { requireOwner } from '@/lib/auth';
import { getDeps } from '@/lib/deps';
import {
  fail,
  friendlyError,
  ok,
  UserError,
  type ActionResult,
} from '@/components/calendar/action-result';
import {
  AiStyleSchema,
  DefaultsSchema,
  NotificationsSchema,
  SlotAddSchema,
  TemplatesSchema,
  firstIssue,
} from '@/components/settings/schemas';
import { KEY_FIELDS } from '@/components/settings/keys-meta';

/** Upper bound so a script can't fill the grid with thousands of rows. */
const MAX_SLOTS = 7 * 24;

async function run<T>(
  what: string,
  body: () => Promise<ActionResult<T>>,
  paths: string[] = ['/settings'],
): Promise<ActionResult<T>> {
  try {
    await requireOwner();
    const result = await body();
    if (result.ok) for (const p of paths) revalidatePath(p);
    return result;
  } catch (e) {
    if (e instanceof z.ZodError) return fail(firstIssue(e));
    const name = e instanceof Error ? e.name : '';
    if (!['UserError', 'NotImplementedError', 'UnauthorizedError', 'ConfigError'].includes(name)) {
      getDeps().log.error(`settings action failed: ${what}`, { error: e });
    }
    return fail(friendlyError(e, what));
  }
}

// ---------------------------------------------------------------------------------------------
// Privacy gate
// ---------------------------------------------------------------------------------------------

/** "I agree" on the privacy banner (YouTube policy: agreement before first use). */
export async function acceptPrivacyAction(): Promise<ActionResult> {
  return run(
    'Saving your agreement',
    async () => {
      const { db, now } = getDeps();
      const settings = await getSettings(db);
      if (!settings.privacyAcceptedAt) await updateSettings(db, { privacyAcceptedAt: now() });
      return ok('Thanks. You can use the app now.');
    },
    ['/', '/calendar', '/settings'],
  );
}

// ---------------------------------------------------------------------------------------------
// Posting times
// ---------------------------------------------------------------------------------------------

export async function addSlotsAction(input: unknown): Promise<ActionResult> {
  return run(
    'Adding the posting time',
    async () => {
      const { time, weekdays } = SlotAddSchema.parse(input);
      const { db } = getDeps();
      const [existing] = await db.select({ n: count() }).from(postingSlots);
      if ((existing?.n ?? 0) + weekdays.length > MAX_SLOTS) {
        throw new UserError('That is a lot of posting times. Remove some first.');
      }
      const inserted = await db
        .insert(postingSlots)
        .values(weekdays.map((weekday) => ({ weekday, time })))
        .onConflictDoNothing({ target: [postingSlots.weekday, postingSlots.time] })
        .returning({ id: postingSlots.id });
      if (inserted.length === 0) return ok(`${time} is already in the grid`);
      return ok(
        weekdays.length === 7
          ? `Added ${time} every day`
          : `Added ${time} on ${inserted.length} day${inserted.length === 1 ? '' : 's'}`,
      );
    },
    ['/settings', '/calendar'],
  );
}

export async function deleteSlotAction(slotId: string): Promise<ActionResult> {
  return run(
    'Removing the posting time',
    async () => {
      const id = z.uuid().parse(slotId);
      await getDeps().db.delete(postingSlots).where(eq(postingSlots.id, id));
      return ok('Removed');
    },
    ['/settings', '/calendar'],
  );
}

/** Removes one time on every weekday (the "every day" row's ✕). */
export async function deleteSlotTimeAction(time: string): Promise<ActionResult> {
  return run(
    'Removing the posting time',
    async () => {
      const t = z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
        .parse(time);
      await getDeps().db.delete(postingSlots).where(eq(postingSlots.time, t));
      return ok(`Removed ${t} from every day`);
    },
    ['/settings', '/calendar'],
  );
}

// ---------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------

export async function saveAiStyleAction(input: unknown): Promise<ActionResult> {
  return run('Saving AI style', async () => {
    const data = AiStyleSchema.parse(input);
    await updateSettings(getDeps().db, data);
    return ok('AI style saved');
  });
}

export async function saveTemplatesAction(input: unknown): Promise<ActionResult> {
  return run('Saving templates', async () => {
    const list = TemplatesSchema.parse(input);
    const { db } = getDeps();
    await db.transaction(async (tx) => {
      for (const t of list) {
        await tx
          .insert(templates)
          .values(t)
          .onConflictDoUpdate({
            target: [templates.platform, templates.field],
            set: { pattern: t.pattern, mode: t.mode, enabled: t.enabled },
          });
      }
    });
    return ok('Templates saved');
  });
}

export async function saveNotificationsAction(input: unknown): Promise<ActionResult> {
  return run('Saving notifications', async () => {
    const data = NotificationsSchema.parse(input);
    await updateSettings(getDeps().db, data);
    return ok('Notification settings saved');
  });
}

export async function saveDefaultsAction(input: unknown): Promise<ActionResult> {
  return run(
    'Saving defaults',
    async () => {
      const data = DefaultsSchema.parse(input);
      await updateSettings(getDeps().db, data);
      return ok('Defaults saved');
    },
    ['/settings', '/calendar', '/'],
  );
}

// ---------------------------------------------------------------------------------------------
// Setup: keys pasted in the app (stored encrypted, see core/keys)
// ---------------------------------------------------------------------------------------------

const KeysInputSchema = z.record(z.string().max(64), z.string().max(1000));

function checkKeyNames(names: string[]): UiKeyName[] {
  if (names.length === 0 || names.length > 20) throw new UserError('Nothing to save.');
  const base = getBaseEnv();
  return names.map((name) => {
    if (!isUiKeyName(name)) throw new UserError('Unknown key.');
    // A key in the server environment wins, so saving one here would silently do nothing.
    if (base[name]) {
      throw new UserError(
        `${KEY_FIELDS[name].label} is set in the server's .env; change it there.`,
      );
    }
    return name;
  });
}

/** [Save] in a Setup group: empty boxes keep the current value. */
export async function saveKeysAction(input: unknown): Promise<ActionResult> {
  return run(
    'Saving the keys',
    async () => {
      const values = KeysInputSchema.parse(input);
      const filled = Object.entries(values).filter(([, v]) => v.trim() !== '');
      if (filled.length === 0) throw new UserError('Paste at least one key first.');
      const names = checkKeyNames(filled.map(([n]) => n));
      for (const [i, name] of names.entries()) {
        const problem = validateKey(name, filled[i]![1]);
        if (problem) throw new UserError(`${KEY_FIELDS[name].label}: ${problem}`);
      }
      if (!getBaseEnv().TOKEN_ENC_KEY) {
        throw new UserError(
          'TOKEN_ENC_KEY is missing on the server, so keys cannot be stored safely.',
        );
      }
      await saveKeys(
        getDeps().db,
        Object.fromEntries(names.map((n, i) => [n, filled[i]![1].trim()])),
      );
      return ok(names.length === 1 ? 'Key saved' : 'Keys saved');
    },
    ['/settings', '/'],
  );
}

/** [Remove] in a Setup group: forgets the saved keys (connected accounts stay connected). */
export async function removeKeysAction(input: unknown): Promise<ActionResult> {
  return run(
    'Removing the keys',
    async () => {
      const names = checkKeyNames(z.array(z.string().max(64)).max(20).parse(input));
      await saveKeys(getDeps().db, Object.fromEntries(names.map((n) => [n, null])));
      return ok('Removed');
    },
    ['/settings', '/'],
  );
}

// ---------------------------------------------------------------------------------------------
// Notifications helpers
// ---------------------------------------------------------------------------------------------

/** [Detect chat id]: reads the bot's latest message and saves the sender's chat id. */
export async function detectTelegramChatAction(): Promise<ActionResult<{ chatId: string }>> {
  return run('Detecting the chat id', async () => {
    const deps = getDeps();
    if (!integrationStatus(deps.env).telegram) {
      throw new UserError('Paste your Telegram bot token under Setup first.');
    }
    const chatId = await discoverTelegramChatId(deps);
    if (!chatId) {
      throw new UserError(
        'No message found. Open Telegram, send any message to your bot, then try again.',
      );
    }
    await updateSettings(deps.db, { telegramChatId: chatId });
    return ok(`Found chat id ${chatId} and saved it`, { chatId });
  });
}

/** [Send test]: one alert on the saved channel. */
export async function sendTestNotificationAction(): Promise<ActionResult> {
  return run('Sending the test', async () => {
    const deps = getDeps();
    const res = await notify(deps, {
      kind: 'test',
      message: 'Test alert from Social Media Scheduler. Alerts are working.',
      link: `${deps.env.APP_URL}/settings#notifications`,
    });
    if (!res.sent) throw new UserError(`Not sent: ${res.reason ?? 'unknown reason'}`);
    return ok('Test sent. Check your phone or inbox.');
  });
}

// ---------------------------------------------------------------------------------------------
// Connected accounts
// ---------------------------------------------------------------------------------------------

const INTEGRATIONS: Record<SocialAccount['platform'], PlatformIntegration> = {
  youtube: youtubeIntegration,
  facebook: facebookIntegration,
  instagram: instagramIntegration,
};

/**
 * Asks the platform to revoke our access. Returns a note for the owner when that didn't happen
 * (not built yet / platform error); the local disconnect still goes ahead either way, because
 * the owner asked us to forget the account.
 */
async function tryRevoke(row: SocialAccount): Promise<string | null> {
  const integration = INTEGRATIONS[row.platform];
  if (!row.accessTokenEnc && !row.refreshTokenEnc) return null;
  try {
    if (!integration.revoke) return 'revoking on the platform is not built yet';
    await integration.revoke(decryptAccount(row));
    return null;
  } catch (e) {
    if (e instanceof Error && e.name === 'NotImplementedError') {
      return 'revoking on the platform is not built yet';
    }
    getDeps().log.warn('settings: revoke failed', {
      accountId: row.id,
      platform: row.platform,
      error: e,
    });
    return 'the platform did not confirm the revoke';
  }
}

/**
 * [Disconnect]. Facebook and Instagram are connected together (one Meta login, the Instagram
 * account uses the Page token), so disconnecting either disconnects both.
 */
export async function disconnectAccountAction(accountId: string): Promise<ActionResult> {
  return run(
    'Disconnecting',
    async () => {
      const id = z.uuid().parse(accountId);
      const { db } = getDeps();
      const [row] = await db.select().from(socialAccounts).where(eq(socialAccounts.id, id));
      if (!row || row.status === 'disabled') throw new UserError('This account is not connected.');

      const group =
        row.authKind === 'meta_fb_login'
          ? await db
              .select()
              .from(socialAccounts)
              .where(
                and(
                  eq(socialAccounts.authKind, 'meta_fb_login'),
                  ne(socialAccounts.status, 'disabled'),
                ),
              )
          : [row];

      // One Meta revoke covers the whole login; prefer the Facebook row (it holds the user token).
      const revokeRow = group.find((r) => r.platform === 'facebook') ?? group[0]!;
      const note = await tryRevoke(revokeRow);
      for (const r of group) await disconnectAccount(db, r.id);

      const names = group.map((r) => PLATFORM_NAME[r.platform]).join(' & ');
      const where =
        row.platform === 'youtube'
          ? 'myaccount.google.com/permissions'
          : 'Facebook Settings → Business integrations';
      return ok(
        note
          ? `${names} disconnected here, but ${note}. Remove access at ${where}.`
          : `${names} disconnected`,
      );
    },
    ['/settings', '/calendar'],
  );
}

const PLATFORM_NAME: Record<SocialAccount['platform'], string> = {
  youtube: 'YouTube',
  facebook: 'Facebook',
  instagram: 'Instagram',
};
