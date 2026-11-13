import { describe, expect, it } from 'vitest';
import { charCount, validateTargetText } from '@app/core/text';
import { captionWithoutHashtags, cleanTags, fieldMeter, fieldsFor, splitChips } from './fields';

const t = (
  over: Partial<{ title: string; body: string; hashtags: string[]; tags: string[] }> = {},
) => ({
  title: '',
  body: '',
  hashtags: [],
  tags: [],
  ...over,
});

describe('fieldMeter', () => {
  it('counts the Instagram caption including its hashtags', () => {
    const body = 'Socha tha normal sunset hoga… phir ye hua 😳';
    const m = fieldMeter('instagram', 'body', t({ body, hashtags: ['goa', 'sunset'] }), 5);
    // body + "\n\n" + "#goa #sunset"; the emoji counts as one character.
    expect(m).toMatchObject({ value: charCount(body) + 2 + 12, max: 2200 });
    expect(charCount(body)).toBe(43);
  });

  it('counts YouTube description bytes (Hindi = 3 bytes per letter)', () => {
    const m = fieldMeter('youtube', 'body', t({ body: 'नमस्ते' }), 3);
    expect(m).toMatchObject({ value: 18, max: 5000, unit: 'bytes' });
  });

  it('counts YouTube tags the way YouTube does', () => {
    const m = fieldMeter('youtube', 'tags', t({ tags: ['goa', 'goa trip'] }), 3);
    // 3 + (8 + 2 quotes) + 1 comma
    expect(m).toMatchObject({ value: 14, max: 500 });
  });

  it('caps Instagram hashtags at the platform rule and counts inline ones', () => {
    const m = fieldMeter(
      'instagram',
      'hashtags',
      t({ body: 'hi #inline', hashtags: ['a', 'b'] }),
      30,
    );
    expect(m).toMatchObject({ value: 3, max: 5 });
    expect(m.hint).toMatch(/1 in the text/);
    expect(fieldMeter('youtube', 'hashtags', t({ hashtags: ['a'] }), 3).max).toBe(3);
  });

  it('agrees with validateTargetText at the limit', () => {
    const atLimit = t({ title: 'x'.repeat(100) });
    const over = t({ title: 'x'.repeat(101) });
    expect(fieldMeter('youtube', 'title', atLimit, 3).value).toBe(100);
    expect(validateTargetText('youtube', atLimit).some((i) => i.code === 'title_too_long')).toBe(
      false,
    );
    expect(fieldMeter('youtube', 'title', over, 3).value).toBe(101);
    expect(validateTargetText('youtube', over).some((i) => i.code === 'title_too_long')).toBe(true);
  });

  it('measures Facebook text and title', () => {
    expect(fieldMeter('facebook', 'body', t({ body: 'abc' }), 0)).toMatchObject({
      value: 3,
      max: 10000,
    });
    expect(fieldMeter('facebook', 'title', t({ title: 'ab' }), 0)).toMatchObject({
      value: 2,
      max: 100,
    });
  });
});

describe('fieldsFor', () => {
  it('lists each tab’s fields', () => {
    expect(fieldsFor('instagram')).toEqual(['body', 'hashtags']);
    expect(fieldsFor('youtube')).toEqual(['title', 'body', 'hashtags', 'tags']);
    expect(fieldsFor('facebook')).toEqual(['body']);
    expect(fieldsFor('facebook', { fbKind: 'video' })).toEqual(['title', 'body']);
  });
});

describe('chips', () => {
  it('splits hashtags on spaces, commas and #', () => {
    expect(splitChips('#goa #Sunset, travel', 'hashtags')).toEqual(['goa', 'Sunset', 'travel']);
    expect(splitChips('##', 'hashtags')).toEqual([]);
  });

  it('splits tags on commas and new lines only', () => {
    expect(splitChips('goa trip, sunset\nbeach  life', 'tags')).toEqual([
      'goa trip',
      'sunset',
      'beach life',
    ]);
  });

  it('cleans and de-duplicates tags', () => {
    expect(cleanTags([' Goa ', 'goa', '<b>', 'a,b', ''])).toEqual(['Goa', 'b', 'a b']);
  });
});

describe('captionWithoutHashtags', () => {
  it('drops lines made only of hashtags and keeps the story', () => {
    const body =
      'Socha tha normal sunset hoga…\nphir ye hua 😳\n\n#goa #sunset\n\nAapka favourite? 👇';
    expect(captionWithoutHashtags(body)).toBe(
      'Socha tha normal sunset hoga…\nphir ye hua 😳\n\nAapka favourite? 👇',
    );
  });

  it('keeps hashtags inside sentences', () => {
    expect(captionWithoutHashtags('Day #2 in Goa')).toBe('Day #2 in Goa');
  });
});
