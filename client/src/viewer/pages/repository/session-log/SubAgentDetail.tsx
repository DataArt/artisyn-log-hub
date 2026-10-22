import { useState } from 'react';
import type { SubAgentNode as SubAgentNodeType, ToolCallDetail } from './types';
import { formatDuration, formatInt, resolveCharsPerToken } from './log-parser';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '../../../ui/collapsible';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../../lib/cn';
import type { ModelPricingMap } from '../../../../models/pricing';
import { computeCost, formatCost } from '../../../lib/format';
import { CostBreakdownTooltip } from '../../../components/CostBreakdownTooltip';
import {
  SectionHeader,
  ToolCallRow,
  buildToolsSummary,
} from './prompt-turn-helpers';
import { PromptTurnFilesSection } from './PromptTurnFilesSection';
import { PromptTurnSkillsSection } from './PromptTurnSkillsSection';
import { PromptTurnRulesSection } from './PromptTurnRulesSection';
import { ToolCallDetailModal } from './ToolCallDetailModal';

interface Props {
  agent: SubAgentNodeType;
  pricing?: ModelPricingMap;
  sessionModel?: string;
}

const PROMPT_PREVIEW_LIMIT = 200;

/**
 * The expanded body of one sub-agent: prompt, model, tokens/cost, duration, Skills, Rules,
 * Tools and Files. Shared by the turn-level `SubAgentNode` tree and the workflow agent modal
 * (`WorkflowAgentModal`); it never renders the agent's children.
 */
export function SubAgentDetail({ agent, pricing, sessionModel }: Props) {
  const costEntry = (() => {
    if (!agent.tokens || !pricing) return undefined;
    const model = agent.model ?? sessionModel;
    return model ? pricing[model] : undefined;
  })();
  const charsPerToken = resolveCharsPerToken(
    pricing,
    agent.model ?? sessionModel,
  );
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [selectedCall, setSelectedCall] = useState<ToolCallDetail | null>(null);

  const isLongPrompt = agent.prompt.length > PROMPT_PREVIEW_LIMIT;

  return (
    <>
      <div className="mt-1 ml-4 flex flex-col gap-1.5 pb-2">
        <div>
          {isLongPrompt ? (
            <Collapsible open={promptExpanded} onOpenChange={setPromptExpanded}>
              <CollapsibleTrigger className="flex items-start gap-1 text-left text-xs hover:text-foreground text-muted-foreground">
                <ChevronRight
                  className={cn(
                    'mt-0.5 size-3 shrink-0 transition-transform',
                    promptExpanded && 'rotate-90',
                  )}
                />
                <span className="whitespace-pre-wrap break-words">
                  {promptExpanded
                    ? agent.prompt
                    : agent.prompt.slice(0, PROMPT_PREVIEW_LIMIT)}
                  {!promptExpanded && '…'}
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent />
            </Collapsible>
          ) : (
            <p className="whitespace-pre-wrap break-words text-xs">
              {agent.prompt}
            </p>
          )}
        </div>

        {agent.model && (
          <p className="text-xs">
            <span className="text-muted-foreground">Model: </span>
            <span className="font-mono">{agent.model}</span>
          </p>
        )}

        {agent.tokens && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-xs">
            <span className="flex items-center gap-1">
              <span className="text-muted-foreground">In</span>
              <span>{formatInt(agent.tokens.input)}</span>
            </span>
            <span className="flex items-center gap-1">
              <span className="text-muted-foreground">Out</span>
              <span>{formatInt(agent.tokens.output)}</span>
            </span>
            <span className="flex items-center gap-1">
              <span className="text-muted-foreground">Cache↑</span>
              <span>{formatInt(agent.tokens.cacheRead)}</span>
            </span>
            <span className="flex items-center gap-1">
              <span className="text-muted-foreground">Cache↓</span>
              <span>{formatInt(agent.tokens.cacheWrite)}</span>
            </span>
            {costEntry && (
              <CostBreakdownTooltip
                breakdown={agent.tokens}
                pricing={costEntry}
              >
                <span className="flex cursor-help items-center gap-1">
                  <span className="text-violet-600 dark:text-violet-400">
                    Cost
                  </span>
                  <span className="font-medium">
                    {formatCost(computeCost(agent.tokens, costEntry))}
                  </span>
                </span>
              </CostBreakdownTooltip>
            )}
          </div>
        )}

        {agent.durationMs !== undefined && (
          <p className="text-xs">
            <span className="text-muted-foreground">Duration: </span>
            <span className="font-mono">
              {formatDuration(agent.durationMs)}
            </span>
          </p>
        )}
      </div>

      {/* Both sections return null for an empty list, so a sub-agent that loaded
          nothing grows no empty section. Same components the root turns use, so the
          drill-down and a root turn look identical. */}
      {agent.skills && (
        <PromptTurnSkillsSection
          skills={agent.skills}
          charsPerToken={charsPerToken}
          calls={agent.allToolCalls}
          onOpenCall={setSelectedCall}
        />
      )}

      {agent.rulesInjected && (
        <PromptTurnRulesSection rulesInjected={agent.rulesInjected} />
      )}

      {agent.toolCalls && agent.toolCalls.length > 0 && (
        <div className="ml-4 border-l-2 border-l-amber-300 pl-2 dark:border-l-amber-700">
          <SectionHeader
            icon="⚙"
            label="Tools"
            summary={buildToolsSummary(agent.toolCalls, charsPerToken)}
            open={toolsOpen}
            onToggle={() => setToolsOpen((v) => !v)}
          />
          {toolsOpen && (
            <div className="pl-2">
              <table className="mt-1 w-full">
                <tbody>
                  {agent.toolCalls.map((call, i) => (
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

      {agent.files && agent.files.length > 0 && (
        <PromptTurnFilesSection
          files={agent.files}
          calls={agent.allToolCalls}
          onOpenCall={setSelectedCall}
        />
      )}

      {selectedCall && (
        <ToolCallDetailModal
          call={selectedCall}
          onClose={() => setSelectedCall(null)}
          charsPerToken={charsPerToken}
          turnFiles={agent.files}
          subAgents={agent.children}
        />
      )}
    </>
  );
}
