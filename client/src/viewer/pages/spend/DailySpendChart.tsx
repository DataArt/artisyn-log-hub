/**
 * The Spend tab daily chart (2026-11-05 budgets-threshold-alerts, Visual notes): blue bars per
 * local day (per hour for a day budget), a dashed budget-pace line (amount / total units) and
 * anomaly bars outlined amber with "▲ N× avg" on hover. A bar click opens the sessions of that
 * day (`slice=day`).
 */
import { useState } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Rectangle,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
  type BarShapeProps,
  type MouseHandlerDataParam,
} from 'recharts';
import type { SpendDailyBucket } from '../../../models/budgets';
import { ChartResponsiveContainer } from '../../components/ChartResponsiveContainer';
import { formatUsdMicros } from '../budgets/budget-format';
import { formatSpendBucketKey } from './spend-format';

const BAR_FILL = '#3b82f6';
const ANOMALY_STROKE = '#f59e0b';
const PACE_STROKE = '#64748b';

interface Props {
  daily: readonly SpendDailyBucket[];
  /** Budget pace per bucket in micros (amount / total units); `null` without a budget. */
  paceMicros: number | null;
  onBucketClick: (bucket: SpendDailyBucket) => void;
}

function hoverIndex(state: MouseHandlerDataParam): number | null {
  const index = Number(state.activeTooltipIndex);
  return state.isTooltipActive && Number.isInteger(index) && index >= 0
    ? index
    : null;
}

export function DailySpendChart({ daily, paceMicros, onBucketClick }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const data = daily.map((d) => ({ ...d, usd: d.micros / 1e6 }));
  const hovered = hover !== null ? daily[hover] : undefined;
  const showPace = paceMicros !== null && paceMicros > 0;
  // Hourly buckets (a day budget) have `HH` keys.
  const paceUnit = daily[0]?.key.length === 2 ? 'hour' : 'day';

  if (daily.length === 0) {
    return (
      <p
        className="text-sm text-muted-foreground"
        data-testid="spend-daily-chart"
      >
        No spend in this period.
      </p>
    );
  }

  return (
    <div className="space-y-1" data-testid="spend-daily-chart">
      <div className="flex h-5 items-center justify-between gap-4 text-xs text-muted-foreground">
        <span>
          {hovered !== undefined ? (
            <>
              {formatSpendBucketKey(hovered.key)} ·{' '}
              <span className="tabular-nums text-foreground">
                {formatUsdMicros(hovered.micros)}
              </span>
              {hovered.anomaly && (
                <span className="text-amber-700">
                  {' '}
                  · ▲ {hovered.ratioToAverage.toFixed(1)}× avg
                </span>
              )}
            </>
          ) : (
            'Click a bar to list its sessions'
          )}
        </span>
        {/* Legend, not an on-chart label: a small budget puts the pace line on the x axis. */}
        {showPace && paceMicros !== null && (
          <span
            className="flex shrink-0 items-center gap-1.5"
            data-testid="spend-pace-legend"
          >
            <svg width="18" height="2" aria-hidden="true">
              <line
                x1="0"
                y1="1"
                x2="18"
                y2="1"
                stroke={PACE_STROKE}
                strokeWidth="1.5"
                strokeDasharray="5 4"
              />
            </svg>
            budget pace{' '}
            <span className="tabular-nums">
              {formatUsdMicros(paceMicros)}/{paceUnit}
            </span>
          </span>
        )}
      </div>
      <div className="h-56" onMouseLeave={() => setHover(null)}>
        <ChartResponsiveContainer>
          <ComposedChart
            data={data}
            margin={{ top: 8, right: 16, bottom: 0, left: 8 }}
            onMouseMove={(state: MouseHandlerDataParam) =>
              setHover(hoverIndex(state))
            }
            onMouseLeave={() => setHover(null)}
            onClick={(state: MouseHandlerDataParam) => {
              const i = hoverIndex(state);
              const bucket = i !== null ? daily[i] : undefined;
              if (bucket !== undefined && bucket.micros > 0)
                onBucketClick(bucket);
            }}
            style={{ cursor: 'pointer' }}
          >
            <CartesianGrid strokeDasharray="4 3" vertical={false} />
            <XAxis
              dataKey="key"
              tick={{ fontSize: 11 }}
              tickFormatter={formatSpendBucketKey}
              minTickGap={16}
            />
            <YAxis
              tick={{ fontSize: 11 }}
              tickFormatter={(v: number) => `$${v.toFixed(v < 10 ? 2 : 0)}`}
              width={56}
            />
            <Tooltip
              content={() => null}
              cursor={{ fill: 'rgba(15, 23, 42, 0.05)' }}
            />
            <Bar
              dataKey="usd"
              fill={BAR_FILL}
              isAnimationActive={false}
              shape={(props: BarShapeProps) => {
                const anomaly = daily[props.index]?.anomaly === true;
                return (
                  <Rectangle
                    {...props}
                    stroke={anomaly ? ANOMALY_STROKE : undefined}
                    strokeWidth={anomaly ? 2 : 0}
                  />
                );
              }}
            />
            {showPace && paceMicros !== null && (
              <ReferenceLine
                y={paceMicros / 1e6}
                stroke={PACE_STROKE}
                strokeDasharray="5 4"
              />
            )}
          </ComposedChart>
        </ChartResponsiveContainer>
      </div>
    </div>
  );
}
