/**
 * Session-scope usage analytics, derived client-side from the already-fetched `/logs`
 * payload (the same approach `SessionChartsTab` takes). The pre-computed-column rule targets
 * repository-scope aggregates; a single session's raw transcript is already in the browser.
 *
 * This deliberately reimplements the rules in `server/src/logs/tool-stats.ts` rather than
 * importing them — the client package is isolated from `server/`. The unit tests assert the
 * same taxonomy cases as the server's, which is what keeps the two definitions honest.
 *
 * Two deliberate differences from repository scope:
 *  - the median here is **exact**, computed from the raw per-call durations, so every row
 *    reports `durationApproximate: false` (repo scope interpolates from a bucket histogram);
 *  - the per-`iterations` drill-down exists only here, and is never added to any total —
 *    totals stay pinned to top-level `message.usage`, per
 *    `docs/knowledgebase/llm-call-math.md`.
 *
 * It also deliberately does NOT split calls by Logs section (`toolSection` in
 * `../tool-calls.ts`): the ranking population here is every `tool_use` block. The outcome rule
 * itself is shared with Logs (`../tool-outcome.ts`); a missing result is `unresolved` here
 * and `'missing'` there.
 */

import { isEditWriteTool, type EditWriteToolName } from '../edit-tools';
import { classifyToolOutcome, MAX_RESULT_TEXT_SCAN } from '../tool-outcome';

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

function asTokenNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function asDurationNumber(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return v;
}

function parseTs(v: unknown): number | null {
  const s = asString(v);
  if (s === null) return null;
  const ms = Date.parse(s);
  return isNaN(ms) ? null : ms;
}

// --- Rules mirrored from server/src/logs/tool-stats.ts -----------------------------------
// The outcome rule (`classifyToolOutcome`, DD-3) lives in `../tool-outcome.ts`, shared with Logs.

export type DurationSource = 'toolUseResult' | 'taskTotal' | 'timestampDelta';

export function resolveToolDuration(inputs: {
  toolUseResult: AnyRecord | null;
  assistantTs: number | null;
  resultTs: number | null;
}): { ms: number; source: DurationSource } | null {
  const result = inputs.toolUseResult;
  if (result !== null) {
    const selfReported = asDurationNumber(result['durationMs']);
    if (selfReported !== null) {
      return { ms: selfReported, source: 'toolUseResult' };
    }
    const taskTotal = asDurationNumber(result['totalDurationMs']);
    if (taskTotal !== null) return { ms: taskTotal, source: 'taskTotal' };
  }
  const { assistantTs, resultTs } = inputs;
  if (assistantTs !== null && resultTs !== null && resultTs >= assistantTs) {
    return { ms: resultTs - assistantTs, source: 'timestampDelta' };
  }
  return null;
}

/**
 * `git commit` invocations in one Bash command, per invocation.
 *
 * The flag-skip allows a value token (`-c user.name=bot` is two tokens), and the trailing
 * `(?![-\w])` is a hyphen-aware boundary so `git commit-tree` does not count.
 */
export function countCommits(command: string): number {
  if (command === '') return 0;
  const pattern =
    /(?:^|[\n;&|])\s*git\s+(?:-{1,2}\S+(?:\s+[^-\s]\S*)?\s+)*commit(?![-\w])/g;
  return (command.match(pattern) ?? []).length;
}

export function countPullRequests(command: string): number {
  if (command === '') return 0;
  const pattern = /(?:^|[\n;&|])\s*gh\s+pr\s+create(?![-\w])/g;
  return (command.match(pattern) ?? []).length;
}

export function mcpServerOfTool(toolName: string): string | null {
  if (!toolName.startsWith('mcp__')) return null;
  const server = toolName.split('__')[1];
  return server !== undefined && server !== '' ? server : null;
}

/**
 * Exact median of the raw durations — the session-scope counterpart to repository scope's
 * histogram interpolation. Even counts average the two middle values.
 */
export function exactMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// --- Public shapes ------------------------------------------------------------------------

export interface SessionTokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface SessionToolRow {
  tool: string;
  mcpServer: string | null;
  calls: number;
  successes: number;
  failures: number;
  unresolved: number;
  failureRate: number | null;
  durationCoveredCalls: number;
  durationP50Ms: number | null;
  durationMaxMs: number | null;
  durationMeanMs: number | null;
  /** Always `false` here — this median is exact, not interpolated. */
  durationApproximate: false;
  durationBySource: Record<DurationSource, number>;
  parallelBatchCalls: number;
}

/** The four token counters, as carried by both `message.usage` and each `iterations[]` entry. */
export interface IterationTokenSum {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** One assistant API call's `iterations[]` decomposition. Never summed into a total. */
export interface SessionIterationDetail {
  messageId: string;
  timestamp: string | null;
  model: string | null;
  serviceTier: string;
  iterationCount: number;
  topLevel: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  };
  iterationsSum: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  };
  /** True when `sum(iterations[]) === message.usage` for all four counters. */
  matchesTopLevel: boolean;
}

export interface SessionUsage {
  tools: SessionToolRow[];
  mainAgent: SessionToolRow[];
  subAgent: SessionToolRow[];
  mcpServers: {
    server: string;
    calls: number;
    failures: number;
    unresolved: number;
  }[];
  totalCalls: number;
  parallelBatchCalls: number;
  tokens: SessionTokenTotals;
  byServiceTier: ({ tier: string } & SessionTokenTotals)[];
  productivity: {
    commits: number;
    pullRequests: number;
    /**
     * Lines written by `Edit`/`Write`/`MultiEdit` across every transcript this walk
     * visited: the root **and** every descendant sub-agent transcript passed to
     * `deriveSessionUsage`. Counted from the tool **input** (`new_string` / `content` /
     * `edits[].new_string`), mirroring `server/src/logs/claude-extractor.ts`, so it does not
     * depend on a `structuredPatch` being present in the result.
     */
    linesWritten: number;
    /**
     * The {@link SessionUsage.productivity.linesWritten} subset contributed by the
     * **root transcript only**, excluding every descendant sub-agent. `0` for a purely
     * delegating session. This is the client's equivalent of the root's own `session_stats`
     * row, which the browser never receives.
     */
    linesWrittenOwn: number;
    /**
     * `Edit`/`Write`/`MultiEdit` **calls** across every transcript this walk visited
     * (root + descendants). A count of calls, not of distinct files.
     */
    filesEditedWritten: number;
    /**
     * The {@link SessionUsage.productivity.filesEditedWritten} subset contributed by
     * the **root transcript only**, excluding every descendant sub-agent.
     */
    filesEditedWrittenOwn: number;
  };
  iterations: SessionIterationDetail[];
  turnCount: number;
}

export const UNKNOWN_SERVICE_TIER = 'unknown';

// --- Derivation ---------------------------------------------------------------------------

interface ToolAccumulator {
  tool: string;
  calls: number;
  failures: number;
  unresolved: number;
  durations: number[];
  bySource: Record<DurationSource, number>;
  parallelBatchCalls: number;
}

interface PendingCall {
  id: string | null;
  name: string;
  messageKey: string | null;
  assistantTs: number | null;
  /**
   * The `tool_use` block's raw `input`, carried through so the tree-scoped written-lines counter can
   * read `new_string` / `content` / `edits[]` in the same loop that already resolves the call's
   * outcome. `null` when the block had no object `input`.
   */
  input: AnyRecord | null;
}

interface ResultRecord {
  isError: boolean | null;
  text: string;
  resultTs: number | null;
  toolUseResult: AnyRecord | null;
  /** The result line's top-level `toolDenialKind` (DD-3). */
  denialKind: string | null;
}

function emptyTokens(): SessionTokenTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
  };
}

/**
 * TTL split of one usage object's cache-creation tokens. Older transcripts carry only the flat
 * field; those tokens all go to the 5m bucket so `5m + 1h === cacheCreation` holds per line.
 */
function splitCacheCreation(usage: AnyRecord): {
  write5m: number;
  write1h: number;
} {
  const total = asTokenNumber(usage['cache_creation_input_tokens']);
  const detail = asRecord(usage['cache_creation']);
  if (detail !== null) {
    const write5m = asTokenNumber(detail['ephemeral_5m_input_tokens']);
    const write1h = asTokenNumber(detail['ephemeral_1h_input_tokens']);
    if (write5m + write1h > 0) return { write5m, write1h };
  }
  return { write5m: total, write1h: 0 };
}

function flattenResultText(content: unknown): string {
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

/**
 * Walks one transcript, folding its tool calls into `side` (and `combined`) and its tokens and
 * productivity counters into the shared accumulators.
 *
 * `isSubagentLog` mirrors the server: in a root transcript, `isSidechain: true` assistant
 * events are the sub-agent's proxy events and are skipped (they are counted in the sub-agent's
 * own log); in a sub-agent transcript they ARE the real calls.
 */
function walkTranscript(
  lines: AnyRecord[],
  isSubagentLog: boolean,
  combined: Map<string, ToolAccumulator>,
  side: Map<string, ToolAccumulator>,
  shared: {
    tokens: SessionTokenTotals;
    byTier: Map<string, SessionTokenTotals>;
    productivity: SessionUsage['productivity'];
    iterations: SessionIterationDetail[];
    prompts: Set<string>;
  },
): void {
  const calls: PendingCall[] = [];
  const blocksByMessage = new Map<string, number>();
  const results = new Map<string, ResultRecord>();
  // One API response can span several transcript lines. Its usage is counted once, on the
  // message's LAST line: a sub-agent's first block line is written mid-stream with a partial
  // `output_tokens`, and only the last line holds the final count (same rule as the server's
  // extractClaudeStats).
  const lastUsageLineByKey = new Map<string, AnyRecord>();
  for (const line of lines) {
    if (line['type'] !== 'assistant') continue;
    if (!isSubagentLog && line['isSidechain'] === true) continue;
    const message = asRecord(line['message']);
    if (asRecord(message?.['usage']) === null) continue;
    const key = asString(message?.['id']) ?? asString(line['uuid']);
    if (key !== null) lastUsageLineByKey.set(key, line);
  }

  for (const line of lines) {
    const type = line['type'];
    const message = asRecord(line['message']);

    if (type === 'assistant') {
      if (!isSubagentLog && line['isSidechain'] === true) continue;
      const assistantTs = parseTs(line['timestamp']);
      const messageKey = asString(message?.['id']) ?? asString(line['uuid']);

      const usage = asRecord(message?.['usage']);
      if (usage !== null) {
        // Count a multi-line response once, on its last line (see lastUsageLineByKey).
        const isLastUsageLine =
          messageKey === null || lastUsageLineByKey.get(messageKey) === line;

        if (isLastUsageLine) {
          const input = asTokenNumber(usage['input_tokens']);
          const output = asTokenNumber(usage['output_tokens']);
          const cacheRead = asTokenNumber(usage['cache_read_input_tokens']);
          const cacheCreation = asTokenNumber(
            usage['cache_creation_input_tokens'],
          );
          const { write5m, write1h } = splitCacheCreation(usage);

          shared.tokens.input += input;
          shared.tokens.output += output;
          shared.tokens.cacheRead += cacheRead;
          shared.tokens.cacheCreation += cacheCreation;
          shared.tokens.cacheWrite5m += write5m;
          shared.tokens.cacheWrite1h += write1h;

          const tierName = readServiceTier(usage);
          const tier = shared.byTier.get(tierName) ?? emptyTokens();
          tier.input += input;
          tier.output += output;
          tier.cacheRead += cacheRead;
          tier.cacheCreation += cacheCreation;
          tier.cacheWrite5m += write5m;
          tier.cacheWrite1h += write1h;
          shared.byTier.set(tierName, tier);

          const iterationsArray = asArray(usage['iterations']);
          if (iterationsArray !== null) {
            const sum = iterationsArray.reduce<IterationTokenSum>(
              (acc, it) => {
                const record = asRecord(it);
                return {
                  input: acc.input + asTokenNumber(record?.['input_tokens']),
                  output: acc.output + asTokenNumber(record?.['output_tokens']),
                  cacheRead:
                    acc.cacheRead +
                    asTokenNumber(record?.['cache_read_input_tokens']),
                  cacheCreation:
                    acc.cacheCreation +
                    asTokenNumber(record?.['cache_creation_input_tokens']),
                };
              },
              { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
            );
            const topLevel = { input, output, cacheRead, cacheCreation };
            shared.iterations.push({
              messageId: messageKey ?? '(unknown)',
              timestamp: asString(line['timestamp']),
              model: asString(message?.['model']),
              serviceTier: tierName,
              iterationCount: iterationsArray.length,
              topLevel,
              iterationsSum: sum,
              matchesTopLevel:
                sum.input === topLevel.input &&
                sum.output === topLevel.output &&
                sum.cacheRead === topLevel.cacheRead &&
                sum.cacheCreation === topLevel.cacheCreation,
            });
          }
        }
      }

      const content = asArray(message?.['content']);
      if (content !== null) {
        for (const block of content) {
          const b = asRecord(block);
          if (b === null || b['type'] !== 'tool_use') continue;
          const name = asString(b['name']);
          if (name === null) continue;

          calls.push({
            id: asString(b['id']),
            name,
            messageKey,
            assistantTs,
            input: asRecord(b['input']),
          });
          if (messageKey !== null) {
            blocksByMessage.set(
              messageKey,
              (blocksByMessage.get(messageKey) ?? 0) + 1,
            );
          }

          if (name === 'Bash') {
            const command = asString(asRecord(b['input'])?.['command']);
            if (command !== null) {
              shared.productivity.commits += countCommits(command);
              shared.productivity.pullRequests += countPullRequests(command);
            }
          }
        }
      }
    }

    if (type === 'user') {
      const promptId = asString(line['promptId']);
      const toolUseResult = asRecord(line['toolUseResult']);
      const isSubagentResult =
        toolUseResult !== null && toolUseResult['agentId'] != null;
      if (promptId !== null && !line['isMeta'] && !isSubagentResult) {
        shared.prompts.add(promptId);
      }

      const content = asArray(message?.['content']);
      if (content === null) continue;
      for (const block of content) {
        const b = asRecord(block);
        if (b === null || b['type'] !== 'tool_result') continue;
        const toolUseId = asString(b['tool_use_id']);
        if (toolUseId === null || results.has(toolUseId)) continue;
        results.set(toolUseId, {
          isError: typeof b['is_error'] === 'boolean' ? b['is_error'] : null,
          text: flattenResultText(b['content']),
          resultTs: parseTs(line['timestamp']),
          toolUseResult,
          denialKind: asString(line['toolDenialKind']),
        });
      }
    }
  }

  for (const call of calls) {
    const result = call.id !== null ? (results.get(call.id) ?? null) : null;
    const batchSize =
      call.messageKey !== null
        ? (blocksByMessage.get(call.messageKey) ?? 1)
        : 1;

    const outcome = classifyToolOutcome(
      result === null
        ? null
        : {
            isError: result.isError,
            text: result.text,
            interrupted: result.toolUseResult?.['interrupted'] === true,
            ...(result.denialKind !== null
              ? { denialKind: result.denialKind }
              : {}),
          },
    );
    const duration = resolveToolDuration({
      toolUseResult: result?.toolUseResult ?? null,
      assistantTs: call.assistantTs,
      resultTs: result?.resultTs ?? null,
    });

    for (const target of [combined, side]) {
      const acc = ensureAccumulator(target, call.name);
      acc.calls += 1;
      if (outcome === 'failure') acc.failures += 1;
      else if (outcome === 'unresolved') acc.unresolved += 1;
      if (batchSize > 1) acc.parallelBatchCalls += 1;
      if (duration !== null) {
        acc.durations.push(duration.ms);
        acc.bySource[duration.source] += 1;
      }
    }

    // The gate now includes `MultiEdit`, matching `claude-extractor.ts` — before the
    // fix a MultiEdit-heavy session under-reported its diff-coverage denominator here while
    // `session_stats` counted every one of those calls.
    const editTool: EditWriteToolName | null = isEditWriteTool(call.name)
      ? call.name
      : null;
    if (editTool !== null) {
      // D1 — the diff pair (`+added / −removed` and its coverage) is no longer derived here;
      // it comes from `session_stats` via `/logs` `rootStats` + `subagentStats` (see
      // `tree-code-impact.ts`). Written lines/calls come from the tool INPUT. `own` is the
      // root transcript's share: `isSubagentLog` is false exactly once per `deriveSessionUsage`
      // (the root walk), and that walk already skips `isSidechain` assistant events, so a
      // sub-agent's proxied calls never leak into the own figures.
      const written = countWrittenLines(editTool, call.input);
      shared.productivity.linesWritten += written;
      shared.productivity.filesEditedWritten += 1;
      if (!isSubagentLog) {
        shared.productivity.linesWrittenOwn += written;
        shared.productivity.filesEditedWrittenOwn += 1;
      }
    }
  }
}

/**
 * Lines written by one `Edit`/`Write`/`MultiEdit` call, read off the tool input.
 *
 * Deliberately identical to `server/src/logs/claude-extractor.ts`'s `linesChanged`
 * accumulation: a non-empty `new_string` / `content` contributes
 * `split('\n').length`, an empty or missing one contributes nothing, and a `MultiEdit` sums
 * over `edits[]`. Any divergence here would make the Info tab disagree with the analytics
 * timeline for the very same session, which is the bug the tree-scoped counter exists to fix.
 */
function countWrittenLines(
  name: EditWriteToolName,
  input: AnyRecord | null,
): number {
  if (input === null) return 0;
  if (name === 'Edit') {
    const newString = asString(input['new_string']);
    return newString !== null && newString !== ''
      ? newString.split('\n').length
      : 0;
  }
  if (name === 'Write') {
    const content = asString(input['content']);
    return content !== null && content !== '' ? content.split('\n').length : 0;
  }
  const edits = asArray(input['edits']);
  if (edits === null) return 0;
  let total = 0;
  for (const edit of edits) {
    const e = asRecord(edit);
    if (e === null) continue;
    const newString = asString(e['new_string']);
    if (newString !== null && newString !== '') {
      total += newString.split('\n').length;
    }
  }
  return total;
}

export function readServiceTier(usage: unknown): string {
  const tier = asString(asRecord(usage)?.['service_tier']);
  return tier === null || tier === '' ? UNKNOWN_SERVICE_TIER : tier;
}

function ensureAccumulator(
  target: Map<string, ToolAccumulator>,
  tool: string,
): ToolAccumulator {
  let acc = target.get(tool);
  if (acc === undefined) {
    acc = {
      tool,
      calls: 0,
      failures: 0,
      unresolved: 0,
      durations: [],
      bySource: { toolUseResult: 0, taskTotal: 0, timestampDelta: 0 },
      parallelBatchCalls: 0,
    };
    target.set(tool, acc);
  }
  return acc;
}

function toRow(acc: ToolAccumulator): SessionToolRow {
  const successes = acc.calls - acc.failures - acc.unresolved;
  const resolved = successes + acc.failures;
  const covered = acc.durations.length;
  return {
    tool: acc.tool,
    mcpServer: mcpServerOfTool(acc.tool),
    calls: acc.calls,
    successes,
    failures: acc.failures,
    unresolved: acc.unresolved,
    failureRate: resolved > 0 ? acc.failures / resolved : null,
    durationCoveredCalls: covered,
    durationP50Ms: exactMedian(acc.durations),
    durationMaxMs: covered > 0 ? Math.max(...acc.durations) : null,
    durationMeanMs:
      covered > 0 ? acc.durations.reduce((a, b) => a + b, 0) / covered : null,
    durationApproximate: false,
    durationBySource: acc.bySource,
    parallelBatchCalls: acc.parallelBatchCalls,
  };
}

function rank(target: Map<string, ToolAccumulator>): SessionToolRow[] {
  return [...target.values()]
    .map(toRow)
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
}

/**
 * Derives every session-scope usage figure from the raw `/logs` payload.
 *
 * `main` is the root transcript; `subagentLogs` are the descendant sub-agent transcripts, whose
 * work is included so a session driven by agents does not report zeros. The main/sub split
 * mirrors the repository-scope `mainAgent` / `subAgent` breakdown.
 */
export function deriveSessionUsage(
  main: AnyRecord[] | null | undefined,
  subagentLogs: AnyRecord[][] = [],
): SessionUsage {
  const combined = new Map<string, ToolAccumulator>();
  const mainSide = new Map<string, ToolAccumulator>();
  const subSide = new Map<string, ToolAccumulator>();
  const shared = {
    tokens: emptyTokens(),
    byTier: new Map<string, SessionTokenTotals>(),
    productivity: {
      commits: 0,
      pullRequests: 0,
      linesWritten: 0,
      linesWrittenOwn: 0,
      filesEditedWritten: 0,
      filesEditedWrittenOwn: 0,
    },
    iterations: [] as SessionIterationDetail[],
    prompts: new Set<string>(),
  };

  if (main && main.length > 0) {
    walkTranscript(main, false, combined, mainSide, shared);
  }
  for (const logs of subagentLogs) {
    if (logs && logs.length > 0) {
      walkTranscript(logs, true, combined, subSide, shared);
    }
  }

  const tools = rank(combined);
  const mcpServers = new Map<
    string,
    { server: string; calls: number; failures: number; unresolved: number }
  >();
  for (const row of tools) {
    if (row.mcpServer === null) continue;
    const entry = mcpServers.get(row.mcpServer) ?? {
      server: row.mcpServer,
      calls: 0,
      failures: 0,
      unresolved: 0,
    };
    entry.calls += row.calls;
    entry.failures += row.failures;
    entry.unresolved += row.unresolved;
    mcpServers.set(row.mcpServer, entry);
  }

  return {
    tools,
    mainAgent: rank(mainSide),
    subAgent: rank(subSide),
    mcpServers: [...mcpServers.values()].sort(
      (a, b) => b.calls - a.calls || a.server.localeCompare(b.server),
    ),
    totalCalls: tools.reduce((n, r) => n + r.calls, 0),
    parallelBatchCalls: tools.reduce((n, r) => n + r.parallelBatchCalls, 0),
    tokens: shared.tokens,
    byServiceTier: [...shared.byTier.entries()]
      .map(([tier, totals]) => ({ tier, ...totals }))
      .sort((a, b) => b.input + b.output - (a.input + a.output)),
    productivity: shared.productivity,
    iterations: shared.iterations,
    turnCount: shared.prompts.size,
  };
}
