'use client';

/**
 * Alerts (PLAN.md §5.9): Telegram (default), email or none; chat-id detection; daily digest;
 * a test message.
 */
import { useState } from 'react';
import type { NotifyChannel } from '@app/db/schema';
import {
  detectTelegramChatAction,
  saveNotificationsAction,
  sendTestNotificationAction,
} from '@/lib/actions/settings';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/field';
import type { IntegrationView } from './data';
import { EnvKeys, SaveBar, Section, Toggle, same, useSettingsAction } from './parts';
import { NotificationsSchema, firstIssue } from './schemas';

interface Form {
  notifyChannel: NotifyChannel;
  telegramChatId: string;
  notifyEmail: string;
  dailyDigest: boolean;
}

const CHANNELS: Array<{ id: NotifyChannel; label: string }> = [
  { id: 'telegram', label: 'Telegram' },
  { id: 'email', label: 'Email' },
  { id: 'none', label: 'None' },
];

export function NotificationsSection({
  initial,
  telegram,
  email,
}: {
  initial: Form;
  telegram: IntegrationView;
  email: IntegrationView;
}) {
  const { pending, run } = useSettingsAction();
  const [baseline, setBaseline] = useState(initial);
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const dirty = !same(form, baseline);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = () => {
    const parsed = NotificationsSchema.safeParse(form);
    if (!parsed.success) {
      setError(firstIssue(parsed.error));
      return;
    }
    setError(null);
    run(
      () => saveNotificationsAction(form),
      () => setBaseline(form),
    );
  };

  const detect = () =>
    run(detectTelegramChatAction, (data) => {
      if (!data?.chatId) return;
      // The action saved it already; keep the form and its baseline in sync.
      setForm((f) => ({ ...f, telegramChatId: data.chatId }));
      setBaseline((b) => ({ ...b, telegramChatId: data.chatId }));
    });

  return (
    <Section
      id="notifications"
      title="Notifications"
      description="Alerts when a post fails, an account needs reconnecting, a login is about to expire or a post was missed."
    >
      <fieldset>
        <legend className="mb-1 text-sm font-medium">Send alerts by</legend>
        <div className="flex flex-wrap gap-4">
          {CHANNELS.map((c) => (
            <label key={c.id} className="flex min-h-10 items-center gap-2 text-sm">
              <input
                type="radio"
                name="notify-channel"
                value={c.id}
                checked={form.notifyChannel === c.id}
                onChange={() => set('notifyChannel', c.id)}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              {c.label}
              {c.id === 'telegram' ? ' (recommended)' : ''}
            </label>
          ))}
        </div>
      </fieldset>

      {form.notifyChannel === 'telegram' ? (
        <div className="mt-3 rounded-lg border border-border p-3">
          {!telegram.configured ? (
            <p className="mb-2 text-xs text-muted">
              Paste your Telegram bot token under{' '}
              <a href="#setup" className="underline">
                Setup
              </a>{' '}
              first (it shows how to get one).
            </p>
          ) : null}
          <Label htmlFor="tg-chat" hint="A number, found automatically">
            Telegram chat id
          </Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="tg-chat"
              inputMode="numeric"
              value={form.telegramChatId}
              onChange={(e) => set('telegramChatId', e.target.value)}
              className="w-56 max-w-full"
              placeholder="123456789"
            />
            <Button onClick={detect} disabled={pending || !telegram.configured}>
              Detect chat id
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted">
            Message your bot first (send it any text in Telegram), then click Detect chat id.
          </p>
        </div>
      ) : null}

      {form.notifyChannel === 'email' ? (
        <div className="mt-3 rounded-lg border border-border p-3">
          {!email.configured ? (
            <p className="mb-2 text-xs text-muted">
              Email needs <EnvKeys keys={email.missingKeys} /> in your <code>.env</code> file.
            </p>
          ) : null}
          <Label htmlFor="notify-email">Email address</Label>
          <Input
            id="notify-email"
            type="email"
            autoComplete="email"
            value={form.notifyEmail}
            onChange={(e) => set('notifyEmail', e.target.value)}
            className="max-w-sm"
          />
        </div>
      ) : null}

      <div className="mt-3">
        <Toggle
          checked={form.dailyDigest}
          onChange={(v) => set('dailyDigest', v)}
          label="Daily digest"
          hint="Each evening: tomorrow's posts."
          disabled={form.notifyChannel === 'none'}
        />
      </div>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <SaveBar dirty={dirty} pending={pending} onSave={save}>
        <Button
          variant="ghost"
          onClick={() => run(sendTestNotificationAction)}
          disabled={pending || dirty || baseline.notifyChannel === 'none'}
          title={dirty ? 'Save first' : undefined}
        >
          Send test
        </Button>
      </SaveBar>
    </Section>
  );
}
