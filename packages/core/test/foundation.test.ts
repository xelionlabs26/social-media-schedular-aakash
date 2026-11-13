import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  signValue,
  tokenAad,
  verifyPassword,
  verifyValue,
} from '../src/crypto';
import {
  composeFinalBody,
  normalizeHashtags,
  trimToBytes,
  trimToChars,
  utf8Bytes,
  validateTargetText,
  youtubeTagsLength,
} from '../src/text';
import {
  addLocalDays,
  formatShort,
  localToUtc,
  pacificDayKey,
  toLocalParts,
  weekdayOf,
} from '../src/time';
import { displayStatusFor, summarizeStatuses } from '../src/status';
import { LocalStorage, assertSafeKey, verifyLocalSignature } from '../src/storage';

describe('crypto', () => {
  it('round-trips secrets and binds them to the AAD', () => {
    const aad = tokenAad('youtube', 'acc-1', 'refresh');
    const ct = encryptSecret('1//refresh-token', aad);
    expect(ct.startsWith('v1.')).toBe(true);
    expect(decryptSecret(ct, aad)).toBe('1//refresh-token');
    expect(() => decryptSecret(ct, tokenAad('youtube', 'acc-2', 'refresh'))).toThrow();
  });

  it('hashes and verifies passwords', async () => {
    const h = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });

  it('signs values', () => {
    const sig = signValue('hello');
    expect(verifyValue('hello', sig)).toBe(true);
    expect(verifyValue('hellO', sig)).toBe(false);
  });
});

describe('text limits', () => {
  it('counts UTF-8 bytes (Devanagari = 3 bytes)', () => {
    expect(utf8Bytes('नमस्ते')).toBe(18);
    expect(utf8Bytes('abc')).toBe(3);
  });

  it('counts YouTube tags with commas and quotes', () => {
    expect(youtubeTagsLength(['Foo', 'Foo Baz'])).toBe(3 + 9 + 1);
    expect(youtubeTagsLength([])).toBe(0);
  });

  it('normalizes and de-duplicates hashtags', () => {
    expect(normalizeHashtags(['#Goa Trip', 'goatrip', '##travel', '', '#!'])).toEqual([
      'GoaTrip',
      'travel',
    ]);
  });

  it('composes final bodies', () => {
    expect(composeFinalBody('instagram', 'Hello', ['a', '#b'])).toBe('Hello\n\n#a #b');
    expect(composeFinalBody('youtube', 'x <y> z', [])).toBe('x y z');
  });

  it('trims at word boundaries', () => {
    expect(trimToChars('hello wonderful world', 12)).toBe('hello');
    expect(utf8Bytes(trimToBytes('नमस्ते दुनिया', 20))).toBeLessThanOrEqual(20);
  });

  it('validates platform limits', () => {
    const yt = validateTargetText('youtube', {
      title: 'x'.repeat(101),
      body: '',
      hashtags: [],
      tags: [],
    });
    expect(yt.map((i) => i.code)).toContain('title_too_long');
    const ig = validateTargetText('instagram', {
      title: '',
      body: 'Caption #one',
      hashtags: ['a', 'b', 'c', 'd', 'e'],
      tags: [],
    });
    expect(ig.map((i) => i.code)).toContain('too_many_hashtags');
    const ok = validateTargetText('facebook', { title: '', body: 'Story', hashtags: [], tags: [] });
    expect(ok).toEqual([]);
  });
});

describe('time (IST)', () => {
  it('converts IST wall time to UTC', () => {
    expect(localToUtc('2026-11-15', '18:00', 'Asia/Kolkata').toISOString()).toBe(
      '2026-11-15T12:30:00.000Z',
    );
  });

  it('reads local parts', () => {
    const p = toLocalParts(new Date('2026-11-15T12:30:00Z'), 'Asia/Kolkata');
    expect(p).toMatchObject({ date: '2026-11-15', time: '18:00', weekday: 0 });
    expect(formatShort(new Date('2026-11-15T12:30:00Z'), 'Asia/Kolkata')).toBe(
      'Sun 15 Nov, 18:00 IST',
    );
  });

  it('does local date arithmetic and Pacific quota days', () => {
    expect(addLocalDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(weekdayOf('2026-11-15')).toBe(0);
    expect(pacificDayKey(new Date('2026-11-15T07:59:00Z'))).toBe('2026-11-14');
    expect(pacificDayKey(new Date('2026-11-15T08:01:00Z'))).toBe('2026-11-15');
  });
});

describe('status', () => {
  it('maps internal states to six display words', () => {
    expect(displayStatusFor({ assetStatus: 'processing', targetStatus: 'draft' })).toBe(
      'processing',
    );
    expect(displayStatusFor({ assetStatus: 'ready', targetStatus: 'prepared' })).toBe('scheduled');
    expect(displayStatusFor({ assetStatus: 'ready', targetStatus: 'needs_reauth' })).toBe(
      'needs_attention',
    );
    expect(summarizeStatuses(['published', 'scheduled', 'needs_attention'])).toBe(
      'needs_attention',
    );
  });
});

describe('storage keys and local signatures', () => {
  it('rejects unsafe keys', () => {
    expect(() => assertSafeKey('../etc/passwd')).toThrow();
    expect(() => assertSafeKey('uploads/a/../../x')).toThrow();
    expect(() => assertSafeKey('uploads/abc/original.mp4')).not.toThrow();
  });

  it('creates verifiable signed upload URLs', async () => {
    const s = new LocalStorage('/tmp/storage-test', 'http://localhost:3000');
    const t = await s.createUploadTarget('uploads/abc/original.mp4', 'video/mp4');
    const u = new URL(t.url);
    const ok = verifyLocalSignature(
      'put',
      u.searchParams.get('key')!,
      Number(u.searchParams.get('exp')),
      u.searchParams.get('sig')!,
      u.searchParams.get('ct') ?? '',
    );
    expect(ok).toBe(true);
    expect(
      verifyLocalSignature(
        'get',
        'uploads/abc/original.mp4',
        Number(u.searchParams.get('exp')),
        u.searchParams.get('sig')!,
        'video/mp4',
      ),
    ).toBe(false);
    expect(s.publicReadUrls).toBe(false);
  });
});
