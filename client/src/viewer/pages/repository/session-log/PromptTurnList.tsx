import type { CompactBoundary, PromptTurn } from './types';
import type { ModelPricingMap } from '../../../../models/pricing';
import {
  formatCompact,
  formatInt,
  getPromptText,
  stripSystemBlocks,
} from './log-parser';
import type { SubagentStatEntry } from './log-parser';
import { PromptTurnItem } from './PromptTurnItem';
import { compactBoundariesBetween } from './compact-boundary-placement';

interface Props {
  turns: PromptTurn[];
  compactBoundaries?: CompactBoundary[];
  subagentLogsMap?: Map<string, Record<string, unknown>[]>;
  /** agentId -> parentAgentId, from the DB's authoritative sessions.parent_session_id. */
  agentParentMap?: Map<string, string | null>;
  pricing?: ModelPricingMap;
  sessionModel?: string;
  costPerToken?: number | null;
  hasStopFailure?: boolean;
  /** Token totals from session_stats for child sessions, keyed by sessionId (e.g. "agent-abc123"). */
  subagentStats?: Record<string, SubagentStatEntry>;
}

export function isSystemOnlyTurn(turn: PromptTurn): boolean {
  return (
    stripSystemBlocks(getPromptText(turn))
      .replace(/<[^>]+>/g, '')
      .trim() === ''
  );
}

function CompactBoundaryDivider({ compact }: { compact: CompactBoundary }) {
  const preTokens = compact.preTokens ?? 0;
  const postTokens = compact.postTokens ?? 0;
  const reduction = preTokens - postTokens;
  const reductionPct =
    preTokens > 0 ? Math.round((reduction / preTokens) * 100) : 0;
  const durationSec =
    compact.durationMs !== undefined
      ? (compact.durationMs / 1000).toFixed(1)
      : null;
  const hasTokenData = compact.preTokens !== undefined;

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-amber-50/60 dark:bg-amber-950/20 border-y border-amber-200/60 dark:border-amber-800/40">
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="text-amber-500 text-sm">⟳</span>
        <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">
          Context compacted
        </span>
        {compact.trigger && compact.trigger !== 'auto' && (
          <span className="text-xs text-amber-600/70 dark:text-amber-500/70">
            ({compact.trigger})
          </span>
        )}
      </div>
      {hasTokenData && (
        <div className="flex items-center gap-3 font-mono text-xs text-muted-foreground">
          <span title={`${formatInt(preTokens)} tokens`}>
            {formatCompact(preTokens)}
          </span>
          <span className="text-amber-400 dark:text-amber-600">→</span>
          <span title={`${formatInt(postTokens)} tokens`}>
            {formatCompact(postTokens)}
          </span>
          <span className="text-amber-600 dark:text-amber-500">
            −{formatCompact(reduction)} (−{reductionPct}%)
          </span>
          {durationSec !== null && (
            <span className="text-muted-foreground/60">{durationSec}s</span>
          )}
        </div>
      )}
    </div>
  );
}

function StopFailureBanner() {
  return (
    <div className="flex items-center gap-2 px-4 py-2.5 bg-red-50/60 dark:bg-red-950/20 border-y border-red-200/60 dark:border-red-800/40">
      <span className="text-red-500 text-sm">✗</span>
      <span className="text-xs font-semibold text-red-700 dark:text-red-400">
        Session ended with a stop failure
      </span>
      <span className="text-xs text-muted-foreground">
        Claude attempted to stop but the hook rejected it or an error occurred.
      </span>
    </div>
  );
}

export function PromptTurnList({
  turns,
  compactBoundaries = [],
  subagentLogsMap,
  agentParentMap,
  pricing,
  sessionModel,
  costPerToken,
  hasStopFailure = false,
  subagentStats,
}: Props) {
  const visible = turns.filter((t) => !isSystemOnlyTurn(t));

  if (visible.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        No user prompts found in this session.
      </p>
    );
  }

  return (
    <div className="divide-y divide-border">
      {visible.map((turn, i) => {
        const nextTurn = visible[i + 1];
        const turnTs = turn.userEvent.timestamp;
        const nextTs = nextTurn?.userEvent.timestamp;

        // Find compact boundaries that fall between this turn and the next
        const compactsAfter = compactBoundariesBetween(
          turnTs,
          nextTs,
          compactBoundaries,
        );

        return (
          <div key={turn.index}>
            <PromptTurnItem
              turn={turn}
              subagentLogsMap={subagentLogsMap}
              agentParentMap={agentParentMap}
              pricing={pricing}
              sessionModel={sessionModel}
              costPerToken={costPerToken}
              subagentStats={subagentStats}
            />
            {compactsAfter.map((cb) => (
              <CompactBoundaryDivider key={cb.timestamp} compact={cb} />
            ))}
          </div>
        );
      })}
      {hasStopFailure && <StopFailureBanner />}
    </div>
  );
}
