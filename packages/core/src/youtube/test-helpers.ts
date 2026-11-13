/**
 * Test helpers for the YouTube module: a scripted fake `fetch` that records every request.
 * (Not imported by production code.)
 */
import type { FetchFn } from './api';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Request body: text for strings/forms, raw bytes for streams. */
  body?: string;
  bytes?: Buffer;
}

type Responder = (call: RecordedCall) => Response | Promise<Response>;

interface Route {
  method: string;
  match: (url: string) => boolean;
  respond: Responder;
  /** Remaining uses; Infinity for persistent routes. */
  times: number;
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function apiError(status: number, reason: string, message = reason): Response {
  return jsonResponse(
    { error: { code: status, message, errors: [{ domain: 'youtube.video', reason, message }] } },
    status,
  );
}

/** A status-only response; 308 and 204 can't carry a body. */
export function emptyResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

export class FakeFetch {
  readonly calls: RecordedCall[] = [];
  private routes: Route[] = [];

  /** Adds a one-shot route (consumed in order). */
  once(method: string, match: string | RegExp, respond: Responder | Response): this {
    return this.add(method, match, respond, 1);
  }

  /** Adds a route used for every matching request. */
  always(method: string, match: string | RegExp, respond: Responder | Response): this {
    return this.add(method, match, respond, Infinity);
  }

  private add(
    method: string,
    match: string | RegExp,
    respond: Responder | Response,
    times: number,
  ) {
    // Build a fresh Response per use (clone() tees the stream, and cancelling one tee branch
    // waits for the other, which would hang tests).
    let fn: Responder;
    if (respond instanceof Response) {
      const template = respond;
      const bytes = template.arrayBuffer();
      fn = async () =>
        new Response(template.body === null ? null : await bytes, {
          status: template.status,
          headers: template.headers,
        });
    } else fn = respond;
    this.routes.push({
      method,
      match: (url) => (typeof match === 'string' ? url.startsWith(match) : match.test(url)),
      respond: fn,
      times,
    });
    return this;
  }

  callsTo(method: string, match: string | RegExp): RecordedCall[] {
    return this.calls.filter(
      (c) =>
        c.method === method &&
        (typeof match === 'string' ? c.url.startsWith(match) : match.test(c.url)),
    );
  }

  readonly fetch: FetchFn = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const call: RecordedCall = { url, method, headers };
    const body = init.body;
    if (typeof body === 'string') call.body = body;
    else if (body instanceof URLSearchParams) call.body = body.toString();
    else if (body && typeof (body as ReadableStream).getReader === 'function') {
      const chunks: Buffer[] = [];
      const reader = (body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
      }
      call.bytes = Buffer.concat(chunks);
    }
    this.calls.push(call);
    const route = this.routes.find((r) => r.times > 0 && r.method === method && r.match(url));
    if (!route) throw new Error(`FakeFetch: no route for ${method} ${url}`);
    route.times -= 1;
    return route.respond(call);
  };
}
