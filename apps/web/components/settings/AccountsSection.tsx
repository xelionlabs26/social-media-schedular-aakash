'use client';

/**
 * Connected accounts (PLAN.md §5.7, §9): YouTube via Google, Facebook Page + Instagram via one
 * Meta login. Shows status, expiry and the last error; Reconnect re-runs the OAuth flow;
 * Disconnect revokes on the platform (when built) and forgets the tokens.
 */
import { useState } from 'react';
import { disconnectAccountAction } from '@/lib/actions/settings';
import { PlatformChip } from '@/components/ui/badges';
import { Badge } from '@/components/ui/badges';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm';
import { formatShort } from '@app/core/time';
import type { AccountView, IntegrationView } from './data';
import { Section, useSettingsAction } from './parts';

const GOOGLE_START = '/api/oauth/google/start';
const META_START = '/api/oauth/meta/start';
/** Warn when a token or Meta data access ends within this many days (PLAN.md §5.9). */
const EXPIRY_WARN_DAYS = 10;

export function AccountsSection({
  youtube,
  meta,
  integrations,
  timezone,
  nowIso,
}: {
  youtube: AccountView[];
  meta: AccountView[];
  integrations: { youtube: IntegrationView; meta: IntegrationView };
  timezone: string;
  nowIso: string;
}) {
  return (
    <Section
      id="accounts"
      title="Connected accounts"
      description="One account per platform. Tokens are stored encrypted and never leave the server."
    >
      <div className="grid gap-3 md:grid-cols-2">
        <Provider
          title="YouTube"
          explainer="Your YouTube channel. Uses Google sign-in with upload permission."
          connectLabel="Connect YouTube"
          setupLabel="YouTube (Google app)"
          startUrl={GOOGLE_START}
          accounts={youtube}
          integration={integrations.youtube}
          timezone={timezone}
          nowIso={nowIso}
        />
        <Provider
          title="Facebook Page & Instagram"
          explainer="One Meta login connects your Facebook Page and the Instagram professional account linked to it."
          connectLabel="Connect Facebook & Instagram"
          setupLabel="Facebook & Instagram (Meta app)"
          startUrl={META_START}
          accounts={meta}
          integration={integrations.meta}
          timezone={timezone}
          nowIso={nowIso}
        />
      </div>
    </Section>
  );
}

function Provider({
  title,
  explainer,
  connectLabel,
  setupLabel,
  startUrl,
  accounts,
  integration,
  timezone,
  nowIso,
}: {
  title: string;
  explainer: string;
  connectLabel: string;
  setupLabel: string;
  startUrl: string;
  accounts: AccountView[];
  integration: IntegrationView;
  timezone: string;
  nowIso: string;
}) {
  const { pending, run } = useSettingsAction();
  const [confirming, setConfirming] = useState(false);
  const connected = accounts.length > 0;
  const needsReconnect = accounts.some((a) => a.status === 'needs_reauth');

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-xs text-muted">{explainer}</p>
        </div>
        {connected ? (
          needsReconnect ? (
            <Badge tone="danger">! Needs reconnect</Badge>
          ) : (
            <Badge tone="ok">✓ Connected</Badge>
          )
        ) : (
          <Badge>Not connected</Badge>
        )}
      </div>

      {connected ? (
        <ul className="mt-3 space-y-2">
          {accounts.map((a) => (
            <AccountRow key={a.id} account={a} timezone={timezone} nowIso={nowIso} />
          ))}
        </ul>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {integration.configured ? (
          // Plain links: the OAuth start routes are GET endpoints that redirect to the platform.
          <a
            href={startUrl}
            className={
              !connected
                ? 'inline-flex h-10 items-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg hover:opacity-90'
                : needsReconnect
                  ? 'inline-flex h-8 items-center rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg hover:opacity-90'
                  : 'inline-flex h-8 items-center rounded-lg border border-border bg-surface px-3 text-sm font-medium hover:bg-surface-2'
            }
          >
            {connected ? 'Reconnect' : connectLabel}
          </a>
        ) : (
          <p className="w-full text-xs text-muted">
            {connected ? 'To reconnect, first paste the ' : 'First paste the '}
            {setupLabel} keys under{' '}
            <a href="#setup" className="font-medium text-text underline">
              Setup
            </a>
            . The button appears here once they&apos;re saved.
          </p>
        )}
        {/* Disconnect works even without the integration keys: it always forgets the login here. */}
        {connected ? (
          <Button size="sm" variant="danger" onClick={() => setConfirming(true)} disabled={pending}>
            Disconnect
          </Button>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirming}
        title={`Disconnect ${title}?`}
        confirmLabel="Disconnect"
        danger
        loading={pending}
        onCancel={() => setConfirming(false)}
        onConfirm={() =>
          run(
            () => disconnectAccountAction(accounts[0]!.id),
            () => setConfirming(false),
          )
        }
      >
        The app asks the platform to remove its access and forgets the stored login. Scheduled posts
        for this platform will need attention until you connect again. Videos already published stay
        online.
      </ConfirmDialog>
    </div>
  );
}

function daysUntil(iso: string, nowIso: string): number {
  return Math.floor((new Date(iso).getTime() - new Date(nowIso).getTime()) / 86_400_000);
}

function AccountRow({
  account: a,
  timezone,
  nowIso,
}: {
  account: AccountView;
  timezone: string;
  nowIso: string;
}) {
  // Google access tokens last an hour and are refreshed automatically, so their expiry is
  // noise; for Meta the token and data-access dates matter (PLAN.md §2, §5.7).
  const expiries: Array<{ label: string; iso: string }> = [];
  if (a.platform !== 'youtube' && a.accessExpiresAt)
    expiries.push({ label: 'Token expires', iso: a.accessExpiresAt });
  if (a.dataAccessExpiresAt)
    expiries.push({ label: 'Data access until', iso: a.dataAccessExpiresAt });

  return (
    <li className="rounded-md bg-surface-2 p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <PlatformChip platform={a.platform} />
        <span className="min-w-0 truncate font-medium">{a.name}</span>
        {a.handle ? <span className="truncate text-xs text-muted">{a.handle}</span> : null}
        <span className="ml-auto text-xs">
          {a.status === 'active' ? (
            <span className="text-ok">✓ Active</span>
          ) : (
            <span className="font-semibold text-danger">! Needs reconnect</span>
          )}
        </span>
      </div>
      {expiries.length || a.lastCheckedAt ? (
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-xs text-muted">
          {expiries.map((e) => {
            const left = daysUntil(e.iso, nowIso);
            return (
              <div key={e.label} className="contents">
                <dt>{e.label}</dt>
                <dd className={left <= EXPIRY_WARN_DAYS ? 'font-medium text-warn' : undefined}>
                  {formatShort(new Date(e.iso), timezone)}
                  {left < 0 ? ' (expired)' : left <= EXPIRY_WARN_DAYS ? ` (in ${left} days)` : ''}
                </dd>
              </div>
            );
          })}
          {a.lastCheckedAt ? (
            <div className="contents">
              <dt>Last checked</dt>
              <dd>{formatShort(new Date(a.lastCheckedAt), timezone)}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {a.lastError ? (
        <p className="mt-1 text-xs text-danger">
          <span aria-hidden>! </span>
          {a.lastError}
        </p>
      ) : null}
    </li>
  );
}
