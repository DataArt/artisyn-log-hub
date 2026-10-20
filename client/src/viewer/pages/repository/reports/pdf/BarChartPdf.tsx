import { G, Rect, Svg, Text } from '@react-pdf/renderer';
import {
  AXIS_MARGIN_LEFT,
  CHART_TOP_PADDING,
  niceTicks,
  YAxisGrid,
} from './pdfChartAxis';

export interface BarChartPdfDatum {
  label: string;
  value: number;
}

interface Props {
  data: BarChartPdfDatum[];
  color: string;
  formatValue?: (value: number) => string;
}

const WIDTH = 480;
const HEIGHT = 110;
// Minimum horizontal space (pt) a label needs so date strings don't overlap.
// Recharts does this tick-skipping automatically on-page; react-pdf's Svg
// primitives render every <Text> unconditionally, so with 20-30+ daily
// buckets (e.g. Work Time Distribution's zero-filled range) every label was
// rendered on top of the next one — a real, visually broken PDF, not a
// screenshot artifact.
const MIN_LABEL_SPACING = 32;

const defaultFormatValue = (v: number) =>
  Number.isInteger(v) ? String(v) : v.toFixed(1);

// Generic single-series bar chart for PDF report exports — shared across
// every bar-chart report (Session Timeline, Work Time, Cost by Branch, Cost
// by User, Productivity) so each doesn't need its own bespoke Svg drawing.
export function BarChartPdf({
  data,
  color,
  formatValue = defaultFormatValue,
}: Props) {
  const rawMax = Math.max(0, ...data.map((d) => d.value));
  const ticks = niceTicks(rawMax);
  const axisMax = ticks[ticks.length - 1];

  const plotWidth = WIDTH - AXIS_MARGIN_LEFT;
  const barWidth = data.length > 0 ? plotWidth / data.length : plotWidth;
  const gap = barWidth * 0.2;

  const maxLabels = Math.max(1, Math.floor(plotWidth / MIN_LABEL_SPACING));
  const labelStep = Math.max(1, Math.ceil(data.length / maxLabels));

  return (
    <Svg width={WIDTH} height={HEIGHT + 14 + CHART_TOP_PADDING}>
      <G transform={`translate(0, ${CHART_TOP_PADDING})`}>
        <YAxisGrid
          ticks={ticks}
          axisMax={axisMax}
          chartWidth={WIDTH}
          chartHeight={HEIGHT}
          formatValue={formatValue}
        />
        {data.map((d, i) => {
          const barHeight = (d.value / axisMax) * HEIGHT;
          return (
            <Rect
              key={d.label}
              x={AXIS_MARGIN_LEFT + i * barWidth + gap / 2}
              y={HEIGHT - barHeight}
              width={barWidth - gap}
              height={Math.max(barHeight, 0.5)}
              fill={color}
            />
          );
        })}
        {data.map((d, i) =>
          i % labelStep === 0 ? (
            <Text
              key={`label-${d.label}`}
              x={AXIS_MARGIN_LEFT + i * barWidth + barWidth / 2}
              y={HEIGHT + 10}
              textAnchor="middle"
              style={{ fontSize: 6, fill: '#64748b' }}
            >
              {d.label}
            </Text>
          ) : null,
        )}
      </G>
    </Svg>
  );
}
