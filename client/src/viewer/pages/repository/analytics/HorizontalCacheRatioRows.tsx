/**
 * Paired-row renderer for the horizontal (ranking) layout of the analytics
 * "Cache Read Ratio" view.
 *
 * Each row shows the same pair the vertical chart shows as bars: root-only (blue) above
 * root + all recursive descendants (teal), scaled against the fixed 0–100 % range rather
 * than against the largest entry — the metric is bounded, so a relative scale would
 * exaggerate small differences. A scope with a zero denominator renders as a short dashed
 * stub and the value reads `n/a`, never `0.0%`.
 *
 * Lives in its own file so `HorizontalBarChart.tsx` stays well under the component-size
 * split threshold.
 */
import { formatCacheReadRatio } from '@/lib/format';
import { CACHE_RATIO_SCOPE_COLORS } from '@/lib/cache-ratio-ui';
import type { BarEntry } from './HorizontalBarChart';
import {
  aggregateCacheRatio,
  type CacheRatioScopeTotals,
} from './cache-ratio-aggregate';

const STUB_WIDTH = 24;

function ScopeBar({
  totals,
  color,
  barAreaWidth,
}: {
  totals: CacheRatioScopeTotals;
  color: string;
  barAreaWidth: number;
}) {
  if (totals.ratio === null) {
    return (
      <div
        data-testid="cache-ratio-row-na-stub"
        className="h-[10px] rounded-sm border border-dashed"
        style={{
          width: `${STUB_WIDTH}px`,
          borderColor: CACHE_RATIO_SCOPE_COLORS.undefinedRatio,
        }}
      />
    );
  }
  return (
    <div
      data-testid="cache-ratio-row-bar"
      className="h-[10px] rounded-sm opacity-90 transition-opacity group-hover:opacity-100"
      style={{
        width: `${Math.max(1, totals.ratio * barAreaWidth)}px`,
        backgroundColor: color,
      }}
    />
  );
}

export function HorizontalCacheRatioRows({
  entries,
  barAreaWidth,
  onEntryClick,
  onEntryHover,
  onEntryLeave,
}: {
  entries: BarEntry[];
  barAreaWidth: number;
  onEntryClick: (entry: BarEntry) => void;
  onEntryHover: (entry: BarEntry, x: number, y: number) => void;
  onEntryLeave: () => void;
}) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto py-2 flex flex-col gap-3">
      {entries.map((entry) => {
        const pair = aggregateCacheRatio(entry.sessions);
        return (
          <div
            key={entry.key}
            data-testid="bar-row"
            className="flex items-center gap-3 cursor-pointer group"
            onClick={() => onEntryClick(entry)}
            onMouseMove={(e) => onEntryHover(entry, e.clientX, e.clientY)}
            onMouseLeave={onEntryLeave}
          >
            <div
              className="w-36 shrink-0 truncate text-xs text-muted-foreground"
              title={entry.label}
            >
              {entry.label}
            </div>
            <div className="flex-1 max-w-[800px] flex flex-col gap-1">
              <ScopeBar
                totals={pair.root}
                color={CACHE_RATIO_SCOPE_COLORS.root}
                barAreaWidth={barAreaWidth}
              />
              <ScopeBar
                totals={pair.withDescendants}
                color={CACHE_RATIO_SCOPE_COLORS.withDescendants}
                barAreaWidth={barAreaWidth}
              />
            </div>
            <div
              data-testid="bar-value"
              className="w-20 shrink-0 text-right font-mono text-xs leading-4"
            >
              <div className="text-blue-700">
                {formatCacheReadRatio(pair.root.ratio)}
              </div>
              <div className="text-teal-700">
                {formatCacheReadRatio(pair.withDescendants.ratio)}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
