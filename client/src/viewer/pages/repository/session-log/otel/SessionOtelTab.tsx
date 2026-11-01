/**
 * The session detail pane's "OTEL" tab (2026-10-30 otel-tabs-traces, `session-otel-tab.svg`).
 *
 * Polls the session OTEL route with `useOtelLivePoll` (a snapshot, then `since=` deltas every
 * `OTEL_SESSION_POLL_MS` while the session is live, DD-20) and composes, top to bottom: the header
 * ("Cost: Claude Code estimate (cost_usd) · hook X · traces on|off") with the "Realtime data"
 * badge and the live indicator, the realtime notices and slow banner, the chart controls and
 * chart, the KPI tiles, cost by query_source, and the traces section (navigator, minimap,
 * waterfall, span details) — or empty state A (no OTEL) / B (no traces).
 *
 * The root's `otel-status` (2026-10-30 otel-shared-receiver): without OTEL data and with state
 * `none` / `unknown` or no status at all, `OtelReasonPanel` says why; state `partial` adds
 * `OtelPartialBanner` above the chart; `ok` changes nothing.
 *
 * Chart settings and legend state are local (the session tab has no URL state of its own); any
 * change of interval / stack-by reloads a snapshot (DD-19).
 */
import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { ApiError, fetchSessionOtel } from '../../../../api';
import type {
  OtelInterval,
  SessionOtelStackBy,
} from '../../../../../models/repositories';
import { OTEL_SESSION_POLL_MS } from '../../otel/otel.constants';
import {
  sessionOtelPollStep,
  useOtelLivePoll,
} from '../../otel/useOtelLivePoll';
import { OtelLiveIndicator } from '../../otel/OtelLiveIndicator';
import {
  OtelRealtimeBadge,
  OtelRealtimeNotice,
  otelNoticeFromSession,
} from '../../otel/OtelRealtimeNotice';
import { OtelSlowUpdatesBanner } from '../../otel/OtelSlowUpdatesBanner';
import {
  OtelChartControls,
  type OtelChartControlsValue,
} from '../../otel/OtelChartControls';
import { OtelCostChart } from '../../otel/OtelCostChart';
import { OtelSessionKpiTiles } from '../../otel/OtelKpiTiles';
import { OtelStructureSection } from '../../otel/OtelStructureSection';
import { OtelEmptyState } from '../../otel/OtelEmptyState';
import { OtelReasonPanel } from '../../otel/OtelReasonPanel';
import { OtelPartialBanner } from '../../otel/OtelPartialBanner';
import type { OtelStatusDto } from '../../../../../models/repositories';
import { assembleOtelTraces } from './otel-trace-assembly';
import { SessionOtelTraces } from './SessionOtelTraces';
import {
  otelSessionDerivedKpis,
  useOtelKpiHighlight,
} from './session-otel-kpis';

export interface SessionOtelTabProps {
  repoId: number;
  sessionId: string;
  teamId?: number;
}

const STACK_OPTIONS = [
  { value: 'structure', label: 'Structure' },
  { value: 'querySource', label: 'query_source' },
  { value: 'model', label: 'Model' },
] as const;

const INTERVAL_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: '5m', label: '5 min' },
  { value: '1h', label: '1 h' },
] as const;

const DEFAULT_CHART: OtelChartControlsValue<SessionOtelStackBy> = {
  metric: 'cost',
  stackBy: 'structure',
  interval: 'auto',
  view: 'absolute',
  cumulative: false,
};

const NO_KEYS: ReadonlySet<string> = new Set();

/** The session route has no `1d` interval; the controls never offer it. */
function sessionInterval(i: 'auto' | OtelInterval): 'auto' | '5m' | '1h' {
  return i === '1d' ? '1h' : i;
}

/**
 * Whether a session without OTEL data gets the reason panel: no status reported (an older hook)
 * or a status that says nothing arrived. `ok` / `partial` without data on the server means the
 * data is still on its way, so the plain empty state stays.
 */
function showsReasonPanel(otelStatus: OtelStatusDto | null): boolean {
  return (
    otelStatus === null ||
    otelStatus.state === 'none' ||
    otelStatus.state === 'unknown'
  );
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function SessionOtelTab({
  repoId,
  sessionId,
  teamId,
}: SessionOtelTabProps) {
  const [chart, setChart] = useState(DEFAULT_CHART);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(NO_KEYS);
  const [isolated, setIsolated] = useState<string | null>(null);
  const tz = useMemo(browserTimeZone, []);
  const interval = sessionInterval(chart.interval);

  const poll = useMemo(
    () =>
      sessionOtelPollStep((since, signal) =>
        fetchSessionOtel(
          {
            repoId,
            sessionId,
            teamId,
            interval,
            stackBy: chart.stackBy,
            tz,
            since,
          },
          signal,
        ),
      ),
    [repoId, sessionId, teamId, interval, chart.stackBy, tz],
  );

  const live = useOtelLivePoll({
    resetKey: JSON.stringify([
      repoId,
      sessionId,
      teamId ?? null,
      interval,
      chart.stackBy,
      tz,
    ]),
    enabled: true,
    intervalMs: OTEL_SESSION_POLL_MS,
    poll,
    isLive: (s) => s.status.live,
    isSlow: (s) => s.status.slowUpdates,
  });
  const { state, error, isLoading } = live;

  const turns = useMemo(
    () => (state ? assembleOtelTraces(state.spans, state.calls) : []),
    [state],
  );
  const derived = useMemo(
    () => otelSessionDerivedKpis(turns, state?.calls ?? []),
    [turns, state],
  );
  const kpiHighlight = useOtelKpiHighlight(state?.kpis ?? null, derived);

  const bucketKeys = useMemo(
    () => new Set((state?.buckets ?? []).map((b) => b.key)),
    [state],
  );
  const hiddenKeys = useMemo<ReadonlySet<string>>(
    () =>
      isolated !== null && chart.stackBy === 'querySource'
        ? new Set([...bucketKeys].filter((k) => k !== isolated))
        : hidden,
    [isolated, chart.stackBy, bucketKeys, hidden],
  );

  const patchChart = (patch: Partial<typeof chart>) => {
    if (patch.stackBy !== undefined && patch.stackBy !== chart.stackBy) {
      setHidden(NO_KEYS);
      setIsolated(null);
    }
    setChart((prev) => ({ ...prev, ...patch }));
  };

  const toggleKey = (key: string) => {
    const next = new Set(hiddenKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setIsolated(null);
    setHidden(next);
  };

  const isolate = (qs: string | null) => {
    setIsolated(qs);
    if (qs !== null && chart.stackBy !== 'querySource') {
      setHidden(NO_KEYS);
      setChart((prev) => ({ ...prev, stackBy: 'querySource' }));
    }
  };

  if (error instanceof ApiError && error.statusCode === 403) {
    return (
      <div className="p-4" data-testid="session-otel-tab">
        <p className="text-sm text-muted-foreground">No access</p>
      </div>
    );
  }

  const status = state?.status;

  return (
    <div className="space-y-4 p-4" data-testid="session-otel-tab">
      {isLoading && state === null ? (
        <Loader2 className="animate-spin" />
      ) : state === null || status === undefined ? (
        <p className="text-sm text-destructive">Could not load OTEL data.</p>
      ) : !status.hasOtel ? (
        showsReasonPanel(status.otelStatus) ? (
          <OtelReasonPanel status={status.otelStatus} />
        ) : (
          <OtelEmptyState variant="A" scope="session" />
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-xs" data-testid="session-otel-header">
              Cost: Claude Code estimate (cost_usd) · hook{' '}
              {status.otelHookVersion ?? 'unknown'} · traces{' '}
              {status.hasSpans ? 'on' : 'off'}
            </span>
            <OtelRealtimeBadge />
            <OtelLiveIndicator
              state={live.indicator}
              scope="session"
              slowReason={status.slowReason}
              hookVersion={status.otelHookVersion}
              lastUpdatedAt={live.lastUpdatedAt}
              paused={live.paused}
              onPausedChange={live.setPaused}
              onResume={live.refresh}
            />
          </div>
          <OtelRealtimeNotice
            input={otelNoticeFromSession(status.realtime)}
            filled={live.filled}
          />
          {status.slowUpdates && status.slowReason !== null && (
            <OtelSlowUpdatesBanner
              reason={status.slowReason}
              hookVersion={status.otelHookVersion}
            />
          )}
          {status.otelStatus?.state === 'partial' && (
            <OtelPartialBanner status={status.otelStatus} />
          )}
          <section className="space-y-2">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <h3 className="text-sm font-semibold">Session cost over time</h3>
              <span className="text-xs text-muted-foreground">
                session tree · by event.timestamp
              </span>
            </div>
            <OtelChartControls
              value={chart}
              onChange={patchChart}
              stackByOptions={STACK_OPTIONS}
              intervalOptions={INTERVAL_OPTIONS}
            />
            <OtelCostChart
              buckets={state.buckets}
              interval={state.interval}
              metric={chart.metric}
              stackBy={chart.stackBy}
              view={chart.view}
              cumulative={chart.cumulative}
              newBucketKeys={live.newKeys.buckets}
              hiddenKeys={hiddenKeys}
              onToggleKey={toggleKey}
              height={240}
            />
          </section>
          {state.kpis && (
            <OtelSessionKpiTiles
              kpis={state.kpis}
              calls={state.calls}
              derived={derived}
              highlighted={kpiHighlight}
            />
          )}
          {state.querySources && state.querySources.length > 0 && (
            <OtelStructureSection
              querySources={state.querySources}
              isolated={chart.stackBy === 'querySource' ? isolated : null}
              onIsolate={isolate}
            />
          )}
          {status.hasSpans && turns.length > 0 ? (
            <SessionOtelTraces
              turns={turns}
              calls={state.calls}
              attributesMasked={status.attributesMasked}
              newSpanKeys={live.newKeys.spans}
            />
          ) : (
            <OtelEmptyState variant="B" hookVersion={status.otelHookVersion} />
          )}
        </>
      )}
    </div>
  );
}
