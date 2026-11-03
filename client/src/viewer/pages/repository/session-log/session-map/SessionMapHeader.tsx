/**
 * Session Map header strip and control row (session-map DD-18, DD-22a): the LIVE / Replay badge,
 * the first prompt (one line, full text in `title`), the five `countersAt` counters, then the
 * Highlight and Order selects and the cost-zone legend.
 */
import { AlertTriangle } from 'lucide-react';
import { ZoneLegend } from '../../analytics/ChangeSurfaceChartParts';
import type {
  AgentOrder,
  HighlightMode,
  MapCounters,
} from './session-map-model';
import { formatElapsed, formatMapUsd } from './session-map-format';

export type SessionMapBadgeKind =
  | 'live'
  | 'live-paused'
  | 'live-idle'
  | 'replay';

export interface SessionMapHeaderProps {
  badge: SessionMapBadgeKind;
  /** The time position, for "LIVE · paused at HH:MM". */
  pausedAtLabel: string | null;
  firstPrompt: string | null;
  counters: MapCounters;
  /** A poll failed while a state is on screen ("update failed", polling continues). */
  updateFailed: boolean;
  highlight: HighlightMode;
  onHighlightChange: (mode: HighlightMode) => void;
  order: AgentOrder;
  onOrderChange: (order: AgentOrder) => void;
}

function badgeText(kind: SessionMapBadgeKind, pausedAt: string | null): string {
  switch (kind) {
    case 'live':
      return 'LIVE · following now';
    case 'live-paused':
      return `LIVE · paused at ${pausedAt ?? '–'}`;
    case 'live-idle':
      return 'LIVE · updates paused';
    case 'replay':
      return 'Replay · finished session';
  }
}

function badgeClass(kind: SessionMapBadgeKind): string {
  switch (kind) {
    case 'live':
      return 'border-green-300 bg-green-50 text-green-700';
    case 'live-paused':
      return 'border-amber-300 bg-amber-50 text-amber-700';
    case 'live-idle':
      return 'border-slate-300 bg-slate-50 text-slate-600';
    case 'replay':
      return 'border-blue-300 bg-blue-50 text-blue-700';
  }
}

function Counter({
  id,
  label,
  value,
  danger,
}: {
  id: string;
  label: string;
  value: string;
  danger?: boolean;
}) {
  return (
    <div
      data-testid={`session-map-counter-${id}`}
      className="flex flex-col rounded border bg-white px-3 py-1"
    >
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span
        className={`font-mono text-sm font-semibold ${danger ? 'text-red-600' : ''}`}
      >
        {value}
      </span>
    </div>
  );
}

function parseHighlight(v: string): HighlightMode {
  return v === 'top' || v === 'failed' ? v : 'none';
}

const SELECT_CLASS =
  'rounded border bg-white px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500';

export function SessionMapHeader({
  badge,
  pausedAtLabel,
  firstPrompt,
  counters,
  updateFailed,
  highlight,
  onHighlightChange,
  order,
  onOrderChange,
}: SessionMapHeaderProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <span
          data-testid="session-map-badge"
          className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${badgeClass(badge)}`}
        >
          {badgeText(badge, pausedAtLabel)}
        </span>
        {firstPrompt !== null && firstPrompt !== '' && (
          <span
            className="min-w-0 max-w-[48rem] flex-1 truncate text-muted-foreground"
            title={firstPrompt}
          >
            {firstPrompt}
          </span>
        )}
        {updateFailed && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-amber-700">
            <AlertTriangle className="h-3.5 w-3.5" />
            update failed
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-stretch gap-2">
        <Counter
          id="elapsed"
          label="Elapsed"
          value={formatElapsed(counters.elapsedMs)}
        />
        <Counter
          id="failed"
          label="Failed calls"
          value={String(counters.failed)}
          danger={counters.failed > 0}
        />
        <Counter id="calls" label="Calls" value={String(counters.calls)} />
        <Counter
          id="agents"
          label="Agents"
          value={`${counters.agentsStarted} / ${counters.agentsTotal}`}
        />
        <Counter
          id="cost"
          label="Cost"
          value={`${formatMapUsd(counters.costSoFar)} / ${formatMapUsd(counters.costTotal)}`}
        />
      </div>
      <div className="flex flex-wrap items-center gap-4 text-xs">
        <label className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Highlight</span>
          <select
            data-testid="session-map-highlight"
            className={SELECT_CLASS}
            value={highlight}
            onChange={(e) => onHighlightChange(parseHighlight(e.target.value))}
          >
            <option value="none">None</option>
            <option value="top">Top 5 by cost</option>
            <option value="failed">Agents with failed calls</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Order</span>
          <select
            data-testid="session-map-order"
            className={SELECT_CLASS}
            value={order}
            onChange={(e) =>
              onOrderChange(e.target.value === 'cost' ? 'cost' : 'start')
            }
          >
            <option value="start">By start</option>
            <option value="cost">By cost</option>
          </select>
        </label>
        <span className="flex items-center gap-1 text-muted-foreground">
          Cost bar vs. most expensive agent:
          <ZoneLegend />
        </span>
      </div>
    </div>
  );
}
