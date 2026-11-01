/**
 * The KPI rows of the OTEL tabs (2026-10-30 otel-tabs-traces, Visual/UX notes, DD-28).
 *
 * - `OtelRepoKpiTiles` — repository / team: total cost, per day, per session, API calls, hidden
 *   cost, sessions, each with the change vs `kpisPrev`; sparklines (from `buckets`) on total,
 *   per day, API calls and hidden cost; a second row with tokens by type, cache read ratio and
 *   per user (left out on the team tab, where it equals "per active person"); with `coverage`
 *   (2026-10-30 otel-shared-receiver) also "Sessions with OTEL" — `N / M`, `<pct> % coverage ·
 *   <users> users`.
 * - `OtelSessionKpiTiles` — session: OTEL cost, hidden, API calls, turns (running), sub-agents,
 *   waiting for you; a further row with tokens by type and cache read ratio summed from `calls`.
 */
import type {
  OtelBucket,
  OtelCallRow,
  OtelCoverage,
  OtelRepoKpis,
  OtelSessionKpis,
} from '../../../../models/repositories';
import { formatDuration } from '../../../lib/format';
import { otelDailySparkline, otelSparkline } from './otel-chart-data';
import {
  formatCount,
  formatMicrosUsd,
  formatShare,
  microsToUsd,
  otelCacheReadRatio,
  otelKpiChange,
} from './otel-format';
import {
  OtelCacheRatioTile,
  OtelKpiTile,
  OtelTokensTile,
  type OtelTokenTotals,
} from './OtelKpiTile';

const costOf = (b: OtelBucket) => microsToUsd(b.costUsdMicros) ?? 0;
const callsOf = (b: OtelBucket) => b.calls;

function usd(m: string | null | undefined): number | null {
  return microsToUsd(m);
}

export interface OtelRepoKpiTilesProps {
  kpis: OtelRepoKpis;
  kpisPrev: OtelRepoKpis | null;
  buckets: readonly OtelBucket[];
  /** The hidden-cost sparkline needs structure buckets. */
  stackBy: string;
  /** Team tab: no per-user tile (DD-29). */
  showPerUser?: boolean;
  /** OTEL coverage of the scope (DD-29); adds the "Sessions with OTEL" tile. */
  coverage?: OtelCoverage;
}

/** `<round(N/M·100)> % coverage · <users> users` (Visual/UX notes); 0 % for an empty scope. */
export function otelCoverageSecondary(coverage: OtelCoverage): string {
  const pct =
    coverage.totalSessions > 0
      ? Math.round((coverage.otelSessions / coverage.totalSessions) * 100)
      : 0;
  return `${pct} % coverage · ${formatCount(coverage.otelUsers)} user${coverage.otelUsers === 1 ? '' : 's'}`;
}

export function OtelRepoKpiTiles({
  kpis,
  kpisPrev,
  buckets,
  stackBy,
  showPerUser = true,
  coverage,
}: OtelRepoKpiTilesProps) {
  const p = kpisPrev;
  const tokens: OtelTokenTotals = {
    input: Number(kpis.inputTokens) || 0,
    output: Number(kpis.outputTokens) || 0,
    cacheRead: Number(kpis.cacheReadTokens) || 0,
    cacheWrite: Number(kpis.cacheWriteTokens) || 0,
  };
  return (
    <div className="space-y-2" data-testid="otel-kpi-tiles">
      {/* A grid, not flex-wrap: a tile that wraps (the 7th, "Sessions with OTEL") keeps one
          column's width instead of stretching across the whole row. */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
        <OtelKpiTile
          testId="otel-kpi-total"
          label="Total OTEL cost"
          hint="Sum of Claude Code's per-call cost estimate (cost_usd) over the period and filters."
          value={formatMicrosUsd(kpis.totalCostUsdMicros)}
          secondary="Claude Code estimate"
          change={otelKpiChange(
            usd(kpis.totalCostUsdMicros),
            usd(p?.totalCostUsdMicros),
          )}
          sparkline={otelSparkline(buckets, costOf)}
        />
        <OtelKpiTile
          testId="otel-kpi-per-day"
          label="Per day"
          hint="Total cost divided by the number of days with at least one call."
          value={formatMicrosUsd(kpis.perDayCostUsdMicros)}
          secondary={`${formatCount(kpis.activeDays)} active day${kpis.activeDays === 1 ? '' : 's'}`}
          change={otelKpiChange(
            usd(kpis.perDayCostUsdMicros),
            usd(p?.perDayCostUsdMicros),
          )}
          sparkline={otelDailySparkline(buckets, costOf)}
        />
        <OtelKpiTile
          testId="otel-kpi-per-session"
          label="Per session"
          hint="Average OTEL cost per session (root session with its sub-agents); the median below."
          value={formatMicrosUsd(kpis.perSessionCostUsdMicros)}
          secondary={`median ${formatMicrosUsd(kpis.medianSessionCostUsdMicros)}`}
          change={otelKpiChange(
            usd(kpis.perSessionCostUsdMicros),
            usd(p?.perSessionCostUsdMicros),
          )}
        />
        <OtelKpiTile
          testId="otel-kpi-api-calls"
          label="API calls"
          hint="Number of model API calls Claude Code reported, including hidden ones."
          value={formatCount(kpis.apiCalls)}
          secondary={`${formatCount(kpis.modelCount)} model${kpis.modelCount === 1 ? '' : 's'}`}
          change={otelKpiChange(kpis.apiCalls, p?.apiCalls)}
          sparkline={otelSparkline(buckets, callsOf)}
        />
        <OtelKpiTile
          testId="otel-kpi-hidden"
          label="Hidden cost"
          hint="Cost of API calls that appear in no transcript of the session tree (the same rule as utility cost)."
          value={formatMicrosUsd(kpis.hiddenCostUsdMicros)}
          secondary={`${formatShare(kpis.hiddenShare)} · ${formatCount(kpis.hiddenCalls)} calls`}
          change={otelKpiChange(kpis.hiddenShare, p?.hiddenShare, 'pp')}
          sparkline={
            stackBy === 'structure'
              ? otelSparkline(buckets, costOf, 'hidden')
              : undefined
          }
        />
        <OtelKpiTile
          testId="otel-kpi-sessions"
          label="Sessions"
          hint="Root sessions with at least one OTEL call in the period and filters."
          value={formatCount(kpis.sessions)}
          secondary={`${formatCount(kpis.users)} user${kpis.users === 1 ? '' : 's'}`}
          change={otelKpiChange(kpis.sessions, p?.sessions)}
        />
        {coverage && (
          <OtelKpiTile
            testId="otel-kpi-coverage"
            label="Sessions with OTEL"
            hint="Root sessions in the period and filters that carry OTEL data, out of all root sessions; the others are left out of every OTEL total, not counted as zero."
            value={`${formatCount(coverage.otelSessions)} / ${formatCount(coverage.totalSessions)}`}
            secondary={otelCoverageSecondary(coverage)}
          />
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <OtelTokensTile tokens={tokens} />
        <OtelCacheRatioTile
          ratio={otelCacheReadRatio(
            tokens.input,
            tokens.cacheRead,
            tokens.cacheWrite,
          )}
        />
        {showPerUser && (
          <OtelKpiTile
            testId="otel-kpi-per-user"
            label="Per user"
            hint="Total OTEL cost divided by the number of users with sessions in the period."
            value={formatMicrosUsd(kpis.perUserCostUsdMicros)}
            secondary={`${formatCount(kpis.users)} user${kpis.users === 1 ? '' : 's'}`}
            change={otelKpiChange(
              usd(kpis.perUserCostUsdMicros),
              usd(p?.perUserCostUsdMicros),
            )}
          />
        )}
      </div>
    </div>
  );
}

/** Token sums of a session's calls (FR-29). */
export function sumOtelCallTokens(
  calls: readonly OtelCallRow[],
): OtelTokenTotals {
  const t: OtelTokenTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  for (const c of calls) {
    t.input += c.inputTokens;
    t.output += c.outputTokens;
    t.cacheRead += c.cacheReadTokens;
    t.cacheWrite += c.cacheWriteTokens;
  }
  return t;
}

/** Session values computed on the client from spans / calls (Visual/UX notes). */
export interface OtelSessionDerivedKpis {
  turns: number;
  runningTurns: number;
  subagents: number;
  modelCount: number;
  waitingMs: number;
}

export interface OtelSessionKpiTilesProps {
  kpis: OtelSessionKpis;
  calls: readonly OtelCallRow[];
  derived: OtelSessionDerivedKpis;
  /** KPI names whose value just changed (live highlight). */
  highlighted?: ReadonlySet<string>;
}

export function OtelSessionKpiTiles({
  kpis,
  calls,
  derived,
  highlighted,
}: OtelSessionKpiTilesProps) {
  const tokens = sumOtelCallTokens(calls);
  const total = usd(kpis.totalCostUsdMicros) ?? 0;
  const hidden = usd(kpis.hiddenCostUsdMicros) ?? 0;
  return (
    <div className="space-y-2" data-testid="otel-kpi-tiles">
      <div className="flex flex-wrap gap-2">
        <OtelKpiTile
          testId="otel-kpi-total"
          label="OTEL cost"
          hint="Sum of Claude Code's per-call cost estimate (cost_usd) for this session and its sub-agents."
          value={formatMicrosUsd(kpis.totalCostUsdMicros)}
          secondary={`${formatCount(derived.modelCount)} model${derived.modelCount === 1 ? '' : 's'}`}
          highlighted={highlighted?.has('total')}
        />
        <OtelKpiTile
          testId="otel-kpi-hidden"
          label="Hidden"
          hint="Cost of API calls that appear in no transcript of the session tree."
          value={formatMicrosUsd(kpis.hiddenCostUsdMicros)}
          secondary={`${formatShare(total > 0 ? hidden / total : 0)} · ${formatCount(kpis.hiddenCalls)} calls`}
          highlighted={highlighted?.has('hidden')}
        />
        <OtelKpiTile
          testId="otel-kpi-api-calls"
          label="API calls"
          hint="Number of model API calls Claude Code reported for this session, including hidden ones."
          value={formatCount(kpis.apiCalls)}
          highlighted={highlighted?.has('apiCalls')}
        />
        <OtelKpiTile
          testId="otel-kpi-turns"
          label="Turns"
          hint="Interaction traces (one per prompt); running = turns without an end yet."
          value={formatCount(derived.turns)}
          secondary={
            derived.runningTurns > 0
              ? `${derived.runningTurns} running`
              : 'none running'
          }
          highlighted={highlighted?.has('turns')}
        />
        <OtelKpiTile
          testId="otel-kpi-subagents"
          label="Sub-agents"
          hint="Distinct sub-agents seen in the calls; the share is their part of the OTEL cost."
          value={formatCount(derived.subagents)}
          secondary={`${formatShare(kpis.subagentShare)} of cost`}
          highlighted={highlighted?.has('subagents')}
        />
        <OtelKpiTile
          testId="otel-kpi-waiting"
          label="Waiting for you"
          hint="Time tools spent blocked on your answer (permission prompts, questions), summed over the turns."
          value={formatDuration(derived.waitingMs)}
          highlighted={highlighted?.has('waiting')}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <OtelTokensTile tokens={tokens} />
        <OtelCacheRatioTile
          ratio={otelCacheReadRatio(
            tokens.input,
            tokens.cacheRead,
            tokens.cacheWrite,
          )}
        />
      </div>
    </div>
  );
}
