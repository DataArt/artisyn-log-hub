---
type: "Note"
title: "Plan research findings 1"
description: "Research subagent report for the otel-events-triage implementation plan (audit archive, 2026-11-24)."
---

# Plan research findings 1 (2026-11-24)

Context for the `2026-11-24-otel-events-triage` plan is below. Nothing was written or modified. The ce index was refreshed and used for the server; client and tests were checked with grep.

## Requirements summary
Log Hub's OTEL path reads only `claude_code.api_request` log records (into `otel_calls`) and spans (into `otel_spans`). Every other log event reaches `logs_otel.body` and the realtime batches, but nothing reads it. FR-1 (inventory) and FR-2 (decisions) are done and approved. What is left:
- **FR-3:** add the `gen_ai.usage.input_tokens` rule (it already includes cache read and cache write tokens; never add it again) to `otel-tabs.md` and `llm-call-math.md`.
- **FR-4:** surface these items on the session OTEL tab: `compaction`, `api_error`, `api_retries_exhausted`, `skill_activated`, `subagent_completed`, `permission_mode_changed`, `tool_decision` (decision, source, permission_mode, classifier_verdict / classifier_category), the `delivery.mode=mid_turn` attribute of `user_prompt` (never the prompt text), and `hook_execution_complete` aggregated by `hook_name`.
  - UI: event markers on the cost chart with an Events On/Off toggle, a "Session events" card with filter chips, and a "Hook overhead" card.
  - API: one new optional field on `GET /api/v1/repositories/:repoId/sessions/:sessionId/otel`, included in `since`/`seq` deltas, with a contract registry row.
  - Masking: event attributes are dropped for `team-no-prompts` callers (DD-22).
  - History: anything added to an existing table is backfilled by bumping `OTEL_PROJECTION_VERSION`.
  - Constraint: "no new generic events table".
- **FR-5:** no events means no markers, no toggle and no new cards. The compatibility matrix gets a row per item, and `s-compat-01` must still pass.
- **Hook:** no change needed. The receiver already forwards every `logs` and `spans` line (`otel-receiver.md` §Realtime sender, `RT_SIGNALS`).
- `open_questions_ru.md` is empty (only a `## Вопросы` header), so there are no user answers.

Facts from the capture (`docs/pocs/2026-11-24-1526-otel-events-capture/results/inventory-2.1.331.md`):
- **Value types vary.** `compaction` sends `pre_tokens`, `post_tokens` and `duration_ms` as strings ("5794"). `hook_execution_complete` counts are strings too. `subagent_completed` and `api_*` send numbers. The extractor has to coerce both.
- **Event name.** Every record carries an `event.name` attribute. The body holds `claude_code.<name>`; the fixture's `apiRequestLine` uses `body.stringValue = 'claude_code.api_request'`.
- **No natural key.** Events have no `request_id`, and `event.sequence` is a per-process counter that is not unique across resume. A key will need the `otelCallKey` fallback: sha1 of `{timeUnixNano, attributes}`.
- **Sensitive attributes.** `OTEL_LOG_TOOL_DETAILS=1` is in the installer env (`artisyn-hooks-installer/src/otel-env.ts:31`), so `tool_decision` carries `tool_parameters` (redacted in the PoC sample, so possibly commands or paths). `user_prompt` has `prompt` / `prompt_text` (`<REDACTED>` in the capture). `api_error.error` is free text. The extractor should keep only a whitelist of keys.
- **Agent ids.** `agent_id` is present on sub-agent `tool_decision`, `tool_result` and `hook_execution_*` events and on `subagent_completed`. Main-thread events have none, so the "main" agent is implied.
- **Attributes we have no sample of.** `classifier_category` was never emitted. `compaction.trigger` was only seen as `manual`; the wireframe's `auto` value is unverified.

## Wireframes
`wireframes/session-otel-events.svg` (1440×1640):

1. **Events toggle.** An "Events On|Off" segmented control after the Stack-by control, default On, hidden when the session has no events. Note 1 says it is "kept in the URL with the other chart params". This **conflicts** with `SessionOtelTab.tsx:14-16`: "Chart settings and legend state are local (the session tab has no URL state of its own)".
2. **Markers.** Dashed vertical lines with diamond badges (C compaction `#0891b2`, S skill `#16a34a`, A sub-agent done `#7c3aed`, ! API failure `#dc2626`). Hover shows a tooltip (time · event, key attributes, agent, "click to open in Session events"). Clicking scrolls to the row. The legend gains an "Events:" group.
3. **Session events card** ("NEW" badge). Subtitle "9 of 31 shown · newest last". Chips: All 31 / Compaction 2 / API failures 2 / Skills 3 / Sub-agents 4 / Permissions 12 / Mid-turn prompts 1. Columns TIME / EVENT / AGENT / DETAILS. The API-failure row has a red background (`#fef2f2`). "Show 22 more ▾". Live rows arrive through `since=` with the usual highlight.
   - **Arithmetic inconsistency:** the chips sum to 2+2+3+4+12+1 = **24**, not 31, so 7 events have no chip. There is no separate "Tool decisions" chip; presumably "Permissions" covers `tool_decision` plus `permission_mode_changed`. 31−9 = 22 matches "Show 22 more", but only 7 rows are drawn.
4. **Row formats.**
   - Compaction: "182 K → 41 K tokens · 5.8 s".
   - Skill: "name · source · trigger".
   - Mid-turn: "prompt text not shown".
   - Tool decision: "Write · by config · mode default"; title "Tool decision · rejected" (raw value `reject`).
   - Sub-agent: "Explore · 1m 56s · 21 K tokens · 7 tool uses"; agent column shows a short `agent_id` (`a432dc`).
   - API retries: "connection_error · 3 attempts · 1.7 s retrying".
   - Permission mode: "default → acceptEdits".
   - Team-no-prompts caller: Details reads "hidden for your role".
5. **Hook overhead card.** Columns HOOK EVENT : TOOL / RUNS / HOOKS/RUN / TOTAL / AVG / STDOUT / ERRORS / SHARE (bar). Header: "5.4 s of hook time = 0.4 % of session wall time". The figures check out exactly:
   - 3.1 + 1.4 + 0.9 = 5.4 s.
   - Wall time 14:01:12→14:24:40 = 1408 s; 5.4/1408 = 0.3835 % → 0.4 %.
   - AVG: 3100/42 = 73.8 → 74 ms; 1400/42 = 33.3 → 33 ms; 900/6 = 150 ms.
   - Share bars of 88 px: 57.4 % → 50.5 px (drawn 50); 25.9 % → 22.8 px (23); 16.7 % → 14.7 px (15).

   Note under the card: a session without `hook_execution_*` shows "Not reported by this Claude Code version". The final note and FR-5 instead say "cards hidden". **Conflict.**
6. Everything else (KPI tiles, Traces) is unchanged.

## Knowledgebase
- `docs/knowledgebase/otel-tabs.md` is the main article:
  - Two channels end in one writer, `applyOtelLines`.
  - Every write does `seq = seq + 1` and stamps `seq` / `change_kind` on each row; the reader runs one REPEATABLE READ transaction with `since < seq <= S` and an empty-delta fast path.
  - Change kinds: new / update / confirm / fill / reclass.
  - DD-22 masking: `masksOtelAttributes` sets `attributesMasked` and drops span attributes.
  - Projection version: "Bump it again whenever extraction gains fields history should get"; the startup re-mark sets `< current` → NULL.
  - Additive-field rule for routes; the client keeps the previous value when a field is absent (the `plan` precedent).
  - Compatibility matrix tables at lines 576-611 (the new rows go there). The Live-view "Scope cuts" note at line 554 says `api_error` / `user_prompt` are not stored, so update it.
  - Tests section: algorithm docs, `f25-otel.ts`, `s-otel-01`.
- `docs/knowledgebase/db-tables.md` §"OTEL tab tables" (l.265-315): root-session key, sub-agent rows split by `agent_id`, `seq` on every fact row, rules for zeroing vs deleting, and how purge happens. Any new column or table goes here, plus the `db-state-update` skill after the migration (latest is `0096_logs_streaming_skip_tombstones.sql`).
- `docs/knowledgebase/llm-call-math.md` gets the FR-3 rule. Candidate homes: §1 Token Breakdown or §"Two cost sources: computed vs. telemetry".
- `docs/knowledgebase/algorithms/otel-facts.md` plus `docs/algorithm-examples/otel-facts.json` (65 rows `OF-01..OF-65`, shape `{id,input:{kind,...},expected,note}`) is the place for the event-extraction rows (a new `kind`).
- `docs/knowledgebase/algorithms/otel-delta-merge.md` plus `otel-delta-merge.json` (15 rows `DM-*`) is where rows for merging and highlighting events in `mergeOtelDelta` would go.
- `docs/knowledgebase/ui-principles.md`: light-only palette, Cost = blue `#3b82f6`, "an undefined value is not zero", floating surfaces through `ViewportPopover`.
- `docs/knowledgebase/client-routing-and-layout.md`: session tabs come from `tab-ids.ts`; `SessionOtelTab` is lazy through `session-tabs-lazy-group.ts`, and no new chunk is allowed (~8, never more than 10).
- `docs/knowledgebase/session-metrics-scope.md`: root vs tree scope. Events are per root tree, and OTEL `session.id` is always the root.
- `user-docs/otel-tab.md` §"Session OTEL tab" (l.47-84) is the in-app help to extend; the product must work offline.
- `docs/knowledgebase/test/scenarios.md` and `contract-tests.md` describe the scenario stand and the contract registry with hand-written SQL.

## Existing patterns
**Server — extraction and writing**
- `server/src/logs/otel/otel-records.ts`
  - `:24`: `API_REQUEST_EVENT` filter on `record.body.stringValue`.
  - `:187` `extractOtelCalls`: the pure-extractor template (dedup by key, keep the last one, skip a record with no event time).
  - `:99` `resolveOtelEventTime`: `event.timestamp`, else `timeUnixNano`, else `receivedAt`.
  - `:133` `otelCallKey`: sha1 fallback key.
  - `:306` `extractOtelAccount`: latest-wins example.
  - `:438` `capAttributes`: the 64 KiB cap.
- `server/src/logs/otel-chunk.ts:29,75,97,114`: `attributesOf`, `tokenCountOf`, `cappedStringAttrOf`, `stringAttrOf` (attribute readers that tolerate odd values).
- `server/src/logs/otel/otel-facts-writer.ts`
  - `:1445` `applyOtelLines`: extract, upsert, `changed` decides the seq bump, then the state UPDATE. A new upsert step would plug in here.
  - `:1209` `upsertOtelSpans`: model for an upsert with `ON CONFLICT … change_kind = CASE IS DISTINCT FROM → update else confirm`, `source_mask` OR, and `insertKind(source, hasRealtime)` (`:531`).
- `server/src/logs/otel/otel-facts.constants.ts:35`: `OTEL_PROJECTION_VERSION = 2`. Bump it for the backfill; the re-mark is at `server/src/database/database-init.ts:176`.

**Server — schema and purge**
- `server/src/database/schema/index.ts:537-760`: `otelCalls`, `otelSpans` (attributes jsonb), `otelCostBuckets`, `otelSessionState`, `otelSessionTotals` (precedent for a derived per-root table, migration 0089).
- `server/src/logs/otel/otel-projection.service.ts:531-534`: cleanup of deleted sessions (each OTEL table is listed explicitly).
- `server/src/sessions/sessions.service.ts`: `purgeSessionChildData` must also list any new table.

**Server — reading and the route**
- `server/src/logs/otel/otel-facts-read.sql.ts`
  - `:1271` `loadSessionSpans(db, rootId, since, withAttributes)`: delta filter `seq > since`, change kind becomes `reclass` for rows not stamped since then, attributes come back as `NULL::jsonb` when masked. This is the model for the events loader.
  - `:1190` `loadSessionCalls`.
- `server/src/logs/otel/otel-facts.reader.ts`
  - `:825` `getSessionOtel`: the response is assembled here. The empty-delta fast path (`:873`) and `emptySession` (`:978`) must carry the new field.
  - `:439` `masksOtelAttributes`; `:1006` `toSessionPlan` is an example of a masked field.
- `server/src/logs/otel/otel-facts.types.ts:397` `SessionOtelResponse`: add the optional field next to `plan?`. The client mirror is `client/src/models/repositories.ts:1273`.
- `server/src/logs/reports/cache-read-ratio.service.ts:65` `CacheRatioCauses.compaction` and `session_cause_stats`: the existing compaction source named in the FR-2 table, so the UI must not show two conflicting numbers.

**Client**
- `client/src/viewer/pages/repository/session-log/otel/SessionOtelTab.tsx`
  - The tab composition: chart section, KPI tiles, `OtelStructureSection`, traces. New cards go between the KPI block and Traces.
  - Uses `useOtelLivePoll` with `sessionOtelPollStep`.
  - `STACK_OPTIONS` and `DEFAULT_CHART` are local state.
- `client/src/viewer/pages/repository/otel/OtelCostChart.tsx`: Recharts `ComposedChart` with a **categorical** `XAxis dataKey="start"` (bucket starts). Markers have to snap to a bucket category, or the axis has to become numeric/time. Highlighting uses a custom bar `shape`.
- Recharts `ReferenceLine` / `ReferenceDot` examples: `client/src/viewer/pages/repository/analytics/BudgetBurnView.tsx:274-294`, `client/src/viewer/pages/spend/DailySpendChart.tsx:156`.
- `client/src/viewer/pages/repository/otel/OtelChartControls.tsx:24` `OtelSegmented`: reuse for the Events On/Off toggle.
- `client/src/viewer/pages/repository/otel/otel-merge.ts:160` `mergeOtelDelta`: add the events field with `mergeRows` / `classifyRows` by key, and "absent → keep previous" like `plan`. Its algorithm test is `otel-merge.algo.test.ts`.
- `client/src/viewer/pages/repository/session-log/otel/SpanDetailsPanel.tsx`: existing "hidden for your role" handling for masked attributes.
- `client/src/viewer/pages/repository/otel/OtelQuerySourceTable.tsx` and `OtelStructureSection.tsx`: existing table-card styling to reuse for the Hook overhead table and share bars.

**Tests**
- `server/src/logs/otel/otel-facts.algo.spec.ts:30-45`: the `FactsInput` union of kinds. Add a new `kind` (e.g. `events`) and its `case`.
- `server/test/contract/registry/f25-otel.ts:1071+`: `SESSION_OTEL` cases (`F25-session-snapshot`, delta, masked); `spansSql(delta, masked)` at `:281` is the model for an events oracle SQL; `s01Status(masked)` at `:315`. Fixture data: `server/test/contract/fixtures/world-v1.sql.ts`.
- `tests/scenarios/fixtures/otel/otel-lines.ts:102` `apiRequestLine`: template for a new event-line builder (`s()` / `i()` attribute helpers, `LOGS_SCOPE`).
- `tests/scenarios/helpers/otel.ts`: `uploadOtelChunk`, `sendRealtime`, `waitForOtelProjected`, `resetOtelProjection` (`:148`, for the "pre-change session re-projected" check).
- `tests/scenarios/view/s-otel-01.spec.ts`:
  - session-tab steps around l.416-512;
  - live delta steps l.755-950;
  - "AC-12/13 upgrade half: facts dropped, chunks unprojected → drain rebuilds" at l.519, the model for the FR-4 backfill check;
  - team / restricted steps l.1071+.
- `tests/scenarios/view/s-otel-02.spec.ts:537`: masked `attributesMasked: true` assertion pattern.
- `tests/scenarios/hook/s-compat-01.spec.ts:614-642`: frozen 2.28.0 OTEL step. Logs-only chunk with no events; must stay green.

## Open gaps
1. **Where events are stored.** FR-2 rules out a "new generic events table" and says "enrich the current OTEL fact tables", but no existing table fits point events with no key. Options the plan has to pick from:
   - (a) one or more per-kind tables, e.g. `otel_hook_stats` keyed `(session_id, hook_name)` as an aggregate plus a typed `otel_session_events`;
   - (b) a jsonb column on `otel_session_state` (bad for `seq` deltas);
   - (c) synthetic rows in `otel_spans` (would pollute `assembleOtelTraces` and the rollups).

   Whatever is chosen needs `seq` / `change_kind` / `source_mask` / `first_seq`, the purge and cleanup lists, a migration (0097), the db-tables entry and `db_state.sql`.
2. **Event key and dedup** across realtime and chunk, and across `--resume`. No `request_id`; the sha1-of-record fallback is the only existing pattern.
3. **Hook overhead aggregation.** Either stored per `hook_name` (so it needs to be delta-friendly) or computed from stored raw events at read time. The "% of session wall time" denominator has no existing source on the OTEL route: wall time is the session header's start/end, and `work time` is a different value.
4. **Attribute whitelist per kind**, and dropping `tool_parameters` / `prompt` / `prompt_text` / `error` text at extraction. The `error` string is shown in the wireframe ("connection_error"), so it is masked for team-no-prompts but kept otherwise. The plan has to decide whether to store raw `error` or only a class.
5. **Marker placement on a categorical bucket axis.** There is no existing time-positioned marker on `OtelCostChart`.
6. **Toggle state.** The wireframe says URL; the session tab has no URL state (`SessionOtelTab.tsx:14`). Decide between a new param and local state.
7. **Hook overhead card when there are no `hook_execution_*` events.** Hidden (FR-5 and the wireframe's final note) or a "Not reported by this Claude Code version" message (the note under the card)?
8. **Wireframe chip counts.** The kind chips sum to 24 against "All 31"; the chip-to-kind mapping needs to be settled, in particular whether "Permissions" covers both `tool_decision` and `permission_mode_changed`.
9. **Compaction vs `session_cause_stats.compaction`.** That source is transcript-derived and root-only. There is no existing UI cross-reference rule to follow.
10. **Join to sub-agents.** `subagent_completed.agent_id` against `otel_agent_totals.agent_key` / `agent_name`; no existing reader joins events to agents.
11. **No algorithm doc for event extraction yet.** Either extend `otel-facts.md` with a new section and kind (preferred under the test policy) or add a new doc together with its rows file.
