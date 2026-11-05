/**
 * Responses of the OTEL Live view routes (2026-11-04 otel-live-view):
 * `GET /api/v1/otel/live/status` and `GET /api/v1/otel/live`.
 * Client copy of `server/src/logs/otel/otel-live.types.ts` (DTOs only).
 * Money and token sums are decimal strings, times are ISO strings.
 */
import type { OtelStructure } from './repositories';

/**
 * Response of `GET /api/v1/otel/live/status` (DD-12). Fields beyond `live` / `liveSessions`
 * are optional: the status DTO may gain or lose additive fields (DD-19).
 */
export interface OtelLiveStatusResponse {
  live: boolean;
  liveSessions: number;
  liveAgents?: number;
  /** Lifetime cost of the live roots. */
  costUsdMicros?: string;
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
  /** Canonical key (DD-3); the client never parses or builds keys. */
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
  /** Sankey rows over the 2 h window; absent from servers before 2026-11-05. */
  flows?: OtelLiveFlowRow[];
}

/** One Live sankey row: per root × model (parent nodes) or model × agent (a session). */
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

/** Query of `GET /api/v1/otel/live`. */
export interface OtelLiveParams {
  /** Node key (DD-3); default `home`. */
  node?: string | null;
  /** Details-panel node key. */
  panel?: string | null;
  /** IANA zone, echoed back. */
  tz?: string | null;
}
