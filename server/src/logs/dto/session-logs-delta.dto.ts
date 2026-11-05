import type { selectSubagentStats } from '../session-logs-delta.service';
import type { WorkflowRun } from '../workflow-extractor';

/**
 * One sub-agent's `session_stats` fields — exactly what `/logs` returns per key of its
 * `subagentStats` map (the select of {@link selectSubagentStats} without its `sessionId` key).
 */
export type SubagentStatsRow = Omit<
  Awaited<ReturnType<typeof selectSubagentStats>>[number],
  'sessionId'
>;

/** One JSONL line of a stored log body. */
export type SessionLogLine = Record<string, unknown>;

/** OTEL liveness of the root session (session-map DD-9). */
export interface SessionLogsDeltaLiveness {
  hasOtel: boolean;
  live: boolean;
  lastActivityAt: string | null;
}

/** The cursor no longer matches what is stored — drop local state and poll without a cursor. */
export interface SessionLogsDeltaReload {
  reload: true;
  serverTime: string;
}

/** What changed since the cursor (a full snapshot when the cursor was empty). */
export interface SessionLogsDeltaUpdate {
  reload: false;
  /** Root session's new artisyn lines (body[n:]) — full body when the row is new. */
  rootArtisynLines: SessionLogLine[];
  /** Root session's new claude lines. */
  rootClaudeLines: SessionLogLine[];
  /**
   * Sub-agent logs that changed: new lines only, plus the agent's `.meta.json` labels. An entry
   * with `lines: []` is sent when the log changed without new lines but carries non-null meta.
   */
  subagentAppends: {
    sessionId: string;
    lines: SessionLogLine[];
    agentDescription: string | null;
    workflowPhase: string | null;
  }[];
  /** Sub-agent sessions/logs not in the cursor: full lines plus linkage. */
  newSubagents: {
    sessionId: string;
    parentSessionId: string | null;
    workflowRunId: string | null;
    agentDescription: string | null;
    workflowPhase: string | null;
    logs: SessionLogLine[];
  }[];
  /** Full SubagentStats rows (same fields + EXISTS guard as /logs) of every new/changed sub-agent. */
  subagentStats: Record<string, SubagentStatsRow>;
  /** Full recomputed list (same shape/agentSessionIds as /logs) or null = unchanged. */
  workflows: WorkflowRun[] | null;
  liveness: SessionLogsDeltaLiveness;
  serverTime: string;
  /** Next cursor; `''` = too large to issue, the next poll is a full snapshot. */
  cursor: string;
}

/** Response of `GET /api/v1/repositories/:repoId/sessions/:sessionId/logs/delta`. */
export type SessionLogsDeltaResponse =
  | SessionLogsDeltaReload
  | SessionLogsDeltaUpdate;
