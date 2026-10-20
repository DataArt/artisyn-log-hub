import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import type { RepositorySession } from '../../../models/repositories';
import {
  ApiError,
  fetchRepositoryContexts,
  fetchRepositoryDetail,
  fetchRepositorySessions,
  fetchRepositorySummary,
  fetchSessionLogs,
  setSessionFavorite,
} from '../../api';
import { SESSION_POLL_INTERVAL_MS } from '../../lib/settings';
import {
  buildAgentParentMap,
  parseSessionLogs,
} from './session-log/log-parser';
import type { ViewMode } from './session-list/SessionListPanel';

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
}

export function useRepositoryData({
  repoId,
  teamId,
  isInvalidId,
  viewMode,
  sessionId,
  branchSelectedSession,
}: UseRepositoryDataParams) {
  const queryClient = useQueryClient();

  const sessionsQuery = useQuery({
    queryKey: ['repo-sessions', repoId, teamId],
    queryFn: () => fetchRepositorySessions(repoId, teamId),
    enabled:
      !isInvalidId &&
      (viewMode === 'plain' ||
        viewMode === 'date' ||
        viewMode === 'user' ||
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

  const repoContextsQuery = useQuery({
    queryKey: ['repo-contexts', repoId, teamId],
    queryFn: () => fetchRepositoryContexts(repoId, teamId),
    enabled: !isInvalidId,
  });

  // `teamId` in the key and the request: a team member reads a teammate's repo through the
  // team's access (D4.8). The `['repo-detail', repoId]` prefix invalidations still match.
  const repoDetailQuery = useQuery({
    queryKey: ['repo-detail', repoId, teamId ?? null],
    queryFn: () => fetchRepositoryDetail(repoId, teamId),
    enabled: !isInvalidId,
  });

  const logsQuery = useQuery({
    queryKey: ['session-logs', repoId, selectedSession?.sessionId, teamId],
    queryFn: () => fetchSessionLogs(repoId, selectedSession!.sessionId, teamId),
    enabled: selectedSession !== null,
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
    if (selectedSession && logsQuery.isSuccess && currentWatermark !== null) {
      seenEndTimeRef.current.set(selectedSession.sessionId, currentWatermark);
    }
  }, [
    selectedSession,
    logsQuery.isSuccess,
    logsQuery.dataUpdatedAt,
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

  // Per-agent log files keyed by agentId (strip the `agent-` sessionId prefix),
  // mirroring SessionLogView so the charts can read inner agent activity.
  const subagentLogsMap = useMemo(() => {
    const map = new Map<string, Record<string, unknown>[]>();
    for (const sa of logsQuery.data?.subagents ?? []) {
      const agentId = sa.sessionId.startsWith('agent-')
        ? sa.sessionId.slice('agent-'.length)
        : sa.sessionId;
      map.set(agentId, sa.logs);
    }
    return map;
  }, [logsQuery.data]);

  // Authoritative agentId -> parentAgentId map (see SessionLogView.tsx for full rationale) —
  // used by the Charts/Call Tree tabs to correctly discover nested sub-agents at any depth.
  const agentParentMap = useMemo(
    () => buildAgentParentMap(logsQuery.data?.subagents ?? []),
    [logsQuery.data],
  );

  const parsedLogs = useMemo(() => {
    if (logsQuery.data?.main === undefined) return null;
    return parseSessionLogs(logsQuery.data.main, {
      repoConfig: repoDetailQuery.data?.repoConfig ?? null,
      subagentStats: logsQuery.data.subagentStats,
      workflows: logsQuery.data.workflows,
      subagentLogs: subagentLogsMap,
    });
  }, [logsQuery.data, repoDetailQuery.data, subagentLogsMap]);

  const handleRefresh = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ['repo-sessions', repoId, teamId],
    });
    void queryClient.invalidateQueries({
      queryKey: ['repo-summary', repoId, teamId],
    });
    void queryClient.invalidateQueries({
      queryKey: ['repo-contexts', repoId, teamId],
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
    repoContextsQuery,
    repoDetailQuery,
    logsQuery,
    isFavorite,
    favoriteMutation,
    parsedLogs,
    subagentLogsMap,
    agentParentMap,
    handleRefresh,
    isReloadingUpdatedSession,
  };
}
