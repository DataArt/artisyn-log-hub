import { G, Rect, Svg, Text } from '@react-pdf/renderer';
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
const BAR_COLOR = '#fcd34d';

const formatValue = (v: number) => (v % 1 === 0 ? `$${v}` : `$${v.toFixed(2)}`);

// Vector counterpart of CostTrendChart.tsx — same weeklyBuckets data, drawn
// with Svg primitives instead of rasterized.
export function CostTrendChartPdf({ weeklyBuckets }: Props) {
  const rawMax = Math.max(0, ...weeklyBuckets.map((b) => b.totalCost));
  const ticks = niceTicks(rawMax);
  const axisMax = ticks[ticks.length - 1];
  const plotWidth = WIDTH - AXIS_MARGIN_LEFT;
  const barWidth =
    weeklyBuckets.length > 0 ? plotWidth / weeklyBuckets.length : plotWidth;
  const gap = barWidth * 0.2;

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
        {weeklyBuckets.map((b, i) => {
          const barHeight = (b.totalCost / axisMax) * HEIGHT;
          return (
            <Rect
              key={b.weekStart}
              x={AXIS_MARGIN_LEFT + i * barWidth + gap / 2}
              y={HEIGHT - barHeight}
              width={barWidth - gap}
              height={Math.max(barHeight, 0.5)}
              fill={BAR_COLOR}
            />
          );
        })}
        {weeklyBuckets.map((b, i) => (
          <Text
            key={`label-${b.weekStart}`}
            x={AXIS_MARGIN_LEFT + i * barWidth + barWidth / 2}
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
