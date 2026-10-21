# 2026-10-21: Workflow Agent Labels From .meta.json

**Status:** todo
**Priority:**
**Type:** feature
**Module(s):** hook, server, client
**Owner:** denis.tsyplakov
**Created:** 2026-10-21

## Description

Follow-up to 2026-10-21-workflow-session-readability.

Every row of the workflow Agents table (`WorkflowAgentsTable`, label from `agentRowLabel` in
`client/src/viewer/pages/repository/session-log/workflow-agent-rows.ts`) shows the same label: the
label is the cleaned prompt, and every workflow agent's first user record is the shared harness
relay "[Workflow harness — user request] The harness relays, verbatim…" (the second record,
"[Workflow harness — computed task]", also starts with a shared template).

The hook already reads each sub-agent's sibling `<agent-id>.meta.json` (`readParentAgentId` in
`hook/.claude/telemetry_tool/send-logs-hook.js`), but only for `parentAgentId`. The same file
carries `description` (the workflow script's agent label, e.g. `chunk-6-Tests`, `load-config`) and
`workflowPhase` (e.g. `Implement`). Send both to the server, store them per agent session, return
them in the session `/logs` payload, and use `description` as the Agents-table label.

Example `.meta.json` next to a workflow agent transcript
(`subagents/workflows/<wf-run>/agent-<id>.meta.json`):

```json
{"agentType":"workflow-subagent","description":"chunk-6-Tests","workflowPhase":"Implement","spawnDepth":1,"requestShape":"foreground","requestNonInteractive":false}
```

## Functional Requirements

- FR-1: The hook reads `description` and `workflowPhase` from each sub-agent's sibling
  `<agent-id>.meta.json` (both the `subagents/` and the `subagents/workflows/<wf-run>/` scans,
  same file as `parentAgentId`) and sends them with that agent's upload as optional query params
  `agentDescription` and `workflowPhase` on `POST /api/v2/logs`, the same way `workflowRunId` is
  sent (`upload-logs.js`, plain and chunked paths).
- FR-2: The server accepts both params for `claude-subagent` uploads, carries them through the
  upload queue (like `workflowRunId`), and stores them on the agent's `sessions` row in new
  nullable columns (migration).
- FR-3: `GET /api/v1/repositories/:repoId/sessions/:sessionId/logs` returns, for each entry of
  `subagents`, `agentDescription` and `workflowPhase` (`null` when unknown), next to
  `parentSessionId`.
- FR-4: `agentRowLabel` labels a row with the agent's `agentDescription` when it is non-empty,
  otherwise with today's prompt-derived label; the same `AGENT_LABEL_LIMIT` cut applies to both.
- FR-5: Backward compatibility: a session uploaded by an old hook (no new params) renders exactly
  as today; an old server ignores the new query params and accepts the upload.

## Acceptance Criteria

- [ ] A workflow run uploaded by the new hook shows each agent's `.meta.json` `description` (e.g.
      `chunk-6-Tests`, `load-config`) as its Task label in the Agents table.
- [ ] An agent whose `.meta.json` is missing, malformed, or has no `description` shows the
      prompt-derived label, as today, and its upload still succeeds.
- [ ] A session uploaded by an old hook (no new params) renders exactly as today; `/logs` returns
      `agentDescription: null`, `workflowPhase: null` for its agents.
- [ ] An upload from the new hook to a server without this change still succeeds.
- [ ] Repository export/import round-trips `agentDescription` and `workflowPhase`; an archive
      exported before this change imports with both `null`.
- [ ] Contract registry rows: `POST /api/v2/logs` with the new params
      (`server/test/contract/registry/f15-ingest.ts`) and the `/logs` response fields
      (`f17-sessions.ts`).
- [ ] `docs/knowledgebase/algorithms/workflow-agent-rows.md` gains label rows for "description
      present" and "description empty → prompt fallback".
- [ ] A step in an existing workflow scenario (`tests/scenarios/view/s-sess-03.spec.ts` or
      `s-sess-04.spec.ts`) checks a description-derived Agents-table label.

## Common sense considerations

- The hook reads `.meta.json` once per agent (one helper returns `parentAgentId`, `description`,
  `workflowPhase`), fail-open as today; non-string or empty values are not sent.
- Both values are capped at 255 characters (hook truncates; server columns are `varchar(255)`).
- A later upload without the params never overwrites stored values (same upsert rule as
  `workflowRunId`).
- `agentType`, `spawnDepth`, `requestShape`, `requestNonInteractive` are not sent.
- `workflowPhase` is stored and returned only; it is not displayed in this task.
- The label change is limited to the workflow Agents table and its agent modal title (both use
  `agentRowLabel`).
- The hook change follows `.claude/rules/hook.md` (installer rebuild, dogfooded install refresh).

## Open Questions

- Should `workflowPhase` be shown in the Agents table (a Phase column or grouping by phase) in this
  task, or stay stored-only until a follow-up?
- Should `agentDescription` also replace the prompt start where sub-agents are named elsewhere (the
  turn-level Sub-agents tree, the Charts tab Agent Tree), or only in the workflow Agents table?

## Notes

<!-- Append timestamped notes here as work progresses -->
