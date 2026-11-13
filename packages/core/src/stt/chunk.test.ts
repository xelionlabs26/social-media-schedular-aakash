import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chunkAudio,
  parseSilences,
  planSegments,
  uploadFilename,
  type FfmpegConfig,
} from './chunk';
import { FFMPEG, FFPROBE, makeAudio, makeTempDir, probeSeconds } from './test-helpers';

describe('planSegments', () => {
  it('keeps short audio whole', () => {
    expect(planSegments(20_000, 29_000)).toEqual([{ startMs: 0, durationMs: 20_000 }]);
  });

  it('splits evenly into the minimum number of chunks', () => {
    const segs = planSegments(70_000, 29_000);
    expect(segs).toHaveLength(3);
    expect(segs.every((s) => s.durationMs <= 29_000)).toBe(true);
    expect(segs.reduce((sum, s) => sum + s.durationMs, 0)).toBe(70_000);
    expect(segs[0]!.durationMs).toBeCloseTo(23_333, -1);
  });

  it('moves a cut into a nearby pause without adding chunks', () => {
    const segs = planSegments(40_000, 29_000, [{ startMs: 22_000, endMs: 23_000 }]);
    expect(segs).toEqual([
      { startMs: 0, durationMs: 22_500 },
      { startMs: 22_500, durationMs: 17_500 },
    ]);
  });

  it('ignores pauses that would force an extra chunk or exceed the cap', () => {
    // 58 s / 29 s: the only cut that keeps 2 chunks is exactly 29 s.
    const segs = planSegments(58_000, 29_000, [
      { startMs: 14_000, endMs: 16_000 },
      { startMs: 30_000, endMs: 31_000 },
    ]);
    expect(segs.map((s) => s.durationMs)).toEqual([29_000, 29_000]);
  });
});

describe('parseSilences', () => {
  it('pairs silence_start/silence_end and closes a trailing silence', () => {
    const stderr = [
      '[silencedetect @ 0x1] silence_start: 20.0012',
      '[silencedetect @ 0x1] silence_end: 21.004 | silence_duration: 1.0028',
      'size=N/A time=00:00:40.00',
      '[silencedetect @ 0x1] silence_start: 38.5',
    ].join('\n');
    expect(parseSilences(stderr, 40_000)).toEqual([
      { startMs: 20_001.2, endMs: 21_004 },
      { startMs: 38_500, endMs: 40_000 },
    ]);
  });
});

describe('uploadFilename', () => {
  it('adds an extension that matches the mime type when missing', () => {
    expect(uploadFilename('/tmp/work/audio', 'audio/mp4')).toBe('audio.m4a');
    expect(uploadFilename('/tmp/work/a.mp3', 'audio/mpeg')).toBe('a.mp3');
  });
});

describe('chunkAudio (ffmpeg)', () => {
  const tmp = makeTempDir('stt-chunk-');
  const config: FfmpegConfig = {
    ffmpegPath: FFMPEG,
    ffprobePath: FFPROBE,
    workDir: path.join(tmp.dir, 'work'),
  };
  let tone70: string;
  let tone10: string;
  let gapped: string;

  beforeAll(() => {
    tone70 = makeAudio(path.join(tmp.dir, 'tone70.m4a'), 70);
    tone10 = makeAudio(path.join(tmp.dir, 'tone10.mp3'), 10, { codec: 'libmp3lame' });
    // 40 s of tone with a 1 s pause at 22–23 s.
    gapped = makeAudio(path.join(tmp.dir, 'gapped.m4a'), 40, {
      expr: 'if(between(t\\,22\\,23)\\,0\\,0.5*sin(2*PI*440*t))',
    });
  });
  afterAll(() => tmp.remove());

  it('splits a 70 s clip into 3 chunks of ≤29 s for Sarvam and cleans up', async () => {
    const out = await chunkAudio(
      { filePath: tone70, mimeType: 'audio/mp4', durationMs: 70_000 },
      { maxSeconds: 29 },
      config,
    );
    expect(out.chunks).toHaveLength(3);
    let total = 0;
    for (const chunk of out.chunks) {
      expect(chunk.path).not.toBe(tone70);
      expect(chunk.mimeType).toBe('audio/mp4');
      const seconds = probeSeconds(chunk.path);
      expect(seconds).toBeLessThanOrEqual(29.5);
      total += seconds;
    }
    expect(total).toBeGreaterThan(69);
    expect(total).toBeLessThan(71.5);
    const dir = path.dirname(out.chunks[0]!.path);
    await out.cleanup();
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(tone70)).toBe(true);
  });

  it('probes the duration when the caller does not know it', async () => {
    const out = await chunkAudio(
      { filePath: tone70, mimeType: 'audio/mp4', durationMs: 0 },
      { maxSeconds: 29 },
      config,
    );
    expect(out.chunks).toHaveLength(3);
    await out.cleanup();
  });

  it('returns the original file when it is within the limits', async () => {
    const out = await chunkAudio(
      { filePath: tone10, mimeType: 'audio/mpeg', durationMs: 10_000 },
      { maxSeconds: 29, maxBytes: 25 * 1024 * 1024 },
      config,
    );
    expect(out.chunks).toEqual([
      { path: tone10, mimeType: 'audio/mpeg', startMs: 0, durationMs: 10_000 },
    ]);
    await out.cleanup();
    expect(existsSync(tone10)).toBe(true);
  });

  it('splits by size when the file is over the byte cap', async () => {
    const out = await chunkAudio(
      { filePath: tone10, mimeType: 'audio/mpeg', durationMs: 10_000 },
      { maxBytes: 20_000 },
      config,
    );
    expect(out.chunks.length).toBeGreaterThan(1);
    expect(out.chunks[0]!.path.endsWith('.mp3')).toBe(true);
    await out.cleanup();
  });

  it('cuts inside a pause when one is close to the even split', async () => {
    const out = await chunkAudio(
      { filePath: gapped, mimeType: 'audio/mp4', durationMs: 40_000 },
      { maxSeconds: 29 },
      config,
    );
    expect(out.chunks).toHaveLength(2);
    expect(out.chunks[1]!.startMs).toBeGreaterThan(22_000);
    expect(out.chunks[1]!.startMs).toBeLessThan(23_000);
    await out.cleanup();
  });

  it('removes its scratch directory when ffmpeg fails', async () => {
    const before = existsSync(config.workDir) ? readdirSync(config.workDir).length : 0;
    await expect(
      chunkAudio(
        { filePath: tone70, mimeType: 'audio/mp4', durationMs: 70_000 },
        { maxSeconds: 29 },
        { ...config, ffmpegPath: '/nonexistent/ffmpeg' },
      ),
    ).rejects.toMatchObject({ name: 'SttError', category: 'fatal' });
    const after = existsSync(config.workDir) ? readdirSync(config.workDir).length : 0;
    expect(after).toBe(before);
  });
});
