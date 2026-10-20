import { G, Rect, Svg, Text } from '@react-pdf/renderer';
import {
  AXIS_MARGIN_LEFT,
  CHART_TOP_PADDING,
  niceTicks,
  YAxisGrid,
} from './pdfChartAxis';

export interface GroupedBarChartPdfDatum {
  label: string;
  /** `null` renders a dashed baseline stub instead of a bar (undefined value). */
  a: number | null;
  b: number | null;
}

interface Props {
  data: GroupedBarChartPdfDatum[];
  colorA: string;
  colorB: string;
  formatValue?: (value: number) => string;
  /** Fixed y-axis maximum (e.g. 100 for a bounded percentage). */
  axisMaxOverride?: number;
  /** Colour of the dashed stub drawn for a `null` value. */
  undefinedColor?: string;
}

const WIDTH = 480;
const HEIGHT = 110;
// Same rationale as BarChartPdf: react-pdf's Svg primitives render every
// <Text> unconditionally, so daily buckets overlap without explicit skipping.
const MIN_LABEL_SPACING = 32;
const STUB_HEIGHT = 6;

const defaultFormatValue = (v: number) =>
  Number.isInteger(v) ? String(v) : v.toFixed(1);

// Two-series (grouped) bar chart for PDF report exports — a pair of bars per
// bucket. Built for the cache read ratio's "root only" vs "root + descendants" cache-read
// ratio, but deliberately generic: the single-series BarChartPdf cannot show
// two values per bucket side by side.
export function GroupedBarChartPdf({
  data,
  colorA,
  colorB,
  formatValue = defaultFormatValue,
  axisMaxOverride,
  undefinedColor = '#94a3b8',
}: Props) {
  const values = data.flatMap((d) =>
    [d.a, d.b].filter((v): v is number => v != null),
  );
  const rawMax = Math.max(0, ...values);
  const ticks =
    axisMaxOverride != null
      ? [
          0,
          axisMaxOverride / 4,
          axisMaxOverride / 2,
          (axisMaxOverride * 3) / 4,
          axisMaxOverride,
        ]
      : niceTicks(rawMax);
  const axisMax = ticks[ticks.length - 1];

  const plotWidth = WIDTH - AXIS_MARGIN_LEFT;
  const bandWidth = data.length > 0 ? plotWidth / data.length : plotWidth;
  const gap = bandWidth * 0.2;
  const barWidth = Math.max(0.5, (bandWidth - gap) / 2);

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
        {data.flatMap((d, i) => {
          const bandX = AXIS_MARGIN_LEFT + i * bandWidth + gap / 2;
          const series = [
            { key: `${d.label}-a`, value: d.a, x: bandX, fill: colorA },
            {
              key: `${d.label}-b`,
              value: d.b,
              x: bandX + barWidth,
              fill: colorB,
            },
          ];
          return series.map(({ key, value, x, fill }) =>
            value == null ? (
              <Rect
                key={key}
                x={x}
                y={HEIGHT - STUB_HEIGHT}
                width={barWidth}
                height={STUB_HEIGHT}
                fill="#ffffff"
                stroke={undefinedColor}
                strokeWidth={0.5}
                strokeDasharray="2 1.5"
              />
            ) : (
              <Rect
                key={key}
                x={x}
                y={HEIGHT - (value / axisMax) * HEIGHT}
                width={barWidth}
                height={Math.max((value / axisMax) * HEIGHT, 0.5)}
                fill={fill}
              />
            ),
          );
        })}
        {data.map((d, i) =>
          i % labelStep === 0 ? (
            <Text
              key={`label-${d.label}`}
              x={AXIS_MARGIN_LEFT + i * bandWidth + bandWidth / 2}
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
