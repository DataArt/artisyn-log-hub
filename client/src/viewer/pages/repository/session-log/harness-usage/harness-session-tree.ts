/**
 * The "Harness usage" tab's session tree and per-node element index.
 *
 * One call assembles everything the tab renders: the tree (root session → agent sub-sessions →
 * `Workflow · <name>` group nodes), each node's own element list, its descendant set, and the
 * flat render list. The tab memoises a single call of this on the raw `/logs` payload, so
 * selecting a node or flipping the "Include sub-sessions" switch is a pure re-selection — no
 * re-walk, no re-parse, no fetch.
 *
 * Pure — no React, no DOM.
 */
import type { WorkflowRun } from '../../../../../models/workflows';
import { stripAgentPrefix } from '../log-parser';
import { formatLocalTimestamp } from '../../../../lib/format';
import {
  compareHarnessElements,
  extractHarnessElements,
  splitSidechainGroups,
  type HarnessElement,
  type RawLogEvent,
} from './harness-elements';

export const HARNESS_ROOT_NODE_ID = 'root';

export interface HarnessTreeNode {
  id: string;
  kind: 'root' | 'agent' | 'workflow-group';
  label: string;
  /** First 8 chars of the session/agent id — absent on nodes that are not a session. */
  shortId?: string;
  subtitle?: string;
  /** Row `title` attribute — for a workflow agent, the head of its own first prompt. */
  titleHint?: string;
  children: HarnessTreeNode[];
}

export interface HarnessUsageModel {
  root: HarnessTreeNode;
  /** Node id → that node's OWN elements, chronologically sorted. */
  elementsByNodeId: Map<string, HarnessElement[]>;
  /** Node id → own element count. The tree badge's only source; never subtree-aggregated. */
  ownCountByNodeId: Map<string, number>;
  labelByNodeId: Map<string, string>;
  /** Node id → every descendant node id, at any depth. */
  descendantsByNodeId: Map<string, string[]>;
  /**
   * Sum of own counts over session nodes only. A workflow group's own list is already the merged
   * union of its members', so counting it would double every workflow element.
   */
  totalElements: number;
}

export interface BuildHarnessUsageModelInput {
  mainLogs: RawLogEvent[] | null | undefined;
  subagentLogsMap: Map<string, RawLogEvent[]> | null | undefined;
  agentParentMap: Map<string, string | null> | null | undefined;
  workflows: WorkflowRun[] | null | undefined;
}

export interface FlatHarnessRow {
  node: HarnessTreeNode;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

interface MutableNode extends HarnessTreeNode {
  children: MutableNode[];
}

const TITLE_HINT_MAX = 80;

// ---------------------------------------------------------------------------
// Raw-event readers (kept local; `harness-elements.ts` owns its own equivalents)
// ---------------------------------------------------------------------------

function firstTimestamp(events: RawLogEvent[]): string | undefined {
  for (const e of events) {
    if (typeof e['timestamp'] === 'string') return e['timestamp'];
  }
  return undefined;
}

function firstSessionId(events: RawLogEvent[]): string | undefined {
  for (const e of events) {
    const id = e['sessionId'];
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return undefined;
}

/** Head of a transcript's first real user text, for a workflow agent's row title. */
function firstUserTextSnippet(events: RawLogEvent[]): string | undefined {
  for (const e of events) {
    if (e['type'] !== 'user') continue;
    if (e['isMeta'] === true) continue;
    const content = (e['message'] as { content?: unknown } | undefined)
      ?.content;
    let text: string | undefined;
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      for (const block of content as Array<{ type?: string; text?: string }>) {
        if (block.type === 'text' && typeof block.text === 'string') {
          text = block.text;
          break;
        }
      }
    }
    const trimmed = text?.trim();
    if (!trimmed) continue;
    return trimmed.length > TITLE_HINT_MAX
      ? `${trimmed.slice(0, TITLE_HINT_MAX)}…`
      : trimmed;
  }
  return undefined;
}

/**
 * `agentId → agent_type` from artisyn `SubagentStart` hook events — the same correlation
 * `parseSessionLogs` performs to label an `AgentActivation`.
 */
export function collectAgentTypes(
  events: RawLogEvent[],
  out: Map<string, string>,
): void {
  for (const e of events) {
    if (e['type'] !== 'artisyn') continue;
    if (e['hook_event_name'] !== 'SubagentStart') continue;
    const agentId = e['agent_id'];
    const agentType = e['agent_type'];
    if (typeof agentId !== 'string' || typeof agentType !== 'string') continue;
    if (!agentType) continue;
    out.set(stripAgentPrefix(agentId), agentType);
  }
}

/**
 * `agentId → the spawning Agent call's declared type`, from the `Agent`/`Task` tool_use ↔
 * `toolUseResult.agentId` pairing inside one transcript. The fallback when no `SubagentStart`
 * hook event was recorded.
 */
export function collectSpawnedAgentTypes(
  events: RawLogEvent[],
  out: Map<string, string>,
): void {
  const typeByToolUseId = new Map<string, string>();
  for (const e of events) {
    if (e['type'] !== 'assistant') continue;
    const content = (e['message'] as { content?: unknown } | undefined)
      ?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{
      type?: string;
      name?: string;
      id?: string;
      input?: Record<string, unknown>;
    }>) {
      if (block.type !== 'tool_use' || !block.id) continue;
      if (block.name !== 'Agent' && block.name !== 'Task') continue;
      const declared =
        (typeof block.input?.['subagent_type'] === 'string'
          ? block.input['subagent_type']
          : undefined) ??
        (typeof block.input?.['description'] === 'string'
          ? block.input['description']
          : undefined);
      if (declared) typeByToolUseId.set(block.id, declared);
    }
  }
  if (typeByToolUseId.size === 0) return;

  for (const e of events) {
    if (e['type'] !== 'user') continue;
    const agentId = (e['toolUseResult'] as { agentId?: string } | undefined)
      ?.agentId;
    if (typeof agentId !== 'string' || !agentId) continue;
    const content = (e['message'] as { content?: unknown } | undefined)
      ?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{
      type?: string;
      tool_use_id?: string;
    }>) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue;
      const declared = typeByToolUseId.get(block.tool_use_id);
      if (declared) out.set(stripAgentPrefix(agentId), declared);
    }
  }
}

// ---------------------------------------------------------------------------
// Model assembly
// ---------------------------------------------------------------------------

function emptyModel(): HarnessUsageModel {
  const root: MutableNode = {
    id: HARNESS_ROOT_NODE_ID,
    kind: 'root',
    label: 'Main session',
    children: [],
  };
  return {
    root,
    elementsByNodeId: new Map([[HARNESS_ROOT_NODE_ID, []]]),
    ownCountByNodeId: new Map([[HARNESS_ROOT_NODE_ID, 0]]),
    labelByNodeId: new Map([[HARNESS_ROOT_NODE_ID, 'Main session']]),
    descendantsByNodeId: new Map([[HARNESS_ROOT_NODE_ID, []]]),
    totalElements: 0,
  };
}

export function buildHarnessUsageModel(
  input: BuildHarnessUsageModelInput,
): HarnessUsageModel {
  const mainLogs = input.mainLogs ?? [];
  const subagentLogsMap = input.subagentLogsMap ?? new Map();
  const agentParentMap = input.agentParentMap ?? new Map();
  const workflows = input.workflows ?? [];

  if (mainLogs.length === 0 && subagentLogsMap.size === 0) return emptyModel();

  // --- agent type resolution -------------------------------------------------
  const agentTypeByAgentId = new Map<string, string>();
  collectSpawnedAgentTypes(mainLogs, agentTypeByAgentId);
  for (const logs of subagentLogsMap.values()) {
    collectSpawnedAgentTypes(logs, agentTypeByAgentId);
  }
  // SubagentStart wins over the tool_use-declared type — it is what actually ran.
  collectAgentTypes(mainLogs, agentTypeByAgentId);

  // --- nodes -----------------------------------------------------------------
  const rootSessionId = firstSessionId(mainLogs);
  const rootFirstTs = firstTimestamp(mainLogs);
  const root: MutableNode = {
    id: HARNESS_ROOT_NODE_ID,
    kind: 'root',
    label: 'Main session',
    ...(rootSessionId ? { shortId: rootSessionId.slice(0, 8) } : {}),
    ...(rootFirstTs ? { subtitle: formatLocalTimestamp(rootFirstTs) } : {}),
    children: [],
  };

  const nodeById = new Map<string, MutableNode>([[root.id, root]]);
  const parentNodeById = new Map<string, MutableNode>();
  /** Every raw-event array whose elements belong to a node (a session, plus merged sidechains). */
  const sourcesByNodeId = new Map<string, RawLogEvent[][]>();

  const addSource = (nodeId: string, events: RawLogEvent[]) => {
    const bucket = sourcesByNodeId.get(nodeId);
    if (bucket) bucket.push(events);
    else sourcesByNodeId.set(nodeId, [events]);
  };

  const agentIds: string[] = [];
  for (const id of agentParentMap.keys()) agentIds.push(id);
  for (const id of subagentLogsMap.keys()) {
    if (!agentParentMap.has(id)) agentIds.push(id);
  }

  for (const agentId of agentIds) {
    if (nodeById.has(agentId)) continue;
    const declaredType = agentTypeByAgentId.get(agentId);
    nodeById.set(agentId, {
      id: agentId,
      kind: 'agent',
      // No known type means a bare "Agent" label rather than a redundant "Agent · Agent".
      label: declaredType ? `Agent · ${declaredType}` : 'Agent',
      shortId: agentId.slice(0, 8),
      children: [],
    });
  }

  // Attach agents. `parentSessionId` is documented as null for a depth-1 agent whose parent row predates parent linkage — so any
  // agent with no resolvable parent NODE goes under the root rather than vanishing (DD 4).
  for (const agentId of agentIds) {
    const node = nodeById.get(agentId);
    if (!node) continue;
    const parentId = agentParentMap.get(agentId);
    const parentNode =
      parentId && parentId !== agentId ? nodeById.get(parentId) : undefined;
    const target = parentNode ?? root;
    target.children.push(node);
    parentNodeById.set(agentId, target);
  }

  // --- workflow group nodes ---------------------------
  const groupMemberIds = new Map<string, string[]>();
  const claimedByWorkflow = new Set<string>();
  for (const wf of workflows) {
    // Every id in `agentSessionIds` keeps its `agent-` prefix (the server's BFS only admits
    // prefixed ids), while the node map is keyed stripped — without this the member set matches
    // nothing and no group node is ever produced.
    const members: string[] = [];
    for (const raw of wf.agentSessionIds ?? []) {
      const id = stripAgentPrefix(raw);
      if (!nodeById.has(id)) continue;
      if (claimedByWorkflow.has(id)) continue;
      if (members.includes(id)) continue;
      members.push(id);
    }
    if (members.length === 0) continue;

    const memberSet = new Set(members);
    const directMembers = members.filter((id) => {
      const parentId = agentParentMap.get(id);
      return !(parentId && memberSet.has(parentId));
    });
    if (directMembers.length === 0) continue;

    const groupId = `wf:${wf.wfId ?? wf.toolUseId}`;
    if (nodeById.has(groupId)) continue;
    const groupParent = parentNodeById.get(directMembers[0]) ?? root;
    const group: MutableNode = {
      id: groupId,
      kind: 'workflow-group',
      label: `Workflow · ${wf.name}`,
      subtitle: `${wf.agentCount ?? directMembers.length} agents`,
      children: [],
    };

    for (const memberId of directMembers) {
      const memberNode = nodeById.get(memberId);
      if (!memberNode) continue;
      const currentParent = parentNodeById.get(memberId);
      if (currentParent) {
        const at = currentParent.children.indexOf(memberNode);
        if (at >= 0) currentParent.children.splice(at, 1);
      }
      group.children.push(memberNode);
      parentNodeById.set(memberId, group);
    }

    groupParent.children.push(group);
    nodeById.set(groupId, group);
    parentNodeById.set(groupId, groupParent);
    groupMemberIds.set(groupId, members);

    // Label + row title for every member, positional within the run.
    members.forEach((memberId, i) => {
      claimedByWorkflow.add(memberId);
      const memberNode = nodeById.get(memberId);
      if (!memberNode) return;
      memberNode.label = `${wf.name}:Agent ${i + 1}`;
      const logs = subagentLogsMap.get(memberId);
      const hint = logs ? firstUserTextSnippet(logs) : undefined;
      if (hint) memberNode.titleHint = hint;
    });
  }

  // --- sidechain groups ----------------------------------
  const sessionSources: Array<[string, RawLogEvent[]]> = [[root.id, mainLogs]];
  for (const [agentId, logs] of subagentLogsMap) {
    if (nodeById.has(agentId)) sessionSources.push([agentId, logs]);
  }

  for (const [ownerNodeId, events] of sessionSources) {
    const split = splitSidechainGroups(events);
    addSource(ownerNodeId, split.mainEvents);
    for (const group of split.groups) {
      const resolved = group.agentId ? stripAgentPrefix(group.agentId) : null;
      if (resolved && nodeById.has(resolved)) {
        // An uploaded transcript already covers this agent — append, never a second node and
        // never a double count.
        addSource(resolved, group.events);
        continue;
      }
      const nodeId = `sidechain:${group.anchorUuid.slice(0, 8)}`;
      if (nodeById.has(nodeId)) {
        addSource(nodeId, group.events);
        continue;
      }
      const owner = nodeById.get(ownerNodeId) ?? root;
      const node: MutableNode = {
        id: nodeId,
        kind: 'agent',
        label: group.agentType ? `Agent · ${group.agentType}` : 'Agent',
        children: [],
      };
      owner.children.push(node);
      nodeById.set(nodeId, node);
      parentNodeById.set(nodeId, owner);
      addSource(nodeId, group.events);
    }
  }

  // --- elements --------------------------------------------------------------
  const elementsByNodeId = new Map<string, HarnessElement[]>();
  for (const node of nodeById.values()) {
    if (node.kind === 'workflow-group') {
      elementsByNodeId.set(node.id, []);
      continue;
    }
    const sources = sourcesByNodeId.get(node.id) ?? [];
    const elements: HarnessElement[] = [];
    for (const events of sources) {
      elements.push(
        ...extractHarnessElements(events, {
          nodeId: node.id,
          nodeOrder: 0,
          workflows,
        }),
      );
    }
    elements.sort(compareHarnessElements);
    elementsByNodeId.set(node.id, elements);
  }

  // --- ordering, then nodeOrder ---------------------------------------------
  const earliestByNodeId = new Map<string, number>();
  const earliestOf = (node: MutableNode): number => {
    let earliest = Number.POSITIVE_INFINITY;
    for (const el of elementsByNodeId.get(node.id) ?? []) {
      if (el.tsMs !== null && el.tsMs < earliest) earliest = el.tsMs;
    }
    for (const child of node.children) {
      const childEarliest = earliestOf(child);
      if (childEarliest < earliest) earliest = childEarliest;
    }
    earliestByNodeId.set(node.id, earliest);
    return earliest;
  };
  earliestOf(root);

  const sortChildren = (node: MutableNode): void => {
    node.children.sort((a, b) => {
      const ta = earliestByNodeId.get(a.id) ?? Number.POSITIVE_INFINITY;
      const tb = earliestByNodeId.get(b.id) ?? Number.POSITIVE_INFINITY;
      if (ta !== tb) return ta - tb;
      return a.label.localeCompare(b.label);
    });
    for (const child of node.children) sortChildren(child);
  };
  sortChildren(root);

  let order = 0;
  const assignOrder = (node: MutableNode): void => {
    const nodeOrder = order;
    order += 1;
    for (const el of elementsByNodeId.get(node.id) ?? []) {
      el.nodeOrder = nodeOrder;
    }
    for (const child of node.children) assignOrder(child);
  };
  assignOrder(root);

  // A group's own list is the chronologically merged union of its members' — the requirement's
  // "selecting it shows the merged list of its agents' elements". Done after nodeOrder so the
  // merge's tiebreaks are the real tree order.
  for (const [groupId, members] of groupMemberIds) {
    const merged: HarnessElement[] = [];
    for (const memberId of members) {
      merged.push(...(elementsByNodeId.get(memberId) ?? []));
    }
    merged.sort(compareHarnessElements);
    elementsByNodeId.set(groupId, merged);
  }

  // --- indexes ---------------------------------------------------------------
  const ownCountByNodeId = new Map<string, number>();
  const labelByNodeId = new Map<string, string>();
  let totalElements = 0;
  for (const node of nodeById.values()) {
    const count = elementsByNodeId.get(node.id)?.length ?? 0;
    ownCountByNodeId.set(node.id, count);
    labelByNodeId.set(node.id, node.label);
    if (node.kind !== 'workflow-group') totalElements += count;
  }

  const descendantsByNodeId = new Map<string, string[]>();
  const collectDescendants = (node: MutableNode): string[] => {
    const out: string[] = [];
    for (const child of node.children) {
      out.push(child.id, ...collectDescendants(child));
    }
    descendantsByNodeId.set(node.id, out);
    return out;
  };
  collectDescendants(root);

  return {
    root,
    elementsByNodeId,
    ownCountByNodeId,
    labelByNodeId,
    descendantsByNodeId,
    totalElements,
  };
}

/**
 * Pre-order flatten for the left pane. A node in `collapsed` still renders its own row; its
 * subtree does not.
 */
export function flattenHarnessRows(
  root: HarnessTreeNode,
  collapsed: ReadonlySet<string>,
): FlatHarnessRow[] {
  const rows: FlatHarnessRow[] = [];
  const walk = (node: HarnessTreeNode, depth: number) => {
    const hasChildren = node.children.length > 0;
    const expanded = hasChildren && !collapsed.has(node.id);
    rows.push({ node, depth, hasChildren, expanded });
    if (!expanded) return;
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(root, 0);
  return rows;
}
