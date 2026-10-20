import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/collapsible';
import { formatBytes, getPromptText } from '../../log-parser';
import type { PromptTurn } from '../../types';

import { buildTurnSlices } from './context-data';
import { ContextUsageTable } from './ContextUsageTable';
import { ContextPieChart } from './ContextPieChart';

interface PromptContextCardProps {
  turn: PromptTurn;
  index: number;
  priorOutputTokens?: number;
  showConversationHistory?: boolean;
  charsPerToken?: number;
}

export function PromptContextCard({
  turn,
  index,
  priorOutputTokens,
  showConversationHistory = true,
  charsPerToken,
}: PromptContextCardProps) {
  const [isOpen, setIsOpen] = useState(true);

  const rawSlices = useMemo(
    () => buildTurnSlices(turn, priorOutputTokens ?? 0, charsPerToken),
    [turn, priorOutputTokens, charsPerToken],
  );

  const slices = useMemo(
    () =>
      showConversationHistory
        ? rawSlices
        : rawSlices.filter((s) => s.key !== 'conversation-history'),
    [rawSlices, showConversationHistory],
  );

  const totalBytes = slices.reduce((sum, s) => sum + s.bytes, 0);
  const totalTokens = slices.reduce((s, sl) => s + sl.tokens, 0);
  const promptText = getPromptText(turn);
  const headerTitle = `#${index} — ${promptText.slice(0, 60)}${promptText.length > 60 ? '…' : ''}`;

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setIsOpen}
      className="mb-3 rounded-md border border-border bg-card"
    >
      <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-3 text-sm hover:bg-muted/30 transition-colors">
        <span className="truncate text-left font-medium">{headerTitle}</span>
        <span className="ml-4 flex shrink-0 items-center gap-2">
          {slices.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              No context data
            </span>
          ) : (
            <span className="text-xs text-muted-foreground tabular-nums">
              Total: {formatBytes(totalBytes)} / {totalTokens.toLocaleString()}{' '}
              tokens
            </span>
          )}
          <ChevronDown
            className="h-4 w-4 text-muted-foreground transition-transform duration-200"
            style={{ transform: isOpen ? 'rotate(0deg)' : 'rotate(-180deg)' }}
          />
        </span>
      </CollapsibleTrigger>

      {slices.length > 0 && (
        <CollapsibleContent>
          <div className="flex flex-wrap gap-4 px-4 pb-4 pt-2">
            <div className="min-w-0 flex-[0_0_45%]">
              <ContextUsageTable slices={slices} />
            </div>
            <div className="min-w-[300px] flex-1 overflow-visible">
              <ContextPieChart slices={slices} size={180} />
            </div>
          </div>
          <div className="px-4 pb-3 text-xs text-muted-foreground">
            MCP Tool Definitions and System context: session-level only
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
