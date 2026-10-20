import { parseSessionLogs, stripAgentPrefix } from '../log-parser';
import type { ParsedSession } from '../types';
import type { SubagentLogsMap } from './chart-data';

/**
 * Sub-agent transcript parsing and labelling for the Charts tab — pure and
 * React-free. `SessionChartsTab` feeds the labelled list to `ContextUsageTab`.
 */

/** One parsed sub-agent transcript with its display label. */
export interface SubagentSessionEntry {
  /** Bare agent id (post-`stripAgentPrefix`). */
  agentId: string;
  /** `"<workflow name>:Agent N"` for a workflow member, else `"Agent N"`. */
  label: string;
  session: ParsedSession;
}

/**
 * Parses every sub-agent transcript once, keyed by bare agent id. An
 * unparseable entry is skipped, so its agent simply has no session.
 */
export function parseAgentSessions(
  subagentLogsMap?: SubagentLogsMap,
): Map<string, ParsedSession> {
  const sessions = new Map<string, ParsedSession>();
  if (!subagentLogsMap) return sessions;
  for (const [rawId, logs] of subagentLogsMap.entries()) {
    try {
      sessions.set(
        stripAgentPrefix(rawId),
        parseSessionLogs(logs, { isSubagent: true }),
      );
    } catch {
      // Unparseable transcript — deliberately swallowed, see above.
    }
  }
  return sessions;
}

/**
 * Bare agentId -> owning workflow's name, over every `turn.workflows[]` entry.
 * `agentSessionIds` carries a workflow's full multi-level agent linkage, so
 * nested workflow agents are members too.
 */
function workflowNameByAgentId(session: ParsedSession): Map<string, string> {
  const names = new Map<string, string>();
  for (const turn of session.turns) {
    for (const wf of turn.workflows ?? []) {
      for (const rawId of wf.agentSessionIds ?? []) {
        names.set(stripAgentPrefix(rawId), wf.name);
      }
    }
  }
  return names;
}

/**
 * The labelled sub-agent session list — `"<workflow name>:Agent N"` for a
 * workflow member, `"Agent N"` otherwise.
 *
 * Numbering is **positional over `subagentLogsMap`**, and `N` advances for every
 * entry whether or not it parsed, so `ContextUsageTab`'s labels stay stable.
 *
 * `agentSessions` defaults to a fresh `parseAgentSessions` call; a caller that
 * already parsed the map can pass it so nothing is parsed twice.
 */
export function buildSubagentSessions(
  parsedLogs: ParsedSession,
  subagentLogsMap?: SubagentLogsMap,
  agentSessions: Map<string, ParsedSession> = parseAgentSessions(
    subagentLogsMap,
  ),
): SubagentSessionEntry[] {
  if (!subagentLogsMap || subagentLogsMap.size === 0) return [];
  const workflowNames = workflowNameByAgentId(parsedLogs);
  const entries: SubagentSessionEntry[] = [];
  let idx = 1;
  for (const rawId of subagentLogsMap.keys()) {
    const agentId = stripAgentPrefix(rawId);
    const session = agentSessions.get(agentId);
    if (session) {
      const workflowName = workflowNames.get(agentId);
      entries.push({
        agentId,
        label: workflowName ? `${workflowName}:Agent ${idx}` : `Agent ${idx}`,
        session,
      });
    }
    idx++;
  }
  return entries;
}
