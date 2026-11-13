import { describe, expect, it } from 'vitest';
import { fakeProbe } from './test-fixtures';
import type { ProbeResult } from './types';
import { formatDuration, videoWarnings } from './warnings';

const ALL = ['instagram', 'youtube', 'facebook'] as const;
const codes = (p: ProbeResult, platforms = [...ALL]) =>
  videoWarnings(p, platforms).map((w) => w.code);

describe('videoWarnings', () => {
  it('has nothing to say about a typical 58 s vertical clip', () => {
    expect(videoWarnings(fakeProbe(), [...ALL])).toEqual([]);
  });

  it('warns over 60 s for YouTube only when YouTube is selected', () => {
    const p = fakeProbe({ durationMs: 75_000 });
    const w = videoWarnings(p, [...ALL]).find((x) => x.code === 'over_60s');
    expect(w).toMatchObject({ platform: 'youtube', severity: 'warn' });
    expect(w?.message).toContain('1:15');
    expect(w?.message).toContain('copyright');
    expect(codes(p, ['instagram'])).not.toContain('over_60s');
  });

  it("says long or landscape clips won't be Shorts", () => {
    expect(codes(fakeProbe({ durationMs: 181_000 }))).toContain('yt_not_short_long');
    expect(codes(fakeProbe({ durationMs: 180_000 }))).not.toContain('yt_not_short_long');
    expect(codes(fakeProbe({ width: 1920, height: 1080 }))).toContain('yt_not_short_landscape');
    expect(codes(fakeProbe({ width: 1080, height: 1080 }))).not.toContain('yt_not_short_landscape');
  });

  it('explains when Facebook posts a normal Page video instead of a Reel', () => {
    const long = videoWarnings(fakeProbe({ durationMs: 130_000 }), ['facebook']);
    expect(long).toEqual([
      expect.objectContaining({ code: 'fb_reel_too_long', severity: 'info', platform: 'facebook' }),
    ]);
    expect(long[0]!.message).toContain('2:10');
    expect(long[0]!.message).toContain('normal Page video');
    expect(codes(fakeProbe({ width: 1080, height: 2400 }), ['facebook'])).toContain(
      'fb_reel_aspect',
    );
    expect(codes(fakeProbe({ width: 1920, height: 1080 }), ['facebook'])).not.toContain(
      'fb_reel_aspect',
    );
    expect(codes(fakeProbe({ width: 2400, height: 1000 }), ['facebook'])).toContain(
      'fb_reel_aspect',
    );
    expect(codes(fakeProbe({ width: 480, height: 854 }), ['facebook'])).toContain(
      'fb_reel_too_small',
    );
    expect(codes(fakeProbe({ fps: 120 }), ['facebook'])).toContain('fb_reel_fps');
    expect(codes(fakeProbe({ fps: 23.976 }), ['facebook'])).toContain('fb_reel_fps');
    expect(codes(fakeProbe({ fps: 59.94 }), ['facebook'])).not.toContain('fb_reel_fps');
  });

  it('blocks clips under 3 s on Instagram and Facebook', () => {
    const w = videoWarnings(fakeProbe({ durationMs: 2500 }), [...ALL]);
    expect(
      w
        .filter((x) => x.severity === 'block')
        .map((x) => x.code)
        .sort(),
    ).toEqual(['fb_too_short', 'ig_too_short']);
  });

  it('blocks Instagram over 15 minutes and warns over 300 MB', () => {
    expect(videoWarnings(fakeProbe({ durationMs: 16 * 60_000 }), ['instagram'])).toEqual([
      expect.objectContaining({ code: 'ig_too_long', severity: 'block' }),
    ]);
    expect(videoWarnings(fakeProbe({ sizeBytes: 301 * 1024 * 1024 }), ['instagram'])).toEqual([
      expect.objectContaining({ code: 'ig_too_large', severity: 'warn' }),
    ]);
  });

  it('notes missing audio and HDR regardless of platforms', () => {
    expect(videoWarnings(fakeProbe({ hasAudio: false, acodec: null }), [])).toEqual([
      expect.objectContaining({ code: 'no_audio', severity: 'info' }),
    ]);
    expect(codes(fakeProbe({ colorTransfer: 'smpte2084' }), [])).toEqual(['hdr_converted']);
    expect(codes(fakeProbe({ colorTransfer: 'arib-std-b67' }), [])).toEqual(['hdr_converted']);
  });

  it('formats durations', () => {
    expect(formatDuration(5000)).toBe('0:05');
    expect(formatDuration(130_000)).toBe('2:10');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
  });
});
