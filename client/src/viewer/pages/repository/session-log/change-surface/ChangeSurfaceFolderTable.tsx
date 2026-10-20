/**
 * The per-folder distribution: which folders absorbed the change, and the tail.
 *
 * Folder identity is the literal full directory path, repo-root-relative and forward-slashed,
 * exactly as the server grouped it — siblings are distinct (`a/b/c` ≠ `a/b/d`) and this
 * table never re-groups them.
 *
 * The single-file tail is collapsed by default: it is usually most of the rows and none of the
 * signal, and it is precisely what antipattern CS-3 reads. `Show tail (N)` reveals it.
 */
import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { formatLinesAdded, formatLinesRemoved } from '@/lib/change-surface-ui';
import type { ChangeSurfaceFolderRow } from '../../../../../models/repositories';

function FolderRow({
  row,
  maxFiles,
  onSelect,
}: {
  row: ChangeSurfaceFolderRow;
  maxFiles: number;
  onSelect: (folder: string) => void;
}) {
  const pct = maxFiles > 0 ? Math.round((row.files / maxFiles) * 100) : 0;
  return (
    <button
      type="button"
      onClick={() => onSelect(row.folder)}
      title={`Show ${row.folder} in the file tree`}
      className="flex w-full items-center gap-3 rounded px-2 py-1 text-left text-xs transition-colors hover:bg-accent/50"
    >
      <span className="min-w-0 flex-1 truncate font-mono">
        {row.folder === '.' ? '. (repo root)' : row.folder}
      </span>
      <span className="h-1.5 w-24 shrink-0 rounded-full bg-muted">
        <span
          className="block h-1.5 rounded-full bg-blue-500"
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="w-10 shrink-0 text-right font-mono tabular-nums">
        {row.files.toLocaleString()}
      </span>
      <span className="w-16 shrink-0 text-right font-mono tabular-nums text-green-600">
        {formatLinesAdded(row.linesAdded)}
      </span>
      <span className="w-16 shrink-0 text-right font-mono tabular-nums text-red-600">
        {formatLinesRemoved(row.linesRemoved)}
      </span>
    </button>
  );
}

export function ChangeSurfaceFolderTable({
  folders,
  onFolderSelect,
}: {
  folders: readonly ChangeSurfaceFolderRow[];
  /** Click-through into the tree (the tree filters down to that folder). */
  onFolderSelect: (folder: string) => void;
}) {
  const [tailOpen, setTailOpen] = useState(false);

  const { head, tail, maxFiles } = useMemo(() => {
    const sorted = [...folders].sort(
      (a, b) => b.files - a.files || a.folder.localeCompare(b.folder),
    );
    const multi = sorted.filter((f) => f.files > 1);
    // When *every* folder holds exactly one file there is no tail to hide — splitting it off
    // would leave the table empty behind a toggle.
    const hasSplit = multi.length > 0;
    return {
      head: hasSplit ? multi : sorted,
      tail: hasSplit ? sorted.filter((f) => f.files <= 1) : [],
      maxFiles: sorted[0]?.files ?? 0,
    };
  }, [folders]);

  return (
    <div
      data-testid="change-surface-folder-table"
      className="rounded-md border border-border bg-card px-4 py-3"
    >
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Per-folder distribution
      </div>
      <div className="mt-0.5 text-[11px] text-muted-foreground/80">
        Sorted by file count; click a row to show it in the tree below.
      </div>

      {folders.length === 0 ? (
        <div className="mt-2 text-xs text-muted-foreground">
          No folders touched
        </div>
      ) : (
        <div className="mt-2 space-y-0.5">
          {head.map((row) => (
            <FolderRow
              key={row.folder}
              row={row}
              maxFiles={maxFiles}
              onSelect={onFolderSelect}
            />
          ))}
          {tail.length > 0 && (
            <div className="pt-1">
              {tailOpen ? (
                <div className="space-y-0.5">
                  {tail.map((row) => (
                    <FolderRow
                      key={row.folder}
                      row={row}
                      maxFiles={maxFiles}
                      onSelect={onFolderSelect}
                    />
                  ))}
                </div>
              ) : (
                <div className="px-2 text-[11px] text-muted-foreground">
                  Tail: {tail.length.toLocaleString()} more folder
                  {tail.length === 1 ? '' : 's'} with exactly 1 changed file
                  each
                </div>
              )}
              <button
                type="button"
                onClick={() => setTailOpen((v) => !v)}
                className="mt-1 flex items-center gap-1 px-2 text-xs text-primary hover:underline"
              >
                <ChevronRight
                  className={`size-3 transition-transform ${tailOpen ? 'rotate-90' : ''}`}
                />
                {tailOpen
                  ? 'Hide tail'
                  : `Show tail (${tail.length.toLocaleString()})`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
