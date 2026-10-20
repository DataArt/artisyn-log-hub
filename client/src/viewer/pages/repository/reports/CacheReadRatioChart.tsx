/**
 * Reports-tab "Cache Read Ratio" chart.
 *
 * Recharts paired bars per UTC day bucket — root-only (blue) next to
 * root + all recursive descendants (teal) — on a fixed 0–100 % y-axis, because
 * the metric is bounded and a rescaled axis would exaggerate small day-to-day
 * differences. A bucket whose denominator is 0 has no ratio at all: its value
 * is `null`, so Recharts draws no bar (never a misleading 0 % one) and the
 * tooltip reports `n/a`.
 *
 * The analytics tab has its own D3 version (`analytics/CacheRatioBarChart.tsx`);
 * Reports deliberately stays on Recharts so its documents keep one visual
 * language — same split as CostByGroupChart vs analytics/CostBarChart.
 */
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CACHE_RATIO_SCOPE_COLORS } from '@/lib/cache-ratio-ui';
import type { CacheRatioBucket } from '../../../../models/repositories';
import { ChartResponsiveContainer } from '../../../components/ChartResponsiveContainer';

interface Props {
  buckets: CacheRatioBucket[];
}

interface Datum {
  label: string;
  root: number | null;
  withDescendants: number | null;
}

function formatDayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (isNaN(d.getTime())) return day;
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function toPercent(ratio: number | null): number | null {
  return ratio == null ? null : ratio * 100;
}

export function CacheReadRatioChart({ buckets }: Props) {
  const data: Datum[] = buckets.map((b) => ({
    label: formatDayLabel(b.bucket),
    root: toPercent(b.root.ratio),
    withDescendants: toPercent(b.withDescendants.ratio),
  }));

  if (data.length === 0) {
    return (
      <div className="flex h-48 w-full items-center justify-center text-sm text-muted-foreground">
        No cache activity in this range
      </div>
    );
  }

  return (
    <div className="h-80 w-full">
      <ChartResponsiveContainer>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="4 3" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
          <YAxis
            domain={[0, 100]}
            ticks={[0, 20, 40, 60, 80, 100]}
            tickFormatter={(v: number) => `${v}%`}
            tick={{ fontSize: 11 }}
          />
          <Tooltip
            formatter={(v, name) => [
              typeof v === 'number' ? `${v.toFixed(1)}%` : 'n/a',
              name === 'root' ? 'Root only' : 'Root + descendants',
            ]}
          />
          <Legend
            formatter={(value) =>
              value === 'root' ? 'Root only' : 'Root + descendants'
            }
            wrapperStyle={{ fontSize: 11 }}
          />
          <Bar
            dataKey="root"
            fill={CACHE_RATIO_SCOPE_COLORS.root}
            radius={[2, 2, 0, 0]}
          />
          <Bar
            dataKey="withDescendants"
            fill={CACHE_RATIO_SCOPE_COLORS.withDescendants}
            radius={[2, 2, 0, 0]}
          />
        </BarChart>
      </ChartResponsiveContainer>
    </div>
  );
}
