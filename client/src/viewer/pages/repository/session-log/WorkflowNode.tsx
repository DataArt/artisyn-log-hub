import { useState } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import type { WorkflowRun } from '../../../../models/workflows';
import type { ModelPricingMap } from '../../../../models/pricing';
import { formatWorkflowDuration } from './log-parser';
import type { SubAgentNode as SubAgentNodeType } from './types';
import { SubAgentNode } from './SubAgentNode';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '../../../ui/collapsible';
import { cn } from '../../../lib/cn';
import { formatCost } from '../../../lib/format';

const ARGS_PREVIEW_LIMIT = 200;

interface Props {
  workflow: WorkflowRun;
  estimatedCost?: number | null;
  /** Restricted sub-agent forest resolved from workflow.agentSessionIds (via buildAgentNodesForIds). */
  agentNodes?: SubAgentNodeType[];
  pricing?: ModelPricingMap;
  sessionModel?: string;
}

function confidenceBadgeClass(confidence: string): string {
  switch (confidence.toLowerCase()) {
    case 'high':
      return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
    case 'medium':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
    case 'low':
      return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

function StatusBadge({ status }: { status: WorkflowRun['status'] }) {
  if (status === 'completed') {
    return (
      <span className="rounded px-1.5 py-0.5 text-xs bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
        completed
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="rounded px-1.5 py-0.5 text-xs bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
        failed
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
      <Loader2 className="size-3 animate-spin" />
      running
    </span>
  );
}

export function WorkflowNode({
  workflow,
  estimatedCost,
  agentNodes = [],
  pricing,
  sessionModel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [findingsOpen, setFindingsOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);

  const hasArgs = workflow.args !== null && workflow.args.length > 0;
  const isLongArgs = hasArgs && workflow.args!.length > ARGS_PREVIEW_LIMIT;
  const argsDisplay =
    hasArgs && !showMore
      ? workflow.args!.slice(0, ARGS_PREVIEW_LIMIT)
      : (workflow.args ?? '');

  // agentNodes.length is authoritative once non-empty; fall back to the
  // self-reported agentCount for running/legacy/unresolvable workflows where it's still [].
  const agentCount =
    agentNodes.length > 0 ? agentNodes.length : workflow.agentCount;
  const hasStats = agentCount !== null;
  const hasFindings = workflow.findings.length > 0;
  const hasAgents = agentNodes.length > 0;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 py-1 text-left text-xs text-muted-foreground hover:text-foreground">
        <ChevronRight
          className={cn(
            'size-3 shrink-0 transition-transform',
            open && 'rotate-90',
          )}
        />
        {/* Name pill */}
        <span className="rounded px-1.5 py-0.5 font-mono text-xs font-medium bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
          ⚡ {workflow.name}
        </span>
        <StatusBadge status={workflow.status} />
        {workflow.durationMs !== null && workflow.status !== 'running' && (
          <span className="font-mono text-xs text-muted-foreground">
            {formatWorkflowDuration(workflow.durationMs)}
          </span>
        )}
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="ml-4 border-l border-dashed border-border pl-3 pb-2 flex flex-col gap-2">
          {/* Args row */}
          {hasArgs && (
            <div>
              <span className="text-xs text-muted-foreground">Question </span>
              <span className="whitespace-pre-wrap break-words text-xs text-foreground">
                {argsDisplay}
                {isLongArgs && !showMore && '…'}
              </span>
              {isLongArgs && (
                <button
                  className="ml-1 text-xs text-muted-foreground hover:text-foreground underline"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowMore((v) => !v);
                  }}
                >
                  {showMore ? '[show less ▴]' : '[show more ▾]'}
                </button>
              )}
            </div>
          )}

          {/* Stats pill strip */}
          {hasStats && (
            <div className="inline-flex flex-wrap gap-1 bg-muted/40 rounded-md px-3 py-1.5 text-xs font-mono">
              {agentCount !== null && <span>{agentCount} agents</span>}
              {workflow.subagentTokens !== null && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span>{workflow.subagentTokens.toLocaleString()} tokens</span>
                </>
              )}
              {estimatedCost != null && estimatedCost > 0 && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span
                    className="text-amber-600 dark:text-amber-400"
                    title="Rough estimate based on this session's average token rate"
                  >
                    ~{formatCost(estimatedCost)}
                  </span>
                </>
              )}
              {workflow.toolUses !== null && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span>{workflow.toolUses} tool uses</span>
                </>
              )}
            </div>
          )}

          {/* Summary */}
          {workflow.summary !== null && (
            <div>
              <span className="text-xs text-muted-foreground">Summary </span>
              <span className="whitespace-pre-wrap break-words text-xs text-foreground">
                {workflow.summary}
              </span>
            </div>
          )}

          {/* Agents */}
          {hasAgents && (
            <Collapsible open={agentsOpen} onOpenChange={setAgentsOpen}>
              <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                <ChevronRight
                  className={cn(
                    'size-3 shrink-0 transition-transform',
                    agentsOpen && 'rotate-90',
                  )}
                />
                Agents ({agentNodes.length})
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-1 flex flex-col gap-0.5">
                  {agentNodes.map((agent) => (
                    <SubAgentNode
                      key={agent.agentId}
                      agent={agent}
                      depth={0}
                      pricing={pricing}
                      sessionModel={sessionModel}
                    />
                  ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}

          {/* Findings */}
          {hasFindings && (
            <Collapsible open={findingsOpen} onOpenChange={setFindingsOpen}>
              <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                <ChevronRight
                  className={cn(
                    'size-3 shrink-0 transition-transform',
                    findingsOpen && 'rotate-90',
                  )}
                />
                Findings ({workflow.findings.length})
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-1 flex flex-col gap-1">
                  {workflow.findings.map((finding, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-2 rounded border border-border px-2 py-1.5"
                    >
                      <span
                        className={cn(
                          'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none',
                          confidenceBadgeClass(finding.confidence),
                        )}
                      >
                        {finding.confidence}
                      </span>
                      <span className="text-xs text-foreground break-words">
                        {finding.claim}
                      </span>
                    </div>
                  ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
