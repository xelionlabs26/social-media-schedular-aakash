/**
 * Alerts to the owner: Telegram (default) or email via Resend. (Module owner: scheduler.)
 */
import type { NotifyJob } from '../jobs';
import { NotImplementedError, type ServiceDeps } from '../deps';

/**
 * Sends one alert on the channel chosen in settings. De-duplicates by job.dedupeKey using the
 * notifications table. Never throws for "not configured": returns sent=false with a reason.
 */
export async function notify(
  _deps: ServiceDeps,
  _job: NotifyJob,
): Promise<{ sent: boolean; reason?: string }> {
  throw new NotImplementedError('notify.notify');
}

/** Finds the Telegram chat id of the last person who messaged the bot (setup helper). */
export async function discoverTelegramChatId(_deps: ServiceDeps): Promise<string | null> {
  throw new NotImplementedError('notify.discoverTelegramChatId');
}
