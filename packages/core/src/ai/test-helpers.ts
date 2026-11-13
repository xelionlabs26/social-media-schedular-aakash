/**
 * Test helpers for the AI module (fake Claude client, canned outputs). Not used at runtime.
 */
import type { BetaMessage, BetaMessageStreamParams, ClaudeClient } from './client';
import type { AppSettings } from '@app/db';
import type { AiOutput } from './types';

export function sampleOutput(overrides: Partial<AiOutput> = {}): AiOutput {
  return {
    summary: 'A street vendor makes tea with a surprising trick.',
    detected_language: 'hinglish',
    story_hook: 'Chai mein ye cheez daali aur sab hairan',
    cover_frame_index: 2,
    instagram: {
      caption:
        'Chai wale bhaiya ne ye kya daal diya? 😮\nPehle laga normal chai hai.\nPhir pehla sip liya…\nTumne kabhi try kiya hai? 👇',
      hashtags: ['#ChaiLover', 'streetfood', 'Mumbai'],
    },
    youtube: {
      title: 'Chai mein ye daala aur sab hairan',
      description: 'Chai mein ye daala aur sab hairan.\n\nMumbai ki ek gali, ek chhota sa stall.',
      hashtags: ['chai', 'streetfood'],
      tags: ['chai', 'street food', 'mumbai'],
    },
    facebook: { text: 'Chai mein ye daala aur sab hairan! Aapne try kiya hai?', hashtags: [] },
    ...overrides,
  };
}

export function fakeMessage(
  output: unknown,
  opts: {
    model?: string;
    stop?: BetaMessage['stop_reason'];
    usage?: Partial<BetaMessage['usage']>;
    contentPrefix?: unknown[];
  } = {},
): BetaMessage {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: opts.model ?? 'claude-opus-5-5',
    content: [
      ...(opts.contentPrefix ?? []),
      {
        type: 'text',
        text: typeof output === 'string' ? output : JSON.stringify(output),
        citations: null,
      },
    ],
    stop_reason: opts.stop ?? 'end_turn',
    stop_details: null,
    stop_sequence: null,
    container: null,
    context_management: null,
    diagnostics: null,
    usage: {
      input_tokens: 100,
      output_tokens: 800,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 9000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 9000 },
      ...opts.usage,
    },
  } as unknown as BetaMessage;
}

/** A fake client that replays responses (or throws errors) in order and records requests. */
export function fakeClient(responses: Array<BetaMessage | Error>): ClaudeClient & {
  calls: BetaMessageStreamParams[];
} {
  const calls: BetaMessageStreamParams[] = [];
  return {
    calls,
    async send(params) {
      calls.push(structuredClone(params));
      const next = responses.shift();
      if (!next) throw new Error('fakeClient: no more responses');
      if (next instanceof Error) throw next;
      return { message: next, requestId: `req_${calls.length}` };
    },
  };
}

export function testSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    id: 1,
    timezone: 'Asia/Kolkata',
    defaultPlatforms: ['instagram', 'youtube', 'facebook'],
    brandVoice: '',
    exampleCaptions: '',
    bannedWords: 'guaranteed, shocking',
    emojiLevel: 'light',
    captionScript: { instagram: 'hinglish_roman', youtube: 'hinglish_roman', facebook: 'english' },
    hashtagCounts: {
      instagram: { min: 3, max: 5 },
      youtube: { min: 2, max: 3 },
      facebook: { min: 0, max: 0 },
    },
    aiModel: 'claude-opus-5-5',
    aiEffort: 'low',
    sttProvider: 'openai',
    youtubeDefaults: {
      privacy: 'public',
      categoryId: '22',
      madeForKids: false,
      notifySubscribers: true,
      syntheticMedia: false,
      defaultLanguage: 'hi',
    },
    instagramDefaults: { shareToFeed: true },
    facebookDefaults: { kind: 'auto' },
    missedPolicy: 'publish_late_or_ask',
    lateGraceMinutes: 120,
    minGapMinutes: 5,
    keepOriginals: false,
    purgeAfterDays: 7,
    notifyChannel: 'telegram',
    telegramChatId: null,
    notifyEmail: null,
    dailyDigest: false,
    sessionVersion: 1,
    privacyAcceptedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}
