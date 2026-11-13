/**
 * Test-only helpers (imported by *.test.ts in this folder; not exported from the module).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { getEnv, type Env } from '../env';

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

export function makeTempDir(prefix = 'stt-test-'): { dir: string; remove: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Generates mono 16 kHz audio with lavfi. `expr` is an aevalsrc expression, so tests can put
 * silent gaps at known places; the default is a 440 Hz tone.
 */
export function makeAudio(
  file: string,
  seconds: number,
  opts: { expr?: string; codec?: 'aac' | 'libmp3lame' | 'flac' } = {},
): string {
  const expr = opts.expr ?? 'sin(2*PI*440*t)';
  const codec = opts.codec ?? 'aac';
  execFileSync(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `aevalsrc=${expr}:s=16000:d=${seconds}`,
      '-ac',
      '1',
      '-c:a',
      codec,
      ...(codec === 'flac' ? [] : ['-b:a', '32k']),
      file,
    ],
    { stdio: 'pipe' },
  );
  return file;
}

export function probeSeconds(file: string): number {
  const out = execFileSync(
    FFPROBE,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
    { encoding: 'utf8' },
  );
  return Number(out.trim());
}

export function testEnv(overrides: Record<string, string | undefined> = {}): Env {
  return getEnv({
    NODE_ENV: 'test',
    FFMPEG_PATH: FFMPEG,
    FFPROBE_PATH: FFPROBE,
    WORK_DIR: path.join(os.tmpdir(), 'stt-work'),
    ...overrides,
  });
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: RequestInit['body'];
}

/** A fetch mock that records each request and answers from a queue of responses. */
export function fakeFetch(responses: Array<Response | (() => Response) | Error>) {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: init.body,
    });
    const next = queue.shift();
    if (!next) throw new Error('fakeFetch: no response queued');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export const noSleep = async () => {};
