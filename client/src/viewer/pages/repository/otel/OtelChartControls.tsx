/**
 * Chart controls of the OTEL tabs (Visual/UX notes): metric, stack-by, interval, stacked / 100 %
 * view and the cumulative line. The repository tab binds them to `otel-url-state.ts`; the session
 * tab passes its own option lists (no `1d` interval, no Claude Code version stack).
 */
import { cn } from '@/lib/cn';
import type { OtelInterval } from '../../../../models/repositories';
import type { OtelChartView, OtelMetric } from './otel-url-state';

export interface OtelSegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface OtelSegmentedProps<T extends string> {
  label: string;
  value: T;
  options: readonly OtelSegmentedOption<T>[];
  onChange: (value: T) => void;
  testId?: string;
}

/** A labelled row of small toggle buttons, one of them active. */
export function OtelSegmented<T extends string>({
  label,
  value,
  options,
  onChange,
  testId,
}: OtelSegmentedProps<T>) {
  return (
    <div className="flex items-center gap-1.5 text-xs" data-testid={testId}>
      <span className="text-muted-foreground">{label}</span>
      <div className="inline-flex overflow-hidden rounded-md border border-border">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={o.value === value}
            onClick={() => onChange(o.value)}
            className={cn(
              'border-r border-border px-2 py-1 last:border-r-0',
              o.value === value
                ? 'bg-blue-50 font-semibold text-blue-700'
                : 'bg-background hover:bg-accent',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export interface OtelChartControlsValue<S extends string> {
  metric: OtelMetric;
  stackBy: S;
  interval: 'auto' | OtelInterval;
  view: OtelChartView;
  cumulative: boolean;
}

export interface OtelChartControlsProps<S extends string> {
  value: OtelChartControlsValue<S>;
  onChange: (patch: Partial<OtelChartControlsValue<S>>) => void;
  stackByOptions: readonly OtelSegmentedOption<S>[];
  intervalOptions?: readonly OtelSegmentedOption<'auto' | OtelInterval>[];
}

const METRIC_OPTIONS: readonly OtelSegmentedOption<OtelMetric>[] = [
  { value: 'cost', label: 'Cost' },
  { value: 'calls', label: 'Calls' },
  { value: 'tokens', label: 'Tokens' },
];

export const OTEL_REPO_INTERVAL_OPTIONS: readonly OtelSegmentedOption<
  'auto' | OtelInterval
>[] = [
  { value: 'auto', label: 'Auto' },
  { value: '5m', label: '5 min' },
  { value: '1h', label: '1 h' },
  { value: '1d', label: '1 day' },
];

export const OTEL_REPO_STACK_OPTIONS = [
  { value: 'structure', label: 'Structure' },
  { value: 'querySource', label: 'query_source' },
  { value: 'model', label: 'Model' },
  { value: 'ccVersion', label: 'CC version' },
] as const;

const VIEW_OPTIONS: readonly OtelSegmentedOption<OtelChartView>[] = [
  { value: 'absolute', label: 'Stacked' },
  { value: 'percent', label: '100 %' },
];

const CUMULATIVE_OPTIONS: readonly OtelSegmentedOption<'on' | 'off'>[] = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

export function OtelChartControls<S extends string>({
  value,
  onChange,
  stackByOptions,
  intervalOptions = OTEL_REPO_INTERVAL_OPTIONS,
}: OtelChartControlsProps<S>) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2"
      data-testid="otel-chart-controls"
    >
      <OtelSegmented
        label="Metric"
        value={value.metric}
        options={METRIC_OPTIONS}
        onChange={(metric) => onChange({ metric })}
        testId="otel-metric"
      />
      <OtelSegmented
        label="Stack by"
        value={value.stackBy}
        options={stackByOptions}
        onChange={(stackBy) => onChange({ stackBy })}
        testId="otel-stack-by"
      />
      <OtelSegmented
        label="Interval"
        value={value.interval}
        options={intervalOptions}
        onChange={(interval) => onChange({ interval })}
        testId="otel-interval"
      />
      <OtelSegmented
        label="View"
        value={value.view}
        options={VIEW_OPTIONS}
        onChange={(view) => onChange({ view })}
        testId="otel-view"
      />
      <OtelSegmented
        label="Cumulative"
        value={value.cumulative ? 'on' : 'off'}
        options={CUMULATIVE_OPTIONS}
        onChange={(v) => onChange({ cumulative: v === 'on' })}
        testId="otel-cumulative"
      />
    </div>
  );
}
