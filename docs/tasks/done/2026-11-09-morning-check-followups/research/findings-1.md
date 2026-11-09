# Research findings 1 — 2026-11-09

Research subagent report for `/adlc-lh:plan-deep`, archived verbatim. Extra constraint given to the
researcher (user, this session): the hook and MCP handling must keep working with both new and old
Claude Code versions.

**Plan-changing findings**
- **The tool-call modal shows no duration for MCP calls.** `ToolCallView.tsx:76,100` shows `⏱` only when the tool is Bash or PowerShell. AC3's "modal shows duration" needs either a UI change or a check against the Tools/MCP tab instead (`tools/ToolCallDetails.tsx:269`).
- **There is no Log Hub MCP server.** The only MCP code in the hook is `probeMcpServerTools` (`send-logs-hook.js:283`), which sends `initialize` and `tools/list` and never `tools/call`, so background MCP calls don't affect it.
- **Item 7's premise is weaker than the requirements say.** The gateway pushes `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, and Log Hub's receiver only accepts JSON, so gateway sessions are refused even when Log Hub's receiver is named as the endpoint.

## Requirements summary
Umbrella task GH-114 with eight items:
1. **CI:** add `--retry 4 --retry-all-errors --retry-delay 5` to every release download in `security-scans.yml:191,727,932,1187` and `gitleaks.yml:38`, then re-run the nightly scans.
2. **Node:** once the 2026-11-11 security release is out, bump Node in `Dockerfile:5,18,29,52` (pin the runtime to `-alpine3.2x`), `docker-dev/Dockerfile:48-49` (version plus new SHA) and five doc lines, then run `npm run build:help` and add a dated line to GH-107's Notes.
3. **Background MCP calls:** join an `mcp__*` call's hand-off message ("moved to the background as task `<id>`") to the later `<task-notification><task-id>`. Take result, status and duration from the notification. A call with no notification must not show as `ok`. Server and client both change; add algorithm rows and an S-SESS-03 step.
4. **KB only:** document how `denyInsteadOfPrompting` denials appear in hooks, OTEL and transcripts.
5. **KB only:** PostToolUse now runs after a Ctrl+Enter interrupt with a 10 s cap (CC 2.1.319, per the morning-check report).
6. **Node 22+ advice:** add the "Node.js 22+ recommended, 18.19 minimum" line to `hook/README.md`, `release-template/INSTALL.md` and `LOCAL-BUNDLE.md`. Add an installer `warnIfNodeEol()` that prints one line to stderr and keeps exit 0. `engines >=18.19` stays.
7. **KB only:** OTEL for Claude apps gateway sessions, in `otel-receiver.md`.
8. Watch only.

There is no `open_questions_ru.md` in the task folder.

## Wireframes
- `wireframes/installer-node-eol-warning.svg` (item 6): a terminal on Node v20.19.0 runs the installer. One amber warning line appears before the ✓ lines, and `echo $?` prints 0.
- Its annotations say the warning shows only when the major version is below 22, goes to stderr, prints nothing from runtime hook scripts, and that the wording is "to be confirmed".
- The wireframe text ("⚠ Node.js 20 is end-of-life… please move to Node.js 22 or later") differs from the exact string in requirements item 6 ("Warning: Node.js <version> is end-of-life… Log Hub hooks still work, but please upgrade to Node.js 22 or newer."). The requirements string should win.

## Knowledgebase
- `docs/knowledgebase/hook-system-overview.md`
  - Target for AC4 and AC5; "Event wiring" (l.41-64) is the natural place.
  - Design rules (l.285+): fail-open, every Node LTS, `engines` not raised without a decision, never augment transcripts.
  - Bump the frontmatter `timestamp` when editing.
- `docs/knowledgebase/algorithms/tool-call-outcome.md` plus `docs/algorithm-examples/tool-call-outcome.json` (26 rows, TO-01…TO-26)
  - The rule input is only `{isError, text, interrupted?, denialKind?}`; output is `outcome` on both server and client, `status` on the client only.
  - Background rows need a new input field and new rules. Each new row needs Rules, Edge cases and Mutations entries in the doc, and the "Rows (26)" count must change.
  - Both table tests read the same rows: `server/src/logs/tool-stats.algo.spec.ts` checks only `outcome`; `client/.../tool-outcome.algo.test.ts` uses `toStrictEqual` on `{outcome, ...outcomeToStatus}`.
- `docs/knowledgebase/twins-and-cross-cutting-rules.md:46,56`
  - Tool outcome is a server↔client twin. The hook has a third, already stale copy (`post-turn-analysis-worker.js:538`: no `denialKind`, no `is_error` gate), and no test pins the hook copy.
  - A new ack regex or join is another server↔client twin and needs its own row.
- `docs/knowledgebase/session-log-view.md`
  - l.150-170: Workflow lifecycle; its notification join is keyed on `<tool-use-id>`.
  - l.261-270: a `<task-notification>` is not a turn boundary; S-SESS-03 step 6a pins this.
  - l.410-420: the result index takes the first result per id; `outcomeToStatus` badges.
- `docs/knowledgebase/tool-monitoring.md:200-220`
  - `ToolCallRecord.status` is `ok|error|killed|no_result`.
  - Bumping `TOOL_USAGE_EXTRACTOR_VERSION` (`tool-usage.constants.ts:13`, currently 2) re-extracts stored sessions on the next start.
- `docs/knowledgebase/otel-receiver.md`: target for item 7. "Why a local receiver" (l.26) says the exporter is `http/json`; "Forwarding to a foreign collector" (l.232) is the closest related section.
- `docs/knowledgebase/otel-tabs.md:568-600`: the "Claude Code version" compatibility matrices. Item 7 can add a gateway row here.
- `docs/knowledgebase/hook-api-versioning.md:541-560`
  - Additive-field template: new hook → old server, old hook → new client, new hook on older CC.
  - The hook-side history table is at l.769.
- `docs/knowledgebase/claude-version-check.md`: per-session CC version is `session_stats.claude_version` (max transcript `version`), with `claude_version_otel` as fallback.
- `docs/knowledgebase/ci-security-scans.md`
  - l.50 and l.137-138: the `node-runtime` row checks every `FROM node:<ver>` line in `Dockerfile` and `ARG NODE_VERSION` in docker-dev.
  - l.284: Dependabot cannot bump `NODE_SHA256`.
- `docs/knowledgebase/release-pipeline.md:31-32`: Node version line to bump in item 2.
- `docs/knowledgebase/turn-end-cost-advisor.md:123-130`: hook pattern for older CC — when `claude -p` rejects a flag with "unknown option", retry once without it.

## Existing patterns
- `server/src/logs/tool-stats.ts`
  - :104 `classifyToolOutcome`.
  - :135 `DurationSource = 'toolUseResult'|'taskTotal'|'timestampDelta'`.
  - :163 `resolveToolDuration`: the chain is durationMs → totalDurationMs → timestamp delta, and the new source goes first.
  - :660 `emptyDurationBySource()` must gain the new key.
- `server/src/logs/claude-extractor.ts`
  - The requirements' :660-684 is the wrong spot: it is the Skill/rule harness index.
  - The real tool-stats join: :1042 reads `toolDenialKind`, the `toolResults` map is filled ~:1060, and the join with `classifyToolOutcome` and `resolveToolDuration` is at :1188-1217.
  - :151 `isNonQualifyingPromptContent` already drops `<task-notification>` from prompts.
  - :374-395 `flattenToolResultText` cuts text at 200 chars.
- `server/src/logs/turn-walk.ts:117`: the notification is not a prompt; no change needed.
- `server/src/logs/workflow-extractor.ts`
  - :52 `extractTagContent`.
  - :58 `parseTaskNotification` returns null when `<tool-use-id>` is missing; it needs to become optional.
  - :226-240 builds the enqueue map from `queue-operation` lines, keyed by toolUseId.
- `server/src/logs/tool-monitoring/mcp-call-extractor.ts`
  - :127 `collectToolUses` keeps the first result per id.
  - :207 `transcriptCallStatus` → `ok` for an ack.
  - :226 `transcriptCallDurationMs`.
  - :250+ agent-saw text = the ack text.
  - The requirements' "Where" list leaves this file out; the PoC README names it.
- `server/src/database/schema/index.ts:1689` `ToolCallStatus`; `:1302` `duration_by_source` jsonb (a new key needs no migration).
- `server/src/logs/analytics/tool-analytics.service.ts:132,242`: sums jsonb keys but drops unknown ones (`key in acc.bySource`).
- Client:
  - `session-log/tool-calls.ts:185` `buildToolResultIndex` is the single place to override the entry with the notification's content and timestamp for Logs, the Bash tab (`bash-tab/collect-bash-calls.ts:48`), the Session Map, and `log-parser.ts:621,1793`.
  - `tool-calls.ts:278` `buildAllToolCalls`; its duration is `endedAt − startedAt`.
  - `session-log/tool-outcome.ts:58,84` `classifyToolOutcome` / `outcomeToStatus`.
  - `session-log/types.ts:200` `ToolCallStatus = 'success'|'error'|'rejected'|'missing'`.
  - `tool-call-view/StatusBadge.tsx`: the badge switch and denial tooltips.
  - `usage/session-usage-derive.ts:62-81` holds a second `resolveToolDuration` twin; :455-510 is the Statistics walker pairing; :604 `bySource` initial value.
  - `client/src/models/repositories.ts:605` `DurationSource`; `lib/usage-analytics-format.ts:70` `DURATION_SOURCE_LABELS`.
  - `tools/call-labels.ts:14` `STATUS_BADGE` for the Tools/MCP tab.
  - `lib/format.ts:8` `formatDuration`: 10144 ms → "10.1s", 2228 ms → "2.2s".
- `tests/scenarios/view/s-sess-03.spec.ts:248-291` step 6a: builds a small claude body plus `promptSessionBodies(...).artisyn`, posts to `/api/v2/logs`, waits with `waitForQueueIdle`, then `openSession`. Step 8c (:480) shows a notification sent as a `queue-operation` enqueue. Copy this pattern.
- `hook/.claude/telemetry_tool/lifecycle-hook.js`
  - :116-135 PostToolUse: identity plus `edit_result`.
  - :146-149 PermissionRequest (no `tool_use_id`).
  - :152-158 PermissionDenied (auto-mode only).
  - :200 PostToolBatch writes the base event only.
  - :205 `writeTelemetry` runs before the awaited OTEL re-arm (:250+). If the 10 s cap kills the hook, only the re-arm is lost, not the event.
- `artisyn-hooks-installer/src/install.ts`
  - :2412 `warnIfClaudeCodeLikelyRunning` (best-effort, `console.warn`, try/catch); called at :958 (install), :1186 (upgrade), :1266 (uninstall).
  - :946 says "any current Node.js LTS release works", which the new wording should match.
  - Installer version is 1.0.95 (`package.json:3`); `engines >=18.19` in both `package.json` files.
- `scripts/ci/node-runtime-check.js:50`: the regex `node:(\d+\.\d+\.\d+)\b` still matches `node:X.Y.Z-alpine3.24` (`\b` falls between the digit and `-`); :58 is the `ARG NODE_VERSION` regex.
- `.github/dependabot.yml:6-14`: the docker ecosystem ignores Node major bumps. Not checked: how Dependabot treats a `-alpine3.24` suffix.
- Workflows: `security-scans.yml:191` and `:1187` download from `downloads.snyk.io`, not github.com; `:727` actionlint and `:932` hadolint (both `continue-on-error`); `gitleaks.yml:38`. No other downloads besides `node-runtime-check.js:88`, which uses curl for the nodejs.org index.

## Claude Code version compatibility
- **Item 3 (transcript, server and client)**
  - *Old CC (< 2.1.319):* an MCP `tool_result` is the real result. `<task-notification>` exists only for background agents, Bash and Workflow calls, and always carries `<tool-use-id>` (examples in `log-schema/attachment-types.md:462` and `claude-log-message-types.md:368`).
  - *New CC (2.1.319):*
    - The ack has no `is_error` and its `toolUseResult` is a content-block array, so `asRecord` gives null and there are no `durationMs`/`taskId` fields.
    - The notification is a string-content user line with `origin.kind:"task-notification"`, `promptSource:"system"`, `turnOrigin:"task_notification"`. A `queue-operation` enqueue carries the same XML about 52 ms earlier.
    - The notification has no `<tool-use-id>`.
    - A failed or stopped task gets no notification when `-p` exits first (PoC s2).
  - *Current handling:* no CC version gating anywhere in transcript parsing; it uses feature detection (`toolDenialKind` "absent on older transcripts", `cache_creation` fallback). The only version gates are OTEL ones (`OTEL_SUBAGENT_COST_FIX_VERSION='2.1.307'` with `ccVersionBeforeSql`; hook `CLAUDE_CODE_PROJECT_OTEL_CUTOFF='2.1.282'`).
  - *Required fallback:* detect by shape, not by `version`.
    - Trigger only on `mcp__*` names plus the ack regex, so a Bash `run_in_background` ack is never matched.
    - When there is no ack match, today's path is unchanged, which covers old transcripts and in-session calls.
    - Read the notification from both the user line and the `queue-operation` (the Workflow join reads the latter).
    - Search the full text, not the 200-char cut. In the fixture the match spans chars 59-100 of a 321-char text, and the offset grows with the `server/tool` name length.
    - Use the PoC regex `([A-Za-z0-9_-]+)` instead of the requirements' `(\S+)`, which would capture trailing punctuation or backticks if CC rewords the message. A second form, `task_id "kce4n8y9u"`, also appears in the ack and can serve as a fallback.
  - *Exact fixture values:*
    - `tool_use` at 08:41:40.469; ack at 08:41:42.697 (2228 ms).
    - Enqueue at 08:41:50.561 (10092 ms); notification user line at 08:41:50.613 (10144 ms).
    - Status `completed`; result `slow_echo says: hi (after 10000 ms)`.
  - *Hook:* nothing fires for the late result, and PostToolUse `duration_ms` (2004) is not stored by the server, so no hook change is needed. The hook's stale outcome twin keeps counting an ack as success, but it is only a fallback when the server aggregate is missing; leaving it avoids a hook version bump.
- **Item 4 (denyInsteadOfPrompting)**
  - *Old CC:* the setting doesn't exist; the PoC notes a headless run without it also uses `reasonType:"asyncAgent"` (read from the binary, not captured).
  - *New CC:* PreToolUse, PermissionRequest (no id) and PostToolBatch fire; PermissionDenied, PostToolUse and PostToolUseFailure do not.
  - *Current handling:* `toolDenialKind:"permission-rule"` → "⊘ rejected" with the tooltip "blocked by a permission rule". Nothing to change; the hook writes no `tool_calls` for PostToolBatch.
- **Item 5 (PostToolUse after interrupt)**
  - *Old CC:* no PostToolUse on an interrupt.
  - *New CC:* extra PostToolUse events for interrupted calls.
  - Server readers filter `PostToolUse` plus `tool_use_id` (`artisyn-extractor.ts:722`, `changed-paths.sql.ts:170`). An interrupted Edit should give `edit_result = null` (call uncovered, not zero) as long as `deriveEditResultCounts` returns null on an interrupted `tool_response`. That is not verified.
- **Item 6 (installer):** CC-version independent; Node 18.19, 20.20.2 and 22.23.4 all pass 21/21 in the PoC.
- **Item 7 (gateway), from the official gateway config docs:**
  - Gateway sessions have existed since CC v2.1.195. With `forward_to` plus `listen.public_url` set, the gateway pushes at managed tier `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_{METRICS,LOGS,TRACES}_EXPORTER`, `OTEL_EXPORTER_OTLP_ENDPOINT=<public_url>` and `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`.
  - Before gateway v2.1.265, all three exporters were pushed as `otlp`.
  - Per destination, `metrics: true` is the default and `logs`/`traces` are opt-in. A signal with no destination is accepted and discarded.
  - `/login` sessions ignore any locally configured endpoint.
  - "Export directly": a managed policy `env.OTEL_EXPORTER_OTLP_ENDPOINT` takes effect only from client CC v2.1.265, and only when it comes from the gateway (not MDM or a local file), is `https` or `http` loopback, and no `otelHeadersHelper` is set.
  - Traces also need `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`.
  - Desktop/Cowork sessions differ again: the bootstrap derives the OTLP endpoint pointing at the gateway.
  - `forward_to` URLs must be `https` (loopback only with `CLAUDE_GATEWAY_ALLOW_LOOPBACK=1` on the gateway).
- **Item 7 consequences for Log Hub**
  - The receiver accepts only `application/json` and answers protobuf with `415 unsupported-media-type` (`otel-receiver.js:3687-3691`). So naming Log Hub's receiver directly works only if the policy also sets `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`.
  - The receiver's per-user loopback port can't be named by a central policy unless the port is pinned on every machine.
  - Through the relay, only logs to an https destination that reaches the Log Hub receiver would arrive.
  - Hook data and transcripts are unaffected.
  - The hook's `managed-settings.js` reads `<claudeConfigDir>/remote-settings.json`. Whether gateway-pushed settings land there is unknown: if they do, `otel-status` reports `managed-endpoint`; if not, a gateway session can look correctly configured while no OTEL arrives.
- **Hook rule (old hooks → new server):** none of items 3-7 changes a hook route or payload, so the hook-version compatibility matrix is untouched.
  - Item 3 is a server-side transcript change. It works for transcripts uploaded by any hook version, since the transcript is uploaded unchanged, and for already stored sessions only after re-extraction.
  - Item 6 changes the installer, not the hook, and needs no hook version bump. If the hook README edit counts as a hook change, `.claude/rules/hook.md` applies (bump `version.json`, run `build:hooks-installer`, refresh the dogfooded copy).

## Open gaps
1. **AC3 duration surface.** The Logs modal shows duration for shells only. Decide whether to show it for all calls, for MCP calls only, or to check the Tools/MCP tab in the scenario. The Tools/MCP data is written by a background rebuild (`tool_usage_version`); not checked whether `waitForQueueIdle` waits for it.
2. **Where the background join goes in the outcome rule.** `classifyToolOutcome`'s input has no background field. Either extend `ToolResultInfo` (for example `background?: {status: string|null}`, giving new rows like TO-27…) or do the join in the input producers and feed the rule a synthetic result.
   - The ack-regex parsing then needs its own algorithm row or doc.
   - The client `ToolCallStatus` needs a new value (for example `'background'`), and so do the badge and the DB `ToolCallStatus` (`no_result` could be reused).
   - The outcome category for "background, no result" is not defined; `unresolved` is the likely fit, since `failure` would inflate failure rates.
   - Status mapping for `failed`/`killed`/`stopped`: the PoC proposes "error".
3. **New `DurationSource` key** (for example `backgroundTask`). It touches six places: server `tool-stats.ts`, server `usage-analytics.types.ts:13`, client `models/repositories.ts`, `session-usage-derive.ts`, `DURATION_SOURCE_LABELS` and both initialisers. Not checked whether the f20-analytics contract rows compare the `durationBySource` shape exactly.
4. **Re-processing stored sessions.** Bump `TOOL_USAGE_EXTRACTOR_VERSION` for the Tools/MCP tab. `session_tool_stats` is rebuilt only on re-ingest or recompute-all-sessions, so old sessions keep the ack-based numbers until then.
5. **Live sessions.** In the Session Map and realtime views, a call still running in the background looks the same as one that never got a result. The badge wording should be neutral (for example "background, no result yet").
6. **Item 2 is blocked** until the Node release lands (2026-11-11).
   - The "patched to at least 22.23.4 / 24.22.1 / 26.12.1" floors in `user-docs/getting-started.md:8`, `connect-repository.md:9` and `hook/INSTALL_HOOK.md:13-15` will likely need raising too; the requirements don't mention them.
   - `user-docs/third-party-components.md:17` says Alpine "3.x"; if the runtime is pinned to `alpine3.24`, that line should probably say 3.24.
7. **Item 5 has no doc source** beyond the morning-check line "PostToolUse hooks now run after Ctrl+Enter interrupt, 10 s cap" (CC 2.1.319). Behaviour when the hook is killed at the cap is not captured.
8. **Item 7:** whether gateway-pushed managed settings are visible to the hook's managed-settings reader (`remote-settings.json`) is unknown. No transcript or hook field that marks a gateway session was found.
9. **Hook outcome twin.** It stays stale (no `denialKind`, background acks count as success). Decide explicitly to leave it, to avoid a hook bump, and record that in `twins-and-cross-cutting-rules.md`.
