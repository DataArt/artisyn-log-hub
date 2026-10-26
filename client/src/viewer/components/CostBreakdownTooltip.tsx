import type * as React from 'react';
import type { ModelPricingEntry } from '../../models/pricing';
import type { TokenBreakdown } from '../pages/repository/session-log/types';
import { formatInt } from '../pages/repository/session-log/log-parser';
import {
  computeCostBreakdown,
  formatCost,
  FAST_MODE_MULTIPLIER,
  type CostTerms,
} from '../lib/format';
import { HoverPopover } from './ViewportPopover';

interface Props {
  children: React.ReactElement<React.HTMLAttributes<HTMLElement>>;
  breakdown: TokenBreakdown;
  pricing: ModelPricingEntry;
  /**
   * The session cost actually displayed alongside this tooltip — the server's complete
   * computed cost (`totalCost`: main thread + sub-agents + utility calls, priced by Log Hub).
   */
  reportedCost?: number | null;
  /** Server-priced sub-agent cost — `costBreakdown.subagentCost` (D2.3), never telemetry minus
   * main. Added into the "Calculated approx. total" row below so this tooltip doesn't look like
   * it disagrees with `reportedCost` by the whole sub-agent spend. The Sub-agents row renders
   * only when it is greater than 0 (the server sends 0 for a session with no sub-agents). */
  subAgentCost?: number | null;
  /** Rough workflow-agent cost estimate, shown/added only when `showWorkflowCostRow` is true. */
  workflowEstimatedCost?: number | null;
  workflowSubagentTokens?: number;
  showWorkflowCostRow?: boolean;
  /** When true, the OTEL total and the computed cost differ by 33%+ and that is flagged
   * elsewhere (the header's warning icon) — suppress the "within normal range" note. */
  hasCostDiscrepancy?: boolean;
}

/** The per-million-token price fields — the always-numeric subset of ModelPricingEntry. */
type PriceKey =
  | 'priceIn'
  | 'priceOut'
  | 'priceCacheR'
  | 'priceCacheW5m'
  | 'priceCacheW1h';

/** Token-count fields of TokenBreakdown that a cost row shows as its quantity. */
type TokenKey =
  | 'input'
  | 'output'
  | 'cacheRead'
  | 'cacheWrite5m'
  | 'cacheWrite1h';

// The two cache-write rows replace the old aggregate one: `cacheWrite5m + cacheWrite1h`
// always equals `cacheWrite`, and each TTL has its own rate, so a single row
// could only ever be right for a session that used one TTL exclusively.
const COST_ROWS: {
  label: string;
  key: TokenKey;
  rateKey: PriceKey;
  termKey: keyof CostTerms;
}[] = [
  { label: 'Token In', key: 'input', rateKey: 'priceIn', termKey: 'input' },
  { label: 'Token Out', key: 'output', rateKey: 'priceOut', termKey: 'output' },
  {
    label: 'Cache Read',
    key: 'cacheRead',
    rateKey: 'priceCacheR',
    termKey: 'cacheRead',
  },
  {
    label: 'Cache Write 5m',
    key: 'cacheWrite5m',
    rateKey: 'priceCacheW5m',
    termKey: 'cacheWrite5m',
  },
  {
    label: 'Cache Write 1h',
    key: 'cacheWrite1h',
    rateKey: 'priceCacheW1h',
    termKey: 'cacheWrite1h',
  },
];

export function CostBreakdownTooltip({
  children,
  breakdown,
  pricing,
  reportedCost,
  subAgentCost,
  workflowEstimatedCost,
  workflowSubagentTokens,
  showWorkflowCostRow,
  hasCostDiscrepancy,
}: Props) {
  // The DD2 terms, each priced at every call's chosen (base or tier) rates, so the rows
  // below always sum to `mainCost` — the figure this tooltip annotates.
  const {
    total: mainCost,
    terms,
    tierDelta,
  } = computeCostBreakdown(breakdown, pricing);
  // With a long-context tier in play a row mixes rates, so a single base rate would be a lie.
  const tiered = tierDelta !== 0;
  const rows: {
    label: string;
    /** Pre-formatted quantity cell — tokens for the `$/M` rows, `N req` for web search. */
    quantity: string;
    /** Pre-formatted rate cell, including its unit (`× $3.75/M` vs `× $0.01`). */
    rate: string;
    cost: number;
  }[] = COST_ROWS.map(({ label, key, rateKey, termKey }) => ({
    label,
    quantity: formatInt(breakdown[key]),
    rate: tiered ? 'tiered' : `× ${pricing[rateKey].toFixed(2)}/M`,
    cost: terms[termKey],
  }));
  // Web search is billed per REQUEST, so its rate cell carries no `/M` unit and its cost is
  // not divided by 1e6. Rendered only when the turn actually searched.
  if (breakdown.webSearchRequests > 0) {
    rows.push({
      label: 'Web Search',
      quantity: `${formatInt(breakdown.webSearchRequests)} req`,
      rate: `× $${pricing.priceWebSearch.toFixed(2)}`,
      cost: terms.webSearch,
    });
  }
  // Fast-mode tokens are a subset of the Token In / Token Out rows above, already charged
  // there at the standard rate, so the only thing left to show is the surcharge. Itemising
  // it keeps the visible rows summing to the total.
  const fastSurcharge = terms.fastSurcharge;
  if (fastSurcharge > 0) {
    rows.push({
      label: `Fast mode (${FAST_MODE_MULTIPLIER}×)`,
      quantity: formatInt(breakdown.inputFast + breakdown.outputFast),
      rate: 'surcharge',
      cost: fastSurcharge,
    });
  }
  const total =
    mainCost +
    (subAgentCost ?? 0) +
    (showWorkflowCostRow ? (workflowEstimatedCost ?? 0) : 0);

  return (
    <HoverPopover
      className="animate-in fade-in-0 zoom-in-95 px-3 py-2.5 text-xs"
      content={
        <table className="border-collapse">
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td className="whitespace-nowrap pr-4 text-muted-foreground">
                  {r.label}
                </td>
                <td className="whitespace-nowrap pr-2 text-right font-mono tabular-nums text-foreground">
                  {r.quantity}
                </td>
                <td className="whitespace-nowrap pr-3 text-right font-mono tabular-nums text-muted-foreground">
                  {r.rate}
                </td>
                <td className="whitespace-nowrap text-right font-mono tabular-nums text-foreground">
                  {formatCost(r.cost)}
                </td>
              </tr>
            ))}
            {subAgentCost != null && subAgentCost > 0 && (
              <tr>
                <td className="whitespace-nowrap pr-4 text-muted-foreground">
                  Sub-agents
                </td>
                <td colSpan={2} />
                <td className="whitespace-nowrap text-right font-mono tabular-nums text-orange-500 dark:text-orange-400">
                  {formatCost(subAgentCost)}
                </td>
              </tr>
            )}
            {showWorkflowCostRow && (
              <tr>
                <td className="whitespace-nowrap pr-4 text-muted-foreground">
                  Workflow agents
                </td>
                <td className="whitespace-nowrap pr-2 text-right font-mono tabular-nums text-foreground">
                  {formatInt(workflowSubagentTokens ?? 0)}
                </td>
                <td />
                <td className="whitespace-nowrap text-right font-mono tabular-nums text-amber-500 dark:text-amber-400">
                  {workflowEstimatedCost != null
                    ? `~${formatCost(workflowEstimatedCost)}`
                    : 'untracked'}
                </td>
              </tr>
            )}
            <tr>
              <td colSpan={4} className="py-1">
                <div className="border-t border-border" />
              </td>
            </tr>
            <tr>
              <td className="whitespace-nowrap font-medium text-muted-foreground">
                Calculated approx. total
              </td>
              <td colSpan={2} />
              <td className="whitespace-nowrap text-right font-mono font-semibold tabular-nums text-foreground">
                {formatCost(total)}
              </td>
            </tr>
            {tierDelta > 0 && (
              <tr>
                <td
                  colSpan={4}
                  className="whitespace-nowrap pt-0.5 text-[10px] text-muted-foreground/70"
                >
                  incl. long-context tier +{formatCost(tierDelta)}
                </td>
              </tr>
            )}
            {reportedCost != null && (
              <tr>
                <td className="whitespace-nowrap font-medium text-muted-foreground">
                  Session cost (Log Hub)
                </td>
                <td colSpan={2} />
                <td className="whitespace-nowrap text-right font-mono font-semibold tabular-nums text-foreground">
                  {formatCost(reportedCost)}
                </td>
              </tr>
            )}
            {reportedCost != null &&
              !hasCostDiscrepancy &&
              Math.abs(total - reportedCost) > 0.005 && (
                <tr>
                  <td
                    colSpan={4}
                    className="whitespace-nowrap pt-0.5 text-[10px] text-muted-foreground/70"
                  >
                    Small gap to the session cost (it also prices utility calls
                    and each sub-agent exactly) is within normal range
                  </td>
                </tr>
              )}
          </tbody>
        </table>
      }
    >
      {children}
    </HoverPopover>
  );
}
