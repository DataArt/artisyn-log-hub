/**
 * Pure helpers for transcript-derived tool/productivity statistics.
 *
 * Everything here is a pure function over already-parsed transcript fragments, so the
 * ingest path (`claude-extractor.ts`), the backfill and the unit tests all share one
 * definition of each rule. Nothing in this file touches the database.
 *
 * The rules encoded here were each verified against the live DB before being written down —
 * see the notes on the individual functions.
 */

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

/** A finite, non-negative number, or `null`. Guards against NaN/Infinity in transcripts. */
function asDurationNumber(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return v;
}

// ---------------------------------------------------------------------------
// Outcome taxonomy
// ---------------------------------------------------------------------------

export type ToolOutcome = 'success' | 'failure' | 'unresolved';

/**
 * Claude Code's own rejection / permission-denial sentences, lower-cased.
 *
 * These are matched deliberately narrowly. A generic `permission denied` match was
 * measured on the live DB and rejected: 51 `tool_result` blocks contain that phrase as
 * ordinary *command output* (a real `Bash` failure), only 2 of which relate to a Claude
 * Code permission decision. Matching it would silently turn genuine tool failures into
 * "unresolved" and understate the failure rate.
 *
 * Only the first entry occurs in the data measured today; the rest are other Claude Code
 * versions' wordings, kept so an older or newer hook's transcripts classify the same way.
 */
const REJECTION_MARKERS: readonly string[] = [
  "doesn't want to proceed with this tool use",
  'doesn’t want to proceed with this tool use',
  "doesn't want to take this action",
  'doesn’t want to take this action',
  'requested permissions to use',
  'operation rejected by user',
  'request interrupted by user',
];

/**
 * True when a `tool_result` body is Claude Code telling us the call never ran because the
 * user rejected it, denied permission, or interrupted it. Such a call is `unresolved`, not
 * a `failure` — it says nothing about the tool.
 */
export function isRejectionText(text: string): boolean {
  if (text === '') return false;
  const lower = text.toLowerCase();
  return REJECTION_MARKERS.some((marker) => lower.includes(marker));
}

export interface ToolResultInfo {
  /** `tool_result.is_error`. Absent in ~65% of real blocks, which means success. */
  isError: boolean | null;
  /** Flattened text of the result, used only for rejection detection. */
  text: string;
  /** `toolUseResult.interrupted === true` — the structured form of an aborted call. */
  interrupted?: boolean;
}

/**
 * Classifies one tool call.
 *
 * - No matching `tool_result` at all (`null`) → `unresolved`: interrupted, abandoned or
 *   compacted away. This is the rule `log-parser.ts` gets wrong for our purposes (it
 *   reports a missing result as `'error'`), which is why that code is not reused here.
 * - Rejected / permission-denied / interrupted → `unresolved`, checked *before* `isError`
 *   because Claude Code sets `is_error: true` on rejection blocks.
 * - `isError === true` → `failure`.
 * - Anything else, including a result with no `is_error` field → `success`.
 */
export function classifyToolOutcome(
  result: ToolResultInfo | null,
): ToolOutcome {
  if (result === null) return 'unresolved';
  if (result.interrupted === true) return 'unresolved';
  if (isRejectionText(result.text)) return 'unresolved';
  if (result.isError === true) return 'failure';
  return 'success';
}

/**
 * Failure rate over resolved calls only: `failures / (successes + failures)`.
 * `null` when nothing resolved, so callers render "—" instead of a misleading `0`.
 */
export function computeFailureRate(
  successes: number,
  failures: number,
): number | null {
  const denominator = successes + failures;
  if (denominator <= 0) return null;
  return failures / denominator;
}

// ---------------------------------------------------------------------------
// Duration resolution and histogram bucketing
// ---------------------------------------------------------------------------

export type DurationSource = 'toolUseResult' | 'taskTotal' | 'timestampDelta';

export interface ResolvedDuration {
  ms: number;
  source: DurationSource;
}

export interface DurationInputs {
  /** The `toolUseResult` object from the user event carrying the matching result. */
  toolUseResult: AnyRecord | null;
  /** Epoch ms of the assistant event that issued the `tool_use` block. */
  assistantTs: number | null;
  /** Epoch ms of the user event carrying the matching `tool_result`. */
  resultTs: number | null;
}

/**
 * Resolves one call's duration through the fixed fallback chain, naming its source so
 * every surface can say which measure it is showing:
 *
 * 1. `toolUseResult.durationMs` — exact, self-reported (438 results on the live DB,
 *    essentially `Bash`).
 * 2. `toolUseResult.totalDurationMs` — the `Task` tool's own total (265 results).
 * 3. Wall-clock delta between the assistant event and the matching result event.
 *
 * Returns `null` when no source applies, so the call is excluded from the median/max and
 * from the coverage numerator.
 */
export function resolveToolDuration(
  inputs: DurationInputs,
): ResolvedDuration | null {
  const result = inputs.toolUseResult;

  if (result !== null) {
    const selfReported = asDurationNumber(result['durationMs']);
    if (selfReported !== null) {
      return { ms: selfReported, source: 'toolUseResult' };
    }
    const taskTotal = asDurationNumber(result['totalDurationMs']);
    if (taskTotal !== null) {
      return { ms: taskTotal, source: 'taskTotal' };
    }
  }

  const { assistantTs, resultTs } = inputs;
  if (
    assistantTs !== null &&
    resultTs !== null &&
    Number.isFinite(assistantTs) &&
    Number.isFinite(resultTs) &&
    resultTs >= assistantTs
  ) {
    return { ms: resultTs - assistantTs, source: 'timestampDelta' };
  }

  return null;
}

/**
 * Inclusive lower bounds of the eleven fixed duration buckets (ms). Bucket `i` covers
 * `[bound[i], bound[i+1])`; the last bucket is `[300000, ∞)`.
 *
 * Fixed rather than derived because per-session medians cannot be averaged at repository
 * scope — the repo-scope median is interpolated from the summed histogram instead.
 * Changing these bounds invalidates every stored histogram, so they must stay append-only.
 */
export const DURATION_BUCKET_LOWER_BOUNDS_MS: readonly number[] = [
  0, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 300000,
];

export const DURATION_BUCKET_COUNT = DURATION_BUCKET_LOWER_BOUNDS_MS.length;

/** Index of the bucket a duration falls in. Negative/NaN clamp to bucket 0. */
export function bucketDurationMs(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  for (let i = DURATION_BUCKET_COUNT - 1; i >= 0; i--) {
    if (ms >= DURATION_BUCKET_LOWER_BOUNDS_MS[i]) return i;
  }
  return 0;
}

export function emptyDurationHistogram(): number[] {
  return new Array<number>(DURATION_BUCKET_COUNT).fill(0);
}

export function addDurationToHistogram(histogram: number[], ms: number): void {
  histogram[bucketDurationMs(ms)] += 1;
}

/**
 * Linearly interpolates a percentile from a bucket histogram.
 *
 * Used only at repository scope, where the result is reported with
 * `durationApproximate: true`. Session scope computes the exact median from the raw
 * per-call durations instead.
 *
 * The open-ended top bucket has no upper bound to interpolate towards, so a percentile
 * landing there returns its lower bound (300000) — an understatement we accept rather
 * than inventing a ceiling.
 */
export function interpolateHistogramPercentile(
  histogram: readonly number[],
  percentile: number,
): number | null {
  const total = histogram.reduce((sum, n) => sum + (n > 0 ? n : 0), 0);
  if (total <= 0) return null;

  const target = total * percentile;
  let cumulative = 0;

  for (let i = 0; i < histogram.length; i++) {
    const count = histogram[i] > 0 ? histogram[i] : 0;
    if (count === 0) continue;

    if (cumulative + count >= target) {
      const lower = DURATION_BUCKET_LOWER_BOUNDS_MS[i];
      const isTopBucket = i === DURATION_BUCKET_COUNT - 1;
      if (isTopBucket) return lower;
      const upper = DURATION_BUCKET_LOWER_BOUNDS_MS[i + 1];
      const positionInBucket = (target - cumulative) / count;
      return lower + (upper - lower) * positionInBucket;
    }
    cumulative += count;
  }

  return DURATION_BUCKET_LOWER_BOUNDS_MS[DURATION_BUCKET_COUNT - 1];
}

/** Elementwise sum of stored histograms. Tolerates short/ragged arrays from jsonb. */
export function sumDurationHistograms(
  histograms: readonly (readonly number[])[],
): number[] {
  const out = emptyDurationHistogram();
  for (const histogram of histograms) {
    for (let i = 0; i < DURATION_BUCKET_COUNT; i++) {
      const value = histogram[i];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        out[i] += value;
      }
    }
  }
  return out;
}

/**
 * Number of calls in a wall-clock-overlapping batch, given how many `tool_use` blocks one
 * assistant event issued.
 *
 * A single assistant message issuing several `tool_use` blocks runs them concurrently, so
 * their durations overlap and must never be summed. Every member of a batch of two or more
 * is counted so the UI can badge those rows; a lone call contributes nothing.
 */
export function parallelBatchCallCount(toolUseBlocksInEvent: number): number {
  return toolUseBlocksInEvent > 1 ? toolUseBlocksInEvent : 0;
}

// ---------------------------------------------------------------------------
// Diff-based line counting
// ---------------------------------------------------------------------------

export interface PatchLineCounts {
  added: number;
  removed: number;
}

/**
 * Counts added/removed lines for one Edit/Write call, or `null` when the call carries no
 * usable payload (the call then counts towards `diffLinesTotalCalls` but not
 * `diffLinesCoveredCalls`, so every surface can state "over N of M Edit/Write calls").
 *
 * The chain, measured on the live DB:
 *
 * 1. Non-empty `structuredPatch` → count hunk `lines[]` entries by their `+`/`-` prefix.
 *    Exact. 1,633 Edit results and 64 Write-`update` results.
 * 2. `type === 'create'` → a new file, whose `structuredPatch` is *always* empty (verified:
 *    all 215 `create` results have zero hunks), so fall back to the written `content`
 *    line count with no removals.
 * 3. Otherwise → `null`.
 *
 * Counting the Edit/Write *inputs'* lines is deliberately NOT a fallback: measured over 954
 * calls it yields 3.14× the diff-based added count and no removals at all, so mixing it in
 * would make the column uninterpretable. Coverage is published instead of guessed.
 *
 * Note: that rejection stands for *counting* the input, and re-measuring it over 1 878
 * calls reproduced the native counts on 0 % of them. It does not extend to *diffing* the input —
 * {@link countEditInputPatchLines} runs a real line diff of `old_string` against `new_string`,
 * reproduces the native counts on 99.6 % of the same calls, and is used as the fallback for a
 * transcript that carries no `toolUseResult` whatsoever.
 */
export function countPatchLines(
  toolUseResult: unknown,
): PatchLineCounts | null {
  const result = asRecord(toolUseResult);
  if (result === null) return null;

  const hunks = asArray(result['structuredPatch']);
  if (hunks !== null && hunks.length > 0) {
    let added = 0;
    let removed = 0;
    for (const hunk of hunks) {
      const lines = asArray(asRecord(hunk)?.['lines']);
      if (lines === null) continue;
      for (const line of lines) {
        const text = asString(line);
        if (text === null || text.length === 0) continue;
        if (text[0] === '+') added += 1;
        else if (text[0] === '-') removed += 1;
      }
    }
    return { added, removed };
  }

  if (result['type'] === 'create') {
    const content = asString(result['content']);
    if (content !== null) {
      return { added: countContentLines(content), removed: 0 };
    }
  }

  return null;
}

/** Line count of a written file body. Empty content is zero lines, not one. */
export function countContentLines(content: string): number {
  if (content === '') return 0;
  return content.split('\n').length;
}

/**
 * Upper bound per side for {@link diffLineCounts}' O(n×m) table. A normal `Edit` block is tens
 * of lines; this only exists so a pathological one cannot stall ingest. Over the cap the
 * function returns `null` — the call stays *uncovered* rather than guessed.
 */
const EDIT_DIFF_MAX_LINES = 2000;

/**
 * Splits a block into the lines a diff should compare.
 *
 * `''` is zero lines, matching {@link countContentLines}. Unlike that function this also drops a
 * single trailing empty element, so a block that ends with a newline is not treated as having an
 * extra blank last line: without this, replacing `"a\nb\n"` with `"a\nb"` scored a phantom
 * removal. Measured on real data, this normalisation alone took exact agreement with the native
 * patch counts from 99.3 % to 99.6 % over 1 878 calls.
 */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/**
 * Added/removed line counts of a real line-level diff between two blocks, via the length of
 * their longest common subsequence: `added = new − common`, `removed = old − common`.
 *
 * This reproduces what a `structuredPatch` would have reported for the same edit. Validated
 * against ground truth over **1 878 real `Edit` calls** that carry BOTH a native patch and their
 * inputs: **99.6 % reproduce the native `+`/`−` counts exactly.** For contrast, counting
 * `new_string`'s lines as additions — the rejected fallback, see {@link countPatchLines} —
 * matched on **0 %** of the same calls.
 *
 * The residual 0.4 % (8 calls) are diff-alignment ambiguity, not error: several minimal diffs can
 * describe one edit, and the native patch sometimes picks a non-minimal alignment (e.g. `2/2`
 * where an LCS finds `1/1`). This function is minimal, so it can report slightly *less* churn
 * than the native patch — never more, and never a removal that did not happen.
 *
 * `null` when either side exceeds {@link EDIT_DIFF_MAX_LINES}.
 */
export function diffLineCounts(
  oldText: string,
  newText: string,
): PatchLineCounts | null {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length > EDIT_DIFF_MAX_LINES || b.length > EDIT_DIFF_MAX_LINES) {
    return null;
  }
  if (a.length === 0) return { added: b.length, removed: 0 };
  if (b.length === 0) return { added: 0, removed: a.length };

  // LCS length over two rolling rows — the full table is never needed, only its last value.
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = 0;
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1] + 1
          : Math.max(prev[j], curr[j - 1]);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  const common = prev[b.length];

  return { added: b.length - common, removed: a.length - common };
}

/**
 * Diff counts recovered from an `Edit`/`MultiEdit` **input**, for a transcript that carries no
 * `toolUseResult` at all.
 *
 * Workflow-spawned agent transcripts (`subagents/workflows/<wf-id>/`) record the `tool_use`
 * block and a bare confirmation string as the `tool_result`, but never the top-level
 * `toolUseResult` object that {@link countPatchLines} reads — measured 0 of 894 edit calls
 * across 92 such agents, against 43 of 43 for regular `Task` sub-agents. The diff is still
 * derivable, because `old_string`/`new_string` are both present in the input.
 *
 * This does NOT contradict the note on {@link countPatchLines} that recomputing from inputs is
 * rejected: what was rejected (and measured at 3.14× added with no removals) is counting
 * `new_string`'s lines as additions. This runs an actual diff of the two blocks instead, which
 * reproduces the native counts exactly — see {@link diffLineCounts}.
 *
 * `Write` is deliberately excluded: its input carries only the new `content`, never the file's
 * prior contents, so an overwrite's removals are unknowable (a real one measured `+142/−164`).
 * Claiming `removed: 0` there would corrupt the column, so such calls stay uncovered and are
 * reported as missing coverage instead.
 */
export function countEditInputPatchLines(
  toolName: string,
  input: unknown,
): PatchLineCounts | null {
  const record = asRecord(input);
  if (record === null) return null;

  if (toolName === 'Edit') {
    const oldText = asString(record['old_string']);
    const newText = asString(record['new_string']);
    if (oldText === null || newText === null) return null;
    return diffLineCounts(oldText, newText);
  }

  if (toolName === 'MultiEdit') {
    const edits = asArray(record['edits']);
    if (edits === null || edits.length === 0) return null;
    let added = 0;
    let removed = 0;
    let counted = 0;
    for (const edit of edits) {
      const e = asRecord(edit);
      if (e === null) continue;
      const oldText = asString(e['old_string']);
      const newText = asString(e['new_string']);
      if (oldText === null || newText === null) continue;
      const counts = diffLineCounts(oldText, newText);
      if (counts === null) continue;
      added += counts.added;
      removed += counts.removed;
      counted += 1;
    }
    // All-or-nothing: a partially-diffed MultiEdit would under-report while counting as
    // covered, which is exactly the dishonesty the coverage columns exist to prevent.
    return counted === edits.length ? { added, removed } : null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Commit / PR counting
// ---------------------------------------------------------------------------

/**
 * Skips git's global flags between `git` and its subcommand.
 *
 * A flag may carry a separate value token, so `-c user.name=bot` is *two* whitespace-
 * separated tokens. The originally pinned `(?:-\S+\s+)*` consumed only the `-c` and then failed to
 * find the subcommand — a unit test caught it undercounting `git -c user.name=bot commit`.
 * The optional `(?:\s+[^-\s]\S*)?` swallows the value token.
 */
const GIT_GLOBAL_FLAGS = String.raw`(?:-{1,2}\S+(?:\s+[^-\s]\S*)?\s+)*`;

/**
 * Start-of-invocation anchor: the command string's start, or after a newline or a shell
 * separator (`;`, `&&`, `||`, `|`). Keeps `echo "remember to git commit"` from counting.
 */
const INVOCATION_START = String.raw`(?:^|[\n;&|])\s*`;

/**
 * Counts `git commit` invocations inside one `Bash` command string.
 *
 * Counted per invocation, so `git add . && git commit -m x` is one commit and
 * `git commit -m a && git commit -m b` is two.
 *
 * The trailing `(?![-\w])` is a hyphen-aware word boundary: a plain `\b` treats the `-` in
 * `git commit-tree` as a boundary and would count that plumbing command as a commit.
 *
 * A fresh RegExp per call — a shared `/g` literal carries `lastIndex` between calls.
 */
export function countCommits(command: string): number {
  if (command === '') return 0;
  const pattern = new RegExp(
    `${INVOCATION_START}git\\s+${GIT_GLOBAL_FLAGS}commit(?![-\\w])`,
    'g',
  );
  return (command.match(pattern) ?? []).length;
}

/** Counts `gh pr create` invocations inside one `Bash` command string. See `countCommits`. */
export function countPullRequests(command: string): number {
  if (command === '') return 0;
  const pattern = new RegExp(
    `${INVOCATION_START}gh\\s+pr\\s+create(?![-\\w])`,
    'g',
  );
  return (command.match(pattern) ?? []).length;
}

// ---------------------------------------------------------------------------
// Token usage helpers and service tier
// ---------------------------------------------------------------------------

export interface UsageTokenFields {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

function asTokenNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** The four token counters from a top-level `message.usage` object. */
export function readUsageTokens(usage: unknown): UsageTokenFields {
  const record = asRecord(usage);
  if (record === null) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
  }
  return {
    inputTokens: asTokenNumber(record['input_tokens']),
    outputTokens: asTokenNumber(record['output_tokens']),
    cacheReadTokens: asTokenNumber(record['cache_read_input_tokens']),
    cacheCreationTokens: asTokenNumber(record['cache_creation_input_tokens']),
  };
}

/**
 * Elementwise sum of `usage.iterations[]`, or `null` when the array is absent.
 *
 * Exists to assert the invariant `sum(iterations[].X) === message.usage.X` in a unit
 * test. Measured over all 24,866 assistant events carrying `iterations` (1,398 logs), the
 * array always holds exactly one element equal to the top-level usage, so *sum*, *last*
 * and *top-level* coincide on all data today. The sum is the relationship asserted
 * because it is the one that stays correct if a multi-iteration response ever appears.
 *
 * This is a decomposition for the session-scope drill-down only — it is never added to any
 * total, which stays pinned to top-level `message.usage`.
 */
export function sumIterationUsageTokens(
  usage: unknown,
): UsageTokenFields | null {
  const record = asRecord(usage);
  if (record === null) return null;
  const iterations = asArray(record['iterations']);
  if (iterations === null) return null;

  const totals: UsageTokenFields = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  for (const iteration of iterations) {
    const fields = readUsageTokens(iteration);
    totals.inputTokens += fields.inputTokens;
    totals.outputTokens += fields.outputTokens;
    totals.cacheReadTokens += fields.cacheReadTokens;
    totals.cacheCreationTokens += fields.cacheCreationTokens;
  }
  return totals;
}

/** Bucket name for `usage.service_tier`; absent or blank becomes `'unknown'`. */
export const UNKNOWN_SERVICE_TIER = 'unknown';

export function readServiceTier(usage: unknown): string {
  const tier = asString(asRecord(usage)?.['service_tier']);
  if (tier === null || tier === '') return UNKNOWN_SERVICE_TIER;
  return tier;
}

// ---------------------------------------------------------------------------
// MCP naming
// ---------------------------------------------------------------------------

/** `mcp__postgres__query` → `postgres`; a non-MCP tool name → `null`. */
export function mcpServerOfTool(toolName: string): string | null {
  if (!toolName.startsWith('mcp__')) return null;
  const server = toolName.split('__')[1];
  return server !== undefined && server !== '' ? server : null;
}

// ---------------------------------------------------------------------------
// Per-session, per-tool accumulator
// ---------------------------------------------------------------------------

/** One `session_tool_stats` row, as produced by the extractor. */
export interface ToolStatRow {
  toolName: string;
  calls: number;
  failures: number;
  unresolved: number;
  durationCoveredCalls: number;
  durationMsTotal: number;
  durationMsMax: number;
  durationMsHistogram: number[];
  durationBySource: Record<DurationSource, number>;
  /**
   * Calls of this tool that ran inside a wall-clock-overlapping batch.
   *
   * Persisted per tool rather than derived at request time: the repo-scope
   * `parallelBatchCalls` figure and the per-row "overlapping" badge both need it, and
   * repo-scope figures may never parse `logs.body` (a performance requirement).
   */
  parallelBatchCalls: number;
}

export function emptyDurationBySource(): Record<DurationSource, number> {
  return { toolUseResult: 0, taskTotal: 0, timestampDelta: 0 };
}

export function createToolStatRow(toolName: string): ToolStatRow {
  return {
    toolName,
    calls: 0,
    failures: 0,
    unresolved: 0,
    durationCoveredCalls: 0,
    durationMsTotal: 0,
    durationMsMax: 0,
    durationMsHistogram: emptyDurationHistogram(),
    durationBySource: emptyDurationBySource(),
    parallelBatchCalls: 0,
  };
}

/**
 * Folds one classified, timed call into its tool's row.
 *
 * `durationMsTotal` is kept only to derive an exact *mean*; it is deliberately never
 * surfaced as a "total tool time" figure, because parallel batches overlap in wall clock
 * (see `parallelBatchCallCount`).
 */
export function accumulateToolCall(
  row: ToolStatRow,
  outcome: ToolOutcome,
  duration: ResolvedDuration | null,
  inOverlappingBatch: boolean = false,
): void {
  row.calls += 1;
  if (outcome === 'failure') row.failures += 1;
  else if (outcome === 'unresolved') row.unresolved += 1;
  if (inOverlappingBatch) row.parallelBatchCalls += 1;

  if (duration !== null) {
    row.durationCoveredCalls += 1;
    row.durationMsTotal += duration.ms;
    if (duration.ms > row.durationMsMax) row.durationMsMax = duration.ms;
    addDurationToHistogram(row.durationMsHistogram, duration.ms);
    row.durationBySource[duration.source] += 1;
  }
}
