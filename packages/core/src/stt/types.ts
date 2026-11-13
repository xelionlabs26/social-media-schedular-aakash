/**
 * Shared STT types. Kept in their own file so provider modules can import them without a cycle
 * through index.ts.
 */
import type { SttProvider } from '@app/db';
import type { Env } from '../env';

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
  /**
   * Detected language(s) as lowercase primary subtags joined by commas, e.g. 'hi,en'.
   * Undefined when the provider could not tell.
   */
  language?: string;
  provider: SttProvider;
}

export interface TranscriptionProvider {
  readonly name: SttProvider;
  isConfigured(env: Env): boolean;
  transcribe(input: TranscribeInput, signal?: AbortSignal): Promise<TranscriptResult>;
}

export type SttErrorCategory = 'retryable' | 'config' | 'spend' | 'fatal';

/** retryable = network/5xx/429; config = missing key; spend = out of credit; fatal = other. */
export class SttError extends Error {
  constructor(
    public readonly category: SttErrorCategory,
    message: string,
    public readonly httpStatus?: number,
    /** From the provider's Retry-After header, when it sent one. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'SttError';
  }
}

/** Injectable plumbing so tests (and callers) can swap network, clock and limits. */
export interface ProviderOptions {
  fetch?: typeof fetch;
  /** Waits between retries / polls. Must reject when the signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Per-request timeout. Default 120 s (a 60 s clip normally takes a few seconds). */
  timeoutMs?: number;
  /** In-process attempts per HTTP call for retryable errors before giving up. Default 3. */
  maxAttempts?: number;
  /** AssemblyAI only: wait between status polls. Default 3 s (as in AssemblyAI's examples). */
  pollIntervalMs?: number;
  /** AssemblyAI only: give up polling after this long (then the job retries). Default 10 min. */
  maxPollMs?: number;
}
