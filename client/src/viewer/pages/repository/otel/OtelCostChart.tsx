/**
 * The OTEL cost chart (2026-10-30 otel-tabs-traces, Visual/UX notes): a Recharts
 * `ComposedChart` with one stacked `Bar` per stack key (`stackId`), an optional 100 % view, an
 * optional cumulative `Line` on a right `YAxis`, a sorted tooltip with share bars (FR-27) and a
 * legend whose items hide / show a series. Bars of the latest poll's new / grown buckets
 * (`newBucketKeys`, `start|key`) get an amber outline through a custom bar `shape`, with no
 * re-mount and no animation.
 */
import { useMemo, useState, type MouseEvent } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  Rectangle,
  Tooltip,
  XAxis,
  YAxis,
  type BarShapeProps,
  type MouseHandlerDataParam,
} from 'recharts';
import { ChartResponsiveContainer } from '../../../components/ChartResponsiveContainer';
import type { OtelBucket, OtelInterval } from '../../../../models/repositories';
import { cn } from '@/lib/cn';
import {
  buildOtelChartRows,
  buildOtelSeries,
  otelViewValue,
  type OtelChartRow,
} from './otel-chart-data';
import { formatBucketStart } from './otel-format';
import { formatOtelMetric, OtelChartTooltip } from './OtelChartTooltip';
import type { OtelChartView, OtelMetric } from './otel-url-state';

export interface OtelCostChartProps {
  buckets: readonly OtelBucket[];
  interval: OtelInterval;
  metric: OtelMetric;
  stackBy: string;
  view: OtelChartView;
  cumulative: boolean;
  /** `start|key` of the bars to outline (latest poll). */
  newBucketKeys: ReadonlySet<string>;
  /** Series hidden through the legend or isolated from the share bars. */
  hiddenKeys: ReadonlySet<string>;
  onToggleKey: (key: string) => void;
  /** Pixel height of the plot. */
  height?: number;
}

const HIGHLIGHT_STROKE = '#f59e0b';

type FlatRow = Record<string, number | string> & { start: string };

function flatten(
  rows: readonly OtelChartRow[],
  keys: readonly string[],
  view: OtelChartView,
): FlatRow[] {
  return rows.map((r) => {
    const flat: FlatRow = { start: r.start, __cumulative: r.cumulative };
    keys.forEach((k, i) => {
      flat[`s${i}`] = otelViewValue(r, k, view);
    });
    return flat;
  });
}

export function OtelCostChart({
  buckets,
  interval,
  metric,
  stackBy,
  view,
  cumulative,
  newBucketKeys,
  hiddenKeys,
  onToggleKey,
  height = 280,
}: OtelCostChartProps) {
  const series = useMemo(
    () => buildOtelSeries(buckets, metric, stackBy),
    [buckets, metric, stackBy],
  );
  const visibleKeys = useMemo(
    () => new Set(series.map((s) => s.key).filter((k) => !hiddenKeys.has(k))),
    [series, hiddenKeys],
  );
  const rows = useMemo(
    () => buildOtelChartRows(buckets, metric, interval, visibleKeys),
    [buckets, metric, interval, visibleKeys],
  );
  const data = useMemo(
    () =>
      flatten(
        rows,
        series.map((s) => s.key),
        view,
      ),
    [rows, series, view],
  );

  // Bucket keys arrive as `start|key` with the server's ISO text; rows use toISOString().
  const newKeys = useMemo(() => {
    const out = new Set<string>();
    for (const k of newBucketKeys) {
      const i = k.indexOf('|');
      const d = new Date(k.slice(0, i));
      if (!Number.isNaN(d.getTime()))
        out.add(`${d.toISOString()}${k.slice(i)}`);
    }
    return out;
  }, [newBucketKeys]);

  const [hover, setHover] = useState<{
    index: number;
    x: number;
    y: number;
  } | null>(null);

  const onChartMove = (
    state: MouseHandlerDataParam,
    e: MouseEvent<SVGGraphicsElement>,
  ) => {
    const index = Number(state.activeTooltipIndex);
    if (!state.isTooltipActive || !Number.isInteger(index) || index < 0) {
      setHover(null);
      return;
    }
    setHover({ index, x: e.clientX, y: e.clientY });
  };

  const hoverRow = hover !== null ? rows[hover.index] : undefined;
  const tickFormatter = (v: string) => formatBucketStart(v, interval);
  const valueTick = (v: number) =>
    view === 'percent' ? `${Math.round(v)} %` : formatOtelMetric(v, metric);

  return (
    <div className="space-y-2" data-testid="otel-cost-chart">
      <div style={{ height }} onMouseLeave={() => setHover(null)}>
        <ChartResponsiveContainer>
          <ComposedChart
            data={data}
            margin={{ top: 8, right: cumulative ? 8 : 16, bottom: 0, left: 8 }}
            onMouseMove={onChartMove}
            onMouseLeave={() => setHover(null)}
          >
            <CartesianGrid strokeDasharray="4 3" vertical={false} />
            <XAxis
              dataKey="start"
              tick={{ fontSize: 11 }}
              tickFormatter={tickFormatter}
              minTickGap={24}
            />
            <YAxis
              yAxisId="left"
              tick={{ fontSize: 11 }}
              tickFormatter={valueTick}
              domain={view === 'percent' ? [0, 100] : [0, 'auto']}
              width={64}
            />
            {cumulative && (
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 11 }}
                tickFormatter={(v: number) => formatOtelMetric(v, metric)}
                width={64}
              />
            )}
            <Tooltip
              content={() => null}
              cursor={{ fill: 'rgba(15, 23, 42, 0.05)' }}
            />
            {series.map((s, i) =>
              hiddenKeys.has(s.key) ? null : (
                <Bar
                  key={s.key}
                  yAxisId="left"
                  dataKey={`s${i}`}
                  name={s.label}
                  stackId="otel"
                  fill={s.color}
                  isAnimationActive={false}
                  shape={(props: BarShapeProps) => {
                    const row = rows[props.index];
                    const highlighted =
                      row !== undefined && newKeys.has(`${row.start}|${s.key}`);
                    return (
                      <Rectangle
                        {...props}
                        stroke={highlighted ? HIGHLIGHT_STROKE : undefined}
                        strokeWidth={highlighted ? 2 : 0}
                        className={highlighted ? 'otel-bar-new' : undefined}
                      />
                    );
                  }}
                />
              ),
            )}
            {cumulative && (
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="__cumulative"
                name="Cumulative"
                stroke="#0f172a"
                strokeDasharray="5 3"
                dot={false}
                isAnimationActive={false}
              />
            )}
          </ComposedChart>
        </ChartResponsiveContainer>
      </div>
      {hover !== null && hoverRow !== undefined && (
        <OtelChartTooltip
          x={hover.x}
          y={hover.y}
          row={hoverRow}
          series={series}
          hiddenKeys={hiddenKeys}
          metric={metric}
          interval={interval}
          showCumulative={cumulative}
        />
      )}
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
        data-testid="otel-chart-legend"
      >
        {series.map((s) => {
          const hidden = hiddenKeys.has(s.key);
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => onToggleKey(s.key)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded px-1 hover:bg-accent',
                hidden && 'text-muted-foreground line-through',
              )}
            >
              <span
                className="inline-block size-2.5 rounded-sm"
                style={{ backgroundColor: hidden ? '#cbd5e1' : s.color }}
              />
              {s.label}
            </button>
          );
        })}
        {cumulative && (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span className="inline-block w-4 border-t-2 border-dashed border-slate-900" />
            Cumulative (right axis)
          </span>
        )}
        {series.length > 0 && (
          <span className="text-muted-foreground">
            · click a legend item to hide / show it
          </span>
        )}
      </div>
    </div>
  );
}
