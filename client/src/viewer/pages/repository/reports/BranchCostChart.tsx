import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartResponsiveContainer } from '../../../components/ChartResponsiveContainer';
import type { BranchSummary } from '../../../../models/repositories';

interface Props {
  branches: BranchSummary[];
}

export function BranchCostChart({ branches }: Props) {
  const data = branches
    .map((b) => ({
      branch: b.branch ?? 'no branch',
      cost: b.totalCost ?? 0,
    }))
    .sort((a, b) => b.cost - a.cost);

  return (
    <div className="h-80 w-full">
      <ChartResponsiveContainer>
        <BarChart data={data} layout="vertical" margin={{ left: 24 }}>
          <CartesianGrid strokeDasharray="4 3" horizontal={false} />
          <XAxis type="number" tick={{ fontSize: 11 }} />
          <YAxis
            type="category"
            dataKey="branch"
            width={140}
            tick={{ fontSize: 11 }}
          />
          <Tooltip formatter={(v) => `$${Number(v).toFixed(4)}`} />
          <Bar dataKey="cost" fill="#fcd34d" radius={[0, 2, 2, 0]} />
        </BarChart>
      </ChartResponsiveContainer>
    </div>
  );
}
