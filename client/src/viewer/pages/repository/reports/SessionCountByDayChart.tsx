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

// Aggregates per-session timeline rows into per-day (optionally per-group)
// session counts and renders them as a Recharts grouped bar chart.
export function SessionCountByDayChart({ sessions, groupBy }: Props) {
  const days = new Map<string, Record<string, number>>();
  const groups = new Set<string>();

  for (const s of sessions) {
    const day = dayKey(s.startTime);
    const group = groupBy !== 'none' ? (s.group ?? 'unknown') : 'sessions';
    groups.add(group);
    const row = days.get(day) ?? {};
    row[group] = (row[group] ?? 0) + 1;
    days.set(day, row);
  }

  const groupList = Array.from(groups).sort();
  const data = Array.from(days.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, counts]) => ({ day, ...counts }));

  return (
    <div className="h-80 w-full">
      <ChartResponsiveContainer>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="4 3" vertical={false} />
          <XAxis dataKey="day" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
          <Tooltip />
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
