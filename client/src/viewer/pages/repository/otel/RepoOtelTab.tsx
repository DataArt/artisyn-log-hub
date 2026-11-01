/**
 * The repository view's "OTEL" main tab (2026-10-30 otel-tabs-traces, Visual/UX notes).
 *
 * Reads the `otel*` URL state, polls the facts route with `useOtelLivePoll` (a fresh snapshot
 * every `OTEL_REPO_POLL_MS` while the period includes now, DD-20; grown `new` / `update` buckets
 * are outlined) and composes, top to bottom: the title row with the "Realtime data" badge, the
 * realtime notices and slow banner, the filter strip with the live indicator, the chart controls,
 * the chart, the KPI tiles, the cost structure, the cost flow, the query_source table and the
 * sessions table. "No access" on 403.
 *
 * Coverage (2026-10-30 otel-shared-receiver, DD-29): the `OtelCoverageBanner` under the title row
 * (its chips filter the sessions list by reason and switch to the Sessions tab), the "Sessions
 * with OTEL" KPI tile, and the `reason` empty state when none of the period's sessions has OTEL.
 */
import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { ApiError, fetchRepoOtelFacts } from '../../../api';
import type {
  OtelReasonKey,
  RepoOtelFactsResponse,
} from '../../../../models/repositories';
import {
  formatOtelPeriod,
  OTEL_PARAM_KEYS,
  otelPeriodIncludesNow,
  otelPeriodRange,
  otelStateFromParams,
  writeOtelState,
  type RepoOtelUrlState,
} from './otel-url-state';
import { snapshotOtelPollStep, useOtelLivePoll } from './useOtelLivePoll';
import { OTEL_REPO_POLL_MS } from './otel.constants';
import { OtelLiveIndicator } from './OtelLiveIndicator';
import {
  OtelRealtimeBadge,
  OtelRealtimeNotice,
  otelNoticeFromCounts,
} from './OtelRealtimeNotice';
import { OtelSlowUpdatesBanner } from './OtelSlowUpdatesBanner';
import { OtelFilterStrip } from './OtelFilterStrip';
import {
  OtelChartControls,
  OTEL_REPO_STACK_OPTIONS,
} from './OtelChartControls';
import { OtelCostChart } from './OtelCostChart';
import { OtelRepoKpiTiles } from './OtelKpiTiles';
import { OtelStructureSection } from './OtelStructureSection';
import { OtelCostFlow } from './OtelCostFlow';
import { otelFlowColumns } from './otel-cost-flow-layout';
import { OtelQuerySourceTable } from './OtelQuerySourceTable';
import { OtelSessionsTable } from './OtelSessionsTable';
import { OtelEmptyState } from './OtelEmptyState';
import { OtelCoverageBanner } from './OtelCoverageBanner';

export interface RepoOtelTabProps {
  repoId: number;
  teamId?: number;
  /** A coverage chip click: filter the sessions list by the reason and show the Sessions tab. */
  onReasonFilter?: (reason: OtelReasonKey) => void;
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Legend-hidden series, remembered per stack-by. */
interface HiddenState {
  stackBy: string;
  keys: ReadonlySet<string>;
}

const NO_KEYS: ReadonlySet<string> = new Set();

export function RepoOtelTab({
  repoId,
  teamId,
  onReasonFilter,
}: RepoOtelTabProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const url = useMemo(() => otelStateFromParams(searchParams), [searchParams]);
  const tz = useMemo(browserTimeZone, []);
  const [hidden, setHidden] = useState<HiddenState>({
    stackBy: '',
    keys: NO_KEYS,
  });
  const [isolated, setIsolated] = useState<string | null>(null);

  const patchUrl = useCallback(
    (patch: Partial<RepoOtelUrlState>) => {
      setSearchParams(
        (prev) =>
          writeOtelState(prev, { ...otelStateFromParams(prev), ...patch }),
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const resetKey = JSON.stringify([
    repoId,
    teamId ?? null,
    formatOtelPeriod(url.period),
    url.models,
    url.ccVersions,
    url.calls,
    url.interval,
    url.stackBy,
    tz,
  ]);

  const poll = useMemo(
    () =>
      snapshotOtelPollStep<RepoOtelFactsResponse>((signal) => {
        // A preset period ends "now" at every poll, so the range is recomputed each time.
        const { from, to } = otelPeriodRange(url.period);
        return fetchRepoOtelFacts(
          {
            repoId,
            teamId,
            from: from.toISOString(),
            to: to.toISOString(),
            models: url.models,
            ccVersions: url.ccVersions,
            calls: url.calls,
            interval: url.interval,
            stackBy: url.stackBy,
            tz,
          },
          signal,
        );
      }),
    // resetKey covers every input of the request.
    [resetKey],
  );

  const isLive = useCallback(
    () => otelPeriodIncludesNow(url.period),
    [url.period],
  );
  const isSlow = useCallback((s: RepoOtelFactsResponse) => s.slowUpdates, []);

  const live = useOtelLivePoll({
    resetKey,
    enabled: true,
    intervalMs: OTEL_REPO_POLL_MS,
    poll,
    isLive,
    isSlow,
  });
  const { state, error, isLoading } = live;

  const bucketKeys = useMemo(
    () => new Set((state?.buckets ?? []).map((b) => b.key)),
    [state],
  );
  const hiddenKeys = useMemo<ReadonlySet<string>>(() => {
    if (isolated !== null && url.stackBy === 'querySource') {
      return new Set([...bucketKeys].filter((k) => k !== isolated));
    }
    return hidden.stackBy === url.stackBy ? hidden.keys : NO_KEYS;
  }, [isolated, url.stackBy, bucketKeys, hidden]);

  const toggleKey = (key: string) => {
    const next = new Set(hiddenKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setIsolated(null);
    setHidden({ stackBy: url.stackBy, keys: next });
  };

  const isolate = (qs: string | null) => {
    setIsolated(qs);
    if (qs !== null && url.stackBy !== 'querySource')
      patchUrl({ stackBy: 'querySource' });
  };

  const openSession = (sessionId: string) => {
    const next = new URLSearchParams(searchParams);
    for (const key of OTEL_PARAM_KEYS) next.delete(key);
    next.delete('mtab');
    next.delete('tu');
    next.set('session', sessionId);
    next.set('tab', 'otel');
    setSearchParams(next);
  };

  if (error instanceof ApiError && error.statusCode === 403) {
    return (
      <div
        className="flex h-full items-center justify-center"
        data-testid="repo-otel-tab"
      >
        <p className="text-sm text-muted-foreground">No access</p>
      </div>
    );
  }

  const teamContext = teamId !== undefined;
  const showMonth = () =>
    patchUrl({ period: { kind: 'preset', preset: '30d' } });
  // N = 0 of M: the `reason` variant replaces the chart and tiles (Visual/UX notes).
  const noCoverage =
    state !== null &&
    state.coverage.otelSessions === 0 &&
    state.coverage.totalSessions > 0;
  const coverageBanner =
    state !== null ? (
      <OtelCoverageBanner
        coverage={state.coverage}
        onReasonFilter={onReasonFilter}
      />
    ) : null;

  return (
    <div className="h-full overflow-auto p-4" data-testid="repo-otel-tab">
      <div className="mx-auto max-w-[1400px] space-y-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-base font-semibold">Cost over time</h2>
          <OtelRealtimeBadge />
          <span className="text-xs text-muted-foreground">
            Claude Code per-call estimate (cost_usd) · bucketed by event time
          </span>
        </div>

        {isLoading && state === null ? (
          <Loader2 className="animate-spin" />
        ) : state === null ? (
          <p className="text-sm text-destructive">Error</p>
        ) : !state.hasOtel ? (
          noCoverage ? (
            <>
              {coverageBanner}
              <OtelEmptyState
                variant="reason"
                scope="repository"
                coverage={state.coverage}
                onShowMonth={showMonth}
              />
            </>
          ) : (
            <OtelEmptyState variant="A" scope="repository" />
          )
        ) : (
          <>
            {coverageBanner}
            <OtelRealtimeNotice
              input={otelNoticeFromCounts(state.realtime, 'repository')}
              filled={live.filled}
            />
            {state.slowUpdates && (
              <OtelSlowUpdatesBanner
                reason="old-hook"
                hookVersion={state.hookVersion}
              />
            )}
            <OtelFilterStrip
              value={url}
              onChange={patchUrl}
              modelOptions={state.filterOptions.models}
              ccVersionOptions={state.filterOptions.ccVersions}
              indicator={
                <OtelLiveIndicator
                  state={live.indicator}
                  scope="repository"
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
                scope="repository"
                coverage={state.coverage}
                onShowMonth={showMonth}
              />
            ) : !state.hasOtelInPeriod ? (
              <OtelEmptyState
                variant="C"
                scope="repository"
                onShowMonth={showMonth}
              />
            ) : (
              <>
                <OtelChartControls
                  value={url}
                  onChange={patchUrl}
                  stackByOptions={OTEL_REPO_STACK_OPTIONS}
                />
                <OtelCostChart
                  buckets={state.buckets}
                  interval={state.interval}
                  metric={url.metric}
                  stackBy={url.stackBy}
                  view={url.view}
                  cumulative={url.cumulative}
                  newBucketKeys={live.newKeys.buckets}
                  hiddenKeys={hiddenKeys}
                  onToggleKey={toggleKey}
                />
                <OtelRepoKpiTiles
                  kpis={state.kpis}
                  kpisPrev={state.kpisPrev}
                  buckets={state.buckets}
                  stackBy={url.stackBy}
                  coverage={state.coverage}
                />
                <OtelStructureSection
                  querySources={state.querySources}
                  isolated={url.stackBy === 'querySource' ? isolated : null}
                  onIsolate={isolate}
                />
                <OtelCostFlow
                  flows={state.flows}
                  columns={otelFlowColumns(teamContext)}
                  subtitle={
                    teamContext
                      ? 'model → user → branch (of the session) · same period and filters as the chart'
                      : 'model → branch (of the session) · same period and filters as the chart'
                  }
                />
                <OtelQuerySourceTable rows={state.querySources} />
                <OtelSessionsTable
                  sessions={state.sessions}
                  onOpen={openSession}
                />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
