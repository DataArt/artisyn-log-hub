/**
 * Share page of the Live chart carousel (2026-11-05 follow-up): three doughnuts side by side —
 * cost or tokens of the sessions under the selected node by team, by repository and by user
 * (`buildLiveShare`). Each doughnut has a short legend with the value and its share.
 */
import { useState } from 'react';
import { Pie, PieChart, Tooltip } from 'recharts';
import type { OtelLiveNode } from '../../models/otel-live';
import { OtelSegmented } from '../pages/repository/otel/OtelChartControls';
import {
  OTEL_NOT_REPORTED_COLOR,
  OTEL_SERIES_PALETTE,
} from '../pages/repository/otel/otel-chart-data';
import {
  formatMicrosUsd,
  formatShare,
  formatTokenCount,
} from '../pages/repository/otel/otel-format';
import {
  buildLiveShare,
  type LiveShareDimension,
  type LiveShareMetric,
  type LiveShareSlice,
  LIVE_SHARE_TOP,
} from './live-share-data';

const PIE_SIZE = 120;
const SERIES_COLORS = OTEL_SERIES_PALETTE.filter(
  (c) => c !== OTEL_NOT_REPORTED_COLOR,
);

function sliceColor(slice: LiveShareSlice, i: number): string {
  return slice.key === '__other__'
    ? OTEL_NOT_REPORTED_COLOR
    : SERIES_COLORS[i % SERIES_COLORS.length];
}

function formatValue(metric: LiveShareMetric, v: number): string {
  return metric === 'cost' ? formatMicrosUsd(v) : formatTokenCount(v);
}

function SharePie({
  dim,
  metric,
}: {
  dim: LiveShareDimension;
  metric: LiveShareMetric;
}) {
  const total = dim.slices.reduce((s, x) => s + x.value, 0);
  return (
    <div
      className="min-w-0 space-y-1.5"
      data-testid="live-share-pie"
      data-dimension={dim.id}
      data-slices={dim.slices.length}
    >
      <h4 className="text-xs font-medium text-muted-foreground">
        {dim.title}
        <span className="font-normal">
          {' '}
          ·{' '}
          {dim.count > dim.slices.length
            ? `top ${LIVE_SHARE_TOP} of ${dim.count}`
            : dim.count}
        </span>
      </h4>
      <div className="flex items-start gap-3">
        {dim.slices.length === 0 ? (
          <div
            className="flex shrink-0 items-center justify-center text-xs text-muted-foreground"
            style={{ width: PIE_SIZE, height: PIE_SIZE }}
          >
            No data
          </div>
        ) : (
          <PieChart width={PIE_SIZE} height={PIE_SIZE} className="shrink-0">
            <Pie
              data={dim.slices.map((s, i) => ({
                ...s,
                fill: sliceColor(s, i),
              }))}
              dataKey="value"
              nameKey="label"
              innerRadius={PIE_SIZE * 0.28}
              outerRadius={PIE_SIZE / 2 - 4}
              stroke={dim.slices.length > 1 ? 'hsl(var(--background))' : 'none'}
              isAnimationActive={false}
            />
            <Tooltip
              formatter={(value, name) => [
                `${formatValue(metric, Number(value))} (${formatShare(Number(value) / total)})`,
                String(name),
              ]}
            />
          </PieChart>
        )}
        <ul className="min-w-0 max-w-[340px] flex-1 space-y-0.5 text-xs">
          {dim.slices.map((s, i) => (
            <li
              key={s.key}
              className="flex min-w-0 items-center gap-1.5"
              title={`${s.title}: ${formatValue(metric, s.value)} (${formatShare(s.value / total)})`}
              data-testid="live-share-legend-item"
            >
              <span
                className="size-2 shrink-0 rounded-sm"
                style={{ backgroundColor: sliceColor(s, i) }}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate">{s.label}</span>
              <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                {formatShare(s.value / total)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function LiveSharePage({
  nodes,
  selected,
}: {
  nodes: readonly OtelLiveNode[];
  selected: OtelLiveNode;
}) {
  const [metric, setMetric] = useState<LiveShareMetric>('cost');
  const dims = buildLiveShare(nodes, selected, metric) ?? [];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <OtelSegmented<LiveShareMetric>
          label="Metric"
          value={metric}
          options={[
            { value: 'cost', label: 'Cost' },
            { value: 'tokens', label: 'Tokens' },
          ]}
          onChange={setMetric}
          testId="live-share-metric"
        />
        <span className="text-xs text-muted-foreground">
          Sessions since start; a session under several teams or repositories
          counts once, under the first.
        </span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-x-8 gap-y-4 2xl:max-w-[1400px]">
        {dims.map((d) => (
          <SharePie key={d.id} dim={d} metric={metric} />
        ))}
      </div>
    </div>
  );
}
