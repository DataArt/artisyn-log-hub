/**
 * Tools/MCP monitoring — matching wrapper records to the transcript (impl-plan DD-12).
 *
 * Inputs: the tree's wrapper records (`parseToolCallsLog`) and its transcript CLI calls — every
 * Bash / PowerShell `tool_use` of the tree with the monitored invocations
 * `recognizeCliCalls` found in its command ("slots").
 *
 * Rules:
 * - A `tool_use`'s window is `[ts − MATCH_WINDOW_SLACK_MS, end + MATCH_WINDOW_SLACK_MS]`, where
 *   `end` is its `tool_result` time, or its own `ts` when it has no result.
 * - Records are taken in `startedAt` order. A record matches a free slot of a `tool_use` whose
 *   window contains `startedAt`, whose slot names the record's `tool` (case-insensitive, no
 *   `.exe`) and whose slot `args[0]` equals the record's `args[0]` (both absent counts as equal).
 *   Ties go to the earliest `tool_use` (by `ts`, then input order), and within it to its first
 *   free slot. Each slot takes one record.
 * - A record with no such slot is `indirect`: linked to the `tool_use` whose window contains
 *   `startedAt` (the latest one started at or before `startedAt`, else the earliest), or with
 *   `toolUseId` null when no window contains it.
 * - A slot left without a record is a transcript-only call (hint `no_wrapper`).
 * - `cut` = the record's `consumerClosed`, or — for a matched record whose `tool_use` result is
 *   known — the agent saw fewer bytes than the wrapper captured (`stdout + stderr`).
 *
 * Pure: no DB, no Nest.
 */
import { normalizeToolName } from '@loghub/tool-monitor';
import type { RecognizedCliCall } from './cli-command-recognition';
import type { WrapperCallRecord } from './tool-calls-log';
import { MATCH_WINDOW_SLACK_MS } from './tool-usage.constants';

/** One Bash / PowerShell `tool_use` of the tree with its recognised monitored invocations. */
export interface TranscriptCliCall {
  toolUseId: string;
  /** Epoch ms of the `tool_use`; a call without one never matches. */
  ts: number | null;
  /** Epoch ms of its `tool_result`, null when there is none. */
  resultTs: number | null;
  /** The monitored invocations in its command, in source order. */
  recognized: RecognizedCliCall[];
  /** UTF-8 bytes of the result text the agent saw; null when there is no result. */
  agentSawBytes: number | null;
}

/** A wrapper record joined to the transcript invocation that ran it. */
export interface MatchedWrapperRecord {
  record: WrapperCallRecord;
  call: TranscriptCliCall;
  /** Index of the matched slot in `call.recognized`. */
  slot: number;
  cut: boolean;
}

/** A wrapper record no transcript invocation names. */
export interface IndirectWrapperRecord {
  record: WrapperCallRecord;
  /** The `tool_use` whose window holds the record, or null. */
  toolUseId: string | null;
  cut: boolean;
}

/** A recognised invocation with no wrapper record (hint `no_wrapper`). */
export interface TranscriptOnlyCliCall {
  call: TranscriptCliCall;
  slot: number;
  recognized: RecognizedCliCall;
}

export interface WrapperMatchResult {
  matched: MatchedWrapperRecord[];
  indirect: IndirectWrapperRecord[];
  transcriptOnly: TranscriptOnlyCliCall[];
}

interface Window {
  call: TranscriptCliCall;
  order: number;
  start: number;
  end: number;
}

function windowOf(call: TranscriptCliCall, order: number): Window | null {
  if (call.ts === null) return null;
  const end =
    call.resultTs !== null && call.resultTs >= call.ts
      ? call.resultTs
      : call.ts;
  return {
    call,
    order,
    start: call.ts - MATCH_WINDOW_SLACK_MS,
    end: end + MATCH_WINDOW_SLACK_MS,
  };
}

function capturedBytes(record: WrapperCallRecord): number {
  return record.bytes.stdout + record.bytes.stderr;
}

/** DD-12 `cut` of a record, given the agent-saw bytes of the `tool_use` that ran it. */
export function isCut(
  record: WrapperCallRecord,
  agentSawBytes: number | null,
): boolean {
  if (record.consumerClosed) return true;
  return agentSawBytes !== null && agentSawBytes < capturedBytes(record);
}

/** Matches the tree's wrapper records to its transcript CLI calls (rules above). */
export function matchWrapperRecords(
  records: readonly WrapperCallRecord[],
  transcriptCliCalls: readonly TranscriptCliCall[],
): WrapperMatchResult {
  // Earliest tool_use first for ties: by ts (the window start is ts minus a constant), then
  // input order.
  const windows = transcriptCliCalls
    .map((call, i) => windowOf(call, i))
    .filter((w): w is Window => w !== null)
    .sort((a, b) => a.start - b.start || a.order - b.order);
  const used = new Map<TranscriptCliCall, Set<number>>();
  const isUsed = (call: TranscriptCliCall, slot: number) =>
    used.get(call)?.has(slot) === true;
  const markUsed = (call: TranscriptCliCall, slot: number) => {
    let set = used.get(call);
    if (set === undefined) {
      set = new Set();
      used.set(call, set);
    }
    set.add(slot);
  };

  const ordered = [...records].sort(
    (a, b) =>
      a.startedAtMs - b.startedAtMs ||
      (a.callId < b.callId ? -1 : a.callId > b.callId ? 1 : 0),
  );

  const matched: MatchedWrapperRecord[] = [];
  const indirect: IndirectWrapperRecord[] = [];

  for (const record of ordered) {
    const at = record.startedAtMs;
    const toolKey = normalizeToolName(record.tool);
    const firstArg = record.args[0];
    const containing = windows.filter((w) => w.start <= at && at <= w.end);

    let hit: { w: Window; slot: number } | null = null;
    for (const w of containing) {
      const slot = w.call.recognized.findIndex(
        (r, i) =>
          !isUsed(w.call, i) &&
          normalizeToolName(r.tool) === toolKey &&
          r.args[0] === firstArg,
      );
      if (slot >= 0) {
        hit = { w, slot };
        break;
      }
    }

    if (hit !== null) {
      markUsed(hit.w.call, hit.slot);
      matched.push({
        record,
        call: hit.w.call,
        slot: hit.slot,
        cut: isCut(record, hit.w.call.agentSawBytes),
      });
      continue;
    }

    let link: Window | null = null;
    for (const w of containing) {
      const ts = w.call.ts ?? Number.NEGATIVE_INFINITY;
      if (ts > at) continue;
      if (link === null || ts >= (link.call.ts ?? Number.NEGATIVE_INFINITY)) {
        link = w;
      }
    }
    if (link === null && containing.length > 0) link = containing[0];
    indirect.push({
      record,
      toolUseId: link?.call.toolUseId ?? null,
      cut: record.consumerClosed,
    });
  }

  const transcriptOnly: TranscriptOnlyCliCall[] = [];
  for (const call of transcriptCliCalls) {
    call.recognized.forEach((recognized, slot) => {
      if (!isUsed(call, slot)) transcriptOnly.push({ call, slot, recognized });
    });
  }

  return { matched, indirect, transcriptOnly };
}
