'use client';

/**
 * One editable field: label + live counter (red over the limit) + input + the platform's issues
 * for this field + [Regenerate] [⋯].
 */
import { useId, type ReactNode } from 'react';
import type { TextIssue } from '@app/core/text';
import { Counter } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import type { FieldMeter } from '@/lib/upload/fields';
import { RefineControls, type RefineChoice } from './RefineMenu';

export function FieldBlock({
  label,
  meter,
  issues,
  refining,
  readOnly,
  onRefine,
  children,
}: {
  label: string;
  meter: FieldMeter;
  issues: TextIssue[];
  refining: boolean;
  readOnly: boolean;
  onRefine: (action: RefineChoice) => void;
  /** Receives the ids to wire up: input id and the describedby id. */
  children: (ids: { inputId: string; describedBy: string }) => ReactNode;
}) {
  const inputId = useId();
  const hintId = useId();
  const over = meter.value > meter.max;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={inputId} className="text-sm font-medium">
          {label}
        </label>
        <span className="flex items-baseline gap-1">
          {meter.hint ? (
            <span className="hidden text-[11px] text-muted sm:inline">{meter.hint}</span>
          ) : null}
          <Counter value={meter.value} max={meter.max} unit={meter.unit} />
        </span>
      </div>
      {children({ inputId, describedBy: hintId })}
      <div id={hintId} className="space-y-0.5">
        {over ? (
          <p className="text-xs text-danger">
            Over the limit by {meter.value - meter.max}
            {meter.unit ? ` ${meter.unit}` : ''}.
          </p>
        ) : null}
        {issues
          .filter((i) => !(over && i.severity === 'block' && /too_long|too_many/.test(i.code)))
          .map((i) => (
            <p
              key={i.code}
              className={cn('text-xs', i.severity === 'block' ? 'text-danger' : 'text-warn')}
            >
              <span aria-hidden>{i.severity === 'block' ? '! ' : '⚠ '}</span>
              {i.message}
            </p>
          ))}
      </div>
      {!readOnly ? (
        <div className="flex justify-end">
          <RefineControls fieldLabel={label} busy={refining} onRefine={onRefine} />
        </div>
      ) : null}
    </div>
  );
}
