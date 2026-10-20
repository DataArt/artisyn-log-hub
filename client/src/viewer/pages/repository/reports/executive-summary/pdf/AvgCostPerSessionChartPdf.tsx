import { Circle, G, Polyline, Svg, Text } from '@react-pdf/renderer';
import type { ExecutiveSummaryWeekBucket } from '../../../../../../models/repositories';
import {
  AXIS_MARGIN_LEFT,
  CHART_TOP_PADDING,
  niceTicks,
  YAxisGrid,
} from '../../pdf/pdfChartAxis';

interface Props {
  weeklyBuckets: ExecutiveSummaryWeekBucket[];
}

const WIDTH = 480;
const HEIGHT = 110;
const LINE_COLOR = '#a78bfa';

const formatValue = (v: number) => (v % 1 === 0 ? `$${v}` : `$${v.toFixed(2)}`);

// Vector counterpart of AvgCostPerSessionChart.tsx — same weeklyBuckets data
// (avg cost per session = totalCost / sessionCount), drawn as a Polyline with
// point markers, following CostTrendChartPdf.tsx's drawing approach.
export function AvgCostPerSessionChartPdf({ weeklyBuckets }: Props) {
  const values = weeklyBuckets.map((b) =>
    b.sessionCount > 0 ? b.totalCost / b.sessionCount : 0,
  );
  const rawMax = Math.max(0, ...values);
  const ticks = niceTicks(rawMax);
  const axisMax = ticks[ticks.length - 1];
  const plotWidth = WIDTH - AXIS_MARGIN_LEFT;
  const stepX =
    weeklyBuckets.length > 1 ? plotWidth / (weeklyBuckets.length - 1) : 0;

  const points = values.map((v, i) => ({
    x:
      weeklyBuckets.length > 1
        ? AXIS_MARGIN_LEFT + i * stepX
        : AXIS_MARGIN_LEFT + plotWidth / 2,
    y: HEIGHT - (v / axisMax) * HEIGHT,
  }));

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
        <Polyline
          points={points.map((p) => `${p.x},${p.y}`).join(' ')}
          stroke={LINE_COLOR}
          strokeWidth={2}
          fill="none"
        />
        {points.map((p, i) => (
          <Circle
            key={`point-${weeklyBuckets[i].weekStart}`}
            cx={p.x}
            cy={p.y}
            r={2.5}
            fill={LINE_COLOR}
          />
        ))}
        {weeklyBuckets.map((b, i) => (
          <Text
            key={`label-${b.weekStart}`}
            x={points[i].x}
            y={HEIGHT + 10}
            textAnchor="middle"
            style={{ fontSize: 6, fill: '#64748b' }}
          >
            {b.weekStart.slice(5)}
          </Text>
        ))}
      </G>
    </Svg>
  );
}
