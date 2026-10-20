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
import type { TimelineSession } from '../../../../models/repositories';

interface Props {
  sessions: TimelineSession[];
  // Widened to accept `attr:<key>` — the fallback
  // `s.group ?? 'unknown'` logic below already treats any non-'none' value generically.
  groupBy: 'none' | 'branch' | 'user' | `attr:${string}`;
}

const COLORS = [
  '#fcd34d',
  '#fca5a5',
  '#93c5fd',
  '#a7f3d0',
  '#c4b5fd',
  '#fdba74',
];

function dayKey(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Cost-per-day (optionally per-group) bar chart, purpose-built for the
// Reports tab — a dedicated Recharts component so "Cost by User" doesn't
// borrow analytics/CostBarChart.tsx's D3 per-hour zone-colored chart.
export function CostByGroupChart({ sessions, groupBy }: Props) {
  const days = new Map<string, Record<string, number>>();
  const groups = new Set<string>();

  for (const s of sessions) {
    const day = dayKey(s.startTime);
    const group = groupBy !== 'none' ? (s.group ?? 'unknown') : 'cost';
    groups.add(group);
    const row = days.get(day) ?? {};
    row[group] = (row[group] ?? 0) + (s.totalCost ?? 0);
    days.set(day, row);
  }

  const groupList = Array.from(groups).sort();
  const data = Array.from(days.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, costs]) => ({ day, ...costs }));

  return (
    <div className="h-80 w-full">
      <ChartResponsiveContainer>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="4 3" vertical={false} />
          <XAxis dataKey="day" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip formatter={(v) => `$${Number(v).toFixed(4)}`} />
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
