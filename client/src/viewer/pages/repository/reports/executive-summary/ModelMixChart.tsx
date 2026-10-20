import { Cell, Legend, Pie, PieChart, Tooltip } from 'recharts';
import { formatCost } from '@/lib/format';
import { ChartResponsiveContainer } from '../../../../components/ChartResponsiveContainer';
import type { ExecutiveSummaryModelMixEntry } from '../../../../../models/repositories';

interface Props {
  modelMix: ExecutiveSummaryModelMixEntry[];
  /** Which value the doughnut/legend/tooltip show — session counts (default)
   * or cost. See wireframes/model-mix-toggle.svg. */
  basis?: 'sessions' | 'cost';
}

const COLORS = [
  '#60a5fa',
  '#c4b5fd',
  '#5eead4',
  '#fca5a5',
  '#fcd34d',
  '#a3e635',
];

export function ModelMixChart({ modelMix, basis = 'sessions' }: Props) {
  const isCost = basis === 'cost';
  const data = modelMix.map((m) => ({
    name: m.model,
    value: isCost ? m.cost : m.sessionCount,
    share: isCost ? m.costShare : m.share,
  }));

  return (
    <div className="h-56 w-full">
      <ChartResponsiveContainer>
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius={50}
            outerRadius={80}
          >
            {data.map((entry, i) => (
              <Cell key={entry.name} fill={COLORS[i % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip
            formatter={(value, name, item) => {
              const share = (item.payload as { share: number }).share;
              const valueLabel = isCost
                ? formatCost(Number(value))
                : `${Number(value)} sessions`;
              return [
                `${valueLabel} (${(share * 100).toFixed(0)}%)`,
                String(name),
              ];
            }}
          />
          <Legend />
        </PieChart>
      </ChartResponsiveContainer>
    </div>
  );
}
