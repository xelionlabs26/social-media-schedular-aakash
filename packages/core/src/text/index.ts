/**
 * Text helpers shared by the AI module, validators, the editor UI and the publishers.
 * Pure functions only (safe to import in client components).
 */
import type { Platform } from '@app/db';
import { RULES } from '../platforms/rules';

export const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

/** Character count the way users perceive it (grapheme-ish: code points). */
export const charCount = (s: string): number => Array.from(s).length;

/** YouTube forbids '<' and '>' in titles and descriptions. */
export const stripAngleBrackets = (s: string): string => s.replace(/[<>]/g, '');

/** Normalizes a hashtag to its bare form ('#Goa Trip' -> 'GoaTrip'). */
export function normalizeHashtag(tag: string): string {
  return tag
    .trim()
    .replace(/^#+/, '')
    .replace(/[\s#]+/g, '')
    .replace(/[^\p{L}\p{N}_]/gu, '');
}

export function normalizeHashtags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const n = normalizeHashtag(t);
    if (!n) continue;
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

/** Counts #hashtags inside free text. */
export function countHashtagsInText(text: string): number {
  return (text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
}

export function countMentions(text: string): number {
  return (text.match(/(^|\s)@[\w.]+/g) ?? []).length;
}

/**
 * YouTube counts the tags field like this: the sum of tag lengths plus a comma between tags,
 * and a tag containing a space counts as if wrapped in quotes (+2).
 */
export function youtubeTagsLength(tags: string[]): number {
  if (tags.length === 0) return 0;
  const parts = tags.map((t) => charCount(t) + (/\s/.test(t) ? 2 : 0));
  return parts.reduce((a, b) => a + b, 0) + (tags.length - 1);
}

/** Final text sent to the platform: body + hashtags (IG caption, YT description, FB text). */
export function composeFinalBody(platform: Platform, body: string, hashtags: string[]): string {
  const tags = normalizeHashtags(hashtags).map((t) => `#${t}`);
  const clean = platform === 'youtube' ? stripAngleBrackets(body.trim()) : body.trim();
  if (tags.length === 0) return clean;
  return `${clean}\n\n${tags.join(' ')}`;
}

/** Trims text at a word boundary to at most `maxChars` characters. */
export function trimToChars(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  const cut = chars.slice(0, maxChars).join('');
  // Cut at the last word boundary unless that would throw away most of the text.
  const lastSpace = cut.search(/\s\S*$/);
  return (lastSpace > maxChars * 0.3 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/** Trims text at a word boundary to at most `maxBytes` UTF-8 bytes. */
export function trimToBytes(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8Bytes(chars.slice(0, mid).join('')) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return trimToChars(chars.slice(0, lo).join(''), lo);
}

export interface TextIssue {
  field: 'title' | 'body' | 'hashtags' | 'tags';
  code: string;
  message: string;
  /** 'block' issues prevent scheduling. */
  severity: 'warn' | 'block';
}

export interface TargetText {
  title: string;
  body: string;
  hashtags: string[];
  tags: string[];
}

/** Validates a target's text against the platform limits. Used by AI post-processing and the UI. */
export function validateTargetText(
  platform: Platform,
  t: TargetText,
  opts: { fbKind?: 'reel' | 'video' } = {},
): TextIssue[] {
  const issues: TextIssue[] = [];
  const finalBody = composeFinalBody(platform, t.body, t.hashtags);

  if (platform === 'instagram') {
    const r = RULES.instagram;
    if (charCount(finalBody) > r.captionMaxChars)
      issues.push({
        field: 'body',
        code: 'caption_too_long',
        message: `Caption is ${charCount(finalBody)}/${r.captionMaxChars} characters (incl. hashtags).`,
        severity: 'block',
      });
    const tagCount = normalizeHashtags(t.hashtags).length + countHashtagsInText(t.body);
    if (tagCount > r.hashtagsMax)
      issues.push({
        field: 'hashtags',
        code: 'too_many_hashtags',
        message: `${tagCount} hashtags; Instagram allows ${r.hashtagsMax}.`,
        severity: 'block',
      });
    if (countMentions(t.body) > r.mentionsMax)
      issues.push({
        field: 'body',
        code: 'too_many_mentions',
        message: `More than ${r.mentionsMax} @mentions.`,
        severity: 'block',
      });
    if (!t.body.trim())
      issues.push({ field: 'body', code: 'empty', message: 'Caption is empty.', severity: 'warn' });
  }

  if (platform === 'youtube') {
    const r = RULES.youtube;
    const title = t.title.trim();
    if (!title)
      issues.push({
        field: 'title',
        code: 'empty',
        message: 'Title is required.',
        severity: 'block',
      });
    if (charCount(title) > r.titleMaxChars)
      issues.push({
        field: 'title',
        code: 'title_too_long',
        message: `Title is ${charCount(title)}/${r.titleMaxChars} characters.`,
        severity: 'block',
      });
    if (/[<>]/.test(title) || /[<>]/.test(t.body))
      issues.push({
        field: /[<>]/.test(title) ? 'title' : 'body',
        code: 'angle_brackets',
        message: 'YouTube does not allow < or >; they will be removed.',
        severity: 'warn',
      });
    if (utf8Bytes(finalBody) > r.descriptionMaxBytes)
      issues.push({
        field: 'body',
        code: 'description_too_long',
        message: `Description is ${utf8Bytes(finalBody)}/${r.descriptionMaxBytes} bytes (Hindi letters use 3 bytes each).`,
        severity: 'block',
      });
    if (youtubeTagsLength(t.tags) > r.tagsMaxChars)
      issues.push({
        field: 'tags',
        code: 'tags_too_long',
        message: `Tags use ${youtubeTagsLength(t.tags)}/${r.tagsMaxChars} characters.`,
        severity: 'block',
      });
  }

  if (platform === 'facebook') {
    const r = RULES.facebook;
    if (charCount(finalBody) > r.descriptionMaxChars)
      issues.push({
        field: 'body',
        code: 'text_too_long',
        message: `Text is ${charCount(finalBody)}/${r.descriptionMaxChars} characters.`,
        severity: 'block',
      });
    if (opts.fbKind === 'video' && charCount(t.title) > r.titleMaxChars)
      issues.push({
        field: 'title',
        code: 'title_too_long',
        message: `Title is ${charCount(t.title)}/${r.titleMaxChars} characters.`,
        severity: 'block',
      });
  }

  return issues;
}
