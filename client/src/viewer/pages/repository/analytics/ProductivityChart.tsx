import { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import type { TimelineSession } from '../../../../models/repositories';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/ui/dialog';
import {
  type ProductivityMetricKey,
  type ProductivityMetricDef,
  PRODUCTIVITY_METRICS,
  computeProductivityValue,
} from './metrics';
import { ViewportPopover } from '../../../components/ViewportPopover';
import { PROMPT_HIDDEN_LABEL } from '../../../lib/access-mode-copy';

interface Props {
  sessions: TimelineSession[];
  startDate: string;
  endDate: string;
  groupBy: 'none' | 'branch' | 'user' | `attr:${string}`;
  activeMetric: ProductivityMetricKey;
  onSessionClick?: (sessionId: string) => void;
}

interface TooltipState {
  x: number;
  y: number;
  hourLabel: string;
  includedSessions: TimelineSession[];
  allSessions: TimelineSession[];
  metric: ProductivityMetricDef;
  groupBy: 'none' | 'branch' | 'user' | `attr:${string}`;
  bucketValue: number;
}

interface ModalState {
  hourLabel: string;
  sessions: TimelineSession[];
  metric: ProductivityMetricDef;
}

const TOP_MARGIN = 16;
const BOTTOM_MARGIN = 48;
const LEFT_MARGIN = 64;
const RIGHT_MARGIN = 16;
const CHART_HEIGHT = 300;
const SEGMENT_GAP = 1;

function zoneColor(value: number, maxY: number): string {
  if (maxY === 0) return '#3b82f6';
  const low = maxY * 0.25;
  const mid = maxY * 0.75;
  if (value <= low) return '#22c55e';
  if (value <= mid) return '#3b82f6';
  return '#f97316';
}

function formatWorkTime(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

function SessionRow({
  session,
  metric,
  className,
  onSessionClick,
}: {
  session: TimelineSession;
  metric: ProductivityMetricDef;
  className?: string;
  onSessionClick?: (sessionId: string) => void;
}) {
  const start = new Date(session.startTime);
  const end = new Date(session.endTime);
  const startStr = start.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const endStr = end.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const prompt = session.firstPrompt ?? PROMPT_HIDDEN_LABEL;
  const preview = prompt.length > 50 ? prompt.slice(0, 50) + '…' : prompt;
  const value = computeProductivityValue(session, metric.key);

  return (
    <div
      className={`${className ?? ''} ${onSessionClick ? 'cursor-pointer rounded hover:bg-accent/50 transition-colors' : ''}`}
      onClick={
        onSessionClick ? () => onSessionClick(session.sessionId) : undefined
      }
    >
      <div className="text-xs text-muted-foreground">
        {startStr}–{endStr}
      </div>
      {preview && (
        <div className="text-xs font-medium break-words mt-0.5">{preview}</div>
      )}
      <div className="flex flex-wrap gap-x-3 text-xs mt-0.5 font-mono">
        {value !== null && value > 0 && (
          <span className="font-semibold">
            {metric.format(value)} {metric.yLabel}
          </span>
        )}
        {session.gitBranch && (
          <span className="text-muted-foreground">{session.gitBranch}</span>
        )}
      </div>
    </div>
  );
}

function HourModal({
  state,
  onClose,
  onSessionClick,
}: {
  state: ModalState;
  onClose: () => void;
  onSessionClick?: (sessionId: string) => void;
}) {
  function handleSessionClick(sessionId: string) {
    onClose();
    onSessionClick?.(sessionId);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{state.hourLabel}</DialogTitle>
        </DialogHeader>
        <div className="overflow-y-auto max-h-[60vh]">
          {state.sessions.map((session, i) => (
            <SessionRow
              key={session.sessionId}
              session={session}
              metric={state.metric}
              className={i > 0 ? 'border-t border-border pt-2 mt-2' : undefined}
              onSessionClick={onSessionClick ? handleSessionClick : undefined}
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ZoneLegend() {
  return (
    <div className="flex items-center gap-4 mt-2 px-1 text-xs text-muted-foreground">
      {(
        [
          { color: '#22c55e', label: '<25%' },
          { color: '#3b82f6', label: '25–75%' },
          { color: '#f97316', label: '>75%' },
        ] as const
      ).map(({ color, label }) => (
        <span key={label} className="flex items-center gap-1">
          <span
            className="inline-block w-3 h-3 rounded-sm opacity-85"
            style={{ backgroundColor: color }}
          />
          {label}
        </span>
      ))}
    </div>
  );
}

function GroupLegend({
  keys,
  colorScale,
}: {
  keys: string[];
  colorScale: d3.ScaleOrdinal<string, string>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-4 mt-2 px-1 text-xs text-muted-foreground">
      {keys.map((key) => (
        <span key={key} className="flex items-center gap-1">
          <span
            className="inline-block w-3 h-3 rounded-sm opacity-85"
            style={{ backgroundColor: colorScale(key) }}
          />
          {key}
        </span>
      ))}
    </div>
  );
}

function HourTooltip({
  x,
  y,
  hourLabel,
  includedSessions,
  allSessions,
  metric,
  groupBy,
  bucketValue,
}: TooltipState) {
  const totalLinesChanged = allSessions.reduce(
    (sum, s) => sum + s.linesChanged,
    0,
  );
  const totalWorkTimeMs = allSessions.reduce((sum, s) => sum + s.workTimeMs, 0);
  const totalCost = allSessions.reduce((sum, s) => sum + (s.totalCost ?? 0), 0);

  return (
    <ViewportPopover x={x} y={y} offset={12} maxWidth={320}>
      <div className="text-xs font-semibold text-muted-foreground mb-2">
        {hourLabel}
      </div>
      <div className="text-xs font-mono font-semibold mb-1.5">
        {metric.format(bucketValue)}
      </div>
      <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
        <span>Lines changed: {totalLinesChanged.toLocaleString()}</span>
        <span>Work time: {formatWorkTime(totalWorkTimeMs)}</span>
        <span>Cost: ${totalCost.toFixed(2)}</span>
      </div>
      {groupBy !== 'none' && includedSessions.length < allSessions.length && (
        <div className="text-xs text-muted-foreground mt-1.5 pt-1.5 border-t border-border">
          ({includedSessions.length} of {allSessions.length} sessions included)
        </div>
      )}
    </ViewportPopover>
  );
}

export function ProductivityChart({
  sessions,
  startDate: _startDate,
  endDate: _endDate,
  groupBy,
  activeMetric,
  onSessionClick,
}: Props) {
  const xAxisRef = useRef<SVGGElement>(null);
  const yAxisRef = useRef<SVGGElement>(null);
  const gridRef = useRef<SVGGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);

  const metric =
    PRODUCTIVITY_METRICS.find((m) => m.key === activeMetric) ??
    PRODUCTIVITY_METRICS[0];

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

  // All sessions grouped by truncated hour (for raw input sums in tooltip)
  const allHourGroups = new Map<string, TimelineSession[]>();
  for (const s of sessions) {
    const d = new Date(s.startTime);
    d.setMinutes(0, 0, 0);
    const key = d.toISOString();
    if (!allHourGroups.has(key)) allHourGroups.set(key, []);
    allHourGroups.get(key)!.push(s);
  }

  // Only sessions where the active metric can be computed (non-null)
  const hourGroups = new Map<string, TimelineSession[]>();
  for (const s of sessions) {
    if (computeProductivityValue(s, activeMetric) === null) continue;
    const d = new Date(s.startTime);
    d.setMinutes(0, 0, 0);
    const key = d.toISOString();
    if (!hourGroups.has(key)) hourGroups.set(key, []);
    hourGroups.get(key)!.push(s);
  }
  const allHours = Array.from(hourGroups.keys()).sort();

  const groupKeys =
    groupBy !== 'none'
      ? Array.from(new Set(sessions.map((s) => s.group ?? 'unknown'))).sort()
      : [];
  const colorScale = d3
    .scaleOrdinal<string>()
    .domain(groupKeys)
    .range(d3.schemeTableau10);

  // Compute maxY for Y scale
  let maxY = 0;
  for (const hourSessions of hourGroups.values()) {
    let hourTotal: number;
    if (groupBy === 'none') {
      hourTotal = hourSessions.reduce((sum, s) => {
        const v = computeProductivityValue(s, activeMetric);
        return sum + (v ?? 0);
      }, 0);
    } else {
      // Sum of per-group averages
      const groupMap = new Map<string, number[]>();
      for (const s of hourSessions) {
        const g = s.group ?? 'unknown';
        const v = computeProductivityValue(s, activeMetric);
        if (v !== null) {
          if (!groupMap.has(g)) groupMap.set(g, []);
          groupMap.get(g)!.push(v);
        }
      }
      hourTotal = 0;
      for (const vals of groupMap.values()) {
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        hourTotal += avg;
      }
    }
    if (hourTotal > maxY) maxY = hourTotal;
  }
  if (maxY === 0) maxY = 1;

  // Max single-session computed value (for zone coloring thresholds)
  let maxSessionValue = 0;
  for (const s of sessions) {
    const v = computeProductivityValue(s, activeMetric);
    if (v !== null && v > maxSessionValue) maxSessionValue = v;
  }
  if (maxSessionValue === 0) maxSessionValue = 1;

  const xScale = d3
    .scaleBand(allHours, [LEFT_MARGIN, width - RIGHT_MARGIN])
    .padding(0.2);

  const yScale = d3
    .scaleLinear()
    .domain([0, maxY])
    .range([CHART_HEIGHT - BOTTOM_MARGIN, TOP_MARGIN]);

  const maxLabels = 24;
  const culledHours: string[] =
    allHours.length <= maxLabels
      ? allHours
      : allHours.filter(
          (_, i) => i % Math.ceil(allHours.length / maxLabels) === 0,
        );

  useEffect(() => {
    if (!xAxisRef.current) return;
    d3.select(xAxisRef.current)
      .call(
        d3
          .axisBottom(xScale)
          .tickValues(culledHours)
          .tickFormat((d) => {
            const date = new Date(String(d));
            const h = date.getHours();
            if (h === 0) {
              return date.toLocaleDateString([], {
                month: 'short',
                day: 'numeric',
              });
            }
            return `${h}:${String(date.getMinutes()).padStart(2, '0')}`;
          })
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
          .ticks(5)
          .tickFormat((d) => {
            const v = d as number;
            if (activeMetric === 'linesPerHour') {
              if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
              if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
              return `${Math.round(v)}`;
            }
            // costPerHour / costPerLine
            if (v >= 1) return `$${v.toFixed(2)}`;
            if (v >= 0.01) return `$${v.toFixed(2)}`;
            if (v >= 0.0001) return `$${v.toFixed(4)}`;
            return `$${v.toFixed(6)}`;
          })
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

  return (
    <div ref={containerRef} className="relative w-full">
      {hourGroups.size === 0 && (
        <div
          className="flex items-center justify-center text-sm text-muted-foreground"
          style={{ height: CHART_HEIGHT }}
        >
          no sessions with productivity data
        </div>
      )}

      <svg
        width={width}
        height={hourGroups.size === 0 ? 0 : CHART_HEIGHT}
        style={{ display: 'block', overflow: 'visible' }}
      >
        <g ref={gridRef} transform={`translate(${LEFT_MARGIN}, 0)`} />
        {allHours.map((hourKey) => {
          const hourSessions = hourGroups.get(hourKey) ?? [];
          const barX = xScale(hourKey) ?? 0;
          const barW = xScale.bandwidth();

          const segments: {
            key: string;
            segY: number;
            segH: number;
            fill: string;
          }[] = [];
          let currentY = yScale(0);

          if (groupBy !== 'none') {
            const groupMap = new Map<string, number[]>();
            for (const s of hourSessions) {
              const g = s.group ?? 'unknown';
              const v = computeProductivityValue(s, activeMetric);
              if (v !== null) {
                if (!groupMap.has(g)) groupMap.set(g, []);
                groupMap.get(g)!.push(v);
              }
            }
            const groupAverages = Array.from(groupMap.entries())
              .map(([g, vals]) => ({
                g,
                avg: vals.reduce((a, b) => a + b, 0) / vals.length,
              }))
              .sort((a, b) => b.avg - a.avg);

            for (const { g, avg } of groupAverages) {
              const segH = Math.max(1, yScale(0) - yScale(avg));
              const segY = currentY - segH;
              currentY = segY - SEGMENT_GAP;
              segments.push({ key: g, segY, segH, fill: colorScale(g) });
            }
          } else {
            const sorted = [...hourSessions].sort((a, b) => {
              const va = computeProductivityValue(a, activeMetric) ?? 0;
              const vb = computeProductivityValue(b, activeMetric) ?? 0;
              return vb - va;
            });
            for (const session of sorted) {
              const value = computeProductivityValue(session, activeMetric);
              if (value === null) continue;
              const segH = Math.max(1, yScale(0) - yScale(value));
              const segY = currentY - segH;
              currentY = segY - SEGMENT_GAP;
              segments.push({
                key: session.sessionId,
                segY,
                segH,
                fill: zoneColor(value, maxSessionValue),
              });
            }
          }

          const hourDate = new Date(hourKey);
          const hourLabel = hourDate.toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          });

          // Compute the bucket value for the tooltip header
          let bucketValue = 0;
          if (groupBy === 'none') {
            bucketValue = hourSessions.reduce((sum, s) => {
              const v = computeProductivityValue(s, activeMetric);
              return sum + (v ?? 0);
            }, 0);
          } else {
            const groupMap = new Map<string, number[]>();
            for (const s of hourSessions) {
              const g = s.group ?? 'unknown';
              const v = computeProductivityValue(s, activeMetric);
              if (v !== null) {
                if (!groupMap.has(g)) groupMap.set(g, []);
                groupMap.get(g)!.push(v);
              }
            }
            for (const vals of groupMap.values()) {
              bucketValue += vals.reduce((a, b) => a + b, 0) / vals.length;
            }
          }

          const allInHour = allHourGroups.get(hourKey) ?? [];

          return (
            <g
              key={hourKey}
              style={{ cursor: 'pointer' }}
              onMouseMove={(e) =>
                setTooltip({
                  x: e.clientX,
                  y: e.clientY,
                  hourLabel,
                  includedSessions: hourSessions,
                  allSessions: allInHour,
                  metric,
                  groupBy,
                  bucketValue,
                })
              }
              onMouseLeave={() => setTooltip(null)}
              onClick={() => {
                setTooltip(null);
                setModal({ hourLabel, sessions: hourSessions, metric });
              }}
            >
              {segments.map(({ key, segY, segH, fill }) => (
                <rect
                  key={key}
                  x={barX}
                  y={segY}
                  width={barW}
                  height={segH}
                  fill={fill}
                  opacity={0.85}
                  rx={2}
                />
              ))}
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

      {groupBy === 'none' ? (
        <ZoneLegend />
      ) : (
        <GroupLegend keys={groupKeys} colorScale={colorScale} />
      )}

      {tooltip && <HourTooltip {...tooltip} />}
      {modal && (
        <HourModal
          state={modal}
          onClose={() => setModal(null)}
          onSessionClick={onSessionClick}
        />
      )}
    </div>
  );
}
