import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { RepositorySession } from '../../../models/repositories';
import {
  fetchRepositoryBranches,
  fetchRepositorySessionIds,
  fetchRepositorySessions,
} from '../../api';
import { SESSION_POLL_INTERVAL_MS } from '../../lib/settings';
import { filterVisibleSessions } from './session-list/session-list-helpers';
import type { ViewMode } from './session-list/SessionListPanel';

/**
 * Pure diff: ids present in `polled` but absent from `displayedIds`.
 * Duplicate ids in `polled` only count once.
 */
export function diffNewSessionIds(
  polled: string[],
  displayedIds: Set<string>,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const sessionId of polled) {
    if (displayedIds.has(sessionId) || seen.has(sessionId)) {
      continue;
    }
    seen.add(sessionId);
    result.push(sessionId);
  }
  return result;
}

interface UseNewSessionPollParams {
  repoId: number;
  teamId?: number;
  isInvalidId: boolean;
  sessions: RepositorySession[] | undefined;
  viewMode: ViewMode;
  filterByUserEmail?: string;
  hideHookSessions: boolean;
  isBranchOpen: (key: string, index: number) => boolean;
  /**
   * The displayed list is a filtered subset (the `otelReason` filter, 2026-10-30
   * otel-shared-receiver), so diffing it against every session id would always report "new".
   */
  paused?: boolean;
}

/**
 * Polls for sessions that are not yet reflected in the currently displayed
 * data: display queries are left
 * untouched, and a sibling poll query (distinct key, own `refetchInterval`)
 * is diffed against them at render time.
 */
export function useNewSessionPoll({
  repoId,
  teamId,
  isInvalidId,
  sessions,
  viewMode,
  filterByUserEmail,
  hideHookSessions,
  isBranchOpen,
  paused = false,
}: UseNewSessionPollParams): { hasNewSessions: boolean } {
  const flatPollQuery = useQuery({
    queryKey: [
      'repo-sessions-ids-poll',
      repoId,
      teamId,
      filterByUserEmail,
      hideHookSessions,
    ],
    queryFn: () =>
      fetchRepositorySessionIds(repoId, teamId, undefined, {
        filterByUserEmail,
        hideHookSessions,
      }),
    enabled: !isInvalidId && !paused && viewMode !== 'branch',
    refetchInterval: SESSION_POLL_INTERVAL_MS,
  });

  const flatHasNew = useMemo(() => {
    if (viewMode === 'branch' || paused) return false;
    const displayedIds = new Set(
      filterVisibleSessions(sessions, {
        filterByUserEmail,
        hideHookSessions,
      }).map((s) => s.sessionId),
    );
    return diffNewSessionIds(flatPollQuery.data ?? [], displayedIds).length > 0;
  }, [
    viewMode,
    paused,
    sessions,
    filterByUserEmail,
    hideHookSessions,
    flatPollQuery.data,
  ]);

  const branchesQuery = useQuery({
    queryKey: ['repo-branches', repoId, teamId],
    queryFn: () => fetchRepositoryBranches(repoId, teamId),
    enabled: !isInvalidId && viewMode === 'branch',
  });

  const branches = branchesQuery.data ?? [];

  const branchDisplayQueries = useQueries({
    queries: branches.map((b, index) => {
      const key = b.branch ?? '__no_branch__';
      const open = viewMode === 'branch' && isBranchOpen(key, index);
      return {
        queryKey: ['repo-sessions-branch', repoId, teamId, b.branch],
        queryFn: () => fetchRepositorySessions(repoId, teamId, b.branch),
        enabled: open,
      };
    }),
  });

  const branchPollQueries = useQueries({
    queries: branches.map((b, index) => {
      const key = b.branch ?? '__no_branch__';
      const open = viewMode === 'branch' && isBranchOpen(key, index);
      return {
        queryKey: [
          'repo-sessions-branch-ids-poll',
          repoId,
          teamId,
          b.branch,
          filterByUserEmail,
          hideHookSessions,
        ],
        queryFn: () =>
          fetchRepositorySessionIds(repoId, teamId, b.branch, {
            filterByUserEmail,
            hideHookSessions,
          }),
        enabled: open,
        refetchInterval: SESSION_POLL_INTERVAL_MS,
      };
    }),
  });

  const branchHasNew = useMemo(() => {
    if (viewMode !== 'branch') return false;
    return branches.some((b, index) => {
      const key = b.branch ?? '__no_branch__';
      if (!isBranchOpen(key, index)) return false;
      const displayedIds = new Set(
        filterVisibleSessions(branchDisplayQueries[index]?.data, {
          filterByUserEmail,
          hideHookSessions,
        }).map((s) => s.sessionId),
      );
      const polled = branchPollQueries[index]?.data ?? [];
      return diffNewSessionIds(polled, displayedIds).length > 0;
    });
  }, [
    viewMode,
    branches,
    branchDisplayQueries,
    branchPollQueries,
    isBranchOpen,
    filterByUserEmail,
    hideHookSessions,
  ]);

  const hasNewSessions = useMemo(
    () => flatHasNew || branchHasNew,
    [flatHasNew, branchHasNew],
  );

  return { hasNewSessions };
}
