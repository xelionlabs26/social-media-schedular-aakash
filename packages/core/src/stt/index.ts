/**
 * Speech-to-text providers behind one interface. (Module owner: stt.)
 */
import type { SttProvider } from '@app/db';
import type { Env } from '../env';
import { NotImplementedError, type ServiceDeps } from '../deps';
import type { ExtractedAudio } from '../media';

export interface TranscribeInput {
  filePath: string;
  mimeType: string;
  durationMs: number;
  /** BCP-47 hints, e.g. ['hi', 'en'] for Hindi + English code-switching. */
  languageHints: string[];
  /** Names, places, recurring terms (from the owner's notes). */
  keywords: string[];
}

export interface TranscriptResult {
  text: string;
  language?: string;
  provider: SttProvider;
}

export interface TranscriptionProvider {
  readonly name: SttProvider;
  isConfigured(env: Env): boolean;
  transcribe(input: TranscribeInput, signal?: AbortSignal): Promise<TranscriptResult>;
}

/** retryable = network/5xx/429; config = missing key; spend = out of credit; fatal = other. */
export class SttError extends Error {
  constructor(
    public readonly category: 'retryable' | 'config' | 'spend' | 'fatal',
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'SttError';
  }
}

export function getTranscriber(_name: SttProvider, _env?: Env): TranscriptionProvider {
  throw new NotImplementedError('stt.getTranscriber');
}

/**
 * Transcribes the asset's audio with the provider chosen in settings and stores the transcript
 * on media_assets (unless the owner edited it). A missing/failed transcript is not fatal: it adds
 * an asset warning and generation continues from frames + notes. Throws SttError('retryable') for
 * errors worth retrying.
 */
export async function transcribeAsset(
  _deps: ServiceDeps,
  _assetId: string,
  _audio: ExtractedAudio | null,
): Promise<{ ok: boolean }> {
  throw new NotImplementedError('stt.transcribeAsset');
}
