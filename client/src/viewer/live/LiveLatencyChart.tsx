/**
 * Page 6 of the Live carousel (2026-11-04 otel-live-view, DD-13): p50 / p95 latency per
 * 5-minute bucket of the LLM request or tool spans, as a small Recharts line chart. `compact`
 * (Live tile grid, 2026-11-21 cloudwatch-cai-parity) only shrinks the axis ticks and margins.
 */
import {
  CartesianGrid,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartResponsiveContainer } from '../components/ChartResponsiveContainer';
import { formatBucketStart } from '../pages/repository/otel/otel-format';
import type { LiveLatencyPoint } from './live-chart-data';

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

export function LiveLatencyChart({
  points,
  height = 240,
  compact = false,
}: {
  points: readonly LiveLatencyPoint[];
  height?: number;
  compact?: boolean;
}) {
  const tickFont = compact ? 10 : 11;
  if (points.length === 0) {
    return (
      <p
        className={
          compact
            ? 'py-4 text-center text-xs text-muted-foreground'
            : 'py-8 text-center text-sm text-muted-foreground'
        }
        style={{ height }}
      >
        No spans of this kind in the last 2 h.
      </p>
    );
  }
  return (
    <div style={{ height }} data-testid="live-latency-chart">
      <ChartResponsiveContainer>
        <LineChart
          data={[...points]}
          margin={{
            top: 8,
            right: compact ? 8 : 16,
            bottom: 0,
            left: compact ? 0 : 8,
          }}
        >
          <CartesianGrid strokeDasharray="4 3" vertical={false} />
          <XAxis
            dataKey="start"
            tick={{ fontSize: tickFont }}
            tickFormatter={(v: string) => formatBucketStart(v, '5m')}
            minTickGap={24}
          />
          <YAxis
            tick={{ fontSize: tickFont }}
            tickFormatter={(v: number) => formatMs(v)}
            width={compact ? 44 : 64}
          />
          <Tooltip
            labelFormatter={(v) => formatBucketStart(String(v), '5m')}
            formatter={(v) => formatMs(Number(v))}
          />
          <Line
            type="monotone"
            dataKey="p50Ms"
            name="p50"
            stroke="#3b82f6"
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="p95Ms"
            name="p95"
            stroke="#f59e0b"
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ChartResponsiveContainer>
    </div>
  );
}
