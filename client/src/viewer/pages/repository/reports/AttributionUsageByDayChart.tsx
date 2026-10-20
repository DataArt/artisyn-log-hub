import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartResponsiveContainer } from '../../../components/ChartResponsiveContainer';
import type { AttributionUsageDayPoint } from '../../../../models/repositories';

interface Props {
  byDay: AttributionUsageDayPoint[];
}

// Single-series bar chart — evaluation attempts per UTC day.
// `byDay` is already ascending-by-date with no gap-filling (`attribution-usage.service.ts`'s
// own doc comment) — a day with zero runs simply has no bar, unlike the zero-filled ranges
// the other report charts build client-side.
export function AttributionUsageByDayChart({ byDay }: Props) {
  return (
    <div className="h-80 w-full">
      <ChartResponsiveContainer>
        <BarChart data={byDay}>
          <CartesianGrid strokeDasharray="4 3" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
          <Tooltip />
          <Bar dataKey="count" fill="#8b5cf6" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ChartResponsiveContainer>
    </div>
  );
}
