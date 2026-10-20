import JSZip from 'jszip';
import type { RepositorySession } from '../../../models/repositories';
import type { ModelPricingMap } from '../../../models/pricing';
import type { WorkflowRun } from '../../../models/workflows';
import {
  fetchSessionLogs,
  fetchSessionsExportScope,
  type ExportScopeFilters,
  type ExportScopeSession,
} from '../../api';
import { parseSessionLogs } from './session-log/log-parser';
import { computeSessionInfoDerived } from './session-log/session-info-derive';
import { computeTreeCodeImpact } from './session-log/tree-code-impact';
import { deriveSessionUsage } from './session-log/usage/session-usage-derive';
import type { WorkflowStats } from './session-log/SessionInfoWorkflowsSection';

export interface SessionExportProgress {
  completed: number;
  total: number;
}

type SanitizedWorkflowRun = Omit<WorkflowRun, 'args' | 'summary' | 'findings'>;

interface SanitizedWorkflowStats extends Omit<WorkflowStats, 'workflows'> {
  workflows: SanitizedWorkflowRun[];
}

/**
 * One row of `sessions.json` inside the exported zip: the export-scope listing fields plus
 * every derived (non-raw) Session Info tab field, computed via the shared
 * `computeSessionInfoDerived` so the export always matches what the tab itself shows —
 * minus `firstPrompt`, `claudeMdFiles`, and each workflow's `args`/`summary`/`findings` (workflow
 * inputs and work-outcome text), which are excluded from the export on request even though the
 * tab itself still shows them; this export is meant to carry only statistics for reporting.
 */
export type SessionExportRecord = Omit<ExportScopeSession, 'firstPrompt'> &
  Omit<
    ReturnType<typeof computeSessionInfoDerived>,
    'claudeMdFiles' | 'workflowStats'
  > & {
    workflowStats: SanitizedWorkflowStats | null;
  };

function sanitizeWorkflowStats(
  stats: WorkflowStats | null,
): SanitizedWorkflowStats | null {
  if (!stats) return null;
  return {
    ...stats,
    workflows: stats.workflows.map((wf) => ({
      taskId: wf.taskId,
      toolUseId: wf.toolUseId,
      name: wf.name,
      status: wf.status,
      durationMs: wf.durationMs,
      agentCount: wf.agentCount,
      subagentTokens: wf.subagentTokens,
      toolUses: wf.toolUses,
      wfId: wf.wfId,
      agentSessionIds: wf.agentSessionIds,
    })),
  };
}

export interface SessionExportMeta {
  formatVersion: 1;
  exportedAt: string;
  filters: ExportScopeFilters;
}

/**
 * Fetches and parses one session's full logs, then derives its Session Info tab fields.
 * Mirrors `useRepositoryData.ts`'s own subagent-log-map construction so nested
 * workflow/sub-agent parsing matches the tab's own computation exactly.
 */
async function buildSessionRecord(
  repoId: number,
  scopeSession: ExportScopeSession,
  teamId: number | undefined,
  pricing: ModelPricingMap | undefined,
): Promise<SessionExportRecord> {
  const logsData = await fetchSessionLogs(
    repoId,
    scopeSession.sessionId,
    teamId,
  );

  const subagentLogsMap = new Map<string, Record<string, unknown>[]>();
  for (const sa of logsData.subagents ?? []) {
    const agentId = sa.sessionId.startsWith('agent-')
      ? sa.sessionId.slice('agent-'.length)
      : sa.sessionId;
    subagentLogsMap.set(agentId, sa.logs);
  }

  const parsedLogs = parseSessionLogs(logsData.main, {
    repoConfig: null,
    subagentStats: logsData.subagentStats,
    workflows: logsData.workflows,
    subagentLogs: subagentLogsMap,
  });

  const session: RepositorySession = {
    sessionId: scopeSession.sessionId,
    firstPrompt: scopeSession.firstPrompt ?? '',
    startTime: scopeSession.startTime,
    endTime: scopeSession.endTime,
    userId: scopeSession.userId,
    userEmail: scopeSession.userEmail,
    // The export scope carries no cost columns, so the record starts from an empty breakdown
    // (no priced parts, no telemetry) — the same "unknown cost" the scope session had before.
    costBreakdown: {
      mainCost: null,
      subagentCost: 0,
      utilityCost: 0,
      calculatedCost: null,
      telemetryCost: null,
      mismatch: false,
      utilityPricingMissing: false,
    },
  };

  // The export must show the same tree-scoped lines/files the Info tab does, so it
  // repeats the tab's own two derivations off the payload it already fetched: the transcript
  // walk over the root plus every sub-agent, and the own/tree code-impact pair.
  const usage = deriveSessionUsage(logsData.main, [
    ...subagentLogsMap.values(),
  ]);
  const codeImpact = computeTreeCodeImpact({
    usage,
    subagentStats: logsData.subagentStats,
    rootStats: logsData.rootStats ?? null,
  });

  const derived = computeSessionInfoDerived(
    session,
    parsedLogs,
    pricing,
    codeImpact,
  );

  return {
    sessionId: scopeSession.sessionId,
    startTime: scopeSession.startTime,
    endTime: scopeSession.endTime,
    userId: scopeSession.userId,
    userEmail: scopeSession.userEmail,
    wallClockMs: derived.wallClockMs,
    workflowSubagentTokens: derived.workflowSubagentTokens,
    workflowStats: sanitizeWorkflowStats(derived.workflowStats),
    derived: derived.derived,
    subAgentCost: derived.subAgentCost,
    workflowEstimatedCost: derived.workflowEstimatedCost,
    showWorkflowCostRow: derived.showWorkflowCostRow,
    totalCostWithSubagents: derived.totalCostWithSubagents,
    productivityLines: derived.productivityLines,
    productivityCost: derived.productivityCost,
    skillsDisplay: derived.skillsDisplay,
  };
}

/**
 * Packages export records + meta into a downloadable zip. Split out from `runSessionExport`
 * so the zip-building step is unit-testable without touching fetch/DOM.
 */
export async function buildExportZip(
  records: SessionExportRecord[],
  meta: SessionExportMeta,
): Promise<Blob> {
  const zip = new JSZip();
  zip.file('sessions.json', JSON.stringify(records, null, 2));
  zip.file('meta.json', JSON.stringify(meta, null, 2));
  return zip.generateAsync({ type: 'blob' });
}

function triggerZipDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function buildFileName(filters: ExportScopeFilters): string {
  const from = filters.from.slice(0, 10);
  const to = filters.to.slice(0, 10);
  return `session-stats-export_${from}_to_${to}.zip`;
}

/**
 * Orchestrates the full "Session Statistics Export" run: lists sessions in scope via
 * the privileged export-scope endpoint, then fetches/parses/derives stats for each one
 * sequentially — never in parallel, to bound memory/network use over large date ranges —
 * reporting progress after every session. Packages the result into a zip (`sessions.json` +
 * `meta.json`, `formatVersion: 1`) and triggers a browser download.
 */
export async function runSessionExport(
  repoId: number,
  filters: ExportScopeFilters,
  pricing: ModelPricingMap | undefined,
  onProgress: (progress: SessionExportProgress) => void,
): Promise<void> {
  const scope = await fetchSessionsExportScope(repoId, filters);
  const total = scope.length;
  onProgress({ completed: 0, total });

  const records: SessionExportRecord[] = [];
  for (let i = 0; i < scope.length; i++) {
    const record = await buildSessionRecord(
      repoId,
      scope[i],
      filters.teamId,
      pricing,
    );
    records.push(record);
    onProgress({ completed: i + 1, total });
  }

  const meta: SessionExportMeta = {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    filters,
  };
  const blob = await buildExportZip(records, meta);
  triggerZipDownload(blob, buildFileName(filters));
}
