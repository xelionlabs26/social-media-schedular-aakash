import { describe, expect, it } from 'vitest';
import {
  joinTranscripts,
  keywordsFromNotes,
  MAX_KEYWORDS,
  normalizeLanguages,
  sanitizeKeyword,
} from './hints';

describe('keywordsFromNotes', () => {
  it('splits on commas, semicolons and newlines, trims and de-duplicates', () => {
    expect(keywordsFromNotes('Rahul, Priya\nGoa; Baga Beach,,  rahul \n#VlogLife')).toEqual([
      'Rahul',
      'Priya',
      'Goa',
      'Baga Beach',
      'VlogLife',
    ]);
  });

  it('merges several notes (asset first, then batch)', () => {
    expect(keywordsFromNotes('Rahul', null, 'Goa, Rahul')).toEqual(['Rahul', 'Goa']);
  });

  it('caps the number of terms', () => {
    const notes = Array.from({ length: 40 }, (_, i) => `term${i}`).join(',');
    const out = keywordsFromNotes(notes);
    expect(out).toHaveLength(MAX_KEYWORDS);
    expect(out[0]).toBe('term0');
  });

  it('skips sentence-like lines and strips characters APIs reject', () => {
    expect(
      keywordsFromNotes('This video is about my trip to the beach with friends\n<Chai> Point'),
    ).toEqual(['Chai Point']);
    expect(sanitizeKeyword('  "Mumbai"  ')).toBe('Mumbai');
  });

  it('returns nothing for empty notes', () => {
    expect(keywordsFromNotes('', undefined, ' , \n ')).toEqual([]);
  });
});

describe('normalizeLanguages', () => {
  it('keeps unique primary subtags in order', () => {
    expect(normalizeLanguages(['hi-IN', 'EN', 'hi', null, 'hi-Latn'])).toBe('hi,en');
    expect(normalizeLanguages([])).toBeUndefined();
    expect(normalizeLanguages(['', 'not a code'])).toBeUndefined();
  });
});

describe('joinTranscripts', () => {
  it('joins non-empty parts with single spaces', () => {
    expect(joinTranscripts([' Namaste dosto ', '', 'aaj ki story'])).toBe(
      'Namaste dosto aaj ki story',
    );
  });
});
