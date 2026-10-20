import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartResponsiveContainer } from '../../../../components/ChartResponsiveContainer';
import type { ExecutiveSummaryWeekBucket } from '../../../../../models/repositories';

interface Props {
  weeklyBuckets: ExecutiveSummaryWeekBucket[];
}

export function UsageTrendChart({ weeklyBuckets }: Props) {
  const data = weeklyBuckets.map((b) => ({
    weekStart: b.weekStart,
    sessions: b.sessionCount,
  }));

  return (
    <div className="h-56 w-full">
      <ChartResponsiveContainer>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="4 3" vertical={false} />
          <XAxis dataKey="weekStart" tick={{ fontSize: 10 }} />
          <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
          <Tooltip />
          <Bar dataKey="sessions" fill="#93c5fd" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ChartResponsiveContainer>
    </div>
  );
}
