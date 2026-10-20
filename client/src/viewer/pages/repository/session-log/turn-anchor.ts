import type { PromptTurn } from './types';

/**
 * Resolution of a cross-tab `targetTurnIndex` against the Logs tab's own visible-turn list.
 * `'turn'` scrolls to a rendered turn; `'top'` scrolls the container to the top (the target
 * precedes every rendered turn); `'none'` does nothing (empty list, or the target is beyond the
 * last rendered turn).
 */
export type TurnAnchor =
  | { kind: 'turn'; index: number }
  | { kind: 'top' }
  | { kind: 'none' };

/**
 * Pure resolution — no DOM access — so the scroll fallback is unit-testable without jsdom.
 *
 * Rules, in order:
 * - empty `visibleTurns` → `{kind:'none'}`
 * - `targetIndex < visibleTurns[0].index` → `{kind:'top'}`
 * - else the first turn with `index >= targetIndex` → `{kind:'turn', index}`
 * - no such turn → `{kind:'none'}`
 */
export function resolveTurnAnchor(
  visibleTurns: PromptTurn[],
  targetIndex: number,
): TurnAnchor {
  if (visibleTurns.length === 0) return { kind: 'none' };
  if (targetIndex < visibleTurns[0].index) return { kind: 'top' };

  const match = visibleTurns.find((t) => t.index >= targetIndex);
  if (!match) return { kind: 'none' };

  return { kind: 'turn', index: match.index };
}
