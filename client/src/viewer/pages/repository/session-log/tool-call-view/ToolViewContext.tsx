import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { ModelPricingMap } from '../../../../../models/pricing';
import type { ParsedSession, SubAgentNode } from '../types';
import { WorkflowAgentModal } from '../WorkflowAgentModal';

/**
 * What every tool-call view of one session needs from around it (DD-7): the session's repo root
 * (display only — paths are shown repo-relative) and, when sub-agent transcripts are loaded, a
 * way to open a sub-agent's session in `WorkflowAgentModal`.
 */
export interface ToolViewContextValue {
  /** Repo root for display (`ParsedSession.repoRoot`), `''` when unknown. */
  repoRoot: string;
  /** Opens a sub-agent's session; absent outside a `ToolViewProvider`. */
  openSubAgent?: (agentId: string, label?: string) => void;
}

const ToolViewContext = createContext<ToolViewContextValue>({ repoRoot: '' });

export function useToolView(): ToolViewContextValue {
  return useContext(ToolViewContext);
}

function findAgentNode(
  nodes: SubAgentNode[] | undefined,
  agentId: string,
): SubAgentNode | undefined {
  for (const node of nodes ?? []) {
    if (node.agentId === agentId) return node;
    const child = findAgentNode(node.children, agentId);
    if (child) return child;
  }
  return undefined;
}

interface OpenAgent {
  node: SubAgentNode;
  label: string;
  logs: Record<string, unknown>[];
}

interface ProviderProps {
  repoRoot: string;
  parsedLogs: ParsedSession | null | undefined;
  /** Bare-id-keyed sub-agent transcripts of the session. */
  subagentLogsMap: Map<string, Record<string, unknown>[]> | undefined;
  pricing?: ModelPricingMap;
  sessionModel?: string;
  children: ReactNode;
}

/**
 * Provides `ToolViewContext` to a session's tabs and owns the one `WorkflowAgentModal` that
 * "Open sub-agent →" opens. The node comes from the parsed `turns[].subAgents` tree (recursive),
 * else a bare `{agentId, prompt: '', children: []}`; opening an agent with no transcript is a
 * no-op.
 */
export function ToolViewProvider({
  repoRoot,
  parsedLogs,
  subagentLogsMap,
  pricing,
  sessionModel,
  children,
}: ProviderProps) {
  const [open, setOpen] = useState<OpenAgent | null>(null);

  const openSubAgent = useCallback(
    (agentId: string, label?: string) => {
      const logs = subagentLogsMap?.get(agentId);
      if (!logs || logs.length === 0) return;
      let node: SubAgentNode | undefined;
      for (const turn of parsedLogs?.turns ?? []) {
        node = findAgentNode(turn.subAgents, agentId);
        if (node) break;
      }
      setOpen({
        node: node ?? { agentId, prompt: '', children: [] },
        label: label || `Agent ${agentId.slice(0, 8)}`,
        logs,
      });
    },
    [parsedLogs, subagentLogsMap],
  );

  const value = useMemo<ToolViewContextValue>(
    () => ({ repoRoot, openSubAgent }),
    [repoRoot, openSubAgent],
  );

  return (
    <ToolViewContext.Provider value={value}>
      {children}
      {open && (
        <WorkflowAgentModal
          agent={open.node}
          label={open.label}
          logs={open.logs}
          subagentLogsMap={subagentLogsMap}
          pricing={pricing}
          sessionModel={sessionModel}
          onClose={() => setOpen(null)}
        />
      )}
    </ToolViewContext.Provider>
  );
}
