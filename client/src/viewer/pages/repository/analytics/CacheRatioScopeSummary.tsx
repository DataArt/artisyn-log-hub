/**
 * Two-value scope strip shown above the analytics "Cache Read Ratio" chart.
 *
 * Both values are ratio-of-sums over the *whole* filtered session set, so the strip is the
 * headline number for the current date range / branch / user selection. Root-only and
 * root+descendants are always shown together — this is not a selector.
 */
import { formatCacheReadRatio } from '@/lib/format';
import { CACHE_RATIO_SCOPE_COLORS } from '@/lib/cache-ratio-ui';
import type { TimelineSession } from '../../../../models/repositories';
import {
  aggregateCacheRatio,
  type CacheRatioScopeTotals,
} from './cache-ratio-aggregate';

/**
 * The scope legend that replaces `ZoneLegend` for this metric: the ratio is bounded
 * 0–100 %, so the zone-colour thresholds used elsewhere would imply meaning that does
 * not exist here.
 */
export function CacheRatioScopeLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 mt-2 px-1 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block w-3 h-3 rounded-sm"
          style={{ backgroundColor: CACHE_RATIO_SCOPE_COLORS.root }}
        />
        Root sessions only
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block w-3 h-3 rounded-sm"
          style={{ backgroundColor: CACHE_RATIO_SCOPE_COLORS.withDescendants }}
        />
        Root + all descendant sub-agents (recursive)
      </span>
      <span className="text-muted-foreground/70">
        Scope legend, not a zone-colour legend — the ratio is bounded 0–100 %.
      </span>
    </div>
  );
}

function ScopeValue({
  swatch,
  label,
  valueClassName,
  totals,
  note,
}: {
  swatch: string;
  label: string;
  valueClassName: string;
  totals: CacheRatioScopeTotals;
  note?: string;
}) {
  return (
    <div className="min-w-[180px]">
      <div className="flex items-center gap-1.5">
        <span
          className="inline-block w-3 h-3 rounded-sm"
          style={{ backgroundColor: swatch }}
        />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className={`font-mono text-lg font-bold ${valueClassName}`}>
          {formatCacheReadRatio(totals.ratio)}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {totals.sessionCount.toLocaleString()} session
          {totals.sessionCount === 1 ? '' : 's'}
          {note ? ` · ${note}` : ''}
        </span>
      </div>
    </div>
  );
}

export function CacheRatioScopeSummary({
  sessions,
  groupBy,
}: {
  sessions: TimelineSession[];
  /**
   * When set to an `attr:<key>` value, a `string[]`-typed attribute may fan a session into
   * more than one bucket upstream — this ratio-of-sums headline is unaffected by that,
   * but the displayed session count can double-count, so we add a
   * caveat rather than recomputing anything.
   */
  groupBy?: 'none' | 'branch' | 'user' | `attr:${string}`;
}) {
  const pair = aggregateCacheRatio(sessions);
  const fanOutCaveat = groupBy?.startsWith('attr:')
    ? 'session count may double-count fanned sessions'
    : undefined;

  return (
    <div
      data-testid="cache-ratio-scope-summary"
      className="rounded-md border bg-muted/30 px-4 py-3"
    >
      <div className="text-[10px] font-bold tracking-wide text-muted-foreground">
        CACHE READ RATIO — RATIO OF SUMMED TOKENS (TOKEN-WEIGHTED)
      </div>
      <div className="mt-2 flex flex-wrap items-start gap-x-8 gap-y-3">
        <ScopeValue
          swatch={CACHE_RATIO_SCOPE_COLORS.root}
          label="Root sessions only"
          valueClassName="text-blue-700"
          totals={pair.root}
          note={fanOutCaveat}
        />
        <ScopeValue
          swatch={CACHE_RATIO_SCOPE_COLORS.withDescendants}
          label="Root + all descendant sub-agents"
          valueClassName="text-teal-700"
          totals={pair.withDescendants}
          note={
            fanOutCaveat
              ? `recursive roll-up · ${fanOutCaveat}`
              : 'recursive roll-up'
          }
        />
        <p className="max-w-xs text-[10.5px] leading-4 text-muted-foreground">
          Both values honour the date-range, branch and user selectors above,
          and are computed as SUM(read) / (SUM(read) + SUM(write)) — never a
          mean of per-session ratios.
        </p>
      </div>
    </div>
  );
}
