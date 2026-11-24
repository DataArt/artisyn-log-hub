import type {
  SessionLiveness,
  SessionLogLine,
  SessionLogPartsManifest,
  SessionLogsData,
  SubagentStats,
} from '../../../../api';
import type { WorkflowRun } from '../../../../../models/workflows';
import { buildAgentParentMap, stripAgentPrefix } from '../log-parser';
import { agentDescriptionText } from '../workflow-agent-rows';

/** One sub-agent session held by the Map: its DB linkage plus its lines. */
export interface SessionMapSubagent {
  /** `sessions.session_id`, e.g. `agent-abc123`. */
  sessionId: string;
  parentSessionId: string | null;
  workflowRunId: string | null;
  /** `description` from the agent's `.meta.json`; `null` when unknown (old hook/server). */
  agentDescription: string | null;
  /** `workflowPhase` from the agent's `.meta.json`; `null` when unknown. */
  workflowPhase: string | null;
  logs: SessionLogLine[];
}

/**
 * The Session Map's view of a session (algorithm `session-map-state`): built from the parts
 * manifest and the loaded part bodies, the same data every other session tab reads. Rebuilt as a
 * new object whenever either changes, so it can key memos.
 */
export interface SessionMapState {
  /** `artisyn ++ claude` of the root, as `/logs` returns `main`. */
  main: SessionLogLine[];
  /** The loaded sub-agent parts, in manifest order. */
  subagents: SessionMapSubagent[];
  /** Keyed by sub-agent `sessionId`, as `/logs` keys it. */
  subagentStats: Record<string, SubagentStats>;
  workflows: WorkflowRun[];
  liveness: SessionLiveness;
  /** Server clock (ISO) of the manifest; `''` when the server does not send it. */
  serverTime: string;
  /** Client epoch ms the manifest arrived; pairs with `serverTime` for "now". */
  receivedAt: number;
}

/** What an older server's manifest (no `liveness`) means: no OTEL, so never live. */
export const NOT_LIVE: SessionLiveness = {
  hasOtel: false,
  live: false,
  lastActivityAt: null,
};

export const emptyMapState: SessionMapState = {
  main: [],
  subagents: [],
  subagentStats: {},
  workflows: [],
  liveness: NOT_LIVE,
  serverTime: '',
  receivedAt: 0,
};

/**
 * Builds the Map's state from the manifest and the assembled logs (`assembleSessionLogs`). Each
 * loaded sub-agent takes its `workflowRunId` from its manifest part; the labels and the parent
 * come with the assembled entry. `liveness` / `serverTime` absent from an older server fall back
 * to {@link NOT_LIVE} / `''`.
 */
export function buildSessionMapState(
  manifest: SessionLogPartsManifest,
  logs: SessionLogsData,
  receivedAt: number,
): SessionMapState {
  const runIdBySession = new Map<string, string | null>();
  for (const part of manifest.parts) {
    if (part.logType === 'claude-subagent')
      runIdBySession.set(part.sessionId, part.workflowRunId);
  }
  return {
    main: logs.main,
    subagents: logs.subagents.map((sa) => ({
      sessionId: sa.sessionId,
      parentSessionId: sa.parentSessionId ?? null,
      workflowRunId: runIdBySession.get(sa.sessionId) ?? null,
      agentDescription: sa.agentDescription ?? null,
      workflowPhase: sa.workflowPhase ?? null,
      logs: sa.logs,
    })),
    subagentStats: manifest.subagentStats,
    workflows: manifest.workflows,
    liveness: manifest.liveness ?? NOT_LIVE,
    serverTime: manifest.serverTime ?? '',
    receivedAt,
  };
}

/** Inputs for `parseSessionLogs` and the map model, derived from the state. */
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
  /** agentId (unprefixed) -> trimmed `.meta.json` description, only for agents that have one. */
  agentDescriptions: Map<string, string>;
}

export function toParseInputs(state: SessionMapState): SessionMapParseInputs {
  const subagentLogs = new Map<string, SessionLogLine[]>();
  const workflowRunIds = new Map<string, string>();
  const agentDescriptions = new Map<string, string>();
  for (const sa of state.subagents) {
    const agentId = stripAgentPrefix(sa.sessionId);
    subagentLogs.set(agentId, sa.logs);
    if (sa.workflowRunId != null) workflowRunIds.set(agentId, sa.workflowRunId);
    const description = agentDescriptionText(sa.agentDescription);
    if (description !== null) agentDescriptions.set(agentId, description);
  }
  return {
    main: state.main,
    subagentLogs,
    agentParentMap: buildAgentParentMap(state.subagents),
    subagentStats: state.subagentStats,
    workflows: state.workflows,
    workflowRunIds,
    agentDescriptions,
  };
}
