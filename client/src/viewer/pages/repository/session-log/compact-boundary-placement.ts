import type { CompactBoundary, PromptTurn } from './types';

/**
 * A compact boundary belongs to the visible turn it follows: its timestamp must be at or after
 * `turnTs` (when known) and strictly before `nextTs` (when there is a next turn). Shared by
 * `PromptTurnList` (placing the divider) and the context-compression detector (finding the turn
 * to deep-link to).
 */
function boundaryBelongsBetween(
  turnTs: string | undefined,
  nextTs: string | undefined,
  cb: CompactBoundary,
): boolean {
  if (!cb.timestamp) return false;
  if (turnTs && cb.timestamp < turnTs) return false;
  if (nextTs && cb.timestamp >= nextTs) return false;
  return true;
}

export function compactBoundariesBetween(
  turnTs: string | undefined,
  nextTs: string | undefined,
  boundaries: CompactBoundary[],
): CompactBoundary[] {
  return boundaries.filter((cb) => boundaryBelongsBetween(turnTs, nextTs, cb));
}

/**
 * Returns the `turn.index` of the visible turn a boundary follows, or `null` when the boundary
 * has no timestamp, `visibleTurns` is empty, or the boundary precedes the first visible turn.
 */
export function findBoundaryTurnIndex(
  visibleTurns: PromptTurn[],
  boundary: CompactBoundary,
): number | null {
  if (!boundary.timestamp || visibleTurns.length === 0) return null;

  for (let i = 0; i < visibleTurns.length; i++) {
    const turnTs = visibleTurns[i].userEvent.timestamp;
    const nextTs = visibleTurns[i + 1]?.userEvent.timestamp;
    if (boundaryBelongsBetween(turnTs, nextTs, boundary)) {
      return visibleTurns[i].index;
    }
  }
  return null;
}
