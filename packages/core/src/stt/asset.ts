/**
 * transcribeAsset: the worker step between "frames" and "generate" (PLAN.md §4.2 step 5).
 *
 * A missing or failed transcript never blocks the post: the asset gets a warning and the AI
 * writes from frames + notes. Only errors worth retrying are thrown, so the job queue retries.
 */
import { and, eq } from 'drizzle-orm';
import { batches, mediaAssets, type AssetWarning, type Db, type SttProvider } from '@app/db';
import type { ServiceDeps } from '../deps';
import type { ExtractedAudio } from '../media';
import { getSettings } from '../settings';
import { keywordsFromNotes } from './hints';
import { getTranscriber, isSttProvider } from './registry';
import { SttError, type ProviderOptions, type TranscriptionProvider } from './types';

/** Hindi + English code-switching (the owner's videos mix both in the same sentence). */
const LANGUAGE_HINTS = ['hi', 'en'];

export const STT_WARNING_CODES = {
  noSpeech: 'no_speech',
  notConfigured: 'stt_not_configured',
  failed: 'transcribe_failed',
  spend: 'stt_spend_limit',
} as const;

const OWNED_CODES = new Set<string>(Object.values(STT_WARNING_CODES));

export const NOT_CONFIGURED_MESSAGE =
  'Speech-to-text is not set up; captions will use frames and notes only';

export interface TranscribeAssetOptions {
  /**
   * Set on the job's last attempt: a retryable failure then becomes a 'transcribe_failed'
   * warning and returns ok=false instead of throwing, so text generation still runs.
   */
  finalAttempt?: boolean;
  /** Cancels the provider call (e.g. worker shutdown). */
  signal?: AbortSignal;
  /** Swaps fetch/sleep/timeouts (tests). */
  providerOptions?: ProviderOptions;
}

/**
 * Transcribes the asset's audio with the provider chosen in settings and stores the transcript
 * on media_assets (unless the owner edited it). A missing/failed transcript is not fatal: it adds
 * an asset warning and generation continues from frames + notes. Throws SttError('retryable') for
 * errors worth retrying.
 *
 * ok=true: a transcript was stored, or there was nothing to do (owner-edited transcript, no audio).
 * ok=false: no transcript (not configured, failed, out of credit); a warning explains why.
 */
export async function transcribeAsset(
  deps: ServiceDeps,
  assetId: string,
  audio: ExtractedAudio | null,
  options: TranscribeAssetOptions = {},
): Promise<{ ok: boolean }> {
  const log = deps.log.child('stt');
  const asset = (
    await deps.db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId)).limit(1)
  )[0];
  if (!asset) {
    log.warn('Asset not found; skipping transcription', { assetId });
    return { ok: false };
  }

  await deps.db
    .update(mediaAssets)
    .set({ processingStep: 'transcribe' })
    .where(eq(mediaAssets.id, assetId));

  // Text the owner typed is never overwritten (PLAN.md §4.7).
  if (asset.transcriptEdited) {
    log.info('Transcript was edited by the owner; skipping', { assetId });
    return { ok: true };
  }

  if (!audio) {
    await replaceSttWarning(deps.db, assetId, {
      code: STT_WARNING_CODES.noSpeech,
      severity: 'info',
      message: 'No audio track; captions will use frames and notes only',
    });
    return { ok: true };
  }

  const provider = await pickProvider(deps, log, options.providerOptions);
  if (!provider) {
    await replaceSttWarning(deps.db, assetId, {
      code: STT_WARNING_CODES.notConfigured,
      severity: 'warn',
      message: NOT_CONFIGURED_MESSAGE,
    });
    return { ok: false };
  }

  const batchNotes = asset.batchId ? await loadBatchNotes(deps.db, asset.batchId) : '';
  const keywords = keywordsFromNotes(asset.notes, batchNotes);

  let result;
  try {
    result = await provider.transcribe(
      {
        filePath: audio.path,
        mimeType: audio.mimeType,
        durationMs: audio.durationMs,
        languageHints: LANGUAGE_HINTS,
        keywords,
      },
      options.signal,
    );
  } catch (err) {
    if (options.signal?.aborted) throw err;
    return handleFailure(deps, assetId, provider.name, err, options, log);
  }

  const text = result.text.trim();
  const updated = await deps.db.transaction(async (tx) => {
    const current = await lockAsset(tx, assetId);
    if (!current || current.transcriptEdited) return false;
    const warnings = withoutSttWarnings(current.warnings);
    if (!text) {
      warnings.push({
        code: STT_WARNING_CODES.noSpeech,
        severity: 'info',
        message: 'No speech detected; captions will use frames and notes only',
      });
    }
    const rows = await tx
      .update(mediaAssets)
      .set({
        transcript: text,
        transcriptLang: result.language ?? null,
        transcriptProvider: result.provider,
        warnings,
      })
      // Re-checked so an edit made while the provider was working is never overwritten.
      .where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.transcriptEdited, false)))
      .returning({ id: mediaAssets.id });
    return rows.length > 0;
  });

  if (!updated) {
    log.info('Transcript edited (or asset removed) during transcription; result discarded', {
      assetId,
    });
    return { ok: true };
  }
  // Lengths only: transcripts are the owner's private content.
  log.info('Transcribed', {
    assetId,
    provider: result.provider,
    language: result.language ?? null,
    chars: text.length,
  });
  return { ok: true };
}

async function pickProvider(
  deps: ServiceDeps,
  log: ServiceDeps['log'],
  providerOptions: ProviderOptions = {},
): Promise<TranscriptionProvider | null> {
  const settings = await getSettings(deps.db);
  const name: SttProvider | null = isSttProvider(settings.sttProvider)
    ? settings.sttProvider
    : null;
  if (name) {
    try {
      return getTranscriber(name, deps.env, providerOptions);
    } catch (err) {
      if (!(err instanceof SttError && err.category === 'config')) throw err;
    }
  }
  // Local development without any STT account: keep the pipeline flowing with placeholder text.
  if (deps.env.AI_MOCK) {
    log.info('Speech-to-text not configured; using the mock provider (AI_MOCK)', {
      provider: name,
    });
    return getTranscriber('mock', deps.env);
  }
  log.warn('Speech-to-text not configured', { provider: name });
  return null;
}

async function handleFailure(
  deps: ServiceDeps,
  assetId: string,
  provider: SttProvider,
  err: unknown,
  options: TranscribeAssetOptions,
  log: ServiceDeps['log'],
): Promise<{ ok: boolean }> {
  const sttError =
    err instanceof SttError
      ? err
      : new SttError('fatal', err instanceof Error ? err.message : String(err));
  log.warn('Speech-to-text failed', {
    assetId,
    provider,
    category: sttError.category,
    httpStatus: sttError.httpStatus ?? null,
    error: sttError.message,
  });

  switch (sttError.category) {
    case 'retryable':
      if (!options.finalAttempt) throw sttError;
      await replaceSttWarning(deps.db, assetId, {
        code: STT_WARNING_CODES.failed,
        severity: 'warn',
        message: `Speech-to-text (${provider}) could not be reached; captions will use frames and notes only`,
      });
      return { ok: false };
    case 'spend':
      await replaceSttWarning(deps.db, assetId, {
        code: STT_WARNING_CODES.spend,
        severity: 'warn',
        message: `Speech-to-text paused: ${provider} spend limit or credit reached; captions will use frames and notes only`,
      });
      return { ok: false };
    case 'config':
      await replaceSttWarning(deps.db, assetId, {
        code: STT_WARNING_CODES.notConfigured,
        severity: 'warn',
        message: `Speech-to-text (${provider}) rejected the API key; captions will use frames and notes only`,
      });
      return { ok: false };
    case 'fatal':
    default:
      await replaceSttWarning(deps.db, assetId, {
        code: STT_WARNING_CODES.failed,
        severity: 'warn',
        message: `Speech-to-text (${provider}) failed; captions will use frames and notes only`,
      });
      return { ok: false };
  }
}

async function loadBatchNotes(db: Db, batchId: string): Promise<string> {
  const rows = await db
    .select({ notes: batches.notes })
    .from(batches)
    .where(eq(batches.id, batchId))
    .limit(1);
  return rows[0]?.notes ?? '';
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

async function lockAsset(tx: Tx, assetId: string) {
  const rows = await tx
    .select({ warnings: mediaAssets.warnings, transcriptEdited: mediaAssets.transcriptEdited })
    .from(mediaAssets)
    .where(eq(mediaAssets.id, assetId))
    .for('update');
  return rows[0];
}

/** Drops earlier STT warnings so a re-run never shows a stale "failed" next to a transcript. */
function withoutSttWarnings(warnings: AssetWarning[] | null | undefined): AssetWarning[] {
  return (warnings ?? []).filter((w) => !OWNED_CODES.has(w.code));
}

/** Replaces this module's warning on the asset, leaving other modules' warnings untouched. */
async function replaceSttWarning(db: Db, assetId: string, warning: AssetWarning): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await lockAsset(tx, assetId);
    if (!current) return;
    await tx
      .update(mediaAssets)
      .set({ warnings: [...withoutSttWarnings(current.warnings), warning] })
      .where(eq(mediaAssets.id, assetId));
  });
}
