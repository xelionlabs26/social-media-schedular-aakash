/**
 * AI cost accounting. Prices are USD per million tokens (MTok), first-party Claude API rates for
 * prompts up to 100K tokens (ours are ~10K), checked 13 Nov 2026 (PLAN.md §4.3/§4.9).
 * Cache writes are priced per TTL: 1.25x input for 5 minutes, 2x input for 1 hour.
 */
import { gte, sum } from 'drizzle-orm';
import { aiGenerations, type Db } from '@app/db';

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite5m: 0.125,
    cacheWrite1h: 0.2,
  },
};

/** Models the Settings screen offers (first = default). */
export const AI_MODELS = Object.keys(MODEL_PRICES);

export interface TokenUsage {
  /** Uncached input tokens (after the last cache breakpoint). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

/**
 * Cost of one call. Unknown models are priced like Opus 5.5 (the most expensive model we offer)
 * so the monthly total errs on the high side instead of silently reading $0.
 */
export function estimateCostUsd(model: string, u: TokenUsage): number {
  const p = MODEL_PRICES[model] ?? MODEL_PRICES['claude-opus-5-5']!;
  const usd =
    (u.inputTokens * p.input +
      u.outputTokens * p.output +
      u.cacheReadTokens * p.cacheRead +
      u.cacheWrite5mTokens * p.cacheWrite5m +
      u.cacheWrite1hTokens * p.cacheWrite1h) /
    1_000_000;
  // Round to 1/1000 of a cent so stored values stay readable.
  return Math.round(usd * 100_000) / 100_000;
}

/** Total AI spend recorded since `since` (Settings → AI shows this month's total). */
export async function monthlyCostUsd(db: Db, since: Date): Promise<number> {
  const rows = await db
    .select({ total: sum(aiGenerations.costUsd) })
    .from(aiGenerations)
    .where(gte(aiGenerations.createdAt, since));
  const total = Number(rows[0]?.total ?? 0);
  return Number.isFinite(total) ? Math.round(total * 100_000) / 100_000 : 0;
}
