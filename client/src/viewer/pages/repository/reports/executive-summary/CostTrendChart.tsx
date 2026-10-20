import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartResponsiveContainer } from '../../../../components/ChartResponsiveContainer';
import type { ExecutiveSummaryWeekBucket } from '../../../../../models/repositories';

interface Props {
  weeklyBuckets: ExecutiveSummaryWeekBucket[];
}

export function CostTrendChart({ weeklyBuckets }: Props) {
  const data = weeklyBuckets.map((b) => ({
    weekStart: b.weekStart,
    cost: Math.round(b.totalCost * 100) / 100,
  }));

  return (
    <div className="h-56 w-full">
      <ChartResponsiveContainer>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="4 3" vertical={false} />
          <XAxis dataKey="weekStart" tick={{ fontSize: 10 }} />
          <YAxis tick={{ fontSize: 10 }} />
          <Tooltip formatter={(v) => `$${Number(v).toFixed(2)}`} />
          <Bar dataKey="cost" fill="#fcd34d" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ChartResponsiveContainer>
    </div>
  );
}
