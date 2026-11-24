---
type: "Research"
title: "Client consumers of session logs and loading in parts"
description: "Which client views need the root only, one sub-agent, or every sub-agent; what the header derives on open; parser behaviour with missing sub-agent bodies."
---

# Client consumers of session logs and loading in parts (2026-11-23)

Read-only survey. Paths relative to `client/src/viewer/`.

## Current data flow

- `SessionLogsData` (`api.ts:1625-1696`): `main`, `subagents[{sessionId,parentSessionId,agentDescription,workflowPhase,logs}]`,
  `subagentStats` (keyed `agent-<id>`, `api.ts:1457-1518`, no 5m/1h cache-write split), `rootStats`,
  `workflows`, `turnEndAdvisor`, `sessionAttribution`, `harnessSnapshot`. Only caller of
  `fetchSessionLogs` besides `useRepositoryData` is `pages/repository/session-export-runner.ts:82`.
- `pages/repository/useRepositoryData.ts` returns `logsQuery`, `subagentLogsMap` (324-333),
  `agentParentMap` (337-340), `parsedLogs` (348-358), `isReloadingUpdatedSession` (240-243); key
  `['session-logs', repoId, sid, teamId]` (159-163), invalidated at `useRepositoryData.ts:221,236`,
  `SessionDetailPane.tsx:115`, `session-map/useSessionMapData.ts:104`.
- Parse duplicated: `useRepositoryData.ts:348`, `SessionLogView.tsx:89-102`, root-only
  `CallTreeView.tsx:71-76`.

## Classification

- **Root only:** RawLogs, Sysctx anatomy, Advisor, Info / `SessionDetailHeader`
  (`computeSessionInfoDerived`), change-surface / okf / tools / otel tabs (own fetches), Session Map
  (own delta route).
- **One sub-agent on demand:** `AgentActivationItem.tsx:51-55` (renders header from root data when
  body absent; parses eagerly today), `ToolViewContext.tsx:76-96` `openSubAgent` (opens
  `WorkflowAgentModal.tsx`, needs the agent and its descendants), workflow agent rows
  (`buildAgentNodesForIds`, `log-parser.ts:1242-1258`, skip ids without body), tool deep link
  `findTurnIndexForToolUse` (`session-log/tool-use-turn.ts:53-75`, scans all subagent logs).
- **All sub-agents:** Bash tab (`collect-bash-calls.ts:73-76`), every chart tab id (`dashboard`,
  `context-growth`, `context-usage`, `agent-tree`, `timeline`, `tool-heatmap`, `call-tree`;
  `SessionChartsTab.tsx:74-114` computes all eagerly), Usage tab, Harness usage
  (`harness-session-tree.ts:217-353`), session export.
- **Logs and Summary tabs** price "+subagent" per turn from bodies: `computeTurnDirectAgentCost`
  (`session-log/log-parser.ts:1606-1639`, `extractSubagentStats` per id) and
  `computeWorkflowCostPerToken` (:1656-1698). With token counts from `subagentStats` (plus the 5m/1h
  split, which `session_stats.cache_write_5m_tokens` / `cache_write_1h_tokens` already hold) they need
  no bodies.

## Header figures on open (`SessionDetailPane.tsx`)

- `usage = deriveSessionUsage(main, all subagent logs)` (:134-137) feeds `codeImpact`
  (`session-log/tree-code-impact.ts:160-201`): tree figures already come from `subagentStats` /
  `rootStats`; own figures are root-only → a root-only `usage` is enough.
- `toolsFailure` (:145-148, MCP failures across tree) and `bashCount` (:157-160, tab badge and
  Summary cards) have no server counterpart → known only after all parts are loaded.
- Sub-agent cost on the header comes from the session list row (`costBreakdown.subagentCost`).

## Parser with missing sub-agent bodies (`session-log/log-parser.ts`)

1. `isAgentUsagePricedElsewhere` (:317-324) excludes an agent's inline `toolUseResult.usage` only when
   `subagentLogs.has(agentId)` → root token totals shift as parts arrive. Must decide from the set of
   known part ids (manifest), not loaded bodies.
2. Depth ≥ 2 nested agents in `turn.subAgents` need the parent's body (:1824-1866, :2254-2277);
   depth-1 comes from root `agent_progress`.
3. Permission attribution diagnostics read sub-agent logs (:1864).
4. Workflow agent rows skip agents without body (:1254).

## UI pieces to reuse

- Banner `SessionDetailPane.tsx:268-273` (indigo strip + `Loader2`); progress bar markup
  `SessionExportProgressModal.tsx:37-46`; no shared `progress.tsx`; no parse-indicator component yet.
- Sizes: `SessionDetailPane.tsx` 12.4 KB (over soft 10 KB limit — do not grow), `SessionTabContent.tsx`
  9.8 KB, `CallTreeView.tsx` 16.3 KB, `SessionLogView.tsx` 8.7 KB. Hard limit 20 KB.
