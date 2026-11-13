/**
 * Claude-powered text generation. (Module owner: ai.) PLAN.md §4.
 *
 * generateForAsset: one Claude call writes every selected platform's text from the video's frames,
 * transcript and notes; code then cleans it, enforces platform limits (one targeted repair call,
 * then deterministic trimming), applies optional templates and saves drafts.
 * refineField: rewrites one field (Regenerate / ⋯ menu) and returns it without saving.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  aiGenerations,
  batches,
  mediaAssets,
  postTargets,
  posts,
  templates,
  type AppSettings,
  type AttentionReason,
  type MediaAsset,
  type Platform,
  type PostTarget,
  type TargetTextSources,
  type Template,
} from '@app/db';
import type { ServiceDeps } from '../deps';
import { loadFramesForAi, type AiFrame } from '../media';
import { getSettings } from '../settings';
import { formatInTz } from '../time';
import type { TargetText } from '../text';
import {
  callClaude,
  getDefaultClaudeClient,
  toAiError,
  type BetaMessage,
  type ClaudeClient,
} from './client';
import { estimateCostUsd, type TokenUsage } from './cost';
import { MOCK_MODEL, mockGenerate, mockRewrite } from './mock';
import {
  applyTemplate,
  baseFilename,
  enforceLimits,
  findRepairs,
  fitTitleTarget,
  readSlot,
  sanitizeOutput,
  slotFor,
  targetTextFromOutput,
  usesCounter,
  writeSlot,
  type RepairEdit,
} from './postprocess';
import {
  ACTION_INSTRUCTIONS,
  PROMPT_VERSION,
  buildFieldTask,
  buildGenerateTask,
  buildRequest,
  buildSystemPrompt,
  buildVideoBlocks,
  type VideoContext,
} from './prompt';
import {
  AiError,
  type AiOutput,
  type OutputSlot,
  type RefineAction,
  type RefineField,
} from './types';

export {
  AiError,
  isAiError,
  REFINE_ACTION_LABELS,
  type AiErrorCategory,
  type AiOutput,
  type RefineAction,
  type RefineField,
} from './types';
export { estimateCostUsd, monthlyCostUsd, MODEL_PRICES, AI_MODELS, type TokenUsage } from './cost';
export { toAiError, type ClaudeClient } from './client';
export { PROMPT_VERSION, buildSystemPrompt } from './prompt';

/** Optional injections (tests, or a worker that wants its own client / frame source). */
export interface AiRunOptions {
  client?: ClaudeClient;
  loadFrames?: (deps: ServiceDeps, assetId: string) => Promise<AiFrame[]>;
}

/** Targets the AI may write to. Anything further along belongs to the scheduling engine. */
const WRITABLE_STATUSES = ['draft', 'failed'] as const;
/** Attention reasons caused by the AI step; a successful run clears them. */
const AI_REASONS: AttentionReason[] = ['ai_failed', 'spend_limit', 'write_manually'];

const FIELDS: RefineField[] = ['title', 'body', 'hashtags', 'tags'];

// ---------------------------------------------------------------------------------------------
// Accounting
// ---------------------------------------------------------------------------------------------

interface Accounting {
  model: string;
  usage: TokenUsage;
  costUsd: number;
  stopReason: string | null;
  requestId: string | null;
}

function newAccounting(model: string): Accounting {
  return {
    model,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
    },
    costUsd: 0,
    stopReason: null,
    requestId: null,
  };
}

/** Adds one response's usage (every response is billed, including retried ones). */
function addUsage(acc: Accounting, message: BetaMessage, requestId: string | null): void {
  const u = message.usage;
  const cc = u.cache_creation;
  const one: TokenUsage = {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWrite5mTokens: cc ? cc.ephemeral_5m_input_tokens : (u.cache_creation_input_tokens ?? 0),
    cacheWrite1hTokens: cc ? cc.ephemeral_1h_input_tokens : 0,
  };
  for (const k of Object.keys(one) as Array<keyof TokenUsage>) acc.usage[k] += one[k];
  // After a server-side fallback the served model can differ; price what actually ran.
  acc.costUsd += estimateCostUsd(message.model || acc.model, one);
  acc.model = message.model || acc.model;
  acc.stopReason = message.stop_reason;
  acc.requestId = requestId ?? acc.requestId;
}

async function recordGeneration(
  deps: ServiceDeps,
  row: {
    assetId: string;
    kind: 'full' | 'field';
    field?: string | null;
    instruction?: string | null;
    effort: string | null;
    acc: Accounting;
    output?: unknown;
    error?: string | null;
  },
): Promise<void> {
  try {
    await deps.db.insert(aiGenerations).values({
      assetId: row.assetId,
      kind: row.kind,
      field: row.field ?? null,
      instruction: row.instruction ?? null,
      model: row.acc.model,
      promptVersion: PROMPT_VERSION,
      effort: row.effort,
      inputTokens: row.acc.usage.inputTokens,
      outputTokens: row.acc.usage.outputTokens,
      cacheReadTokens: row.acc.usage.cacheReadTokens,
      cacheWriteTokens: row.acc.usage.cacheWrite5mTokens + row.acc.usage.cacheWrite1hTokens,
      costUsd: row.acc.costUsd,
      stopReason: row.acc.stopReason,
      requestId: row.acc.requestId,
      output: row.output ?? null,
      error: row.error ?? null,
    });
  } catch (e) {
    // Accounting must never turn a good generation into a failure.
    deps.log.child('ai').error('Could not record ai_generations row', { error: e });
  }
}

// ---------------------------------------------------------------------------------------------
// Shared request context
// ---------------------------------------------------------------------------------------------

interface CallContext {
  deps: ServiceDeps;
  settings: AppSettings;
  asset: MediaAsset;
  video: VideoContext;
  system: string;
  mock: boolean;
  client?: ClaudeClient;
}

async function loadVideoContext(
  deps: ServiceDeps,
  asset: MediaAsset,
  opts: AiRunOptions,
): Promise<VideoContext> {
  let frames: AiFrame[] = [];
  try {
    frames = await (opts.loadFrames ?? loadFramesForAi)(deps, asset.id);
  } catch (e) {
    // Frames may be purged or not extracted; the transcript and notes still carry the story.
    deps.log.child('ai').warn('Frames unavailable; writing from transcript and notes', {
      assetId: asset.id,
      error: e,
    });
  }
  frames = [...frames].sort((a, b) => a.idx - b.idx);
  let batchNotes = '';
  if (asset.batchId) {
    const b = await deps.db
      .select({ notes: batches.notes })
      .from(batches)
      .where(eq(batches.id, asset.batchId))
      .limit(1);
    batchNotes = b[0]?.notes ?? '';
  }
  return { asset, frames, batchNotes };
}

async function buildCallContext(
  deps: ServiceDeps,
  asset: MediaAsset,
  settings: AppSettings,
  opts: AiRunOptions,
): Promise<CallContext> {
  const mock = deps.env.AI_MOCK;
  // Resolve the client before loading frames so a missing key fails fast with a config error.
  const client = mock
    ? undefined
    : (opts.client ?? getDefaultClaudeClient(deps.env.ANTHROPIC_API_KEY));
  return {
    deps,
    settings,
    asset,
    video: await loadVideoContext(deps, asset, opts),
    system: buildSystemPrompt(settings),
    mock,
    client,
  };
}

/** One structured call (or its mock). Usage of every response lands in `acc`. */
async function runCall(
  cc: CallContext,
  task: string,
  acc: Accounting,
  mockResult: () => AiOutput,
): Promise<AiOutput> {
  if (cc.mock) {
    acc.stopReason = 'end_turn';
    return mockResult();
  }
  const params = buildRequest({
    model: cc.settings.aiModel,
    effort: cc.settings.aiEffort,
    system: cc.system,
    videoBlocks: buildVideoBlocks(cc.video),
    task,
  });
  const res = await callClaude(cc.client!, params, {
    log: cc.deps.log.child('ai'),
    onResponse: (m, id) => addUsage(acc, m, id),
  });
  return res.output;
}

// ---------------------------------------------------------------------------------------------
// generateForAsset
// ---------------------------------------------------------------------------------------------

/** Field → whether the target's platform has it (Instagram has no title or tags, etc.). */
function platformFields(platform: Platform): RefineField[] {
  return FIELDS.filter((f) => slotFor(platform, f) !== null);
}

function isManual(t: PostTarget, field: RefineField): boolean {
  return t.textSources[field] === 'manual';
}

function textOf(t: PostTarget): TargetText {
  return { title: t.title, body: t.body, hashtags: t.hashtags, tags: t.tags };
}

async function writableTargets(
  deps: ServiceDeps,
  postId: string,
  platforms?: Platform[],
): Promise<PostTarget[]> {
  const rows = await deps.db
    .select()
    .from(postTargets)
    .where(
      and(eq(postTargets.postId, postId), inArray(postTargets.status, [...WRITABLE_STATUSES])),
    );
  return platforms?.length ? rows.filter((t) => platforms.includes(t.platform)) : rows;
}

/**
 * One Claude call that writes every selected platform's text for the asset's post. Fills only
 * fields whose textSources entry is not 'manual'. Records ai_generations, sets
 * media_assets.coverFrameMs, sets media_assets.status = 'ready'. On refusal/spend/config errors
 * it marks the targets 'failed' with the right attentionReason (no throw); throws
 * AiError('retryable') for retryable errors.
 */
export async function generateForAsset(
  deps: ServiceDeps,
  assetId: string,
  opts: { platforms?: Platform[] } & AiRunOptions = {},
): Promise<{ ok: boolean }> {
  const log = deps.log.child('ai');
  const asset = (
    await deps.db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId)).limit(1)
  )[0];
  if (!asset) {
    log.warn('generateForAsset: asset not found', { assetId });
    return { ok: false };
  }
  await deps.db
    .update(mediaAssets)
    .set({ status: 'processing', processingStep: 'generate' })
    .where(eq(mediaAssets.id, assetId));

  const post = (
    await deps.db
      .select()
      .from(posts)
      .where(and(eq(posts.assetId, assetId), isNull(posts.deletedAt)))
      .limit(1)
  )[0];
  const targets = post ? await writableTargets(deps, post.id, opts.platforms) : [];
  if (targets.length === 0) {
    log.info('generateForAsset: no draft/failed targets to write', { assetId });
    await markAssetReady(deps, assetId, {});
    return { ok: true };
  }

  const settings = await getSettings(deps.db);
  const acc = newAccounting(deps.env.AI_MOCK ? MOCK_MODEL : settings.aiModel);
  const effort = deps.env.AI_MOCK ? null : settings.aiEffort;
  try {
    const cc = await buildCallContext(deps, asset, settings, opts);
    const platforms = [...new Set(targets.map((t) => t.platform))];
    const task = buildGenerateTask({
      platforms,
      manual: manualContext(targets),
      needTitleForFacebook: platforms.includes('facebook') && !platforms.includes('youtube'),
    });
    const raw = await runCall(cc, task, acc, () => mockGenerate(cc.video, platforms));
    await recordGeneration(deps, { assetId, kind: 'full', effort, acc, output: raw });

    let out = sanitizeOutput(raw, settings);
    out = fitTitleTarget(await repairIfNeeded(cc, out, targets, effort));

    const now = deps.now();
    for (const target of targets) {
      await writeTarget(deps, { target, out, asset, settings, now, frames: cc.video.frames });
    }
    const cover = cc.video.frames.find((f) => f.idx === out.cover_frame_index);
    await markAssetReady(deps, assetId, cover ? { coverFrameMs: cover.tMs } : {});
    log.info('Text generated', { assetId, model: acc.model, costUsd: acc.costUsd });
    return { ok: true };
  } catch (e) {
    // Database or programming errors are not AI failures: let the job retry them.
    if (!(e instanceof AiError)) throw e;
    const err = e;
    if (acc.stopReason || acc.costUsd > 0 || err.category !== 'retryable')
      await recordGeneration(deps, {
        assetId,
        kind: 'full',
        effort,
        acc,
        error: `${err.category}: ${err.message}`,
      });
    if (err.category === 'retryable') {
      log.warn('Claude call failed; job will retry', { assetId, error: err.message });
      throw err;
    }
    await recordFailure(deps, { assetId, targets, err, settings });
    return { ok: false };
  }
}

/** Rewrites every non-manual field of every target of the asset (after transcript/notes edits). */
export async function rewriteAll(
  deps: ServiceDeps,
  assetId: string,
  opts: AiRunOptions = {},
): Promise<{ ok: boolean }> {
  return generateForAsset(deps, assetId, opts);
}

/**
 * For the worker's dead-letter path: a generate job that kept failing with retryable errors
 * leaves the asset in 'processing'. This marks the video ready and the targets as needing
 * attention so the owner can write manually or retry.
 */
export async function markAiFailed(
  deps: ServiceDeps,
  assetId: string,
  message = 'Claude could not be reached. Try Rewrite again later or write the text manually.',
): Promise<void> {
  const post = (await deps.db.select().from(posts).where(eq(posts.assetId, assetId)).limit(1))[0];
  const targets = post ? await writableTargets(deps, post.id) : [];
  const settings = await getSettings(deps.db);
  await recordFailure(deps, { assetId, targets, err: new AiError('fatal', message), settings });
}

function manualContext(targets: PostTarget[]): Array<{ slot: string; value: string }> {
  const out: Array<{ slot: string; value: string }> = [];
  for (const t of targets) {
    for (const f of platformFields(t.platform)) {
      if (!isManual(t, f)) continue;
      const v = t[f];
      const value = Array.isArray(v) ? v.join(', ') : v;
      if (value) out.push({ slot: `${t.platform}.${f}`, value });
    }
  }
  return out;
}

/**
 * One targeted repair call when a limit is broken (e.g. "shorten youtube.title to under 60
 * characters"). Only slots that feed a non-manual field are repaired. A failed repair is not
 * fatal: enforceLimits trims deterministically afterwards.
 */
async function repairIfNeeded(
  cc: CallContext,
  out: AiOutput,
  targets: PostTarget[],
  effort: string | null,
): Promise<AiOutput> {
  const platforms = [...new Set(targets.map((t) => t.platform))];
  const needed = (slot: OutputSlot) =>
    targets.some((t) =>
      platformFields(t.platform).some((f) => slotFor(t.platform, f) === slot && !isManual(t, f)),
    );
  const edits: RepairEdit[] = findRepairs(out, platforms).filter((e) => needed(e.slot));
  if (edits.length === 0) return out;

  const acc = newAccounting(cc.mock ? MOCK_MODEL : cc.settings.aiModel);
  const field = edits.map((e) => e.slot).join(',');
  const instruction = edits.map((e) => `${e.slot}: ${e.instruction}`).join('; ');
  try {
    const raw = await runCall(cc, buildFieldTask({ current: out, edits }), acc, () =>
      mockRewrite(out, edits),
    );
    await recordGeneration(cc.deps, {
      assetId: cc.asset.id,
      kind: 'field',
      field,
      instruction,
      effort,
      acc,
      output: raw,
    });
    const fixed = sanitizeOutput(raw, cc.settings);
    let merged = out;
    for (const e of edits) {
      const v = readSlot(fixed, e.slot);
      if (Array.isArray(v) ? v.length : v) merged = writeSlot(merged, e.slot, v);
    }
    return merged;
  } catch (e) {
    const err = toAiError(e);
    await recordGeneration(cc.deps, {
      assetId: cc.asset.id,
      kind: 'field',
      field,
      instruction,
      effort,
      acc,
      error: `${err.category}: ${err.message}`,
    });
    cc.deps.log.child('ai').warn('Repair call failed; trimming instead', { error: err.message });
    return out;
  }
}

/** Bumps a template's counter and returns the new value (used by the {n} token). */
async function nextTemplateNumber(deps: ServiceDeps, templateId: string): Promise<number> {
  const rows = await deps.db
    .update(templates)
    .set({ counter: sql`${templates.counter} + 1` })
    .where(eq(templates.id, templateId))
    .returning({ counter: templates.counter });
  return rows[0]?.counter ?? 1;
}

async function writeTarget(
  deps: ServiceDeps,
  input: {
    target: PostTarget;
    out: AiOutput;
    asset: MediaAsset;
    settings: AppSettings;
    now: Date;
    frames: AiFrame[];
  },
): Promise<void> {
  const { target, out, asset, settings, now } = input;
  const ai = targetTextFromOutput(target.platform, out);
  const fields = platformFields(target.platform);
  const sources: TargetTextSources = { ...target.textSources };
  const next: TargetText = { ...textOf(target) };

  // Templates apply to title/body only, and only for fields the AI owns.
  const active: Template[] = await deps.db
    .select()
    .from(templates)
    .where(and(eq(templates.platform, target.platform), eq(templates.enabled, true)));

  for (const field of fields) {
    if (isManual(target, field)) continue;
    if (field === 'title' || field === 'body') {
      // A Facebook title only exists if the AI wrote one (needed for normal Page videos).
      if (field === 'title' && !ai.title) continue;
      const tpl = active.find((t) => t.field === field && t.mode !== 'ai_only' && t.pattern.trim());
      if (tpl) {
        const n = usesCounter(tpl.pattern) ? await nextTemplateNumber(deps, tpl.id) : tpl.counter;
        next[field] = applyTemplate(tpl, ai[field], {
          aiTitle: ai.title,
          aiBody: ai.body,
          n,
          date: formatInTz(now, 'd MMM yyyy', settings.timezone),
          filename: baseFilename(asset.filename),
        });
        sources[field] = 'template';
      } else {
        next[field] = ai[field];
        sources[field] = 'ai';
      }
    } else {
      next[field] = ai[field];
      sources[field] = 'ai';
    }
  }

  // Hard limits after templates; manual fields stay exactly as the owner typed them.
  const limited = enforceLimits(target.platform, next);
  for (const field of fields) if (!isManual(target, field)) next[field] = limited[field] as never;

  const clearsAttention =
    target.status === 'failed' &&
    (target.attentionReason === null || AI_REASONS.includes(target.attentionReason));
  const cover = input.frames.find((f) => f.idx === out.cover_frame_index);
  const options =
    target.platform === 'instagram' && cover && target.options.thumbOffsetMs === undefined
      ? { ...target.options, thumbOffsetMs: cover.tMs }
      : target.options;

  await deps.db
    .update(postTargets)
    .set({
      title: next.title,
      body: next.body,
      hashtags: next.hashtags,
      tags: next.tags,
      textSources: sources,
      options,
      ...(clearsAttention
        ? { status: 'draft' as const, attentionReason: null, lastError: null, lastErrorCode: null }
        : {}),
      version: sql`${postTargets.version} + 1`,
    })
    // Re-check the status: the owner may have scheduled the post while Claude was writing.
    .where(and(eq(postTargets.id, target.id), inArray(postTargets.status, [...WRITABLE_STATUSES])));
}

async function markAssetReady(
  deps: ServiceDeps,
  assetId: string,
  extra: { coverFrameMs?: number },
): Promise<void> {
  await deps.db
    .update(mediaAssets)
    .set({ status: 'ready', processingStep: null, ...extra })
    .where(eq(mediaAssets.id, assetId));
}

const FAILURE_REASON: Record<Exclude<AiError['category'], 'retryable'>, AttentionReason> = {
  spend: 'spend_limit',
  refusal: 'write_manually',
  config: 'ai_failed',
  fatal: 'ai_failed',
};

/**
 * Non-retryable failure: the video itself is fine (asset → ready), the targets need attention.
 * Spend limits also alert the owner once per day.
 */
async function recordFailure(
  deps: ServiceDeps,
  input: { assetId: string; targets: PostTarget[]; err: AiError; settings: AppSettings },
): Promise<void> {
  const { err } = input;
  const reason = err.category === 'retryable' ? 'ai_failed' : FAILURE_REASON[err.category];
  deps.log.child('ai').warn('Text generation failed', {
    assetId: input.assetId,
    category: err.category,
    error: err.message,
  });
  const ids = input.targets.map((t) => t.id);
  if (ids.length)
    await deps.db
      .update(postTargets)
      .set({
        status: 'failed',
        attentionReason: reason,
        lastError: err.message,
        lastErrorCode: `ai_${err.category}`,
        version: sql`${postTargets.version} + 1`,
      })
      .where(
        and(inArray(postTargets.id, ids), inArray(postTargets.status, [...WRITABLE_STATUSES])),
      );
  await markAssetReady(deps, input.assetId, {});

  if (err.category === 'spend') {
    const day = formatInTz(deps.now(), 'yyyy-MM-dd', input.settings.timezone);
    try {
      await deps.jobs.send('notify', {
        kind: 'spend_limit',
        message: `AI paused: Anthropic spend limit reached or credit too low. Captions are waiting; raise the limit or add credit, then click Rewrite. (${err.message})`,
        dedupeKey: `spend_limit:${day}`,
      });
    } catch (e) {
      deps.log.child('ai').error('Could not queue spend-limit alert', { error: e });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// refineField
// ---------------------------------------------------------------------------------------------

/** The post's current texts in output shape (context for a field rewrite). */
function currentOutput(all: PostTarget[]): AiOutput {
  const by = (p: Platform) => all.find((t) => t.platform === p);
  const ig = by('instagram');
  const yt = by('youtube');
  const fb = by('facebook');
  return {
    summary: '',
    detected_language: 'other',
    story_hook: '',
    cover_frame_index: 0,
    instagram: { caption: ig?.body ?? '', hashtags: ig?.hashtags ?? [] },
    youtube: {
      title: yt?.title || fb?.title || '',
      description: yt?.body ?? '',
      hashtags: yt?.hashtags ?? [],
      tags: yt?.tags ?? [],
    },
    facebook: { text: fb?.body ?? '', hashtags: fb?.hashtags ?? [] },
  };
}

/**
 * Rewrites one field of one target (Regenerate / ⋯ menu) and returns the new value. Does NOT
 * save: the caller saves it through scheduling.updateTargetText (which also handles targets that
 * were already handed to a platform). Throws AiError on failure (category tells the UI what to
 * say: spend / refusal / config / retryable / fatal).
 */
export async function refineField(
  deps: ServiceDeps,
  input: { targetId: string; field: RefineField; action: RefineAction },
  opts: AiRunOptions = {},
): Promise<{ title?: string; body?: string; hashtags?: string[]; tags?: string[] }> {
  const row = (
    await deps.db
      .select({ target: postTargets, asset: mediaAssets })
      .from(postTargets)
      .innerJoin(posts, eq(posts.id, postTargets.postId))
      .innerJoin(mediaAssets, eq(mediaAssets.id, posts.assetId))
      .where(eq(postTargets.id, input.targetId))
      .limit(1)
  )[0];
  if (!row) throw new AiError('fatal', 'That post no longer exists.');
  const { target, asset } = row;
  const slot = slotFor(target.platform, input.field);
  if (!slot) throw new AiError('fatal', `${target.platform} has no ${input.field} field.`);

  const settings = await getSettings(deps.db);
  const all = await deps.db.select().from(postTargets).where(eq(postTargets.postId, target.postId));
  const current = currentOutput(all);
  const edits = [
    { slot, instruction: refineInstruction(target.platform, input.field, input.action) },
  ];
  const acc = newAccounting(deps.env.AI_MOCK ? MOCK_MODEL : settings.aiModel);
  const effort = deps.env.AI_MOCK ? null : settings.aiEffort;
  const field = `${target.platform}.${input.field}`;

  let value: string | string[];
  try {
    const cc = await buildCallContext(deps, asset, settings, opts);
    const raw = await runCall(cc, buildFieldTask({ current, edits }), acc, () =>
      mockRewrite(current, edits, input.action),
    );
    await recordGeneration(deps, {
      assetId: asset.id,
      kind: 'field',
      field,
      instruction: input.action,
      effort,
      acc,
      output: raw,
    });
    value = readSlot(fitTitleTarget(sanitizeOutput(raw, settings)), slot);
  } catch (e) {
    const err = toAiError(e);
    await recordGeneration(deps, {
      assetId: asset.id,
      kind: 'field',
      field,
      instruction: input.action,
      effort,
      acc,
      error: `${err.category}: ${err.message}`,
    });
    throw err;
  }
  if (Array.isArray(value) ? value.length === 0 && input.field !== 'hashtags' : !value)
    throw new AiError('fatal', 'Claude returned an empty value. Try again.');

  // Enforce limits in the context of the target's other fields (e.g. caption + hashtags).
  const candidate: TargetText = { ...textOf(target), [input.field]: value };
  const limited = enforceLimits(target.platform, candidate);
  return { [input.field]: limited[input.field] };
}

function refineInstruction(platform: Platform, field: RefineField, action: RefineAction): string {
  const what =
    platform === 'facebook' && field === 'title'
      ? 'This is the Facebook video title (same rules as a YouTube title). '
      : '';
  return `${what}${ACTION_INSTRUCTIONS[action]} Keep every rule and limit for this field.`;
}
