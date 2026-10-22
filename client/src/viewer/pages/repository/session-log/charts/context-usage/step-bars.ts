import type { PromptTurn } from '../../types';

/** One sub-step bar of the Context Growth chart (DD-8). */
export interface StepBar {
  /** Context the step was sent with. */
  prior: number;
  /** Context of the next step (the step's own output plus its tool results), or `prior` on the last step. */
  total: number;
  /** `total − prior`; `null` on the last step, which has no next step to measure against. */
  delta: number | null;
}

/**
 * Step delta rule (DD-8): row `si` measures how much the context grew from step `si` to step
 * `si + 1` — the step's own output plus the tool results it brought back. The last row has no
 * next step, so its delta is `null`. Negative deltas are kept as is (no clamp).
 */
export function stepBars(turn: PromptTurn): StepBar[] {
  const steps = turn.assistantSteps;
  return steps.map((step, si) => {
    const prior = step.contextTokens;
    if (si === steps.length - 1) return { prior, total: prior, delta: null };
    const total = steps[si + 1].contextTokens;
    return { prior, total, delta: total - prior };
  });
}

/** `+20k` / `−3k` / `0k`, or `—` when there is no delta (DD-8). */
export function formatStepDelta(delta: number | null): string {
  if (delta === null) return '—';
  const k = Math.round(delta / 1000);
  if (k > 0) return `+${k}k`;
  if (k < 0) return `\u2212${-k}k`;
  return '0k';
}
