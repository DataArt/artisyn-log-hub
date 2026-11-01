/**
 * Hover tooltip of the OTEL cost chart (FR-27): the bucket's series sorted by value, largest
 * first, each with a share bar, then the total and the cumulative value. Rendered through
 * `ViewportPopover`, so it never leaves the viewport.
 */
import { ViewportPopover } from '../../../components/ViewportPopover';
import type { OtelInterval } from '../../../../models/repositories';
import type { OtelChartRow, OtelSeries } from './otel-chart-data';
import {
  formatBucketStart,
  formatCount,
  formatShare,
  formatUsd,
} from './otel-format';
import type { OtelMetric } from './otel-url-state';

export function formatOtelMetric(value: number, metric: OtelMetric): string {
  if (metric === 'cost') return formatUsd(value);
  if (metric === 'tokens') return formatCount(Math.round(value));
  return formatCount(value);
}

/** The tooltip lines of a row: visible series with a value, sorted by value (pure). */
export function otelTooltipLines(
  row: OtelChartRow,
  series: readonly OtelSeries[],
  hiddenKeys: ReadonlySet<string>,
): { series: OtelSeries; value: number; share: number }[] {
  return series
    .filter((s) => !hiddenKeys.has(s.key) && (row.values[s.key] ?? 0) !== 0)
    .map((s) => {
      const value = row.values[s.key] ?? 0;
      return { series: s, value, share: row.total > 0 ? value / row.total : 0 };
    })
    .sort(
      (a, b) =>
        b.value - a.value || a.series.label.localeCompare(b.series.label),
    );
}

export interface OtelChartTooltipProps {
  x: number;
  y: number;
  row: OtelChartRow;
  series: readonly OtelSeries[];
  hiddenKeys: ReadonlySet<string>;
  metric: OtelMetric;
  interval: OtelInterval;
  showCumulative: boolean;
}

export function OtelChartTooltip({
  x,
  y,
  row,
  series,
  hiddenKeys,
  metric,
  interval,
  showCumulative,
}: OtelChartTooltipProps) {
  const lines = otelTooltipLines(row, series, hiddenKeys);
  return (
    <ViewportPopover x={x} y={y} maxWidth={340} className="text-xs">
      <div
        className="min-w-[240px] space-y-1.5"
        data-testid="otel-chart-tooltip"
      >
        <div className="font-semibold">
          {formatBucketStart(row.start, interval)}
        </div>
        {lines.length === 0 && (
          <div className="text-muted-foreground">No data in this bucket</div>
        )}
        {lines.map((l) => (
          <div key={l.series.key} className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span
                className="inline-block size-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: l.series.color }}
              />
              <span className="flex-1 truncate">{l.series.label}</span>
              <span className="font-mono">
                {formatOtelMetric(l.value, metric)}
              </span>
              <span className="w-12 text-right text-muted-foreground">
                {formatShare(l.share)}
              </span>
            </div>
            <div className="ml-4 h-1 rounded bg-muted">
              <div
                className="h-1 rounded"
                style={{
                  width: `${Math.max(0, Math.min(100, l.share * 100))}%`,
                  backgroundColor: l.series.color,
                }}
              />
            </div>
          </div>
        ))}
        <div className="flex justify-between border-t border-border pt-1 font-semibold">
          <span>Total</span>
          <span className="font-mono">
            {formatOtelMetric(row.total, metric)}
          </span>
        </div>
        {showCumulative && (
          <div className="flex justify-between text-muted-foreground">
            <span>Cumulative</span>
            <span className="font-mono">
              {formatOtelMetric(row.cumulative, metric)}
            </span>
          </div>
        )}
      </div>
    </ViewportPopover>
  );
}
