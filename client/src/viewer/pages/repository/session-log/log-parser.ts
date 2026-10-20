import type { RepoConfig } from '../../../../models/repositories';
import type { WorkflowRun } from '../../../../models/workflows';
import type { ModelPricingMap } from '../../../../models/pricing';
import type { HarnessSnapshot } from '../../../api';
import { computeCost, formatLocalTimestamp } from '../../../lib/format';
import type {
  AgentActivation,
  AgentDefinition,
  AssistantEvent,
  ClaudeMdContext,
  CompactBoundary,
  FileAccess,
  FileCategoryStats,
  FileStats,
  ImageAccess,
  ImageStats,
  McpServerConfig,
  ToolCallDetail,
  ParsedSession,
  ProgressAgentEvent,
  PromptTurn,
  RuleInjection,
  SessionSummary,
  SkillDefinition,
  SkillInvocation,
  SubAgentNode,
  SystemCompactBoundaryEvent,
  TelemetryEvent,
  TokenBreakdown,
  TokenUsage,
  UserEvent,
} from './types';

export const BYTES_PER_TOKEN = 3.5;

/**
 * DD-16: `anthropic-skills:*` plugin entries are filtered out of every snapshot-derived
 * `skillDefinitions` map (and so out of `visibleSkills` and the turn-chip resolution) — they are
 * Claude's own bundled skills, not something a System Context viewer needs to inspect.
 */
export const HIDDEN_SKILL_PREFIX = 'anthropic-skills:';

// Resolves the per-model chars-per-token estimation ratio, falling back to
// BYTES_PER_TOKEN when the model is unrecognized/third-party or no pricing
// map was supplied — silent fallback is acceptable (estimation-only figures).
export function resolveCharsPerToken(
  pricing: ModelPricingMap | undefined,
  model: string | null | undefined,
): number {
  return pricing?.[model ?? '']?.charsPerToken ?? BYTES_PER_TOKEN;
}

// ---------------------------------------------------------------------------
// Repo file-category utilities (keep in sync with server normaliseFilePath)
// ---------------------------------------------------------------------------

export const DEFAULT_REPO_CONFIG: RepoConfig = {
  fileCategories: [
    { name: 'knowledgebase', patterns: ['docs/knowledgebase/.*'] },
    { name: 'docs', patterns: ['docs/.*'] },
  ],
};

/**
 * Well-known top-level directory names that appear at the root of any repo
 * using this project's layout. Used as a fallback when repoRoot is unknown.
 */
const KNOWN_TOP_LEVEL_DIRS = [
  'server',
  'client',
  'doc',
  'hook',
  '.claude',
  'tests',
  'dist',
  '.playwright-work-folder',
];

/** Strips repoRoot prefix (case-insensitive), normalises separators, removes leading slash. */
export function normaliseClientPath(
  absolutePath: string,
  repoRoot: string,
): string {
  const abs = absolutePath.replace(/\\/g, '/');
  const root = repoRoot.replace(/\\/g, '/');
  if (root && abs.toLowerCase().startsWith(root.toLowerCase())) {
    return abs.slice(root.length).replace(/^\//, '');
  }
  // Fallback: when repoRoot is unknown, scan for a known top-level directory
  // segment and return from that point onward.
  if (!root) {
    for (const dir of KNOWN_TOP_LEVEL_DIRS) {
      const marker = `/${dir}/`;
      const idx = abs.indexOf(marker);
      if (idx !== -1) {
        return abs.slice(idx + 1); // strip leading '/'
      }
    }
  }
  return abs.replace(/^\//, '');
}

/** Returns the first matching category name or 'code' as fallback. */
export function resolveFileCategory(
  absolutePath: string,
  repoRoot: string,
  config: RepoConfig | null,
): string {
  const relativePath = normaliseClientPath(absolutePath, repoRoot);
  const categories = (config ?? DEFAULT_REPO_CONFIG).fileCategories;
  for (const cat of categories) {
    for (const pattern of cat.patterns) {
      try {
        if (new RegExp(pattern).test(relativePath)) {
          return cat.name;
        }
      } catch {
        // skip malformed pattern
      }
    }
  }
  return 'code';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function summarizeToolCall(
  name: string,
  input: Record<string, unknown>,
): string {
  const s = (v: unknown) => String(v ?? '');
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit': {
      const p = s(input.file_path);
      return p.length > 60 ? '…' + p.slice(-57) : p;
    }
    case 'Bash': {
      const cmd = s(input.command).split('\n')[0];
      return cmd.length > 50 ? cmd.slice(0, 50) + '…' : cmd;
    }
    case 'Glob':
      return s(input.pattern);
    case 'Grep': {
      const pat = s(input.pattern);
      return pat.length > 40 ? pat.slice(0, 40) + '…' : pat;
    }
    case 'Agent': {
      const desc = s(input.description ?? input.prompt);
      return desc.length > 40 ? desc.slice(0, 40) + '…' : desc;
    }
    default:
      return '';
  }
}

function sumCtxTokens(usage: TokenUsage | undefined): number | null {
  if (!usage) return null;
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

function coerceToObject(entry: unknown): Record<string, unknown> | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  return entry as Record<string, unknown>;
}

function buildEventIndex(
  events: TelemetryEvent[],
): Map<string, TelemetryEvent> {
  const map = new Map<string, TelemetryEvent>();
  for (const e of events) {
    if (e.uuid) {
      map.set(e.uuid, e);
    }
  }
  return map;
}

function buildParentChildMap(events: TelemetryEvent[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const e of events) {
    if (!e.uuid || !e.parentUuid) continue;
    const children = map.get(e.parentUuid);
    if (children) {
      children.push(e.uuid);
    } else {
      map.set(e.parentUuid, [e.uuid]);
    }
  }
  return map;
}

function collectTurnUuids(
  startUuid: string,
  map: Map<string, string[]>,
  stopUuids?: Set<string>,
): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [startUuid];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    // Don't traverse into other top-level turns (prevents token accumulation)
    if (current !== startUuid && stopUuids?.has(current)) continue;
    const children = map.get(current);
    if (children) {
      for (const child of children) {
        if (!visited.has(child)) {
          queue.push(child);
        }
      }
    }
  }
  return visited;
}

function isQualifyingUserEvent(e: TelemetryEvent, isSubagent = false): boolean {
  if (e.type !== 'user') return false;
  if (!isSubagent && e.isSidechain === true) return false;
  if (e.isMeta === true) return false;
  const userEvent = e as UserEvent;
  // Sub-agent completion events carry toolUseResult.agentId — not user-typed prompts.
  if (userEvent.toolUseResult?.agentId) return false;
  const content = userEvent.message?.content;
  if (!content || content.length === 0) return false;
  // Slash commands are injected as strings.
  // Two formats exist depending on Claude Code version:
  //   old: starts with <command-name> — always filter (utility commands like /clear)
  //   new: starts with <command-message> — always qualify; this format is emitted for
  //        skill invocations (/task-post-impl-check-kb-actual, etc.) which represent
  //        real user intent regardless of whether command-args are present.
  // Workflow task-completion notifications injected by the harness are also strings
  // but start with <task-notification> — always filter.
  if (typeof content === 'string') {
    const trimmed = content.trimStart();
    if (trimmed.startsWith('<command-name>')) return false;
    if (trimmed.startsWith('<task-notification>')) return false;
    if (trimmed.startsWith('<command-message>')) return true;
    return true;
  }
  return content.some((block) => block.type === 'text');
}

/**
 * Same eligibility checks as `isQualifyingUserEvent` (type/sidechain/meta/agentId/non-empty
 * content), but does NOT filter out `<command-name>`/`<task-notification>`-prefixed string
 * content — those events still mark a turn boundary for work-time purposes even though they
 * don't count as a qualifying "prompt". Without this, an async subagent-completion tail
 * injected as a `<task-notification>` after a turn's real work has finished gets folded into
 * that turn's BFS set (because it isn't in `allQualifyingUuids`), inflating `workTimeMs` with
 * the subagent's completion delay.
 */
function isTurnBoundaryUserEvent(
  e: TelemetryEvent,
  isSubagent = false,
): boolean {
  if (e.type !== 'user') return false;
  if (!isSubagent && e.isSidechain === true) return false;
  if (e.isMeta === true) return false;
  const userEvent = e as UserEvent;
  if (userEvent.toolUseResult?.agentId) return false;
  const content = userEvent.message?.content;
  if (!content || content.length === 0) return false;
  if (typeof content === 'string') return true;
  return content.some((block) => block.type === 'text');
}

/**
 * A directly-activated (non-workflow) agent whose full transcript is available in
 * `subagentLogs` gets its ENTIRE cost priced independently via `computeTurnDirectAgentCost`
 * (client-side, from that full transcript). Its own completion event's inline
 * `toolUseResult.usage` — a subset of that same transcript (typically just the final call) — must
 * therefore be excluded from any "main" token rollup, or it is double-counted: once here, once as
 * part of the complete per-agent total. Workflow agents are exempted: they aren't repriced via
 * `computeTurnDirectAgentCost`, only via the separate (aggregate, rough) workflow-cost estimate, so
 * their inline-usage fold into "main" is intentionally left as the only per-token-type-detail
 * source available for them (see `session-log-view.md`'s token-counting table).
 */
function isAgentUsagePricedElsewhere(
  agentId: string,
  workflowAgentIds: Set<string>,
  subagentLogs: Map<string, Record<string, unknown>[]> | undefined,
): boolean {
  if (workflowAgentIds.has(agentId)) return false;
  return !!subagentLogs?.has(agentId);
}

/**
 * Splits one `usage` object's cache-creation tokens into the 5m / 1h TTL buckets.
 *
 * `usage.cache_creation` is authoritative when present; older transcripts only carry the
 * flat `cache_creation_input_tokens`, and those tokens all go to the 5m bucket. Either
 * way `write5m + write1h === cache_creation_input_tokens`, which is what makes the
 * `TokenBreakdown` invariant hold at every level.
 *
 * Twin of `splitCacheCreationTokens()` in `server/src/logs/claude-extractor.ts` — keep
 * the two in sync.
 */
function splitCacheWrite(u: TokenUsage): { write5m: number; write1h: number } {
  const total = u.cache_creation_input_tokens ?? 0;
  const cc = u.cache_creation;
  if (cc) {
    const write5m = cc.ephemeral_5m_input_tokens ?? 0;
    const write1h = cc.ephemeral_1h_input_tokens ?? 0;
    if (write5m + write1h > 0) return { write5m, write1h };
  }
  return { write5m: total, write1h: 0 };
}

/**
 * Billed web-search requests in one `usage` object. `web_fetch_requests` is not
 * billed and is deliberately ignored.
 */
function webSearchRequestsOf(u: TokenUsage): number {
  return u.server_tool_use?.web_search_requests ?? 0;
}

/**
 * Fast-mode split of one `usage` object's input/output tokens.
 *
 * `usage.speed` applies to the whole response, so a `'fast'` response contributes all of
 * its input/output to the fast buckets and a standard one contributes none. The buckets
 * stay **subsets** of the grand totals, which is what `computeCost`'s surcharge form
 * requires. Twin of the `usage->>'speed'` handling in `server/src/logs/claude-extractor.ts`.
 */
function splitFastTokens(u: TokenUsage): {
  inputFast: number;
  outputFast: number;
} {
  if (u.speed !== 'fast') return { inputFast: 0, outputFast: 0 };
  return {
    inputFast: u.input_tokens ?? 0,
    outputFast: u.output_tokens ?? 0,
  };
}

/** Builds a `TokenBreakdown` from a single raw `usage` object. */
function breakdownFromUsage(u: TokenUsage): TokenBreakdown {
  const { write5m, write1h } = splitCacheWrite(u);
  const fast = splitFastTokens(u);
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheWrite5m: write5m,
    cacheWrite1h: write1h,
    webSearchRequests: webSearchRequestsOf(u),
    inputFast: fast.inputFast,
    outputFast: fast.outputFast,
  };
}

/**
 * Maps each response key (`message.id`, else the line's uuid) to the uuid of its LAST
 * usage-carrying assistant line within `uuidSet` — the line whose usage is counted.
 */
function lastUsageUuidByMessage(
  events: TelemetryEvent[],
  uuidSet: Set<string>,
): Map<string, string> {
  const last = new Map<string, string>();
  for (const e of events) {
    if (e.type !== 'assistant') continue;
    if (!e.uuid || !uuidSet.has(e.uuid)) continue;
    const ae = e as AssistantEvent;
    if (!ae.message?.usage) continue;
    last.set(ae.message.id ?? e.uuid, e.uuid);
  }
  return last;
}

function sumTokenBreakdown(
  events: TelemetryEvent[],
  uuidSet: Set<string>,
  workflowAgentIds: Set<string>,
  subagentLogs: Map<string, Record<string, unknown>[]> | undefined,
): TokenBreakdown | null {
  let contributingCount = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cacheWrite5m = 0;
  let cacheWrite1h = 0;
  let webSearchRequests = 0;
  let inputFast = 0;
  let outputFast = 0;
  // One API response can be split across multiple transcript lines — one per content
  // block (thinking/tool_use/text). Dedupe by message.id (falling back to the line's own
  // uuid when absent, which is unique per line and so never collides) so usage is counted
  // once per response, from its LAST line — a sub-agent's first block line carries a
  // partial mid-stream output_tokens. Matches claude-extractor.ts /
  // repositories.controller.ts.
  const lastUsageUuid = lastUsageUuidByMessage(events, uuidSet);

  for (const e of events) {
    if (!e.uuid || !uuidSet.has(e.uuid)) continue;

    if (e.type === 'assistant') {
      const ae = e as AssistantEvent;
      if (!ae.message?.usage) continue;
      if (lastUsageUuid.get(ae.message.id ?? e.uuid) !== e.uuid) continue;
      const u = ae.message.usage;
      const ttl = splitCacheWrite(u);
      const fast = splitFastTokens(u);
      input += u.input_tokens ?? 0;
      output += u.output_tokens ?? 0;
      cacheRead += u.cache_read_input_tokens ?? 0;
      cacheWrite += u.cache_creation_input_tokens ?? 0;
      cacheWrite5m += ttl.write5m;
      cacheWrite1h += ttl.write1h;
      webSearchRequests += webSearchRequestsOf(u);
      inputFast += fast.inputFast;
      outputFast += fast.outputFast;
      contributingCount++;
    } else if (e.type === 'user') {
      const ue = e as UserEvent;
      if (!ue.toolUseResult?.agentId || !ue.toolUseResult.usage) continue;
      if (
        isAgentUsagePricedElsewhere(
          ue.toolUseResult.agentId,
          workflowAgentIds,
          subagentLogs,
        )
      )
        continue;
      const u = ue.toolUseResult.usage;
      const ttl = splitCacheWrite(u);
      const fast = splitFastTokens(u);
      input += u.input_tokens ?? 0;
      output += u.output_tokens ?? 0;
      cacheRead += u.cache_read_input_tokens ?? 0;
      cacheWrite += u.cache_creation_input_tokens ?? 0;
      cacheWrite5m += ttl.write5m;
      cacheWrite1h += ttl.write1h;
      webSearchRequests += webSearchRequestsOf(u);
      inputFast += fast.inputFast;
      outputFast += fast.outputFast;
      contributingCount++;
    }
  }

  return contributingCount > 0
    ? {
        input,
        output,
        cacheRead,
        cacheWrite,
        cacheWrite5m,
        cacheWrite1h,
        webSearchRequests,
        inputFast,
        outputFast,
      }
    : null;
}

/**
 * Like {@link sumTokenBreakdown}, but sums **only** this turn's own `assistant` events.
 *
 * It deliberately omits both folds that `sumTokenBreakdown` performs — the sub-agent
 * `toolUseResult.usage` fold and (at the call site) the workflow `session_stats` fold —
 * so the result describes the main thread's own cache traffic. That is what the per-turn
 * cache read ratio needs: a turn that delegated everything to sub-agents has no cache
 * traffic of its own and must read `n/a`, not the children's blended ratio.
 */
function sumOwnAssistantTokenBreakdown(
  events: TelemetryEvent[],
  uuidSet: Set<string>,
): TokenBreakdown | null {
  let contributingCount = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cacheWrite5m = 0;
  let cacheWrite1h = 0;
  let webSearchRequests = 0;
  let inputFast = 0;
  let outputFast = 0;
  // Same last-line-per-message.id dedupe as sumTokenBreakdown.
  const lastUsageUuid = lastUsageUuidByMessage(events, uuidSet);

  for (const e of events) {
    if (e.type !== 'assistant') continue;
    if (!e.uuid || !uuidSet.has(e.uuid)) continue;
    const ae = e as AssistantEvent;
    if (!ae.message?.usage) continue;
    if (lastUsageUuid.get(ae.message.id ?? e.uuid) !== e.uuid) continue;
    const u = ae.message.usage;
    const ttl = splitCacheWrite(u);
    const fast = splitFastTokens(u);
    input += u.input_tokens ?? 0;
    output += u.output_tokens ?? 0;
    cacheRead += u.cache_read_input_tokens ?? 0;
    cacheWrite += u.cache_creation_input_tokens ?? 0;
    cacheWrite5m += ttl.write5m;
    cacheWrite1h += ttl.write1h;
    webSearchRequests += webSearchRequestsOf(u);
    inputFast += fast.inputFast;
    outputFast += fast.outputFast;
    contributingCount++;
  }

  return contributingCount > 0
    ? {
        input,
        output,
        cacheRead,
        cacheWrite,
        cacheWrite5m,
        cacheWrite1h,
        webSearchRequests,
        inputFast,
        outputFast,
      }
    : null;
}

function extractToolCallsInTurn(
  events: TelemetryEvent[],
  uuidSet: Set<string>,
): Array<{
  id: string;
  name: string;
  input: Record<string, unknown>;
  timestamp?: string;
}> {
  const calls: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    timestamp?: string;
  }> = [];

  for (const e of events) {
    if (e.type !== 'assistant') continue;
    if (!e.uuid || !uuidSet.has(e.uuid)) continue;
    const ae = e as AssistantEvent;
    if (!ae.message?.content) continue;
    for (const block of ae.message.content) {
      if (block.type === 'tool_use' && block.id && block.name && block.input) {
        calls.push({
          id: block.id,
          name: block.name,
          input: block.input,
          timestamp: ae.timestamp,
        });
      }
    }
  }

  return calls;
}

function extractToolResultContent(
  events: TelemetryEvent[],
  toolCallId: string,
): { content: string; isBinary: boolean; isError: boolean; found: boolean } {
  for (const e of events) {
    if (e.type !== 'user') continue;
    const ue = e as UserEvent;
    const content = ue.message?.content;
    if (!content || typeof content === 'string') continue;
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      if (block.tool_use_id !== toolCallId) continue;
      const isError = block.is_error === true;
      const c = block.content;
      if (typeof c === 'string') {
        const isBin = c.startsWith('data:') || c.includes('\0');
        if (isBin) {
          const bytes = Math.floor((c.length * 3) / 4);
          return {
            content: `[binary data, ${bytes} bytes]`,
            isBinary: true,
            isError,
            found: true,
          };
        }
        return { content: c, isBinary: false, isError, found: true };
      }
      if (Array.isArray(c)) {
        let text = '';
        let hasBin = false;
        for (const item of c) {
          const it = item as { type?: string; text?: string; data?: string };
          if (it.type === 'text') {
            text += (text ? '\n' : '') + (it.text ?? '');
          } else {
            hasBin = true;
            const bytes = it.data ? Math.floor((it.data.length * 3) / 4) : 0;
            text += (text ? '\n' : '') + `[binary data, ${bytes} bytes]`;
          }
        }
        return { content: text, isBinary: hasBin, isError, found: true };
      }
      return { content: '', isBinary: false, isError, found: true };
    }
  }
  return { content: '', isBinary: false, isError: false, found: false };
}

function buildToolCallDetails(
  events: TelemetryEvent[],
  rawCalls: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    timestamp?: string;
  }>,
  permReqs: Array<{ toolName: string; ts: number }>,
  permDenials: Array<{ toolName: string; ts: number }>,
): ToolCallDetail[] {
  const SKIP = new Set([
    'Skill',
    'Agent',
    'Read',
    'Edit',
    'Write',
    'MultiEdit',
    'Glob',
  ]);
  const filtered = rawCalls.filter((c) => !SKIP.has(c.name));

  filtered.sort((a, b) => {
    if (!a.timestamp && !b.timestamp) return 0;
    if (!a.timestamp) return 1;
    if (!b.timestamp) return -1;
    return a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0;
  });

  const unusedReqs = [...permReqs];
  const unusedDenials = [...permDenials];

  return filtered.map((call) => {
    const { content, isError, found } = extractToolResultContent(
      events,
      call.id,
    );
    const status: 'success' | 'error' = !found || isError ? 'error' : 'success';

    const denialIdx = unusedDenials.findIndex((d) => d.toolName === call.name);
    let permissionDenied: true | undefined;
    if (denialIdx !== -1) {
      permissionDenied = true;
      unusedDenials.splice(denialIdx, 1);
    }

    const reqIdx = unusedReqs.findIndex((r) => r.toolName === call.name);
    let permissionRequested: true | undefined;
    if (reqIdx !== -1) {
      permissionRequested = true;
      unusedReqs.splice(reqIdx, 1);
    }

    return {
      id: call.id,
      name: call.name,
      input: call.input,
      ...(found && content ? { result: content } : {}),
      status,
      ...(permissionDenied ? { permissionDenied } : {}),
      ...(permissionRequested && !permissionDenied
        ? { permissionRequested }
        : {}),
    };
  });
}

function extractArtisynPermissionEvents(
  events: TelemetryEvent[],
  windowStart: number,
  windowEnd: number,
): {
  permReqs: Array<{ toolName: string; ts: number }>;
  permDenials: Array<{ toolName: string; ts: number }>;
} {
  const permReqs: Array<{ toolName: string; ts: number }> = [];
  const permDenials: Array<{ toolName: string; ts: number }> = [];
  const WIN_START = windowStart - 5000;
  const WIN_END = windowEnd + 5000;

  for (const e of events) {
    if (e.type !== 'artisyn') continue;
    const ae = e as {
      type: string;
      hook_event_name?: string;
      tool_name?: string;
      timestamp?: string;
    };
    if (!ae.hook_event_name || !ae.timestamp) continue;
    const ts = Date.parse(ae.timestamp);
    if (Number.isNaN(ts) || ts < WIN_START || ts > WIN_END) continue;
    if (ae.hook_event_name === 'PermissionRequest') {
      permReqs.push({ toolName: ae.tool_name ?? '', ts });
    } else if (ae.hook_event_name === 'PermissionDenied') {
      permDenials.push({ toolName: ae.tool_name ?? '', ts });
    }
  }

  permReqs.sort((a, b) => a.ts - b.ts);
  permDenials.sort((a, b) => a.ts - b.ts);

  return { permReqs, permDenials };
}

function extractFilePathFromToolCall(
  name: 'Read' | 'Edit' | 'Write' | 'MultiEdit' | 'Glob',
  input: Record<string, unknown>,
): string {
  if (name === 'Glob') {
    return (input.pattern as string) ?? '';
  }
  return (input.file_path as string) ?? '';
}

function extractGlobCount(
  events: TelemetryEvent[],
  toolCallId: string,
): number | undefined {
  for (const e of events) {
    if (e.type !== 'user') continue;
    const ue = e as UserEvent;
    const content = ue.message?.content;
    if (!content || typeof content === 'string') continue;
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      if (block.tool_use_id !== toolCallId) continue;
      try {
        const parsed: unknown = JSON.parse(block.content as string);
        if (Array.isArray(parsed)) {
          return parsed.length;
        }
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function parsePngDimensions(
  base64: string,
): { width: number; height: number } | null {
  try {
    // PNG: 8-byte signature + IHDR chunk (4 len + 4 type + 4 width + 4 height)
    // First 24 bytes = 32 base64 chars
    const header = atob(base64.slice(0, 32));
    // PNG signature: bytes 1-3 are 'P','N','G'
    if (
      header.charCodeAt(1) !== 80 ||
      header.charCodeAt(2) !== 78 ||
      header.charCodeAt(3) !== 71
    )
      return null;
    const width =
      ((header.charCodeAt(16) << 24) |
        (header.charCodeAt(17) << 16) |
        (header.charCodeAt(18) << 8) |
        header.charCodeAt(19)) >>>
      0;
    const height =
      ((header.charCodeAt(20) << 24) |
        (header.charCodeAt(21) << 16) |
        (header.charCodeAt(22) << 8) |
        header.charCodeAt(23)) >>>
      0;
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

function estimateImageInputTokens(width: number, height: number): number {
  // Scale to fit within 1568×1568 (Claude's max image dimension)
  let w = width;
  let h = height;
  const maxEdge = Math.max(w, h);
  if (maxEdge > 1568) {
    const scale = 1568 / maxEdge;
    w = Math.floor(w * scale);
    h = Math.floor(h * scale);
  }
  // Approximate Claude vision token formula: pixel_area / 750 + base
  return Math.round((w * h) / 750 + 1024);
}

function extractImagesInTurn(
  events: TelemetryEvent[],
  uuidSet: Set<string>,
  toolCalls: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>,
): ImageAccess[] {
  const toolIdToName = new Map<string, string>();
  for (const call of toolCalls) {
    toolIdToName.set(call.id, call.name);
  }

  const images: ImageAccess[] = [];
  for (const e of events) {
    if (e.type !== 'user') continue;
    if (!e.uuid || !uuidSet.has(e.uuid)) continue;
    const ue = e as UserEvent;
    const content = ue.message?.content;
    if (!content || typeof content === 'string') continue;
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const c = block.content;
      if (!Array.isArray(c)) continue;
      const toolName = block.tool_use_id
        ? (toolIdToName.get(block.tool_use_id) ?? '')
        : '';
      for (const item of c) {
        const imgBlock = item as {
          type?: string;
          source?: { type?: string; media_type?: string; data?: string };
        };
        if (imgBlock.type !== 'image') continue;
        if (imgBlock.source?.type !== 'base64') continue;
        const base64 = imgBlock.source.data ?? '';
        const mediaType = imgBlock.source.media_type ?? 'image/png';
        const bytes = Math.floor((base64.length * 3) / 4);
        const dims =
          mediaType === 'image/png' ? parsePngDimensions(base64) : null;
        const estInputTokens =
          dims !== null
            ? estimateImageInputTokens(dims.width, dims.height)
            : undefined;
        images.push({
          toolName,
          mediaType,
          bytes,
          ...(dims ?? {}),
          ...(estInputTokens !== undefined ? { estInputTokens } : {}),
        });
      }
    }
  }
  return images;
}

function extractToolResultBytes(
  events: TelemetryEvent[],
  toolCallId: string,
): number | undefined {
  for (const e of events) {
    if (e.type !== 'user') continue;
    const ue = e as UserEvent;
    const content = ue.message?.content;
    if (!content || typeof content === 'string') continue;
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      if (block.tool_use_id !== toolCallId) continue;
      const c = block.content;
      if (typeof c === 'string') return c.length;
      if (Array.isArray(c)) {
        return c.reduce(
          (sum, b) =>
            sum +
            (typeof (b as { text?: unknown }).text === 'string'
              ? (b as { text: string }).text.length
              : 0),
          0,
        );
      }
    }
  }
  return undefined;
}

// Skills inject their content as a child isMeta=true user event following the tool_result.
// The tool_result itself only contains "Launching skill: X" — we need the child event.
function extractSkillContentBytes(
  toolCallId: string,
  events: TelemetryEvent[],
  parentChildMap: Map<string, string[]>,
  eventIndex: Map<string, TelemetryEvent>,
): number | undefined {
  // Step 1: find the UUID of the user event that holds this tool_result
  let toolResultUuid: string | undefined;
  for (const e of events) {
    if (e.type !== 'user') continue;
    const ue = e as UserEvent;
    const content = ue.message?.content;
    if (!content || typeof content === 'string') continue;
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id === toolCallId) {
        toolResultUuid = ue.uuid;
        break;
      }
    }
    if (toolResultUuid) break;
  }
  if (!toolResultUuid) return undefined;

  // Step 2: walk immediate children looking for isMeta user events with text content
  const children = parentChildMap.get(toolResultUuid) ?? [];
  let totalBytes = 0;
  for (const childUuid of children) {
    const child = eventIndex.get(childUuid);
    if (!child || child.type !== 'user') continue;
    const ue = child as UserEvent;
    if (ue.isMeta !== true) continue;
    const content = ue.message?.content;
    if (!content) continue;
    const encoder = new TextEncoder();
    if (typeof content === 'string') {
      totalBytes += encoder.encode(content).length;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          totalBytes += encoder.encode(block.text).length;
        }
      }
    }
  }
  return totalBytes > 0 ? totalBytes : undefined;
}

function normalizeRuleName(displayPath: string): string {
  const normalized = displayPath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return displayPath;
  const filename = parts[parts.length - 1].replace(/\.md$/i, '');
  // For CLAUDE.md-style files, use the parent directory as the label
  if (filename.toUpperCase() === 'CLAUDE' && parts.length > 1) {
    return parts[parts.length - 2];
  }
  return filename;
}

function extractRulesInjected(
  events: TelemetryEvent[],
  uuidSet: Set<string>,
  charsPerToken: number,
): RuleInjection[] {
  const seen = new Set<string>();
  const result: RuleInjection[] = [];
  for (const e of events) {
    if (!e.uuid || !uuidSet.has(e.uuid)) continue;
    if (e.type !== 'attachment') continue;
    const ae = e as {
      type: string;
      uuid?: string;
      attachment?: {
        type?: string;
        path?: string;
        displayPath?: string;
        content?: { content?: string };
      };
    };
    if (ae.attachment?.type !== 'nested_memory') continue;
    const raw = ae.attachment.displayPath ?? ae.attachment.path ?? '';
    const label = normalizeRuleName(raw);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    const text = ae.attachment.content?.content ?? '';
    const bytes = text ? new TextEncoder().encode(text).length : undefined;
    result.push({
      name: label,
      ...(raw && { path: raw }),
      ...(bytes !== undefined &&
        bytes > 0 && {
          bytes,
          estTokens: Math.round(bytes / charsPerToken),
        }),
    });
  }
  return result;
}

function extractAgentActivations(
  events: TelemetryEvent[],
  uuidSet: Set<string>,
): AgentActivation[] {
  // Collect Agent tool_use ids + description from assistant events in this turn
  const agentCallInfo = new Map<string, { description?: string }>();
  for (const e of events) {
    if (e.type !== 'assistant' || !e.uuid || !uuidSet.has(e.uuid)) continue;
    const ae = e as AssistantEvent;
    if (!ae.message?.content || typeof ae.message.content === 'string')
      continue;
    for (const block of ae.message.content) {
      if (block.type === 'tool_use' && block.name === 'Agent' && block.id) {
        agentCallInfo.set(block.id, {
          description: block.input?.description as string | undefined,
        });
      }
    }
  }

  if (agentCallInfo.size === 0) return [];

  const activations: AgentActivation[] = [];
  for (const e of events) {
    if (e.type !== 'user' || !e.uuid || !uuidSet.has(e.uuid)) continue;
    const ue = e as UserEvent;
    if (!ue.toolUseResult?.agentId) continue;

    // Match to an Agent tool_use in this turn via tool_result content block
    let toolUseId: string | undefined;
    const msgContent = ue.message?.content;
    if (Array.isArray(msgContent)) {
      for (const block of msgContent) {
        if (
          block.type === 'tool_result' &&
          block.tool_use_id &&
          agentCallInfo.has(block.tool_use_id)
        ) {
          toolUseId = block.tool_use_id;
          break;
        }
      }
    }
    if (!toolUseId) continue;

    const info = agentCallInfo.get(toolUseId);
    const result = ue.toolUseResult as UserEvent['toolUseResult'] & {
      prompt?: string;
      content?: Array<{ type: string; text?: string }>;
    };
    const u = result?.usage;
    const tokens: TokenBreakdown | undefined = u
      ? breakdownFromUsage(u)
      : undefined;
    const resultText = result?.content?.find((c) => c.type === 'text')?.text;

    // Real timing: the completion event timestamp is the agent END; subtracting
    // the reported duration yields the START. These drive step ordering and
    // sequential-vs-parallel detection in the charts.
    const durationMs = result?.totalDurationMs;
    const endParsed =
      typeof ue.timestamp === 'string' ? Date.parse(ue.timestamp) : NaN;
    const endMs = !Number.isNaN(endParsed) ? endParsed : undefined;
    const startMs =
      endMs !== undefined && durationMs !== undefined
        ? endMs - durationMs
        : undefined;

    activations.push({
      agentId: result?.agentId ?? '',
      ...(info?.description !== undefined && { description: info.description }),
      prompt: result?.prompt ?? '',
      ...(resultText !== undefined && { resultText }),
      ...(tokens !== undefined && { tokens }),
      ...(result?.totalTokens !== undefined && {
        totalTokens: result.totalTokens,
      }),
      ...(durationMs !== undefined && { durationMs }),
      ...(endMs !== undefined && { endMs }),
      ...(startMs !== undefined && { startMs }),
    });
  }

  return activations;
}

function buildSubAgentTree(
  progressEvents: ProgressAgentEvent[],
  completionMap: Map<string, UserEvent>,
  eventIndex: Map<string, TelemetryEvent>,
  subagentStats?: Record<string, SubagentStatEntry>,
): SubAgentNode[] {
  // Group progress events by agentId
  const grouped = new Map<string, ProgressAgentEvent[]>();
  for (const pe of progressEvents) {
    const agentId = pe.data.agentId;
    const group = grouped.get(agentId);
    if (group) {
      group.push(pe);
    } else {
      grouped.set(agentId, [pe]);
    }
  }

  // Build node map: only include agents that have at least one event with a non-empty prompt
  const nodeMap = new Map<string, SubAgentNode>();
  const representativeEvent = new Map<string, ProgressAgentEvent>();

  for (const [agentId, events] of grouped) {
    const representative = events.find(
      (pe) => pe.data.prompt && pe.data.prompt.trim() !== '',
    );
    if (!representative) continue;

    representativeEvent.set(agentId, representative);

    // Find model from first event with data.message.type === 'assistant'
    const modelEvent = events.find(
      (pe) => pe.data.message?.type === 'assistant',
    );
    const model = modelEvent?.data.message?.message?.model;

    // Attach tokens and durationMs from completionMap
    const completion = completionMap.get(agentId);
    let tokens: TokenBreakdown | undefined;
    let durationMs: number | undefined;
    if (completion?.toolUseResult?.usage) {
      tokens = breakdownFromUsage(completion.toolUseResult.usage);
    }
    // Fallback: Workflow agents don't embed usage in toolUseResult; use session_stats.
    if (!tokens && subagentStats) {
      const stats = subagentStats[`agent-${agentId}`];
      if (stats) {
        tokens = {
          input: stats.inputTokens,
          output: stats.outputTokens,
          cacheRead: stats.cacheReadTokens,
          cacheWrite: stats.cacheWriteTokens,
          // session_stats carries no TTL split here, so all of it goes to the 5m
          // bucket — keeps cacheWrite5m + cacheWrite1h === cacheWrite.
          cacheWrite5m: stats.cacheWriteTokens,
          cacheWrite1h: 0,
          // Web-search / fast-mode figures come straight from session_stats; a server that predates them
          // (or a fixture that omits them) simply contributes no surcharge / search cost.
          webSearchRequests: stats.webSearchRequests ?? 0,
          inputFast: stats.inputTokensFast ?? 0,
          outputFast: stats.outputTokensFast ?? 0,
        };
      }
    }
    if (completion?.toolUseResult?.totalDurationMs !== undefined) {
      durationMs = completion.toolUseResult.totalDurationMs;
    }

    const node: SubAgentNode = {
      agentId,
      prompt: representative.data.prompt!,
      ...(model !== undefined && { model }),
      ...(tokens !== undefined && { tokens }),
      ...(durationMs !== undefined && { durationMs }),
      ...(representative.toolUseID !== undefined && {
        toolUseID: representative.toolUseID,
      }),
      ...(representative.parentToolUseID !== undefined && {
        parentToolUseID: representative.parentToolUseID,
      }),
      children: [],
    };

    nodeMap.set(agentId, node);
  }

  // Determine parent-child relationships
  const childOf = new Map<string, string>(); // childAgentId -> parentAgentId

  // Build toolUseID -> agentId map for primary nesting
  const toolUseIdToAgentId = new Map<string, string>();
  for (const [agentId, node] of nodeMap) {
    if (node.toolUseID) {
      toolUseIdToAgentId.set(node.toolUseID, agentId);
    }
  }

  for (const [agentId, node] of nodeMap) {
    // Primary: parentToolUseID matches another agent's toolUseID
    if (node.parentToolUseID) {
      const parentAgentId = toolUseIdToAgentId.get(node.parentToolUseID);
      if (
        parentAgentId &&
        parentAgentId !== agentId &&
        nodeMap.has(parentAgentId)
      ) {
        childOf.set(agentId, parentAgentId);
        continue;
      }
    }

    // Fallback: trace parentUuid chain upward
    const repEvent = representativeEvent.get(agentId);
    if (!repEvent) continue;

    let currentUuid = repEvent.parentUuid;
    while (currentUuid) {
      const ancestor = eventIndex.get(currentUuid);
      if (!ancestor) break;

      // Check if this ancestor is an agent_progress event for a different agentId
      if (ancestor.type === 'progress') {
        const ancPe = ancestor as ProgressAgentEvent;
        if (
          ancPe.data?.type === 'agent_progress' &&
          ancPe.data.agentId !== agentId &&
          nodeMap.has(ancPe.data.agentId)
        ) {
          childOf.set(agentId, ancPe.data.agentId);
          break;
        }
      }

      currentUuid = ancestor.parentUuid;
    }
  }

  // Attach children to parents
  for (const [agentId, parentAgentId] of childOf) {
    const parent = nodeMap.get(parentAgentId);
    const child = nodeMap.get(agentId);
    if (parent && child) {
      parent.children.push(child);
    }
  }

  // Return only root-level nodes
  const roots: SubAgentNode[] = [];
  for (const agentId of nodeMap.keys()) {
    if (!childOf.has(agentId)) {
      roots.push(nodeMap.get(agentId)!);
    }
  }

  return roots;
}

// ---------------------------------------------------------------------------
// Lightweight token extraction for sub-agent logs (no full turn parsing)
// ---------------------------------------------------------------------------

export function extractSubagentStats(logs: Record<string, unknown>[]): {
  model: string | null;
  tokens: TokenBreakdown;
} {
  let model: string | null = null;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cacheWrite5m = 0;
  let cacheWrite1h = 0;
  let webSearchRequests = 0;
  let inputFast = 0;
  let outputFast = 0;

  for (const rec of logs) {
    if (rec['type'] !== 'assistant') continue;
    const msg = rec['message'] as
      | { usage?: TokenUsage; model?: string }
      | undefined;
    if (!msg) continue;
    if (model === null && typeof msg.model === 'string')
      model = msg.model.replace(/-\d{8}$/, '');
    const u = msg.usage;
    if (u) {
      const ttl = splitCacheWrite(u);
      const fast = splitFastTokens(u);
      input += u.input_tokens ?? 0;
      output += u.output_tokens ?? 0;
      cacheRead += u.cache_read_input_tokens ?? 0;
      cacheWrite += u.cache_creation_input_tokens ?? 0;
      cacheWrite5m += ttl.write5m;
      cacheWrite1h += ttl.write1h;
      webSearchRequests += webSearchRequestsOf(u);
      inputFast += fast.inputFast;
      outputFast += fast.outputFast;
    }
  }

  return {
    model,
    tokens: {
      input,
      output,
      cacheRead,
      cacheWrite,
      cacheWrite5m,
      cacheWrite1h,
      webSearchRequests,
      inputFast,
      outputFast,
    },
  };
}

/**
 * Finds the text of the first qualifying `user` prompt inside a single agent's own raw transcript
 * (`subagentLogsMap`'s per-agent log array). Workflow-spawned agents have no `Task`/`Agent`
 * tool_use in the ROOT session's transcript (they're launched by the harness, not by a tool call),
 * so `extractAgentActivations`/`buildSubAgentTree`'s `Agent` tool_use → prompt matching can never
 * find a prompt for them — this instead reads the prompt straight out of the agent's own log, the
 * same way `extractSubagentStats` reads tokens/model from it.
 */
function firstUserPromptText(logs: Record<string, unknown>[]): string {
  for (const rec of logs) {
    if (rec['type'] !== 'user') continue;
    if (rec['isMeta'] === true) continue;
    const toolUseResult = rec['toolUseResult'] as
      | { agentId?: string }
      | undefined;
    if (toolUseResult?.agentId) continue; // sub-agent completion event, not a prompt
    const message = rec['message'] as { content?: unknown } | undefined;
    const content = message?.content;
    if (!content) continue;
    if (typeof content === 'string') {
      const trimmed = content.trimStart();
      if (trimmed.startsWith('<command-name>')) continue;
      if (trimmed.startsWith('<task-notification>')) continue;
      return content;
    }
    if (Array.isArray(content)) {
      const textParts = content
        .filter(
          (block): block is { type: string; text: string } =>
            (block as { type?: string }).type === 'text' &&
            typeof (block as { text?: unknown }).text === 'string',
        )
        .map((block) => block.text);
      if (textParts.length > 0) return textParts.join('\n\n');
    }
  }
  return '';
}

/**
 * Builds a `SubAgentNode[]` forest restricted to exactly the given `agentIds` (bare ids, no
 * "agent-" prefix) — used to render `WorkflowRun.agentSessionIds` in the Logs tab, where there is
 * no `agent_progress`/`Agent` tool_use tree to walk (see `firstUserPromptText` doc above).
 *
 * Roots are ids whose parent (per `agentParentMap`) is either absent or falls OUTSIDE the given
 * `agentIds` set — i.e. nesting is resolved only among the ids explicitly passed in, never
 * escaping to unrelated agents that happen to share a parent chain.
 *
 * Per-agent prompt comes from `firstUserPromptText` on that agent's own log
 * (`subagentLogsMap.get(agentId)`); tokens/model come from `extractSubagentStats` on the same log,
 * falling back to `subagentStats['agent-'+agentId]` (the `session_stats`-derived totals) when the
 * transcript itself carries no usage. An id with no entry in `subagentLogsMap` is skipped — it
 * cannot be rendered without a transcript to source a prompt from.
 */
export function buildAgentNodesForIds(
  agentIds: string[],
  agentParentMap: Map<string, string | null>,
  subagentLogsMap: Map<string, Record<string, unknown>[]>,
  subagentStats?: Record<string, SubagentStatEntry>,
  pricing?: ModelPricingMap,
): SubAgentNode[] {
  const idSet = new Set(agentIds);
  const nodeMap = new Map<string, SubAgentNode>();

  for (const agentId of agentIds) {
    if (nodeMap.has(agentId)) continue; // guard against duplicate ids in the input list
    const logs = subagentLogsMap.get(agentId);
    if (!logs) continue;

    const prompt = firstUserPromptText(logs);
    const { model, tokens: ownTokens } = extractSubagentStats(logs);
    const hasOwnTokens =
      ownTokens.input > 0 ||
      ownTokens.output > 0 ||
      ownTokens.cacheRead > 0 ||
      ownTokens.cacheWrite > 0;

    let tokens: TokenBreakdown | undefined = hasOwnTokens
      ? ownTokens
      : undefined;
    if (!tokens && subagentStats) {
      const fallback = subagentStats[`agent-${agentId}`];
      if (fallback) {
        tokens = {
          input: fallback.inputTokens,
          output: fallback.outputTokens,
          cacheRead: fallback.cacheReadTokens,
          cacheWrite: fallback.cacheWriteTokens,
          // No TTL split in session_stats here — all to the 5m bucket (see above).
          cacheWrite5m: fallback.cacheWriteTokens,
          cacheWrite1h: 0,
          // Web-search / fast-mode figures from session_stats; absent -> no surcharge / no search cost.
          webSearchRequests: fallback.webSearchRequests ?? 0,
          inputFast: fallback.inputTokensFast ?? 0,
          outputFast: fallback.outputTokensFast ?? 0,
        };
      }
    }

    // Aggregate tool calls + files touched across the agent's own full transcript (all its own
    // turns), so the Logs tab drill-down can show "tool calls and files touched" the same way it
    // does for the root session's own turns — a workflow agent has no `Task` tool_use of its own
    // to hang this off of, so it's sourced from the agent's own parsed session instead.
    const parsed = parseSessionLogs(logs, { isSubagent: true, pricing });
    const toolCalls = parsed.turns.flatMap((t) => t.toolCalls);
    const files = parsed.turns.flatMap((t) => t.files);
    // The same per-turn block already extracts these two; they were simply never carried
    // onto the node, which is why a workflow agent's skill loads were invisible in the Logs tab.
    const skills = parsed.turns.flatMap((t) => t.skills);
    const rulesInjected = parsed.turns.flatMap((t) => t.rulesInjected);

    nodeMap.set(agentId, {
      agentId,
      prompt,
      ...(model !== null ? { model } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(files.length > 0 ? { files } : {}),
      ...(skills.length > 0 ? { skills } : {}),
      ...(rulesInjected.length > 0 ? { rulesInjected } : {}),
      children: [],
    });
  }

  const roots: SubAgentNode[] = [];
  for (const agentId of agentIds) {
    const node = nodeMap.get(agentId);
    if (!node) continue;
    const parentId = agentParentMap.get(agentId);
    const parentNode =
      parentId && idSet.has(parentId) ? nodeMap.get(parentId) : undefined;
    if (parentNode) {
      parentNode.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

/**
 * Finds every direct child agentId spawned (via an "Agent" tool_use) within a single sub-agent's
 * own raw event array. Mirrors the tool_use-id / toolUseResult.agentId matching that
 * extractAgentActivations uses for the root session's own turns, but scans the WHOLE log with no
 * per-turn uuid scoping — a sub-agent's own transcript is one continuous execution, not split
 * into turns.
 *
 * This is the mechanism that actually works on real persisted data: confirmed during the sub-agent nesting
 * investigation that a real sub-agent's own saved .jsonl contains `assistant` events with "Agent"
 * tool_use blocks and `user` events with matching `toolUseResult.agentId` completions, but ZERO
 * `type: "progress"` (`agent_progress`) entries — those streaming events are not reliably
 * persisted into a sub-agent's own transcript file, so `buildSubAgentTree`'s agent_progress-based
 * tree cannot discover nesting beyond what the root's own transcript happens to show.
 */
function findDirectChildAgentIds(logs: Record<string, unknown>[]): string[] {
  const agentToolUseIds = new Set<string>();
  for (const rec of logs) {
    if (rec['type'] !== 'assistant') continue;
    const content = (rec['message'] as { content?: unknown } | undefined)
      ?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: string; name?: string; id?: string };
      if (b.type === 'tool_use' && b.name === 'Agent' && b.id) {
        agentToolUseIds.add(b.id);
      }
    }
  }
  if (agentToolUseIds.size === 0) return [];

  const childIds: string[] = [];
  for (const rec of logs) {
    if (rec['type'] !== 'user') continue;
    const toolUseResult = rec['toolUseResult'] as
      | { agentId?: string }
      | undefined;
    if (!toolUseResult?.agentId) continue;
    const content = (rec['message'] as { content?: unknown } | undefined)
      ?.content;
    if (!Array.isArray(content)) continue;
    const matched = content.some((block) => {
      const b = block as { type?: string; tool_use_id?: string };
      return (
        b.type === 'tool_result' &&
        !!b.tool_use_id &&
        agentToolUseIds.has(b.tool_use_id)
      );
    });
    if (matched) childIds.push(toolUseResult.agentId);
  }
  return childIds;
}

/**
 * Recursively collects every descendant agentId of the given root agentId (NOT including the
 * root itself), by walking each agent's own transcript (from `subagentLogs`) for further "Agent"
 * tool_use + completion pairs.
 *
 * LIMITATION (found via manual Playwright verification against real historical data): this only
 * finds descendants whose completion event (`toolUseResult.agentId`) was actually written back
 * into the PARENT's own transcript. For a background-launched agent (Claude Code's default),
 * that completion can arrive asynchronously; if the parent's own session/turn already ended by
 * the time a grandchild finishes, the parent's transcript never receives it — real data showed a
 * parent agent with 8 real "Agent" tool_use calls but ZERO matching completions in its own log.
 * This function is therefore kept only as a defensive secondary source (unioned in
 * `PromptTurnItem`); the authoritative source is `collectDescendantAgentIdsFromParentMap` below,
 * which uses the DB's `sessions.parent_session_id` (via the `/logs` endpoint's per-subagent
 * `parentSessionId` field) instead of trying to reconstruct linkage from transcript content.
 */
export function collectDescendantAgentIds(
  rootAgentId: string,
  subagentLogs: Map<string, Record<string, unknown>[]>,
): string[] {
  const visited = new Set<string>([rootAgentId]);
  const queue: string[] = [rootAgentId];
  const descendants: string[] = [];

  while (queue.length > 0) {
    const agentId = queue.shift()!;
    const ownLog = subagentLogs.get(agentId);
    if (!ownLog) continue;
    for (const childId of findDirectChildAgentIds(ownLog)) {
      if (visited.has(childId)) continue;
      visited.add(childId);
      descendants.push(childId);
      queue.push(childId);
    }
  }

  return descendants;
}

/** Minimal shape needed from a fetched sub-agent entry to build the parent map below. */
export interface SubagentParentSource {
  sessionId: string;
  parentSessionId: string | null;
}

/** Strips a leading "agent-" prefix if present, otherwise returns the id unchanged. */
export function stripAgentPrefix(id: string): string {
  return id.startsWith('agent-') ? id.slice('agent-'.length) : id;
}

/**
 * Builds the authoritative `agentId -> parentAgentId` map from the server's per-subagent
 * `parentSessionId` field (`sessions.parent_session_id`), stripping any "agent-" prefix from
 * both sides so keys/values match `subagentLogsMap`/`turn.agentActivations[].agentId` keying.
 * `parentSessionId` is `null` for a depth-1 agent (or one whose parent row predates parent
 * linkage). Shared by every call site that previously duplicated this inline (SessionLogView,
 * useRepositoryData, CallTreeView).
 */
export function buildAgentParentMap(
  subagents: SubagentParentSource[],
): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const sa of subagents) {
    map.set(
      stripAgentPrefix(sa.sessionId),
      sa.parentSessionId != null ? stripAgentPrefix(sa.parentSessionId) : null,
    );
  }
  return map;
}

/** Inverts an `agentId -> parentAgentId` map into `parentAgentId -> childAgentId[]`. */
export function buildChildrenByParentMap(
  agentParentMap: Map<string, string | null>,
): Map<string, string[]> {
  const childrenByParent = new Map<string, string[]>();
  for (const [childId, parentId] of agentParentMap) {
    if (!parentId) continue;
    const siblings = childrenByParent.get(parentId);
    if (siblings) siblings.push(childId);
    else childrenByParent.set(parentId, [childId]);
  }
  return childrenByParent;
}

/**
 * Authoritative descendant lookup: given `agentId -> parentAgentId` (both with any "agent-"
 * prefix already stripped, matching `subagentLogsMap`'s keying), returns every descendant of
 * `rootAgentId` at any depth. Built from `sessions.parent_session_id` via the server (the same
 * recursive-descendant source of truth the API's own cost totals use), so — unlike
 * `collectDescendantAgentIds` — this does not depend on transcript content and is correct even
 * when a nested agent's completion was never written back into its parent's own transcript.
 */
export function collectDescendantAgentIdsFromParentMap(
  rootAgentId: string,
  agentParentMap: Map<string, string | null>,
): string[] {
  const childrenByParent = buildChildrenByParentMap(agentParentMap);

  const visited = new Set<string>([rootAgentId]);
  const queue: string[] = [rootAgentId];
  const descendants: string[] = [];

  while (queue.length > 0) {
    const agentId = queue.shift()!;
    for (const childId of childrenByParent.get(agentId) ?? []) {
      if (visited.has(childId)) continue;
      visited.add(childId);
      descendants.push(childId);
      queue.push(childId);
    }
  }

  return descendants;
}

/**
 * DFS collection of every agentId in a `SubAgentNode` subtree (the node itself plus all
 * descendants), across the whole forest under `nodes`. Only used as one of the descendant
 * sources unioned by `computeTurnDirectAgentCost` below — a defensive fallback alongside the
 * DB-authoritative and transcript-walk sources.
 */
function collectSubtreeAgentIdsFrom(
  nodes: SubAgentNode[],
  agentId: string,
): string[] {
  for (const node of nodes) {
    if (node.agentId === agentId) {
      const ids: string[] = [];
      const walk = (n: SubAgentNode): void => {
        ids.push(n.agentId);
        for (const child of n.children) walk(child);
      };
      walk(node);
      return ids;
    }
    const found = collectSubtreeAgentIdsFrom(node.children, agentId);
    if (found.length > 0) return found;
  }
  return [];
}

/**
 * Total cost of every directly-activated agent in `turn` (its own `agentActivations` — bare
 * `Agent`-tool calls, NOT Workflow-spawned agents), including nested descendants at any depth
 * (orchestrator -> chunk-agent -> research-agent). Three descendant sources are unioned, in order
 * of decreasing reliability: the DB-authoritative `agentParentMap`, a transcript walk
 * (`collectDescendantAgentIds`), and `turn.subAgents` (from `agent_progress` events).
 *
 * Shared by `PromptTurnItem`'s displayed "+subagent" addend and by `SessionLogView`'s
 * `costPerToken` estimate: the latter must subtract this same total from the session's overall
 * sub-agent spend before deriving a per-workflow-token rate — otherwise a directly-activated
 * agent's cost leaks into the workflow-rate numerator while its tokens are absent from the
 * (workflow-only) denominator, inflating the rate.
 */
export function computeTurnDirectAgentCost(
  turn: PromptTurn,
  subagentLogsMap: Map<string, Record<string, unknown>[]> | undefined,
  agentParentMap: Map<string, string | null> | undefined,
  pricing: ModelPricingMap | undefined,
): number | null {
  if (!turn.agentActivations.length || !subagentLogsMap || !pricing)
    return null;
  let total = 0;
  const counted = new Set<string>();
  for (const activation of turn.agentActivations) {
    const ids = new Set<string>([
      activation.agentId,
      ...(agentParentMap
        ? collectDescendantAgentIdsFromParentMap(
            activation.agentId,
            agentParentMap,
          )
        : []),
      ...collectDescendantAgentIds(activation.agentId, subagentLogsMap),
      ...collectSubtreeAgentIdsFrom(turn.subAgents, activation.agentId),
    ]);
    for (const id of ids) {
      if (counted.has(id)) continue; // don't double-count an id shared across activations
      counted.add(id);
      const subLogs = subagentLogsMap.get(id);
      if (!subLogs) continue;
      const { model, tokens } = extractSubagentStats(subLogs);
      const entry = model ? pricing[model] : undefined;
      if (entry) total += computeCost(tokens, entry);
    }
  }
  return total > 0 ? total : null;
}

/**
 * Per-token rate for pricing workflow-spawned agent tokens — the source of a turn's displayed
 * "+~$X" workflow addend (`PromptTurnItem.tsx`) and the Summary tab's per-prompt cost table
 * (`session-summary-derive.ts`). Extracted from `SessionLogView.tsx` so both
 * consumers price a workflow token identically instead of drifting.
 *
 * Prefers the DB-accurate rate: the session's server-computed sub-agent spend
 * (`costBreakdown.subagentCost`, D2.3), net of the exactly-priced direct-agent activations
 * (`computeTurnDirectAgentCost`, subtracted here so it cannot double-count into this
 * workflow-only rate's numerator while its tokens are absent from the denominator), divided by
 * the session's total workflow tokens. This is more accurate than assuming a workflow token
 * costs the same as a main-thread token — workflow/sub-agents often run a different cache/token
 * mix. Falls back to the main-session average rate when workflow agents haven't been uploaded to
 * the DB yet (no `sessionSubagentCost`) or the DB-accurate numerator isn't positive.
 */
export function computeWorkflowCostPerToken(
  parsedLogs: ParsedSession,
  pricing: ModelPricingMap | undefined,
  sessionSubagentCost: number | null | undefined,
  subagentLogsMap: Map<string, Record<string, unknown>[]> | undefined,
  agentParentMap: Map<string, string | null> | undefined,
): number | null {
  const model = parsedLogs.summary.model;
  if (!model || !pricing?.[model]) return null;
  const mainCost = computeCost(
    parsedLogs.summary.tokenBreakdown,
    pricing[model],
  );

  // DB-accurate path: distribute actual sub-agent cost across workflow tokens.
  if (sessionSubagentCost != null) {
    const directAgentCost = parsedLogs.turns.reduce(
      (sum, t) =>
        sum +
        (computeTurnDirectAgentCost(
          t,
          subagentLogsMap,
          agentParentMap,
          pricing,
        ) ?? 0),
      0,
    );
    const subAgentCost = sessionSubagentCost - directAgentCost;
    const totalWorkflowTokens = parsedLogs.turns.reduce(
      (sum, t) =>
        sum +
        (t.workflows?.reduce((s, wf) => s + (wf.subagentTokens ?? 0), 0) ?? 0),
      0,
    );
    if (subAgentCost > 0.001 && totalWorkflowTokens > 0) {
      return subAgentCost / totalWorkflowTokens;
    }
  }

  // Fallback: main session average (skewed by cache mix, less accurate).
  const mainTokens = parsedLogs.summary.totalTokens;
  return mainTokens > 0 ? mainCost / mainTokens : null;
}

function classifyClaudeMdRole(
  rawPath: string,
): 'claude-md' | 'local-md' | 'rule' {
  const norm = rawPath.replace(/\\/g, '/');
  if (norm.includes('.claude/rules/')) return 'rule';
  if (/CLAUDE\.local\.md$/i.test(norm)) return 'local-md';
  return 'claude-md';
}

// Main exported function
// ---------------------------------------------------------------------------

export interface SubagentStatEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * Web-search / fast-mode cost inputs, optional here even though the current server always sends them
   * (`SubagentStats` in `viewer/api.ts`): the folds below treat an absent value as 0, so a
   * client running against an older server keeps working instead of producing `NaN` costs.
   * `*Fast` are subsets of `inputTokens` / `outputTokens`, not additional tokens.
   */
  webSearchRequests?: number;
  inputTokensFast?: number;
  outputTokensFast?: number;
}

export function parseSessionLogs(
  raw: Record<string, unknown>[],
  options?: {
    isSubagent?: boolean;
    repoRoot?: string;
    repoConfig?: RepoConfig | null;
    /** Token totals from session_stats for child sessions, keyed by sessionId (e.g. "agent-abc123"). */
    subagentStats?: Record<string, SubagentStatEntry>;
    /** Workflow runs from the server, keyed by toolUseId for attachment to turns. */
    workflows?: WorkflowRun[];
    /**
     * Each fetched sub-agent's own raw event array, keyed by agentId (no "agent-" prefix).
     * A sub-agent can itself spawn further sub-agents (3+ levels of nesting); the spawning
     * `Agent` tool_use and the resulting `agent_progress` events for such a grandchild live
     * only inside its direct parent's own transcript, never in the root session's. Passing
     * every fetched sub-agent's log here lets the per-turn `agent_progress` collection below
     * pull in those cross-transcript events, so `buildSubAgentTree`'s existing
     * `parentToolUseID`/`parentUuid` matching can link nesting at any depth instead of only
     * ever seeing the root's own (depth-1) sub-agent activity.
     */
    subagentLogs?: Map<string, Record<string, unknown>[]>;
    /** Model pricing map, used to resolve the session's per-model chars-per-token ratio. */
    pricing?: ModelPricingMap;
    /**
     * The root session's bound harness snapshot (DD-12), server-loaded and passed straight
     * through from `SessionLogsData.harnessSnapshot`. `undefined`/`null` means no bound snapshot
     * (old hook, or a session that never bound one) — System Context then builds nothing from it
     * (DD-13, DD-17). Never supplied for a sub-agent's own log (a snapshot is a root-session-only
     * concept).
     */
    harnessSnapshot?: HarnessSnapshot | null;
  },
): ParsedSession {
  const isSubagent = options?.isSubagent ?? false;
  const repoRoot = options?.repoRoot ?? '';
  const repoConfig = options?.repoConfig ?? null;
  const subagentStats = options?.subagentStats;
  const workflowsOption = options?.workflows;
  const subagentLogsOption = options?.subagentLogs;
  const pricingOption = options?.pricing;
  const harnessSnapshot = options?.harnessSnapshot ?? null;

  let skillDefinitionsMap: Map<string, SkillDefinition> | undefined;
  let agentDefinitionsMap: Map<string, AgentDefinition> | undefined;
  let mcpConfigList: McpServerConfig[] | undefined;

  // 1. Filter and cast events
  const events = raw
    .map((entry) => coerceToObject(entry))
    .filter(
      (e): e is Record<string, unknown> => e !== null,
    ) as unknown as TelemetryEvent[];

  // 2. Build indexes
  const eventIndex = buildEventIndex(events);
  const parentChildMap = buildParentChildMap(events);

  // 3. Assign 1-based global index to ALL type=user events
  let userEventCounter = 0;
  const userEventIndexMap = new Map<TelemetryEvent, number>();
  for (const e of events) {
    if (e.type === 'user') {
      userEventCounter++;
      userEventIndexMap.set(e, userEventCounter);
    }
  }

  // 4. Identify qualifying user events
  const qualifyingEvents = events.filter((e) =>
    isQualifyingUserEvent(e, isSubagent),
  ) as UserEvent[];

  // Build completion map: agentId -> UserEvent (for sub-agent completions)
  const completionMap = new Map<string, UserEvent>();
  for (const e of events) {
    if (e.type === 'user') {
      const ue = e as UserEvent;
      if (ue.toolUseResult?.agentId) {
        completionMap.set(ue.toolUseResult.agentId, ue);
      }
    }
  }

  // Cross-transcript sub-agent progress events (see the `subagentLogs` option doc above).
  // Each sub-agent's own log array is parsed once and its `agent_progress` events are indexed
  // by the OWNING agent's id (i.e. whose transcript they were found in), so the per-turn
  // collection below can transitively pull in exactly the ones reachable from that turn's
  // directly-known sub-agents — never events belonging to an unrelated turn's agent tree.
  const nestedProgressByOwner = new Map<string, ProgressAgentEvent[]>();
  if (subagentLogsOption) {
    for (const [ownerAgentId, subRaw] of subagentLogsOption) {
      const subEvents = subRaw
        .map((entry) => coerceToObject(entry))
        .filter(
          (e): e is Record<string, unknown> => e !== null,
        ) as unknown as TelemetryEvent[];

      for (const e of subEvents) {
        if (e.uuid && !eventIndex.has(e.uuid)) {
          eventIndex.set(e.uuid, e);
        }
        if (e.type === 'user') {
          const ue = e as UserEvent;
          if (
            ue.toolUseResult?.agentId &&
            !completionMap.has(ue.toolUseResult.agentId)
          ) {
            completionMap.set(ue.toolUseResult.agentId, ue);
          }
        }
      }

      const progressInThisLog = subEvents.filter(
        (e): e is ProgressAgentEvent =>
          e.type === 'progress' &&
          (e as ProgressAgentEvent).data?.type === 'agent_progress',
      );
      if (progressInThisLog.length > 0) {
        nestedProgressByOwner.set(ownerAgentId, progressInThisLog);
      }
    }
  }

  // Model: first non-empty model string from any assistant event. Resolved here (ahead of the
  // turn-building loop below) so estTokens calcs throughout can use the session's own
  // chars-per-token ratio instead of always falling back to BYTES_PER_TOKEN.
  let sessionModel: string | undefined;
  for (const e of events) {
    if (e.type === 'assistant') {
      const ae = e as AssistantEvent;
      if (ae.message?.model) {
        sessionModel = ae.message.model.replace(/-\d{8}$/, '');
        break;
      }
    }
  }
  const charsPerToken = resolveCharsPerToken(pricingOption, sessionModel);

  // 5. Build turns
  const turns: PromptTurn[] = [];
  // Stores the BFS uuid set per turn index (0-based position in turns[]) for workflow matching
  const uuidSetsByTurnIndex: Set<string>[] = [];

  // Bare (no "agent-" prefix) agentIds that are confirmed workflow members via
  // `workflows[].agentSessionIds` — used below to restrict the session_stats fallback fold to
  // true workflow-spawned agents only, not any agent whose inline toolUseResult.usage is null.
  const workflowAgentIds = new Set(
    workflowsOption?.flatMap((wf) =>
      wf.agentSessionIds.map(stripAgentPrefix),
    ) ?? [],
  );

  // Set of all qualifying user event UUIDs — used to stop BFS at turn boundaries
  const allQualifyingUuids = new Set(
    qualifyingEvents.filter((e) => e.uuid).map((e) => e.uuid!),
  );

  // Broader set of all turn-boundary user event UUIDs (includes <command-name>/
  // <task-notification> events that don't qualify as prompts but still end a turn) — used
  // only to bound the workTimeMs BFS so trailing async subagent-completion tails don't get
  // folded into the preceding turn's work-time window.
  const allTurnBoundaryUuids = new Set(
    events
      .filter((e) => isTurnBoundaryUserEvent(e, isSubagent))
      .filter((e) => e.uuid)
      .map((e) => e.uuid!),
  );

  for (const userEvent of qualifyingEvents) {
    const index = userEventIndexMap.get(userEvent) ?? 0;

    if (!userEvent.uuid) {
      // No uuid: turn with empty metrics
      uuidSetsByTurnIndex.push(new Set());
      turns.push({
        index,
        userEvent,
        workTimeMs: null,
        tokenBreakdown: null,
        ownTokenBreakdown: null,
        contextTokens: null,
        contextTokensStart: null,
        assistantSteps: [],
        skills: [],
        files: [],
        images: [],
        subAgents: [],
        agentActivations: [],
        toolCalls: [],
        rulesInjected: [],
        linesChanged: 0,
      });
      continue;
    }

    // Stop traversal at other qualifying user events to keep tokens per-turn
    const otherQualifyingUuids = new Set(allQualifyingUuids);
    otherQualifyingUuids.delete(userEvent.uuid);
    const uuidSet = collectTurnUuids(
      userEvent.uuid,
      parentChildMap,
      otherQualifyingUuids,
    );

    // Separate, tighter-bounded uuid set for workTimeMs only: stops at ANY turn-boundary
    // event (including <command-name>/<task-notification>), not just qualifying prompts, so
    // a trailing async subagent-completion tail can't extend this turn's work time. Tokens,
    // context, tool calls, and files below still use the wider `uuidSet`.
    const otherTurnBoundaryUuids = new Set(allTurnBoundaryUuids);
    otherTurnBoundaryUuids.delete(userEvent.uuid);
    const workTimeUuidSet = collectTurnUuids(
      userEvent.uuid,
      parentChildMap,
      otherTurnBoundaryUuids,
    );

    // Work time: last assistant timestamp in uuid BFS set minus user event timestamp
    let workTimeMs: number | null = null;
    const userTs =
      typeof userEvent.timestamp === 'string'
        ? Date.parse(userEvent.timestamp)
        : NaN;
    if (!isNaN(userTs)) {
      let lastAssistantTs: number | null = null;
      for (const e of events) {
        if (e.type !== 'assistant') continue;
        if (!e.uuid || !workTimeUuidSet.has(e.uuid)) continue;
        const ts =
          typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
        if (
          !isNaN(ts) &&
          ts > userTs &&
          (lastAssistantTs === null || ts > lastAssistantTs)
        ) {
          lastAssistantTs = ts;
        }
      }
      if (lastAssistantTs !== null) workTimeMs = lastAssistantTs - userTs;
    }

    // Context tokens: derive start/end from first/last assistant event usage
    let firstAssistantUsage: TokenUsage | undefined;
    let lastAssistantUsage: TokenUsage | undefined;

    for (const e of events) {
      if (e.type !== 'assistant' || !e.uuid || !uuidSet.has(e.uuid)) continue;
      const ae = e as AssistantEvent;
      if (!ae.message?.usage) continue;
      if (!firstAssistantUsage) firstAssistantUsage = ae.message.usage;
      lastAssistantUsage = ae.message.usage;
    }

    const contextTokensStart = sumCtxTokens(firstAssistantUsage);
    let contextTokens = sumCtxTokens(lastAssistantUsage);

    // compact_boundary is authoritative if present — keep as override
    for (const e of events) {
      if (!e.uuid || !uuidSet.has(e.uuid)) continue;
      if (e.type === 'system') {
        const se = e as {
          subtype?: string;
          compactMetadata?: { preTokens: number };
        };
        if (
          se.subtype === 'compact_boundary' &&
          se.compactMetadata !== undefined
        ) {
          contextTokens = se.compactMetadata.preTokens;
          break;
        }
      }
    }

    // Assistant steps: collect per-LLM-call context sizes in chronological order
    const assistantSteps: Array<{
      contextTokens: number;
      text: string | null;
      stopReason: string | null;
      toolCallNames: string[];
      toolCallSummaries: string[];
      toolCallInputs: Record<string, unknown>[];
      timestamp: string | null;
    }> = [];
    for (const e of events) {
      if (e.type !== 'assistant' || !e.uuid || !uuidSet.has(e.uuid)) continue;
      const ae = e as AssistantEvent;
      if (!ae.message?.usage) continue;
      const ctx = sumCtxTokens(ae.message.usage);
      if (ctx === null) continue;
      const content = ae.message.content ?? [];
      const textParts = content
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text!)
        .join('\n')
        .trim();
      const toolBlocks = content.filter((b) => b.type === 'tool_use');
      const toolCallNames = toolBlocks
        .filter((b) => b.name)
        .map((b) => b.name!);
      const toolCallSummaries = toolBlocks.map((b) =>
        b.name && b.input ? summarizeToolCall(b.name, b.input) : '',
      );
      const toolCallInputs = toolBlocks.map((b) => b.input ?? {});
      const timestamp = typeof ae.timestamp === 'string' ? ae.timestamp : null;
      assistantSteps.push({
        contextTokens: ctx,
        text: textParts || null,
        stopReason: ae.message.stop_reason ?? null,
        toolCallNames,
        toolCallSummaries,
        toolCallInputs,
        timestamp,
      });
    }

    // Merge consecutive steps that share the same contextTokens — they are fragments
    // of one streaming API response (thinking → text → tool_use emitted separately).
    const mergedSteps: typeof assistantSteps = [];
    for (const step of assistantSteps) {
      const prev = mergedSteps[mergedSteps.length - 1];
      if (prev && prev.contextTokens === step.contextTokens) {
        prev.text = prev.text ?? step.text;
        prev.stopReason = step.stopReason ?? prev.stopReason;
        prev.toolCallNames = [...prev.toolCallNames, ...step.toolCallNames];
        prev.toolCallSummaries = [
          ...prev.toolCallSummaries,
          ...step.toolCallSummaries,
        ];
        prev.toolCallInputs = [...prev.toolCallInputs, ...step.toolCallInputs];
      } else {
        mergedSteps.push({ ...step });
      }
    }

    // Tokens — main session events
    let tokenBreakdown = sumTokenBreakdown(
      events,
      uuidSet,
      workflowAgentIds,
      subagentLogsOption,
    );

    // Tokens — this turn's OWN assistant events only (no sub-agent / workflow folds).
    // Drives the per-turn cache read ratio; see PromptTurn.ownTokenBreakdown.
    const ownTokenBreakdown = sumOwnAssistantTokenBreakdown(events, uuidSet);

    // Add tokens from session_stats for agents confirmed as workflow members (i.e. their bare
    // agentId appears in some `workflows[].agentSessionIds`) where toolUseResult.usage is null.
    // This must NOT match every agent with null inline usage — a directly-activated (non-workflow)
    // agent's tokens are already reported separately under 'subagents', so folding them in here too
    // would double-count them into 'main'. sumTokenBreakdown already handles the case where usage
    // is present, so this is additive only, and only for true workflow agents.
    if (subagentStats) {
      for (const e of events) {
        if (!e.uuid || !uuidSet.has(e.uuid) || e.type !== 'user') continue;
        const ue = e as UserEvent;
        if (!ue.toolUseResult?.agentId || ue.toolUseResult.usage) continue;
        if (!workflowAgentIds.has(ue.toolUseResult.agentId)) continue;
        const stats = subagentStats[`agent-${ue.toolUseResult.agentId}`];
        if (!stats) continue;
        if (tokenBreakdown === null) {
          tokenBreakdown = {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cacheWrite5m: 0,
            cacheWrite1h: 0,
            webSearchRequests: 0,
            inputFast: 0,
            outputFast: 0,
          };
        }
        tokenBreakdown.input += stats.inputTokens;
        tokenBreakdown.output += stats.outputTokens;
        tokenBreakdown.cacheRead += stats.cacheReadTokens;
        tokenBreakdown.cacheWrite += stats.cacheWriteTokens;
        // session_stats has no TTL split at this level, so the whole cache-write
        // figure lands in the 5m bucket — preserving the
        // cacheWrite5m + cacheWrite1h === cacheWrite invariant.
        tokenBreakdown.cacheWrite5m += stats.cacheWriteTokens;
        // Web-search / fast-mode figures from session_stats; absent -> no surcharge / no search cost.
        tokenBreakdown.webSearchRequests += stats.webSearchRequests ?? 0;
        tokenBreakdown.inputFast += stats.inputTokensFast ?? 0;
        tokenBreakdown.outputFast += stats.outputTokensFast ?? 0;
      }
    }

    // Tool calls in this turn
    const toolCalls = extractToolCallsInTurn(events, uuidSet);

    // Lines changed: count lines written by Edit/Write tool calls
    let linesChanged = 0;
    for (const call of toolCalls) {
      if (call.name === 'Edit') {
        const s = call.input.new_string as string | undefined;
        if (typeof s === 'string') linesChanged += s.split('\n').length;
      } else if (call.name === 'Write') {
        const s = call.input.content as string | undefined;
        if (typeof s === 'string') linesChanged += s.split('\n').length;
      } else if (call.name === 'MultiEdit') {
        const edits = call.input.edits;
        if (Array.isArray(edits)) {
          for (const edit of edits) {
            const s = (edit as Record<string, unknown> | null)?.['new_string'];
            if (typeof s === 'string') linesChanged += s.split('\n').length;
          }
        }
      }
    }

    // Skills
    const seenSkills = new Set<string>();
    const skills: SkillInvocation[] = [];
    for (const call of toolCalls) {
      if (call.name === 'Skill') {
        const skillName = (call.input.skill as string) ?? '';
        const isDuplicate = seenSkills.has(skillName);
        seenSkills.add(skillName);
        const skillBytes = extractSkillContentBytes(
          call.id,
          events,
          parentChildMap,
          eventIndex,
        );
        skills.push({
          name: skillName,
          isDuplicate,
          path: `.claude/skills/${skillName}`,
          ...(skillBytes !== undefined &&
            skillBytes > 0 && {
              bytes: skillBytes,
              estTokens: Math.round(skillBytes / charsPerToken),
            }),
        });
      }
    }

    // Files
    const pathAccessCount = new Map<string, number>();
    const files: FileAccess[] = [];
    const fileToolNames = new Set([
      'Read',
      'Edit',
      'Write',
      'MultiEdit',
      'Glob',
    ]);
    for (const call of toolCalls) {
      if (!fileToolNames.has(call.name)) continue;
      const toolName = call.name as
        | 'Read'
        | 'Edit'
        | 'Write'
        | 'MultiEdit'
        | 'Glob';
      const path = extractFilePathFromToolCall(toolName, call.input);
      const accessCount = (pathAccessCount.get(path) ?? 0) + 1;
      pathAccessCount.set(path, accessCount);
      const category = resolveFileCategory(path, repoRoot, repoConfig);

      const fileAccess: FileAccess = {
        path,
        tool: toolName,
        accessCount,
        category,
      };

      if (toolName === 'Glob') {
        fileAccess.globMatchCount = extractGlobCount(events, call.id);
      } else if (toolName === 'Read') {
        const bytes = extractToolResultBytes(events, call.id);
        if (bytes !== undefined) {
          fileAccess.bytes = bytes;
          fileAccess.estTokens = Math.round(bytes / charsPerToken);
        }
      }

      files.push(fileAccess);
    }

    // Per-call tool details
    const turnStartTs = userEvent.timestamp
      ? Date.parse(userEvent.timestamp)
      : 0;
    const lastToolCall = toolCalls[toolCalls.length - 1];
    const turnEndTs = lastToolCall?.timestamp
      ? Date.parse(lastToolCall.timestamp)
      : turnStartTs;
    const { permReqs, permDenials } = extractArtisynPermissionEvents(
      events,
      turnStartTs,
      turnEndTs,
    );
    const callDetails = buildToolCallDetails(
      events,
      toolCalls,
      permReqs,
      permDenials,
    );

    // Sub-agents: collect agent_progress events in turn uuid set
    // Exclude progress events whose parentUuid is absent from the event index
    const turnProgressEvents: ProgressAgentEvent[] = [];
    for (const e of events) {
      if (e.type !== 'progress') continue;
      const pe = e as ProgressAgentEvent;
      if (pe.data?.type !== 'agent_progress') continue;
      if (!pe.uuid || !uuidSet.has(pe.uuid)) continue;
      // Exclude if parentUuid is absent from the event index
      if (!pe.parentUuid || !eventIndex.has(pe.parentUuid)) continue;
      turnProgressEvents.push(pe);
    }

    // Transitively pull in cross-transcript progress events (grandchildren, etc.) reachable
    // from the sub-agents already known to belong to this turn. Starting the walk only from
    // agentIds discovered above keeps this strictly turn-scoped — an unrelated turn's agent
    // tree living in a different sub-agent transcript is never pulled in here.
    if (nestedProgressByOwner.size > 0) {
      const seenAgentIds = new Set(
        turnProgressEvents.map((pe) => pe.data.agentId),
      );
      const queue = [...seenAgentIds];
      const seenEvents = new Set(turnProgressEvents);
      while (queue.length > 0) {
        const ownerAgentId = queue.shift()!;
        const nested = nestedProgressByOwner.get(ownerAgentId);
        if (!nested) continue;
        for (const pe of nested) {
          if (seenEvents.has(pe)) continue;
          seenEvents.add(pe);
          turnProgressEvents.push(pe);
          if (!seenAgentIds.has(pe.data.agentId)) {
            seenAgentIds.add(pe.data.agentId);
            queue.push(pe.data.agentId);
          }
        }
      }
    }

    const subAgents = buildSubAgentTree(
      turnProgressEvents,
      completionMap,
      eventIndex,
      subagentStats,
    );

    const agentActivations = extractAgentActivations(events, uuidSet);

    const rulesInjected = extractRulesInjected(events, uuidSet, charsPerToken);

    const images = extractImagesInTurn(events, uuidSet, toolCalls);

    uuidSetsByTurnIndex.push(uuidSet);
    turns.push({
      index,
      userEvent,
      workTimeMs,
      tokenBreakdown,
      ownTokenBreakdown,
      contextTokens,
      contextTokensStart,
      assistantSteps: mergedSteps,
      skills,
      files,
      images,
      subAgents,
      agentActivations,
      toolCalls: callDetails,
      rulesInjected,
      linesChanged,
    });
  }

  // Post-turn: attach WorkflowRun objects to turns by matching toolUseId.
  // Scan ALL assistant events (including those inside sub-agent invocations)
  // using the per-turn uuidSet to find which turn owns the Workflow call.
  if (workflowsOption && workflowsOption.length > 0) {
    const workflowByToolUseId = new Map<string, WorkflowRun>();
    for (const wf of workflowsOption) {
      workflowByToolUseId.set(wf.toolUseId, wf);
    }

    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      const uuidSet = uuidSetsByTurnIndex[i];
      if (!uuidSet || uuidSet.size === 0) continue;

      const matched: WorkflowRun[] = [];
      for (const e of events) {
        if (e.type !== 'assistant') continue;
        if (!e.uuid || !uuidSet.has(e.uuid)) continue;
        const ae = e as AssistantEvent;
        if (!ae.message?.content) continue;
        for (const block of ae.message.content) {
          if (
            block.type === 'tool_use' &&
            block.name === 'Workflow' &&
            block.id
          ) {
            const wf = workflowByToolUseId.get(block.id);
            if (wf) matched.push(wf);
          }
        }
      }
      if (matched.length > 0) {
        turn.workflows = matched;
      }
    }
  }

  // Post-turn: correlate artisyn SubagentStart events with AgentActivations
  for (const e of events) {
    if (e.type !== 'artisyn') continue;
    const ae = e as {
      type: string;
      hook_event_name?: string;
      agent_id?: string;
      agent_type?: string;
      timestamp?: string;
    };
    if (ae.hook_event_name !== 'SubagentStart' || !ae.agent_id) continue;
    for (const turn of turns) {
      const act = turn.agentActivations.find((a) => a.agentId === ae.agent_id);
      if (act) {
        if (ae.agent_type) act.agentType = ae.agent_type;
        break;
      }
    }
  }

  // Detect StopFailure
  let hasStopFailure = false;
  for (const e of events) {
    if (e.type === 'artisyn') {
      const ae = e as { type: string; hook_event_name?: string };
      if (ae.hook_event_name === 'StopFailure') {
        hasStopFailure = true;
        break;
      }
    }
  }

  // 6. Compute summary
  // System Context (DD-13): claudeMd, skillDefinitions, agentDefinitions and mcpConfig are all
  // built from the hook-reported harness snapshot (DD-1), loaded server-side and passed in as
  // `options.harnessSnapshot`. With no snapshot (old hook, or a session that never bound one —
  // DD-17), every one of these stays undefined and the corresponding System Context tabs do not
  // render. There is no fallback to the old per-event or `skill_listing` sources any more.
  let claudeMd: ClaudeMdContext | undefined;
  if (
    harnessSnapshot?.systemContext &&
    harnessSnapshot.systemContext.totalBytes > 0
  ) {
    claudeMd = {
      totalBytes: harnessSnapshot.systemContext.totalBytes,
      estTokens: Math.round(
        harnessSnapshot.systemContext.totalBytes / charsPerToken,
      ),
      files: harnessSnapshot.systemContext.files.map((f) => ({
        path: f.path,
        bytes: f.bytes,
        role: classifyClaudeMdRole(f.path),
        ...(f.content !== undefined ? { content: f.content } : {}),
      })),
    };
  }

  if (harnessSnapshot?.skills && harnessSnapshot.skills.length > 0) {
    const visible = harnessSnapshot.skills.filter(
      (s) => !s.name.startsWith(HIDDEN_SKILL_PREFIX),
    );
    if (visible.length > 0) {
      skillDefinitionsMap = new Map();
      for (const s of visible) {
        skillDefinitionsMap.set(s.name, {
          name: s.name,
          description: s.description ?? '',
          ...(s.argumentHint ? { argumentHint: s.argumentHint } : {}),
          body: s.body ?? '',
          path: s.path,
          bytes: s.bytes ?? 0,
          source: s.source,
          kind: s.kind,
          ...(s.plugin ? { plugin: s.plugin } : {}),
          ...(s.contentHash ? { contentHash: s.contentHash } : {}),
        });
      }
    }
  }

  if (harnessSnapshot?.agents && harnessSnapshot.agents.length > 0) {
    agentDefinitionsMap = new Map();
    for (const a of harnessSnapshot.agents) {
      agentDefinitionsMap.set(a.name, {
        name: a.name,
        description: a.description ?? '',
        body: a.body ?? '',
        path: a.path,
        bytes: a.bytes ?? 0,
        source: a.source,
        ...(a.contentHash ? { contentHash: a.contentHash } : {}),
      });
    }
  }

  if (harnessSnapshot?.mcpServers && harnessSnapshot.mcpServers.length > 0) {
    mcpConfigList = harnessSnapshot.mcpServers
      .filter((s) => s && typeof s.name === 'string')
      .map((s) => ({
        name: s.name,
        command: s.command ?? '',
        args: s.args ?? '',
        ...(s.url !== undefined ? { url: s.url } : {}),
        ...(s.configSource !== undefined
          ? { configSource: s.configSource }
          : {}),
      }));
  }

  // Token breakdown across all events (not scoped to turns)
  let sumInput = 0;
  let sumOutput = 0;
  let sumCacheRead = 0;
  let sumCacheWrite = 0;
  let sumCacheWrite5m = 0;
  let sumCacheWrite1h = 0;
  let sumWebSearchRequests = 0;
  let sumInputFast = 0;
  let sumOutputFast = 0;
  // Same message.id dedup as sumTokenBreakdown() above — one API response can be split
  // across multiple transcript lines (one per content block); its usage is counted from
  // the LAST line, as a first line written mid-stream can carry a partial output_tokens.
  const lastSummaryUsageEvent = new Map<string, TelemetryEvent>();
  for (const e of events) {
    if (e.type !== 'assistant') continue;
    const ae = e as AssistantEvent;
    if (!ae.message?.usage) continue;
    const dedupeKey = ae.message.id ?? e.uuid;
    if (dedupeKey) lastSummaryUsageEvent.set(dedupeKey, e);
  }

  for (const e of events) {
    if (e.type === 'assistant') {
      const ae = e as AssistantEvent;
      if (!ae.message?.usage) continue;
      const dedupeKey = ae.message.id ?? e.uuid;
      if (dedupeKey && lastSummaryUsageEvent.get(dedupeKey) !== e) continue;
      const u = ae.message.usage;
      const ttl = splitCacheWrite(u);
      const fast = splitFastTokens(u);
      sumInput += u.input_tokens ?? 0;
      sumOutput += u.output_tokens ?? 0;
      sumCacheRead += u.cache_read_input_tokens ?? 0;
      sumCacheWrite += u.cache_creation_input_tokens ?? 0;
      sumCacheWrite5m += ttl.write5m;
      sumCacheWrite1h += ttl.write1h;
      sumWebSearchRequests += webSearchRequestsOf(u);
      sumInputFast += fast.inputFast;
      sumOutputFast += fast.outputFast;
    } else if (e.type === 'user') {
      const ue = e as UserEvent;
      if (!ue.toolUseResult?.agentId || !ue.toolUseResult.usage) continue;
      if (
        isAgentUsagePricedElsewhere(
          ue.toolUseResult.agentId,
          workflowAgentIds,
          subagentLogsOption,
        )
      )
        continue;
      const u = ue.toolUseResult.usage;
      const ttl = splitCacheWrite(u);
      const fast = splitFastTokens(u);
      sumInput += u.input_tokens ?? 0;
      sumOutput += u.output_tokens ?? 0;
      sumCacheRead += u.cache_read_input_tokens ?? 0;
      sumCacheWrite += u.cache_creation_input_tokens ?? 0;
      sumCacheWrite5m += ttl.write5m;
      sumCacheWrite1h += ttl.write1h;
      sumWebSearchRequests += webSearchRequestsOf(u);
      sumInputFast += fast.inputFast;
      sumOutputFast += fast.outputFast;
    }
  }

  const tokenBreakdown: TokenBreakdown = {
    input: sumInput,
    output: sumOutput,
    cacheRead: sumCacheRead,
    cacheWrite: sumCacheWrite,
    cacheWrite5m: sumCacheWrite5m,
    cacheWrite1h: sumCacheWrite1h,
    webSearchRequests: sumWebSearchRequests,
    inputFast: sumInputFast,
    outputFast: sumOutputFast,
  };
  const totalTokens = sumInput + sumOutput + sumCacheRead + sumCacheWrite;

  const totalWorkTimeMs = turns.reduce(
    (sum, t) => sum + (t.workTimeMs ?? 0),
    0,
  );

  // maxContextTokens: max preTokens across all compact_boundary events
  let maxContextTokens: number | null = null;
  for (const e of events) {
    if (e.type === 'system') {
      const se = e as {
        subtype?: string;
        compactMetadata?: { preTokens: number };
      };
      if (
        se.subtype === 'compact_boundary' &&
        se.compactMetadata !== undefined
      ) {
        const val = se.compactMetadata.preTokens;
        maxContextTokens =
          maxContextTokens === null ? val : Math.max(maxContextTokens, val);
      }
    }
  }

  // Fallback: derive maxContextTokens from turn-level end-of-turn context
  if (maxContextTokens === null) {
    for (const turn of turns) {
      if (turn.contextTokens !== null) {
        maxContextTokens =
          maxContextTokens === null
            ? turn.contextTokens
            : Math.max(maxContextTokens, turn.contextTokens);
      }
    }
  }

  // skillsUsed: distinct skill names from Skill tool calls in assistant events
  const skillNamesSet = new Set<string>();
  for (const turn of turns) {
    for (const skill of turn.skills) {
      skillNamesSet.add(skill.name);
    }
  }
  const skillsUsed = Array.from(skillNamesSet);

  // linesChanged: sum across all turns
  const linesChanged = turns.reduce((n, t) => n + t.linesChanged, 0);

  // imageStats: aggregate across all turns
  const imageStats: ImageStats = { count: 0, totalBytes: 0, estInputTokens: 0 };
  for (const turn of turns) {
    for (const img of turn.images) {
      imageStats.count++;
      imageStats.totalBytes += img.bytes;
      imageStats.estInputTokens += img.estInputTokens ?? 0;
    }
  }

  // fileStats: aggregate file access counts and bytes across all turns
  const fileStats: FileStats = {};
  for (const turn of turns) {
    for (const file of turn.files) {
      const cat = file.category;
      const existing: FileCategoryStats = fileStats[cat] ?? {
        files: 0,
        bytes: 0,
      };
      fileStats[cat] = {
        files: existing.files + 1,
        bytes: existing.bytes + (file.bytes ?? 0),
      };
    }
  }

  // deferredTools: collect tool names from deferred_tools_delta attachment events
  const deferredToolsSet = new Set<string>();
  for (const e of events) {
    if (e.type !== 'attachment') continue;
    const ae = e as {
      type: string;
      attachment?: {
        type?: string;
        addedNames?: string[];
        readdedNames?: string[];
        removedNames?: string[];
      };
    };
    if (ae.attachment?.type !== 'deferred_tools_delta') continue;
    for (const name of ae.attachment.addedNames ?? [])
      deferredToolsSet.add(name);
    for (const name of ae.attachment.readdedNames ?? [])
      deferredToolsSet.add(name);
    for (const name of ae.attachment.removedNames ?? [])
      deferredToolsSet.delete(name);
  }
  const deferredTools = Array.from(deferredToolsSet);

  // registeredAgents: net set from agent_listing_delta events
  const registeredAgentsSet = new Set<string>();
  for (const e of events) {
    if (e.type !== 'attachment') continue;
    const ae = e as {
      attachment?: {
        type?: string;
        addedTypes?: string[];
        removedTypes?: string[];
        isInitial?: boolean;
      };
    };
    if (ae.attachment?.type !== 'agent_listing_delta') continue;
    if (ae.attachment.isInitial === true) registeredAgentsSet.clear();
    for (const t of ae.attachment.addedTypes ?? []) registeredAgentsSet.add(t);
    for (const t of ae.attachment.removedTypes ?? [])
      registeredAgentsSet.delete(t);
  }
  const registeredAgents = Array.from(registeredAgentsSet);

  // registeredSkills: prefer isInitial=true entry; fallback to last skill_listing
  let registeredSkills: string[] = [];
  let lastSkillNames: string[] = [];
  for (const e of events) {
    if (e.type !== 'attachment') continue;
    const ae = e as {
      attachment?: {
        type?: string;
        names?: string[];
        isInitial?: boolean;
      };
    };
    if (ae.attachment?.type !== 'skill_listing') continue;
    const names = ae.attachment.names ?? [];
    if (ae.attachment.isInitial === true) {
      registeredSkills = names;
      break;
    }
    lastSkillNames = names;
  }
  if (registeredSkills.length === 0) registeredSkills = lastSkillNames;

  // visibleSkills / visibleAgents (DD-13): snapshot-derived definitions filtered down to what
  // this session actually registered. When the session reported no listing at all (empty
  // registeredSkills/registeredAgents — e.g. a log predating the attachment events), every
  // snapshot definition is shown instead of none, so a merely-older session still gets its
  // Skills/Agents tabs.
  const visibleSkills: SkillDefinition[] | undefined = skillDefinitionsMap
    ? Array.from(skillDefinitionsMap.values())
        .filter(
          (s) =>
            registeredSkills.length === 0 || registeredSkills.includes(s.name),
        )
        .sort((a, b) => a.name.localeCompare(b.name))
    : undefined;
  const visibleAgents: AgentDefinition[] | undefined = agentDefinitionsMap
    ? Array.from(agentDefinitionsMap.values())
        .filter(
          (a) =>
            registeredAgents.length === 0 || registeredAgents.includes(a.name),
        )
        .sort((a, b) => a.name.localeCompare(b.name))
    : undefined;

  // mcpCalls: count tool_use blocks in assistant messages whose name matches /^mcp__/
  const mcpCalls: Record<string, number> = {};
  for (const e of events) {
    if (e.type !== 'assistant') continue;
    const ae = e as AssistantEvent;
    if (!ae.message?.content) continue;
    for (const block of ae.message.content) {
      if (block.type === 'tool_use' && block.name?.startsWith('mcp__')) {
        mcpCalls[block.name] = (mcpCalls[block.name] ?? 0) + 1;
      }
    }
  }

  // Post-process: resolve SkillInvocation.definition
  if (skillDefinitionsMap) {
    for (const turn of turns) {
      for (const skill of turn.skills) {
        const def = skillDefinitionsMap.get(skill.name);
        if (def) skill.definition = def;
      }
    }
  }

  const summary: SessionSummary = {
    promptCount: qualifyingEvents.length,
    totalTokens,
    tokenBreakdown,
    totalWorkTimeMs,
    maxContextTokens,
    skillsUsed,
    fileStats,
    linesChanged,
    imageStats,
    deferredTools,
    registeredAgents,
    registeredSkills,
    ...(sessionModel !== undefined && { model: sessionModel }),
    ...(claudeMd !== undefined && { claudeMd }),
    ...(skillDefinitionsMap !== undefined && {
      skillDefinitions: skillDefinitionsMap,
    }),
    ...(agentDefinitionsMap !== undefined && {
      agentDefinitions: agentDefinitionsMap,
    }),
    ...(mcpConfigList !== undefined && { mcpConfig: mcpConfigList }),
    ...(visibleSkills !== undefined && { visibleSkills }),
    ...(visibleAgents !== undefined && { visibleAgents }),
  };

  // ---------------------------------------------------------------------------
  // Path normalisation: strip repoRoot prefix so every consumer receives
  // repo-root-relative paths, regardless of the machine they were captured on.
  // ---------------------------------------------------------------------------
  {
    const allAbsPaths: string[] = [];
    for (const turn of turns) {
      for (const f of turn.files) allAbsPaths.push(f.path);
      for (const r of turn.rulesInjected) if (r.path) allAbsPaths.push(r.path);
    }
    for (const f of claudeMd?.files ?? []) allAbsPaths.push(f.path);

    // Prefer caller-supplied repoRoot; otherwise auto-detect from the session data.
    const effectiveRoot =
      repoRoot ||
      (() => {
        const fwdPaths = allAbsPaths.map((p) => p.replace(/\\/g, '/'));

        // Primary: CLAUDE.md always lives at the repo root. The hook writes its
        // path as an absolute OS path, so the shortest matching path gives us the
        // repo root without ambiguity.
        const claudeMdPaths = fwdPaths.filter(
          (p) =>
            (/^[A-Za-z]:\//.test(p) || p.startsWith('/')) &&
            /\/(CLAUDE(?:\.local)?\.md)$/.test(p),
        );
        if (claudeMdPaths.length > 0) {
          const shortest = claudeMdPaths.reduce((a, b) =>
            a.length <= b.length ? a : b,
          );
          return shortest.replace(/\/(CLAUDE(?:\.local)?\.md)$/, '') + '/';
        }

        // Fallback: common prefix of absolute paths — but only when paths span
        // at least two distinct parent directories, otherwise the prefix collapses
        // to a single-file directory and strips too much.
        const absPaths = fwdPaths.filter(
          (p) => p && (/^[A-Za-z]:\//.test(p) || p.startsWith('/')),
        );
        if (absPaths.length === 0) return '';
        const uniqueDirs = new Set(
          absPaths.map((p) => p.replace(/\/[^/]+$/, '')),
        );
        if (uniqueDirs.size < 2) return '';

        const partsArr = absPaths.map((p) => p.split('/'));
        const minLen = Math.min(...partsArr.map((p) => p.length));
        let prefixParts: string[] = [];
        for (let i = 0; i < minLen - 1; i++) {
          if (partsArr.every((p) => p[i] === partsArr[0][i])) {
            prefixParts = partsArr[0].slice(0, i + 1);
          } else {
            break;
          }
        }
        return prefixParts.length > 0 ? prefixParts.join('/') + '/' : '';
      })();

    if (effectiveRoot) {
      for (const turn of turns) {
        for (const f of turn.files) {
          f.path = normaliseClientPath(f.path, effectiveRoot);
        }
        for (const r of turn.rulesInjected) {
          if (r.path) r.path = normaliseClientPath(r.path, effectiveRoot);
        }
      }
      if (claudeMd) {
        for (const f of claudeMd.files) {
          f.path = normaliseClientPath(f.path, effectiveRoot);
        }
      }
    }
  }

  // compactBoundaries: collect from compact_boundary system events
  const compactBoundaries: CompactBoundary[] = [];
  for (const e of events) {
    if (e.type !== 'system') continue;
    const se = e as SystemCompactBoundaryEvent;
    if (se.subtype !== 'compact_boundary' || !se.compactMetadata) continue;
    compactBoundaries.push({
      timestamp: se.timestamp ?? '',
      preTokens: se.compactMetadata.preTokens,
      postTokens: se.compactMetadata.postTokens ?? 0,
      ...(se.compactMetadata.durationMs !== undefined && {
        durationMs: se.compactMetadata.durationMs,
      }),
      ...(se.compactMetadata.trigger !== undefined && {
        trigger: se.compactMetadata.trigger,
      }),
    });
  }

  // PreCompact fallback: add boundaries from artisyn PreCompact events not matched to existing ones.
  // compact_boundary always fires AFTER PreCompact (compaction takes 30-180s), so we look for a
  // compact_boundary within 10 minutes that starts after the PreCompact timestamp.
  for (const e of events) {
    if (e.type !== 'artisyn') continue;
    const ae = e as {
      type: string;
      hook_event_name?: string;
      timestamp?: string;
    };
    if (ae.hook_event_name !== 'PreCompact' || !ae.timestamp) continue;
    const aeTs = Date.parse(ae.timestamp);
    const TEN_MINUTES = 10 * 60 * 1000;
    const alreadyCovered = compactBoundaries.some((cb) => {
      const cbTs = Date.parse(cb.timestamp);
      // compact_boundary fires after PreCompact, within 10 minutes
      return !Number.isNaN(cbTs) && cbTs >= aeTs && cbTs - aeTs < TEN_MINUTES;
    });
    if (!alreadyCovered) {
      compactBoundaries.push({ timestamp: ae.timestamp });
    }
  }

  return { summary, turns, mcpCalls, compactBoundaries, hasStopFailure };
}

// ---------------------------------------------------------------------------
// Exported utility functions
// ---------------------------------------------------------------------------

export const SYSTEM_BLOCK_RE =
  /<(local-command-caveat|system-reminder|command-name|command-message|command-args|local-command-stdout|ide_opened_file)>[\s\S]*?<\/\1>/gi;

export function stripSystemBlocks(text: string): string {
  return text
    .replace(SYSTEM_BLOCK_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function getPromptText(turn: PromptTurn): string {
  const content = turn.userEvent.message?.content;
  if (!content) return '';
  if (typeof content === 'string') {
    // New slash-command format starts with <command-message>.
    // Reconstruct the full command: <command-name> (has the / prefix) + <command-args>.
    if (content.trimStart().startsWith('<command-message>')) {
      const nameMatch = content.match(
        /<command-name>([\s\S]*?)<\/command-name>/,
      );
      const argsMatch = content.match(
        /<command-args>([\s\S]*?)<\/command-args>/,
      );
      const cmdName = nameMatch?.[1].trim() ?? '';
      const args = argsMatch?.[1].trim() ?? '';
      if (cmdName && args) return `${cmdName} ${args}`;
      if (cmdName) return cmdName;
      return args;
    }
    // Old format (<command-name> prefix) is filtered by isQualifyingUserEvent;
    // fall back to args text for safety.
    const argsMatch = content.match(/<command-args>([\s\S]*?)<\/command-args>/);
    if (argsMatch) return argsMatch[1].trim();
    return content;
  }
  const parts = content
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text as string);
  return parts.join('\n\n');
}

export function formatDuration(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Format workflow duration: "Xm Ys" when ≥60 s, "Xs" when <60 s. */
export function formatWorkflowDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function formatInt(n: number): string {
  return n.toLocaleString();
}

/** Local `YYYY-MM-DD HH:mm:ss`; delegates to the shared {@link formatLocalTimestamp}. */
export function formatTimestamp(ts: string | undefined): string {
  return formatLocalTimestamp(ts);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

export function extractSystemPromptBytes(
  _events: TelemetryEvent[],
): number | undefined {
  // STUB: exact log event field TBD; confirm against real data before implementing.
  return undefined;
}
