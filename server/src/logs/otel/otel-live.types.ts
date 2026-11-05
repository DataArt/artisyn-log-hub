// Shapes of the OTEL Live view (2026-11-04 otel-live-view): the two read routes
// `GET /api/v1/otel/live/status` and `GET /api/v1/otel/live` (API changes section of the plan),
// plus the internal seam between the live SQL, the pure tree builder and the reader (DD-20).
// Money and token sums are decimal strings and times are ISO strings, as in every OTEL DTO.

import type { TeamScope } from '../team-scope';
import type { OtelStructure } from './otel-facts.types';

// ── DTOs ────────────────────────────────────────────────────────────────────────────────

/** Response of `GET /api/v1/otel/live/status` (DD-12). */
export interface OtelLiveStatusResponse {
  live: boolean;
  liveSessions: number;
  liveAgents: number;
  /** Lifetime cost of the live roots (DD-22). */
  costUsdMicros: string;
  /** Header sparkline over the live roots (added 2026-11-05; additive, DD-19). */
  spark: OtelLiveSpark;
}

/**
 * Per-minute activity of the last `minutes` minutes, oldest first: point `i` covers
 * `(now - (minutes - i) min, now - (minutes - 1 - i) min]`, so the last point is the last 60 s.
 */
export interface OtelLiveSpark {
  minutes: number;
  /** input + output + cache read + cache write tokens per minute. */
  tokens: number[];
  /** Cost per minute, decimal strings. */
  costUsdMicros: string[];
}

export type OtelLiveNodeType =
  | 'home'
  | 'team'
  | 'noteam'
  | 'repo'
  | 'session'
  | 'agent';

/** Figures every live node carries (DD-6). */
export interface OtelLiveTotals {
  costUsdMicros: string;
  inputTokens: string;
  outputTokens: string;
  cacheReadTokens: string;
  cacheWriteTokens: string;
  calls: number;
  liveSessions: number;
  liveAgents: number;
  runningMs: number;
  firstEventAt: string | null;
  lastActivityAt: string | null;
}

export interface OtelLiveNode {
  /** Canonical key (DD-3). */
  key: string;
  type: OtelLiveNodeType;
  /** null for home. */
  parentKey: string | null;
  /** Team name / repo URL / user email · first-prompt excerpt (masked) / agent label. */
  label: string;
  live: boolean;
  /** false = ended agent shown only in a session breakdown (DD-9). */
  inTree: boolean;
  /** Team node filtered to the caller's own sessions (DD-4). */
  restricted: boolean;
  teamId: number | null;
  repoId: number | null;
  rootId: number | null;
  sessionUuid: string | null;
  agentKey: string | null;
  userEmail: string | null;
  totals: OtelLiveTotals;
}

export interface OtelLiveBucket {
  start: string;
  structure: OtelStructure;
  /** '' = not reported (also for `skill` / `mcpServer`). */
  model: string;
  skill: string;
  mcpServer: string;
  calls: number;
  costUsdMicros: string;
  inputTokens: string;
  outputTokens: string;
  cacheReadTokens: string;
  cacheWriteTokens: string;
}

export interface OtelLiveLatencyBucket {
  start: string;
  kind: 'llm' | 'tool';
  count: number;
  p50Ms: number;
  p95Ms: number;
  failed: number;
}

export interface OtelLiveCallRow {
  callKey: string;
  eventTime: string;
  model: string | null;
  agentKey: string;
  agentLabel: string;
  structure: OtelStructure;
  costUsdMicros: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs: number | null;
}

export interface OtelLiveView {
  costPerMinUsdMicros: string;
  buckets: OtelLiveBucket[];
  latency: OtelLiveLatencyBucket[];
  hasSpans: boolean;
  breakdown: OtelLiveNode[];
  /** Agents beyond the DD-9 cap, 0 otherwise. */
  moreAgents: number;
  calls: OtelLiveCallRow[] | null;
  distinctFootnote: boolean;
  /**
   * Sankey rows over the 2 h window (2026-11-05 follow-up): per root × model for a parent node,
   * per model × agent for a session, `[]` for an agent. Added later — older clients ignore it.
   */
  flows: OtelLiveFlowRow[];
}

/** One Live sankey row; the client maps `rootId` to team / user / repo / session from `nodes`. */
export interface OtelLiveFlowRow {
  rootId: number;
  model: string;
  /** Session view only; null for hidden (utility) calls and on parent views. */
  agentKey: string | null;
  agentLabel: string | null;
  costUsdMicros: string;
  calls: number;
  /** input + output + cache read + cache write. */
  tokens: string;
}

export interface OtelLiveEvent {
  time: string;
  kind: 'api_request' | 'tool';
  label: string | null;
  costUsdMicros: string | null;
}

export interface OtelLiveTopUser {
  email: string;
  liveSessions: number;
  costUsdMicros: string;
}

export interface OtelLiveTopModel {
  model: string;
  calls: number;
  costUsdMicros: string;
}

export interface OtelLiveTopRepo {
  repoId: number;
  label: string;
  costUsdMicros: string;
}

export interface OtelLiveTopTool {
  name: string;
  calls: number;
  failed: number;
}

export interface OtelLiveDetails {
  key: string;
  type: OtelLiveNodeType;
  live: boolean;
  liveUsers: number | null;
  longestRunningMs: number | null;
  topUsers: OtelLiveTopUser[] | null;
  topModels: OtelLiveTopModel[] | null;
  topRepos: OtelLiveTopRepo[] | null;
  userEmail: string | null;
  startedAt: string | null;
  claudeVersion: string | null;
  firstPrompt: string | null;
  attributesMasked: boolean;
  agents: OtelLiveNode[] | null;
  model: string | null;
  topTools: OtelLiveTopTool[] | null;
  events: OtelLiveEvent[] | null;
  calls: OtelLiveCallRow[] | null;
}

/** Response of `GET /api/v1/otel/live`. */
export interface OtelLiveResponse {
  generatedAt: string;
  tz: string;
  windowFrom: string;
  windowTo: string;
  /** Canonical key actually shown (DD-3 fallback → 'home'). */
  selected: string;
  /** Tree nodes (inTree) in display order: teams by name, No team last, children by cost desc. */
  nodes: OtelLiveNode[];
  view: OtelLiveView;
  details: OtelLiveDetails | null;
}

// ── Internal shapes (DD-20) ─────────────────────────────────────────────────────────────

/** A parsed node key (DD-3). */
export interface ParsedLiveKey {
  type: OtelLiveNodeType;
  teamId?: number;
  noteam?: boolean;
  /** true when the key carries an `@<teamId>` / `@noteam` placement suffix. */
  qualified: boolean;
  repoId?: number;
  rootId?: number;
  agentKey?: string;
}

export interface OtelLiveWindow {
  from: Date;
  to: Date;
}

/** agentKey 'main' = `agent_id IS NULL AND structure <> 'hidden'`. */
export interface OtelLiveAgentFilter {
  rootId: number;
  agentKey: string;
}

/** Tree-derived part of the details panel for home / team / noteam / repo (DD-10). */
export interface OtelLiveNodeSummary {
  topUsers: OtelLiveTopUser[];
  liveUsers: number;
  longestRunningMs: number;
  /** null unless type = team. */
  topRepos: OtelLiveTopRepo[] | null;
}

export interface OtelLiveScopeTeam {
  teamId: number;
  teamName: string;
  /** Effective row filter on `logs.user_id` (DD-4); null = no user predicate. */
  userIds: number[] | null;
  restricted: boolean;
  scope: TeamScope;
}

/** A candidate root; `live` per DD-1. */
export interface OtelLiveCandidate {
  rootId: number;
  live: boolean;
}

export interface OtelLivePlacementRow {
  rootId: number;
  userId: number;
  userEmail: string;
  /** null = No team. */
  teamId: number | null;
  /** team_repo_id, or the caller's own repositories.id under No team. */
  repoId: number;
  /** repositories.repo_url. */
  repoLabel: string;
  /** logs.first_prompt of the root's artisyn log (masked by the reader, DD-11). */
  firstPrompt: string | null;
  /** sessions.session_id. */
  sessionUuid: string;
  /** logs.start_time. */
  startedAt: string | null;
}

export interface OtelLiveRootTotalsRow {
  rootId: number;
  costUsdMicros: string;
  inputTokens: string;
  outputTokens: string;
  cacheReadTokens: string;
  cacheWriteTokens: string;
  calls: number;
  firstEventAt: string | null;
  lastActivityAt: string | null;
}

export interface OtelLiveAgentRow {
  rootId: number;
  agentKey: string;
  agentLabel: string;
  costUsdMicros: string;
  inputTokens: string;
  outputTokens: string;
  cacheReadTokens: string;
  cacheWriteTokens: string;
  calls: number;
  firstEventAt: string;
  lastEventAt: string;
}

export interface OtelLiveRetainedRepoLabel {
  /** null = No team. */
  teamId: number | null;
  repoId: number;
  label: string;
}

export interface OtelLiveTreeInput {
  now: Date;
  scopeTeams: OtelLiveScopeTeam[];
  candidates: OtelLiveCandidate[];
  placements: OtelLivePlacementRow[];
  rootTotals: OtelLiveRootTotalsRow[];
  agents: OtelLiveAgentRow[];
  retainedKeys: ParsedLiveKey[];
  retainedRepoLabels: OtelLiveRetainedRepoLabel[];
}

export interface OtelLiveTree {
  /**
   * Every node in display order (home first; teams by name, No team last; children by cost
   * desc). Includes ended agents with `inTree: false` (they appear only in a session breakdown);
   * the response's `nodes` are the `inTree` ones. A root linked to two repos of one team is
   * emitted under both repo nodes, so session / agent keys may repeat with a different parent.
   */
  nodes: OtelLiveNode[];
  /** The first in-tree node for a key, resolving an unqualified key (DD-3); null if none. */
  resolve(key: string): OtelLiveNode | null;
  /** DISTINCT root ids below (and including) the resolved key, [] if it does not resolve. */
  rootIdsOf(key: string): number[];
  /** Direct in-tree children of the resolved key, in display order (DD-9 parent breakdown). */
  childrenOf(key: string): OtelLiveNode[];
  /** DD-9: a parent whose total is less than the sum of its children's totals. */
  distinctFootnote(key: string): boolean;
}
