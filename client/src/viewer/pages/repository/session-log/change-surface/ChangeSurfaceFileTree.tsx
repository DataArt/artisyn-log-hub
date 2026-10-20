/**
 * The code-review-style tree of changed paths.
 *
 * Folder rows aggregate their children's `+`/`−`, so the root row is the exact sum of the
 * leaves shown — that is the sum identity, and it holds over the rows *currently displayed*
 * (a filter narrows both sides of it at once). The trailing "Outside repo / unnormalised"
 * group is deliberately outside that equality: those paths are excluded from every folder,
 * spread, module and percentage figure, and are listed only for transparency.
 *
 * All rows render unconditionally — no inner scroll container. A fixed-height virtualised
 * viewport nested inside the page's own scroll produced a "scroll in a scroll" that only moved
 * a few rows at a time instead of the page; scrolling this tree is just scrolling the page.
 */
import { useMemo, useState } from 'react';
import { Input } from '@/ui/input';
import type { ChangeSurfaceFileRow } from '../../../../../models/repositories';
import {
  buildChangeSurfaceTree,
  collectFolderPaths,
  flattenVisibleRows,
  type ChangeSurfaceSortKey,
} from './change-surface-tree';
import {
  NodeRow,
  OutsideFileRow,
  OutsideGroupRow,
  type RenderRow,
} from './change-surface-tree-rows';

export interface ChangeSurfaceFileTreeProps {
  rows: readonly ChangeSurfaceFileRow[];
  /** Total paths the server holds; larger than `rows.length` when the response was capped. */
  total: number;
  truncated: boolean;
  /** Controlled, so the folder table's click-through can drive it. */
  filter: string;
  onFilterChange: (value: string) => void;
}

export function ChangeSurfaceFileTree({
  rows,
  total,
  truncated,
  filter,
  onFilterChange,
}: ChangeSurfaceFileTreeProps) {
  const [sort, setSort] = useState<ChangeSurfaceSortKey>('lines');
  const [collapseSingleChild, setCollapseSingleChild] = useState(true);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [outsideOpen, setOutsideOpen] = useState(false);

  const tree = useMemo(
    () => buildChangeSurfaceTree(rows, { filter, sort, collapseSingleChild }),
    [rows, filter, sort, collapseSingleChild],
  );

  const renderRows = useMemo<RenderRow[]>(() => {
    const out: RenderRow[] = flattenVisibleRows(tree.root, collapsed).map(
      (entry) => ({ kind: 'node', ...entry }),
    );
    if (tree.outside.files > 0) {
      out.push({
        kind: 'outside-group',
        files: tree.outside.files,
        linesAdded: tree.outside.linesAdded,
        linesRemoved: tree.outside.linesRemoved,
      });
      if (outsideOpen) {
        for (const row of tree.outside.rows) {
          out.push({ kind: 'outside-file', row });
        }
      }
    }
    return out;
  }, [tree, collapsed, outsideOpen]);

  const toggle = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div
      data-testid="change-surface-file-tree"
      className="rounded-md border border-border bg-card"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Input
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder="Filter paths…"
          aria-label="Filter paths"
          className="h-7 w-56 text-xs"
        />
        <button
          type="button"
          onClick={() => setCollapsed(new Set(collectFolderPaths(tree.root)))}
          className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        >
          Collapse all
        </button>
        <button
          type="button"
          onClick={() => setCollapsed(new Set())}
          className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        >
          Expand all
        </button>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          Sort:
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as ChangeSurfaceSortKey)}
            aria-label="Sort tree"
            className="rounded border border-border bg-transparent px-1 py-0.5 text-xs"
          >
            <option value="lines">lines changed</option>
            <option value="files">files</option>
            <option value="path">path</option>
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={collapseSingleChild}
            onChange={(e) => setCollapseSingleChild(e.target.checked)}
          />
          Collapse single-child
        </label>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          {tree.files.toLocaleString()} files · {tree.folders.toLocaleString()}{' '}
          folders · {tree.modules.toLocaleString()} modules
        </span>
      </div>

      <div className="flex items-center gap-2 border-b border-border px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        <span className="min-w-0 flex-1">Path</span>
        <span className="w-10 shrink-0 text-right">Files</span>
        <span className="w-16 shrink-0 text-right">+</span>
        <span className="w-16 shrink-0 text-right">−</span>
        <span className="w-28 shrink-0">Churn</span>
      </div>

      {renderRows.length === 0 ? (
        <div className="px-3 py-6 text-center text-xs text-muted-foreground">
          No paths match this filter
        </div>
      ) : (
        <div>
          {renderRows.map((entry, i) => {
            if (entry.kind === 'node') {
              return (
                <NodeRow
                  key={`n:${entry.node.path}`}
                  entry={entry}
                  maxChurn={tree.maxChurn}
                  onToggle={toggle}
                />
              );
            }
            if (entry.kind === 'outside-group') {
              return (
                <OutsideGroupRow
                  key="outside-group"
                  files={entry.files}
                  linesAdded={entry.linesAdded}
                  linesRemoved={entry.linesRemoved}
                  open={outsideOpen}
                  onToggle={() => setOutsideOpen((v) => !v)}
                />
              );
            }
            return (
              <OutsideFileRow
                key={`o:${entry.row.rawPath}:${i}`}
                row={entry.row}
              />
            );
          })}
        </div>
      )}

      {truncated && (
        <div className="border-t border-border px-3 py-1.5 text-[11px] text-amber-700">
          Showing the first {rows.length.toLocaleString()} of{' '}
          {total.toLocaleString()} paths — the tree below that cap is not the
          whole session.
        </div>
      )}
    </div>
  );
}
