import { describe, expect, it } from 'vitest';
import { PlatformError } from '../platforms';
import { createFacebookIntegration } from './index';
import {
  FakeGraph,
  MASTER_KEY,
  PAGE_TOKEN,
  VIDEO,
  graphError,
  harness,
  makeAsset,
  makeSettings,
  makeTarget,
  memoryStorage,
  testEnv,
} from './test-utils';
import { facebookKind, qualifiesAsReel } from './video';

const NOW = new Date('2026-11-13T10:00:00Z');
const IN_2H = new Date('2026-11-13T12:00:00Z');
const env = testEnv();

function setup() {
  const graph = new FakeGraph();
  const fb = createFacebookIntegration({ env: () => env, fetch: graph.fetch });
  return { graph, fb, pub: fb.publisher };
}

const status = (publish_status: string, extra: Record<string, unknown> = {}) => ({
  id: 'v1',
  permalink_url: '/reel/555',
  status: {
    video_status: publish_status === 'published' ? 'ready' : 'processing',
    uploading_phase: { status: 'completed', bytes_transfered: VIDEO.length },
    processing_phase: { status: 'completed' },
    publishing_phase: { status: 'not_started', publish_status },
    ...extra,
  },
});

describe('facebook mode + timing', () => {
  const { pub } = setup();
  const base = { asset: makeAsset(), target: makeTarget() };

  it('uses native scheduling from 10 minutes ahead, app mode below', () => {
    expect(
      pub.chooseMode({ ...base, now: NOW, scheduledAt: new Date(NOW.getTime() + 10 * 60_000) }),
    ).toBe('native');
    expect(
      pub.chooseMode({ ...base, now: NOW, scheduledAt: new Date(NOW.getTime() + 9 * 60_000) }),
    ).toBe('app');
  });

  it('prepares now within 29 days and at T−28 days when further out', () => {
    const in10d = new Date(NOW.getTime() + 10 * 86_400_000);
    expect(pub.prepareAt({ ...base, now: NOW, scheduledAt: in10d, mode: 'native' })).toEqual(NOW);
    const in40d = new Date(NOW.getTime() + 40 * 86_400_000);
    expect(pub.prepareAt({ ...base, now: NOW, scheduledAt: in40d, mode: 'native' })).toEqual(
      new Date(in40d.getTime() - 28 * 86_400_000),
    );
    expect(pub.prepareAt({ ...base, now: NOW, scheduledAt: IN_2H, mode: 'app' })).toEqual(NOW);
  });

  it('decides reel vs video from probe data and settings', () => {
    expect(qualifiesAsReel(makeAsset())).toBe(true);
    expect(qualifiesAsReel(makeAsset({ durationMs: 120_000 }))).toBe(false);
    expect(qualifiesAsReel(makeAsset({ width: 1920, height: 1080 }))).toBe(true); // 16:9 ok
    expect(qualifiesAsReel(makeAsset({ width: 2400, height: 1000 }))).toBe(false); // wider than 16:9
    expect(qualifiesAsReel(makeAsset({ width: 480, height: 854 }))).toBe(false); // too small
    expect(qualifiesAsReel(makeAsset({ fps: 15 }))).toBe(false);
    expect(qualifiesAsReel(makeAsset({ width: 1920, height: 1080, rotation: 90 }))).toBe(true);
    const settings = makeSettings({ facebookDefaults: { kind: 'video' } });
    expect(facebookKind(makeTarget(), settings, makeAsset())).toBe('video');
    expect(facebookKind(makeTarget({ options: { fbKind: 'reel' } }), settings, makeAsset())).toBe(
      'reel',
    );
  });
});

describe('facebook reels', () => {
  it('native: start → rupload → finish SCHEDULED → scheduled', async () => {
    const { graph, pub } = setup();
    graph
      .on('POST', /\/v27\.0\/111\/video_reels$/, (c) =>
        c.params.get('upload_phase') === 'start'
          ? { video_id: 'v1', upload_url: 'https://rupload.facebook.com/video-upload/v1' }
          : { success: true },
      )
      .on('POST', /rupload\.facebook\.com\/video-upload\/v27\.0\/v1$/, () => ({ success: true }))
      .once('GET', /\/v27\.0\/v1\?/, () => status('draft'))
      .on('GET', /\/v27\.0\/v1\?/, () => status('scheduled'));
    const h = harness({ platform: 'facebook', scheduledAt: IN_2H, now: NOW, mode: 'native' });

    const res = await pub.prepare(h.input);
    expect(res).toEqual({ kind: 'done', remoteMediaId: 'v1' });

    const start = graph.find('POST', /video_reels/)[0]!;
    expect(start.params.get('upload_phase')).toBe('start');
    expect(start.params.get('access_token')).toBe(PAGE_TOKEN);
    expect(start.params.get('appsecret_proof')).toMatch(/^[0-9a-f]{64}$/);

    const up = graph.find('POST', /rupload/)[0]!;
    expect(up.headers.get('authorization')).toBe(`OAuth ${PAGE_TOKEN}`);
    expect(up.headers.get('offset')).toBe('0');
    expect(up.headers.get('file_size')).toBe(String(VIDEO.length));
    expect(up.body?.equals(VIDEO)).toBe(true);

    const finish = graph.find('POST', /video_reels/)[1]!;
    expect(finish.params.get('upload_phase')).toBe('finish');
    expect(finish.params.get('video_id')).toBe('v1');
    expect(finish.params.get('video_state')).toBe('SCHEDULED');
    expect(finish.params.get('scheduled_publish_time')).toBe(String(IN_2H.getTime() / 1000));
    expect(finish.params.get('description')).toBe(h.target.body);
    expect(finish.params.has('title')).toBe(false);

    expect(h.apiCalls).toEqual(['fb_reel_start']);
    expect(h.target).toMatchObject({
      remoteContainerId: 'v1',
      remoteUploadOffset: VIDEO.length,
      remoteMediaId: 'v1',
    });
    // Never the graph-video host.
    expect(graph.calls.every((c) => !c.url.host.startsWith('graph-video'))).toBe(true);
  });

  it('native: waits while Facebook is still processing', async () => {
    const { graph, pub } = setup();
    graph.on('GET', /\/v1\?/, () => status('draft'));
    const h = harness({
      platform: 'facebook',
      scheduledAt: IN_2H,
      now: NOW,
      mode: 'native',
      target: { remoteContainerId: 'v1', remoteUploadOffset: VIDEO.length, remoteMediaId: 'v1' },
    });
    const res = await pub.prepare(h.input);
    expect(res.kind).toBe('wait');
    expect(graph.find('POST', /./)).toHaveLength(0);
  });

  it('app mode: uploads in prepare, finishes PUBLISHED in publish', async () => {
    const { graph, pub } = setup();
    const soon = new Date(NOW.getTime() + 5 * 60_000);
    graph
      .on('POST', /\/111\/video_reels$/, (c) =>
        c.params.get('upload_phase') === 'start' ? { video_id: 'v1' } : { success: true },
      )
      .on('POST', /rupload/, () => ({ success: true }))
      .once('GET', /\/v1\?/, () => status('draft'))
      .once('GET', /\/v1\?/, () => status('draft'))
      .on('GET', /\/v1\?/, () => status('published'));
    const h = harness({ platform: 'facebook', scheduledAt: soon, now: NOW, mode: 'app' });

    expect(await pub.prepare(h.input)).toEqual({ kind: 'done' });
    expect(graph.find('POST', /video_reels/)).toHaveLength(1); // start only, no finish yet

    const atSlot = h.next({ now: soon });
    const first = await pub.publish(atSlot);
    expect(first.kind).toBe('wait');
    const finish = graph.find('POST', /video_reels/)[1]!;
    expect(finish.params.get('video_state')).toBe('PUBLISHED');
    expect(finish.params.has('scheduled_publish_time')).toBe(false);

    const second = await pub.publish(h.next({ now: soon }));
    expect(second).toEqual({
      kind: 'done',
      remoteMediaId: 'v1',
      remoteUrl: 'https://www.facebook.com/reel/555',
    });
    // finish was not sent twice
    expect(graph.find('POST', /video_reels/)).toHaveLength(2);
  });

  it('resumes an interrupted upload from bytes_transfered without a new start', async () => {
    const { graph, pub } = setup();
    graph
      .once('GET', /\/v1\?/, () =>
        status('draft', {
          video_status: 'uploading',
          uploading_phase: { status: 'in_progress', bytes_transfered: 10 },
        }),
      )
      .on('POST', /rupload/, () => ({ success: true }))
      .once('GET', /\/v1\?/, () => status('draft'))
      .on('POST', /video_reels/, () => ({ success: true }))
      .on('GET', /\/v1\?/, () => status('scheduled'));
    const h = harness({
      platform: 'facebook',
      scheduledAt: IN_2H,
      now: NOW,
      mode: 'native',
      target: { remoteContainerId: 'v1' },
    });
    const res = await pub.prepare(h.input);
    expect(res.kind).toBe('done');
    const up = graph.find('POST', /rupload/)[0]!;
    expect(up.headers.get('offset')).toBe('10');
    expect(up.body?.equals(VIDEO.subarray(10))).toBe(true);
    expect(h.apiCalls).toEqual([]);
    expect(graph.find('POST', /video_reels/).map((c) => c.params.get('upload_phase'))).toEqual([
      'finish',
    ]);
  });

  it('does not call finish twice when the crash happened right after finish', async () => {
    const { graph, pub } = setup();
    graph.on('GET', /\/v1\?/, () => status('scheduled'));
    const h = harness({
      platform: 'facebook',
      scheduledAt: IN_2H,
      now: NOW,
      mode: 'native',
      target: { remoteContainerId: 'v1', remoteUploadOffset: VIDEO.length },
    });
    expect(await pub.prepare(h.input)).toEqual({ kind: 'done', remoteMediaId: 'v1' });
    expect(graph.find('POST', /./)).toHaveLength(0);
    expect(h.target.remoteMediaId).toBe('v1');
  });

  it('uses file_url when storage has public URLs', async () => {
    const { graph, pub } = setup();
    graph
      .on('POST', /video_reels/, (c) =>
        c.params.get('upload_phase') === 'start' ? { video_id: 'v1' } : { success: true },
      )
      .on('POST', /rupload/, () => ({ success: true }))
      .once('GET', /\/v1\?/, () => status('draft'))
      .on('GET', /\/v1\?/, () => status('scheduled'));
    const h = harness({
      platform: 'facebook',
      scheduledAt: IN_2H,
      now: NOW,
      mode: 'native',
      storage: memoryStorage({ [MASTER_KEY]: VIDEO }, true),
    });
    await pub.prepare(h.input);
    const up = graph.find('POST', /rupload/)[0]!;
    expect(up.headers.get('file_url')).toContain('files.example.com');
    expect(up.headers.get('offset')).toBeNull();
  });

  it('too close for Facebook scheduling: waits for the slot, then publishes', async () => {
    const { graph, pub } = setup();
    const slot = new Date(NOW.getTime() + 10.5 * 60_000);
    graph
      .on('POST', /video_reels/, (c) =>
        c.params.get('upload_phase') === 'start' ? { video_id: 'v1' } : { success: true },
      )
      .on('POST', /rupload/, () => ({ success: true }))
      .on('GET', /\/v1\?/, () => status('draft'));
    const h = harness({ platform: 'facebook', scheduledAt: slot, now: NOW, mode: 'native' });
    const r1 = await pub.prepare(h.input);
    expect(r1.kind).toBe('wait');
    expect(graph.find('POST', /video_reels/)).toHaveLength(1);

    await pub.prepare(h.next({ now: slot }));
    const finish = graph.find('POST', /video_reels/)[1]!;
    expect(finish.params.get('video_state')).toBe('PUBLISHED');
  });

  it('maps a Reels spec error to a plain-English invalid error', async () => {
    const { graph, pub } = setup();
    graph
      .on('POST', /video_reels/, (c) =>
        c.params.get('upload_phase') === 'start'
          ? { video_id: 'v1' }
          : graphError(100, { subcode: 1363128, message: 'Invalid duration' }),
      )
      .on('POST', /rupload/, () => ({ success: true }))
      .on('GET', /\/v1\?/, () => status('draft'));
    const h = harness({ platform: 'facebook', scheduledAt: IN_2H, now: NOW, mode: 'native' });
    const err = await pub.prepare(h.input).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.category).toBe('invalid');
    expect(err.message).toMatch(/3–90 seconds/);
    expect(err.details.fbtraceId).toBe('TRACE123');
    expect(h.steps.at(-1)?.log.outcome).toBe('fatal');
  });

  it('reports processing errors from the status endpoint', async () => {
    const { graph, pub } = setup();
    graph.on('GET', /\/v1\?/, () =>
      status('draft', {
        video_status: 'error',
        processing_phase: { status: 'error', error: { message: 'Bad codec' } },
      }),
    );
    const h = harness({
      platform: 'facebook',
      scheduledAt: IN_2H,
      now: NOW,
      mode: 'native',
      target: { remoteContainerId: 'v1', remoteUploadOffset: VIDEO.length, remoteMediaId: 'v1' },
    });
    await expect(pub.prepare(h.input)).rejects.toMatchObject({
      category: 'invalid',
      message: expect.stringContaining('Bad codec'),
    });
  });
});

describe('facebook page videos (non-reel)', () => {
  it('native: streams a multipart upload with published=false + scheduled_publish_time', async () => {
    const { graph, pub } = setup();
    graph
      .on('POST', /\/111\/videos$/, () => ({ id: 'vid9' }))
      .on('GET', /\/vid9\?/, () => status('scheduled'));
    const h = harness({
      platform: 'facebook',
      scheduledAt: IN_2H,
      now: NOW,
      mode: 'native',
      asset: { durationMs: 200_000 },
    });
    const res = await pub.prepare(h.input);
    expect(res).toEqual({ kind: 'done', remoteMediaId: 'vid9' });
    const call = graph.find('POST', /\/111\/videos$/)[0]!;
    expect(call.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
    const text = call.body!.toString('latin1');
    expect(text).toContain('name="published"\r\n\r\nfalse');
    expect(text).toContain(`name="scheduled_publish_time"\r\n\r\n${IN_2H.getTime() / 1000}`);
    expect(text).toContain('name="source"; filename="clip.mp4"');
    expect(text).toContain(VIDEO.toString('latin1'));
    expect(Number(call.headers.get('content-length'))).toBe(call.body!.length);
    expect(h.apiCalls).toEqual(['fb_video']);
    expect(h.target.remoteMediaId).toBe('vid9');
  });

  it('public storage: uses file_url', async () => {
    const { graph, pub } = setup();
    graph
      .on('POST', /\/111\/videos$/, () => ({ id: 'vid9' }))
      .on('GET', /\/vid9\?/, () => status('scheduled'));
    const h = harness({
      platform: 'facebook',
      scheduledAt: IN_2H,
      now: NOW,
      mode: 'native',
      target: { options: { fbKind: 'video' } },
      storage: memoryStorage({ [MASTER_KEY]: VIDEO }, true),
    });
    await pub.prepare(h.input);
    const call = graph.find('POST', /\/111\/videos$/)[0]!;
    expect(call.params.get('file_url')).toContain('files.example.com');
    expect(call.params.get('published')).toBe('false');
  });

  it('app mode: posts at the slot with published=true', async () => {
    const { graph, pub } = setup();
    graph
      .on('POST', /\/111\/videos$/, () => ({ id: 'vid9' }))
      .on('GET', /\/vid9\?/, () => status('published'));
    const h = harness({
      platform: 'facebook',
      scheduledAt: NOW,
      now: NOW,
      mode: 'app',
      target: { options: { fbKind: 'video' } },
    });
    expect(await pub.prepare(h.input)).toEqual({ kind: 'done' });
    expect(graph.calls).toHaveLength(0);
    const res = await pub.publish(h.next());
    expect(res).toMatchObject({ kind: 'done', remoteMediaId: 'vid9' });
    expect(graph.find('POST', /videos/)[0]!.body!.toString()).toContain(
      'name="published"\r\n\r\ntrue',
    );
  });
});

describe('facebook verify / reconcile / cancel', () => {
  const prepared = {
    remoteContainerId: 'v1',
    remoteUploadOffset: VIDEO.length,
    remoteMediaId: 'v1',
  };

  it('publish (native) verifies it went live, waits while scheduled, flags when very late', async () => {
    const { graph, pub } = setup();
    graph
      .once('GET', /\/v1\?/, () => status('published'))
      .on('GET', /\/v1\?/, () => status('scheduled'));
    const h = harness({
      platform: 'facebook',
      scheduledAt: IN_2H,
      now: IN_2H,
      mode: 'native',
      target: prepared,
    });
    expect(await pub.publish(h.input)).toMatchObject({
      kind: 'done',
      remoteUrl: 'https://www.facebook.com/reel/555',
    });
    expect((await pub.publish(h.next())).kind).toBe('wait');
    const late = h.next({ now: new Date(IN_2H.getTime() + 31 * 60_000) });
    await expect(pub.publish(late)).rejects.toMatchObject({ category: 'fatal' });
  });

  it('reconcile reports scheduled / published / gone', async () => {
    const { graph, pub } = setup();
    graph
      .once('GET', /\/v1\?/, () => status('scheduled'))
      .once('GET', /\/v1\?/, () => status('published'))
      .once('GET', /\/v1\?/, () => graphError(100, { subcode: 33, message: 'does not exist' }));
    const h = harness({
      platform: 'facebook',
      scheduledAt: IN_2H,
      now: NOW,
      mode: 'native',
      target: prepared,
    });
    expect(await pub.reconcile(h.input)).toEqual({
      published: false,
      scheduled: true,
      remoteMediaId: 'v1',
    });
    expect(await pub.reconcile(h.input)).toMatchObject({ published: true, remoteMediaId: 'v1' });
    expect(await pub.reconcile(h.input)).toEqual({ published: false });
    const empty = harness({ platform: 'facebook', scheduledAt: IN_2H, now: NOW, mode: 'native' });
    expect(await pub.reconcile(empty.input)).toEqual({ published: false });
  });

  it('cancel deletes a scheduled video, tolerates 404, never deletes a live one', async () => {
    const { graph, pub } = setup();
    graph
      .once('GET', /\/v1\?/, () => status('scheduled'))
      .once('DELETE', /\/v1\?/, () => ({ success: true }))
      .once('GET', /\/v1\?/, () => graphError(100, { subcode: 33, status: 404 }))
      .once('GET', /\/v1\?/, () => status('published'));
    const h = harness({
      platform: 'facebook',
      scheduledAt: IN_2H,
      now: NOW,
      mode: 'native',
      target: prepared,
    });
    await pub.cancel(h.input);
    expect(graph.find('DELETE', /v1/)).toHaveLength(1);
    expect(h.target.remoteMediaId).toBeNull();

    await expect(pub.cancel(h.next())).resolves.toBeUndefined(); // nothing saved: no call
    const again = harness({
      platform: 'facebook',
      scheduledAt: IN_2H,
      now: NOW,
      mode: 'native',
      target: prepared,
    });
    await pub.cancel(again.input); // 404 → ok
    const live = harness({
      platform: 'facebook',
      scheduledAt: IN_2H,
      now: NOW,
      mode: 'native',
      target: prepared,
    });
    await pub.cancel(live.input); // published → keep
    expect(graph.find('DELETE', /v1/)).toHaveLength(1);
    expect(live.target.remoteMediaId).toBe('v1');
  });

  it('update is not supported (engine cancels and re-prepares)', async () => {
    const { pub } = setup();
    const h = harness({ platform: 'facebook', scheduledAt: IN_2H, now: NOW, mode: 'native' });
    expect(await pub.update!(h.input)).toBe(false);
  });
});
