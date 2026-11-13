/**
 * HTTP helpers for the local storage routes: Range / Content-Range parsing and content types.
 * Pure functions (RFC 9110 §14).
 */

export type RangeResult =
  { kind: 'full' } | { kind: 'partial'; start: number; end: number } | { kind: 'unsatisfiable' };

/**
 * Parses a `Range` request header against a file of `size` bytes. Supports one range
 * (`bytes=0-499`, `bytes=500-`, `bytes=-500`). Multiple ranges or malformed headers fall back to
 * the full file, which RFC 9110 §14.2 allows ("a server MAY ignore the Range header field").
 */
export function parseRangeHeader(header: string | null, size: number): RangeResult {
  if (!header) return { kind: 'full' };
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return { kind: 'full' };
  const [, startS = '', endS = ''] = m;
  if (startS === '' && endS === '') return { kind: 'full' };
  if (size === 0) return { kind: 'unsatisfiable' };

  if (startS === '') {
    // Suffix range: the last N bytes.
    const suffix = Number(endS);
    if (!Number.isSafeInteger(suffix) || suffix === 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startS);
  if (!Number.isSafeInteger(start) || start >= size) return { kind: 'unsatisfiable' };
  let end = endS === '' ? size - 1 : Number(endS);
  if (!Number.isSafeInteger(end) || end < start) return { kind: 'full' };
  end = Math.min(end, size - 1);
  return { kind: 'partial', start, end };
}

export type ContentRange =
  // "bytes */<total>" with an empty body: "how many bytes do you have?"
  { kind: 'query'; total: number } | { kind: 'chunk'; start: number; end: number; total: number };

/** Parses a `Content-Range` request header (end inclusive). Returns null when malformed. */
export function parseContentRange(header: string | null): ContentRange | null {
  if (!header) return null;
  const query = /^\s*bytes\s+\*\/(\d+)\s*$/i.exec(header);
  if (query) {
    const total = Number(query[1]);
    return Number.isSafeInteger(total) && total > 0 ? { kind: 'query', total } : null;
  }
  const m = /^\s*bytes\s+(\d+)-(\d+)\/(\d+)\s*$/i.exec(header);
  if (!m) return null;
  const [start, end, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (![start, end, total].every(Number.isSafeInteger)) return null;
  if (end < start || end >= total) return null;
  return { kind: 'chunk', start, end, total };
}

const CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  json: 'application/json',
  txt: 'text/plain; charset=utf-8',
};

/** Content type for a storage key, from its extension (needed for <video> playback). */
export function contentTypeForKey(key: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(key)?.[1]?.toLowerCase() ?? '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/** Parses a non-negative integer header such as Content-Length. */
export function parseLength(header: string | null): number | null {
  if (header === null || !/^\s*\d+\s*$/.test(header)) return null;
  const n = Number(header.trim());
  return Number.isSafeInteger(n) ? n : null;
}
