/**
 * The one place the session-detail page turns a `SessionUsage` walk plus the `/logs`
 * `subagentStats` map into the own/tree pair of code-impact figures.
 *
 * The bug this module exists to fix: the Info tab and the Summary band reported the **root
 * transcript's** lines/files while the analytics timeline, Branch Summary and Executive Summary
 * reported the whole session tree, so a delegating session showed `0 lines` next to
 * `22 sub-agents`. Every session-detail surface now reads its lines/files from here, so the two
 * sides of the app can no longer disagree.
 *
 * Rather than exposing one number, it exposes both scopes (`*Own` = root transcript only,
 * `*Tree` = root + every recursive descendant) so a surface can show the tree value as the
 * headline and the split as secondary text.
 */

import type { SessionRootStats, SubagentStats } from '../../../api';
import type { SessionUsage } from './usage/session-usage-derive';

/**
 * Own- and tree-scoped code impact for one session, plus the diff pair (`+added / −removed`
 * and its coverage) the Summary band and Usage tab need to describe it honestly.
 *
 * `linesOwn`/`filesOwn` always come from the transcript walk — the browser
 * never receives the root's own `session_stats` row, so the walk's own-scope accumulators are
 * the only root-only figures available, and they use the same formula as
 * `server/src/logs/claude-extractor.ts`.
 */
export interface TreeCodeImpact {
  /** Lines written by `Edit`/`Write`/`MultiEdit` across the root **and every descendant**. */
  linesTree: number;
  /** The `linesTree` subset written by the root transcript itself. `0` when purely delegating. */
  linesOwn: number;
  /** `Edit`/`Write`/`MultiEdit` **calls** across the root and every descendant. */
  filesTree: number;
  /** The `filesTree` subset made by the root transcript itself. */
  filesOwn: number;
  /**
   * Number of descendant sessions counted into the tree figures — taken from the
   * `subagentStats` map, which the server keys by every *recursive* descendant, not only the
   * depth-1 children. `0` in walk mode (see {@link TreeCodeImpact.source}), which is what
   * suppresses the "N own · M in K sub-agents" secondary line when there is nothing to split.
   */
  descendants: number;
  /**
   * D1 — diff-derived added lines across the root and every descendant: `rootStats.linesAdded`
   * plus `Σ subagentStats[*].linesAdded`, which equals the server's tree rollup
   * (`session-tree-metrics.sql.ts`). `null` when the root has no `session_stats` row
   * (`rootStats === null`), rendered as "no diff data".
   */
  linesAdded: number | null;
  /** D1 — diff-derived removed lines, same source and `null` rule as {@link linesAdded}. */
  linesRemoved: number | null;
  /**
   * D1 — of the tree's `Edit`/`Write`/`MultiEdit` calls, how many carried a `structuredPatch`
   * and so contributed real `+added / −removed` numbers. Same source and `null` rule as
   * {@link linesAdded}.
   */
  diffCoveredCalls: number | null;
  /** D1 — the tree's total `Edit`/`Write`/`MultiEdit` call count, the coverage denominator. */
  diffTotalCalls: number | null;
  /**
   * Which rule produced `linesTree`/`filesTree` — see {@link computeTreeCodeImpact}. Exposed
   * so tests can assert the precedence and so a surface can explain a figure if it ever needs
   * to; no current surface branches on it.
   */
  source: 'stats' | 'walk';
}

/**
 * The all-zero value, for the loading state and for a session whose transcript failed to parse
 * (`main === null`). Frozen so a caller cannot accidentally mutate the shared instance.
 *
 * `source: 'walk'` because zero descendants were summed — nothing came out of `subagentStats`.
 */
export const EMPTY_TREE_CODE_IMPACT: TreeCodeImpact = Object.freeze({
  linesTree: 0,
  linesOwn: 0,
  filesTree: 0,
  filesOwn: 0,
  descendants: 0,
  linesAdded: null,
  linesRemoved: null,
  diffCoveredCalls: null,
  diffTotalCalls: null,
  source: 'walk',
});

export interface TreeCodeImpactInput {
  /** The `deriveSessionUsage` result for this session; `null`/`undefined` while loading. */
  usage: SessionUsage | null | undefined;
  /** The `/logs` payload's `subagentStats`, keyed by descendant session id. */
  subagentStats?: Record<string, SubagentStats> | null;
  /**
   * D1 — the `/logs` payload's `rootStats`: the root session's own `session_stats` counters.
   * `null`/`undefined` means no diff data.
   */
  rootStats?: SessionRootStats | null;
}

interface DiffPair {
  linesAdded: number | null;
  linesRemoved: number | null;
  diffCoveredCalls: number | null;
  diffTotalCalls: number | null;
}

const NO_DIFF_DATA: DiffPair = Object.freeze({
  linesAdded: null,
  linesRemoved: null,
  diffCoveredCalls: null,
  diffTotalCalls: null,
});

/**
 * The diff pair is `rootStats` plus the sum of every `subagentStats`
 * entry's diff fields, i.e. exactly the server's tree rollup. `null` throughout when
 * `rootStats` is absent.
 */
function computeDiffPair(
  rootStats: SessionRootStats | null | undefined,
  statsEntries: SubagentStats[],
): DiffPair {
  if (!rootStats) return NO_DIFF_DATA;
  let linesAdded = rootStats.linesAdded;
  let linesRemoved = rootStats.linesRemoved;
  let diffCoveredCalls = rootStats.diffLinesCoveredCalls;
  let diffTotalCalls = rootStats.diffLinesTotalCalls;
  for (const entry of statsEntries) {
    linesAdded += entry.linesAdded ?? 0;
    linesRemoved += entry.linesRemoved ?? 0;
    diffCoveredCalls += entry.diffLinesCoveredCalls ?? 0;
    diffTotalCalls += entry.diffLinesTotalCalls ?? 0;
  }
  return { linesAdded, linesRemoved, diffCoveredCalls, diffTotalCalls };
}

/**
 * Computes the own/tree code-impact pair for one session.
 *
 * **Source precedence.** When `subagentStats` carries at least one entry,
 * the tree figures are `own + Σ subagentStats[*]` (`source: 'stats'`); otherwise they fall back
 * to the walk's tree-wide accumulators (`source: 'walk'`). Stats mode wins because it is the
 * very same `session_stats` data the analytics timeline sums server-side, so the Info tab and
 * the analytics pages cannot disagree — and because it also covers a descendant whose
 * transcript never reached the browser (`/logs` drops a sub-agent whose body failed to load).
 * There is no double count: `subagentStats` holds descendants only, and the root's share comes
 * from the walk's own-scope accumulators.
 *
 * **Known limitation of stats mode.** A descendant that has an uploaded transcript but no
 * `session_stats` row — or one excluded by the OTEL-only guard the server applies to the same
 * map — is not counted, even though its transcript may have been walked. This is accepted
 * because ingest writes a stats row for every uploaded Claude transcript, so the case is a
 * partially-ingested session rather than a steady state; the alternative (taking the max of the
 * two sources) would hide real server/client divergence instead of surfacing it.
 *
 * **The diff pair** (`linesAdded`/`linesRemoved` and its coverage) never comes from the walk:
 * it is `rootStats` + `Σ subagentStats[*]`, and `null` when
 * `rootStats` is absent. The written-lines fields stay walk-based as described above.
 */
export function computeTreeCodeImpact({
  usage,
  subagentStats,
  rootStats,
}: TreeCodeImpactInput): TreeCodeImpact {
  if (!usage) return EMPTY_TREE_CODE_IMPACT;

  const p = usage.productivity;
  const linesOwn = p.linesWrittenOwn;
  const filesOwn = p.filesEditedWrittenOwn;

  const statsEntries = subagentStats ? Object.values(subagentStats) : [];
  const diff = computeDiffPair(rootStats, statsEntries);
  if (statsEntries.length === 0) {
    return {
      linesTree: p.linesWritten,
      linesOwn,
      filesTree: p.filesEditedWritten,
      filesOwn,
      descendants: 0,
      ...diff,
      source: 'walk',
    };
  }

  let linesDescendants = 0;
  let filesDescendants = 0;
  for (const entry of statsEntries) {
    linesDescendants += entry.linesChanged ?? 0;
    filesDescendants += entry.filesEditedWritten ?? 0;
  }

  return {
    linesTree: linesOwn + linesDescendants,
    linesOwn,
    filesTree: filesOwn + filesDescendants,
    filesOwn,
    descendants: statsEntries.length,
    ...diff,
    source: 'stats',
  };
}
