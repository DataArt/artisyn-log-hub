import type { WorkflowRun } from '../../../../models/workflows';
export type { WorkflowRun };

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /**
   * Per-TTL split of `cache_creation_input_tokens`, present on newer transcripts only.
   * When absent, all cache-creation tokens are treated as 5m (see `splitCacheWrite`
   * in `log-parser.ts`, twinned with `splitCacheCreationTokens` on the server).
   */
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  /**
   * Server-side tool usage for this response. Only `web_search_requests` is billed
   * (per request, at `priceWebSearch`); `web_fetch_requests` is free and is ignored.
   */
  server_tool_use?: {
    web_search_requests?: number;
    web_fetch_requests?: number;
  };
  /**
   * Billing speed of this response. `'fast'` tokens cost `FAST_MODE_MULTIPLIER` x the
   * standard rate (see `computeCost` in `viewer/lib/format.ts`); absent or `'standard'`
   * means the normal rate.
   */
  speed?: string;
}

export interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /**
   * TTL split of `cacheWrite`. Both are required, not optional, so the invariant
   * `cacheWrite5m + cacheWrite1h === cacheWrite` is structurally guaranteed at every
   * construction site.
   */
  cacheWrite5m: number;
  cacheWrite1h: number;
  /**
   * Billed web-search requests (`usage.server_tool_use.web_search_requests`).
   * Priced **per request** at `priceWebSearch`, not per million — it is not a token count
   * and must never be folded into a token total.
   */
  webSearchRequests: number;
  /**
   * Fast-mode **subsets** of `input` / `output` (`usage.speed === 'fast'`) — not
   * additional tokens. `inputFast <= input` and `outputFast <= output` always hold, and
   * the fast surcharge is applied on top of the grand total in `computeCost`; adding
   * these as separate priced terms would double-bill every fast token.
   *
   * Required, not optional, for the same reason as the TTL pair: every fold site has to
   * carry them or the session/turn totals silently drop the surcharge.
   */
  inputFast: number;
  outputFast: number;
}

export interface BaseEvent {
  type: string;
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
}

export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
}

export interface UserEvent extends BaseEvent {
  message?: { content?: ContentBlock[] | string };
  toolUseResult?: {
    agentId?: string;
    usage?: TokenUsage;
    totalDurationMs?: number;
    totalTokens?: number;
  };
}

export interface AssistantEvent extends BaseEvent {
  message?: {
    /** API response id — shared by every transcript line split off the same response. */
    id?: string;
    usage?: TokenUsage;
    content?: ContentBlock[];
    model?: string;
    stop_reason?: string;
  };
}

export interface SystemTurnDurationEvent extends BaseEvent {
  subtype: 'turn_duration';
  durationMs?: number;
  messageCount?: number;
}

export interface SystemCompactBoundaryEvent extends BaseEvent {
  subtype: 'compact_boundary';
  compactMetadata?: {
    preTokens: number;
    postTokens?: number;
    durationMs?: number;
    trigger?: string;
  };
}

export interface CompactBoundary {
  timestamp: string;
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
  trigger?: string;
}

export interface ProgressAgentEvent extends BaseEvent {
  toolUseID?: string;
  parentToolUseID?: string;
  data: {
    type: 'agent_progress';
    agentId: string;
    prompt?: string;
    message?: {
      type?: string;
      message?: { model?: string; usage?: TokenUsage };
    };
  };
}

export type TelemetryEvent =
  | UserEvent
  | AssistantEvent
  | SystemTurnDurationEvent
  | SystemCompactBoundaryEvent
  | ProgressAgentEvent
  | (BaseEvent & { type: string });

export interface SkillInvocation {
  name: string;
  isDuplicate: boolean;
  path?: string;
  bytes?: number;
  estTokens?: number;
  definition?: SkillDefinition;
}

export interface ToolCallDetail {
  id?: string;
  name: string;
  input: Record<string, unknown>;
  /** Tool result as string; absent if no result was captured */
  result?: string;
  status: 'success' | 'error';
  permissionRequested?: boolean;
  permissionDenied?: boolean;
}

export interface FileAccess {
  path: string;
  tool: 'Read' | 'Edit' | 'Write' | 'MultiEdit' | 'Glob';
  globMatchCount?: number;
  /** 1-based access count within a turn; ≥2 means repeated read */
  accessCount: number;
  category: string;
  /** Byte length of tool_result content (Read only) */
  bytes?: number;
  /** Estimated token count: bytes ÷ the session model's chars-per-token ratio (Read only) */
  estTokens?: number;
}

export interface AgentActivation {
  agentId: string;
  description?: string;
  prompt: string;
  resultText?: string;
  tokens?: TokenBreakdown;
  totalTokens?: number;
  durationMs?: number;
  /** Epoch ms when the agent finished (from the completion event timestamp). */
  endMs?: number;
  /** Epoch ms when the agent started (endMs − durationMs). */
  startMs?: number;
  /** Agent type from artisyn SubagentStart hook event, e.g. "Explore", "code-reviewer". */
  agentType?: string;
}

export interface SubAgentNode {
  agentId: string;
  prompt: string;
  model?: string;
  tokens?: TokenBreakdown;
  durationMs?: number;
  toolUseID?: string;
  parentToolUseID?: string;
  /** Tool calls made across the agent's own transcript, when available (e.g. workflow agents). */
  toolCalls?: ToolCallDetail[];
  /** Files touched across the agent's own transcript, when available (e.g. workflow agents). */
  files?: FileAccess[];
  /**
   * Skills this agent loaded, across its own transcript. Same provenance as
   * `toolCalls`/`files`: parsed from the agent's own log in `buildAgentNodesForIds`. Optional and
   * only ever present when non-empty, so a sub-agent that loaded none grows no empty section.
   */
  skills?: SkillInvocation[];
  /** Rule/CLAUDE.md injections in this agent's own transcript. See `skills` above. */
  rulesInjected?: RuleInjection[];
  children: SubAgentNode[];
}

export interface RuleInjection {
  /** Short label, e.g. "server", "client", "hook" */
  name: string;
  /** Full file path from the attachment event */
  path?: string;
  /** Byte length of the injected rule content */
  bytes?: number;
  /** Estimated token count: bytes ÷ the session model's chars-per-token ratio */
  estTokens?: number;
}

export interface ImageAccess {
  /** Full tool name, e.g. "mcp__playwright__browser_take_screenshot" */
  toolName: string;
  mediaType: string;
  /** Decoded image size in bytes (base64_length * 3/4) */
  bytes: number;
  width?: number;
  height?: number;
  /** Estimated Claude input tokens consumed by this image */
  estInputTokens?: number;
}

export interface SkillDefinition {
  name: string;
  description: string;
  argumentHint?: string;
  body: string;
  path: string;
  bytes: number;
  source: 'project' | 'builtin' | 'plugin';
  lastModified?: number;
}

export interface AgentDefinition {
  name: string;
  description: string;
  body: string;
  path: string;
  bytes: number;
  source?: 'project' | 'builtin' | 'plugin';
  lastModified?: number;
}

export interface McpServerConfig {
  name: string;
  command: string;
  args: string;
  url?: string;
  configSource?: 'project' | 'user';
}

export interface PromptTurn {
  index: number;
  userEvent: UserEvent;
  workTimeMs: number | null;
  tokenBreakdown: TokenBreakdown | null;
  /**
   * Tokens from **this turn's own `assistant` events only** — no sub-agent
   * `toolUseResult.usage` fold and no workflow `session_stats` fold, both of which
   * `tokenBreakdown` keeps. This is the denominator/numerator source for the per-turn
   * cache read ratio, which must describe the main thread, not its children.
   */
  ownTokenBreakdown: TokenBreakdown | null;
  contextTokens: number | null;
  contextTokensStart: number | null;
  assistantSteps: Array<{
    contextTokens: number;
    text: string | null;
    stopReason: string | null;
    toolCallNames: string[];
    toolCallSummaries: string[];
    toolCallInputs: Record<string, unknown>[];
    timestamp: string | null;
  }>;
  skills: SkillInvocation[];
  files: FileAccess[];
  images: ImageAccess[];
  subAgents: SubAgentNode[];
  agentActivations: AgentActivation[];
  toolCalls: ToolCallDetail[];
  unmatchedSubagentIds?: string[];
  rulesInjected: RuleInjection[];
  linesChanged: number;
  workflows?: WorkflowRun[];
}

export interface FileCategoryStats {
  files: number;
  bytes: number;
}
export type FileStats = Record<string, FileCategoryStats>;

export interface ImageStats {
  count: number;
  totalBytes: number;
  estInputTokens: number;
}

export interface SessionSummary {
  promptCount: number;
  totalTokens: number;
  tokenBreakdown: TokenBreakdown;
  totalWorkTimeMs: number;
  maxContextTokens: number | null;
  skillsUsed: string[];
  fileStats: FileStats;
  linesChanged: number;
  imageStats: ImageStats;
  deferredTools: string[];
  registeredAgents: string[];
  registeredSkills: string[];
  /** Primary model used in the session (from first assistant event with a model field) */
  model?: string;
  /** CLAUDE.md system-context injected by the hook on upload */
  claudeMd?: ClaudeMdContext;
  skillDefinitions?: Map<string, SkillDefinition>;
  agentDefinitions?: Map<string, AgentDefinition>;
  mcpConfig?: McpServerConfig[];
}

export interface ClaudeMdFile {
  path: string;
  bytes: number;
  role?: 'claude-md' | 'local-md' | 'rule';
  lastModified?: number;
  content?: string;
}

export interface ClaudeMdContext {
  totalBytes: number;
  estTokens: number;
  files: ClaudeMdFile[];
}

export interface ParsedSession {
  summary: SessionSummary;
  turns: PromptTurn[];
  mcpCalls: Record<string, number>;
  compactBoundaries: CompactBoundary[];
  hasStopFailure: boolean;
}
