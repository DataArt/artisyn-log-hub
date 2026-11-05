/**
 * Page 6 of the Live carousel (2026-11-04 otel-live-view, DD-13): p50 / p95 latency per
 * 5-minute bucket of the LLM request or tool spans, as a small Recharts line chart.
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
}: {
  points: readonly LiveLatencyPoint[];
  height?: number;
}) {
  if (points.length === 0) {
    return (
      <p
        className="py-8 text-center text-sm text-muted-foreground"
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
          margin={{ top: 8, right: 16, bottom: 0, left: 8 }}
        >
          <CartesianGrid strokeDasharray="4 3" vertical={false} />
          <XAxis
            dataKey="start"
            tick={{ fontSize: 11 }}
            tickFormatter={(v: string) => formatBucketStart(v, '5m')}
            minTickGap={24}
          />
          <YAxis
            tick={{ fontSize: 11 }}
            tickFormatter={(v: number) => formatMs(v)}
            width={64}
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
