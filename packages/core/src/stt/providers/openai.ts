/**
 * OpenAI `gpt-transcribe` (replaces whisper-1 / gpt-4o-transcribe, which shut down 2027-02-26).
 * Docs: https://developers.openai.com/api/docs/guides/speech-to-text
 *       https://developers.openai.com/api/docs/guides/transcription
 */
import type { Env } from '../../env';
import { uploadFilename } from '../chunk';
import { primaryHints, sanitizeKeyword } from '../hints';
import { requestJson } from '../http';
import type {
  ProviderOptions,
  TranscribeInput,
  TranscriptionProvider,
  TranscriptResult,
} from '../types';
import { audioBlob, readAudio, requireKey, transcribeChunked } from './common';

export const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
export const OPENAI_TRANSCRIBE_MODEL = 'gpt-transcribe';
/** The documented cap is 25 MB per file; stay a little under it for multipart overhead. */
export const OPENAI_MAX_BYTES = 24 * 1024 * 1024;

interface OpenAiTranscription {
  text?: string;
  /** gpt-transcribe returns the detected languages; [] when it could not tell. */
  languages?: Array<{ code?: string }>;
}

export function createOpenAiProvider(env: Env, opts: ProviderOptions = {}): TranscriptionProvider {
  return {
    name: 'openai',
    isConfigured: (e: Env) => Boolean(e.OPENAI_API_KEY),
    async transcribe(input: TranscribeInput, signal?: AbortSignal): Promise<TranscriptResult> {
      const key = requireKey(env.OPENAI_API_KEY, 'OPENAI_API_KEY');
      const languages = primaryHints(input.languageHints);
      const keywords = input.keywords.map(sanitizeKeyword).filter(Boolean);
      const result = await transcribeChunked(
        input,
        { maxBytes: OPENAI_MAX_BYTES },
        env,
        signal,
        async (chunk) => {
          const bytes = await readAudio(chunk.path);
          const filename = uploadFilename(chunk.path, chunk.mimeType);
          const body = await requestJson<OpenAiTranscription>(
            {
              provider: 'openai',
              url: OPENAI_TRANSCRIBE_URL,
              headers: { Authorization: `Bearer ${key}` },
              secret: key,
              body: () => {
                const form = new FormData();
                form.append('file', audioBlob(bytes, chunk.mimeType), filename);
                form.append('model', OPENAI_TRANSCRIBE_MODEL);
                // gpt-transcribe takes `languages[]` instead of the single `language` field
                // (never send both) and literal `keywords[]` hints; see the curl example in
                // https://developers.openai.com/api/docs/guides/speech-to-text
                for (const lang of languages) form.append('languages[]', lang);
                for (const kw of keywords) form.append('keywords[]', kw);
                return form;
              },
            },
            opts,
            signal,
          );
          return {
            text: typeof body.text === 'string' ? body.text : '',
            languages: (body.languages ?? []).map((l) => l?.code),
          };
        },
      );
      return { provider: 'openai', text: result.text, language: result.language };
    },
  };
}
