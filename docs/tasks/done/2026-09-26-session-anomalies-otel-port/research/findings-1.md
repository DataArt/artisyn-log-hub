I gathered context for all of FR-1 to FR-8. FR-1 detection and FR-7 are already shipped, so the plan covers FR-2, FR-3, FR-5, FR-6 and the remaining FR-1 work (a regression test and the check on the audited repository). I also ran the FR-3 `deferred_tools_record` prototype on the dev database. It is a separate event type that sits alongside `deferred_tools_delta` and does not replace it.

## Requirements summary
The task fixes problems found while auditing one repository's sessions:
- **FR-1:** the "⚡ Workflow" badge should only show for a real `assistant` `tool_use` block named `Workflow`. Detection is done; the regression test and the live check remain.
- **FR-2:** audit every detector that substring-matches raw transcript text.
- **FR-3:** handle the seven new Claude Code 2.1.280 event types. Document them in the log-schema KB, keep them out of all metrics, and show them collapsed in the viewer. The `deferred_tools_record` question is settled by the prototype below.
- **FR-5:** a session's `logs.start_time` becomes the first `prompt_start`/legacy `prompt` hook line, falling back to today's minimum over activity lines. No backfill.
- **FR-6:** the installer moves all nine Artisyn OTEL env keys to the gitignored `.claude/settings.local.json` and rewrites stale Artisyn-owned loopback endpoints on install/upgrade. Ownership means a loopback endpoint whose port is in 25000–65535 or equals a port the installer recorded earlier. Each key is judged on its own, in each file. It also migrates the keys out of `.claude/settings.json`, cleans both files on uninstall, and `upgrade` tells the user to restart running sessions. This repo's own settings get the same migration.
- **FR-7:** done in hook 2.18.0.
- **FR-8:** older hooks must keep working.

## Wireframes
- `wireframes/sessions-list-workflow-badge.svg`: the badge keeps its look (purple mono tag after the branch tag) and only which sessions get it changes. The list row shows the **end** time (`formatLocalTimestamp(session.endTime)`), so FR-5 does not show there. Rows D/E/F keep the badge.
- `wireframes/session-detail-header.svg`: no new fields. Only START moves: 17:08:59 → 19:14:02. In the "after" example, 19:14:02 → 19:15:10 is 68 s, which matches the "span 1m 8s" label. END, work time, tokens and cost are unchanged. START comes from `SessionDetailHeader.tsx:152`, which reads `session.startTime` from the API, so no client logic changes.

## Prototype result (FR-3, read-only queries on the dev DB)
- **Both types are emitted:**

  | Type | Claude Code version | Events | Sessions |
  |---|---|---|---|
  | `deferred_tools_record` | 2.1.280 | 594 | 368 |
  | `deferred_tools_delta` | 2.1.280 | 437 | 369 |

- Every session with a `record` also has a `delta`: 0 sessions are record-only and 1 is delta-only.
- So `deferred_tools_record` is a **distinct, additive type and does not replace the delta**. Under FR-3 it is only excluded from metrics; `walkDeferredToolsDelta` and the client parsers do not need to change.
- Shape of `deferred_tools_record`: keys `entries` (each `{name, description, input_schema, defer_loading, eager_input_streaming}`), `nameOnlyAnnouncements`, `toolInputCopies`. Like `prompt_snapshot`, it carries a tool catalogue, so it is the same kind of false-positive source.
- The local corpus set `tests/corpus/sets/2026-10_cc-2.1.280/*` (recorded with `claude -p`) has `deferred_tools_delta` and no `deferred_tools_record` or `silent_turn_reminder`.
- Shapes of the other new types:

  | Type | Kind | Fields |
  |---|---|---|
  | `prompt_snapshot` | attachment | `tools`, `systemPrompt`, `systemTurns`, `inlineTools`, `cliPrefix`, `contextRendering`, `echoWireToolInputs`, `keptReminders`, `reminderFold`, `toolChangeHeader` |
  | `total_tokens_reminder` | attachment | `{text}` |
  | `silent_turn_reminder` | attachment | `{text}` |
  | `remote_session_change` | attachment | `commit`, `managedCommit`, `managedPr`, `pr`, `sendUserFileHint`, `url` |
  | `atis-latch` | top-level, no `timestamp` | `atis`, `sessionId` |
  | `cost-state` | top-level, no `timestamp` | `totalCostUSD`, `modelUsage`, `startTime`, `totalDuration`, … (must not feed cost) |

## Knowledgebase
- `docs/knowledgebase/log-schema/{claude-log-message-types,attachment-types}.md`: the headers say "Auto-generated from live database on 2026-06-15". Add the hand-maintained note there. `atis-latch` and `cost-state` go in `claude-log-message-types.md`; the five attachment types go in `attachment-types.md`, each with a "Mandatory Fields" section and a "Suggested Display Strategy" entry. `log-schema/index.md` says "all 20 attachment sub-types", so that count needs updating.
- `docs/knowledgebase/algorithms/README.md`: format for the new `session-time-span.md`. Required sections are Purpose, Code, Rules, Edge cases, Examples (exactly one `examples` JSON block with `{id,input,expected,note}`), Mutations and Where visible. Front-matter starts as `reviewed: no` / `reviewer: none`, followed by an AI review. Add a row to the Docs table (L28-42). The server test file is named `<module>.algo.spec.ts` and uses `loadExamples` from `scripts/algo-docs/load-examples.cjs`.
- `docs/knowledgebase/hook-installation.md` L315-354: the "`.claude/settings.json` env block" section, the per-key fill-if-absent paragraph and the "Known gap: stale-endpoint trap … not implemented" paragraph all need rewriting. L144-147 (uninstall rule) also changes, and the `index.md` line 38 entry says "nine-key `.claude/settings.json` env block".
- `hook/INSTALL_HOOK.md` L164 and L485-513, plus `hook/README.md:58`, describe the settings.json env block. Update them via the `update-install-instructions` skill.
- `docs/knowledgebase/otel-receiver.md:100`: endpoint/port resolution text.
- `docs/knowledgebase/test/scenarios.md` L246-265: describes the installer scenarios S-INST-01/02/04 and the golden lifecycle lines.
- `tests/corpus/README.md` "Approving a new set": `diff-format.mjs --approve` only merges what is **in a set** into `known-format.json`.
- Also relevant: `session-log-view.md`, `raw-logs-renderers.md` (the viewer dispatcher), `harness-usage-tab.md`, `server-conventions.md` (`npm run perf`), `.claude/rules/installer.md` (patch bump; currently `1.0.70`), and `.claude/rules/hook.md` (hook version is `2.22.0`; the dogfood `plugin.json` is also `2.22.0`).

## Existing patterns
**FR-1**
- `server/src/logs/repositories.controller.ts:815-853`: the new detection (jsonb `@>` pre-filter plus `EXISTS` over `tool_use` blocks with a non-empty string `id`). It mirrors `workflow-extractor.ts:98-123`.
- `server/test/contract/registry/f17-sessions.ts:34,67`: **the contract oracle maps `hasWorkflow` to `r.workflow_run_id IS NOT NULL`, which is not the controller's rule.** It passes only because world-v1 roots have no Workflow. Bodies are seeded in `server/test/contract/fixtures/world-v1.sql.ts` (`claudeBody()` L252, `artisynBody()` L219; `start_time` is stored directly, so FR-5 does not affect it).
- `tests/scenarios/view/golden-load.spec.ts:118-145`: the session-list step does not assert `hasWorkflow` yet. `tests/golden/gs-05-skills-rules-mcp-workflow/session.jsonl` contains a real Workflow `tool_use`, which makes it the positive case. A `prompt_snapshot` line can be added to another golden session as the negative case.
- Corpus `expected.json` (local, gitignored) already pins `hasWorkflow: false` on all three 2.1.280 sessions. Each one's `prompt_snapshot` lists `"name": "Workflow"` once, so S-CORPUS-01 already covers the regression, but only on machines that have the set.

**FR-2 audit (searched `server/src`, `client/src`, `hook/.claude/telemetry_tool`)**
- There is no `body::text LIKE`, `ILIKE`, `JSON.stringify(...).includes`, or raw-blob `.includes`/`.match` on transcripts.
- The only `LIKE` is `otel-cost.sql.ts:258` (`query_source` column). The only `@>` uses are `repositories.controller.ts:557,1071` (`{"event":"hook_service"}` on artisyn bodies) and `:833` (already fixed).
- Client text matches all run on structured fields: `log-parser.ts:247-249,2358,2910`; `session-usage-derive.ts:84` (only `tool_result` text, first 200 chars); `session-list-helpers.tsx:94` (a filter).
- Conclusion: the old badge query was the only raw-text detector. None need changing.

**FR-3 (all extractors check the event type before reading)**
- Server: `claude-extractor.ts:855-862` (`extractClaudeStats` reads only `assistant`/`user`), `:455-472`, `:623-736` (`nested_memory` only); `turn-walk.ts:100,223,249,265,438-490`.
- Client: `log-parser.ts:957,2634-2697` (each loop gated on its own attachment type).
- So none of the seven types feeds a metric today, and no code change is needed.
- Viewer: `raw-logs/renderers.tsx:32-61` falls through to `JsonBlock` for unknown top-level types such as `atis-latch` and `cost-state`. `raw-logs/attachment.tsx:11-57` (`getAttachmentDetail`, empty by default) and `:68-92` (`SYSTEM_TYPES` → `SystemAttachmentBody`, otherwise `JsonBlock`) handle attachments. `raw-logs/utils.ts:42-138` (`getCollapsedSummary`) provides the collapsed summary; add cases there for collapsed summaries.
- `tests/corpus/known-format.json`: `lineTypes` already has `atis-latch` and `cost-state` (with `keysByType`); `attachmentTypes` has `prompt_snapshot`, `remote_session_change` and `total_tokens_reminder`. **Missing: `silent_turn_reminder`, `deferred_tools_record`.**
- Test for "same metrics with and without the events": add the seven events to a golden root's `session.jsonl` (with timestamps inside the span) and keep `expected.json` unchanged. That exercises `golden-load.spec.ts` and `tests/golden/check-arithmetic.mjs`, whose L314-320 take start/end from every timestamped root line.

**FR-5**
- `server/src/logs/artisyn-extractor.ts:87-128`: `NON_ACTIVITY_LINE_TYPES` plus `extractTimestampRange`. `:57-85` (`extractFirstPrompt`) already shows how to recognise `prompt_start`/`prompt`, including the empty-prompt check.
- Callers: `logs.service.ts:345-348,376,388` (ingest upsert) and `repositories.service.ts:1349` (recompute-all). Import is unaffected: `logs.service.ts:805-830,965-1008` keep the start time from `session.json`.
- Hook line shape: `hook/.claude/telemetry_tool/telemetry-hook.js:70-72` (`{event:'prompt_start', timestamp, …}`, no `type`). Legacy hooks 1.6.2 and 2.6.1 also emit `prompt_start`. `SessionStart` lines look like `{type:'artisyn', hook_event_name:'SessionStart'}`.
- Test template: `server/src/logs/claude-extractor.algo.spec.ts` (loadExamples, then `it.each`).
- Scenario home for a row-A-shaped step: `tests/scenarios/ingest/s-ingest-02.spec.ts:73-84,185-195` (step 5 already asserts `startTime`/`endTime` from the artisyn log).

**FR-6**
- `artisyn-hooks-installer/src/install.ts`:

  | Lines | What | Note for the plan |
  |---|---|---|
  | 693-696 | `resolveInstallOtelPort` | Overwrites `otel-port.json` before anything else |
  | 728-735 | `log-hub.json otelReceiverPort` | Also overwritten here |
  | 753 | `mergeSettings` | Runs after both writes. **The previously recorded ports must be read before L693.** |
  | 1213-1282 | `ensureConfigIgnored(cwd, path, {secret:false})` | Reusable for `.claude/settings.local.json`: writes `.claude/.gitignore` with the entry `settings.local.json` and warns if the file is tracked |
  | 1297-1298 | `OTEL_PORT_MIN` / `OTEL_PORT_MAX` | 25000 / 65535 |
  | 1342 | `readStoredOtelPort` | |
  | 1529-1541 | `OTEL_ENV_KEYS` | |
  | 1546 | `OTEL_LOOPBACK_LOGS_ENDPOINT_RE` | Logs only; a metrics regex is needed |
  | 1825-1847 | `readSettingsForMutation` | Hardcodes `settings.json`. Generalise it for `settings.local.json` (abort on invalid JSON, `.bak`). |
  | 1938-1960 | Fill-if-absent env merge plus the "Note: kept your existing" line | |
  | 2013-2038 | Uninstall | Uses a single `isOurs` for the whole block; must become per key and per file |
  | 984-1044 | `runUpgrade` | Where the restart note goes; `warnIfClaudeCodeLikelyRunning` is at 1791 |
  | 1053-1069 | Uninstall order | `removePluginSettingsKeys` runs before `removeStoredOtelPort`, so the recorded port can still be read |

- Scenarios:
  - `tests/scenarios/installer/s-inst-01.spec.ts`: `OTEL_ENV` at L83-93; step 6 at L199-208 asserts `settings.env` equals all nine keys, so it must flip to `settings.local.json`; step 4 at L160-182.
  - `s-inst-02.spec.ts`: step 4 (L79-83, git status/ignored), step 5 (L86-105, `.gitignore` entries), step 6 (L143-152, a changed-files list that will now include settings.local).
  - `s-inst-04.spec.ts`: step 2 (L103), step 3 (L126-136, foreign collector plus the Note text).
  - **No existing scenario runs `upgrade` or moves the port.** S-INST-01 or S-INST-04 is the natural place for the new port A→B step (change `otel-port.json`, or use `--otel-port`).
  - Helpers in `tests/scenarios/helpers/installer.ts`: `runInstaller` (L82), `writeClaudeSettings` (L221), `USER_SETTINGS` (L214), `readJson`, `treeHashes`.
- Dogfood state: `.claude/settings.json` holds all nine keys on port 58603. `.artisyn/config/otel-port.json` and `log-hub.json` also say 58603, so nothing is stale. `.claude/settings.local.json` exists with no OTEL keys and is already ignored by the root `.gitignore:16`.
- The hook check `hook/.claude/telemetry_tool/otel-endpoint-check.js:75-131` already reads `settings.local.json` first, so it agrees with the new location and needs no hook change.

**FR-8**
- `tests/scenarios/hook/s-compat-01.spec.ts` with `tests/fixtures/legacy-hooks/{1.6.2,2.6.1}`, plus `s-ingest-0*`.

## Open gaps
1. **FR-5 breaks existing expected values (computed exactly):**
   - `tests/golden/gs-05-skills-rules-mcp-workflow`: `SessionStart` is at 10:00:00.000Z but the first `prompt_start` is at 10:00:10.000Z. Start moves by +10000 ms, so `expected.json` `start` becomes `2026-01-08T10:00:10.000Z` and `durationMs` goes from 210000 to 200000. `check-arithmetic.mjs:315-320` derives start from the transcript, and the README table says "W1 Thu 10:00:00".
   - The plan must either move gs-05's first `prompt_start` to 10:00:00 or apply the new rule in the oracle and in `expected.json`.
   - Golden fixtures gs-01 to gs-04 and gs-07 to gs-09 have `prompt_start` equal to `SessionStart`, so they are unaffected; gs-06 has no artisyn log.
   - The work-time report (`check-arithmetic.mjs:474-477`) also anchors on start.
   - Local corpus `expected.json` `startTime` shifts by +303 ms (js-cli), +298 ms (node-service) and +288 ms (ts-webapp), so it needs `CORPUS_APPROVE=1` re-approval locally.
2. **FR-3 corpus AC:** `diff-format.mjs --approve` cannot add `silent_turn_reminder` or `deferred_tools_record`, because no local set contains them. S-CORPUS-03 already passes. The plan must decide whether to hand-edit `known-format.json`, generate a new set, or treat the AC as already met.
3. **FR-1 contract oracle:** the `f17-sessions.ts` `has_workflow` rule differs from the controller's. Decide whether to align it (and add a `prompt_snapshot` with a Workflow entry to a world-v1 claude body) or rely on golden-load and corpus. No route changes, so the router meta-test needs no new row.
4. **FR-2:** nothing to change. The test asked for "every detector changed" has no target, so the outcome is just the audit write-up in `notes.md`.
5. **FR-5 rule details not settled in requirements:** whether a `prompt_start` with an empty or null `prompt` counts (`extractFirstPrompt` skips those); and what happens if the first prompt line has no or invalid timestamp (presumably the next valid one, otherwise the fallback). The new algorithm doc and `artisyn-extractor.algo.spec.ts` are new files. There is no twin in the hook or client.
6. **FR-6:**
   - There is no metrics-endpoint regex; one is needed, along with a shared ownership predicate (port in range, or equal to the recorded `otel-port.json`/`log-hub.json` port, read before L693).
   - `readSettingsForMutation` has to be parameterised by file.
   - There is no installer unit-test harness: `artisyn-hooks-installer` has no test script, and only a stale `dist/__tests__/install.test.js` remains. So coverage is scenario-only.
   - The two "Note:" texts asserted in S-INST-04 step 3 will change.
7. **Open questions:** all 18 in `open_questions_ru.md` have answers, and every one is reflected in `requirements.md`. Q1 ("make a prototype") is now settled by the finding above (the type does not replace the delta). Record that in `notes.md` and tidy FR-3's conditional wording. Q4 ("find it") is the gap in item 2.
