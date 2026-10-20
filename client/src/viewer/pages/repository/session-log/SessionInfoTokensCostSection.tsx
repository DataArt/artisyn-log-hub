import type * as React from 'react';
import type { RepositorySession } from '../../../../models/repositories';
import type { ParsedSession } from './types';
import { formatInt, formatCompact } from './log-parser';
import {
  formatCacheReadRatio,
  formatCost,
  formatLocalTimestamp,
  FAST_MODE_MULTIPLIER,
} from '../../../lib/format';
import { Skeleton } from '../../../ui/skeleton';
import { NoPricingBadge } from '../../../components/NoPricingBadge';
import { CostReconciliation } from '../../../components/CostReconciliation';
import {
  CollapsibleSection,
  InfoRow,
  rateFormatter,
} from './session-info-primitives';

interface DerivedTokenCostFields {
  cacheHitRate: number;
  cacheReadRatio: number | null;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  cacheWrite5mCost: number | null;
  cacheWrite1hCost: number | null;
  priceIn: number | null;
  priceOut: number | null;
  priceCacheR: number | null;
  priceCacheW: number | null;
  /** The two TTLs are priced at different rates, so each sub-row shows its own. */
  priceCacheW5m: number | null;
  priceCacheW1h: number | null;
  /** USD per web-search request — rendered with a `/req` unit, never as `$/M`. */
  priceWebSearch: number | null;
  inputCost: number | null;
  outputCost: number | null;
  cacheReadCost: number | null;
  cacheWriteCost: number | null;
  webSearchCost: number | null;
  inputFastCost: number | null;
  outputFastCost: number | null;
  totalCost: number | null;
}

interface Props {
  session: RepositorySession;
  parsedLogs: ParsedSession | null;
  showSkeleton: boolean;
  derived: DerivedTokenCostFields | null;
  subAgentCost: number | null;
  workflowSubagentTokens: number;
  workflowEstimatedCost: number | null;
  showWorkflowCostRow: boolean;
  /**
   * The session's model id when it has no `model_pricing` row, else `null`.
   * Drives the "no pricing" badge on the Model row and in the Calculated total cell — those two
   * must never fall back to `—` or `$0.0000`, which would read as "this session was free".
   */
  unpricedModel: string | null;
}

/**
 * Session Info tab — "Tokens & Cost" collapsible section: per-category token/cost
 * table (input/output/cache read/cache write with its 5m/1h TTL sub-rows, sub-agents,
 * workflow agents), the token total row, the server-priced `CostReconciliation` table
 * (main · sub-agents · utility · calculated · telemetry), the max-context-used / cached-input-share /
 * cache-read-ratio rows, and the context
 * compactions table. Extracted from `SessionInfoTab.tsx` to keep that file under
 * the project's component-size guidance.
 */
export function SessionInfoTokensCostSection({
  session,
  parsedLogs,
  showSkeleton,
  derived,
  subAgentCost,
  workflowSubagentTokens,
  workflowEstimatedCost,
  showWorkflowCostRow,
  unpricedModel,
}: Props) {
  const val = (v: React.ReactNode) =>
    showSkeleton ? <Skeleton className="h-4 w-24" /> : (v ?? '—');

  return (
    <CollapsibleSection title="Tokens &amp; Cost">
      <InfoRow label="Model">
        {val(
          parsedLogs?.summary.model != null ? (
            <span className="inline-flex items-center gap-2">
              {parsedLogs.summary.model}
              {unpricedModel != null && (
                <NoPricingBadge modelId={unpricedModel} />
              )}
            </span>
          ) : parsedLogs ? (
            '—'
          ) : null,
        )}
      </InfoRow>
      <table className="w-full border-collapse mt-2">
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground">
            <th className="text-left font-medium pb-1 pr-3">Item</th>
            <th className="text-right font-medium pb-1 pr-3">Tokens</th>
            <th className="text-right font-medium pb-1 pr-3">$/M</th>
            <th className="text-right font-medium pb-1">Cost</th>
          </tr>
        </thead>
        <tbody>
          {showSkeleton ? (
            ['Input', 'Output', 'Cache read', 'Cache write'].map((label) => (
              <tr key={label}>
                <td className="py-0.5 pr-3 text-xs text-muted-foreground">
                  {label}
                </td>
                <td className="py-0.5 pr-3 text-right">
                  <Skeleton className="h-3 w-16 ml-auto" />
                </td>
                <td className="py-0.5 pr-3 text-right">
                  <Skeleton className="h-3 w-10 ml-auto" />
                </td>
                <td className="py-0.5 text-right">
                  <Skeleton className="h-3 w-12 ml-auto" />
                </td>
              </tr>
            ))
          ) : parsedLogs ? (
            <>
              {(
                [
                  {
                    label: 'Input',
                    tokens: parsedLogs.summary.tokenBreakdown.input,
                    pricePerM: derived?.priceIn,
                    cost: derived?.inputCost,
                  },
                  {
                    label: 'Output',
                    tokens: parsedLogs.summary.tokenBreakdown.output,
                    pricePerM: derived?.priceOut,
                    cost: derived?.outputCost,
                  },
                  {
                    label: 'Cache read',
                    tokens: parsedLogs.summary.tokenBreakdown.cacheRead,
                    pricePerM: derived?.priceCacheR,
                    cost: derived?.cacheReadCost,
                  },
                  {
                    label: 'Cache write',
                    tokens: parsedLogs.summary.tokenBreakdown.cacheWrite,
                    pricePerM: derived?.priceCacheW,
                    cost: derived?.cacheWriteCost,
                  },
                ] as const
              ).map(({ label, tokens, pricePerM, cost }) => (
                <tr key={label} className="hover:bg-muted/30">
                  <td className="py-0.5 pr-3 text-xs text-muted-foreground">
                    {label}
                  </td>
                  <td className="py-0.5 pr-3 text-right text-sm font-mono">
                    {formatInt(tokens)}
                  </td>
                  <td className="py-0.5 pr-3 text-right text-sm font-mono">
                    {pricePerM != null ? rateFormatter.format(pricePerM) : '—'}
                  </td>
                  <td className="py-0.5 text-right text-sm font-mono">
                    {cost != null ? formatCost(cost) : '—'}
                  </td>
                </tr>
              ))}
              {/* TTL split of the Cache write row above — the two always sum back to it. */}
              {(
                [
                  {
                    label: '↳ 5m TTL',
                    tokens: parsedLogs.summary.tokenBreakdown.cacheWrite5m,
                    cost: derived?.cacheWrite5mCost,
                    pricePerM: derived?.priceCacheW5m,
                  },
                  {
                    label: '↳ 1h TTL',
                    tokens: parsedLogs.summary.tokenBreakdown.cacheWrite1h,
                    cost: derived?.cacheWrite1hCost,
                    pricePerM: derived?.priceCacheW1h,
                  },
                ] as const
              ).map(({ label, tokens, cost, pricePerM }) => (
                <tr key={label} className="bg-violet-50 text-indigo-700">
                  <td className="py-0.5 pl-3 pr-3 text-xs">{label}</td>
                  <td className="py-0.5 pr-3 text-right text-sm font-mono">
                    {formatInt(tokens)}
                  </td>
                  <td className="py-0.5 pr-3 text-right text-sm font-mono">
                    {pricePerM != null ? rateFormatter.format(pricePerM) : '—'}
                  </td>
                  <td className="py-0.5 text-right text-sm font-mono">
                    {cost != null ? formatCost(cost) : '—'}
                  </td>
                </tr>
              ))}
              {/* Web search is billed per REQUEST, so this row's unit column reads
                  "N req" and its rate column carries a "/req" suffix — it is never a
                  $/M figure. Hidden entirely when the session made no web searches. */}
              {parsedLogs.summary.tokenBreakdown.webSearchRequests > 0 && (
                <tr className="hover:bg-muted/30">
                  <td className="py-0.5 pr-3 text-xs text-muted-foreground">
                    Web search
                  </td>
                  <td className="py-0.5 pr-3 text-right text-sm font-mono">
                    {formatInt(
                      parsedLogs.summary.tokenBreakdown.webSearchRequests,
                    )}{' '}
                    req
                  </td>
                  <td className="py-0.5 pr-3 text-right text-sm font-mono">
                    {derived?.priceWebSearch != null
                      ? `${rateFormatter.format(derived.priceWebSearch)}/req`
                      : '—'}
                  </td>
                  <td className="py-0.5 text-right text-sm font-mono">
                    {derived?.webSearchCost != null
                      ? formatCost(derived.webSearchCost)
                      : '—'}
                  </td>
                </tr>
              )}
              {/* Fast-mode rows: `inputFast`/`outputFast` are SUBSETS of the Input/Output
                  rows above, shown at the fast rate so the surcharge is visible. They are
                  a disclosure of what is already inside the total, not extra line items —
                  hidden entirely for a session with no fast turns. */}
              {(
                [
                  {
                    label: 'Input (fast)',
                    tokens: parsedLogs.summary.tokenBreakdown.inputFast,
                    pricePerM:
                      derived?.priceIn != null
                        ? derived.priceIn * FAST_MODE_MULTIPLIER
                        : null,
                    cost: derived?.inputFastCost,
                  },
                  {
                    label: 'Output (fast)',
                    tokens: parsedLogs.summary.tokenBreakdown.outputFast,
                    pricePerM:
                      derived?.priceOut != null
                        ? derived.priceOut * FAST_MODE_MULTIPLIER
                        : null,
                    cost: derived?.outputFastCost,
                  },
                ] as const
              )
                .filter(({ tokens }) => tokens > 0)
                .map(({ label, tokens, pricePerM, cost }) => (
                  <tr
                    key={label}
                    className="hover:bg-muted/30"
                    title={`Fast-mode share of the ${label.startsWith('Input') ? 'input' : 'output'} tokens above, billed at ${FAST_MODE_MULTIPLIER}× the standard rate. Already included in the total.`}
                  >
                    <td className="py-0.5 pr-3 text-xs text-muted-foreground">
                      {label}
                    </td>
                    <td className="py-0.5 pr-3 text-right text-sm font-mono">
                      {formatInt(tokens)}
                    </td>
                    <td className="py-0.5 pr-3 text-right text-sm font-mono">
                      {pricePerM != null
                        ? rateFormatter.format(pricePerM)
                        : '—'}
                    </td>
                    <td className="py-0.5 text-right text-sm font-mono">
                      {cost != null ? formatCost(cost) : '—'}
                    </td>
                  </tr>
                ))}
              {subAgentCost != null && (
                <tr className="hover:bg-muted/30">
                  <td className="py-0.5 pr-3 text-xs text-muted-foreground">
                    Sub-agents
                  </td>
                  <td className="py-0.5 pr-3 text-right text-sm font-mono text-muted-foreground">
                    —
                  </td>
                  <td className="py-0.5 pr-3 text-right text-sm font-mono text-muted-foreground">
                    —
                  </td>
                  <td className="py-0.5 text-right text-sm font-mono text-orange-500 dark:text-orange-400">
                    {formatCost(subAgentCost)}
                  </td>
                </tr>
              )}
              {showWorkflowCostRow && (
                <tr className="hover:bg-muted/30">
                  <td className="py-0.5 pr-3 text-xs text-muted-foreground">
                    Workflow agents
                  </td>
                  <td
                    className="py-0.5 pr-3 text-right text-sm font-mono"
                    title="Total tokens reported by the workflow system across all agents. Input/output/cache breakdown is not available for exact pricing."
                  >
                    {formatInt(workflowSubagentTokens)}
                  </td>
                  <td className="py-0.5 pr-3 text-right text-sm font-mono text-muted-foreground">
                    —
                  </td>
                  <td
                    className="py-0.5 text-right text-sm font-mono text-amber-500 dark:text-amber-400"
                    title="Rough estimate based on this session's average token rate. Actual cost depends on the input/output/cache breakdown, which is not available for workflow agents."
                  >
                    {workflowEstimatedCost != null
                      ? `~${formatCost(workflowEstimatedCost)}`
                      : 'untracked'}
                  </td>
                </tr>
              )}
              <tr className="border-t-2 border-border font-semibold">
                <td className="pt-1 pr-3 text-xs">Total tokens</td>
                <td className="pt-1 pr-3 text-right text-sm font-mono">
                  {formatInt(parsedLogs.summary.totalTokens)}
                </td>
                <td className="pt-1 pr-3" />
                <td className="pt-1" />
              </tr>
            </>
          ) : null}
        </tbody>
      </table>
      {/* D2.2 — the server-priced totals: main thread + sub-agents + utility calls against
          the telemetry-reported cost. An unpriced main model keeps the "no pricing" badge in
          the Calculated row — never "—" or "$0.0000", which would read as "free". */}
      {!showSkeleton && (
        <CostReconciliation
          variant="table"
          breakdown={session.costBreakdown}
          unpriced={
            unpricedModel != null ||
            session.costUnavailableReason === 'unknown-model'
          }
          unpricedModelId={unpricedModel}
          className="mt-2"
        />
      )}
      <div className="mt-2">
        <InfoRow label="Max context used">
          {val(
            parsedLogs?.summary.maxContextTokens != null
              ? formatInt(parsedLogs.summary.maxContextTokens)
              : parsedLogs
                ? '—'
                : null,
          )}
        </InfoRow>
        <InfoRow
          label="Cached input share"
          title="cacheRead / (input + cacheRead)"
        >
          {val(derived ? `${(derived.cacheHitRate * 100).toFixed(1)}%` : null)}
        </InfoRow>
        <InfoRow
          label="Cache read ratio"
          title="cache read ÷ (cache read + cache write)"
        >
          {val(derived ? formatCacheReadRatio(derived.cacheReadRatio) : null)}
        </InfoRow>
        {parsedLogs && parsedLogs.compactBoundaries.length > 0 && (
          <div className="mt-3">
            <p className="mb-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Context compactions ({parsedLogs.compactBoundaries.length})
            </p>
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="text-left font-medium pb-1 pr-3">Time</th>
                  <th className="text-right font-medium pb-1 pr-3">Before</th>
                  <th className="text-right font-medium pb-1 pr-3">After</th>
                  <th className="text-right font-medium pb-1 pr-3">Saved</th>
                  <th className="text-right font-medium pb-1">Duration</th>
                </tr>
              </thead>
              <tbody>
                {parsedLogs.compactBoundaries.map((cb, i) => {
                  const pre = cb.preTokens ?? 0;
                  const post = cb.postTokens ?? 0;
                  const saved = pre - post;
                  const savedPct =
                    pre > 0 ? Math.round((saved / pre) * 100) : 0;
                  const timeLabel = cb.timestamp
                    ? formatLocalTimestamp(cb.timestamp).slice(11)
                    : '—';
                  return (
                    <tr key={i} className="hover:bg-muted/30">
                      <td className="py-0.5 pr-3 text-xs text-muted-foreground font-mono">
                        {timeLabel}
                      </td>
                      <td
                        className="py-0.5 pr-3 text-right text-sm font-mono"
                        title={
                          cb.preTokens != null
                            ? `${formatInt(cb.preTokens)} tokens`
                            : undefined
                        }
                      >
                        {cb.preTokens != null
                          ? formatCompact(cb.preTokens)
                          : '—'}
                      </td>
                      <td
                        className="py-0.5 pr-3 text-right text-sm font-mono"
                        title={
                          cb.postTokens != null
                            ? `${formatInt(cb.postTokens)} tokens`
                            : undefined
                        }
                      >
                        {cb.postTokens != null
                          ? formatCompact(cb.postTokens)
                          : '—'}
                      </td>
                      <td className="py-0.5 pr-3 text-right text-sm font-mono text-emerald-600 dark:text-emerald-400">
                        {pre > 0 ? `−${savedPct}%` : '—'}
                      </td>
                      <td className="py-0.5 text-right text-sm font-mono text-muted-foreground">
                        {cb.durationMs != null
                          ? `${(cb.durationMs / 1000).toFixed(1)}s`
                          : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}
