import { useState, useCallback, useEffect, lazy, Suspense } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQueryClient, useMutation, useQuery } from '@tanstack/react-query';
import { Loader2, Lock, RefreshCw } from 'lucide-react';
import { deleteSession, fetchTeams } from '../../api';
import { RESTRICTED_SESSIONS_NOTICE } from '../../lib/access-mode-copy';
import { routes } from '../../hooks/useHashRoute';
import { useAuth } from '../../context/AuthContext';
import { PageTabs, PageTabsContent } from '../../ui/page-tabs';
import { useModelPricing } from '../../hooks/useModelPricing';
import { LazyFallback } from '../../components/LazyFallback';
import { type ViewMode } from './session-list/SessionListPanel';
import { type AnalyticsState } from './analytics/RepositoryAnalytics';
import { RepositorySettings } from './RepositorySettings';
import { analyticsFromParams } from './analytics/analytics-url';
import { useRepositoryData } from './useRepositoryData';
import { REPO_MAIN_TABS, type RepoMainTab as MainTab } from '../../tab-ids';
import { RepositoryHeader } from './RepositoryHeader';
import { RepositorySessionsPanel } from './RepositorySessionsPanel';
import { useRepositoryViewState } from './useRepositoryViewState';
import { useOpenBranches } from './useOpenBranches';
import { useNewSessionPoll } from './useNewSessionPoll';
import { useSessionListRefreshing } from './useSessionListRefresh';
import { NotificationDot } from '../../ui/notification-dot';

export type { AnalyticsState };

const RepositoryAnalytics = lazy(() =>
  import('./analytics/RepositoryAnalytics').then((m) => ({
    default: m.RepositoryAnalytics,
  })),
);
const ReportsPanel = lazy(() =>
  import('./reports/ReportsPanel').then((m) => ({
    default: m.ReportsPanel,
  })),
);
const RepoOkfTab = lazy(() =>
  import('./okf/RepoOkfTab').then((m) => ({
    default: m.RepoOkfTab,
  })),
);

function getHttpStatusCode(error: unknown): number | null {
  if (error && typeof error === 'object' && 'statusCode' in error) {
    const s = error.statusCode;
    if (typeof s === 'number') return s;
  }
  return null;
}

const MAIN_TAB_LABELS: Record<MainTab, string> = {
  sessions: 'Sessions',
  analytics: 'Analytics',
  reports: 'Reports',
  okf: 'OKF',
  settings: 'Settings',
};

export function RepositoryView() {
  const { repoId: repoIdStr, teamId: teamIdStr } = useParams<{
    repoId: string;
    teamId?: string;
  }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const repoId = parseInt(repoIdStr!, 10);
  const teamId = teamIdStr ? parseInt(teamIdStr, 10) : undefined;

  const isInvalidId =
    Number.isNaN(repoId) || (teamId !== undefined && Number.isNaN(teamId));

  const isRefreshing = useSessionListRefreshing(repoId, teamId);

  const { data: teams = [] } = useQuery({
    queryKey: ['teams'],
    queryFn: fetchTeams,
    enabled: teamId !== undefined,
  });
  const currentTeam =
    teamId !== undefined ? teams.find((t) => t.id === teamId) : undefined;

  /**
   * What this caller may reach inside a `restricted` team. Mirrors the server-side
   * scope — the tabs below are a cosmetic second layer over
   * real 403s, never the enforcement itself.
   *
   * While the `['teams']` query is still in flight `currentTeam` is `undefined`,
   * which reads as "not restricted" so the tab bar does not flash a narrower set
   * and then widen.
   */
  const isRestrictedTeam = currentTeam?.accessMode === 'restricted';
  const isTeamOwner =
    currentTeam !== undefined &&
    user != null &&
    currentTeam.ownerId === user.id;

  /**
   * Team owner and `manager` keep Analytics / Reports / Settings. The app admin role
   * grants nothing here — an admin is scoped by their team role like anyone else.
   */
  const canSeeTeamWideTabs =
    !isRestrictedTeam || isTeamOwner || (currentTeam?.myIsManager ?? false);

  /**
   * Only a caller whose scope really is `own-only` gets the notice — a `manager`
   * and an `adlc trainer` both see every member's rows, so the "you see only your
   * own sessions" wording would be wrong for them.
   */
  const showRestrictedNotice =
    isRestrictedTeam &&
    !isTeamOwner &&
    !currentTeam?.myIsManager &&
    !currentTeam?.myIsAdlcTrainer;

  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const stored = localStorage.getItem(
      'artisyn:sessionViewMode',
    ) as ViewMode | null;
    return stored ?? 'branch';
  });

  function handleViewModeChange(mode: ViewMode) {
    localStorage.setItem('artisyn:sessionViewMode', mode);
    setViewMode(mode);
  }

  const [hideHookSessions, setHideHookSessions] = useState<boolean>(() => {
    const stored = localStorage.getItem(
      `artisyn:repo-${repoId}-hideHookSessions`,
    );
    return stored !== null ? stored === 'true' : true;
  });

  function handleHideHookSessionsChange(value: boolean) {
    localStorage.setItem(
      `artisyn:repo-${repoId}-hideHookSessions`,
      String(value),
    );
    setHideHookSessions(value);
  }

  const [branchSelectedSession, setBranchSelectedSession] = useState<{
    sessionId: string;
    branch: string | null;
  } | null>(null);

  const { isBranchOpen, toggleBranch } = useOpenBranches();

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteSuccessMsg, setDeleteSuccessMsg] = useState<string | null>(null);

  const handleRepoBranchReset = useCallback(
    () => setBranchSelectedSession(null),
    [],
  );

  const {
    searchParams,
    sessionId,
    mainTab,
    sessionTab,
    topN,
    showAllUsers,
    setMainTab,
    setSessionTab,
    setTopN,
    setShowAllUsers,
    handleSessionSelect,
    closeSession,
    handleAnalyticsSessionClick,
    handleAnalyticsStateChange,
  } = useRepositoryViewState({
    repoId,
    teamId,
    viewMode,
    onBranchSessionSelect: (sessionId, branch) =>
      setBranchSelectedSession({ sessionId, branch }),
    onRepoBranchReset: handleRepoBranchReset,
  });

  // The URL `session` param is the only source of the selection: once it
  // stops naming the branch-local selection (Back/Forward, a pasted link, Close), drop it.
  // Runs only when the URL session changes. A branch-row click sets this state urgently, while
  // the router commits the new URL later inside `startTransition`, so for one commit the
  // fresh selection legitimately runs ahead of the URL and must not be dropped.
  // `useRepositoryData` already ignores a selection that does not match the URL.
  useEffect(() => {
    setBranchSelectedSession((prev) =>
      prev !== null && prev.sessionId !== sessionId ? null : prev,
    );
  }, [sessionId]);

  /**
   * Personal repo views default to the owner's own sessions; a team view is already scoped by the
   * server, so it never filters by email here. `showAllUsers` lifts the default on request —
   * `SessionListPanel` surfaces what is hidden and calls `setShowAllUsers` to reveal it.
   *
   * Derived once: the session list and the new-session poll must agree on this value, and they
   * previously each re-derived it from their own copy of the ternary.
   */
  const filterByUserEmail =
    teamId === undefined && !showAllUsers
      ? (user?.email ?? undefined)
      : undefined;

  const {
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
  } = useRepositoryData({
    repoId,
    teamId,
    isInvalidId,
    viewMode,
    sessionId,
    branchSelectedSession,
  });

  // D4.8 — the repo URL comes from the repo-detail query (team-aware), not another view's cache.
  const repoUrl = repoDetailQuery.data?.repoUrl;

  // Price the selected session at the rates in effect on its start date
  // (the UTC date the server's `sessionPriceDateSql` uses); no session means today.
  const pricing = useModelPricing(
    selectedSession?.startTime
      ? selectedSession.startTime.slice(0, 10)
      : undefined,
  );

  const { hasNewSessions } = useNewSessionPoll({
    repoId,
    teamId,
    isInvalidId,
    sessions,
    viewMode,
    filterByUserEmail,
    hideHookSessions,
    isBranchOpen,
  });

  const deleteSessionMutation = useMutation({
    mutationFn: () => deleteSession(selectedSession!.sessionId),
    onSuccess: () => {
      setShowDeleteDialog(false);
      void queryClient.invalidateQueries({
        queryKey: ['repo-sessions', repoId, teamId],
      });
      void queryClient.invalidateQueries({
        queryKey: ['repo-sessions-branch', repoId, teamId],
      });
      void navigate(
        teamId !== undefined
          ? routes.teamRepo(teamId, repoId)
          : routes.repo(repoId),
      );
      setDeleteSuccessMsg('Session removed.');
      setTimeout(() => setDeleteSuccessMsg(null), 3000);
    },
  });

  if (isInvalidId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Error</p>
      </div>
    );
  }

  const sessionsStatusCode = getHttpStatusCode(sessionsQuery.error);
  const summaryStatusCode = getHttpStatusCode(summaryQuery.error);

  if (sessionsStatusCode === 403 || summaryStatusCode === 403) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">No access</p>
      </div>
    );
  }

  if (sessionsStatusCode === 404 || summaryStatusCode === 404) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Repository not found</p>
      </div>
    );
  }

  if (summaryQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  const summary = summaryQuery.data;
  const repoContexts = repoContextsQuery.data ?? [];

  const sessionCountDisplay = summaryQuery.error ? (
    <span>—</span>
  ) : (
    <span>{summary?.sessionCount ?? 0}</span>
  );

  const userCountDisplay = summaryQuery.error ? (
    <span>—</span>
  ) : (
    <span>{summary?.userCount ?? 0}</span>
  );

  // Use server-computed totalCost (includes sub-agent costs).
  const sessionCost = selectedSession?.totalCost ?? null;

  /**
   * `mainTab` is URL state, so a hand-typed `?tab=settings` would otherwise render
   * a panel whose trigger is not on screen. Fall back to Sessions — the one tab
   * every caller keeps.
   */
  const visibleMainTab: MainTab =
    canSeeTeamWideTabs || mainTab === 'sessions' ? mainTab : 'sessions';

  return (
    <div className="flex flex-col h-full">
      <RepositoryHeader
        repoUrl={repoUrl}
        sessionCountDisplay={sessionCountDisplay}
        userCountDisplay={userCountDisplay}
        repoContexts={repoContexts}
      />

      {showRestrictedNotice && (
        <div
          data-testid="restricted-sessions-notice"
          className="flex items-start gap-2 border-b border-border bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{RESTRICTED_SESSIONS_NOTICE}</span>
        </div>
      )}

      <PageTabs
        tabs={REPO_MAIN_TABS.filter(
          (t) => t === 'sessions' || canSeeTeamWideTabs,
        ).map((t) => ({ value: t, label: MAIN_TAB_LABELS[t] }))}
        value={visibleMainTab}
        onValueChange={(v) => setMainTab(v as MainTab)}
        className="flex flex-col flex-1 min-h-0"
        testIdGroup="repo"
        leftActions={
          <div className="relative">
            <button
              onClick={handleRefresh}
              title="Refresh"
              className={`flex items-center justify-center rounded border border-border p-1 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground ${
                isRefreshing ? 'bg-indigo-50 border-blue-600 text-blue-600' : ''
              }`}
            >
              <RefreshCw
                className={`size-3.5 ${isRefreshing ? 'animate-spin' : ''}`}
              />
            </button>
            {hasNewSessions && <NotificationDot />}
          </div>
        }
      >
        <PageTabsContent value="sessions" className="flex-1 min-h-0">
          <RepositorySessionsPanel
            sessions={sessions ?? []}
            sessionsLoading={sessionsQuery.isLoading}
            sessionsError={sessionsQuery.error}
            selectedSession={selectedSession}
            isSessionNotFound={isSessionNotFound}
            onSessionClose={closeSession}
            onSessionSelect={handleSessionSelect}
            repoId={repoId}
            teamId={teamId}
            viewMode={viewMode}
            onViewModeChange={handleViewModeChange}
            filterByUserEmail={filterByUserEmail}
            onShowAllUsers={() => setShowAllUsers(true)}
            hideHookSessions={hideHookSessions}
            sessionTab={sessionTab}
            onSessionTabChange={setSessionTab}
            isFavorite={isFavorite}
            favoriteMutationPending={favoriteMutation.isPending}
            onFavoriteToggle={(newValue) => favoriteMutation.mutate(newValue)}
            showDeleteDialog={showDeleteDialog}
            onDeleteRequest={() => setShowDeleteDialog(true)}
            onDeleteConfirm={() => deleteSessionMutation.mutate()}
            onDeleteCancel={() => setShowDeleteDialog(false)}
            deleteLoading={deleteSessionMutation.isPending}
            logsQuery={logsQuery}
            parsedLogs={parsedLogs}
            subagentLogsMap={subagentLogsMap}
            agentParentMap={agentParentMap}
            pricing={pricing}
            repoConfig={repoDetailQuery.data?.repoConfig ?? null}
            topN={topN}
            onTopNChange={setTopN}
            repoUrl={repoUrl}
            sessionCost={sessionCost}
            isBranchOpen={isBranchOpen}
            onToggleBranch={toggleBranch}
            isReloadingUpdatedSession={isReloadingUpdatedSession}
          />
        </PageTabsContent>

        {canSeeTeamWideTabs && (
          <>
            <PageTabsContent value="analytics" className="flex-1 min-h-0">
              <Suspense fallback={<LazyFallback />}>
                <RepositoryAnalytics
                  key={searchParams.get('av') ?? 'work-time'}
                  repoId={repoId}
                  teamId={teamId}
                  initialState={(() => {
                    const fromParams = analyticsFromParams(searchParams);
                    if (teamId === undefined && user?.email) {
                      return {
                        ...fromParams,
                        users: [user.email],
                        ...(fromParams.groupBy === 'user'
                          ? { groupBy: 'none' as const }
                          : {}),
                      };
                    }
                    return fromParams;
                  })()}
                  onStateChange={handleAnalyticsStateChange}
                  onSessionClick={handleAnalyticsSessionClick}
                />
              </Suspense>
            </PageTabsContent>

            <PageTabsContent value="reports" className="flex-1 min-h-0">
              <Suspense fallback={<LazyFallback />}>
                <ReportsPanel repoId={repoId} teamId={teamId} />
              </Suspense>
            </PageTabsContent>

            <PageTabsContent value="okf" className="flex-1 min-h-0">
              <Suspense fallback={<LazyFallback />}>
                <RepoOkfTab repoId={repoId} teamId={teamId} />
              </Suspense>
            </PageTabsContent>

            <PageTabsContent value="settings" className="flex-1 min-h-0">
              <RepositorySettings
                repoId={repoId}
                teamId={teamId}
                hideHookSessions={hideHookSessions}
                onHideHookSessionsChange={handleHideHookSessionsChange}
              />
            </PageTabsContent>
          </>
        )}
      </PageTabs>

      {deleteSuccessMsg && (
        <div className="fixed bottom-4 right-4 z-50 rounded-md border border-border bg-background px-4 py-2 text-sm shadow-lg">
          {deleteSuccessMsg}
        </div>
      )}
    </div>
  );
}
