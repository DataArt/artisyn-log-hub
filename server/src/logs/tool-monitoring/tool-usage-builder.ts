/**
 * Tools/MCP monitoring — builds the `session_tool_usage` rows of one session tree (impl-plan
 * DD-8 to DD-11).
 *
 * Inputs: every node's transcript (`claude` / `claude-subagent` lines), the tree's parsed
 * `tool-calls` log (wrapper records, may be absent) and the owner's monitored tool names.
 *
 * - MCP calls come from `extractMcpCalls` per node.
 * - CLI calls: recognised tools = monitored names ∪ tool names present in wrapper records. Every
 *   Bash / PowerShell `tool_use` is scanned with `recognizeCliCalls`; the wrapper records are then
 *   joined to those invocations with `matchWrapperRecords`:
 *   - matched → `source: 'both'` (the wrapper's figures, the transcript's `toolUseId`);
 *   - unmatched record → `source: 'wrapper'`, hint `indirect`, owned by the tree root;
 *   - invocation without a record → `source: 'transcript'`, hint `no_wrapper`.
 * - Signals (FR-5) are computed per agent (= tree node) over its ordered `tool_use`s.
 * - Rows: one per (node, channel, tool), each row owned by the node whose transcript holds the
 *   call; `calls` sorted by `ts`, `aggregates` per operation (DD-11), `outputs` keyed by `callId`
 *   (DD-9; `encoding` describes `stdin` / `stdout` / `stderr`, while `input` and `agentSaw` are
 *   always UTF-8 text).
 *
 * Pure: no DB, no Nest.
 */
import type { BashParser } from '@loghub/bash-view';
import { normalizeToolName } from '@loghub/tool-monitor';
import type {
  ToolCallAgentKind,
  ToolCallHint,
  ToolCallOutput,
  ToolCallOutputs,
  ToolCallRecord,
  ToolCallShell,
  ToolCallStatus,
  ToolUsageAggregates,
  ToolUsageChannel,
  ToolUsageOperationAggregate,
} from '../../database/schema/index';
import {
  commandWordsOf,
  operationOfArgs,
  recognizeCliCalls,
  type RecognizedCliCall,
} from './cli-command-recognition';
import {
  collectToolUses,
  extractMcpCalls,
  parseMcpToolName,
  transcriptCallDurationMs,
  transcriptCallStatus,
  type TranscriptToolUse,
} from './mcp-call-extractor';
import { computeSignals, type SignalToolUse } from './tool-call-signals';
import {
  clampUtf8,
  type ParsedToolCallsLog,
  type WrapperCallRecord,
} from './tool-calls-log';
import { INPUT_PREVIEW_CHARS } from './tool-usage.constants';
import {
  matchWrapperRecords,
  type TranscriptCliCall,
} from './wrapper-record-matching';

/** One node of the tree with its transcript lines. */
export interface ToolUsageTreeNode {
  /** `sessions.id` of the node. */
  sessionRowId: number;
  /** True for the tree root (unmatched wrapper records belong to it). */
  isRoot: boolean;
  /** Sub-agent / workflow agent id of the node; null for the root. */
  agentId: string | null;
  agentKind: ToolCallAgentKind;
  /** The node's transcript is a `claude-subagent` log (every line is a sidechain line). */
  isSubagentLog: boolean;
  /** The node's transcript lines (empty when it has none yet). */
  entries: readonly object[];
}

/** One `session_tool_usage` row to insert. */
export interface ToolUsageRow {
  sessionId: number;
  channel: ToolUsageChannel;
  tool: string;
  callCount: number;
  firstCallAt: Date | null;
  lastCallAt: Date | null;
  hasWrapperData: boolean;
  aggregates: ToolUsageAggregates;
  calls: ToolCallRecord[];
  outputs: ToolCallOutputs | null;
}

export interface BuildTreeToolUsageOptions {
  /** The tree-sitter bash parser (`getServerBashParser()`); null falls back to the tokenizer. */
  parser?: BashParser | null;
}

const SHELL_TOOL_NAMES: Record<string, ToolCallShell> = {
  Bash: 'bash',
  PowerShell: 'powershell',
};

/** The exit code of a process killed by SIGPIPE (128 + 13). */
const SIGPIPE_EXIT_CODE = 141;

interface BuiltCall {
  nodeRowId: number;
  call: ToolCallRecord;
  output: ToolCallOutput | null;
}

/** Per node: its tool_uses, the signal view of them and the use index by `tool_use` id. */
interface NodeScan {
  node: ToolUsageTreeNode;
  uses: TranscriptToolUse[];
  signalUses: SignalToolUse[];
  indexById: Map<string, number>;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function shellOf(use: TranscriptToolUse): ToolCallShell | null {
  return SHELL_TOOL_NAMES[use.name] ?? null;
}

function commandOf(use: TranscriptToolUse): string {
  return asString(use.input['command']) ?? '';
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** The DD-10 status of a wrapper record. */
export function wrapperCallStatus(record: WrapperCallRecord): ToolCallStatus {
  if (record.exitCode === null) {
    // No exit record: the call never finished (killed) unless it reported an end anyway.
    return record.endedAt === null ? 'killed' : 'ok';
  }
  if (record.exitCode === 0) return 'ok';
  // `zz | head -1`: the consumer closed the pipe, so the tool died of SIGPIPE — not an error.
  if (record.consumerClosed && record.exitCode === SIGPIPE_EXIT_CODE) {
    return 'ok';
  }
  return 'error';
}

function wrapperText(record: WrapperCallRecord): string | null {
  if (record.capture !== 'full' || record.textDropped) return null;
  if (record.encoding !== 'utf8') return null;
  return [record.stdout ?? '', record.stderr ?? ''].join('');
}

function wrapperOutput(
  record: WrapperCallRecord,
  input: string | null,
  agentSaw: string | null,
): ToolCallOutput | null {
  const output: ToolCallOutput = { encoding: record.encoding };
  if (input !== null) output.input = clampUtf8(input).text;
  if (record.stdin !== undefined) output.stdin = record.stdin;
  if (record.stdout !== undefined) output.stdout = record.stdout;
  if (record.stderr !== undefined) output.stderr = record.stderr;
  if (agentSaw !== null) output.agentSaw = clampUtf8(agentSaw).text;
  return Object.keys(output).length > 1 ? output : null;
}

function wrapperHints(
  record: WrapperCallRecord,
  cut: boolean,
  extra: ToolCallHint[],
): ToolCallHint[] {
  const hints: ToolCallHint[] = [...extra];
  if (cut) hints.push('cut');
  if (record.truncated || record.textClamped) hints.push('truncated');
  const text = wrapperText(record);
  if (text !== null && text.trim() === '') hints.push('empty');
  return hints;
}

function scanNode(
  node: ToolUsageTreeNode,
  parser: BashParser | null,
  toolNames: readonly string[],
): NodeScan & { recognizedByIndex: Map<number, RecognizedCliCall[]> } {
  const uses = collectToolUses(node.entries, {
    isSubagentLog: node.isSubagentLog,
  });
  const indexById = new Map<string, number>();
  const recognizedByIndex = new Map<number, RecognizedCliCall[]>();
  const signalUses: SignalToolUse[] = uses.map((use, i) => {
    if (use.id !== null) indexById.set(use.id, i);
    const shell = shellOf(use);
    const output = use.result === null ? null : use.result.text;
    if (shell !== null) {
      const command = commandOf(use);
      const recognized = recognizeCliCalls(parser, command, shell, toolNames);
      if (recognized.length > 0) recognizedByIndex.set(i, recognized);
      return {
        name: use.name,
        calls: recognized.map((r) => ({
          tool: r.tool,
          operation: r.operation,
        })),
        commandWords: commandWordsOf(parser, command, shell),
        filePath: null,
        output,
      };
    }
    const mcp = parseMcpToolName(use.name);
    return {
      name: use.name,
      calls:
        mcp === null ? [] : [{ tool: mcp.server, operation: mcp.operation }],
      commandWords: [],
      filePath: asString(use.input['file_path']),
      output,
    };
  });
  return { node, uses, signalUses, indexById, recognizedByIndex };
}

function emptyOperationAggregate(): ToolUsageOperationAggregate {
  return {
    calls: 0,
    errors: 0,
    killed: 0,
    noResult: 0,
    empty: 0,
    retried: 0,
    fellBack: 0,
    openedFile: 0,
    durationMsSum: 0,
    durationCount: 0,
    inBytesSum: 0,
    outBytesSum: 0,
    lastTs: null,
  };
}

/** DD-11 per-operation totals of a row's calls. */
export function aggregateCalls(
  calls: readonly ToolCallRecord[],
): ToolUsageAggregates {
  const operations: Record<string, ToolUsageOperationAggregate> = {};
  for (const call of calls) {
    const agg = (operations[call.operation] ??= emptyOperationAggregate());
    agg.calls++;
    if (call.status === 'error') agg.errors++;
    if (call.status === 'killed') agg.killed++;
    if (call.status === 'no_result') agg.noResult++;
    if (call.signals.includes('empty')) agg.empty++;
    if (call.signals.includes('retried')) agg.retried++;
    if (call.signals.includes('fell_back')) agg.fellBack++;
    if (call.signals.includes('opened_file')) agg.openedFile++;
    if (call.durationMs !== null) {
      agg.durationMsSum += call.durationMs;
      agg.durationCount++;
    }
    agg.inBytesSum += call.inBytes;
    agg.outBytesSum += call.outBytes;
    if (agg.lastTs === null || call.ts > agg.lastTs) agg.lastTs = call.ts;
  }
  return { operations };
}

function compareCalls(a: ToolCallRecord, b: ToolCallRecord): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  return a.callId < b.callId ? -1 : a.callId > b.callId ? 1 : 0;
}

function groupRows(built: readonly BuiltCall[]): ToolUsageRow[] {
  const groups = new Map<string, BuiltCall[]>();
  for (const b of built) {
    const key = `${b.nodeRowId}\u0000${b.call.channel}\u0000${b.call.tool}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [b]);
    else list.push(b);
  }

  const rows: ToolUsageRow[] = [];
  for (const list of groups.values()) {
    const calls = list.map((b) => b.call).sort(compareCalls);
    const outputs: ToolCallOutputs = {};
    for (const b of list) {
      if (b.output !== null) outputs[b.call.callId] = b.output;
    }
    const first = calls[0];
    const last = calls[calls.length - 1];
    rows.push({
      sessionId: list[0].nodeRowId,
      channel: first.channel,
      tool: first.tool,
      callCount: calls.length,
      firstCallAt: new Date(first.ts),
      lastCallAt: new Date(last.ts),
      hasWrapperData: calls.some((c) => c.source !== 'transcript'),
      aggregates: aggregateCalls(calls),
      calls,
      outputs: Object.keys(outputs).length > 0 ? outputs : null,
    });
  }
  rows.sort(
    (a, b) =>
      a.sessionId - b.sessionId ||
      a.channel.localeCompare(b.channel) ||
      a.tool.localeCompare(b.tool),
  );
  return rows;
}

/**
 * The `session_tool_usage` rows of one tree (rules above). `monitored` are the owner's enabled
 * monitored CLI tool names (an empty list when the tree has no linked repository yet).
 */
export function buildTreeToolUsage(
  nodes: readonly ToolUsageTreeNode[],
  toolCallsLog: ParsedToolCallsLog | null,
  monitored: readonly string[],
  options: BuildTreeToolUsageOptions = {},
): ToolUsageRow[] {
  const parser = options.parser ?? null;
  const records = toolCallsLog?.calls ?? [];

  // Recognised CLI tool names, first spelling wins (monitored names before record names).
  const toolNameByKey = new Map<string, string>();
  for (const name of [...monitored, ...records.map((r) => r.tool)]) {
    const key = normalizeToolName(name);
    if (key !== '' && !toolNameByKey.has(key)) toolNameByKey.set(key, name);
  }
  const toolNames = [...toolNameByKey.values()];
  const canonicalTool = (name: string) =>
    toolNameByKey.get(normalizeToolName(name)) ?? name;

  const built: BuiltCall[] = [];
  const scans = nodes.map((node) => scanNode(node, parser, toolNames));
  const root = nodes.find((n) => n.isRoot) ?? nodes[0];

  // MCP calls, per node.
  for (const scan of scans) {
    const { node } = scan;
    for (const { call, output } of extractMcpCalls(node.entries, node)) {
      const index =
        call.toolUseId !== null
          ? scan.indexById.get(call.toolUseId)
          : Number(call.callId.slice('mcp-'.length));
      const signals =
        index === undefined || !Number.isInteger(index)
          ? []
          : computeSignals(scan.signalUses, index);
      built.push({
        nodeRowId: node.sessionRowId,
        call: { ...call, signals },
        output,
      });
    }
  }

  // CLI invocations of every node, joined to the wrapper records.
  const owners = new Map<
    TranscriptCliCall,
    { scan: NodeScan; index: number }
  >();
  const transcriptCliCalls: TranscriptCliCall[] = [];
  for (const scan of scans) {
    for (const [index, recognized] of scan.recognizedByIndex) {
      const use = scan.uses[index];
      if (use.id === null) continue;
      const cliCall: TranscriptCliCall = {
        toolUseId: use.id,
        ts: use.ts,
        resultTs: use.result?.resultTs ?? null,
        recognized,
        agentSawBytes: use.result === null ? null : utf8Bytes(use.result.text),
      };
      owners.set(cliCall, { scan, index });
      transcriptCliCalls.push(cliCall);
    }
  }
  const match = matchWrapperRecords(records, transcriptCliCalls);

  for (const m of match.matched) {
    const owner = owners.get(m.call);
    if (owner === undefined) continue;
    const { scan, index } = owner;
    const use = scan.uses[index];
    const record = m.record;
    const tool = canonicalTool(m.call.recognized[m.slot].tool);
    const operation = operationOfArgs(record.args);
    const command = commandOf(use);
    const agentSaw = use.result === null ? null : use.result.text;
    built.push({
      nodeRowId: scan.node.sessionRowId,
      call: {
        callId: record.callId,
        channel: 'cli',
        tool,
        operation,
        ts: record.startedAt,
        durationMs: record.durationMs ?? transcriptCallDurationMs(use),
        status: wrapperCallStatus(record),
        hints: wrapperHints(record, m.cut, []),
        source: 'both',
        shell: record.shell ?? shellOf(use),
        exitCode: record.exitCode,
        inBytes: record.bytes.stdin + utf8Bytes(record.args.join(' ')),
        outBytes: record.bytes.stdout + record.bytes.stderr,
        agentSawBytes: m.call.agentSawBytes,
        toolUseId: m.call.toolUseId,
        agentId: scan.node.agentId,
        agentKind: scan.node.agentKind,
        inputPreview: command.slice(0, INPUT_PREVIEW_CHARS),
        real: record.real,
        cwd: record.cwd ?? use.cwd,
        args: record.args,
        signals: computeSignals(scan.signalUses, index, {
          tool,
          operation,
          output: wrapperText(record) ?? agentSaw,
        }),
      },
      output: wrapperOutput(record, command, agentSaw),
    });
  }

  if (root !== undefined) {
    for (const ind of match.indirect) {
      const record = ind.record;
      const tool = canonicalTool(record.tool);
      const commandLine = [record.tool, ...record.args].join(' ');
      const text = wrapperText(record);
      built.push({
        nodeRowId: root.sessionRowId,
        call: {
          callId: record.callId,
          channel: 'cli',
          tool,
          operation: operationOfArgs(record.args),
          ts: record.startedAt,
          durationMs: record.durationMs,
          status: wrapperCallStatus(record),
          hints: wrapperHints(record, ind.cut, ['indirect']),
          source: 'wrapper',
          shell: record.shell,
          exitCode: record.exitCode,
          inBytes: record.bytes.stdin + utf8Bytes(record.args.join(' ')),
          outBytes: record.bytes.stdout + record.bytes.stderr,
          agentSawBytes: null,
          toolUseId: ind.toolUseId,
          agentId: root.agentId,
          agentKind: root.agentKind,
          inputPreview: commandLine.slice(0, INPUT_PREVIEW_CHARS),
          real: record.real,
          cwd: record.cwd,
          args: record.args,
          signals: text !== null && text.trim() === '' ? ['empty'] : [],
        },
        output: wrapperOutput(record, null, null),
      });
    }
  }

  for (const t of match.transcriptOnly) {
    const owner = owners.get(t.call);
    if (owner === undefined) continue;
    const { scan, index } = owner;
    const use = scan.uses[index];
    const tool = canonicalTool(t.recognized.tool);
    const command = commandOf(use);
    const result = use.result;
    const hints: ToolCallHint[] = ['no_wrapper'];
    if (result !== null && result.text.trim() === '') hints.push('empty');
    const output: ToolCallOutput = {
      input: clampUtf8(command).text,
      encoding: 'utf8',
    };
    if (result !== null) {
      const saw = clampUtf8(result.text);
      output.agentSaw = saw.text;
      if (saw.clamped) hints.push('truncated');
    }
    built.push({
      nodeRowId: scan.node.sessionRowId,
      call: {
        callId: `${t.call.toolUseId}:${t.slot}`,
        channel: 'cli',
        tool,
        operation: t.recognized.operation,
        ts: new Date(use.ts ?? 0).toISOString(),
        durationMs: transcriptCallDurationMs(use),
        status: transcriptCallStatus(result),
        hints,
        source: 'transcript',
        shell: shellOf(use),
        exitCode: null,
        inBytes: utf8Bytes(t.recognized.args.join(' ')),
        outBytes: t.call.agentSawBytes ?? 0,
        agentSawBytes: t.call.agentSawBytes,
        toolUseId: t.call.toolUseId,
        agentId: scan.node.agentId,
        agentKind: scan.node.agentKind,
        inputPreview: command.slice(0, INPUT_PREVIEW_CHARS),
        real: null,
        cwd: use.cwd,
        args: t.recognized.args,
        signals: computeSignals(scan.signalUses, index, {
          tool,
          operation: t.recognized.operation,
          output: result === null ? null : result.text,
        }),
      },
      output,
    });
  }

  return groupRows(built);
}
