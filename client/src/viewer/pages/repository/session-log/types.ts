import type { CallTokens } from '@loghub/pricing';
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

/**
 * Tokens of one LLM call — one deduplicated assistant usage (keyed by `message.id`, falling
 * back to `uuid`), or one sub-agent `toolUseResult.usage` priced as a single call. Needed
 * because prompt-length tiers price each call by its own prompt size, which the aggregates
 * cannot reproduce. Defined in the shared `@loghub/pricing` package.
 */
export type { CallTokens };

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
  /**
   * Per-call tokens summing to the aggregates above, in first-seen order (DD14). Optional:
   * a breakdown built without call data (e.g. a `session_stats` fallback) is priced on the
   * aggregate path. Every merge of two breakdowns concatenates both lists, or drops them
   * when either side has none (`concatCalls` in `log-parser.ts`).
   */
  calls?: CallTokens[];
}

export interface BaseEvent {
  type: string;
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  /** Working directory of the Claude Code process when the line was written. */
  cwd?: string;
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
    /** The tool call was interrupted by the user. */
    interrupted?: boolean;
  };
  /**
   * Why Claude Code denied the tool call this result answers (`user-rejected`,
   * `permission-rule`, `automode-blocked`, `interrupted`); absent when it ran.
   */
  toolDenialKind?: string;
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
  /** Id of the `Skill` tool call that loaded this skill (DD-21). */
  toolUseId?: string;
  /** Status of that call (DD-3, DD-21). */
  status?: ToolCallStatus;
}

/**
 * Where a tool call is shown in a turn (DD-1). Decided only by `toolSection` in
 * `tool-calls.ts`: `'file'` → Files, `'skill'` → Skills, `'agent'` → Agents, `'tool'` → Tools.
 */
export type ToolSection = 'file' | 'skill' | 'agent' | 'tool';

/**
 * Outcome of a tool call (DD-3): `'missing'` = no result captured, `'rejected'` = denied by the
 * user/a rule or interrupted, `'error'` = `is_error` result, `'success'` otherwise.
 */
export type ToolCallStatus = 'success' | 'error' | 'rejected' | 'missing';

export interface ToolCallDetail {
  id?: string;
  name: string;
  input: Record<string, unknown>;
  /** Section the call belongs to (DD-1). */
  section: ToolSection;
  /** Tool result as string; absent if no result was captured */
  result?: string;
  status: ToolCallStatus;
  /** `tool_use` line timestamp (DD-4). */
  startedAt?: string;
  /** `tool_result` line timestamp (DD-4). */
  endedAt?: string;
  /** `endedAt − startedAt` in ms when both exist and the value is ≥ 0 (DD-4). */
  durationMs?: number;
  /** The call was interrupted by the user (`toolUseResult.interrupted`); status is `'rejected'` (DD-3). */
  interrupted?: true;
  /** The result line's `toolDenialKind`, copied when status is `'rejected'` (DD-3). */
  denialKind?: string;
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
  /** Byte length of tool_result content (Read only; absent when status ≠ `'success'`) */
  bytes?: number;
  /** Estimated token count: bytes ÷ the session model's chars-per-token ratio (Read only; absent when status ≠ `'success'`) */
  estTokens?: number;
  /** Id of the tool call behind this access (DD-21). */
  toolUseId?: string;
  /** Status of that call (DD-3, DD-21). */
  status?: ToolCallStatus;
  /** First line of the result, cut to `FILE_ERROR_MAX_CHARS`; set only when status ≠ `'success'` (DD-21). */
  error?: string;
}

export interface AgentActivation {
  /** Id of the `Agent` tool call that started this activation (DD-21). */
  toolUseId?: string;
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
  /** Epoch ms of the agent's first timestamped transcript record. */
  startMs?: number;
  toolUseID?: string;
  parentToolUseID?: string;
  /**
   * Every tool call across the agent's own transcript, in call order, deduped by id (fork
   * sub-agents repeat their parent's ids). The source of the derived `toolCalls`, `files` and
   * `skills` below (DD-1a).
   */
  allToolCalls?: ToolCallDetail[];
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
  /** Full file path from the attachment event (`~/.claude/…` for a User-type file) */
  path?: string;
  /** Attachment `content.type` as logged, e.g. "Project", "User", "Local" */
  type?: string;
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

/** DD-1's plugin provenance, present only on a `plugin`-source skill/entry. */
export interface SkillDefinitionPlugin {
  id: string;
  name: string;
  marketplace: string;
  version: string;
  gitCommitSha?: string;
}

export interface SkillDefinition {
  name: string;
  description: string;
  argumentHint?: string;
  body: string;
  path: string;
  bytes: number;
  source: 'project' | 'user' | 'plugin' | 'org-synced';
  /** Absent only for a pre-snapshot definition that predates DD-1's kind field. */
  kind?: 'skill' | 'workflow' | 'command';
  /** `plugin`-source entries only (DD-1/DD-3). */
  plugin?: SkillDefinitionPlugin;
  contentHash?: string;
}

/**
 * One assistant API response within a turn (consecutive transcript lines of the same response
 * merged). `toolCallNames` / `toolCallSummaries` / `toolCallInputs` / `toolCallIds` are parallel
 * arrays over the named `tool_use` blocks only (DD-5).
 */
export interface AssistantStep {
  contextTokens: number;
  text: string | null;
  stopReason: string | null;
  toolCallNames: string[];
  toolCallSummaries: string[];
  toolCallInputs: Record<string, unknown>[];
  /** `tool_use` block ids (`''` when a block has none); look up in `PromptTurn.allToolCalls`. */
  toolCallIds: string[];
  timestamp: string | null;
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
  assistantSteps: AssistantStep[];
  skills: SkillInvocation[];
  files: FileAccess[];
  images: ImageAccess[];
  subAgents: SubAgentNode[];
  agentActivations: AgentActivation[];
  /**
   * Every tool call of the turn, in call order (stable sort by `startedAt`). The source of the
   * derived sections: `toolCalls` (section `'tool'`), `files` (`'file'`), `skills` (`'skill'`);
   * Agent calls link to `agentActivations` / `subAgents` by `toolUseId` (DD-1a).
   */
  allToolCalls: ToolCallDetail[];
  /** Calls of section `'tool'` only, derived from `allToolCalls` (DD-1a). */
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
  /** Primary model used in the session (from first assistant event with a model field) */
  model?: string;
  /** CLAUDE.md system-context injected by the hook on upload */
  claudeMd?: ClaudeMdContext;
  skillDefinitions?: Map<string, SkillDefinition>;
}

export interface ClaudeMdFile {
  path: string;
  bytes: number;
  role?: 'claude-md' | 'local-md' | 'user-md' | 'rule';
  /** Lowercased attachment `type` (`user` / `project` / `local` / …); absent for snapshot-only files. */
  typeLabel?: string;
  /**
   * Came from a per-turn `nested_memory` injection. Not shown in the UI — only lets Call Tree and
   * Context Usage skip it, since those bytes are already counted per turn via `rulesInjected`.
   */
  onDemand?: boolean;
  lastModified?: number;
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
  /**
   * Repo root for display only (DD-6): the effective root when non-empty, else the first main
   * event's `cwd`. Forward slashes, no trailing slash, `''` when unknown. Path normalisation does
   * not use it.
   */
  repoRoot: string;
  /**
   * Permission events (main log and every sub-agent log) that `attributePermissionEvents` could
   * not join to a tool call (DD-22). Diagnostics only.
   */
  unattributedPermissionEvents: number;
}
