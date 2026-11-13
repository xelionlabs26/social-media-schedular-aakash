/**
 * Thin wrapper around the Anthropic SDK: one injectable client interface (tests never touch the
 * network), the call loop that checks stop_reason before parsing, and the mapping from SDK errors
 * to AiError categories.
 *
 * SDK: @anthropic-ai/sdk 1.8.0 (types checked in node_modules). We use the beta Messages surface
 * because server-side refusal fallbacks (`fallbacks` + the `server-side-fallback-2026-07-01`
 * beta) only exist there; everything else we send is GA.
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaMessage,
  BetaMessageStreamParams,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { z } from 'zod';
import type { Logger } from '../log';
import { AiError, type AiOutput } from './types';

export type { BetaMessage, BetaMessageStreamParams };

/** What the AI module needs from Claude. Inject a fake in tests. */
export interface ClaudeClient {
  send(
    params: BetaMessageStreamParams,
  ): Promise<{ message: BetaMessage; requestId: string | null }>;
}

export const DEFAULT_MAX_TOKENS = 12_000;
/** One retry with more room when hidden thinking + JSON hit the cap. */
export const RETRY_MAX_TOKENS = 24_000;

/**
 * Server-side refusal fallback is only offered on these models (claude-api skill, Nov 2026;
 * https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback). Haiku gets one
 * manual retry instead.
 */
export const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const clients = new Map<string, ClaudeClient>();

/**
 * Default client. Streams and returns the final message: a 24K max_tokens retry is over the
 * SDK's 10-minute non-streaming guard, and streaming avoids idle-connection drops
 * (https://platform.claude.com/docs/en/api/errors#long-requests).
 * maxRetries=1: pg-boss already retries the job with backoff, and the SDK would otherwise also
 * retry spend-cap 429s that can never succeed.
 */
export function getDefaultClaudeClient(apiKey: string | undefined): ClaudeClient {
  if (!apiKey) throw new AiError('config', 'Add ANTHROPIC_API_KEY or set AI_MOCK=true.');
  let client = clients.get(apiKey);
  if (!client) {
    const anthropic = new Anthropic({ apiKey, maxRetries: 1 });
    client = {
      async send(params) {
        const stream = anthropic.beta.messages.stream(params);
        const message = await stream.finalMessage();
        return { message, requestId: stream.request_id ?? null };
      },
    };
    clients.set(apiKey, client);
  }
  return client;
}

// ---------------------------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------------------------

function retryAfterSeconds(headers: Headers | undefined): number | undefined {
  const raw = headers?.get?.('retry-after');
  if (!raw) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : undefined;
}

/** Spend-limit wording documented at https://platform.claude.com/docs/en/api/rate-limits */
const SPEND_MESSAGE =
  /reached your specified (workspace )?API usage limits|credit balance is too low/i;

/**
 * Maps any thrown value to an AiError. Most specific SDK classes first; a mid-stream SSE error
 * has no HTTP status, so the error `type` is checked too.
 */
export function toAiError(e: unknown): AiError {
  if (e instanceof AiError) return e;
  if (e instanceof Anthropic.APIError) {
    const msg = e.apiMessage ?? e.message;
    const short = `Claude API error${e.status ? ` ${e.status}` : ''}: ${msg}`.slice(0, 500);
    if (e instanceof Anthropic.RateLimitError || e.type === 'rate_limit_error') {
      // Tier spend cap: 429 with error_code enforced_spend_limit_reached and no retry-after.
      if (e.errorCode === 'enforced_spend_limit_reached') return new AiError('spend', short);
      // ramp_limit_exceeded and normal rate limits: retry after the server's hint.
      return new AiError('retryable', short, retryAfterSeconds(e.headers));
    }
    if (e.status === 402 || e.type === 'billing_error') return new AiError('spend', short);
    if (e instanceof Anthropic.BadRequestError) {
      // A spend limit the owner set returns 400 invalid_request_error.
      if (SPEND_MESSAGE.test(msg)) return new AiError('spend', short);
      return new AiError('fatal', short);
    }
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError)
      return new AiError(
        'config',
        `Anthropic rejected the API key (${e.status}). Check ANTHROPIC_API_KEY or set AI_MOCK=true.`,
      );
    if (
      e instanceof Anthropic.APIConnectionError ||
      e instanceof Anthropic.InternalServerError ||
      e instanceof Anthropic.RequestTimeoutError ||
      e instanceof Anthropic.ConflictError ||
      e.type === 'overloaded_error' ||
      e.type === 'api_error' ||
      e.type === 'timeout_error' ||
      (typeof e.status === 'number' && e.status >= 500)
    )
      return new AiError('retryable', short, retryAfterSeconds(e.headers));
    return new AiError('fatal', short);
  }
  if (e instanceof Anthropic.AnthropicError) return new AiError('fatal', e.message.slice(0, 500));
  const message = e instanceof Error ? e.message : String(e);
  return new AiError('fatal', message.slice(0, 500));
}

// ---------------------------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------------------------

const str = z.string();
const strs = z.array(z.string());
export const AiOutputSchema = z
  .object({
    summary: str,
    detected_language: z.enum(['en', 'hi', 'hinglish', 'other']),
    story_hook: str,
    cover_frame_index: z.number().int(),
    instagram: z.object({ caption: str, hashtags: strs }).strict(),
    youtube: z.object({ title: str, description: str, hashtags: strs, tags: strs }).strict(),
    facebook: z.object({ text: str, hashtags: strs }).strict(),
  })
  .strict();

/**
 * JSON text of the final answer. After a server-side fallback the content can hold a `fallback`
 * block; only text after the last one belongs to the model that finished the answer.
 */
export function finalText(message: BetaMessage): string {
  const blocks = message.content;
  let start = 0;
  blocks.forEach((b, i) => {
    if (b.type === 'fallback') start = i + 1;
  });
  return blocks
    .slice(start)
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('');
}

export function parseOutput(message: BetaMessage): AiOutput {
  const text = finalText(message).trim();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AiError('fatal', 'Claude returned text that is not valid JSON.');
  }
  const parsed = AiOutputSchema.safeParse(json);
  if (!parsed.success)
    throw new AiError('fatal', 'Claude returned JSON that does not match the expected shape.');
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------
// Call loop
// ---------------------------------------------------------------------------------------------

export interface CallResult {
  output: AiOutput;
  message: BetaMessage;
  requestId: string | null;
}

/**
 * Sends the request and checks stop_reason before parsing:
 *  - 'refusal'    → AiError('refusal'), after one manual retry on models without server fallback;
 *  - 'max_tokens' → one retry with RETRY_MAX_TOKENS, then AiError('fatal').
 * `onResponse` sees every response (also the discarded ones) so their tokens are billed.
 */
export async function callClaude(
  client: ClaudeClient,
  params: BetaMessageStreamParams,
  opts: { log: Logger; onResponse: (message: BetaMessage, requestId: string | null) => void },
): Promise<CallResult> {
  let current = params;
  let refusalRetried = FALLBACK_MODELS.has(params.model);
  let maxTokensRetried = false;
  for (;;) {
    let res: { message: BetaMessage; requestId: string | null };
    try {
      res = await client.send(current);
    } catch (e) {
      throw toAiError(e);
    }
    opts.onResponse(res.message, res.requestId);
    const stop = res.message.stop_reason;
    if (stop === 'refusal') {
      if (!refusalRetried) {
        refusalRetried = true;
        opts.log.warn('Claude declined; retrying once', { model: params.model });
        continue;
      }
      const category = res.message.stop_details?.category ?? null;
      throw new AiError(
        'refusal',
        `Claude declined to write this text${category ? ` (${category})` : ''}. Write it manually.`,
      );
    }
    if (stop === 'max_tokens') {
      if (!maxTokensRetried) {
        maxTokensRetried = true;
        opts.log.warn('Claude hit max_tokens; retrying with more room', { model: params.model });
        current = { ...current, max_tokens: RETRY_MAX_TOKENS };
        continue;
      }
      throw new AiError('fatal', 'Claude ran out of room twice while writing the text.');
    }
    return { output: parseOutput(res.message), message: res.message, requestId: res.requestId };
  }
}
