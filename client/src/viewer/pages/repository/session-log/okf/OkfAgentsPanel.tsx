/**
 * The session OKF tab's Agents panel: one row per agent of the tree (main + sub-agents), named
 * by `okfAgentLabel` (main / 1.N · description). Clicking an agent (`okfAgent` in the URL) narrows the
 * tree to that agent's KB reads and opens its trail in section B; clicking it again clears both.
 */
import { formatBytes } from '@/lib/format';
import {
  okfAgentLabel,
  okfLabelIsTaskHead,
  type OkfAgentLabels,
} from '@/lib/okf/okf-agent-label';
import { entryLabel } from '@/lib/okf/okf-verdict-text';
import type { OkfAgent } from '../../../../../models/repositories';
import { formatOkfYield } from './okf-tree';

/**
 * Value-signal columns of one agent (2026-11-03): code paths followed (pointer yield), searches
 * without reading (routing misses), KB articles it edited (upkeep) and code searches. Hidden on an older server that sends none of them.
 */
function AgentSignals({ agent }: { agent: OkfAgent }) {
  if (
    agent.yield === undefined &&
    agent.routingMisses === undefined &&
    agent.upkeepArticles === undefined &&
    agent.searches === undefined
  ) {
    return null;
  }
  const misses = agent.routingMisses?.length ?? 0;
  const cells: {
    label: string;
    value: string;
    testId: string;
    warn?: boolean;
  }[] = [
    {
      label: 'paths followed',
      value: formatOkfYield(agent.yield),
      testId: 'okf-agent-yield',
    },
    {
      label: 'searched w/o reading',
      value: String(misses),
      testId: 'okf-agent-misses',
      warn: misses > 0,
    },
    {
      label: 'edited KB',
      value: String(agent.upkeepArticles?.length ?? 0),
      testId: 'okf-agent-upkeep',
    },
    {
      label: 'code searches',
      value: String(agent.searches ?? 0),
      testId: 'okf-agent-searches',
    },
  ];
  return (
    <div className="grid max-w-sm grid-cols-2 gap-x-3 gap-y-1 pt-0.5 text-[11px]">
      {cells.map((c) => (
        <div
          key={c.label}
          data-testid={c.testId}
          className="flex items-baseline justify-between gap-2"
        >
          <span className="text-[10px] text-muted-foreground">{c.label}</span>
          <span
            className={`font-mono tabular-nums ${
              c.warn ? 'text-amber-600 dark:text-amber-400' : ''
            }`}
          >
            {c.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export function OkfAgentsPanel({
  agents,
  rootSessionId,
  labels,
  selected,
  onSelect,
}: {
  agents: readonly OkfAgent[];
  rootSessionId: string;
  labels: OkfAgentLabels;
  selected: string | null;
  onSelect: (agentId: string | null) => void;
}) {
  return (
    <div
      data-testid="okf-agents-panel"
      className="w-full shrink-0 rounded-md border border-border bg-card @4xl/okf:w-[300px]"
    >
      <div className="border-b border-border px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Agents · {agents.length}
      </div>
      {agents.length === 0 ? (
        <div className="px-3 py-4 text-xs text-muted-foreground">
          No agent read the KB.
        </div>
      ) : (
        <div className="divide-y divide-border">
          {agents.map((a) => {
            const active = selected === a.id;
            const label = okfAgentLabel(a.id, rootSessionId, labels);
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
                  <span
                    className="min-w-0 truncate font-medium"
                    data-testid="okf-agent-label"
                    title={label}
                  >
                    {label}
                  </span>
                  {a.entry ? (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {entryLabel(a.entry)}
                    </span>
                  ) : null}
                </div>
                {a.taskHead && !okfLabelIsTaskHead(a, rootSessionId) ? (
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
                <AgentSignals agent={a} />
              </button>
            );
          })}
        </div>
      )}
      <div className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        Click an agent → the tree shows only its reads, section B its trail.
      </div>
    </div>
  );
}
