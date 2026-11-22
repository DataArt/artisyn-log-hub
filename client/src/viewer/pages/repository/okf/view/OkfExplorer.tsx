/**
 * "Explorer" of the OKF view: the KB folders of the snapshot as a tree, with how many of their
 * files were opened. Three filter chips — All, Opened, Never opened — and everything collapsed
 * at first. The filter and the open folders are local state. The tree itself is built by
 * `okf-explorer-tree.ts` from the response's `files` and `folders`.
 */
import { useMemo, useState } from 'react';
import type {
  OkfUsageFile,
  OkfUsageFolder,
  OkfUsageUnit,
  OkfUsageVersionRow,
} from '../../../../../models/repositories';
import { OKF_EXPLORER_COL, OkfExplorerRowView } from './OkfExplorerRow';
import {
  buildOkfExplorerTree,
  okfExplorerCounts,
  okfExplorerRows,
  type OkfExplorerFilter,
} from './okf-explorer-tree';
import { OKF_EXPLORER_HEADER_TAIL, OKF_UNIT_LABEL } from './okf-view-text';

const EMPTY_TEXT: Record<OkfExplorerFilter, string> = {
  all: 'No KB files',
  opened: 'No KB file was opened',
  never: 'Every KB file was opened',
};

export function OkfExplorer({
  files,
  folders,
  versions,
  unit,
  notInSnapshotUnits,
}: {
  files: OkfUsageFile[];
  folders: OkfUsageFolder[];
  /** Source of the "not in git" chip on a bundle root. */
  versions: OkfUsageVersionRow[];
  unit: OkfUsageUnit;
  notInSnapshotUnits: number;
}) {
  const [filter, setFilter] = useState<OkfExplorerFilter>('all');
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());

  const tree = useMemo(
    () => buildOkfExplorerTree(files, folders),
    [files, folders],
  );
  const counts = okfExplorerCounts(tree);
  const rows = useMemo(
    () => okfExplorerRows(tree, filter, open, notInSnapshotUnits),
    [tree, filter, open, notInSnapshotUnits],
  );
  const ignoredRoots = useMemo(
    () => new Set(versions.filter((v) => v.ignored).map((v) => v.root)),
    [versions],
  );

  const toggle = (key: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const chips: { value: OkfExplorerFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'opened', label: `Opened (${counts.opened})` },
    { value: 'never', label: `Never opened (${counts.never})` },
  ];

  return (
    <section
      data-testid="okf-tree"
      className="rounded-md border border-border bg-card p-3"
    >
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold text-foreground">Explorer</h3>
        <span
          data-testid="okf-tree-header"
          className="text-xs tabular-nums text-muted-foreground"
        >
          {tree.filesOpened} of {tree.filesTotal} files opened
          {OKF_EXPLORER_HEADER_TAIL[unit]}
        </span>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {chips.map((chip) => (
          <button
            key={chip.value}
            type="button"
            data-testid={`okf-tree-filter-${chip.value}`}
            aria-pressed={chip.value === filter}
            onClick={() => setFilter(chip.value)}
            className={
              chip.value === filter
                ? 'rounded-full bg-primary px-2.5 py-0.5 text-xs font-semibold text-primary-foreground'
                : 'rounded-full border border-border px-2.5 py-0.5 text-xs text-foreground hover:bg-accent/50'
            }
          >
            {chip.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 border-b border-border py-1 pl-1 pr-1 text-[11px] font-medium text-muted-foreground">
        <span className="min-w-0 flex-1">File / folder</span>
        {filter === 'never' ? (
          <span className={OKF_EXPLORER_COL.files}>Never opened</span>
        ) : (
          <>
            <span className={OKF_EXPLORER_COL.files}>Files opened</span>
            <span className={OKF_EXPLORER_COL.units}>
              {OKF_UNIT_LABEL[unit]}
            </span>
            <span className={OKF_EXPLORER_COL.tokens}>≈ Tokens</span>
          </>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="py-2 text-xs text-muted-foreground">
          {EMPTY_TEXT[filter]}
        </div>
      ) : (
        <div className="pt-1">
          {rows.map((row) => (
            <OkfExplorerRowView
              key={row.key}
              row={row}
              filter={filter}
              ignored={row.bundle !== undefined && ignoredRoots.has(row.bundle)}
              onToggle={toggle}
            />
          ))}
        </div>
      )}
    </section>
  );
}
