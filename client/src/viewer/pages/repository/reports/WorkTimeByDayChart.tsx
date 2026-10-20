import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartResponsiveContainer } from '../../../components/ChartResponsiveContainer';
import type { WorkTimeBucket } from '../../../../models/repositories';

interface Props {
  buckets: WorkTimeBucket[];
}

const COLORS = [
  '#3b82f6',
  '#14b8a6',
  '#f59e0b',
  '#8b5cf6',
  '#ef4444',
  '#22c55e',
];

function dayKey(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Groups the daily WorkTimeBucket[] (from GET /analytics/work-time) by
// (optionally per-group) work-time totals for the "Work Time Distribution"
// report chart.
export function WorkTimeByDayChart({ buckets }: Props) {
  const days = new Map<string, Record<string, number>>();
  const groups = new Set<string>();

  for (const b of buckets) {
    const day = dayKey(b.day);
    const group = b.group ?? 'minutes';
    groups.add(group);
    const row = days.get(day) ?? {};
    row[group] = (row[group] ?? 0) + b.workTimeMinutes;
    days.set(day, row);
  }

  const groupList = Array.from(groups).sort();
  const data = Array.from(days.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, minutes]) => ({ day, ...minutes }));

  return (
    <div className="h-80 w-full">
      <ChartResponsiveContainer>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="4 3" vertical={false} />
          <XAxis dataKey="day" tick={{ fontSize: 11 }} />
          <YAxis
            tick={{ fontSize: 11 }}
            allowDecimals={false}
            label={{
              value: 'minutes',
              angle: -90,
              position: 'insideLeft',
              fontSize: 11,
            }}
          />
          <Tooltip formatter={(v) => `${Number(v).toFixed(2)} min`} />
          {groupList.length > 1 && <Legend />}
          {groupList.map((group, i) => (
            <Bar
              key={group}
              dataKey={group}
              fill={COLORS[i % COLORS.length]}
              radius={[2, 2, 0, 0]}
            />
          ))}
        </BarChart>
      </ChartResponsiveContainer>
    </div>
  );
}
