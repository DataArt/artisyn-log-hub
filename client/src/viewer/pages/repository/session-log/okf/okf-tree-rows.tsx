/**
 * Row primitives of the OKF tree. Every row is exactly `ROW_HEIGHT` tall, like the change-surface
 * tree rows, so the two trees read the same. Bars reuse the change-surface `ChurnBar` look: one
 * muted track, a filled share scaled against the top-level (bundle) node of the row.
 */
import { ChevronDown, ChevronRight, Circle } from 'lucide-react';
import { formatBytes } from '@/lib/format';
import type { OkfTreeNode } from '../../../../../models/repositories';
import {
  countFiles,
  heatValue,
  isNotRead,
  OKF_DEAD_MARKER_MIN,
  OKF_ROW_HEIGHT,
  okfPartialReadsText,
  type FlatOkfRow,
  type OkfHeatMetric,
} from './okf-tree';
import {
  OkfSessionSignalCells,
  OkfSessionSignalHeaderCells,
  OkfSignalCells,
  OkfSignalHeaderCells,
} from './okf-tree-columns';

/** Uniform row height, in px (same as the change-surface tree). */
export const ROW_HEIGHT = OKF_ROW_HEIGHT;

/** Name column: keeps a readable minimum and shares the free width with the markers. */
const NAME_COL = 'min-w-32 flex-[1_1_0%]';
/** Markers column: shrinks first and truncates (full text in the title). */
const MARKERS_COL = 'min-w-0 flex-[1_1_0%]';

export type OkfTreeVariant = 'session' | 'repo';

function HeatBar({
  value,
  max,
  colour,
  width,
}: {
  value: number;
  max: number;
  colour: string;
  width: string;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <span
      className={`flex h-1.5 ${width} shrink-0 overflow-hidden rounded-full bg-muted`}
    >
      <span className={`block h-1.5 ${colour}`} style={{ width: `${pct}%` }} />
    </span>
  );
}

/**
 * Text of a 2026-11-03 value-signal marker; `null` hides it. An unknown marker (newer server)
 * is shown as its id.
 */
function valueMarkerLabel(
  m: OkfTreeNode['markers'][number],
  node: OkfTreeNode,
): string | null {
  switch (m) {
    case 'routing_miss':
      return 'routing miss';
    case 'section':
      return okfPartialReadsText(node.rangedCalls ?? 0);
    case 'catalog':
      return `catalog ${node.catalogFiles ?? ''}`.trim();
    case 'dead': {
      const n = node.deadPointers ?? 0;
      return n >= OKF_DEAD_MARKER_MIN ? `${n} dead` : null;
    }
    case 'upkeep':
      return `upkeep ×${node.upkeepReadCalls ?? 0}`;
    case 'stale':
      return node.stale?.size != null
        ? `stale · now ${formatBytes(node.stale.size)}`
        : 'stale';
    case 'not_read':
      return 'not read';
    default:
      return String(m);
  }
}

/** Marker texts of one row (DD-40), plus the info-only "read by N agents". */
function markerLabels(
  node: OkfTreeNode,
  variant: OkfTreeVariant,
  collapsed: boolean,
  folderScans: number,
): string[] {
  const out: string[] = [];
  for (const m of node.markers) {
    if (m === 'entry_point') out.push('entry point');
    else if (m === 'folder_scan') {
      out.push(`grep / ls over folder ×${folderScans}`);
    } else if (m === 'own_edit') {
      out.push(`↻ own edit ${formatBytes(node.ownEditReadBytes)}`);
    } else if (m === 'coarse') out.push('coarse');
    else if (m === 'hot') {
      out.push(node.hotRank ? `🔥 hot #${node.hotRank}` : '🔥 hot');
    } else {
      const label = valueMarkerLabel(m, node);
      if (label) out.push(label);
    }
  }
  if (variant === 'session' && node.kind === 'file' && node.agents > 1) {
    out.push(`read by ${node.agents} agents`);
  }
  if (collapsed && node.kind !== 'file') {
    out.push(`(${countFiles(node)} files)`);
  }
  return out;
}

export function OkfTreeRow({
  entry,
  metric,
  variant,
  bundleLabel,
  bundleIgnored,
  folderScans,
  highlighted,
  onToggle,
  onOpenArticle,
  pointerToggle,
}: {
  entry: FlatOkfRow;
  metric: OkfHeatMetric;
  variant: OkfTreeVariant;
  /** Display label of a top-level node (bundle root or the synthetic group). */
  bundleLabel: string;
  bundleIgnored: boolean;
  /** Grep / ls calls on this folder itself (`folderScanCounts`), children excluded. */
  folderScans: number;
  highlighted: boolean;
  onToggle: (key: string) => void;
  /** Repo tab: a file name opens the article drill-down. */
  onOpenArticle?: (path: string) => void;
  /** Session tab: opens the per-agent new-pointer sub-rows of an article. */
  pointerToggle?: { open: boolean; agents: number; onToggle: () => void };
}) {
  const { node, top } = entry;
  const idle = isNotRead(node);
  const isTop = node.kind === 'bundle';
  const value = heatValue(node, metric);
  const markers = markerLabels(
    node,
    variant,
    entry.hasChildren && !entry.expanded,
    folderScans,
  );
  const label = isTop ? bundleLabel : entry.label;
  const markerText =
    idle && node.kind === 'file' && markers.length === 0
      ? 'not read'
      : markers.join(' · ');

  return (
    <div
      data-okf-key={entry.key}
      data-testid="okf-tree-row"
      className={`flex items-center gap-2 px-2 text-xs ${
        highlighted ? 'bg-accent' : ''
      } ${idle ? 'text-muted-foreground' : ''}`}
      style={{ height: ROW_HEIGHT, paddingLeft: 8 + entry.depth * 14 }}
      title={node.path || label}
    >
      {entry.hasChildren ? (
        <button
          type="button"
          aria-label={entry.expanded ? 'Collapse' : 'Expand'}
          onClick={() => onToggle(entry.key)}
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
      {node.kind === 'file' && onOpenArticle ? (
        <button
          type="button"
          data-testid="okf-tree-file-link"
          onClick={() => onOpenArticle(node.path)}
          className={`${NAME_COL} truncate text-left font-mono hover:underline`}
        >
          {label}
        </button>
      ) : (
        <span
          className={`${NAME_COL} truncate font-mono ${
            node.kind === 'file' ? '' : 'font-medium'
          }`}
        >
          {label}
        </span>
      )}
      {pointerToggle ? (
        <button
          type="button"
          data-testid="okf-pointers-toggle"
          aria-expanded={pointerToggle.open}
          onClick={pointerToggle.onToggle}
          title={`Code paths shown in this article · ${pointerToggle.agents} ${pointerToggle.agents === 1 ? 'agent' : 'agents'}`}
          className="min-w-10 shrink truncate rounded border border-border px-1 text-[10px] text-muted-foreground hover:text-foreground"
        >
          {pointerToggle.open ? '▾' : '▸'} code paths shown ·{' '}
          {pointerToggle.agents}{' '}
          {pointerToggle.agents === 1 ? 'agent' : 'agents'}
        </button>
      ) : null}
      {isTop && bundleIgnored ? (
        <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">
          gitignored
        </span>
      ) : null}
      {!node.inSnapshot && node.kind === 'file' && top.bundle !== null ? (
        <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">
          not in KB at start
        </span>
      ) : null}
      <span
        className={`${MARKERS_COL} truncate text-[11px] text-muted-foreground`}
        title={markerText || undefined}
      >
        {markerText}
      </span>
      <HeatBar
        value={value}
        max={heatValue(top, metric)}
        colour="bg-sky-500"
        width="w-16"
      />
      <span className="w-16 shrink-0 text-right font-mono tabular-nums">
        {value === 0
          ? ''
          : metric === 'bytes'
            ? formatBytes(value)
            : value.toLocaleString()}
      </span>
      {variant === 'repo' ? (
        <span className="w-14 shrink-0 text-right font-mono tabular-nums text-muted-foreground">
          {node.agents > 0 ? node.agents.toLocaleString() : ''}
        </span>
      ) : null}
      {variant === 'repo' ? (
        <OkfSignalCells node={node} />
      ) : (
        <OkfSessionSignalCells node={node} />
      )}
      {variant === 'repo' ? (
        <span
          className="flex w-16 shrink-0 items-center"
          title={`${node.writeCalls} writes`}
        >
          <HeatBar
            value={node.writeCalls}
            max={top.writeCalls}
            colour="bg-amber-500"
            width="w-16"
          />
        </span>
      ) : null}
    </div>
  );
}

/** Column header row of the tree. */
export function OkfTreeHeader({
  metric,
  variant,
}: {
  metric: OkfHeatMetric;
  variant: OkfTreeVariant;
}) {
  return (
    <div className="flex items-end gap-2 border-b border-border px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
      <span className={NAME_COL}>KB folder → file</span>
      <span className={MARKERS_COL}>Markers</span>
      <span className="w-[136px] shrink-0">
        Read ({metric === 'bytes' ? 'bytes' : 'calls'})
      </span>
      {variant === 'repo' ? (
        <span className="w-14 shrink-0 text-right">Sessions</span>
      ) : null}
      {variant === 'repo' ? (
        <OkfSignalHeaderCells />
      ) : (
        <OkfSessionSignalHeaderCells />
      )}
      {variant === 'repo' ? <span className="w-16 shrink-0">Write</span> : null}
    </div>
  );
}
