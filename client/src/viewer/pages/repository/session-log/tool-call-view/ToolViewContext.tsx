import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ModelPricingMap } from '../../../../../models/pricing';
import type { ParsedSession, SubAgentNode } from '../types';
import { WorkflowAgentModal } from '../WorkflowAgentModal';
import { agentDescriptionText, agentRowLabel } from '../workflow-agent-rows';
import { useSessionParts } from '../../session-parts/SessionPartsContext';

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

/** An agent asked to open; it opens once its log part (and descendants) is loaded. */
interface OpenRequest {
  agentId: string;
  label?: string;
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
 * no-op. The agent's log part and its descendants' load first (impl-plan DD-33): the modal opens
 * once they are in.
 */
export function ToolViewProvider({
  repoRoot,
  parsedLogs,
  subagentLogsMap,
  pricing,
  sessionModel,
  children,
}: ProviderProps) {
  const { requestAgent } = useSessionParts();
  const [request, setRequest] = useState<OpenRequest | null>(null);
  // Only the latest click opens: an earlier request still loading is dropped.
  const requestSeq = useRef(0);

  const openSubAgent = useCallback(
    (agentId: string, label?: string) => {
      const seq = ++requestSeq.current;
      void requestAgent(agentId, true).then(() => {
        if (seq === requestSeq.current) setRequest({ agentId, label });
      });
    },
    [requestAgent],
  );

  // Resolved against the current transcripts, so a part that lands a render after
  // `requestAgent` resolves still opens the modal.
  const open = useMemo<OpenAgent | null>(() => {
    if (request === null) return null;
    const { agentId, label } = request;
    const logs = subagentLogsMap?.get(agentId);
    if (!logs || logs.length === 0) return null;
    let node: SubAgentNode | undefined;
    for (const turn of parsedLogs?.turns ?? []) {
      node = findAgentNode(turn.subAgents, agentId);
      if (node) break;
    }
    return {
      node: node ?? { agentId, prompt: '', children: [] },
      // Caller's label first; else the node's `.meta.json` description label; else the short id.
      label:
        label ||
        (node && agentDescriptionText(node.agentDescription)
          ? agentRowLabel(node)
          : `Agent ${agentId.slice(0, 8)}`),
      logs,
    };
  }, [request, parsedLogs, subagentLogsMap]);

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
          onClose={() => setRequest(null)}
        />
      )}
    </ToolViewContext.Provider>
  );
}
