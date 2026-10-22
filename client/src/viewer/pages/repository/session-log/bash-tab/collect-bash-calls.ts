/**
 * The Bash tab's call list (DD-17): every `Bash` call of the session tree — the main transcript,
 * then each sub-agent transcript — with its status, timing and result, numbered in time order.
 *
 * Pure — no React, no DOM, no WASM (the tab bar counts these rows without loading the parser).
 */
import {
  collectAgentTypes,
  collectSpawnedAgentTypes,
} from '../harness-usage/harness-session-tree';
import {
  attributePermissionEvents,
  buildAllToolCalls,
  buildToolResultIndex,
  extractPermissionEvents,
  extractRawToolCalls,
} from '../tool-calls';
import type { TelemetryEvent, ToolCallDetail } from '../types';

export type BashCallRow = ToolCallDetail & {
  id: string;
  /** 1-based position in the time-sorted list. */
  n: number;
  /** Bare id of the sub-agent that ran the call; `null` for the main transcript. */
  agentId: string | null;
  /** `Agent · <type>`, else `Agent <first 8 chars>`; `null` for the main transcript. */
  agentLabel: string | null;
};

type RawLog = Record<string, unknown>[];

/** Raw `/logs` lines as telemetry events — the same filter `parseSessionLogs` applies. */
function toEvents(raw: RawLog): TelemetryEvent[] {
  return raw.filter(
    (e) => e !== null && typeof e === 'object' && !Array.isArray(e),
  ) as unknown as TelemetryEvent[];
}

/**
 * `isSubagentLog` mirrors the parser and the server: only a root transcript skips its
 * `isSidechain: true` lines (inline sub-agent copies); in a sub-agent transcript every line is a
 * sidechain line and all of them are its own calls.
 */
function bashCallsOf(raw: RawLog, isSubagentLog: boolean): ToolCallDetail[] {
  const events = toEvents(raw);
  const calls = buildAllToolCalls(
    extractRawToolCalls(events, { skipSidechain: !isSubagentLog }),
    buildToolResultIndex(events),
  );
  // Same per-log attribution as Logs (DD-22), so the badges agree across tabs.
  attributePermissionEvents(extractPermissionEvents(events), calls);
  return calls.filter((c) => c.name === 'Bash');
}

function compareStartedAt(a: ToolCallDetail, b: ToolCallDetail): number {
  if (!a.startedAt && !b.startedAt) return 0;
  if (!a.startedAt) return 1;
  if (!b.startedAt) return -1;
  return a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0;
}

/**
 * Bash calls of the main transcript and every sub-agent transcript, deduped by id (fork
 * sub-agents repeat their parent's lines), stably sorted by `startedAt` (missing last) and
 * numbered after sorting.
 */
export function collectBashCalls(
  mainLogs: RawLog | null | undefined,
  subagentLogsMap: Map<string, RawLog> | null | undefined,
): BashCallRow[] {
  const main = mainLogs ?? [];
  const subs = subagentLogsMap ?? new Map<string, RawLog>();

  const agentTypes = new Map<string, string>();
  collectSpawnedAgentTypes(main, agentTypes);
  for (const logs of subs.values()) collectSpawnedAgentTypes(logs, agentTypes);
  // SubagentStart wins over the tool_use-declared type — it is what actually ran.
  collectAgentTypes(main, agentTypes);

  const seen = new Set<string>();
  const rows: Omit<BashCallRow, 'n'>[] = [];
  const add = (
    calls: ToolCallDetail[],
    agentId: string | null,
    agentLabel: string | null,
  ) => {
    for (const call of calls) {
      if (!call.id || seen.has(call.id)) continue;
      seen.add(call.id);
      rows.push({ ...call, id: call.id, agentId, agentLabel });
    }
  };

  add(bashCallsOf(main, false), null, null);
  for (const [agentId, logs] of subs) {
    const type = agentTypes.get(agentId);
    add(
      bashCallsOf(logs, true),
      agentId,
      type ? `Agent · ${type}` : `Agent ${agentId.slice(0, 8)}`,
    );
  }

  return rows.sort(compareStartedAt).map((row, i) => ({ ...row, n: i + 1 }));
}
