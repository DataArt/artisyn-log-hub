import type {
  SessionLogLine,
  SessionLogsDeltaData,
  SessionLogsDeltaLiveness,
  SubagentStats,
} from '../../../../api';
import type { WorkflowRun } from '../../../../../models/workflows';
import { buildAgentParentMap, stripAgentPrefix } from '../log-parser';

/** A non-reload delta response — the only kind that is merged. */
export type SessionLogsDeltaUpdate = Extract<
  SessionLogsDeltaData,
  { reload: false }
>;

/** One sub-agent session held by the Map: its DB linkage plus every line received so far. */
export interface SessionMapSubagent {
  /** `sessions.session_id`, e.g. `agent-abc123`. */
  sessionId: string;
  parentSessionId: string | null;
  workflowRunId: string | null;
  logs: SessionLogLine[];
}

/**
 * The Session Map's accumulated copy of a session's logs, built from `/logs/delta` responses
 * (session-map DD-10). Every field is replaced, never mutated, so the state can key memos.
 */
export interface SessionMapState {
  rootArtisynLines: SessionLogLine[];
  rootClaudeLines: SessionLogLine[];
  /** In first-seen order. */
  subagents: SessionMapSubagent[];
  /** Keyed by sub-agent `sessionId`, as `/logs` keys it. */
  subagentStats: Record<string, SubagentStats>;
  workflows: WorkflowRun[];
  /** Cursor for the next poll; `''` = the next poll is a full snapshot. */
  cursor: string;
  liveness: SessionLogsDeltaLiveness;
  /** Server clock (ISO) of the last merged response; `''` before any. */
  serverTime: string;
  /** Client epoch ms the last merged response arrived; pairs with `serverTime` for "now". */
  receivedAt: number;
}

export const emptyMapState: SessionMapState = {
  rootArtisynLines: [],
  rootClaudeLines: [],
  subagents: [],
  subagentStats: {},
  workflows: [],
  cursor: '',
  liveness: { hasOtel: false, live: false, lastActivityAt: null },
  serverTime: '',
  receivedAt: 0,
};

function mergeSubagents(
  prev: SessionMapSubagent[],
  delta: SessionLogsDeltaUpdate,
): SessionMapSubagent[] {
  if (delta.subagentAppends.length === 0 && delta.newSubagents.length === 0)
    return prev;
  const appends = new Map<string, SessionLogLine[]>();
  for (const a of delta.subagentAppends) {
    if (a.lines.length > 0) appends.set(a.sessionId, a.lines);
  }
  const fresh = new Map<string, SessionMapSubagent>();
  for (const n of delta.newSubagents) {
    fresh.set(n.sessionId, {
      sessionId: n.sessionId,
      parentSessionId: n.parentSessionId,
      workflowRunId: n.workflowRunId,
      logs: n.logs,
    });
  }
  const next: SessionMapSubagent[] = [];
  for (const sa of prev) {
    // A "new" entry for an already-known sub-agent carries its full lines: replace, never append.
    const replaced = fresh.get(sa.sessionId);
    if (replaced) {
      next.push(replaced);
      fresh.delete(sa.sessionId);
      continue;
    }
    const lines = appends.get(sa.sessionId);
    next.push(lines ? { ...sa, logs: [...sa.logs, ...lines] } : sa);
  }
  // Appends for a sub-agent the state never saw cannot be placed (no linkage) and are dropped.
  for (const n of fresh.values()) next.push(n);
  return next;
}

/**
 * Merges one delta into the state (session-map DD-10). A delta answering a poll sent without a
 * cursor — `prev` is `null` or `prev.cursor === ''` — is a full snapshot and replaces the state;
 * any other delta appends new lines, adds new sub-agents, overwrites stats per key, keeps the
 * previous workflows when `workflows` is `null`, and replaces cursor, liveness and server time.
 */
export function mergeSessionMapDelta(
  prev: SessionMapState | null,
  delta: SessionLogsDeltaUpdate,
  receivedAt: number = Date.now(),
): SessionMapState {
  const base = prev === null || prev.cursor === '' ? emptyMapState : prev;
  return {
    rootArtisynLines:
      delta.rootArtisynLines.length > 0
        ? [...base.rootArtisynLines, ...delta.rootArtisynLines]
        : base.rootArtisynLines,
    rootClaudeLines:
      delta.rootClaudeLines.length > 0
        ? [...base.rootClaudeLines, ...delta.rootClaudeLines]
        : base.rootClaudeLines,
    subagents: mergeSubagents(base.subagents, delta),
    subagentStats:
      Object.keys(delta.subagentStats).length > 0
        ? { ...base.subagentStats, ...delta.subagentStats }
        : base.subagentStats,
    workflows: delta.workflows ?? base.workflows,
    cursor: delta.cursor,
    liveness: delta.liveness,
    serverTime: delta.serverTime,
    receivedAt,
  };
}

/** Inputs for `parseSessionLogs` and the map model, derived from the state (DD-10 "Parse inputs"). */
export interface SessionMapParseInputs {
  /** `artisyn ++ claude`, as `/logs` returns `main`. */
  main: SessionLogLine[];
  /** Keyed by agentId without the `agent-` prefix, as `useRepositoryData` keys it. */
  subagentLogs: Map<string, SessionLogLine[]>;
  /** agentId -> parent agentId (both unprefixed), from `buildAgentParentMap`. */
  agentParentMap: Map<string, string | null>;
  subagentStats: Record<string, SubagentStats>;
  workflows: WorkflowRun[];
  /** agentId (unprefixed) -> `workflowRunId`, only for agents spawned by a Workflow run. */
  workflowRunIds: Map<string, string>;
}

export function toParseInputs(state: SessionMapState): SessionMapParseInputs {
  const subagentLogs = new Map<string, SessionLogLine[]>();
  const workflowRunIds = new Map<string, string>();
  for (const sa of state.subagents) {
    const agentId = stripAgentPrefix(sa.sessionId);
    subagentLogs.set(agentId, sa.logs);
    if (sa.workflowRunId != null) workflowRunIds.set(agentId, sa.workflowRunId);
  }
  return {
    main: [...state.rootArtisynLines, ...state.rootClaudeLines],
    subagentLogs,
    agentParentMap: buildAgentParentMap(state.subagents),
    subagentStats: state.subagentStats,
    workflows: state.workflows,
    workflowRunIds,
  };
}
