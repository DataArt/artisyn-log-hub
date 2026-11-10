---
type: "Reference"
title: "Twins Registry and Cross-Cutting Rules"
description: "Every rule, constant or list that lives in more than one package (server, client, hook, installer, packages) with each copy's file and the test that pins them, plus one-line cross-cutting rules (env vars, lazy chunks, installer-written keys, background jobs, Workflow status) with their reason and owning article."
tags:
  - twins
  - invariants
  - backward-compatibility
timestamp: "2026-11-09T00:00:00+04:00"
---

# Twins Registry and Cross-Cutting Rules

Read before changing any constant, regex, list or rule that may also exist in another package, and
before adding an env var, a lazy chunk, a hook-written setting, a background job or a Workflow
status rule.

## Why twins exist and why they bite

`client/`, `server/`, `hook/` and `artisyn-hooks-installer/` share no runtime code except the
repo-local packages ([repo-local-packages.md](repo-local-packages.md)). The hook is plain CommonJS
on every Node LTS with built-ins only, so it cannot import a package; the OTEL receiver scripts
cannot even `require` each other ([otel-receiver.md](otel-receiver.md)). So some logic is copied by
hand, marked in code with `Twin:`, `mirrors`, `Hand-port of` or `keep in sync`.

A hook copy is the dangerous one: the hook runs on users' machines and is upgraded late. A change to
the server copy is live at once, while installed hooks keep the old rule for weeks. Change the hook
copy in the same task, bump the hook version, and make the server tolerate the old hook's output
([hook-api-versioning.md](hook-api-versioning.md)).

To find copies not listed here: `grep -rnE "Twins?:|keep in sync|Hand-port|mirrors \`"` over
`server/src`, `client/src`, `hook/.claude/telemetry_tool`, `artisyn-hooks-installer/src`.

## Twins registry

"Doc" is the algorithm doc whose examples table drives the test; its "Twins" field lists the exact
known differences between copies.

### Server ↔ hook (hook ports of server logic)

| Logic / value | Copies | Test that pins them |
|---|---|---|
| Cost formula (per-call tiers, cache, fast mode) | `packages/pricing/src/cost.ts` (server + client); hook `post-turn-analysis-worker.js` (`computeLocalSessionCost`, `pickCallRates`) | Doc [cost-formula](algorithms/cost-formula.md); `hook/.claude/telemetry_tool/__tests__/cost-formula.algo.test.js` |
| `FAST_MODE_MULTIPLIER` | `packages/pricing/src/cost.ts`; hook `post-turn-analysis-worker.js` | via the cost-formula rows only |
| Work time | `server/src/logs/claude-extractor.ts` (`computeWorkTime`); hook `post-turn-analysis-worker.js` (`deriveWorkTimeMs`). The client's per-turn work time is a different algorithm | Doc [work-time](algorithms/work-time.md); `claude-extractor.algo.spec.ts`, `__tests__/work-time.algo.test.js` |
| Rejection markers and tool outcome | `server/src/logs/tool-stats.ts` (`REJECTION_MARKERS`, `classifyToolOutcome`); hook `post-turn-analysis-worker.js` (hand-port, third copy, see client row below). Since hook 2.31.2 the hook copy follows the server: the background-MCP rule (`background.status` null → `unresolved`, `completed` → `success`, other → `failure`) first, then `interrupted`, `toolDenialKind` → `unresolved`, and the rejection marker only on `is_error` results | **none** for the hook copy (pinning it to `tool-call-outcome.json` is task `2026-11-03-pin-twins-with-tests`) |
| Background-MCP join (`BACKGROUND_ACK_RE`, `matchBackgroundAckTaskId`, `isBackgroundCandidate`, `collectBackgroundTaskNotifications`) | `server/src/logs/background-mcp.ts` (source of truth; reuses `parseTaskNotification` from `workflow-extractor.ts`); client `client/.../session-log/background-mcp.ts` (own tag parser, `QueueOperationLine` guard); hook `post-turn-analysis-worker.js` (plain-JS port, used by `deriveToolUsage`). Rules: [tool-monitoring.md](tool-monitoring.md) § "Background MCP calls" | Scenario fixtures `tests/scenarios/fixtures/bg-mcp/` (server + client); **none** for the hook copy |
| `KNOWN_TOP_LEVEL_DIRS`, `normaliseFilePath`, `classifyFile`, `computeToolResultBytes`, file stats by category | `server/src/logs/claude-extractor.ts`; hook `post-turn-analysis-worker.js` | **none** |
| Patch line counts (`countPatchLines`) | `server/src/logs/tool-stats.ts` (source of truth); hook `edit-result-counts.js` (`deriveEditResultCounts`) | **none**. The shared fixture `tests/fixtures/patch-line-counts.json` the hook comment names is run by no test today |
| Edit/Write tool name list | `server/src/logs/edit-tools.ts` (`EDIT_WRITE_TOOL_NAMES`); hook `edit-result-counts.js` | **none** |
| Tool-monitor name validation, denylist, capture limits | `packages/tool-monitor/` (server); hook `tool-wrap-names.js` | Doc [tool-monitor-name-validation](algorithms/tool-monitor-name-validation.md); both run every row |

### Server ↔ client

| Logic / value | Copies | Test that pins them |
|---|---|---|
| Tool outcome (`classifyToolOutcome`, markers, `MAX_RESULT_TEXT_SCAN`) | `client/.../session-log/tool-outcome.ts`; `server/src/logs/tool-stats.ts` | Doc [tool-call-outcome](algorithms/tool-call-outcome.md); both sides |
| Prompt qualification (`isQualifyingUserEvent` ↔ `isNonQualifyingPromptContent`) | `client/.../session-log/log-parser.ts`; `server/src/logs/claude-extractor.ts` | golden sessions only |
| Default file categories, path normalisation | `client/.../session-log/log-parser.ts` (`DEFAULT_REPO_CONFIG`); `server/src/logs/claude-extractor.ts` (`DEFAULT_FILE_CATEGORIES`, `normaliseFilePath`) | **none** |
| Deferred-tools detection | `client/.../session-log/log-parser.ts`; `server/src/logs/turn-walk.ts` (port) | **none** |
| Cache-read ratio and its aggregate | `server/src/logs/cache-ratio.sql.ts`; `client/src/viewer/lib/format.ts`, `client/.../analytics/cache-ratio-aggregate.ts` | Doc [cache-ratio-and-causes](algorithms/cache-ratio-and-causes.md) |
| Change-surface band (`BAND_ZONES`); file merge | server `change-surface-metrics.ts` / `change-surface.service.ts` (`mergeFileRows`); `client/src/viewer/lib/change-surface-ui.ts` | Doc [change-surface-concentration](algorithms/change-surface-concentration.md) |
| SemVer helpers (`parseVersion`, `compareVersions`, `maxVersion`) | `server/src/common/semver.ts`; `client/src/viewer/lib/semver.ts` | **none** (the "same case table" the header claims has no test file) |
| Cost-mismatch tolerance | `server/src/logs/otel-cost.sql.ts` (`COST_MISMATCH_TOLERANCE_*`); the tooltip text in `client/src/viewer/components/CostReconciliation.tsx` and the comment in `client/src/models/repositories.ts` | **none**; the text drifted once (53d1634) |
| Response types | server `*.types.ts`; client `client/src/models/*.ts` | contract registry for shape only; see [server-endpoint-map.md](server-endpoint-map.md) |
| Session-list flags | `server/src/logs/session-list-flags.ts`; startup backfill SQL `server/src/database/backfill-session-list-flags.ts`; Workflow predicate in `workflow-extractor.ts` | Doc [session-list-flags](algorithms/session-list-flags.md) |

### Hook ↔ installer, and hook-internal OTEL copies

| Logic / value | Copies | Test that pins them |
|---|---|---|
| `repoKey`, `ownerHash`, `REPO_ATTR_KEY` | hook `user-state.js`, `otel-receiver.js`, `otel-ensure-receiver.js`; installer `user-state.ts`, `otel-env.ts` | end to end only (`@S-HOOK-07`, `@S-INST-01`) |
| `SHARED_IDLE_TIMEOUT_MS`, `REGISTER_CONTRACT`, `DEFAULT_MAX_BODY_BYTES`, hello HMAC proof, hello / session-status timeouts | hook `otel-receiver.js`, `otel-register.js`, `otel-ensure-receiver.js`; installer `otel-handshake.ts` | end to end only (`@S-HOOK-07`) |
| Fallback OTEL port 25317 | hook `env-context.js` (`OTEL_FALLBACK_PORT`), `otel-receiver.js` (`DEFAULT_PORT`); installer `install.ts` (`OTEL_FALLBACK_PORT_INSTALLER`) | **none** |
| Receiver shutdown sequence | hook `otel-restart.js`; installer `otel-restart.ts` | **none** |
| Managed-settings read, `OS_POLICY_TIMEOUT_MS` | hook `managed-settings.js`; installer `managed-settings.ts` | **none** |
| OTEL keys the installer writes | installer `otel-env.ts` (`OTEL_ENV_KEYS`, `OTEL_TRACE_ENV_KEYS`); hook `otel-status.js` (`ARTISYN_OTEL_KEYS`, `PER_REPO_KEYS`) | Doc [otel-status-reason](algorithms/otel-status-reason.md) (hook side only) |

All hook paths are under `hook/.claude/telemetry_tool/`; installer paths under
`artisyn-hooks-installer/src/`.

## Cross-cutting rules

- **New server env var** → add a commented line to `release-template/.env.example`; the release
  compose needs no edit because `app` has `env_file: .env`. Never add an `environment:` entry
  without a default: it overrides `.env` and an unset `${VAR}` blanks it. See
  [deployment-auth-mode.md](deployment-auth-mode.md).
- **New lazy page or tab** → join an existing lazy-group barrel (e.g. `session-tabs-lazy-group.ts`),
  never a new `import()`: budget about 8 chunks, never more than 10. See
  [client-routing-and-layout.md](client-routing-and-layout.md) § "Code splitting".
- **New key the installer writes** into a Claude Code settings file → `otel-status.js` must accept it
  in the scope where the installer puts it, or every user gets a false warning (per-repo keys in
  `settings.local.json` are legitimately project-only). See
  [algorithms/otel-status-reason.md](algorithms/otel-status-reason.md),
  [hook-installation.md](hook-installation.md).
- **New background job or queue** → a queue table claimed with `FOR UPDATE SKIP LOCKED` by every
  cluster worker, a lease that returns lapsed `processing` rows, transient-error retry. Copy
  [upload-queue.md](upload-queue.md); other users of the pattern are listed in
  [db-tables.md](db-tables.md) (`otel_reclass_queue`, `team_repo_recompute_queue`).
- **New list or analytics read** → read derived per-session tables, never stored transcripts
  (`logs.body`); add it to the perf `-heavy` scenarios. See
  [server-conventions.md](server-conventions.md) § "Gotchas".
- **A twin changed** → change every copy above in the same task; a hook copy also needs a hook
  version bump and `npm run build:hooks-installer` (`.claude/rules/hook.md`).
- **Workflow status** (`server/src/logs/workflow-extractor.ts`): a `Workflow` call that Claude Code
  rejects before launch has an `is_error` `tool_result` and never gets a `<task-notification>`, so
  its status must come from that `tool_result` (`failed`), not only from a notification, or it stays
  `running` forever. A run launched by `scriptPath` has no `name` input: its name comes from
  `toolUseResult.workflowName`, else the script file name (de74b97, `@S-SESS-03` step 8c).
