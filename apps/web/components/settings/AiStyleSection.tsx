'use client';

/**
 * AI style (PLAN.md §4.3–4.5, §4.8): brand voice, examples, banned words, emoji level, caption
 * script and hashtag counts per platform, Claude model + effort, speech-to-text provider, and
 * this month's AI cost.
 */
import { useState } from 'react';
import type { Platform, SttProvider } from '@app/db/schema';
import { saveAiStyleAction } from '@/lib/actions/settings';
import { Input, Label, Select, Textarea } from '@/components/ui/field';
import { PLATFORM_LABELS } from '@app/core/platforms';
import { SaveBar, Section, SubHeading, same, useSettingsAction } from './parts';
import {
  AI_EFFORTS,
  AI_MODELS,
  AiStyleSchema,
  CAPTION_SCRIPT_LABEL,
  EMOJI_LEVELS,
  HASHTAG_MAX,
  STT_ENV_KEY,
  STT_LABEL,
  firstIssue,
  type AiStyleInput,
} from './schemas';

const PLATFORMS_UI: Platform[] = ['instagram', 'youtube', 'facebook'];
const STT_ORDER: SttProvider[] = ['openai', 'deepgram', 'sarvam', 'assemblyai', 'mock'];

const EFFORT_HINT: Record<(typeof AI_EFFORTS)[number], string> = {
  low: 'Low (default, fastest)',
  medium: 'Medium (try if captions feel weak)',
  high: 'High (slowest, costs more)',
};

export function AiStyleSection({
  initial,
  sttConfigured,
  ai,
  costUsd,
  monthLabel,
}: {
  initial: AiStyleInput;
  sttConfigured: Record<Exclude<SttProvider, 'mock'>, boolean>;
  ai: { configured: boolean; mock: boolean; missingKeys: string[] };
  costUsd: number;
  monthLabel: string;
}) {
  const { pending, run } = useSettingsAction();
  const [baseline, setBaseline] = useState(initial);
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof AiStyleInput>(k: K, v: AiStyleInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const save = () => {
    const parsed = AiStyleSchema.safeParse(form);
    if (!parsed.success) {
      setError(firstIssue(parsed.error));
      return;
    }
    setError(null);
    run(
      () => saveAiStyleAction(parsed.data),
      () => setBaseline(form),
    );
  };

  const isConfigured = (p: SttProvider) => (p === 'mock' ? true : sttConfigured[p]);

  return (
    <Section
      id="ai"
      title="AI style"
      description="How Claude writes your captions and titles. Titles never get links or hashtags."
    >
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2 rounded-lg bg-surface-2 p-3">
        <div>
          <p className="text-xs text-muted">AI cost this month ({monthLabel})</p>
          <p className="text-xl font-semibold tabular-nums">${costUsd.toFixed(2)}</p>
        </div>
        <p className="text-xs text-muted">
          {ai.mock
            ? 'AI is in mock mode (AI_MOCK=true): no real calls.'
            : ai.configured
              ? 'Claude API key configured ✓'
              : `✗ Add ${ai.missingKeys.join(', ')} to .env to write captions.`}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="md:col-span-2">
          <Label htmlFor="ai-voice" hint="Tone, audience, what you are about">
            Brand voice
          </Label>
          <Textarea
            id="ai-voice"
            value={form.brandVoice}
            onChange={(e) => set('brandVoice', e.target.value)}
            placeholder="Warm and funny, travel + fitness stories, talks like a friend…"
          />
        </div>
        <div className="md:col-span-2">
          <Label htmlFor="ai-examples" hint="3–5 captions or titles you liked">
            Example captions
          </Label>
          <Textarea
            id="ai-examples"
            value={form.exampleCaptions}
            onChange={(e) => set('exampleCaptions', e.target.value)}
            placeholder={'Socha tha normal sunset hoga… phir ye hua 😳\nGym mein aaj kuch alag hua'}
          />
        </div>
        <div>
          <Label htmlFor="ai-banned" hint="Comma separated">
            Banned words
          </Label>
          <Input
            id="ai-banned"
            value={form.bannedWords}
            onChange={(e) => set('bannedWords', e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="ai-emoji">Emoji level</Label>
          <Select
            id="ai-emoji"
            value={form.emojiLevel}
            onChange={(e) => set('emojiLevel', e.target.value as AiStyleInput['emojiLevel'])}
          >
            {EMOJI_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l === 'none' ? 'None' : l === 'light' ? 'Light (default)' : 'Lots'}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <SubHeading>Per platform</SubHeading>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[30rem] text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="py-1 pr-2 font-medium">Platform</th>
              <th className="py-1 pr-2 font-medium">Caption script</th>
              <th className="py-1 pr-2 font-medium">Hashtags min</th>
              <th className="py-1 font-medium">max</th>
            </tr>
          </thead>
          <tbody>
            {PLATFORMS_UI.map((p) => (
              <tr key={p} className="border-t border-border">
                <th scope="row" className="py-2 pr-2 text-left font-medium">
                  {PLATFORM_LABELS[p]}
                </th>
                <td className="py-2 pr-2">
                  <Select
                    aria-label={`${PLATFORM_LABELS[p]} caption script`}
                    value={form.captionScript[p]}
                    onChange={(e) =>
                      set('captionScript', {
                        ...form.captionScript,
                        [p]: e.target.value as AiStyleInput['captionScript'][Platform],
                      })
                    }
                  >
                    {Object.entries(CAPTION_SCRIPT_LABEL).map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </td>
                {(['min', 'max'] as const).map((bound) => (
                  <td key={bound} className="py-2 pr-2">
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={HASHTAG_MAX[p]}
                      aria-label={`${PLATFORM_LABELS[p]} hashtags ${bound}`}
                      className="w-20"
                      value={form.hashtagCounts[p][bound]}
                      onChange={(e) =>
                        set('hashtagCounts', {
                          ...form.hashtagCounts,
                          [p]: { ...form.hashtagCounts[p], [bound]: Number(e.target.value) },
                        })
                      }
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-xs text-muted">
        Hashtags go at the end of the Instagram caption (max {HASHTAG_MAX.instagram}) and the
        YouTube description. Titles never get hashtags.
      </p>

      <SubHeading>Model</SubHeading>
      <div className="grid gap-4 md:grid-cols-2">
        <fieldset>
          <legend className="mb-1 text-sm font-medium">Claude model</legend>
          <div className="space-y-1">
            {AI_MODELS.map((m) => (
              <label key={m.id} className="flex min-h-10 items-center gap-2.5 text-sm">
                <input
                  type="radio"
                  name="ai-model"
                  value={m.id}
                  checked={form.aiModel === m.id}
                  onChange={() => set('aiModel', m.id)}
                  className="h-4 w-4 accent-[var(--color-accent)]"
                />
                <span>
                  {m.label}{' '}
                  <span className="text-xs text-muted">
                    {m.cost}
                    {m.note ? `, ${m.note}` : ''}
                    {m.id === 'claude-opus-5-5' ? ' (default)' : ''}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div>
          <Label htmlFor="ai-effort">Effort</Label>
          <Select
            id="ai-effort"
            value={form.aiEffort}
            onChange={(e) => set('aiEffort', e.target.value as AiStyleInput['aiEffort'])}
          >
            {AI_EFFORTS.map((x) => (
              <option key={x} value={x}>
                {EFFORT_HINT[x]}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <SubHeading>Speech-to-text</SubHeading>
      <fieldset>
        <legend className="sr-only">Speech-to-text provider</legend>
        <div className="grid gap-1 sm:grid-cols-2">
          {STT_ORDER.map((p) => {
            const ok = isConfigured(p);
            return (
              <label key={p} className="flex min-h-10 items-center gap-2.5 text-sm">
                <input
                  type="radio"
                  name="stt"
                  value={p}
                  checked={form.sttProvider === p}
                  onChange={() => set('sttProvider', p)}
                  className="h-4 w-4 accent-[var(--color-accent)]"
                />
                <span>
                  {STT_LABEL[p]}{' '}
                  {ok ? (
                    <span className="text-xs text-ok">✓ configured</span>
                  ) : (
                    <span className="text-xs text-muted">
                      ✗ add {STT_ENV_KEY[p as Exclude<SttProvider, 'mock'>]}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      {!isConfigured(form.sttProvider) ? (
        <p className="mt-1 text-xs text-warn">
          The chosen provider has no key yet, so transcripts will fail until you add it.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <SaveBar dirty={!same(form, baseline)} pending={pending} onSave={save} />
    </Section>
  );
}
