/**
 * Value-signal columns of the OKF tree (2026-11-03 OKF value signals), their header cells, the
 * column legends under the tree and the session tree's "N articles not read" group row. The
 * numbers come from the server as they are (`yield`, `searchedAfter`, `routingMiss` on a tree
 * node) and are only formatted here.
 *
 * Repo variant: PATHS FOLLOWED, SEARCHED AFTER READING, SEARCHED WITHOUT READING. Session
 * variant: CODE PATHS FOLLOWED, SEARCHED AFTER READING.
 */
import type { OkfTreeNode } from '../../../../../models/repositories';
import {
  formatOkfRoutingMiss,
  formatOkfSearchedAfter,
  formatOkfYield,
  OKF_ROW_HEIGHT,
  type FlatOkfUnreadGroup,
} from './okf-tree';

/** Width of one value-signal column (cells and the two-line header text). */
export const SIGNAL_COL = 'w-14 shrink-0';
const CELL = `${SIGNAL_COL} text-right font-mono tabular-nums`;
const HEAD = `${SIGNAL_COL} text-right leading-tight`;

/** Header cells of the repo value-signal columns. */
export function OkfSignalHeaderCells() {
  return (
    <>
      <span
        className={HEAD}
        title="Of the reads that showed a new code path, how many had one followed"
      >
        Paths followed
      </span>
      <span
        className={HEAD}
        title="Agents that searched the article's code area after reading it · their searches"
      >
        Searched after reading
      </span>
      <span
        className={HEAD}
        title="Agents that searched the article's code area but never opened the article / all agents that searched there"
      >
        Searched without reading
      </span>
    </>
  );
}

/** Value-signal cells of one repo tree row; only file rows carry values. */
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

/** Session tree: CODE PATHS FOLLOWED and SEARCHED AFTER READING header cells. */
export function OkfSessionSignalHeaderCells() {
  return (
    <>
      <span
        className={HEAD}
        title="Reads that showed a new code path which was then followed / all such reads"
      >
        Code paths followed
      </span>
      <span
        className={HEAD}
        title="Agents that searched the article's code area after reading it · their searches"
      >
        Searched after reading
      </span>
    </>
  );
}

/** Session tree: CODE PATHS FOLLOWED "k / n" and SEARCHED AFTER READING cells (file rows only). */
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

function Term({ children }: { children: string }) {
  return <span className="font-medium text-foreground">{children}</span>;
}

const LEGEND =
  'space-y-0.5 border-t border-border px-3 py-2 text-[11px] text-muted-foreground';

/** Column legend under the repo tree. */
export function OkfTreeLegend() {
  return (
    <div data-testid="okf-tree-legend" className={LEGEND}>
      <div>
        <Term>Paths followed k / n</Term> — of n reads that showed a new code
        path, k had one followed (— = no read showed a new path).
      </div>
      <div>
        <Term>Searched after reading agents · searches</Term> — agents that
        searched the article&apos;s code area after reading it, and their
        searches.
      </div>
      <div>
        <Term>Searched without reading X / Y</Term> — X of the Y agents that
        searched the article&apos;s area never opened the article.
      </div>
      <div>
        Markers: <span className="font-mono">partial reads</span> reads of a
        line range, not the whole file ·{' '}
        <span className="font-mono">upkeep</span> reads by an agent that edited
        the article, excluded from the totals ·{' '}
        <span className="font-mono">stale</span> the article changed since most
        of its reads · <span className="font-mono">catalog</span> the article
        points to many code files.
      </div>
    </div>
  );
}

/** Column legend under the session tree. */
export function OkfSessionTreeLegend() {
  return (
    <div data-testid="okf-tree-legend" className={LEGEND}>
      <div>
        <Term>Read</Term> — bytes (or calls) of this KB article that went into
        the agents&apos; context in this session.
      </div>
      <div>
        <Term>Code paths followed k / n</Term> — of n reads that showed a new
        code path, k had one opened afterwards (— = no read showed a new path).
      </div>
      <div>
        <Term>Searched after reading agents · searches</Term> — agents that kept
        searching the article&apos;s code area after reading it.
      </div>
      <div>
        Markers: <span className="font-mono">entry point</span> the first KB
        article an agent opened · <span className="font-mono">read by N</span>{' '}
        several agents read it ·{' '}
        <span className="font-mono">partial reads</span> line-range reads ·{' '}
        <span className="font-mono">upkeep</span> /{' '}
        <span className="font-mono">own edit</span> an agent re-read an article
        it edited itself (KB writes; excluded from the totals) ·{' '}
        <span className="font-mono">grep / ls over folder</span> searches over
        the whole folder · <span className="font-mono">code paths shown</span>{' '}
        opens the code paths each agent saw in the article.
      </div>
    </div>
  );
}

/** Session tree: one row standing for a folder's "not read" children; click shows / hides them. */
export function OkfUnreadGroupRow({
  group,
  onToggle,
}: {
  group: FlatOkfUnreadGroup;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="okf-tree-unread-group"
      aria-expanded={group.open}
      onClick={onToggle}
      className="flex w-full items-center gap-2 px-2 text-left text-[11px] text-muted-foreground hover:bg-accent/40 hover:text-foreground"
      style={{ height: OKF_ROW_HEIGHT, paddingLeft: 8 + group.depth * 14 + 22 }}
    >
      {group.articles.toLocaleString()}{' '}
      {group.articles === 1 ? 'article' : 'articles'} not read in this session ·{' '}
      <span className="underline underline-offset-2">
        {group.open ? 'hide' : 'show'}
      </span>
    </button>
  );
}
