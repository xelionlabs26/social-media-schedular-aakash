/**
 * Public types of the AI module (kept in their own file so internal files can import them without
 * a cycle through index.ts).
 */
import type { Platform } from '@app/db';

export type RefineField = 'title' | 'body' | 'hashtags' | 'tags';
export type RefineAction = 'regenerate' | 'shorter' | 'longer' | 'casual' | 'formal' | 'viral';

export const REFINE_ACTION_LABELS: Record<RefineAction, string> = {
  regenerate: 'Regenerate',
  shorter: 'Shorter',
  longer: 'Longer',
  casual: 'More casual',
  formal: 'More formal',
  viral: 'More viral',
};

export type AiErrorCategory = 'retryable' | 'spend' | 'refusal' | 'config' | 'fatal';

/** retryable = 429/5xx/network/ramp; spend = spend limit or no credit; refusal; config; fatal. */
export class AiError extends Error {
  constructor(
    public readonly category: AiErrorCategory,
    message: string,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

export function isAiError(e: unknown): e is AiError {
  return e instanceof AiError;
}

/** The JSON Claude returns (one fixed schema for every call, so the prompt cache stays valid). */
export interface AiOutput {
  summary: string;
  detected_language: 'en' | 'hi' | 'hinglish' | 'other';
  story_hook: string;
  cover_frame_index: number;
  instagram: { caption: string; hashtags: string[] };
  youtube: { title: string; description: string; hashtags: string[]; tags: string[] };
  facebook: { text: string; hashtags: string[] };
}

/** Where a target field lives in AiOutput. */
export type OutputSlot =
  | 'instagram.caption'
  | 'instagram.hashtags'
  | 'youtube.title'
  | 'youtube.description'
  | 'youtube.hashtags'
  | 'youtube.tags'
  | 'facebook.text'
  | 'facebook.hashtags';

export interface FieldRef {
  platform: Platform;
  field: RefineField;
}
