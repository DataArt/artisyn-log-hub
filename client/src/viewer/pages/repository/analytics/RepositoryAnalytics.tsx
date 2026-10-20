import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DateRange } from 'react-day-picker';
import {
  fetchAnalyticsChangeSurface,
  fetchAnalyticsTimeline,
  fetchTeamMembers,
  getRepoSettings,
  ApiError,
} from '@/api';
import type { TimelineSession } from '../../../../models/repositories';
import { resolveSessionAttributionDefinitions } from '../../../lib/session-attribution-ui';
import {
  type FilesMetricKey,
  type VisionMetricKey,
  type ProductivityMetricKey,
  buildFilesMetrics,
} from './metrics';
import {
  DEFAULT_CHANGE_SURFACE_METRIC,
  type ChangeSurfaceMetricKey,
} from './change-surface-metrics';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Button } from '@/ui/button';
import { DateRangePicker } from './DateRangePicker';
import { AnalyticsControls } from './AnalyticsControls';
import { AnalyticsChartArea } from './AnalyticsChartArea';
import { isUsageAnalyticsView } from './UsageAnalyticsPanel';
import {
  type AnalyticsState,
  DEFAULT_STATE,
  deriveStartEnd,
} from './analytics-state';

export type { AnalyticsState };

interface Props {
  repoId: number;
  teamId?: number;
  initialState?: Partial<AnalyticsState>;
  onStateChange: (s: AnalyticsState) => void;
  onSessionClick: (sessionId: string) => void;
}

export function RepositoryAnalytics({
  repoId,
  teamId,
  initialState,
  onStateChange,
  onSessionClick,
}: Props) {
  const initialised = useRef(false);

  const [state, setState] = useState<AnalyticsState>(() => ({
    ...DEFAULT_STATE,
    ...initialState,
  }));

  const [errorDismissed, setErrorDismissed] = useState(false);
  const [customPickerOpen, setCustomPickerOpen] = useState(false);
  const [filesMetric, setFilesMetric] =
    useState<FilesMetricKey>('linesChanged');
  const [visionMetric, setVisionMetric] =
    useState<VisionMetricKey>('imageCount');
  const [productivityMetric, setProductivityMetric] =
    useState<ProductivityMetricKey>('linesPerHour');
  // The Change Surface view's sub-metric, same fixed-default pattern as the three
  // selectors above.
  const [changeSurfaceMetric, setChangeSurfaceMetric] =
    useState<ChangeSurfaceMetricKey>(DEFAULT_CHANGE_SURFACE_METRIC);

  const mutate = useCallback(
    (patch: Partial<AnalyticsState>) => {
      setState((prev) => {
        const next = { ...prev, ...patch };
        onStateChange(next);
        return next;
      });
    },
    [onStateChange],
  );

  // Fire onStateChange only after first render (not during initialisation)
  useEffect(() => {
    if (!initialised.current) {
      initialised.current = true;
      return;
    }
  });

  // Memoized so new Date() doesn't create a new query key on every render.
  // Only range/customFrom/customTo drive startDate changes — other state fields don't affect the window.
  const { startDate, endDate } = useMemo(
    () => deriveStartEnd(state),
    [state.range, state.customFrom, state.customTo], // intentionally narrow deps
  );

  // Team members query for user filter
  const teamMembersQuery = useQuery({
    queryKey: ['team-members', teamId],
    queryFn: () => fetchTeamMembers(teamId!),
    enabled: teamId != null,
  });

  // Resolved AI Session Attribution definitions,
  // feeding AnalyticsControls' "Group by" dropdown ATTRIBUTES section. Shares its query key
  // with SessionListPanel.tsx/RepositorySettings.tsx's own `getRepoSettings()` fetch (no
  // duplicate network round trip when the user has already visited either); enabled for every
  // view except the usage-analytics table views, which have no "Group by" control at all.
  const repoSettingsQuery = useQuery({
    queryKey: ['repoSettings', repoId, teamId ?? null],
    queryFn: () => getRepoSettings(repoId, teamId),
    enabled: !isUsageAnalyticsView(state.view),
  });
  const attributeDefinitions = useMemo(
    () => resolveSessionAttributionDefinitions(repoSettingsQuery.data),
    [repoSettingsQuery.data],
  );

  // Timeline query — used for both timeline and work-time views
  const timelineQuery = useQuery({
    queryKey: [
      'analytics-timeline',
      repoId,
      teamId,
      startDate,
      endDate,
      state.groupBy,
      state.branches,
      state.users,
    ],
    queryFn: () =>
      fetchAnalyticsTimeline(repoId, {
        teamId,
        startDate: startDate!,
        endDate: endDate!,
        groupBy: state.groupBy !== 'none' ? state.groupBy : undefined,
        branches: state.branches.length > 0 ? state.branches : undefined,
        users: state.users.length > 0 ? state.users : undefined,
      }),
    enabled: startDate != null,
  });

  // The Change Surface view's own series. Bucketing, grouping and the union
  // recomputation all happen server-side (one shared aggregate service with the report,
  // so the two can never disagree), and the bucket granularity is derived from the range
  // span unless an explicit `bucket` param overrides it. Only enabled while the view is selected —
  // no other view has a use for it.
  const changeSurfaceQuery = useQuery({
    queryKey: [
      'analytics-change-surface',
      repoId,
      teamId,
      startDate,
      endDate,
      state.groupBy,
      state.branches,
      state.users,
    ],
    queryFn: () =>
      fetchAnalyticsChangeSurface(repoId, {
        teamId,
        startDate: startDate!,
        endDate: endDate!,
        groupBy: state.groupBy !== 'none' ? state.groupBy : undefined,
        branches: state.branches.length > 0 ? state.branches : undefined,
        users: state.users.length > 0 ? state.users : undefined,
      }),
    enabled: startDate != null && state.view === 'change-surface',
  });

  // Derive branch list from timeline sessions
  const branchList = useMemo<string[]>(() => {
    const sessions: TimelineSession[] = timelineQuery.data ?? [];
    const set = new Set<string>();
    for (const s of sessions) {
      if (s.gitBranch) set.add(s.gitBranch);
    }
    return Array.from(set).sort();
  }, [timelineQuery.data]);

  // Stale branches: selected branches that are no longer in the current branch list
  const staleBranches = useMemo(
    () => state.branches.filter((b) => !branchList.includes(b)),
    [state.branches, branchList],
  );

  // Users visible in current range — derived from timeline sessions
  const usersInRange = useMemo<string[]>(() => {
    const sessions: TimelineSession[] = timelineQuery.data ?? [];
    const set = new Set<string>();
    for (const s of sessions) {
      if (s.userEmail) set.add(s.userEmail);
    }
    return Array.from(set).sort();
  }, [timelineQuery.data]);

  // File categories derived from sessions — drives sub-metric list for "files" view
  const filesMetrics = useMemo(() => {
    const catSet = new Set<string>();
    for (const s of timelineQuery.data ?? []) {
      for (const cat of Object.keys(s.fileStatsByCategory ?? {})) {
        catSet.add(cat);
      }
    }
    return buildFilesMetrics(Array.from(catSet).sort());
  }, [timelineQuery.data]);

  // Team member email list from the query
  const teamMemberEmails = useMemo<string[]>(
    () => (teamMembersQuery.data ?? []).map((m) => m.email),
    [teamMembersQuery.data],
  );

  // Show user filter only when teamId set, members list is non-empty, and
  // at least one team member has a session in range
  const showUserFilter = useMemo(
    () =>
      teamId != null &&
      teamMemberEmails.length > 0 &&
      teamMemberEmails.some((e) => usersInRange.includes(e)),
    [teamId, teamMemberEmails, usersInRange],
  );

  // Determine active query error (non-401 only)
  const activeError = useMemo(() => {
    const err = timelineQuery.error;
    if (!err) return null;
    if (err instanceof ApiError && err.statusCode === 401) return null;
    return err;
  }, [timelineQuery.error]);

  // Reset error dismiss when error changes
  useEffect(() => {
    setErrorDismissed(false);
  }, [activeError]);

  const isEmpty = timelineQuery.data != null && timelineQuery.data.length === 0;

  // Date picker calendar state
  const calendarRange: DateRange | undefined =
    state.range === 'custom' && state.customFrom && state.customTo
      ? {
          from: new Date(state.customFrom),
          to: new Date(state.customTo),
        }
      : undefined;

  function handleRangeToggle(value: string) {
    if (!value) return;
    mutate({
      range: value as AnalyticsState['range'],
      customFrom: undefined,
      customTo: undefined,
    });
  }

  function handleCustomButtonClick() {
    setCustomPickerOpen(true);
  }

  function handleCustomApply(range: { from: Date; to: Date }) {
    const localDate = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };
    mutate({
      range: 'custom',
      customFrom: localDate(range.from),
      customTo: localDate(range.to),
    });
  }

  function formatCustomLabel(from: string, to: string): string {
    const fmt = (d: string) =>
      new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
      }).format(new Date(d + 'T00:00:00'));
    return `${fmt(from)} – ${fmt(to)}`;
  }

  function handleGroupByChange(value: string) {
    mutate({
      groupBy: value as AnalyticsState['groupBy'],
      // Clear branch/user filters that conflict with grouping
      branches: value === 'branch' ? [] : state.branches,
      users: value === 'user' ? [] : state.users,
    });
  }

  function handleViewToggle(value: string) {
    if (!value) return;
    mutate({ view: value as AnalyticsState['view'] });
  }

  function handleLayoutToggle(layout: 'vertical' | 'horizontal') {
    mutate({ layout });
  }

  function toggleBranch(branch: string) {
    const next = state.branches.includes(branch)
      ? state.branches.filter((b) => b !== branch)
      : [...state.branches, branch];
    mutate({ branches: next });
  }

  function toggleUser(user: string) {
    const next = state.users.includes(user)
      ? state.users.filter((u) => u !== user)
      : [...state.users, user];
    mutate({ users: next });
  }

  const showBranchFilter = branchList.length > 0 && state.groupBy !== 'branch';

  return (
    <div className="flex flex-col h-full gap-4 p-4">
      {/* Stale branch warning */}
      {staleBranches.length > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-yellow-300 bg-yellow-50 px-3 py-2 text-sm text-yellow-800 dark:border-yellow-700 dark:bg-yellow-950 dark:text-yellow-300">
          <span className="flex-1">
            Some selected branches are no longer in this date range:{' '}
            {staleBranches.join(', ')}. Clear?
          </span>
          <button
            className="font-medium underline hover:no-underline"
            onClick={() => mutate({ branches: [] })}
          >
            Clear
          </button>
        </div>
      )}

      {/* Header controls */}
      <AnalyticsControls
        state={state}
        teamId={teamId}
        branchList={branchList}
        showBranchFilter={showBranchFilter}
        showUserFilter={showUserFilter}
        teamMemberEmails={teamMemberEmails}
        filesMetric={filesMetric}
        filesMetrics={filesMetrics}
        visionMetric={visionMetric}
        productivityMetric={productivityMetric}
        changeSurfaceMetric={changeSurfaceMetric}
        attributeDefinitions={attributeDefinitions}
        onRangeToggle={handleRangeToggle}
        onCustomButtonClick={handleCustomButtonClick}
        formatCustomLabel={formatCustomLabel}
        onGroupByChange={handleGroupByChange}
        onToggleBranch={toggleBranch}
        onToggleUser={toggleUser}
        onLayoutToggle={handleLayoutToggle}
        onViewToggle={handleViewToggle}
        onFilesMetricChange={setFilesMetric}
        onVisionMetricChange={setVisionMetric}
        onProductivityMetricChange={setProductivityMetric}
        onChangeSurfaceMetricChange={setChangeSurfaceMetric}
      />

      {/* Custom date range picker dialog */}
      <DateRangePicker
        open={customPickerOpen}
        onOpenChange={setCustomPickerOpen}
        selected={calendarRange}
        onApply={handleCustomApply}
      />

      {/* Chart area */}
      {/* The four usage views are table documents backed by their own endpoints, so they bypass
          the timeline payload and its empty state entirely. Testing with a type predicate also
          narrows `state.view` for the chart branches below, which take the narrower union. */}
      <AnalyticsChartArea
        repoId={repoId}
        teamId={teamId}
        state={state}
        startDate={startDate}
        endDate={endDate}
        isFetching={timelineQuery.isFetching}
        isEmpty={isEmpty}
        sessions={timelineQuery.data ?? []}
        filesMetric={filesMetric}
        visionMetric={visionMetric}
        productivityMetric={productivityMetric}
        changeSurfaceMetric={changeSurfaceMetric}
        changeSurfaceTimeline={changeSurfaceQuery.data}
        changeSurfaceFetching={changeSurfaceQuery.isFetching}
        changeSurfaceError={changeSurfaceQuery.isError}
        onSessionClick={onSessionClick}
      />

      {/* Error modal */}
      {activeError != null && !errorDismissed && (
        <Dialog open onOpenChange={(open) => !open && setErrorDismissed(true)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Error</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              {activeError instanceof Error
                ? activeError.message
                : String(activeError)}
            </p>
            <DialogFooter>
              <Button onClick={() => setErrorDismissed(true)}>Dismiss</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
