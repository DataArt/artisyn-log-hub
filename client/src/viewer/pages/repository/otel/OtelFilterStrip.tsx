/**
 * The filter strip of the repository and team OTEL tabs (Visual/UX notes): period (presets or a
 * custom range of local days), the team tab's optional repository / people pickers, model,
 * Claude Code version and calls, with the live indicator at its end. The repository tab binds it
 * to `otel-url-state.ts`; the team tab keeps its state locally (`value` / `onChange`).
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import type { OtelCallsFilter } from '../../../../models/repositories';
import { OtelSegmented, type OtelSegmentedOption } from './OtelChartControls';
import {
  OTEL_PERIOD_PRESETS,
  type OtelPeriod,
  type OtelPeriodPreset,
} from './otel-url-state';

export interface OtelFilterStripValue {
  period: OtelPeriod;
  models: string[];
  ccVersions: string[];
  calls: OtelCallsFilter;
}

export interface OtelFilterStripProps {
  value: OtelFilterStripValue;
  onChange: (patch: Partial<OtelFilterStripValue>) => void;
  modelOptions: readonly string[];
  ccVersionOptions: readonly string[];
  /** The live indicator, shown at the end of the strip. */
  indicator?: ReactNode;
  /** Team tab: repository and people pickers after the period (DD-29). */
  pickers?: readonly OtelFilterPicker[];
}

/** A single-choice picker whose options carry their own labels (e.g. user id → e-mail). */
export interface OtelFilterPicker {
  label: string;
  allLabel: string;
  /** The selected option value, `''` = all. */
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  testId: string;
}

/** One labelled option or "all"; a selected value missing from the options stays selectable. */
function OtelLabelledPick({ picker }: { picker: OtelFilterPicker }) {
  const { label, allLabel, value, options, onChange, testId } = picker;
  const all =
    value && !options.some((o) => o.value === value)
      ? [{ value, label: value }, ...options]
      : options;
  return (
    <label className="flex items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <select
        className="h-7 max-w-[260px] rounded-md border border-border bg-background px-1.5 text-xs"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
      >
        <option value="">{allLabel}</option>
        {all.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const PRESET_LABELS: Record<OtelPeriodPreset, string> = {
  '24h': '24 h',
  '7d': '7 d',
  '30d': '30 d',
  '90d': '90 d',
};

const CALLS_OPTIONS: readonly OtelSegmentedOption<OtelCallsFilter>[] = [
  { value: 'all', label: 'All' },
  { value: 'hidden', label: 'Hidden only' },
  { value: 'transcript', label: 'In transcript' },
];

function localDateOnly(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function customDefault(): OtelPeriod {
  const end = new Date();
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 6);
  return {
    kind: 'custom',
    startDate: localDateOnly(start),
    endDate: localDateOnly(end),
  };
}

interface PickProps {
  label: string;
  allLabel: string;
  value: string[];
  options: readonly string[];
  onChange: (next: string[]) => void;
  testId: string;
}

/** One value or "all"; a value in the URL that is not among the options stays selectable. */
function OtelPick({
  label,
  allLabel,
  value,
  options,
  onChange,
  testId,
}: PickProps) {
  const current = value[0] ?? '';
  const all =
    current && !options.includes(current) ? [current, ...options] : options;
  return (
    <label className="flex items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <select
        className="h-7 max-w-[220px] rounded-md border border-border bg-background px-1.5 text-xs"
        value={current}
        onChange={(e) => onChange(e.target.value ? [e.target.value] : [])}
        data-testid={testId}
      >
        <option value="">{allLabel}</option>
        {all.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

export function OtelFilterStrip({
  value,
  onChange,
  modelOptions,
  ccVersionOptions,
  indicator,
  pickers,
}: OtelFilterStripProps) {
  const period = value.period;
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2"
      data-testid="otel-filter-strip"
    >
      <div className="flex items-center gap-1.5 text-xs">
        <span className="text-muted-foreground">Period</span>
        <div className="inline-flex overflow-hidden rounded-md border border-border">
          {OTEL_PERIOD_PRESETS.map((p) => {
            const active = period.kind === 'preset' && period.preset === p;
            return (
              <button
                key={p}
                type="button"
                aria-pressed={active}
                onClick={() =>
                  onChange({ period: { kind: 'preset', preset: p } })
                }
                className={cn(
                  'border-r border-border px-2 py-1',
                  active
                    ? 'bg-blue-50 font-semibold text-blue-700'
                    : 'hover:bg-accent',
                )}
              >
                {PRESET_LABELS[p]}
              </button>
            );
          })}
          <button
            type="button"
            aria-pressed={period.kind === 'custom'}
            onClick={() => {
              if (period.kind !== 'custom')
                onChange({ period: customDefault() });
            }}
            className={cn(
              'px-2 py-1',
              period.kind === 'custom'
                ? 'bg-blue-50 font-semibold text-blue-700'
                : 'hover:bg-accent',
            )}
          >
            Custom
          </button>
        </div>
        {period.kind === 'custom' && (
          <span className="flex items-center gap-1">
            <input
              type="date"
              className="h-7 rounded-md border border-border px-1 text-xs"
              value={period.startDate}
              max={period.endDate}
              onChange={(e) =>
                e.target.value &&
                onChange({ period: { ...period, startDate: e.target.value } })
              }
              aria-label="Start date"
            />
            –
            <input
              type="date"
              className="h-7 rounded-md border border-border px-1 text-xs"
              value={period.endDate}
              min={period.startDate}
              onChange={(e) =>
                e.target.value &&
                onChange({ period: { ...period, endDate: e.target.value } })
              }
              aria-label="End date"
            />
          </span>
        )}
      </div>
      {pickers?.map((p) => (
        <OtelLabelledPick key={p.testId} picker={p} />
      ))}
      <OtelPick
        label="Model"
        allLabel="All models"
        value={value.models}
        options={modelOptions}
        onChange={(models) => onChange({ models })}
        testId="otel-model-filter"
      />
      <OtelPick
        label="Claude Code"
        allLabel="All versions"
        value={value.ccVersions}
        options={ccVersionOptions}
        onChange={(ccVersions) => onChange({ ccVersions })}
        testId="otel-cc-version-filter"
      />
      <OtelSegmented
        label="Calls"
        value={value.calls}
        options={CALLS_OPTIONS}
        onChange={(calls) => onChange({ calls })}
        testId="otel-calls-filter"
      />
      {indicator}
    </div>
  );
}
