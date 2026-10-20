import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartResponsiveContainer } from '../../../components/ChartResponsiveContainer';

interface Datum {
  label: string;
  value: number;
}

interface Props {
  data: Datum[];
}

export function ProductivityByDayChart({ data }: Props) {
  return (
    <div className="h-80 w-full">
      <ChartResponsiveContainer>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="4 3" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip formatter={(v) => `$${Number(v).toFixed(4)}/line`} />
          <Bar dataKey="value" fill="#a3e635" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ChartResponsiveContainer>
    </div>
  );
}
