import * as d3 from 'd3';
import { useEffect, useRef, useState } from 'react';
import { contextColorDynamic } from '@/lib/chart-colors';
import { formatBytes } from '../../log-parser';
import { CHART_TOOLTIP_CLASS } from '../chart-tooltip-class';
import type { ContextSlice } from './context-data';

interface ContextPieChartProps {
  slices: ContextSlice[];
  size?: number;
}

interface TooltipInfo {
  label: string;
  bytes: string;
  tokens: number;
  pct: string;
  x: number;
  y: number;
}

const SMALL_SLICE_THRESHOLD = 0.02;

function collapseSmallSlices(slices: ContextSlice[]): ContextSlice[] {
  const total = slices.reduce((sum, s) => sum + s.tokens, 0);
  if (total === 0) return slices;

  const big: ContextSlice[] = [];
  let otherBytes = 0;
  let otherTokens = 0;

  for (const s of slices) {
    if (s.tokens / total < SMALL_SLICE_THRESHOLD) {
      otherBytes += s.bytes;
      otherTokens += s.tokens;
    } else {
      big.push(s);
    }
  }

  if (otherBytes > 0) {
    big.push({
      key: 'other',
      label: 'Other (small)',
      bytes: otherBytes,
      tokens: otherTokens,
    });
  }

  return big;
}

export function ContextPieChart({ slices, size = 260 }: ContextPieChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);

  const nonZero = slices.filter((s) => s.bytes > 0);

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;

    d3.select(svgEl).selectAll('*').remove();

    if (nonZero.length === 0) return;

    const collapsed = collapseSmallSlices(nonZero);
    const total = collapsed.reduce((sum, s) => sum + s.tokens, 0);

    const margin = size * 0.04; // small padding around the pie
    const svgSize = size + margin * 2;
    const cx = svgSize / 2;
    const cy = svgSize / 2;
    const outerR = size / 2;
    const innerR = outerR * 0.35;

    const svg = d3
      .select(svgEl)
      .attr('width', svgSize)
      .attr('height', svgSize)
      .attr('viewBox', `0 0 ${svgSize} ${svgSize}`);

    const g = svg.append('g').attr('transform', `translate(${cx},${cy})`);

    const pie = d3
      .pie<ContextSlice>()
      .value((d) => d.tokens)
      .sort(null);
    const arcs = pie(collapsed);

    const arc = d3
      .arc<d3.PieArcDatum<ContextSlice>>()
      .innerRadius(innerR)
      .outerRadius(outerR);

    // Draw slices
    g.selectAll('path')
      .data(arcs)
      .join('path')
      .attr('d', arc)
      .attr('fill', (d) => contextColorDynamic(d.data.key))
      .attr('stroke', 'hsl(var(--background))')
      .attr('stroke-width', 1.5)
      .style('cursor', 'pointer')
      .on('mousemove', function (event: MouseEvent, d) {
        const pct = ((d.data.tokens / total) * 100).toFixed(1);
        const rect = containerRef.current?.getBoundingClientRect() ?? {
          left: 0,
          top: 0,
        };
        setTooltip({
          label: d.data.label,
          bytes: formatBytes(d.data.bytes),
          tokens: d.data.tokens,
          pct: `${pct}%`,
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
      })
      .on('mouseleave', function () {
        setTooltip(null);
      });

    // Draw percentage labels inside slices (only for slices ≥ 10%)
    arcs.forEach((d) => {
      const pct = (d.data.tokens / total) * 100;
      if (pct < 10) return;
      const [lx, ly] = arc.centroid(d);
      g.append('text')
        .attr('x', lx)
        .attr('y', ly)
        .attr('dy', '0.35em')
        .attr('text-anchor', 'middle')
        .attr('font-size', '9px')
        .attr('font-weight', '500')
        .attr('fill', 'hsl(var(--background))')
        .attr('pointer-events', 'none')
        .text(`${pct.toFixed(0)}%`);
    });
  }, [nonZero, size]);

  if (nonZero.length === 0) {
    return (
      <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
        No context data
      </div>
    );
  }

  const margin = size * 0.04;
  const svgSize = size + margin * 2;

  return (
    <div className="relative" ref={containerRef}>
      <svg ref={svgRef} width={svgSize} height={svgSize} overflow="visible" />
      {tooltip && (
        <div
          className={CHART_TOOLTIP_CLASS}
          style={{ left: tooltip.x + 12, top: tooltip.y - 10 }}
        >
          <div className="font-medium">{tooltip.label}</div>
          <div className="text-muted-foreground">
            {tooltip.bytes} · {tooltip.tokens.toLocaleString()} tokens
          </div>
          <div className="text-muted-foreground">{tooltip.pct}</div>
        </div>
      )}
    </div>
  );
}
