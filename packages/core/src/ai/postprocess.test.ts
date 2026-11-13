import { describe, expect, it } from 'vitest';
import { charCount, utf8Bytes, validateTargetText, youtubeTagsLength } from '../text';
import { estimateCostUsd } from './cost';
import {
  applyTemplate,
  cleanTags,
  cleanTitle,
  enforceLimits,
  fillPattern,
  findRepairs,
  fitTitleTarget,
  sanitizeOutput,
  slotFor,
  splitBodyHashtags,
  stripLinks,
  targetTextFromOutput,
} from './postprocess';
import { sampleOutput, testSettings } from './test-helpers';

describe('cleaning', () => {
  it('strips hashtags, links, quotes and angle brackets from titles', () => {
    expect(cleanTitle('"Chai ka <jaadu> dekho https://x.co #chai #viral"')).toBe(
      'Chai ka jaadu dekho',
    );
    expect(cleanTitle('Goa mein #sunset ka kamaal')).toBe('Goa mein sunset ka kamaal');
  });

  it('moves trailing hashtag lines out of the body', () => {
    const r = splitBodyHashtags('Line one #wow\nLine two\n\n#chai #mumbai\n#food');
    expect(r.body).toBe('Line one wow\nLine two');
    expect(r.hashtags).toEqual(['chai', 'mumbai', 'food']);
  });

  it('removes links', () => {
    expect(stripLinks('see www.example.com and https://a.b/c now')).toBe('see and now');
  });

  it('cleans YouTube tags and keeps them within 500 characters', () => {
    expect(cleanTags(['#chai', 'Chai', 'street, food', '<b>x</b>', ''])).toEqual([
      'chai',
      'street food',
      'bx/b',
    ]);
    const many = Array.from({ length: 80 }, (_, i) => `keyword number ${i}`);
    const out = cleanTags(many);
    expect(youtubeTagsLength(out)).toBeLessThanOrEqual(500);
    expect(out.length).toBeLessThan(80);
  });

  it('sanitizes output: normalizes and caps hashtags per settings', () => {
    const out = sanitizeOutput(
      sampleOutput({
        instagram: {
          caption: 'Hook\nstory\n#a #b',
          hashtags: ['#one', 'two', 'three', 'four', 'five', 'six', 'seven'],
        },
        facebook: { text: 'Hello #there', hashtags: ['x'] },
      }),
      testSettings(),
    );
    expect(out.instagram.caption).toBe('Hook\nstory');
    expect(out.instagram.hashtags).toEqual(['one', 'two', 'three', 'four', 'five']);
    expect(out.youtube.hashtags).toEqual(['chai', 'streetfood']);
    expect(out.facebook).toEqual({ text: 'Hello there', hashtags: [] }); // facebook max 0
  });
});

describe('limits', () => {
  const long = (n: number, word = 'kahani') => Array.from({ length: n }, () => word).join(' ');

  it('asks for a repair when the YouTube title is over 60 characters', () => {
    const out = sampleOutput({
      youtube: { ...sampleOutput().youtube, title: long(15) },
    });
    const edits = findRepairs(out, ['youtube']);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.slot).toBe('youtube.title');
    expect(edits[0]!.instruction).toMatch(/under 60 characters/);
    expect(findRepairs(sampleOutput(), ['youtube', 'instagram', 'facebook'])).toEqual([]);
  });

  it('asks for a repair when a caption breaks the hard limit', () => {
    const out = sampleOutput({ instagram: { caption: long(400), hashtags: ['a'] } });
    expect(findRepairs(out, ['instagram']).map((e) => e.slot)).toEqual(['instagram.caption']);
    // Not selected → not repaired.
    expect(findRepairs(out, ['youtube'])).toEqual([]);
  });

  it('trims deterministically so no block issue remains', () => {
    const ig = enforceLimits('instagram', {
      title: '',
      body: long(500),
      hashtags: ['a', 'b', 'c', 'd', 'e', 'f'],
      tags: [],
    });
    expect(ig.hashtags).toHaveLength(5);
    expect(validateTargetText('instagram', ig).filter((i) => i.severity === 'block')).toEqual([]);

    const yt = enforceLimits('youtube', {
      title: long(30),
      body: long(1200, 'कहानी'),
      hashtags: ['chai'],
      tags: Array.from({ length: 80 }, (_, i) => `tag ${i}`),
    });
    expect(charCount(yt.title)).toBeLessThanOrEqual(100);
    expect(utf8Bytes(`${yt.body}\n\n#chai`)).toBeLessThanOrEqual(5000);
    expect(validateTargetText('youtube', yt).filter((i) => i.severity === 'block')).toEqual([]);

    const fb = enforceLimits('facebook', {
      title: long(30),
      body: long(2000),
      hashtags: [],
      tags: [],
    });
    expect(validateTargetText('facebook', fb, { fbKind: 'video' })).toEqual([]);
  });

  it('fits the AI title to 60 characters at a word boundary', () => {
    const out = fitTitleTarget(
      sampleOutput({ youtube: { ...sampleOutput().youtube, title: long(15) } }),
    );
    expect(charCount(out.youtube.title)).toBeLessThanOrEqual(60);
    expect(out.youtube.title.endsWith('kahani')).toBe(true);
  });
});

describe('slots', () => {
  it('maps target fields to output slots', () => {
    expect(slotFor('instagram', 'body')).toBe('instagram.caption');
    expect(slotFor('instagram', 'title')).toBeNull();
    expect(slotFor('youtube', 'tags')).toBe('youtube.tags');
    expect(slotFor('facebook', 'title')).toBe('youtube.title');
    expect(slotFor('facebook', 'tags')).toBeNull();
    const fb = targetTextFromOutput('facebook', sampleOutput());
    expect(fb.title).toBe(sampleOutput().youtube.title);
    expect(fb.body).toBe(sampleOutput().facebook.text);
  });
});

describe('templates', () => {
  const tk = {
    aiTitle: 'AI title',
    aiBody: 'AI body',
    n: 7,
    date: '13 Nov 2026',
    filename: 'chai',
  };

  it('fills tokens', () => {
    expect(fillPattern('#{n} {ai_title} – {date} ({filename}) {ai_caption} {other}', tk)).toBe(
      '#7 AI title – 13 Nov 2026 (chai) AI body {other}',
    );
  });

  it('applies the three modes', () => {
    expect(
      applyTemplate({ field: 'title', pattern: 'Ep {n}', mode: 'ai_only' }, 'AI title', tk),
    ).toBe('AI title');
    expect(
      applyTemplate({ field: 'title', pattern: 'Ep {n}', mode: 'template_only' }, 'AI title', tk),
    ).toBe('Ep 7');
    expect(
      applyTemplate(
        { field: 'title', pattern: '{ai_title} | Ep {n}', mode: 'template_ai' },
        'AI title',
        tk,
      ),
    ).toBe('AI title | Ep 7');
    expect(
      applyTemplate(
        { field: 'body', pattern: 'Follow for more', mode: 'template_ai' },
        'AI body',
        tk,
      ),
    ).toBe('AI body\n\nFollow for more');
  });
});

describe('estimateCostUsd', () => {
  it('prices every token kind per model', () => {
    const u = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWrite5mTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000,
    };
    expect(estimateCostUsd('claude-opus-5-5', u)).toBeCloseTo(4 + 20 + 0.2 + 5 + 8);
    expect(estimateCostUsd('claude-sonnet-5-5', u)).toBeCloseTo(2 + 10 + 0.1 + 2.5 + 4);
    expect(estimateCostUsd('claude-haiku-5-5', u)).toBeCloseTo(0.1 + 0.5 + 0.01 + 0.125 + 0.2);
    // Unknown models are priced like Opus (never silently free).
    expect(estimateCostUsd('claude-x', u)).toBeCloseTo(37.2);
  });

  it('matches the plan estimate for a typical video (~$0.05–0.08 on Opus)', () => {
    const first = estimateCostUsd('claude-opus-5-5', {
      inputTokens: 300,
      outputTokens: 1500,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 10_000,
    });
    expect(first).toBeGreaterThan(0.05);
    expect(first).toBeLessThan(0.15);
  });
});
