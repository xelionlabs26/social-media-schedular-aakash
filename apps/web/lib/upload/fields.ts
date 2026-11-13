/**
 * Per-field counters and cleanup for the post editor. The counters measure exactly what
 * core/text `validateTargetText` checks (e.g. the Instagram caption counts its hashtags, the
 * YouTube description counts UTF-8 bytes), so a red counter and a blocking issue always agree.
 * Pure and client-safe.
 */
import type { Platform } from '@app/db';
import { RULES } from '@app/core/platforms';
import {
  charCount,
  composeFinalBody,
  countHashtagsInText,
  normalizeHashtag,
  normalizeHashtags,
  utf8Bytes,
  youtubeTagsLength,
  type TargetText,
} from '@app/core/text';

export type EditorField = 'title' | 'body' | 'hashtags' | 'tags';

export interface FieldMeter {
  value: number;
  max: number;
  unit?: string;
  /** Extra words for screen readers / the hint line. */
  hint?: string;
}

/** Which fields each platform tab shows. */
export function fieldsFor(
  platform: Platform,
  opts: { fbKind?: 'reel' | 'video' } = {},
): EditorField[] {
  if (platform === 'instagram') return ['body', 'hashtags'];
  if (platform === 'youtube') return ['title', 'body', 'hashtags', 'tags'];
  return opts.fbKind === 'video' ? ['title', 'body'] : ['body'];
}

export const FIELD_LABELS: Record<Platform, Partial<Record<EditorField, string>>> = {
  instagram: { body: 'Caption', hashtags: 'Hashtags' },
  youtube: { title: 'Title', body: 'Description', hashtags: 'Hashtags', tags: 'Tags' },
  facebook: { title: 'Title', body: 'Text' },
};

/** Live counter for one field. `hashtagMax` comes from settings (capped by platform rules). */
export function fieldMeter(
  platform: Platform,
  field: EditorField,
  t: TargetText,
  hashtagMax: number,
): FieldMeter {
  const finalBody = composeFinalBody(platform, t.body, t.hashtags);
  if (field === 'hashtags') {
    const inline = countHashtagsInText(t.body);
    const max =
      platform === 'instagram' ? Math.min(hashtagMax, RULES.instagram.hashtagsMax) : hashtagMax;
    return {
      value: normalizeHashtags(t.hashtags).length + inline,
      max,
      hint: inline ? `incl. ${inline} in the text` : undefined,
    };
  }
  if (platform === 'instagram') {
    return {
      value: charCount(finalBody),
      max: RULES.instagram.captionMaxChars,
      hint: 'incl. hashtags',
    };
  }
  if (platform === 'youtube') {
    if (field === 'title')
      return { value: charCount(t.title.trim()), max: RULES.youtube.titleMaxChars };
    if (field === 'tags')
      return { value: youtubeTagsLength(t.tags), max: RULES.youtube.tagsMaxChars };
    return {
      value: utf8Bytes(finalBody),
      max: RULES.youtube.descriptionMaxBytes,
      unit: 'bytes',
      hint: 'Hindi letters count 3 bytes, emoji 4',
    };
  }
  if (field === 'title') return { value: charCount(t.title), max: RULES.facebook.titleMaxChars };
  return { value: charCount(finalBody), max: RULES.facebook.descriptionMaxChars };
}

/** One YouTube tag as YouTube accepts it: no commas or angle brackets, single spaces. */
export function cleanTag(tag: string): string {
  return tag.replace(/[<>,]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Cleans and de-duplicates (case-insensitively) a tag list, keeping the first spelling. */
export function cleanTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = cleanTag(raw);
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/**
 * Splits what the owner typed or pasted into chips. Tags split on commas and new lines (a tag
 * may contain spaces); hashtags also split on spaces and '#'.
 */
export function splitChips(text: string, kind: 'hashtags' | 'tags'): string[] {
  const parts = kind === 'tags' ? text.split(/[,\n]+/) : text.split(/[\s,#]+/);
  const cleaned = parts.map((p) => (kind === 'tags' ? cleanTag(p) : normalizeHashtag(p)));
  return cleaned.filter(Boolean);
}

/**
 * Facebook's "Copy Instagram caption": the caption body without hashtags. Hashtags normally
 * live in their own list (not copied); lines made only of #tags typed into the body are dropped.
 */
export function captionWithoutHashtags(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((line) => !/^\s*(#[\p{L}\p{N}_]+\s*)+$/u.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
