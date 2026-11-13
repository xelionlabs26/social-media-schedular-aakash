import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getEnv } from '../env';
import { runProbe } from './probe';
import { listFilters, runTool } from './process';
import { fakeProbe, hasFfmpeg, makeFixtures, type Fixtures } from './test-fixtures';
import {
  fpsWindow,
  normalizeArgs,
  normalizeVideoFilter,
  planMaster,
  remuxArgs,
  type FilterSupport,
} from './transcode';

const ALL = ['instagram', 'youtube', 'facebook'] as const;
const ZSCALE: FilterSupport = { zscale: true, tonemap: true, colorspace: true };
const NO_ZSCALE: FilterSupport = { zscale: false, tonemap: true, colorspace: true };

describe('planMaster (fast path decision)', () => {
  it('remuxes a compliant clip', () => {
    expect(planMaster(fakeProbe(), [...ALL])).toEqual({ mode: 'remux', reasons: [] });
    expect(planMaster(fakeProbe({ vcodec: 'hevc' }), [...ALL]).mode).toBe('remux');
    expect(
      planMaster(fakeProbe({ hasAudio: false, acodec: null, audioSampleRate: null }), [...ALL])
        .mode,
    ).toBe('remux');
  });

  it.each([
    ['codec', { vcodec: 'vp9' }],
    ['10-bit', { pixFmt: 'yuv420p10le', bitDepth: 10 }],
    ['4:2:2', { pixFmt: 'yuv422p' }],
    ['interlaced', { interlaced: true }],
    ['VFR', { isVfr: true }],
    ['120 fps', { fps: 120 }],
    ['unknown fps', { fps: null }],
    ['bitrate', { bitrate: 30_000_000 }],
    ['unknown bitrate', { bitrate: null }],
    ['size', { sizeBytes: 301 * 1024 * 1024 }],
    ['audio codec', { acodec: 'opus' }],
    ['audio rate', { audioSampleRate: 96_000 }],
    ['4K', { width: 2160, height: 3840 }],
    ['HDR', { colorTransfer: 'arib-std-b67' }],
    ['rotation', { rotation: 90 }],
  ] as const)('normalizes when %s fails', (_name, over) => {
    const plan = planMaster(fakeProbe(over), [...ALL]);
    expect(plan.mode).toBe('normalize');
    expect(plan.reasons.length).toBeGreaterThan(0);
  });

  it('uses the strictest selected frame-rate window', () => {
    expect(fpsWindow(['instagram'])).toEqual({ min: 23, max: 60 });
    expect(fpsWindow(['instagram', 'facebook'])).toEqual({ min: 24, max: 60 });
    const film = fakeProbe({ fps: 23.5 });
    expect(planMaster(film, ['instagram', 'youtube']).mode).toBe('remux');
    expect(planMaster(film, ['instagram', 'facebook']).mode).toBe('normalize');
    // 23.976 is within tolerance of 24 for Facebook.
    expect(planMaster(fakeProbe({ fps: 23.976 }), [...ALL]).mode).toBe('remux');
  });

  it('builds a stream-copy remux with faststart', () => {
    const args = remuxArgs('/in.mov', '/out.mp4', fakeProbe());
    expect(args.join(' ')).toContain('-map 0:v:0 -map 0:a:0? -c copy');
    expect(args.join(' ')).toContain('-movflags +faststart');
    expect(args).not.toContain('hvc1');
    expect(remuxArgs('/in', '/out', fakeProbe({ vcodec: 'hevc' }))).toContain('hvc1');
  });
});

describe('normalize filters', () => {
  it('keeps the shape and only scales down', () => {
    expect(normalizeVideoFilter(fakeProbe({ width: 720, height: 1280 }), ZSCALE)).toBe(
      'scale=w=trunc(iw/2)*2:h=trunc(ih/2)*2,fps=30,format=yuv420p',
    );
    expect(normalizeVideoFilter(fakeProbe({ width: 2160, height: 3840 }), ZSCALE)).toContain(
      'scale=w=1080:h=1920:force_original_aspect_ratio=decrease',
    );
    expect(normalizeVideoFilter(fakeProbe({ width: 3840, height: 2160 }), ZSCALE)).toContain(
      'scale=w=1920:h=1080:force_original_aspect_ratio=decrease',
    );
    expect(normalizeVideoFilter(fakeProbe(), ZSCALE)).not.toMatch(/crop|pad/);
  });

  it('tone-maps HDR with zscale, or falls back to colorspace', () => {
    const hlg = fakeProbe({ colorTransfer: 'arib-std-b67' });
    expect(normalizeVideoFilter(hlg, ZSCALE)).toMatch(
      /^zscale=tin=arib-std-b67.*tonemap=tonemap=hable/,
    );
    expect(normalizeVideoFilter(fakeProbe({ colorTransfer: 'smpte2084' }), ZSCALE)).toContain(
      'tin=smpte2084',
    );
    expect(normalizeVideoFilter(hlg, NO_ZSCALE)).toMatch(/^colorspace=all=bt709/);
    expect(normalizeVideoFilter(fakeProbe({ interlaced: true }), ZSCALE)).toMatch(/^yadif/);
  });

  it('encodes H.264 High CFR 30 with AAC 48 kHz stereo, or no audio', () => {
    const a = normalizeArgs('/i', '/o', fakeProbe(), ZSCALE).join(' ');
    for (const part of [
      '-c:v libx264',
      '-profile:v high',
      '-preset veryfast',
      '-crf 20',
      '-maxrate 20M',
      '-bufsize 40M',
      '-fps_mode cfr',
      '-pix_fmt yuv420p',
      '-c:a aac',
      '-ar 48000',
      '-ac 2',
      '-b:a 128k',
      '-movflags +faststart',
    ]) {
      expect(a).toContain(part);
    }
    const silent = normalizeArgs('/i', '/o', fakeProbe({ hasAudio: false }), ZSCALE);
    expect(silent).toContain('-an');
    expect(silent).not.toContain('-c:a');
  });
});

describe.skipIf(!hasFfmpeg())('normalize with ffmpeg', () => {
  const env = getEnv();
  let fx: Fixtures;
  beforeAll(async () => {
    fx = await makeFixtures();
  }, 60_000);
  afterAll(async () => {
    if (fx) await fs.rm(fx.dir, { recursive: true, force: true });
  });

  async function normalize(input: string, filters?: FilterSupport) {
    const probe = await runProbe(input, env);
    const out = path.join(fx.dir, `norm-${path.basename(input)}`);
    const names = await listFilters(env.FFMPEG_PATH);
    const support = filters ?? {
      zscale: names.has('zscale'),
      tonemap: names.has('tonemap'),
      colorspace: names.has('colorspace'),
    };
    await runTool(env.FFMPEG_PATH, normalizeArgs(input, out, probe, support), {
      timeoutMs: 120_000,
    });
    return runProbe(out, env);
  }

  it('tone-maps 10-bit HLG to 8-bit SDR BT.709', async () => {
    const out = await normalize(fx.hdr10bit);
    expect(out).toMatchObject({ pixFmt: 'yuv420p', bitDepth: 8, colorTransfer: 'bt709', fps: 30 });
    expect(planMaster(out, [...ALL]).mode).toBe('remux');
  });

  it('applies rotation to the pixels', async () => {
    const out = await normalize(fx.rotated);
    expect(out).toMatchObject({ width: 1080, height: 1920, rotation: 0 });
  });

  it('makes VFR constant 30 fps and keeps silent clips silent', async () => {
    const vfr = await normalize(fx.vfr);
    expect(vfr).toMatchObject({ isVfr: false, fps: 30 });
    const silent = await normalize(fx.silent);
    expect(silent.hasAudio).toBe(false);
  });

  it('works with the colorspace HDR fallback', async () => {
    const out = await normalize(fx.hdr10bit, NO_ZSCALE);
    expect(out).toMatchObject({ pixFmt: 'yuv420p', bitDepth: 8 });
  });
});
