'use client';

/**
 * Defaults (PLAN.md §11 B2): platforms, YouTube/Instagram/Facebook options, missed-post policy,
 * minimum gap, media cleanup and the time zone.
 */
import { useState } from 'react';
import type { Platform } from '@app/db/schema';
import { PLATFORM_LABELS } from '@app/core/platforms';
import { saveDefaultsAction } from '@/lib/actions/settings';
import { Input, Label, Select } from '@/components/ui/field';
import { SaveBar, Section, SubHeading, Toggle, same, useSettingsAction } from './parts';
import {
  DefaultsSchema,
  MISSED_POLICY_LABEL,
  YOUTUBE_CATEGORIES,
  YOUTUBE_LANGUAGES,
  firstIssue,
  type DefaultsInput,
} from './schemas';

const ALL: Platform[] = ['instagram', 'youtube', 'facebook'];

export function DefaultsSection({
  initial,
  timeZones,
}: {
  initial: DefaultsInput;
  timeZones: string[];
}) {
  const { pending, run } = useSettingsAction();
  const [baseline, setBaseline] = useState(initial);
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof DefaultsInput>(k: K, v: DefaultsInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const yt = <K extends keyof DefaultsInput['youtubeDefaults']>(
    k: K,
    v: DefaultsInput['youtubeDefaults'][K],
  ) => setForm((f) => ({ ...f, youtubeDefaults: { ...f.youtubeDefaults, [k]: v } }));

  const save = () => {
    const parsed = DefaultsSchema.safeParse(form);
    if (!parsed.success) {
      setError(firstIssue(parsed.error));
      return;
    }
    setError(null);
    run(
      () => saveDefaultsAction(parsed.data),
      () => setBaseline(form),
    );
  };

  const num = (v: string) => (v === '' ? Number.NaN : Number(v));
  const zones = timeZones.includes(form.timezone) ? timeZones : [form.timezone, ...timeZones];
  const categoryKnown = YOUTUBE_CATEGORIES.some((c) => c.id === form.youtubeDefaults.categoryId);

  return (
    <Section
      id="defaults"
      title="Defaults"
      description="Used for every new video. You can still change them per video in the editor."
    >
      <fieldset>
        <legend className="mb-1 text-sm font-medium">Post to</legend>
        <div className="flex flex-wrap gap-x-5">
          {ALL.map((p) => (
            <Toggle
              key={p}
              checked={form.defaultPlatforms.includes(p)}
              onChange={(v) =>
                set(
                  'defaultPlatforms',
                  v
                    ? ALL.filter((x) => x === p || form.defaultPlatforms.includes(x))
                    : form.defaultPlatforms.filter((x) => x !== p),
                )
              }
              label={PLATFORM_LABELS[p]}
            />
          ))}
        </div>
      </fieldset>

      <SubHeading>YouTube</SubHeading>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <Label htmlFor="yt-privacy">Privacy</Label>
          <Select
            id="yt-privacy"
            value={form.youtubeDefaults.privacy}
            onChange={(e) =>
              yt('privacy', e.target.value as DefaultsInput['youtubeDefaults']['privacy'])
            }
          >
            <option value="public">Public</option>
            <option value="unlisted">Unlisted</option>
            <option value="private">Private</option>
          </Select>
        </div>
        <div>
          <Label htmlFor="yt-cat">Category</Label>
          <Select
            id="yt-cat"
            value={form.youtubeDefaults.categoryId}
            onChange={(e) => yt('categoryId', e.target.value)}
          >
            {!categoryKnown ? (
              <option value={form.youtubeDefaults.categoryId}>
                Category {form.youtubeDefaults.categoryId}
              </option>
            ) : null}
            {YOUTUBE_CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="yt-lang">Video language</Label>
          <Select
            id="yt-lang"
            value={form.youtubeDefaults.defaultLanguage}
            onChange={(e) => yt('defaultLanguage', e.target.value)}
          >
            {YOUTUBE_LANGUAGES.some((l) => l.id === form.youtubeDefaults.defaultLanguage) ? null : (
              <option value={form.youtubeDefaults.defaultLanguage}>
                {form.youtubeDefaults.defaultLanguage}
              </option>
            )}
            {YOUTUBE_LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="mt-2 grid gap-x-4 sm:grid-cols-3">
        <Toggle
          checked={form.youtubeDefaults.madeForKids}
          onChange={(v) => yt('madeForKids', v)}
          label="Made for kids"
        />
        <Toggle
          checked={form.youtubeDefaults.notifySubscribers}
          onChange={(v) => yt('notifySubscribers', v)}
          label="Notify subscribers"
        />
        <Toggle
          checked={form.youtubeDefaults.syntheticMedia}
          onChange={(v) => yt('syntheticMedia', v)}
          label="AI-altered video"
          hint="Only for realistic altered footage. AI-written text alone doesn't count."
        />
      </div>

      <SubHeading>Instagram & Facebook</SubHeading>
      <div className="grid gap-3 sm:grid-cols-2">
        <Toggle
          checked={form.instagramDefaults.shareToFeed}
          onChange={(v) => set('instagramDefaults', { shareToFeed: v })}
          label="Instagram: also show the Reel in the main feed"
        />
        <div>
          <Label htmlFor="fb-kind">Facebook post type</Label>
          <Select
            id="fb-kind"
            value={form.facebookDefaults.kind}
            onChange={(e) =>
              set('facebookDefaults', {
                kind: e.target.value as DefaultsInput['facebookDefaults']['kind'],
              })
            }
          >
            <option value="auto">Auto (Reel when 3–90 s and vertical)</option>
            <option value="reel">Always Reel</option>
            <option value="video">Always normal Page video</option>
          </Select>
        </div>
      </div>

      <SubHeading>Timing</SubHeading>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Label htmlFor="missed">If an Instagram post was missed (server down)</Label>
          <Select
            id="missed"
            value={form.missedPolicy}
            onChange={(e) => set('missedPolicy', e.target.value as DefaultsInput['missedPolicy'])}
          >
            {Object.entries(MISSED_POLICY_LABEL).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="grace" hint="minutes">
            Grace time for late posts
          </Label>
          <Input
            id="grace"
            type="number"
            inputMode="numeric"
            min={0}
            max={1440}
            value={Number.isNaN(form.lateGraceMinutes) ? '' : form.lateGraceMinutes}
            onChange={(e) => set('lateGraceMinutes', num(e.target.value))}
          />
        </div>
        <div>
          <Label htmlFor="gap" hint="minutes, same platform">
            Minimum gap between posts
          </Label>
          <Input
            id="gap"
            type="number"
            inputMode="numeric"
            min={0}
            max={240}
            value={Number.isNaN(form.minGapMinutes) ? '' : form.minGapMinutes}
            onChange={(e) => set('minGapMinutes', num(e.target.value))}
          />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="tz" hint="All times in the app use this zone">
            Time zone
          </Label>
          <Select id="tz" value={form.timezone} onChange={(e) => set('timezone', e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z === 'Asia/Kolkata' ? 'Asia/Kolkata (IST)' : z}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <SubHeading>Storage</SubHeading>
      <div className="grid items-end gap-3 sm:grid-cols-2">
        <Toggle
          checked={form.keepOriginals}
          onChange={(v) => set('keepOriginals', v)}
          label="Keep original videos forever"
        />
        <div>
          <Label htmlFor="purge" hint="after everything is published">
            Otherwise delete originals after (days)
          </Label>
          <Input
            id="purge"
            type="number"
            inputMode="numeric"
            min={1}
            max={365}
            disabled={form.keepOriginals}
            value={Number.isNaN(form.purgeAfterDays) ? '' : form.purgeAfterDays}
            onChange={(e) => set('purgeAfterDays', num(e.target.value))}
          />
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <SaveBar dirty={!same(form, baseline)} pending={pending} onSave={save} />
    </Section>
  );
}
