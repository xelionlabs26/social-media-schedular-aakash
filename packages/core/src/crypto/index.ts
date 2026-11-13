/**
 * Small crypto helpers built on node:crypto only.
 *
 * - encryptSecret / decryptSecret: AES-256-GCM for OAuth tokens at rest. Ciphertext format:
 *   `v{keyVersion}.{iv b64url}.{tag b64url}.{ciphertext b64url}`. AAD binds the ciphertext to a
 *   row (e.g. `youtube:<accountId>:access`) so it can't be swapped between rows.
 * - hashPassword / verifyPassword: scrypt, format `scrypt$N$r$p$salt$hash` (b64url).
 * - signValue / verifyValue: HMAC-SHA256 for short-lived signed URLs.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { getEnv } from '../env';

const b64url = (buf: Buffer) => buf.toString('base64url');
const fromB64url = (s: string) => Buffer.from(s, 'base64url');

function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  opts: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

// ---------------------------------------------------------------------------------------------
// Token encryption
// ---------------------------------------------------------------------------------------------

function loadKey(keyB64?: string): Buffer {
  const raw = keyB64 ?? getEnv().TOKEN_ENC_KEY;
  if (!raw) {
    throw new Error(
      'TOKEN_ENC_KEY is not set. Generate one with `openssl rand -base64 32` and add it to .env.',
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENC_KEY must be 32 bytes, base64 encoded.');
  return key;
}

export function encryptSecret(
  plaintext: string,
  aad: string,
  opts: { keyB64?: string; keyVersion?: number } = {},
): string {
  const key = loadKey(opts.keyB64);
  const version = opts.keyVersion ?? getEnv().TOKEN_ENC_KEY_VERSION;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v${version}.${b64url(iv)}.${b64url(tag)}.${b64url(ct)}`;
}

export function decryptSecret(
  ciphertext: string,
  aad: string,
  opts: { keyB64?: string } = {},
): string {
  const parts = ciphertext.split('.');
  if (parts.length !== 4 || !parts[0]?.startsWith('v')) throw new Error('Malformed ciphertext');
  const [, ivS, tagS, ctS] = parts as [string, string, string, string];
  const key = loadKey(opts.keyB64);
  const decipher = createDecipheriv('aes-256-gcm', key, fromB64url(ivS));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(fromB64url(tagS));
  return Buffer.concat([decipher.update(fromB64url(ctS)), decipher.final()]).toString('utf8');
}

/** AAD helper so every caller builds it the same way. */
export function tokenAad(
  platform: string,
  accountId: string,
  kind: 'access' | 'refresh' | 'user',
): string {
  return `${platform}:${accountId}:${kind}`;
}

// ---------------------------------------------------------------------------------------------
// Password hashing (owner login)
// ---------------------------------------------------------------------------------------------

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64url(salt)}$${b64url(key)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nS, rS, pS, saltS, keyS] = parts as [string, string, string, string, string, string];
  const expected = fromB64url(keyS);
  const key = await scrypt(password, fromB64url(saltS), expected.length, {
    N: Number(nS),
    r: Number(rS),
    p: Number(pS),
    maxmem: 64 * 1024 * 1024,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// ---------------------------------------------------------------------------------------------
// HMAC signing (signed URLs), hashing, random tokens
// ---------------------------------------------------------------------------------------------

function authSecret(secret?: string): string {
  const s = secret ?? getEnv().AUTH_SECRET;
  if (!s || s.length < 32) throw new Error('AUTH_SECRET must be set and at least 32 characters.');
  return s;
}

export function signValue(value: string, secret?: string): string {
  return b64url(createHmac('sha256', authSecret(secret)).update(value).digest());
}

export function verifyValue(value: string, signature: string, secret?: string): boolean {
  const expected = Buffer.from(signValue(value, secret));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}
