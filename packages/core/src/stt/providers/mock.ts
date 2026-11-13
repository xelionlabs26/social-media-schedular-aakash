/**
 * Deterministic placeholder transcript for local development (AI_MOCK) and tests. Makes no
 * network calls and reads no files, so the pipeline runs without any STT account.
 */
import type { Env } from '../../env';
import type { TranscribeInput, TranscriptionProvider, TranscriptResult } from '../types';

export function mockTranscript(input: Pick<TranscribeInput, 'durationMs' | 'keywords'>): string {
  const seconds = Math.max(0, Math.round(input.durationMs / 1000));
  const about = input.keywords.length ? ` Aaj ki kahani: ${input.keywords.join(', ')}.` : '';
  return (
    `[Mock transcript, ${seconds}s] Namaste dosto! Aaj main aapko ek interesting story ` +
    `sunata hoon.${about} Last mein jo hua, woh dekh ke aap shocked ho jaoge. Video end tak ` +
    `zaroor dekhna!`
  );
}

export function createMockProvider(): TranscriptionProvider {
  return {
    name: 'mock',
    isConfigured: (_env: Env) => true,
    async transcribe(input: TranscribeInput, signal?: AbortSignal): Promise<TranscriptResult> {
      signal?.throwIfAborted();
      return { provider: 'mock', text: mockTranscript(input), language: 'hi,en' };
    },
  };
}
