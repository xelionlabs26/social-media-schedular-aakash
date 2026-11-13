/**
 * Provider registry: builds a TranscriptionProvider by name. Kept apart from index.ts so asset.ts
 * can use it without an import cycle.
 */
import { STT_PROVIDERS, type SttProvider } from '@app/db';
import { getEnv, type Env } from '../env';
import { createAssemblyAiProvider } from './providers/assemblyai';
import { createDeepgramProvider } from './providers/deepgram';
import { createMockProvider } from './providers/mock';
import { createOpenAiProvider } from './providers/openai';
import { createSarvamProvider } from './providers/sarvam';
import { SttError, type ProviderOptions, type TranscriptionProvider } from './types';

/** The environment variable that holds each provider's key (for Settings hints). */
export const STT_KEY_ENV: Record<SttProvider, keyof Env | null> = {
  openai: 'OPENAI_API_KEY',
  deepgram: 'DEEPGRAM_API_KEY',
  sarvam: 'SARVAM_API_KEY',
  assemblyai: 'ASSEMBLYAI_API_KEY',
  mock: null,
};

export function isSttProvider(value: unknown): value is SttProvider {
  return typeof value === 'string' && (STT_PROVIDERS as readonly string[]).includes(value);
}

function createProvider(
  name: SttProvider,
  env: Env,
  options: ProviderOptions,
): TranscriptionProvider {
  switch (name) {
    case 'openai':
      return createOpenAiProvider(env, options);
    case 'deepgram':
      return createDeepgramProvider(env, options);
    case 'sarvam':
      return createSarvamProvider(env, options);
    case 'assemblyai':
      return createAssemblyAiProvider(env, options);
    case 'mock':
      return createMockProvider();
    default: {
      const unknown: never = name;
      throw new SttError('config', `Unknown speech-to-text provider: ${String(unknown)}`);
    }
  }
}

/** True when the provider can be used with this environment (its API key is set). */
export function isSttConfigured(name: SttProvider, env: Env = getEnv()): boolean {
  if (!isSttProvider(name)) return false;
  return createProvider(name, env, {}).isConfigured(env);
}

/**
 * Returns the provider. Throws SttError('config') when its API key is missing, so check
 * isSttConfigured() (or provider.isConfigured) first when that is an expected state.
 * `options` swaps fetch/sleep/timeouts (tests).
 */
export function getTranscriber(
  name: SttProvider,
  env: Env = getEnv(),
  options: ProviderOptions = {},
): TranscriptionProvider {
  if (!isSttProvider(name)) {
    throw new SttError('config', `Unknown speech-to-text provider: ${String(name)}`);
  }
  const provider = createProvider(name, env, options);
  if (!provider.isConfigured(env)) {
    const keyName = STT_KEY_ENV[name];
    throw new SttError(
      'config',
      `Speech-to-text provider "${name}" is not configured${keyName ? ` (set ${keyName})` : ''}`,
    );
  }
  return provider;
}
