/**
 * Owner session cookie (signed JWT). Safe to import from proxy.ts (no database access here).
 */
import { SignJWT, jwtVerify } from 'jose';

export const SESSION_COOKIE = 'sms_session';
export const SESSION_MAX_AGE_SEC = 30 * 24 * 3600;

function key(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('AUTH_SECRET must be set (at least 32 characters). See .env.example.');
  }
  return new TextEncoder().encode(secret);
}

export interface SessionPayload {
  sub: 'owner';
  /** app_settings.session_version at login time (bumping it logs every session out). */
  sv: number;
}

export async function createSessionToken(sv: number): Promise<string> {
  return new SignJWT({ sv })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('owner')
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SEC}s`)
    .sign(key());
}

export async function readSessionToken(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ['HS256'] });
    if (payload.sub !== 'owner' || typeof payload.sv !== 'number') return null;
    return { sub: 'owner', sv: payload.sv };
  } catch {
    return null;
  }
}

export function sessionCookieOptions() {
  const secure = (process.env.APP_URL ?? '').startsWith('https://');
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_MAX_AGE_SEC,
  };
}
