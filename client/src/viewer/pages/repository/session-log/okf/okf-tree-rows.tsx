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
  type FlatOkfRow,
  type OkfHeatMetric,
} from './okf-tree';

/** Uniform row height, in px (same as the change-surface tree). */
export const ROW_HEIGHT = 28;

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
    }
  }
  if (variant === 'session' && node.kind === 'file' && node.agents > 1) {
    out.push(`read by ${node.agents}`);
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
      <span
        className={`min-w-0 flex-1 truncate font-mono ${
          node.kind === 'file' ? '' : 'font-medium'
        }`}
      >
        {label}
      </span>
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
      <span className="w-48 shrink-0 truncate text-[11px] text-muted-foreground">
        {idle && node.kind === 'file' ? 'not read' : markers.join(' · ')}
      </span>
      <HeatBar
        value={value}
        max={heatValue(top, metric)}
        colour="bg-sky-500"
        width="w-24"
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
    <div className="flex items-center gap-2 border-b border-border px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
      <span className="min-w-0 flex-1">Bundle → folder → file</span>
      <span className="w-48 shrink-0">Markers</span>
      <span className="w-[168px] shrink-0">
        Read ({metric === 'bytes' ? 'bytes' : 'calls'})
      </span>
      {variant === 'repo' ? (
        <span className="w-14 shrink-0 text-right">Sessions</span>
      ) : null}
      <span className="w-16 shrink-0">Write</span>
    </div>
  );
}
