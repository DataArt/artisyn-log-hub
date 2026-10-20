/**
 * Detector #2: `context-ceiling-pressure`.
 *
 * Eligible turns are those with `contextTokens != null`; a turn is "at the ceiling" when its
 * `contextTokens >= contextWindow * CONTEXT_CEILING_WINDOW_FRACTION`. Returns `null` when
 * `contextWindow` is `null` or there are no eligible turns.
 */
import { formatInt } from '../../log-parser';
import {
  CONTEXT_CEILING_TURN_SHARE,
  CONTEXT_CEILING_WINDOW_FRACTION,
} from './thresholds';
import type { Detector, Finding } from './types';

export const TITLE = 'Ran near the context ceiling';

export function EXPLANATION(
  atCeiling: number,
  eligible: number,
  pct: number,
  window: number,
): string {
  return `${atCeiling} of ${eligible} turns ran at or above ${pct}% of the ${formatInt(window)}-token context window.`;
}

export const contextCeilingPressureDetector: Detector = {
  id: 'context-ceiling-pressure',
  run(ctx): Finding | null {
    const { contextWindow, peakContextTokens } = ctx.summary;
    if (contextWindow == null) return null;

    const eligibleTurns = ctx.parsedLogs.turns.filter(
      (t) => t.contextTokens != null,
    );
    const eligible = eligibleTurns.length;
    if (eligible === 0) return null;

    const ceiling = contextWindow * CONTEXT_CEILING_WINDOW_FRACTION;
    const atCeilingTurns = eligibleTurns.filter(
      (t) => (t.contextTokens ?? 0) >= ceiling,
    );
    const atCeiling = atCeilingTurns.length;

    if (atCeiling / eligible < CONTEXT_CEILING_TURN_SHARE) return null;

    const pct = CONTEXT_CEILING_WINDOW_FRACTION * 100;

    return {
      id: 'context-ceiling-pressure',
      severity: 'warning',
      title: TITLE,
      explanation: EXPLANATION(atCeiling, eligible, pct, contextWindow),
      evidence:
        peakContextTokens != null
          ? [`peak ${formatInt(peakContextTokens)}`]
          : undefined,
      turnIndex: atCeilingTurns[0]?.index,
    };
  },
};
