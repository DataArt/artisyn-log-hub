import type { WorkflowRun } from './workflow-extractor';

/** One descendant session of the root, as the linkage needs it. */
export interface WorkflowLinkageRow {
  /** `sessions.session_id` of the descendant (an agent id `agent-…`). */
  subSessionId: string;
  parentSessionId: string | null;
  workflowRunId: string | null;
}

/**
 * Resolves each WorkflowRun's full multi-level agent linkage, writing it into
 * `wf.agentSessionIds` (the runs are mutated in place): a workflow's direct agents (sessions
 * whose `workflow_run_id` matches the run's `wfId`) plus their own regular Task-tool
 * sub-agents at any depth — but NOT a sub-agent's own nested `Workflow` tool call (out of
 * scope).
 *
 * Both maps are built only from `rows`, which the callers scope to the root session's
 * descendant tree, so the BFS is implicitly restricted to that tree — no cross-session
 * leakage possible. A run without `wfId` (still running) or without direct agents keeps the
 * `agentSessionIds` it had.
 */
export function resolveWorkflowAgentLinkage(
  workflows: WorkflowRun[],
  rows: readonly WorkflowLinkageRow[],
): void {
  if (workflows.length === 0) return;

  const wfDirectAgentsMap = new Map<string, string[]>();
  const childrenByParentMap = new Map<string, string[]>();
  for (const r of rows) {
    // Guard against the workflow runtime's own `journal.jsonl` bookkeeping file —
    // historically uploaded (pre-hook-fix) with the literal, unprefixed sessionId
    // "journal" — being mistaken for a real spawned agent.
    if (!r.subSessionId.startsWith('agent-')) continue;
    if (r.workflowRunId) {
      const directList = wfDirectAgentsMap.get(r.workflowRunId);
      if (directList) directList.push(r.subSessionId);
      else wfDirectAgentsMap.set(r.workflowRunId, [r.subSessionId]);
    }
    if (r.parentSessionId) {
      const childList = childrenByParentMap.get(r.parentSessionId);
      if (childList) childList.push(r.subSessionId);
      else childrenByParentMap.set(r.parentSessionId, [r.subSessionId]);
    }
  }

  for (const wf of workflows) {
    if (!wf.wfId) continue; // running workflow — no linkage yet
    const directAgentIds = wfDirectAgentsMap.get(wf.wfId);
    if (!directAgentIds || directAgentIds.length === 0) continue;

    const visited = new Set<string>();
    const queue = [...directAgentIds];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const children = childrenByParentMap.get(current);
      if (children) queue.push(...children);
    }
    wf.agentSessionIds = [...visited];
  }
}
