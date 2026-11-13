import { describe, expect, it, vi } from 'vitest';
import { UploadQueue, type UploadJob, type UploadTransport } from './queue';
import { backoffDelayMs, isRetryableStatus, UploadError, uploadErrorMessage } from './retry';

const target = { url: '/put', method: 'PUT' as const, headers: { 'Content-Type': 'video/mp4' } };
const job = (id: string, size = 100, issuedAt = 0): UploadJob => ({
  id,
  file: new Blob([new Uint8Array(size)]),
  target,
  issuedAt,
});

/** Resolves once `fn` returns true (polls the microtask queue). */
async function until(fn: () => boolean, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('condition not reached');
}

function makeQueue(
  transport: UploadTransport,
  extra: Partial<ConstructorParameters<typeof UploadQueue>[0]> = {},
) {
  const finalize = vi.fn(async () => ({ ok: true as const }));
  const sleeps: number[] = [];
  const queue = new UploadQueue({
    transport,
    finalize,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    backoff: (attempt) => attempt * 1000,
    progressThrottleMs: 0,
    now: () => 0,
    ...extra,
  });
  return { queue, finalize, sleeps };
}

describe('retry policy', () => {
  it('backs off 1 s, 3 s, 9 s with jitter, capped', () => {
    const mid = () => 0.5;
    expect(backoffDelayMs(1, { random: mid })).toBe(1000);
    expect(backoffDelayMs(2, { random: mid })).toBe(3000);
    expect(backoffDelayMs(3, { random: mid })).toBe(9000);
    expect(backoffDelayMs(10, { random: mid })).toBe(30000);
    expect(backoffDelayMs(1, { random: () => 0 })).toBe(800);
    expect(backoffDelayMs(1, { random: () => 1 })).toBe(1200);
  });

  it('retries network, expiry, throttling and server errors only', () => {
    for (const s of [0, 403, 408, 429, 500, 503]) expect(isRetryableStatus(s)).toBe(true);
    for (const s of [400, 401, 404, 409, 413, 415]) expect(isRetryableStatus(s)).toBe(false);
    expect(uploadErrorMessage(new UploadError('x', 0, true))).toBe('Upload failed (network)');
    expect(uploadErrorMessage(new UploadError('x', 413, false))).toBe('File is too large');
  });
});

describe('UploadQueue', () => {
  it('runs at most 3 uploads at a time and finalizes each', async () => {
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const transport: UploadTransport = (_job, { onProgress }) =>
      new Promise<void>((resolve) => {
        active += 1;
        peak = Math.max(peak, active);
        onProgress(50);
        release.push(() => {
          active -= 1;
          resolve();
        });
      });
    const done: string[] = [];
    const { queue, finalize } = makeQueue(transport, { onDone: (id) => done.push(id) });
    queue.add(['a', 'b', 'c', 'd', 'e'].map((id) => job(id)));
    await until(() => release.length === 3);
    expect(peak).toBe(3);
    expect(queue.get('a')?.loaded).toBe(50);
    expect(queue.get('d')?.phase).toBe('queued');
    while (done.length < 5) {
      release.shift()?.();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(peak).toBe(3);
    expect(finalize).toHaveBeenCalledTimes(5);
    expect(done).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(queue.getSnapshot().every((i) => i.phase === 'done' && i.loaded === i.total)).toBe(true);
    expect(queue.isBusy()).toBe(false);
  });

  it('retries a retryable failure with backoff, then succeeds', async () => {
    let calls = 0;
    const transport: UploadTransport = async () => {
      calls += 1;
      if (calls < 3) throw new UploadError('Network error', 0, true);
    };
    const { queue, sleeps } = makeQueue(transport);
    queue.add([job('a')]);
    await until(() => queue.get('a')?.phase === 'done');
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
    expect(queue.get('a')?.attempt).toBe(3);
  });

  it('gives up after 3 tries and can be retried by hand', async () => {
    let calls = 0;
    const transport: UploadTransport = async () => {
      calls += 1;
      if (calls <= 3) throw new UploadError('boom', 500, true);
    };
    const { queue } = makeQueue(transport);
    queue.add([job('a')]);
    await until(() => queue.get('a')?.phase === 'failed');
    expect(calls).toBe(3);
    expect(queue.get('a')?.error).toBe('Storage server error');
    queue.retry('a');
    await until(() => queue.get('a')?.phase === 'done');
    expect(calls).toBe(4);
  });

  it('does not retry permanent errors', async () => {
    const transport = vi.fn(async () => {
      throw new UploadError('File is too large', 413, false);
    });
    const { queue } = makeQueue(transport);
    queue.add([job('a')]);
    await until(() => queue.get('a')?.phase === 'failed');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('asks for a fresh URL after a 403 and when the URL is old', async () => {
    let calls = 0;
    const seen: string[] = [];
    const transport: UploadTransport = async (j) => {
      calls += 1;
      seen.push(j.target.url);
      if (calls === 1) throw new UploadError('expired', 403, true);
    };
    const renewTarget = vi.fn(async () => ({ target: { ...target, url: '/fresh' } }));
    const { queue } = makeQueue(transport, { renewTarget });
    queue.add([job('a')]);
    await until(() => queue.get('a')?.phase === 'done');
    expect(seen).toEqual(['/put', '/fresh']);
    expect(renewTarget).toHaveBeenCalledTimes(1);

    // Signed 11 minutes ago: renewed before the first try.
    const { queue: q2 } = makeQueue(transport, { renewTarget, now: () => 11 * 60_000 });
    q2.add([job('b', 10, 0)]);
    await until(() => q2.get('b')?.phase === 'done');
    expect(renewTarget).toHaveBeenCalledTimes(2);
  });

  it('cancels a running upload through the abort signal', async () => {
    const transport: UploadTransport = (_j, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const { queue, finalize } = makeQueue(transport);
    queue.add([job('a'), job('b')]);
    await until(() => queue.get('a')?.phase === 'uploading');
    queue.cancel('a');
    await until(() => queue.get('a')?.phase === 'canceled');
    expect(finalize).not.toHaveBeenCalled();
    queue.cancel('b');
    queue.remove('a');
    expect(queue.has('a')).toBe(false);
  });

  it('re-sends the bytes when finalize reports a missing or short file', async () => {
    const transport = vi.fn(async () => {});
    const finalize = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'Upload incomplete', reupload: true })
      .mockResolvedValueOnce({ ok: false, error: 'db down', reupload: false })
      .mockResolvedValueOnce({ ok: true });
    const { queue } = makeQueue(transport, { finalize });
    queue.add([job('a')]);
    await until(() => queue.get('a')?.phase === 'done');
    // Try 1 uploads, finalize says re-upload; try 2 uploads again, finalize fails without
    // needing bytes; try 3 only finalizes.
    expect(transport).toHaveBeenCalledTimes(2);
    expect(finalize).toHaveBeenCalledTimes(3);
  });

  it('notifies subscribers and keeps snapshots stable between changes', async () => {
    const { queue } = makeQueue(async () => {});
    const listener = vi.fn();
    queue.subscribe(listener);
    const before = queue.getSnapshot();
    expect(queue.getSnapshot()).toBe(before);
    queue.add([job('a')]);
    await until(() => queue.get('a')?.phase === 'done');
    expect(listener).toHaveBeenCalled();
    expect(queue.getSnapshot()).not.toBe(before);
  });
});
