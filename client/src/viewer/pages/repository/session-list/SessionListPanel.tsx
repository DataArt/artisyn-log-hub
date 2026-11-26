import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import type {
  BranchSummary,
  RepositorySession,
} from '../../../../models/repositories';
import { fetchRepositoryBranches, getRepoSettings } from '../../../api';
import { resolveSessionAttributionDefinitions } from '../../../lib/session-attribution-ui';
import { noisyKeyHint } from '../../../lib/session-tags';
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
import { TagSection } from './TagSection';
import {
  groupSessionsByTag,
  isTagViewMode,
  tagViewMode,
  tagViewModeKey,
  type TagViewMode,
} from './tag-view-mode';
import { useSessionTagFilterParam } from './useSessionTagFilterParam';
import { useSessionTagValues } from '../useSessionTagValues';

/** `tag:<key>` = "By tag: <key>" grouping (2026-11-24 otel-session-tags, FR-6). */
export type ViewMode = 'branch' | 'date' | 'user' | 'plain' | TagViewMode;

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

  // Session tags (otel-session-tags, FR-6): the filter lives in the URL `tag=` param and is
  // applied client-side over each row's `tags`, like the attribute filter above. The pickers
  // and the "By tag" options list only the keys of the view's tag discovery (FR-8).
  const { tagFilters, setTagFilters } = useSessionTagFilterParam();
  const { data: tagValues } = useSessionTagValues(
    repoId,
    teamId,
    filterByUserEmail,
  );
  const groupedTagKey = tagViewModeKey(viewMode);
  const tagKeys = useMemo(() => {
    const keys = Object.keys(tagValues?.tags ?? {}).sort((a, b) =>
      a.localeCompare(b),
    );
    // A remembered "By tag" key no longer in scope still needs its option, or the select blanks.
    if (groupedTagKey !== null && !keys.includes(groupedTagKey)) {
      keys.push(groupedTagKey);
    }
    return keys;
  }, [tagValues, groupedTagKey]);
  const noisyTagKeys = useMemo(
    () => new Set(tagValues?.noisyKeys ?? []),
    [tagValues],
  );
  // Rows show the filtered keys' values as chips; in "By tag" mode, the grouped key's.
  const rowTagChipKeys = useMemo(
    () => tagFilters.map((f) => f.key),
    [tagFilters],
  );

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
        tagFilters,
      }),
    [
      sessions,
      filterByUserEmail,
      hideHookSessions,
      attributeFilter,
      tagFilters,
    ],
  );

  const thresholds = useMemo(
    () => computeCostThresholds(displayedSessions ?? []),
    [displayedSessions],
  );

  const tagGroups = useMemo(
    () =>
      groupedTagKey !== null
        ? groupSessionsByTag(displayedSessions, groupedTagKey)
        : [],
    [groupedTagKey, displayedSessions],
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
              tagFilters,
            }),
          )
        : [],
    [viewMode, sessions, hideHookSessions, attributeFilter, tagFilters],
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
            tagFilters,
          }),
    [
      viewMode,
      sessions,
      filterByUserEmail,
      hideHookSessions,
      attributeFilter,
      tagFilters,
    ],
  );

  function handleModeChange(v: string) {
    if (
      v === 'branch' ||
      v === 'date' ||
      v === 'user' ||
      v === 'plain' ||
      isTagViewMode(v)
    ) {
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
          data-testid="session-list-view-mode"
          value={viewMode}
          onChange={(e) => handleModeChange(e.target.value)}
          className="w-full rounded border border-border bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="branch">By branch</option>
          <option value="date">By date</option>
          <option value="user">By user</option>
          <option value="plain">Plain list</option>
          {tagKeys.length > 0 && (
            <optgroup label="By tag">
              {tagKeys.map((key) => (
                <option
                  key={key}
                  value={tagViewMode(key)}
                  title={noisyTagKeys.has(key) ? noisyKeyHint(key) : undefined}
                >
                  {`By tag: ${key}${noisyTagKeys.has(key) ? ' ⚠ noisy' : ''}`}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <AttributeFilterPopover
          repoId={repoId}
          teamId={teamId}
          definitions={attributeDefs}
          value={attributeFilter}
          onChange={setAttributeFilter}
          tagValues={tagValues}
          tagFilters={tagFilters}
          onTagFiltersChange={setTagFilters}
        />
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
                  tagFilters={tagFilters}
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
      ) : groupedTagKey !== null ? (
        <div className="flex flex-1 flex-col overflow-y-auto">
          {tagGroups.length > 0 ? (
            tagGroups.map(({ groupKey, label, sessions: group }, index) => (
              <TagSection
                key={groupKey}
                tagKey={groupedTagKey}
                label={label}
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
                tagChipKeys={rowTagChipKeys}
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
