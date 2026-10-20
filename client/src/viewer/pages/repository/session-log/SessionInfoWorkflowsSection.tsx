import type { WorkflowRun } from '../../../../models/workflows';
import { formatDuration, formatInt } from './log-parser';
import { formatCost } from '../../../lib/format';
import { cn } from '../../../lib/cn';
import { CollapsibleSection, InfoRow } from './session-info-primitives';

export interface WorkflowStats {
  workflows: WorkflowRun[];
  totalAgents: number;
  totalToolUses: number;
  completed: number;
  failed: number;
  running: number;
}

interface Props {
  workflowStats: WorkflowStats;
  workflowSubagentTokens: number;
  workflowEstimatedCost: number | null;
}

/**
 * Session Info tab — "Workflows" collapsible section: lists each
 * `turn.workflows[]` entry with status/duration/agent-count/tool-uses/tokens,
 * a total row, and an "Est. workflow cost" row. Extracted from
 * `SessionInfoTab.tsx` to keep that file under the project's
 * component-size guidance; omitted entirely by the caller when no
 * workflows ran.
 */
export function SessionInfoWorkflowsSection({
  workflowStats,
  workflowSubagentTokens,
  workflowEstimatedCost,
}: Props) {
  return (
    <CollapsibleSection title="Workflows">
      <InfoRow label="Workflows run">
        {workflowStats.workflows.length}
        {workflowStats.failed > 0 && ` (${workflowStats.failed} failed)`}
        {workflowStats.running > 0 && ` (${workflowStats.running} running)`}
      </InfoRow>
      <table className="mb-2 mt-2 w-full border-collapse">
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground">
            <th className="pb-1 pr-3 text-left font-medium">Workflow</th>
            <th className="pb-1 pr-3 text-left font-medium">Status</th>
            <th className="pb-1 pr-3 text-right font-medium">Duration</th>
            <th className="pb-1 pr-3 text-right font-medium">Agents</th>
            <th className="pb-1 pr-3 text-right font-medium">Tool uses</th>
            <th className="pb-1 text-right font-medium">Tokens</th>
          </tr>
        </thead>
        <tbody>
          {workflowStats.workflows.map((wf) => {
            const agentCount =
              wf.agentSessionIds.length > 0
                ? wf.agentSessionIds.length
                : wf.agentCount;
            return (
              <tr key={wf.toolUseId} className="hover:bg-muted/30">
                <td className="py-0.5 pr-3 text-sm font-medium">
                  ⚡ {wf.name}
                </td>
                <td className="py-0.5 pr-3">
                  <span
                    className={cn(
                      'rounded px-1.5 py-0.5 text-[10px] font-medium',
                      wf.status === 'completed'
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                        : wf.status === 'failed'
                          ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
                          : 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
                    )}
                  >
                    {wf.status}
                  </span>
                </td>
                <td className="py-0.5 pr-3 text-right text-sm font-mono">
                  {wf.durationMs != null ? formatDuration(wf.durationMs) : '—'}
                </td>
                <td className="py-0.5 pr-3 text-right text-sm font-mono">
                  {agentCount ? formatInt(agentCount) : '—'}
                </td>
                <td className="py-0.5 pr-3 text-right text-sm font-mono">
                  {wf.toolUses != null ? formatInt(wf.toolUses) : '—'}
                </td>
                <td className="py-0.5 text-right text-sm font-mono">
                  {wf.subagentTokens != null
                    ? formatInt(wf.subagentTokens)
                    : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-border font-semibold">
            <td className="pt-1 pr-3 text-xs" colSpan={3}>
              Total
            </td>
            <td className="pt-1 pr-3 text-right text-sm font-mono">
              {formatInt(workflowStats.totalAgents)}
            </td>
            <td className="pt-1 pr-3 text-right text-sm font-mono">
              {formatInt(workflowStats.totalToolUses)}
            </td>
            <td className="pt-1 text-right text-sm font-mono">
              {formatInt(workflowSubagentTokens)}
            </td>
          </tr>
        </tfoot>
      </table>
      {workflowEstimatedCost != null && (
        <InfoRow label="Est. workflow cost">
          <span title="Rough estimate based on this session's average token rate. Actual cost depends on the input/output/cache breakdown, which is not available for workflow agents.">
            ~{formatCost(workflowEstimatedCost)}
          </span>
        </InfoRow>
      )}
    </CollapsibleSection>
  );
}
