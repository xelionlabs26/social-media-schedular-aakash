import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notifications } from '@app/db';
import { updateSettings } from '../settings';
import { FakeClock, makeDeps, openTestDb, type TestDb } from '../scheduling/test-helpers';
import { discoverTelegramChatId, formatAlert, notify } from './index';

const tdb = await openTestDb('notify');
if (!tdb) console.warn('TEST_DATABASE_URL is not set: skipping database tests in notify.test.ts');
const SKIP_NOTE = tdb ? '' : ' [skipped: TEST_DATABASE_URL is not set]';

const TOKEN = '123456:SECRET-bot-token';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('formatAlert', () => {
  it('adds the deep link (default: the calendar) and stays under the Telegram limit', () => {
    expect(formatAlert({ kind: 'test', message: ' Hello ' }, 'https://app.test')).toBe(
      'Hello\nhttps://app.test/calendar',
    );
    expect(
      formatAlert(
        { kind: 'test', message: 'x', link: 'https://app.test/settings' },
        'https://app.test',
      ),
    ).toBe('x\nhttps://app.test/settings');
    expect(
      formatAlert({ kind: 'test', message: 'y'.repeat(5000) }, 'https://app.test').length,
    ).toBeLessThanOrEqual(4096);
  });
});

describe.skipIf(!tdb)(`notify (database + mocked fetch)${SKIP_NOTE}`, () => {
  const { db } = tdb ?? ({} as TestDb);
  const clock = new FakeClock('2026-11-13T06:00:00Z');
  const fetchMock = vi.fn<typeof fetch>();
  const telegramDeps = () => makeDeps(db, clock, { TELEGRAM_BOT_TOKEN: TOKEN });

  beforeEach(async () => {
    await tdb!.reset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await tdb?.close();
  });

  it('returns a reason instead of throwing when Telegram is not set up', async () => {
    expect(await notify(makeDeps(db, clock), { kind: 'test', message: 'hi' })).toEqual({
      sent: false,
      reason: 'TELEGRAM_BOT_TOKEN is not set.',
    });
    expect((await notify(telegramDeps(), { kind: 'test', message: 'hi' })).reason).toMatch(
      /No Telegram chat linked/,
    );
    await updateSettings(db, { notifyChannel: 'none', telegramChatId: '42' });
    expect((await notify(telegramDeps(), { kind: 'test', message: 'hi' })).reason).toMatch(
      /turned off/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await db.select().from(notifications)).toEqual([]);
  });

  it('sends a Telegram message and never sends the same dedupe key twice', async () => {
    await updateSettings(db, { telegramChatId: '42' });
    fetchMock.mockResolvedValue(json(200, { ok: true, result: { message_id: 1 } }));
    const job = {
      kind: 'publish_failed' as const,
      message: "YouTube: 'Gym PR' failed",
      dedupeKey: 'failed:t1',
    };

    expect(await notify(telegramDeps(), job)).toEqual({ sent: true });
    expect(await notify(telegramDeps(), job)).toEqual({ sent: false, reason: 'Already sent.' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' } });
    expect(JSON.parse(init!.body as string)).toEqual({
      chat_id: '42',
      text: "YouTube: 'Gym PR' failed\nhttps://app.test/calendar",
      link_preview_options: { is_disabled: true },
    });
    const rows = await db.select().from(notifications);
    expect(rows).toMatchObject([
      {
        kind: 'publish_failed',
        channel: 'telegram',
        dedupeKey: 'failed:t1',
        error: null,
        sentAt: clock.now(),
      },
    ]);
  });

  it('records permanent errors and retries a failed key on the next call', async () => {
    await updateSettings(db, { telegramChatId: '42' });
    fetchMock.mockResolvedValueOnce(
      json(403, {
        ok: false,
        error_code: 403,
        description: 'Forbidden: bot was blocked by the user',
      }),
    );
    const job = { kind: 'missed' as const, message: 'missed', dedupeKey: 'missed:t1' };

    const first = await notify(telegramDeps(), job);
    expect(first).toMatchObject({ sent: false, retryable: false });
    expect(first.reason).toMatch(
      /Telegram error 403: Forbidden: bot was blocked by the user\. Open the bot/,
    );
    expect((await db.select().from(notifications))[0]!.error).toMatch(/403/);

    fetchMock.mockResolvedValueOnce(json(200, { ok: true, result: {} }));
    expect(await notify(telegramDeps(), job)).toEqual({ sent: true });
    expect(await db.select().from(notifications)).toHaveLength(1);
  });

  it('marks flood control, 5xx and network errors retryable without leaking the token', async () => {
    await updateSettings(db, { telegramChatId: '42' });
    fetchMock.mockResolvedValueOnce(
      json(429, {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 5',
        parameters: { retry_after: 5 },
      }),
    );
    expect(await notify(telegramDeps(), { kind: 'test', message: 'a' })).toMatchObject({
      sent: false,
      retryable: true,
    });

    fetchMock.mockResolvedValueOnce(
      json(502, { ok: false, error_code: 502, description: 'Bad Gateway' }),
    );
    expect(await notify(telegramDeps(), { kind: 'test', message: 'b' })).toMatchObject({
      sent: false,
      retryable: true,
    });

    fetchMock.mockRejectedValueOnce(
      new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`),
    );
    const res = await notify(telegramDeps(), { kind: 'test', message: 'c' });
    expect(res).toMatchObject({ sent: false, retryable: true });
    expect(res.reason).not.toContain(TOKEN);
    for (const row of await db.select().from(notifications))
      expect(row.error ?? '').not.toContain(TOKEN);
  });

  it('sends email through Resend when the owner chose email', async () => {
    await updateSettings(db, { notifyChannel: 'email', notifyEmail: 'owner@example.com' });
    const deps = makeDeps(db, clock, {
      RESEND_API_KEY: 're_test_key',
      NOTIFY_FROM_EMAIL: 'Scheduler <alerts@example.com>',
    });
    fetchMock.mockResolvedValueOnce(json(200, { id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' }));

    expect(
      await notify(deps, {
        kind: 'quota',
        message: 'YouTube limit reached\nmore',
        dedupeKey: 'q1',
      }),
    ).toEqual({ sent: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer re_test_key');
    expect(headers['Content-Type']).toBe('application/json');
    const [row] = await db.select().from(notifications);
    expect(headers['Idempotency-Key']).toBe(`notification-${row!.id}`);
    expect(JSON.parse(init!.body as string)).toEqual({
      from: 'Scheduler <alerts@example.com>',
      to: ['owner@example.com'],
      subject: 'YouTube limit reached',
      text: 'YouTube limit reached\nmore\nhttps://app.test/calendar',
    });

    fetchMock.mockResolvedValueOnce(
      json(429, { statusCode: 429, name: 'daily_quota_exceeded', message: 'quota' }),
    );
    expect(await notify(deps, { kind: 'test', message: 'x' })).toMatchObject({
      sent: false,
      retryable: false,
    });
    fetchMock.mockResolvedValueOnce(
      json(429, { statusCode: 429, name: 'rate_limit_exceeded', message: 'slow down' }),
    );
    expect(await notify(deps, { kind: 'test', message: 'y' })).toMatchObject({
      sent: false,
      retryable: true,
    });
    fetchMock.mockResolvedValueOnce(
      json(422, { statusCode: 422, name: 'missing_required_field', message: 'from missing' }),
    );
    const bad = await notify(deps, { kind: 'test', message: 'z' });
    expect(bad).toMatchObject({ sent: false, retryable: false });
    expect(bad.reason).toBe('Resend error 422 (missing_required_field): from missing');
  });

  describe('discoverTelegramChatId', () => {
    it('returns null without a token', async () => {
      expect(await discoverTelegramChatId(makeDeps(db, clock))).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('finds the private chat of the latest message', async () => {
      fetchMock.mockResolvedValueOnce(
        json(200, {
          ok: true,
          result: [
            { update_id: 10, message: { chat: { id: 111, type: 'private' } } },
            { update_id: 12, message: { chat: { id: -500, type: 'group' } } },
            { update_id: 11, message: { chat: { id: 222, type: 'private' } } },
          ],
        }),
      );
      expect(await discoverTelegramChatId(telegramDeps())).toBe('222');
      expect(fetchMock.mock.calls[0]![0]).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates`);
    });

    it('returns null when nobody messaged the bot and explains API errors', async () => {
      fetchMock.mockResolvedValueOnce(json(200, { ok: true, result: [] }));
      expect(await discoverTelegramChatId(telegramDeps())).toBeNull();
      fetchMock.mockResolvedValueOnce(
        json(401, { ok: false, error_code: 401, description: 'Unauthorized' }),
      );
      await expect(discoverTelegramChatId(telegramDeps())).rejects.toThrow(
        /rejected the bot token/,
      );
      fetchMock.mockResolvedValueOnce(
        json(409, { ok: false, error_code: 409, description: 'Conflict' }),
      );
      await expect(discoverTelegramChatId(telegramDeps())).rejects.toThrow(/webhook/);
    });
  });
});
