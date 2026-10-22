/**
 * Tool-call core (DD-1, DD-2, DD-2a, DD-4, DD-22, DD-22a; algorithm doc
 * `tool-call-sections.md`). The only place that decides where a tool is shown, how a call is
 * joined to its result, and which call a permission event belongs to.
 */

import { outcomeToStatus } from './tool-outcome';
import type {
  AssistantEvent,
  ContentBlock,
  FileAccess,
  TelemetryEvent,
  ToolCallDetail,
  ToolSection,
  UserEvent,
} from './types';

// ---------------------------------------------------------------------------
// Sections (DD-1)
// ---------------------------------------------------------------------------

type FileToolName = FileAccess['tool'];

const FILE_TOOL_LIST: readonly FileToolName[] = [
  'Read',
  'Edit',
  'Write',
  'MultiEdit',
  'Glob',
];

/**
 * Tool name → section. Anything not listed (MCP tools, NotebookEdit, the legacy `Task`,
 * unknown and new tools) is `'tool'`.
 */
export const TOOL_SECTION: Readonly<Record<string, ToolSection>> = (() => {
  const map: Record<string, ToolSection> = {};
  for (const name of FILE_TOOL_LIST) map[name] = 'file';
  map['Skill'] = 'skill';
  map['Agent'] = 'agent';
  return map;
})();

export function toolSection(name: string): ToolSection {
  return Object.prototype.hasOwnProperty.call(TOOL_SECTION, name)
    ? TOOL_SECTION[name]
    : 'tool';
}

/** The tools of section `'file'`, derived from `TOOL_SECTION`. */
export const FILE_TOOL_NAMES: ReadonlySet<FileToolName> = new Set(
  FILE_TOOL_LIST.filter((name) => toolSection(name) === 'file'),
);

/** Narrows a tool name to `FileAccess['tool']` when it is a file tool. */
export function isFileToolName(name: string): name is FileToolName {
  return FILE_TOOL_LIST.some((n) => n === name) && toolSection(name) === 'file';
}

/** Slack around a call's lifetime within which a permission event may belong to it (DD-22). */
export const PERMISSION_WINDOW_MS = 2000;

/** `FileAccess.error` is the result's first line cut to this many chars (DD-21). */
export const FILE_ERROR_MAX_CHARS = 200;

// ---------------------------------------------------------------------------
// Deep compare over JSON values (DD-22a)
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep equality of JSON values; key order is ignored, arrays compare by position. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]),
    );
  }
  return false;
}

/**
 * `sub` is a deep subset of `sup`: every key of `sub` exists in `sup` with a deep-subset value.
 * Arrays compare by position (same length, element-wise subset); other values must be equal.
 */
export function deepSubset(sub: unknown, sup: unknown): boolean {
  if (sub === sup) return true;
  if (Array.isArray(sub)) {
    if (!Array.isArray(sup) || sub.length !== sup.length) return false;
    return sub.every((item, i) => deepSubset(item, sup[i]));
  }
  if (isPlainObject(sub)) {
    if (!isPlainObject(sup)) return false;
    return Object.keys(sub).every(
      (k) =>
        Object.prototype.hasOwnProperty.call(sup, k) &&
        deepSubset(sub[k], sup[k]),
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Result index (DD-2)
// ---------------------------------------------------------------------------

export interface ToolResultEntry {
  /** Result text; binary parts are replaced by `[binary data, N bytes]`. */
  content: string;
  isBinary: boolean;
  isError: boolean;
  /** Timestamp of the user line that holds the result. */
  timestamp?: string;
  /** `toolUseResult.interrupted === true` on the result line. */
  interrupted: boolean;
  /**
   * Raw result size: the string's length, or the summed length of the text blocks. Absent when
   * the block has no string/array content.
   */
  bytes?: number;
  /** uuid of the user line that holds the result. */
  uuid?: string;
  /** The result line's top-level `toolDenialKind`. */
  denialKind?: string;
}

type ContentValue = ContentBlock['content'];

function resultContent(c: ContentValue): {
  content: string;
  isBinary: boolean;
} {
  if (typeof c === 'string') {
    const isBin = c.startsWith('data:') || c.includes('\0');
    if (isBin) {
      const bytes = Math.floor((c.length * 3) / 4);
      return { content: `[binary data, ${bytes} bytes]`, isBinary: true };
    }
    return { content: c, isBinary: false };
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
    return { content: text, isBinary: hasBin };
  }
  return { content: '', isBinary: false };
}

function resultBytes(c: ContentValue): number | undefined {
  if (typeof c === 'string') return c.length;
  if (Array.isArray(c)) {
    return c.reduce(
      (sum, b) => sum + (typeof b.text === 'string' ? b.text.length : 0),
      0,
    );
  }
  return undefined;
}

/**
 * One pass over a log: `tool_use_id` → its result. The first result for an id wins, as in the
 * per-call scans this replaces.
 */
export function buildToolResultIndex(
  events: TelemetryEvent[],
): Map<string, ToolResultEntry> {
  const index = new Map<string, ToolResultEntry>();
  for (const e of events) {
    if (e.type !== 'user') continue;
    const ue = e as UserEvent;
    const content = ue.message?.content;
    if (!content || typeof content === 'string') continue;
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const id = block.tool_use_id;
      if (!id || index.has(id)) continue;
      const { content: text, isBinary } = resultContent(block.content);
      const bytes = resultBytes(block.content);
      const denialKind = ue.toolDenialKind;
      index.set(id, {
        content: text,
        isBinary,
        isError: block.is_error === true,
        ...(ue.timestamp ? { timestamp: ue.timestamp } : {}),
        interrupted: ue.toolUseResult?.interrupted === true,
        ...(bytes !== undefined ? { bytes } : {}),
        ...(ue.uuid ? { uuid: ue.uuid } : {}),
        ...(typeof denialKind === 'string' && denialKind !== ''
          ? { denialKind }
          : {}),
      });
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// Raw calls (DD-2a) and call details (DD-3, DD-4)
// ---------------------------------------------------------------------------

export interface RawToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  timestamp?: string;
}

/**
 * Every assistant `tool_use` block of the log — or of one turn when `uuidSet` is given. With
 * `skipSidechain`, `isSidechain: true` assistant lines are skipped.
 */
export function extractRawToolCalls(
  events: TelemetryEvent[],
  opts: { uuidSet?: Set<string>; skipSidechain?: boolean } = {},
): RawToolCall[] {
  const { uuidSet, skipSidechain } = opts;
  const calls: RawToolCall[] = [];
  for (const e of events) {
    if (e.type !== 'assistant') continue;
    if (uuidSet && (!e.uuid || !uuidSet.has(e.uuid))) continue;
    if (skipSidechain && e.isSidechain === true) continue;
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

function durationMs(startedAt?: string, endedAt?: string): number | undefined {
  if (!startedAt || !endedAt) return undefined;
  const d = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(d) && d >= 0 ? d : undefined;
}

/**
 * Every call with its section, status (DD-3), timing (DD-4) and result, stably sorted by
 * `startedAt` (calls without a timestamp last).
 */
export function buildAllToolCalls(
  rawCalls: RawToolCall[],
  index: Map<string, ToolResultEntry>,
): ToolCallDetail[] {
  const sorted = [...rawCalls].sort((a, b) => {
    if (!a.timestamp && !b.timestamp) return 0;
    if (!a.timestamp) return 1;
    if (!b.timestamp) return -1;
    return a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0;
  });

  return sorted.map((call) => {
    const r = index.get(call.id);
    const outcome = outcomeToStatus(
      r
        ? {
            isError: r.isError,
            text: r.content,
            interrupted: r.interrupted,
            ...(r.denialKind !== undefined ? { denialKind: r.denialKind } : {}),
          }
        : null,
    );
    const startedAt = call.timestamp;
    const endedAt = r?.timestamp;
    const duration = durationMs(startedAt, endedAt);
    const detail: ToolCallDetail = {
      id: call.id,
      name: call.name,
      input: call.input,
      section: toolSection(call.name),
      ...(r && r.content ? { result: r.content } : {}),
      ...outcome,
      ...(startedAt ? { startedAt } : {}),
      ...(endedAt ? { endedAt } : {}),
      ...(duration !== undefined ? { durationMs: duration } : {}),
    };
    return detail;
  });
}

// ---------------------------------------------------------------------------
// Permission events (DD-2a, DD-22)
// ---------------------------------------------------------------------------

export interface PermissionEvent {
  kind: 'request' | 'denied';
  toolName: string;
  /** The hook's `tool_input`; `null` on old hooks that did not record it. */
  toolInput: unknown;
  /** Epoch ms of the event. */
  ts: number;
  /** `tool_use_id` — recorded on `PermissionDenied` from hook 2.24.0, never on requests. */
  toolUseId?: string;
}

/** Artisyn `PermissionRequest` / `PermissionDenied` events of the whole log, by time. */
export function extractPermissionEvents(
  events: TelemetryEvent[],
): PermissionEvent[] {
  const out: PermissionEvent[] = [];
  for (const e of events) {
    if (e.type !== 'artisyn') continue;
    const ae = e as {
      type: string;
      hook_event_name?: string;
      tool_name?: string;
      tool_input?: unknown;
      tool_use_id?: unknown;
      timestamp?: string;
    };
    if (!ae.hook_event_name || !ae.timestamp) continue;
    const kind =
      ae.hook_event_name === 'PermissionRequest'
        ? 'request'
        : ae.hook_event_name === 'PermissionDenied'
          ? 'denied'
          : null;
    if (kind === null) continue;
    const ts = Date.parse(ae.timestamp);
    if (Number.isNaN(ts)) continue;
    out.push({
      kind,
      toolName: ae.tool_name ?? '',
      toolInput: ae.tool_input ?? null,
      ts,
      ...(typeof ae.tool_use_id === 'string' && ae.tool_use_id !== ''
        ? { toolUseId: ae.tool_use_id }
        : {}),
    });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function isFlagged(
  call: ToolCallDetail,
  kind: PermissionEvent['kind'],
): boolean {
  return kind === 'request'
    ? call.permissionRequested === true
    : call.permissionDenied === true;
}

function flag(call: ToolCallDetail, kind: PermissionEvent['kind']): void {
  if (kind === 'request') call.permissionRequested = true;
  else call.permissionDenied = true;
}

function matchScore(call: ToolCallDetail, toolInput: unknown): number {
  if (toolInput === null || toolInput === undefined) return 1;
  if (deepEqual(call.input, toolInput)) return 3;
  if (deepSubset(call.input, toolInput)) return 2;
  return 0;
}

/**
 * DD-22: sets `permissionRequested` / `permissionDenied` on the call each event belongs to
 * (mutates `calls`). An event with `tool_use_id` takes that call; otherwise the candidates are
 * same-name calls not yet flagged for the event's kind and pending at `t` (within
 * `PERMISSION_WINDOW_MS`), scored 3 = equal input, 2 = the call's input is a subset of the
 * event's, 1 = the event has no input. Highest score wins; a tie goes to the latest
 * `startedAt ≤ t` (else the earliest start). No candidate → unattributed; never name-only.
 */
export function attributePermissionEvents(
  permEvents: PermissionEvent[],
  calls: ToolCallDetail[],
): { unattributed: number } {
  let unattributed = 0;
  const events = [...permEvents].sort((a, b) => a.ts - b.ts);

  for (const ev of events) {
    if (ev.toolUseId !== undefined) {
      const byId = calls.find((c) => c.id === ev.toolUseId);
      if (byId) flag(byId, ev.kind);
      else unattributed++;
      continue;
    }

    const t = ev.ts;
    let best: ToolCallDetail | null = null;
    let bestScore = 0;
    let bestStart = 0;
    for (const call of calls) {
      if (call.name !== ev.toolName) continue;
      if (isFlagged(call, ev.kind)) continue;
      if (!call.startedAt) continue;
      const start = Date.parse(call.startedAt);
      if (Number.isNaN(start)) continue;
      const endParsed = call.endedAt ? Date.parse(call.endedAt) : NaN;
      const end = Number.isNaN(endParsed) ? Infinity : endParsed;
      if (t < start - PERMISSION_WINDOW_MS || t > end + PERMISSION_WINDOW_MS)
        continue;
      const score = matchScore(call, ev.toolInput);
      if (score === 0) continue;
      if (
        best === null ||
        score > bestScore ||
        (score === bestScore && betterTieBreak(start, bestStart, t))
      ) {
        best = call;
        bestScore = score;
        bestStart = start;
      }
    }

    if (best) flag(best, ev.kind);
    else unattributed++;
  }

  return { unattributed };
}

/** Tie-break: prefer the latest start at or before `t`; failing that, the earliest start. */
function betterTieBreak(start: number, bestStart: number, t: number): boolean {
  const startBefore = start <= t;
  const bestBefore = bestStart <= t;
  if (startBefore !== bestBefore) return startBefore;
  return startBefore ? start > bestStart : start < bestStart;
}
