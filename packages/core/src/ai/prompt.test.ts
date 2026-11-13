import { describe, expect, it } from 'vitest';
import {
  OUTPUT_JSON_SCHEMA,
  buildFieldTask,
  buildGenerateTask,
  buildRequest,
  buildSystemPrompt,
  buildVideoBlocks,
} from './prompt';
import { sampleOutput, testSettings } from './test-helpers';

const frames = [
  { idx: 0, tMs: 500, source: 'hook' as const, jpeg: Buffer.from('frame-zero') },
  { idx: 1, tMs: 8000, source: 'uniform' as const, jpeg: Buffer.from('frame-one') },
];
const video = {
  asset: {
    filename: 'chai.mp4',
    durationMs: 58_200,
    transcript: 'Bhaiya ek special chai dena',
    notes: 'Stall in Dadar, Mumbai',
  },
  batchNotes: '',
  frames,
};

function request(model: string) {
  return buildRequest({
    model,
    effort: 'low',
    system: buildSystemPrompt(testSettings()),
    videoBlocks: buildVideoBlocks(video),
    task: buildGenerateTask({ platforms: ['youtube'], manual: [], needTitleForFacebook: false }),
  });
}

describe('buildRequest', () => {
  it('never sends sampling or thinking parameters', () => {
    const p = request('claude-opus-5-5') as unknown as Record<string, unknown>;
    for (const k of ['temperature', 'top_p', 'top_k', 'thinking', 'tool_choice', 'tools'])
      expect(p).not.toHaveProperty(k);
    expect(p.max_tokens).toBe(12_000);
  });

  it('pins effort and a JSON schema format', () => {
    const p = request('claude-opus-5-5');
    expect(p.output_config).toEqual({
      effort: 'low',
      format: { type: 'json_schema', schema: OUTPUT_JSON_SCHEMA },
    });
  });

  it('caches the system prompt and the frames+transcript block for 1 hour', () => {
    const p = request('claude-opus-5-5');
    const system = p.system as Array<{ cache_control?: unknown }>;
    expect(system).toHaveLength(1);
    expect(system[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });

    const content = p.messages[0]!.content as unknown as Array<Record<string, unknown>>;
    expect(p.messages).toHaveLength(1);
    expect(p.messages[0]!.role).toBe('user');
    // frame label, image, frame label, image, context (cached), task (not cached)
    expect(content.map((b) => b.type)).toEqual(['text', 'image', 'text', 'image', 'text', 'text']);
    expect(content[0]!.text).toBe('Frame 0 at 0.5 s (hook)');
    expect(content[1]!.source).toEqual({
      type: 'base64',
      media_type: 'image/jpeg',
      data: Buffer.from('frame-zero').toString('base64'),
    });
    expect(content[4]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(content[4]!.text).toContain('Bhaiya ek special chai dena');
    expect(content[4]!.text).toContain('Stall in Dadar, Mumbai');
    expect(content[4]!.text).toContain('58.2 s');
    expect(content[5]!.cache_control).toBeUndefined();
    const breakpoints = content.filter((b) => b.cache_control).length + 1;
    expect(breakpoints).toBeLessThanOrEqual(4);
  });

  it('sends server-side refusal fallback only for Opus 5.5 and Sonnet 5.5', () => {
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5']) {
      const p = request(m);
      expect(p.betas).toEqual(['server-side-fallback-2026-07-01']);
      expect(p.fallbacks).toBe('default');
    }
    const haiku = request('claude-haiku-5-5');
    expect(haiku.betas).toBeUndefined();
    expect(haiku.fallbacks).toBeUndefined();
  });

  it('keeps the cached prefix identical between a generation and a field rewrite', () => {
    const gen = request('claude-opus-5-5');
    const refine = buildRequest({
      model: 'claude-opus-5-5',
      effort: 'low',
      system: buildSystemPrompt(testSettings()),
      videoBlocks: buildVideoBlocks(video),
      task: buildFieldTask({
        current: sampleOutput(),
        edits: [{ slot: 'youtube.title', instruction: 'shorter' }],
      }),
    });
    expect(refine.system).toEqual(gen.system);
    expect(refine.output_config).toEqual(gen.output_config);
    const prefix = (p: typeof gen) => (p.messages[0]!.content as unknown[]).slice(0, -1);
    expect(prefix(refine)).toEqual(prefix(gen));
  });

  it('says so when there are no frames or no speech', () => {
    const blocks = buildVideoBlocks({
      asset: { filename: 'x.mp4', durationMs: null, transcript: null, notes: '' },
      frames: [],
    });
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('no speech detected');
    expect(text).toContain('none available');
  });
});

describe('buildSystemPrompt', () => {
  it('is long enough to be cached (≥512 tokens ≈ 2,000+ characters) and deterministic', () => {
    const s = buildSystemPrompt(testSettings());
    expect(s.length).toBeGreaterThan(3000);
    expect(buildSystemPrompt(testSettings())).toBe(s);
  });

  it('includes settings: scripts, hashtag counts, banned words, voice', () => {
    const s = buildSystemPrompt(
      testSettings({ brandVoice: 'Funny Mumbai foodie', exampleCaptions: 'Vada pav > burger' }),
    );
    expect(s).toContain('Hinglish in Roman letters');
    expect(s).toContain('Simple, natural English only.'); // facebook = english
    expect(s).toContain('3–5 hashtags');
    expect(s).toContain('2–3 hashtags');
    expect(s).toContain('no hashtags: return an empty hashtags list');
    expect(s).toContain('- guaranteed');
    expect(s).toContain('Funny Mumbai foodie');
    expect(s).toContain('Vada pav > burger');
    expect(s).toMatch(/NO hashtags, NO links, NO series/);
    expect(s).toMatch(/Never name or identify a person unless/);
  });

  it('caps Instagram hashtags at 5 even if settings ask for more', () => {
    const s = buildSystemPrompt(
      testSettings({
        hashtagCounts: {
          instagram: { min: 10, max: 30 },
          youtube: { min: 2, max: 3 },
          facebook: { min: 0, max: 0 },
        },
      }),
    );
    expect(s).toContain('Instagram Reels\n- caption');
    expect(s).toContain('exactly 5 hashtags');
  });
});

describe('OUTPUT_JSON_SCHEMA', () => {
  it('requires every field, forbids extra ones and has no reasoning field', () => {
    const check = (node: Record<string, unknown>) => {
      if (node.type !== 'object') return;
      const props = node.properties as Record<string, Record<string, unknown>>;
      expect(node.additionalProperties).toBe(false);
      expect(node.required).toEqual(Object.keys(props));
      for (const child of Object.values(props)) check(child);
    };
    check(OUTPUT_JSON_SCHEMA);
    const props = OUTPUT_JSON_SCHEMA.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual([
      'summary',
      'detected_language',
      'story_hook',
      'cover_frame_index',
      'instagram',
      'youtube',
      'facebook',
    ]);
    expect(JSON.stringify(OUTPUT_JSON_SCHEMA)).not.toMatch(/reasoning|maxLength|minimum/);
  });
});

describe('task text', () => {
  it('lists the selected platforms and the manual fields', () => {
    const t = buildGenerateTask({
      platforms: ['instagram', 'facebook'],
      manual: [{ slot: 'instagram.body', value: 'My own caption' }],
      needTitleForFacebook: true,
    });
    expect(t).toContain('Instagram: instagram.caption');
    expect(t).toContain('Facebook: facebook.text');
    expect(t).not.toContain('YouTube:');
    expect(t).toContain('youtube.title only');
    expect(t).toContain('"My own caption"');
  });
});
