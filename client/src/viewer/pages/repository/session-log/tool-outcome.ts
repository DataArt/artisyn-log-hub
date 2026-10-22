/**
 * Outcome of one tool call (DD-3, algorithm doc `tool-call-outcome.md`). Shared by the Logs
 * parser (`tool-calls.ts`) and the Statistics walker (`usage/session-usage-derive.ts`).
 *
 * The server twin is `server/src/logs/tool-stats.ts` `classifyToolOutcome` (DD-21b) — the
 * client package is isolated from `server/`, so the rule is mirrored, and both twins are
 * pinned by the same algorithm doc.
 */

import type { ToolCallStatus } from './types';

export type ToolOutcome = 'success' | 'failure' | 'unresolved';

/**
 * Claude Code's own rejection / permission / interruption sentences, lower-cased and matched as
 * substrings anywhere in the (cut) text. Kept narrow: a generic `permission denied` match would
 * catch ordinary `Bash` output and turn real tool failures into "unresolved".
 */
export const REJECTION_MARKERS: readonly string[] = [
  "doesn't want to proceed with this tool use",
  'doesn’t want to proceed with this tool use',
  "doesn't want to take this action",
  'doesn’t want to take this action',
  'requested permissions to use',
  'operation rejected by user',
  'request interrupted by user',
];

/** Rejection notices are short and sentence-initial; scanning more is wasted work. */
export const MAX_RESULT_TEXT_SCAN = 200;

export function isRejectionText(text: string): boolean {
  if (text === '') return false;
  const lower = text.toLowerCase();
  return REJECTION_MARKERS.some((marker) => lower.includes(marker));
}

/** What the outcome rule reads from a tool result. */
export interface ToolResultInfo {
  isError: boolean | null;
  /** Result text; only its first `MAX_RESULT_TEXT_SCAN` chars matter. */
  text: string;
  /** `toolUseResult.interrupted === true` on the result line. */
  interrupted?: boolean;
  /** The result line's top-level `toolDenialKind` (`user-rejected`, `permission-rule`, …). */
  denialKind?: string;
}

function hasDenialKind(result: ToolResultInfo): boolean {
  return typeof result.denialKind === 'string' && result.denialKind !== '';
}

/**
 * DD-3: no result → `unresolved`; interrupted or a `denialKind` → `unresolved` (a rejection);
 * a rejection marker counts only on an `is_error` result (successful Grep/Bash output can quote
 * the marker text); any other `is_error` → `failure`; else `success`.
 */
export function classifyToolOutcome(
  result: ToolResultInfo | null,
): ToolOutcome {
  if (result === null) return 'unresolved';
  if (result.interrupted === true) return 'unresolved';
  if (hasDenialKind(result)) return 'unresolved';
  if (result.isError === true) {
    return isRejectionText(result.text) ? 'unresolved' : 'failure';
  }
  return 'success';
}

/** `ToolCallDetail` status fields derived from a result (DD-3 mapping). */
export interface ToolCallOutcomeFields {
  status: ToolCallStatus;
  interrupted?: true;
  denialKind?: string;
}

/**
 * DD-3 mapping to `ToolCallDetail.status`: no result → `'missing'`; interrupted or a rejection
 * → `'rejected'` (with `interrupted: true` when `interrupted` or `denialKind === 'interrupted'`,
 * and `denialKind` copied);
 * `is_error` → `'error'`; otherwise `'success'`.
 */
export function outcomeToStatus(
  result: ToolResultInfo | null,
): ToolCallOutcomeFields {
  if (result === null) return { status: 'missing' };
  const outcome = classifyToolOutcome({
    ...result,
    text: result.text.slice(0, MAX_RESULT_TEXT_SCAN),
  });
  if (outcome === 'unresolved') {
    const fields: ToolCallOutcomeFields = { status: 'rejected' };
    if (result.interrupted === true || result.denialKind === 'interrupted')
      fields.interrupted = true;
    if (hasDenialKind(result)) fields.denialKind = result.denialKind;
    return fields;
  }
  return { status: outcome === 'failure' ? 'error' : 'success' };
}
