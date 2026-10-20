import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import type {
  BranchSummary,
  RepositorySession,
} from '../../../../models/repositories';
import { fetchRepositoryBranches, getRepoSettings } from '../../../api';
import { resolveSessionAttributionDefinitions } from '../../../lib/session-attribution-ui';
import {
  didRefreshJustFail,
  useSessionListRefreshing,
} from '../useSessionListRefresh';
import {
  SessionItem,
  computeCostThresholds,
  filterVisibleSessions,
  hiddenUserBreakdown,
  type AttributeFilterSelection,
} from './session-list-helpers';
import { OtherUsersNotice } from './OtherUsersNotice';
import { AttributeFilterPopover } from './AttributeFilterPopover';
import { BranchSection } from './BranchSection';
import { DateSection, groupSessionsByDate } from './DateSection';
import { UserSection, groupSessionsByUser } from './UserSection';

export type ViewMode = 'branch' | 'date' | 'user' | 'plain';

export interface SessionListPanelProps {
  sessions: RepositorySession[] | undefined;
  isLoading: boolean;
  error: Error | null;
  selectedSession: RepositorySession | null;
  onSelect: (s: RepositorySession, viaAdvisorBadge?: boolean) => void;
  repoId: number;
  teamId?: number;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  filterByUserEmail?: string;
  onShowAllUsers: () => void;
  hideHookSessions: boolean;
  isBranchOpen: (key: string, index: number) => boolean;
  onToggleBranch: (key: string, index: number) => void;
}

export function SessionListPanel({
  sessions,
  isLoading,
  error,
  selectedSession,
  onSelect,
  repoId,
  teamId,
  viewMode,
  onViewModeChange,
  filterByUserEmail,
  onShowAllUsers,
  hideHookSessions,
  isBranchOpen,
  onToggleBranch,
}: SessionListPanelProps) {
  const isRefreshing = useSessionListRefreshing(repoId, teamId);

  const {
    data: branches,
    isLoading: branchesLoading,
    isError: branchesError,
  } = useQuery({
    queryKey: ['repo-branches', repoId, teamId],
    queryFn: () => fetchRepositoryBranches(repoId, teamId),
    enabled: viewMode === 'branch',
  });

  // Shares its query key with RepositorySettings.tsx's own
  // `getRepoSettings()` fetch, so switching into this repo from the Settings tab (or vice
  // versa) never re-fetches. Resolved the same way that tab derives its own
  // `effectiveSessionAttribution`: a team's saved override wins,
  // otherwise the built-in defaults for a team repo, or nothing for a no-team repo.
  const { data: repoSettings } = useQuery({
    queryKey: ['repoSettings', repoId, teamId ?? null],
    queryFn: () => getRepoSettings(repoId, teamId),
  });
  const attributeDefs = useMemo(
    () => resolveSessionAttributionDefinitions(repoSettings),
    [repoSettings],
  );

  // Client-side only — filters the already-fetched `attribution` field embedded in
  // each session, mirroring `filterByUserEmail`/`hideHookSessions` above rather than
  // a server round-trip through `attr=`. Single active selection, same convention as the
  // existing single-value `filterByUserEmail` filter.
  const [attributeFilter, setAttributeFilter] =
    useState<AttributeFilterSelection | null>(null);

  const [refreshErrorMsg, setRefreshErrorMsg] = useState<string | null>(null);
  const prevErrorRef = useRef<unknown>(null);
  const prevBranchesErrorRef = useRef<unknown>(null);

  useEffect(() => {
    const hasSessionsData = Boolean(sessions && sessions.length > 0);
    if (didRefreshJustFail(prevErrorRef.current, error, hasSessionsData)) {
      setRefreshErrorMsg('Refresh failed — showing previous results.');
      setTimeout(() => setRefreshErrorMsg(null), 3000);
    }
    prevErrorRef.current = error;

    const hasBranchesData = Boolean(branches && branches.length > 0);
    if (
      didRefreshJustFail(
        prevBranchesErrorRef.current,
        branchesError,
        hasBranchesData,
      )
    ) {
      setRefreshErrorMsg('Refresh failed — showing previous results.');
      setTimeout(() => setRefreshErrorMsg(null), 3000);
    }
    prevBranchesErrorRef.current = branchesError;
  }, [error, sessions, branchesError, branches]);

  // For plain mode, filter by user on personal repos; also hide hook-service sessions when
  // toggled, and narrow to the active attribute-filter selection when set.
  const displayedSessions = useMemo(
    () =>
      filterVisibleSessions(sessions, {
        filterByUserEmail,
        hideHookSessions,
        attributeFilter,
      }),
    [sessions, filterByUserEmail, hideHookSessions, attributeFilter],
  );

  const thresholds = useMemo(
    () => computeCostThresholds(displayedSessions ?? []),
    [displayedSessions],
  );

  const dateGroups = useMemo(
    () =>
      viewMode === 'date' && displayedSessions
        ? groupSessionsByDate(displayedSessions)
        : [],
    [viewMode, displayedSessions],
  );

  // "By user" exists precisely to show every uploader, so it ignores the email filter by design —
  // it still honours the hook-service toggle and the attribute filter, which the other modes
  // apply too.
  const userGroups = useMemo(
    () =>
      viewMode === 'user' && sessions
        ? groupSessionsByUser(
            filterVisibleSessions(sessions, {
              hideHookSessions,
              attributeFilter,
            }),
          )
        : [],
    [viewMode, sessions, hideHookSessions, attributeFilter],
  );

  // What the "my sessions only" default is currently withholding, so the list can say so rather
  // than silently dropping rows. Empty in a team view (no email filter) and whenever the owner is
  // the only uploader.
  //
  // Two modes are excluded, for opposite reasons:
  //   'branch' does not load the repo-wide list at all (`sessions` is only fetched for the other
  //     modes, or when a session is deep-linked), so each BranchSection renders its own notice
  //     from the branch list it fetched. Without this guard a deep-linked session in branch view
  //     would populate `sessions` and stack a second, panel-level notice on top of it.
  //   'user' already shows every uploader, so nothing is hidden left to announce.
  const hiddenUsers = useMemo(
    () =>
      viewMode === 'branch' || viewMode === 'user'
        ? []
        : hiddenUserBreakdown(sessions, {
            filterByUserEmail,
            hideHookSessions,
            attributeFilter,
          }),
    [viewMode, sessions, filterByUserEmail, hideHookSessions, attributeFilter],
  );

  function handleModeChange(v: string) {
    if (v === 'branch' || v === 'date' || v === 'user' || v === 'plain') {
      onViewModeChange(v);
    }
  }

  const loadingIndicator = (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4">
      <Loader2 className="animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">Loading session list…</p>
    </div>
  );

  return (
    <>
      <div className="shrink-0 border-b border-border px-2 py-1.5 flex flex-col gap-1.5">
        <select
          value={viewMode}
          onChange={(e) => handleModeChange(e.target.value)}
          className="w-full rounded border border-border bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="branch">By branch</option>
          <option value="date">By date</option>
          <option value="user">By user</option>
          <option value="plain">Plain list</option>
        </select>
        {attributeDefs.length > 0 && (
          <AttributeFilterPopover
            repoId={repoId}
            teamId={teamId}
            definitions={attributeDefs}
            value={attributeFilter}
            onChange={setAttributeFilter}
          />
        )}
      </div>

      <OtherUsersNotice hidden={hiddenUsers} onShowAll={onShowAllUsers} />

      {isRefreshing && (
        <div className="flex items-center gap-2 border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs text-indigo-700">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Refreshing session list…</span>
        </div>
      )}

      {viewMode === 'branch' ? (
        <div className="flex flex-1 flex-col overflow-y-auto">
          {branches && branches.length > 0 ? (
            branches.map((b: BranchSummary, index: number) => {
              const key = b.branch ?? '__no_branch__';
              return (
                <BranchSection
                  key={key}
                  branch={b.branch}
                  sessionCount={b.sessionCount}
                  latestEndTime={b.latestEndTime}
                  totalWorkTimeMs={b.totalWorkTimeMs}
                  totalLinesChanged={b.totalLinesChanged}
                  totalCost={b.totalCost}
                  repoId={repoId}
                  teamId={teamId}
                  isOpen={isBranchOpen(key, index)}
                  onToggle={() => onToggleBranch(key, index)}
                  selectedSession={selectedSession}
                  onSelect={onSelect}
                  filterByUserEmail={filterByUserEmail}
                  onShowAllUsers={onShowAllUsers}
                  hideHookSessions={hideHookSessions}
                  attributeFilter={attributeFilter}
                  attributeDefs={attributeDefs}
                />
              );
            })
          ) : branchesLoading ? (
            loadingIndicator
          ) : branchesError ? (
            <p className="p-4 text-sm text-muted-foreground">
              Failed to load branches
            </p>
          ) : (
            <p className="p-4 text-sm text-muted-foreground">
              No sessions found for this repository
            </p>
          )}
        </div>
      ) : viewMode === 'date' ? (
        <div className="flex flex-1 flex-col overflow-y-auto">
          {dateGroups.length > 0 ? (
            dateGroups.map(({ dateKey, sessions: group }, index) => (
              <DateSection
                key={dateKey}
                dateKey={dateKey}
                sessions={group}
                isInitiallyOpen={index === 0}
                selectedSession={selectedSession}
                onSelect={onSelect}
                attributeDefs={attributeDefs}
              />
            ))
          ) : isLoading ? (
            loadingIndicator
          ) : error ? (
            <p className="p-4 text-sm text-muted-foreground">
              {error.message || 'Failed to load sessions'}
            </p>
          ) : (
            <p className="p-4 text-sm text-muted-foreground">
              No sessions found for this repository
            </p>
          )}
        </div>
      ) : viewMode === 'user' ? (
        <div className="flex flex-1 flex-col overflow-y-auto">
          {userGroups.length > 0 ? (
            userGroups.map(({ userEmail, sessions: group }, index) => (
              <UserSection
                key={userEmail}
                userEmail={userEmail}
                sessions={group}
                isInitiallyOpen={index === 0}
                selectedSession={selectedSession}
                onSelect={onSelect}
                attributeDefs={attributeDefs}
              />
            ))
          ) : isLoading ? (
            loadingIndicator
          ) : error ? (
            <p className="p-4 text-sm text-muted-foreground">
              {error.message || 'Failed to load sessions'}
            </p>
          ) : (
            <p className="p-4 text-sm text-muted-foreground">
              No sessions found for this repository
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-y-auto">
          {displayedSessions.length > 0 ? (
            displayedSessions?.map((session) => (
              <SessionItem
                key={session.sessionId}
                session={session}
                selected={selectedSession?.sessionId === session.sessionId}
                onSelect={onSelect}
                thresholds={thresholds}
                attributeDefs={attributeDefs}
              />
            ))
          ) : isLoading ? (
            loadingIndicator
          ) : error ? (
            <p className="p-4 text-sm text-muted-foreground">
              {error.message || 'Failed to load sessions'}
            </p>
          ) : (
            <p className="p-4 text-sm text-muted-foreground">
              No sessions found for this repository
            </p>
          )}
        </div>
      )}

      {refreshErrorMsg && (
        <div className="fixed bottom-4 right-4 z-50 rounded-md border border-border bg-background px-4 py-2 text-sm shadow-lg">
          {refreshErrorMsg}
        </div>
      )}
    </>
  );
}
