/**
 * File storage for videos, frames and covers.
 *
 * Two drivers behind one interface:
 * - `local`: files on disk under STORAGE_DIR. Browser uploads go to the web app's own
 *   `/api/uploads/local` route with an HMAC-signed URL. Good for running on your computer.
 * - `s3`: any S3-compatible bucket (Cloudflare R2 in production). Browser uploads go straight to
 *   the bucket with a presigned PUT. Presigned GET URLs are publicly fetchable, which Meta's
 *   `file_url` option needs.
 *
 * Key layout (see `keys`): uploads/{assetId}/original.{ext}, media/{assetId}/master.mp4,
 * frames/{assetId}/{idx}.jpg, covers/{assetId}/cover.jpg.
 */
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getEnv, type Env } from '../env';
import { signValue, verifyValue } from '../crypto';

export interface UploadTarget {
  url: string;
  method: 'PUT';
  /** Headers the browser must send with the PUT (e.g. the signed Content-Type). */
  headers: Record<string, string>;
}

export interface StoredObjectInfo {
  size: number;
  contentType?: string;
}

export interface ByteRange {
  start: number;
  /** Inclusive. */
  end?: number;
}

export interface Storage {
  readonly driver: 'local' | 's3';
  /**
   * True if `getReadUrl` returns URLs an outside service (Meta, Google) can fetch over the
   * internet. Local storage is only public when APP_URL is a public https URL.
   */
  readonly publicReadUrls: boolean;
  createUploadTarget(
    key: string,
    contentType: string,
    opts?: { expiresInSec?: number },
  ): Promise<UploadTarget>;
  getReadUrl(key: string, opts?: { expiresInSec?: number }): Promise<string>;
  head(key: string): Promise<StoredObjectInfo | null>;
  openReadStream(key: string, range?: ByteRange): Promise<Readable>;
  putFile(key: string, localPath: string, contentType: string): Promise<void>;
  putBuffer(key: string, data: Buffer, contentType: string): Promise<void>;
  downloadToFile(key: string, localPath: string): Promise<void>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}

export const keys = {
  original: (assetId: string, ext: string) =>
    `uploads/${assetId}/original.${ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp4'}`,
  master: (assetId: string) => `media/${assetId}/master.mp4`,
  frame: (assetId: string, idx: number) => `frames/${assetId}/${String(idx).padStart(2, '0')}.jpg`,
  cover: (assetId: string) => `covers/${assetId}/cover.jpg`,
  assetPrefixes: (assetId: string) => [
    `uploads/${assetId}/`,
    `media/${assetId}/`,
    `frames/${assetId}/`,
    `covers/${assetId}/`,
  ],
};

const KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/;
export function assertSafeKey(key: string): void {
  if (!KEY_RE.test(key) || key.includes('..') || key.includes('//') || key.length > 512) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Local driver
// ---------------------------------------------------------------------------------------------

/** What the signed local URLs authorize. */
type LocalOp = 'put' | 'get';

export function localSignaturePayload(
  op: LocalOp,
  key: string,
  exp: number,
  contentType = '',
): string {
  return `${op}\n${key}\n${exp}\n${contentType}`;
}

/** Verifies a signed local upload/download URL (used by the web routes). */
export function verifyLocalSignature(
  op: LocalOp,
  key: string,
  exp: number,
  sig: string,
  contentType = '',
  now = Date.now(),
): boolean {
  if (!Number.isFinite(exp) || exp * 1000 < now) return false;
  try {
    assertSafeKey(key);
  } catch {
    return false;
  }
  return verifyValue(localSignaturePayload(op, key, exp, contentType), sig);
}

export class LocalStorage implements Storage {
  readonly driver = 'local' as const;
  readonly publicReadUrls: boolean;
  private readonly root: string;

  constructor(
    root: string,
    private readonly appUrl: string,
  ) {
    this.root = path.resolve(root);
    this.publicReadUrls = /^https:\/\//.test(appUrl) && !/localhost|127\.0\.0\.1/.test(appUrl);
  }

  /** Absolute path for a key (validated). */
  pathFor(key: string): string {
    assertSafeKey(key);
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error('Path escapes storage root');
    return p;
  }

  private signedUrl(
    op: LocalOp,
    route: string,
    key: string,
    expiresInSec: number,
    contentType = '',
  ) {
    const exp = Math.floor(Date.now() / 1000) + expiresInSec;
    const sig = signValue(localSignaturePayload(op, key, exp, contentType));
    const qs = new URLSearchParams({ key, exp: String(exp), sig });
    if (contentType) qs.set('ct', contentType);
    return `${this.appUrl}${route}?${qs.toString()}`;
  }

  async createUploadTarget(key: string, contentType: string, opts: { expiresInSec?: number } = {}) {
    assertSafeKey(key);
    return {
      url: this.signedUrl(
        'put',
        '/api/uploads/local',
        key,
        opts.expiresInSec ?? 15 * 60,
        contentType,
      ),
      method: 'PUT' as const,
      headers: { 'Content-Type': contentType },
    };
  }

  async getReadUrl(key: string, opts: { expiresInSec?: number } = {}) {
    assertSafeKey(key);
    return this.signedUrl('get', '/api/files', key, opts.expiresInSec ?? 60 * 60);
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    try {
      const st = await fs.stat(this.pathFor(key));
      return st.isFile() ? { size: st.size } : null;
    } catch {
      return null;
    }
  }

  async openReadStream(key: string, range?: ByteRange): Promise<Readable> {
    const p = this.pathFor(key);
    await fs.access(p);
    return createReadStream(p, range ? { start: range.start, end: range.end } : undefined);
  }

  /** Writes a stream to a key (used by the local upload route). */
  async writeStream(key: string, body: Readable): Promise<number> {
    const p = this.pathFor(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.part-${process.pid}-${Date.now()}`;
    try {
      await pipeline(body, createWriteStream(tmp));
      await fs.rename(tmp, p);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
    return (await fs.stat(p)).size;
  }

  async putFile(key: string, localPath: string): Promise<void> {
    const p = this.pathFor(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.copyFile(localPath, p);
  }

  async putBuffer(key: string, data: Buffer): Promise<void> {
    const p = this.pathFor(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, data);
  }

  async downloadToFile(key: string, localPath: string): Promise<void> {
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.copyFile(this.pathFor(key), localPath);
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.pathFor(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    assertSafeKey(prefix.replace(/\/$/, '') || 'x');
    const p = path.resolve(this.root, prefix);
    if (!p.startsWith(this.root + path.sep)) throw new Error('Path escapes storage root');
    await fs.rm(p, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// S3 / R2 driver
// ---------------------------------------------------------------------------------------------

export class S3Storage implements Storage {
  readonly driver = 's3' as const;
  readonly publicReadUrls = true;
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    config: { endpoint?: string; region: string; accessKeyId: string; secretAccessKey: string },
  ) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }

  async createUploadTarget(key: string, contentType: string, opts: { expiresInSec?: number } = {}) {
    assertSafeKey(key);
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: opts.expiresInSec ?? 15 * 60 },
    );
    return { url, method: 'PUT' as const, headers: { 'Content-Type': contentType } };
  }

  async getReadUrl(key: string, opts: { expiresInSec?: number } = {}) {
    assertSafeKey(key);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: Math.min(opts.expiresInSec ?? 60 * 60, 7 * 24 * 3600),
    });
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: Number(res.ContentLength ?? 0), contentType: res.ContentType };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (err as Error).name === 'NotFound') return null;
      throw err;
    }
  }

  async openReadStream(key: string, range?: ByteRange): Promise<Readable> {
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: range ? `bytes=${range.start}-${range.end ?? ''}` : undefined,
      }),
    );
    if (!res.Body) throw new Error(`Empty body for ${key}`);
    return res.Body as Readable;
  }

  async putFile(key: string, localPath: string, contentType: string): Promise<void> {
    const st = await fs.stat(localPath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(localPath),
        ContentLength: st.size,
        ContentType: contentType,
      }),
    );
  }

  async putBuffer(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType }),
    );
  }

  async downloadToFile(key: string, localPath: string): Promise<void> {
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    const body = await this.openReadStream(key);
    await pipeline(body, createWriteStream(localPath));
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deletePrefix(prefix: string): Promise<void> {
    let token: string | undefined;
    do {
      const list = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const objects = (list.Contents ?? []).map((o) => ({ Key: o.Key! })).filter((o) => o.Key);
      if (objects.length) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: objects, Quiet: true },
          }),
        );
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
  }
}

// ---------------------------------------------------------------------------------------------

let instance: Storage | undefined;

export function createStorage(env: Env = getEnv()): Storage {
  if (env.STORAGE_DRIVER === 's3') {
    if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
      throw new Error(
        'STORAGE_DRIVER=s3 needs S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.',
      );
    }
    return new S3Storage(env.S3_BUCKET, {
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    });
  }
  return new LocalStorage(env.STORAGE_DIR, env.APP_URL);
}

export function getStorage(): Storage {
  instance ??= createStorage();
  return instance;
}

/** Collects a stream into a Buffer (small objects only, e.g. frames). */
export async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Converts a web ReadableStream (fetch / Next request body) to a Node Readable. */
export function webToNodeStream(body: ReadableStream<Uint8Array>): Readable {
  return Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
}
