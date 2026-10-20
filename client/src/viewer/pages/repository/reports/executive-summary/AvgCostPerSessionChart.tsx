import {
  CartesianGrid,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartResponsiveContainer } from '../../../../components/ChartResponsiveContainer';
import type { ExecutiveSummaryWeekBucket } from '../../../../../models/repositories';

interface Props {
  weeklyBuckets: ExecutiveSummaryWeekBucket[];
}

export function AvgCostPerSessionChart({ weeklyBuckets }: Props) {
  const data = weeklyBuckets.map((b) => ({
    weekStart: b.weekStart,
    avgCost:
      b.sessionCount > 0
        ? Math.round((b.totalCost / b.sessionCount) * 100) / 100
        : 0,
  }));

  return (
    <div className="h-56 w-full">
      <ChartResponsiveContainer>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="4 3" vertical={false} />
          <XAxis dataKey="weekStart" tick={{ fontSize: 10 }} />
          <YAxis tick={{ fontSize: 10 }} />
          <Tooltip formatter={(v) => `$${Number(v).toFixed(2)}`} />
          <Line
            type="monotone"
            dataKey="avgCost"
            stroke="#a78bfa"
            strokeWidth={2}
            dot={{ r: 3 }}
          />
        </LineChart>
      </ChartResponsiveContainer>
    </div>
  );
}
