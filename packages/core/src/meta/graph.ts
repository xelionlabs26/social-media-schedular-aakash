/**
 * Tiny Meta Graph API client: versioned URLs, appsecret_proof, timeouts, error mapping and the
 * rupload.facebook.com byte uploads used by Facebook Reels and Instagram resumable containers.
 *
 * Deliberately avoided (removed or restricted for new apps, see PLAN.md §2): `?ids=` multi-ID
 * reads, field aliases, `method=` override, `date_format`, JSONP, async batch, ETag caching and
 * the deprecated graph-video.facebook.com host.
 */
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { PlatformError } from '../platforms';
import { mapGraphError, networkError, scrubSecrets, type GraphErrorBody } from './errors';

export const GRAPH_HOST = 'https://graph.facebook.com';
export const RUPLOAD_HOST = 'https://rupload.facebook.com';

export type FetchFn = typeof fetch;
export type Params = Record<string, string | number | boolean | undefined | null>;

export interface GraphClientOptions {
  /** e.g. 'v27.0' (env.GRAPH_VERSION). */
  version: string;
  /** Adds appsecret_proof to every token-bearing call when set. */
  appSecret?: string;
  fetch?: FetchFn;
  /** Per-request timeout for ordinary API calls. */
  timeoutMs?: number;
  /** Timeout for byte uploads. */
  uploadTimeoutMs?: number;
  signal?: AbortSignal;
}

/** One HTTP response we already parsed (used by callers that need headers). */
export interface GraphResponse<T> {
  data: T;
  status: number;
  headers: Headers;
}

/**
 * appsecret_proof = HMAC-SHA256(access_token, app_secret), hex.
 * https://developers.facebook.com/docs/graph-api/securing-requests#appsecret_proof
 */
export function appSecretProof(accessToken: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(accessToken).digest('hex');
}

function toSearchParams(params: Params): URLSearchParams {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    sp.set(k, String(v));
  }
  return sp;
}

export class GraphClient {
  readonly version: string;
  private readonly appSecret?: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly signal?: AbortSignal;

  constructor(opts: GraphClientOptions) {
    this.version = opts.version;
    this.appSecret = opts.appSecret;
    this.fetchFn = opts.fetch ?? ((...args) => fetch(...args));
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.uploadTimeoutMs = opts.uploadTimeoutMs ?? 60 * 60_000;
    this.signal = opts.signal;
  }

  /** Same client, bound to an abort signal (PublishInput.signal). */
  withSignal(signal: AbortSignal | undefined): GraphClient {
    if (!signal) return this;
    return new GraphClient({
      version: this.version,
      appSecret: this.appSecret,
      fetch: this.fetchFn,
      timeoutMs: this.timeoutMs,
      uploadTimeoutMs: this.uploadTimeoutMs,
      signal,
    });
  }

  url(path: string): string {
    return `${GRAPH_HOST}/${this.version}/${path.replace(/^\/+/, '')}`;
  }

  private authParams(token: string | undefined): Params {
    if (!token) return {};
    return {
      access_token: token,
      appsecret_proof: this.appSecret ? appSecretProof(token, this.appSecret) : undefined,
    };
  }

  private signalFor(timeoutMs: number): AbortSignal {
    const t = AbortSignal.timeout(timeoutMs);
    return this.signal ? AbortSignal.any([this.signal, t]) : t;
  }

  async get<T>(path: string, params: Params, token?: string, context?: string): Promise<T> {
    return (await this.request<T>('GET', path, params, token, context)).data;
  }

  async post<T>(path: string, params: Params, token?: string, context?: string): Promise<T> {
    return (await this.request<T>('POST', path, params, token, context)).data;
  }

  async delete<T>(path: string, params: Params, token?: string, context?: string): Promise<T> {
    return (await this.request<T>('DELETE', path, params, token, context)).data;
  }

  /**
   * GET/DELETE send parameters in the query string; POST sends them form-encoded in the body
   * (the documented way for Graph writes).
   */
  async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Params,
    token: string | undefined,
    context?: string,
  ): Promise<GraphResponse<T>> {
    const all = toSearchParams({ ...params, ...this.authParams(token) });
    let url = this.url(path);
    const init: RequestInit = { method, signal: this.signalFor(this.timeoutMs) };
    if (method === 'POST') {
      init.body = all;
      init.headers = { 'content-type': 'application/x-www-form-urlencoded' };
    } else if ([...all.keys()].length) {
      url += `?${all.toString()}`;
    }
    return this.send<T>(url, init, context);
  }

  /** Sends a request and maps Graph errors. Never includes the URL (it may carry a token). */
  async send<T>(url: string, init: RequestInit, context?: string): Promise<GraphResponse<T>> {
    let res: Response;
    try {
      res = await this.fetchFn(url, init);
    } catch (err) {
      throw networkError(err, context);
    }
    const text = await res.text().catch(() => '');
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }
    const graphErr = (body as { error?: GraphErrorBody } | undefined)?.error;
    if (!res.ok || (graphErr && typeof graphErr === 'object')) {
      if (graphErr && typeof graphErr === 'object') {
        throw mapGraphError(res.status, graphErr, res.headers, context);
      }
      throw ruploadOrHttpError(res.status, body, text, res.headers, context);
    }
    return { data: (body ?? {}) as T, status: res.status, headers: res.headers };
  }

  /**
   * POST with a streamed multipart/form-data body (fields first, then the file as `fileField`).
   * Used for non-resumable Page video uploads (`source`), which Meta caps at 1 GB / 20 min.
   * https://developers.facebook.com/docs/graph-api/reference/page/videos/
   */
  async postMultipart<T>(
    path: string,
    params: Params,
    token: string,
    file: { field: string; filename: string; contentType: string; size: number; body: Readable },
    context?: string,
  ): Promise<T> {
    const boundary = `----metaform${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const fields = toSearchParams({ ...params, ...this.authParams(token) });
    let head = '';
    for (const [k, v] of fields) {
      head += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
    }
    const safeName = file.filename.replace(/["\r\n]/g, '_');
    head +=
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${safeName}"\r\n` +
      `Content-Type: ${file.contentType}\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;
    const headBuf = Buffer.from(head, 'utf8');
    const tailBuf = Buffer.from(tail, 'utf8');
    async function* parts() {
      yield headBuf;
      for await (const chunk of file.body) yield chunk as Buffer;
      yield tailBuf;
    }
    const init: RequestInit & { duplex?: 'half' } = {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(headBuf.length + file.size + tailBuf.length),
      },
      body: Readable.toWeb(Readable.from(parts())) as unknown as ReadableStream<Uint8Array>,
      duplex: 'half',
      signal: this.signalFor(this.uploadTimeoutMs),
    };
    return (await this.send<T>(this.url(path), init, context)).data;
  }

  /**
   * Uploads bytes to rupload.facebook.com (Reels: /video-upload/{v}/{video-id}, Instagram:
   * /ig-api-upload/{v}/{container-id}). Either streams `body` starting at `offset`, or hands
   * Meta a public `fileUrl` to fetch.
   * https://developers.facebook.com/docs/video-api/guides/reels-publishing (Step 2)
   * https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/content-publishing
   */
  async rupload(
    kind: 'video-upload' | 'ig-api-upload',
    id: string,
    token: string,
    input:
      { offset: number; fileSize: number; body: Readable } | { fileUrl: string; fileSize?: number },
    context?: string,
  ): Promise<Record<string, unknown>> {
    const url = `${RUPLOAD_HOST}/${kind}/${this.version}/${encodeURIComponent(id)}`;
    const headers: Record<string, string> = { Authorization: `OAuth ${token}` };
    const init: RequestInit & { duplex?: 'half' } = {
      method: 'POST',
      headers,
      signal: this.signalFor(this.uploadTimeoutMs),
    };
    if ('fileUrl' in input) {
      // Hosted file: Meta fetches it (the host must allow facebookexternalhit/1.1).
      headers.file_url = input.fileUrl;
    } else {
      headers.offset = String(input.offset);
      headers.file_size = String(input.fileSize);
      headers['content-type'] = 'application/octet-stream';
      headers['content-length'] = String(input.fileSize - input.offset);
      init.body = Readable.toWeb(input.body) as unknown as ReadableStream<Uint8Array>;
      // Node's fetch needs duplex: 'half' to send a streamed request body.
      init.duplex = 'half';
    }
    const res = await this.send<Record<string, unknown>>(url, init, context);
    if (res.data.success === false) {
      throw ruploadOrHttpError(
        res.status,
        res.data,
        JSON.stringify(res.data),
        res.headers,
        context,
      );
    }
    return res.data;
  }
}

/**
 * rupload errors look like {"debug_info":{"retriable":false,"type":"OffsetInvalidError",
 * "message":"..."}}. Documented types: OffsetInvalidError (resume from bytes_transfered),
 * PartialRequestError and ProcessingFailedError (retry). Anything else falls back to HTTP status.
 */
function ruploadOrHttpError(
  status: number,
  body: unknown,
  text: string,
  headers: Headers,
  context?: string,
): PlatformError {
  const info = (body as { debug_info?: { type?: string; message?: string; retriable?: boolean } })
    ?.debug_info;
  if (info?.type) {
    const message = scrubSecrets(`${info.type}: ${info.message ?? ''}`.trim());
    const retryable =
      info.retriable === true ||
      ['OffsetInvalidError', 'PartialRequestError', 'ProcessingFailedError'].includes(info.type) ||
      status >= 500;
    return new PlatformError(
      retryable ? 'retryable' : 'fatal',
      `${context ? `${context}: ` : ''}${message}`,
      {
        code: info.type,
        httpStatus: status,
        retryAfterSec: retryable ? 60 : undefined,
        details: { httpStatus: status, platformMessage: message },
      },
    );
  }
  const err = mapGraphError(status, undefined, headers, context);
  if (text && err.details && typeof err.details === 'object') {
    (err.details as { excerpt?: string }).excerpt = scrubSecrets(text.slice(0, 300));
  }
  return err;
}
