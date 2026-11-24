/**
 * Pure pacing decision of the background-rebuild governor (impl-plan DD-15 of
 * 2026-11-23-session-logs-streaming). Rules and examples:
 * `docs/knowledgebase/algorithms/rebuild-load-governor.md`.
 */

export interface RebuildPaceInput {
  /** Smoothed CPU busy share, 0–100 (may be fractional). */
  loadPct: number;
  /** Current time in ms. */
  nowMs: number;
  /** When the current pause began, or null when not paused. */
  pausedSinceMs: number | null;
  /** Load at which rebuilds start to slow down (`REBUILD_SLOWDOWN_CPU_PERCENT`). */
  slowdownPct: number;
  /** Load at which rebuilds pause (`REBUILD_PAUSE_CPU_PERCENT`). */
  pausePct: number;
  /** Longest pause before drain mode runs everything anyway (`REBUILD_HARD_CAP_MS`). */
  hardCapMs: number;
  /** Delay just below the pause threshold (`REBUILD_MAX_DELAY_MS`). */
  maxDelayMs: number;
}

export type RebuildPaceAction = 'run' | 'wait' | 'pause';

export interface RebuildPaceDecision {
  /** `run` now, `wait` `waitMs` then run, or `pause` (re-check after one load sample). */
  action: RebuildPaceAction;
  /** Delay before running; 0 unless `action` is `wait`. */
  waitMs: number;
  /** The pause start to keep for the next call. */
  pausedSinceMs: number | null;
}

/** Decides whether one background rebuild step may run now, later, or must pause. */
export function decideRebuildPace(
  input: RebuildPaceInput,
): RebuildPaceDecision {
  const {
    loadPct,
    nowMs,
    pausedSinceMs,
    slowdownPct,
    pausePct,
    hardCapMs,
    maxDelayMs,
  } = input;

  if (loadPct < slowdownPct) {
    return { action: 'run', waitMs: 0, pausedSinceMs: null };
  }

  if (loadPct < pausePct) {
    // slowdownPct <= loadPct < pausePct, so pausePct - slowdownPct > 0.
    const waitMs = Math.floor(
      (maxDelayMs * (loadPct - slowdownPct)) / (pausePct - slowdownPct),
    );
    return waitMs > 0
      ? { action: 'wait', waitMs, pausedSinceMs: null }
      : { action: 'run', waitMs: 0, pausedSinceMs: null };
  }

  if (pausedSinceMs === null) {
    return { action: 'pause', waitMs: 0, pausedSinceMs: nowMs };
  }

  if (nowMs - pausedSinceMs < hardCapMs) {
    return { action: 'pause', waitMs: 0, pausedSinceMs };
  }

  // Drain mode: the pause outlived the hard cap, so deferred work runs anyway. The pause start
  // is kept until the drain reports it has no waiting work.
  return { action: 'run', waitMs: 0, pausedSinceMs };
}
