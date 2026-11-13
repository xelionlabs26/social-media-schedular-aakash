/**
 * Deepgram Nova-3, pre-recorded endpoint with the audio as the raw request body.
 * Docs: https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded
 *       https://developers.deepgram.com/docs/multilingual-code-switching (language=multi, incl. Hindi)
 *       https://developers.deepgram.com/docs/keyterm (repeat `keyterm`, Nova-3 only, ≤500 tokens)
 *       https://developers.deepgram.com/docs/errors (402 ASR_PAYMENT_REQUIRED, err_code/err_msg)
 */
import type { Env } from '../../env';
import { normalizeLanguages, primaryHints } from '../hints';
import { requestJson } from '../http';
import type {
  ProviderOptions,
  TranscribeInput,
  TranscriptionProvider,
  TranscriptResult,
} from '../types';
import { readAudio, requireKey } from './common';

export const DEEPGRAM_LISTEN_URL = 'https://api.deepgram.com/v1/listen';
export const DEEPGRAM_MODEL = 'nova-3';

interface DeepgramResponse {
  results?: {
    channels?: Array<{
      detected_language?: string;
      alternatives?: Array<{ transcript?: string; languages?: string[] }>;
    }>;
  };
}

/** Builds the /v1/listen URL. Exported for tests. */
export function deepgramUrl(input: Pick<TranscribeInput, 'languageHints' | 'keywords'>): string {
  const hints = primaryHints(input.languageHints);
  const params = new URLSearchParams();
  params.set('model', DEEPGRAM_MODEL);
  // Several hints (Hindi + English in one sentence) need multilingual code-switching mode;
  // a single hint is passed through as the primary language.
  params.set('language', hints.length === 1 ? hints[0]! : 'multi');
  params.set('smart_format', 'true');
  params.set('punctuate', 'true');
  // One `keyterm` per term; a comma-joined value would be treated as one literal phrase.
  for (const kw of input.keywords) params.append('keyterm', kw);
  return `${DEEPGRAM_LISTEN_URL}?${params.toString()}`;
}

export function createDeepgramProvider(
  env: Env,
  opts: ProviderOptions = {},
): TranscriptionProvider {
  return {
    name: 'deepgram',
    isConfigured: (e: Env) => Boolean(e.DEEPGRAM_API_KEY),
    async transcribe(input: TranscribeInput, signal?: AbortSignal): Promise<TranscriptResult> {
      const key = requireKey(env.DEEPGRAM_API_KEY, 'DEEPGRAM_API_KEY');
      // Pre-recorded accepts files far larger than our clips, so no chunking is needed.
      const bytes = await readAudio(input.filePath);
      const body = await requestJson<DeepgramResponse>(
        {
          provider: 'deepgram',
          url: deepgramUrl(input),
          headers: {
            Authorization: `Token ${key}`,
            'Content-Type': input.mimeType || 'application/octet-stream',
          },
          secret: key,
          body: () => new Uint8Array(bytes),
        },
        opts,
        signal,
      );
      const channel = body.results?.channels?.[0];
      const alt = channel?.alternatives?.[0];
      return {
        provider: 'deepgram',
        text: (alt?.transcript ?? '').trim(),
        language: normalizeLanguages([...(alt?.languages ?? []), channel?.detected_language]),
      };
    },
  };
}
