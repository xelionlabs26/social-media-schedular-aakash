/**
 * Test helpers for the Meta module (fake Graph API, in-memory storage, PublishInput builder).
 * Only imported by *.test.ts files.
 */
import { Readable } from 'node:stream';
import type { AppSettings, MediaAsset, PostTarget, PublishAttempt } from '@app/db';
import { getEnv, type Env } from '../env';
import type { AccountCredentials, PublishInput, RemoteProgress, StepLog } from '../platforms';
import type { Storage } from '../storage';

export const PAGE_TOKEN = 'EAAPAGETOKENsecretsecretsecret123456';
export const USER_TOKEN = 'EAAUSERTOKENsecretsecretsecret654321';
export const SHORT_TOKEN = 'EAASHORTTOKENsecretsecretsecret00000';
export const APP_SECRET = 'appsecret-very-secret-value';

export function testEnv(overrides: Record<string, string> = {}): Env {
  return getEnv({
    NODE_ENV: 'test',
    APP_URL: 'https://sched.example.com',
    META_APP_ID: '1234567890',
    META_APP_SECRET: APP_SECRET,
    GRAPH_VERSION: 'v27.0',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------------------------
// Fake fetch
// ---------------------------------------------------------------------------------------------

export interface RecordedCall {
  method: string;
  url: URL;
  headers: Headers;
  /** Form fields (urlencoded POST) or query params (GET/DELETE). */
  params: URLSearchParams;
  /** Raw body bytes for streamed uploads. */
  body?: Buffer;
}

type Responder = (call: RecordedCall) => unknown | Response | Promise<unknown | Response>;

interface Route {
  method: string;
  pattern: RegExp;
  respond: Responder;
  once: boolean;
  used: boolean;
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function graphError(
  code: number,
  opts: { subcode?: number; message?: string; type?: string; status?: number } = {},
  headers: Record<string, string> = {},
): Response {
  return json(
    {
      error: {
        message: opts.message ?? `Error ${code}`,
        type: opts.type ?? 'OAuthException',
        code,
        error_subcode: opts.subcode,
        fbtrace_id: 'TRACE123',
      },
    },
    opts.status ?? 400,
    headers,
  );
}

async function readBody(body: unknown): Promise<Buffer | undefined> {
  if (body == null) return undefined;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ReadableStream) {
    const chunks: Buffer[] = [];
    for await (const c of Readable.fromWeb(body as never)) chunks.push(Buffer.from(c as Buffer));
    return Buffer.concat(chunks);
  }
  return undefined;
}

/**
 * A routing fake for global fetch. Routes are matched in order: `once` routes first if unused.
 * Unmatched requests fail the test loudly.
 */
export class FakeGraph {
  readonly calls: RecordedCall[] = [];
  private routes: Route[] = [];

  on(method: string, pattern: RegExp, respond: Responder): this {
    this.routes.push({ method, pattern, respond, once: false, used: false });
    return this;
  }

  once(method: string, pattern: RegExp, respond: Responder): this {
    this.routes.push({ method, pattern, respond, once: true, used: false });
    return this;
  }

  /** Calls whose path matches. */
  find(method: string, pattern: RegExp): RecordedCall[] {
    return this.calls.filter((c) => c.method === method && pattern.test(c.url.href));
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const body = await readBody(init.body);
    const isForm = headers.get('content-type')?.includes('urlencoded');
    const params = isForm && body ? new URLSearchParams(body.toString()) : url.searchParams;
    const call: RecordedCall = { method, url, headers, params, body: isForm ? undefined : body };
    this.calls.push(call);
    const candidates = this.routes.filter(
      (r) => r.method === method && r.pattern.test(url.href) && !(r.once && r.used),
    );
    const route = candidates.find((r) => r.once) ?? candidates[0];
    if (!route) throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    route.used = true;
    const res = await route.respond(call);
    return res instanceof Response ? res : json(res);
  };
}

// ---------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------

export function memoryStorage(files: Record<string, Buffer>, publicReadUrls = false): Storage {
  return {
    driver: 'local',
    publicReadUrls,
    async createUploadTarget() {
      throw new Error('not used');
    },
    async getReadUrl(key) {
      return `https://files.example.com/${key}?sig=abc`;
    },
    async head(key) {
      const f = files[key];
      return f ? { size: f.length } : null;
    },
    async openReadStream(key, range) {
      const f = files[key];
      if (!f) throw new Error('missing');
      const slice = range
        ? f.subarray(range.start, range.end !== undefined ? range.end + 1 : undefined)
        : f;
      return Readable.from([slice.subarray(0, 7), slice.subarray(7)]);
    },
    async putFile() {},
    async putBuffer(key, data) {
      files[key] = data;
    },
    async downloadToFile() {},
    async delete(key) {
      delete files[key];
    },
    async deletePrefix() {},
  };
}

// ---------------------------------------------------------------------------------------------
// PublishInput builder
// ---------------------------------------------------------------------------------------------

export const VIDEO = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz'); // 36 bytes
export const MASTER_KEY = 'media/asset-1/master.mp4';

export function makeAsset(over: Partial<MediaAsset> = {}): MediaAsset {
  const now = new Date('2026-11-13T00:00:00Z');
  return {
    id: 'asset-1',
    batchId: null,
    filename: 'clip.mp4',
    contentType: 'video/mp4',
    sizeBytes: VIDEO.length,
    sha256: null,
    originalKey: 'uploads/asset-1/original.mp4',
    masterKey: MASTER_KEY,
    status: 'ready',
    processingStep: null,
    durationMs: 60_000,
    width: 1080,
    height: 1920,
    rotation: 0,
    fps: 30,
    vcodec: 'h264',
    acodec: 'aac',
    hasAudio: true,
    colorTransfer: null,
    bitrate: null,
    warnings: [],
    transcript: null,
    transcriptLang: null,
    transcriptProvider: null,
    transcriptEdited: false,
    notes: '',
    coverFrameMs: 4200,
    error: null,
    sortIndex: 0,
    purgedAt: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

export function makeTarget(over: Partial<PostTarget> = {}): PostTarget {
  const now = new Date('2026-11-13T00:00:00Z');
  return {
    id: 'target-1',
    postId: 'post-1',
    platform: 'facebook',
    socialAccountId: 'acc-1',
    status: 'preparing',
    attentionReason: null,
    note: null,
    publishMode: 'native',
    scheduledAt: null,
    prepareAt: null,
    title: '',
    body: 'Socha tha normal sunset hoga… phir ye hua',
    hashtags: [],
    tags: [],
    textSources: {},
    options: {},
    idempotencyKey: '00000000-0000-0000-0000-000000000001',
    remoteContainerId: null,
    remoteUploadUri: null,
    remoteUploadOffset: null,
    remoteMediaId: null,
    remoteUrl: null,
    needsSync: false,
    attempts: 0,
    nextAttemptAt: null,
    lockedUntil: null,
    lastErrorCode: null,
    lastError: null,
    publishedAt: null,
    version: 0,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

export function makeSettings(over: Partial<AppSettings> = {}): AppSettings {
  return {
    instagramDefaults: { shareToFeed: true },
    facebookDefaults: { kind: 'auto' },
    ...over,
  } as AppSettings;
}

export function fbAccount(): AccountCredentials {
  return {
    accountId: 'acc-fb',
    platform: 'facebook',
    externalId: '111',
    accessToken: PAGE_TOKEN,
    accessExpiresAt: null,
    userAccessToken: USER_TOKEN,
    scopes: [],
    meta: { pageId: '111', pageName: 'My Page' },
  };
}

export function igAccount(): AccountCredentials {
  return {
    accountId: 'acc-ig',
    platform: 'instagram',
    externalId: '999',
    accessToken: PAGE_TOKEN,
    accessExpiresAt: null,
    scopes: [],
    meta: { igUserId: '999', igUsername: 'me', pageId: '111', pageAccountId: 'acc-fb' },
  };
}

export interface Harness {
  input: PublishInput;
  /** The target as the engine would have persisted it after saveProgress calls. */
  target: PostTarget;
  apiCalls: string[];
  steps: Array<{ step: PublishAttempt['step']; log: StepLog }>;
  progress: RemoteProgress[];
  /** A fresh input for the next engine call, carrying the saved progress. */
  next(over?: { now?: Date; mode?: PublishInput['mode'] }): PublishInput;
}

export function harness(opts: {
  platform: 'facebook' | 'instagram';
  scheduledAt: Date;
  now: Date;
  mode: PublishInput['mode'];
  target?: Partial<PostTarget>;
  asset?: Partial<MediaAsset>;
  settings?: Partial<AppSettings>;
  storage?: Storage;
  text?: Partial<PublishInput['text']>;
}): Harness {
  const h = {
    target: makeTarget({ platform: opts.platform, scheduledAt: opts.scheduledAt, ...opts.target }),
    apiCalls: [] as string[],
    steps: [] as Harness['steps'],
    progress: [] as RemoteProgress[],
  } as Harness;
  const storage = opts.storage ?? memoryStorage({ [MASTER_KEY]: VIDEO });
  const asset = makeAsset(opts.asset);
  const settings = makeSettings(opts.settings);
  const account = opts.platform === 'facebook' ? fbAccount() : igAccount();
  const build = (now: Date, mode: PublishInput['mode']): PublishInput => ({
    target: { ...h.target },
    asset,
    settings,
    account,
    storage,
    text: { title: '', body: h.target.body, tags: [], ...opts.text },
    scheduledAt: opts.scheduledAt,
    now,
    mode,
    async saveProgress(patch) {
      h.progress.push(patch);
      h.target = { ...h.target, ...patch } as PostTarget;
    },
    async recordApiCall(kind) {
      h.apiCalls.push(kind);
    },
    async logStep(step, log) {
      h.steps.push({ step, log });
    },
  });
  h.input = build(opts.now, opts.mode);
  h.next = (over = {}) => build(over.now ?? opts.now, over.mode ?? opts.mode);
  return h;
}
