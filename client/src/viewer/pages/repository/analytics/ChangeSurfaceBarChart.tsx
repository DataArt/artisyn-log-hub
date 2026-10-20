/**
 * Analytics "Change Surface" chart.
 *
 * One bar per server-side bucket (`hour` / `day` / `week`, derived from the range span),
 * fed by `GET :repoId/analytics/change-surface`. Every bucket is its own union
 * recomputation on the server, so bars are never summed or averaged here.
 *
 * Axis treatment follows `CacheRatioBarChart.tsx`: `concentration` is a bounded 0-100
 * score and gets a **fixed** 0-100 axis, because rescaling a bounded metric to its own
 * max exaggerates small differences. The three volume metrics are open-ended counts and
 * keep the data-scaled axis plus the shared `zoneColor` treatment. The D3-axes /
 * React-`<rect>` split (D3 owns only the `<g>` axis nodes, React owns every bar) is the
 * `FilesBarChart.tsx` pattern.
 *
 * A bucket that changed no file has **no** concentration: it renders as an `n/a` stub at
 * the baseline, never as a `0` bar.
 *
 * The shaded background zones are the shared band legend from `lib/change-surface-ui.ts`
 * drawn graphically — display copy describing the server's fixed thresholds (the
 * real `ChangeBand` still comes from the server on every other surface — the Summary
 * tile, the Change surface tab, the report). The bucket payload carries no `band` field, but
 * each bar's own fill mirrors those same already-duplicated display thresholds (`BAND_ZONES` /
 * `zoneOf` in `lib/change-surface-ui.ts`) so a bar visually sits in the zone it's drawn over — a flat single colour left a bar
 * sitting in the "scattered" background rendering as "mixed" blue, contradicting the legend
 * directly under it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import type {
  ChangeSurfaceBucket,
  ChangeSurfaceTimeline,
  ChangeSurfaceTimelineBucket,
  TimelineSession,
} from '../../../../models/repositories';
import {
  CHANGE_BAND_COLORS,
  CHANGE_BAND_UNDEFINED_COLOR,
  BAND_ZONES,
  CONCENTRATION_AXIS_MAX,
  zoneOf,
} from '../../../lib/change-surface-ui';
import { zoneColor } from './HorizontalBarChart';
import {
  HorizontalSessionModal,
  type ModalState,
} from './HorizontalSessionModal';
import {
  resolveChangeSurfaceMetric,
  resolveChangeSurfaceValue,
  type ChangeSurfaceMetricKey,
} from './change-surface-metrics';
import {
  BandLegend,
  BucketTooltip,
  CenteredNote,
  GroupLegend,
  ZoneLegend,
  type SeriesPoint,
  type TooltipState,
} from './ChangeSurfaceChartParts';

interface Props {
  timeline: ChangeSurfaceTimeline | undefined;
  isFetching: boolean;
  isError: boolean;
  activeMetric: ChangeSurfaceMetricKey;
  /** The shared timeline payload, used only to give the click-through modal real rows. */
  sessions: TimelineSession[];
  onSessionClick: (sessionId: string) => void;
}

const TOP_MARGIN = 16;
const BOTTOM_MARGIN = 48;
const LEFT_MARGIN = 56;
const RIGHT_MARGIN = 16;
const CHART_HEIGHT = 300;
const STUB_HEIGHT = 10;
const ALL_SERIES_KEY = '__all__';

function formatBucketLabel(
  iso: string,
  size: ChangeSurfaceTimelineBucket,
): string {
  const d = new Date(iso);
  if (size === 'hour') {
    return d.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  const day = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return size === 'week' ? `week of ${day}` : day;
}

/**
 * The x-axis tick label, distinct from `formatBucketLabel`'s full tooltip text: an `hour`
 * bucket's every-tick full date+time (`Aug 27, 05:00 PM`) is too long for a rotated tick to fit
 * above the legend without overlapping it, so ticks print a bare time and only spell out the
 * date at midnight — the `CostBarChart.tsx` hour-axis convention.
 */
function formatAxisTickLabel(
  iso: string,
  size: ChangeSurfaceTimelineBucket,
): string {
  if (size !== 'hour') return formatBucketLabel(iso, size);
  const d = new Date(iso);
  if (d.getHours() === 0) {
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatCount(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return `${v}`;
}

export function ChangeSurfaceBarChart({
  timeline,
  isFetching,
  isError,
  activeMetric,
  sessions,
  onSessionClick,
}: Props) {
  const xAxisRef = useRef<SVGGElement>(null);
  const yAxisRef = useRef<SVGGElement>(null);
  const gridRef = useRef<SVGGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);

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

  const metric = resolveChangeSurfaceMetric(activeMetric);
  const bucketSize: ChangeSurfaceTimelineBucket = timeline?.bucket ?? 'day';
  const repoBuckets = useMemo(() => timeline?.buckets ?? [], [timeline]);
  const groups = timeline?.groups ?? null;
  const grouped = groups != null && groups.length > 0;

  const series = useMemo(
    () =>
      grouped
        ? groups.map((g) => ({
            key: g.key,
            label: g.label,
            buckets: g.buckets,
          }))
        : [
            {
              key: ALL_SERIES_KEY,
              label: 'All sessions',
              buckets: repoBuckets,
            },
          ],
    [grouped, groups, repoBuckets],
  );

  const bucketKeys = useMemo(() => {
    const keys = new Set(repoBuckets.map((b) => b.bucketStart));
    for (const s of series) {
      for (const b of s.buckets) keys.add(b.bucketStart);
    }
    return Array.from(keys).sort();
  }, [repoBuckets, series]);

  const sessionsById = useMemo(() => {
    const map = new Map<string, TimelineSession>();
    for (const s of sessions) map.set(s.sessionId, s);
    return map;
  }, [sessions]);

  const maxValue = useMemo(() => {
    if (metric.bounded) return CONCENTRATION_AXIS_MAX;
    let max = 1;
    for (const s of series) {
      for (const b of s.buckets) {
        const v = resolveChangeSurfaceValue(b, metric.key) ?? 0;
        if (v > max) max = v;
      }
    }
    return max;
  }, [series, metric]);

  const xScale = d3
    .scaleBand(bucketKeys, [
      LEFT_MARGIN,
      Math.max(LEFT_MARGIN + 1, width - RIGHT_MARGIN),
    ])
    .padding(0.3);
  const yScale = d3
    .scaleLinear()
    .domain([0, maxValue])
    .range([CHART_HEIGHT - BOTTOM_MARGIN, TOP_MARGIN]);

  const colorScale = d3
    .scaleOrdinal<string>()
    .domain(series.map((s) => s.key))
    .range(d3.schemeTableau10);

  const maxLabels = 24;
  const culledKeys: string[] =
    bucketKeys.length <= maxLabels
      ? bucketKeys
      : bucketKeys.filter(
          (_, i) => i % Math.ceil(bucketKeys.length / maxLabels) === 0,
        );
  const yTickValues = metric.bounded ? [0, 20, 40, 60, 80, 100] : null;

  useEffect(() => {
    if (!xAxisRef.current) return;
    d3.select(xAxisRef.current)
      .call(
        d3
          .axisBottom(xScale)
          .tickValues(culledKeys)
          .tickFormat((d) => formatAxisTickLabel(String(d), bucketSize))
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
    const axis = d3.axisLeft(yScale).tickSize(4);
    if (yTickValues)
      axis.tickValues(yTickValues).tickFormat((d) => `${Number(d)}`);
    else axis.ticks(5).tickFormat((d) => formatCount(d as number));
    d3.select(yAxisRef.current)
      .call(axis)
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
    const grid = d3
      .axisLeft(yScale)
      .tickSize(-gridWidth)
      .tickFormat(() => '');
    if (yTickValues) grid.tickValues(yTickValues);
    else grid.ticks(5);
    const gridSel = d3.select(gridRef.current);
    gridSel.call(grid);
    gridSel.select('.domain').remove();
    gridSel
      .selectAll('.tick line')
      .attr('stroke', 'currentColor')
      .attr('opacity', 0.12);
    gridSel.selectAll('.tick text').remove();
  });

  if (isFetching && timeline == null) {
    return (
      <div ref={containerRef} className="relative w-full">
        <div className="flex h-48 items-center justify-center gap-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          <span className="text-sm text-muted-foreground">Loading…</span>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div ref={containerRef} className="relative w-full">
        <CenteredNote text="Could not load the change surface for this range" />
      </div>
    );
  }

  if (bucketKeys.length === 0) {
    return (
      <div ref={containerRef} className="relative w-full">
        <CenteredNote text="No file changes recorded in this range" />
      </div>
    );
  }

  const baselineY = yScale(0);
  const bandWidth = xScale.bandwidth();
  const barWidth = Math.max(
    2,
    (bandWidth - (series.length - 1)) / series.length,
  );

  function openModal(label: string, bucket: ChangeSurfaceBucket | null) {
    if (!bucket) return;
    const rows = bucket.sessionIds
      .map((id) => sessionsById.get(id))
      .filter((s): s is TimelineSession => s != null);
    if (rows.length === 0) return;
    setTooltip(null);
    setModal({ label, sessions: rows });
  }

  return (
    <div ref={containerRef} className="relative w-full">
      <svg
        width={width}
        height={CHART_HEIGHT}
        style={{ display: 'block', overflow: 'visible' }}
      >
        {metric.bounded &&
          BAND_ZONES.map(({ band, from, to }) => (
            <rect
              key={band}
              x={LEFT_MARGIN}
              y={yScale(to)}
              width={Math.max(0, width - LEFT_MARGIN - RIGHT_MARGIN)}
              height={Math.max(0, yScale(from) - yScale(to))}
              fill={CHANGE_BAND_COLORS[band]}
              opacity={0.08}
            />
          ))}
        <g ref={gridRef} transform={`translate(${LEFT_MARGIN}, 0)`} />
        {bucketKeys.map((bucketKey) => {
          const bandX = xScale(bucketKey) ?? 0;
          const repoBucket =
            repoBuckets.find((b) => b.bucketStart === bucketKey) ?? null;
          const points: SeriesPoint[] = [];
          for (const s of series) {
            const bucket = s.buckets.find((b) => b.bucketStart === bucketKey);
            if (bucket) {
              points.push({
                seriesKey: s.key,
                seriesLabel: s.label,
                bucket,
              });
            }
          }
          const label = formatBucketLabel(bucketKey, bucketSize);
          const clickable =
            repoBucket != null && repoBucket.sessionIds.length > 0;

          return (
            <g
              key={bucketKey}
              style={{ cursor: clickable ? 'pointer' : 'default' }}
              onMouseMove={(e) =>
                setTooltip({
                  x: e.clientX,
                  y: e.clientY,
                  label,
                  repoBucket,
                  points,
                })
              }
              onMouseLeave={() => setTooltip(null)}
              onClick={() => openModal(label, repoBucket)}
            >
              {/* Invisible hit area so the whole band is hoverable */}
              <rect
                x={bandX}
                y={TOP_MARGIN}
                width={bandWidth}
                height={baselineY - TOP_MARGIN}
                fill="transparent"
              />
              {points.map(({ seriesKey, bucket }, i) => {
                const x = bandX + i * (barWidth + 1);
                const value = resolveChangeSurfaceValue(bucket, metric.key);
                if (value === null) {
                  return (
                    <rect
                      key={seriesKey}
                      data-testid="change-surface-na-stub"
                      x={x}
                      y={baselineY - STUB_HEIGHT}
                      width={barWidth}
                      height={STUB_HEIGHT}
                      rx={2}
                      fill="transparent"
                      stroke={CHANGE_BAND_UNDEFINED_COLOR}
                      strokeDasharray="3,2"
                    />
                  );
                }
                const fill = grouped
                  ? colorScale(seriesKey)
                  : metric.bounded
                    ? CHANGE_BAND_COLORS[zoneOf(value).band]
                    : zoneColor(value, maxValue);
                return (
                  <rect
                    key={seriesKey}
                    data-testid="change-surface-bar"
                    x={x}
                    y={yScale(value)}
                    width={barWidth}
                    height={Math.max(1, baselineY - yScale(value))}
                    rx={2}
                    fill={fill}
                    opacity={0.85}
                  />
                );
              })}
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
          {metric.yLabel}
        </text>
      </svg>

      {grouped ? (
        <GroupLegend
          keys={series.map((s) => s.key)}
          labels={new Map(series.map((s) => [s.key, s.label]))}
          colorScale={colorScale}
        />
      ) : metric.bounded ? (
        <BandLegend />
      ) : (
        <ZoneLegend />
      )}

      {tooltip && <BucketTooltip {...tooltip} metricKey={metric.key} />}
      {modal && (
        <HorizontalSessionModal
          state={modal}
          onClose={() => setModal(null)}
          onSessionClick={onSessionClick}
        />
      )}
    </div>
  );
}
