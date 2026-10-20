import { Bot, GitBranch, MessageSquare, Zap } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { formatCost, formatDuration, formatTokens } from '@/lib/format';
import type { AgentNode } from '../chart-data';

interface Props {
  node: AgentNode;
  onClose: () => void;
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex gap-3 text-xs">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span
        className={
          mono ? 'break-all font-mono text-foreground' : 'text-foreground'
        }
      >
        {value}
      </span>
    </div>
  );
}

function TitleIcon({ node }: { node: AgentNode }) {
  if (node.agentId === 'main') return <MessageSquare className="size-4" />;
  if (node.isWorkflow) return <Zap className="size-4" />;
  if (node.isGroup) return <GitBranch className="size-4" />;
  return <Bot className="size-4" />;
}

export function AgentTreeNodeDetailModal({ node, onClose }: Props) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-mono text-base">
            <TitleIcon node={node} />
            {node.slug}
          </DialogTitle>
          <DialogDescription>
            {node.agentId === 'main'
              ? 'Root session'
              : node.isWorkflow
                ? 'Workflow run'
                : node.isGroup
                  ? 'Parallel agent group'
                  : 'Agent'}{' '}
            details
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 rounded border border-border bg-muted/40 p-3">
          <Row label="Agent ID" value={node.agentId} mono />
          {!node.isGroup && node.model && (
            <Row label="Model" value={node.model} mono />
          )}
          <Row label="Duration" value={formatDuration(node.totalDurationMs)} />
          {node.isWorkflow ? (
            <Row
              label="Agents spawned"
              value={`${node.turnCount} agent${node.turnCount === 1 ? '' : 's'}`}
            />
          ) : node.isGroup ? (
            <Row label="Parallel agents" value={String(node.children.length)} />
          ) : (
            <>
              <Row label="Cost" value={formatCost(node.totalCost)} />
              <Row label="Tokens in" value={formatTokens(node.inputTokens)} />
              <Row label="Tokens out" value={formatTokens(node.outputTokens)} />
            </>
          )}
          {node.prompt && (
            <div className="pt-2">
              <div className="mb-1 text-xs text-muted-foreground">Prompt</div>
              <p className="whitespace-pre-wrap break-words text-xs text-foreground">
                {node.prompt}
              </p>
            </div>
          )}
        </div>

        {node.isGroup && node.children.length > 0 && (
          <div>
            <div className="mb-1 text-xs text-muted-foreground">
              Agents in this group
            </div>
            <ul className="space-y-1">
              {node.children.map((child) => (
                <li
                  key={child.agentId}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="font-mono text-foreground">
                    {child.slug}
                  </span>
                  <span className="text-muted-foreground">
                    {formatDuration(child.totalDurationMs)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {node.isWorkflow && node.children.length > 0 && (
          <div>
            <div className="mb-1 text-xs text-muted-foreground">
              Direct agents
            </div>
            <ul className="space-y-1">
              {node.children.map((child) => (
                <li
                  key={child.agentId}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="font-mono text-foreground">
                    {child.slug}
                  </span>
                  <span className="text-muted-foreground">
                    {formatCost(child.totalCost)} ·{' '}
                    {formatDuration(child.totalDurationMs)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
