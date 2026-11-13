/**
 * Small display helpers for cards (sizes, durations, shapes). Pure and client-safe.
 */
import { ACCEPTED_VIDEO_TYPES, type AcceptedVideoType } from './constants';

/** "45.2 MB" (binary units, like the OS file browser on most systems). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** "0:58", "1:12", "1:02:03". Rounds to the nearest second. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const SHAPES: Array<{ label: string; ratio: number }> = [
  { label: '9:16', ratio: 9 / 16 },
  { label: '3:4', ratio: 3 / 4 },
  { label: '4:5', ratio: 4 / 5 },
  { label: '1:1', ratio: 1 },
  { label: '4:3', ratio: 4 / 3 },
  { label: '16:9', ratio: 16 / 9 },
];

const trimDecimal = (n: number) => n.toFixed(1).replace(/\.0$/, '');

/**
 * Aspect label for a display size: the nearest common shape within 3 %, otherwise the ratio
 * against 9 (e.g. a 1080×2340 screen recording is "9:19.5").
 */
export function shapeLabel(width: number | null | undefined, height: number | null | undefined) {
  if (!width || !height || width <= 0 || height <= 0) return null;
  const ratio = width / height;
  let best = SHAPES[0]!;
  for (const s of SHAPES) {
    if (Math.abs(Math.log(ratio / s.ratio)) < Math.abs(Math.log(ratio / best.ratio))) best = s;
  }
  if (Math.abs(Math.log(ratio / best.ratio)) < Math.log(1.03)) return best.label;
  return ratio < 1
    ? `9:${trimDecimal((9 * height) / width)}`
    : `${trimDecimal((9 * width) / height)}:9`;
}

/** Lower-case extension without the dot ('' when there is none). */
export function fileExtension(name: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name.trim());
  return m ? m[1]!.toLowerCase() : '';
}

const EXT_TO_TYPE: Record<string, AcceptedVideoType> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  qt: 'video/quicktime',
};

/**
 * The MIME type we upload a file as, or null when it is not an accepted video. Some systems
 * report an empty or generic type for .mov files, so the extension is used as a fallback.
 */
export function videoTypeFor(name: string, reportedType: string): AcceptedVideoType | null {
  const t = reportedType.trim().toLowerCase();
  if (t in ACCEPTED_VIDEO_TYPES) return t as AcceptedVideoType;
  if (t === '' || t === 'application/octet-stream' || t === 'video/x-m4v') {
    return EXT_TO_TYPE[fileExtension(name)] ?? null;
  }
  return null;
}

/** Extension the original is stored under: the file's own when it matches its type. */
export function storageExtension(name: string, type: AcceptedVideoType): string {
  const ext = fileExtension(name);
  if (EXT_TO_TYPE[ext] === type) return ext;
  return ACCEPTED_VIDEO_TYPES[type];
}

/** Natural, case-insensitive filename order ("clip 2" before "clip 10"). */
export const compareNames: (a: string, b: string) => number = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base',
}).compare;

/** First non-empty line of a text, cut to `max` characters with an ellipsis. */
export function firstLine(text: string | null | undefined, max = 90): string {
  const line =
    (text ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  const chars = Array.from(line);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : line;
}
