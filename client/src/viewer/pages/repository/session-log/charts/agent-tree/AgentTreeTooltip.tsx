import { cn } from '@/lib/cn';
import { formatCost, formatDuration } from '@/lib/format';
import type { AgentNode } from '../chart-data';
import { CHART_TOOLTIP_CLASS } from '../chart-tooltip-class';

export interface TooltipInfo {
  node: AgentNode;
  x: number;
  y: number;
}

export function AgentTreeTooltip({ info }: { info: TooltipInfo }) {
  const { node } = info;
  return (
    <div
      className={cn(CHART_TOOLTIP_CLASS, 'max-w-xs')}
      style={{ left: info.x + 12, top: info.y - 10 }}
    >
      <div className="mb-1 font-medium">{node.slug}</div>
      {node.isWorkflow ? (
        <>
          <div>Agents: {node.turnCount}</div>
          <div>Duration: {formatDuration(node.totalDurationMs)}</div>
        </>
      ) : node.isGroup ? (
        <>
          <div>Total cost: {formatCost(node.totalCost)}</div>
          <div>Total agents: {node.children.length}</div>
        </>
      ) : (
        <>
          {node.prompt && (
            <div className="mb-1 line-clamp-3 text-muted-foreground">
              {node.prompt}
            </div>
          )}
          {node.totalCost != null && node.totalCost > 0 && (
            <div>Cost: {formatCost(node.totalCost)}</div>
          )}
          <div>Duration: {formatDuration(node.totalDurationMs)}</div>
          {node.model && <div>Model: {node.model}</div>}
        </>
      )}
    </div>
  );
}
