// Partition table of the "System context anatomy" tab (impl-plan DD 6, 13, 15): one row per
// partition kind, an expand chevron on kinds with drill-down rows, row selection shared with the
// bar, and an info icon on the Harness internals row that shows the internals hint.
import { ChevronDown, ChevronRight, Info } from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/tooltip';
import type { AnatomyPartition, SysctxAnatomy } from './sysctx-anatomy';
import {
  KIND_COLORS,
  type AnatomyPartitionKind,
} from './sysctx-anatomy-constants';
import {
  fmtBytesOrDash,
  fmtInt,
  fmtShare,
  InternalsHintContent,
  NumCell,
  sourceLabel,
} from './AnatomyCells';
import { PartitionDrilldown } from './AnatomyDrilldowns';

const COLUMNS = [
  'Partition',
  'Kind',
  'Source',
  '#Bytes',
  '#≈ Tokens',
  '#Share',
];

function InternalsInfo({
  anatomy,
  p,
}: {
  anatomy: SysctxAnatomy;
  p: AnatomyPartition;
}) {
  if (anatomy.total === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid="anatomy-internals-hint"
          aria-label="What is in Harness internals"
          className="ml-1 inline-flex align-middle text-muted-foreground hover:text-foreground"
          onClick={(e) => e.stopPropagation()}
        >
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={6}>
        <InternalsHintContent
          internals={p.tokens}
          share={p.share}
          total={anatomy.total}
          attributed={anatomy.attributed}
        />
      </TooltipContent>
    </Tooltip>
  );
}

function partitionSource(p: AnatomyPartition): string {
  // Skills and instruction files have a source per row.
  return p.source === null ? 'per row' : sourceLabel(p.source);
}

export interface AnatomyPartitionTableProps {
  anatomy: SysctxAnatomy;
  selectedKind: AnatomyPartitionKind | null;
  expanded: ReadonlySet<AnatomyPartitionKind>;
  onSelect: (kind: AnatomyPartitionKind) => void;
  onToggleExpand: (kind: AnatomyPartitionKind) => void;
}

export function AnatomyPartitionTable({
  anatomy,
  selectedKind,
  expanded,
  onSelect,
  onToggleExpand,
}: AnatomyPartitionTableProps) {
  return (
    <TooltipProvider delayDuration={150}>
      <table className="w-full text-sm" data-testid="anatomy-partition-table">
        <thead>
          <tr className="border-b border-border text-[11px] tracking-wide text-muted-foreground uppercase">
            {COLUMNS.map((c) => (
              <th
                key={c}
                className={cn(
                  'px-2 py-1.5 font-medium whitespace-nowrap',
                  c.startsWith('#') ? 'text-right' : 'text-left',
                )}
              >
                {c.replace(/^#/, '')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {anatomy.partitions.map((p) => {
            const hasChildren = p.rows.length > 0;
            const isOpen = hasChildren && expanded.has(p.kind);
            const selected = selectedKind === p.kind;
            return (
              <PartitionRows
                key={p.kind}
                anatomy={anatomy}
                p={p}
                hasChildren={hasChildren}
                isOpen={isOpen}
                selected={selected}
                onSelect={onSelect}
                onToggleExpand={onToggleExpand}
              />
            );
          })}
        </tbody>
      </table>
    </TooltipProvider>
  );
}

function PartitionRows({
  anatomy,
  p,
  hasChildren,
  isOpen,
  selected,
  onSelect,
  onToggleExpand,
}: {
  anatomy: SysctxAnatomy;
  p: AnatomyPartition;
  hasChildren: boolean;
  isOpen: boolean;
  selected: boolean;
  onSelect: (kind: AnatomyPartitionKind) => void;
  onToggleExpand: (kind: AnatomyPartitionKind) => void;
}) {
  const internals = p.kind === 'harness-internals';
  return (
    <>
      <tr
        data-testid="anatomy-partition-row"
        data-kind={p.kind}
        aria-selected={selected}
        onClick={() => onSelect(p.kind)}
        className={cn(
          'cursor-pointer border-b border-border/60 hover:bg-muted/40',
          selected && 'bg-primary/5 hover:bg-primary/5',
        )}
      >
        <td className="px-2 py-1.5">
          <div className="flex items-center gap-1.5">
            {hasChildren ? (
              <button
                type="button"
                aria-label={isOpen ? 'Collapse' : 'Expand'}
                aria-expanded={isOpen}
                className="text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleExpand(p.kind);
                }}
              >
                {isOpen ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
              </button>
            ) : (
              <span className="inline-block size-3.5" />
            )}
            <span
              aria-hidden
              className="inline-block size-2.5 shrink-0 rounded-[2px]"
              style={{
                background: internals
                  ? 'repeating-linear-gradient(45deg, #cbd5e1 0, #cbd5e1 2px, #f1f5f9 2px, #f1f5f9 4px)'
                  : KIND_COLORS[p.kind],
              }}
            />
            <span>{p.label}</span>
            {p.count !== undefined && (
              <span className="text-xs text-muted-foreground">
                · {fmtInt(p.count)} names
              </span>
            )}
            {internals && <InternalsInfo anatomy={anatomy} p={p} />}
          </div>
        </td>
        <td className="px-2 py-1.5 font-mono text-xs text-muted-foreground">
          {p.kind}
        </td>
        <td className="px-2 py-1.5 text-muted-foreground">
          {partitionSource(p)}
        </td>
        <NumCell className="py-1.5">{fmtBytesOrDash(p.bytes)}</NumCell>
        <NumCell className="py-1.5">{fmtInt(p.tokens)}</NumCell>
        <NumCell className="py-1.5">{fmtShare(p.share)}</NumCell>
      </tr>
      {isOpen && (
        <tr className="border-b border-border/60 bg-muted/20">
          <td colSpan={COLUMNS.length} className="py-1.5 pr-2 pl-6">
            <PartitionDrilldown partition={p} />
          </td>
        </tr>
      )}
    </>
  );
}
