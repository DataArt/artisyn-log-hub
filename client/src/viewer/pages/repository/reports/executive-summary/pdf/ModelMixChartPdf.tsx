import { Circle, G, Rect, Svg, Text } from '@react-pdf/renderer';
import type { ExecutiveSummaryModelMixEntry } from '../../../../../../models/repositories';

interface Props {
  modelMix: ExecutiveSummaryModelMixEntry[];
}

const COLORS = [
  '#60a5fa',
  '#c4b5fd',
  '#5eead4',
  '#fca5a5',
  '#fcd34d',
  '#a3e635',
];
const R = 40;
const CIRCUMFERENCE = 2 * Math.PI * R;
// pdfkit's dash() rejects a zero-length dash or gap outright ("lengths must be
// numeric and greater than zero") — which a single 100%-share model produces
// exactly (dash = full circumference, gap = 0). Clamp both segments away from
// zero; the visual difference at this radius is imperceptible.
const MIN_SEGMENT = 0.01;

// Vector counterpart of ModelMixChart.tsx — a donut built from Svg <Circle>
// stroke-dasharray segments (same technique as the wireframe), not a screenshot.
export function ModelMixChartPdf({ modelMix }: Props) {
  // react-pdf's Svg primitives don't support strokeDashoffset, so each
  // segment is positioned by rotating it into place instead (equivalent
  // effect: -90 places the first segment's start at 12 o'clock).
  let cumulative = 0;
  const segments = modelMix.map((m) => {
    const rawLength = m.share * CIRCUMFERENCE;
    const length = Math.max(
      MIN_SEGMENT,
      Math.min(rawLength, CIRCUMFERENCE - MIN_SEGMENT),
    );
    const startAngle = (cumulative / CIRCUMFERENCE) * 360 - 90;
    cumulative += rawLength;
    return { model: m.model, length, startAngle };
  });

  return (
    <Svg width={480} height={110}>
      <G transform="translate(60, 55)">
        <Circle
          cx={0}
          cy={0}
          r={R}
          stroke="#f1f5f9"
          strokeWidth={16}
          fill="none"
        />
        {segments.map((seg, i) => (
          <Circle
            key={seg.model}
            cx={0}
            cy={0}
            r={R}
            stroke={COLORS[i % COLORS.length]}
            strokeWidth={16}
            fill="none"
            strokeDasharray={`${seg.length} ${CIRCUMFERENCE - seg.length}`}
            transform={`rotate(${seg.startAngle})`}
          />
        ))}
      </G>
      {modelMix.map((m, i) => (
        <G key={`legend-${m.model}`}>
          <Rect
            x={140}
            y={16 + i * 16}
            width={10}
            height={10}
            fill={COLORS[i % COLORS.length]}
          />
          <Text
            x={156}
            y={25 + i * 16}
            style={{ fontSize: 8, fill: '#334155' }}
          >
            {m.model} — {(m.share * 100).toFixed(0)}%
          </Text>
        </G>
      ))}
    </Svg>
  );
}
