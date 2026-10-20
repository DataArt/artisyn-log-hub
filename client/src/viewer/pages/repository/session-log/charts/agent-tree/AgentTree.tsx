import { useCallback, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card';
import { useDragScroll } from '@/hooks/useDragScroll';
import type { AgentNode } from '../chart-data';
import { AgentTreeNodeDetailModal } from './AgentTreeNodeDetailModal';
import { AgentTreeTooltip, type TooltipInfo } from './AgentTreeTooltip';
import { computeLayout, subtreeBottom, subtreeRight } from './layout';
import { TreeNode } from './TreeNode';

export interface AgentTreeProps {
  data: AgentNode;
  selectedAgentId?: string | null;
  onSelectAgent?: (agentId: string) => void;
}

function indexById(node: AgentNode, into: Map<string, AgentNode>): void {
  into.set(node.agentId, node);
  for (const child of node.children) indexById(child, into);
}

export function AgentTree({
  data,
  selectedAgentId,
  onSelectAgent,
}: AgentTreeProps) {
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);
  const [detailNode, setDetailNode] = useState<AgentNode | null>(null);
  const dragScroll = useDragScroll<HTMLDivElement>();

  const layout = useMemo(() => computeLayout(data), [data]);
  const [svgWidth, svgHeight] = useMemo(
    () => [subtreeRight(layout) + 16, subtreeBottom(layout) + 16],
    [layout],
  );
  const nodesById = useMemo(() => {
    const map = new Map<string, AgentNode>();
    indexById(data, map);
    return map;
  }, [data]);

  const handleHover = useCallback((node: AgentNode, e: React.MouseEvent) => {
    setTooltip({ node, x: e.clientX, y: e.clientY });
  }, []);
  const handleLeave = useCallback(() => setTooltip(null), []);

  const handleSelectAgent = useCallback(
    (agentId: string) => {
      onSelectAgent?.(agentId);
      const node = nodesById.get(agentId);
      if (node) setDetailNode(node);
    },
    [onSelectAgent, nodesById],
  );

  if (data.children.length === 0) {
    return (
      <Card className="min-w-0 gap-0 py-0">
        <CardHeader className="px-3 pb-0 pt-3">
          <CardTitle className="text-xs font-medium text-muted-foreground">
            Agent Tree
          </CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-3 pt-2">
          <p className="text-xs text-muted-foreground">
            No sub-agents spawned in this session
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="min-w-0 gap-0 py-0">
      <CardHeader className="px-3 pb-0 pt-3">
        <CardTitle className="text-xs font-medium text-muted-foreground">
          Agent Tree
        </CardTitle>
      </CardHeader>
      <CardContent className="relative px-3 pb-3 pt-2">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-to-scroll is an optional mouse enhancement over the container's native keyboard/wheel scrolling — no new behavior is gated behind the handler */}
        <div
          ref={dragScroll.ref}
          onMouseDown={dragScroll.onMouseDown}
          className={`min-w-full max-w-0 overflow-x-auto ${
            dragScroll.isDragging ? 'cursor-grabbing' : 'cursor-grab'
          }`}
        >
          <svg
            viewBox={`-8 -16 ${svgWidth} ${svgHeight}`}
            width={svgWidth}
            height={svgHeight}
            className="block"
            aria-label="Agent hierarchy tree"
          >
            <TreeNode
              layout={layout}
              onSelectAgent={handleSelectAgent}
              onHover={handleHover}
              onLeave={handleLeave}
              selectedAgentId={selectedAgentId ?? undefined}
            />
          </svg>
        </div>
        {tooltip && <AgentTreeTooltip info={tooltip} />}
      </CardContent>
      {detailNode && (
        <AgentTreeNodeDetailModal
          node={detailNode}
          onClose={() => setDetailNode(null)}
        />
      )}
    </Card>
  );
}
