import { useEffect, useMemo, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import type { SessionLogsData } from '../../../api';
import type { ModelPricingMap } from '../../../../models/pricing';
import type { RepoConfig } from '../../../../models/repositories';
import {
  buildAgentParentMap,
  computeWorkflowCostPerToken,
  parseSessionLogs,
} from './log-parser';
import { PromptTurnList, isSystemOnlyTurn } from './PromptTurnList';
import { StartupContextLine } from './StartupContextLine';
import { NoPricingBadge } from '../../../components/NoPricingBadge';
import { getSessionLogsErrorMessage } from './session-logs-error';
import { resolveTurnAnchor } from './turn-anchor';
import { findTurnIndexForToolUse } from './tool-use-turn';

interface Props {
  logsData: SessionLogsData | undefined;
  isLoading: boolean;
  error: Error | null;
  pricing?: ModelPricingMap;
  repoConfig?: RepoConfig | null;
  /** Server-computed sub-agent cost (`costBreakdown.subagentCost`, D2.3). Used to derive the accurate workflow cost rate. */
  sessionSubagentCost?: number | null;
  /** Cross-tab turn target — a Summary-tab deep link to scroll to. */
  targetTurnIndex?: number | null;
  /** Called once the scroll effect has acted on `targetTurnIndex`, so a later manual visit does not re-scroll. */
  onTargetTurnConsumed?: () => void;
  /**
   * A `tool_use` id to jump to — the Tools/MCP tab's "Open in session" link (`tu` param,
   * DD-19). Once the logs parse, the turn holding it goes through `onTargetTurnResolved` and
   * the id is consumed, found or not.
   */
  targetToolUseId?: string | null;
  /** Receives the turn index resolved from `targetToolUseId` (sets the target-turn state). */
  onTargetTurnResolved?: (turnIndex: number) => void;
  /** Called once `targetToolUseId` has been acted on. */
  onTargetToolUseConsumed?: () => void;
  /** Opens the System context anatomy tab (the startup line's "View anatomy" link). */
  onOpenAnatomy?: () => void;
}

export function SessionLogView({
  logsData,
  isLoading,
  error,
  pricing,
  repoConfig,
  sessionSubagentCost,
  targetTurnIndex,
  onTargetTurnConsumed,
  targetToolUseId,
  onTargetTurnResolved,
  onTargetToolUseConsumed,
  onOpenAnatomy,
}: Props) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const subagentLogsMap = useMemo(() => {
    const map = new Map<string, Record<string, unknown>[]>();
    for (const sa of logsData?.subagents ?? []) {
      const agentId = sa.sessionId.startsWith('agent-')
        ? sa.sessionId.slice('agent-'.length)
        : sa.sessionId;
      map.set(agentId, sa.logs);
    }
    return map;
  }, [logsData]);

  // Authoritative agentId -> parentAgentId map, from the DB's sessions.parent_session_id (via
  // the /logs endpoint's per-subagent parentSessionId field) — both stripped of any "agent-"
  // prefix so they key identically to subagentLogsMap/turn.agentActivations[].agentId. This is
  // the reliable source for cost rollup: a background-launched agent's completion can arrive
  // after its parent's own session already ended, so transcript content (agent_progress /
  // tool_use+toolUseResult) cannot always reconstruct nesting beyond depth 1, but
  // parent_session_id always can.
  const agentParentMap = useMemo(
    () => buildAgentParentMap(logsData?.subagents ?? []),
    [logsData],
  );

  const parsed = useMemo(
    () =>
      logsData !== undefined
        ? parseSessionLogs(logsData.main, {
            repoConfig: repoConfig ?? null,
            subagentStats: logsData.subagentStats,
            workflows: logsData.workflows,
            subagentLogs: subagentLogsMap,
            pricing,
            harnessSnapshot: logsData.harnessSnapshot ?? null,
          })
        : null,
    [logsData, repoConfig, subagentLogsMap, pricing],
  );

  // Same single filter `PromptTurnList` applies, so the anchor list and the rendered list
  // cannot diverge.
  const visibleTurns = useMemo(
    () => (parsed ? parsed.turns.filter((t) => !isSystemOnlyTurn(t)) : []),
    [parsed],
  );

  // Deep link to one tool call (DD-19): resolve the turn holding the `tool_use` id and hand it
  // to the target-turn state, which the scroll effect below then acts on.
  useEffect(() => {
    if (!targetToolUseId || parsed === null) return;
    const turnIndex = findTurnIndexForToolUse(
      parsed.turns,
      targetToolUseId,
      subagentLogsMap,
      agentParentMap,
    );
    if (turnIndex !== null) onTargetTurnResolved?.(turnIndex);
    onTargetToolUseConsumed?.();
  }, [
    targetToolUseId,
    parsed,
    subagentLogsMap,
    agentParentMap,
    onTargetTurnResolved,
    onTargetToolUseConsumed,
  ]);

  // Cross-tab scroll-to-turn. Returns immediately when there is no
  // target or the session hasn't parsed yet — otherwise this would fire on every Logs mount and
  // again after each consume. Once it acts, it always consumes the target so a later manual
  // return to Logs does not re-scroll.
  useEffect(() => {
    if (targetTurnIndex == null || parsed === null) return;

    const container = scrollContainerRef.current;
    const anchor = resolveTurnAnchor(visibleTurns, targetTurnIndex);
    if (container) {
      if (anchor.kind === 'turn') {
        container
          .querySelector(`[data-turn-index="${anchor.index}"]`)
          ?.scrollIntoView({ block: 'start' });
      } else if (anchor.kind === 'top') {
        container.scrollTop = 0;
      }
    }
    onTargetTurnConsumed?.();
  }, [targetTurnIndex, parsed, onTargetTurnConsumed]);

  // The session-level counterpart of the per-turn check in `TurnHeader`: the rates
  // are loaded but this session's model has no `model_pricing` row, so every cost in this
  // view (including `costPerToken` below, which returns null for exactly this reason) is
  // unknown rather than zero. Surfaced once at the top of the view instead of silently
  // dropping every figure.
  const unpricedModel = useMemo(() => {
    if (!parsed || !pricing) return null;
    const model = parsed.summary.model;
    return model && !pricing[model] ? model : null;
  }, [parsed, pricing]);

  // Per-token rate for workflow agent cost estimates — shared with the Summary tab's per-prompt
  // cost table via `computeWorkflowCostPerToken` (log-parser.ts) so the two never drift.
  const costPerToken = useMemo(() => {
    if (!parsed) return null;
    return computeWorkflowCostPerToken(
      parsed,
      pricing,
      sessionSubagentCost,
      subagentLogsMap,
      agentParentMap,
    );
  }, [parsed, pricing, sessionSubagentCost, subagentLogsMap, agentParentMap]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">
          {getSessionLogsErrorMessage(error)}
        </p>
      </div>
    );
  }

  if (parsed === null) {
    return null;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-auto">
        {unpricedModel != null && (
          <div className="flex flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/5 px-4 py-1.5 text-xs text-muted-foreground">
            <NoPricingBadge modelId={unpricedModel} />
            <span>
              Session and turn costs cannot be computed for this model.
            </span>
          </div>
        )}
        <StartupContextLine
          main={logsData?.main}
          onOpenAnatomy={onOpenAnatomy}
        />
        <PromptTurnList
          turns={parsed.turns}
          compactBoundaries={parsed.compactBoundaries}
          subagentLogsMap={subagentLogsMap}
          agentParentMap={agentParentMap}
          pricing={pricing}
          sessionModel={parsed?.summary.model}
          costPerToken={costPerToken}
          hasStopFailure={parsed.hasStopFailure}
          subagentStats={logsData?.subagentStats}
        />
      </div>
    </div>
  );
}
