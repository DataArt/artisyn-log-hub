/**
 * Pure row logic for the workflow "Agents (N)" table (`WorkflowAgentsTable`): ordering and
 * numbering of the agent forest, and the prompt-derived row label.
 *
 * Algorithm doc (its examples are the test cases):
 * docs/knowledgebase/algorithms/workflow-agent-rows.md
 */
import type { SubAgentNode } from './types';
import { cleanText } from './prompt-turn-helpers';

/** One flattened table row: the agent, its nesting depth (0 = root) and its number (`2.1`). */
export interface AgentRow {
  node: SubAgentNode;
  depth: number;
  number: string;
}

/** Max label length; longer labels are cut to `AGENT_LABEL_LIMIT - 1` chars + `…`. */
export const AGENT_LABEL_LIMIT = 60;

/**
 * Stable sort of one sibling group: nodes with a `startMs` first, ascending; ties and nodes
 * without a `startMs` keep their input order. Copies the array, never mutates it.
 */
function sortSiblings(nodes: readonly SubAgentNode[]): SubAgentNode[] {
  return nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => {
      const sa = a.node.startMs;
      const sb = b.node.startMs;
      if (sa !== undefined && sb !== undefined) {
        return sa !== sb ? sa - sb : a.index - b.index;
      }
      if (sa !== undefined) return -1;
      if (sb !== undefined) return 1;
      return a.index - b.index;
    })
    .map((entry) => entry.node);
}

/**
 * Flattens the agent forest into table rows: each sibling group is sorted by `startMs`
 * (see `sortSiblings`), then walked depth-first so a parent is directly followed by its own
 * sorted children. Root numbers are `"1"`, `"2"`…; a child's number is its parent's number +
 * `.` + its 1-based position among its sorted siblings. Nesting is never changed.
 */
export function orderAgentRows(forest: readonly SubAgentNode[]): AgentRow[] {
  const rows: AgentRow[] = [];
  const walk = (
    nodes: readonly SubAgentNode[],
    depth: number,
    prefix: string,
  ): void => {
    sortSiblings(nodes).forEach((node, i) => {
      const number = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      rows.push({ node, depth, number });
      walk(node.children, depth + 1, number);
    });
  };
  walk(forest, 0, '');
  return rows;
}

/**
 * The row label: the cleaned prompt (`cleanText`: system blocks and tags stripped, whitespace
 * collapsed), falling back to `agentId` when it cleans to empty, cut to `AGENT_LABEL_LIMIT`.
 */
export function agentRowLabel(node: SubAgentNode): string {
  const text = cleanText(node.prompt) || node.agentId;
  return text.length > AGENT_LABEL_LIMIT
    ? `${text.slice(0, AGENT_LABEL_LIMIT - 1)}…`
    : text;
}
