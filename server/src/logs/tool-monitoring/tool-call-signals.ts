/**
 * Tools/MCP monitoring — usefulness signals of a call (FR-5; impl-plan DD-12). Heuristics: the
 * UI labels them as such.
 *
 * Looked at over the next `SIGNAL_LOOKAHEAD` (3) `tool_use`s of the same agent:
 * - `empty`: the call's output is empty after trimming, or a line of it starts with
 *   "no results", "no matches", "not found", "nothing found" or "0 results" (case-insensitive).
 *   A call without output (no result) gets no `empty`.
 * - `retried`: a following `tool_use` carries the same tool (case-insensitive, no `.exe`) and
 *   operation.
 * - `opened_file`: a following `Read` / `Edit` whose `file_path` basename appears in the call's
 *   output.
 *
 * Pure: no DB, no Nest.
 */
import { normalizeToolName } from '@loghub/tool-monitor';
import type { ToolCallSignal } from '../../database/schema/index';
import { SIGNAL_LOOKAHEAD } from './tool-usage.constants';

/** One `tool_use` of an agent, as the signals see it. */
export interface SignalToolUse {
  /** The transcript tool name (`Bash`, `Read`, `mcp__srv__op`, …). */
  name: string;
  /** The monitored calls it carries: one for MCP, the recognised ones for Bash / PowerShell. */
  calls: { tool: string; operation: string }[];
  /** Read / Edit: its `file_path`; else null. */
  filePath: string | null;
  /** The output the agent saw; null when the call got no result. */
  output: string | null;
}

/** The call the signals are computed for, when it is not the first call of the `tool_use`. */
export interface SignalSubject {
  tool: string;
  operation: string;
  /** The call's output (e.g. the wrapper's stdout); null when unknown. */
  output: string | null;
}

const EMPTY_OUTPUT_PATTERN =
  /^(no (results|matches)|not found|nothing found|0 results)/im;

const OPEN_FILE_TOOLS = new Set(['Read', 'Edit']);

/** True when an output reads as "nothing found" (DD-12 `empty`). */
export function isEmptyOutput(output: string): boolean {
  return output.trim() === '' || EMPTY_OUTPUT_PATTERN.test(output);
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p !== '');
  return parts.length === 0 ? '' : parts[parts.length - 1];
}

/**
 * The DD-10 `signals` of the call at `index` in its agent's ordered `tool_use`s. `subject`
 * selects the call when the `tool_use` carries several (default: its first call and its
 * output).
 */
export function computeSignals(
  orderedToolUsesPerAgent: readonly SignalToolUse[],
  index: number,
  subject?: SignalSubject,
): ToolCallSignal[] {
  const use = orderedToolUsesPerAgent[index];
  if (use === undefined) return [];
  const own = subject ?? {
    tool: use.calls[0]?.tool ?? use.name,
    operation: use.calls[0]?.operation ?? '',
    output: use.output,
  };
  const ownTool = normalizeToolName(own.tool);
  const next = orderedToolUsesPerAgent.slice(
    index + 1,
    index + 1 + SIGNAL_LOOKAHEAD,
  );

  const signals: ToolCallSignal[] = [];
  if (own.output !== null && isEmptyOutput(own.output)) signals.push('empty');

  if (
    next.some((n) =>
      n.calls.some(
        (c) =>
          normalizeToolName(c.tool) === ownTool &&
          c.operation === own.operation,
      ),
    )
  ) {
    signals.push('retried');
  }

  const output = own.output;
  if (
    output !== null &&
    output !== '' &&
    next.some((n) => {
      if (!OPEN_FILE_TOOLS.has(n.name) || n.filePath === null) return false;
      const base = basename(n.filePath);
      return base !== '' && output.includes(base);
    })
  ) {
    signals.push('opened_file');
  }

  return signals;
}
