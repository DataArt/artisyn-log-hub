import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import type {
  OtelReasonKey,
  RepositorySession,
} from '../../../models/repositories';
import {
  ApiError,
  fetchRepositoryDetail,
  fetchRepositorySessions,
  fetchRepositorySummary,
  setSessionFavorite,
} from '../../api';
import { SESSION_POLL_INTERVAL_MS } from '../../lib/settings';
import { parseSessionLogs } from './session-log/log-parser';
import { useSessionLogParts } from './session-parts/useSessionLogParts';
import type { ViewMode } from './session-list/SessionListPanel';
import { isTagViewMode } from './session-list/tag-view-mode';
import { useSessionTagValues } from './useSessionTagValues';

interface BranchSelectedSession {
  sessionId: string;
  branch: string | null;
}

interface UseRepositoryDataParams {
  repoId: number;
  teamId?: number;
  isInvalidId: boolean;
  viewMode: ViewMode;
  sessionId?: string;
  branchSelectedSession: BranchSelectedSession | null;
  /** The sessions list `otelReason` filter (2026-10-30 otel-shared-receiver, DD-33). */
  otelReason?: OtelReasonKey | null;
  /** The personal-repo "my sessions only" user filter; scopes the header tag chips (FR-5). */
  tagScopeUserEmail?: string;
}

export function useRepositoryData({
  repoId,
  teamId,
  isInvalidId,
  viewMode,
  sessionId,
  branchSelectedSession,
  otelReason = null,
  tagScopeUserEmail,
}: UseRepositoryDataParams) {
  const queryClient = useQueryClient();

  // The unfiltered list keeps its historic key, so the exact-key cache writes below (favorite)
  // still reach it; a filtered list is its own entry under the same prefix (invalidations match).
  const sessionsQuery = useQuery({
    queryKey:
      otelReason === null
        ? ['repo-sessions', repoId, teamId]
        : ['repo-sessions', repoId, teamId, { otelReason }],
    queryFn: () =>
      fetchRepositorySessions(repoId, teamId, undefined, otelReason),
    enabled:
      !isInvalidId &&
      (viewMode === 'plain' ||
        viewMode === 'date' ||
        viewMode === 'user' ||
        isTagViewMode(viewMode) ||
        !!sessionId),
    retry: false,
  });

  const sessions = sessionsQuery.data;

  // The URL `session` param is the only source of the selected session.
  // The branch-local selection is honoured only while it still points at that URL session —
  // after Back/Forward or a pasted link it can be stale, and must never win over the URL.
  const activeBranchSelection =
    branchSelectedSession !== null &&
    sessionId !== undefined &&
    branchSelectedSession.sessionId === sessionId
      ? branchSelectedSession
      : null;

  // Shares the same cache entry (queryKey + queryFn) as `BranchSection.tsx`'s per-branch
  // query, so a background refetch of the open branch's session list also refreshes the
  // header for whichever of its sessions is currently selected.
  const branchSessionQuery = useQuery({
    queryKey: [
      'repo-sessions-branch',
      repoId,
      teamId,
      activeBranchSelection?.branch ?? null,
    ],
    queryFn: () =>
      fetchRepositorySessions(
        repoId,
        teamId,
        activeBranchSelection?.branch ?? undefined,
      ),
    enabled: !isInvalidId && activeBranchSelection !== null,
    staleTime: 30_000,
    select: (list) =>
      list.find((s) => s.sessionId === activeBranchSelection?.sessionId) ??
      null,
  });

  const sessionFromList = sessionId
    ? (sessions?.find((s) => s.sessionId === sessionId) ?? null)
    : null;
  const sessionFromBranch =
    activeBranchSelection !== null ? (branchSessionQuery.data ?? null) : null;
  const selectedSession = sessionFromBranch ?? sessionFromList;

  // The URL names a session, the repo-wide list has settled (success, or a
  // 403/404 error) and neither it nor the matching branch query holds that id. While the branch
  // query is still in flight the answer is not known yet, so the pane does not flash "not found".
  const sessionsErrorStatus =
    sessionsQuery.error instanceof ApiError
      ? sessionsQuery.error.statusCode
      : null;
  const sessionsSettled =
    sessionsQuery.isSuccess ||
    (sessionsQuery.isError &&
      (sessionsErrorStatus === 403 || sessionsErrorStatus === 404));
  const branchSettled =
    activeBranchSelection === null || !branchSessionQuery.isPending;
  const isSessionNotFound =
    sessionId !== undefined &&
    sessionId !== '' &&
    sessionsSettled &&
    branchSettled &&
    selectedSession === null;

  const summaryQuery = useQuery({
    queryKey: ['repo-summary', repoId, teamId],
    queryFn: () => fetchRepositorySummary(repoId, teamId),
    enabled: !isInvalidId,
    retry: false,
  });

  // The repository-header tag chips (FR-5 / FR-8): discovery over the sessions this view shows.
  const repoTagValuesQuery = useSessionTagValues(
    repoId,
    teamId,
    tagScopeUserEmail,
    !isInvalidId,
  );

  // `teamId` in the key and the request: a team member reads a teammate's repo through the
  // team's access (D4.8). The `['repo-detail', repoId]` prefix invalidations still match.
  const repoDetailQuery = useQuery({
    queryKey: ['repo-detail', repoId, teamId ?? null],
    queryFn: () => fetchRepositoryDetail(repoId, teamId),
    enabled: !isInvalidId,
  });

  // The manifest keeps the historic `['session-logs', …]` key, so the watermark below and every
  // invalidator refetch only the manifest; changed parts that are loaded follow by revision.
  const {
    manifestQuery,
    logsQuery,
    logsData,
    subagentLogsMap,
    agentParentMap,
    subagentMeta,
    knownAgentIds,
    requestAgent,
    requestAll,
    loaded: loadedParts,
    total: totalParts,
    allLoaded: allPartsLoaded,
  } = useSessionLogParts({
    repoId,
    sessionId: selectedSession?.sessionId,
    teamId,
  });

  // Sibling poll (same pattern as useNewSessionPoll.ts): a query key
  // distinct from `repo-sessions`/`repo-sessions-branch` above, so its background refetch never
  // trips `useSessionListRefreshing` — the session list stays visually still. Only reads the
  // open session's `endTime` watermark; the server bumps it on every re-upload of a growing
  // session (see logs.service.ts), so a change means new log data landed.
  const watermarkBranch = activeBranchSelection?.branch ?? undefined;
  const sessionWatermarkQuery = useQuery({
    queryKey: [
      'session-watermark-poll',
      repoId,
      teamId,
      activeBranchSelection !== null ? (watermarkBranch ?? null) : null,
      selectedSession?.sessionId,
    ],
    queryFn: () => fetchRepositorySessions(repoId, teamId, watermarkBranch),
    enabled: !isInvalidId && selectedSession !== null,
    refetchInterval: SESSION_POLL_INTERVAL_MS,
    select: (list) =>
      list.find((s) => s.sessionId === selectedSession?.sessionId)?.endTime ??
      null,
  });
  const currentWatermark =
    sessionWatermarkQuery.data ?? selectedSession?.endTime ?? null;

  // `seenEndTimeRef` records the watermark that was current the last time this session's logs
  // were fetched, so a later mismatch means the session grew since.
  const seenEndTimeRef = useRef<Map<string, string>>(new Map());
  const prevSessionIdRef = useRef<string | undefined>(undefined);
  // Set only by `reloadSelectedSessionLogs` (an explicit user action, e.g. the Refresh button),
  // never by background watermark detection — so the "loading updated session" banner never
  // pops up on its own while the user is just browsing. Cleared once that session's refetch
  // finishes. Read together with `logsQuery.isFetching` (derived below) rather than mirrored
  // into its own state, so there is no window where a stale-clearing effect could race ahead of
  // `isFetching` actually flipping true.
  const pendingReloadSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedSession) {
      prevSessionIdRef.current = undefined;
      return;
    }
    const currentSessionId = selectedSession.sessionId;
    prevSessionIdRef.current = currentSessionId;

    if (currentWatermark === null) return;
    const seenEndTime = seenEndTimeRef.current.get(currentSessionId);
    // No prior fetch to compare against (first time viewing this session) — the normal
    // loading path already handles this, nothing to reconcile here.
    if (seenEndTime === undefined || seenEndTime === currentWatermark) return;

    // Cached logs are older than the current watermark — refetch silently. No banner: that's
    // reserved for explicit reloads via `reloadSelectedSessionLogs`.
    void queryClient.invalidateQueries({
      queryKey: ['session-logs', repoId, currentSessionId, teamId],
    });
  }, [selectedSession, currentWatermark, queryClient, repoId, teamId]);

  const reloadSelectedSessionLogs = useCallback(() => {
    if (!selectedSession) return;
    pendingReloadSessionIdRef.current = selectedSession.sessionId;
    void queryClient.invalidateQueries({
      queryKey: ['session-logs', repoId, selectedSession.sessionId, teamId],
    });
  }, [selectedSession, queryClient, repoId, teamId]);

  const isReloadingUpdatedSession =
    pendingReloadSessionIdRef.current !== null &&
    pendingReloadSessionIdRef.current === selectedSession?.sessionId &&
    logsQuery.isFetching;

  // Once that refetch finishes, un-arm the ref so a later *silent* background refresh of the
  // same session (endTime advancing while it stays selected) never re-lights this banner.
  useEffect(() => {
    if (
      pendingReloadSessionIdRef.current !== null &&
      pendingReloadSessionIdRef.current === selectedSession?.sessionId &&
      !logsQuery.isFetching
    ) {
      pendingReloadSessionIdRef.current = null;
    }
  }, [logsQuery.isFetching, selectedSession]);

  useEffect(() => {
    if (
      selectedSession &&
      manifestQuery.isSuccess &&
      currentWatermark !== null
    ) {
      seenEndTimeRef.current.set(selectedSession.sessionId, currentWatermark);
    }
  }, [
    selectedSession,
    manifestQuery.isSuccess,
    manifestQuery.dataUpdatedAt,
    currentWatermark,
  ]);

  const isFavorite = selectedSession?.isFavorite ?? false;

  const favoriteMutation = useMutation({
    mutationFn: (favorite: boolean) => {
      if (!selectedSession) return Promise.resolve({ isFavorite: false });
      return setSessionFavorite(
        repoId,
        selectedSession.sessionId,
        favorite,
        teamId,
      );
    },
    onSuccess: (result) => {
      if (!selectedSession) return;
      const currentSessionId = selectedSession.sessionId;

      queryClient.setQueryData<RepositorySession[]>(
        ['repo-sessions', repoId, teamId],
        (old) =>
          old?.map((s) =>
            s.sessionId === currentSessionId
              ? { ...s, isFavorite: result.isFavorite }
              : s,
          ),
      );

      const branchCaches = queryClient.getQueriesData<RepositorySession[]>({
        queryKey: ['repo-sessions-branch', repoId, teamId],
      });
      for (const [key, data] of branchCaches) {
        queryClient.setQueryData<RepositorySession[]>(
          key,
          data?.map((s) =>
            s.sessionId === currentSessionId
              ? { ...s, isFavorite: result.isFavorite }
              : s,
          ),
        );
      }

      void queryClient.invalidateQueries({
        queryKey: ['repo-sessions', repoId, teamId],
      });
      void queryClient.invalidateQueries({
        queryKey: ['repo-sessions-branch', repoId, teamId],
      });
      void queryClient.invalidateQueries({
        queryKey: ['analytics-timeline', repoId, teamId],
      });
    },
  });

  // `subagentLogsMap` (loaded sub-agent bodies by bare agent id), `agentParentMap` and
  // `subagentMeta` (every manifest sub-agent) come from `useSessionLogParts` above.
  const parsedLogs = useMemo(() => {
    if (logsData === undefined) return null;
    return parseSessionLogs(logsData.main, {
      repoConfig: repoDetailQuery.data?.repoConfig ?? null,
      subagentStats: logsData.subagentStats,
      workflows: logsData.workflows,
      subagentLogs: subagentLogsMap,
      harnessSnapshot: logsData.harnessSnapshot ?? null,
      subagentMeta,
      knownSubagentIds: knownAgentIds,
    });
  }, [
    logsData,
    repoDetailQuery.data,
    subagentLogsMap,
    subagentMeta,
    knownAgentIds,
  ]);

  const handleRefresh = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ['repo-sessions', repoId, teamId],
    });
    void queryClient.invalidateQueries({
      queryKey: ['repo-summary', repoId, teamId],
    });
    void queryClient.invalidateQueries({
      queryKey: ['repo-tag-values', repoId, teamId],
    });
    void queryClient.invalidateQueries({
      queryKey: ['repo-branches', repoId, teamId],
    });
    void queryClient.invalidateQueries({
      queryKey: ['repo-sessions-branch', repoId, teamId],
    });
    reloadSelectedSessionLogs();
  }, [queryClient, repoId, teamId, reloadSelectedSessionLogs]);

  return {
    sessionsQuery,
    sessions,
    selectedSession,
    isSessionNotFound,
    summaryQuery,
    repoTagValuesQuery,
    repoDetailQuery,
    /** The manifest plus loaded parts, in the legacy `SessionLogsData` shape. */
    logsQuery,
    manifestQuery,
    isFavorite,
    favoriteMutation,
    parsedLogs,
    subagentLogsMap,
    agentParentMap,
    subagentMeta,
    knownAgentIds,
    handleRefresh,
    isReloadingUpdatedSession,
    requestAgent,
    requestAll,
    loadedParts,
    totalParts,
    allPartsLoaded,
  };
}
