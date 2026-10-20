/**
 * The "Harness usage" tab's left pane: the Explorer-style session tree.
 *
 * Geometry is deliberately the change-surface tree's (`ROW_HEIGHT = 28`,
 * `paddingLeft: 8 + depth * 14`, chevron toggles) so the two trees in the session view read as
 * one component. Every row renders unconditionally — no inner windowing, for the same reason
 * that file records: a scroll container nested inside the pane's own reads as broken.
 *
 * Purely presentational: rows, selection and collapse state are owned by the tab shell.
 */
import { ChevronDown, ChevronRight, Circle } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { FlatHarnessRow } from './harness-session-tree';

/** Uniform row height, in px — matches the change-surface tree. */
export const HARNESS_ROW_HEIGHT = 28;

export interface HarnessSessionTreeProps {
  rows: FlatHarnessRow[];
  selectedNodeId: string;
  /** Node id → OWN element count. Never subtree-aggregated, so siblings stay comparable. */
  countByNodeId: Map<string, number>;
  onSelect: (nodeId: string) => void;
  onToggle: (nodeId: string) => void;
}

export function HarnessSessionTree({
  rows,
  selectedNodeId,
  countByNodeId,
  onSelect,
  onToggle,
}: HarnessSessionTreeProps) {
  return (
    <div>
      {rows.map((row) => {
        const { node } = row;
        const count = countByNodeId.get(node.id) ?? 0;
        const selected = node.id === selectedNodeId;
        return (
          <div
            key={node.id}
            data-testid="harness-tree-row"
            data-node-id={node.id}
            className={cn(
              'flex cursor-pointer items-center gap-1.5 px-2 text-xs',
              selected
                ? 'bg-accent text-accent-foreground'
                : 'hover:bg-muted/40',
            )}
            style={{
              height: HARNESS_ROW_HEIGHT,
              paddingLeft: 8 + row.depth * 14,
            }}
            title={node.titleHint ?? node.label}
            onClick={() => onSelect(node.id)}
          >
            {row.hasChildren ? (
              <button
                type="button"
                aria-label={row.expanded ? 'Collapse' : 'Expand'}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(node.id);
                }}
                className="flex size-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
              >
                {row.expanded ? (
                  <ChevronDown className="size-3" />
                ) : (
                  <ChevronRight className="size-3" />
                )}
              </button>
            ) : (
              <Circle className="size-1.5 shrink-0 fill-current text-muted-foreground/60" />
            )}
            <span className="min-w-0 flex-1 truncate">
              <span
                className={cn(node.kind === 'workflow-group' && 'font-medium')}
              >
                {node.label}
              </span>
              {node.shortId ? (
                <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                  {node.shortId}
                </span>
              ) : null}
              {node.subtitle ? (
                <span className="ml-1 text-[10px] text-muted-foreground">
                  {node.subtitle}
                </span>
              ) : null}
            </span>
            <span
              data-testid="harness-node-badge"
              className={cn(
                'shrink-0 rounded px-1.5 text-[10px] tabular-nums',
                count > 0
                  ? 'bg-muted text-foreground/80'
                  : 'text-muted-foreground/50',
              )}
            >
              {count}
            </span>
          </div>
        );
      })}
    </div>
  );
}
