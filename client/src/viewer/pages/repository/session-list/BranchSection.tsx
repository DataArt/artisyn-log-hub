import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Loader2 } from 'lucide-react';
import type {
  BranchSummary,
  RepositorySession,
  SessionAttributionAttributeDef,
} from '../../../../models/repositories';
import { fetchRepositorySessions } from '../../../api';
import { cn } from '../../../lib/cn';
import {
  formatCost,
  formatDuration,
  formatLocalTimestamp,
} from '../../../lib/format';
import { DetailTooltip } from '../../../components/DetailTooltip';
import type { DetailRow } from '../../../components/DetailTooltip';
import {
  SessionItem,
  computeCostThresholds,
  filterVisibleSessions,
  hiddenUserBreakdown,
  type AttributeFilterSelection,
} from './session-list-helpers';
import { OtherUsersNotice } from './OtherUsersNotice';

interface BranchSectionProps {
  branch: BranchSummary['branch'];
  sessionCount: BranchSummary['sessionCount'];
  latestEndTime: BranchSummary['latestEndTime'];
  totalWorkTimeMs: BranchSummary['totalWorkTimeMs'];
  totalLinesChanged: BranchSummary['totalLinesChanged'];
  totalCost: BranchSummary['totalCost'];
  repoId: number;
  teamId?: number;
  isOpen: boolean;
  onToggle: () => void;
  selectedSession: RepositorySession | null;
  onSelect: (s: RepositorySession, viaAdvisorBadge?: boolean) => void;
  filterByUserEmail?: string;
  onShowAllUsers: () => void;
  hideHookSessions?: boolean;
  /** Mirrors `SessionListPanel`'s own attribute filter/chip state;
   * branch view fetches its own session list independently, so it must apply both itself
   * rather than inheriting `SessionListPanel`'s already-filtered `displayedSessions`. */
  attributeFilter?: AttributeFilterSelection | null;
  attributeDefs?: SessionAttributionAttributeDef[];
}

export function BranchSection({
  branch,
  sessionCount,
  latestEndTime,
  totalWorkTimeMs,
  totalLinesChanged,
  totalCost,
  repoId,
  teamId,
  isOpen,
  onToggle,
  selectedSession,
  onSelect,
  filterByUserEmail,
  onShowAllUsers,
  hideHookSessions,
  attributeFilter,
  attributeDefs,
}: BranchSectionProps) {
  const { data: rawSessions, isLoading } = useQuery({
    queryKey: ['repo-sessions-branch', repoId, teamId, branch],
    queryFn: () => fetchRepositorySessions(repoId, teamId, branch),
    enabled: isOpen,
    staleTime: 30_000,
  });

  const sessions = useMemo(
    () =>
      filterVisibleSessions(rawSessions, {
        filterByUserEmail,
        hideHookSessions,
        attributeFilter,
      }),
    [rawSessions, filterByUserEmail, hideHookSessions, attributeFilter],
  );

  const thresholds = useMemo(
    () => computeCostThresholds(sessions ?? []),
    [sessions],
  );

  // `sessionCount` comes from the branch summary endpoint, which is not user-filtered, while the
  // rows below are. Surface both instead of showing a count the list then contradicts. Only
  // possible once expanded — a collapsed section has not fetched its sessions yet, so it can show
  // nothing but the true total.
  const isCountFiltered =
    isOpen && !isLoading && sessions.length !== sessionCount;

  // Branch view is the default and never fetches the repo-wide session list (see
  // useRepositoryData.ts), so the panel-level notice cannot cover it — each expanded branch
  // reports its own hidden rows from the list it already fetched.
  const hiddenUsers = useMemo(
    () =>
      hiddenUserBreakdown(rawSessions, {
        filterByUserEmail,
        hideHookSessions,
        attributeFilter,
      }),
    [rawSessions, filterByUserEmail, hideHookSessions, attributeFilter],
  );

  const tooltipRows: DetailRow[] = [
    { label: 'Branch', value: branch ?? '(no branch)' },
    { label: 'Sessions', value: String(sessionCount) },
    ...(isCountFiltered
      ? [{ label: 'Shown', value: `${sessions.length} of ${sessionCount}` }]
      : []),
    { label: 'Work time', value: formatDuration(totalWorkTimeMs) },
    { label: 'Lines changed', value: String(totalLinesChanged) },
    ...(totalCost != null
      ? [{ label: 'Total cost', value: formatCost(totalCost) }]
      : []),
  ];

  return (
    <div className="border-b border-border">
      <DetailTooltip rows={tooltipRows}>
        <button
          className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-accent/50 transition-colors"
          onClick={onToggle}
        >
          <ChevronRight
            className={cn(
              'mt-0.5 h-4 w-4 shrink-0 transition-transform',
              isOpen && 'rotate-90',
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="flex-1 truncate font-mono text-sm font-medium">
                {branch ?? '(no branch)'}
              </span>
              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {isCountFiltered
                  ? `${sessions.length}/${sessionCount}`
                  : sessionCount}
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
              <span>{formatLocalTimestamp(latestEndTime)}</span>
              <span>·</span>
              <span>{formatDuration(totalWorkTimeMs)}</span>
              {totalCost != null && (
                <>
                  <span>·</span>
                  <span>{formatCost(totalCost)}</span>
                </>
              )}
            </div>
          </div>
        </button>
      </DetailTooltip>

      {isOpen && !isLoading && (
        <OtherUsersNotice hidden={hiddenUsers} onShowAll={onShowAllUsers} />
      )}

      {isOpen &&
        (isLoading ? (
          <div className="flex items-center justify-center py-3">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          sessions?.map((session) => (
            <SessionItem
              key={session.sessionId}
              session={session}
              selected={selectedSession?.sessionId === session.sessionId}
              onSelect={onSelect}
              thresholds={thresholds}
              attributeDefs={attributeDefs}
            />
          ))
        ))}
    </div>
  );
}
