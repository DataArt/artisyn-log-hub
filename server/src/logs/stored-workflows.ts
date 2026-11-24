import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.module';
import { sessionStats } from '../database/schema/index';
import type { WorkflowRun } from './workflow-extractor';

/**
 * A stored run with its keys back in `extractWorkflows` order. `jsonb` reorders object keys
 * (shorter first), so without this a reader's `JSON.stringify` would differ from the former
 * per-request parse — and legacy `/logs` promises byte-identical output (DD-4).
 */
function inExtractorKeyOrder(w: WorkflowRun): WorkflowRun {
  return {
    taskId: w.taskId,
    toolUseId: w.toolUseId,
    name: w.name,
    args: w.args,
    status: w.status,
    durationMs: w.durationMs,
    agentCount: w.agentCount,
    subagentTokens: w.subagentTokens,
    toolUses: w.toolUses,
    summary: w.summary,
    findings: Array.isArray(w.findings)
      ? w.findings.map((f) => ({ claim: f.claim, confidence: f.confidence }))
      : [],
    wfId: w.wfId,
    agentSessionIds: Array.isArray(w.agentSessionIds) ? w.agentSessionIds : [],
  };
}

/**
 * The stored workflow runs of a session tree root (impl-plan DD-6 of
 * 2026-11-23-session-logs-streaming): `session_stats.workflows`, written at ingest from the
 * root's own `claude` transcript (`upsertSessionStatsRow`) or by `WorkflowsBackfillService`.
 *
 * Returns `null` when the session has not been extracted yet (no `session_stats` row, or
 * `workflows_version` NULL). Callers then fall back to parsing the root `claude` body with
 * `extractWorkflows`, exactly as before the column existed. Either way they apply
 * `resolveWorkflowAgentLinkage` afterwards — the stored runs carry no agent linkage.
 */
export async function readStoredWorkflows(
  db: DrizzleDb,
  rootRowId: number,
): Promise<WorkflowRun[] | null> {
  const [row] = await db
    .select({
      workflows: sessionStats.workflows,
      workflowsVersion: sessionStats.workflowsVersion,
    })
    .from(sessionStats)
    .where(eq(sessionStats.sessionId, rootRowId))
    .limit(1);
  if (!row || row.workflowsVersion === null) return null;
  return Array.isArray(row.workflows)
    ? (row.workflows as WorkflowRun[]).map(inExtractorKeyOrder)
    : [];
}
