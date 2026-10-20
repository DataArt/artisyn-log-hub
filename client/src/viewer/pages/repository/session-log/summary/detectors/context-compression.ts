/**
 * Detector #1: `context-compression`.
 *
 * Fires whenever the session hit context compaction at least once. Reports the raw
 * `compactBoundaries.length`, which may exceed the deduplicated boundary-row count the Charts
 * tab shows (`ContextGrowthChart.tsx:61-71`) — this detector deliberately does not dedupe.
 */
import { formatCompact } from '../../log-parser';
import { isSystemOnlyTurn } from '../../PromptTurnList';
import { findBoundaryTurnIndex } from '../../compact-boundary-placement';
import type { Detector, Finding } from './types';

export const TITLE = 'Context was compacted';

export function EXPLANATION(n: number): string {
  return `The session hit context compression ${n} time(s); everything before each point was summarised away.`;
}

export const contextCompressionDetector: Detector = {
  id: 'context-compression',
  run(ctx): Finding | null {
    const { compactBoundaries, turns } = ctx.parsedLogs;
    if (compactBoundaries.length === 0) return null;

    const evidence = compactBoundaries
      .filter((cb) => cb.preTokens !== undefined)
      .map(
        (cb) =>
          `${formatCompact(cb.preTokens ?? 0)} → ${formatCompact(cb.postTokens ?? 0)}`,
      );

    const visibleTurns = turns.filter((t) => !isSystemOnlyTurn(t));
    const firstBoundary = compactBoundaries[0];
    const turnIndex =
      findBoundaryTurnIndex(visibleTurns, firstBoundary) ?? undefined;

    return {
      id: 'context-compression',
      severity: 'warning',
      title: TITLE,
      explanation: EXPLANATION(compactBoundaries.length),
      evidence,
      turnIndex,
    };
  },
};
