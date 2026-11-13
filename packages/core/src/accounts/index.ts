/**
 * Social account storage: encrypts tokens on write, decrypts on read, and manages one-time
 * OAuth state (CSRF) records. Server-only.
 */
import { and, eq, gt, isNull } from 'drizzle-orm';
import {
  oauthFlows,
  socialAccounts,
  type AccountMeta,
  type AccountStatus,
  type Db,
  type Platform,
  type SocialAccount,
} from '@app/db';
import { decryptSecret, encryptSecret, randomToken, sha256Hex, tokenAad } from '../crypto';
import type { AccountCredentials } from '../platforms';
import { createHash } from 'node:crypto';

export interface UpsertAccountInput {
  platform: Platform;
  authKind: 'google' | 'meta_fb_login';
  externalId: string;
  displayName: string;
  avatarUrl?: string | null;
  accessToken: string;
  accessExpiresAt?: Date | null;
  refreshToken?: string | null;
  userAccessToken?: string | null;
  dataAccessExpiresAt?: Date | null;
  scopes: string[];
  meta: AccountMeta;
}

/**
 * Creates or updates the account for (platform, externalId). Tokens are encrypted with AAD bound
 * to the row id, so the row is inserted first and the tokens written right after.
 */
export async function upsertSocialAccount(
  db: Db,
  input: UpsertAccountInput,
): Promise<SocialAccount> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(socialAccounts)
      .where(
        and(
          eq(socialAccounts.platform, input.platform),
          eq(socialAccounts.externalId, input.externalId),
        ),
      )
      .limit(1);
    let id = existing[0]?.id;
    if (!id) {
      const inserted = await tx
        .insert(socialAccounts)
        .values({
          platform: input.platform,
          authKind: input.authKind,
          externalId: input.externalId,
          displayName: input.displayName,
          scopes: input.scopes,
          meta: input.meta,
        })
        .returning({ id: socialAccounts.id });
      id = inserted[0]!.id;
    }
    const enc = (value: string, kind: 'access' | 'refresh' | 'user') =>
      encryptSecret(value, tokenAad(input.platform, id!, kind));
    const rows = await tx
      .update(socialAccounts)
      .set({
        authKind: input.authKind,
        displayName: input.displayName,
        avatarUrl: input.avatarUrl ?? null,
        accessTokenEnc: enc(input.accessToken, 'access'),
        accessExpiresAt: input.accessExpiresAt ?? null,
        // Keep an existing refresh token if Google didn't send a new one.
        ...(input.refreshToken ? { refreshTokenEnc: enc(input.refreshToken, 'refresh') } : {}),
        ...(input.userAccessToken
          ? { userAccessTokenEnc: enc(input.userAccessToken, 'user') }
          : {}),
        dataAccessExpiresAt: input.dataAccessExpiresAt ?? null,
        scopes: input.scopes,
        meta: { ...(existing[0]?.meta ?? {}), ...input.meta },
        status: 'active',
        lastError: null,
        lastCheckedAt: new Date(),
      })
      .where(eq(socialAccounts.id, id))
      .returning();
    return rows[0]!;
  });
}

export function decryptAccount(row: SocialAccount): AccountCredentials {
  if (!row.accessTokenEnc) throw new Error(`Account ${row.id} has no access token`);
  const dec = (value: string | null, kind: 'access' | 'refresh' | 'user') =>
    value ? decryptSecret(value, tokenAad(row.platform, row.id, kind)) : undefined;
  return {
    accountId: row.id,
    platform: row.platform,
    externalId: row.externalId,
    accessToken: dec(row.accessTokenEnc, 'access')!,
    accessExpiresAt: row.accessExpiresAt,
    refreshToken: dec(row.refreshTokenEnc, 'refresh'),
    userAccessToken: dec(row.userAccessTokenEnc, 'user'),
    scopes: row.scopes,
    meta: row.meta,
  };
}

export async function getAccount(db: Db, id: string): Promise<SocialAccount | undefined> {
  const rows = await db.select().from(socialAccounts).where(eq(socialAccounts.id, id)).limit(1);
  return rows[0];
}

/** The connected (non-disabled) account for a platform. One account per platform in v1. */
export async function getAccountForPlatform(
  db: Db,
  platform: Platform,
): Promise<SocialAccount | undefined> {
  const rows = await db.select().from(socialAccounts).where(eq(socialAccounts.platform, platform));
  return rows.find((r) => r.status !== 'disabled') ?? undefined;
}

export async function listAccounts(db: Db): Promise<SocialAccount[]> {
  return db.select().from(socialAccounts);
}

/** Stores a refreshed access token (Google). */
export async function saveAccessToken(
  db: Db,
  account: Pick<SocialAccount, 'id' | 'platform'>,
  accessToken: string,
  expiresAt: Date | null,
): Promise<void> {
  await db
    .update(socialAccounts)
    .set({
      accessTokenEnc: encryptSecret(accessToken, tokenAad(account.platform, account.id, 'access')),
      accessExpiresAt: expiresAt,
    })
    .where(eq(socialAccounts.id, account.id));
}

export async function setAccountStatus(
  db: Db,
  id: string,
  status: AccountStatus,
  lastError: string | null = null,
): Promise<void> {
  await db
    .update(socialAccounts)
    .set({ status, lastError, lastCheckedAt: new Date() })
    .where(eq(socialAccounts.id, id));
}

/** Disconnect: forget tokens (the caller revokes them on the platform first). */
export async function disconnectAccount(db: Db, id: string): Promise<void> {
  await db
    .update(socialAccounts)
    .set({
      status: 'disabled',
      accessTokenEnc: null,
      refreshTokenEnc: null,
      userAccessTokenEnc: null,
      lastError: null,
    })
    .where(eq(socialAccounts.id, id));
}

// ---------------------------------------------------------------------------------------------
// OAuth state + PKCE
// ---------------------------------------------------------------------------------------------

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(48);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Creates a single-use OAuth state valid for 10 minutes. Returns the raw state for the URL. */
export async function createOauthFlow(
  db: Db,
  provider: 'google' | 'meta',
  opts: { codeVerifier?: string; redirectTo?: string } = {},
): Promise<string> {
  const state = randomToken(32);
  await db.insert(oauthFlows).values({
    stateHash: sha256Hex(state),
    provider,
    codeVerifierEnc: opts.codeVerifier
      ? encryptSecret(opts.codeVerifier, `oauth:${provider}`)
      : null,
    redirectTo: opts.redirectTo ?? null,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  return state;
}

/** Consumes a state exactly once. Returns null if unknown, expired or already used. */
export async function consumeOauthFlow(
  db: Db,
  provider: 'google' | 'meta',
  state: string,
): Promise<{ codeVerifier?: string; redirectTo?: string } | null> {
  const rows = await db
    .update(oauthFlows)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(oauthFlows.stateHash, sha256Hex(state)),
        eq(oauthFlows.provider, provider),
        isNull(oauthFlows.usedAt),
        gt(oauthFlows.expiresAt, new Date()),
      ),
    )
    .returning();
  const row = rows[0];
  if (!row) return null;
  return {
    codeVerifier: row.codeVerifierEnc
      ? decryptSecret(row.codeVerifierEnc, `oauth:${provider}`)
      : undefined,
    redirectTo: row.redirectTo ?? undefined,
  };
}
