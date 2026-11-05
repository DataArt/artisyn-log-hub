# Research findings 1 — 2026-11-04 (plan-deep)

## Requirements summary
GH-89 builds on the newer Claude Code OTEL fields (2.1.300–2.1.317). It has six parts:
- **FR-1 / FR-2:** `extractOtelCalls` also reads the 5m/1h cache-write split and seven attribution attributes (`effort`, `speed`, `skill.name`, `plugin.name`, `agent.name`, `mcp_server.name`, `mcp_tool.name`). They are stored as nullable `otel_calls` columns and not exposed in `OtelCallRow`.
- **FR-3:** the repository, session and team OTEL routes get four new `stackBy` values: `skill`, `mcpServer`, `effort`, `speed`. They are served from `otel_cost_buckets`, whose grain gains four `NOT NULL DEFAULT ''` columns. `''` is the "not reported" group, so the stack still sums to the total.
- **FR-4 / FR-5:** `anthropic.plan`, `seat_type`, `provider` and `custom_base_url` are stored on `otel_session_state` (latest non-null value by event time). They are returned as `SessionOtelResponse.plan`. The session tab shows an "Account" row, a plan note and a `plan: <value>` chip. The repository and team routes return a `planMix` (`OtelPlanMixRow` = plan, session count, cost) shown on the Total tile. There is no plan allowlist.
- **FR-6:** for sub-agents from CC < 2.1.307, cost = `max(transcript cost, SUM(otel_calls.cost_usd_micros WHERE agent_id = subagent))`. This is done server-side in `session-tree-cost.sql.ts`, and the tooltip shows a "from OTEL" hint.
- **FR-7:** `OTEL_PROJECTION_VERSION` goes from 1 to 2, so the existing startup requeue backfills history.
- **Constraints:** everything is additive and nullable, no hook change, and the perf cost of the facts routes may not grow by more than 20%.

## Wireframes
- **`wireframes/otel-stack-by-attribution.svg`** (repository tab):
  - "Stack by" segmented control gains Skill / MCP server / Effort / Fast mode, next to Structure / query_source / Model / CC version.
  - A grey "not reported ⓘ" series with the tooltip: "Calls without this attribute. It is sent only by newer Claude Code; skill / MCP names also need OTEL_LOG_TOOL_DETAILS=1".
  - The session tab gets the same options except CC version. The team tab gets the same control.
  - Fast-mode buckets are "fast" / "standard" / not reported.
- **`wireframes/session-otel-plan-notional.svg`** (session tab):
  - An "Account" row under the status line ("Cost: Claude Code estimate (cost_usd) · hook … · traces …") with plan / seat / provider / base URL chips. Null chips are left out, and the row is hidden when all four are null.
  - An info note "Claude Code reports plan X … What is this?".
  - The "OTEL cost" tile carries a `plan: max` chip whose tooltip repeats the note. Amounts are unchanged, with no "≈".
  - Repository/team Total OTEL cost tile adds: "Mix of plans: max · 12 sessions · $96.40 — pro · 3 · $10.20 — not reported · 40 · $172.35", plus "On subscription plans cost_usd is list-price equivalent, not billed".

## Knowledgebase
- `docs/knowledgebase/otel-tabs.md`:
  - The two channels both go through `applyOtelLines` (`otel-facts-writer.ts`).
  - Lock order is state row `FOR UPDATE`, then the deleted check.
  - Seq/`change_kind` rules (DD-3).
  - Bucket grain (DD-7, l.154): a call upsert subtracts the old contribution and adds the new one; a rebuild zeroes stale keys and never deletes them.
  - Projection drain and version (l.213–231).
  - The compatibility matrix (l.342–363) and the routes table must be extended.
  - Masking DD-22: `attributesMasked`, `maskFirstPrompt`.
- `docs/knowledgebase/algorithms/otel-facts.md`:
  - Rule 8 (Calls) is where FR-1/2/4 extraction gets documented.
  - Rows `docs/algorithm-examples/otel-facts.json` (OF-01..OF-49; new rows start at OF-50). The test `otel-facts.algo.spec.ts` dispatches on `input.kind`.
  - `calls` rows use `toMatchObject`, so AC-9 rows must list each new field explicitly as `null`.
  - Base-URL sanitising and anthropic extraction need a new `kind` in the spec switch.
- `docs/knowledgebase/algorithms/otel-cost-selection.md`:
  - Rule 1 says "OTEL never stands in". FR-6 adds a documented exception here.
  - Rows `docs/algorithm-examples/otel-cost-selection.json` (34 rows, kinds `total|unpriced|discrepancy|mismatch`, prefixes CT/UM/OC/CM).
  - New kind needed, e.g. a per-sub-agent selection function in `otel-cost.sql.ts`. Spec: `server/src/logs/otel-cost.sql.algo.spec.ts`.
- `docs/knowledgebase/db-schema-code.md`:
  - Migrations are hand-written SQL: `NNNN_<desc>.sql`, an entry in `meta/_journal.json`, then `npm run migrations:lock`.
  - Never run `drizzle-kit generate`, and never use `CONCURRENTLY` (each file runs inside BEGIN/COMMIT).
  - Add `COMMENT ON COLUMN`, then run `npm run db:state` (root, `scripts/db-state.mjs`) to regenerate `db_state.sql`.
  - Also edit the schema in `server/src/database/schema/index.ts`: `otelCostBuckets` at l.569 with `name: 'otel_cost_buckets_pk'` at l.604, `otel_session_state` at l.622, `otel_calls` around l.470–490.
  - The `db-state-update` and `migrations-data-integrity` skills apply.
- `docs/knowledgebase/db-tables.md` §"OTEL tab tables" (l.192) and §session_stats (l.223): `claude_version` vs `claude_version_otel`, plus the rule that each column has an exclusive writer.
- `docs/knowledgebase/server-endpoint-map.md`: read it before changing the routes.
- `user-docs/otel-tab.md` (Repository l.12, Session l.45, Team l.76, "What Log Hub collects" l.136) gets the new groupings and the plan explanation.
- `docs/knowledgebase/llm-call-math.md` covers sub-agent aggregation and `costBreakdown`.

## Existing patterns
**Extraction**
- `server/src/logs/otel/otel-records.ts:136-150`: the `ExtractedOtelCall` interface.
- `otel-records.ts:165-200`: `extractOtelCalls`. Add the fields here (`stringAttrOf` / `tokenCountOf` from `../otel-chunk`).
- `otel-records.ts:153`: `serviceVersionOf(resource)` shows how to read a resource attribute (needed for the `anthropic.*` record-then-resource fallback).
- `server/src/logs/otel-chunk.ts:29` `attributesOf`, `:75` `tokenCountOf`, `:89` `stringAttrOf`:
  - `tokenCountOf` returns 0 when the attribute is missing, so FR-1's NULL needs a new nullable variant.
  - `stringAttrOf` caps at 255 (`CALL_TEXT_MAX`). The 64-wide `effort` / `speed` / `plan` columns need their own cap, like `CC_VERSION_MAX = 64` at l.25.
- `otel-records.ts:257` `flatStringOf(attrs, key, max)`: a cap-to-width helper for spans.

**Writer** (`server/src/logs/otel/otel-facts-writer.ts`)
- `:315` `OldCallRow`; `:336` `CallContribution`; `:349` `BucketDelta`.
- `:364` `bucketKey` and `:374` `addContribution`.
- `:419` `contributionOfOld` and `:434` `contributionOfNew`: the `?? ''` convention.
- `:453` `callDataChanged`.
- `:485-536` `applyBucketDeltas`: `jsonb_to_recordset` column list, `ON CONFLICT ON CONSTRAINT otel_cost_buckets_pk`.
- `:589` the old-row SELECT and `:666-702` the calls upsert (column list and SET list).
- `:1005-1083` `rebuildOtelBuckets`: GROUP BY 1..5 and the FULL JOIN on every grain column. All of them need the 4 new columns.
- `:939-993` `applyOtelLines`: the state UPDATE at l.976 is where the FR-4 plan columns go.
- `:96-137` `StateDbRow` / `toState` and `:161` `selectStateForUpdate`: the state row shape.

**Projection version**
- `server/src/logs/otel/otel-facts.constants.ts:35`: `OTEL_PROJECTION_VERSION = 1`.
- `server/src/database/database-init.ts:164-175`: step 3c requeue (`< $1` → NULL; failed `-1` rows are requeued too).

**Read side**
- `otel-facts.types.ts:83-94`: the `RepoOtelStackBy` / `SessionOtelStackBy` / `TeamOtelStackBy` literals.
- `otel-facts.types.ts:258` `RepoOtelFactsResponse`, `:359` `SessionOtelResponse`, `:411` `TeamOtelFactsResponse`: add the optional `planMix` / `plan`.
- `otel-facts.controller.ts:38,44` `REPO_STACK_BY`, `SESSION_STACK_BY`; `:98` `enumParam` (400 on an unknown value); `:166,182` the defaults.
- `otel-team-facts.controller.ts:28` `TEAM_STACK_BY`.
- `otel-facts-read.sql.ts:125-142` `OtelStackColumn` / `stackKeySql`: add the cases.
- `otel-facts-read.sql.ts:187-222` `repoBucketSource` / `sessionBucketSource`: the explicit `fb` column lists must include the new columns.
- `otel-facts-read.sql.ts:362-410` `loadKpiSums`: its `per_session` CTE is the template for the planMix SQL (join `otel_session_state.plan` on `fb.session_id`).
- `otel-facts-read.sql.ts:1022` `readOtelStateRow`: add the plan columns.
- `otel-facts-read.sql.ts:1338` `teamStackKeySql`.
- `otel-facts.reader.ts:535-649` `getRepoOtelFacts` (`Promise.all` fan-out), `:661-808` `getTeamOtelFacts`, `:815-949` `getSessionOtel`:
  - `attributesMasked` is set at l.823 and the empty-delta fast path is at l.862.
  - Returning `plan` from the state read on every response, deltas included, satisfies "included in `since=` deltas" without seq-tracking per row.

**FR-6 (sub-agent cost)**
- `server/src/logs/session-tree-cost.sql.ts:39-81` `treeCostCtes`: `tree_subagent_costs` sums `session_costs.cost` per `ds.root_id`. Per-sub-agent substitution must happen before the SUM.
- `session-tree-cost.sql.ts:135` `readTreeCost`.
- `server/src/logs/otel-cost.sql.ts:48` `SessionCostParts`, `:71` `resolveSessionTotalCost`, `:183` `CostBreakdown` (add an optional OTEL-source flag).
- `server/src/logs/repositories.controller.ts:705`: builds `costBreakdown.subagentCost`.
- `server/src/logs/artisyn-extractor.ts:756-773`: sub-agent `sessions.session_id` is `<agentId>` for a Task sub-agent and `agent-<agentId>` for a workflow agent. The match must accept both spellings.

**Version comparison**
- `server/src/common/semver.ts`: `compareVersions`, `parseVersion`, `maxVersion`.

**Client**
- `client/src/models/repositories.ts:1036-1041` and `client/src/models/teams.ts:~100-107`: mirror types.
- `client/src/viewer/pages/repository/otel/OtelChartControls.tsx:85` `OTEL_REPO_STACK_OPTIONS`.
- `client/src/viewer/pages/repository/otel/otel-url-state.ts:94` `STACK_BY_VALUES`.
- `client/src/viewer/pages/repository/session-log/otel/SessionOtelTab.tsx:61` `STACK_OPTIONS`; the status line is at l.228.
- `client/src/viewer/pages/teams/otel/TeamOtelTab.tsx:113` `TEAM_STACK_OPTIONS`.
- `client/src/viewer/pages/repository/otel/otel-chart-data.ts:54` `otelSeriesLabel`: today `''` renders as "(unknown)". The new groupings need "not reported" plus the tooltip.
- `client/src/viewer/pages/repository/otel/OtelKpiTiles.tsx:87` "Total OTEL cost", `:237` session "OTEL cost". `OtelKpiTile.tsx:66` props have `secondary` but no chip slot.
- `client/src/viewer/pages/repository/otel/otel-merge.ts:164` `mergeOtelDelta`: it rebuilds the state field by field, so a new `plan` field must be carried explicitly.
- `client/src/viewer/components/CostBreakdownTooltip.tsx:22` `subAgentCost` prop: where the "from OTEL" hint goes.

**Migrations**
- `server/drizzle/migrations/0078_*.sql`: header comment style (purpose, additive, lock profile) and the `otel_cost_buckets` DDL/PK at l.100-118.
- `meta/_journal.json`: the last entry is idx 86, `0086_log_hub_release_check`.

**Tests**
- Contract `server/test/contract/registry/f25-otel.ts`:
  - `bucketsOf()` at l.68, `kpiSql()` at l.75.
  - Row `F25-repo-buckets` (l.742) is the template for the `stackBy` rows.
  - Session rows are around l.1159–1262, team rows l.1265–1475.
  - `F25-team-bad-stack-by` is at l.1465.
- World fixture `server/test/contract/fixtures/world-v1.sql.ts:2757` `otelStatements()`: state l.2762, calls l.2866, buckets l.3070. The plan/attribute seed data goes here.
- Scenario `tests/scenarios/view/s-otel-01.spec.ts`:
  - The step at l.303 ("every control redraws: stack-by…") is the UI step to extend.
  - The step at l.423 (AC-12/13) already uses `resetOtelProjection` + `waitForOtelProjected` (`tests/scenarios/helpers/otel.ts:122`, `:99`). Reuse it for AC-7.
  - The session tab step is at l.354 and the team tab test at l.958.
- `tests/scenarios/fixtures/otel/otel-lines.ts:79-122`: `OtelCallSpec` / `apiRequestLine`. Add optional attribute and resource fields; the resource is fixed at l.74.
- `tests/scenarios/hook/s-compat-01.spec.ts:435`: step 12 (frozen 2.28.0 OTEL) is where AC-8 is added.
- Perf `server/perf-tests/scenarios.ts`: `otel:repo-facts-week` l.169, `otel:session-snapshot` l.476.
- Installer: `artisyn-hooks-installer/src/otel-env.ts:31` already writes `OTEL_LOG_TOOL_DETAILS: '1'`, so no hook change is needed.

## Open gaps
1. **Migration number clash.** The working tree has an untracked `0086_log_hub_release_check.sql` from the current branch. If this task branches from `main`, 0086 may collide, so the plan must fix the number (0087 after the other branch merges).
2. **Primary-key rebuild cost.** Recreating `otel_cost_buckets_pk` (DROP + ADD PRIMARY KEY) takes an ACCESS EXCLUSIVE lock and rebuilds the index inside the migration transaction. There is no prior pattern for a PK change. The `ADD COLUMN … NOT NULL DEFAULT ''` steps are metadata-only (PG11+). Also, the Drizzle schema's `primaryKey` columns must be updated.
3. **No nullable token reader.** `tokenCountOf` maps a missing attribute to 0. FR-1 needs a new helper that returns NULL instead.
4. **No SQL semver comparison exists.** FR-6 must compare `claude_version` / `claude_version_otel` with 2.1.307 in SQL inside `treeCostCtes`, or in TS (but `readTreeCost` only sees aggregated rows). The choice needs a design.
5. **Sub-agent ↔ OTEL matching is unverified.** The format of OTEL `agent_id` relative to `sessions.session_id` (bare id vs the `agent-` prefix) is not confirmed. It must be checked on real data (AC-6 Notes). There is also no `(session_id, agent_id)` index on `otel_calls`, which matters for the perf NFR.
6. **"FR-6 applies everywhere" is not true as written.** `SubAgentDetail.tsx` (l.38, 117) and the Session Map side panel compute each sub-agent's cost on the client with `computeCost(agent.tokens, …)`; they never call `readTreeCost`. Doing the swap only in `readTreeCost` will not reach the per-sub-agent displays. They need a new per-sub-agent field, or the requirement needs narrowing.
7. **Not-reported label and tooltip.** There is no existing label or tooltip pattern for a "not reported" stack key: today `''` renders as "(unknown)" for every grouping. The plan must decide whether to scope the new label to the new groupings only. `OtelKpiTile` has no chip slot either.
8. **Masking for team-no-prompts.** No masking helper exists for bucket keys or plan values; the requirement says to leave them unmasked, so only a contract row is needed.
9. **Base-URL sanitiser.** There is no existing URL sanitiser to reuse; write one as a pure function with algorithm rows.
10. **Latest-plan tracking.** "Latest event wins" for the plan needs a new state column, e.g. `plan_event_at timestamptz`. There is no existing per-field latest-wins pattern on `otel_session_state`. The closest is `upsertSessionOtelStatus` (newest event timestamp wins) in `session-stats-writer.ts`.
11. **Perf baseline.** The `otel:session-snapshot` and empty-delta cases were never measured (per `otel-tabs.md`). They need a seeded run first to get a baseline for the 20% check.
12. **No help anchor yet.** `user-docs/otel-tab.md` has no section for plan/notional cost, so the "What is this?" link needs a new anchor.
13. **No open-questions file.** The task folder has no `open_questions_ru.md`, so there are no pending answers to merge.
