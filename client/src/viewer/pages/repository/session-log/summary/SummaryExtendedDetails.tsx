/**
 * Summary tab, Section 3: the four extended-details report blocks plus the embedded
 * context-growth chart. Two-column layout at wide widths (report blocks
 * left, chart right), collapsing to one column when narrow (Visual/UX notes). Each block shows
 * `n/a` for an absent field and is omitted entirely when it has no data at all; every block's
 * deep link switches the session tab via `onSessionTabChange` rather than adding an intra-tab
 * anchor.
 */
import type { ReactNode } from 'react';
import type { ModelPricingMap } from '../../../../../models/pricing';
import type { SessionTab } from '../../useRepositoryViewState';
import { cn } from '@/lib/cn';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { formatCacheReadRatio, formatCost } from '../../../../lib/format';
import { formatInt } from '../log-parser';
import type { ParsedSession } from '../types';
import {
  groupMcpCallsByServer,
  type SessionInfoDerived,
} from '../session-info-derive';
import { ContextGrowthChart } from '../charts/context-usage/ContextGrowthChart';
import { SUMMARY_CHART_MAX_HEIGHT_PX } from './constants';
import type { SessionSummaryDerived } from './session-summary-derive';
import { SummaryPromptCostTable } from './SummaryPromptCostTable';

interface Props {
  parsedLogs: ParsedSession;
  info: SessionInfoDerived;
  derived: SessionSummaryDerived;
  pricing: ModelPricingMap | undefined;
  gitBranch: string | null;
  onSessionTabChange: (tab: SessionTab) => void;
  onGoToTurn: (turnIndex: number) => void;
}

/** `null`/`undefined` -> `'n/a'`, otherwise the formatted cost. */
function costOrNa(v: number | null | undefined): string {
  return v != null ? formatCost(v) : 'n/a';
}

function DeepLink({
  tab,
  label,
  onSessionTabChange,
}: {
  tab: SessionTab;
  label: string;
  onSessionTabChange: (tab: SessionTab) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSessionTabChange(tab)}
      className="mt-2 text-xs text-primary hover:underline"
    >
      {label}
    </button>
  );
}

function BlockRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

/**
 * Block accents tie each report block back to the executive-band tile it elaborates on, reusing
 * the same colors `SummaryExecutiveBand.tsx` assigns (itself borrowed from the Executive Summary
 * report's `KpiTiles.tsx`): Tokens & cost -> the Cost tile's green, Cache & models -> the Session
 * shape tile's indigo (both surface the session's model), Delegation -> the Delegation tile's
 * violet. Git context has no corresponding tile, so it stays uncolored.
 */
const BLOCK_ACCENT = {
  tokensCost: 'border-l-green-600 dark:border-l-green-400',
  cacheModels: 'border-l-indigo-500 dark:border-l-indigo-400',
  delegation: 'border-l-violet-500 dark:border-l-violet-400',
} as const;

function Block({
  title,
  children,
  footer,
  accentClassName,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  accentClassName?: string;
}) {
  return (
    <div
      className={cn('rounded-md border border-l-[3px] p-3', accentClassName)}
    >
      <div className="mb-1.5 text-sm font-semibold">{title}</div>
      <div className="flex flex-col gap-1">{children}</div>
      {footer}
    </div>
  );
}

export function SummaryExtendedDetails({
  parsedLogs,
  info,
  derived,
  pricing,
  gitBranch,
  onSessionTabChange,
  onGoToTurn,
}: Props) {
  const { input, output, cacheRead, cacheWrite } =
    parsedLogs.summary.tokenBreakdown;
  const tokensCost = info.derived;

  // Sum of the four rows below — this session's main-thread computed cost only (never `0`
  // when a component is missing). Deliberately smaller than both the executive band's Cost
  // tile (telemetry-reported, plus sub-agent/workflow cost) and the per-prompt cost table
  // below (each row's FULL impact, delegation included) — the tooltip explains why rather
  // than implying either difference is a bug.
  const mainCostTotal =
    tokensCost?.inputCost != null &&
    tokensCost?.outputCost != null &&
    tokensCost?.cacheReadCost != null &&
    tokensCost?.cacheWriteCost != null
      ? tokensCost.inputCost +
        tokensCost.outputCost +
        tokensCost.cacheReadCost +
        tokensCost.cacheWriteCost
      : null;

  const mcpServers = groupMcpCallsByServer(parsedLogs.mcpCalls);
  const workflows = info.workflowStats?.workflows ?? [];
  // Tree-scoped, matching the Delegation tile and the Info tab's "Sub-agents spawned" — the
  // narrow `Task`-activation count showed `0` for a workflow-driven session.
  const subAgentCount = tokensCost?.subAgentsTree ?? 0;
  const hasDelegationData =
    subAgentCount > 0 || workflows.length > 0 || mcpServers.length > 0;

  return (
    <Card data-testid="summary-extended-details">
      <CardHeader>
        <CardTitle>Extended details</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-3">
            {/* Tokens & cost — row 1. */}
            <Block
              title="Tokens & cost"
              accentClassName={BLOCK_ACCENT.tokensCost}
              footer={
                <DeepLink
                  tab="info"
                  label="View on Info tab →"
                  onSessionTabChange={onSessionTabChange}
                />
              }
            >
              <BlockRow
                label="Input"
                value={`${formatInt(input)} · ${costOrNa(tokensCost?.inputCost)}`}
              />
              <BlockRow
                label="Output"
                value={`${formatInt(output)} · ${costOrNa(tokensCost?.outputCost)}`}
              />
              <BlockRow
                label="Cache read"
                value={`${formatInt(cacheRead)} · ${costOrNa(tokensCost?.cacheReadCost)}`}
              />
              <BlockRow
                label="Cache write"
                value={`${formatInt(cacheWrite)} · ${costOrNa(tokensCost?.cacheWriteCost)}`}
              />
              <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-border pt-1.5 text-sm">
                <Tooltip>
                  <TooltipTrigger className="text-left text-muted-foreground underline decoration-dotted">
                    Main-thread total
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[320px]">
                    Sum of the four rows above — the computed token × price cost
                    for this session&apos;s main thread only, excluding
                    sub-agent and workflow cost. The per-prompt cost table below
                    prices each prompt&apos;s full impact instead (delegation
                    included), and the Cost tile at the top of the page is the
                    telemetry-reported total — hover that tile for its own
                    breakdown.
                  </TooltipContent>
                </Tooltip>
                <span className="font-mono font-semibold">
                  {costOrNa(mainCostTotal)}
                </span>
              </div>
            </Block>

            {/* Cache & models — row 2. */}
            <Block
              title="Cache & models"
              accentClassName={BLOCK_ACCENT.cacheModels}
              footer={
                <DeepLink
                  tab="usage"
                  label="View on Usage tab →"
                  onSessionTabChange={onSessionTabChange}
                />
              }
            >
              <BlockRow
                label="Cache-read ratio"
                value={formatCacheReadRatio(tokensCost?.cacheReadRatio ?? null)}
              />
              <BlockRow
                label="Cache write 5m / 1h"
                value={`${formatInt(tokensCost?.cacheWrite5mTokens ?? 0)} / ${formatInt(tokensCost?.cacheWrite1hTokens ?? 0)}`}
              />
              {derived.modelUsage.length === 0 ? (
                <BlockRow label="Models" value="n/a" />
              ) : (
                derived.modelUsage.map((m) => (
                  <BlockRow
                    key={m.model}
                    label={m.model}
                    value={`${formatInt(m.steps)} steps`}
                  />
                ))
              )}
            </Block>

            {/* Delegation — row 3. Omitted entirely with no evidence. */}
            {hasDelegationData && (
              <Block
                title="Delegation"
                accentClassName={BLOCK_ACCENT.delegation}
                footer={
                  <DeepLink
                    tab="info"
                    label="View on Info tab →"
                    onSessionTabChange={onSessionTabChange}
                  />
                }
              >
                <BlockRow label="Sub-agents" value={formatInt(subAgentCount)} />
                <BlockRow
                  label="Workflows"
                  value={formatInt(workflows.length)}
                />
                {workflows.length > 0 && (
                  <div className="ml-2 flex flex-col gap-0.5 text-xs">
                    {workflows.map((wf) => (
                      <div
                        key={wf.toolUseId}
                        className="flex items-baseline justify-between gap-2"
                      >
                        <span className="truncate text-muted-foreground">
                          {wf.name}
                        </span>
                        <span className="font-mono">{wf.status}</span>
                      </div>
                    ))}
                  </div>
                )}
                <BlockRow
                  label="Workflow tokens"
                  value={formatInt(info.workflowSubagentTokens)}
                />
                <BlockRow
                  label="Sub-agent cost"
                  value={costOrNa(info.subAgentCost)}
                />
                {mcpServers.length > 0 && (
                  <div className="ml-2 flex flex-col gap-0.5 text-xs">
                    {mcpServers.map((s) => (
                      <div
                        key={s.server}
                        className="flex items-baseline justify-between gap-2"
                      >
                        <span className="truncate text-muted-foreground">
                          {s.server}
                        </span>
                        <span className="font-mono">{formatInt(s.total)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Block>
            )}

            {/* Git context — row 4. No deep link; omitted with no branch. */}
            {gitBranch != null && gitBranch !== '' && (
              <Block title="Git context">
                <BlockRow label="Branch" value={gitBranch} />
              </Block>
            )}
          </div>

          <div>
            <div
              data-testid="summary-chart-wrapper"
              className="overflow-y-auto rounded-md border"
              style={{ maxHeight: SUMMARY_CHART_MAX_HEIGHT_PX }}
            >
              <ContextGrowthChart session={parsedLogs} pricing={pricing} />
            </div>
            <DeepLink
              tab="charts"
              label="View full chart on the Charts tab →"
              onSessionTabChange={onSessionTabChange}
            />
          </div>
        </div>

        {/* Per-prompt cost table — Section 3's fifth block. Rendered inside
            this same CardContent (not as a separate sibling section) so its left/right edges
            line up with the two columns above instead of falling back to the page's own
            (narrower) inset. */}
        <div className="mt-4">
          <SummaryPromptCostTable
            promptCosts={derived.promptCosts}
            onGoToTurn={onGoToTurn}
          />
        </div>
      </CardContent>
    </Card>
  );
}
