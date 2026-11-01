/**
 * The "Cost flow" card (2026-10-30 otel-tabs-traces, DD-28 / FR-26): a custom SVG Sankey over the
 * facts route's `flows` rows, laid out by `layoutOtelCostFlow`. Hovering a band shows its cost,
 * share, calls and (where they add up) sessions; hovering a node shows cost, share and calls.
 * The tooltip renders through `ViewportPopover`. No click action.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ViewportPopover } from '../../../components/ViewportPopover';
import type { OtelFlowRow } from '../../../../models/repositories';
import { formatCount, formatShare, formatUsd } from './otel-format';
import {
  layoutOtelCostFlow,
  OTEL_FLOW_COLUMN_LABELS,
  OTEL_FLOW_NODE_WIDTH,
  otelFlowBandPath,
  type OtelFlowBand,
  type OtelFlowColumn,
  type OtelFlowNode,
} from './otel-cost-flow-layout';

export interface OtelCostFlowProps {
  flows: readonly OtelFlowRow[];
  columns: readonly OtelFlowColumn[];
  /** Subtitle, e.g. which columns and that the period / filters follow the chart. */
  subtitle?: ReactNode;
}

type Hover =
  | { kind: 'band'; band: OtelFlowBand; x: number; y: number }
  | { kind: 'node'; node: OtelFlowNode; x: number; y: number };

const PLOT_HEIGHT = 260;
const TOP = 22;

export function OtelCostFlow({ flows, columns, subtitle }: OtelCostFlowProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [hover, setHover] = useState<Hover | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      if (w > 0) setWidth(Math.min(1200, w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(
    () => layoutOtelCostFlow(flows, columns, { width, height: PLOT_HEIGHT }),
    [flows, columns, width],
  );

  return (
    <section className="rounded-md border p-4" data-testid="otel-cost-flow">
      <h3 className="text-sm font-semibold">Cost flow</h3>
      <p className="mb-2 text-xs text-muted-foreground">
        {subtitle ??
          `${columns.map((c) => OTEL_FLOW_COLUMN_LABELS[c].toLowerCase()).join(' → ')} · same period and filters as the chart`}
      </p>
      <div ref={wrapRef} className="w-full" onMouseLeave={() => setHover(null)}>
        {flows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No cost in this period.
          </p>
        ) : (
          <svg width={width} height={layout.height + TOP + 4} className="block">
            {layout.columns.map((c, i) => (
              <text
                key={c}
                x={layout.nodes.find((n) => n.column === i)?.x ?? 0}
                y={12}
                className="fill-muted-foreground text-[10px] font-semibold uppercase"
              >
                {OTEL_FLOW_COLUMN_LABELS[c]}
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
                    x={n.x + OTEL_FLOW_NODE_WIDTH + 4}
                    y={n.y + n.height / 2}
                    dominantBaseline="middle"
                    className="fill-foreground text-[11px]"
                    stroke="white"
                    strokeWidth={3}
                    paintOrder="stroke"
                  >
                    {n.label.length > 40 ? `${n.label.slice(0, 39)}…` : n.label}{' '}
                    {formatUsd(n.cost)}
                  </text>
                </g>
              ))}
            </g>
          </svg>
        )}
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Hover a band or a node for cost, share and calls. Branch = the session's
        git branch; (unknown) = no git branch recorded.
      </p>
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
              <div className="font-mono">{formatUsd(hover.band.cost)}</div>
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
              <div className="font-mono">{formatUsd(hover.node.cost)}</div>
              <div>{formatShare(hover.node.share)} of total</div>
              <div>{formatCount(hover.node.calls)} calls</div>
            </div>
          )}
        </ViewportPopover>
      )}
    </section>
  );
}
