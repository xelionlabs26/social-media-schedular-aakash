/**
 * Keys the owner pastes in Settings instead of .env: Google and Meta app keys, Claude,
 * speech-to-text and Telegram. Stored AES-GCM encrypted in `app_keys` and merged into getEnv()
 * (a key set in the environment always wins). The web app reloads them on signed-in requests
 * and the worker before each job, so a new key works without a restart.
 */
import { eq } from 'drizzle-orm';
import { appKeys, type Db } from '@app/db';
import { decryptSecret, encryptSecret } from '../crypto';
import {
  UI_KEY_NAMES,
  getBaseEnv,
  getSavedKeys,
  savedKeysLoadedAt,
  setSavedKeys,
  type SavedKeys,
  type UiKeyName,
} from '../env';
import type { Logger } from '../log';

export { UI_KEY_NAMES, type UiKeyName, type SavedKeys };

/** IDs are shown in full in Settings so the owner can check them; secrets only by last 4. */
export const PUBLIC_KEY_NAMES: ReadonlySet<UiKeyName> = new Set([
  'GOOGLE_CLIENT_ID',
  'META_APP_ID',
  'META_LOGIN_CONFIG_ID',
  'ANTHROPIC_WORKSPACE_ID',
]);

const MAX_LEN = 512;

export const isUiKeyName = (name: string): name is UiKeyName =>
  (UI_KEY_NAMES as readonly string[]).includes(name);

const aad = (name: UiKeyName) => `app_key:${name}`;

// ---------------------------------------------------------------------------------------------
// Validation (catches the usual copy-paste mix-ups before anything is saved)
// ---------------------------------------------------------------------------------------------

type Rule = { test: (v: string) => boolean; message: string };

const RULES: Partial<Record<UiKeyName, Rule[]>> = {
  GOOGLE_CLIENT_ID: [
    {
      test: (v) => /^[\w-]+\.apps\.googleusercontent\.com$/.test(v),
      message: 'A Client ID ends with .apps.googleusercontent.com.',
    },
  ],
  GOOGLE_CLIENT_SECRET: [
    {
      test: (v) => !v.endsWith('.apps.googleusercontent.com'),
      message: 'This is the Client ID. Paste the Client secret here.',
    },
    { test: (v) => v.length >= 10, message: 'This looks too short for a Client secret.' },
  ],
  META_APP_ID: [{ test: (v) => /^\d{6,25}$/.test(v), message: 'The App ID is a number.' }],
  META_APP_SECRET: [
    {
      test: (v) => /^[a-f0-9]{32}$/i.test(v),
      message: 'The App secret is 32 letters and numbers (App settings → Basic → Show).',
    },
  ],
  META_LOGIN_CONFIG_ID: [
    { test: (v) => /^\d{6,25}$/.test(v), message: 'The Configuration ID is a number.' },
  ],
  ANTHROPIC_API_KEY: [
    { test: (v) => v.startsWith('sk-ant-'), message: 'Claude API keys start with sk-ant-.' },
  ],
  ANTHROPIC_WORKSPACE_ID: [
    {
      test: (v) => /^wrkspc_[A-Za-z0-9]+$/.test(v),
      message: 'A workspace ID starts with wrkspc_.',
    },
  ],
  OPENAI_API_KEY: [{ test: (v) => v.startsWith('sk-'), message: 'OpenAI keys start with sk-.' }],
  TELEGRAM_BOT_TOKEN: [
    {
      test: (v) => /^\d+:[\w-]{20,}$/.test(v),
      message: 'A bot token looks like 123456789:AA… (from @BotFather).',
    },
  ],
};

/** Returns an error message, or null when the value looks right. Empty means "remove". */
export function validateKey(name: UiKeyName, raw: string): string | null {
  const v = raw.trim();
  if (v === '') return null;
  if (v.length > MAX_LEN) return 'This is too long to be a key.';
  if (/\s/.test(v)) return 'Keys have no spaces or line breaks. Copy it again.';
  if (v.length < 6) return 'This looks too short.';
  for (const rule of RULES[name] ?? []) if (!rule.test(v)) return rule.message;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Load / refresh
// ---------------------------------------------------------------------------------------------

const UNREADABLE = Symbol.for('app.savedKeys.unreadable');
function unreadableState(): { names: UiKeyName[] } {
  const g = globalThis as { [UNREADABLE]?: { names: UiKeyName[] } };
  return (g[UNREADABLE] ??= { names: [] });
}

/** Reads and decrypts every saved key. Keys that can't be decrypted are reported, not thrown. */
export async function loadSavedKeys(db: Db): Promise<{ keys: SavedKeys; unreadable: UiKeyName[] }> {
  const rows = await db.select().from(appKeys);
  const keys: SavedKeys = {};
  const unreadable: UiKeyName[] = [];
  for (const row of rows) {
    if (!isUiKeyName(row.name)) continue;
    try {
      keys[row.name] = decryptSecret(row.valueEnc, aad(row.name));
    } catch {
      // TOKEN_ENC_KEY changed or missing: the owner has to paste this key again.
      unreadable.push(row.name);
    }
  }
  return { keys, unreadable };
}

let inflight: Promise<void> | undefined;

/**
 * Loads saved keys into this process. With maxAgeMs, skips the query when the keys were read
 * that recently. Never throws: on a database error the previous keys stay in use.
 */
export async function refreshSavedKeys(
  db: Db,
  opts: { maxAgeMs?: number; log?: Logger } = {},
): Promise<void> {
  const maxAge = opts.maxAgeMs ?? 0;
  if (maxAge > 0 && Date.now() - savedKeysLoadedAt() < maxAge) return;
  inflight ??= (async () => {
    try {
      const { keys, unreadable } = await loadSavedKeys(db);
      setSavedKeys(keys);
      unreadableState().names = unreadable;
    } catch (err) {
      opts.log?.warn('Could not read saved keys; using the previous ones', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      inflight = undefined;
    }
  })();
  await inflight;
}

/**
 * Saves (non-empty value) or removes (empty or null) keys, then reloads them in this process.
 * Callers validate first with validateKey().
 */
export async function saveKeys(
  db: Db,
  changes: Partial<Record<UiKeyName, string | null>>,
): Promise<void> {
  const entries = Object.entries(changes).filter(([name]) => isUiKeyName(name)) as Array<
    [UiKeyName, string | null]
  >;
  if (entries.length === 0) return;
  await db.transaction(async (tx) => {
    for (const [name, raw] of entries) {
      const value = raw?.trim() ?? '';
      if (value === '') {
        await tx.delete(appKeys).where(eq(appKeys.name, name));
      } else {
        const valueEnc = encryptSecret(value, aad(name));
        await tx
          .insert(appKeys)
          .values({ name, valueEnc, updatedAt: new Date() })
          .onConflictDoUpdate({ target: appKeys.name, set: { valueEnc, updatedAt: new Date() } });
      }
    }
  });
  await refreshSavedKeys(db);
}

// ---------------------------------------------------------------------------------------------
// What Settings shows (never the secret itself)
// ---------------------------------------------------------------------------------------------

export type KeySource = 'env' | 'app' | 'none';

export interface KeyStatus {
  source: KeySource;
  /** Full value for IDs, "••••1234" for secrets, null when not set. */
  display: string | null;
  /** Saved earlier but can't be decrypted any more. */
  unreadable: boolean;
}

export function maskKey(name: UiKeyName, value: string): string {
  if (PUBLIC_KEY_NAMES.has(name)) return value;
  return value.length <= 8 ? '••••' : `••••${value.slice(-4)}`;
}

/** Status of every key, for the Settings screen. Call after refreshSavedKeys(). */
export function describeKeys(): Record<UiKeyName, KeyStatus> {
  const base = getBaseEnv();
  const saved = getSavedKeys();
  const unreadable = new Set(unreadableState().names);
  const out = {} as Record<UiKeyName, KeyStatus>;
  for (const name of UI_KEY_NAMES) {
    const envValue = base[name];
    const savedValue = saved[name];
    out[name] = envValue
      ? { source: 'env', display: maskKey(name, envValue), unreadable: false }
      : savedValue
        ? { source: 'app', display: maskKey(name, savedValue), unreadable: false }
        : { source: 'none', display: null, unreadable: unreadable.has(name) };
  }
  return out;
}
