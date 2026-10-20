import { useEffect, useMemo, useRef, useState } from 'react';
import type { TimelineSession } from '../../../../models/repositories';
import {
  type FilesMetricKey,
  type VisionMetricKey,
  type ProductivityMetricKey,
  FILES_METRICS,
  VISION_METRICS,
  PRODUCTIVITY_METRICS,
  buildFilesMetrics,
  computeProductivityValue,
} from './metrics';
import { SessionTooltip } from './SessionTooltip';
import { cacheReadRatio, formatCacheReadRatio } from '@/lib/format';
import { aggregateCacheRatio } from './cache-ratio-aggregate';
import { HorizontalCacheRatioRows } from './HorizontalCacheRatioRows';
import { CacheRatioScopeLegend } from './CacheRatioScopeSummary';
import {
  HorizontalSessionModal,
  type ModalState,
} from './HorizontalSessionModal';
import { ViewportPopover } from '../../../components/ViewportPopover';
import { PROMPT_HIDDEN_LABEL } from '../../../lib/access-mode-copy';

interface Props {
  sessions: TimelineSession[];
  groupBy: 'none' | 'branch' | 'user' | `attr:${string}`;
  view:
    | 'work-time'
    | 'cost'
    | 'files'
    | 'vision'
    | 'mcp'
    | 'productivity'
    | 'log-lines'
    | 'cache-read-ratio';
  filesMetric: FilesMetricKey;
  visionMetric: VisionMetricKey;
  productivityMetric: ProductivityMetricKey;
  onSessionClick: (sessionId: string) => void;
}

export interface BarEntry {
  key: string;
  label: string;
  value: number;
  sessions: TimelineSession[];
}

interface TooltipState {
  x: number;
  y: number;
  entry: BarEntry;
}

const LABEL_COL_WIDTH = 144;
const VALUE_COL_WIDTH = 80;
const TOOLTIP_MAX = 3;

function resolveFilesMetricValue(
  session: TimelineSession,
  key: FilesMetricKey,
): number {
  if (key === 'filesEditedWritten') return session.filesEditedWritten ?? 0;
  if (key === 'linesChanged') return session.linesChanged ?? 0;
  const catMatch = /^cat:(.+):(files|bytes)$/.exec(key);
  if (catMatch) {
    const [, cat, field] = catMatch;
    return (
      session.fileStatsByCategory?.[cat]?.[field as 'files' | 'bytes'] ?? 0
    );
  }
  return 0;
}

export function getMetricValue(
  session: TimelineSession,
  view: Props['view'],
  filesMetric: FilesMetricKey,
  visionMetric: VisionMetricKey,
  productivityMetric: ProductivityMetricKey,
): number {
  switch (view) {
    case 'work-time':
      return session.workTimeMs ?? 0;
    case 'cost':
      return session.totalCost ?? 0;
    case 'files':
      return resolveFilesMetricValue(session, filesMetric);
    case 'vision':
      return session[visionMetric] ?? 0;
    case 'mcp':
      return session.mcpCallsTotal ?? 0;
    case 'productivity':
      return computeProductivityValue(session, productivityMetric) ?? 0;
    case 'log-lines':
      return session.logLineCount ?? 0;
    case 'cache-read-ratio':
      // Root-only ratio as a 0–1 fraction; `NaN` marks an undefined ratio (zero
      // denominator) so `formatBarValue` can render `n/a` rather than `0.0%`.
      return (
        cacheReadRatio(
          session.cacheReadTokens ?? 0,
          session.cacheWriteTokens ?? 0,
        ) ?? Number.NaN
      );
  }
}

export function formatBarValue(
  value: number,
  view: Props['view'],
  filesMetric: FilesMetricKey,
  visionMetric: VisionMetricKey,
  productivityMetric: ProductivityMetricKey,
  allFilesMetrics = FILES_METRICS,
): string {
  switch (view) {
    case 'work-time': {
      const totalSec = Math.floor(value / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      if (totalSec >= 3600) {
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      }
      return `${m}:${String(s).padStart(2, '0')}`;
    }
    case 'cost':
      if (value < 0.01) return `$${value.toFixed(4)}`;
      return `$${value.toFixed(2)}`;
    case 'files': {
      const def = allFilesMetrics.find((m) => m.key === filesMetric);
      return def ? def.format(value) : value.toLocaleString();
    }
    case 'vision':
      return VISION_METRICS.find((m) => m.key === visionMetric)!.format(value);
    case 'mcp':
      return `${Math.round(value)} calls`;
    case 'productivity':
      return PRODUCTIVITY_METRICS.find(
        (m) => m.key === productivityMetric,
      )!.format(value);
    case 'log-lines':
      return `${Math.round(value).toLocaleString()} lines`;
    case 'cache-read-ratio':
      // `value` is a 0–1 fraction; a non-finite value means "no ratio".
      return formatCacheReadRatio(Number.isFinite(value) ? value : null);
  }
}

export function zoneColor(value: number, maxValue: number): string {
  if (maxValue === 0) return '#3b82f6';
  if (value < maxValue * 0.25) return '#22c55e';
  if (value <= maxValue * 0.75) return '#3b82f6';
  return '#f97316';
}

/** "Jan 15, 10:00" — the row label used when sessions are not grouped. */
function formatSessionLabel(session: TimelineSession): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(session.startTime));
}

/** Groups sessions by `session.group` (`''` when unset), preserving encounter order. */
function groupSessions(
  sessions: TimelineSession[],
): Map<string, TimelineSession[]> {
  const grouped = new Map<string, TimelineSession[]>();
  for (const s of sessions) {
    const groupKey = s.group ?? '';
    const existing = grouped.get(groupKey);
    if (existing) existing.push(s);
    else grouped.set(groupKey, [s]);
  }
  return grouped;
}

export function buildEntries(
  sessions: TimelineSession[],
  groupBy: Props['groupBy'],
  view: Props['view'],
  filesMetric: FilesMetricKey,
  visionMetric: VisionMetricKey,
  productivityMetric: ProductivityMetricKey,
): BarEntry[] {
  if (view === 'cache-read-ratio') {
    // Ratio-of-sums: sum each entry's cache-read and cache-write
    // tokens first, then divide once — never a mean of the sessions' own ratios.
    // `value` carries the root-only ratio as a 0–1 fraction and drives the sort;
    // `NaN` means "undefined ratio" and always sorts last.
    const toEntry = (
      key: string,
      label: string,
      entrySessions: TimelineSession[],
    ): BarEntry => ({
      key,
      label,
      value: aggregateCacheRatio(entrySessions).root.ratio ?? Number.NaN,
      sessions: entrySessions,
    });

    const entries: BarEntry[] =
      groupBy === 'none'
        ? sessions.map((s) => toEntry(s.sessionId, formatSessionLabel(s), [s]))
        : Array.from(groupSessions(sessions).entries()).map(
            ([groupKey, groupedSessions]) =>
              toEntry(
                groupKey || 'no data',
                groupKey || 'no data',
                groupedSessions,
              ),
          );

    const sortKey = (v: number) => (Number.isFinite(v) ? v : -1);
    return entries.sort((a, b) => sortKey(b.value) - sortKey(a.value));
  }

  if (view === 'productivity') {
    if (groupBy === 'none') {
      const entries: BarEntry[] = sessions
        .map((s) => {
          const raw = computeProductivityValue(s, productivityMetric);
          if (raw === null) return null;
          return {
            key: s.sessionId,
            label: formatSessionLabel(s),
            value: raw,
            sessions: [s],
          };
        })
        .filter((e): e is BarEntry => e !== null);
      return entries.sort((a, b) => b.value - a.value);
    }

    const entries: BarEntry[] = [];
    for (const [groupKey, groupedSessions] of groupSessions(
      sessions,
    ).entries()) {
      const validValues = groupedSessions
        .map((s) => computeProductivityValue(s, productivityMetric))
        .filter((v): v is number => v !== null);
      if (validValues.length === 0) continue;
      const avg =
        validValues.reduce((sum, v) => sum + v, 0) / validValues.length;
      entries.push({
        key: groupKey || 'no data',
        label: groupKey || 'no data',
        value: avg,
        sessions: groupedSessions,
      });
    }
    return entries.sort((a, b) => b.value - a.value);
  }

  if (groupBy === 'none') {
    const entries: BarEntry[] = sessions.map((s) => {
      return {
        key: s.sessionId,
        label: formatSessionLabel(s),
        value: getMetricValue(
          s,
          view,
          filesMetric,
          visionMetric,
          productivityMetric,
        ),
        sessions: [s],
      };
    });
    return entries.sort((a, b) => b.value - a.value);
  }

  const entries: BarEntry[] = Array.from(groupSessions(sessions).entries()).map(
    ([groupKey, groupedSessions]) => ({
      key: groupKey || 'no data',
      label: groupKey || 'no data',
      value: groupedSessions.reduce(
        (sum, s) =>
          sum +
          getMetricValue(
            s,
            view,
            filesMetric,
            visionMetric,
            productivityMetric,
          ),
        0,
      ),
      sessions: groupedSessions,
    }),
  );
  return entries.sort((a, b) => b.value - a.value);
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

function GroupTooltip({
  x,
  y,
  entry,
}: {
  x: number;
  y: number;
  entry: BarEntry;
}) {
  const shown = entry.sessions.slice(0, TOOLTIP_MAX);
  const extra = entry.sessions.length - TOOLTIP_MAX;

  return (
    <ViewportPopover x={x} y={y} offset={12} maxWidth={320}>
      <div className="text-xs font-semibold text-muted-foreground mb-2">
        {entry.label}
      </div>
      {shown.map((session, i) => {
        const start = new Date(session.startTime);
        const startStr = start.toLocaleString([], {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
        const prompt = session.firstPrompt ?? PROMPT_HIDDEN_LABEL;
        const preview = prompt.length > 50 ? prompt.slice(0, 50) + '…' : prompt;

        return (
          <div
            key={session.sessionId}
            className={
              i > 0 ? 'border-t border-border pt-1.5 mt-1.5' : undefined
            }
          >
            <div className="text-xs text-muted-foreground">{startStr}</div>
            {preview && (
              <div className="text-xs font-medium break-words mt-0.5">
                {preview}
              </div>
            )}
          </div>
        );
      })}
      {extra > 0 && (
        <div className="text-xs text-muted-foreground mt-1.5 pt-1.5 border-t border-border">
          +{extra} more
        </div>
      )}
    </ViewportPopover>
  );
}

export function HorizontalBarChart({
  sessions,
  groupBy,
  view,
  filesMetric,
  visionMetric,
  productivityMetric,
  onSessionClick,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);

  const categories = useMemo(() => {
    const catSet = new Set<string>();
    for (const s of sessions) {
      for (const cat of Object.keys(s.fileStatsByCategory ?? {})) {
        catSet.add(cat);
      }
    }
    return Array.from(catSet).sort();
  }, [sessions]);

  const filesMetrics = useMemo(
    () => buildFilesMetrics(categories),
    [categories],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setContainerWidth(w);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const barAreaWidth = Math.min(
    800,
    containerWidth - LABEL_COL_WIDTH - VALUE_COL_WIDTH,
  );

  const entries = buildEntries(
    sessions,
    groupBy,
    view,
    filesMetric,
    visionMetric,
    productivityMetric,
  );
  const maxValue =
    entries.length > 0 ? Math.max(...entries.map((e) => e.value)) : 0;

  function handleBarClick(entry: BarEntry) {
    setTooltip(null);
    setModal({ label: entry.label, sessions: entry.sessions });
  }

  return (
    <div ref={containerRef} className="flex flex-col h-full gap-2">
      {/* Bar list */}
      {entries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">no sessions</p>
        </div>
      ) : view === 'cache-read-ratio' ? (
        <HorizontalCacheRatioRows
          entries={entries}
          barAreaWidth={barAreaWidth}
          onEntryClick={handleBarClick}
          onEntryHover={(entry, x, y) => setTooltip({ x, y, entry })}
          onEntryLeave={() => setTooltip(null)}
        />
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto py-2 flex flex-col gap-2">
          {entries.map((entry) => {
            const barPx =
              maxValue === 0 ? 0 : (entry.value / maxValue) * barAreaWidth;
            const color =
              groupBy === 'none' ? zoneColor(entry.value, maxValue) : '#3b82f6';

            return (
              <div
                key={entry.key}
                data-testid="bar-row"
                className="flex items-center gap-3 cursor-pointer group"
                onClick={() => handleBarClick(entry)}
                onMouseMove={
                  groupBy === 'none'
                    ? (e) =>
                        setTooltip({
                          x: e.clientX,
                          y: e.clientY,
                          entry,
                        })
                    : (e) =>
                        setTooltip({
                          x: e.clientX,
                          y: e.clientY,
                          entry,
                        })
                }
                onMouseLeave={() => setTooltip(null)}
              >
                <div
                  className="w-36 shrink-0 truncate text-xs text-muted-foreground"
                  title={entry.label}
                >
                  {entry.label}
                </div>
                <div className="flex-1 max-w-[800px]">
                  <div
                    className="min-h-[16px] rounded-sm opacity-85 transition-opacity group-hover:opacity-100"
                    style={{
                      width: `${barPx}px`,
                      backgroundColor: color,
                      minHeight: '16px',
                    }}
                  />
                </div>
                <div
                  data-testid="bar-value"
                  className="w-20 shrink-0 text-right font-mono text-xs text-foreground"
                >
                  {formatBarValue(
                    entry.value,
                    view,
                    filesMetric,
                    visionMetric,
                    productivityMetric,
                    filesMetrics,
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Legend — the bounded cache-read ratio uses the scope legend instead of the
          zone-colour legend; other views keep the zone legend,
          and only when ungrouped. */}
      {entries.length > 0 &&
        (view === 'cache-read-ratio' ? (
          <CacheRatioScopeLegend />
        ) : groupBy === 'none' ? (
          <ZoneLegend />
        ) : null)}

      {/* Single-session tooltip */}
      {tooltip && groupBy === 'none' && tooltip.entry.sessions[0] && (
        <SessionTooltip
          session={tooltip.entry.sessions[0]}
          x={tooltip.x}
          y={tooltip.y}
        />
      )}

      {/* Grouped tooltip */}
      {tooltip && groupBy !== 'none' && (
        <GroupTooltip x={tooltip.x} y={tooltip.y} entry={tooltip.entry} />
      )}

      {/* Session list modal */}
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
