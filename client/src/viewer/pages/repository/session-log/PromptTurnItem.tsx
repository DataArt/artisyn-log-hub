import { useMemo, useState } from 'react';
import type { PromptTurn, SubAgentNode as SubAgentNodeType } from './types';
import {
  buildAgentNodesForIds,
  computeTurnDirectAgentCost,
  getPromptText,
  resolveCharsPerToken,
  stripAgentPrefix,
  stripSystemBlocks,
} from './log-parser';
import type { SubagentStatEntry } from './log-parser';
import { WorkflowNode } from './WorkflowNode';
import { SubAgentNode } from './SubAgentNode';
import type { ModelPricingMap } from '../../../../models/pricing';
import { AgentActivationItem } from './AgentActivationItem';
import {
  cleanText,
  buildToolsSummary,
  SectionHeader,
  ToolCallRow,
  buildImagesSummary,
  ImageRow,
} from './prompt-turn-helpers';
import { ToolCallDetailModal } from './ToolCallDetailModal';
import type { ToolCallDetail } from './types';
import { PromptTurnHeader } from './PromptTurnHeader';
import { PromptTurnPromptText } from './PromptTurnPromptText';
import { PromptTurnTokenMetrics } from './PromptTurnTokenMetrics';
import { PromptTurnSkillsSection } from './PromptTurnSkillsSection';
import { PromptTurnRulesSection } from './PromptTurnRulesSection';
import { PromptTurnFilesSection } from './PromptTurnFilesSection';

interface Props {
  turn: PromptTurn;
  subagentLogsMap?: Map<string, Record<string, unknown>[]>;
  /** agentId -> parentAgentId, from the DB's authoritative sessions.parent_session_id. */
  agentParentMap?: Map<string, string | null>;
  pricing?: ModelPricingMap;
  sessionModel?: string;
  costPerToken?: number | null;
  /** Token totals from session_stats for child sessions, keyed by sessionId (e.g. "agent-abc123"). */
  subagentStats?: Record<string, SubagentStatEntry>;
}

export function PromptTurnItem({
  turn,
  subagentLogsMap,
  agentParentMap,
  pricing,
  sessionModel,
  costPerToken,
  subagentStats,
}: Props) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const [imagesOpen, setImagesOpen] = useState(false);
  const [selectedCall, setSelectedCall] = useState<ToolCallDetail | null>(null);

  const rawText = stripSystemBlocks(getPromptText(turn));
  const displayText = cleanText(rawText);
  const isEmpty = displayText === '';
  const charsPerToken = resolveCharsPerToken(pricing, sessionModel);

  // Total cost of all sub-agents spawned in this turn, including nested sub-agents they
  // themselves spawned (grandchildren, etc. — orchestrator → chunk-agent → research-agent is a
  // real 3+ level chain), not just each directly-activated agent's own tokens. Delegates to
  // `computeTurnDirectAgentCost` (log-parser.ts), which `SessionLogView`'s `costPerToken` estimate
  // also uses so the two stay consistent.
  const subagentCost = useMemo(
    () =>
      computeTurnDirectAgentCost(
        turn,
        subagentLogsMap,
        agentParentMap,
        pricing,
      ),
    [turn, subagentLogsMap, agentParentMap, pricing],
  );

  // Rough workflow agent cost: sum of tokens across all workflow runs × main session rate.
  const workflowCost = useMemo(() => {
    if (!turn.workflows?.length || !costPerToken) return null;
    const total = turn.workflows.reduce(
      (sum, wf) => sum + (wf.subagentTokens ?? 0) * costPerToken,
      0,
    );
    return total > 0 ? total : null;
  }, [turn.workflows, costPerToken]);

  // Per-workflow agent forest for the Logs-tab "Agents (N)" drill-down. `agentSessionIds` is
  // "agent-<id>"-prefixed (parity with SubagentLog.sessionId); strip that prefix before it can be
  // used against agentParentMap/subagentLogsMap, which are bare-id-keyed.
  const workflowAgentNodes = useMemo(() => {
    const map = new Map<string, SubAgentNodeType[]>();
    if (!turn.workflows?.length) return map;
    for (const wf of turn.workflows) {
      if (!wf.agentSessionIds.length) {
        map.set(wf.toolUseId, []);
        continue;
      }
      map.set(
        wf.toolUseId,
        buildAgentNodesForIds(
          wf.agentSessionIds.map(stripAgentPrefix),
          agentParentMap ?? new Map(),
          subagentLogsMap ?? new Map(),
          subagentStats,
          pricing,
        ),
      );
    }
    return map;
  }, [turn.workflows, agentParentMap, subagentLogsMap, subagentStats, pricing]);

  return (
    <div
      data-turn-index={turn.index}
      id={`turn-${turn.index}`}
      className="border-b border-border px-4 py-3 transition-colors hover:bg-muted/20"
    >
      {/* Header */}
      <PromptTurnHeader
        timestamp={turn.userEvent.timestamp ?? ''}
        workTimeMs={turn.workTimeMs}
        workflows={turn.workflows}
      />

      {/* Prompt text */}
      <PromptTurnPromptText
        rawText={rawText}
        displayText={displayText}
        isEmpty={isEmpty}
      />

      {/* Token metrics */}
      <PromptTurnTokenMetrics
        tokenBreakdown={turn.tokenBreakdown}
        ownTokenBreakdown={turn.ownTokenBreakdown}
        contextTokens={turn.contextTokens}
        contextTokensStart={turn.contextTokensStart}
        pricing={pricing}
        sessionModel={sessionModel}
        subagentCost={subagentCost}
        workflowCost={workflowCost}
      />

      {/* Skills */}
      <PromptTurnSkillsSection
        skills={turn.skills}
        charsPerToken={charsPerToken}
      />

      {/* Rules injected */}
      <PromptTurnRulesSection rulesInjected={turn.rulesInjected} />

      {/* Tool calls (Bash, MCP, WebFetch, etc.) */}
      {turn.toolCalls.length > 0 && (
        <div className="ml-4 mt-2 border-l-2 border-l-amber-300 pl-2 dark:border-l-amber-700">
          <SectionHeader
            icon="⚙"
            label="Tools"
            summary={buildToolsSummary(turn.toolCalls, charsPerToken)}
            open={toolsOpen}
            onToggle={() => setToolsOpen((v) => !v)}
          />
          {toolsOpen && (
            <div className="pl-2">
              <table className="mt-1 w-full">
                <tbody>
                  {turn.toolCalls.map((call, i) => (
                    <ToolCallRow
                      key={call.id ?? i}
                      call={call}
                      onClick={() => setSelectedCall(call)}
                      charsPerToken={charsPerToken}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Files — grouped by category; 'code' first */}
      <PromptTurnFilesSection files={turn.files} />

      {/* Images */}
      {turn.images.length > 0 && (
        <div className="ml-4 mt-2 border-l-2 border-l-pink-300 pl-2 dark:border-l-pink-700">
          <SectionHeader
            icon="◈"
            label="Images"
            summary={buildImagesSummary(turn.images)}
            open={imagesOpen}
            onToggle={() => setImagesOpen((v) => !v)}
          />
          {imagesOpen && (
            <div className="pl-2">
              <table className="mt-1 w-full">
                <tbody>
                  {turn.images.map((img, i) => (
                    <ImageRow key={i} img={img} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Agent activations */}
      {turn.agentActivations.length > 0 && (
        <div className="ml-4 mt-2 border-l-2 border-l-orange-300 pl-2 dark:border-l-orange-700">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
            Agents
          </p>
          <div className="flex flex-col">
            {turn.agentActivations.map((activation, i) => (
              <AgentActivationItem
                key={i}
                activation={activation}
                subagentLogsMap={subagentLogsMap}
                pricing={pricing}
                sessionModel={sessionModel}
                renderSubTurn={(t) => <PromptTurnItem key={t.index} turn={t} />}
              />
            ))}
          </div>
        </div>
      )}

      {/* Sub-agents */}
      {turn.subAgents.length > 0 && (
        <div className="ml-4 mt-2 border-l-2 border-l-slate-300 pl-2 dark:border-l-slate-600">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
            Sub-agents
          </p>
          <div className="flex flex-col gap-0.5">
            {turn.subAgents.map((agent) => (
              <SubAgentNode
                key={agent.agentId}
                agent={agent}
                depth={0}
                pricing={pricing}
                sessionModel={sessionModel}
              />
            ))}
          </div>
        </div>
      )}

      {/* Workflows */}
      {turn.workflows && turn.workflows.length > 0 && (
        <div className="ml-4 mt-2 border-l-2 border-l-purple-300 pl-2 dark:border-l-purple-700">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
            Workflows
          </p>
          <div className="flex flex-col">
            {turn.workflows.map((wf) => (
              <WorkflowNode
                key={wf.toolUseId}
                workflow={wf}
                estimatedCost={
                  costPerToken != null && wf.subagentTokens != null
                    ? wf.subagentTokens * costPerToken
                    : null
                }
                agentNodes={workflowAgentNodes.get(wf.toolUseId) ?? []}
                pricing={pricing}
                sessionModel={sessionModel}
                subagentLogsMap={subagentLogsMap}
              />
            ))}
          </div>
        </div>
      )}

      {selectedCall && (
        <ToolCallDetailModal
          call={selectedCall}
          onClose={() => setSelectedCall(null)}
        />
      )}
    </div>
  );
}
