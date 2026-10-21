import { useMemo, useState } from 'react';
import type { SubAgentNode } from './types';
import type { ModelPricingMap } from '../../../../models/pricing';
import { formatDuration } from './log-parser';
import { computeCost, formatCost, formatTokens } from '../../../lib/format';
import { cn } from '../../../lib/cn';
import { cleanText, truncateAgentId } from './prompt-turn-helpers';
import { CopyButton } from './raw-logs/primitives';
import { orderAgentRows, agentRowLabel } from './workflow-agent-rows';
import { WorkflowAgentModal } from './WorkflowAgentModal';

interface Props {
  /** Restricted sub-agent forest of one workflow run (input order; sorted here). */
  agentNodes: SubAgentNode[];
  /** Bare-id-keyed agent transcripts, already loaded with the session's Logs payload. */
  subagentLogsMap?: Map<string, Record<string, unknown>[]>;
  pricing?: ModelPricingMap;
  sessionModel?: string;
}

const NO_VALUE = '–';

function agentTokensTotal(node: SubAgentNode): number | undefined {
  const t = node.tokens;
  if (!t) return undefined;
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

function agentCost(
  node: SubAgentNode,
  pricing: ModelPricingMap | undefined,
  sessionModel: string | undefined,
): number | undefined {
  if (!node.tokens || !pricing) return undefined;
  const model = node.model ?? sessionModel;
  const entry = model ? pricing[model] : undefined;
  return entry ? computeCost(node.tokens, entry) : undefined;
}

/**
 * The workflow agents table: one row per agent (`#`, Task, Duration, Tokens, Cost), ordered and
 * numbered by `orderAgentRows`; nested agents are always shown, indented under their parent.
 * Clicking a row (or its `#` button, for keyboard) opens that agent's session — its
 * `SubAgentDetail` and its transcript — in `WorkflowAgentModal`. Rows never expand inline.
 */
export function WorkflowAgentsTable({
  agentNodes,
  subagentLogsMap,
  pricing,
  sessionModel,
}: Props) {
  const rows = useMemo(() => orderAgentRows(agentNodes), [agentNodes]);
  const [openAgent, setOpenAgent] = useState<SubAgentNode | null>(null);

  return (
    <>
      {/* w-full + max-w-4xl caps the width on wide screens; table-fixed needs a definite
          width for the Task column's `truncate` to work. */}
      <table className="mt-1 w-full max-w-4xl table-fixed border-collapse">
        <thead>
          <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="w-10 pb-1 pr-2 text-right font-medium">#</th>
            <th className="min-w-0 pb-1 pr-3 text-left font-medium">Task</th>
            <th className="w-20 pb-1 pr-3 text-right font-medium">Duration</th>
            <th className="w-20 pb-1 pr-3 text-right font-medium">Tokens</th>
            <th className="w-24 pb-1 text-right font-medium">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ node, depth, number }) => {
            const label = agentRowLabel(node);
            const title = cleanText(node.prompt) || node.agentId;
            return (
              <tr
                key={node.agentId}
                data-testid="workflow-agent-row"
                data-agent-id={node.agentId}
                className="cursor-pointer align-top hover:bg-muted/30"
                onClick={() => setOpenAgent(node)}
              >
                <td className="w-10 py-0.5 pr-2 text-right">
                  <button
                    type="button"
                    aria-haspopup="dialog"
                    aria-label={`Open agent ${number}`}
                    className="text-xs font-semibold text-purple-700 hover:underline dark:text-purple-300"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenAgent(node);
                    }}
                  >
                    {number}
                  </button>
                </td>
                <td
                  className="min-w-0 py-0.5 pr-3"
                  style={{ paddingLeft: depth * 16 }}
                >
                  <div
                    className={cn(
                      'truncate',
                      depth > 0 ? 'text-[11px]' : 'text-xs',
                    )}
                    title={title}
                  >
                    {depth > 0 && (
                      <span className="text-muted-foreground">↳ </span>
                    )}
                    {label}
                  </div>
                  <div className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
                    <span title={node.agentId}>
                      {truncateAgentId(node.agentId)}
                    </span>
                    <CopyButton text={node.agentId} />
                  </div>
                </td>
                <td className="w-20 py-0.5 pr-3 text-right font-mono text-xs">
                  {node.durationMs !== undefined
                    ? formatDuration(node.durationMs)
                    : NO_VALUE}
                </td>
                <td className="w-20 py-0.5 pr-3 text-right font-mono text-xs">
                  {formatTokens(agentTokensTotal(node))}
                </td>
                <td className="w-24 py-0.5 text-right font-mono text-xs">
                  {formatCost(agentCost(node, pricing, sessionModel))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {openAgent && (
        <WorkflowAgentModal
          agent={openAgent}
          label={agentRowLabel(openAgent)}
          logs={subagentLogsMap?.get(openAgent.agentId) ?? []}
          subagentLogsMap={subagentLogsMap}
          pricing={pricing}
          sessionModel={sessionModel}
          onClose={() => setOpenAgent(null)}
        />
      )}
    </>
  );
}
