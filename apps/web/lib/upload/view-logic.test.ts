/**
 * Apply-to-all plan, Schedule button readiness and the card view model.
 */
import { describe, expect, it } from 'vitest';
import type { PostCard, TargetCard } from '@app/core/posts';
import { computeApplyPlan, planTargetChanges, sameWhen } from './apply-plan';
import { buildCardModel } from './card-model';
import { computeScheduleState } from './readiness';
import type { UploadItem } from './queue';

function target(over: Partial<TargetCard> = {}): TargetCard {
  return {
    id: `t-${over.platform ?? 'instagram'}`,
    platform: 'instagram',
    status: 'draft',
    display: 'draft',
    overdue: false,
    attention: null,
    note: null,
    scheduledAt: null,
    publishMode: null,
    title: '',
    body: 'Socha tha normal sunset hoga…',
    hashtags: ['goa'],
    tags: [],
    options: {},
    textSources: {},
    remoteUrl: null,
    publishedAt: null,
    lastError: null,
    issues: [],
    connected: true,
    version: 0,
    ...over,
  };
}

function post(over: Partial<PostCard> = {}, asset: Partial<PostCard['asset']> = {}): PostCard {
  const targets = over.targets ?? [target()];
  return {
    id: 'p1',
    batchId: 'b1',
    scheduledAt: null,
    approvedAt: null,
    display: 'draft',
    createdAt: new Date(0),
    ...over,
    targets,
    asset: {
      id: 'a1',
      filename: '01_beach.mp4',
      status: 'ready',
      processingStep: null,
      durationMs: 58_000,
      width: 1080,
      height: 1920,
      warnings: [],
      transcript: null,
      notes: '',
      error: null,
      coverFrameMs: null,
      sizeBytes: 1000,
      sortIndex: 0,
      createdAt: new Date(0),
      ...asset,
    },
  };
}

describe('planTargetChanges / computeApplyPlan', () => {
  it('adds missing platforms, deletes drafts, keeps scheduled targets', () => {
    const plan = planTargetChanges(
      [
        { platform: 'instagram' as const, status: 'draft' as const },
        { platform: 'youtube' as const, status: 'scheduled' as const },
        { platform: 'facebook' as const, status: 'canceled' as const },
      ],
      ['facebook'],
    );
    expect(plan.add).toEqual(['facebook']);
    expect(plan.remove.map((t) => t.platform)).toEqual(['instagram']);
    expect(plan.keep.map((t) => t.platform)).toEqual(['youtube']);
  });

  it('lists exactly the cards that change', () => {
    const plan = computeApplyPlan(
      [
        {
          assetId: 'a',
          filename: 'a.mp4',
          notes: 'Goa trip',
          assetStatus: 'ready',
          targets: [
            { platform: 'instagram', status: 'draft' },
            { platform: 'youtube', status: 'draft' },
          ],
        },
        {
          assetId: 'b',
          filename: 'b.mp4',
          notes: '',
          assetStatus: 'ready',
          targets: [{ platform: 'instagram', status: 'draft' }],
        },
        { assetId: 'c', filename: 'c.mp4', notes: '', assetStatus: 'uploading', targets: null },
      ],
      { platforms: ['instagram', 'youtube'], notes: ' Goa trip ', when: { mode: 'draft' } },
      { mode: 'next_free', startDate: '2026-11-15' },
    );
    expect(plan.total).toBe(3);
    expect(plan.unchanged).toBe(1);
    expect(
      plan.changes.map((c) => [c.assetId, c.add, c.remove, c.notesChanged, c.pendingUpload]),
    ).toEqual([
      ['b', ['youtube'], [], true, false],
      ['c', [], [], true, true],
    ]);
    expect(plan.readyWithNewNotes).toBe(1);
    expect(plan.when).toEqual({
      from: { mode: 'next_free', startDate: '2026-11-15' },
      to: { mode: 'draft' },
    });
    expect(plan.hasChanges).toBe(true);
  });

  it('reports no changes when everything matches', () => {
    const plan = computeApplyPlan(
      [
        {
          assetId: 'a',
          filename: 'a',
          notes: '',
          assetStatus: 'ready',
          targets: [{ platform: 'youtube', status: 'draft' }],
        },
      ],
      { platforms: ['youtube'], notes: '', when: { mode: 'pick' } },
      { mode: 'pick' },
    );
    expect(plan.hasChanges).toBe(false);
    expect(sameWhen({ mode: 'next_free', startDate: '2026-11-15' }, { mode: 'next_free' })).toBe(
      false,
    );
    expect(sameWhen({ mode: 'draft', startDate: 'x' }, { mode: 'draft' })).toBe(true);
  });
});

describe('computeScheduleState', () => {
  const item = (p: PostCard | null, uploading = false, assetId = 'a1') => ({
    assetId,
    filename: p?.asset.filename ?? 'x.mp4',
    post: p,
    uploading,
  });

  it('counts ready drafts and labels the button', () => {
    const s = computeScheduleState([item(post()), item(post({ id: 'p2' }), false, 'a2')], {
      mode: 'next_free',
    });
    expect(s.readyPostIds).toEqual(['p1', 'p2']);
    expect(s.disabledReason).toBeNull();
    expect(s.buttonLabel).toBe('Schedule 2 videos');
    expect(computeScheduleState([item(post())], { mode: 'draft' }).buttonLabel).toBe(
      'Save 1 draft',
    );
  });

  it('explains why nothing can be scheduled', () => {
    expect(computeScheduleState([], { mode: 'next_free' }).disabledReason).toBe('Add videos first');
    expect(computeScheduleState([item(null, true)], { mode: 'next_free' }).disabledReason).toBe(
      'Uploading…',
    );
    const writing = post(
      { display: 'processing' },
      { status: 'processing', processingStep: 'generate' },
    );
    expect(computeScheduleState([item(writing)], { mode: 'next_free' }).disabledReason).toBe(
      'Writing captions…',
    );
    const probing = post(
      { display: 'processing' },
      { status: 'processing', processingStep: 'probe' },
    );
    expect(computeScheduleState([item(probing)], { mode: 'next_free' }).disabledReason).toBe(
      'Analyzing videos…',
    );
    const scheduled = post({ targets: [target({ status: 'scheduled', display: 'scheduled' })] });
    expect(computeScheduleState([item(scheduled)], { mode: 'next_free' }).disabledReason).toBe(
      'Everything here is scheduled',
    );
  });

  it('leaves out cards that need attention, with the reason', () => {
    const tooLong = post({
      targets: [
        target({
          platform: 'youtube',
          issues: [
            {
              field: 'title',
              code: 'title_too_long',
              message: 'Title is 120/100 characters.',
              severity: 'block',
            },
          ],
        }),
      ],
    });
    const s = computeScheduleState(
      [
        item(tooLong),
        item(null, false, 'a2'),
        item(post({ id: 'p3' }, { status: 'failed', error: 'bad file' }), false, 'a3'),
      ],
      { mode: 'next_free' },
    );
    expect(s.readyPostIds).toEqual([]);
    expect(s.needsAttention.map((n) => n.reason)).toEqual([
      'YouTube: Title is 120/100 characters.',
      'Upload interrupted',
      'Processing failed: bad file',
    ]);
    expect(s.disabledReason).toBe('Fix the cards that need attention');
  });
});

describe('buildCardModel', () => {
  const upload = (over: Partial<UploadItem>): UploadItem => ({
    id: 'a1',
    phase: 'uploading',
    loaded: 64,
    total: 100,
    attempt: 1,
    error: null,
    ...over,
  });
  const base = { assetStatus: 'uploading' as const, thumbUrl: null, post: null };

  it('shows upload progress, failure and interruption', () => {
    const m = buildCardModel(base, upload({}), {
      durationMs: 58_000,
      width: 1080,
      height: 1920,
      thumb: 'data:x',
    });
    expect(m).toMatchObject({
      phase: 'uploading',
      status: 'processing',
      detail: 'Uploading 64%',
      progress: 64,
    });
    expect(m.thumb).toBe('data:x');
    expect(
      buildCardModel(
        base,
        upload({ phase: 'failed', error: 'Upload failed (network)' }),
        undefined,
      ),
    ).toMatchObject({
      phase: 'upload_failed',
      status: 'needs_attention',
      detail: 'Upload failed (network)',
    });
    expect(buildCardModel(base, undefined, undefined)).toMatchObject({
      phase: 'interrupted',
      status: 'needs_attention',
      detail: 'Upload interrupted',
    });
    expect(buildCardModel(null, undefined, undefined).phase).toBe('preparing');
  });

  it('shows the processing step and the post’s schedule', () => {
    const processing = post(
      { display: 'processing' },
      { status: 'processing', processingStep: 'transcribe' },
    );
    expect(buildCardModel({ ...base, post: processing }, undefined, undefined).detail).toBe(
      'Transcribing speech',
    );
    const queued = post({ display: 'processing' }, { status: 'uploaded' });
    expect(buildCardModel({ ...base, post: queued }, undefined, undefined).detail).toBe(
      'Waiting to start',
    );

    const at1 = new Date('2026-11-15T12:30:00Z');
    const at2 = new Date('2026-11-16T12:30:00Z');
    const varied = post({
      display: 'scheduled',
      targets: [
        target({ status: 'scheduled', display: 'scheduled', scheduledAt: at2 }),
        target({
          platform: 'youtube',
          status: 'scheduled',
          display: 'scheduled',
          scheduledAt: at1,
        }),
      ],
    });
    const m = buildCardModel(
      { ...base, post: varied, thumbUrl: '/api/files?x' },
      undefined,
      undefined,
    );
    expect(m.when?.toISOString()).toBe(at1.toISOString());
    expect(m.whenVaries).toBe(true);
    expect(m.allDrafts).toBe(false);
    expect(m.thumb).toBe('/api/files?x');
    expect(m.platforms.map((p) => p.platform)).toEqual(['instagram', 'youtube']);
  });

  it('explains needs-attention and sorts warnings by severity', () => {
    const failed = post(
      { display: 'needs_attention' },
      {
        status: 'failed',
        error: 'No video stream',
        warnings: [
          { code: 'no_audio', severity: 'info', message: 'No audio' },
          { code: 'over_60s', severity: 'warn', message: 'Over 60 s' },
        ],
      },
    );
    const m = buildCardModel({ ...base, post: failed }, undefined, undefined);
    expect(m.detail).toBe('No video stream');
    expect(m.canRetryProcessing).toBe(true);
    expect(m.warnings.map((w) => w.code)).toEqual(['over_60s', 'no_audio']);
    const reauth = post({
      display: 'needs_attention',
      targets: [
        target({
          platform: 'youtube',
          status: 'needs_reauth',
          display: 'needs_attention',
          attention: 'Reconnect YouTube',
        }),
      ],
    });
    expect(buildCardModel({ ...base, post: reauth }, undefined, undefined).detail).toBe(
      'YouTube: Reconnect YouTube',
    );
  });
});
