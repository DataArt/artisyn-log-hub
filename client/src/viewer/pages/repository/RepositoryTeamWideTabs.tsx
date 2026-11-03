import { lazy, Suspense } from 'react';
import { useAuth } from '../../context/AuthContext';
import { PageTabsContent } from '../../ui/page-tabs';
import { LazyFallback } from '../../components/LazyFallback';
import type { OtelReasonKey } from '../../../models/repositories';
import { type AnalyticsState } from './analytics/RepositoryAnalytics';
import { RepositorySettings } from './RepositorySettings';
import { analyticsFromParams } from './analytics/analytics-url';

// The light repository tabs load through one barrel, so they share one chunk (lazy-chunk budget).
// Reports keeps its own chunk: it carries the PDF and zip export libraries.
const loadRepoTabs = () => import('./repository-tabs-lazy-group');
const RepositoryAnalytics = lazy(() =>
  loadRepoTabs().then((m) => ({ default: m.RepositoryAnalytics })),
);
const ReportsPanel = lazy(() =>
  import('./reports/ReportsPanel').then((m) => ({
    default: m.ReportsPanel,
  })),
);
const RepoToolsTab = lazy(() =>
  loadRepoTabs().then((m) => ({ default: m.RepoToolsTab })),
);
const RepoOkfTab = lazy(() =>
  loadRepoTabs().then((m) => ({ default: m.RepoOkfTab })),
);
const RepoOtelTab = lazy(() =>
  loadRepoTabs().then((m) => ({ default: m.RepoOtelTab })),
);

interface RepositoryTeamWideTabsProps {
  repoId: number;
  teamId?: number;
  searchParams: URLSearchParams;
  onAnalyticsStateChange: (s: AnalyticsState) => void;
  onAnalyticsSessionClick: (sessionId: string) => void;
  onOtelReasonFilter: (reason: OtelReasonKey) => void;
  hideHookSessions: boolean;
  onHideHookSessionsChange: (value: boolean) => void;
}

/**
 * The repository tabs beyond Sessions — Analytics, Reports, Tools, OKF, OTEL, Settings — as
 * `PageTabsContent` panels of `RepositoryView`'s `PageTabs`. Rendered only for a caller who may
 * see the team-wide tabs.
 */
export function RepositoryTeamWideTabs({
  repoId,
  teamId,
  searchParams,
  onAnalyticsStateChange,
  onAnalyticsSessionClick,
  onOtelReasonFilter,
  hideHookSessions,
  onHideHookSessionsChange,
}: RepositoryTeamWideTabsProps) {
  const { user } = useAuth();

  return (
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
            onStateChange={onAnalyticsStateChange}
            onSessionClick={onAnalyticsSessionClick}
          />
        </Suspense>
      </PageTabsContent>

      <PageTabsContent value="reports" className="flex-1 min-h-0">
        <Suspense fallback={<LazyFallback />}>
          <ReportsPanel repoId={repoId} teamId={teamId} />
        </Suspense>
      </PageTabsContent>

      <PageTabsContent value="tools" className="flex-1 min-h-0">
        <Suspense fallback={<LazyFallback />}>
          <RepoToolsTab repoId={repoId} teamId={teamId} />
        </Suspense>
      </PageTabsContent>

      <PageTabsContent value="okf" className="flex-1 min-h-0">
        <Suspense fallback={<LazyFallback />}>
          <RepoOkfTab repoId={repoId} teamId={teamId} />
        </Suspense>
      </PageTabsContent>

      <PageTabsContent value="otel" className="flex-1 min-h-0">
        <Suspense fallback={<LazyFallback />}>
          <RepoOtelTab
            repoId={repoId}
            teamId={teamId}
            onReasonFilter={onOtelReasonFilter}
          />
        </Suspense>
      </PageTabsContent>

      <PageTabsContent value="settings" className="flex-1 min-h-0">
        <RepositorySettings
          repoId={repoId}
          teamId={teamId}
          hideHookSessions={hideHookSessions}
          onHideHookSessionsChange={onHideHookSessionsChange}
        />
      </PageTabsContent>
    </>
  );
}
