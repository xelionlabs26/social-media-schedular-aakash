/**
 * Request handlers behind the local storage driver's signed URLs:
 *   PUT /api/uploads/local  (browser upload)
 *   GET /api/files          (video playback, thumbnails, and files fetched by the worker)
 *
 * Both routes are public in proxy.ts: the HMAC signature in the query string (core/storage
 * `verifyLocalSignature`) is the authorization. They only work with STORAGE_DRIVER=local;
 * with S3/R2 the browser talks to the bucket directly.
 *
 * Server-only. The route files are thin wrappers so these can be tested with plain Requests.
 */
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  LocalStorage,
  verifyLocalSignature,
  webToNodeStream,
  type Storage,
} from '@app/core/storage';
import { LOCAL_MAX_CHUNK_BYTES, MAX_FILE_BYTES } from './constants';
import {
  contentTypeForKey,
  parseContentRange,
  parseLength,
  parseRangeHeader,
  type ContentRange,
} from './http';

export interface LocalRouteDeps {
  driver: 'local' | 's3';
  storage: Storage;
  now?: () => number;
  maxBytes?: number;
  maxChunkBytes?: number;
}

const NO_STORE = { 'Cache-Control': 'no-store' };

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

const forbidden = () => json(403, { error: 'Forbidden' });

interface SignedParams {
  key: string;
  exp: number;
  sig: string;
  ct: string;
}

function signedParams(request: Request): SignedParams {
  const q = new URL(request.url).searchParams;
  return {
    key: q.get('key') ?? '',
    exp: Number(q.get('exp')),
    sig: q.get('sig') ?? '',
    ct: q.get('ct') ?? '',
  };
}

function signatureOk(op: 'put' | 'get', p: SignedParams, now: number): boolean {
  if (!p.key || !p.sig) return false;
  try {
    return verifyLocalSignature(op, p.key, p.exp, p.sig, p.ct, now);
  } catch {
    // AUTH_SECRET missing or malformed input: treat as not authorized.
    return false;
  }
}

class BodyTooLongError extends Error {}

/** Passes the request body through while counting; fails once it exceeds `max` bytes. */
async function* limitedBody(body: Readable, max: number): AsyncGenerator<Buffer> {
  let total = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > max) throw new BodyTooLongError('Body is longer than Content-Length');
    yield buf;
  }
}

async function fileSize(p: string): Promise<number | null> {
  try {
    const st = await fs.stat(p);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/** Serializes chunk writes per key within this process (a retry may overlap a slow request). */
const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  locks.set(key, run);
  try {
    return await run;
  } finally {
    if (locks.get(key) === run) locks.delete(key);
  }
}

// ---------------------------------------------------------------------------------------------
// PUT /api/uploads/local
// ---------------------------------------------------------------------------------------------

export async function handleLocalUpload(request: Request, deps: LocalRouteDeps): Promise<Response> {
  const { storage } = deps;
  if (deps.driver !== 'local' || !(storage instanceof LocalStorage)) return forbidden();
  const now = deps.now?.() ?? Date.now();
  const params = signedParams(request);
  if (!params.ct || !signatureOk('put', params, now)) return forbidden();

  // The signature covers the content type, so the stored file can't be relabeled.
  const contentType = (request.headers.get('content-type') ?? '').trim();
  if (contentType !== params.ct) {
    return json(415, { error: `Content-Type must be ${params.ct}` });
  }

  const maxBytes = deps.maxBytes ?? MAX_FILE_BYTES;
  const rangeHeader = request.headers.get('content-range');
  if (rangeHeader !== null) {
    const range = parseContentRange(rangeHeader);
    if (!range) return json(400, { error: 'Malformed Content-Range' });
    if (range.total > maxBytes) return json(413, { error: 'File is too large' });
    return withLock(params.key, () =>
      handleChunk(request, storage, params.key, range, deps.maxChunkBytes ?? LOCAL_MAX_CHUNK_BYTES),
    );
  }

  // Whole file in one request.
  const length = parseLength(request.headers.get('content-length'));
  if (length === null) return json(411, { error: 'Content-Length is required' });
  if (length > maxBytes) return json(413, { error: 'File is too large' });
  if (length === 0 || !request.body) return json(400, { error: 'Empty upload' });

  try {
    const source = Readable.from(limitedBody(webToNodeStream(request.body), length));
    const written = await storage.writeStream(params.key, source);
    if (written !== length) {
      // Fewer bytes than announced: the client went away or something cut the body short.
      await storage.delete(params.key);
      return json(400, { error: `Upload incomplete (${written} of ${length} bytes)` });
    }
  } catch (err) {
    if (err instanceof BodyTooLongError) return json(400, { error: err.message });
    return json(400, { error: 'Upload interrupted' });
  }
  return json(201, { offset: length, complete: true });
}

async function handleChunk(
  request: Request,
  storage: LocalStorage,
  key: string,
  range: ContentRange,
  maxChunkBytes: number,
): Promise<Response> {
  const finalPath = storage.pathFor(key);
  const partPath = `${finalPath}.partial`;

  if (range.kind === 'query') {
    if ((await fileSize(finalPath)) === range.total && (await fileSize(partPath)) === null) {
      return json(200, { offset: range.total, complete: true });
    }
    const have = (await fileSize(partPath)) ?? 0;
    return json(200, { offset: Math.min(have, range.total) });
  }

  const expected = range.end - range.start + 1;
  const length = parseLength(request.headers.get('content-length'));
  if (length === null) return json(411, { error: 'Content-Length is required' });
  if (length !== expected) {
    return json(400, { error: 'Content-Length does not match Content-Range' });
  }
  if (expected > maxChunkBytes) return json(413, { error: 'Chunk is too large' });
  if (!request.body) return json(400, { error: 'Empty chunk' });

  await fs.mkdir(path.dirname(partPath), { recursive: true });
  const have = (await fileSize(partPath)) ?? 0;
  if (range.start > have) {
    // A gap would corrupt the file; tell the client where to continue.
    return json(409, { error: 'Chunk out of order', offset: have });
  }
  // A retried chunk replaces whatever an earlier, interrupted try left behind.
  if (range.start < have) await fs.truncate(partPath, range.start);

  try {
    await pipeline(
      Readable.from(limitedBody(webToNodeStream(request.body), expected)),
      createWriteStream(partPath, { flags: 'a' }),
    );
  } catch (err) {
    await fs.truncate(partPath, range.start).catch(() => undefined);
    if (err instanceof BodyTooLongError) return json(400, { error: err.message });
    return json(400, { error: 'Upload interrupted' });
  }

  const size = (await fileSize(partPath)) ?? 0;
  if (size !== range.end + 1) {
    await fs.truncate(partPath, range.start).catch(() => undefined);
    return json(400, { error: 'Chunk incomplete', offset: range.start });
  }
  if (size === range.total) {
    await fs.rename(partPath, finalPath);
    return json(201, { offset: size, complete: true });
  }
  return json(200, { offset: size });
}

// ---------------------------------------------------------------------------------------------
// GET / HEAD /api/files
// ---------------------------------------------------------------------------------------------

export async function handleLocalFile(
  request: Request,
  deps: LocalRouteDeps,
  opts: { head?: boolean } = {},
): Promise<Response> {
  const { storage } = deps;
  if (deps.driver !== 'local' || !(storage instanceof LocalStorage)) return forbidden();
  const now = deps.now?.() ?? Date.now();
  const params = signedParams(request);
  // Read URLs are signed without a content type.
  if (!signatureOk('get', { ...params, ct: '' }, now)) return forbidden();

  const info = await storage.head(params.key);
  if (!info) return json(404, { error: 'Not found' });

  const maxAge = Math.max(0, Math.min(3600, params.exp - Math.floor(now / 1000)));
  const headers: Record<string, string> = {
    'Content-Type': contentTypeForKey(params.key),
    'Accept-Ranges': 'bytes',
    'Cache-Control': `private, max-age=${maxAge}`,
    'Content-Disposition': 'inline',
  };

  const range = parseRangeHeader(request.headers.get('range'), info.size);
  if (range.kind === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${info.size}` },
    });
  }

  const partial = range.kind === 'partial';
  const start = partial ? range.start : 0;
  const end = partial ? range.end : info.size - 1;
  const length = info.size === 0 ? 0 : end - start + 1;
  headers['Content-Length'] = String(length);
  if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  const status = partial ? 206 : 200;

  if (opts.head || length === 0) return new Response(null, { status, headers });
  const stream = await storage.openReadStream(params.key, { start, end });
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
    status,
    headers,
  });
}
