/**
 * Tools/MCP monitoring — transcript tool calls and MCP call extraction (FR-3; impl-plan DD-9,
 * DD-10, DD-12).
 *
 * {@link collectToolUses} walks one `claude` / `claude-subagent` transcript (one tree node) and
 * returns its `tool_use` blocks in transcript order, each joined to its `tool_result`. The tree
 * builder uses it for the CLI calls (Bash / PowerShell) and the usefulness signals as well.
 *
 * {@link extractMcpCalls} turns the node's `mcp__<server>__<rest>` calls into DD-10 call records
 * plus their DD-9 outputs:
 * - `tool` = `<server>` (segment 1), `operation` = the remaining segments joined with `__`;
 * - status (via `classifyToolOutcome`): no `tool_result` → `no_result`; `is_error: true`
 *   (a failure or a rejection) → `error`; anything else → `ok`;
 * - duration via `resolveToolDuration`;
 * - the agent-saw text is the result's text blocks joined with `\n`, other blocks as
 *   `[image]` / `[<type>]` placeholders, clamped to `CAPTURE_LIMIT_BYTES` (hint `truncated`);
 *   `outBytes` / `agentSawBytes` are `computeToolResultBytes` of the result;
 * - hints: `empty` (result text empty after trimming), `persisted` (Claude Code saved the output
 *   to a file, `<persisted-output>`), `truncated`.
 * - Sidechain lines of a root log belong to a sub-agent and are skipped; a repeated `tool_use`
 *   id counts once, and the first `tool_result` of an id wins (as `okf-access-extractor.ts`).
 *
 * Pure: no DB, no Nest.
 */
import {
  computeToolResultBytes,
  flattenToolResultText,
} from '../claude-extractor';
import { classifyToolOutcome, resolveToolDuration } from '../tool-stats';
import type {
  ToolCallAgentKind,
  ToolCallHint,
  ToolCallOutput,
  ToolCallRecord,
  ToolCallStatus,
} from '../../database/schema/index';
import { INPUT_PREVIEW_CHARS } from './tool-usage.constants';
import { clampUtf8 } from './tool-calls-log';

type AnyRecord = Record<string, unknown>;

function asRecord(v: unknown): AnyRecord | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as AnyRecord)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function parseTs(v: unknown): number | null {
  const s = asString(v);
  if (s === null) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/** The node a transcript belongs to (supplied by the tree builder). */
export interface ToolUseNodeMeta {
  /** Sub-agent / workflow agent id of the node; null for the root. */
  agentId: string | null;
  agentKind: ToolCallAgentKind;
  /**
   * `true` for a `claude-subagent` log, whose every line is a sidechain line. In a root log,
   * `isSidechain` lines belong to a sub-agent and are skipped.
   */
  isSubagentLog: boolean;
}

/** The `tool_result` a `tool_use` got. */
export interface TranscriptToolResult {
  /** `tool_result.is_error`, null when absent. */
  isError: boolean | null;
  /** The raw `tool_result.content`. */
  content: unknown;
  /** Full result text: `text` blocks joined with `\n`, other blocks as placeholders. */
  text: string;
  /** Epoch ms of the user line carrying the result. */
  resultTs: number | null;
  /** The carrying user line's `toolUseResult` object. */
  toolUseResult: AnyRecord | null;
  /** The carrying user line's `toolDenialKind`. */
  denialKind: string | null;
}

/** One `tool_use` of a node, in transcript order. */
export interface TranscriptToolUse {
  /** `tool_use.id`; null when the block has none. */
  id: string | null;
  name: string;
  input: AnyRecord;
  /** Epoch ms of the assistant line; null when it has no parseable timestamp. */
  ts: number | null;
  /** The last `cwd` seen at or before the assistant line. */
  cwd: string | null;
  /** 0-based position among the node's tool_uses (stable key for an id-less block). */
  seq: number;
  result: TranscriptToolResult | null;
}

/**
 * The full text of a `tool_result` content: string content as is, `text` blocks joined with
 * `\n`, an `image` block as `[image]`, any other block as `[<type>]`.
 */
export function toolResultFullText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    const b = asRecord(item);
    if (b === null) continue;
    const type = asString(b['type']) ?? 'unknown';
    if (type === 'text') {
      const text = asString(b['text']);
      if (text !== null) parts.push(text);
    } else {
      parts.push(`[${type}]`);
    }
  }
  return parts.join('\n');
}

/**
 * The node's `tool_use` blocks in transcript order, each joined to its first `tool_result`.
 * Sidechain lines of a root log are skipped; a repeated `tool_use` id counts once.
 */
export function collectToolUses(
  entries: readonly object[],
  options: { isSubagentLog?: boolean } = {},
): TranscriptToolUse[] {
  const isSubagentLog = options.isSubagentLog === true;
  const visible = entries.filter(
    (line) => isSubagentLog || (line as AnyRecord)['isSidechain'] !== true,
  );

  // Pass 1: the first tool_result per tool_use id.
  const results = new Map<string, TranscriptToolResult>();
  for (const line of visible) {
    const rec = line as AnyRecord;
    if (rec['type'] !== 'user') continue;
    const content = asRecord(rec['message'])?.['content'];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = asRecord(block);
      if (b === null || b['type'] !== 'tool_result') continue;
      const id = asString(b['tool_use_id']);
      if (id === null || results.has(id)) continue;
      const isError = b['is_error'];
      results.set(id, {
        isError: typeof isError === 'boolean' ? isError : null,
        content: b['content'],
        text: toolResultFullText(b['content']),
        resultTs: parseTs(rec['timestamp']),
        toolUseResult: asRecord(rec['toolUseResult']),
        denialKind: asString(rec['toolDenialKind']),
      });
    }
  }

  // Pass 2: tool_use blocks in transcript order.
  const out: TranscriptToolUse[] = [];
  const seenIds = new Set<string>();
  let cwd: string | null = null;
  for (const line of visible) {
    const rec = line as AnyRecord;
    const lineCwd = asString(rec['cwd']);
    if (lineCwd !== null && lineCwd !== '') cwd = lineCwd;
    if (rec['type'] !== 'assistant') continue;
    const content = asRecord(rec['message'])?.['content'];
    if (!Array.isArray(content)) continue;
    const ts = parseTs(rec['timestamp']);
    for (const block of content) {
      const b = asRecord(block);
      if (b === null || b['type'] !== 'tool_use') continue;
      const id = asString(b['id']);
      if (id !== null) {
        if (seenIds.has(id)) continue;
        seenIds.add(id);
      }
      const name = asString(b['name']);
      if (name === null || name === '') continue;
      out.push({
        id,
        name,
        input: asRecord(b['input']) ?? {},
        ts,
        cwd,
        seq: out.length,
        result: id === null ? null : (results.get(id) ?? null),
      });
    }
  }
  return out;
}

/** `{ server, operation }` of an `mcp__<server>__<rest>` tool name, else null. */
export function parseMcpToolName(
  name: string,
): { server: string; operation: string } | null {
  if (!name.startsWith('mcp__')) return null;
  const segments = name.slice('mcp__'.length).split('__');
  if (segments.length < 2) return null;
  const server = segments[0];
  const operation = segments.slice(1).join('__');
  if (server === '' || operation === '') return null;
  return { server, operation };
}

/**
 * The DD-10 status of a transcript call (`classifyToolOutcome`): no result → `no_result`;
 * `is_error: true` → `error` (a rejection too); anything else → `ok`.
 */
export function transcriptCallStatus(
  result: TranscriptToolResult | null,
): ToolCallStatus {
  if (result === null) return 'no_result';
  const outcome = classifyToolOutcome({
    isError: result.isError,
    text: flattenToolResultText(result.content),
    interrupted: result.toolUseResult?.['interrupted'] === true,
    denialKind: result.denialKind ?? undefined,
  });
  if (outcome === 'failure' || result.isError === true) return 'error';
  return 'ok';
}

/** Duration of a transcript call in whole ms (`resolveToolDuration`), or null. */
export function transcriptCallDurationMs(
  use: TranscriptToolUse,
): number | null {
  const resolved = resolveToolDuration({
    toolUseResult: use.result?.toolUseResult ?? null,
    assistantTs: use.ts,
    resultTs: use.result?.resultTs ?? null,
  });
  return resolved === null ? null : Math.round(resolved.ms);
}

/** Claude Code's marker for a tool output it saved to a file instead of the transcript. */
const PERSISTED_OUTPUT_MARKER = '<persisted-output>';

/** One extracted MCP call: its DD-10 record and its DD-9 output. */
export interface ExtractedMcpCall {
  call: ToolCallRecord;
  output: ToolCallOutput;
}

/**
 * The node's MCP calls in transcript order. `signals` are left empty: the tree builder fills
 * them with `computeSignals` (it needs the whole agent's call order). A call without its own
 * timestamp takes the last earlier one of the node (else the epoch).
 */
export function extractMcpCalls(
  entries: readonly object[],
  nodeMeta: ToolUseNodeMeta,
): ExtractedMcpCall[] {
  const uses = collectToolUses(entries, {
    isSubagentLog: nodeMeta.isSubagentLog,
  });
  const out: ExtractedMcpCall[] = [];
  let lastTs = 0;
  for (const use of uses) {
    if (use.ts !== null) lastTs = use.ts;
    const parsed = parseMcpToolName(use.name);
    if (parsed === null) continue;

    const inputJson = JSON.stringify(use.input);
    const input = clampUtf8(inputJson);
    const result = use.result;
    const agentSaw = result === null ? null : clampUtf8(result.text);
    const outBytes =
      result === null ? 0 : computeToolResultBytes(result.content);

    const hints: ToolCallHint[] = [];
    if (agentSaw?.clamped === true || input.clamped) hints.push('truncated');
    if (result !== null && result.text.trim() === '') hints.push('empty');
    if (result !== null && result.text.includes(PERSISTED_OUTPUT_MARKER)) {
      hints.push('persisted');
    }

    const output: ToolCallOutput = { input: input.text, encoding: 'utf8' };
    if (agentSaw !== null) output.agentSaw = agentSaw.text;

    out.push({
      call: {
        callId: use.id ?? `mcp-${use.seq}`,
        channel: 'mcp',
        tool: parsed.server,
        operation: parsed.operation,
        ts: new Date(use.ts ?? lastTs).toISOString(),
        durationMs: transcriptCallDurationMs(use),
        status: transcriptCallStatus(result),
        hints,
        source: 'transcript',
        shell: null,
        exitCode: null,
        inBytes: Buffer.byteLength(inputJson, 'utf8'),
        outBytes,
        agentSawBytes: result === null ? null : outBytes,
        toolUseId: use.id,
        agentId: nodeMeta.agentId,
        agentKind: nodeMeta.agentKind,
        inputPreview: inputJson.slice(0, INPUT_PREVIEW_CHARS),
        real: null,
        cwd: null,
        args: null,
        signals: [],
      },
      output,
    });
  }
  return out;
}
