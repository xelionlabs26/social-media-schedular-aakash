/**
 * Speech-to-text providers behind one interface. (Module owner: stt.)
 *
 * Providers (PLAN.md §4.8): OpenAI gpt-transcribe, Deepgram Nova-3 (multi), Sarvam Saaras
 * (codemix) and AssemblyAI Universal-3.5 Pro, plus a mock for local development. The owner picks
 * one in Settings (app_settings.stt_provider); its API key comes from the environment.
 */
export {
  SttError,
  type ProviderOptions,
  type SttErrorCategory,
  type TranscribeInput,
  type TranscriptionProvider,
  type TranscriptResult,
} from './types';
export { getTranscriber, isSttConfigured, isSttProvider, STT_KEY_ENV } from './registry';
export {
  transcribeAsset,
  STT_WARNING_CODES,
  NOT_CONFIGURED_MESSAGE,
  type TranscribeAssetOptions,
} from './asset';
export {
  chunkAudio,
  planSegments,
  type AudioChunk,
  type ChunkLimits,
  type ChunkedAudio,
} from './chunk';
export { keywordsFromNotes, normalizeLanguages } from './hints';
