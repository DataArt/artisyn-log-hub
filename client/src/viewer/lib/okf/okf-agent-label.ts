/**
 * How the OKF tabs name an agent of a session tree — one helper for every place (agents panel,
 * entry chips, per-article sub-rows, finding text, the article drill-down).
 *
 * The root session is `main`. A sub-agent is `1.N · <text>`: N is its position among the
 * sub-agents in the order the server lists them (tree order: depth, then start time), and the
 * text is its description (`label`, the Agent tool's `description`), else its cleaned task head,
 * else its short id. Where only an id is known (finding params, the repo drill-down) the label
 * is looked up in a map built from the response's agents, else the short id: the first 8
 * characters after the `agent-` prefix every sub-agent id starts with.
 */
import type { OkfAgent } from '../../../models/repositories';

/** Characters of an id shown when an agent has no other name. */
export const OKF_AGENT_ID_CHARS = 8;

/** Short id of an agent: 8 characters after the common `agent-` prefix. */
export function okfShortAgentId(agentId: string): string {
  return agentId.replace(/^agent-/, '').slice(0, OKF_AGENT_ID_CHARS);
}

/** Longest description / task text in a label; longer text is cut to this − 1 chars + `…`. */
export const OKF_AGENT_TEXT_MAX = 48;

/** Agent id → display label. */
export type OkfAgentLabels = ReadonlyMap<string, string>;

function cut(text: string): string {
  return text.length > OKF_AGENT_TEXT_MAX
    ? `${text.slice(0, OKF_AGENT_TEXT_MAX - 1)}…`
    : text;
}

/** Labels of every agent of a session route's `agents[]`, by id. */
export function buildOkfAgentLabels(
  agents: readonly Pick<OkfAgent, 'id' | 'label' | 'taskHead'>[],
  rootSessionId: string,
): Map<string, string> {
  const out = new Map<string, string>();
  let n = 0;
  for (const a of agents) {
    if (a.id === rootSessionId) {
      out.set(a.id, 'main');
      continue;
    }
    n += 1;
    const text = a.label?.trim() || a.taskHead.trim() || okfShortAgentId(a.id);
    out.set(a.id, `1.${n} · ${cut(text)}`);
  }
  return out;
}

/** Label of one agent id: `main` for the root, the built label, else its short id. */
export function okfAgentLabel(
  agentId: string,
  rootSessionId: string,
  labels?: OkfAgentLabels,
): string {
  if (agentId === rootSessionId) return 'main';
  return labels?.get(agentId) ?? okfShortAgentId(agentId);
}

/** True when the agent's label already is its task head (the task line would repeat it). */
export function okfLabelIsTaskHead(
  agent: Pick<OkfAgent, 'id' | 'label' | 'taskHead'>,
  rootSessionId: string,
): boolean {
  return agent.id !== rootSessionId && !agent.label?.trim();
}
