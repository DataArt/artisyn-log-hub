'use strict';
/**
 * Claude Code Hook helper — derive `{added, removed}` for one Edit/Write/MultiEdit call from the
 * CLI's own `tool_response`. Not a hook entry point; `lifecycle-hook.js` calls it
 * on every `PostToolUse`.
 *
 * WHY THIS EXISTS. The server already counts these lines from the session transcript's
 * `toolUseResult`. That works for the root session and for `Task` sub-agents, and not at all for
 * **workflow agents**, whose transcripts carry `toolUseResult` as a plain string (or not at all) —
 * no `structuredPatch`, no `.type`. Delegated work is therefore invisible to the diff-line
 * counters unless the hook, which sees the real object at the moment the tool returns, reports it.
 * That is this module's whole job.
 *
 * WHAT IT MUST NOT DO. It never persists the payload it reads. `tool_response` contains the file's
 * new content, the patch text and — for other tools — command output; only four derived values
 * leave this function. `Read`, `Bash`, `Glob` and every other tool return `null` before
 * anything is inspected, so their results are not so much as looked at.
 *
 * ONE DEFINITION. The counting rule below is a **verbatim port** of
 * `server/src/logs/tool-stats.ts` → `countPatchLines()`, which is the source of truth. Two
 * implementations of "how many lines did this edit change" that disagree would make a session's
 * numbers depend on which side happened to cover the call, which is exactly the defect the shared definition was
 * written to prevent. The equivalence is pinned by the shared fixture
 * `tests/fixtures/patch-line-counts.json`, which both this package's tests and the server's
 * `tool-stats.spec.ts` run through their own implementation. If you change one, change the other
 * and the fixture together.
 */

/**
 * The tools whose results are inspected at all. Mirrors `server/src/logs/edit-tools.ts`'s
 * `EDIT_WRITE_TOOL_NAMES` — the server-side single list of "the model edited or wrote code".
 */
const EDIT_WRITE_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit']);

/** @param {*} v @returns {Record<string, *>|null} */
function asRecord(v) {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v;
  return null;
}

/** @param {*} v @returns {*[]|null} */
function asArray(v) {
  return Array.isArray(v) ? v : null;
}

/** @param {*} v @returns {string|null} */
function asString(v) {
  return typeof v === 'string' ? v : null;
}

/**
 * Line count of a written file body. Empty content is zero lines, not one.
 * Port of `tool-stats.ts` → `countContentLines()`.
 * @param {string} content
 * @returns {number}
 */
function countContentLines(content) {
  if (content === '') return 0;
  return content.split('\n').length;
}

/**
 * Counts added/removed lines for one Edit/Write result, or `null` when the payload carries
 * nothing usable.
 *
 * Verbatim port of `server/src/logs/tool-stats.ts` → `countPatchLines()` (the source of truth):
 *
 * 1. Non-empty `structuredPatch` → count hunk `lines[]` entries by their `+`/`-` prefix. Exact.
 * 2. `type === 'create'` → a new file, whose `structuredPatch` is always empty, so fall back to
 *    the written `content` line count with no removals.
 * 3. Otherwise → `null`.
 *
 * `null` is the honest answer for an absent or over-cap payload: the call is then reported as
 * **uncovered** rather than as `+0/−0`, which would turn "we don't know" into "nothing changed".
 *
 * @param {*} toolResponse
 * @returns {{added: number, removed: number}|null}
 */
function countPatchLines(toolResponse) {
  const result = asRecord(toolResponse);
  if (result === null) return null;

  const hunks = asArray(result['structuredPatch']);
  if (hunks !== null && hunks.length > 0) {
    let added = 0;
    let removed = 0;
    for (const hunk of hunks) {
      const hunkRecord = asRecord(hunk);
      const lines = asArray(hunkRecord === null ? null : hunkRecord['lines']);
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

/**
 * The per-call record `lifecycle-hook.js` attaches to a `PostToolUse` event, or `null` when the
 * call has nothing to report.
 *
 * `null` for:
 * - every non-edit tool (`Read`, `Bash`, `Glob`, …) — their results are never inspected;
 * - an edit call whose payload carries no countable diff (absent, string-form, or over the CLI's
 *   own patch cap), which leaves the call **uncovered**. The server joins on `tool_use_id`, so an
 *   absent record simply means this source contributed nothing, never an error.
 *
 * `changeKind` is `'added'` for a file creation (`type === 'create'`) and `'modified'` otherwise.
 * `deleted` is deliberately never produced: deletions happen through
 * `Bash rm`, not through an edit tool.
 *
 * `filePath` is the CLI's own `filePath` from the result, used server-side only as a fallback when
 * the transcript's `tool_input.file_path` is unavailable.
 *
 * @param {string|null|undefined} toolName
 * @param {*} toolResponse the raw `PostToolUse` payload's `tool_response` — read, never stored
 * @returns {{added: number, removed: number, changeKind: 'added'|'modified',
 *            filePath: string|null}|null}
 */
function deriveEditResultCounts(toolName, toolResponse) {
  if (typeof toolName !== 'string' || !EDIT_WRITE_TOOL_NAMES.has(toolName)) return null;

  const counts = countPatchLines(toolResponse);
  if (counts === null) return null;

  const result = asRecord(toolResponse);
  return {
    added: counts.added,
    removed: counts.removed,
    changeKind: result !== null && result['type'] === 'create' ? 'added' : 'modified',
    filePath: result === null ? null : asString(result['filePath']),
  };
}

module.exports = {
  EDIT_WRITE_TOOL_NAMES,
  countContentLines,
  countPatchLines,
  deriveEditResultCounts,
};
