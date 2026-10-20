/**
 * The session view's "Harness usage" tab.
 *
 * WHAT the harness actually did in this run, per session: a Windows-Explorer-style tree of the
 * root session and every agent sub-session it spawned (workflow fan-outs grouped under one
 * `Workflow · <name>` node), and on the right a usage-count summary of the harness elements that
 * session used — skills, rules, workflow runs, MCP tool calls, and tool calls (built-in tools and
 * sub-agent spawns alike) — grouped by name with a count, not a chronological event log.
 *
 * The tab is fully prop-driven and issues NO query of its own: everything
 * derives from the `/logs` payload `SessionDetailPane` already holds, through a single memo.
 * Selecting a node and flipping the switch are pure re-selections of that memo — no re-walk, no
 * re-parse, no fetch, which is exactly what the acceptance criterion about zero extra requests
 * is asserting.
 */
import { useMemo, useState } from 'react';
import { Skeleton } from '@/ui/skeleton';
import type { WorkflowRun } from '../../../../../models/workflows';
import { getSessionLogsErrorMessage } from '../session-logs-error';
import { HarnessElementList } from './HarnessElementList';
import { HarnessSessionTree } from './HarnessSessionTree';
import {
  summarizeHarnessElements,
  type HarnessElement,
  type RawLogEvent,
} from './harness-elements';
import {
  buildHarnessUsageModel,
  flattenHarnessRows,
  HARNESS_ROOT_NODE_ID,
  type HarnessTreeNode,
} from './harness-session-tree';

export interface SessionHarnessUsageTabProps {
  mainLogs: RawLogEvent[] | null;
  subagentLogsMap: Map<string, RawLogEvent[]>;
  agentParentMap: Map<string, string | null>;
  workflows?: WorkflowRun[];
  isLoading: boolean;
  error: Error | null;
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3 p-4" data-testid="harness-usage-loading">
      <Skeleton className="h-8 w-full" />
      <div className="flex gap-3">
        <Skeleton className="h-96 w-[300px]" />
        <Skeleton className="h-96 flex-1" />
      </div>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div
      className="p-8 text-center text-sm text-muted-foreground"
      data-testid="harness-usage-empty"
    >
      <div className="font-medium text-foreground">{title}</div>
      <div className="mt-1">{body}</div>
    </div>
  );
}

export function SessionHarnessUsageTab({
  mainLogs,
  subagentLogsMap,
  agentParentMap,
  workflows,
  isLoading,
  error,
}: SessionHarnessUsageTabProps) {
  const [selectedNodeId, setSelectedNodeId] =
    useState<string>(HARNESS_ROOT_NODE_ID);
  // The tree starts fully expanded — a workflow fan-out is the thing the user came here to see.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  // Presentation-only, so it stays out of the URL (only `tab` is URL-backed) and survives moving
  // between tree nodes for free.
  const [includeChildren, setIncludeChildren] = useState(false);

  const model = useMemo(
    () =>
      buildHarnessUsageModel({
        mainLogs,
        subagentLogsMap,
        agentParentMap,
        workflows,
      }),
    [mainLogs, subagentLogsMap, agentParentMap, workflows],
  );

  const nodeById = useMemo(() => {
    const map = new Map<string, HarnessTreeNode>();
    const walk = (node: HarnessTreeNode) => {
      map.set(node.id, node);
      for (const child of node.children) walk(child);
    };
    walk(model.root);
    return map;
  }, [model]);

  const rows = useMemo(
    () => flattenHarnessRows(model.root, collapsed),
    [model, collapsed],
  );

  const activeNodeId = nodeById.has(selectedNodeId)
    ? selectedNodeId
    : HARNESS_ROOT_NODE_ID;
  const activeNode = nodeById.get(activeNodeId);
  const descendants = model.descendantsByNodeId.get(activeNodeId) ?? [];

  // A workflow group's own list already spans its members, so aggregating its subtree would
  // double every row — the switch is disabled there for the same reason it is on a leaf.
  const includeDisabled =
    model.totalElements === 0 ||
    descendants.length === 0 ||
    activeNode?.kind === 'workflow-group';
  const effectiveInclude = includeChildren && !includeDisabled;

  const summaryRows = useMemo(() => {
    const own = model.elementsByNodeId.get(activeNodeId) ?? [];
    if (!effectiveInclude) return summarizeHarnessElements(own);
    const merged: HarnessElement[] = [...own];
    for (const descendantId of descendants) {
      const node = nodeById.get(descendantId);
      // Skip group nodes: their list is a merged copy of member rows already collected here.
      if (node?.kind === 'workflow-group') continue;
      merged.push(...(model.elementsByNodeId.get(descendantId) ?? []));
    }
    return summarizeHarnessElements(merged);
  }, [model, activeNodeId, descendants, effectiveInclude, nodeById]);

  if (isLoading) return <LoadingSkeleton />;

  if (error) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        {getSessionLogsErrorMessage(error)}
      </div>
    );
  }

  const emptyState =
    model.totalElements === 0 ? (
      <EmptyState
        title="No harness usage recorded for this session"
        body="Sessions uploaded by older hook versions can carry no harness data at all. Nothing is broken — there is simply nothing to show."
      />
    ) : (
      <EmptyState
        title="No harness elements in this session"
        body={
          'This session made no tool call and loaded no skill, rule, MCP tool, or workflow. Turn on "Include sub-sessions" to see what its descendants used.'
        }
      />
    );

  return (
    <div className="flex h-full min-h-0" data-testid="harness-usage-tab">
      <div className="w-[300px] shrink-0 overflow-auto border-r border-border">
        <div className="border-b border-border px-3 py-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Sessions
        </div>
        <HarnessSessionTree
          rows={rows}
          selectedNodeId={activeNodeId}
          countByNodeId={model.ownCountByNodeId}
          onSelect={setSelectedNodeId}
          onToggle={(nodeId) =>
            setCollapsed((prev) => {
              const next = new Set(prev);
              if (next.has(nodeId)) next.delete(nodeId);
              else next.add(nodeId);
              return next;
            })
          }
        />
      </div>
      <div className="min-w-0 flex-1 overflow-auto">
        <HarnessElementList
          headerLabel={activeNode?.label ?? 'Main session'}
          subSessionCount={descendants.length}
          rows={summaryRows}
          includeChildren={effectiveInclude}
          onIncludeChildrenChange={setIncludeChildren}
          includeDisabled={includeDisabled}
          emptyState={emptyState}
        />
      </div>
    </div>
  );
}
