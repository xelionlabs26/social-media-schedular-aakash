'use client';

/**
 * Optional fixed-text templates (PLAN.md §3.8), off by default. Applied in code after the AI
 * runs, so platform limits are checked after filling.
 */
import { useState } from 'react';
import { saveTemplatesAction } from '@/lib/actions/settings';
import { Label, Select, Textarea } from '@/components/ui/field';
import { SaveBar, Section, Toggle, same, useSettingsAction } from './parts';
import {
  TEMPLATE_MODES,
  TEMPLATE_MODE_LABEL,
  TEMPLATE_SLOTS,
  TEMPLATE_TOKENS,
  TemplateSchema,
  TemplatesSchema,
  firstIssue,
  type TemplateInput,
} from './schemas';

const key = (t: Pick<TemplateInput, 'platform' | 'field'>) => `${t.platform}.${t.field}`;

export function TemplatesSection({ initial }: { initial: TemplateInput[] }) {
  const { pending, run } = useSettingsAction();
  const [baseline, setBaseline] = useState(initial);
  const [list, setList] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  const update = (k: string, patch: Partial<TemplateInput>) =>
    setList((cur) => cur.map((t) => (key(t) === k ? { ...t, ...patch } : t)));

  const save = () => {
    const parsed = TemplatesSchema.safeParse(list);
    if (!parsed.success) {
      setError(firstIssue(parsed.error));
      return;
    }
    setError(null);
    run(
      () => saveTemplatesAction(parsed.data),
      () => setBaseline(list),
    );
  };

  return (
    <Section
      id="templates"
      title="Templates (optional)"
      description={
        <>
          Off by default: Claude writes everything. Turn one on to add fixed text. Tokens:{' '}
          {TEMPLATE_TOKENS.map((t) => (
            <code key={t} className="mr-1 rounded bg-surface-2 px-1 text-xs">
              {t}
            </code>
          ))}
        </>
      }
    >
      <div className="space-y-3">
        {TEMPLATE_SLOTS.map((slot) => {
          const t = list.find((x) => key(x) === key(slot));
          if (!t) return null;
          const k = key(t);
          const rowCheck = TemplateSchema.safeParse(t);
          const rowError = rowCheck.success ? null : firstIssue(rowCheck.error);
          return (
            <div key={k} className="rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{slot.label}</h3>
                <Toggle
                  checked={t.enabled}
                  onChange={(v) => update(k, { enabled: v })}
                  label="Use template"
                />
              </div>
              {t.enabled ? (
                <div className="mt-2 grid gap-3 sm:grid-cols-[12rem_1fr]">
                  <div>
                    <Label htmlFor={`${k}-mode`}>Mode</Label>
                    <Select
                      id={`${k}-mode`}
                      value={t.mode}
                      onChange={(e) => update(k, { mode: e.target.value as TemplateInput['mode'] })}
                    >
                      {TEMPLATE_MODES.map((m) => (
                        <option key={m} value={m}>
                          {TEMPLATE_MODE_LABEL[m]}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor={`${k}-pattern`}>Pattern</Label>
                    <Textarea
                      id={`${k}-pattern`}
                      className="min-h-16"
                      value={t.pattern}
                      onChange={(e) => update(k, { pattern: e.target.value })}
                      placeholder={
                        slot.field === 'title'
                          ? '{ai_title} | Day {n}'
                          : '{ai_body}\n\nNew video every day'
                      }
                      aria-invalid={rowError ? true : undefined}
                      aria-describedby={rowError ? `${k}-err` : undefined}
                    />
                    {rowError ? (
                      <p id={`${k}-err`} className="mt-1 text-xs text-danger">
                        {rowError}
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <SaveBar dirty={!same(list, baseline)} pending={pending} onSave={save} />
    </Section>
  );
}
