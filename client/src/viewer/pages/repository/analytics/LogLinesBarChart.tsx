import { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import type { TimelineSession } from '../../../../models/repositories';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/ui/dialog';
import { LOG_LINES_METRICS } from './metrics';
import { ViewportPopover } from '../../../components/ViewportPopover';
import { PROMPT_HIDDEN_LABEL } from '../../../lib/access-mode-copy';

const METRIC = LOG_LINES_METRICS[0];

interface Props {
  sessions: TimelineSession[];
  startDate: string;
  endDate: string;
  groupBy: 'none' | 'branch' | 'user' | `attr:${string}`;
  onSessionClick?: (sessionId: string) => void;
}

interface TooltipState {
  x: number;
  y: number;
  hourLabel: string;
  sessions: TimelineSession[];
}

interface ModalState {
  hourLabel: string;
  sessions: TimelineSession[];
}

const TOP_MARGIN = 16;
const BOTTOM_MARGIN = 48;
const LEFT_MARGIN = 64;
const RIGHT_MARGIN = 16;
const CHART_HEIGHT = 300;
const SEGMENT_GAP = 1;
const TOOLTIP_MAX = 3;

function zoneColor(value: number, maxY: number): string {
  if (maxY === 0) return '#3b82f6';
  const low = maxY * 0.25;
  const mid = maxY * 0.75;
  if (value <= low) return '#22c55e';
  if (value <= mid) return '#3b82f6';
  return '#f97316';
}

function SessionRow({
  session,
  className,
  onSessionClick,
}: {
  session: TimelineSession;
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
  const value = session.logLineCount ?? 0;

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
        {value > 0 && (
          <span className="font-semibold">
            {METRIC.format(value)} {METRIC.yLabel}
          </span>
        )}
        {session.gitBranch && (
          <span className="text-muted-foreground">{session.gitBranch}</span>
        )}
      </div>
    </div>
  );
}

function HourTooltip({ x, y, hourLabel, sessions }: TooltipState) {
  const shown = sessions.slice(0, TOOLTIP_MAX);
  const extra = sessions.length - TOOLTIP_MAX;

  return (
    <ViewportPopover x={x} y={y} offset={12} maxWidth={320}>
      <div className="text-xs font-semibold text-muted-foreground mb-2">
        {hourLabel}
      </div>
      {shown.map((session, i) => (
        <SessionRow
          key={session.sessionId}
          session={session}
          className={i > 0 ? 'border-t border-border pt-1.5 mt-1.5' : undefined}
        />
      ))}
      {extra > 0 && (
        <div className="text-xs text-muted-foreground mt-1.5 pt-1.5 border-t border-border">
          +{extra} more · click to see all
        </div>
      )}
    </ViewportPopover>
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

export function LogLinesBarChart({
  sessions,
  startDate: _startDate,
  endDate: _endDate,
  groupBy,
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

  const hourGroups = new Map<string, TimelineSession[]>();
  for (const s of sessions) {
    const value = s.logLineCount ?? 0;
    if (value <= 0) continue;
    const d = new Date(s.startTime);
    d.setMinutes(0, 0, 0);
    const key = d.toISOString();
    if (!hourGroups.has(key)) hourGroups.set(key, []);
    hourGroups.get(key)!.push(s);
  }
  const allHours = Array.from(hourGroups.keys()).sort();

  let maxY = 1;
  for (const sArr of hourGroups.values()) {
    const total = sArr.reduce((t, s) => t + (s.logLineCount ?? 0), 0);
    if (total > maxY) maxY = total;
  }

  let maxSessionValue = 1;
  for (const s of sessions) {
    const v = s.logLineCount ?? 0;
    if (v > maxSessionValue) maxSessionValue = v;
  }

  const xScale = d3
    .scaleBand(allHours, [LEFT_MARGIN, width - RIGHT_MARGIN])
    .padding(0.2);
  const yScale = d3
    .scaleLinear()
    .domain([0, maxY])
    .range([CHART_HEIGHT - BOTTOM_MARGIN, TOP_MARGIN]);

  const groupKeys =
    groupBy !== 'none'
      ? Array.from(new Set(sessions.map((s) => s.group ?? 'unknown'))).sort()
      : [];
  const colorScale = d3
    .scaleOrdinal<string>()
    .domain(groupKeys)
    .range(d3.schemeTableau10);

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
            if (h === 0)
              return date.toLocaleDateString([], {
                month: 'short',
                day: 'numeric',
              });
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
            if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
            if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
            return `${v}`;
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

  const hasData = allHours.length > 0;

  return (
    <div ref={containerRef} className="relative w-full">
      {!hasData ? (
        <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
          No log activity in this range
        </div>
      ) : (
        <>
          <svg
            width={width}
            height={CHART_HEIGHT}
            style={{ display: 'block', overflow: 'visible' }}
          >
            <g ref={gridRef} transform={`translate(${LEFT_MARGIN}, 0)`} />
            {allHours.map((hourKey) => {
              const hourSessions = (hourGroups.get(hourKey) ?? []).sort(
                (a, b) => (b.logLineCount ?? 0) - (a.logLineCount ?? 0),
              );
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
                const groupTotals = new Map<string, number>();
                for (const s of hourSessions) {
                  const g = s.group ?? 'unknown';
                  groupTotals.set(
                    g,
                    (groupTotals.get(g) ?? 0) + (s.logLineCount ?? 0),
                  );
                }
                const sorted = Array.from(groupTotals.entries()).sort(
                  (a, b) => b[1] - a[1],
                );
                for (const [g, total] of sorted) {
                  const segH = Math.max(1, yScale(0) - yScale(total));
                  const segY = currentY - segH;
                  currentY = segY - SEGMENT_GAP;
                  segments.push({ key: g, segY, segH, fill: colorScale(g) });
                }
              } else {
                for (const session of hourSessions) {
                  const value = session.logLineCount ?? 0;
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

              return (
                <g
                  key={hourKey}
                  style={{ cursor: 'pointer' }}
                  onMouseMove={(e) =>
                    setTooltip({
                      x: e.clientX,
                      y: e.clientY,
                      hourLabel,
                      sessions: hourSessions,
                    })
                  }
                  onMouseLeave={() => setTooltip(null)}
                  onClick={() => {
                    setTooltip(null);
                    setModal({ hourLabel, sessions: hourSessions });
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
              {METRIC.yLabel}
            </text>
          </svg>
          {groupBy === 'none' ? (
            <ZoneLegend />
          ) : (
            <GroupLegend keys={groupKeys} colorScale={colorScale} />
          )}
        </>
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
