import type { SessionAttributionAttributeDef } from '../../database/schema';
import type { HarnessSnapshotBody } from '../harness-snapshot';
import type { OtelLiveness } from '../otel/otel-facts.reader';
import type { SessionTag, SessionTagNoise } from '../session-tags.reader';
import type { TreeLogType } from '../session-tree-logs-meta';
import type { WorkflowRun } from '../workflow-extractor';
import type { SubagentStatsRow } from './session-logs-delta.dto';

/**
 * Shapes of the session-log parts API (impl-plan "API changes" of
 * 2026-11-23-session-logs-streaming): `GET …/sessions/:sessionId/logs/parts` (the manifest) and
 * `GET …/logs/parts/:partSessionId/:logType` (one part's body, a JSON array of log lines).
 */

/** One sub-agent's `session_stats` figures — the same object `/logs` returns per key. */
export type SubagentStats = SubagentStatsRow;

/** The root session's own productivity counters (`/logs` `rootStats`). */
export interface SessionRootStats {
  linesChanged: number | null;
  filesEditedWritten: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  diffLinesCoveredCalls: number | null;
  diffLinesTotalCalls: number | null;
}

/** The latest submitted Turn-End Cost Advisor result (`/logs` `turnEndAdvisor`). */
export interface TurnEndAdvisor {
  generatedAt: string;
  summaryGeneral: string | null;
  costFactors: string[];
  harnessAdvice: string[];
  model: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

/** The session attribution state the session detail derives its chips from (`/logs`). */
export interface SessionAttribution {
  enabled: boolean;
  attributes: SessionAttributionAttributeDef[];
  values: Record<string, string | string[] | boolean | number | null> | null;
  evaluatedWatermark: number | null;
  currentWatermark: number | null;
  lastRun: {
    outcome: string;
    finishedAt: string;
    failureReason: string | null;
  } | null;
}

/** The harness snapshot bound to the session (`/logs` `harnessSnapshot`). */
export type HarnessSnapshot = HarnessSnapshotBody;

/** One stored log blob of the session tree (DD-11): one `logs` row with a non-NULL body. */
export interface SessionLogPart {
  /** Root session id or `agent-<id>`. */
  sessionId: string;
  logType: TreeLogType;
  /** DD-8: `body_rev` when set, else `'u' + updated_at` in microseconds. */
  rev: string;
  parentSessionId: string | null;
  agentDescription: string | null;
  workflowPhase: string | null;
  workflowRunId: string | null;
}

/** Response of `GET /api/v1/repositories/:repoId/sessions/:sessionId/logs/parts`. */
export interface SessionLogPartsManifest {
  /** DD-5 order (root claude, root artisyn, then sub-agents by session id); NULL bodies omitted. */
  parts: SessionLogPart[];
  /** As `/logs`, including `cacheWrite5mTokens` / `cacheWrite1hTokens`. */
  subagentStats: Record<string, SubagentStats>;
  rootStats: SessionRootStats | null;
  workflows: WorkflowRun[];
  /** Same object as `/logs`. */
  turnEndAdvisor: TurnEndAdvisor | null;
  /** Same object as `/logs`. */
  sessionAttribution: SessionAttribution;
  harnessSnapshot: HarnessSnapshot | null;
  /**
   * The root session's tags (2026-11-24 otel-session-tags), deduped across sources; a
   * sub-agent gets its root's tags. Same array as `/logs`. Absent from an older server.
   */
  tags: SessionTag[];
  /** FR-10 junk-tag verdict of the root session. Same object as `/logs`. */
  tagNoise: SessionTagNoise;
  /** DD-14: derived figures may lag behind the latest upload (a backlog older than 30 s). */
  derivedLagging: boolean;
  /**
   * The root session's OTEL liveness, as `/logs/delta` reports it — the Session Map follows a
   * live session by re-reading this manifest. Absent from an older server.
   */
  liveness: OtelLiveness;
  /** Server clock (ISO) when the manifest was built; pairs with `liveness` for "now". */
  serverTime: string;
}
