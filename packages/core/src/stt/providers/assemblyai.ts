/**
 * AssemblyAI Universal-3.5 Pro: upload → create transcript → poll.
 * Docs: https://www.assemblyai.com/docs/api-reference/files/upload.md
 *       https://www.assemblyai.com/docs/api-reference/transcripts/submit.md
 *       https://www.assemblyai.com/docs/pre-recorded-audio/code-switching.md
 *       https://www.assemblyai.com/docs/pre-recorded-audio/universal-3-5-pro.md
 */
import type { Env } from '../../env';
import { normalizeLanguages, primaryHints } from '../hints';
import { classifyMessage, defaultSleep, requestJson } from '../http';
import {
  SttError,
  type ProviderOptions,
  type TranscribeInput,
  type TranscriptionProvider,
  type TranscriptResult,
} from '../types';
import { readAudio, requireKey } from './common';

export const ASSEMBLYAI_BASE_URL = 'https://api.assemblyai.com';
export const ASSEMBLYAI_MODEL = 'universal-3-5-pro';
/** Universal-3.5 Pro covers 18 languages; anything else falls through to Universal-2. */
const ASSEMBLYAI_FALLBACK_MODEL = 'universal-2';
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_MAX_POLL_MS = 10 * 60_000;

interface UploadResponse {
  upload_url?: string;
}

interface TranscriptResponse {
  id?: string;
  status?: 'queued' | 'processing' | 'completed' | 'error';
  text?: string | null;
  error?: string | null;
  language_code?: string | null;
  language_codes?: string[] | null;
}

/**
 * The create-transcript body. Exported for tests.
 * - Several hints → `language_codes` (the code-switching constraint; one of them must be 'en').
 * - One hint → `language_code`.
 * - Otherwise → automatic language detection with a Universal-2 fallback.
 * `keyterms_prompt` and `prompt` are mutually exclusive on async requests, so only keyterms
 * (names/places from the owner's notes) are sent.
 */
export function assemblyAiTranscriptBody(
  audioUrl: string,
  input: Pick<TranscribeInput, 'languageHints' | 'keywords'>,
): Record<string, unknown> {
  const hints = primaryHints(input.languageHints);
  const body: Record<string, unknown> = { audio_url: audioUrl, punctuate: true, format_text: true };
  if (hints.length > 1 && hints.includes('en')) {
    body.speech_models = [ASSEMBLYAI_MODEL];
    body.language_codes = hints;
  } else if (hints.length === 1) {
    body.speech_models = [ASSEMBLYAI_MODEL, ASSEMBLYAI_FALLBACK_MODEL];
    body.language_code = hints[0];
  } else {
    body.speech_models = [ASSEMBLYAI_MODEL, ASSEMBLYAI_FALLBACK_MODEL];
    body.language_detection = true;
  }
  // Max 6 words per phrase (hints.ts already enforces it).
  if (input.keywords.length) body.keyterms_prompt = input.keywords;
  return body;
}

export function createAssemblyAiProvider(
  env: Env,
  opts: ProviderOptions = {},
): TranscriptionProvider {
  const sleep = opts.sleep ?? defaultSleep;
  return {
    name: 'assemblyai',
    isConfigured: (e: Env) => Boolean(e.ASSEMBLYAI_API_KEY),
    async transcribe(input: TranscribeInput, signal?: AbortSignal): Promise<TranscriptResult> {
      const key = requireKey(env.ASSEMBLYAI_API_KEY, 'ASSEMBLYAI_API_KEY');
      const headers = { authorization: key };
      const bytes = await readAudio(input.filePath);

      const upload = await requestJson<UploadResponse>(
        {
          provider: 'assemblyai',
          url: `${ASSEMBLYAI_BASE_URL}/v2/upload`,
          headers: { ...headers, 'Content-Type': 'application/octet-stream' },
          secret: key,
          body: () => new Uint8Array(bytes),
        },
        opts,
        signal,
      );
      if (!upload.upload_url) {
        throw new SttError('retryable', 'assemblyai upload returned no upload_url');
      }

      const created = await requestJson<TranscriptResponse>(
        {
          provider: 'assemblyai',
          url: `${ASSEMBLYAI_BASE_URL}/v2/transcript`,
          headers: { ...headers, 'Content-Type': 'application/json' },
          secret: key,
          body: () => JSON.stringify(assemblyAiTranscriptBody(upload.upload_url!, input)),
        },
        opts,
        signal,
      );
      if (!created.id) throw new SttError('retryable', 'assemblyai returned no transcript id');

      const done = await pollTranscript(created, key, opts, sleep, signal);
      return {
        provider: 'assemblyai',
        text: (done.text ?? '').trim(),
        language: normalizeLanguages([...(done.language_codes ?? []), done.language_code]),
      };
    },
  };
}

async function pollTranscript(
  first: TranscriptResponse,
  key: string,
  opts: ProviderOptions,
  sleep: NonNullable<ProviderOptions['sleep']>,
  signal?: AbortSignal,
): Promise<TranscriptResponse> {
  const interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxPolls = Math.max(1, Math.ceil((opts.maxPollMs ?? DEFAULT_MAX_POLL_MS) / interval));
  let current = first;
  for (let poll = 0; ; poll++) {
    if (current.status === 'completed') return current;
    if (current.status === 'error') {
      // The job ran and failed (e.g. no audio stream, unsupported file): retrying won't help.
      throw classifyMessage('assemblyai', current.error || 'transcription failed');
    }
    if (poll >= maxPolls) {
      throw new SttError('retryable', 'assemblyai transcription is still processing; will retry');
    }
    await sleep(interval, signal);
    current = await requestJson<TranscriptResponse>(
      {
        provider: 'assemblyai',
        url: `${ASSEMBLYAI_BASE_URL}/v2/transcript/${encodeURIComponent(first.id!)}`,
        method: 'GET',
        headers: { authorization: key },
        secret: key,
      },
      opts,
      signal,
    );
  }
}
