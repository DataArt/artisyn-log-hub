/**
 * Host for the four usage-analytics views inside the Analytics tab.
 *
 * These four are table documents backed by their own dedicated endpoints, not the shared
 * `analytics/timeline` payload the D3 charts render, so they own their queries here rather
 * than reusing `RepositoryAnalytics`'s `timelineQuery`. Keeping them in their own component
 * also keeps `RepositoryAnalytics.tsx` down to a single render branch.
 *
 * All four honour the tab's existing date-range, branch and user selectors; `groupBy` and the
 * vertical/horizontal layout toggle do not apply to them and are hidden by the parent.
 */
import { useQuery } from '@tanstack/react-query';
import {
  fetchActiveSessions,
  fetchProductivityAnalytics,
  fetchTokenAnalytics,
  fetchToolAnalytics,
} from '../../../api';
import { ActiveSessionsView } from './ActiveSessionsView';
import { ProductivityCountersView } from './ProductivityCountersView';
import { TokenBreakdownView } from './TokenBreakdownView';
import { ToolAnalyticsView } from './ToolAnalyticsView';
import type { AnalyticsState } from './analytics-state';

/** The `AnalyticsState['view']` values this panel owns. */
export type UsageAnalyticsView =
  | 'tools'
  | 'tokens'
  | 'productivity-counters'
  | 'active-sessions';

const USAGE_VIEWS: readonly string[] = [
  'tools',
  'tokens',
  'productivity-counters',
  'active-sessions',
];

export function isUsageAnalyticsView(
  view: AnalyticsState['view'],
): view is UsageAnalyticsView {
  return USAGE_VIEWS.includes(view);
}

interface Props {
  repoId: number;
  teamId?: number;
  view: UsageAnalyticsView;
  startDate?: string;
  endDate?: string;
  branches: string[];
  users: string[];
  onSessionClick: (sessionId: string) => void;
}

function Loading() {
  return (
    <div className="flex flex-1 items-center justify-center gap-2">
      <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
      <span className="text-sm text-muted-foreground">Loading…</span>
    </div>
  );
}

function LoadError() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <p className="text-sm text-muted-foreground">Error</p>
    </div>
  );
}

export function UsageAnalyticsPanel({
  repoId,
  teamId,
  view,
  startDate,
  endDate,
  branches,
  users,
  onSessionClick,
}: Props) {
  const enabled = startDate != null && endDate != null;
  const params = {
    teamId,
    startDate: startDate ?? '',
    endDate: endDate ?? '',
    branches,
    users,
  };
  // One shared key prefix so switching views refetches only what that view needs.
  const key = [repoId, teamId, startDate, endDate, branches, users] as const;

  const toolsQuery = useQuery({
    queryKey: ['usage-analytics-tools', ...key],
    queryFn: () => fetchToolAnalytics(repoId, params),
    enabled: enabled && view === 'tools',
  });
  const tokensQuery = useQuery({
    queryKey: ['usage-analytics-tokens', ...key],
    queryFn: () => fetchTokenAnalytics(repoId, params),
    enabled: enabled && view === 'tokens',
  });
  const productivityQuery = useQuery({
    queryKey: ['usage-analytics-productivity', ...key],
    queryFn: () => fetchProductivityAnalytics(repoId, params),
    enabled: enabled && view === 'productivity-counters',
  });
  const activeSessionsQuery = useQuery({
    queryKey: ['usage-analytics-active-sessions', ...key],
    queryFn: () => fetchActiveSessions(repoId, params),
    enabled: enabled && view === 'active-sessions',
  });

  const active =
    view === 'tools'
      ? toolsQuery
      : view === 'tokens'
        ? tokensQuery
        : view === 'productivity-counters'
          ? productivityQuery
          : activeSessionsQuery;

  if (!enabled) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">
          Select a date range to load these figures.
        </p>
      </div>
    );
  }
  if (active.isPending || active.isFetching) return <Loading />;
  if (active.isError) return <LoadError />;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {view === 'tools' && toolsQuery.data && (
        <ToolAnalyticsView data={toolsQuery.data} />
      )}
      {view === 'tokens' && tokensQuery.data && (
        <TokenBreakdownView data={tokensQuery.data} />
      )}
      {view === 'productivity-counters' && productivityQuery.data && (
        <ProductivityCountersView data={productivityQuery.data} />
      )}
      {view === 'active-sessions' && activeSessionsQuery.data && (
        <ActiveSessionsView
          data={activeSessionsQuery.data}
          onSessionClick={onSessionClick}
        />
      )}
    </div>
  );
}
