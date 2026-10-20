import { formatCompact, formatInt } from './log-parser';
import { DetailTooltip } from '../../../components/DetailTooltip';
import type { ModelPricingMap } from '../../../../models/pricing';
import {
  cacheReadRatio,
  computeCost,
  formatCacheReadRatio,
  formatCost,
} from '../../../lib/format';
import { CostBreakdownTooltip } from '../../../components/CostBreakdownTooltip';
import type { TokenBreakdown } from './types';

const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;

interface Props {
  tokenBreakdown: TokenBreakdown | null;
  /**
   * The turn's *own* assistant-event tokens — main session only, excluding the
   * sub-agent and workflow folds that `tokenBreakdown` carries. The cache read
   * ratio is defined on this narrower set.
   */
  ownTokenBreakdown: TokenBreakdown | null;
  contextTokens: number | null;
  contextTokensStart: number | null;
  pricing?: ModelPricingMap;
  sessionModel?: string;
  subagentCost: number | null;
  workflowCost: number | null;
}

export function PromptTurnTokenMetrics({
  tokenBreakdown,
  ownTokenBreakdown,
  contextTokens,
  contextTokensStart,
  pricing,
  sessionModel,
  subagentCost,
  workflowCost,
}: Props) {
  if (tokenBreakdown === null) return null;

  return (
    <div className="ml-5 mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
      <span className="flex items-center gap-1">
        <span className="text-emerald-600 dark:text-emerald-400">In</span>
        <span className="font-mono font-medium">
          {formatInt(tokenBreakdown.input)}
        </span>
      </span>
      <span className="flex items-center gap-1">
        <span className="text-rose-600 dark:text-rose-400">Out</span>
        <span className="font-mono font-medium">
          {formatInt(tokenBreakdown.output)}
        </span>
      </span>
      <span className="flex items-center gap-1">
        <span className="text-sky-600 dark:text-sky-400">cache_r</span>
        <span className="font-mono font-medium">
          {formatInt(tokenBreakdown.cacheRead)}
        </span>
      </span>
      <span className="flex items-center gap-1">
        <span className="text-indigo-600 dark:text-indigo-400">cache_w</span>
        <span className="font-mono font-medium">
          {formatInt(tokenBreakdown.cacheWrite)}
        </span>
      </span>
      {ownTokenBreakdown !== null &&
        (() => {
          const { cacheRead, cacheWrite, cacheWrite5m, cacheWrite1h } =
            ownTokenBreakdown;
          const ratio = cacheReadRatio(cacheRead, cacheWrite);
          const rows = [
            { label: 'Cache read', value: `${formatInt(cacheRead)} tokens` },
            {
              label: 'Cache write — 5m TTL',
              value: `${formatInt(cacheWrite5m)} tokens`,
            },
            {
              label: 'Cache write — 1h TTL',
              value: `${formatInt(cacheWrite1h)} tokens`,
            },
            {
              label: 'Cache write total (denominator)',
              value: `${formatInt(cacheWrite)} tokens`,
            },
          ];
          return (
            <DetailTooltip
              rows={rows}
              formula={`${formatInt(cacheRead)} ÷ (${formatInt(cacheRead)} + ${formatInt(cacheWrite)}) = ${formatCacheReadRatio(ratio)}`}
              footnote="Main session only — sub-agent and workflow tokens are excluded, so nested Skills/Tools rows carry no ratio."
            >
              <span
                className={`flex cursor-help items-center gap-1 rounded border px-1.5 ${
                  ratio === null
                    ? 'border-slate-200 bg-slate-100 text-slate-400'
                    : 'border-emerald-300 bg-emerald-50 text-emerald-800'
                }`}
              >
                <span>cache_ratio</span>
                <span className="font-mono font-medium">
                  {formatCacheReadRatio(ratio)}
                </span>
              </span>
            </DetailTooltip>
          );
        })()}
      {pricing &&
        sessionModel &&
        pricing[sessionModel] &&
        (() => {
          const mainCost = computeCost(tokenBreakdown, pricing[sessionModel]);
          const hasExtra =
            subagentCost != null || (workflowCost != null && workflowCost > 0);
          if (hasExtra) {
            return (
              <span className="flex items-center gap-1 font-mono text-sm">
                <CostBreakdownTooltip
                  breakdown={tokenBreakdown}
                  pricing={pricing[sessionModel]}
                >
                  <span className="cursor-help text-violet-600 dark:text-violet-400">
                    {formatCost(mainCost)}
                  </span>
                </CostBreakdownTooltip>
                {subagentCost != null && (
                  <>
                    <span className="text-muted-foreground">+</span>
                    <span className="text-orange-500 dark:text-orange-400">
                      {formatCost(subagentCost)}
                    </span>
                  </>
                )}
                {workflowCost != null && workflowCost > 0 && (
                  <>
                    <span className="text-muted-foreground">+</span>
                    <span
                      className="text-amber-500 dark:text-amber-400"
                      title="Rough estimate: workflow agent tokens × this session's average token rate"
                    >
                      ~{formatCost(workflowCost)}
                    </span>
                  </>
                )}
                <span className="text-muted-foreground">=</span>
                <span className="font-medium">
                  {formatCost(
                    mainCost + (subagentCost ?? 0) + (workflowCost ?? 0),
                  )}
                </span>
              </span>
            );
          }
          return (
            <CostBreakdownTooltip
              breakdown={tokenBreakdown}
              pricing={pricing[sessionModel]}
            >
              <span className="flex cursor-help items-center gap-1">
                <span className="text-violet-600 dark:text-violet-400">
                  Cost
                </span>
                <span className="font-mono font-medium">
                  {formatCost(mainCost)}
                </span>
              </span>
            </CostBreakdownTooltip>
          );
        })()}
      {contextTokens !== null &&
        (() => {
          const maxContextTokens =
            pricing?.[sessionModel ?? '']?.contextLength ??
            DEFAULT_MAX_CONTEXT_TOKENS;
          const tokensLeft = maxContextTokens - contextTokens;
          const showStartEnd =
            contextTokensStart !== null && contextTokensStart !== contextTokens;
          const delta = showStartEnd
            ? contextTokens - contextTokensStart
            : null;
          const tooltipRows = [
            ...(showStartEnd
              ? [
                  {
                    label: 'Before turn',
                    value: `${formatInt(contextTokensStart)} tokens`,
                  },
                  {
                    label: 'After turn',
                    value: `${formatInt(contextTokens)} tokens`,
                  },
                  {
                    label: 'Growth',
                    value: `${delta! >= 0 ? '+' : ''}${formatInt(delta!)} tokens`,
                  },
                ]
              : [
                  {
                    label: 'Context used',
                    value: `${formatInt(contextTokens)} tokens`,
                  },
                ]),
            {
              label: 'Remaining',
              value: `${formatInt(tokensLeft)} tokens (${Math.round((tokensLeft / maxContextTokens) * 100)}%)`,
            },
          ];
          return (
            <DetailTooltip rows={tooltipRows}>
              <span className="flex cursor-help items-center gap-1 font-mono text-sm">
                <span className="not-italic text-amber-600 dark:text-amber-400">
                  Context:
                </span>
                {showStartEnd ? (
                  <>
                    <span className="font-medium">
                      {formatCompact(contextTokensStart)}
                    </span>
                    <span className="text-muted-foreground">→</span>
                    <span className="font-medium">
                      {formatCompact(contextTokens)}
                    </span>
                    <span className="text-muted-foreground">
                      (Δ {delta! >= 0 ? '+' : ''}
                      {formatCompact(delta!)})
                    </span>
                  </>
                ) : (
                  <span className="font-medium">
                    {formatCompact(contextTokens)}
                  </span>
                )}
                <span className="text-muted-foreground">|</span>
                <span className="font-medium">{formatCompact(tokensLeft)}</span>
                <span>left</span>
              </span>
            </DetailTooltip>
          );
        })()}
    </div>
  );
}
