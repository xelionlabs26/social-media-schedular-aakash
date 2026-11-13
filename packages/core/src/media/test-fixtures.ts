/**
 * Test-only helpers: generates small video fixtures with ffmpeg's lavfi sources, so no binary
 * media is committed. Not imported by production code.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProbeResult } from './types';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

export interface Fixtures {
  dir: string;
  /** 1080×1920, 5 s, 30 fps H.264 + 48 kHz AAC sine: qualifies for the fast path. */
  portrait: string;
  /** 1920×1080, 4 s, with audio. */
  landscape: string;
  /** 720×1280, 4 s, no audio track. */
  silent: string;
  /** 720×1280, 2 s, 10-bit H.264 tagged as HLG HDR. */
  hdr10bit: string;
  /** 360×640, variable frame rate. */
  vfr: string;
  /** Landscape pixels with a 90° display matrix → shows as 1080×1920 portrait. */
  rotated: string;
  /** Hard cuts at 2.7 s and 5.7 s (red → blue → testsrc), 10 s, 540×960. */
  scenes: string;
  /** Random bytes named .mp4. */
  garbage: string;
}

function ff(args: string[]): void {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

const h264Fast = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p'];
const aac = ['-c:a', 'aac', '-b:a', '96k', '-shortest'];

export async function makeFixtures(): Promise<Fixtures> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-fixtures-'));
  const p = (name: string) => path.join(dir, name);
  const f: Fixtures = {
    dir,
    portrait: p('portrait.mp4'),
    landscape: p('landscape.mp4'),
    silent: p('silent.mp4'),
    hdr10bit: p('hdr.mp4'),
    vfr: p('vfr.mp4'),
    rotated: p('rotated.mp4'),
    scenes: p('scenes.mp4'),
    garbage: p('garbage.mp4'),
  };
  const sine = (d: number) => ['-f', 'lavfi', '-i', `sine=f=440:d=${d}:sample_rate=48000`];

  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=1080x1920:r=30:d=5',
    ...sine(5),
    ...h264Fast,
    ...aac,
    f.portrait,
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=1920x1080:r=30:d=4',
    ...sine(4),
    ...h264Fast,
    ...aac,
    f.landscape,
  ]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=720x1280:r=30:d=4', ...h264Fast, f.silent]);
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=720x1280:r=30:d=2',
    ...sine(2),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p10le',
    '-color_trc',
    'arib-std-b67',
    '-color_primaries',
    'bt2020',
    '-colorspace',
    'bt2020nc',
    // Some ffmpeg builds only write colour tags into H.264 through the encoder's VUI fields.
    '-x264-params',
    'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc',
    ...aac,
    f.hdr10bit,
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=360x640:r=30:d=4',
    '-vf',
    "select='lt(n,30)+not(mod(n,4))'",
    '-fps_mode',
    'vfr',
    ...h264Fast,
    f.vfr,
  ]);
  // Encode 1920×1080 pixels, then mark them as rotated 90° (like a phone held upright).
  const landscapeTmp = p('rot-src.mp4');
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=1920x1080:r=30:d=3',
    ...sine(3),
    ...h264Fast,
    ...aac,
    landscapeTmp,
  ]);
  ff(['-display_rotation', '90', '-i', landscapeTmp, '-c', 'copy', f.rotated]);
  ff([
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=540x960:r=30:d=2.7',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=540x960:r=30:d=3',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=540x960:r=30:d=4.3',
    ...sine(10),
    '-filter_complex',
    '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    '-map',
    '[v]',
    '-map',
    '3:a',
    ...h264Fast,
    ...aac,
    f.scenes,
  ]);
  await fs.writeFile(
    f.garbage,
    Buffer.from(Array.from({ length: 64 * 1024 }, (_, i) => (i * 7919) % 251)),
  );
  return f;
}

export function hasFfmpeg(): boolean {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A typical compliant 58 s vertical phone clip; override fields per test. */
export function fakeProbe(over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    durationMs: 58_000,
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
    colorTransfer: 'bt709',
    bitrate: 8_000_000,
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    sizeBytes: 40 * 1024 * 1024,
    ...over,
  };
}
