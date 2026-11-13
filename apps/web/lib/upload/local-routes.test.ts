import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@app/core/env';
import { LocalStorage, keys } from '@app/core/storage';
import { contentTypeForKey, parseContentRange, parseLength, parseRangeHeader } from './http';
import { handleLocalFile, handleLocalUpload } from './local-routes';

const APP_URL = 'http://localhost:3101';
let dir: string;
let storage: LocalStorage;
const deps = () => ({ driver: 'local' as const, storage });

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'ui-upload-routes-'));
  storage = new LocalStorage(dir, APP_URL);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * seed) % 251);

function put(url: string, body: Uint8Array<ArrayBuffer> | null, headers: Record<string, string>) {
  return new Request(url, { method: 'PUT', body, headers });
}

async function signedPut(key: string, contentType = 'video/mp4') {
  return (await storage.createUploadTarget(key, contentType)).url;
}

describe('Range / Content-Range parsing', () => {
  it('parses single byte ranges', () => {
    expect(parseRangeHeader(null, 100)).toEqual({ kind: 'full' });
    expect(parseRangeHeader('bytes=0-9', 100)).toEqual({ kind: 'partial', start: 0, end: 9 });
    expect(parseRangeHeader('bytes=90-', 100)).toEqual({ kind: 'partial', start: 90, end: 99 });
    expect(parseRangeHeader('bytes=-10', 100)).toEqual({ kind: 'partial', start: 90, end: 99 });
    expect(parseRangeHeader('bytes=-500', 100)).toEqual({ kind: 'partial', start: 0, end: 99 });
    expect(parseRangeHeader('bytes=50-5000', 100)).toEqual({ kind: 'partial', start: 50, end: 99 });
  });

  it('rejects unsatisfiable ranges and ignores the rest', () => {
    expect(parseRangeHeader('bytes=100-', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=-0', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=0-1,5-6', 100)).toEqual({ kind: 'full' });
    expect(parseRangeHeader('items=0-1', 100)).toEqual({ kind: 'full' });
    expect(parseRangeHeader('bytes=9-2', 100)).toEqual({ kind: 'full' });
  });

  it('parses Content-Range for chunks and status queries', () => {
    expect(parseContentRange('bytes 0-9/100')).toEqual({
      kind: 'chunk',
      start: 0,
      end: 9,
      total: 100,
    });
    expect(parseContentRange('bytes */100')).toEqual({ kind: 'query', total: 100 });
    expect(parseContentRange('bytes 9-0/100')).toBeNull();
    expect(parseContentRange('bytes 0-100/100')).toBeNull();
    expect(parseContentRange('bytes */0')).toBeNull();
    expect(parseContentRange(null)).toBeNull();
    expect(parseLength(' 42 ')).toBe(42);
    expect(parseLength('-1')).toBeNull();
  });

  it('maps extensions to content types', () => {
    expect(contentTypeForKey('media/x/master.mp4')).toBe('video/mp4');
    expect(contentTypeForKey('uploads/x/original.mov')).toBe('video/quicktime');
    expect(contentTypeForKey('frames/x/00.jpg')).toBe('image/jpeg');
    expect(contentTypeForKey('weird/file')).toBe('application/octet-stream');
  });
});

describe('PUT /api/uploads/local', () => {
  it('stores a whole-file upload with a valid signature', async () => {
    const key = keys.original('11111111-1111-4111-8111-111111111111', 'mp4');
    const body = bytes(1000);
    const res = await handleLocalUpload(
      put(await signedPut(key), body, { 'Content-Type': 'video/mp4', 'Content-Length': '1000' }),
      deps(),
    );
    expect(res.status).toBe(201);
    expect(await storage.head(key)).toEqual({ size: 1000 });
    expect(new Uint8Array(await readFile(storage.pathFor(key)))).toEqual(body);
  });

  it('rejects bad, expired or foreign signatures with 403', async () => {
    const key = 'uploads/a/original.mp4';
    const url = new URL(await signedPut(key));
    const headers = { 'Content-Type': 'video/mp4', 'Content-Length': '3' };

    const tampered = new URL(url);
    tampered.searchParams.set('key', 'uploads/b/original.mp4');
    expect((await handleLocalUpload(put(tampered.href, bytes(3), headers), deps())).status).toBe(
      403,
    );

    const later = Date.now() + 16 * 60_000;
    expect(
      (await handleLocalUpload(put(url.href, bytes(3), headers), { ...deps(), now: () => later }))
        .status,
    ).toBe(403);

    const noSig = new URL(url);
    noSig.searchParams.delete('sig');
    expect((await handleLocalUpload(put(noSig.href, bytes(3), headers), deps())).status).toBe(403);

    // A read URL can't be used to upload.
    const readUrl = await storage.getReadUrl(key);
    expect((await handleLocalUpload(put(readUrl, bytes(3), headers), deps())).status).toBe(403);

    // Only with the local driver.
    expect(
      (await handleLocalUpload(put(url.href, bytes(3), headers), { driver: 's3', storage })).status,
    ).toBe(403);
    expect(await storage.head(key)).toBeNull();
  });

  it('requires the signed Content-Type and a Content-Length within the limit', async () => {
    const key = 'uploads/c/original.mp4';
    const url = await signedPut(key);
    const wrongType = await handleLocalUpload(
      put(url, bytes(3), { 'Content-Type': 'video/quicktime', 'Content-Length': '3' }),
      deps(),
    );
    expect(wrongType.status).toBe(415);
    const noLength = await handleLocalUpload(
      put(url, bytes(3), { 'Content-Type': 'video/mp4' }),
      deps(),
    );
    expect(noLength.status).toBe(411);
    const tooBig = await handleLocalUpload(
      put(url, bytes(3), { 'Content-Type': 'video/mp4', 'Content-Length': '3' }),
      { ...deps(), maxBytes: 2 },
    );
    expect(tooBig.status).toBe(413);
    expect(await storage.head(key)).toBeNull();
  });

  it('refuses bodies that are shorter or longer than announced', async () => {
    const key = 'uploads/d/original.mp4';
    const url = await signedPut(key);
    const short = await handleLocalUpload(
      put(url, bytes(10), { 'Content-Type': 'video/mp4', 'Content-Length': '20' }),
      deps(),
    );
    expect(short.status).toBe(400);
    expect(((await short.json()) as { error: string }).error).toMatch(/incomplete/i);
    const long = await handleLocalUpload(
      put(url, bytes(30), { 'Content-Type': 'video/mp4', 'Content-Length': '20' }),
      deps(),
    );
    expect(long.status).toBe(400);
    expect(await storage.head(key)).toBeNull();
  });

  it('assembles chunked uploads, resumes, and refuses gaps', async () => {
    const key = 'uploads/e/original.mov';
    const url = await signedPut(key, 'video/quicktime');
    const data = bytes(25, 7);
    const h = (range: string, length: number) => ({
      'Content-Type': 'video/quicktime',
      'Content-Range': range,
      'Content-Length': String(length),
    });
    const send = (start: number, end: number) =>
      handleLocalUpload(
        put(url, data.slice(start, end + 1), h(`bytes ${start}-${end}/25`, end - start + 1)),
        {
          ...deps(),
          maxChunkBytes: 10,
        },
      );
    const query = async () =>
      (await (await handleLocalUpload(put(url, null, h('bytes */25', 0)), deps())).json()) as {
        offset: number;
        complete?: boolean;
      };

    expect(await query()).toEqual({ offset: 0 });
    expect((await send(0, 9)).status).toBe(200);
    expect(await query()).toEqual({ offset: 10 });

    // A gap is refused with the offset to continue from.
    const gap = await send(15, 19);
    expect(gap.status).toBe(409);
    expect(await gap.json()).toMatchObject({ offset: 10 });

    // A chunk over the per-request limit is refused.
    expect((await send(10, 24)).status).toBe(413);

    // Retrying an earlier chunk replaces it (idempotent).
    expect((await send(0, 9)).status).toBe(200);
    expect((await send(10, 19)).status).toBe(200);
    const last = await send(20, 24);
    expect(last.status).toBe(201);
    expect(await last.json()).toEqual({ offset: 25, complete: true });
    expect(await query()).toEqual({ offset: 25, complete: true });
    expect(new Uint8Array(await readFile(storage.pathFor(key)))).toEqual(data);
    await expect(stat(`${storage.pathFor(key)}.partial`)).rejects.toThrow();
  });
});

describe('GET /api/files', () => {
  const key = 'media/f/master.mp4';
  const data = bytes(100, 3);
  beforeAll(async () => {
    await mkdir(path.dirname(storage.pathFor(key)), { recursive: true });
    await writeFile(storage.pathFor(key), data);
  });
  const get = (url: string, headers: Record<string, string> = {}) =>
    new Request(url, { method: 'GET', headers });

  it('streams the whole file with a content type for <video>', async () => {
    const res = await handleLocalFile(get(await storage.getReadUrl(key)), deps());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe('100');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(data);
  });

  it('serves byte ranges with 206 and 416', async () => {
    const url = await storage.getReadUrl(key);
    const res = await handleLocalFile(get(url, { Range: 'bytes=10-19' }), deps());
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 10-19/100');
    expect(res.headers.get('content-length')).toBe('10');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(data.slice(10, 20));

    const tail = await handleLocalFile(get(url, { Range: 'bytes=-5' }), deps());
    expect(tail.status).toBe(206);
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(data.slice(95));

    const bad = await handleLocalFile(get(url, { Range: 'bytes=200-' }), deps());
    expect(bad.status).toBe(416);
    expect(bad.headers.get('content-range')).toBe('bytes */100');
  });

  it('answers HEAD without a body', async () => {
    const res = await handleLocalFile(get(await storage.getReadUrl(key)), deps(), { head: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('100');
    expect(res.body).toBeNull();
  });

  it('rejects bad signatures with 403 and missing files with 404', async () => {
    const url = new URL(await storage.getReadUrl(key));
    url.searchParams.set('sig', 'x'.repeat(43));
    expect((await handleLocalFile(get(url.href), deps())).status).toBe(403);
    // An upload URL can't be used to read.
    expect((await handleLocalFile(get(await signedPut(key)), deps())).status).toBe(403);
    expect(
      (await handleLocalFile(get(await storage.getReadUrl('media/none/master.mp4')), deps()))
        .status,
    ).toBe(404);
    expect(
      (await handleLocalFile(get(await storage.getReadUrl(key)), { driver: 's3', storage })).status,
    ).toBe(403);
  });
});

describe('route modules', () => {
  it('wire the handlers to env + storage', async () => {
    const routeDir = await mkdtemp(path.join(os.tmpdir(), 'ui-upload-route-mod-'));
    const prev = { ...process.env };
    process.env.STORAGE_DRIVER = 'local';
    process.env.STORAGE_DIR = routeDir;
    process.env.APP_URL = APP_URL;
    resetEnvCache();
    try {
      const { PUT } = await import('@/app/api/uploads/local/route');
      const { GET, HEAD } = await import('@/app/api/files/route');
      const local = new LocalStorage(routeDir, APP_URL);
      const key = 'uploads/route/original.mp4';
      const up = await PUT(
        put((await local.createUploadTarget(key, 'video/mp4')).url, bytes(5), {
          'Content-Type': 'video/mp4',
          'Content-Length': '5',
        }),
      );
      expect(up.status).toBe(201);
      const readUrl = await local.getReadUrl(key);
      const down = await GET(new Request(readUrl, { headers: { Range: 'bytes=1-2' } }));
      expect(down.status).toBe(206);
      expect(new Uint8Array(await down.arrayBuffer())).toEqual(bytes(5).slice(1, 3));
      expect((await HEAD(new Request(readUrl, { method: 'HEAD' }))).status).toBe(200);
    } finally {
      process.env = prev;
      resetEnvCache();
      await rm(routeDir, { recursive: true, force: true });
    }
  });
});
