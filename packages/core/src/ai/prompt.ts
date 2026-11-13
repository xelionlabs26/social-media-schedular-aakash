/**
 * Prompt + request building (PLAN.md §4.4–§4.5).
 *
 * Cache layout (prefix match: tools → system → messages):
 *   system  [brand voice + rules]                        cache_control 1h  ← shared by all videos
 *   user    [frame label, image] × N, [video context]    cache_control 1h  ← shared by every call
 *                                                                            for this video
 *   user    [task text]                                  (not cached: differs per call)
 * Both breakpoints use the 1-hour TTL because a longer-TTL entry may not follow a shorter one,
 * and Regenerate clicks often come more than 5 minutes after the first generation.
 * The output schema is identical for every call: changing output_config.format invalidates the
 * prompt cache (https://platform.claude.com/docs/en/build-with-claude/structured-outputs).
 * Nothing volatile (dates, ids, selected platforms) goes before the second breakpoint.
 */
import type { AppSettings, CaptionScript, MediaAsset, Platform } from '@app/db';
import type {
  BetaContentBlockParam,
  BetaMessageStreamParams,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { AiFrame } from '../media';
import { PLATFORM_LABELS, RULES } from '../platforms/rules';
import { DEFAULT_MAX_TOKENS, FALLBACK_BETA, FALLBACK_MODELS } from './client';
import type { AiOutput, OutputSlot, RefineAction } from './types';

/** Bump when the prompt or schema changes meaningfully (stored on ai_generations). */
export const PROMPT_VERSION = '2026-11-13.1';

// ---------------------------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------------------------

const S = { type: 'string' } as const;
const LIST = { type: 'array', items: { type: 'string' } } as const;
const obj = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** Structured-output schema. No min/max constraints: the API doesn't support them; code checks. */
export const OUTPUT_JSON_SCHEMA: Record<string, unknown> = obj({
  summary: { ...S, description: 'One line: what happens in the video.' },
  detected_language: { type: 'string', enum: ['en', 'hi', 'hinglish', 'other'] },
  story_hook: { ...S, description: 'The single most surprising or emotional moment, one line.' },
  cover_frame_index: {
    type: 'integer',
    description: 'Number of the most eye-catching frame (the N in "Frame N"); 0 if no frames.',
  },
  instagram: obj({ caption: S, hashtags: LIST }),
  youtube: obj({ title: S, description: S, hashtags: LIST, tags: LIST }),
  facebook: obj({ text: S, hashtags: LIST }),
});

// ---------------------------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------------------------

const SCRIPT_RULE: Record<CaptionScript, string> = {
  hinglish_roman:
    'Hinglish in Roman letters: the natural Hindi + English mix people type on their phones, written only in the Latin alphabet (for example "Socha tha normal sunset hoga… phir ye hua"). Never use Devanagari here.',
  english: 'Simple, natural English only.',
  hindi_devanagari:
    'Hindi in Devanagari script. English words that people normally say in English (brand names, "vlog", "reel") may stay in Latin letters.',
};

const EMOJI_RULE: Record<AppSettings['emojiLevel'], string> = {
  none: 'Do not use emojis anywhere.',
  light: 'Use at most 1–2 fitting emojis per caption or description, never in the YouTube title.',
  heavy:
    'Emojis are welcome in captions and descriptions (a few per text) when they fit the mood; at most one in the YouTube title.',
};

function hashtagRule(settings: AppSettings, platform: Platform): string {
  const r = settings.hashtagCounts[platform];
  const max = platform === 'instagram' ? Math.min(r.max, RULES.instagram.hashtagsMax) : r.max;
  const min = Math.min(r.min, max);
  if (max <= 0) return 'no hashtags: return an empty hashtags list';
  return min === max ? `exactly ${max} hashtags` : `${min}–${max} hashtags`;
}

function section(title: string, body: string): string {
  return `## ${title}\n${body.trim()}\n`;
}

/**
 * The cached system prompt. Depends only on settings, so every video shares one cache entry
 * until the owner edits AI settings. Long on purpose: the brand voice, rules and examples are
 * what make the writing good, and the prompt must be ≥512 tokens for the cache to engage.
 */
export function buildSystemPrompt(settings: AppSettings): string {
  const script = settings.captionScript;
  const banned = settings.bannedWords
    .split(/[\n,]+/)
    .map((w) => w.trim())
    .filter(Boolean);
  const parts = [
    `You write the social media text for one creator's short vertical videos (~60 seconds; Instagram Reels, YouTube Shorts and Facebook Page Reels). The creator speaks Hindi and English mixed together, often in the same sentence. For each video you get still frames with timestamps, a speech-to-text transcript, the creator's own notes, the video length and the file name. You turn that into scroll-stopping, honest, story-driven text for each platform. The creator reviews and edits everything before it is posted, so write the version you would be proud to publish as is.`,
    section(
      'Style: viral, story-first',
      `- Every video is a small story. Before writing, find its hook: the surprise, the emotion, the twist or the payoff that makes someone stop scrolling. Lead with it.
- Create curiosity without lying. Tease what happens; never promise something the video does not deliver. No fake claims, no misleading clickbait, no "you won't believe" filler, no ALL CAPS shouting.
- Short lines, spoken rhythm, concrete details from the video (what is seen or heard), not generic adjectives.
- Sound like the creator talking to a friend, not like a brand or an announcer.
- Vary openings between videos; avoid starting every text with the same word.`,
    ),
    section(
      'Hard rules (never break these)',
      `- Describe only what is seen in the frames or heard in the transcript, plus facts in the creator's notes. Never invent places, numbers, names, events, prices or outcomes.
- Never name or identify a person unless the creator's notes name them. Do not guess who someone is from their face.
- If there is no speech (music-only clip) or the transcript is empty or garbled, rely on the frames and notes, and keep the text more general rather than guessing.
- The transcript comes from speech-to-text and can contain mistakes; prefer the notes when they disagree.
- No links or URLs anywhere. No @mentions unless the notes ask for one.
- Never put hashtags inside a title, caption, description or text field: hashtags go only in the separate hashtags lists (the app adds them at the end). Write hashtags without the # sign, no spaces inside a hashtag.
- Fill only the platforms the task asks for; leave every field of the other platforms empty ("" or []).`,
    ),
    section(
      'YouTube Shorts',
      `- title: a story hook of at most ${RULES.youtube.titleTargetChars} characters so it reads fully on a phone. NO hashtags, NO links, NO series or episode numbers, no quotes around it, no "Shorts". It must make sense on its own.
- description: the hook again in the first 1–2 lines (only these show before "more"), then 2–3 short lines of story context. No links. No hashtags inside it.
- hashtags: ${hashtagRule(settings, 'youtube')}, relevant to the story (the app appends them to the description).
- tags: 5–15 search keywords or short phrases people would type to find this video, mixing English and common Hinglish spellings, no # sign, all tags together under ${RULES.youtube.tagsMaxChars - 100} characters.
- Never use the characters < or >.
- Language/script: ${SCRIPT_RULE[script.youtube]}`,
    ),
    section(
      'Instagram Reels',
      `- caption: the hook in the very first line (it is all people see before "more"), then 2–4 short story lines, then a soft question or call to action that invites comments (not "like and subscribe"). Keep it well under ${RULES.instagram.captionMaxChars} characters; 300–600 is ideal. No hashtags inside it.
- hashtags: ${hashtagRule(settings, 'instagram')} (Instagram allows at most ${RULES.instagram.hashtagsMax}); a mix of specific and broader tags that match the story.
- Language/script: ${SCRIPT_RULE[script.instagram]}`,
    ),
    section(
      'Facebook Page Reels',
      `- text: conversational story text with the same hook, 2–5 short lines, ending with a natural question or reaction prompt. No hashtags inside it.
- hashtags: ${hashtagRule(settings, 'facebook')}.
- Language/script: ${SCRIPT_RULE[script.facebook]}`,
    ),
    section(
      'Other fields',
      `- summary: one plain line describing what happens in the video (for the creator, not for posting).
- detected_language: the main spoken language: "en", "hi", "hinglish" (mixed) or "other"; use the frames' text if there is no speech.
- story_hook: the single most surprising or emotional moment, in one line.
- cover_frame_index: the N of the frame ("Frame N") that would make the best cover: sharp, expressive, shows the subject; 0 if there are no frames.`,
    ),
    section('Emojis', EMOJI_RULE[settings.emojiLevel]),
    section(
      'Words never to use',
      banned.length ? banned.map((w) => `- ${w}`).join('\n') : '(none listed)',
    ),
    section(
      "The creator's brand voice",
      settings.brandVoice.trim() ||
        '(not provided) Warm, curious and real: a creator sharing moments from their life with friends, a little playful, never salesy.',
    ),
    section(
      "Examples of the creator's past captions and titles (match this voice; never copy them)",
      settings.exampleCaptions.trim() ||
        `(none provided) For tone only:
- Title: "Socha tha normal sunset hoga… phir ye hua"
- Caption first line: "Bas 2 minute ke liye ruke the, aur pura plan badal gaya 😅"`,
    ),
  ];
  return parts.join('\n');
}

// ---------------------------------------------------------------------------------------------
// User turn
// ---------------------------------------------------------------------------------------------

export interface VideoContext {
  asset: Pick<MediaAsset, 'filename' | 'durationMs' | 'transcript' | 'notes'>;
  batchNotes?: string;
  frames: AiFrame[];
}

function quoteBlock(text: string): string {
  return `"""\n${text.trim()}\n"""`;
}

/** Frames + video context, ending with the 1-hour cache breakpoint. Identical for every call. */
export function buildVideoBlocks(ctx: VideoContext): BetaContentBlockParam[] {
  const blocks: BetaContentBlockParam[] = [];
  for (const f of ctx.frames) {
    blocks.push({
      type: 'text',
      text: `Frame ${f.idx} at ${(f.tMs / 1000).toFixed(1)} s (${f.source})`,
    });
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: f.jpeg.toString('base64') },
    });
  }
  const { asset } = ctx;
  const transcript = asset.transcript?.trim();
  const notes = [asset.notes.trim(), ctx.batchNotes?.trim() ?? ''].filter(Boolean).join('\n');
  const lines = [
    'VIDEO',
    `File name: ${asset.filename}`,
    `Length: ${asset.durationMs ? `${(asset.durationMs / 1000).toFixed(1)} s` : 'unknown'}`,
    `Frames: ${ctx.frames.length ? `${ctx.frames.length} (above)` : 'none available, rely on the transcript and notes'}`,
    '',
    'Transcript (speech-to-text; may mix Hindi and English and contain mistakes):',
    transcript ? quoteBlock(transcript) : '(no speech detected: rely on the frames and notes)',
    '',
    "Creator's notes (trusted facts; names here may be used):",
    notes ? quoteBlock(notes) : '(none)',
  ];
  blocks.push({
    type: 'text',
    text: lines.join('\n'),
    cache_control: { type: 'ephemeral', ttl: '1h' },
  });
  return blocks;
}

const PLATFORM_FIELDS: Record<Platform, string> = {
  instagram: 'instagram.caption + instagram.hashtags',
  youtube: 'youtube.title + youtube.description + youtube.hashtags + youtube.tags',
  facebook: 'facebook.text + facebook.hashtags',
};

/** Task text for a full generation. */
export function buildGenerateTask(input: {
  platforms: Platform[];
  /** Fields the creator wrote by hand: shown so the rest stays consistent. */
  manual: Array<{ slot: string; value: string }>;
  /** Facebook needs a title (normal Page video) but YouTube isn't selected. */
  needTitleForFacebook: boolean;
}): string {
  const wanted = input.platforms.map((p) => `- ${PLATFORM_LABELS[p]}: ${PLATFORM_FIELDS[p]}`);
  if (input.needTitleForFacebook)
    wanted.push(
      '- youtube.title only (used as the Facebook video title); other YouTube fields empty',
    );
  const lines = [
    'TASK',
    'Write the text for these platforms, following every rule in your instructions:',
    ...wanted,
    'Leave all other platform fields empty. Always fill summary, detected_language, story_hook and cover_frame_index.',
  ];
  if (input.manual.length) {
    lines.push(
      '',
      'The creator already wrote these fields by hand; they will be kept as is. Keep your other text consistent with them:',
      ...input.manual.map((m) => `- ${m.slot}: ${JSON.stringify(m.value)}`),
    );
  }
  return lines.join('\n');
}

export const ACTION_INSTRUCTIONS: Record<RefineAction, string> = {
  regenerate: 'Write a fresh alternative with a different hook angle than the current version.',
  shorter: 'Make it clearly shorter (roughly half), keeping the hook.',
  longer:
    'Make it a little longer with one or two more story details that are really in the video, staying within the limits.',
  casual: 'Make it more casual and conversational, like talking to a close friend.',
  formal: 'Make it more polished and formal, while staying warm and human.',
  viral:
    'Make the hook stronger and more curiosity-driven, without exaggerating or inventing anything.',
};

/**
 * Task text for rewriting individual fields (Refine menu and the limit-repair call). Uses the same
 * output schema as full generation so the cached prefix is reused; only the named slots are
 * filled.
 */
export function buildFieldTask(input: {
  current: AiOutput;
  edits: Array<{ slot: OutputSlot; instruction: string }>;
}): string {
  const current = {
    instagram: input.current.instagram,
    youtube: input.current.youtube,
    facebook: input.current.facebook,
  };
  return [
    'CURRENT TEXT (all platforms, for context):',
    JSON.stringify(current, null, 2),
    '',
    'TASK',
    'Rewrite only these fields, following every rule in your instructions:',
    ...input.edits.map((e) => `- ${e.slot}: ${e.instruction}`),
    'Return the full JSON object, but leave every other platform field empty ("" or []). Set summary and story_hook to "", detected_language to the spoken language, and cover_frame_index to 0.',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------------------------

export interface RequestInput {
  model: string;
  effort: AppSettings['aiEffort'];
  system: string;
  videoBlocks: BetaContentBlockParam[];
  task: string;
}

/**
 * The Messages request. Deliberately absent: temperature/top_p/top_k (rejected on current
 * models), `thinking` (Opus 5.5 can't disable it; adaptive is the default), assistant prefill
 * and forced tool_choice (both 400 on Opus 5.5). Effort is pinned per settings so the cache
 * stays valid between calls.
 */
export function buildRequest(input: RequestInput): BetaMessageStreamParams {
  const params: BetaMessageStreamParams = {
    model: input.model,
    max_tokens: DEFAULT_MAX_TOKENS,
    system: [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [
      {
        role: 'user',
        content: [...input.videoBlocks, { type: 'text', text: input.task }],
      },
    ],
    output_config: {
      effort: input.effort,
      format: { type: 'json_schema', schema: OUTPUT_JSON_SCHEMA },
    },
  };
  if (FALLBACK_MODELS.has(input.model)) {
    // Server-side refusal fallback, routed by refusal category
    // (https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback).
    params.betas = [FALLBACK_BETA];
    params.fallbacks = 'default';
  }
  return params;
}
