/**
 * The SVG Sankey card shared by the OTEL "Cost flow" (`OtelCostFlow`) and the Live view
 * (`LiveFlowSankey`): it measures its width, asks `buildLayout` for the layout at that width and
 * draws columns, bands and nodes. The columns spread over at most 1200 px; the svg spans the whole
 * card, and last-column labels are cut to the room actually left (`fitFlowLabel`). Hovering a band shows its value, share, calls and (where they
 * add up) sessions; hovering a node shows value, share and calls. The tooltip renders through
 * `ViewportPopover`. No click action.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ViewportPopover } from '../../../components/ViewportPopover';
import { formatCount, formatShare } from './otel-format';
import {
  OTEL_FLOW_NODE_WIDTH,
  otelFlowBandPath,
  type OtelFlowBand,
  type OtelFlowLayout,
  type OtelFlowNode,
} from './otel-cost-flow-layout';
import { fitFlowLabel, OTEL_FLOW_INNER_LABEL_CHARS } from './otel-flow-label';

export interface OtelFlowSankeyProps {
  title: string;
  subtitle: ReactNode;
  footnote: ReactNode;
  /** Column headers, one per layout column. */
  columnLabels: readonly string[];
  /** Layout for the measured plot width (height is fixed). */
  buildLayout: (
    width: number,
    height: number,
  ) => Omit<OtelFlowLayout, 'columns'>;
  /** Formats a node / band weight (cost in USD, a token count, …). */
  formatValue: (value: number) => string;
  isEmpty: boolean;
  emptyText: string;
  testId: string;
}

type Hover =
  | { kind: 'band'; band: OtelFlowBand; x: number; y: number }
  | { kind: 'node'; node: OtelFlowNode; x: number; y: number };

const PLOT_HEIGHT = 260;
const TOP = 22;
/** The columns never spread wider than this; a wider card leaves the rest to the labels. */
const MAX_PLOT_WIDTH = 1200;
/** Between a node and its label. */
const LABEL_GAP = 4;
/** Until the card's own font is read (first effect). */
const LABEL_FONT_FALLBACK = 'system-ui, sans-serif';

export function OtelFlowSankey({
  title,
  subtitle,
  footnote,
  columnLabels,
  buildLayout,
  formatValue,
  isEmpty,
  emptyText,
  testId,
}: OtelFlowSankeyProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  /** The card's full width: the svg spans it, so last-column labels can use the room. */
  const [boxWidth, setBoxWidth] = useState(900);
  const [labelFont, setLabelFont] = useState(`11px ${LABEL_FONT_FALLBACK}`);
  const [hover, setHover] = useState<Hover | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setLabelFont(`11px ${getComputedStyle(el).fontFamily}`);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      if (w > 0) setBoxWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The columns spread over at most 1200 px; the rest of a wide card is label room.
  const width = Math.min(MAX_PLOT_WIDTH, boxWidth);
  // A few hundred rows at most: laying out on every render is cheap.
  const layout = buildLayout(width, PLOT_HEIGHT);
  const lastColumn = Math.max(0, ...layout.nodes.map((n) => n.column));
  const nodeLabel = (n: OtelFlowNode): string => {
    if (n.column !== lastColumn) {
      return n.label.length > OTEL_FLOW_INNER_LABEL_CHARS
        ? `${n.label.slice(0, OTEL_FLOW_INNER_LABEL_CHARS - 1)}…`
        : n.label;
    }
    const free = boxWidth - (n.x + OTEL_FLOW_NODE_WIDTH + LABEL_GAP) - 4;
    return fitFlowLabel(n.label, formatValue(n.cost), free, labelFont);
  };

  return (
    <section className="rounded-md border p-4" data-testid={testId}>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mb-2 text-xs text-muted-foreground">{subtitle}</p>
      <div ref={wrapRef} className="w-full" onMouseLeave={() => setHover(null)}>
        {isEmpty ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {emptyText}
          </p>
        ) : (
          <svg
            width={boxWidth}
            height={layout.height + TOP + 4}
            className="block"
          >
            {columnLabels.map((c, i) => (
              <text
                key={`${i}:${c}`}
                x={layout.nodes.find((n) => n.column === i)?.x ?? 0}
                y={12}
                className="fill-muted-foreground text-[10px] font-semibold uppercase"
              >
                {c}
              </text>
            ))}
            <g transform={`translate(0, ${TOP})`}>
              {layout.bands.map((b) => (
                <path
                  key={b.id}
                  d={otelFlowBandPath(b)}
                  fill={b.source.color}
                  fillOpacity={
                    hover?.kind === 'band' && hover.band.id === b.id
                      ? 0.55
                      : 0.28
                  }
                  onMouseMove={(e) =>
                    setHover({
                      kind: 'band',
                      band: b,
                      x: e.clientX,
                      y: e.clientY,
                    })
                  }
                  data-testid="otel-flow-band"
                />
              ))}
              {layout.nodes.map((n) => (
                <g
                  key={n.id}
                  onMouseMove={(e) =>
                    setHover({
                      kind: 'node',
                      node: n,
                      x: e.clientX,
                      y: e.clientY,
                    })
                  }
                  data-testid="otel-flow-node"
                >
                  <rect
                    x={n.x}
                    y={n.y}
                    width={OTEL_FLOW_NODE_WIDTH}
                    height={n.height}
                    fill={n.color}
                    rx={2}
                  />
                  <text
                    x={n.x + OTEL_FLOW_NODE_WIDTH + LABEL_GAP}
                    y={n.y + n.height / 2}
                    dominantBaseline="middle"
                    className="fill-foreground text-[11px]"
                    stroke="white"
                    strokeWidth={3}
                    paintOrder="stroke"
                  >
                    {nodeLabel(n)} {formatValue(n.cost)}
                  </text>
                </g>
              ))}
            </g>
          </svg>
        )}
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">{footnote}</p>
      {hover && (
        <ViewportPopover
          x={hover.x}
          y={hover.y}
          maxWidth={360}
          className="text-xs"
        >
          {hover.kind === 'band' ? (
            <div className="space-y-0.5" data-testid="otel-flow-tooltip">
              <div className="font-semibold">
                {hover.band.source.label} → {hover.band.target.label}
              </div>
              <div className="font-mono">{formatValue(hover.band.cost)}</div>
              <div>{formatShare(hover.band.share)} of total</div>
              <div>
                {formatCount(hover.band.calls)} calls
                {hover.band.sessions !== null &&
                  ` · ${formatCount(hover.band.sessions)} sessions`}
              </div>
            </div>
          ) : (
            <div className="space-y-0.5" data-testid="otel-flow-tooltip">
              <div className="font-semibold">{hover.node.label}</div>
              <div className="font-mono">{formatValue(hover.node.cost)}</div>
              <div>{formatShare(hover.node.share)} of total</div>
              <div>{formatCount(hover.node.calls)} calls</div>
            </div>
          )}
        </ViewportPopover>
      )}
    </section>
  );
}
