/**
 * Value-signal columns of the OKF tree (2026-11-03 OKF value signals): YIELD, EXPL. AFTER and
 * ROUTE MISS, their header cells and the column legend under the tree. Shown on the repo
 * variant; the numbers come from the server as they are (`yield`, `searchedAfter`,
 * `routingMiss` on a tree node) and are only formatted here.
 */
import type { OkfTreeNode } from '../../../../../models/repositories';
import {
  formatOkfRoutingMiss,
  formatOkfSearchedAfter,
  formatOkfYield,
} from './okf-tree';

const CELL = 'w-14 shrink-0 text-right font-mono tabular-nums';

/** Header cells of the value-signal columns. */
export function OkfSignalHeaderCells() {
  return (
    <>
      <span className="w-14 shrink-0 text-right" title="Pointer yield">
        Yield
      </span>
      <span className="w-14 shrink-0 text-right" title="Explored after reading">
        Expl. after
      </span>
      <span className="w-14 shrink-0 text-right" title="Routing miss">
        Route miss
      </span>
    </>
  );
}

/** Value-signal cells of one tree row; only file rows carry values. */
export function OkfSignalCells({ node }: { node: OkfTreeNode }) {
  const isFile = node.kind === 'file';
  const routeMiss = isFile ? formatOkfRoutingMiss(node.routingMiss) : '';
  return (
    <>
      <span
        className={`${CELL} text-muted-foreground`}
        data-testid="okf-tree-yield"
      >
        {isFile ? formatOkfYield(node.yield) : ''}
      </span>
      <span
        className={`${CELL} text-muted-foreground`}
        data-testid="okf-tree-searched-after"
      >
        {isFile ? formatOkfSearchedAfter(node.searchedAfter) : ''}
      </span>
      <span
        className={`${CELL} ${routeMiss ? 'text-amber-600 dark:text-amber-400' : ''}`}
        data-testid="okf-tree-route-miss"
      >
        {routeMiss}
      </span>
    </>
  );
}

/** Session tree: POINTERS USED and EXPL. AFTER header cells. */
export function OkfSessionSignalHeaderCells() {
  return (
    <>
      <span
        className="w-14 shrink-0 text-right"
        title="Reads with a new code pointer that was followed / all such reads"
      >
        Ptrs used
      </span>
      <span
        className="w-14 shrink-0 text-right"
        title="Agents that searched the article's code area after reading it · their searches"
      >
        Expl. after
      </span>
    </>
  );
}

/** Session tree: POINTERS USED "k / n" and EXPL. AFTER cells; only file rows carry values. */
export function OkfSessionSignalCells({ node }: { node: OkfTreeNode }) {
  const isFile = node.kind === 'file';
  return (
    <>
      <span
        className={`${CELL} text-muted-foreground`}
        data-testid="okf-tree-pointers-used"
      >
        {isFile ? formatOkfYield(node.yield) : ''}
      </span>
      <span
        className={`${CELL} text-muted-foreground`}
        data-testid="okf-tree-searched-after"
      >
        {isFile ? formatOkfSearchedAfter(node.searchedAfter) : ''}
      </span>
    </>
  );
}

/** Column legend under the repo tree. */
export function OkfTreeLegend() {
  return (
    <div
      data-testid="okf-tree-legend"
      className="space-y-0.5 border-t border-border px-3 py-2 text-[11px] text-muted-foreground"
    >
      <div>
        <span className="font-medium text-foreground">Yield k / n</span> — of n
        reads that showed a new code pointer, k had one followed (— = no read
        showed a new pointer).
      </div>
      <div>
        <span className="font-medium text-foreground">
          Expl. after agents · searches
        </span>{' '}
        — agents that searched the article&apos;s code area after reading it,
        and their searches.
      </div>
      <div>
        <span className="font-medium text-foreground">Route miss X / Y</span> —
        X of the Y agents that searched the article&apos;s area never opened the
        article.
      </div>
      <div>
        Markers: <span className="font-mono">§</span> section reads (ranged, not
        whole-file) · <span className="font-mono">upkeep</span> reads by an
        agent that edited the article, excluded from the totals ·{' '}
        <span className="font-mono">stale</span> the article changed since most
        of its reads · <span className="font-mono">catalog</span> the article
        points to many code files.
      </div>
    </div>
  );
}
