import { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import type { TimelineSession } from '../../../../models/repositories';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/ui/dialog';
import { ViewportPopover } from '../../../components/ViewportPopover';
import { PROMPT_HIDDEN_LABEL } from '../../../lib/access-mode-copy';

interface Props {
  sessions: TimelineSession[];
  startDate: string;
  endDate: string;
  groupBy: 'none' | 'branch' | 'user' | `attr:${string}`;
  onSessionClick: (sessionId: string) => void;
}

interface TooltipState {
  x: number;
  y: number;
  hourLabel: string;
  sessions: TimelineSession[];
  serverBreakdown: Record<string, number> | null;
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

const SERVER_COLORS: Record<string, string> = {
  playwright: '#8b5cf6',
  postgres: '#3b82f6',
  ide: '#10b981',
};
const FALLBACK_COLORS = ['#f59e0b', '#ef4444', '#06b6d4'];

function getServerColor(server: string, unknownServers: string[]): string {
  const fixed = SERVER_COLORS[server.toLowerCase()];
  if (fixed) return fixed;
  const idx = unknownServers.indexOf(server);
  return FALLBACK_COLORS[idx % FALLBACK_COLORS.length];
}

function collectUnknownServers(sessions: TimelineSession[]): string[] {
  const known = new Set(Object.keys(SERVER_COLORS).map((k) => k.toLowerCase()));
  const others = new Set<string>();
  for (const s of sessions) {
    for (const server of Object.keys(s.mcpCallsByServer)) {
      if (!known.has(server.toLowerCase())) others.add(server);
    }
  }
  return Array.from(others).sort();
}

function formatDuration(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  if (h > 0)
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
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
        <span className="font-semibold">{session.mcpCallsTotal} calls</span>
        <span className="text-muted-foreground">
          {formatDuration(session.workTimeMs)}
        </span>
        {session.gitBranch && (
          <span className="text-muted-foreground">{session.gitBranch}</span>
        )}
      </div>
    </div>
  );
}

function HourTooltip({
  x,
  y,
  hourLabel,
  sessions,
  serverBreakdown,
}: TooltipState) {
  const shown = sessions.slice(0, TOOLTIP_MAX);
  const extra = sessions.length - TOOLTIP_MAX;
  const total = sessions.reduce((s, sess) => s + sess.mcpCallsTotal, 0);

  return (
    <ViewportPopover x={x} y={y} offset={12} maxWidth={320}>
      <div className="text-xs font-semibold text-muted-foreground mb-1">
        {hourLabel}
      </div>
      <div className="text-xs font-semibold mb-2">{total} calls total</div>
      {serverBreakdown && Object.entries(serverBreakdown).length > 0 && (
        <div className="text-xs text-muted-foreground mb-2 space-y-0.5">
          {Object.entries(serverBreakdown)
            .sort((a, b) => b[1] - a[1])
            .map(([server, count]) => (
              <div key={server} className="flex justify-between gap-4">
                <span>{server}</span>
                <span className="font-mono">{count}</span>
              </div>
            ))}
        </div>
      )}
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

function ServerLegend({
  servers,
  unknownServers,
}: {
  servers: string[];
  unknownServers: string[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-4 mt-2 px-1 text-xs text-muted-foreground">
      {servers.map((server) => (
        <span key={server} className="flex items-center gap-1">
          <span
            className="inline-block w-3 h-3 rounded-sm opacity-85"
            style={{ backgroundColor: getServerColor(server, unknownServers) }}
          />
          {server}
        </span>
      ))}
    </div>
  );
}

export function McpInvocationsChart({
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

  const unknownServers = collectUnknownServers(sessions);

  const hourGroups = new Map<string, TimelineSession[]>();
  for (const s of sessions) {
    if (s.mcpCallsTotal <= 0) continue;
    const d = new Date(s.startTime);
    d.setMinutes(0, 0, 0);
    const key = d.toISOString();
    if (!hourGroups.has(key)) hourGroups.set(key, []);
    hourGroups.get(key)!.push(s);
  }
  const allHours = Array.from(hourGroups.keys()).sort();

  let maxY = 1;
  for (const sArr of hourGroups.values()) {
    const total = sArr.reduce((t, s) => t + s.mcpCallsTotal, 0);
    if (total > maxY) maxY = total;
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

  const allServersInData = Array.from(
    new Set(sessions.flatMap((s) => Object.keys(s.mcpCallsByServer))),
  ).sort((a, b) => {
    const fixed = Object.keys(SERVER_COLORS);
    const ai = fixed.indexOf(a.toLowerCase());
    const bi = fixed.indexOf(b.toLowerCase());
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

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
          .tickFormat((d) => String(Math.round(d as number)))
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
      <svg
        width={width}
        height={CHART_HEIGHT}
        style={{ display: 'block', overflow: 'visible' }}
      >
        <g ref={gridRef} transform={`translate(${LEFT_MARGIN}, 0)`} />
        {allHours.map((hourKey) => {
          const hourSessions = (hourGroups.get(hourKey) ?? []).sort(
            (a, b) => b.mcpCallsTotal - a.mcpCallsTotal,
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
              groupTotals.set(g, (groupTotals.get(g) ?? 0) + s.mcpCallsTotal);
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
            const serverTotals = new Map<string, number>();
            for (const s of hourSessions) {
              for (const [server, count] of Object.entries(
                s.mcpCallsByServer,
              )) {
                serverTotals.set(
                  server,
                  (serverTotals.get(server) ?? 0) + Number(count),
                );
              }
            }
            const sorted = Array.from(serverTotals.entries()).sort(
              (a, b) => b[1] - a[1],
            );
            for (const [server, count] of sorted) {
              const segH = Math.max(1, yScale(0) - yScale(count));
              const segY = currentY - segH;
              currentY = segY - SEGMENT_GAP;
              segments.push({
                key: server,
                segY,
                segH,
                fill: getServerColor(server, unknownServers),
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

          const serverBreakdown: Record<string, number> | null =
            groupBy === 'none'
              ? (() => {
                  const totals: Record<string, number> = {};
                  for (const s of hourSessions) {
                    for (const [server, count] of Object.entries(
                      s.mcpCallsByServer,
                    )) {
                      totals[server] = (totals[server] ?? 0) + Number(count);
                    }
                  }
                  return totals;
                })()
              : null;

          return (
            <g
              key={hourKey}
              style={{ cursor: groupBy === 'none' ? 'pointer' : 'default' }}
              onMouseMove={(e) =>
                setTooltip({
                  x: e.clientX,
                  y: e.clientY,
                  hourLabel,
                  sessions: hourSessions,
                  serverBreakdown,
                })
              }
              onMouseLeave={() => setTooltip(null)}
              onClick={() => {
                if (groupBy !== 'none') return;
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
          calls
        </text>
      </svg>

      {groupBy === 'none' ? (
        <ServerLegend
          servers={allServersInData}
          unknownServers={unknownServers}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-4 mt-2 px-1 text-xs text-muted-foreground">
          {groupKeys.map((key) => (
            <span key={key} className="flex items-center gap-1">
              <span
                className="inline-block w-3 h-3 rounded-sm opacity-85"
                style={{ backgroundColor: colorScale(key) }}
              />
              {key}
            </span>
          ))}
        </div>
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
