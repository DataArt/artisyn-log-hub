/**
 * The Session Map tab (session-map): main session, workflow runs and agents as cards over time,
 * live or replayed. Wires `useSessionMapData` and `useSessionMapPlayback` to the header, cards,
 * side panel and timeline, and registers the Map's own poll as the session header's Refresh
 * action (DD-10 "Header refresh").
 *
 * - The selected card lives in the `smSel` URL param (DD-20): `main`, `group:<key>` or an agent
 *   id. An unknown id is ignored; the param is dropped when the session changes and when the tab
 *   unmounts.
 * - Poll errors (DD-10): before any state, or on 403 / 404, the session-logs error panel; with a
 *   state, a small "update failed" note in the header while polling continues.
 * - Render budget (DD-19): a `session-map:render-start` mark per render and a
 *   `session-map:render` measure in the commit effect.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ModelPricingMap } from '../../../../../models/pricing';
import type { RepoConfig } from '../../../../../models/repositories';
import { LazyFallback } from '../../../../components/LazyFallback';
import { getSessionLogsErrorMessage } from '../session-logs-error';
import { GroupColumn, MainCard, runningMinutes } from './SessionMapCards';
import { type SessionMapBadgeKind, SessionMapHeader } from './SessionMapHeader';
import { SessionMapSidePanel } from './SessionMapSidePanel';
import { SessionMapTimeline } from './SessionMapTimeline';
import {
  type AgentOrder,
  countersAt,
  type HighlightMode,
  highlightSet,
  stateAt,
} from './session-map-model';
import { COLUMN_GAP } from './session-map.constants';
import { formatClock } from './session-map-format';
import { useSessionMapData } from './useSessionMapData';
import { useSessionMapPlayback } from './useSessionMapPlayback';
import { useSessionMapSelection } from './useSessionMapSelection';

export interface SessionMapTabProps {
  repoId: number;
  sessionId: string;
  teamId?: number;
  firstPrompt: string | null;
  pricing: ModelPricingMap | undefined;
  repoConfig: RepoConfig | null;
  /** Called with the Map's poll on mount and with `null` on unmount. */
  registerRefresh: (fn: (() => void) | null) => void;
}

const RENDER_START = 'session-map:render-start';
const RENDER_END = 'session-map:render-end';
const RENDER_MEASURE = 'session-map:render';

function markRenderStart(): void {
  try {
    performance.mark(RENDER_START);
  } catch {
    // performance marks are diagnostics only
  }
}

function measureRender(): void {
  try {
    performance.mark(RENDER_END);
    performance.clearMeasures(RENDER_MEASURE);
    performance.measure(RENDER_MEASURE, RENDER_START, RENDER_END);
  } catch {
    // a missing start mark (or no Performance API) only loses the measurement
  }
}

function errorMessage(error: unknown): string {
  return getSessionLogsErrorMessage(
    error instanceof Error ? error : new Error(String(error)),
  );
}

export function SessionMapTab({
  repoId,
  sessionId,
  teamId,
  firstPrompt,
  pricing,
  repoConfig,
  registerRefresh,
}: SessionMapTabProps) {
  markRenderStart();
  useEffect(measureRender);

  const data = useSessionMapData({
    repoId,
    sessionId,
    teamId,
    pricing,
    repoConfig,
  });
  const { refresh, model, state } = data;

  useEffect(() => {
    registerRefresh(refresh);
    return () => registerRefresh(null);
  }, [registerRefresh, refresh]);

  const serverTimeMs = state ? Date.parse(state.serverTime) : NaN;
  const live = state?.liveness.live ?? false;
  const playback = useSessionMapPlayback({
    start: model?.timeline?.start ?? null,
    end: model?.timeline?.end ?? null,
    live,
    serverTimeMs: Number.isNaN(serverTimeMs) ? null : serverTimeMs,
    receivedAt: state?.receivedAt ?? 0,
  });

  const { selectedId, onSelect, clear } = useSessionMapSelection(
    `${repoId}|${sessionId}`,
    model,
  );

  // --- highlight / order -------------------------------------------------------
  const [highlight, setHighlight] = useState<HighlightMode>('none');
  const [order, setOrder] = useState<AgentOrder>('start');
  const highlighted = useMemo(
    () => (model ? highlightSet(model, highlight) : null),
    [model, highlight],
  );

  // --- render --------------------------------------------------------------------
  if (data.isLoading) return <LazyFallback />;
  if (data.fatal || state === null || model === null) {
    return (
      <div
        data-testid="session-map"
        className="flex h-full items-center justify-center p-6"
      >
        <p className="text-sm text-muted-foreground">
          {data.error !== null && data.error !== undefined
            ? errorMessage(data.error)
            : 'No session data yet.'}
        </p>
      </div>
    );
  }

  const t = playback.t ?? Number.POSITIVE_INFINITY;
  const atNow = playback.following && live;
  const counters = countersAt(model, t);
  const mainState = stateAt(model.main, t, { live, atNow });
  const badge: SessionMapBadgeKind = !live
    ? 'replay'
    : data.indicator === 'hidden' || data.indicator === 'idle'
      ? 'live-idle'
      : playback.following
        ? 'live'
        : 'live-paused';

  return (
    <div data-testid="session-map" className="flex flex-col gap-3 p-3 text-sm">
      <SessionMapHeader
        badge={badge}
        pausedAtLabel={playback.t !== null ? formatClock(playback.t) : null}
        firstPrompt={firstPrompt}
        counters={counters}
        updateFailed={data.error !== null && data.error !== undefined}
        highlight={highlight}
        onHighlightChange={setHighlight}
        order={order}
        onOrderChange={setOrder}
      />
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <MainCard
            node={model.main}
            state={mainState}
            runningMin={runningMinutes(mainState, model.main.f, t)}
            selected={selectedId === 'main'}
            treeCost={model.treeCost}
            onSelect={onSelect}
          />
          {model.columns.length === 0 ? (
            <div className="py-6 text-center text-muted-foreground">
              No groups
            </div>
          ) : (
            <div
              className="flex items-start overflow-x-auto pb-2"
              style={{ gap: COLUMN_GAP }}
            >
              {model.columns.map((column) => (
                <GroupColumn
                  key={column.key}
                  column={column}
                  order={order}
                  t={t}
                  live={live}
                  atNow={atNow}
                  highlight={highlighted}
                  selectedId={selectedId}
                  maxAgentCost={model.maxAgentCost}
                  onSelect={onSelect}
                />
              ))}
            </div>
          )}
        </div>
        {selectedId !== null && (
          <SessionMapSidePanel
            key={selectedId}
            model={model}
            selectedId={selectedId}
            t={t}
            parsed={data.parsed}
            pricing={pricing}
            onSetT={playback.setT}
            onClose={clear}
          />
        )}
      </div>
      {model.timeline !== null && playback.t !== null ? (
        <SessionMapTimeline
          timeline={model.timeline}
          t={playback.t}
          live={live}
          following={playback.following}
          playing={playback.playing}
          speed={playback.speed}
          onScrub={playback.setT}
          onPlay={playback.play}
          onPause={playback.pause}
          onSpeedChange={playback.setSpeed}
          onEnd={playback.goEnd}
          onLive={playback.goLive}
        />
      ) : (
        <div
          data-testid="session-map-timeline"
          className="rounded-lg border bg-white p-3 text-center text-xs text-muted-foreground"
        >
          No timed activity yet
        </div>
      )}
    </div>
  );
}
