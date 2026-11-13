/**
 * Owner authentication for server components, server actions and route handlers.
 * Every mutation must call requireOwner() itself (server actions are reachable by direct POST).
 */
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, count, eq, gt } from 'drizzle-orm';
import { loginAttempts } from '@app/db';
import { getSettings } from '@app/core/settings';
import { verifyPassword } from '@app/core/crypto';
import { getDeps } from './deps';
import {
  SESSION_COOKIE,
  createSessionToken,
  readSessionToken,
  sessionCookieOptions,
} from './session';

export class UnauthorizedError extends Error {
  constructor() {
    super('Not signed in');
    this.name = 'UnauthorizedError';
  }
}

/** Returns true when a valid, non-revoked owner session cookie is present. */
export async function isOwner(): Promise<boolean> {
  const jar = await cookies();
  const session = await readSessionToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) return false;
  const settings = await getSettings(getDeps().db);
  return session.sv === settings.sessionVersion;
}

/** For pages: redirects to /login when not signed in. */
export async function requireOwnerPage(): Promise<void> {
  if (!(await isOwner())) redirect('/login');
}

/** For server actions and route handlers: throws when not signed in. */
export async function requireOwner(): Promise<void> {
  if (!(await isOwner())) throw new UnauthorizedError();
}

export function authConfigured(): boolean {
  return Boolean(
    process.env.OWNER_EMAIL && process.env.OWNER_PASSWORD_HASH && process.env.AUTH_SECRET,
  );
}

async function clientIp(): Promise<string> {
  const h = await headers();
  return (h.get('x-forwarded-for')?.split(',')[0] ?? h.get('x-real-ip') ?? 'unknown').trim();
}

const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;

export type LoginResult = { ok: true } | { ok: false; error: string };

export async function login(email: string, password: string): Promise<LoginResult> {
  if (!authConfigured())
    return { ok: false, error: 'Login is not configured yet. See the setup steps below.' };
  const { db } = getDeps();
  const ip = await clientIp();
  const since = new Date(Date.now() - WINDOW_MS);
  const [failures] = await db
    .select({ n: count() })
    .from(loginAttempts)
    .where(
      and(eq(loginAttempts.ip, ip), eq(loginAttempts.success, false), gt(loginAttempts.at, since)),
    );
  if ((failures?.n ?? 0) >= MAX_FAILURES) {
    return { ok: false, error: 'Too many attempts. Try again in 15 minutes.' };
  }
  const emailOk = email.trim().toLowerCase() === process.env.OWNER_EMAIL!.trim().toLowerCase();
  // Always run the hash check so timing doesn't reveal whether the email matched.
  const passOk = await verifyPassword(password, process.env.OWNER_PASSWORD_HASH!);
  const success = emailOk && passOk;
  await db.insert(loginAttempts).values({ ip, success });
  if (!success) return { ok: false, error: 'Wrong email or password.' };

  const settings = await getSettings(db);
  const token = await createSessionToken(settings.sessionVersion);
  (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions());
  return { ok: true };
}

export async function logout(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
