import type {
  SessionLogLine,
  SessionLogPart,
  SessionLogPartsManifest,
  SessionLogsData,
} from '../../../api';

/** The identity of one part across revisions: its session id plus its log type. */
export function sessionLogPartKey(
  part: Pick<SessionLogPart, 'sessionId' | 'logType'>,
): string {
  return `${part.logType}:${part.sessionId}`;
}

/** The root's own parts (`claude`, `artisyn`) — everything else is a sub-agent part. */
export function isRootSessionLogPart(part: SessionLogPart): boolean {
  return part.logType !== 'claude-subagent';
}

/**
 * Builds the legacy `SessionLogsData` shape from the parts manifest plus the bodies loaded so far
 * (`bodies`, keyed by {@link sessionLogPartKey}), so every existing view keeps its props.
 *
 * - `main` is the root's artisyn lines followed by its claude lines — the same merge order the
 *   legacy `/logs` route writes (impl-plan DD-4, DD-11).
 * - `subagents` holds only the sub-agent parts whose body is loaded, in manifest order.
 */
export function assembleSessionLogs(
  manifest: SessionLogPartsManifest,
  bodies: ReadonlyMap<string, SessionLogLine[]>,
): SessionLogsData {
  let artisyn: SessionLogLine[] = [];
  let claude: SessionLogLine[] = [];
  const subagents: SessionLogsData['subagents'] = [];
  for (const part of manifest.parts) {
    const lines = bodies.get(sessionLogPartKey(part));
    if (lines === undefined) continue;
    if (part.logType === 'artisyn') artisyn = lines;
    else if (part.logType === 'claude') claude = lines;
    else {
      subagents.push({
        sessionId: part.sessionId,
        parentSessionId: part.parentSessionId,
        agentDescription: part.agentDescription,
        workflowPhase: part.workflowPhase,
        logs: lines,
      });
    }
  }
  return {
    main: artisyn.length === 0 ? claude : [...artisyn, ...claude],
    subagents,
    subagentStats: manifest.subagentStats,
    rootStats: manifest.rootStats,
    workflows: manifest.workflows,
    turnEndAdvisor: manifest.turnEndAdvisor,
    sessionAttribution: manifest.sessionAttribution,
    harnessSnapshot: manifest.harnessSnapshot,
  };
}
