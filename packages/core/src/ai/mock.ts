/**
 * AI_MOCK=true: deterministic, realistic-looking Hinglish output with no API call, for local
 * development and end-to-end tests. The output goes through the same post-processing and
 * database writes as real output, so everything downstream behaves the same.
 */
import type { Platform } from '@app/db';
import { trimToChars } from '../text';
import { readSlot, writeSlot } from './postprocess';
import type { VideoContext } from './prompt';
import type { AiOutput, OutputSlot, RefineAction } from './types';

export const MOCK_MODEL = 'mock';

const STOP_WORDS = new Set(
  'the and for with this that from have was were are you your yeh ye hai tha thi aur kya nahi main mein hum ham bhi toh kar karo raha rahi wala wali video img vid mov mp4 final edit copy'.split(
    ' ',
  ),
);

function firstSentence(text: string | null | undefined): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return (t.split(/(?<=[.!?।])\s/)[0] ?? t).replace(/[.!?।]+$/, '').trim();
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
}

/** A short subject phrase: notes first (trusted), then speech, then the file name. */
function subjectOf(ctx: VideoContext): string {
  const fromNotes = firstSentence(ctx.asset.notes || ctx.batchNotes);
  if (fromNotes) return trimToChars(fromNotes, 40);
  const fromSpeech = firstSentence(ctx.asset.transcript);
  if (fromSpeech) return trimToChars(fromSpeech, 40);
  const fromFile = ctx.asset.filename
    .replace(/\.[^.]+$/, '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\b(img|vid|mov|pxl|dsc)\b/gi, '')
    .replace(/\d{3,}/g, '')
    .trim();
  return fromFile ? trimToChars(fromFile, 40) : 'Aaj ka ye moment';
}

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export function mockGenerate(ctx: VideoContext, platforms: Platform[]): AiOutput {
  const subject = cap(subjectOf(ctx));
  const keywords = [
    ...new Set(words(`${ctx.asset.notes} ${ctx.asset.transcript ?? ''} ${ctx.asset.filename}`)),
  ];
  const hook = `${subject}… aur phir jo hua, socha bhi nahi tha`;
  const spoken = firstSentence(ctx.asset.transcript);
  const story = spoken
    ? `"${trimToChars(spoken, 80)}" — bas yahin se kahani palat gayi.`
    : 'Bas ek normal din tha, par ye pal special nikla.';
  const hashtags = [...keywords.slice(0, 3), 'hinglish', 'storytime', 'reels', 'india'];
  const tags = [...keywords.slice(0, 6), 'hinglish', 'shorts', 'story', subject.toLowerCase()];
  const has = (p: Platform) => platforms.includes(p);
  const middle = ctx.frames[Math.floor(ctx.frames.length / 2)];

  return {
    summary: `Video about: ${subject}`,
    detected_language: ctx.asset.transcript?.trim() ? 'hinglish' : 'other',
    story_hook: hook,
    cover_frame_index: middle?.idx ?? 0,
    instagram: has('instagram')
      ? {
          caption: [
            hook,
            story,
            'Aakhir tak dekhna, asli twist wahi hai.',
            'Tumhare saath kabhi aisa hua hai? Comment mein batao 👇',
          ].join('\n'),
          hashtags,
        }
      : { caption: '', hashtags: [] },
    youtube: {
      title: has('youtube') || has('facebook') ? trimToChars(`${subject}… phir ye hua`, 60) : '',
      description: has('youtube')
        ? [hook, '', story, 'Pura moment dekho, end mein surprise hai.'].join('\n')
        : '',
      hashtags: has('youtube') ? hashtags : [],
      tags: has('youtube') ? tags : [],
    },
    facebook: has('facebook')
      ? { text: [hook, story, 'Aapko kya lagta hai, aage kya hua hoga?'].join('\n'), hashtags }
      : { text: '', hashtags: [] },
  };
}

function rewriteText(value: string, instruction: string, action?: RefineAction): string {
  if (!action) {
    // Repair call: the instruction asks to shorten under N characters.
    const n = Number(/under (\d+)/.exec(instruction)?.[1] ?? 0);
    return n ? trimToChars(value, Math.max(10, n - 5)) : value;
  }
  switch (action) {
    case 'shorter':
      return trimToChars(value, Math.max(10, Math.ceil(Array.from(value).length / 2)));
    case 'longer':
      return `${value}\nSach mein, ye pal yaad reh gaya.`;
    case 'casual':
      return `Yaar, ${value}`;
    case 'formal':
      return value
        .replace(/^Yaar,\s*/i, '')
        .replace(/[\p{Extended_Pictographic}]/gu, '')
        .trim();
    case 'viral':
      return `Ruko… ${value}`;
    default:
      return `Kisi ne socha nahi tha: ${value}`;
  }
}

/** Mock of a field-rewrite call: only the requested slots are filled, like the real prompt asks. */
export function mockRewrite(
  current: AiOutput,
  edits: Array<{ slot: OutputSlot; instruction: string }>,
  action?: RefineAction,
): AiOutput {
  let out: AiOutput = {
    summary: '',
    detected_language: current.detected_language,
    story_hook: '',
    cover_frame_index: 0,
    instagram: { caption: '', hashtags: [] },
    youtube: { title: '', description: '', hashtags: [], tags: [] },
    facebook: { text: '', hashtags: [] },
  };
  for (const e of edits) {
    const value = readSlot(current, e.slot);
    if (Array.isArray(value)) {
      const list =
        action === 'shorter'
          ? value.slice(0, Math.max(1, Math.ceil(value.length / 2)))
          : action === 'regenerate'
            ? [...value].reverse()
            : value;
      out = writeSlot(out, e.slot, list.length ? list : ['hinglish', 'storytime']);
    } else {
      out = writeSlot(out, e.slot, rewriteText(value || 'Ye moment dekho', e.instruction, action));
    }
  }
  return out;
}
