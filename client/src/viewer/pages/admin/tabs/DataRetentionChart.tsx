import { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import type { DataRetentionDailyBucket } from '../../../../models';
import { formatBytes } from '../../../lib/format';

interface Props {
  data: DataRetentionDailyBucket[];
}

const TOP_MARGIN = 16;
const BOTTOM_MARGIN = 48;
const LEFT_MARGIN = 48;
const RIGHT_MARGIN = 64;
const CHART_HEIGHT = 300;

const COUNT_COLOR = '#3b82f6';
const SIZE_COLOR = '#f97316';

const LEGEND_ENTRIES = [
  { color: COUNT_COLOR, label: 'Session count' },
  { color: SIZE_COLOR, label: 'Total size' },
] as const;

export function DataRetentionChart({ data }: Props) {
  const xAxisRef = useRef<SVGGElement>(null);
  const yCountAxisRef = useRef<SVGGElement>(null);
  const ySizeAxisRef = useRef<SVGGElement>(null);
  const gridRef = useRef<SVGGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);

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

  const days = data.map((d) => d.day);

  const maxCount = d3.max(data, (d) => d.sessionCount) ?? 0;
  const maxSize = d3.max(data, (d) => d.totalSizeBytes) ?? 0;

  const xScale = d3
    .scaleBand(days, [LEFT_MARGIN, width - RIGHT_MARGIN])
    .padding(0.2);

  const innerScale = d3
    .scaleBand(['count', 'size'], [0, xScale.bandwidth()])
    .padding(0.15);

  const yCountScale = d3
    .scaleLinear()
    .domain([0, maxCount || 1])
    .range([CHART_HEIGHT - BOTTOM_MARGIN, TOP_MARGIN]);

  const ySizeScale = d3
    .scaleLinear()
    .domain([0, maxSize || 1])
    .range([CHART_HEIGHT - BOTTOM_MARGIN, TOP_MARGIN]);

  const maxLabels = 14;
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
          .tickFormat((d) =>
            new Date(String(d)).toLocaleDateString([], {
              month: 'short',
              day: 'numeric',
            }),
          )
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
    if (!yCountAxisRef.current) return;
    d3.select(yCountAxisRef.current)
      .call(
        d3
          .axisLeft(yCountScale)
          .ticks(5)
          .tickFormat(d3.format('d'))
          .tickSize(4),
      )
      .select('.domain')
      .attr('stroke', 'currentColor')
      .attr('opacity', 0.3);
    d3.select(yCountAxisRef.current)
      .selectAll('.tick line')
      .attr('stroke', 'currentColor')
      .attr('opacity', 0.3);
    d3.select(yCountAxisRef.current)
      .selectAll('.tick text')
      .attr('fill', COUNT_COLOR)
      .attr('font-size', '10px');

    if (!gridRef.current) return;
    const gridWidth = width - LEFT_MARGIN - RIGHT_MARGIN;
    const gridSel = d3.select(gridRef.current);
    gridSel.call(
      d3
        .axisLeft(yCountScale)
        .ticks(5)
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

  useEffect(() => {
    if (!ySizeAxisRef.current) return;
    d3.select(ySizeAxisRef.current)
      .call(
        d3
          .axisRight(ySizeScale)
          .ticks(5)
          .tickFormat((d) => formatBytes(d as number))
          .tickSize(4),
      )
      .select('.domain')
      .attr('stroke', 'currentColor')
      .attr('opacity', 0.3);
    d3.select(ySizeAxisRef.current)
      .selectAll('.tick line')
      .attr('stroke', 'currentColor')
      .attr('opacity', 0.3);
    d3.select(ySizeAxisRef.current)
      .selectAll('.tick text')
      .attr('fill', SIZE_COLOR)
      .attr('font-size', '10px');
  });

  return (
    <div ref={containerRef} className="relative w-full">
      <svg
        width={width}
        height={CHART_HEIGHT}
        style={{ display: 'block', overflow: 'visible' }}
      >
        <g ref={gridRef} transform={`translate(${LEFT_MARGIN}, 0)`} />
        {data.map((bucket) => {
          const barX = xScale(bucket.day) ?? 0;
          const countX = barX + (innerScale('count') ?? 0);
          const sizeX = barX + (innerScale('size') ?? 0);
          const subBarW = innerScale.bandwidth();

          const countY = yCountScale(bucket.sessionCount);
          const countH = Math.max(0, yCountScale(0) - countY);
          const sizeY = ySizeScale(bucket.totalSizeBytes);
          const sizeH = Math.max(0, ySizeScale(0) - sizeY);

          return (
            <g key={bucket.day}>
              <title>
                {new Date(bucket.day).toLocaleDateString([], {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
                {' · '}
                {bucket.sessionCount} session
                {bucket.sessionCount === 1 ? '' : 's'}
                {' · '}
                {formatBytes(bucket.totalSizeBytes)}
              </title>
              <rect
                x={countX}
                y={countY}
                width={subBarW}
                height={countH}
                fill={COUNT_COLOR}
                opacity={0.85}
                rx={2}
              />
              <rect
                x={sizeX}
                y={sizeY}
                width={subBarW}
                height={sizeH}
                fill={SIZE_COLOR}
                opacity={0.85}
                rx={2}
              />
            </g>
          );
        })}

        <g
          ref={xAxisRef}
          transform={`translate(0, ${CHART_HEIGHT - BOTTOM_MARGIN})`}
        />
        <g ref={yCountAxisRef} transform={`translate(${LEFT_MARGIN}, 0)`} />
        <g
          ref={ySizeAxisRef}
          transform={`translate(${width - RIGHT_MARGIN}, 0)`}
        />
      </svg>

      <div className="flex flex-wrap items-center gap-4 mt-2 px-1 text-xs text-muted-foreground">
        {LEGEND_ENTRIES.map(({ color, label }) => (
          <span key={label} className="flex items-center gap-1">
            <span
              className="inline-block w-3 h-3 rounded-sm opacity-85"
              style={{ backgroundColor: color }}
            />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
