/**
 * Small pure helpers that turn the owner's notes into keyword hints and normalize the language
 * codes the providers return.
 */

/** Providers differ (Deepgram ~500 tokens, Sarvam 50 terms); 20 short terms fit all of them. */
export const MAX_KEYWORDS = 20;
/** AssemblyAI rejects keyterm phrases longer than 6 words; longer lines are sentences anyway. */
const MAX_WORDS_PER_KEYWORD = 6;
const MAX_KEYWORD_CHARS = 60;

/**
 * Splits notes on commas, semicolons and newlines into short, de-duplicated keyword hints.
 * Characters some APIs reject (`<`, `>`, control characters) are removed, and lines that read like
 * sentences (more than 6 words) are skipped because keyword boosting works on terms, not prose.
 */
export function keywordsFromNotes(...notes: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const note of notes) {
    if (!note) continue;
    for (const raw of note.split(/[,;\n\r]+/)) {
      const term = sanitizeKeyword(raw);
      if (!term) continue;
      if (term.split(' ').length > MAX_WORDS_PER_KEYWORD || term.length > MAX_KEYWORD_CHARS) {
        continue;
      }
      const key = term.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(term);
      if (out.length >= MAX_KEYWORDS) return out;
    }
  }
  return out;
}

/** OpenAI rejects the whole request when a keyword contains `<`, `>` or a line break. */
export function sanitizeKeyword(raw: string): string {
  return raw
    .replace(/[<>]/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/^[\s#@"'`*\-•]+|[\s"'`*.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes provider language codes ('hi-IN', 'EN', 'hi-Latn') to unique lowercase primary
 * subtags joined by commas, keeping the provider's order. Returns undefined when nothing is known.
 */
export function normalizeLanguages(codes: Array<string | null | undefined>): string | undefined {
  const out: string[] = [];
  for (const code of codes) {
    if (!code) continue;
    const primary = code.trim().toLowerCase().split(/[-_]/)[0];
    if (!primary || !/^[a-z]{2,3}$/.test(primary) || out.includes(primary)) continue;
    out.push(primary);
  }
  return out.length ? out.join(',') : undefined;
}

/** Primary subtags of the hints ('hi-IN' → 'hi'), unique, in order. */
export function primaryHints(hints: string[]): string[] {
  return normalizeLanguages(hints)?.split(',') ?? [];
}

/** Joins chunk transcripts with single spaces, dropping empty chunks. */
export function joinTranscripts(parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(' ');
}
