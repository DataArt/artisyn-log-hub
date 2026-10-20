/**
 * Shared formatting for the usage-analytics surfaces.
 *
 * One place for the display rules the requirements pin down, so the four analytics views,
 * the session Usage tab and the four reports (plus their PDFs) can never word the same
 * figure differently:
 *
 * - a duration with no derivable source renders `—`, never `0`;
 * - a repository-scope median is prefixed `≈` because it is interpolated from a bucket
 *   histogram, while a session-scope median is exact and carries no prefix;
 * - coverage always reads "over N of M calls", so a median over 14 of 61 calls can never be
 *   mistaken for a median over all of them.
 */
import { formatDuration } from './format';

/** Em dash used wherever a value is genuinely absent rather than zero. */
export const NO_VALUE = '—';

/**
 * A duration cell. `approximate` adds the `≈` prefix that marks a histogram-interpolated
 * repository-scope median; session scope passes `false` and gets an exact value.
 *
 * The value is rounded to whole milliseconds first. `formatDuration` prints sub-second values
 * verbatim (`${ms}ms`), which is fine for measured durations — those are always integers — but
 * an interpolated median or a mean is fractional and rendered as
 * `≈377.45098039215685ms` without this.
 */
export function formatToolDuration(
  ms: number | null,
  approximate: boolean,
): string {
  if (ms === null) return NO_VALUE;
  return `${approximate ? '≈' : ''}${formatDuration(Math.round(ms))}`;
}

/**
 * Coverage of a duration or line-count statistic. Returns `—` when nothing is covered, so a
 * row with no measurable calls reads as "no data" rather than "measured, and it was zero".
 */
export function formatCoverage(covered: number, total: number): string {
  if (covered <= 0) return NO_VALUE;
  return `over ${covered.toLocaleString()} of ${total.toLocaleString()} calls`;
}

/** A rate in `[0,1]` as a percentage; `null` (nothing resolved) renders `—`. */
export function formatRate(rate: number | null): string {
  if (rate === null) return NO_VALUE;
  return `${(rate * 100).toFixed(1)}%`;
}

/** Success rate is the complement of the failure rate, over resolved calls only. */
export function formatSuccessRate(failureRate: number | null): string {
  if (failureRate === null) return NO_VALUE;
  return formatRate(1 - failureRate);
}

export function formatCount(n: number): string {
  return n.toLocaleString();
}

/** `0` renders as `—` for counts that mean "none observed" (unresolved, overlapping). */
export function formatCountOrDash(n: number): string {
  return n > 0 ? n.toLocaleString() : NO_VALUE;
}

/**
 * Human label for a duration source, used in column tooltips so every displayed duration
 * states where it came from.
 */
export const DURATION_SOURCE_LABELS: Record<string, string> = {
  toolUseResult: 'self-reported by the tool',
  taskTotal: "the Task tool's own total",
  timestampDelta: 'tool_use → tool_result wall clock',
};

/**
 * Summary of which sources produced a row's durations, e.g.
 * `self-reported by the tool: 12, tool_use → tool_result wall clock: 49`.
 */
export function formatDurationSources(
  bySource: Record<string, number>,
): string {
  const parts = Object.entries(bySource)
    .filter(([, n]) => n > 0)
    .map(
      ([source, n]) =>
        `${DURATION_SOURCE_LABELS[source] ?? source}: ${n.toLocaleString()}`,
    );
  return parts.length > 0 ? parts.join(', ') : NO_VALUE;
}

/**
 * Coverage footnote for the diff-based line counts.
 *
 * Copy only, no formula change. Two things the old wording got wrong: the counts have
 * always included `MultiEdit`, and they are accumulated over every transcript in scope —
 * sub-agents included, not just the session's own thread. "in this range" is kept deliberately
 * scope-neutral: the same sentence annotates a single session tree (the Summary tab's
 * Code-impact tile, the Statistics tab) and a repository-wide date range (the Productivity
 * Counters view, the usage report).
 *
 * D1 — either count may be `null` when the session has no `session_stats` diff data at all
 * (`/logs` `rootStats` is null); that renders as "No diff data" rather than a misleading zero.
 */
export function formatDiffCoverageNote(
  covered: number | null,
  total: number | null,
): string {
  if (covered === null || total === null) return 'No diff data';
  if (total <= 0) return 'No Edit, Write or MultiEdit calls in this range.';
  if (covered <= 0) {
    return `No usable diff payload on any of the ${total.toLocaleString()} Edit/Write/MultiEdit calls in this range (sub-agents included), so no lines could be counted.`;
  }
  return `Diff-based, over ${covered.toLocaleString()} of ${total.toLocaleString()} Edit/Write/MultiEdit calls in this range (sub-agents included) — the rest carried no diff payload and are not counted.`;
}
