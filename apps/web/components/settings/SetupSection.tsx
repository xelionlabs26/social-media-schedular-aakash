'use client';

/**
 * Setup: the one-time keys, pasted here instead of into .env. Each group has short steps for
 * getting its keys, copy buttons for the addresses Google/Meta ask for, and the paste boxes.
 * Saved secrets are never sent back to the browser (only "••••1234").
 */
import { useId, useState, type ReactNode } from 'react';
import type { UiKeyName } from '@app/core/env';
import type { KeyStatus } from '@app/core/keys';
import { removeKeysAction, saveKeysAction } from '@/lib/actions/settings';
import { Badge } from '@/components/ui/badges';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Input } from '@/components/ui/field';
import { KEY_GROUPS, type KeyGroup, type KeyGroupId } from './keys-meta';
import { Section, useSettingsAction } from './parts';

export interface SetupUrls {
  app: string;
  googleRedirect: string;
  metaRedirect: string;
  privacy: string;
  terms: string;
  dataDeletion: string;
}

const META_PERMISSIONS = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'pages_read_user_content',
  'business_management',
  'instagram_basic',
  'instagram_content_publish',
];

export function SetupSection({
  keys,
  urls,
  canSave,
}: {
  keys: Record<UiKeyName, KeyStatus>;
  urls: SetupUrls;
  canSave: boolean;
}) {
  const ready = (g: KeyGroup) =>
    g.fields.filter((f) => f.required).every((f) => keys[f.name].source !== 'none');
  const missingCount = KEY_GROUPS.filter((g) => !g.optional && !ready(g)).length;

  return (
    <Section
      id="setup"
      title="Setup"
      description={
        missingCount === 0
          ? 'All keys are in. You can connect your accounts below.'
          : 'Paste each key once. They are stored encrypted in your app and never shown again.'
      }
    >
      {!canSave ? (
        <p className="mb-3 rounded-lg bg-danger/10 p-3 text-sm text-danger">
          TOKEN_ENC_KEY is missing on the server, so keys can&apos;t be stored safely. Run the
          Codespace setup again, or add it to .env.
        </p>
      ) : null}
      {!urls.app.startsWith('https://') && !urls.app.startsWith('http://localhost') ? (
        <p className="mb-3 rounded-lg bg-warn/10 p-3 text-sm text-warn">
          The app address ({urls.app}) is not https. Google and Facebook only accept https
          addresses.
        </p>
      ) : null}
      <div className="space-y-3">
        {KEY_GROUPS.map((g) => (
          <KeyGroupCard
            key={g.id}
            group={g}
            keys={keys}
            ready={ready(g)}
            canSave={canSave}
            guide={<Guide id={g.id} urls={urls} />}
          />
        ))}
      </div>
    </Section>
  );
}

function KeyGroupCard({
  group,
  keys,
  ready,
  canSave,
  guide,
}: {
  group: KeyGroup;
  keys: Record<UiKeyName, KeyStatus>;
  ready: boolean;
  canSave: boolean;
  guide: ReactNode;
}) {
  const { pending, run } = useSettingsAction();
  const [values, setValues] = useState<Partial<Record<UiKeyName, string>>>({});
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [open, setOpen] = useState(!ready && !group.optional);
  const savedHere = group.fields.filter((f) => keys[f.name].source === 'app').map((f) => f.name);
  const editable = group.fields.filter((f) => keys[f.name].source !== 'env');
  const dirty = Object.values(values).some((v) => v && v.trim() !== '');

  const save = () =>
    run(
      () => saveKeysAction(values),
      () => setValues({}),
    );

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="group rounded-lg border border-border"
    >
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 p-3 [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden
          className="text-muted transition-transform group-open:rotate-90 motion-reduce:transition-none"
        >
          ›
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{group.title}</span>
          <span className="block text-xs text-muted">{group.purpose}</span>
        </span>
        {ready ? (
          <Badge tone="ok">✓ Ready</Badge>
        ) : group.optional ? (
          <Badge>Optional</Badge>
        ) : (
          <Badge tone="warn">Needs keys</Badge>
        )}
      </summary>

      <div className="border-t border-border p-3">
        {guide}

        <div className="mt-4 space-y-3">
          {group.fields.map((f) => {
            const st = keys[f.name];
            return (
              <KeyInput
                key={f.name}
                label={f.label}
                hint={f.hint}
                secret={f.secret}
                placeholder={
                  st.source === 'none'
                    ? f.placeholder
                    : st.source === 'app'
                      ? 'Paste a new value to replace it'
                      : ''
                }
                status={st}
                value={values[f.name] ?? ''}
                disabled={st.source === 'env' || !canSave || pending}
                onChange={(v) => setValues((cur) => ({ ...cur, [f.name]: v }))}
              />
            );
          })}
        </div>

        {editable.length > 0 ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={save} disabled={!dirty || !canSave || pending}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
            {savedHere.length > 0 ? (
              <Button variant="danger" onClick={() => setConfirmRemove(true)} disabled={pending}>
                Remove
              </Button>
            ) : null}
            {dirty ? <span className="text-xs text-warn">Not saved yet</span> : null}
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmRemove}
        title={`Remove the ${group.title} keys?`}
        confirmLabel="Remove"
        danger
        loading={pending}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() =>
          run(
            () => removeKeysAction(savedHere),
            () => setConfirmRemove(false),
          )
        }
      >
        The app forgets these keys. Connected accounts stay listed, but nothing can be posted with
        them until you paste the keys again.
      </ConfirmDialog>
    </details>
  );
}

function KeyInput({
  label,
  hint,
  secret,
  placeholder,
  status,
  value,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  secret: boolean;
  placeholder: string;
  status: KeyStatus;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <span className="text-xs text-muted">
          {status.source === 'env' ? (
            <>Set in the server&apos;s .env</>
          ) : status.source === 'app' ? (
            <span className="text-ok">
              ✓ Saved <span className="break-all font-mono">{status.display}</span>
            </span>
          ) : status.unreadable ? (
            <span className="text-danger">! Can&apos;t be read any more. Paste it again.</span>
          ) : (
            'Not set'
          )}
        </span>
      </div>
      <Input
        id={id}
        type={secret ? 'password' : 'text'}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono placeholder:font-sans"
      />
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Step-by-step guides
// ---------------------------------------------------------------------------------------------

function Guide({ id, urls }: { id: KeyGroupId; urls: SetupUrls }) {
  switch (id) {
    case 'google':
      return (
        <Steps
          intro="About 10 minutes, done once. Use the Google account that owns your YouTube channel."
          footer={
            <>
              When you click <b>Connect YouTube</b>, Google says it hasn&apos;t verified this app.
              That&apos;s normal for an app only you use: click <b>Advanced</b>, then{' '}
              <b>Go to (your app name)</b>.
            </>
          }
        >
          <li>
            <Ext href="https://console.cloud.google.com/projectcreate">
              Create a Google Cloud project
            </Ext>{' '}
            with any name.
          </li>
          <li>
            Open{' '}
            <Ext href="https://console.cloud.google.com/apis/library/youtube.googleapis.com">
              YouTube Data API v3
            </Ext>{' '}
            and click <b>Enable</b>.
          </li>
          <li>
            Open{' '}
            <Ext href="https://console.cloud.google.com/auth/overview">Google Auth Platform</Ext> →{' '}
            <b>Get started</b>. App name: anything <i>without</i> “YouTube” or “Google”. Audience:{' '}
            <b>External</b>. Add your email where asked. Don&apos;t upload a logo.
          </li>
          <li>
            <b>Data access</b> → <b>Add or remove scopes</b> → tick{' '}
            <code className="text-xs">…/auth/youtube.force-ssl</code> → <b>Update</b> → <b>Save</b>.
          </li>
          <li>
            <b>Audience</b> → <b>Publish app</b> → <b>Confirm</b>. This stops your YouTube login
            from expiring every 7 days.
          </li>
          <li>
            <b>Clients</b> → <b>Create client</b> → type <b>Web application</b>. Under{' '}
            <b>Authorized redirect URIs</b> click <b>Add URI</b> and paste:
            <Copy value={urls.googleRedirect} />
            Then click <b>Create</b>.
          </li>
          <li>Copy the Client ID and Client secret into the boxes below.</li>
        </Steps>
      );
    case 'meta':
      return (
        <Steps
          intro={
            <>
              About 15 minutes, done once. First, in the Instagram app: switch to a{' '}
              <b>Professional</b> account (Creator is fine) and link it to the Facebook Page you
              manage.
            </>
          }
        >
          <li>
            Open <Ext href="https://developers.facebook.com/apps">Meta for Developers</Ext> →{' '}
            <b>Create app</b>. Name: anything <i>without</i> “Facebook” or “Instagram”. Use case{' '}
            <b>Other</b>, app type <b>Business</b>.
          </li>
          <li>
            Add the product <b>Facebook Login for Business</b> → <b>Settings</b>. Under{' '}
            <b>Valid OAuth Redirect URIs</b> paste:
            <Copy value={urls.metaRedirect} />
            and save.
          </li>
          <li>
            <b>Facebook Login for Business</b> → <b>Configurations</b> → <b>Create</b>. Token type:{' '}
            <b>User access token</b>. Assets: your <b>Page</b> and <b>Instagram account</b>.
            Permissions:
            <span className="my-1.5 flex flex-wrap gap-1">
              {META_PERMISSIONS.map((p) => (
                <code key={p} className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">
                  {p}
                </code>
              ))}
            </span>
            Create it and copy its <b>Configuration ID</b>.
          </li>
          <li>
            Add the product <b>Instagram</b> → <b>API setup with Facebook login</b>.
          </li>
          <li>
            <b>App settings</b> → <b>Basic</b>. Privacy policy URL:
            <Copy value={urls.privacy} />
            Terms of service URL:
            <Copy value={urls.terms} />
            User data deletion (instructions URL):
            <Copy value={urls.dataDeletion} />
            Save. Then copy the <b>App ID</b>, and click <b>Show</b> to copy the <b>App secret</b>.
          </li>
          <li>Paste the App ID, App secret and Configuration ID below.</li>
        </Steps>
      );
    case 'claude':
      return (
        <Steps intro="About 2 minutes.">
          <li>
            Open <Ext href="https://platform.claude.com/settings/keys">Claude API keys</Ext> →{' '}
            <b>Create key</b>, and copy it (it is shown only once).
          </li>
          <li>
            Set a monthly spend limit under{' '}
            <Ext href="https://platform.claude.com/settings/limits">Limits</Ext> (for example $20).
            Each video costs about 3–4 cents.
          </li>
          <li>Paste the key below.</li>
        </Steps>
      );
    case 'stt':
      return (
        <Steps intro="About 2 minutes. Deepgram gives $200 of free credit.">
          <li>
            Open the <Ext href="https://console.deepgram.com">Deepgram console</Ext> →{' '}
            <b>API Keys</b> → <b>Create a New API Key</b>, and copy it.
          </li>
          <li>
            Paste it below. The other providers are optional; pick which one listens under{' '}
            <a href="#ai" className="underline">
              AI style
            </a>
            .
          </li>
        </Steps>
      );
    case 'telegram':
      return (
        <Steps intro="Optional, about 2 minutes.">
          <li>
            In Telegram, message <Ext href="https://t.me/BotFather">@BotFather</Ext>, send{' '}
            <code className="text-xs">/newbot</code> and follow the questions.
          </li>
          <li>Copy the token it gives you and paste it below.</li>
          <li>
            Send your new bot any message, then choose Telegram under{' '}
            <a href="#notifications" className="underline">
              Notifications
            </a>{' '}
            and click <b>Detect chat id</b>.
          </li>
        </Steps>
      );
  }
}

function Steps({
  intro,
  footer,
  children,
}: {
  intro: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="text-sm leading-relaxed">
      <p className="text-muted">{intro}</p>
      <ol className="mt-2 list-decimal space-y-2 pl-5 marker:text-muted">{children}</ol>
      {footer ? <p className="mt-3 rounded-lg bg-surface-2 p-2.5 text-xs">{footer}</p> : null}
    </div>
  );
}

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="font-medium underline">
      {children}
      <span aria-hidden> ↗</span>
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/** Read-only address with a Copy button (falls back to selecting the text). */
function Copy({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const id = useId();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const el = document.getElementById(id) as HTMLInputElement | null;
      el?.select();
    }
  };
  return (
    <span className="my-1.5 flex items-center gap-2">
      <input
        id={id}
        readOnly
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        aria-label="Address to copy"
        className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface-2 px-2 font-mono text-xs"
      />
      <Button size="sm" onClick={copy} aria-live="polite">
        {copied ? 'Copied ✓' : 'Copy'}
      </Button>
    </span>
  );
}
