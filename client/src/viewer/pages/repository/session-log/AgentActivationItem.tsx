import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { AgentActivation, PromptTurn } from './types';
import {
  formatCompact,
  formatDuration,
  formatInt,
  getPromptText,
  parseSessionLogs,
  stripSystemBlocks,
} from './log-parser';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '../../../ui/collapsible';
import type { ModelPricingMap } from '../../../../models/pricing';
import { computeCost, formatCost } from '../../../lib/format';
import { CostBreakdownTooltip } from '../../../components/CostBreakdownTooltip';
import { cn } from '../../../lib/cn';

interface AgentActivationItemProps {
  activation: AgentActivation;
  subagentLogsMap?: Map<string, Record<string, unknown>[]>;
  pricing?: ModelPricingMap;
  sessionModel?: string;
  renderSubTurn: (turn: PromptTurn) => React.ReactNode;
}

export function AgentActivationItem({
  activation,
  subagentLogsMap,
  pricing,
  sessionModel,
  renderSubTurn,
}: AgentActivationItemProps) {
  const [open, setOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);

  const subLogs = subagentLogsMap?.get(activation.agentId);
  const parsedSubagent = useMemo(
    () => (subLogs ? parseSessionLogs(subLogs, { isSubagent: true }) : null),
    [subLogs],
  );

  const visibleTurns = useMemo(
    () =>
      parsedSubagent?.turns.filter(
        (t) =>
          stripSystemBlocks(getPromptText(t))
            .replace(/<[^>]+>/g, '')
            .trim() !== '',
      ) ?? [],
    [parsedSubagent],
  );

  const label = activation.description ?? `agent-${activation.agentId}`;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 py-1 text-left text-xs hover:text-foreground">
        <ChevronRight
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
        <span className="font-medium text-foreground">{label}</span>
        {activation.durationMs !== undefined && (
          <span className="font-mono text-muted-foreground">
            {formatDuration(activation.durationMs)}
          </span>
        )}
        {activation.totalTokens !== undefined && (
          <span className="font-mono text-muted-foreground">
            {formatCompact(activation.totalTokens)} tok
          </span>
        )}
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="ml-4 mt-1 flex flex-col gap-1 pb-2">
          <p className="font-mono text-[10px] text-muted-foreground/60">
            agent-{activation.agentId}
          </p>

          {/* Output — collapsed by default */}
          {activation.resultText && (
            <Collapsible open={resultOpen} onOpenChange={setResultOpen}>
              <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                <ChevronRight
                  className={cn(
                    'size-3 shrink-0 transition-transform',
                    resultOpen && 'rotate-90',
                  )}
                />
                <span className="font-semibold">Output</span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="ml-4 mt-1 rounded-md bg-muted/40 p-2">
                  <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                    {activation.resultText}
                  </p>
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}

          {/* Token breakdown + cost */}
          {activation.tokens && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-xs">
              <span className="flex items-center gap-1">
                <span className="text-emerald-600 dark:text-emerald-400">
                  In
                </span>
                <span className="text-foreground">
                  {formatInt(activation.tokens.input)}
                </span>
              </span>
              <span className="flex items-center gap-1">
                <span className="text-rose-600 dark:text-rose-400">Out</span>
                <span className="text-foreground">
                  {formatInt(activation.tokens.output)}
                </span>
              </span>
              <span className="flex items-center gap-1">
                <span className="text-sky-600 dark:text-sky-400">Cache↑</span>
                <span className="text-foreground">
                  {formatInt(activation.tokens.cacheRead)}
                </span>
              </span>
              <span className="flex items-center gap-1">
                <span className="text-indigo-600 dark:text-indigo-400">
                  Cache↓
                </span>
                <span className="text-foreground">
                  {formatInt(activation.tokens.cacheWrite)}
                </span>
              </span>
              {pricing && sessionModel && pricing[sessionModel] && (
                <CostBreakdownTooltip
                  breakdown={activation.tokens}
                  pricing={pricing[sessionModel]}
                >
                  <span className="flex cursor-help items-center gap-1">
                    <span className="text-violet-600 dark:text-violet-400">
                      Cost
                    </span>
                    <span className="font-medium">
                      {formatCost(
                        computeCost(activation.tokens, pricing[sessionModel]),
                      )}
                    </span>
                  </span>
                </CostBreakdownTooltip>
              )}
            </div>
          )}

          {/* Sub-agent turns — rendered via renderSubTurn prop to avoid circular import */}
          {visibleTurns.length > 0 && (
            <div className="mt-2 divide-y divide-border rounded-md border border-border/50">
              {visibleTurns.map((t) => renderSubTurn(t))}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
