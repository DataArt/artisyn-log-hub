import type { FileCategory, ServiceTierTokens } from '../database/schema/index';
import type { RawChangedPath } from './change-surface/change-surface.types';
import type { SessionCallTokens } from './cost.sql';
import {
  stripRepoRootPreservingCase,
  usableRepoRoots,
} from './change-surface/path-normalise';
import { maxVersion } from '../common/semver';
import { isEditWriteTool } from './edit-tools';
import {
  accumulateToolCall,
  classifyToolOutcome,
  countCommits,
  countEditInputPatchLines,
  countPatchLines,
  countPullRequests,
  createToolStatRow,
  mcpServerOfTool,
  readServiceTier,
  resolveToolDuration,
  type PatchLineCounts,
  type ToolStatRow,
} from './tool-stats';
import { inferToolIsInitial, walkDeferredToolsDelta } from './turn-walk';

export type { FileCategory };

export const DEFAULT_FILE_CATEGORIES: FileCategory[] = [
  { name: 'knowledgebase', patterns: ['docs/knowledgebase/.*'] },
  { name: 'docs', patterns: ['docs/.*'] },
  // 'code' is the implicit fallback — not stored in config
];

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

export function normaliseFilePath(
  absolutePath: string,
  repoRoot: string,
): string {
  let rel = absolutePath;
  if (repoRoot) {
    // Case-insensitive strip on Windows; safe on POSIX too
    if (rel.toLowerCase().startsWith(repoRoot.toLowerCase())) {
      rel = rel.slice(repoRoot.length);
    }
  } else {
    // Fallback: when repoRoot is unknown, scan for a known top-level directory
    // segment and return from that point onward.
    const fwd = rel.replace(/\\/g, '/');
    for (const dir of KNOWN_TOP_LEVEL_DIRS) {
      const marker = `/${dir}/`;
      const idx = fwd.indexOf(marker);
      if (idx !== -1) {
        return fwd.slice(idx + 1); // strip leading '/'
      }
    }
  }
  return rel.replace(/\\/g, '/').replace(/^\//, '');
}

/**
 * Normalise a Read tool's absolute `file_path` for file-category classification, using the
 * same repo-root rules as the change surface (`normaliseChangedPath()`):
 *
 * - **No usable root** (`repoRoots` empty, or only blank entries): fall back to
 *   {@link normaliseFilePath} with `''`, i.e. the `KNOWN_TOP_LEVEL_DIRS` guess.
 * - **Under a root:** the repo-relative path in its original case — longest root wins,
 *   matched case-insensitively on a `/` boundary, empty and `.` segments dropped.
 * - **Under no root** (or the root directory itself): the path itself with backslashes
 *   turned into `/` — still absolute, nothing stripped, so a repo-relative pattern such as
 *   `^docs/` can never match a file outside the repo.
 */
export function normaliseReadPath(
  absPath: string,
  repoRoots: readonly string[],
): string {
  const roots = usableRepoRoots(repoRoots);
  if (roots.length === 0) return normaliseFilePath(absPath, '');
  const relative = stripRepoRootPreservingCase(absPath, roots);
  return relative ?? absPath.replace(/\\/g, '/');
}

export function classifyFile(
  relativePath: string,
  categories: FileCategory[],
): string {
  for (const category of categories) {
    for (const pattern of category.patterns) {
      let regExp: RegExp;
      try {
        regExp = new RegExp(pattern);
      } catch {
        // A stale/invalid pattern (e.g. glob syntax saved before regex validation
        // was enforced) must not break classification for every file — skip it.
        continue;
      }
      if (regExp.test(relativePath)) {
        return category.name;
      }
    }
  }
  return 'code';
}

type AnyRecord = Record<string, unknown>;

function asRecord(v: unknown): AnyRecord | null {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    return v as AnyRecord;
  }
  return null;
}

function asArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asNumber(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

/**
 * Twin of isQualifyingUserEvent() in
 * client/src/viewer/pages/repository/session-log/log-parser.ts — keep in sync.
 */
function isNonQualifyingPromptContent(content: unknown): boolean {
  if (typeof content !== 'string') return false;
  const trimmed = content.trimStart();
  return (
    trimmed.startsWith('<task-notification>') ||
    trimmed.startsWith('<command-name>')
  );
}

/**
 * Splits one `usage` object's cache-creation tokens into the 5m / 1h TTL buckets.
 *
 * `usage.cache_creation` (`{ ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }`)
 * is the authoritative source when present. Older transcripts only carry the flat
 * `cache_creation_input_tokens`; those tokens all go to the 5m bucket, which keeps
 * `write5m + write1h === cache_creation_input_tokens` for every line.
 */
export function splitCacheCreationTokens(usage: Record<string, unknown>): {
  write5m: number;
  write1h: number;
} {
  const total = asNumber(usage['cache_creation_input_tokens']);
  const cacheCreation = asRecord(usage['cache_creation']);
  if (cacheCreation !== null) {
    const write5m = asNumber(cacheCreation['ephemeral_5m_input_tokens']);
    const write1h = asNumber(cacheCreation['ephemeral_1h_input_tokens']);
    if (write5m + write1h > 0) return { write5m, write1h };
  }
  return { write5m: total, write1h: 0 };
}

function parseTs(v: unknown): number {
  const s = asString(v);
  if (s === null) return NaN;
  return Date.parse(s);
}

export interface ClaudeStats {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * TTL split of `cacheWriteTokens`. Invariant (test-enforced, not a DB
   * constraint): `cacheWrite5mTokens + cacheWrite1hTokens === cacheWriteTokens`.
   * When `usage.cache_creation` is absent, all cache-creation tokens go to the
   * 5m bucket.
   */
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  /**
   * Sum of `usage.server_tool_use.web_search_requests` over the same deduped
   * assistant responses the token totals are summed over. Billed **per request**
   * (`model_pricing.price_web_search`), not per million tokens. `web_fetch_requests`
   * is not billed and is deliberately not counted here.
   */
  webSearchRequests: number;
  /**
   * Fast-mode portions of `inputTokens` / `outputTokens` — **subsets**, not extra
   * tokens: `inputTokens` and `outputTokens` keep their grand-total semantics, so
   * `fast + standard === the per-category total` holds by construction and no
   * existing consumer shifts. A line counts as fast when `usage.speed === 'fast'`;
   * `speed` absent or `'standard'` contributes 0. Fast is priced at
   * `FAST_MODE_MULTIPLIER` × the standard rate, derived at cost time
   * (`server/src/logs/cost.sql.ts`) rather than stored. Only input and output are
   * speed-split — there is no distinct fast-mode cache rate.
   */
  inputTokensFast: number;
  outputTokensFast: number;
  workTimeMs: number;
  fileStatsByCategory: Record<string, { fileCount: number; byteCount: number }>;
  filesEditedWritten: number;
  linesChanged: number;
  imageCount: number;
  imageTotalBytes: number;
  mcpCallsTotal: number;
  mcpCallsByServer: Record<string, number>;
  /**
   * Diff-based productivity counters. Deliberately additive to `linesChanged` above,
   * which counts lines *written* by Edit/Write with no delta and no removals and keeps its
   * existing semantics and consumers untouched.
   */
  linesAdded: number;
  linesRemoved: number;
  commitCount: number;
  prCount: number;
  /** Number of user turns — the same prompt set work time is computed over. */
  turnCount: number;
  /**
   * Coverage of `linesAdded`/`linesRemoved`: how many Edit/Write calls carried a usable
   * payload, out of how many were made. Surfaced as "over N of M Edit/Write calls" rather
   * than guessing the remainder.
   */
  diffLinesCoveredCalls: number;
  diffLinesTotalCalls: number;
  /**
   * Change surface: one entry per raw `file_path` this session's Edit/Write calls
   * touched, with the same `{added, removed}` precedence chain the session-level
   * `linesAdded`/`linesRemoved` above are fed by — the two are
   * accumulated in the same loop precisely so they cannot disagree.
   *
   * Still *raw*: no repo root is known at extraction time, so nothing here is normalised.
   * `session-changed-paths-writer.ts` turns these into per-`path_key` rows once the root is
   * resolved, and re-does that from the stored `raw_path` when the root arrives later.
   */
  changedPaths: RawChangedPath[];
  /** Token totals per `usage.service_tier`; messages lacking the field key on 'unknown'. */
  tokenByServiceTier: Record<string, ServiceTierTokens>;
  /** One entry per distinct tool name used in this session. */
  toolStats: ToolStatRow[];
  /**
   * Harness usage: one `kind: 'tool'` row per distinct tool name called in this
   * session (built-in or MCP), with token attribution and the
   * `is_initial` vs. `deferred` inference, PLUS `kind: 'skill'`/
   * `'rule'` rows from real transcript trigger events (see
   * {@link extractHarnessSkillAndRuleUsage} — supersedes the original rule,
   * which counted a skill/rule as "used" merely for existing in the self-report).
   */
  harnessUsage: (HarnessToolUsageRow | HarnessSkillRuleUsageRow)[];
  /**
   * Claude Code CLI version that wrote this log: the highest valid version over every
   * line's string `version` field, whatever its `type` and including sidechain lines
   * (they are all written by the same CLI process). `null` when no line carries one.
   */
  claudeVersion: string | null;
  /**
   * Distinct non-empty `requestId`s of the log's `type==='assistant'` lines, in first-seen
   * order. Sidechain lines are included — the same set the migration
   * backfill reads — since a request id only ever needs to be found somewhere in the session
   * tree to mark the matching OTEL call as a transcript (non-utility) call.
   */
  requestIds: string[];
  /**
   * Per-call token counts (`session_call_tokens.calls`), columnar: index `i` of every
   * array is one deduplicated usage entry (`lastUsageByMessageId`, keyed by `message.id`
   * with a `uuid` fallback), in first-seen order. Filled in the same loop as the totals
   * above, so each array sums exactly to its aggregate. Used to price prompt-length tiers
   * per call.
   */
  callTokens: Required<SessionCallTokens>;
}

/** A `tool_use` block awaiting its matching `tool_result`, collected during the walk. */
interface PendingToolCall {
  id: string | null;
  name: string;
  /**
   * `message.id` (falling back to the line `uuid`) of the assistant response that issued
   * this block. One API response can be split across several transcript lines, one per
   * content block, so a parallel batch must be counted per *message*, not per line.
   */
  messageKey: string | null;
  assistantTs: number | null;
  /**
   * Diff counts recovered from this call's own `Edit`/`MultiEdit` input, used only when
   * the transcript carries no `toolUseResult.structuredPatch` for it (workflow-agent logs never
   * do). `null` for every other tool, and for an input the diff cannot be taken from. Captured
   * here rather than by retaining the raw input, so a long `new_string` is not held in memory
   * for the whole extraction.
   */
  editInputPatch: PatchLineCounts | null;
  /**
   * The Edit/Write call's own `input.file_path`, the raw spelling the tool used.
   * `null` for every other tool and for an edit call whose input carries no path.
   */
  filePath: string | null;
  /**
   * This call, on its own, creates the file: an `Edit` whose `old_string` was `''`
   * (source 3 of the change-kind chain). The two stronger sources — the
   * transcript's `toolUseResult.type === 'create'` and the hook record's `changeKind` — are
   * only available at join time, so they are applied there, not here.
   */
  createsFile: boolean;
}

/**
 * A per-call record the hook derived from `tool_response` and uploaded on its `PostToolUse`
 * artisyn event, already keyed by `tool_use_id` by `artisyn-extractor.ts`.
 *
 * It is source 2 of the line-count precedence chain and exists for one reason: a
 * workflow-agent transcript never carries a usable `toolUseResult`, so without it every
 * delegated edit is uncovered. It is an **input** to extraction, never a patch applied to an
 * already-computed row — a merged-in value would be erased by the very
 * next `recompute-all-sessions`.
 *
 * `added`/`removed` are `null` when the hook could not derive them (absent or over-cap
 * payload): the call then stays *uncovered* rather than being credited a fabricated `0/0`.
 */
export interface HookEditRecord {
  toolUseId: string;
  /** `null` = the root transcript; sub-agent calls carry the spawning agent's id. */
  agentId: string | null;
  added: number | null;
  removed: number | null;
  changeKind: 'added' | 'modified' | null;
  filePath: string | null;
}

/** The matching `tool_result` block plus the carrying user event's `toolUseResult`. */
interface ToolResultRecord {
  isError: boolean | null;
  text: string;
  resultTs: number | null;
  toolUseResult: AnyRecord | null;
  /** The result line's top-level `toolDenialKind`, when Claude Code recorded one. */
  denialKind: string | null;
}

/**
 * How much `tool_result` text to scan for a rejection marker.
 *
 * Every marker in `REJECTION_MARKERS` is sentence-initial — Claude Code emits the rejection
 * or permission notice as the whole result body, and the longest marker is under 50
 * characters — so 200 is comfortably enough to classify correctly.
 *
 * Kept deliberately small because this runs for *every* tool result on every upload, and a
 * real result can be megabytes of command output: at 4000 a log with ~900 Bash results
 * allocated ~3.6 MB of throwaway strings, which showed up on the `logs:upsert` perf scenario.
 */
const MAX_RESULT_TEXT_SCAN = 200;

/**
 * The first `MAX_RESULT_TEXT_SCAN` characters of a `tool_result`'s text (string content, or the
 * concatenated `text` blocks), for rejection detection. Also used by the tool-monitoring MCP
 * extractor for the same purpose.
 */
export function flattenToolResultText(content: unknown): string {
  if (typeof content === 'string')
    return content.slice(0, MAX_RESULT_TEXT_SCAN);
  const blocks = asArray(content);
  if (blocks === null) return '';
  let out = '';
  for (const item of blocks) {
    const b = asRecord(item);
    if (b === null || b['type'] !== 'text') continue;
    const text = asString(b['text']);
    if (text === null) continue;
    out += text;
    if (out.length >= MAX_RESULT_TEXT_SCAN) break;
  }
  return out.slice(0, MAX_RESULT_TEXT_SCAN);
}

function emptyServiceTierTokens(): ServiceTierTokens {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
  };
}

// ---------------------------------------------------------------------------
// Harness usage token attribution.
// ---------------------------------------------------------------------------

/**
 * Character-proportional token split: the one formula the FRs need
 * twice (skill/rule share of a turn's tokens; same-message multiple-`tool_use` share of
 * that message's tokens). Each part gets `Math.round(total * ownChars / sumChars)`; the
 * *last* part (by input order) absorbs the rounding remainder so the parts sum exactly to
 * `total` — the reconciliation invariant the AC requires. A single part always gets the
 * full total, regardless of its own `chars` (matching the single-`tool_use`
 * rule); `sumChars === 0` falls back to an even split across parts so a divide-by-zero
 * never occurs (e.g. every part reporting a zero byte size).
 */
export function splitTokensByCharacterShare(
  totalInput: number,
  totalOutput: number,
  parts: { key: string; chars: number }[],
): { key: string; inputTokens: number; outputTokens: number }[] {
  if (parts.length === 0) return [];

  const sumChars = parts.reduce((sum, p) => sum + p.chars, 0);

  const shares = parts.map((p) => {
    const fraction = sumChars > 0 ? p.chars / sumChars : 1 / parts.length;
    return {
      key: p.key,
      inputTokens: Math.round(totalInput * fraction),
      outputTokens: Math.round(totalOutput * fraction),
    };
  });

  const inputSum = shares.reduce((sum, s) => sum + s.inputTokens, 0);
  const outputSum = shares.reduce((sum, s) => sum + s.outputTokens, 0);
  const last = shares[shares.length - 1];
  last.inputTokens += totalInput - inputSum;
  last.outputTokens += totalOutput - outputSum;

  return shares;
}

/** One `session_harness_usage` row of `kind: 'tool'`, as produced by {@link extractHarnessUsage}. */
export interface HarnessToolUsageRow {
  kind: 'tool';
  name: string;
  /** Non-null only for `mcp__<server>__<tool>`-shaped names. */
  mcpServer: string | null;
  uses: number;
  inputTokens: number;
  outputTokens: number;
  /** Whether this tool's first `tool_use` in this session preceded its name appearing in a `deferred_tools_delta` attachment. */
  isInitial: boolean;
}

interface PendingHarnessToolUseBlock {
  name: string;
  chars: number;
  lineIndex: number;
}

/**
 * Builds `tool`-kind `session_harness_usage` rows from a `claude`/`claude-subagent`
 * transcript. Every distinct tool name called in the session
 * (built-in or `mcp__server__tool`) gets one row; `MCP`-kind rows are not produced here —
 * their use-count/tokens are the sum of their `tool`-kind children, computed at report time,
 * not stored redundantly.
 *
 * Token attribution: an assistant message with exactly one `tool_use` block
 * gets that message's full `usage.input_tokens`/`output_tokens`; a message with N blocks
 * splits its usage by {@link splitTokensByCharacterShare}, using each block's
 * `JSON.stringify(input).length` as its "chars" share. A `tool_result`'s content is not
 * separately billed, so no `tool_result` matching is needed for tokens.
 */
export function extractHarnessUsage(
  lines: object[],
  isSubagentLog: boolean = false,
): HarnessToolUsageRow[] {
  const { firstDeferredLineIndexByName } = walkDeferredToolsDelta(lines);

  // messageKey -> every tool_use block issued under that message, in transcript order.
  // A single API response can be split across several transcript lines (one per content
  // block), all repeating the same message.usage, so blocks are grouped by message before
  // the usage split is applied — mirroring extractClaudeStats' own message-usage dedup.
  const blocksByMessage = new Map<string, PendingHarnessToolUseBlock[]>();
  const usageByMessage = new Map<
    string,
    { inputTokens: number; outputTokens: number }
  >();
  lines.forEach((line, lineIndex) => {
    const rec = line as AnyRecord;
    if (rec['type'] !== 'assistant') return;
    if (!isSubagentLog && rec['isSidechain'] === true) return;

    const message = asRecord(rec['message']);
    const messageKey = asString(message?.['id']) ?? asString(rec['uuid']);
    if (messageKey === null) return;

    const usage = asRecord(message?.['usage']);
    // Last line wins: a sub-agent's first block line carries a partial mid-stream
    // `output_tokens` (see extractClaudeStats' lastUsageByMessageId).
    if (usage !== null) {
      usageByMessage.set(messageKey, {
        inputTokens: asNumber(usage['input_tokens']),
        outputTokens: asNumber(usage['output_tokens']),
      });
    }

    const content = asArray(message?.['content']);
    if (content === null) return;
    for (const block of content) {
      const b = asRecord(block);
      if (b === null || b['type'] !== 'tool_use') continue;
      const name = asString(b['name']);
      if (name === null) continue;

      const stringifiedInput = JSON.stringify(b['input']);
      const chars =
        typeof stringifiedInput === 'string' ? stringifiedInput.length : 0;

      const entry: PendingHarnessToolUseBlock = { name, chars, lineIndex };
      const existing = blocksByMessage.get(messageKey);
      if (existing === undefined) blocksByMessage.set(messageKey, [entry]);
      else existing.push(entry);
    }
  });

  const rows = new Map<
    string,
    {
      uses: number;
      inputTokens: number;
      outputTokens: number;
      firstLineIndex: number;
    }
  >();

  for (const [messageKey, blocks] of blocksByMessage) {
    const usage = usageByMessage.get(messageKey) ?? {
      inputTokens: 0,
      outputTokens: 0,
    };
    const shares = splitTokensByCharacterShare(
      usage.inputTokens,
      usage.outputTokens,
      blocks.map((b, idx) => ({ key: String(idx), chars: b.chars })),
    );

    blocks.forEach((block, idx) => {
      const share = shares[idx];
      let row = rows.get(block.name);
      if (row === undefined) {
        row = {
          uses: 0,
          inputTokens: 0,
          outputTokens: 0,
          firstLineIndex: block.lineIndex,
        };
        rows.set(block.name, row);
      }
      row.uses += 1;
      row.inputTokens += share.inputTokens;
      row.outputTokens += share.outputTokens;
      if (block.lineIndex < row.firstLineIndex) {
        row.firstLineIndex = block.lineIndex;
      }
    });
  }

  return [...rows.entries()].map(([name, row]) => ({
    kind: 'tool' as const,
    name,
    mcpServer: mcpServerOfTool(name),
    uses: row.uses,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    isInitial: inferToolIsInitial(
      row.firstLineIndex,
      firstDeferredLineIndexByName.get(name),
    ),
  }));
}

// ---------------------------------------------------------------------------
// Skill/rule usage from REAL transcript triggers.
//
// The original rule counted a skill/rule as "used" merely because it was
// present in the artisyn self-report's static inventory list — every skill/rule the repo
// has ever registered gets self-reported on every upload regardless of whether it was
// actually invoked, so every one of them ended up with the exact same `uses` count (the
// number of sessions with a self-report). This replaces that with real trigger detection:
// - `skill`: one row per skill NAME actually invoked via a `Skill`-tool `tool_use` block
//   (`input.skill`), client parity with `log-parser.ts`'s Skill-invocation detection.
// - `rule`: one row per `nested_memory` attachment event — `.claude/rules/*.md` files and
//   nested `CLAUDE.md` files alike, client parity with `log-parser.ts`'s
//   `extractRulesInjected`.
// Token cost is measured DIRECTLY from the actual injected content bytes (the child
// `isMeta` event for a skill invocation; the attachment's own `content.content` for a
// rule), not guessed via a proportional share of an unrelated turn's tokens.
// ---------------------------------------------------------------------------

/** One `session_harness_usage` row of kind `'skill'` or `'rule'`. */
export interface HarnessSkillRuleUsageRow {
  kind: 'skill' | 'rule';
  name: string;
  uses: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Default chars-per-token estimate for directly-measured injected content. Mirrors the
 * client's `BYTES_PER_TOKEN` default in `log-parser.ts` (used there for the exact same
 * skill/rule content, in the Session Log's Skills/Rules sections) so the two surfaces show
 * consistent numbers for the same underlying bytes. Deliberately NOT the admin-configurable
 * per-model `charsPerToken` override those sections can also use — like the MCP schema-size
 * `÷4` estimate elsewhere in this report, this is one fixed, coarse estimate.
 */
const HARNESS_CONTENT_BYTES_PER_TOKEN = 3.5;

function bytesOfUtf8(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Client parity: `log-parser.ts`'s `normalizeRuleName`. */
function normalizeInjectedRuleName(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return rawPath;
  const filename = parts[parts.length - 1].replace(/\.md$/i, '');
  if (filename.toUpperCase() === 'CLAUDE' && parts.length > 1) {
    return parts[parts.length - 2];
  }
  return filename;
}

/**
 * Builds `skill`/`rule`-kind `session_harness_usage` rows from real transcript trigger
 * events. A `Skill` `tool_use` block with no resolvable `input.skill` name is dropped
 * rather than miscounted — the generic built-in `Skill` tool's own `tool`-kind row (from
 * {@link extractHarnessUsage}) still records that the invocation mechanism itself ran.
 */
export function extractHarnessSkillAndRuleUsage(
  lines: object[],
  isSubagentLog: boolean = false,
): HarnessSkillRuleUsageRow[] {
  const records: AnyRecord[] = [];
  for (const line of lines) {
    const rec = asRecord(line);
    if (rec !== null) records.push(rec);
  }

  // Index every tool_result's carrying-event uuid by the tool_use_id it resolves, and every
  // event's immediate children — both needed to measure a Skill invocation's actual
  // injected content size (client parity: `extractSkillContentBytes` in `log-parser.ts`:
  // the content lands as a child `isMeta=true` user event following the tool_result).
  const toolResultUuidByCallId = new Map<string, string>();
  const childrenByParent = new Map<string, string[]>();
  const byUuid = new Map<string, AnyRecord>();
  for (const rec of records) {
    const uuid = asString(rec['uuid']);
    if (uuid !== null) {
      byUuid.set(uuid, rec);
      const parentUuid = asString(rec['parentUuid']);
      if (parentUuid !== null) {
        const list = childrenByParent.get(parentUuid);
        if (list) list.push(uuid);
        else childrenByParent.set(parentUuid, [uuid]);
      }
    }
    if (rec['type'] !== 'user' || uuid === null) continue;
    const content = asArray(asRecord(rec['message'])?.['content']);
    if (content === null) continue;
    for (const block of content) {
      const b = asRecord(block);
      if (b === null || b['type'] !== 'tool_result') continue;
      const toolUseId = asString(b['tool_use_id']);
      if (toolUseId !== null && !toolResultUuidByCallId.has(toolUseId)) {
        toolResultUuidByCallId.set(toolUseId, uuid);
      }
    }
  }

  function injectedContentBytes(toolCallId: string): number {
    const toolResultUuid = toolResultUuidByCallId.get(toolCallId);
    if (toolResultUuid === undefined) return 0;
    const children = childrenByParent.get(toolResultUuid) ?? [];
    let total = 0;
    for (const childUuid of children) {
      const child = byUuid.get(childUuid);
      if (child === undefined || child['type'] !== 'user') continue;
      if (child['isMeta'] !== true) continue;
      const content = asRecord(child['message'])?.['content'];
      if (typeof content === 'string') {
        total += bytesOfUtf8(content);
        continue;
      }
      const blocks = asArray(content);
      if (blocks === null) continue;
      for (const block of blocks) {
        const b = asRecord(block);
        if (
          b !== null &&
          b['type'] === 'text' &&
          typeof b['text'] === 'string'
        ) {
          total += bytesOfUtf8(b['text']);
        }
      }
    }
    return total;
  }

  interface PendingRow {
    kind: 'skill' | 'rule';
    name: string;
    uses: number;
    inputTokens: number;
  }
  const rows = new Map<string, PendingRow>();

  function addUse(kind: 'skill' | 'rule', name: string, bytes: number): void {
    const tokens =
      bytes > 0 ? Math.round(bytes / HARNESS_CONTENT_BYTES_PER_TOKEN) : 0;
    const key = `${kind}\0${name}`;
    const existing = rows.get(key);
    if (existing === undefined) {
      rows.set(key, { kind, name, uses: 1, inputTokens: tokens });
    } else {
      existing.uses += 1;
      existing.inputTokens += tokens;
    }
  }

  for (const rec of records) {
    if (rec['type'] !== 'assistant') continue;
    if (!isSubagentLog && rec['isSidechain'] === true) continue;
    const content = asArray(asRecord(rec['message'])?.['content']);
    if (content === null) continue;
    for (const block of content) {
      const b = asRecord(block);
      if (b === null || b['type'] !== 'tool_use') continue;
      if (asString(b['name']) !== 'Skill') continue;
      const input = asRecord(b['input']);
      const skillName = asString(input?.['skill']);
      if (skillName === null || skillName === '') continue;
      const toolId = asString(b['id']);
      const bytes = toolId !== null ? injectedContentBytes(toolId) : 0;
      addUse('skill', skillName, bytes);
    }
  }

  for (const rec of records) {
    if (rec['type'] !== 'attachment') continue;
    const attachment = asRecord(rec['attachment']);
    if (attachment === null || attachment['type'] !== 'nested_memory') continue;
    const rawPath =
      asString(attachment['displayPath']) ?? asString(attachment['path']);
    if (rawPath === null || rawPath === '') continue;
    const name = normalizeInjectedRuleName(rawPath);
    if (name === '') continue;

    const contentObj = asRecord(attachment['content']);
    const text = asString(contentObj?.['content']) ?? '';
    const bytes = text !== '' ? bytesOfUtf8(text) : 0;
    addUse('rule', name, bytes);
  }

  return [...rows.values()].map((row) => ({
    kind: row.kind,
    name: row.name,
    uses: row.uses,
    inputTokens: row.inputTokens,
    outputTokens: 0,
  }));
}

/**
 * `{added, removed}` from a hook-supplied record, or `null` when the hook could not derive
 * them — source 2 of the line-count precedence chain. Both sides must be numbers: a half-filled record is
 * not a diff, and reporting it as one would silently turn an uncovered call into a covered
 * `+0/−0`.
 */
function hookRecordCounts(
  record: HookEditRecord | null,
): PatchLineCounts | null {
  if (record === null) return null;
  if (typeof record.added !== 'number' || typeof record.removed !== 'number') {
    return null;
  }
  return { added: record.added, removed: record.removed };
}

/**
 * Extracts one session node's stats from its `claude` / `claude-subagent` transcript.
 *
 * `hookEditRecords` is the optional second *input*: the hook-derived per-call
 * `{added, removed, changeKind, filePath}` records for **this node**, keyed by
 * `tool_use_id` (`extractEditResultRecords()` + `selectEditResultRecordsForSession()` in
 * `artisyn-extractor.ts`). It is applied inside the join loop as source 2 of the
 * line-count precedence chain, so the session-level `linesAdded`/`linesRemoved` and the
 * per-path {@link ClaudeStats.changedPaths} rows are fed by one chain and cannot disagree.
 *
 * Omitting it — or passing an empty map, which is what an old hook install, an artisyn log
 * that has not been uploaded yet, or any node with no delegated edits all amount to —
 * behaves exactly as before: the native patch and the `tool_input` fallback still
 * apply, and a call neither covers stays uncovered.
 */
export function extractClaudeStats(
  lines: object[],
  repoRoot: string = '',
  isSubagentLog: boolean = false,
  hookEditRecords?: ReadonlyMap<string, HookEditRecord> | null,
): ClaudeStats {
  let model: string | null = null;
  // Fallback model read from a skipped sidechain (sub-agent) line, used only when
  // the root session log has no non-sidechain assistant activity of its own —
  // e.g. a pure Task-tool orchestrator session — so it isn't left as NULL /
  // bucketed as "unknown" in reporting.
  let sidechainModel: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let cacheWrite5mTokens = 0;
  let cacheWrite1hTokens = 0;
  let webSearchRequests = 0;
  let inputTokensFast = 0;
  let outputTokensFast = 0;
  const fileStatsByCategory: Record<
    string,
    { fileCount: number; byteCount: number }
  > = {};
  let filesEditedWritten = 0;
  let linesChanged = 0;
  let imageCount = 0;
  let imageTotalBytes = 0;
  const mcpCallsByServer: Record<string, number> = {};
  let commitCount = 0;
  let prCount = 0;
  const tokenByServiceTier: Record<string, ServiceTierTokens> = {};

  // Tool analytics. `tool_use` and its `tool_result` live in different events and can
  // appear in either order once a transcript has been compacted, so both sides are
  // collected during the single walk and joined after it.
  const toolCalls: PendingToolCall[] = [];
  const toolUseBlocksByMessage = new Map<string, number>();
  const toolResults = new Map<string, ToolResultRecord>();

  // promptId → earliest qualifying user event timestamp
  const promptMap = new Map<string, number>();

  // tool_use_id → category name for Read calls
  const readToolCalls = new Map<string, { category: string }>();

  // assistant timestamps for work time computation
  const assistantTimestamps: number[] = [];

  // One API response can be split across multiple transcript lines — one per
  // content block (thinking/tool_use/text) — each carrying a message.usage. The
  // usage is summed once per message id, from the message's LAST line: sub-agent
  // transcripts write the first block's line mid-stream, with a partial
  // `output_tokens` (e.g. 8 where the final line says 372), and only the last line
  // holds the final count. Input and cache counts are identical on every line.
  // Fall back to the line's own uuid when message.id is missing, so those lines
  // still count (nothing to dedupe them against). A Map keeps first-seen order.
  const lastUsageByMessageId = new Map<string, AnyRecord>();

  // Every line's string `version` counts towards the session's Claude Code version.
  const versions: string[] = [];

  // Distinct transcript request ids, sidechain lines included.
  const requestIds = new Set<string>();

  for (const line of lines) {
    const rec = line as AnyRecord;
    const lineVersion = rec['version'];
    if (typeof lineVersion === 'string') versions.push(lineVersion);
    const type = rec['type'];
    const message = asRecord(rec['message']);

    if (type === 'assistant') {
      const requestId = asString(rec['requestId']);
      if (requestId !== null && requestId !== '') requestIds.add(requestId);

      // isSidechain=true marks sub-agent proxy events embedded in the main session
      // log — skip them there to avoid double-counting. In a claude-subagent log,
      // all events carry isSidechain=true (they are the real API calls for that
      // sub-agent), so skip the filter when isSubagentLog=true.
      if (!isSubagentLog && rec['isSidechain'] === true) {
        if (sidechainModel === null && message !== null) {
          const m = asString(message['model']);
          if (m !== null && m !== '') sidechainModel = m;
        }
        continue;
      }

      // model
      if (model === null && message !== null) {
        const m = asString(message['model']);
        if (m !== null && m !== '') model = m;
      }

      // assistant timestamp for work time
      const ts = parseTs(rec['timestamp']);
      if (!isNaN(ts)) assistantTimestamps.push(ts);

      // tokens
      if (message !== null) {
        const usage = asRecord(message['usage']);
        if (usage !== null) {
          const usageKey =
            asString(message['id']) ??
            asString(rec['uuid']) ??
            `#line-${lastUsageByMessageId.size}`;
          lastUsageByMessageId.set(usageKey, usage);
        }
      }

      // tool calls from content[]
      const content = asArray(message?.['content']);
      if (content !== null) {
        for (const block of content) {
          const b = asRecord(block);
          if (b === null) continue;
          if (b['type'] !== 'tool_use') continue;

          const name = asString(b['name']);
          const toolId = asString(b['id']);
          const input = asRecord(b['input']);

          if (name === 'Read' && toolId !== null && input !== null) {
            const filePath = asString(input['file_path']);
            if (filePath !== null) {
              const relative = normaliseFilePath(filePath, repoRoot);
              const category = classifyFile(relative, DEFAULT_FILE_CATEGORIES);
              readToolCalls.set(toolId, { category });
              const entry = fileStatsByCategory[category] ?? {
                fileCount: 0,
                byteCount: 0,
              };
              entry.fileCount += 1;
              fileStatsByCategory[category] = entry;
            }
          }

          if (isEditWriteTool(name)) {
            filesEditedWritten += 1;
            if (name === 'Edit' && input !== null) {
              const newString = asString(input['new_string']);
              if (newString !== null && newString !== '') {
                linesChanged += newString.split('\n').length;
              }
            }
            if (name === 'Write' && input !== null) {
              const contentStr = asString(input['content']);
              if (contentStr !== null && contentStr !== '') {
                linesChanged += contentStr.split('\n').length;
              }
            }
            if (name === 'MultiEdit' && input !== null) {
              const edits = asArray(input['edits']);
              if (edits !== null) {
                for (const edit of edits) {
                  const e = asRecord(edit);
                  if (e === null) continue;
                  const newString = asString(e['new_string']);
                  if (newString !== null && newString !== '') {
                    linesChanged += newString.split('\n').length;
                  }
                }
              }
            }
          }

          if (name !== null && /^mcp__/.test(name)) {
            const segments = name.split('__');
            const serverName = segments[1];
            if (serverName) {
              mcpCallsByServer[serverName] =
                (mcpCallsByServer[serverName] ?? 0) + 1;
            }
          }

          // Every tool_use block is part of the ranking population — including
          // Read/Edit/Write/Glob/Skill/Task. `log-parser.ts`'s SKIP set tracks those
          // separately as file accesses and is deliberately NOT reused here.
          if (name !== null) {
            const messageKey =
              asString(message?.['id']) ?? asString(rec['uuid']);
            toolCalls.push({
              id: toolId,
              name,
              messageKey,
              assistantTs: isNaN(ts) ? null : ts,
              editInputPatch: isEditWriteTool(name)
                ? countEditInputPatchLines(name, input)
                : null,
              // The changed path, captured here rather than re-walked later: the
              // join loop below needs it in the same pass that resolves the call's diff, so
              // the per-path rows and the session totals come from one accumulation.
              filePath:
                isEditWriteTool(name) && input !== null
                  ? asString(input['file_path'])
                  : null,
              createsFile:
                name === 'Edit' && input !== null
                  ? asString(input['old_string']) === ''
                  : false,
            });
            if (messageKey !== null) {
              toolUseBlocksByMessage.set(
                messageKey,
                (toolUseBlocksByMessage.get(messageKey) ?? 0) + 1,
              );
            }

            if (name === 'Bash' && input !== null) {
              const command = asString(input['command']);
              if (command !== null) {
                commitCount += countCommits(command);
                prCount += countPullRequests(command);
              }
            }
          }
        }
      }
    }

    if (type === 'user') {
      // qualifying user events for work time
      const promptId = asString(rec['promptId']);
      const isMeta = rec['isMeta'];
      const toolUseResult = asRecord(rec['toolUseResult']);
      const denialKind = asString(rec['toolDenialKind']);
      const isSubagentResult =
        toolUseResult !== null && toolUseResult['agentId'] != null;

      if (
        promptId !== null &&
        !isMeta &&
        !isSubagentResult &&
        !isNonQualifyingPromptContent(message?.['content'])
      ) {
        const ts = parseTs(rec['timestamp']);
        if (!isNaN(ts)) {
          const existing = promptMap.get(promptId);
          if (existing === undefined || ts < existing) {
            promptMap.set(promptId, ts);
          }
        }
      }

      // tool results for Read byte counts
      const msgContent = asArray(message?.['content']);
      if (msgContent !== null) {
        for (const block of msgContent) {
          const b = asRecord(block);
          if (b === null) continue;
          if (b['type'] !== 'tool_result') continue;

          const toolUseId = asString(b['tool_use_id']);

          // Remember the result so the post-walk join can classify the call and
          // resolve its duration. First result wins — a compacted transcript can repeat a
          // block, and the earliest is the real one.
          if (toolUseId !== null && !toolResults.has(toolUseId)) {
            const resultTs = parseTs(rec['timestamp']);
            toolResults.set(toolUseId, {
              isError:
                typeof b['is_error'] === 'boolean' ? b['is_error'] : null,
              text: flattenToolResultText(b['content']),
              resultTs: isNaN(resultTs) ? null : resultTs,
              toolUseResult,
              denialKind,
            });
          }

          if (toolUseId !== null && readToolCalls.has(toolUseId)) {
            const bytes = computeToolResultBytes(b['content']);
            const info = readToolCalls.get(toolUseId)!;
            const entry = fileStatsByCategory[info.category] ?? {
              fileCount: 0,
              byteCount: 0,
            };
            entry.byteCount += bytes;
            fileStatsByCategory[info.category] = entry;
          }

          // image_count / image_total_bytes from nested content blocks
          const innerContent = asArray(b['content']);
          if (innerContent !== null) {
            for (const item of innerContent) {
              const img = asRecord(item);
              if (img === null || img['type'] !== 'image') continue;
              const source = asRecord(img['source']);
              if (source === null || source['type'] !== 'base64') continue;
              const data = asString(source['data']);
              if (data !== null) {
                imageCount += 1;
                imageTotalBytes += Math.floor((data.length * 3) / 4);
              }
            }
          }
        }
      }
    }
  }

  // Token totals, once per message from its last line (see lastUsageByMessageId).
  // The per-call arrays are filled from the very same values, so they sum to the totals.
  const callTokens: Required<SessionCallTokens> = {
    inputTokens: [],
    outputTokens: [],
    cacheReadTokens: [],
    cacheWrite5mTokens: [],
    cacheWrite1hTokens: [],
    inputTokensFast: [],
    outputTokensFast: [],
  };
  for (const usage of lastUsageByMessageId.values()) {
    inputTokens += asNumber(usage['input_tokens']);
    outputTokens += asNumber(usage['output_tokens']);
    cacheReadTokens += asNumber(usage['cache_read_input_tokens']);
    cacheWriteTokens += asNumber(usage['cache_creation_input_tokens']);
    const { write5m, write1h } = splitCacheCreationTokens(usage);
    cacheWrite5mTokens += write5m;
    cacheWrite1hTokens += write1h;

    const isFast = asString(usage['speed']) === 'fast';
    callTokens.inputTokens.push(asNumber(usage['input_tokens']));
    callTokens.outputTokens.push(asNumber(usage['output_tokens']));
    callTokens.cacheReadTokens.push(asNumber(usage['cache_read_input_tokens']));
    callTokens.cacheWrite5mTokens.push(write5m);
    callTokens.cacheWrite1hTokens.push(write1h);
    callTokens.inputTokensFast.push(
      isFast ? asNumber(usage['input_tokens']) : 0,
    );
    callTokens.outputTokensFast.push(
      isFast ? asNumber(usage['output_tokens']) : 0,
    );

    // Server-tool usage. Only web_search is billed (per request); web_fetch is not.
    const serverToolUse = asRecord(usage['server_tool_use']);
    if (serverToolUse !== null) {
      webSearchRequests += asNumber(serverToolUse['web_search_requests']);
    }

    // Fast mode is a *subset* of the totals above, not an addition to them:
    // the grand totals already include these tokens and stay untouched here.
    if (asString(usage['speed']) === 'fast') {
      inputTokensFast += asNumber(usage['input_tokens']);
      outputTokensFast += asNumber(usage['output_tokens']);
    }

    // Same per-message usage as the totals above, so the per-tier split always sums
    // back to them regardless of how many content-block lines a response spans.
    const tier = readServiceTier(usage);
    const bucket = tokenByServiceTier[tier] ?? emptyServiceTierTokens();
    bucket.input += asNumber(usage['input_tokens']);
    bucket.output += asNumber(usage['output_tokens']);
    bucket.cacheRead += asNumber(usage['cache_read_input_tokens']);
    bucket.cacheCreation += asNumber(usage['cache_creation_input_tokens']);
    bucket.cacheWrite5m += write5m;
    bucket.cacheWrite1h += write1h;
    tokenByServiceTier[tier] = bucket;
  }

  const workTimeMs = computeWorkTime(promptMap, assistantTimestamps);
  const mcpCallsTotal = Object.values(mcpCallsByServer).reduce(
    (sum, n) => sum + n,
    0,
  );

  // Join each collected tool_use to its tool_result: classify the outcome, resolve the
  // duration, and fold both into the per-tool row. Edit/Write calls additionally contribute
  // their diff-based line counts and their coverage.
  const toolStatRows = new Map<string, ToolStatRow>();
  let linesAdded = 0;
  let linesRemoved = 0;
  let diffLinesCoveredCalls = 0;
  let diffLinesTotalCalls = 0;
  // Raw `file_path` → its accumulated facts. Keyed on the verbatim spelling; two
  // spellings of one logical file are collapsed later, by `path_key`, once a repo root is
  // known. Aggregating here as well would need normalisation the
  // extractor deliberately cannot do.
  const changedPathAcc = new Map<string, RawChangedPath>();

  for (const call of toolCalls) {
    const result = call.id !== null ? (toolResults.get(call.id) ?? null) : null;
    const batchSize =
      call.messageKey !== null
        ? (toolUseBlocksByMessage.get(call.messageKey) ?? 1)
        : 1;

    const outcome = classifyToolOutcome(
      result === null
        ? null
        : {
            isError: result.isError,
            text: result.text,
            interrupted: result.toolUseResult?.['interrupted'] === true,
            denialKind: result.denialKind ?? undefined,
          },
    );
    const duration = resolveToolDuration({
      toolUseResult: result?.toolUseResult ?? null,
      assistantTs: call.assistantTs,
      resultTs: result?.resultTs ?? null,
    });

    let row = toolStatRows.get(call.name);
    if (row === undefined) {
      row = createToolStatRow(call.name);
      toolStatRows.set(call.name, row);
    }
    accumulateToolCall(row, outcome, duration, batchSize > 1);

    if (isEditWriteTool(call.name)) {
      diffLinesTotalCalls += 1;
      // The transcript's own patch wins; the input-derived diff is the fallback for a
      // log that carries no `toolUseResult` at all (workflow-agent logs never do). It is a real
      // diff of `old_string`/`new_string`, not a line count of the new text, so it reproduces
      // what the missing patch would have said — see `countEditInputPatchLines`. A call the
      // fallback cannot cover (notably any `Write`) still counts as uncovered.
      //
      // The fallback is gated on a *successful* outcome, which the native patch does not need to
      // be: a patch only exists because the edit applied, whereas an input is present even for a
      // call that was rejected, interrupted or errored. Without the gate those would start
      // contributing lines that never reached a file — and an unresolved call (no result at all)
      // would newly count as covered, which is a silent change to the coverage columns.
      //
      // Inserts the hook-supplied record between those two as source 2 of the
      // line-count precedence chain: it is the ONLY source for a workflow-agent transcript (no usable
      // `toolUseResult`, and its string form must never be parsed as a patch), and it needs
      // no success gate of its own — the record exists only because the tool returned. A
      // record whose counts the hook could not derive reports the call as *uncovered*, not
      // as `+0/−0`.
      const hookRecord =
        call.id !== null ? (hookEditRecords?.get(call.id) ?? null) : null;
      const counts =
        countPatchLines(result?.toolUseResult ?? null) ??
        hookRecordCounts(hookRecord) ??
        (outcome === 'success' ? call.editInputPatch : null);
      if (counts !== null) {
        diffLinesCoveredCalls += 1;
        linesAdded += counts.added;
        linesRemoved += counts.removed;
      }

      // Per-path accumulation off the SAME `counts`, so a path's `+`/`-` can never
      // disagree with the session total, and a call is credited to exactly one source.
      const filePath = call.filePath ?? hookRecord?.filePath ?? null;
      if (filePath !== null && filePath !== '') {
        let entry = changedPathAcc.get(filePath);
        if (entry === undefined) {
          entry = {
            rawPath: filePath,
            editCalls: 0,
            diffCoveredCalls: 0,
            linesAdded: 0,
            linesRemoved: 0,
            createdByAnyCall: false,
          };
          changedPathAcc.set(filePath, entry);
        }
        entry.editCalls += 1;
        if (counts !== null) {
          entry.diffCoveredCalls += 1;
          entry.linesAdded += counts.added;
          entry.linesRemoved += counts.removed;
        }
        // Three change-kind sources, in precedence order. Source 1 is
        // reachable only for an object-shaped `toolUseResult` — `toolResults` stores it
        // through `asRecord()`, so a string-form one is already `null` here.
        if (
          result?.toolUseResult?.['type'] === 'create' ||
          hookRecord?.changeKind === 'added' ||
          call.createsFile
        ) {
          entry.createdByAnyCall = true;
        }
      }
    }
  }

  return {
    model: model ?? sidechainModel,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheWrite5mTokens,
    cacheWrite1hTokens,
    webSearchRequests,
    inputTokensFast,
    outputTokensFast,
    workTimeMs,
    fileStatsByCategory,
    filesEditedWritten,
    linesChanged,
    imageCount,
    imageTotalBytes,
    mcpCallsTotal,
    mcpCallsByServer,
    linesAdded,
    linesRemoved,
    commitCount,
    prCount,
    turnCount: promptMap.size,
    diffLinesCoveredCalls,
    diffLinesTotalCalls,
    changedPaths: [...changedPathAcc.values()],
    tokenByServiceTier,
    toolStats: [...toolStatRows.values()],
    harnessUsage: [
      ...extractHarnessUsage(lines, isSubagentLog),
      ...extractHarnessSkillAndRuleUsage(lines, isSubagentLog),
    ],
    claudeVersion: maxVersion(versions),
    requestIds: [...requestIds],
    callTokens,
  };
}

/**
 * Per-category Read counts and bytes for `session_file_stats`.
 *
 * Each Read's `file_path` is normalised with {@link normaliseReadPath}, so file stats share
 * the change-surface root rules. `repoRoots` are the session's candidate roots (repo root
 * plus linked-worktree root, as `resolveSessionRepoRoots()` returns them). An empty array
 * means the root is unknown, and only then does classification fall back to
 * {@link normaliseFilePath}'s `KNOWN_TOP_LEVEL_DIRS` guess. A path outside every known root
 * stays absolute, so repo-relative patterns never match it.
 */
export function extractFileStatsByCategory(
  lines: object[],
  repoRoots: readonly string[],
  categories: FileCategory[],
): Record<string, { fileCount: number; byteCount: number }> {
  const result: Record<string, { fileCount: number; byteCount: number }> = {};

  // tool_use_id → category name for Read calls
  const readToolCalls = new Map<string, { category: string }>();

  for (const line of lines) {
    const rec = line as AnyRecord;
    const type = rec['type'];
    const message = asRecord(rec['message']);

    if (type === 'assistant') {
      const content = asArray(message?.['content']);
      if (content !== null) {
        for (const block of content) {
          const b = asRecord(block);
          if (b === null || b['type'] !== 'tool_use') continue;
          if (asString(b['name']) !== 'Read') continue;

          const toolId = asString(b['id']);
          const input = asRecord(b['input']);
          if (toolId === null || input === null) continue;

          const filePath = asString(input['file_path']);
          if (filePath === null) continue;

          const relative = normaliseReadPath(filePath, repoRoots);
          const category = classifyFile(relative, categories);
          readToolCalls.set(toolId, { category });

          const entry = result[category] ?? { fileCount: 0, byteCount: 0 };
          entry.fileCount += 1;
          result[category] = entry;
        }
      }
    }

    if (type === 'user') {
      const msgContent = asArray(message?.['content']);
      if (msgContent !== null) {
        for (const block of msgContent) {
          const b = asRecord(block);
          if (b === null || b['type'] !== 'tool_result') continue;

          const toolUseId = asString(b['tool_use_id']);
          if (toolUseId === null || !readToolCalls.has(toolUseId)) continue;

          const bytes = computeToolResultBytes(b['content']);
          const info = readToolCalls.get(toolUseId)!;
          const entry = result[info.category] ?? { fileCount: 0, byteCount: 0 };
          entry.byteCount += bytes;
          result[info.category] = entry;
        }
      }
    }
  }

  return result;
}

/**
 * Length (UTF-16 code units) of a `tool_result`'s text: string content, or the summed `text`
 * blocks; other blocks count 0. Also used by the tool-monitoring MCP extractor.
 */
export function computeToolResultBytes(content: unknown): number {
  if (typeof content === 'string') return content.length;
  const blocks = asArray(content);
  if (blocks === null) return 0;
  let total = 0;
  for (const item of blocks) {
    const b = asRecord(item);
    if (b === null || b['type'] !== 'text') continue;
    const text = asString(b['text']);
    if (text !== null) total += text.length;
  }
  return total;
}

function computeWorkTime(
  promptMap: Map<string, number>,
  assistantTimestamps: number[],
): number {
  if (promptMap.size === 0) return 0;

  const prompts = [...promptMap.values()].sort((a, b) => a - b);
  const sortedAssistantTs = [...assistantTimestamps].sort((a, b) => a - b);

  let totalMs = 0;

  for (let i = 0; i < prompts.length; i++) {
    const promptTs = prompts[i];
    const nextPromptTs = i + 1 < prompts.length ? prompts[i + 1] : null;

    let maxAssistantTs: number | null = null;
    for (const ts of sortedAssistantTs) {
      if (ts <= promptTs) continue;
      if (nextPromptTs !== null && ts > nextPromptTs) continue;
      if (maxAssistantTs === null || ts > maxAssistantTs) {
        maxAssistantTs = ts;
      }
    }

    if (maxAssistantTs !== null) {
      totalMs += maxAssistantTs - promptTs;
    }
  }

  return totalMs;
}
