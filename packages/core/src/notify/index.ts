/**
 * Alerts to the owner: Telegram (default) or email via Resend. (Module owner: scheduler.)
 *
 * - Telegram Bot API: POST https://api.telegram.org/bot<token>/sendMessage with a JSON body;
 *   responses are `{ ok, result }` or `{ ok: false, error_code, description, parameters }`
 *   (https://core.telegram.org/bots/api#making-requests, #sendmessage, #responseparameters).
 * - Resend: POST https://api.resend.com/emails, `Authorization: Bearer <key>`, JSON
 *   `{ from, to, subject, text }`, optional `Idempotency-Key` header (≤256 chars, kept 24 h)
 *   (https://resend.com/docs/api-reference/emails/send-email, /errors, /rate-limit).
 *
 * Every alert is stored in `notifications`; `dedupe_key` is unique, so the same key is sent at
 * most once even when the job runs twice.
 */
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { notifications, type AppSettings, type NotifyChannel } from '@app/db';
import type { ServiceDeps } from '../deps';
import type { Env } from '../env';
import type { NotifyJob } from '../jobs';
import { getSettings } from '../settings';

export interface NotifyResult {
  sent: boolean;
  reason?: string;
  /** The send failed for a reason that may pass (network, 5xx, rate limit): try again later. */
  retryable?: boolean;
}

const TELEGRAM_API = 'https://api.telegram.org';
const RESEND_API = 'https://api.resend.com/emails';
/** Telegram's text limit is 4096 characters after entity parsing; we send plain text. */
const TELEGRAM_MAX_CHARS = 4096;
const REQUEST_TIMEOUT_MS = 15_000;
/** A claimed-but-unfinished row older than this belongs to a crashed attempt and may be reused. */
const STALE_CLAIM_MS = 10 * 60_000;

/** The text of an alert: short and plain, with a deep link into the app. */
export function formatAlert(job: NotifyJob, appUrl: string): string {
  const link = job.link ?? `${appUrl}/calendar`;
  const room = TELEGRAM_MAX_CHARS - link.length - 2;
  const message = job.message.trim();
  const body = message.length > room ? `${message.slice(0, room - 1)}…` : message;
  return `${body}\n${link}`;
}

interface SendOutcome {
  ok: boolean;
  error?: string;
  retryable?: boolean;
}

type ChannelCheck = { ok: true } | { ok: false; reason: string };

function channelReady(channel: NotifyChannel, settings: AppSettings, env: Env): ChannelCheck {
  if (channel === 'telegram') {
    if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, reason: 'TELEGRAM_BOT_TOKEN is not set.' };
    if (!settings.telegramChatId) {
      return {
        ok: false,
        reason: 'No Telegram chat linked yet: message the bot, then link it in Settings.',
      };
    }
    return { ok: true };
  }
  if (channel === 'email') {
    if (!env.RESEND_API_KEY || !env.NOTIFY_FROM_EMAIL) {
      return {
        ok: false,
        reason: 'RESEND_API_KEY and NOTIFY_FROM_EMAIL must be set for email alerts.',
      };
    }
    if (!settings.notifyEmail)
      return { ok: false, reason: 'No alert email address set in Settings.' };
    return { ok: true };
  }
  return { ok: false, reason: 'Alerts are turned off in Settings.' };
}

/**
 * Sends one alert on the channel chosen in settings. De-duplicates by job.dedupeKey using the
 * notifications table. Never throws for "not configured": returns sent=false with a reason.
 */
export async function notify(deps: ServiceDeps, job: NotifyJob): Promise<NotifyResult> {
  const settings = await getSettings(deps.db);
  const channel = settings.notifyChannel;
  const ready = channelReady(channel, settings, deps.env);
  if (!ready.ok) {
    // Nothing is stored, so the alert can still go out once the channel is set up.
    deps.log.info('alert not sent', { kind: job.kind, reason: ready.reason });
    return { sent: false, reason: ready.reason };
  }

  const claim = await claimNotification(deps, job, channel);
  if (!claim) return { sent: false, reason: 'Already sent.' };

  const text = formatAlert(job, deps.env.APP_URL);
  const out =
    channel === 'telegram'
      ? await sendTelegram(deps.env.TELEGRAM_BOT_TOKEN!, settings.telegramChatId!, text)
      : await sendEmail(deps.env, settings.notifyEmail!, job, text, claim);

  await deps.db
    .update(notifications)
    .set(out.ok ? { sentAt: deps.now(), error: null } : { error: out.error ?? 'Send failed.' })
    .where(eq(notifications.id, claim));
  if (out.ok) return { sent: true };
  deps.log.warn('alert send failed', {
    kind: job.kind,
    channel,
    error: out.error,
    retryable: out.retryable,
  });
  return { sent: false, reason: out.error, retryable: out.retryable };
}

/**
 * Creates the history row and claims the dedupe key. Returns the row id to send with, or null
 * when the key was already sent (or is being sent right now).
 */
async function claimNotification(
  deps: ServiceDeps,
  job: NotifyJob,
  channel: NotifyChannel,
): Promise<string | null> {
  const now = deps.now();
  const values = {
    kind: job.kind,
    targetId: job.targetId ?? null,
    channel,
    dedupeKey: job.dedupeKey ?? null,
    payload: { message: job.message, link: job.link ?? null },
    createdAt: now,
  };
  if (!job.dedupeKey) {
    const rows = await deps.db
      .insert(notifications)
      .values(values)
      .returning({ id: notifications.id });
    return rows[0]!.id;
  }
  const inserted = await deps.db
    .insert(notifications)
    .values(values)
    .onConflictDoNothing({ target: notifications.dedupeKey })
    .returning({ id: notifications.id });
  if (inserted[0]) return inserted[0].id;

  const [existing] = await deps.db
    .select()
    .from(notifications)
    .where(eq(notifications.dedupeKey, job.dedupeKey));
  if (!existing || existing.sentAt) return null;
  // A previous attempt failed (error set) or crashed mid-send (stale claim): retry with it.
  const stale = now.getTime() - existing.createdAt.getTime() > STALE_CLAIM_MS;
  const reclaimed = await deps.db
    .update(notifications)
    .set({ error: null, channel, createdAt: now })
    .where(
      and(
        eq(notifications.id, existing.id),
        isNull(notifications.sentAt),
        stale ? undefined : isNotNull(notifications.error),
      ),
    )
    .returning({ id: notifications.id });
  return reclaimed[0]?.id ?? null;
}

// ---------------------------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------------------------

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

/** Never let the bot token (it is part of the URL) leak into stored errors or logs. */
const scrub = (text: string, token: string) => (token ? text.split(token).join('[token]') : text);

async function telegramCall<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<{ status: number; data: TelegramResponse<T> | null; networkError?: string }> {
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => null)) as TelegramResponse<T> | null;
    return { status: res.status, data };
  } catch (err) {
    return {
      status: 0,
      data: null,
      networkError: scrub((err as Error).message ?? 'network error', token),
    };
  }
}

async function sendTelegram(token: string, chatId: string, text: string): Promise<SendOutcome> {
  const { status, data, networkError } = await telegramCall(token, 'sendMessage', {
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
  });
  if (networkError)
    return { ok: false, retryable: true, error: `Telegram unreachable: ${networkError}` };
  if (data?.ok) return { ok: true };
  const code = data?.error_code ?? status;
  const description = scrub(data?.description ?? `HTTP ${status}`, token);
  // 429 = flood control (parameters.retry_after), 5xx = Telegram trouble: worth retrying.
  // 400 chat not found / 401 bad token / 403 bot blocked won't fix themselves.
  const retryable = code === 429 || code >= 500;
  const hint =
    code === 401
      ? ' Check TELEGRAM_BOT_TOKEN.'
      : code === 403 || code === 400
        ? ' Open the bot in Telegram, press Start, then link the chat again in Settings.'
        : '';
  return { ok: false, retryable, error: `Telegram error ${code}: ${description}.${hint}` };
}

/**
 * Finds the Telegram chat id of the last person who messaged the bot (setup helper). Returns
 * null when the bot token is not set or nobody has messaged the bot yet. getUpdates does not
 * work while a webhook is set (Telegram answers 409).
 */
export async function discoverTelegramChatId(deps: ServiceDeps): Promise<string | null> {
  const token = deps.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  type Chat = { id: number; type: string };
  type Update = {
    update_id: number;
    message?: { chat: Chat };
    edited_message?: { chat: Chat };
    my_chat_member?: { chat: Chat };
  };
  const { status, data, networkError } = await telegramCall<Update[]>(token, 'getUpdates', {
    limit: 100,
    timeout: 0,
  });
  if (networkError) throw new Error(`Telegram unreachable: ${networkError}`);
  if (!data?.ok) {
    const code = data?.error_code ?? status;
    const description = scrub(data?.description ?? `HTTP ${status}`, token);
    if (code === 409)
      throw new Error('Telegram: a webhook is set for this bot, so updates cannot be read.');
    if (code === 401) throw new Error('Telegram rejected the bot token. Check TELEGRAM_BOT_TOKEN.');
    throw new Error(`Telegram error ${code}: ${description}`);
  }
  const updates = [...(data.result ?? [])].sort((a, b) => b.update_id - a.update_id);
  for (const u of updates) {
    const chat = u.message?.chat ?? u.edited_message?.chat ?? u.my_chat_member?.chat;
    if (chat && chat.type === 'private') return String(chat.id);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Email (Resend)
// ---------------------------------------------------------------------------------------------

interface ResendError {
  name?: string;
  message?: string;
  statusCode?: number;
}

async function sendEmail(
  env: Env,
  to: string,
  job: NotifyJob,
  text: string,
  notificationId: string,
): Promise<SendOutcome> {
  const firstLine = job.message.split('\n')[0]!.trim();
  const subject = firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine;
  let res: Response;
  try {
    res = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        // Same id on a retry of the same alert: Resend sends it once (key kept 24 h).
        'Idempotency-Key': `notification-${notificationId}`,
      },
      body: JSON.stringify({ from: env.NOTIFY_FROM_EMAIL, to: [to], subject, text }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, retryable: true, error: `Resend unreachable: ${(err as Error).message}` };
  }
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => null)) as ResendError | null;
  const name = body?.name ?? `HTTP ${res.status}`;
  // rate_limit_exceeded (429) and 5xx pass; daily/monthly quota and validation errors don't.
  const retryable =
    res.status >= 500 ||
    name === 'rate_limit_exceeded' ||
    name === 'concurrent_idempotent_requests';
  return {
    ok: false,
    retryable,
    error: `Resend error ${res.status} (${name}): ${body?.message ?? 'send failed'}`,
  };
}
