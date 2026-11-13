/**
 * Claude-powered text generation. (Module owner: ai.)
 */
import type { Platform } from '@app/db';
import { NotImplementedError, type ServiceDeps } from '../deps';

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

/** retryable = 429/5xx/network/ramp; spend = spend limit or no credit; refusal; config; fatal. */
export class AiError extends Error {
  constructor(
    public readonly category: 'retryable' | 'spend' | 'refusal' | 'config' | 'fatal',
    message: string,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

/**
 * One Claude call that writes every selected platform's text for the asset's post. Fills only
 * fields whose textSources entry is not 'manual'. Records ai_generations, sets
 * media_assets.coverFrameMs, sets media_assets.status = 'ready'. On refusal/spend/config errors
 * it marks the targets 'failed' with the right attentionReason (no throw); throws
 * AiError('retryable') for retryable errors.
 */
export async function generateForAsset(
  _deps: ServiceDeps,
  _assetId: string,
  _opts: { platforms?: Platform[] } = {},
): Promise<{ ok: boolean }> {
  throw new NotImplementedError('ai.generateForAsset');
}

/** Rewrites one field of one target (Regenerate / ⋯ menu), saves it and returns the new value. */
export async function refineField(
  _deps: ServiceDeps,
  _input: { targetId: string; field: RefineField; action: RefineAction },
): Promise<{ title?: string; body?: string; hashtags?: string[]; tags?: string[] }> {
  throw new NotImplementedError('ai.refineField');
}

/** Rewrites every non-manual field of every target of the asset (after transcript/notes edits). */
export async function rewriteAll(_deps: ServiceDeps, _assetId: string): Promise<{ ok: boolean }> {
  throw new NotImplementedError('ai.rewriteAll');
}
