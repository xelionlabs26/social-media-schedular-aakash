import { promises as fs } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getEnv } from '../env';
import { detectScenes, frameSize, parseSceneOutput, planFrames } from './frames';
import { hasFfmpeg, makeFixtures, type Fixtures } from './test-fixtures';

describe('planFrames', () => {
  it('picks a hook frame + 7 uniform frames for a 60 s clip', () => {
    const plan = planFrames(60_000, []);
    expect(plan).toEqual([
      { tMs: 500, source: 'hook' },
      { tMs: 3000, source: 'uniform' },
      { tMs: 12000, source: 'uniform' },
      { tMs: 21000, source: 'uniform' },
      { tMs: 30000, source: 'uniform' },
      { tMs: 39000, source: 'uniform' },
      { tMs: 48000, source: 'uniform' },
      { tMs: 57000, source: 'uniform' },
    ]);
  });

  it('adds up to 4 of the strongest scene cuts, skipping ones near existing frames', () => {
    const plan = planFrames(60_000, [
      { tMs: 12_200, score: 0.99 }, // within 0.5 s of the 12 s uniform frame → dropped
      { tMs: 5_000, score: 0.5 },
      { tMs: 7_000, score: 0.6 },
      { tMs: 25_000, score: 0.7 },
      { tMs: 33_000, score: 0.8 },
      { tMs: 45_000, score: 0.4 }, // 5th strongest usable → dropped
    ]);
    const scenes = plan.filter((f) => f.source === 'scene').map((f) => f.tMs);
    expect(scenes).toEqual([5_000, 7_000, 25_000, 33_000]);
    expect(plan).toHaveLength(12);
    expect(plan.map((f) => f.tMs)).toEqual([...plan.map((f) => f.tMs)].sort((a, b) => a - b));
  });

  it('deduplicates on very short clips and stays inside the video', () => {
    const plan = planFrames(1000, [{ tMs: 1000, score: 1 }]);
    for (let i = 1; i < plan.length; i++) {
      expect(plan[i]!.tMs - plan[i - 1]!.tMs).toBeGreaterThanOrEqual(500);
    }
    expect(Math.max(...plan.map((f) => f.tMs))).toBeLessThan(1000);
    expect(planFrames(0, [])).toEqual([]);
  });

  it('sizes frames with a 1024 long edge, never upscaling', () => {
    expect(frameSize(1080, 1920)).toEqual({ width: 576, height: 1024 });
    expect(frameSize(1920, 1080)).toEqual({ width: 1024, height: 576 });
    expect(frameSize(2160, 3840)).toEqual({ width: 576, height: 1024 });
    expect(frameSize(720, 1280)).toEqual({ width: 576, height: 1024 });
    expect(frameSize(540, 960)).toEqual({ width: 540, height: 960 });
    expect(frameSize(1080, 1080)).toEqual({ width: 1024, height: 1024 });
  });

  it('parses metadata=print output', () => {
    expect(
      parseSceneOutput(
        'frame:0    pts:30720   pts_time:2\nlavfi.scene_score=0.400000\nframe:1    pts:61440   pts_time:4.5\nlavfi.scene_score=0.846779\n',
      ),
    ).toEqual([
      { tMs: 2000, score: 0.4 },
      { tMs: 4500, score: 0.846779 },
    ]);
  });
});

describe.skipIf(!hasFfmpeg())('detectScenes (ffmpeg)', () => {
  let fx: Fixtures;
  beforeAll(async () => {
    fx = await makeFixtures();
  }, 60_000);
  afterAll(async () => {
    if (fx) await fs.rm(fx.dir, { recursive: true, force: true });
  });

  it('finds the hard cuts', async () => {
    const cuts = await detectScenes(getEnv().FFMPEG_PATH, fx.scenes, 10_000);
    const times = cuts.map((c) => c.tMs);
    expect(times.some((t) => Math.abs(t - 2700) < 100)).toBe(true);
    expect(times.some((t) => Math.abs(t - 5700) < 100)).toBe(true);
  });
});
