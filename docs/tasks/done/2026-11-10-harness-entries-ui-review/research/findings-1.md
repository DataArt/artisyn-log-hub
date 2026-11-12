# Research findings 1 (plan-deep, 2026-11-11)

Nothing is built in this task. Its output is a research document (`analysis.md` plus `research/`) and a ranked list of follow-up tasks. The plan should cover the survey re-run, the decision tables, the Logs tab review and wireframes, with no product code. No `open_questions_ru.md` exists in the task folder yet.

## Requirements summary
Analyse about 30 kinds of entries that Claude Code (the harness) injects into transcripts: attachment types and `system` subtypes. For each type, decide one of three things, with a one-line reason:
- **(a)** extra markup on an existing tab, naming the tab and the place
- **(b)** a new tab, chart or report, per session or per repo/team
- **(c)** not worth showing

Every (a) or (b) item must state:
- which fields it reads
- whether it runs client-only from the `/logs` payload or needs the server (and then which extractor it extends)
- the hook impact and its backward compatibility
- the equivalent event in the hook's own `artisyn` log and which source it prefers
- privacy
- how it degrades when the entry is missing (FR-7: Stop-time entries, the SessionEnd flush in hook ≥ 2.8.0, no `turn_duration` in `claude -p` sessions)
- its producer, and which setups lack that producer (FR-8)

The rest of the scope:
- **Logs tab review (FR-3):** per-turn "Signals" markup, a "Signal sources" strip, what is outdated or redundant, and UX improvements with SVG wireframes.
- **Overlap check (FR-4):** map each finding to `2026-11-09-session-waiting-breakdown`, `2026-11-02-session-antipatterns` or `2026-11-10-sysctx-prompt-viewer`, or mark it "new".
- **Survey re-run (FR-6):** at least 30 sessions read from what Log Hub stored (local prod DB or the `/logs` payload), segmented by `entrypoint`, CC version, OS, IDE, diagnostics `source` and configured hooks; "n < 3" for small groups. Scripts and the table go in `research/`.
- **Follow-up list (FR-5):** each item has value H/M/L (share of sessions where the producer is present), effort S/M/L, its decision lines and the task it extends. Every finding A1–A5, B6–B13, C14–C16 of `research/setup-neutrality-audit.md` must appear in it. The research is in English and committed files hold aggregates only.

The user already answered the two open questions:
- hook-health and diagnostics analytics should be per repo and per team
- session-mode (`auto_mode`) segmentation should be shown

## Wireframes
**`wireframes/logs-tab-harness-markup.svg`** shows these numbered elements:
1. A "Signals: Show ✓ · Only turns with issues" bar with session-wide counts ("1 interrupt · 1 hook error · 1 compaction · 1 external edit").
2. A "Signal sources" strip: hooks ✓ 2 · IDE ✓ (name not recorded) · diagnostics — none seen · entrypoint: cli · CC 2.1.314.
3. A turn-header chip "turn 0:00:52 · 14 msgs · hooks 3.9s", taken from `turn_duration` plus the sum of hook `durationMs`. It reads "turn timing: not recorded" when the entries are missing.
4. A per-turn collapsible ⚑ Signals section, in the same style as Tools/Rules, with chips.
5. A "⏸ silent 1× nudged" chip from `silent_turn_reminder`.
6. A "↯ User interjected mid-turn · 09:16:50 (+1:49 into the turn)" marker from `queued_command`, with the quoted text labelled "queued, not a new turn".
7. An extended compaction divider: trigger, pre→post tokens, files re-read (`compact_file_reference`), size of re-injected skills + CLAUDE.md.
8. Degradation notes, plus a privacy and OS-neutrality note (repo-relative paths from `file://`, `X:\` in any case, or `/`; basename outside the repo; no email, no gitStatus, no snippets in chips).

The mock tab bar is "Cost ▾ | Summary Statistics Call Tree Context Growth More ▾ | Logs" (the lens model).

**`wireframes/logs-turn-signals-section.svg`** shows the expanded section using the Tools-row layout (kind badge · mono metric · mono detail · › opens the raw entry in the Raw logs modal). Its groups:
- **HOOKS:** "4 runs · 4.6 s total"; error rows show exit code and stderr; the ok row is aggregated as "slowest: 'Uploading logs...'". Each row is labelled by `command`, because `hookName` is just the event.
- **IDE:** opened / selected with line range; `ideName` or "name not recorded".
- **EDITED OUTSIDE THE AGENT:** path and time; the snippet only in the modal.
- **DIAGNOSTICS:** sub-grouped by raw `source`, a missing source goes to "other"; marked "fixed ✓" (a later Edit/Write of the file) or "not fixed".
- **CONTEXT:** read truncated, rules re-injected.

Groups whose producer is absent are hidden, and unknown types stay on Raw logs only.

**Points the plan must reconcile:**
- The compaction divider already exists (see Existing patterns). The current one shows "⟳" and hides the trigger when it is `auto`; the wireframe shows "⇣ … (auto)".
- The "Signals" label is fixed by FR-3. Element 3's per-turn hook time needs a hook-to-turn assignment.

## Knowledgebase
- **`docs/knowledgebase/log-schema/attachment-types.md`**
  - The FR-1 scope list: 27 types (20 auto-generated, 7 hand-maintained).
  - The sizing table at lines 27-43 shows which types the anatomy tab measures.
  - "Suggested Display Strategy" at lines 612+ gives earlier per-type ideas to reconcile.
  - Newly found types (`read_truncation_notice`, `hook_non_blocking_error`, `budget_usd`, `environment`, `invoked_skills` shapes, …) need rows here. Document field names and sizes only, never text.
- **`docs/knowledgebase/log-schema/claude-log-message-types.md`**
  - `system` subtypes are documented only implicitly: `stop_hook_summary`, `turn_duration`, `local_command`, compact (`compactMetadata`), at lines 372-428.
  - `scheduled_task_fire` is not documented; neither are `informational` or `api_error` (to check).
  - `queue-operation` is at line 351.
- **`docs/knowledgebase/session-log-view.md`**
  - Logs tab file map at lines 19-55.
  - The `/logs` payload contract at lines 77-112: add a field by extending the string in `getSessionLogs` and `SessionLogsData`, optional on the client.
  - Prompt Turn Item sections at lines 630-653.
  - "Special log event fields" at lines 811-818 lists the types the parser ignores.
  - The per-turn assignment pattern: a BFS over `parentUuid` that stops at qualifying user events.
- **`docs/knowledgebase/harness-usage-tab.md:86-88`** says "Neither the session `/logs` payload nor the transcript carries per-invocation hook records". This is false (`hook_success` exists), and FR-3 requires correcting it. Lines 135-147 explain why the tab walks raw NDJSON rather than `parseSessionLogs` or `session_harness_usage`, which is relevant to a client-only hooks follow-up.
- **`docs/knowledgebase/raw-logs-renderers.md`**
  - `attachment-file.tsx` covers `file`, `edited_text_file`, `compact_file_reference`, `nested_memory` and the IDE types.
  - `attachment-system.tsx` covers `hook_success`, `diagnostics`, `queued_command`, `invoked_skills`, ….
  - `system.tsx` `SystemExpanded` already renders hook*/durationMs/messageCount/compactMetadata.
  - Lines 146-165 list the 2.1.280+ types with no renderer.
  - This is the "› opens the raw entry" modal the wireframe reuses.
- **`docs/knowledgebase/sysctx-anatomy-tab.md`**: anatomy covers the startup block only, and the `StartupContextLine` is at lines 168-172. The analysis's mid-session context tax extends past this.
- **`docs/knowledgebase/server-conventions.md:15`**: list and analytics endpoints must never read `logs.body` per request. Any repo/team (b) item therefore needs an ingest-time extractor and a derived table.
- **`docs/knowledgebase/algorithms/work-time.md`**: rule 4 (waiting counted as work) overlaps audit finding B9 and the waiting-breakdown task.
- **`docs/knowledgebase/hook-api-versioning.md`** and **`hook/HOW_HOOK_WORKS.md`**:
  - `prompt_start`/`prompt_stop` at lines 81-110
  - the hook event list incl. `PreCompact`/`PostCompact` at line 114
  - SessionEnd flush (2.8.0+) at lines 441-480
  - `hook-status` at lines 462 and 489
  - These are the `artisyn`-log equivalents FR-2 needs.
- **`docs/knowledgebase/repo-identity.md`** and **`change-surface.md`** describe path normalisation that is already setup-neutral (the audit's "checked" list); reuse it for repo-relative reduction.
- **`docs/knowledgebase/algorithms/README.md`**: a new client derivation, such as signal extraction per turn, would need its own algorithm doc plus `docs/algorithm-examples/<name>.json`. That belongs to a follow-up task, not this analysis.
- **`docs/product-kb/competitive-research/budgets-forecasts-waiting.md`** and **`gap-closing-plan.md`**: competitor parity (NFR). New product ideas go to `docs/product-kb/ideas/`.
- **`docs/kb-local/local-prod.md`** (personal, gitignored): local prod runs at :5003; the DB container is `artisyn-log-hub-db` (postgres 18.2-alpine), its data is real, and it is read-only for us. Never point tests at it.

## Existing patterns
**Client — turn model and Logs tab rendering**
- `client/src/viewer/pages/repository/session-log/types.ts`
  - Lines 131-153: typed `SystemTurnDurationEvent` (`durationMs`, `messageCount`) and `SystemCompactBoundaryEvent`. The turn-duration type exists but nothing reads it.
  - Lines 374-406: the `PromptTurn` shape. A `signals` field would be added here.
  - Lines 458-475: `ParsedSession.compactBoundaries`.
- `client/src/viewer/pages/repository/session-log/log-parser.ts`
  - Lines 795-830 (`extractRulesInjected(events, uuidSet, …)`): the template for collecting attachments per turn from the turn's uuid set.
  - Lines 1937-1980: per-turn `uuidSet` / `workTimeUuidSet`.
  - Lines 2766-2810: `compactBoundaries`, with a fallback from the artisyn `PreCompact` event within 10 min. This is an existing artisyn↔transcript preference example.
  - Lines 2678-2712: repo-root guessing (audit C14).
- `client/src/viewer/pages/repository/session-log/PromptTurnList.tsx`
  - Lines 37-83: the `CompactBoundaryDivider` already shows ⟳ "Context compacted", pre→post, −N (−%) and duration. Wireframe item 7 extends it.
  - Line 108: `isSystemOnlyTurn` filtering.
  - Lines 85-97: `StopFailureBanner`.
  - There is no toolbar today; the Signals bar would go here or in `SessionLogView`.
- `client/src/viewer/pages/repository/session-log/compact-boundary-placement.ts:9-26`: `compactBoundariesBetween` / `findBoundaryTurnIndex`, the timestamp-between-turns placement used for the divider and the context-compression detector. Reuse it for `queued_command` offsets and session-level markers.
- `client/src/viewer/pages/repository/session-log/PromptTurnItem.tsx:146-330`: section order Header → PromptText → TokenMetrics → Skills → Rules → Tools (`SectionHeader` + `ToolCallRow`) → Files → Images → Agents → Sub-agents → Workflows. The model for a new `PromptTurnSignalsSection.tsx` is `PromptTurnRulesSection.tsx` / `PromptTurnSkillsSection.tsx`, and `PromptTurnHeader.tsx` gets the timing chip.
- `client/src/viewer/pages/repository/session-log/StartupContextLine.tsx` (48 lines): the one-line band pattern for a "Signal sources" strip.

**Client — raw renderers and path helpers**
- `client/src/viewer/pages/repository/session-log/raw-logs/attachment-system.tsx`: lines 16 (`hook_success`), 141 (`diagnostics`), 184 (`queued_command`) and 209 (`invoked_skills`) show the current field reads.
- `raw-logs/attachment-file.tsx:11,35,54`: `edited_text_file` and IDE types.
- `raw-logs/primitives.tsx:86-108`: `entrypoint` is shown in CommonFields only.
- `client/src/viewer/pages/repository/session-log/background-mcp.ts:79-91` (with the server twin `server/src/logs/background-mcp.ts:110-134`): reads `queue-operation` lines that are deliberately outside the `TelemetryEvent` union. Use the same approach for untyped harness lines.
- `client/src/viewer/pages/repository/session-log/harness-usage/harness-elements.ts`: a single raw NDJSON walk per session, including sub-agents. This is the pattern for a client-only Hooks kind in Harness usage.
- `client/src/viewer/pages/repository/session-log/instruction-files.ts` (`toUserDisplayPath`), `normaliseClientPath`, `toRepoRelative` and the anatomy `pathKey` are the setup-neutral path reducers named in the audit. Do not use `prompt-turn-helpers.tsx:395` or `packages/bash-view/src/display-paths.ts:14`, which fail on `file://` and `/mnt/c` (audit C16).
- `client/src/viewer/tab-ids.ts:167-410`: the session tabs and groups (Overview / Transcript / Cost & context / Effects): Summary, Info, Statistics, Advisor, Session Map, Logs, Bash, Raw Logs, Dashboard, Context Growth, Context Usage, Agent Tree, Timeline, Tool Heatmap, Call Tree, Charts, System context anatomy, Harness usage, OTEL, Change surface, Tools/MCP, OKF. These are the candidates for the FR-3 redundancy check.

**Server**
- `server/src/logs/turn-walk.ts`
  - Lines 64 and 155-250: `compact_boundary` is read per turn.
  - Lines 436-448: `deferred_tools_delta` feeds `is_initial`.
  - Lines 177-183 and 385-391: raw-path re-read compare (audit B13).
- `server/src/logs/claude-extractor.ts:774` (`nested_memory` becomes harness kind=rule) and `:595` (`inferToolIsInitial`): the ingest extractors a server follow-up would extend. `entrypoint` is not extracted (audit B8). Use the `ce` skill for callers.
- `server/src/database/schema/index.ts:1381-1401` (`session_harness_usage`, `is_initial`) and `:498` (`claude_code_version` on OTEL call rows): the DB targets for the corrected consumer column.
- `server/src/logs/repositories.controller.ts` `getSessionLogs`: the `/logs` payload source (a hand-concatenated JSON string).

**Hook**
- `hook/.claude/telemetry_tool/send-logs-hook.js:1793`: `turn_duration` is appended after Stop fires, so it lands in the next upload or the SessionEnd flush. This is the basis for the FR-7 last-turn behaviour.
- `hook/.claude/telemetry_tool/post-turn-analysis-worker.js:264-297,609-631`: the hook-side `compact_boundary` and `queue-operation` reads (twins).

**Survey tooling (FR-6)**
- `tmp/attach-scan.js`, `tmp/diag-scan.js`, `tmp/snapshot-scan.js`: the initial survey. They read `~/.claude/projects`, which FR-6 does not allow. Port the counting logic into `research/` against stored data.
- `docs/pocs/2026-10-30-1407-otel-traces-session-view/build.js:39-60` with `facts.sql`: the house pattern for read-only DB scans (`docker exec -i <container> sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" --csv'`, container from an env var defaulting to `artisyn-log-hub-db`, `statement_timeout`). Use `jsonb_array_elements(logs.body)` with `log_type IN ('claude','claude-subagent')`.
- `docs/pocs/2026-10-29-1504-sysctx-anatomy/` (`anatomy.cjs`, `README.md`, `sample-output.md`): the layout for a reproducible scan script plus a redacted sample output. Node only; no Python.

**Tests a follow-up would extend (none for this analysis)**
- Scenario `tests/scenarios/view/s-sess-03.spec.ts`, "@S-SESS-03 Logs: what counts as a prompt, what is hidden, how a turn reads", is the natural home for Signals and timing-chip steps.
- `s-sess-14.spec.ts` (tool-call details, statuses) and `s-sess-12.spec.ts` (Raw Logs) are also candidates.
- Golden sessions `tests/golden/gs-03-compaction` (compaction divider), `gs-05-skills-rules-mcp-workflow` and `gs-09-windows-paths` (path neutrality).
- A new client signal derivation would need a new algorithm doc and rows file under `docs/knowledgebase/algorithms/` and `docs/algorithm-examples/`, picked up by the `*.algo.test.ts` table test.
- API contract (`server/test/contract/registry/`): only if a follow-up adds or changes a route, for example repo/team hook-health or diagnostics reports.

## Open gaps
- **Survey script:** there is no committed script that reads stored transcripts by facet. The plan must decide between a DB query and the `/logs` API:
  - The DB route needs `docker exec` into local-prod `artisyn-log-hub-db` and is strictly read-only.
  - The `/logs` API route needs a session list and per-session fetches at :5003.
  - Either way: which sessions (at least 30, sub-agent transcripts included or not), and where raw output goes (`tmp/`).
  - Local prod has 1 user and is all-Windows (297 sessions; IDE in 1; diagnostics in 147, all `typescript`), so most facet cells will be "n < 3". This must be recorded.
- **Hook identity facet:** "configured hook names" come only from `hook_success.command` / `stop_hook_summary.hookInfos`, and `command` is sometimes a status text. There is no stable hook identity field; define it.
- **Undocumented subtypes:** `system` subtypes are not enumerated in the KB (`scheduled_task_fire`, `informational`, `local_command` …), and neither are attachment types like `read_truncation_notice`, `hook_non_blocking_error`, `budget_usd`, `environment`, `model`, `language`, `date`, `credential_org` and `instructions`. The scan has to discover them, and the KB rows need adding. The KB-update scope (attachment-types.md / claude-log-message-types.md) is a plan decision.
- **Hook-to-turn assignment:** there is no rule yet for hook entries that land after the turn's last assistant line (Stop hooks), nor for the unflushed last turn.
- **"Usage" tab:** FR-3 lists a "Usage" tab, but `tab-ids.ts` has none by that name: the options are Context Usage, Statistics, or the `session-log/usage/` derive. Clarify which is meant.
- **Signals filter:** there is no Logs toolbar or filter precedent. The URL vs local state for "Signals: Show / Only turns with issues" must be decided (see `client-routing-and-layout.md` on URL state and per-user storage keys).
- **Wireframe conflicts:**
  - The divider glyph and text conflict with the existing `CompactBoundaryDivider`.
  - The wireframe quotes `queued_command` text inline. That matches FR-2 only if that text is already on the Logs tab; verify whether the parser shows the queued text anywhere today.
- **Sub-agent diagnostics:** none appear in sub-agent transcripts (notes.md). Decide whether Signals in `SubAgentDetail` are out of scope.
- **Output layout:** the format of `analysis.md` vs a summary in `requirements.md`, and the follow-up list format, are unspecified apart from the FR-5 fields.
