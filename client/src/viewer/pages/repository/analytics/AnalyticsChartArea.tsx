import type {
  ChangeSurfaceTimeline,
  TimelineSession,
} from '../../../../models/repositories';
import { WorkTimeBarChart } from './WorkTimeBarChart';
import { CostBarChart } from './CostBarChart';
import { FilesBarChart } from './FilesBarChart';
import { VisionBarChart } from './VisionBarChart';
import { McpInvocationsChart } from './McpInvocationsChart';
import { HorizontalBarChart } from './HorizontalBarChart';
import { ProductivityChart } from './ProductivityChart';
import { LogLinesBarChart } from './LogLinesBarChart';
import { CacheRatioBarChart } from './CacheRatioBarChart';
import { CacheRatioScopeSummary } from './CacheRatioScopeSummary';
import {
  isUsageAnalyticsView,
  UsageAnalyticsPanel,
} from './UsageAnalyticsPanel';
import { ChangeSurfaceBarChart } from './ChangeSurfaceBarChart';
import type { ChangeSurfaceMetricKey } from './change-surface-metrics';
import type {
  FilesMetricKey,
  VisionMetricKey,
  ProductivityMetricKey,
} from './metrics';
import type { AnalyticsState } from './analytics-state';

// Chart area for RepositoryAnalytics — picks the right chart/table for the active
// view and layout. Split out of RepositoryAnalytics.tsx (component-size split).
// The four usage table views are backed by their own endpoints (UsageAnalyticsPanel), so
// they bypass the timeline payload and its loading/empty state entirely.

interface Props {
  repoId: number;
  teamId?: number;
  state: AnalyticsState;
  startDate: string | undefined;
  endDate: string | undefined;
  isFetching: boolean;
  isEmpty: boolean;
  sessions: TimelineSession[];
  filesMetric: FilesMetricKey;
  visionMetric: VisionMetricKey;
  productivityMetric: ProductivityMetricKey;
  /** The change-surface view's own query, owned by RepositoryAnalytics.tsx. */
  changeSurfaceMetric: ChangeSurfaceMetricKey;
  changeSurfaceTimeline: ChangeSurfaceTimeline | undefined;
  changeSurfaceFetching: boolean;
  changeSurfaceError: boolean;
  onSessionClick: (sessionId: string) => void;
}

export function AnalyticsChartArea({
  repoId,
  teamId,
  state,
  startDate,
  endDate,
  isFetching,
  isEmpty,
  sessions,
  filesMetric,
  visionMetric,
  productivityMetric,
  changeSurfaceMetric,
  changeSurfaceTimeline,
  changeSurfaceFetching,
  changeSurfaceError,
  onSessionClick,
}: Props) {
  if (isUsageAnalyticsView(state.view)) {
    return (
      <UsageAnalyticsPanel
        repoId={repoId}
        teamId={teamId}
        view={state.view}
        startDate={startDate}
        endDate={endDate}
        branches={state.branches}
        users={state.users}
        onSessionClick={onSessionClick}
      />
    );
  }

  // Own endpoint, bucketed server-side (every bucket is a fresh union, never a
  // sum), so it bypasses the shared timelineQuery payload and its loading/empty state the
  // same way the views above do. The shared session list is passed only so the bar-click
  // modal can show real session rows for the bucket's sessionIds.
  if (state.view === 'change-surface') {
    return (
      <ChangeSurfaceBarChart
        timeline={changeSurfaceTimeline}
        isFetching={changeSurfaceFetching}
        isError={changeSurfaceError}
        activeMetric={changeSurfaceMetric}
        sessions={sessions}
        onSessionClick={onSessionClick}
      />
    );
  }

  if (isFetching) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
        <span className="text-sm text-muted-foreground">Loading…</span>
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">no sessions</p>
      </div>
    );
  }

  const rangeStart = startDate ?? new Date().toISOString();
  const rangeEnd = endDate ?? new Date().toISOString();

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      {/* Two-value scope strip — the headline ratio-of-sums for the current
          filters, shown above either layout of the cache-read-ratio view. */}
      {state.view === 'cache-read-ratio' && (
        <CacheRatioScopeSummary sessions={sessions} groupBy={state.groupBy} />
      )}
      <div className="flex-1 min-h-0">
        {state.layout === 'horizontal' ? (
          <HorizontalBarChart
            sessions={sessions}
            groupBy={state.groupBy}
            view={state.view}
            filesMetric={filesMetric}
            visionMetric={visionMetric}
            productivityMetric={productivityMetric}
            onSessionClick={onSessionClick}
          />
        ) : state.view === 'cost' ? (
          <CostBarChart
            sessions={sessions}
            startDate={rangeStart}
            endDate={rangeEnd}
            groupBy={state.groupBy}
            onSessionClick={onSessionClick}
          />
        ) : state.view === 'files' ? (
          <FilesBarChart
            sessions={sessions}
            startDate={rangeStart}
            endDate={rangeEnd}
            groupBy={state.groupBy}
            activeMetric={filesMetric}
            onSessionClick={onSessionClick}
          />
        ) : state.view === 'vision' ? (
          <VisionBarChart
            sessions={sessions}
            startDate={rangeStart}
            endDate={rangeEnd}
            groupBy={state.groupBy}
            activeMetric={visionMetric}
            onSessionClick={onSessionClick}
          />
        ) : state.view === 'mcp' ? (
          <McpInvocationsChart
            sessions={sessions}
            startDate={rangeStart}
            endDate={rangeEnd}
            groupBy={state.groupBy}
            onSessionClick={onSessionClick}
          />
        ) : state.view === 'productivity' ? (
          <ProductivityChart
            sessions={sessions}
            startDate={rangeStart}
            endDate={rangeEnd}
            groupBy={state.groupBy}
            activeMetric={productivityMetric}
            onSessionClick={onSessionClick}
          />
        ) : state.view === 'log-lines' ? (
          <LogLinesBarChart
            sessions={sessions}
            startDate={rangeStart}
            endDate={rangeEnd}
            groupBy={state.groupBy}
            onSessionClick={onSessionClick}
          />
        ) : state.view === 'cache-read-ratio' ? (
          <CacheRatioBarChart sessions={sessions} />
        ) : (
          <WorkTimeBarChart
            sessions={sessions}
            startDate={rangeStart}
            endDate={rangeEnd}
            groupBy={state.groupBy}
            onSessionClick={onSessionClick}
          />
        )}
      </div>
    </div>
  );
}
