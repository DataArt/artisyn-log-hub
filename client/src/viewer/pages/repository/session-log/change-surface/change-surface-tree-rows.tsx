/**
 * The row primitives of the change-surface file tree.
 *
 * Split out of `ChangeSurfaceFileTree.tsx` so that component stays the windowing/toolbar shell:
 * these are pure presentational rows with no state of their own. Every row is exactly
 * `ROW_HEIGHT` tall — the hand-rolled window's `scrollTop → [start, end)` maths depends on it,
 * so any change here must keep the height fixed (Tailwind's `border-box` keeps borders and
 * padding inside it).
 */
import { ChevronDown, ChevronRight, Circle } from 'lucide-react';
import { formatLinesAdded, formatLinesRemoved } from '@/lib/change-surface-ui';
import type { ChangeSurfaceFileRow } from '../../../../../models/repositories';
import type {
  ChangeSurfaceTreeNode,
  FlatChangeSurfaceRow,
} from './change-surface-tree';

/** Uniform row height, in px — the windowing maths depends on it being exact. */
export const ROW_HEIGHT = 28;

/** One entry of the flat, windowable list: an in-repo node, or the out-of-repo group. */
export type RenderRow =
  | ({ kind: 'node' } & FlatChangeSurfaceRow)
  | {
      kind: 'outside-group';
      files: number;
      linesAdded: number;
      linesRemoved: number;
    }
  | { kind: 'outside-file'; row: ChangeSurfaceFileRow };

/**
 * Green added / red removed on one shared track, scaled against the largest row in the current
 * tree — so bar length is comparable between rows, not per-row normalised.
 */
function ChurnBar({
  linesAdded,
  linesRemoved,
  maxChurn,
}: {
  linesAdded: number;
  linesRemoved: number;
  maxChurn: number;
}) {
  const scale = maxChurn > 0 ? 100 / maxChurn : 0;
  return (
    <span className="flex h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-muted">
      <span
        className="block h-1.5 bg-green-500"
        style={{ width: `${Math.min(100, linesAdded * scale)}%` }}
      />
      <span
        className="block h-1.5 bg-red-500"
        style={{ width: `${Math.min(100, linesRemoved * scale)}%` }}
      />
    </span>
  );
}

export function NodeRow({
  entry,
  maxChurn,
  onToggle,
}: {
  entry: { kind: 'node' } & FlatChangeSurfaceRow;
  maxChurn: number;
  onToggle: (path: string) => void;
}) {
  const node: ChangeSurfaceTreeNode = entry.node;
  const isFolder = node.kind === 'folder';
  const leafRow = node.row;
  const chainHint =
    node.collapsedFrom.length > 1
      ? `collapsed single-child chain: ${node.collapsedFrom.join(' › ')}`
      : undefined;

  return (
    <div
      className="flex items-center gap-2 px-2 text-xs"
      style={{ height: ROW_HEIGHT, paddingLeft: 8 + entry.depth * 14 }}
      title={chainHint ?? node.path}
    >
      {entry.hasChildren ? (
        <button
          type="button"
          aria-label={entry.expanded ? 'Collapse' : 'Expand'}
          onClick={() => onToggle(node.path)}
          className="flex size-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
        >
          {entry.expanded ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
        </button>
      ) : (
        <Circle className="size-1.5 shrink-0 fill-current text-muted-foreground/60" />
      )}
      <span
        className={`min-w-0 flex-1 truncate font-mono ${isFolder ? 'font-medium' : ''}`}
      >
        {node.label}
      </span>
      {leafRow ? (
        <>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {leafRow.changeKind}
          </span>
          {leafRow.diffCoveredCalls === 0 ? (
            <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">
              no diff coverage
            </span>
          ) : null}
        </>
      ) : null}
      <span className="w-10 shrink-0 text-right font-mono tabular-nums text-muted-foreground">
        {isFolder ? node.files.toLocaleString() : ''}
      </span>
      <span className="w-16 shrink-0 text-right font-mono tabular-nums text-green-600">
        {formatLinesAdded(node.linesAdded)}
      </span>
      <span className="w-16 shrink-0 text-right font-mono tabular-nums text-red-600">
        {formatLinesRemoved(node.linesRemoved)}
      </span>
      <ChurnBar
        linesAdded={node.linesAdded}
        linesRemoved={node.linesRemoved}
        maxChurn={maxChurn}
      />
    </div>
  );
}

/**
 * The trailing group header. Its counts are deliberately *not* part of the root row's sum
 * equality — the wording says so on the row itself, so the two totals can never be read as one.
 */
export function OutsideGroupRow({
  files,
  linesAdded,
  linesRemoved,
  open,
  onToggle,
}: {
  files: number;
  linesAdded: number;
  linesRemoved: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{ height: ROW_HEIGHT }}
      className="flex w-full items-center gap-2 border-t border-border px-2 text-left text-xs text-muted-foreground hover:bg-accent/50"
    >
      {open ? (
        <ChevronDown className="size-3 shrink-0" />
      ) : (
        <ChevronRight className="size-3 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">
        Outside repo / unnormalised ({files.toLocaleString()}) — excluded from
        the root totals above
      </span>
      <span className="w-16 shrink-0 text-right font-mono tabular-nums text-green-600">
        {formatLinesAdded(linesAdded)}
      </span>
      <span className="w-16 shrink-0 text-right font-mono tabular-nums text-red-600">
        {formatLinesRemoved(linesRemoved)}
      </span>
    </button>
  );
}

/**
 * One out-of-repo path. It prints the raw path — that is all there is: nothing normalised, so
 * there is no repo-relative spelling to show.
 */
export function OutsideFileRow({ row }: { row: ChangeSurfaceFileRow }) {
  return (
    <div
      style={{ height: ROW_HEIGHT, paddingLeft: 22 }}
      className="flex items-center gap-2 px-2 text-xs"
      title={row.rawPath}
    >
      <span className="min-w-0 flex-1 truncate font-mono">{row.rawPath}</span>
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {row.changeKind}
      </span>
      <span className="w-16 shrink-0 text-right font-mono tabular-nums text-green-600">
        {formatLinesAdded(row.linesAdded)}
      </span>
      <span className="w-16 shrink-0 text-right font-mono tabular-nums text-red-600">
        {formatLinesRemoved(row.linesRemoved)}
      </span>
    </div>
  );
}
