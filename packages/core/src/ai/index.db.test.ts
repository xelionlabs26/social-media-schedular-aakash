/**
 * Integration tests against a real Postgres (TEST_DATABASE_URL). The Claude client and the frame
 * loader are injected, so nothing touches the network or storage.
 */
import Anthropic from '@anthropic-ai/sdk';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  aiGenerations,
  appSettings,
  closeDb,
  getDb,
  mediaAssets,
  postTargets,
  posts,
  templates,
  type Db,
  type Platform,
  type PostTarget,
} from '@app/db';
import type { ServiceDeps } from '../deps';
import { getEnv } from '../env';
import { createLogger } from '../log';
import type { AiFrame } from '../media';
import type { Storage } from '../storage';
import {
  AiError,
  generateForAsset,
  markAiFailed,
  monthlyCostUsd,
  refineField,
  rewriteAll,
} from '.';
import { fakeClient, fakeMessage, sampleOutput } from './test-helpers';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
if (!url) console.warn('[ai] TEST_DATABASE_URL is not set: skipping database tests.');

const frames: AiFrame[] = [
  { idx: 0, tMs: 500, source: 'hook', jpeg: Buffer.from('f0') },
  { idx: 1, tMs: 8_000, source: 'uniform', jpeg: Buffer.from('f1') },
  { idx: 2, tMs: 21_000, source: 'scene', jpeg: Buffer.from('f2') },
];
const loadFrames = async () => frames;

let db: Db;
let jobs: Array<{ queue: string; data: unknown }>;

function deps(env: Record<string, string> = { ANTHROPIC_API_KEY: 'sk-test' }): ServiceDeps {
  return {
    db,
    storage: {} as Storage,
    env: getEnv(env),
    log: createLogger('test'),
    jobs: {
      async send(queue, data) {
        jobs.push({ queue, data });
        return 'job-id';
      },
    },
    now: () => new Date('2026-11-13T10:00:00Z'),
  };
}

async function seed(platforms: Platform[] = ['instagram', 'youtube', 'facebook']) {
  const [asset] = await db
    .insert(mediaAssets)
    .values({
      filename: 'chai_stall.mp4',
      contentType: 'video/mp4',
      sizeBytes: 1000,
      originalKey: 'originals/x.mp4',
      status: 'processing',
      processingStep: 'transcribe',
      durationMs: 58_000,
      transcript: 'Bhaiya ek special chai dena. Arre ye kya daal diya!',
      notes: 'Chai stall in Dadar',
    })
    .returning();
  const [post] = await db.insert(posts).values({ assetId: asset!.id }).returning();
  const targets = await db
    .insert(postTargets)
    .values(platforms.map((platform) => ({ postId: post!.id, platform })))
    .returning();
  return { asset: asset!, post: post!, targets };
}

const target = async (id: string) =>
  (await db.select().from(postTargets).where(eq(postTargets.id, id)))[0]!;
const byPlatform = (ts: PostTarget[], p: Platform) => ts.find((t) => t.platform === p)!;
const assetRow = async (id: string) =>
  (await db.select().from(mediaAssets).where(eq(mediaAssets.id, id)))[0]!;

function apiError(status: number, type: string, message: string, extra: object = {}) {
  return Anthropic.APIError.generate(
    status,
    { type: 'error', error: { type, message, ...extra } },
    message,
    new Headers(),
  );
}

d('ai (database)', () => {
  beforeAll(() => {
    db = getDb(url);
  });
  afterAll(async () => {
    await closeDb();
  });
  beforeEach(async () => {
    jobs = [];
    await db.execute(
      sql`truncate ${mediaAssets}, ${templates}, ${aiGenerations}, ${appSettings} restart identity cascade`,
    );
  });

  it('AI_MOCK: writes realistic text for every platform end to end', async () => {
    const { asset, targets } = await seed();
    const res = await generateForAsset(deps({ AI_MOCK: 'true' }), asset.id, { loadFrames });
    expect(res).toEqual({ ok: true });

    const a = await assetRow(asset.id);
    expect(a.status).toBe('ready');
    expect(a.processingStep).toBeNull();
    expect(a.coverFrameMs).toBe(8_000); // mock picks the middle frame (idx 1)

    const ig = await target(byPlatform(targets, 'instagram').id);
    expect(ig.body).toContain('Chai stall in Dadar');
    expect(ig.hashtags.length).toBeGreaterThan(0);
    expect(ig.hashtags.length).toBeLessThanOrEqual(5);
    expect(ig.textSources).toEqual({ body: 'ai', hashtags: 'ai' });
    expect(ig.options.thumbOffsetMs).toBe(8_000);

    const yt = await target(byPlatform(targets, 'youtube').id);
    expect(yt.title.length).toBeGreaterThan(0);
    expect(yt.title.length).toBeLessThanOrEqual(60);
    expect(yt.title).not.toMatch(/#|http/);
    expect(yt.tags.length).toBeGreaterThan(0);
    expect(yt.hashtags.length).toBeLessThanOrEqual(3);

    const fb = await target(byPlatform(targets, 'facebook').id);
    expect(fb.body.length).toBeGreaterThan(0);
    expect(fb.hashtags).toEqual([]); // default: none on Facebook
    expect(fb.title).toBe(yt.title);

    const gens = await db.select().from(aiGenerations);
    expect(gens).toHaveLength(1);
    expect(gens[0]).toMatchObject({ kind: 'full', model: 'mock', costUsd: 0 });
  });

  it('calls Claude, records usage and cost, and never overwrites manual fields', async () => {
    const { asset, targets } = await seed();
    const ytId = byPlatform(targets, 'youtube').id;
    await db
      .update(postTargets)
      .set({ title: 'My own title', textSources: { title: 'manual' } })
      .where(eq(postTargets.id, ytId));

    const client = fakeClient([fakeMessage(sampleOutput())]);
    expect(await generateForAsset(deps(), asset.id, { client, loadFrames })).toEqual({ ok: true });

    const yt = await target(ytId);
    expect(yt.title).toBe('My own title');
    expect(yt.textSources.title).toBe('manual');
    expect(yt.body).toContain('Mumbai ki ek gali');
    expect(yt.hashtags).toEqual(['chai', 'streetfood']);
    expect(yt.textSources.body).toBe('ai');
    expect(yt.version).toBe(1);

    // The model saw the manual title as context.
    const task = (client.calls[0]!.messages[0]!.content as Array<{ text?: string }>).at(-1)!.text!;
    expect(task).toContain('"My own title"');

    const a = await assetRow(asset.id);
    expect(a.coverFrameMs).toBe(21_000); // cover_frame_index 2

    const [gen] = await db.select().from(aiGenerations);
    expect(gen).toMatchObject({
      kind: 'full',
      model: 'claude-opus-5-5',
      effort: 'low',
      inputTokens: 100,
      outputTokens: 800,
      cacheWriteTokens: 9000,
      requestId: 'req_1',
      stopReason: 'end_turn',
    });
    // 100*4 + 800*20 + 9000*8 per MTok
    expect(gen!.costUsd).toBeCloseTo((100 * 4 + 800 * 20 + 9000 * 8) / 1e6, 6);
    expect(await monthlyCostUsd(db, new Date('2026-01-01'))).toBeCloseTo(gen!.costUsd, 6);
  });

  it('only writes the selected platforms and only draft/failed targets', async () => {
    const { asset, targets } = await seed();
    const fbId = byPlatform(targets, 'facebook').id;
    await db.update(postTargets).set({ status: 'scheduled' }).where(eq(postTargets.id, fbId));
    const client = fakeClient([fakeMessage(sampleOutput())]);
    await generateForAsset(deps(), asset.id, {
      client,
      loadFrames,
      platforms: ['instagram', 'facebook'],
    });

    expect((await target(byPlatform(targets, 'instagram').id)).body).toContain('Chai wale');
    expect((await target(byPlatform(targets, 'youtube').id)).body).toBe('');
    expect((await target(fbId)).body).toBe('');
    const task = (client.calls[0]!.messages[0]!.content as Array<{ text?: string }>).at(-1)!.text!;
    expect(task).toContain('Instagram:');
    expect(task).not.toContain('Facebook:');
  });

  it('makes one targeted repair call for a long title', async () => {
    const { asset, targets } = await seed(['youtube']);
    const longTitle =
      'Mumbai ke is chai wale ne aisa kya kiya ki poori gali hairan reh gayi aur sab dekhte rahe';
    const repaired = {
      ...sampleOutput(),
      youtube: { ...sampleOutput().youtube, title: 'Chai wale ka jaadu' },
    };
    const client = fakeClient([
      fakeMessage({ ...sampleOutput(), youtube: { ...sampleOutput().youtube, title: longTitle } }),
      fakeMessage(repaired),
    ]);
    await generateForAsset(deps(), asset.id, { client, loadFrames });

    expect(client.calls).toHaveLength(2);
    const task = (client.calls[1]!.messages[0]!.content as Array<{ text?: string }>).at(-1)!.text!;
    expect(task).toMatch(/youtube\.title: shorten to under 60 characters/);
    // Same schema → same cached prefix.
    expect(client.calls[1]!.output_config).toEqual(client.calls[0]!.output_config);
    expect((await target(targets[0]!.id)).title).toBe('Chai wale ka jaadu');
    const gens = await db.select().from(aiGenerations);
    expect(gens.map((g) => g.kind).sort()).toEqual(['field', 'full']);
  });

  it('trims deterministically when the repair call fails', async () => {
    const { asset, targets } = await seed(['youtube']);
    const longTitle =
      'Mumbai ke is chai wale ne aisa kya kiya ki poori gali hairan reh gayi aur sab dekhte rahe';
    const client = fakeClient([
      fakeMessage({ ...sampleOutput(), youtube: { ...sampleOutput().youtube, title: longTitle } }),
      apiError(500, 'api_error', 'boom'),
    ]);
    expect(await generateForAsset(deps(), asset.id, { client, loadFrames })).toEqual({ ok: true });
    const t = await target(targets[0]!.id);
    expect(t.title.length).toBeLessThanOrEqual(60);
    expect(longTitle.startsWith(t.title)).toBe(true);
  });

  it('applies enabled templates and bumps the counter', async () => {
    const { asset, targets } = await seed(['youtube']);
    await db.insert(templates).values([
      {
        platform: 'youtube',
        field: 'title',
        pattern: '{ai_title} | Ep {n}',
        mode: 'template_ai',
        enabled: true,
        counter: 4,
      },
      {
        platform: 'youtube',
        field: 'body',
        pattern: 'IGNORED',
        mode: 'template_only',
        enabled: false,
      },
    ]);
    await generateForAsset(deps(), asset.id, {
      client: fakeClient([fakeMessage(sampleOutput())]),
      loadFrames,
    });
    const t = await target(targets[0]!.id);
    expect(t.title).toBe('Chai mein ye daala aur sab hairan | Ep 5');
    expect(t.textSources.title).toBe('template');
    expect(t.body).not.toContain('IGNORED');
    const [tpl] = await db.select().from(templates).where(eq(templates.field, 'title'));
    expect(tpl!.counter).toBe(5);
  });

  it('spend limit: targets need attention, video is ready, owner alerted once per day', async () => {
    const { asset, targets } = await seed(['instagram', 'youtube']);
    const err = apiError(429, 'rate_limit_error', 'You have reached your API usage limits', {
      details: { error_code: 'enforced_spend_limit_reached' },
    });
    const res = await generateForAsset(deps(), asset.id, { client: fakeClient([err]), loadFrames });
    expect(res).toEqual({ ok: false });
    for (const t of targets) {
      const row = await target(t.id);
      expect(row.status).toBe('failed');
      expect(row.attentionReason).toBe('spend_limit');
    }
    expect((await assetRow(asset.id)).status).toBe('ready');
    expect(jobs).toEqual([
      {
        queue: 'notify',
        data: expect.objectContaining({ kind: 'spend_limit', dedupeKey: 'spend_limit:2026-11-13' }),
      },
    ]);
    const [gen] = await db.select().from(aiGenerations);
    expect(gen!.error).toMatch(/^spend:/);
  });

  it('refusal → write manually; a later success returns the target to draft', async () => {
    const { asset, targets } = await seed(['instagram']);
    const res = await generateForAsset(deps(), asset.id, {
      client: fakeClient([fakeMessage('', { stop: 'refusal' })]),
      loadFrames,
    });
    expect(res.ok).toBe(false);
    let t = await target(targets[0]!.id);
    expect(t.status).toBe('failed');
    expect(t.attentionReason).toBe('write_manually');

    await rewriteAll(deps(), asset.id, {
      client: fakeClient([fakeMessage(sampleOutput())]),
      loadFrames,
    });
    t = await target(targets[0]!.id);
    expect(t.status).toBe('draft');
    expect(t.attentionReason).toBeNull();
    expect(t.lastError).toBeNull();
    expect(t.body).toContain('Chai wale');
  });

  it('missing API key → ai_failed with a clear message', async () => {
    const { asset, targets } = await seed(['youtube']);
    const res = await generateForAsset(deps({}), asset.id, { loadFrames });
    expect(res.ok).toBe(false);
    const t = await target(targets[0]!.id);
    expect(t.attentionReason).toBe('ai_failed');
    expect(t.lastError).toBe('Add your Claude API key in Settings (or set AI_MOCK=true).');
    expect((await assetRow(asset.id)).status).toBe('ready');
  });

  it('retryable errors throw for the job queue and leave the asset processing', async () => {
    const { asset, targets } = await seed(['youtube']);
    await expect(
      generateForAsset(deps(), asset.id, {
        client: fakeClient([apiError(529, 'overloaded_error', 'busy')]),
        loadFrames,
      }),
    ).rejects.toBeInstanceOf(AiError);
    const a = await assetRow(asset.id);
    expect(a.status).toBe('processing');
    expect(a.processingStep).toBe('generate');
    expect((await target(targets[0]!.id)).status).toBe('draft');

    await markAiFailed(deps(), asset.id);
    expect((await assetRow(asset.id)).status).toBe('ready');
    expect((await target(targets[0]!.id)).attentionReason).toBe('ai_failed');
  });

  it('writes from transcript and notes when frames are unavailable', async () => {
    const { asset } = await seed(['youtube']);
    const client = fakeClient([fakeMessage(sampleOutput())]);
    const res = await generateForAsset(deps(), asset.id, {
      client,
      loadFrames: async () => {
        throw new Error('purged');
      },
    });
    expect(res.ok).toBe(true);
    const content = client.calls[0]!.messages[0]!.content as Array<{ type: string }>;
    expect(content.some((b) => b.type === 'image')).toBe(false);
    expect((await assetRow(asset.id)).coverFrameMs).toBeNull();
  });

  describe('refineField', () => {
    it('returns one field without saving, reusing the cached prefix', async () => {
      const { asset, targets } = await seed(['youtube', 'instagram']);
      const gen = fakeClient([fakeMessage(sampleOutput())]);
      await generateForAsset(deps(), asset.id, { client: gen, loadFrames });
      const ytId = byPlatform(targets, 'youtube').id;
      const before = await target(ytId);

      const refined = {
        ...sampleOutput(),
        summary: '',
        story_hook: '',
        instagram: { caption: '', hashtags: [] },
        youtube: {
          title: 'Ek sip aur sab badal gaya #chai',
          description: '',
          hashtags: [],
          tags: [],
        },
        facebook: { text: '', hashtags: [] },
      };
      const client = fakeClient([
        fakeMessage(refined, { usage: { cache_read_input_tokens: 9000 } }),
      ]);
      const res = await refineField(
        deps(),
        { targetId: ytId, field: 'title', action: 'viral' },
        { client, loadFrames },
      );
      expect(res).toEqual({ title: 'Ek sip aur sab badal gaya' });
      expect(await target(ytId)).toEqual(before); // not saved

      const g = gen.calls[0]!;
      const r = client.calls[0]!;
      expect(r.system).toEqual(g.system);
      expect(r.output_config).toEqual(g.output_config);
      const prefix = (p: typeof g) => (p.messages[0]!.content as unknown[]).slice(0, -1);
      expect(prefix(r)).toEqual(prefix(g));
      const task = (r.messages[0]!.content as Array<{ text?: string }>).at(-1)!.text!;
      expect(task).toContain('youtube.title: Make the hook stronger');
      expect(task).toContain('Chai wale bhaiya ne ye kya daal diya'); // current texts as context

      const rows = await db.select().from(aiGenerations).where(eq(aiGenerations.kind, 'field'));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        field: 'youtube.title',
        instruction: 'viral',
        cacheReadTokens: 9000,
      });
    });

    it('works in AI_MOCK mode and enforces limits on the result', async () => {
      const { asset, targets } = await seed(['instagram']);
      await generateForAsset(deps({ AI_MOCK: 'true' }), asset.id, { loadFrames });
      const igId = targets[0]!.id;
      const current = await target(igId);
      const res = await refineField(
        deps({ AI_MOCK: 'true' }),
        { targetId: igId, field: 'body', action: 'shorter' },
        { loadFrames },
      );
      expect(res.body!.length).toBeLessThan(current.body.length);
      const tags = await refineField(
        deps({ AI_MOCK: 'true' }),
        { targetId: igId, field: 'hashtags', action: 'regenerate' },
        { loadFrames },
      );
      expect(tags.hashtags!.length).toBeLessThanOrEqual(5);
    });

    it('rejects fields a platform does not have and surfaces API errors', async () => {
      const { targets } = await seed(['instagram']);
      await expect(
        refineField(deps({ AI_MOCK: 'true' }), {
          targetId: targets[0]!.id,
          field: 'tags',
          action: 'regenerate',
        }),
      ).rejects.toMatchObject({ category: 'fatal' });
      await expect(
        refineField(
          deps(),
          { targetId: targets[0]!.id, field: 'body', action: 'shorter' },
          { client: fakeClient([apiError(429, 'rate_limit_error', 'slow')]), loadFrames },
        ),
      ).rejects.toMatchObject({ category: 'retryable' });
    });
  });
});
