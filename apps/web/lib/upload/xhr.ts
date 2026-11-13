/**
 * Browser upload transport built on XMLHttpRequest (fetch has no upload progress events).
 *
 * - S3 / R2: one PUT of the whole file to the presigned URL.
 * - Local driver: PUTs of `chunkSize` bytes with `Content-Range`, so each request stays under
 *   the 10 MB body buffer that Next.js applies to requests passing through proxy.ts. Every try
 *   first asks the server how many bytes it already has (an empty PUT whose Content-Range has
 *   `*` as the range, like Google's resumable uploads) and resumes from there.
 */
import { UPLOAD_STALL_TIMEOUT_MS } from './constants';
import { isRetryableStatus, UploadCanceledError, UploadError } from './retry';
import type { UploadJob, UploadTransport } from './queue';

interface PutResult {
  status: number;
  body: string;
}

/** One PUT with progress, cancel and a stall timer (no bytes sent for `stallMs` = abort). */
export function xhrPut(
  url: string,
  body: Blob | null,
  headers: Record<string, string>,
  opts: { signal: AbortSignal; onProgress?: (loaded: number) => void; stallMs?: number },
): Promise<PutResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) return reject(new UploadCanceledError());
    const xhr = new XMLHttpRequest();
    let stalled = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        xhr.abort();
      }, opts.stallMs ?? UPLOAD_STALL_TIMEOUT_MS);
    };
    const cleanup = () => {
      clearTimeout(stallTimer);
      opts.signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => xhr.abort();

    xhr.open('PUT', url, true);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (ev) => {
      armStall();
      if (ev.lengthComputable) opts.onProgress?.(ev.loaded);
    };
    xhr.onload = () => {
      cleanup();
      resolve({ status: xhr.status, body: xhr.responseText });
    };
    xhr.onerror = () => {
      cleanup();
      reject(new UploadError('Network error', 0, true));
    };
    xhr.onabort = () => {
      cleanup();
      if (stalled) reject(new UploadError('Upload stalled', 0, true));
      else reject(new UploadCanceledError());
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });
    armStall();
    xhr.send(body);
  });
}

function assertOk(res: PutResult): void {
  if (res.status >= 200 && res.status < 300) return;
  let message = `Upload failed (HTTP ${res.status})`;
  try {
    const parsed = JSON.parse(res.body) as { error?: unknown };
    if (typeof parsed.error === 'string') message = parsed.error;
  } catch {
    /* not JSON (e.g. S3 XML error) */
  }
  throw new UploadError(message, res.status, isRetryableStatus(res.status));
}

function parseOffset(res: PutResult): number | null {
  try {
    const parsed = JSON.parse(res.body) as { offset?: unknown };
    return typeof parsed.offset === 'number' && parsed.offset >= 0 ? parsed.offset : null;
  } catch {
    return null;
  }
}

/** Asks the local upload route how many bytes of this file it already has. */
async function queryOffset(job: UploadJob, signal: AbortSignal): Promise<number> {
  const total = job.file.size;
  const res = await xhrPut(
    job.target.url,
    null,
    { ...job.target.headers, 'Content-Range': `bytes */${total}` },
    { signal },
  );
  assertOk(res);
  return Math.min(parseOffset(res) ?? 0, total);
}

async function uploadChunked(
  job: UploadJob,
  chunkSize: number,
  ctx: Parameters<UploadTransport>[1],
): Promise<void> {
  const total = job.file.size;
  let offset = await queryOffset(job, ctx.signal);
  ctx.onProgress(offset);
  while (offset < total) {
    const end = Math.min(offset + chunkSize, total);
    const chunk = job.file.slice(offset, end, job.target.headers['Content-Type']);
    const res = await xhrPut(
      job.target.url,
      chunk,
      { ...job.target.headers, 'Content-Range': `bytes ${offset}-${end - 1}/${total}` },
      { signal: ctx.signal, onProgress: (loaded) => ctx.onProgress(offset + loaded) },
    );
    if (res.status === 409) {
      // The server holds a different number of bytes (e.g. an earlier try half-finished).
      const serverOffset = parseOffset(res);
      if (serverOffset === null) assertOk(res);
      offset = Math.min(serverOffset!, total);
      ctx.onProgress(offset);
      continue;
    }
    assertOk(res);
    offset = parseOffset(res) ?? end;
    ctx.onProgress(offset);
  }
}

/** The transport used by the Upload screen. */
export const xhrTransport: UploadTransport = async (job, ctx) => {
  if (job.chunkSize && job.chunkSize > 0) {
    await uploadChunked(job, job.chunkSize, ctx);
    return;
  }
  const res = await xhrPut(job.target.url, job.file, job.target.headers, {
    signal: ctx.signal,
    onProgress: ctx.onProgress,
  });
  assertOk(res);
};
