/**
 * The team page's "OTEL" tab (2026-10-30 otel-tabs-traces, DD-29, FR-33 / FR-34): OTEL cost of
 * every team repository over a period, the distinct sessions counted once.
 *
 * Top to bottom: the title row (repositories, access mode, the caller's role, the "Realtime data"
 * badge), realtime notices and the slow banner, the filter strip (period, repository, people,
 * model, Claude Code, calls) with the live indicator and Pause, the chart controls, the chart
 * (stacked by person by default, the top `OTEL_TEAM_TOP_PEOPLE` named and the rest folded into
 * "others (N)"), the KPI tiles plus "per active person" and "repositories", the cost structure,
 * the cost flow (model → person → repository, or repository · branch), and the People and
 * Repositories tables. Filters live in local state, like the page's own tab state; the same 30 s
 * snapshot polling and highlight rule as the repository tab (DD-20). "No access" on 403.
 *
 * Coverage (2026-10-30 otel-shared-receiver, DD-29): the same `OtelCoverageBanner` as the
 * repository tab, counted across the team's repositories, with chips that only label (a team has
 * no single sessions list to filter); the "Sessions with OTEL" tile; the `reason` empty state when
 * none of the period's sessions has OTEL.
 */
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { ApiError, fetchTeamOtelFacts } from '../../../api';
import { routes } from '../../../hooks/useHashRoute';
import type {
  OtelCallsFilter,
  OtelInterval,
} from '../../../../models/repositories';
import type {
  TeamAccessMode,
  TeamOtelFactsResponse,
  TeamOtelStackBy,
} from '../../../../models/teams';
import {
  formatOtelPeriod,
  OTEL_DEFAULT_PERIOD,
  otelPeriodIncludesNow,
  otelPeriodRange,
  type OtelChartView,
  type OtelMetric,
  type OtelPeriod,
} from '../../repository/otel/otel-url-state';
import {
  snapshotOtelPollStep,
  useOtelLivePoll,
} from '../../repository/otel/useOtelLivePoll';
import { OTEL_REPO_POLL_MS } from '../../repository/otel/otel.constants';
import { OtelLiveIndicator } from '../../repository/otel/OtelLiveIndicator';
import {
  OtelRealtimeBadge,
  OtelRealtimeNotice,
  otelNoticeFromCounts,
} from '../../repository/otel/OtelRealtimeNotice';
import { OtelSlowUpdatesBanner } from '../../repository/otel/OtelSlowUpdatesBanner';
import { OtelFilterStrip } from '../../repository/otel/OtelFilterStrip';
import { OtelChartControls } from '../../repository/otel/OtelChartControls';
import { OtelCostChart } from '../../repository/otel/OtelCostChart';
import { OtelRepoKpiTiles } from '../../repository/otel/OtelKpiTiles';
import { OtelKpiTile } from '../../repository/otel/OtelKpiTile';
import { OtelStructureSection } from '../../repository/otel/OtelStructureSection';
import { OtelCostFlow } from '../../repository/otel/OtelCostFlow';
import { OtelEmptyState } from '../../repository/otel/OtelEmptyState';
import { OtelCoverageBanner } from '../../repository/otel/OtelCoverageBanner';
import {
  formatCount,
  formatMicrosUsd,
  microsToUsd,
  otelKpiChange,
} from '../../repository/otel/otel-format';
import {
  otelTeamDisplayBuckets,
  otelTeamDisplayFlows,
  otelTeamDisplayNewKeys,
  otelTeamPeopleFold,
} from './team-otel-display';
import { OtelPeopleTable } from './OtelPeopleTable';
import { OtelRepositoriesTable } from './OtelRepositoriesTable';

export interface TeamOtelTabProps {
  teamId: number;
  accessMode: TeamAccessMode;
  /** The caller's role, shown in the title row ("owner", "manager", "member"). */
  role: string;
}

interface TeamOtelState {
  period: OtelPeriod;
  repoId: number | null;
  userId: number | null;
  models: string[];
  ccVersions: string[];
  calls: OtelCallsFilter;
  metric: OtelMetric;
  interval: 'auto' | OtelInterval;
  stackBy: TeamOtelStackBy;
  view: OtelChartView;
  cumulative: boolean;
}

const INITIAL_STATE: TeamOtelState = {
  period: OTEL_DEFAULT_PERIOD,
  repoId: null,
  userId: null,
  models: [],
  ccVersions: [],
  calls: 'all',
  metric: 'cost',
  interval: 'auto',
  stackBy: 'person',
  view: 'absolute',
  cumulative: false,
};

const TEAM_STACK_OPTIONS = [
  { value: 'person', label: 'Person' },
  { value: 'repository', label: 'Repository' },
  { value: 'structure', label: 'Structure' },
  { value: 'model', label: 'Model' },
  { value: 'querySource', label: 'query_source' },
] as const;

const NO_KEYS: ReadonlySet<string> = new Set();

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const usd = (m: string | null | undefined) => microsToUsd(m);

export function TeamOtelTab({ teamId, accessMode, role }: TeamOtelTabProps) {
  const navigate = useNavigate();
  const tz = useMemo(browserTimeZone, []);
  const [s, setS] = useState<TeamOtelState>(INITIAL_STATE);
  const [hidden, setHidden] = useState<{
    stackBy: string;
    keys: ReadonlySet<string>;
  }>({ stackBy: '', keys: NO_KEYS });
  const [flowByBranch, setFlowByBranch] = useState(false);
  const [isolated, setIsolated] = useState<string | null>(null);
  const patch = useCallback(
    (p: Partial<TeamOtelState>) => setS((prev) => ({ ...prev, ...p })),
    [],
  );

  const resetKey = JSON.stringify([
    teamId,
    formatOtelPeriod(s.period),
    s.repoId,
    s.userId,
    s.models,
    s.ccVersions,
    s.calls,
    s.interval,
    s.stackBy,
    tz,
  ]);

  const poll = useMemo(
    () =>
      snapshotOtelPollStep<TeamOtelFactsResponse>((signal) => {
        const { from, to } = otelPeriodRange(s.period);
        return fetchTeamOtelFacts(
          {
            teamId,
            from: from.toISOString(),
            to: to.toISOString(),
            repoIds: s.repoId === null ? [] : [s.repoId],
            userIds: s.userId === null ? [] : [s.userId],
            models: s.models,
            ccVersions: s.ccVersions,
            calls: s.calls,
            interval: s.interval,
            stackBy: s.stackBy,
            tz,
          },
          signal,
        );
      }),
    // resetKey covers every input of the request.
    [resetKey],
  );
  const isLive = useCallback(() => otelPeriodIncludesNow(s.period), [s.period]);
  const isSlow = useCallback((r: TeamOtelFactsResponse) => r.slowUpdates, []);
  const live = useOtelLivePoll({
    resetKey,
    enabled: true,
    intervalMs: OTEL_REPO_POLL_MS,
    poll,
    isLive,
    isSlow,
  });
  const { state, error, isLoading } = live;

  const display = useMemo(
    () => (state === null ? null : otelTeamDisplayBuckets(state, s.stackBy)),
    [state, s.stackBy],
  );
  const flows = useMemo(
    () =>
      state === null
        ? []
        : otelTeamDisplayFlows(state.flows, otelTeamPeopleFold(state)),
    [state],
  );
  const newBucketKeys = useMemo(
    () =>
      display === null
        ? NO_KEYS
        : otelTeamDisplayNewKeys(live.newKeys.buckets, display.displayKeyOf),
    [display, live.newKeys.buckets],
  );
  const hiddenKeys = useMemo<ReadonlySet<string>>(() => {
    if (isolated !== null && s.stackBy === 'querySource' && display) {
      return new Set(
        display.buckets.map((b) => b.key).filter((k) => k !== isolated),
      );
    }
    return hidden.stackBy === s.stackBy ? hidden.keys : NO_KEYS;
  }, [isolated, s.stackBy, display, hidden]);
  const toggleKey = (key: string) => {
    const next = new Set(hiddenKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setIsolated(null);
    setHidden({ stackBy: s.stackBy, keys: next });
  };
  const isolate = (qs: string | null) => {
    setIsolated(qs);
    if (qs !== null && s.stackBy !== 'querySource') {
      patch({ stackBy: 'querySource' });
    }
  };

  const openRepo = (repoId: number) => {
    const q = new URLSearchParams({ mtab: 'otel' });
    const period = formatOtelPeriod(s.period);
    if (period !== formatOtelPeriod(OTEL_DEFAULT_PERIOD)) {
      q.set('otelPeriod', period);
    }
    void navigate({
      pathname: routes.teamRepo(teamId, repoId),
      search: `?${q.toString()}`,
    });
  };

  if (error instanceof ApiError && error.statusCode === 403) {
    return (
      <div
        className="flex h-full items-center justify-center p-6"
        data-testid="team-otel-tab"
      >
        <p className="text-sm text-muted-foreground">No access</p>
      </div>
    );
  }

  const showMonth = () => patch({ period: { kind: 'preset', preset: '30d' } });
  // N = 0 of M: the `reason` variant replaces the chart and tiles (Visual/UX notes).
  const noCoverage =
    state !== null &&
    state.coverage.otelSessions === 0 &&
    state.coverage.totalSessions > 0;

  return (
    <div className="space-y-4" data-testid="team-otel-tab">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">Team cost over time</h2>
        <OtelRealtimeBadge />
        <span className="text-xs text-muted-foreground">
          Claude Code per-call estimate (cost_usd) ·{' '}
          {state
            ? `${formatCount(state.filterOptions.repositories.length)} repositories · `
            : ''}
          {accessMode} team · you: {role}
        </span>
      </div>

      {isLoading && state === null ? (
        <Loader2 className="animate-spin" />
      ) : state === null || display === null ? (
        <p className="text-sm text-destructive">Error</p>
      ) : !state.hasOtel ? (
        noCoverage ? (
          <>
            <OtelCoverageBanner coverage={state.coverage} />
            <OtelEmptyState
              variant="reason"
              scope="team"
              coverage={state.coverage}
              onShowMonth={showMonth}
            />
          </>
        ) : (
          <OtelEmptyState variant="A" scope="team" />
        )
      ) : (
        <>
          <OtelCoverageBanner coverage={state.coverage} />
          <OtelRealtimeNotice
            input={otelNoticeFromCounts(state.realtime, 'team')}
            filled={live.filled}
          />
          {state.slowUpdates && (
            <OtelSlowUpdatesBanner
              reason="old-hook"
              hookVersion={state.hookVersion}
            />
          )}
          <OtelFilterStrip
            value={s}
            onChange={patch}
            modelOptions={state.filterOptions.models}
            ccVersionOptions={state.filterOptions.ccVersions}
            pickers={[
              {
                label: 'Repository',
                allLabel: 'All repositories',
                value: s.repoId === null ? '' : String(s.repoId),
                options: state.filterOptions.repositories.map((r) => ({
                  value: String(r.repoId),
                  label: r.repoUrl,
                })),
                onChange: (v) => patch({ repoId: v ? Number(v) : null }),
                testId: 'otel-repository-filter',
              },
              {
                label: 'People',
                allLabel: 'Everyone',
                value: s.userId === null ? '' : String(s.userId),
                options: state.filterOptions.people.map((p) => ({
                  value: String(p.userId),
                  label: p.email,
                })),
                onChange: (v) => patch({ userId: v ? Number(v) : null }),
                testId: 'otel-people-filter',
              },
            ]}
            indicator={
              <OtelLiveIndicator
                state={live.indicator}
                scope="team"
                slowReason="old-hook"
                hookVersion={state.hookVersion}
                lastUpdatedAt={live.lastUpdatedAt}
                paused={live.paused}
                onPausedChange={live.setPaused}
                onResume={live.refresh}
              />
            }
          />
          {noCoverage ? (
            <OtelEmptyState
              variant="reason"
              scope="team"
              coverage={state.coverage}
              onShowMonth={showMonth}
            />
          ) : !state.hasOtelInPeriod ? (
            <OtelEmptyState variant="C" scope="team" onShowMonth={showMonth} />
          ) : (
            <>
              <OtelChartControls
                value={s}
                onChange={patch}
                stackByOptions={TEAM_STACK_OPTIONS}
              />
              <OtelCostChart
                buckets={display.buckets}
                interval={state.interval}
                metric={s.metric}
                stackBy={s.stackBy}
                view={s.view}
                cumulative={s.cumulative}
                newBucketKeys={newBucketKeys}
                hiddenKeys={hiddenKeys}
                onToggleKey={toggleKey}
              />
              <OtelRepoKpiTiles
                kpis={state.kpis}
                kpisPrev={state.kpisPrev}
                buckets={state.buckets}
                stackBy={s.stackBy}
                showPerUser={false}
                coverage={state.coverage}
              />
              <div className="flex flex-wrap gap-2">
                <OtelKpiTile
                  testId="otel-kpi-per-person"
                  label="Per active person"
                  hint="Total cost divided by the number of people with at least one call in the period and filters."
                  value={formatMicrosUsd(
                    state.kpis.perActivePersonCostUsdMicros,
                  )}
                  secondary={`${formatCount(state.kpis.users)} active`}
                  change={otelKpiChange(
                    usd(state.kpis.perActivePersonCostUsdMicros),
                    usd(state.kpisPrev?.perActivePersonCostUsdMicros),
                  )}
                />
                <OtelKpiTile
                  testId="otel-kpi-repositories"
                  label="Repositories"
                  hint="Team repositories with OTEL data in the period and filters; live = data in the last 10 minutes."
                  value={formatCount(state.kpis.repositories)}
                  secondary={`${formatCount(state.kpis.repositoriesLive)} live`}
                  change={otelKpiChange(
                    state.kpis.repositories,
                    state.kpisPrev?.repositories,
                  )}
                />
              </div>
              <OtelStructureSection
                querySources={state.querySources}
                isolated={s.stackBy === 'querySource' ? isolated : null}
                onIsolate={isolate}
              />
              <OtelCostFlow
                flows={flows}
                columns={[
                  'model',
                  'user',
                  flowByBranch ? 'repositoryBranch' : 'repository',
                ]}
                subtitle={
                  <span className="inline-flex items-center gap-2">
                    model → person → repository
                    {flowByBranch ? ' · branch' : ''} · same period and filters
                    as the chart
                    <button
                      type="button"
                      className="text-blue-600 hover:underline"
                      onClick={() => setFlowByBranch((v) => !v)}
                      data-testid="otel-flow-branch-switch"
                    >
                      {flowByBranch ? 'show repository' : 'show branch'}
                    </button>
                  </span>
                }
              />
              <OtelPeopleTable
                people={state.people}
                selectedUserId={s.userId}
                onSelect={(userId) => patch({ userId })}
              />
              <OtelRepositoriesTable
                repositories={state.repositories}
                onOpen={openRepo}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
