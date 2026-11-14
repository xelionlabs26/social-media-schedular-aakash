/**
 * Keys pasted in Settings: validation, the env overlay (environment wins), the live deps.env,
 * and the encrypted save/load round trip (database part needs TEST_DATABASE_URL).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appKeys, closeDb, getDb, type Db } from '@app/db';
import { defaultDeps } from '../deps';
import { applySavedKeys, getBaseEnv, getEnv, resetEnvCache, setSavedKeys, type Env } from '../env';
import type { Logger } from '../log';
import type { Storage } from '../storage';
import {
  describeKeys,
  loadSavedKeys,
  maskKey,
  refreshSavedKeys,
  saveKeys,
  validateKey,
} from './index';

const base = (extra: Record<string, string> = {}): Env =>
  getEnv({ AUTH_SECRET: 'x'.repeat(40), ...extra });

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silent,
};

describe('validateKey', () => {
  it('accepts well-formed keys and empty (= remove)', () => {
    expect(validateKey('GOOGLE_CLIENT_ID', '123-abc.apps.googleusercontent.com')).toBeNull();
    expect(validateKey('GOOGLE_CLIENT_SECRET', 'GOCSPX-abcdefghijklmnop')).toBeNull();
    expect(validateKey('META_APP_ID', '1234567890123')).toBeNull();
    expect(validateKey('META_APP_SECRET', 'a'.repeat(32))).toBeNull();
    expect(validateKey('META_LOGIN_CONFIG_ID', '987654321098')).toBeNull();
    expect(validateKey('ANTHROPIC_API_KEY', 'sk-ant-api03-abcdef')).toBeNull();
    expect(validateKey('ANTHROPIC_WORKSPACE_ID', 'wrkspc_01AbC')).toBeNull();
    expect(validateKey('DEEPGRAM_API_KEY', 'f'.repeat(40))).toBeNull();
    expect(
      validateKey('TELEGRAM_BOT_TOKEN', '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'),
    ).toBeNull();
    expect(validateKey('DEEPGRAM_API_KEY', '  ')).toBeNull();
  });

  it('catches the usual copy-paste mix-ups', () => {
    expect(validateKey('GOOGLE_CLIENT_ID', 'my-project-123')).toMatch(/apps\.googleusercontent/);
    expect(validateKey('GOOGLE_CLIENT_SECRET', '1-abc.apps.googleusercontent.com')).toMatch(
      /Client ID/,
    );
    expect(validateKey('META_APP_ID', 'abc123')).toMatch(/number/);
    expect(validateKey('META_APP_SECRET', 'short')).toBeTruthy();
    expect(validateKey('ANTHROPIC_API_KEY', 'sk-proj-123456')).toMatch(/sk-ant-/);
    expect(validateKey('DEEPGRAM_API_KEY', 'abc def ghi jkl')).toMatch(/spaces/);
    expect(validateKey('DEEPGRAM_API_KEY', 'x'.repeat(600))).toMatch(/too long/);
  });
});

describe('applySavedKeys', () => {
  it('fills empty keys and never overrides the environment', () => {
    const env = applySavedKeys(base({ META_APP_ID: '111111' }), {
      META_APP_ID: '222222',
      DEEPGRAM_API_KEY: 'dg-saved',
    });
    expect(env.META_APP_ID).toBe('111111');
    expect(env.DEEPGRAM_API_KEY).toBe('dg-saved');
  });

  it('a Claude key saved in Settings switches sample captions off', () => {
    const mock = base({ AI_MOCK: 'true' });
    expect(applySavedKeys(mock, {}).AI_MOCK).toBe(true);
    expect(applySavedKeys(mock, { ANTHROPIC_API_KEY: 'sk-ant-x' }).AI_MOCK).toBe(false);
    // A key in .env keeps AI_MOCK's old meaning (developers can still mock with a key set).
    const devMock = base({ AI_MOCK: 'true', ANTHROPIC_API_KEY: 'sk-ant-env' });
    expect(applySavedKeys(devMock, { ANTHROPIC_API_KEY: 'sk-ant-x' }).AI_MOCK).toBe(true);
  });
});

describe('getEnv with saved keys', () => {
  const NAME = 'SARVAM_API_KEY';
  const hadEnv = Boolean(process.env[NAME]);
  afterEach(() => resetEnvCache());

  it.skipIf(hadEnv)('merges saved keys and deps.env sees changes without a restart', () => {
    resetEnvCache();
    const deps = defaultDeps({
      db: {} as Db,
      storage: {} as Storage,
      log: silent,
      jobs: { send: async () => null },
    });
    expect(deps.env[NAME]).toBeUndefined();
    setSavedKeys({ [NAME]: 'sarvam-saved-123' });
    expect(getEnv()[NAME]).toBe('sarvam-saved-123');
    expect(getBaseEnv()[NAME]).toBeUndefined();
    expect(deps.env[NAME]).toBe('sarvam-saved-123');
    setSavedKeys({});
    expect(deps.env[NAME]).toBeUndefined();
  });

  it('an explicit env override is kept as is', () => {
    const fixed = base();
    const deps = defaultDeps({
      db: {} as Db,
      storage: {} as Storage,
      log: silent,
      jobs: { send: async () => null },
      env: fixed,
    });
    setSavedKeys({ [NAME]: 'ignored' });
    expect(deps.env).toBe(fixed);
  });
});

describe('maskKey', () => {
  it('shows IDs in full and secrets by their last 4 characters', () => {
    expect(maskKey('META_APP_ID', '1234567890')).toBe('1234567890');
    expect(maskKey('META_APP_SECRET', 'abcdef0123456789abcdef0123456789')).toBe('••••6789');
    expect(maskKey('DEEPGRAM_API_KEY', 'short')).toBe('••••');
  });
});

const DB_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!DB_URL)('saveKeys / refreshSavedKeys (database)', () => {
  let db: Db;
  const SECRET = 'abcdef0123456789abcdef0123456789';

  beforeAll(() => {
    db = getDb(DB_URL);
  });
  beforeEach(async () => {
    resetEnvCache();
    await db.delete(appKeys);
  });
  afterAll(async () => {
    await db.delete(appKeys);
    resetEnvCache();
    await closeDb();
  });

  it('stores keys encrypted, loads them into getEnv and removes them', async () => {
    const skip = ['META_APP_ID', 'META_APP_SECRET'].some((k) => process.env[k]);
    if (skip) return;

    await saveKeys(db, { META_APP_ID: '1234567890', META_APP_SECRET: SECRET });
    const rows = await db.select().from(appKeys);
    expect(rows.map((r) => r.name).sort()).toEqual(['META_APP_ID', 'META_APP_SECRET']);
    for (const r of rows) expect(r.valueEnc).not.toContain(SECRET);
    expect(rows.find((r) => r.name === 'META_APP_SECRET')!.valueEnc).toMatch(/^v\d+\./);

    // saveKeys reloads this process at once.
    expect(getEnv().META_APP_SECRET).toBe(SECRET);
    const status = describeKeys();
    expect(status.META_APP_ID).toEqual({ source: 'app', display: '1234567890', unreadable: false });
    expect(status.META_APP_SECRET).toEqual({
      source: 'app',
      display: '••••6789',
      unreadable: false,
    });
    expect(status.GOOGLE_CLIENT_ID.source).toBe(process.env.GOOGLE_CLIENT_ID ? 'env' : 'none');

    // Another process (the worker) picks them up with refreshSavedKeys.
    resetEnvCache();
    expect(getEnv().META_APP_SECRET).toBeUndefined();
    await refreshSavedKeys(db, { log: silent });
    expect(getEnv().META_APP_SECRET).toBe(SECRET);

    // Empty value removes.
    await saveKeys(db, { META_APP_SECRET: '' });
    expect(getEnv().META_APP_SECRET).toBeUndefined();
    expect(getEnv().META_APP_ID).toBe('1234567890');
  });

  it('maxAgeMs skips the query when the keys are fresh', async () => {
    await refreshSavedKeys(db);
    await db.insert(appKeys).values({ name: 'TELEGRAM_BOT_TOKEN', valueEnc: 'v1.a.b.c' });
    // Fresh: not re-read, so the bad row isn't seen yet.
    await refreshSavedKeys(db, { maxAgeMs: 60_000 });
    expect(describeKeys().TELEGRAM_BOT_TOKEN.unreadable).toBe(false);
    await refreshSavedKeys(db);
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      expect(describeKeys().TELEGRAM_BOT_TOKEN).toEqual({
        source: 'none',
        display: null,
        unreadable: true,
      });
    }
  });

  it('ignores rows with unknown names and reports undecryptable ones', async () => {
    await db.insert(appKeys).values([
      { name: 'DATABASE_URL', valueEnc: 'v1.a.b.c' },
      { name: 'OPENAI_API_KEY', valueEnc: 'not-a-ciphertext' },
    ]);
    const { keys, unreadable } = await loadSavedKeys(db);
    expect(keys).toEqual({});
    expect(unreadable).toEqual(['OPENAI_API_KEY']);
  });
});
