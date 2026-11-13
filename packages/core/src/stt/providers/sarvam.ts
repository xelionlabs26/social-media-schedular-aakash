/**
 * Sarvam AI Saaras (India-focused), REST /speech-to-text in `codemix` mode for Hinglish.
 * Docs: https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe
 *       https://docs.sarvam.ai/api/getting-started/models/saaras.md
 * The sync REST API accepts at most 30 s of audio, so longer clips are cut into ≤29 s chunks
 * (1 s of margin for container/frame rounding), sent one after another and joined with spaces.
 */
import type { Env } from '../../env';
import { uploadFilename } from '../chunk';
import { primaryHints } from '../hints';
import { requestJson } from '../http';
import type {
  ProviderOptions,
  TranscribeInput,
  TranscriptionProvider,
  TranscriptResult,
} from '../types';
import { audioBlob, readAudio, requireKey, transcribeChunked } from './common';

export const SARVAM_STT_URL = 'https://api.sarvam.ai/speech-to-text';
/** "default, recommended, latest"; keyterms are accepted only on saaras:v4. */
export const SARVAM_MODEL = 'saaras:v4';
/** Code-mixed output: Hindi words in Devanagari, English words kept in Latin script. */
export const SARVAM_MODE = 'codemix';
export const SARVAM_MAX_CHUNK_SECONDS = 29;
/** Sarvam accepts up to 50 keyterms. */
const SARVAM_MAX_KEYTERMS = 50;

/** Languages Saaras accepts as `language_code` (BCP-47 with the -IN region). */
const SARVAM_LANGUAGES = new Set([
  'hi',
  'bn',
  'kn',
  'ml',
  'mr',
  'od',
  'pa',
  'ta',
  'te',
  'gu',
  'en',
]);

interface SarvamResponse {
  request_id?: string | null;
  transcript?: string;
  language_code?: string | null;
}

/**
 * Picks `language_code`. Codemix treats the Indian language as the base and keeps English words
 * in Latin script, so with hints ['hi','en'] we send 'hi-IN' rather than asking it to guess per
 * chunk (a mostly-English 20 s chunk would otherwise flip to English-only output).
 */
export function sarvamLanguageCode(hints: string[]): string {
  const primary = primaryHints(hints).filter((h) => SARVAM_LANGUAGES.has(h));
  const indic = primary.find((h) => h !== 'en');
  if (indic) return `${indic}-IN`;
  if (primary.includes('en')) return 'en-IN';
  return 'unknown';
}

export function createSarvamProvider(env: Env, opts: ProviderOptions = {}): TranscriptionProvider {
  return {
    name: 'sarvam',
    isConfigured: (e: Env) => Boolean(e.SARVAM_API_KEY),
    async transcribe(input: TranscribeInput, signal?: AbortSignal): Promise<TranscriptResult> {
      const key = requireKey(env.SARVAM_API_KEY, 'SARVAM_API_KEY');
      const languageCode = sarvamLanguageCode(input.languageHints);
      const keyterms = input.keywords.slice(0, SARVAM_MAX_KEYTERMS);
      const result = await transcribeChunked(
        input,
        { maxSeconds: SARVAM_MAX_CHUNK_SECONDS },
        env,
        signal,
        async (chunk) => {
          const bytes = await readAudio(chunk.path);
          const filename = uploadFilename(chunk.path, chunk.mimeType);
          const body = await requestJson<SarvamResponse>(
            {
              provider: 'sarvam',
              url: SARVAM_STT_URL,
              headers: { 'api-subscription-key': key },
              secret: key,
              body: () => {
                const form = new FormData();
                form.append('file', audioBlob(bytes, chunk.mimeType), filename);
                form.append('model', SARVAM_MODEL);
                form.append('mode', SARVAM_MODE);
                form.append('language_code', languageCode);
                // The docs' curl example sends keyterms as one JSON-array string field.
                if (keyterms.length) form.append('keyterms', JSON.stringify(keyterms));
                return form;
              },
            },
            opts,
            signal,
          );
          return {
            text: typeof body.transcript === 'string' ? body.transcript : '',
            languages: [body.language_code],
          };
        },
      );
      return { provider: 'sarvam', text: result.text, language: result.language };
    },
  };
}
