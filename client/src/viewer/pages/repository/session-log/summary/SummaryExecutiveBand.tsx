/**
 * Summary tab, Section 1: the executive band of six stat tiles.
 *
 * Every value comes straight from the derive (`SessionSummaryDerived`) or the raw
 * `SessionSummary` / `SessionInfoDerived` inputs it was built from — this component contains
 * no formulas of its own beyond formatting. The cost tile mirrors
 * `SessionDetailHeader.tsx:130-180` exactly; the peak-context tile carries
 * an amber progress bar.
 */
import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';
import type { RepositorySession } from '../../../../../models/repositories';
import type { ModelPricingMap } from '../../../../../models/pricing';
import type { SessionLogsData } from '../../../../api';
import { Card, CardContent } from '@/ui/card';
import { CostBreakdownTooltip } from '../../../../components/CostBreakdownTooltip';
import { NoPricingBadge } from '../../../../components/NoPricingBadge';
import {
  costDiscrepancyHint,
  unpricedModelIds,
} from '../../../../lib/cost-hints';
import { CostReconciliation } from '../../../../components/CostReconciliation';
import { UtilityCallsMarker } from '../../../../components/UtilityCallsMarker';
import { cn } from '../../../../lib/cn';
import { formatCost } from '../../../../lib/format';
import { formatDiffCoverageNote } from '../../../../lib/usage-analytics-format';
import {
  bandBgClass,
  bandLabel,
  bandTextClass,
  formatConcentration,
} from '../../../../lib/change-surface-ui';
import type { SessionSummary } from '../types';
import type { SessionInfoDerived } from '../session-info-derive';
import { formatDuration, formatInt } from '../log-parser';
import { SummaryStatTile } from './SummaryStatTile';
import type { SessionSummaryDerived } from './session-summary-derive';
import { buildAttributionDisplay } from '../../SessionDetailHeader';

/**
 * Per-tile accent colors, reused from the Executive Summary report's `KpiTiles.tsx` (Cost ->
 * green, Turns -> blue, Delegation -> violet, Peak context -> orange match that report's
 * Total AI Cost / Total Sessions / Active Users / Avg Cost tiles exactly); Code impact and
 * Session shape extend the same categorical order with two more hues already used elsewhere
 * in this app (teal, indigo) rather than inventing new ones.
 */
const TILE_ACCENT = {
  cost: 'border-l-green-600 dark:border-l-green-400',
  peakContext: 'border-l-orange-500 dark:border-l-orange-400',
  turns: 'border-l-blue-500 dark:border-l-blue-400',
  codeImpact: 'border-l-teal-500 dark:border-l-teal-400',
  delegation: 'border-l-violet-500 dark:border-l-violet-400',
  sessionShape: 'border-l-indigo-500 dark:border-l-indigo-400',
  // A seventh hue for the change-surface tile, distinct from the six above.
  changeSurface: 'border-l-amber-500 dark:border-l-amber-400',
} as const;

/**
 * The Code-impact tile's secondary line. Four shapes, driven by how
 * much of the tree's edit-call diff data actually survived into `linesAdded`/`linesRemoved`:
 *
 * - no edit calls at all (or no coverage figures) → `N files`
 * - zero coverage over N calls → `no diff data (0 of N calls) · N files`
 * - full coverage → `+A / −B · N files`
 * - partial coverage → `+A / −B over C of N calls · N files`
 *
 * The `title` is `formatDiffCoverageNote` — reused, never reimplemented, so this tile and the
 * Statistics tab's productivity counters explain coverage in the same words.
 */
function CodeImpactSecondary({ derived }: { derived: SessionSummaryDerived }) {
  const filesLabel =
    derived.filesTouched != null
      ? `${formatInt(derived.filesTouched)} files`
      : null;
  const covered = derived.diffCoveredCalls;
  const total = derived.diffTotalCalls;

  const join = (head: string | null) =>
    [head, filesLabel].filter((part) => part != null).join(' · ') || 'n/a';

  let text: string;
  if (covered == null || total == null || total <= 0) {
    text = join(null);
  } else if (covered <= 0) {
    text = join(`no diff data (0 of ${formatInt(total)} calls)`);
  } else {
    const delta = `+${formatInt(derived.linesAdded ?? 0)} / −${formatInt(
      derived.linesRemoved ?? 0,
    )}`;
    text =
      covered >= total
        ? join(delta)
        : join(
            `${delta} over ${formatInt(covered)} of ${formatInt(total)} calls`,
          );
  }

  return (
    <span
      title={
        covered != null && total != null
          ? formatDiffCoverageNote(covered, total)
          : undefined
      }
    >
      {text}
    </span>
  );
}

interface Props {
  session: RepositorySession;
  summary: SessionSummary;
  info: SessionInfoDerived;
  derived: SessionSummaryDerived;
  pricing: ModelPricingMap | undefined;
  sessionCost: number | null;
  /**
   * The incomplete render: every tile shows `n/a` regardless of the computed
   * values below — the values are still computed (cheap, and harmless on an empty session) but
   * `SummaryStatTile` ignores them once `incomplete` is set.
   */
  incomplete: boolean;
  /**
   * The change-surface aggregate is a separate request from the logs payload, so the
   * tile renders its own `Skeleton` state while that request is in flight rather than briefly
   * claiming the data is incomplete.
   */
  changeSurfaceLoading?: boolean;
  /** Same source and derivation as `SessionDetailHeader.tsx`'s attribution row —
   * `null`/`undefined` renders nothing, same as `enabled: false`, so the two surfaces never
   * disagree. Independent of `parsedLogs`/`incomplete`: attribution comes from a separate part
   * of the same `/logs` response, so it renders in both the incomplete and full-render branches. */
  sessionAttribution?: SessionLogsData['sessionAttribution'] | null;
}

/** `null` -> `'n/a'`, else an integer percentage — no dedicated percent formatter exists yet. */
function formatPct(ratio: number | null): string {
  return ratio != null ? `${Math.round(ratio * 100)}%` : 'n/a';
}

export function SummaryExecutiveBand({
  session,
  summary,
  info,
  derived,
  pricing,
  sessionCost,
  incomplete,
  changeSurfaceLoading = false,
  sessionAttribution,
}: Props) {
  // --- Cost tile ---------------------------------------------------
  const model = summary.model ?? null;
  const unpriced =
    session.costUnavailableReason === 'unknown-model' ||
    (model != null && pricing != null && pricing[model] == null);
  const priced =
    sessionCost !== null && model != null && pricing?.[model] != null;

  const costValue: ReactNode = priced ? (
    <CostBreakdownTooltip
      breakdown={summary.tokenBreakdown}
      pricing={pricing[model]}
      reportedCost={sessionCost}
      subAgentCost={info.subAgentCost}
      workflowEstimatedCost={info.workflowEstimatedCost}
      workflowSubagentTokens={info.workflowSubagentTokens}
      showWorkflowCostRow={info.showWorkflowCostRow}
      hasCostDiscrepancy={session.hasCostDiscrepancy}
    >
      <span className="cursor-help">{formatCost(sessionCost)}</span>
    </CostBreakdownTooltip>
  ) : unpriced && sessionCost === null ? (
    // The cost cannot be computed: `$???` with the hint naming the models (never the
    // OTEL figure in its place).
    <NoPricingBadge
      modelIds={unpricedModelIds(session.costBreakdown.unpricedModels, model)}
    />
  ) : (
    <span>{sessionCost !== null ? formatCost(sessionCost) : 'n/a'}</span>
  );

  const hasSubAgentMarker = (info.subAgentCost ?? 0) > 0;
  // D2.2 — the compact server-priced reconciliation (calculated vs telemetry, and the
  // main / sub-agents / utility parts) sits under the existing markers. No `unpriced` here:
  // the tile's value already carries the `$???` marker, so a null calculated total just
  // reads `—` rather than marking the tile twice.
  const costSecondary: ReactNode = (
    <span className="flex flex-col gap-1">
      {(hasSubAgentMarker || session.hasCostDiscrepancy) && (
        <span className="inline-flex items-center gap-1">
          {hasSubAgentMarker && (
            <span title="Includes sub-agent cost in addition to the main-thread total.">
              +sub-agents
            </span>
          )}
          {session.hasCostDiscrepancy && (
            <span
              data-testid="cost-discrepancy-icon"
              title={costDiscrepancyHint(
                session.costBreakdown.telemetryCost,
                session.costBreakdown.calculatedCost,
              )}
              className="cursor-help"
            >
              <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
            </span>
          )}
        </span>
      )}
      {session.costBreakdown.costExcludesUtilityCalls === true && (
        <UtilityCallsMarker />
      )}
      <CostReconciliation variant="compact" breakdown={session.costBreakdown} />
    </span>
  );

  // --- Peak context tile --------------------------------------------
  const peakValue =
    derived.peakContextTokens != null
      ? formatInt(derived.peakContextTokens)
      : 'n/a';
  const contextWindowLabel =
    derived.contextWindow != null ? formatInt(derived.contextWindow) : 'n/a';
  const peakSecondary = `${formatPct(derived.contextWindowPct)} of ${contextWindowLabel}`;

  // --- Turns tile ------------------------------------------------------------------------
  const turnsValue = `${formatInt(derived.promptCount)} prompts`;
  const turnsSecondary = `${formatInt(derived.assistantSteps)} assistant steps`;

  // --- Code impact tile --------------------------------------------------------------------
  // The value is tree-scoped (root + every descendant sub-agent), so it can no longer
  // read `0 lines` next to a Delegation tile reporting 22 agents. The secondary line is
  // coverage-aware: `+A / −B` is only honest when every edit call carried
  // a `structuredPatch`, so partial and zero coverage say so instead of printing a silent
  // `+0 / −0`. The full sentence is the tile's native tooltip, from the same shared formatter
  // the Statistics tab uses.
  const codeImpactValue = `${formatInt(derived.linesChanged)} lines`;
  const codeImpactSecondary = <CodeImpactSecondary derived={derived} />;

  // --- Delegation tile ---------------------------------------------------------------------
  const delegationValue = `${derived.subAgentCount} agents · ${derived.workflowCount} workflows`;
  const delegationSecondary = `${formatPct(derived.delegationCostShare)} of cost · ${formatPct(derived.delegationTokenShare)} of tokens`;

  // --- Session shape tile (log-parser's formatDuration) ----------------
  const sessionShapeValue = summary.model ?? 'n/a';
  const sessionShapeSecondary = `${formatDuration(summary.totalWorkTimeMs)} work time · ${formatInt(derived.toolCalls)} other tool calls`;

  // --- Change surface tile -----------------------------------------
  // Distinct changed **paths**, never call counts, and deliberately no line family — that is
  // the Code-impact tile's axis, and the two must not appear to contradict each other. A
  // never-computed aggregate falls back to the tile's own `incomplete` state; a genuinely
  // empty one (`computed: true`, zero files) is muted with an `n/a` concentration and no meter,
  // because "changed nothing" is real data, not missing data.
  const changeSurfaceComputed = derived.changeSurfaceComputed;
  const changeSurfaceFiles = derived.changeSurfaceChangedFiles ?? 0;
  const changeSurfaceFolders = derived.changeSurfaceFoldersTouched ?? 0;
  const changeSurfaceEmpty = changeSurfaceComputed && changeSurfaceFiles === 0;
  const concentration = derived.changeSurfaceConcentration;
  const band = derived.changeSurfaceBand;

  const changeSurfaceValue: ReactNode = (
    <span className={cn(changeSurfaceEmpty && 'text-muted-foreground')}>
      {formatInt(changeSurfaceFiles)} files · {formatInt(changeSurfaceFolders)}{' '}
      folders
    </span>
  );
  const changeSurfaceSecondary: ReactNode = (
    <span>
      Concentration {formatConcentration(concentration)}
      {concentration !== null && (
        <>
          {' '}
          <span className={bandTextClass(band)}>{bandLabel(band)}</span>
        </>
      )}
    </span>
  );

  // --- Attribution chip row — same shared derivation as SessionDetailHeader.tsx,
  // so the two surfaces never disagree.
  const {
    state: attributionState,
    chips: attributionChips,
    label: attributionLabel,
  } = buildAttributionDisplay(sessionAttribution);

  return (
    <Card data-testid="summary-executive-band">
      <CardContent className="flex flex-wrap gap-3">
        <SummaryStatTile
          label="Cost"
          hint="Total AI cost for this session's tree (root + sub-agents), priced from the session's model and token usage. Hover the value for the full breakdown."
          value={costValue}
          secondary={costSecondary}
          incomplete={incomplete}
          accentClassName={TILE_ACCENT.cost}
        />
        <SummaryStatTile
          label="Peak context"
          hint="The highest number of tokens the context window reached at any point in this session, as a share of the model's context window size."
          value={peakValue}
          secondary={peakSecondary}
          progress={{ pct: derived.contextWindowPct }}
          incomplete={incomplete}
          accentClassName={TILE_ACCENT.peakContext}
        />
        <SummaryStatTile
          label="Turns"
          hint="Number of user prompts in this session, and the total assistant response steps across all of them."
          value={turnsValue}
          secondary={turnsSecondary}
          incomplete={incomplete}
          accentClassName={TILE_ACCENT.turns}
        />
        <SummaryStatTile
          label="Code impact"
          hint="Lines changed across this session's tree (root + every descendant sub-agent), from edit calls that carried diff data — see the secondary line for coverage."
          value={codeImpactValue}
          secondary={codeImpactSecondary}
          incomplete={incomplete}
          accentClassName={TILE_ACCENT.codeImpact}
        />
        <SummaryStatTile
          label="Delegation"
          hint="Number of sub-agents and workflows this session spawned, and the share of total cost/tokens they account for."
          value={delegationValue}
          secondary={delegationSecondary}
          incomplete={incomplete}
          accentClassName={TILE_ACCENT.delegation}
        />
        <SummaryStatTile
          label="Session shape"
          hint="The model used for this session, its total work time, and the total tool calls made."
          value={sessionShapeValue}
          secondary={sessionShapeSecondary}
          incomplete={incomplete}
          accentClassName={TILE_ACCENT.sessionShape}
        />
        <SummaryStatTile
          label="Change surface"
          hint="Distinct file paths this session tree actually changed — not Edit/Write call counts, so ten edits to one file count once. Concentration scores 0-100 how tightly those paths cluster into folders; the label below reads focused (≥ 60), mixed (40-59), or scattered (< 40)."
          value={changeSurfaceValue}
          secondary={changeSurfaceSecondary}
          progress={
            concentration !== null
              ? { pct: concentration / 100, colorClassName: bandBgClass(band) }
              : undefined
          }
          incomplete={incomplete || !changeSurfaceComputed}
          loading={changeSurfaceLoading}
          accentClassName={TILE_ACCENT.changeSurface}
        />
        {attributionState !== 'off' && (
          <div className="flex w-full flex-wrap items-center gap-1.5">
            {attributionChips.map((chip) => (
              <span
                key={chip.key}
                className="inline-block rounded px-1.5 py-0.5 font-mono text-xs bg-sky-500/10 text-sky-700 dark:text-sky-400"
              >
                {chip.text}
              </span>
            ))}
            {attributionLabel && (
              <span
                className={cn(
                  'text-[11px] font-normal',
                  attributionState === 'failed'
                    ? 'text-amber-700 dark:text-amber-400'
                    : 'text-muted-foreground/70',
                )}
                title={
                  attributionState === 'failed'
                    ? (sessionAttribution?.lastRun?.failureReason ?? undefined)
                    : undefined
                }
              >
                {attributionLabel}
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
