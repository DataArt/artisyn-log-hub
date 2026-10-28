/**
 * Resolves a `tool_use` id (the `tu` URL param of the Tools/MCP tab's "Open in session" link,
 * DD-19) to the index of the root-session turn that holds it, so the Logs tab can scroll there
 * through the existing cross-tab target-turn state.
 *
 * The call may sit in the root transcript, in a sub-agent's own transcript (any depth) or in a
 * sub-agent log the turn model did not attach; the last case is found by scanning the
 * sub-agent logs and walking `agentParentMap` up to an agent some turn activated.
 */
import type { PromptTurn, SubAgentNode, ToolCallDetail } from './types';

function hasCall(calls: ToolCallDetail[] | undefined, id: string): boolean {
  return calls?.some((c) => c.id === id) ?? false;
}

function nodeHolds(node: SubAgentNode, id: string): boolean {
  return (
    hasCall(node.allToolCalls, id) ||
    hasCall(node.toolCalls, id) ||
    node.children.some((child) => nodeHolds(child, id))
  );
}

function contentHoldsToolUse(content: unknown, id: string): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (block === null || typeof block !== 'object') return false;
    const b = block as { type?: unknown; id?: unknown };
    return b.type === 'tool_use' && b.id === id;
  });
}

function logHoldsToolUse(logs: Record<string, unknown>[], id: string): boolean {
  return logs.some((line) => {
    const message = line.message;
    if (message === null || typeof message !== 'object') return false;
    return contentHoldsToolUse((message as { content?: unknown }).content, id);
  });
}

function turnActivates(turn: PromptTurn, agentIds: Set<string>): boolean {
  return (
    turn.agentActivations.some((a) => agentIds.has(a.agentId)) ||
    turn.subAgents.some((s) => agentIds.has(s.agentId))
  );
}

/**
 * The `index` of the turn holding `toolUseId`, or null when no turn does. Checked in order:
 * the turn's own calls, its sub-agent tree, then the sub-agent logs (the agent that issued the
 * call and its ancestors, matched against each turn's activations).
 */
export function findTurnIndexForToolUse(
  turns: PromptTurn[],
  toolUseId: string,
  subagentLogs: Map<string, Record<string, unknown>[]>,
  agentParentMap: Map<string, string | null>,
): number | null {
  if (toolUseId === '') return null;
  for (const turn of turns) {
    if (
      hasCall(turn.allToolCalls, toolUseId) ||
      turn.subAgents.some((s) => nodeHolds(s, toolUseId))
    ) {
      return turn.index;
    }
  }

  for (const [agentId, logs] of subagentLogs) {
    if (!logHoldsToolUse(logs, toolUseId)) continue;
    const chain = new Set<string>();
    let current: string | null | undefined = agentId;
    while (current && !chain.has(current)) {
      chain.add(current);
      current = agentParentMap.get(current);
    }
    const turn = turns.find((t) => turnActivates(t, chain));
    if (turn) return turn.index;
  }
  return null;
}
