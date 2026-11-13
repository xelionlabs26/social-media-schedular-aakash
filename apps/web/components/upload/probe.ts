/**
 * Reads a picked video in the browser so its card can show length, shape and a thumbnail
 * immediately, long before the worker has probed it. Best effort: files the browser can't
 * decode (e.g. some HEVC .mov) simply show placeholders until the server catches up.
 */

export interface LocalProbe {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  /** Small JPEG data URL of a frame near 0.5 s. */
  thumb: string | null;
}

const THUMB_WIDTH = 120;
const TIMEOUT_MS = 10_000;

function once<T extends Event>(el: HTMLElement, type: string, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      el.removeEventListener(type, onEvent);
      el.removeEventListener('error', onError);
      reject(new Error(`timeout waiting for ${type}`));
    }, ms);
    const onEvent = (e: Event) => {
      clearTimeout(timer);
      el.removeEventListener('error', onError);
      resolve(e as T);
    };
    const onError = () => {
      clearTimeout(timer);
      el.removeEventListener(type, onEvent);
      reject(new Error('cannot decode'));
    };
    el.addEventListener(type, onEvent, { once: true });
    el.addEventListener('error', onError, { once: true });
  });
}

async function probeOne(file: Blob): Promise<LocalProbe> {
  const result: LocalProbe = { durationMs: null, width: null, height: null, thumb: null };
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  try {
    video.src = url;
    await once(video, 'loadedmetadata', TIMEOUT_MS);
    if (Number.isFinite(video.duration)) result.durationMs = Math.round(video.duration * 1000);
    result.width = video.videoWidth || null;
    result.height = video.videoHeight || null;
    if (result.width && result.height) {
      video.currentTime = Math.min(0.5, (video.duration || 1) / 2);
      await once(video, 'seeked', TIMEOUT_MS);
      const canvas = document.createElement('canvas');
      canvas.width = THUMB_WIDTH;
      canvas.height = Math.round((THUMB_WIDTH * result.height) / result.width);
      canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
      result.thumb = canvas.toDataURL('image/jpeg', 0.7);
    }
  } catch {
    /* keep whatever we got */
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
  return result;
}

/** Probes files two at a time (a 100-file drop must not create 100 decoders at once). */
export function createProber(concurrency = 2) {
  let active = 0;
  const waiting: Array<() => void> = [];
  const slot = async () => {
    if (active >= concurrency) await new Promise<void>((r) => waiting.push(r));
    active += 1;
  };
  const release = () => {
    active -= 1;
    waiting.shift()?.();
  };
  return async (file: Blob): Promise<LocalProbe> => {
    await slot();
    try {
      return await probeOne(file);
    } finally {
      release();
    }
  };
}
