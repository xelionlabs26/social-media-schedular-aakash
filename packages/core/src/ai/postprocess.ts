/**
 * Post-processing of Claude's output. Limits are enforced here in code, never trusted to the
 * model (PLAN.md §4.6). Pure functions only.
 */
import type { AppSettings, Platform, Template } from '@app/db';
import { RULES } from '../platforms/rules';
import {
  charCount,
  composeFinalBody,
  normalizeHashtags,
  stripAngleBrackets,
  trimToBytes,
  trimToChars,
  utf8Bytes,
  validateTargetText,
  youtubeTagsLength,
  type TargetText,
  type TextIssue,
} from '../text';
import type { AiOutput, OutputSlot, RefineField } from './types';

// ---------------------------------------------------------------------------------------------
// Cleaning
// ---------------------------------------------------------------------------------------------

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const HASHTAG_RE = /(^|\s)#([\p{L}\p{N}_]+)/gu;
const HASHTAG_ONLY_LINE = /^\s*(?:#[\p{L}\p{N}_]+\s*)+$/u;

/** Owner decision: no links anywhere. */
export function stripLinks(text: string): string {
  return text.replace(URL_RE, '').replace(/[ \t]{2,}/g, ' ');
}

function tidy(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Bodies must not carry hashtags (they are appended from the hashtags list at publish time).
 * Trailing hashtag-only lines move into the list; an inline "#word" keeps the word.
 */
export function splitBodyHashtags(body: string): { body: string; hashtags: string[] } {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const moved: string[] = [];
  while (lines.length && (HASHTAG_ONLY_LINE.test(lines.at(-1)!) || !lines.at(-1)!.trim())) {
    const line = lines.pop()!;
    // Lines are read bottom-up; prepend so the hashtags keep their original order.
    moved.unshift(...[...line.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1]!));
  }
  const cleaned = lines.join('\n').replace(HASHTAG_RE, '$1$2');
  return { body: tidy(cleaned), hashtags: moved };
}

/** Titles: no hashtags, no links, no quotes around them, no < >, one line. */
export function cleanTitle(title: string): string {
  let t = stripAngleBrackets(stripLinks(title)).replace(/\s+/g, ' ').trim();
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  // Trailing hashtags are dropped; an inline "#word" keeps the word.
  t = t.replace(/(?:\s*#[\p{L}\p{N}_]+)+$/u, '').replace(HASHTAG_RE, '$1$2');
  return t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
}

export function cleanBody(platform: Platform, body: string): { body: string; hashtags: string[] } {
  const noLinks = stripLinks(body);
  const split = splitBodyHashtags(platform === 'youtube' ? stripAngleBrackets(noLinks) : noLinks);
  return split;
}

/** YouTube tags: plain keywords, no '#', no commas or < >, deduplicated, within 500 chars. */
export function cleanTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = stripAngleBrackets(raw)
      .replace(/^#+/, '')
      .replace(/[,"]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!t || charCount(t) > 100) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  while (out.length && youtubeTagsLength(out) > RULES.youtube.tagsMaxChars) out.pop();
  return out;
}

/** Hashtag cap from settings (Instagram is also capped at its platform maximum of 5). */
export function hashtagMax(settings: AppSettings, platform: Platform): number {
  const max = Math.max(0, settings.hashtagCounts[platform].max);
  return platform === 'instagram' ? Math.min(max, RULES.instagram.hashtagsMax) : max;
}

export function capHashtags(settings: AppSettings, platform: Platform, tags: string[]): string[] {
  return normalizeHashtags(tags).slice(0, hashtagMax(settings, platform));
}

// ---------------------------------------------------------------------------------------------
// Output → target text
// ---------------------------------------------------------------------------------------------

/** Cleans every field of the output (pure; returns a new object). */
export function sanitizeOutput(out: AiOutput, settings: AppSettings): AiOutput {
  const ig = cleanBody('instagram', out.instagram.caption);
  const yt = cleanBody('youtube', out.youtube.description);
  const fb = cleanBody('facebook', out.facebook.text);
  return {
    ...out,
    summary: out.summary.trim(),
    story_hook: out.story_hook.trim(),
    instagram: {
      caption: ig.body,
      hashtags: capHashtags(settings, 'instagram', [...out.instagram.hashtags, ...ig.hashtags]),
    },
    youtube: {
      title: cleanTitle(out.youtube.title),
      description: yt.body,
      hashtags: capHashtags(settings, 'youtube', [...out.youtube.hashtags, ...yt.hashtags]),
      tags: cleanTags(out.youtube.tags),
    },
    facebook: {
      text: fb.body,
      hashtags: capHashtags(settings, 'facebook', [...out.facebook.hashtags, ...fb.hashtags]),
    },
  };
}

/** The AI text for one platform's target, in post_targets shape. */
export function targetTextFromOutput(platform: Platform, out: AiOutput): TargetText {
  if (platform === 'instagram')
    return { title: '', body: out.instagram.caption, hashtags: out.instagram.hashtags, tags: [] };
  if (platform === 'youtube')
    return {
      title: out.youtube.title,
      body: out.youtube.description,
      hashtags: out.youtube.hashtags,
      tags: out.youtube.tags,
    };
  // Facebook uses the YouTube title as its video title (only shown for normal Page videos).
  return {
    title: trimToChars(out.youtube.title, RULES.facebook.titleMaxChars),
    body: out.facebook.text,
    hashtags: out.facebook.hashtags,
    tags: [],
  };
}

/** Which output slot holds a target field (null = the platform has no such field). */
export function slotFor(platform: Platform, field: RefineField): OutputSlot | null {
  const map: Record<Platform, Partial<Record<RefineField, OutputSlot>>> = {
    instagram: { body: 'instagram.caption', hashtags: 'instagram.hashtags' },
    youtube: {
      title: 'youtube.title',
      body: 'youtube.description',
      hashtags: 'youtube.hashtags',
      tags: 'youtube.tags',
    },
    // The Facebook video title is written in the youtube.title slot (same schema for all calls).
    facebook: { title: 'youtube.title', body: 'facebook.text', hashtags: 'facebook.hashtags' },
  };
  return map[platform][field] ?? null;
}

export function readSlot(out: AiOutput, slot: OutputSlot): string | string[] {
  const [p, f] = slot.split('.') as [keyof AiOutput, string];
  return (out[p] as unknown as Record<string, string | string[]>)[f]!;
}

export function writeSlot(out: AiOutput, slot: OutputSlot, value: string | string[]): AiOutput {
  const [p, f] = slot.split('.') as ['instagram' | 'youtube' | 'facebook', string];
  return { ...out, [p]: { ...out[p], [f]: value } };
}

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------

export interface RepairEdit {
  slot: OutputSlot;
  instruction: string;
}

/**
 * Problems the repair call should fix, per selected platform: every 'block' issue plus a YouTube
 * title over the 60-character target (YouTube allows 100, but the owner wants titles that read
 * fully on a phone). Hashtag counts and tag length are fixed deterministically, not repaired.
 */
export function findRepairs(out: AiOutput, platforms: Platform[]): RepairEdit[] {
  const edits = new Map<OutputSlot, string>();
  const ytTitleNeeded = platforms.includes('youtube');
  for (const platform of platforms) {
    const text = targetTextFromOutput(platform, out);
    for (const issue of validateTargetText(platform, text)) {
      if (issue.severity !== 'block') continue;
      const edit = repairFor(platform, issue, text);
      if (edit) edits.set(edit.slot, edit.instruction);
    }
  }
  const title = out.youtube.title;
  if (ytTitleNeeded && title && charCount(title) > RULES.youtube.titleTargetChars)
    edits.set(
      'youtube.title',
      `shorten to under ${RULES.youtube.titleTargetChars} characters (it is ${charCount(title)} now), keeping the hook`,
    );
  return [...edits].map(([slot, instruction]) => ({ slot, instruction }));
}

function repairFor(platform: Platform, issue: TextIssue, text: TargetText): RepairEdit | null {
  const tagsLen = composeFinalBody(platform, '', text.hashtags).length;
  switch (`${platform}.${issue.code}`) {
    case 'instagram.caption_too_long':
      return {
        slot: 'instagram.caption',
        instruction: `shorten to under ${RULES.instagram.captionMaxChars - tagsLen - 100} characters (it is ${charCount(text.body)} now)`,
      };
    case 'instagram.too_many_mentions':
      return {
        slot: 'instagram.caption',
        instruction: `use at most ${RULES.instagram.mentionsMax} @mentions`,
      };
    case 'youtube.empty':
      return { slot: 'youtube.title', instruction: 'write the title (it is empty)' };
    case 'youtube.title_too_long':
      return {
        slot: 'youtube.title',
        instruction: `shorten to under ${RULES.youtube.titleTargetChars} characters (it is ${charCount(text.title)} now)`,
      };
    case 'youtube.description_too_long':
      return {
        slot: 'youtube.description',
        instruction: `shorten to under ${Math.floor((RULES.youtube.descriptionMaxBytes - tagsLen * 3) / 3)} characters`,
      };
    case 'facebook.text_too_long':
      return {
        slot: 'facebook.text',
        instruction: `shorten to under ${RULES.facebook.descriptionMaxChars - tagsLen - 100} characters`,
      };
    default:
      return null;
  }
}

/**
 * Last line of defence after the repair call (and after templates): trims at word boundaries so
 * every hard limit holds. Returns the fixed text; never throws.
 */
export function enforceLimits(platform: Platform, t: TargetText): TargetText {
  const out: TargetText = { ...t, hashtags: [...t.hashtags], tags: [...t.tags] };
  if (platform === 'instagram') {
    const r = RULES.instagram;
    out.hashtags = normalizeHashtags(out.hashtags).slice(0, r.hashtagsMax);
    const room = r.captionMaxChars - charCount(suffixText(platform, out.hashtags));
    out.body = trimToChars(out.body, room);
  } else if (platform === 'youtube') {
    const r = RULES.youtube;
    out.title = trimToChars(stripAngleBrackets(out.title), r.titleMaxChars);
    out.body = stripAngleBrackets(out.body);
    const room = r.descriptionMaxBytes - utf8Bytes(suffixText(platform, out.hashtags));
    out.body = trimToBytes(out.body, room);
    out.tags = cleanTags(out.tags);
  } else {
    const r = RULES.facebook;
    out.title = trimToChars(out.title, r.titleMaxChars);
    const room = r.descriptionMaxChars - charCount(suffixText(platform, out.hashtags));
    out.body = trimToChars(out.body, room);
  }
  return out;
}

/**
 * The AI title must read fully on a phone (owner decision, ≤60 chars). Applied to the AI's own
 * title only, before templates, so a template prefix can still use YouTube's full 100.
 */
export function fitTitleTarget(out: AiOutput): AiOutput {
  const max = RULES.youtube.titleTargetChars;
  if (charCount(out.youtube.title) <= max) return out;
  return { ...out, youtube: { ...out.youtube, title: trimToChars(out.youtube.title, max) } };
}

/** The text appended after the body at publish time ("\n\n#a #b"), or ''. */
function suffixText(platform: Platform, hashtags: string[]): string {
  return composeFinalBody(platform, '', hashtags);
}

// ---------------------------------------------------------------------------------------------
// Templates (Settings → Templates; off by default)
// ---------------------------------------------------------------------------------------------

export interface TemplateTokens {
  aiTitle: string;
  aiBody: string;
  n: number;
  date: string;
  filename: string;
}

/** Replaces {ai_title} {ai_body} {ai_caption} {n} {date} {filename}. Unknown tokens stay. */
export function fillPattern(pattern: string, tk: TemplateTokens): string {
  return pattern.replace(
    /\{(ai_title|ai_body|ai_caption|n|date|filename)\}/g,
    (_, name: string) => {
      switch (name) {
        case 'ai_title':
          return tk.aiTitle;
        case 'ai_body':
        case 'ai_caption':
          return tk.aiBody;
        case 'n':
          return String(tk.n);
        case 'date':
          return tk.date;
        default:
          return tk.filename;
      }
    },
  );
}

export const usesCounter = (pattern: string) => pattern.includes('{n}');

/**
 * Applies one template to a field value.
 *  - ai_only:       the AI text unchanged (template ignored);
 *  - template_only: the filled pattern;
 *  - template_ai:   the filled pattern; if it has no {ai_*} token, the AI text comes first and
 *                   the filled pattern is appended (title: " · ", body: blank line).
 */
export function applyTemplate(
  template: Pick<Template, 'field' | 'pattern' | 'mode'>,
  aiValue: string,
  tk: TemplateTokens,
): string {
  if (template.mode === 'ai_only' || !template.pattern.trim()) return aiValue;
  const filled = fillPattern(template.pattern, tk).trim();
  if (template.mode === 'template_only') return filled;
  if (/\{ai_(title|body|caption)\}/.test(template.pattern)) return filled;
  if (!aiValue) return filled;
  return template.field === 'title' ? `${aiValue} · ${filled}` : `${aiValue}\n\n${filled}`;
}

/** File name without extension, for {filename}. */
export function baseFilename(name: string): string {
  return name.replace(/\.[^./\\]+$/, '');
}
