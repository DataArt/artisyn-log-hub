import { Line, Text } from '@react-pdf/renderer';

// Shared y-axis gridline/tick math for every PDF Svg chart (bar and line
// charts alike). react-pdf's Svg primitives have no <YAxis> equivalent like
// Recharts, so this fills that gap once instead of each chart re-deriving
// "nice" tick values on its own.

const TICK_COUNT = 4;

// Rounds a raw max value up to a "nice" step (1/2/5/10 x a power of ten) and
// returns the tick values from 0 to that rounded max — same idea as d3.ticks.
export function niceTicks(rawMax: number, tickCount = TICK_COUNT): number[] {
  if (rawMax <= 0) return [0, 1];
  const rawStep = rawMax / tickCount;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const residual = rawStep / magnitude;
  const niceResidual =
    residual > 5 ? 10 : residual > 2 ? 5 : residual > 1 ? 2 : 1;
  const step = niceResidual * magnitude;
  const niceMax = Math.ceil(rawMax / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= niceMax + step / 2; v += step) ticks.push(v);
  return ticks;
}

// Left margin (pt) reserved for y-axis tick labels across every PDF chart.
export const AXIS_MARGIN_LEFT = 34;

// Top padding (pt) so the topmost gridline's number label has room for its
// ascender instead of being clipped against the Svg's top edge (and the
// section heading sitting right above it).
export const CHART_TOP_PADDING = 8;

interface YAxisGridProps {
  ticks: number[];
  axisMax: number;
  chartWidth: number;
  chartHeight: number;
  marginLeft?: number;
  formatValue: (value: number) => string;
}

// Horizontal gridlines spanning the plot area plus a left-aligned numeric
// label per tick — the Svg equivalent of Recharts' <YAxis>.
export function YAxisGrid({
  ticks,
  axisMax,
  chartWidth,
  chartHeight,
  marginLeft = AXIS_MARGIN_LEFT,
  formatValue,
}: YAxisGridProps) {
  return (
    <>
      {ticks.map((t) => (
        <Line
          key={`gridline-${t}`}
          x1={marginLeft}
          y1={chartHeight - (t / axisMax) * chartHeight}
          x2={chartWidth}
          y2={chartHeight - (t / axisMax) * chartHeight}
          stroke={t === 0 ? '#94a3b8' : '#e2e8f0'}
          strokeWidth={0.5}
        />
      ))}
      {ticks.map((t) => (
        <Text
          key={`ticklabel-${t}`}
          x={marginLeft - 4}
          y={chartHeight - (t / axisMax) * chartHeight + 2}
          textAnchor="end"
          style={{ fontSize: 6, fill: '#64748b' }}
        >
          {formatValue(t)}
        </Text>
      ))}
    </>
  );
}
