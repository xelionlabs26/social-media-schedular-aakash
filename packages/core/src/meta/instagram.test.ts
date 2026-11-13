import { describe, expect, it } from 'vitest';
import { PlatformError } from '../platforms';
import { createInstagramIntegration } from './index';
import { parseIgTimestamp } from './instagram';
import {
  FakeGraph,
  PAGE_TOKEN,
  VIDEO,
  graphError,
  harness,
  makeAsset,
  makeTarget,
  testEnv,
} from './test-utils';

const SLOT = new Date('2026-11-13T12:30:00Z');
const PREP = new Date('2026-11-13T12:15:00Z');
const env = testEnv();

function setup() {
  const graph = new FakeGraph();
  const ig = createInstagramIntegration({ env: () => env, fetch: graph.fetch });
  return { graph, pub: ig.publisher, ig };
}

const container = (status_code: string, status?: string) => () => ({
  id: 'c1',
  status_code,
  status,
});
const quota = (usage: number, total = 50) => ({
  data: [{ quota_usage: usage, config: { quota_total: total, quota_duration: 86400 } }],
});

describe('instagram timing', () => {
  it('is always app mode and prepares 15 minutes before the slot (or now)', () => {
    const { pub } = setup();
    const base = { asset: makeAsset(), target: makeTarget({ platform: 'instagram' }) };
    expect(pub.chooseMode({ ...base, scheduledAt: SLOT, now: PREP })).toBe('app');
    const early = new Date('2026-11-13T08:00:00Z');
    expect(pub.prepareAt({ ...base, scheduledAt: SLOT, now: early, mode: 'app' })).toEqual(PREP);
    const late = new Date('2026-11-13T12:25:00Z');
    expect(pub.prepareAt({ ...base, scheduledAt: SLOT, now: late, mode: 'app' })).toEqual(late);
  });

  it('parses IG timestamps', () => {
    expect(parseIgTimestamp('2026-11-13T12:30:05+0000')?.toISOString()).toBe(
      '2026-11-13T12:30:05.000Z',
    );
    expect(parseIgTimestamp('nope')).toBeNull();
  });
});

describe('instagram prepare', () => {
  it('creates a resumable REELS container, uploads, then waits while IN_PROGRESS', async () => {
    const { graph, pub } = setup();
    graph
      .on('POST', /\/v27\.0\/999\/media$/, () => ({ id: 'c1' }))
      .on('POST', /rupload\.facebook\.com\/ig-api-upload\/v27\.0\/c1$/, () => ({
        success: true,
        message: 'Upload successful.',
      }))
      .on('GET', /\/c1\?/, container('IN_PROGRESS'));
    const h = harness({ platform: 'instagram', scheduledAt: SLOT, now: PREP, mode: 'app' });

    const res = await pub.prepare(h.input);
    expect(res.kind).toBe('wait');
    if (res.kind === 'wait') expect(res.retryInSec).toBeGreaterThanOrEqual(30);

    const create = graph.find('POST', /\/999\/media$/)[0]!;
    expect(Object.fromEntries(create.params)).toMatchObject({
      media_type: 'REELS',
      upload_type: 'resumable',
      caption: h.target.body,
      share_to_feed: 'true',
      thumb_offset: '4200',
      access_token: PAGE_TOKEN,
    });
    const up = graph.find('POST', /ig-api-upload/)[0]!;
    expect(up.headers.get('authorization')).toBe(`OAuth ${PAGE_TOKEN}`);
    expect(up.headers.get('offset')).toBe('0');
    expect(up.headers.get('file_size')).toBe(String(VIDEO.length));
    expect(up.body?.equals(VIDEO)).toBe(true);
    expect(h.apiCalls).toEqual(['ig_container']);
    expect(h.target).toMatchObject({ remoteContainerId: 'c1', remoteUploadOffset: VIDEO.length });

    // Next tick: FINISHED → done, no new container or upload.
    const graph2 = new FakeGraph().on('GET', /\/c1\?/, container('FINISHED'));
    const pub2 = createInstagramIntegration({ env: () => env, fetch: graph2.fetch }).publisher;
    expect(await pub2.prepare(h.next())).toEqual({ kind: 'done' });
    expect(graph2.calls).toHaveLength(1);
  });

  it('respects per-target options (share_to_feed=false, custom thumb offset, offset beyond video dropped)', async () => {
    const { graph, pub } = setup();
    graph
      .on('POST', /\/999\/media$/, () => ({ id: 'c1' }))
      .on('POST', /ig-api-upload/, () => ({ success: true }))
      .on('GET', /\/c1\?/, container('IN_PROGRESS'));
    const h = harness({
      platform: 'instagram',
      scheduledAt: SLOT,
      now: PREP,
      mode: 'app',
      target: { options: { shareToFeed: false, thumbOffsetMs: 1500 } },
    });
    await pub.prepare(h.input);
    expect(graph.calls[0]!.params.get('share_to_feed')).toBe('false');
    expect(graph.calls[0]!.params.get('thumb_offset')).toBe('1500');

    const h2 = harness({
      platform: 'instagram',
      scheduledAt: SLOT,
      now: PREP,
      mode: 'app',
      asset: { coverFrameMs: 90_000 },
    });
    await pub.prepare(h2.input);
    expect(graph.find('POST', /\/999\/media$/)[1]!.params.has('thumb_offset')).toBe(false);
  });

  it('resumes after a crash: re-uploads into the saved container without creating a new one', async () => {
    const { graph, pub } = setup();
    graph
      .on('GET', /\/c1\?/, container('IN_PROGRESS'))
      .on('POST', /ig-api-upload\/v27\.0\/c1$/, () => ({ success: true }));
    const h = harness({
      platform: 'instagram',
      scheduledAt: SLOT,
      now: PREP,
      mode: 'app',
      target: { remoteContainerId: 'c1' },
    });
    const res = await pub.prepare(h.input);
    expect(res.kind).toBe('wait');
    expect(graph.find('POST', /\/999\/media$/)).toHaveLength(0);
    expect(graph.find('POST', /ig-api-upload/)).toHaveLength(1);
    expect(h.apiCalls).toEqual([]);
  });

  it('EXPIRED container → creates a new one', async () => {
    const { graph, pub } = setup();
    graph
      .once('GET', /\/old\?/, () => ({ id: 'old', status_code: 'EXPIRED' }))
      .on('POST', /\/999\/media$/, () => ({ id: 'c1' }))
      .on('POST', /ig-api-upload\/v27\.0\/c1$/, () => ({ success: true }))
      .on('GET', /\/c1\?/, container('FINISHED'));
    const h = harness({
      platform: 'instagram',
      scheduledAt: SLOT,
      now: PREP,
      mode: 'app',
      target: { remoteContainerId: 'old', remoteUploadOffset: VIDEO.length },
    });
    expect(await pub.prepare(h.input)).toEqual({ kind: 'done' });
    expect(h.target.remoteContainerId).toBe('c1');
    expect(h.apiCalls).toEqual(['ig_container']);
  });

  it('ERROR container: validation subcode → invalid; transient subcode → retryable + cleared', async () => {
    const { graph, pub } = setup();
    graph.once('GET', /\/c1\?/, container('ERROR', 'Error: unsupported format (2207026)'));
    const h = harness({
      platform: 'instagram',
      scheduledAt: SLOT,
      now: PREP,
      mode: 'app',
      target: { remoteContainerId: 'c1', remoteUploadOffset: VIDEO.length },
    });
    const err = await pub.prepare(h.input).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.category).toBe('invalid');
    expect(err.message).toMatch(/unsupported video format/i);
    expect(h.target.remoteContainerId).toBe('c1');

    graph.once('GET', /\/c1\?/, container('ERROR', 'Error: unknown upload error (2207053)'));
    const err2 = await pub.prepare(h.next()).catch((e) => e);
    expect(err2.category).toBe('retryable');
    expect(h.target.remoteContainerId).toBeNull();
  });
});

describe('instagram publish', () => {
  const ready = { remoteContainerId: 'c1', remoteUploadOffset: VIDEO.length };

  it('checks quota, publishes, fetches the permalink', async () => {
    const { graph, pub } = setup();
    graph
      .on('GET', /\/c1\?/, container('FINISHED'))
      .on('GET', /\/999\/content_publishing_limit/, () => quota(3))
      .on('POST', /\/999\/media_publish$/, () => ({ id: 'm1' }))
      .on('GET', /\/m1\?/, () => ({ id: 'm1', permalink: 'https://www.instagram.com/reel/abc/' }));
    const h = harness({
      platform: 'instagram',
      scheduledAt: SLOT,
      now: SLOT,
      mode: 'app',
      target: ready,
    });
    const res = await pub.publish(h.input);
    expect(res).toEqual({
      kind: 'done',
      remoteMediaId: 'm1',
      remoteUrl: 'https://www.instagram.com/reel/abc/',
      note: undefined,
    });
    expect(graph.find('POST', /media_publish/)[0]!.params.get('creation_id')).toBe('c1');
    expect(graph.find('GET', /content_publishing_limit/)[0]!.url.searchParams.get('fields')).toBe(
      'quota_usage,config',
    );
    expect(h.apiCalls).toEqual(['ig_publish']);
    expect(h.target).toMatchObject({
      remoteMediaId: 'm1',
      remoteUrl: 'https://www.instagram.com/reel/abc/',
    });
  });

  it('quota exhausted → quota error and no publish call', async () => {
    const { graph, pub } = setup();
    graph
      .on('GET', /\/c1\?/, container('FINISHED'))
      .on('GET', /content_publishing_limit/, () => quota(50, 50));
    const h = harness({
      platform: 'instagram',
      scheduledAt: SLOT,
      now: SLOT,
      mode: 'app',
      target: ready,
    });
    const err = await pub.publish(h.input).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.category).toBe('quota');
    expect(err.retryAfterSec).toBeGreaterThan(0);
    expect(graph.find('POST', /media_publish/)).toHaveLength(0);
  });

  it('config_issue → done with a note (never retried)', async () => {
    const { graph, pub } = setup();
    graph
      .on('GET', /\/c1\?/, container('FINISHED'))
      .on('GET', /content_publishing_limit/, () => quota(1))
      .on('POST', /media_publish/, () => ({ id: 'm1', config_issue: 'CAPTION_NOT_ATTACHED' }))
      .on('GET', /\/m1\?/, () => ({ permalink: 'https://www.instagram.com/reel/abc/' }));
    const h = harness({
      platform: 'instagram',
      scheduledAt: SLOT,
      now: SLOT,
      mode: 'app',
      target: ready,
    });
    const res = await pub.publish(h.input);
    expect(res).toMatchObject({ kind: 'done', remoteMediaId: 'm1', note: 'caption not attached' });
  });

  it('media not ready (9007) → wait', async () => {
    const { graph, pub } = setup();
    graph
      .on('GET', /\/c1\?/, container('FINISHED'))
      .on('GET', /content_publishing_limit/, () => quota(1))
      .on('POST', /media_publish/, () =>
        graphError(9007, { subcode: 2207027, message: 'Media ID is not available' }),
      );
    const h = harness({
      platform: 'instagram',
      scheduledAt: SLOT,
      now: SLOT,
      mode: 'app',
      target: ready,
    });
    expect((await pub.publish(h.input)).kind).toBe('wait');
    expect(h.apiCalls).toEqual([]);
  });

  it('still IN_PROGRESS at the slot → wait without publishing', async () => {
    const { graph, pub } = setup();
    graph.on('GET', /\/c1\?/, container('IN_PROGRESS'));
    const h = harness({
      platform: 'instagram',
      scheduledAt: SLOT,
      now: SLOT,
      mode: 'app',
      target: ready,
    });
    expect((await pub.publish(h.input)).kind).toBe('wait');
    expect(graph.find('POST', /./)).toHaveLength(0);
  });

  it('daily limit error from media_publish maps to quota', async () => {
    const { graph, pub } = setup();
    graph
      .on('GET', /\/c1\?/, container('FINISHED'))
      .on('GET', /content_publishing_limit/, () => quota(1))
      .on('POST', /media_publish/, () => graphError(9, { subcode: 2207042 }));
    const h = harness({
      platform: 'instagram',
      scheduledAt: SLOT,
      now: SLOT,
      mode: 'app',
      target: ready,
    });
    await expect(pub.publish(h.input)).rejects.toMatchObject({ category: 'quota' });
  });

  it('container already PUBLISHED (crash after publish) → finds the media instead of publishing again', async () => {
    const { graph, pub } = setup();
    graph.on('GET', /\/c1\?/, container('PUBLISHED')).on('GET', /\/999\/media\?/, () => ({
      data: [
        { id: 'other', caption: 'Something else', timestamp: '2026-11-13T12:30:10+0000' },
        {
          id: 'm1',
          caption: 'Socha tha normal sunset hoga… phir ye hua\n\n#travel',
          timestamp: '2026-11-13T12:30:05+0000',
          permalink: 'https://www.instagram.com/reel/abc/',
        },
      ],
    }));
    const h = harness({
      platform: 'instagram',
      scheduledAt: SLOT,
      now: SLOT,
      mode: 'app',
      target: ready,
    });
    const res = await pub.publish(h.input);
    expect(res).toMatchObject({ kind: 'done', remoteMediaId: 'm1' });
    expect(graph.find('POST', /media_publish/)).toHaveLength(0);
    const list = graph.find('GET', /\/999\/media\?/)[0]!;
    expect(list.url.searchParams.get('fields')).toBe('id,permalink,timestamp,caption');
    expect(list.url.searchParams.get('limit')).toBe('10');
  });
});

describe('secrets in publisher logs', () => {
  it('never puts tokens in step logs, errors or console output', async () => {
    const lines: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log =
      console.warn =
      console.error =
        (...a: unknown[]) => void lines.push(a.map(String).join(' '));
    try {
      const { graph, pub } = setup();
      graph
        .on('POST', /\/999\/media$/, () => ({ id: 'c1' }))
        .on('POST', /ig-api-upload/, () =>
          graphError(190, { message: `Invalid token ${PAGE_TOKEN}`, status: 401 }),
        );
      const h = harness({ platform: 'instagram', scheduledAt: SLOT, now: PREP, mode: 'app' });
      const err = await pub.prepare(h.input).catch((e) => e);
      expect(err.category).toBe('auth');
      expect(h.target.remoteContainerId).toBeNull(); // rejected upload → fresh container next time
      const out = JSON.stringify({
        steps: h.steps,
        progress: h.progress,
        message: err.message,
        details: err.details,
        lines,
      });
      expect(out).not.toContain(PAGE_TOKEN);
      expect(h.steps.length).toBeGreaterThan(0);
    } finally {
      Object.assign(console, orig);
    }
  });
});

describe('instagram reconcile / cancel', () => {
  it('reconcile: published container → finds media; FINISHED → not published', async () => {
    const { graph, pub } = setup();
    graph
      .once('GET', /\/c1\?/, container('PUBLISHED'))
      .on('GET', /\/999\/media\?/, () => ({
        data: [
          {
            id: 'm1',
            caption: 'Socha tha normal sunset hoga… phir ye hua',
            timestamp: '2026-11-13T12:30:05+0000',
            permalink: 'https://www.instagram.com/reel/abc/',
          },
        ],
      }))
      .once('GET', /\/c1\?/, container('FINISHED'));
    const h = harness({
      platform: 'instagram',
      scheduledAt: SLOT,
      now: SLOT,
      mode: 'app',
      target: { remoteContainerId: 'c1', remoteUploadOffset: VIDEO.length, prepareAt: PREP },
    });
    expect(await pub.reconcile(h.input)).toEqual({
      published: true,
      remoteMediaId: 'm1',
      remoteUrl: 'https://www.instagram.com/reel/abc/',
    });
    const h2 = harness({
      platform: 'instagram',
      scheduledAt: SLOT,
      now: SLOT,
      mode: 'app',
      target: { remoteContainerId: 'c1' },
    });
    expect(await pub.reconcile(h2.input)).toEqual({ published: false });
  });

  it('cancel forgets an unpublished container and never touches published media', async () => {
    const { graph, pub } = setup();
    const h = harness({
      platform: 'instagram',
      scheduledAt: SLOT,
      now: PREP,
      mode: 'app',
      target: { remoteContainerId: 'c1', remoteUploadOffset: 5 },
    });
    await pub.cancel(h.input);
    expect(h.target.remoteContainerId).toBeNull();
    const live = harness({
      platform: 'instagram',
      scheduledAt: SLOT,
      now: PREP,
      mode: 'app',
      target: { remoteContainerId: 'c1', remoteMediaId: 'm1', status: 'published' },
    });
    await pub.cancel(live.input);
    expect(live.target.remoteMediaId).toBe('m1');
    expect(graph.calls).toHaveLength(0);
  });
});
