import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type {
  RepositorySession,
  SessionAttributionAttributeDef,
} from '../../../../models/repositories';
import { cn } from '../../../lib/cn';
import {
  formatCost,
  formatDuration,
  formatLocalTimestamp,
} from '../../../lib/format';
import { useOpenOnSelection } from './useOpenOnSelection';
import { SessionItem, computeCostThresholds } from './session-list-helpers';

interface TagSectionProps {
  /** The grouped tag key (FR-6) — its values are shown as a chip on each row. */
  tagKey: string;
  label: string;
  sessions: RepositorySession[];
  isInitiallyOpen: boolean;
  selectedSession: RepositorySession | null;
  onSelect: (s: RepositorySession, viaAdvisorBadge?: boolean) => void;
  attributeDefs?: SessionAttributionAttributeDef[];
}

/**
 * One "By tag: <key>" group of the session list (2026-11-24 otel-session-tags, FR-6): a value of
 * the key (or "(untagged)") with its session count, latest end, summed duration and cost. A
 * session with several values of the key is counted in each of their groups (fan-out).
 */
export function TagSection({
  tagKey,
  label,
  sessions,
  isInitiallyOpen,
  selectedSession,
  onSelect,
  attributeDefs,
}: TagSectionProps) {
  const [isOpen, setIsOpen] = useState(isInitiallyOpen);
  useOpenOnSelection(sessions, selectedSession, setIsOpen);

  const thresholds = useMemo(() => computeCostThresholds(sessions), [sessions]);

  const stats = useMemo(() => {
    let latest: string | null = null;
    let durationMs = 0;
    let cost = 0;
    let hasCost = false;
    for (const s of sessions) {
      if (latest === null || s.endTime > latest) latest = s.endTime;
      const ms = Date.parse(s.endTime) - Date.parse(s.startTime);
      if (Number.isFinite(ms) && ms > 0) durationMs += ms;
      const c = s.costBreakdown.calculatedCost ?? s.totalCost;
      if (c != null) {
        cost += c;
        hasCost = true;
      }
    }
    return { latest, durationMs, cost: hasCost ? cost : null };
  }, [sessions]);

  return (
    <div className="border-b border-border" data-testid="session-tag-group">
      <button
        className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-accent/50 transition-colors"
        onClick={() => setIsOpen((prev) => !prev)}
        title={label}
      >
        <ChevronRight
          className={cn(
            'mt-0.5 h-4 w-4 shrink-0 transition-transform',
            isOpen && 'rotate-90',
          )}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-mono text-sm font-medium">
            {label}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {formatLocalTimestamp(stats.latest)} ·{' '}
            {formatDuration(stats.durationMs)}
            {stats.cost !== null && ` · ${formatCost(stats.cost)}`}
          </span>
        </span>
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {sessions.length}
        </span>
      </button>

      {isOpen &&
        sessions.map((session) => (
          <SessionItem
            key={session.sessionId}
            session={session}
            selected={selectedSession?.sessionId === session.sessionId}
            onSelect={onSelect}
            thresholds={thresholds}
            attributeDefs={attributeDefs}
            tagChipKeys={[tagKey]}
          />
        ))}
    </div>
  );
}
