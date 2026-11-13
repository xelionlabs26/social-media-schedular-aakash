/**
 * Glue shared by the HTTP providers: reading the audio file and running a per-chunk transcriber
 * over audio that had to be split.
 */
import { promises as fs } from 'node:fs';
import type { Env } from '../../env';
import { chunkAudio, type AudioChunk, type ChunkLimits } from '../chunk';
import { joinTranscripts, normalizeLanguages } from '../hints';
import { SttError, type TranscribeInput } from '../types';

export interface ChunkTranscript {
  text: string;
  languages: Array<string | null | undefined>;
}

export async function readAudio(filePath: string): Promise<Buffer> {
  try {
    return await fs.readFile(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
    throw new SttError('fatal', `Could not read the audio file (${code})`);
  }
}

/** Wraps bytes for fetch/FormData (a fresh Blob per attempt keeps retries independent). */
export function audioBlob(bytes: Uint8Array, mimeType: string): Blob {
  return new Blob([new Uint8Array(bytes)], { type: mimeType || 'application/octet-stream' });
}

/**
 * Splits the audio when it exceeds `limits`, transcribes chunks one after another (keeps the
 * provider's rate limits simple and the order guaranteed) and joins the text with spaces.
 */
export async function transcribeChunked(
  input: TranscribeInput,
  limits: ChunkLimits,
  env: Env,
  signal: AbortSignal | undefined,
  transcribeChunk: (chunk: AudioChunk, index: number, total: number) => Promise<ChunkTranscript>,
): Promise<{ text: string; language?: string }> {
  const split = await chunkAudio(
    { filePath: input.filePath, mimeType: input.mimeType, durationMs: input.durationMs },
    limits,
    { ffmpegPath: env.FFMPEG_PATH, ffprobePath: env.FFPROBE_PATH, workDir: env.WORK_DIR },
    signal,
  );
  try {
    const texts: string[] = [];
    const languages: Array<string | null | undefined> = [];
    for (const [i, chunk] of split.chunks.entries()) {
      signal?.throwIfAborted();
      const result = await transcribeChunk(chunk, i, split.chunks.length);
      texts.push(result.text);
      languages.push(...result.languages);
    }
    return { text: joinTranscripts(texts), language: normalizeLanguages(languages) };
  } finally {
    await split.cleanup();
  }
}

/** Throws SttError('config') when the provider's key is missing. */
export function requireKey(value: string | undefined, envName: string): string {
  if (!value) throw new SttError('config', `${envName} is not set`);
  return value;
}
