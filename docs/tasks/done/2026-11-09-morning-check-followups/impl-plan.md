# Implementation plan — 2026-11-09 morning check follow-ups (GH-114)

## TL;DR

- **New server module** `server/src/logs/background-mcp.ts`: `matchBackgroundAckTaskId()`, `isBackgroundCandidate()` and `collectBackgroundTaskNotifications()`.
  - It is for item 3, MCP calls that Claude Code moves to the background. That happens **since CC 2.1.212**, not 2.1.319 (bisected in the PoC); 2.1.319 only changed the defaults.
  - It joins the call's hand-off acknowledgement to the later `<task-notification>` through the task id.
  - There is a **client twin** at `client/.../session-log/background-mcp.ts`.
- **Workflow extractor:** `parseTaskNotification`, `TaskNotification` and `QueueOperationEvent` become exported. `parseTaskNotification` no longer returns null when `<tool-use-id>` is missing; the Workflow enqueue join skips those entries itself.
- **Outcome rule change, both twins:**
  - `ToolResultInfo` gains an optional `background: {status}`; algorithm rows TO-27…TO-31.
  - A new client `ToolCallStatus` value, `'background'` ("background, no result").
  - A new `DurationSource` key, `backgroundTask` (server, client and analytics accumulators).
- **Old and new Claude Code:** the join is detected by transcript shape, never by version. Transcripts without the ack (CC < 2.1.212, or calls that never moved to the background) go through today's code path unchanged.
  - Proven on real captures from a mock MCP server run with `claude -p` on CC 2.1.211, 2.1.318 and 2.1.319 (PoC `docs/pocs/2026-11-09-1318-mcp-mock-old-new-cc/`).
  - Those captures become the scenario fixtures.
- **Hook:** its copy of the outcome rule (`post-turn-analysis-worker.js`, per-tool failure counts for the turn-end advisor) gets the same background rule. Hook version **2.31.1 → 2.31.2**, with the installer rebuilt and the dogfooded copy refreshed.
- **DB:** no migration. `duration_by_source` jsonb gains a key, and `TOOL_USAGE_EXTRACTOR_VERSION` goes from 2 to 3 so stored sessions are re-extracted for the Tools/MCP tab.
- **API:** no new or changed routes. Analytics `durationBySource` objects gain a `backgroundTask` key, which is additive.
- **Installer:** `warnIfNodeEol()` prints one stderr line when Node is below 22, and the exit code is unchanged. Installer patch bump, then `npm run build:hooks-installer`, which also ships hook 2.31.2.
- **CI/infra:**
  - curl retries on every release download in `security-scans.yml` and `gitleaks.yml`.
  - Node image bump with the runtime pinned to `-alpine3.24`. **Gated** on the Node security release of 2026-11-11.
- **Docs only:**
  - Into the KB (`hook-system-overview.md`, `otel-receiver.md`):
    - item 4: `denyInsteadOfPrompting` denials;
    - item 5: PostToolUse after an interrupt;
    - item 7: OTEL for gateway sessions.
  - Item 3 is also documented in `tool-monitoring.md`, `session-log-view.md` and `twins-and-cross-cutting-rules.md`.
  - The CI retries are documented in `ci-security-scans.md`.
  - Item 8 is watch-only, with no work here.

## Reference

- Requirements: [requirements.md](requirements.md)
- PoC evidence: [notes.md](notes.md), `docs/pocs/2026-11-09-1236-cc-bg-mcp-deny-policy/`, `docs/pocs/2026-11-09-1236-hook-node18-compat/`, `docs/pocs/2026-11-09-1318-mcp-mock-old-new-cc/` (mock MCP + `claude -p` on old/new CC; the source of the scenario fixtures)
- Research archive: [research/findings-1.md](research/findings-1.md)

## Design Decisions

**DD-1 — Compatibility with old and new Claude Code** (a user constraint added in the planning session: the hook and MCP handling must work with both).
- Background-MCP handling triggers only when all three hold:
  - the tool name starts with `mcp__`;
  - the first `tool_result` is not `is_error: true`;
  - its full text matches the ack regex (DD-2).
- Nothing reads the transcript `version`.
- When there is no ack match, the call keeps today's result, status and duration. This covers:
  - transcripts from CC before 2.1.212 (the first release with the hand-off; PoC `bisect.cjs`);
  - MCP calls finished in-session;
  - Bash `run_in_background` acks, which use different wording.
- A `<task-notification>` without `<tool-use-id>` must not break the Workflow join, which still requires that tag.
- No hook route or payload changes, so old hooks keep working against the new server.
- The new hook (DD-10) uses the same shape rule, so it is correct on old and new CC too.
- Old CC can fail the first MCP call with "No such tool available" when the call races the server connect (`old-full` capture). That call is `is_error: true` with no ack, so it stays a plain failure.
- Log Hub has no MCP server of its own. The hook's `probeMcpServerTools` (`hook/.claude/telemetry_tool/send-logs-hook.js:283`) only calls `initialize` and `tools/list`, and background tasks do not affect it.

**DD-2 — Ack parsing contract** (shared by the server and client twins). The regex is `BACKGROUND_ACK_RE = /moved to the background as task ([A-Za-z0-9_-]+)/`.
- Use the PoC's character class instead of `(\S+)`, so trailing punctuation or backticks are never captured.
- Run it over the **full** flattened result text, never the 200-char `MAX_RESULT_TEXT_SCAN` cut: the match offset grows with the server/tool name.
- Fixture ack, identical wording in 2.1.318 and 2.1.319: `MCP tool "mock/slow_echo" is still running after 2s. It was moved to the background as task kkumm8n15 and keeps running; …` → `kkumm8n15`.
- Matching is split in two, because result loops know only the `tool_use_id` while names live with the calls:
  - `matchBackgroundAckTaskId(fullText: string): string | null` is name-free. It runs where the full result text is available, and its id is stored on the result record.
  - `isBackgroundCandidate(toolName: string, isError: boolean | null): boolean` (`toolName.startsWith('mcp__') && isError !== true`) runs in the call↔result join.
  - A call is background only when both hold. Both twins export the same pair.

**DD-3 — Notification collection** (both twins).
- A notification is either of these:
  - a `type:"user"` line whose `message.content` is a **string** starting (after `trimStart`) with `<task-notification>`;
  - a `type:"queue-operation"` line with `operation:"enqueue"` and string `content` holding the same XML.
- Parse `<task-id>`, `<status>` and `<result>` (trimmed), and key them by task id.
- The user line wins over the enqueue for the timestamp. The enqueue is the fallback, and it is **required**, not optional.
  - When a plain `-p` ends its turn, CC closes the MCP connection and fails the tasks.
  - It then writes **only** an enqueue, with `<status>failed</status>` and `<result>Task failed: Connection closed</result>` (`new-close` capture).
- A failed task's `<result>` is prefixed `Task failed: ` (for example `Task failed: slow_fail: d failed`). It is shown as is.
- The first notification per task id wins.
- Shape: `BackgroundTaskNotification { taskId: string; status: string; result: string | null; ts: number | null }` (`ts` is epoch ms).
- Fixture: user line at 08:41:50.613, enqueue at 08:41:50.561, `status completed`, `result "slow_echo says: hi (after 10000 ms)"`.
- An entry whose `taskId` parses as null is skipped (the map key is `string`), and a missing `<status>` becomes `''`.
- **Signatures:**
  - server `collectBackgroundTaskNotifications(lines: readonly unknown[]): Map<string, BackgroundTaskNotification>`;
  - client `collectBackgroundTaskNotifications(events: readonly TelemetryEvent[]): Map<string, BackgroundTaskNotification>`.
- Both take the parsed JSONL line objects and do their own pass, narrowing each line by `type`. They read string-content user lines, which `buildToolResultIndex` skips.
- **queue-operation types:**
  - Server: reuse `QueueOperationEvent` (`server/src/logs/workflow-extractor.ts:7`), now exported.
  - Client: `background-mcp.ts` declares a local `QueueOperationLine { type: 'queue-operation'; operation?: string; content?: unknown }` and narrows to it with a type guard. No `TelemetryEvent` union change.

**DD-4 — Outcome rule extension** (`classifyToolOutcome`, both twins).
- `ToolResultInfo` gains `background?: { status: string | null }`:
  - a matched ack sets it;
  - `status` is the notification's `<status>`, or `null` when no notification exists.
- New rule, checked right after the `result === null` rule:

  | Background state | Outcome |
  |---|---|
  | `status === null` | `unresolved` |
  | `status === 'completed'` | `success` |
  | any other status (`failed`, `killed`, `stopped`, …) | `failure` |

- Client `outcomeToStatus` maps the background states:

  | Background state | Client status |
  |---|---|
  | `status === null` | `{status:'background'}` |
  | `completed` | `{status:'success'}` |
  | any other status | `{status:'error'}` |

  It sets no `interrupted` and no `denialKind`.
- "No result" is `unresolved`, not `failure`: a call that may still be running must not inflate failure rates.

**DD-5 — Result substitution.** For a joined call with a notification:
- **Text:** the notification's `<result>` (or `''` when absent) replaces the ack text as the call's result text: Logs modal output, agent-saw text, and bytes.
- **Timestamp:** the notification `ts` replaces the result timestamp.
- **No notification:** the ack text stays as the result text, and the result timestamp stays the ack's.
- **Server tool stats:** `session_tool_stats` stores no result text or bytes, so `claude-extractor.ts` passes only `background` and `backgroundEndTs`.
- **Server MCP calls** (`mcp-call-extractor.ts`): `collectToolUses` replaces `TranscriptToolResult.content` with the notification `<result>`. Agent-saw text, `outBytes` (:272-273) and the `empty`/`persisted`/`truncated` hints (:276-280) are then all computed from the notification result, matching the client.
  - `TranscriptToolResult` gains `background?: { taskId: string; status: string | null }` and `backgroundEndTs?: number | null`.
  - `transcriptCallStatus` (DD-7) and `transcriptCallDurationMs` (DD-6) read those fields.
  - The callers in `tool-usage-builder.ts` (:46-47, :396, :486-487) need no change: for non-`mcp__` and non-background calls the fields are absent.
- **Client timestamp:** `ToolResultEntry.timestamp` is an ISO string, so it is set to `new Date(ts).toISOString()`. When the notification `ts` is null, the ack's timestamp is kept.

**DD-6 — Duration source.**
- `DurationSource` becomes `'backgroundTask' | 'toolUseResult' | 'taskTotal' | 'timestampDelta'`.
- `DurationInputs` gains `backgroundEndTs?: number | null`. When it is non-null, finite and `>= assistantTs`, it wins first: `{ms: backgroundEndTs - assistantTs, source:'backgroundTask'}`.
- Every `bySource` accumulator and initialiser gains `backgroundTask: 0`.
- A label `"background task (notification time)"` is added.
- Fixture values (`tool_use` → notification, as printed by PoC `check.cjs`; `formatDuration` uses one decimal):

  | Capture | Call | Today | Planned |
  |---|---|---|---|
  | `new-full` | `slow_echo` | 2011 ms ("2.0s") | 8079 ms ("8.1s") |
  | `new-full` | `slow_fail` | 3979 ms | 10006 ms ("10.0s") |
  | `new-close` | `slow_echo` (enqueue only) | 2008 ms | 10299 ms ("10.3s") |
  | `new-live` | `slow_echo` (no notification) | 2011 ms ("2.0s") | 2011 ms ("2.0s"), unchanged |
  | `old-full` | `slow_echo` | 8004 ms ("8.0s") | 8004 ms ("8.0s"), unchanged |

**DD-7 — MCP call status (server Tools/MCP tab, `transcriptCallStatus`).**

| Background state | Status |
|---|---|
| `status === null` | `'no_result'` |
| `completed` | `'ok'` |
| any other status | `'error'` |

- No new DB `ToolCallStatus` value.
- Bump `TOOL_USAGE_EXTRACTOR_VERSION` from 2 to 3 so stored sessions are re-extracted on the next start.
- `session_tool_stats` of old sessions updates only on re-ingest or recompute-all-sessions. That is acceptable and documented.

**DD-8 — The client badge for `'background'`.**
- Neutral muted style, label `⧗ background`.
- Tooltip: `Moved to the background; no completion notification in this log (still running, or the session ended first).`
- The Logs modal header shows `⏱ <duration>` for `mcp__*` calls as well as Bash/PowerShell.

**DD-9 — `parseTaskNotification`** (`server/src/logs/workflow-extractor.ts:58`) is exported.
- It returns the exported `TaskNotification { taskId: string | null; toolUseId: string | null; status: string; summary: string | null; result: string | null; usage: string | null; diagnostics: string | null }`.
- It no longer returns `null` when `<tool-use-id>` is missing.
- `QueueOperationEvent` (:7) is exported too.
- The Workflow enqueue map (`:226-240`) skips notifications whose `toolUseId` is null, so the Workflow join is unchanged.
- The server `background-mcp.ts` reuses it.

**DD-10 — Hook outcome twin** (`hook/.claude/telemetry_tool/post-turn-analysis-worker.js`, `classifyToolOutcome` :538, `deriveToolUsage` :779) is brought in line with the server. Today it counts a background `slow_fail` as success.
- **`classifyToolOutcome`:**
  - the DD-4 background rule;
  - the server's `denialKind` rule (`toolDenialKind` → `unresolved`);
  - the rejection marker counting only on `is_error` results.
- **`deriveToolUsage`:**
  - reads `toolDenialKind`;
  - matches the ack on the full result text, before the 200-char `flattenToolResultText` cut;
  - collects notifications per DD-3, and joins per DD-2.
- **Plain-JS helpers in the same file:** `BACKGROUND_ACK_RE`, `matchBackgroundAckTaskId`, `isBackgroundCandidate`, `collectBackgroundTaskNotifications`. The hook has no TS imports.
- **Version:** PATCH bump (bug fix) 2.31.1 → 2.31.2 in `hook/.claude/telemetry_tool/version.json`, per `.claude/rules/hook.md`.
- **Then:**
  - the `update-install-instructions` skill;
  - lint (`npm run lint:fix`, `npm run lint` in `hook/`);
  - refresh the dogfooded `.artisyn/marketplace/plugins/log-hub-hooks/`: the changed `scripts/` files plus `.claude-plugin/plugin.json` `version`;
  - `npm run build:hooks-installer`, which runs in the installer chunk.
- **Compatibility:** there is no hook API change. Old servers ignore nothing new, because the hook sends the same `TurnEndAdvisorToolUsage` rows with corrected counts. The rule is shape-based, so old CC transcripts are unchanged.
- **Not covered by a hook test:** the policy allows a new algorithm test file only with a new doc. Pinning the hook copy to `tool-call-outcome.json` stays with task `2026-11-03-pin-twins-with-tests`, and a dated line goes into its Notes.

**DD-11 — Node EOL warning (installer).**
- `warnIfNodeEol()` parses `process.versions.node`, and only when the major is below 22 calls `console.warn` (stderr) with exactly: `Warning: Node.js <process.versions.node> is end-of-life and gets no security fixes. Log Hub hooks still work, but please upgrade to Node.js 22 or newer.`
- It is wrapped in try/catch and never changes the exit code.
- The requirements string wins over the wireframe's draft wording.
- Runtime hook scripts print nothing.
- `engines >=18.19` stays.

**DD-12 — Shared doc line** (item 6): `**Node.js:** 22+ recommended (18 and 20 are end-of-life); 18.19 minimum.`

**DD-13 — CI retry flags.**
- Append `--retry 4 --retry-all-errors --retry-delay 5` to each curl release download.
- Versions and SHA-256 pins stay unchanged.
- If a download uses `wget`, change it to `curl -fsSL` with the same flags.

**DD-14 — Node bump (gated).**
- Pick the 26.x release that ships the 2026-11-11 fixes, `<NEW>`.
- Build stages use `node:<NEW>-slim`; the runtime uses `node:<NEW>-alpine3.24`, or the newest Alpine minor the release publishes.
- `scripts/ci/node-runtime-check.js:50` already matches the `-alpine3.24` suffix, so no change is needed there.
- If no image exists, leave chunk 4 unchecked and close the others (requirements, Common sense).

**DD-15 — Item 7 content.** It includes the research finding that the gateway pushes `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, while Log Hub's receiver accepts only `application/json` (415 otherwise, `hook/.claude/telemetry_tool/otel-receiver.js:3687-3691`). So:
- A policy naming Log Hub's receiver must also set `http/json`.
- A `forward_to` relay must be https and must reach the receiver.
- Hook data and transcripts are unaffected.

**DD-16 — KB facts for items 4, 5 and 7** (verified in the PoC or taken from the docs; write them as stated).

*Item 4: `permissions.denyInsteadOfPrompting` (CC 2.1.319), one denied Bash call.*
- Hooks that fire: `PreToolUse`, `PermissionRequest` (no `tool_use_id`; see `lifecycle-hook.js:146-149`) and `PostToolBatch` (its `tool_calls[]` carries the id and the denial text).
- Hooks that do not fire: `PermissionDenied`, `PostToolUse` and `PostToolUseFailure`.
- OTEL `claude_code.tool_decision`: `decision:"reject"`, `source:"config"`. That is the same source as a deny rule or an auto-allow, so OTEL cannot single these denials out, and there is no projection.
- Transcript `tool_result`: `is_error:true`, `toolDenialKind:"permission-rule"`, and `permissionDecision {decision:"reject", source:"config", reasonType:"asyncAgent", reasonCode:"bashMiss:no-rule-match"}`.
- The server counts the call as a denial and the UI shows "⊘ rejected".
- There is no separate badge, because `reasonType:"asyncAgent"` likely also marks headless runs that don't use the setting.

*Item 5: PostToolUse after an interrupt (CC 2.1.319).*
- PostToolUse also fires after a Ctrl+Enter interrupt, with a 10 s cap, and a hook still running at the cap is killed.
- Since `writeTelemetry` runs before the OTEL re-arm, only the re-arm can be lost.

*Item 7: Claude apps gateway sessions.*
- **`/login` gateway sessions:** the CLI sends OTLP/HTTP to the gateway, and the gateway relays it to the `telemetry.forward_to` destinations.
  - By default only metrics are relayed; logs and traces are opt-in per destination.
  - With no destination, the data is discarded.
  - A locally configured endpoint is ignored.
- **Desktop sessions** keep using the local `OTEL_EXPORTER_OTLP_ENDPOINT`.
- **When Log Hub gets the data:** only when its receiver is a `forward_to` destination with logs enabled, or when a gateway-delivered policy names it as the endpoint. That needs client CC ≥ 2.1.265, an https or loopback http URL, no `otelHeadersHelper`, and `http/json` per DD-15.
- **Not routed through the gateway:** hook data and local transcripts.
- **Exact keys:** take them from https://code.claude.com/docs/en/claude-apps-gateway-config.

**DD-17 — Post-merge follow-up (outside the chunks).** The GitHub token is read-only for Actions, so after merge the user re-runs security-scans. Then a dated line with the actionlint/hadolint rows from `REPORT.md`, and the triage of real findings, is added to requirements.md `## Notes`.

**DD-18 — Chunk order.**
- Chunks 1-4 (CI, hook, installer, Docker) are independent infra/ops areas, placed first, outside the Schema → Services → API → Frontend → Tests sequence.
- The hook chunk (2) comes before the installer chunk (3), because the installer chunk's `build:hooks-installer` ships the new hook.
- The sequence applies from chunk 5 on.
- No API or schema chunk exists.

**DD-19 — Scenario fixtures.**
- Copy the PoC's sanitized captures into `tests/scenarios/fixtures/bg-mcp/`: `old-full`, `new-full`, `new-live` and `new-close`, as `.transcript.jsonl`.
- The scenario step reads each file and makes it unique per run:
  - it rewrites `sessionId` to the run's id;
  - it prefixes `uuid`/`parentUuid` with it;
  - it shifts every `timestamp` by one constant, so the first line lands at `at`. Deltas stay exact.
- It uploads each file as its own session with a matching `promptSessionBodies(...).artisyn` body.
- MCP task ids and `tool_use` ids are left as captured; they are unique per file.
- When CC changes the wording or shape, re-capture with the PoC (`run.cjs`, `sanitize.cjs`, `check.cjs`) and copy again.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `.github/workflows/security-scans.yml` | curl retries | lines 191, 727, 932, 1187 (DD-13) |
| `.github/workflows/gitleaks.yml` | curl retries | line 38 |
| `server/src/logs/tool-stats.ts` | rule + duration | `ToolResultInfo.background`, rule (DD-4), `DurationSource`, `resolveToolDuration`, `emptyDurationBySource` (:660) (DD-6) |
| `server/src/logs/background-mcp.ts` | **new** | ack parse + notification collection (DD-2, DD-3) |
| `server/src/logs/workflow-extractor.ts` | export parser | DD-9 |
| `server/src/logs/claude-extractor.ts` | join in tool stats | result fill ~:1060, join :1188-1217 |
| `server/src/logs/tool-monitoring/mcp-call-extractor.ts` | Tools/MCP tab | `collectToolUses` :127, `transcriptCallStatus` :207, duration :226, agent-saw :250+ (DD-5, DD-7) |
| `server/src/logs/tool-monitoring/tool-usage-builder.ts` | verify only | callers of `transcriptCallStatus`/`transcriptCallDurationMs` (:46-47, :396, :486-487) stay unchanged (DD-5) |
| `server/src/logs/tool-monitoring/tool-usage.constants.ts` | re-extract | `TOOL_USAGE_EXTRACTOR_VERSION` 2 → 3 |
| `server/src/logs/analytics/usage-analytics.types.ts` | type | `DurationSource` (:13) |
| `server/src/logs/analytics/tool-analytics.service.ts` | verify only | :222 already uses `emptyDurationBySource()`, so the :242 `key in` guard keeps `backgroundTask` |
| `client/src/viewer/pages/repository/session-log/background-mcp.ts` | **new** client twin | DD-2, DD-3 |
| `client/.../session-log/tool-outcome.ts` | rule twin + status | DD-4 |
| `client/.../session-log/types.ts` | `ToolCallStatus` + `ToolResultEntry`-adjacent types | add `'background'` (:200) |
| `client/.../session-log/tool-calls.ts` | result index + call details | `buildToolResultIndex` :185, `buildAllToolCalls` :278 |
| `client/.../session-log/usage/session-usage-derive.ts` | Statistics walker | `DurationSource`, `resolveToolDuration` :62-81, pairing :455-510, `bySource` :604 |
| `client/.../session-log/tool-call-view/StatusBadge.tsx` | badge | `'background'` case (DD-8) |
| `client/.../session-log/tool-call-view/ToolCallView.tsx` | ⏱ for MCP | :76, :100 |
| `client/src/models/repositories.ts` | `DurationSource` | :605 |
| `client/src/viewer/lib/usage-analytics-format.ts` | label | `DURATION_SOURCE_LABELS` :70 (`Record<string,string>`, so the compiler won't flag a miss) |
| `hook/.claude/telemetry_tool/post-turn-analysis-worker.js` | hook outcome twin | DD-10 (:498 port map, :538, :557, :779-830) |
| `hook/.claude/telemetry_tool/version.json` | hook version | 2.31.1 → 2.31.2 |
| `hook/INSTALL_HOOK.md` | via `update-install-instructions` | only if the skill finds a change |
| `.artisyn/marketplace/plugins/log-hub-hooks/scripts/post-turn-analysis-worker.js`, `.../scripts/version.json`, `.../.claude-plugin/plugin.json` | dogfooded hook copy | DD-10 |
| `docs/tasks/todo/2026-11-03-pin-twins-with-tests/requirements.md` | dated note | the hook outcome copy is to be pinned there (DD-10) |
| `tests/scenarios/fixtures/bg-mcp/{old-full,new-full,new-live,new-close}.transcript.jsonl` | **new** scenario fixtures | copied from the PoC `fixtures/` (DD-19) |
| `artisyn-hooks-installer/src/install.ts` | `warnIfNodeEol()` | next to :2412; calls at :958, :1186, :1266; wording at :946 |
| `artisyn-hooks-installer/package.json` | patch bump | 1.0.95 → 1.0.96 (the build may bump it further) |
| `hook/README.md`, `release-template/INSTALL.md`, `release-template/LOCAL-BUNDLE.md` | Node line | DD-12 |
| `Dockerfile`, `docker-dev/Dockerfile` | Node bump (gated) | :5, :18, :29, :52; :48-49 |
| `user-docs/component-reference.md`, `user-docs/third-party-components.md`, `docs/third-party-components.md`, `user-docs/getting-started.md`, `user-docs/connect-repository.md`, `hook/INSTALL_HOOK.md` | Node version lines (gated) | plus the "patched to at least" floors |
| `docs/knowledgebase/release-pipeline.md` | Node line (gated) | :31-32 |
| `docs/tasks/todo/2026-11-06-alpine-musl-crypt-upgrade/requirements.md` | GH-107 dated note | gated |
| `docs/knowledgebase/hook-system-overview.md` | items 4, 5 | "Event wiring" l.41-64 |
| `docs/knowledgebase/otel-receiver.md` | item 7 | new section after "Forwarding to a foreign collector" (l.232) |
| `docs/knowledgebase/tool-monitoring.md`, `session-log-view.md`, `twins-and-cross-cutting-rules.md`, `ci-security-scans.md` | KB updates | background join, twin rows, retries |
| `docs/knowledgebase/algorithms/tool-call-outcome.md` + `docs/algorithm-examples/tool-call-outcome.json` | algorithm | rules + rows TO-27…TO-31 |
| `tests/scenarios/view/s-sess-03.spec.ts` | scenario step 6b | after 6a (:248-291) |

## API changes

There are no new or changed routes. Analytics responses that already return `durationBySource`
gain the key `backgroundTask: number`. The change is additive, so older clients ignore it.

## Database changes

None. There is no migration, and the `duration_by_source` jsonb takes the new key as is.
`TOOL_USAGE_EXTRACTOR_VERSION` 2 → 3 triggers the existing re-extraction in
`server/src/database/database-init.ts:149-154`.

## Test coverage plan

- **Algorithm (tool-call-outcome):**
  - Extend `docs/algorithm-examples/tool-call-outcome.json` and its doc `docs/knowledgebase/algorithms/tool-call-outcome.md`. The existing `server/src/logs/tool-stats.algo.spec.ts` and `client/.../tool-outcome.algo.test.ts` pick the rows up.
  - New rows:

    | Row | `background.status` | `isError` | Outcome | Client status |
    |---|---|---|---|---|
    | TO-27 | `completed` | `null` | `success` | `success` |
    | TO-28 | `failed` | `null` | `failure` | `error` |
    | TO-29 | `null` | — | `unresolved` | `background` |
    | TO-30 | `stopped` | — | `failure` | `error` |
    | TO-31 | no `background` field, ack-like text | `null` | `success` | `success` (old-transcript / DD-1 guard) |

  - The ack regex and notification collection have no algorithm doc. They are covered by the scenario step, per the test policy: no new algorithm test without a new doc.
- **API contract:** no route changes, and no row under `server/test/` mentions `durationBySource`. No contract row is affected.
- **Scenario:** a new step `6b` in `tests/scenarios/view/s-sess-03.spec.ts`, using the 6a/8c upload pattern. It uploads the four real captures (DD-19) and checks the Logs modal of `slow_echo`/`slow_fail` in each:

  | Capture | Call | Badge | Duration | Output |
  |---|---|---|---|---|
  | `new-full` (2.1.319) | `slow_echo` | ok | `⏱ 8.1s` | `slow_echo: c` |
  | `new-full` (2.1.319) | `slow_fail` | `✗ error` | `⏱ 10.0s` | `Task failed: slow_fail: d failed` |
  | `new-close` (enqueue only) | `slow_echo` | `✗ error` | `⏱ 10.3s` | `Task failed: Connection closed` |
  | `new-live` (no notification) | `slow_echo` | `⧗ background` | — | the ack text |
  | `old-full` (2.1.211, regression guard) | `slow_echo` | ok | `⏱ 8.0s` | `slow_echo: c` |
  | `old-full` (2.1.211, regression guard) | `slow_fail` | `✗ error` | — | `slow_fail: d failed` |

- **Re-capture when CC changes:** run the PoC `check.cjs` on a fresh capture. It is a manual tool, not a suite: a live `claude -p` costs credits and needs a login. It is not added to any automated suite.
- **Item 6 (Node 18.19 check):** run the PoC runner `node run.mjs 18.19 20 22`. Record the result in task Notes; it is not a test (Common sense).
- **Items 1, 2, 4, 5, 7:** CI/doc work, with no tests.

## Visual/UX notes

- `⧗ background` badge: the same size and shape as the `missing` badge, muted foreground, tooltip per DD-8.
- The Logs modal header shows `⏱ 8.1s` (for example) for MCP calls, in the same span style as the Bash duration.
- The installer warning is one stderr line before the ✓ install lines, per `wireframes/installer-node-eol-warning.svg`, with the DD-11 wording.

## Wireframes

No change. `wireframes/installer-node-eol-warning.svg` already shows the flow. Its draft wording is superseded by DD-11.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | CI release-download retries | 4 | independent (DD-18); the post-merge re-run is DD-17 |
| 2 | Hook outcome twin & version bump | 7 | DD-10; before chunk 3, whose build ships hook 2.31.2 |
| 3 | Installer Node EOL warning, shipped docs & installer build | 6 | after chunk 2 |
| 4 | Node image bump (gated on 2026-11-11 release) | 7 | independent; skip and leave unchecked if no fixed image exists |
| 5 | Server outcome rule & duration source | 5 | seam for chunks 6-8: DD-4, DD-6 |
| 6 | Server background join (producers) | 6 | uses chunk 5 + DD-2/3/5/7/9 |
| 7 | Client background join & rule twin | 6 | mirrors chunks 5-6 per DD-2…DD-6; client typecheck passes, but the `'background'` badge falls to the default ok case until chunk 8 |
| 8 | Client UI: badge, duration, labels | 5 | uses chunk 7's `'background'` status and `backgroundTask` key |
| 9 | KB docs (items 3, 4, 5, 7, CI) | 6 | describes chunks 1-8; does not touch `algorithms/tool-call-outcome.md` (chunk 10) |
| 10 | Tests: fixtures, algorithm rows, scenario step | 6 | last; covers chunks 2 and 5-8 |

### Chunk 1 — CI release-download retries
- [ ] In `.github/workflows/security-scans.yml:191` and `:1187` (snyk downloads), append `--retry 4 --retry-all-errors --retry-delay 5` to the curl call (DD-13); keep URLs, versions and SHA pins.
- [ ] In `security-scans.yml:727` (actionlint install), add the same retry flags (DD-13).
- [ ] In `security-scans.yml:932` (hadolint install), add the same retry flags (DD-13).
- [ ] In `.github/workflows/gitleaks.yml:38`, add the same retry flags (DD-13); grep both workflows for any other `curl`/`wget` release download and apply the same.

### Chunk 2 — Hook outcome twin & version bump
- [ ] In `hook/.claude/telemetry_tool/post-turn-analysis-worker.js`, add the plain-JS `BACKGROUND_ACK_RE`, `matchBackgroundAckTaskId`, `isBackgroundCandidate` and `collectBackgroundTaskNotifications` per DD-2/DD-3 next to the other ports (:498-570); extend the port-map comment (:498).
- [ ] In the same file, align `classifyToolOutcome` (:538) with DD-10: background rule (DD-4) first, then `interrupted`, `denialKind`, and the rejection marker only on `isError === true`.
- [ ] In `deriveToolUsage` (:779), record `toolDenialKind` and the ack task id from the full text (before `flattenToolResultText`'s cut), collect notifications once, and pass `background` for `isBackgroundCandidate` calls (DD-10).
- [ ] Bump `hook/.claude/telemetry_tool/version.json` from 2.31.1 to 2.31.2.
- [ ] Run the `update-install-instructions` skill, then `npm run lint:fix` and `npm run lint` in `hook/`, and `npm test` in `hook/` (existing algorithm tests stay green).
- [ ] Refresh the dogfooded copy: copy `post-turn-analysis-worker.js` and `version.json` into `.artisyn/marketplace/plugins/log-hub-hooks/scripts/`, and set `.claude-plugin/plugin.json` `version` to `2.31.2`.
- [ ] Add a dated Notes line to `docs/tasks/todo/2026-11-03-pin-twins-with-tests/requirements.md`: the hook `classifyToolOutcome` now follows DD-4 plus `denialKind` and should be pinned to `tool-call-outcome.json`.

### Chunk 3 — Installer Node EOL warning, shipped docs & installer build
- [ ] In `artisyn-hooks-installer/src/install.ts`, add `warnIfNodeEol()` next to `warnIfClaudeCodeLikelyRunning()` (:2412) per DD-11.
- [ ] Call `warnIfNodeEol()` before `warnIfClaudeCodeLikelyRunning()` at the install (:958), upgrade (:1186) and uninstall (:1266) sites; align the :946 Node wording with DD-12.
- [ ] Bump the patch version in `artisyn-hooks-installer/package.json` from 1.0.95 to 1.0.96 (`.claude/rules/installer.md`); leave `engines >=18.19` in both `package.json` files.
- [ ] Add the DD-12 line to the requirements/prerequisites part of `hook/README.md`, `release-template/INSTALL.md` and `release-template/LOCAL-BUNDLE.md`.
- [ ] Run `npm run build:hooks-installer` from the repo root. It syncs the installer package and tarballs and ships hook 2.31.2 from chunk 2; the build may auto-bump the installer patch again.
- [ ] From `docs/pocs/2026-11-09-1236-hook-node18-compat/`, run `node run.mjs 18.19 20 22`; append the summary lines and the observed warning line to `## Notes` in requirements.md.

### Chunk 4 — Node image bump (gated on 2026-11-11 release)
> **Moved 2026-11-09** to task `2026-11-09-after-11-11-node-image-bump`; not implemented in this task.
- [ ] Confirm a Node 26.x release that ships the 2026-11-11 security fixes is published with `-slim` and `-alpine3.24` (or newer) tags; if not, stop here and leave this chunk unchecked (DD-14).
- [ ] In `Dockerfile:5`, `:18` and `:29`, set `node:<NEW>-slim`; at `:52`, set `node:<NEW>-alpine3.24` (DD-14).
- [ ] In `docker-dev/Dockerfile:48-49`, set `NODE_VERSION=<NEW>` and `NODE_SHA256`, taken from the release's `SHASUMS256.txt` for the file that Dockerfile downloads.
- [ ] Update the Node version in `user-docs/component-reference.md:48`, `user-docs/third-party-components.md:16-17` (Alpine `3.24`), `docs/third-party-components.md:35` and `docs/knowledgebase/release-pipeline.md:31-32`.
- [ ] Raise the "patched to at least …" floors in `user-docs/getting-started.md:8`, `user-docs/connect-repository.md:9` and `hook/INSTALL_HOOK.md:13-15` to the new 22.x/24.x/26.x patch releases; run `npm run build:help`.
- [ ] Build the runtime image and run `docker run --rm <image> apk info -v`. Check that musl, zlib and libssl3/libcrypto3 are at least 1.2.6-r3, 1.3.2-r1 and 3.5.9-r0, and record them in requirements.md `## Notes`.
- [ ] Add a dated line with the new image tag and musl version to the Notes of `docs/tasks/todo/2026-11-06-alpine-musl-crypt-upgrade/requirements.md` (GH-107 stays open).

### Chunk 5 — Server outcome rule & duration source
- [ ] In `server/src/logs/tool-stats.ts`, add `background?: { status: string | null }` to `ToolResultInfo`, and the DD-4 rule in `classifyToolOutcome` right after the `result === null` check; update its doc comment.
- [ ] In `tool-stats.ts`, add `'backgroundTask'` to `DurationSource` (first), `backgroundEndTs?: number | null` to `DurationInputs`, and the first branch in `resolveToolDuration` per DD-6.
- [ ] In `tool-stats.ts` `emptyDurationBySource()` (~:660), add `backgroundTask: 0`.
- [ ] In `server/src/logs/analytics/usage-analytics.types.ts:13`, add `'backgroundTask'` to its `DurationSource`.
- [ ] Verify `server/src/logs/analytics/tool-analytics.service.ts:222` builds its accumulator with `emptyDurationBySource()`, so the `key in acc.bySource` guard (:242) keeps `backgroundTask`; edit only if a hand-written key list exists.

### Chunk 6 — Server background join (producers)
- [ ] In `server/src/logs/workflow-extractor.ts`, export `TaskNotification`, `QueueOperationEvent` and `parseTaskNotification` per DD-9; the Workflow enqueue map (:226-240) skips entries whose `toolUseId` is null.
- [ ] Create `server/src/logs/background-mcp.ts`, exporting `BACKGROUND_ACK_RE`, `matchBackgroundAckTaskId(fullText)` and `isBackgroundCandidate(toolName, isError)` with the DD-2 signatures (DD-1).
- [ ] In the same file, export `BackgroundTaskNotification` and `collectBackgroundTaskNotifications(lines)` per DD-3 (signature, skip rules, user-line-over-enqueue, enqueue-only fallback), using `parseTaskNotification`.
- [ ] In `server/src/logs/claude-extractor.ts`:
  - call `collectBackgroundTaskNotifications` once over the same line objects before the result loop (~:855);
  - add `backgroundTaskId: string | null` to `ToolResultRecord` (:354), set at :1076 by `matchBackgroundAckTaskId` over the full text, before the 200-char cut;
  - in the join (:1188-1217), when `isBackgroundCandidate(call.name, result.isError)` holds and the id is set, look up the notification and pass `background` and `backgroundEndTs` (DD-4, DD-5, DD-6).
- [ ] In `server/src/logs/tool-monitoring/mcp-call-extractor.ts`, add the DD-5 fields to `TranscriptToolResult`. In `collectToolUses` (:127), collect notifications once and join them by name plus ack, substituting `content`. `transcriptCallStatus` (:207) follows DD-7, and `transcriptCallDurationMs` (:226) passes `backgroundEndTs`. `tool-usage-builder.ts` stays unchanged.
- [ ] In `server/src/logs/tool-monitoring/tool-usage.constants.ts:13`, bump `TOOL_USAGE_EXTRACTOR_VERSION` from 2 to 3.

### Chunk 7 — Client background join & rule twin
- [ ] In `client/src/viewer/pages/repository/session-log/types.ts:200`, add `'background'` to `ToolCallStatus`.
- [ ] In `session-log/tool-outcome.ts`, add `background?: { status: string | null }` to `ToolResultInfo`, the DD-4 rule in `classifyToolOutcome`, and the DD-4 mapping in `outcomeToStatus` before the `unresolved` branch.
- [ ] Create `session-log/background-mcp.ts`, the client twin of the server module; its header comment names the twin. It exports `BACKGROUND_ACK_RE`, `matchBackgroundAckTaskId`, `isBackgroundCandidate`, `BackgroundTaskNotification`, `collectBackgroundTaskNotifications(events)` and the local `QueueOperationLine` guard per DD-2/DD-3, with its own tag parser.
- [ ] In `session-log/tool-calls.ts`:
  - `ToolResultEntry` gains `background?: { taskId: string; status: string | null }`;
  - `buildToolResultIndex` (:185) also collects `tool_use` names and calls `collectBackgroundTaskNotifications`;
  - when `isBackgroundCandidate` holds and `matchBackgroundAckTaskId` (run on the full text) finds an id, it sets `background` and substitutes `content`, `timestamp` (an ISO string) and `bytes` per DD-5.
- [ ] In `tool-calls.ts` `buildAllToolCalls` (:278), pass `r.background` (as `{status}`) into `outcomeToStatus`; duration keeps `endedAt − startedAt`, which DD-5 has already set to the notification time.
- [ ] In `session-log/usage/session-usage-derive.ts`:
  - add `'backgroundTask'` to `DurationSource` and to `resolveToolDuration` (:62-81);
  - at `results.set` (~:478), store `backgroundTaskId` from `matchBackgroundAckTaskId` over the full `b['content']` text;
  - in the call loop (~:487), check `isBackgroundCandidate(call.name, …)`, look up the notification and pass `background` and `backgroundEndTs`;
  - add `backgroundTask: 0` to the `bySource` initial value (:604).

### Chunk 8 — Client UI: badge, duration, labels
- [ ] In `session-log/tool-call-view/StatusBadge.tsx` `statusBadge` (switch near :62), add a `'background'` case before `default`, with the DD-8 label, tooltip and the `missing` case's muted style.
- [ ] In `session-log/tool-call-view/ToolCallView.tsx` (:76, :100), show the `⏱` duration span also when `call.name.startsWith('mcp__')` (DD-8); update the doc comment.
- [ ] In `client/src/models/repositories.ts:605`, add `'backgroundTask'` to `DurationSource`.
- [ ] In `client/src/viewer/lib/usage-analytics-format.ts:70`, add `backgroundTask: 'background task (notification time)'` to `DURATION_SOURCE_LABELS`.
- [ ] Run `bun run typecheck` in `client/` and fix every error it reports for the session-log `ToolCallStatus` or `DurationSource`. Leave `tools/call-labels.ts`, which uses the separate Tools/MCP `ToolCallStatus` that DD-7 does not change.

### Chunk 9 — KB docs (items 3, 4, 5, 7, CI)
- [ ] In `docs/knowledgebase/hook-system-overview.md`, under "Event wiring" (l.41-64), add a `denyInsteadOfPrompting` (CC 2.1.319) paragraph with the DD-16 item 4 facts. Bump `timestamp`.
- [ ] In the same article, add the DD-16 item 5 line (10 s PostToolUse cap after an interrupt; `lifecycle-hook.js:205`).
- [ ] In `docs/knowledgebase/otel-receiver.md`, add a "Claude apps gateway sessions" section after "Forwarding to a foreign collector" (l.232) with the DD-16 item 7 facts and DD-15.
- [ ] Add a "Background MCP calls (CC ≥ 2.1.212)" section to `docs/knowledgebase/tool-monitoring.md` (l.200-220) and `docs/knowledgebase/session-log-view.md` (l.410-420) per DD-1…DD-8. Cover the four shapes in DD-6's table, the stale `session_tool_stats` until re-ingest, and the PoC link for re-capture.
- [ ] In `docs/knowledgebase/twins-and-cross-cutting-rules.md`, add a row for `background-mcp.ts` (server ↔ client ↔ hook port in `post-turn-analysis-worker.js`). Update the tool-outcome row: the hook copy now follows DD-4 and `denialKind` (DD-10).
- [ ] In `docs/knowledgebase/ci-security-scans.md`, note the curl retry flags on release downloads (DD-13).

### Chunk 10 — Tests: fixtures, algorithm rows, scenario step
- [ ] Copy `docs/pocs/2026-11-09-1318-mcp-mock-old-new-cc/fixtures/{old-full,new-full,new-live,new-close}.transcript.jsonl` into `tests/scenarios/fixtures/bg-mcp/` (DD-19).
- [ ] In `docs/algorithm-examples/tool-call-outcome.json`, add rows TO-27…TO-31 per the Test coverage plan, each with a `note` naming the rule; TO-28's text is `Task failed: slow_fail: d failed`.
- [ ] In `docs/knowledgebase/algorithms/tool-call-outcome.md`, add the DD-4 background rule and client mapping to Rules. Add Edge cases (no notification; old transcript without ack) and Mutations (background check moved after the `isError` rule; `null` status treated as success). Update "Rows (26)" to 31.
- [ ] In `tests/scenarios/view/s-sess-03.spec.ts`, add step `6b` after 6a (:248-291). Upload the four fixtures as separate sessions per DD-19, using the 6a pattern (`promptSessionBodies`, POST `/api/v2/logs`, `waitForQueueIdle`).
- [ ] In step 6b, `openSession` each session's Logs tab, open the `slow_echo`/`slow_fail` modals as step 6 does, and assert the badge, `⏱` and output per the Test coverage plan's scenario table.
- [ ] Run the fast set (`adlc-lh:check-health`, `finalRun: false`), then `npm run test:scenarios -- --mode a --only scenarios --grep "@S-SESS-03"`; fix failures.
