/**
 * One 24 px row of the Tools/MCP tree: chevron, channel badge, name, calls number, a bar
 * ∝ calls / the busiest tool's calls and the coloured error % chip; `never called` rows are
 * greyed and italic instead.
 */
import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import type {
  ToolUsageAgg,
  ToolUsageChannel,
} from '../../../../models/tool-monitoring';
import { ChannelBadge } from './ChannelBadge';
import { errorPct, errorPctClass, formatPct } from './tools-tree-model';

export interface TreeRowProps {
  level: number;
  label: ReactNode;
  title: string;
  agg: ToolUsageAgg;
  maxCalls: number;
  selected: boolean;
  onSelect: () => void;
  expanded?: boolean;
  onToggle?: () => void;
  badge?: ToolUsageChannel;
  neverCalled?: boolean;
  testId: string;
}

export function TreeRow({
  level,
  label,
  title,
  agg,
  maxCalls,
  selected,
  onSelect,
  expanded,
  onToggle,
  badge,
  neverCalled,
  testId,
}: TreeRowProps) {
  const pct = errorPct(agg);
  const barPct = maxCalls > 0 ? Math.min(100, (agg.calls / maxCalls) * 100) : 0;
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      aria-expanded={onToggle ? expanded : undefined}
      aria-level={level + 1}
      onClick={onSelect}
      title={title}
      data-testid={testId}
      className={cn(
        'flex h-6 cursor-pointer items-center gap-1.5 pr-2 text-xs',
        selected ? 'bg-blue-50 text-foreground' : 'hover:bg-muted/50',
        neverCalled && 'italic text-muted-foreground',
      )}
      style={{ paddingLeft: 4 + level * 14 }}
    >
      {onToggle ? (
        <button
          type="button"
          aria-label={expanded ? 'Collapse' : 'Expand'}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent"
        >
          {expanded ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
        </button>
      ) : (
        <span className="size-4 shrink-0" />
      )}
      {badge ? <ChannelBadge channel={badge} /> : null}
      <span className="min-w-0 flex-1 truncate font-mono">{label}</span>
      {neverCalled ? (
        <span className="shrink-0 text-[10px]">never called</span>
      ) : (
        <>
          <span className="w-9 shrink-0 text-right font-mono tabular-nums">
            {agg.calls}
          </span>
          <span className="h-1.5 w-10 shrink-0 overflow-hidden rounded bg-muted">
            <span
              className="block h-full rounded bg-blue-400"
              style={{ width: `${barPct}%` }}
            />
          </span>
          <span
            className={cn(
              'w-11 shrink-0 rounded px-1 text-right font-mono text-[10px] tabular-nums',
              errorPctClass(pct),
            )}
            title="Error % = (errors + killed) / calls"
          >
            {formatPct(pct)}
          </span>
        </>
      )}
    </div>
  );
}
