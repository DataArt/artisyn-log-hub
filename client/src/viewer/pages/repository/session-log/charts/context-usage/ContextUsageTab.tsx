import { useMemo, useState } from 'react';
import type { ParsedSession } from '../../types';
import type { ModelPricingMap } from '../../../../../../models/pricing';
import { resolveCharsPerToken } from '../../log-parser';
import { buildSessionSlices } from './context-data';
import { ContextUsageTable } from './ContextUsageTable';
import { ContextPieChart } from './ContextPieChart';
import { PromptContextCard } from './PromptContextCard';

interface ContextUsageTabProps {
  session: ParsedSession;
  subagentSessions?: { label: string; session: ParsedSession }[];
  pricing?: ModelPricingMap;
}

export function ContextUsageTab({
  session,
  subagentSessions,
  pricing,
}: ContextUsageTabProps) {
  const [showHistory, setShowHistory] = useState(true);
  const [selectedIdx, setSelectedIdx] = useState<number>(-1);

  const activeSession =
    selectedIdx === -1
      ? session
      : (subagentSessions?.[selectedIdx]?.session ?? session);

  const charsPerToken = resolveCharsPerToken(
    pricing,
    activeSession.summary.model,
  );

  const rawSessionSlices = useMemo(
    () => buildSessionSlices(activeSession, charsPerToken),
    [activeSession, charsPerToken],
  );

  const sessionSlices = useMemo(
    () =>
      showHistory
        ? rawSessionSlices
        : rawSessionSlices.filter((s) => s.key !== 'conversation-history'),
    [rawSessionSlices, showHistory],
  );

  const hasSubagents = subagentSessions && subagentSessions.length > 0;

  return (
    <div className="space-y-0">
      <div>
        <div className="flex items-center gap-3 mb-3">
          <div className="text-sm font-medium text-muted-foreground">
            Session — all turns
          </div>
          <label className="flex items-center gap-1 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showHistory}
              onChange={(e) => setShowHistory(e.target.checked)}
              className="h-3 w-3 accent-primary"
            />
            <span className="text-xs text-muted-foreground">
              Conversation History
            </span>
          </label>
        </div>

        {hasSubagents && (
          <div className="flex flex-wrap gap-1 mb-3">
            <button
              onClick={() => setSelectedIdx(-1)}
              className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                selectedIdx === -1
                  ? 'font-medium border-border bg-muted underline'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              Main Session
            </button>
            {subagentSessions.map((sub, i) => (
              <button
                key={i}
                onClick={() => setSelectedIdx(i)}
                className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                  selectedIdx === i
                    ? 'font-medium border-border bg-muted underline'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {sub.label}
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-4">
          <div className="min-w-0 flex-[0_0_45%]">
            <ContextUsageTable slices={sessionSlices} />
          </div>
          <div className="min-w-[160px] flex-1">
            <ContextPieChart slices={sessionSlices} />
          </div>
        </div>
      </div>

      <div>
        <div className="text-sm font-medium text-muted-foreground mt-6 mb-3">
          Per-prompt breakdown
        </div>
        {activeSession.turns.map((turn, idx) => {
          const priorOutputTokens = activeSession.turns
            .slice(0, idx)
            .reduce((sum, t) => sum + (t.tokenBreakdown?.output ?? 0), 0);
          return (
            <PromptContextCard
              key={turn.index}
              turn={turn}
              index={turn.index}
              priorOutputTokens={priorOutputTokens}
              showConversationHistory={showHistory}
              charsPerToken={charsPerToken}
            />
          );
        })}
      </div>
    </div>
  );
}
