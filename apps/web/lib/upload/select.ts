/**
 * Screens files the owner dropped or picked before anything is sent: only MP4/MOV, not empty,
 * at most 2 GB, at most 100 per drop. Pure and client-safe.
 */
import { MAX_FILE_BYTES, MAX_FILES_PER_CALL, type AcceptedVideoType } from './constants';
import { formatBytes, videoTypeFor } from './format';

export interface FileLike {
  name: string;
  size: number;
  type: string;
}

export interface ScreenedFiles<F extends FileLike> {
  accepted: Array<{ file: F; type: AcceptedVideoType }>;
  rejected: Array<{ file: F; reason: string }>;
  /** Accepted but over the per-drop limit (the owner can drop them next). */
  overflow: F[];
}

export function screenFiles<F extends FileLike>(
  files: F[],
  opts: { maxFiles?: number; maxBytes?: number } = {},
): ScreenedFiles<F> {
  const maxFiles = opts.maxFiles ?? MAX_FILES_PER_CALL;
  const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES;
  const out: ScreenedFiles<F> = { accepted: [], rejected: [], overflow: [] };
  for (const file of files) {
    const type = videoTypeFor(file.name, file.type);
    if (!type) out.rejected.push({ file, reason: 'not an MP4 or MOV video' });
    else if (file.size === 0) out.rejected.push({ file, reason: 'the file is empty' });
    else if (file.size > maxBytes)
      out.rejected.push({ file, reason: `larger than ${formatBytes(maxBytes)}` });
    else if (out.accepted.length >= maxFiles) out.overflow.push(file);
    else out.accepted.push({ file, type });
  }
  return out;
}

/** One-line toast text for rejected files ("a.pdf: not an MP4…; and 3 more"). */
export function rejectionMessage(rejected: Array<{ file: FileLike; reason: string }>): string {
  const shown = rejected.slice(0, 2).map((r) => `${r.file.name}: ${r.reason}`);
  const more = rejected.length - shown.length;
  return `Skipped ${shown.join('; ')}${more > 0 ? `; and ${more} more` : ''}.`;
}
