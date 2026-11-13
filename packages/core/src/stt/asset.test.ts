/**
 * transcribeAsset against a real Postgres. Needs TEST_DATABASE_URL pointing at a migrated
 * database (see the task setup: create database test_stt; pnpm db:migrate).
 */
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { batches, closeDb, getDb, mediaAssets, type AssetWarning, type Db } from '@app/db';
import type { ServiceDeps } from '../deps';
import type { Logger } from '../log';
import type { ExtractedAudio } from '../media';
import { updateSettings } from '../settings';
import type { Storage } from '../storage';
import { NOT_CONFIGURED_MESSAGE, transcribeAsset } from './asset';
import { mockTranscript } from './providers/mock';
import { fakeFetch, json, makeAudio, makeTempDir, noSleep, testEnv } from './test-helpers';
import { SttError } from './types';

const DB_URL = process.env.TEST_DATABASE_URL;
if (!DB_URL) {
  console.warn('[stt] TEST_DATABASE_URL is not set; skipping transcribeAsset database tests');
}

const OPENAI_KEY = 'sk-openai-SECRET-asset-test';

function memoryLogger(lines: string[]): Logger {
  const write = (level: string) => (msg: string, data?: Record<string, unknown>) => {
    lines.push(`${level} ${msg} ${JSON.stringify(data ?? {})}`);
  };
  const logger: Logger = {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: () => logger,
  };
  return logger;
}

describe.skipIf(!DB_URL)('transcribeAsset (database)', () => {
  const tmp = makeTempDir('stt-asset-');
  let db: Db;
  let audio: ExtractedAudio;
  let logs: string[];

  function deps(envOverrides: Record<string, string> = {}): ServiceDeps {
    return {
      db,
      storage: {} as Storage,
      env: testEnv({ WORK_DIR: path.join(tmp.dir, 'work'), ...envOverrides }),
      log: memoryLogger(logs),
      jobs: { send: async () => null },
      now: () => new Date('2026-11-13T10:00:00Z'),
    };
  }

  async function createAsset(values: Partial<typeof mediaAssets.$inferInsert> = {}) {
    const rows = await db
      .insert(mediaAssets)
      .values({
        filename: 'stt-test.mp4',
        contentType: 'video/mp4',
        sizeBytes: 1000,
        originalKey: 'media/stt-test/original.mp4',
        status: 'processing',
        processingStep: 'frames',
        ...values,
      })
      .returning();
    return rows[0]!;
  }

  async function reload(id: string) {
    return (await db.select().from(mediaAssets).where(eq(mediaAssets.id, id)))[0]!;
  }

  const codes = (warnings: AssetWarning[]) => warnings.map((w) => w.code).sort();

  beforeAll(async () => {
    db = getDb(DB_URL);
    const file = makeAudio(path.join(tmp.dir, 'speech.m4a'), 3);
    audio = { path: file, mimeType: 'audio/mp4', durationMs: 3_000, sizeBytes: 1 };
    await db.delete(mediaAssets).where(eq(mediaAssets.filename, 'stt-test.mp4'));
  });

  beforeEach(async () => {
    logs = [];
    await updateSettings(db, { sttProvider: 'mock' });
  });

  afterAll(async () => {
    await db.delete(mediaAssets).where(eq(mediaAssets.filename, 'stt-test.mp4'));
    await updateSettings(db, { sttProvider: 'openai' });
    await closeDb();
    tmp.remove();
  });

  it('stores the transcript, language and provider (mock) and clears stale STT warnings', async () => {
    const [batch] = await db
      .insert(batches)
      .values({ platforms: ['instagram'], notes: 'Goa Trip' })
      .returning();
    const asset = await createAsset({
      batchId: batch!.id,
      notes: 'Rahul, Baga Beach\nThis line is a long sentence about the video for the AI only',
      warnings: [
        { code: 'over_60s', severity: 'warn', message: 'Over 60 s' },
        { code: 'transcribe_failed', severity: 'warn', message: 'old failure' },
      ],
    });

    expect(await transcribeAsset(deps(), asset.id, audio)).toEqual({ ok: true });

    const after = await reload(asset.id);
    expect(after.processingStep).toBe('transcribe');
    expect(after.transcript).toBe(
      mockTranscript({ durationMs: 3_000, keywords: ['Rahul', 'Baga Beach', 'Goa Trip'] }),
    );
    expect(after.transcriptLang).toBe('hi,en');
    expect(after.transcriptProvider).toBe('mock');
    expect(after.transcriptEdited).toBe(false);
    expect(codes(after.warnings)).toEqual(['over_60s']);
    // Logs carry lengths, never the transcript itself.
    expect(logs.join('\n')).not.toContain('Namaste');
    await db.delete(batches).where(eq(batches.id, batch!.id));
  });

  it('leaves a transcript the owner edited untouched', async () => {
    const asset = await createAsset({
      transcript: 'my own words',
      transcriptEdited: true,
      transcriptProvider: 'manual',
    });
    expect(await transcribeAsset(deps(), asset.id, audio)).toEqual({ ok: true });
    const after = await reload(asset.id);
    expect(after.transcript).toBe('my own words');
    expect(after.transcriptProvider).toBe('manual');
    expect(after.processingStep).toBe('transcribe');
    expect(after.warnings).toEqual([]);
  });

  it('adds a not-configured warning (no throw) when the provider has no key', async () => {
    await updateSettings(db, { sttProvider: 'openai' });
    const asset = await createAsset({
      warnings: [{ code: 'not_vertical', severity: 'warn', message: 'Not vertical' }],
    });
    expect(await transcribeAsset(deps(), asset.id, audio)).toEqual({ ok: false });
    const after = await reload(asset.id);
    expect(after.transcript).toBeNull();
    expect(after.warnings).toContainEqual({
      code: 'stt_not_configured',
      severity: 'warn',
      message: NOT_CONFIGURED_MESSAGE,
    });
    expect(codes(after.warnings)).toEqual(['not_vertical', 'stt_not_configured']);

    // Running again does not duplicate the warning.
    await transcribeAsset(deps(), asset.id, audio);
    expect(codes((await reload(asset.id)).warnings)).toEqual([
      'not_vertical',
      'stt_not_configured',
    ]);
  });

  it('falls back to the mock provider under AI_MOCK when the provider has no key', async () => {
    await updateSettings(db, { sttProvider: 'deepgram' });
    const asset = await createAsset();
    expect(await transcribeAsset(deps({ AI_MOCK: 'true' }), asset.id, audio)).toEqual({ ok: true });
    expect((await reload(asset.id)).transcriptProvider).toBe('mock');
  });

  it('adds an info no_speech warning when there is no audio', async () => {
    const asset = await createAsset();
    expect(await transcribeAsset(deps(), asset.id, null)).toEqual({ ok: true });
    const after = await reload(asset.id);
    expect(after.transcript).toBeNull();
    expect(after.warnings).toEqual([
      expect.objectContaining({ code: 'no_speech', severity: 'info' }),
    ]);
  });

  it('does not repeat the no-audio note the video check already added', async () => {
    const asset = await createAsset();
    const noSound = {
      code: 'no_audio',
      severity: 'info' as const,
      message: 'No sound in this video.',
    };
    await db
      .update(mediaAssets)
      .set({ warnings: [noSound] })
      .where(eq(mediaAssets.id, asset.id));
    expect(await transcribeAsset(deps(), asset.id, null)).toEqual({ ok: true });
    expect((await reload(asset.id)).warnings).toEqual([noSound]);
  });

  it('records an empty transcript with a no_speech note', async () => {
    await updateSettings(db, { sttProvider: 'openai' });
    const asset = await createAsset();
    const { fetch } = fakeFetch([json({ text: '', languages: [] })]);
    const res = await transcribeAsset(deps({ OPENAI_API_KEY: OPENAI_KEY }), asset.id, audio, {
      providerOptions: { fetch, sleep: noSleep },
    });
    expect(res).toEqual({ ok: true });
    const after = await reload(asset.id);
    expect(after.transcript).toBe('');
    expect(after.transcriptLang).toBeNull();
    expect(codes(after.warnings)).toEqual(['no_speech']);
  });

  it('adds stt_spend_limit on a spend error and transcribe_failed on a fatal one', async () => {
    await updateSettings(db, { sttProvider: 'openai' });
    const spendAsset = await createAsset();
    const spend = fakeFetch([
      json(
        { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } },
        429,
      ),
    ]);
    expect(
      await transcribeAsset(deps({ OPENAI_API_KEY: OPENAI_KEY }), spendAsset.id, audio, {
        providerOptions: { fetch: spend.fetch, sleep: noSleep },
      }),
    ).toEqual({ ok: false });
    expect(codes((await reload(spendAsset.id)).warnings)).toEqual(['stt_spend_limit']);

    const fatalAsset = await createAsset();
    const fatal = fakeFetch([json({ error: { message: 'Unsupported file format' } }, 400)]);
    expect(
      await transcribeAsset(deps({ OPENAI_API_KEY: OPENAI_KEY }), fatalAsset.id, audio, {
        providerOptions: { fetch: fatal.fetch, sleep: noSleep },
      }),
    ).toEqual({ ok: false });
    const after = await reload(fatalAsset.id);
    expect(codes(after.warnings)).toEqual(['transcribe_failed']);
    expect(after.transcript).toBeNull();
    expect(logs.join('\n')).not.toContain(OPENAI_KEY);
  });

  it('throws a retryable SttError so the job retries, and warns on the final attempt', async () => {
    await updateSettings(db, { sttProvider: 'openai' });
    const asset = await createAsset();
    const busy = fakeFetch([json({ error: { message: 'overloaded' } }, 503)]);
    const err = await transcribeAsset(deps({ OPENAI_API_KEY: OPENAI_KEY }), asset.id, audio, {
      providerOptions: { fetch: busy.fetch, sleep: noSleep, maxAttempts: 1 },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SttError);
    expect((err as SttError).category).toBe('retryable');
    expect((await reload(asset.id)).warnings).toEqual([]);

    const again = fakeFetch([json({ error: { message: 'overloaded' } }, 503)]);
    expect(
      await transcribeAsset(deps({ OPENAI_API_KEY: OPENAI_KEY }), asset.id, audio, {
        providerOptions: { fetch: again.fetch, sleep: noSleep, maxAttempts: 1 },
        finalAttempt: true,
      }),
    ).toEqual({ ok: false });
    expect(codes((await reload(asset.id)).warnings)).toEqual(['transcribe_failed']);
  });

  it('returns ok=false for an unknown asset', async () => {
    expect(await transcribeAsset(deps(), '00000000-0000-4000-8000-000000000000', audio)).toEqual({
      ok: false,
    });
  });
});
