/**
 * The session OKF tab's Agents panel: one row per agent of the tree (main + sub-agents), each on
 * its own task. Clicking an agent narrows the tree to that agent's KB reads; clicking it again
 * clears the filter.
 */
import { formatBytes } from '@/lib/format';
import type {
  OkfAgent,
  OkfAgentEntry,
} from '../../../../../models/repositories';
import { okfAgentLabel } from './okf-tree';

const ENTRY_TEXT: Record<OkfAgentEntry, string> = {
  index: '✓ started from index',
  search: 'found by grep',
  given: 'path given in its prompt',
};

export function OkfAgentsPanel({
  agents,
  rootSessionId,
  selected,
  onSelect,
}: {
  agents: readonly OkfAgent[];
  rootSessionId: string;
  selected: string | null;
  onSelect: (agentId: string | null) => void;
}) {
  return (
    <div
      data-testid="okf-agents-panel"
      className="w-full shrink-0 rounded-md border border-border bg-card lg:w-[280px]"
    >
      <div className="border-b border-border px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Agents · {agents.length} · each on its own task
      </div>
      {agents.length === 0 ? (
        <div className="px-3 py-4 text-xs text-muted-foreground">
          No agent read the KB.
        </div>
      ) : (
        <div className="divide-y divide-border">
          {agents.map((a) => {
            const active = selected === a.id;
            return (
              <button
                key={a.id}
                type="button"
                data-testid="okf-agent-row"
                aria-pressed={active}
                onClick={() => onSelect(active ? null : a.id)}
                className={`block w-full space-y-0.5 px-3 py-2 text-left text-xs hover:bg-accent/50 ${
                  active ? 'bg-accent' : ''
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono font-medium">
                    {okfAgentLabel(a.id, rootSessionId)}
                  </span>
                  {a.entry ? (
                    <span className="text-[11px] text-muted-foreground">
                      {(ENTRY_TEXT as Record<string, string | undefined>)[
                        a.entry
                      ] ?? a.entry}
                    </span>
                  ) : null}
                </div>
                {a.taskHead ? (
                  <div
                    className="truncate text-muted-foreground"
                    title={a.taskHead}
                  >
                    {a.taskHead}
                  </div>
                ) : null}
                <div className="text-[11px] text-muted-foreground">
                  {a.files.length.toLocaleString()} KB files ·{' '}
                  {formatBytes(a.kbReadBytes)} into context
                </div>
              </button>
            );
          })}
        </div>
      )}
      <div className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        Click an agent → the tree shows only its reads.
      </div>
    </div>
  );
}
