import { promises as fs } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getEnv } from '../env';
import { InvalidVideoError, bitDepthOf, parseProbe, parseRate } from './probe';
import { probeVideo } from './index';
import { hasFfmpeg, makeFixtures, type Fixtures } from './test-fixtures';

const env = getEnv();

describe('parseProbe (pure)', () => {
  const base = {
    streams: [
      {
        codec_type: 'video',
        codec_name: 'hevc',
        width: 1920,
        height: 1080,
        pix_fmt: 'yuv420p10le',
        field_order: 'progressive',
        r_frame_rate: '30/1',
        avg_frame_rate: '2997/100',
        color_transfer: 'arib-std-b67',
        color_primaries: 'bt2020',
        color_space: 'bt2020nc',
        bit_rate: '9000000',
        side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }],
      },
      { codec_type: 'audio', codec_name: 'aac', sample_rate: '44100', channels: 2 },
    ],
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '59.533', bit_rate: '9100000' },
  };

  it('normalizes an iPhone-style HDR portrait clip', () => {
    const p = parseProbe(base, 1234);
    expect(p).toMatchObject({
      durationMs: 59533,
      width: 1080,
      height: 1920,
      rotation: 90,
      vcodec: 'hevc',
      bitDepth: 10,
      interlaced: false,
      acodec: 'aac',
      audioSampleRate: 44100,
      hasAudio: true,
      colorTransfer: 'arib-std-b67',
      bitrate: 9_000_000,
      sizeBytes: 1234,
    });
    expect(p.fps).toBeCloseTo(29.97, 2);
    // 30 vs 29.97 is 0.1%: not variable.
    expect(p.isVfr).toBe(false);
  });

  it('detects VFR, interlacing, the legacy rotate tag and missing audio', () => {
    const p = parseProbe(
      {
        streams: [
          {
            codec_type: 'video',
            codec_name: 'h264',
            width: 1920,
            height: 1080,
            pix_fmt: 'yuv420p',
            field_order: 'tt',
            r_frame_rate: '60/1',
            avg_frame_rate: '30/1',
            tags: { rotate: '270' },
          },
        ],
        format: { duration: '10', bit_rate: '5000000' },
      },
      10,
    );
    expect(p.isVfr).toBe(true);
    expect(p.interlaced).toBe(true);
    expect(p.rotation).toBe(270);
    expect([p.width, p.height]).toEqual([1080, 1920]);
    expect(p.hasAudio).toBe(false);
    expect(p.bitrate).toBe(5_000_000); // falls back to the container bitrate
  });

  it('rejects files without a video stream, cover art and pictures', () => {
    expect(() => parseProbe({ streams: [{ codec_type: 'audio' }], format: {} }, 1)).toThrow(
      InvalidVideoError,
    );
    expect(() =>
      parseProbe(
        {
          streams: [
            { codec_type: 'audio', codec_name: 'mp3' },
            {
              codec_type: 'video',
              codec_name: 'mjpeg',
              width: 500,
              height: 500,
              disposition: { attached_pic: 1 },
            },
          ],
          format: { format_name: 'mp3' },
        },
        1,
      ),
    ).toThrow('Not a valid video file');
    expect(() =>
      parseProbe(
        {
          streams: [{ codec_type: 'video', codec_name: 'png', width: 10, height: 10 }],
          format: { format_name: 'png_pipe' },
        },
        1,
      ),
    ).toThrow('picture');
  });

  it('parses rates and bit depths', () => {
    expect(parseRate('30000/1001')).toBeCloseTo(29.97, 2);
    expect(parseRate('0/0')).toBeNull();
    expect(parseRate(undefined)).toBeNull();
    expect(bitDepthOf('yuv420p')).toBe(8);
    expect(bitDepthOf('yuv420p10le')).toBe(10);
    expect(bitDepthOf('yuv422p12be')).toBe(12);
    expect(bitDepthOf('p010le')).toBe(10);
    expect(bitDepthOf('nv12')).toBe(8);
  });
});

describe.skipIf(!hasFfmpeg())('probeVideo (ffprobe)', () => {
  let fx: Fixtures;
  beforeAll(async () => {
    fx = await makeFixtures();
  }, 60_000);
  afterAll(async () => {
    if (fx) await fs.rm(fx.dir, { recursive: true, force: true });
  });

  it('probes a portrait H.264 + AAC clip', async () => {
    const p = await probeVideo(fx.portrait, { env });
    expect(p).toMatchObject({
      width: 1080,
      height: 1920,
      rotation: 0,
      fps: 30,
      isVfr: false,
      vcodec: 'h264',
      pixFmt: 'yuv420p',
      bitDepth: 8,
      interlaced: false,
      acodec: 'aac',
      audioSampleRate: 48000,
      hasAudio: true,
    });
    expect(p.durationMs).toBeGreaterThan(4900);
    expect(p.durationMs).toBeLessThan(5200);
    expect(p.sizeBytes).toBe((await fs.stat(fx.portrait)).size);
    expect(p.bitrate).toBeGreaterThan(0);
  });

  it('reads silent, 10-bit HDR, VFR and rotated clips', async () => {
    expect((await probeVideo(fx.silent, { env })).hasAudio).toBe(false);
    const hdr = await probeVideo(fx.hdr10bit, { env });
    expect(hdr).toMatchObject({ bitDepth: 10, colorTransfer: 'arib-std-b67' });
    expect((await probeVideo(fx.vfr, { env })).isVfr).toBe(true);
    const rot = await probeVideo(fx.rotated, { env });
    expect(rot).toMatchObject({ width: 1080, height: 1920 });
    expect([90, 270]).toContain(rot.rotation);
  });

  it('rejects garbage', async () => {
    await expect(probeVideo(fx.garbage, { env })).rejects.toThrow(InvalidVideoError);
  });
});
