import { describe, expect, it } from 'vitest';
import {
  isUnscheduled,
  matchesFilter,
  matchesQuery,
  parseListFilter,
  parseQuery,
} from './list-filter';

describe('list filters', () => {
  it('parses filter and query params', () => {
    expect(parseListFilter('published')).toBe('published');
    expect(parseListFilter('unscheduled')).toBe('unscheduled');
    expect(parseListFilter('bogus')).toBeNull();
    expect(parseQuery('  goa  ')).toBe('goa');
    expect(parseQuery('x'.repeat(500))).toHaveLength(100);
  });

  const post = {
    scheduledAt: null,
    display: 'needs_attention' as const,
    targets: [
      { display: 'published' as const, scheduledAt: '2026-11-13T12:30:00Z' },
      { display: 'needs_attention' as const, scheduledAt: null },
    ],
  };

  it('matches any platform status', () => {
    expect(matchesFilter(post, 'published')).toBe(true);
    expect(matchesFilter(post, 'needs_attention')).toBe(true);
    expect(matchesFilter(post, 'draft')).toBe(false);
    expect(matchesFilter(post, null)).toBe(true);
  });

  it('treats a post as scheduled when any platform has a time', () => {
    expect(isUnscheduled(post)).toBe(false);
    expect(matchesFilter({ ...post, targets: [] }, 'unscheduled')).toBe(true);
  });

  it('searches filename and captions, all words', () => {
    const p = {
      filename: '01_beach.mp4',
      targets: [{ title: 'Goa mein ek sunset', body: 'Socha tha normal', hashtags: ['travel'] }],
    };
    expect(matchesQuery(p, 'BEACH')).toBe(true);
    expect(matchesQuery(p, 'goa sunset')).toBe(true);
    expect(matchesQuery(p, '#travel')).toBe(true);
    expect(matchesQuery(p, 'goa gym')).toBe(false);
    expect(matchesQuery(p, '')).toBe(true);
  });
});
