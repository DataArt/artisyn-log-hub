import { Bot, GitBranch, MessageSquare, Zap } from 'lucide-react';
import { modelColor } from '@/lib/chart-colors';
import { cn } from '@/lib/cn';
import {
  formatCost,
  formatDuration,
  shortModelName,
  truncate,
} from '@/lib/format';
import type { AgentNode } from '../chart-data';
import {
  GROUP_PAD,
  type LayoutNode,
  NODE_HEIGHT,
  NODE_WIDTH,
  subtreeBottom,
  subtreeRight,
} from './layout';

const ICON_SIZE = 11;

function NodeIcon({ node }: { node: AgentNode }) {
  if (node.agentId === 'main') return <MessageSquare size={ICON_SIZE} />;
  if (node.isWorkflow) return <Zap size={ICON_SIZE} />;
  if (node.isGroup) return <GitBranch size={ICON_SIZE} />;
  return <Bot size={ICON_SIZE} />;
}

interface TreeNodeProps {
  layout: LayoutNode;
  onSelectAgent?: (agentId: string) => void;
  onHover: (node: AgentNode, e: React.MouseEvent) => void;
  onLeave: () => void;
  selectedAgentId?: string;
}

function GroupContainer({
  layout,
  onSelectAgent,
  onHover,
  onLeave,
  selectedAgentId,
}: TreeNodeProps) {
  let minX = Number.POSITIVE_INFINITY;
  const minY = layout.y;
  let maxX = 0;
  let maxY = 0;
  for (const child of layout.children) {
    const r = subtreeRight(child);
    const b = subtreeBottom(child);
    if (child.x < minX) minX = child.x;
    if (r > maxX) maxX = r;
    if (b > maxY) maxY = b;
  }
  const pad = GROUP_PAD;

  return (
    <>
      <rect
        aria-label={`Group: ${layout.node.slug}`}
        data-testid="agent-tree-node"
        data-agent-id={layout.node.agentId}
        x={minX - pad}
        y={minY}
        width={maxX - minX + pad * 2}
        height={maxY - minY + pad * 2}
        rx={8}
        fill="none"
        stroke="hsl(var(--border))"
        strokeWidth={1}
        strokeDasharray="6 3"
        className={cn(onSelectAgent && 'cursor-pointer')}
        onClick={() => onSelectAgent?.(layout.node.agentId)}
        onMouseEnter={(e) => onHover(layout.node, e)}
        onMouseMove={(e) => onHover(layout.node, e)}
        onMouseLeave={onLeave}
      />
      <g
        transform={`translate(${minX - pad + 4}, ${minY - 14})`}
        className="text-muted-foreground"
      >
        <NodeIcon node={layout.node} />
      </g>
      <text
        x={minX - pad + 18}
        y={minY - 4}
        className="fill-muted-foreground text-[9px]"
      >
        {layout.node.slug}
      </text>
      {layout.children.map((child) => (
        <TreeNode
          key={child.node.agentId}
          layout={child}
          onSelectAgent={onSelectAgent}
          onHover={onHover}
          onLeave={onLeave}
          selectedAgentId={selectedAgentId}
        />
      ))}
    </>
  );
}

export function TreeNode({
  layout,
  onSelectAgent,
  onHover,
  onLeave,
  selectedAgentId,
}: TreeNodeProps) {
  const { node } = layout;

  if (node.isGroup) {
    return (
      <GroupContainer
        layout={layout}
        onSelectAgent={onSelectAgent}
        onHover={onHover}
        onLeave={onLeave}
        selectedAgentId={selectedAgentId}
      />
    );
  }

  // Workflow nodes get a fixed purple identity (matching WorkflowNode's pill
  // color) instead of the per-model color — a workflow run isn't tied to one
  // model.
  const color = node.isWorkflow
    ? 'hsl(270 60% 55%)'
    : `hsl(${modelColor(node.model)})`;
  const nodeY = layout.y + Math.max(0, (layout.height - NODE_HEIGHT) / 2);
  const isSelected = node.agentId === selectedAgentId;

  return (
    <>
      {layout.children.map((child) => {
        // Every child is this node's own direct child — all connectors originate
        // from `layout` itself, never from a previous sibling (siblings are
        // independent branches, not a chain).
        const sourceRight = layout.x + NODE_WIDTH;
        const sourceCy = nodeY + NODE_HEIGHT / 2;

        const childCy = child.node.isGroup
          ? child.y + child.height / 2
          : child.y +
            Math.max(0, (child.height - NODE_HEIGHT) / 2) +
            NODE_HEIGHT / 2;
        const childLeft = child.x;
        const midX = sourceRight + (childLeft - sourceRight) / 2;

        return (
          <path
            key={child.node.agentId}
            aria-label={`Connection from ${layout.node.slug} to ${child.node.slug}`}
            d={`M ${sourceRight} ${sourceCy} C ${midX} ${sourceCy}, ${midX} ${childCy}, ${childLeft} ${childCy}`}
            fill="none"
            stroke="hsl(var(--border))"
            strokeWidth={1.5}
          />
        );
      })}

      <g
        aria-label={`Agent node: ${node.slug}`}
        data-testid="agent-tree-node"
        data-agent-id={node.agentId}
        data-selected={isSelected ? 'true' : undefined}
        className={cn(onSelectAgent && !node.isGroup && 'cursor-pointer')}
        onClick={() => onSelectAgent?.(node.agentId)}
        onMouseEnter={(e) => onHover(node, e)}
        onMouseMove={(e) => onHover(node, e)}
        onMouseLeave={onLeave}
      >
        {isSelected && (
          <rect
            x={layout.x - 3}
            y={nodeY - 3}
            width={NODE_WIDTH + 6}
            height={NODE_HEIGHT + 6}
            rx={8}
            fill="none"
            stroke="hsl(var(--primary))"
            strokeWidth={2}
          />
        )}
        <rect
          x={layout.x}
          y={nodeY}
          width={NODE_WIDTH}
          height={NODE_HEIGHT}
          rx={6}
          fill={color}
          fillOpacity={0.15}
          stroke={color}
          strokeWidth={1.5}
          strokeDasharray={node.isBackground ? '4 3' : undefined}
        />
        <g
          transform={`translate(${layout.x + 6}, ${nodeY + 5})`}
          style={{ color }}
        >
          <NodeIcon node={node} />
        </g>
        <text
          x={layout.x + NODE_WIDTH / 2}
          y={nodeY + 19}
          textAnchor="middle"
          className="fill-foreground text-[11px] font-medium"
        >
          {truncate(node.slug, 16)}
        </text>
        <text
          x={layout.x + NODE_WIDTH / 2}
          y={nodeY + 31}
          textAnchor="middle"
          className="fill-muted-foreground text-[9px]"
        >
          {node.isWorkflow
            ? `${node.turnCount} agent${node.turnCount === 1 ? '' : 's'} · ${formatDuration(node.totalDurationMs)}`
            : `${formatCost(node.totalCost)} · ${formatDuration(node.totalDurationMs)}`}
        </text>
        {!node.isWorkflow && node.model && (
          <text
            x={layout.x + NODE_WIDTH / 2}
            y={nodeY + 42}
            textAnchor="middle"
            className="fill-muted-foreground text-[8px]"
          >
            {shortModelName(node.model)}
          </text>
        )}
      </g>

      {layout.children.map((child) => (
        <TreeNode
          key={child.node.agentId}
          layout={child}
          onSelectAgent={onSelectAgent}
          onHover={onHover}
          onLeave={onLeave}
          selectedAgentId={selectedAgentId}
        />
      ))}
    </>
  );
}
