import { useMemo } from 'react';
import type { ModelPricingMap } from '../../../../../models/pricing';
import { resolveCharsPerToken } from '../log-parser';
import { ToolCallView } from '../tool-call-view/ToolCallView';
import { useToolView } from '../tool-call-view/ToolViewContext';
import { useBashViews } from '../tool-call-view/useBashView';
import { BashCallList } from './BashCallList';
import { collectBashCalls } from './collect-bash-calls';
import { useBashCallParam } from './useBashCallParam';

interface Props {
  mainLogs: Record<string, unknown>[] | null | undefined;
  subagentLogsMap: Map<string, Record<string, unknown>[]> | undefined;
  pricing?: ModelPricingMap;
  sessionModel?: string;
}

/**
 * The session's Bash tab (DD-18): every Bash command of the session tree in time order on the
 * left, the selected call's full view on the right. The selection lives in the `bashCall` URL
 * param (DD-19); a missing or unknown id shows row 1 without rewriting the URL.
 */
export function SessionBashTab({
  mainLogs,
  subagentLogsMap,
  pricing,
  sessionModel,
}: Props) {
  const charsPerToken = resolveCharsPerToken(pricing, sessionModel);
  const rows = useMemo(
    () => collectBashCalls(mainLogs, subagentLogsMap),
    [mainLogs, subagentLogsMap],
  );
  const views = useBashViews(rows);
  const [selectedId, select] = useBashCallParam();
  const { openSubAgent } = useToolView();

  if (rows.length === 0) {
    return (
      <div
        className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground"
        data-testid="session-bash-tab"
      >
        No Bash commands in this session
      </div>
    );
  }

  const selected = rows.find((r) => r.id === selectedId) ?? rows[0];
  const { agentId, agentLabel } = selected;

  return (
    // A container query, not a viewport one: the pane is narrow whenever the sidebar and the
    // session list are open. Below 42rem the list stacks above the details instead of
    // squeezing them to a sliver.
    <div
      className="@container/bash h-full min-h-0"
      data-testid="session-bash-tab"
    >
      <div className="flex h-full min-h-0 flex-col @2xl/bash:flex-row">
        <BashCallList
          rows={rows}
          views={views}
          selectedId={selected.id}
          onSelect={select}
        />
        <div
          className="min-w-0 flex-1 overflow-y-auto p-4"
          data-testid="bash-call-details"
        >
          <div className="mb-3 flex items-center gap-2 text-xs">
            <span className="font-mono font-semibold">#{selected.n}</span>
            {agentId && agentLabel && (
              <>
                <span
                  className="rounded bg-violet-500/15 px-1.5 py-0.5 text-violet-700 dark:text-violet-300"
                  data-testid="bash-details-agent-badge"
                >
                  {agentLabel}
                </span>
                {openSubAgent && (
                  <button
                    type="button"
                    className="text-primary hover:underline"
                    onClick={() => openSubAgent(agentId, agentLabel)}
                    data-testid="bash-open-subagent"
                  >
                    Open sub-agent →
                  </button>
                )}
              </>
            )}
          </div>
          <ToolCallView
            key={selected.id}
            call={selected}
            charsPerToken={charsPerToken}
          />
        </div>
      </div>
    </div>
  );
}
