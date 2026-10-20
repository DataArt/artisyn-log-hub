interface Props {
  show: boolean;
}

/**
 * Extends `ExecutiveSummaryLimitations.tsx`'s
 * muted-panel caveat pattern to the 5 `supportsGroupBy: true` reports (`session-timeline`,
 * `work-time`, `cost-by-user`, `cache-read-ratio`, `harness-usage`). A `groupBy=attr:<key>`
 * on a `string[]`-typed attribute can, by design, count one session in more than one group —
 * the same fan-out idea that applies to Attribution Breakdown's own sections —
 * so bucket totals can legitimately sum above the overall session count/cost shown in the KPI
 * table above. Each caller computes its own `show` (see the call sites for how, including the
 * two reports whose response shape carries no per-group count to check against, where `show`
 * is simply "grouped by an attribute at all").
 */
export function GroupByFanOutCaveat({ show }: Props) {
  if (!show) return null;

  return (
    <div className="mb-4 flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
      <span aria-hidden="true">⚠</span>
      <span>
        This attribute can carry more than one value per session — a session
        grouped by it counts in full in every matching group, so the totals
        below can legitimately sum above the overall session count and cost
        shown above.
      </span>
    </div>
  );
}
