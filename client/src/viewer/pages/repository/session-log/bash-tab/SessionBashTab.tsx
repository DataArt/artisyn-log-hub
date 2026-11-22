import { useEffect, useMemo } from 'react';
import type { ShellKind } from '@loghub/bash-view';
import type { ModelPricingMap } from '../../../../../models/pricing';
import { resolveCharsPerToken } from '../log-parser';
import { ToolCallView } from '../tool-call-view/ToolCallView';
import { useToolView } from '../tool-call-view/ToolViewContext';
import { useBashViews } from '../tool-call-view/useBashView';
import { BashCallList, type ShellCounts } from './BashCallList';
import { collectBashCalls } from './collect-bash-calls';
import { useBashCallParam } from './useBashCallParam';
import { useShellFilterParam } from './useShellFilterParam';

interface Props {
  mainLogs: Record<string, unknown>[] | null | undefined;
  subagentLogsMap: Map<string, Record<string, unknown>[]> | undefined;
  pricing?: ModelPricingMap;
  sessionModel?: string;
}

/** Calls per shell — the filter chips' counts and the `mixed` test (DD-24). */
function countByShell(rows: ReadonlyArray<{ shell: ShellKind }>): ShellCounts {
  const counts: ShellCounts = { bash: 0, powershell: 0 };
  for (const r of rows) counts[r.shell] += 1;
  return counts;
}

/**
 * The session's Shell tab (DD-18, tab id `bash`): every shell command (Bash and PowerShell) of the
 * session tree in time order on the left, the selected call's full view on the right. The
 * selection lives in the `bashCall` URL param (DD-19); a missing or unknown id shows the first
 * visible row without rewriting the URL. On a session with both shells a filter in the `shell`
 * URL param (DD-24) narrows the list; row numbers never change.
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
  const [urlShell, setShell] = useShellFilterParam();
  const { openSubAgent } = useToolView();

  const counts = useMemo(() => countByShell(rows), [rows]);
  const mixed = counts.bash > 0 && counts.powershell > 0;
  // DD-24: the filter applies only on a mixed session; a `bashCall` that names a row the filter
  // would hide wins over `shell` (the filter is dropped from the URL below).
  const urlSelected = rows.find((r) => r.id === selectedId);
  const hidesSelected =
    urlShell !== null &&
    urlSelected !== undefined &&
    urlSelected.shell !== urlShell;
  const shell = mixed && !hidesSelected ? urlShell : null;

  useEffect(() => {
    if (mixed && hidesSelected) setShell(null);
  }, [mixed, hidesSelected, setShell]);

  if (rows.length === 0) {
    return (
      <div
        className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground"
        data-testid="session-bash-tab"
      >
        No shell commands in this session
      </div>
    );
  }

  const visibleRows = shell ? rows.filter((r) => r.shell === shell) : rows;
  const selected =
    visibleRows.find((r) => r.id === selectedId) ?? visibleRows[0];

  // Picking a filter that hides the selected row selects the first visible one (DD-24).
  const onShellChange = (next: ShellKind | null) => {
    const nextRows = next ? rows.filter((r) => r.shell === next) : rows;
    const keeps = nextRows.some((r) => r.id === selected.id);
    setShell(next, keeps ? undefined : nextRows[0]?.id);
  };
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
          rows={visibleRows}
          views={views}
          shellFilter={
            mixed ? { shell, counts, onChange: onShellChange } : null
          }
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
