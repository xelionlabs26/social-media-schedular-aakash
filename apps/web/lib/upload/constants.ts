/**
 * Limits and tuning for the Upload screen and the post editor. Client-safe (no server imports).
 */
import { RULES } from '@app/core/platforms';

/**
 * Largest file we accept: Facebook's cap for a normal Page video (2 GB, PLAN.md §2). Every other
 * platform accepts less, and the media module warns per platform after probing.
 */
export const MAX_FILE_BYTES = RULES.facebook.video.maxBytes;

/** Files per drop / per startUploads call. */
export const MAX_FILES_PER_CALL = 100;

/** MIME type -> file extension we store the original under. */
export const ACCEPTED_VIDEO_TYPES = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
} as const;
export type AcceptedVideoType = keyof typeof ACCEPTED_VIDEO_TYPES;

/** `accept` attribute for the file picker (extensions help when the OS reports no MIME type). */
export const FILE_INPUT_ACCEPT = 'video/mp4,video/quicktime,.mp4,.mov,.m4v';

/** Parallel uploads (PLAN.md §3.2: "3–4 at a time"). */
export const UPLOAD_CONCURRENCY = 3;
/** Tries per file before the card asks for a manual retry. */
export const UPLOAD_MAX_ATTEMPTS = 3;
/** Signed upload URLs live 15 minutes; renew before starting a file whose URL is older than this. */
export const UPLOAD_TARGET_MAX_AGE_MS = 10 * 60_000;
/** Abort and retry an upload request that made no progress for this long. */
export const UPLOAD_STALL_TIMEOUT_MS = 60_000;

/**
 * Chunk size for the local storage driver. Next.js buffers request bodies that pass through
 * proxy.ts and silently cuts them at 10 MB (experimental.proxyClientMaxBodySize, see
 * node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/
 * proxyClientMaxBodySize.md), so local uploads are sent in chunks well below that.
 */
export const LOCAL_CHUNK_BYTES = 8 * 1024 * 1024;
/** Largest chunk the local upload route accepts. */
export const LOCAL_MAX_CHUNK_BYTES = 9 * 1024 * 1024;

/** Upload screen refresh while something is processing. */
export const POLL_INTERVAL_MS = 3000;
/** Editor autosave debounce. */
export const AUTOSAVE_DELAY_MS = 800;

export const NOTES_MAX_CHARS = 2000;
export const TRANSCRIPT_MAX_CHARS = 50_000;
export const FILENAME_MAX_CHARS = 255;
