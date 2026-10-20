/**
 * The "Harness usage" tab's right pane: a usage-count summary.
 *
 * `KIND | ELEMENT | COUNT` — the fact that a skill/rule/workflow/MCP tool/tool was used, and how
 * many times, not a chronological event log. "Include sub-sessions" sums counts over the selected
 * node's subtree instead of listing every descendant's rows separately — an aggregate has no
 * single source session to name, so there is no per-row source column.
 *
 * Filter (by kind) and sort (by name / count) are local UI state, not URL-backed — same treatment
 * as the "Include sub-sessions" switch and the repo-level Harness Usage report's own table
 * (`reports/HarnessUsageTable.tsx`), which this pane's chip/sort styling mirrors. State lives here
 * rather than in the tab shell, so it naturally persists across a re-render triggered by selecting
 * a different tree node or flipping the switch — exactly like the switch's own persistence.
 */
import { ArrowUpDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Switch } from '@/ui/switch';
import {
  HARNESS_TAB_KIND_BADGE_CLASSNAMES,
  HARNESS_TAB_KIND_LABELS,
} from './harness-element-kinds';
import {
  buildHarnessUsageKindChips,
  filterHarnessUsageRows,
  sortHarnessUsageRows,
  type HarnessUsageKindFilter,
  type HarnessUsageSortKey,
  type HarnessUsageSummaryRow,
} from './harness-elements';

export interface HarnessElementListProps {
  /** The selected node's label — the middle segment of the pane header. */
  headerLabel: string;
  /** Descendant count of the selected node, for the "+ N sub-sessions" header half. */
  subSessionCount: number;
  rows: HarnessUsageSummaryRow[];
  includeChildren: boolean;
  onIncludeChildrenChange: (next: boolean) => void;
  includeDisabled: boolean;
  /**
   * Rendered in place of the table when there is nothing to list. Passed in rather than decided
   * here because the two empty states are worded differently (a session that loaded nothing vs.
   * a tree with no harness data at all) and the header + switch stay visible for both — the
   * per-node copy tells the reader to flip that very switch.
   */
  emptyState?: ReactNode;
}

interface ColumnDef {
  label: string;
  key?: HarnessUsageSortKey;
  align: 'left' | 'right';
}

const COLUMNS: ColumnDef[] = [
  { label: 'Kind', align: 'left' },
  { label: 'Element', key: 'name', align: 'left' },
  { label: 'Count', key: 'count', align: 'right' },
];

export function HarnessElementList({
  headerLabel,
  subSessionCount,
  rows,
  includeChildren,
  onIncludeChildrenChange,
  includeDisabled,
  emptyState,
}: HarnessElementListProps) {
  const [kindFilter, setKindFilter] = useState<HarnessUsageKindFilter>('all');
  const [sortKey, setSortKey] = useState<HarnessUsageSortKey>('count');
  const [sortDesc, setSortDesc] = useState(true);

  const chips = useMemo(() => buildHarnessUsageKindChips(rows), [rows]);
  const displayRows = useMemo(
    () =>
      sortHarnessUsageRows(
        filterHarnessUsageRows(rows, kindFilter),
        sortKey,
        sortDesc,
      ),
    [rows, kindFilter, sortKey, sortDesc],
  );

  function handleSort(key: HarnessUsageSortKey) {
    if (key === sortKey) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
  }

  const scope = includeChildren
    ? `${headerLabel} + ${subSessionCount} sub-sessions`
    : headerLabel;
  const totalUses = displayRows.reduce((sum, row) => sum + row.count, 0);

  return (
    <div>
      <div className="sticky top-0 z-10 border-b border-border bg-background">
        <div className="flex items-center gap-3 px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            Harness usage · {scope} · {displayRows.length}{' '}
            {displayRows.length === 1 ? 'element' : 'elements'} · {totalUses}{' '}
            {totalUses === 1 ? 'use' : 'uses'}
          </span>
          <label
            className={cn(
              'flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground',
              includeDisabled && 'opacity-50',
            )}
          >
            <Switch
              data-testid="harness-include-children"
              checked={includeChildren}
              disabled={includeDisabled}
              onCheckedChange={onIncludeChildrenChange}
              aria-label="Include sub-sessions"
            />
            Include sub-sessions
          </label>
        </div>
        {rows.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 px-3 pb-2">
            {chips.map((chip) => (
              <button
                key={chip.kind}
                type="button"
                data-testid="harness-kind-chip"
                onClick={() => setKindFilter(chip.kind)}
                className={cn(
                  'rounded-full px-2 py-0.5 text-[10px] font-semibold',
                  chip.kind === kindFilter
                    ? 'bg-primary text-primary-foreground'
                    : 'border border-border text-foreground hover:bg-accent/50',
                )}
              >
                {chip.label} {chip.count}
              </button>
            ))}
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        emptyState
      ) : displayRows.length === 0 ? (
        <div className="p-6 text-center text-xs text-muted-foreground">
          No elements match this filter.
        </div>
      ) : (
        <table className="w-full min-w-[360px] text-xs">
          <thead>
            <tr className="border-b border-border text-left text-[10px] tracking-wide text-muted-foreground uppercase">
              {COLUMNS.map((col) => (
                <th
                  key={col.label}
                  onClick={col.key ? () => handleSort(col.key!) : undefined}
                  className={cn(
                    'px-3 py-1.5 font-medium whitespace-nowrap',
                    col.align === 'right' && 'text-right',
                    col.key &&
                      'cursor-pointer select-none hover:text-foreground',
                    col.label === 'Element' && 'w-full',
                  )}
                >
                  <span
                    className={cn(
                      'inline-flex items-center gap-1',
                      col.align === 'right' && 'justify-end',
                    )}
                  >
                    {col.label}
                    {col.key && sortKey === col.key && (
                      <ArrowUpDown className="size-3" />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row) => (
              <tr
                key={`${row.kind}:${row.name}`}
                data-testid="harness-element-row"
                className="border-b border-border/50 transition-colors hover:bg-muted/30"
              >
                <td className="px-3 py-1 align-top">
                  <span
                    className={cn(
                      'inline-block rounded px-1.5 py-0.5 text-[10px] leading-none font-bold',
                      HARNESS_TAB_KIND_BADGE_CLASSNAMES[row.kind],
                    )}
                  >
                    {HARNESS_TAB_KIND_LABELS[row.kind]}
                  </span>
                </td>
                <td className="w-full px-3 py-1 align-top font-mono">
                  <div className="truncate" title={row.name}>
                    {row.name}
                  </div>
                </td>
                <td
                  className="px-3 py-1 align-top text-right font-mono tabular-nums"
                  data-testid="harness-element-count"
                >
                  {row.count}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
