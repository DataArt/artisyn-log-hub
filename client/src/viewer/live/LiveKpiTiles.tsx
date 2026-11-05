/**
 * KPI tiles of the Live view pane (2026-11-04 otel-live-view, FR-5 / DD-23), built from the
 * shared `OtelKpiTile` / `OtelTokensTile`. Totals are the session lifetime ("since start");
 * Cost/min covers the last 5 min. Parent nodes show live sessions / agents, session nodes the
 * live agents and running time, agent nodes Cost, Calls, Model and Running.
 */
import type { OtelLiveNode, OtelLiveView } from '../../models/otel-live';
import {
  OtelKpiTile,
  OtelTokensTile,
  type OtelTokenTotals,
} from '../pages/repository/otel/OtelKpiTile';
import {
  formatCount,
  formatMicrosUsd,
} from '../pages/repository/otel/otel-format';
import { formatLiveDuration } from './live-format';

function tokenTotals(node: OtelLiveNode): OtelTokenTotals {
  const n = (v: string) => Number(v) || 0;
  return {
    input: n(node.totals.inputTokens),
    output: n(node.totals.outputTokens),
    cacheRead: n(node.totals.cacheReadTokens),
    cacheWrite: n(node.totals.cacheWriteTokens),
  };
}

/** The model with the most calls in the window, else the newest call's model. */
function topModel(view: OtelLiveView): string | null {
  const calls = new Map<string, number>();
  for (const b of view.buckets) {
    if (b.model === '') continue;
    calls.set(b.model, (calls.get(b.model) ?? 0) + b.calls);
  }
  let best: string | null = null;
  let bestCalls = -1;
  for (const [m, c] of calls) {
    if (c > bestCalls) {
      best = m;
      bestCalls = c;
    }
  }
  return best ?? view.calls?.find((c) => c.model)?.model ?? null;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function LiveKpiTiles({
  node,
  view,
}: {
  node: OtelLiveNode;
  view: OtelLiveView;
}) {
  const t = node.totals;
  const cost = (
    <OtelKpiTile
      label="Cost"
      hint="OTEL cost of the sessions under this node since they started."
      value={formatMicrosUsd(t.costUsdMicros)}
      secondary="since start"
      testId="live-kpi-cost"
    />
  );
  const running = (
    <OtelKpiTile
      label="Running"
      hint="Wall-clock time from the first to the latest OTEL API call."
      value={formatLiveDuration(t.runningMs)}
      testId="live-kpi-running"
    />
  );

  if (node.type === 'agent') {
    return (
      <div className="flex flex-wrap gap-3" data-testid="live-kpi-tiles">
        {cost}
        <OtelKpiTile
          label="Calls"
          hint="OTEL API calls of this agent since it started."
          value={formatCount(t.calls)}
          secondary="since start"
          testId="live-kpi-calls"
        />
        <OtelKpiTile
          label="Model"
          hint="The model this agent called most in the last 2 h."
          value={
            <span className="block truncate text-sm">
              {topModel(view) ?? '—'}
            </span>
          }
          secondary="last 2 h"
          testId="live-kpi-model"
        />
        {running}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-3" data-testid="live-kpi-tiles">
      {cost}
      <OtelTokensTile tokens={tokenTotals(node)} />
      {node.type === 'session' ? (
        <OtelKpiTile
          label="Agents live"
          hint="Agents of this session with an OTEL API call in the last 10 min."
          value={formatCount(t.liveAgents)}
          secondary={`running ${formatLiveDuration(t.runningMs)}`}
          testId="live-kpi-agents"
        />
      ) : (
        <OtelKpiTile
          label="Live sessions / agents"
          hint="Distinct live sessions and agents under this node; a session placed in several repos or teams counts once."
          value={`${t.liveSessions} / ${t.liveAgents}`}
          secondary={`${plural(t.liveSessions, 'session', 'sessions')} · longest ${formatLiveDuration(t.runningMs)}`}
          testId="live-kpi-live"
        />
      )}
      <OtelKpiTile
        label="Cost/min"
        hint="OTEL cost of the last 5 min divided by 5."
        value={`${formatMicrosUsd(view.costPerMinUsdMicros)}/min`}
        secondary="last 5 min"
        testId="live-kpi-cost-rate"
      />
    </div>
  );
}
