import { crossedTiers, type PricingTier } from '@loghub/pricing';
import type { PromptTurn } from '../../types';

/** Where the session's calls step into a long-context price tier, per Context Growth row. */
export interface TurnTierJumps {
  /** Tiers entered anywhere in the turn, including its first call vs the previous turn's last. */
  turn: PricingTier[];
  /** Per step `si`: tiers entered by step `si + 1` (the step row's bar runs from `si` to `si + 1`). */
  steps: PricingTier[][];
}

/** Prompt size of each call of the turn, in order (one per assistant step). */
function promptSeries(turn: PromptTurn): number[] {
  if (turn.assistantSteps.length > 0) {
    return turn.assistantSteps.map((s) => s.contextTokens);
  }
  return [turn.contextTokensStart, turn.contextTokens].filter(
    (v): v is number => v !== null,
  );
}

/**
 * Tier jumps of every turn, keyed by `turn.index`: a jump is a call whose prompt is above a
 * tier threshold while the previous call's was not (`crossedTiers`). A compaction drops the
 * prompt, so the next growth past the threshold is a new jump. Empty map when `tiers` is.
 */
export function tierJumps(
  turns: readonly PromptTurn[],
  tiers: readonly PricingTier[] | null | undefined,
): Map<number, TurnTierJumps> {
  const result = new Map<number, TurnTierJumps>();
  if (!tiers || tiers.length === 0) return result;
  let previous: number | null = null;
  for (const turn of turns) {
    const series = promptSeries(turn);
    const steps = series.map((p, si) =>
      si + 1 < series.length ? crossedTiers(p, series[si + 1], tiers) : [],
    );
    const first =
      series.length > 0 ? crossedTiers(previous ?? 0, series[0], tiers) : [];
    const entered = [...first, ...steps.flat()];
    if (entered.length > 0) {
      const unique = [
        ...new Map(entered.map((t) => [t.aboveTokens, t])).values(),
      ];
      result.set(turn.index, { turn: unique, steps });
    }
    if (series.length > 0) previous = series[series.length - 1];
  }
  return result;
}
