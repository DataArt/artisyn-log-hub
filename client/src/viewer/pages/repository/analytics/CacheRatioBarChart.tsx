/**
 * Analytics "Cache Read Ratio" chart.
 *
 * Paired bars per UTC day bucket: root-only (blue) next to root + all recursive
 * descendants (teal), on a fixed 0–100 % y-axis. A bucket whose denominator is 0 has no
 * ratio at all and renders as a short dashed `n/a` stub at the baseline — never as a 0 %
 * bar. The two-swatch scope legend replaces the zone-colour legend
 * used by the other analytics views.
 */
import { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { formatCacheReadRatio } from '@/lib/format';
import { CACHE_RATIO_SCOPE_COLORS } from '@/lib/cache-ratio-ui';
import type { TimelineSession } from '../../../../models/repositories';
import {
  bucketCacheRatioByDay,
  type CacheRatioDayBucket,
} from './cache-ratio-aggregate';
import { CacheRatioScopeLegend } from './CacheRatioScopeSummary';
import { ViewportPopover } from '../../../components/ViewportPopover';

interface Props {
  sessions: TimelineSession[];
}

interface TooltipState {
  x: number;
  y: number;
  bucket: CacheRatioDayBucket;
}

const TOP_MARGIN = 16;
const BOTTOM_MARGIN = 48;
const LEFT_MARGIN = 56;
const RIGHT_MARGIN = 16;
const CHART_HEIGHT = 300;
const STUB_HEIGHT = 10;

function formatDayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function BucketTooltip({ x, y, bucket }: TooltipState) {
  return (
    <ViewportPopover x={x} y={y} offset={12} className="w-[300px]">
      <div className="text-xs font-semibold text-muted-foreground mb-2">
        {formatDayLabel(bucket.day)}
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <span
            className="inline-block w-2.5 h-2.5 rounded-sm"
            style={{ backgroundColor: CACHE_RATIO_SCOPE_COLORS.root }}
          />
          Root only
        </span>
        <span className="font-mono font-bold text-blue-700">
          {formatCacheReadRatio(bucket.root.ratio)}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <span
            className="inline-block w-2.5 h-2.5 rounded-sm"
            style={{
              backgroundColor: CACHE_RATIO_SCOPE_COLORS.withDescendants,
            }}
          />
          Root + descendants
        </span>
        <span className="font-mono font-bold text-teal-700">
          {formatCacheReadRatio(bucket.withDescendants.ratio)}
        </span>
      </div>
      <div className="mt-1.5 pt-1.5 border-t border-border text-xs">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">cache read (root)</span>
          <span className="font-mono">{bucket.root.read.toLocaleString()}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">cache write (root)</span>
          <span className="font-mono">
            {bucket.root.write.toLocaleString()}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">
            cache read / write (incl. descendants)
          </span>
          <span className="font-mono">
            {bucket.withDescendants.read.toLocaleString()} /{' '}
            {bucket.withDescendants.write.toLocaleString()}
          </span>
        </div>
      </div>
      <div className="mt-1.5 text-[10px] text-muted-foreground">
        Sessions in bucket: {bucket.root.sessionCount.toLocaleString()} root
      </div>
    </ViewportPopover>
  );
}

export function CacheRatioBarChart({ sessions }: Props) {
  const xAxisRef = useRef<SVGGElement>(null);
  const yAxisRef = useRef<SVGGElement>(null);
  const gridRef = useRef<SVGGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(w);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const buckets = bucketCacheRatioByDay(sessions);
  const days = buckets.map((b) => b.day);

  const xScale = d3
    .scaleBand(days, [
      LEFT_MARGIN,
      Math.max(LEFT_MARGIN + 1, width - RIGHT_MARGIN),
    ])
    .padding(0.3);
  // Fixed 0–100 % domain: the metric is bounded, so a rescaled axis would exaggerate
  // small differences between days.
  const yScale = d3
    .scaleLinear()
    .domain([0, 100])
    .range([CHART_HEIGHT - BOTTOM_MARGIN, TOP_MARGIN]);

  const maxLabels = 24;
  const culledDays: string[] =
    days.length <= maxLabels
      ? days
      : days.filter((_, i) => i % Math.ceil(days.length / maxLabels) === 0);

  useEffect(() => {
    if (!xAxisRef.current) return;
    d3.select(xAxisRef.current)
      .call(
        d3
          .axisBottom(xScale)
          .tickValues(culledDays)
          .tickFormat((d) => formatDayLabel(String(d)))
          .tickSize(4),
      )
      .select('.domain')
      .attr('stroke', 'currentColor')
      .attr('opacity', 0.3);
    d3.select(xAxisRef.current)
      .selectAll('.tick line')
      .attr('stroke', 'currentColor')
      .attr('opacity', 0.3);
    d3.select(xAxisRef.current)
      .selectAll('.tick text')
      .attr('fill', 'currentColor')
      .attr('font-size', '10px')
      .attr('transform', 'rotate(-45)')
      .attr('text-anchor', 'end');
  });

  useEffect(() => {
    if (!yAxisRef.current) return;
    d3.select(yAxisRef.current)
      .call(
        d3
          .axisLeft(yScale)
          .tickValues([0, 20, 40, 60, 80, 100])
          .tickFormat((d) => `${Number(d)}%`)
          .tickSize(4),
      )
      .select('.domain')
      .attr('stroke', 'currentColor')
      .attr('opacity', 0.3);
    d3.select(yAxisRef.current)
      .selectAll('.tick line')
      .attr('stroke', 'currentColor')
      .attr('opacity', 0.3);
    d3.select(yAxisRef.current)
      .selectAll('.tick text')
      .attr('fill', 'currentColor')
      .attr('font-size', '10px');

    if (!gridRef.current) return;
    const gridWidth = width - LEFT_MARGIN - RIGHT_MARGIN;
    const gridSel = d3.select(gridRef.current);
    gridSel.call(
      d3
        .axisLeft(yScale)
        .tickValues([0, 20, 40, 60, 80, 100])
        .tickSize(-gridWidth)
        .tickFormat(() => ''),
    );
    gridSel.select('.domain').remove();
    gridSel
      .selectAll('.tick line')
      .attr('stroke', 'currentColor')
      .attr('opacity', 0.12);
    gridSel.selectAll('.tick text').remove();
  });

  if (buckets.length === 0) {
    return (
      <div ref={containerRef} className="relative w-full">
        <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
          No cache activity in this range
        </div>
      </div>
    );
  }

  const baselineY = yScale(0);
  const bandWidth = xScale.bandwidth();
  const barWidth = Math.max(2, (bandWidth - 2) / 2);

  return (
    <div ref={containerRef} className="relative w-full">
      <svg
        width={width}
        height={CHART_HEIGHT}
        style={{ display: 'block', overflow: 'visible' }}
      >
        <g ref={gridRef} transform={`translate(${LEFT_MARGIN}, 0)`} />
        {buckets.map((bucket) => {
          const bandX = xScale(bucket.day) ?? 0;
          const series = [
            {
              key: 'root',
              ratio: bucket.root.ratio,
              x: bandX,
              fill: CACHE_RATIO_SCOPE_COLORS.root,
            },
            {
              key: 'withDescendants',
              ratio: bucket.withDescendants.ratio,
              x: bandX + barWidth + 2,
              fill: CACHE_RATIO_SCOPE_COLORS.withDescendants,
            },
          ];
          const bothUndefined =
            bucket.root.ratio === null && bucket.withDescendants.ratio === null;

          return (
            <g
              key={bucket.day}
              style={{ cursor: 'default' }}
              onMouseMove={(e) =>
                setTooltip({ x: e.clientX, y: e.clientY, bucket })
              }
              onMouseLeave={() => setTooltip(null)}
            >
              {/* Invisible hit area so the whole band is hoverable */}
              <rect
                x={bandX}
                y={TOP_MARGIN}
                width={bandWidth}
                height={baselineY - TOP_MARGIN}
                fill="transparent"
              />
              {series.map(({ key, ratio, x, fill }) =>
                ratio === null ? (
                  <rect
                    key={key}
                    data-testid="cache-ratio-na-stub"
                    x={x}
                    y={baselineY - STUB_HEIGHT}
                    width={barWidth}
                    height={STUB_HEIGHT}
                    rx={2}
                    fill="transparent"
                    stroke={CACHE_RATIO_SCOPE_COLORS.undefinedRatio}
                    strokeDasharray="3,2"
                  />
                ) : (
                  <rect
                    key={key}
                    data-testid="cache-ratio-bar"
                    x={x}
                    y={yScale(ratio * 100)}
                    width={barWidth}
                    height={Math.max(1, baselineY - yScale(ratio * 100))}
                    rx={2}
                    fill={fill}
                    opacity={0.9}
                  />
                ),
              )}
              {bothUndefined && (
                <text
                  x={bandX + bandWidth / 2}
                  y={baselineY - STUB_HEIGHT - 4}
                  textAnchor="middle"
                  fontSize={9}
                  fill={CACHE_RATIO_SCOPE_COLORS.undefinedRatio}
                >
                  n/a
                </text>
              )}
            </g>
          );
        })}
        <g
          ref={xAxisRef}
          transform={`translate(0, ${CHART_HEIGHT - BOTTOM_MARGIN})`}
        />
        <g ref={yAxisRef} transform={`translate(${LEFT_MARGIN}, 0)`} />
        <text
          x={LEFT_MARGIN - 8}
          y={TOP_MARGIN - 4}
          textAnchor="middle"
          fontSize={9}
          fill="currentColor"
          opacity={0.5}
        >
          ratio
        </text>
      </svg>
      <CacheRatioScopeLegend />
      {tooltip && <BucketTooltip {...tooltip} />}
    </div>
  );
}
