import type { CostBreakdown } from '../../models/repositories';
import { cn } from '../lib/cn';
import { formatCost } from '../lib/format';
import { costDiscrepancyHint, unpricedModelIds } from '../lib/cost-hints';
import { NoPricingBadge } from './NoPricingBadge';

interface Props {
  /** The server's per-session cost parts (`RepositorySession.costBreakdown`, D2.2). */
  breakdown: CostBreakdown;
  /**
   * `'table'` — the Session Info tab's right-aligned reconciliation rows.
   * `'compact'` — two short lines for the Summary cost tile and the session-list hover.
   */
  variant: 'table' | 'compact';
  /**
   * True when some model of the session tree has no `model_pricing` row. A null
   * `calculatedCost` then renders the `$???` marker instead of `—`, so an unknown price
   * never reads as "free" or "missing data". Also implied by a non-empty
   * `breakdown.unpricedModels`.
   */
  unpriced?: boolean;
  /** The surface's own unpriced main model, used when the server sent no `unpricedModels`. */
  unpricedModelId?: string | null;
  className?: string;
}

/** `|calculated − telemetry|`, or `null` unless both sides are known. */
function mismatchDelta(breakdown: CostBreakdown): number | null {
  const { calculatedCost, telemetryCost } = breakdown;
  if (calculatedCost == null || telemetryCost == null) return null;
  return Math.abs(calculatedCost - telemetryCost);
}

/** The amber `⚠ mismatch $Δ` chip — rendered only when the server flagged a mismatch. */
function MismatchChip({ breakdown }: { breakdown: CostBreakdown }) {
  if (!breakdown.mismatch) return null;
  const delta = mismatchDelta(breakdown);
  return (
    <span
      data-testid="cost-mismatch-chip"
      className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-sans text-[10px] font-normal text-amber-700 dark:text-amber-400"
      title={costDiscrepancyHint(
        breakdown.telemetryCost,
        breakdown.calculatedCost,
      )}
    >
      <span aria-hidden="true">⚠</span> mismatch
      {delta != null && ` ${formatCost(delta)}`}
    </span>
  );
}

/**
 * Muted footnote under a flagged mismatch: why the two figures differ and what to do
 * (`costDiscrepancyHint`). The calculated total is the shown session cost; the telemetry
 * figure Claude Code reports is only a cross-check.
 */
function MismatchNote({ breakdown }: { breakdown: CostBreakdown }) {
  if (!breakdown.mismatch) return null;
  return (
    <p
      className="text-[10px] leading-snug text-muted-foreground/70"
      data-testid="cost-mismatch-note"
    >
      *(The shown cost is Log Hub&apos;s.{' '}
      {costDiscrepancyHint(breakdown.telemetryCost, breakdown.calculatedCost)})
    </p>
  );
}

function CalculatedValue({
  breakdown,
  unpriced,
  unpricedModelId,
}: Pick<Props, 'breakdown' | 'unpriced' | 'unpricedModelId'>) {
  if (breakdown.calculatedCost != null)
    return <>{formatCost(breakdown.calculatedCost)}</>;
  const ids = unpricedModelIds(breakdown.unpricedModels, unpricedModelId);
  return unpriced || ids.length > 0 ? (
    <span className="inline-flex justify-end">
      <NoPricingBadge modelIds={ids} />
    </span>
  ) : (
    <>—</>
  );
}

/**
 * D2.2 — reconciles the session's calculated cost (main thread + sub-agents + utility calls,
 * all priced server-side at the session's price date) against the telemetry-reported total.
 * Every figure comes straight from `costBreakdown`; this component does no pricing of its own.
 *
 * Without telemetry (`telemetryCost == null`) the Utility and Telemetry rows are hidden —
 * utility calls are only ever discovered through telemetry, so they are 0 by construction.
 * A part with an unpriced model carries the `$???` marker next to its priced share, and the
 * calculated total is then `$???` too (never a partial sum).
 */
export function CostReconciliation({
  breakdown,
  variant,
  unpriced = false,
  unpricedModelId,
  className,
}: Props) {
  const hasTelemetry = breakdown.telemetryCost != null;

  if (variant === 'compact') {
    // Nothing to reconcile: no priced total and no telemetry figure. The host surface
    // already says why (its own "no pricing" badge or a plain `n/a`).
    if (breakdown.calculatedCost == null && !hasTelemetry) return null;
    const parts = [
      `main ${formatCost(breakdown.mainCost)}`,
      `sub-agents ${formatCost(breakdown.subagentCost)}`,
    ];
    if (hasTelemetry)
      parts.push(`utility ${formatCost(breakdown.utilityCost)}`);
    return (
      <div
        data-testid="cost-reconciliation"
        className={cn('flex flex-col gap-0.5 text-xs', className)}
      >
        <span className="inline-flex flex-wrap items-center gap-1">
          <span className="font-mono tabular-nums text-foreground">
            <CalculatedValue
              breakdown={breakdown}
              unpriced={unpriced}
              unpricedModelId={unpricedModelId}
            />
          </span>
          <span>calculated</span>
          {hasTelemetry && (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums text-foreground">
                {formatCost(breakdown.telemetryCost)}
              </span>
              <span>telemetry</span>
            </>
          )}
          <MismatchChip breakdown={breakdown} />
        </span>
        {/* The parts explain the calculated total, so they are shown only when it exists. */}
        {breakdown.calculatedCost != null && (
          <span className="font-mono tabular-nums text-muted-foreground">
            {parts.join(' · ')}
            {hasTelemetry && breakdown.utilityPricingMissing && (
              <NoPricingBadge
                className="ml-1"
                modelIds={breakdown.unpricedModels ?? []}
              />
            )}
          </span>
        )}
        <MismatchNote breakdown={breakdown} />
      </div>
    );
  }

  const labelCell = 'py-0.5 pr-3 text-xs text-muted-foreground';
  const amountCell =
    'py-0.5 text-right text-sm font-mono tabular-nums whitespace-nowrap';

  return (
    <table
      data-testid="cost-reconciliation"
      className={cn('w-full border-collapse', className)}
    >
      <tbody>
        <tr className="hover:bg-muted/30">
          <td className={labelCell}>Main thread</td>
          <td className={amountCell}>{formatCost(breakdown.mainCost)}</td>
        </tr>
        <tr className="hover:bg-muted/30">
          <td className={labelCell}>Sub-agents</td>
          <td className={amountCell}>
            <span className="inline-flex items-center justify-end gap-1">
              {breakdown.subagentPricingMissing === true && (
                <NoPricingBadge modelIds={breakdown.unpricedModels ?? []} />
              )}
              {formatCost(breakdown.subagentCost)}
            </span>
          </td>
        </tr>
        {hasTelemetry && (
          <tr
            className="hover:bg-muted/30"
            title="Telemetry API calls that appear in no transcript of this session tree (prompt suggestions, titles, …)."
          >
            <td className={labelCell}>Utility calls</td>
            <td className={amountCell}>
              <span className="inline-flex items-center justify-end gap-1">
                {breakdown.utilityPricingMissing && (
                  <NoPricingBadge modelIds={breakdown.unpricedModels ?? []} />
                )}
                {formatCost(breakdown.utilityCost)}
              </span>
            </td>
          </tr>
        )}
        <tr className="border-t-2 border-border font-semibold">
          <td className="pt-1 pr-3 text-xs">Calculated total</td>
          <td className={cn(amountCell, 'pt-1')}>
            <CalculatedValue
              breakdown={breakdown}
              unpriced={unpriced}
              unpricedModelId={unpricedModelId}
            />
          </td>
        </tr>
        {hasTelemetry && (
          <tr className="font-semibold">
            <td className="pt-0.5 pr-3 text-xs">
              <span className="inline-flex items-center gap-2">
                Telemetry total
                <MismatchChip breakdown={breakdown} />
              </span>
            </td>
            <td className={cn(amountCell, 'pt-0.5')}>
              {formatCost(breakdown.telemetryCost)}
            </td>
          </tr>
        )}
        {hasTelemetry && breakdown.mismatch && (
          <tr>
            <td colSpan={2} className="pt-1">
              <MismatchNote breakdown={breakdown} />
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
