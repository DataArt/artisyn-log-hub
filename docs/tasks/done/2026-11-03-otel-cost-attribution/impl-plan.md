# Implementation plan — 2026-11-03 OTEL cost attribution (GH-89)

## TL;DR

- **One migration** (next free number, `0087_otel_cost_attribution.sql` if `0086_log_hub_release_check` is merged first). It adds 9 nullable columns to `otel_calls`, 4 grain columns (`NOT NULL DEFAULT ''`) to `otel_cost_buckets` and recreates `otel_cost_buckets_pk` with them, adds 5 nullable columns to `otel_session_state`, and creates the new index `idx_otel_calls_session_agent`.
- **Extraction** (`otel-records.ts`, `otel-chunk.ts`): new pure functions `nullableTokenCountOf`, `cappedStringAttrOf`, `extractOtelAccount`, `sanitizeOtelBaseUrl`. `ExtractedOtelCall` gets 9 fields.
- **Writer:** the call upsert, bucket grain and rebuild carry 4 new dimensions. `applyOtelLines` writes the account fields with a latest-wins rule (DD-5). `OTEL_PROJECTION_VERSION` goes 1 → 2, which re-projects all history at startup.
- **API (additive only):**
  - `stackBy` gains `skill | mcpServer | effort | speed` on the repository, session and team OTEL routes.
  - New `planMix?: OtelPlanMixRow[]` on the repository and team facts responses.
  - New `plan?: OtelSessionPlan | null` on the session OTEL response.
  - New `costBreakdown.subagentCostFromOtel?` on the session list and header.
  - New `subagentStats[*].otelCostUsd?` on `/logs` and `/logs/delta`.
- **FR-6 (high blast radius):** `treeCostCtes` (`session-tree-cost.sql.ts`) replaces the cost of an old-CC (< 2.1.307) sub-agent with `GREATEST(transcript, OTEL)` in SQL. This changes historical totals on every cost surface: sessions list and header, analytics timeline and active sessions, executive summary, attribution breakdown, turn-end cost advisor and the delete-time audit row. It adds a documented exception to rule 1 of `otel-cost-selection.md`.
- **Client:**
  - 4 new stack-by options with a "not reported" series and its tooltip.
  - New `SessionOtelAccount.tsx`: the session "Account" row and plan note. A new `chip` prop on `OtelKpiTile` carries the `plan:` chip.
  - New `OtelPlanMix.tsx`: the plan-mix text on the repository and team Total tile.
  - Sub-agent cost from OTEL, with a "from OTEL" hint, in `SubAgentDetail`, `WorkflowAgentsTable`, `AgentActivationItem` and `CostBreakdownTooltip`.
- **New constants:**
  - Server: `OTEL_SUBAGENT_COST_FIX_VERSION = '2.1.307'`, and `selectSubagentCost`, the TypeScript twin of the FR-6 SQL rule with the new algorithm kind `subagent`.
  - Client: `OTEL_NOT_REPORTED_HINT`, `OTEL_PLAN_NOTE`, `OTEL_PLAN_EXPLANATION` and `OTEL_HELP_ANCHORS.plan`.
  - User help: the new section "Plan and notional cost".
- **No hook change, no new npm packages.**

## Reference

Requirements: [requirements.md](requirements.md) (GH-89). Research archive: `research/findings-1.md`.

## Design Decisions

1. **Migration number.** Use the next free number at implementation time. Today `0086_log_hub_release_check` is still on an unmerged branch, so the expected name is `0087_otel_cost_attribution.sql`. Re-check `server/drizzle/migrations/meta/_journal.json` before writing the file.
2. **Primary-key recreate.** `ALTER TABLE otel_cost_buckets DROP CONSTRAINT otel_cost_buckets_pk, ADD CONSTRAINT otel_cost_buckets_pk PRIMARY KEY (session_id, bucket_start, structure, query_source, model, cc_version, skill, mcp_server, effort, speed)` runs in one statement inside the migration transaction. It takes an ACCESS EXCLUSIVE lock and rebuilds the index once. That is acceptable because the table is a per-hour projection.
3. **Column contract.** `otel_calls` gets these columns, all nullable:
   - `cache_write_5m_tokens bigint` and `cache_write_1h_tokens bigint`
   - `effort varchar(64)` and `speed varchar(64)`
   - `skill_name`, `plugin_name`, `agent_name`, `mcp_server_name` and `mcp_tool_name`, each `varchar(255)`

   `otel_cost_buckets` gets `skill varchar(255)`, `mcp_server varchar(255)`, `effort varchar(64)` and `speed varchar(64)`, all `NOT NULL DEFAULT ''`.

   `otel_session_state` gets `plan`, `seat_type` and `provider` as `varchar(64)`, `custom_base_url varchar(1024)` and `account_event_at timestamptz`, all nullable.
4. **Attribute mapping** (OTEL key → `ExtractedOtelCall` field → column):

   | OTEL key | Field | Column |
   |---|---|---|
   | `cache_creation_5m_tokens` | `cacheWrite5mTokens` | `cache_write_5m_tokens` |
   | `cache_creation_1h_tokens` | `cacheWrite1hTokens` | `cache_write_1h_tokens` |
   | `effort` | `effort` | `effort` |
   | `speed` | `speed` | `speed` |
   | `skill.name` | `skillName` | `skill_name` |
   | `plugin.name` | `pluginName` | `plugin_name` |
   | `agent.name` | `agentName` | `agent_name` |
   | `mcp_server.name` | `mcpServerName` | `mcp_server_name` |
   | `mcp_tool.name` | `mcpToolName` | `mcp_tool_name` |

   - Token fields use `nullableTokenCountOf`: missing or non-numeric → `null`, otherwise rounded.
   - Text fields use `cappedStringAttrOf(attrs, key, max)`: empty or non-string → `null`, otherwise sliced to the column width (64 or 255).
5. **Account latest-wins.**
   - `extractOtelAccount(lines)` is exported from `otel-records.ts` together with its type `ExtractedOtelAccount = { plan: string | null; seatType: string | null; provider: string | null; customBaseUrl: string | null; eventAt: Date }`. It returns that type, or `null` when no record carries any of the four keys. It reads `anthropic.plan`, `anthropic.seat_type`, `anthropic.provider` and `anthropic.custom_base_url` from `logs` `claude_code.api_request` records and `traces` spans: record or span attributes first, then `entry.resource`.
   - Event time comes from `resolveOtelEventTime(line): Date | null` (`otel-records.ts:88`); lines without one are skipped. The resource fallback reads `entry.resource[key]`, the same way `serviceVersionOf` (`otel-records.ts:153`) does.
   - Inside one batch, each field takes the non-null value of the record with the greatest event time. On a tie, the later line in the batch's line order wins, whether it is a `logs` or a `traces` line. `eventAt` is the greatest event time among records that carried any field.
   - In SQL, a new non-null field value overwrites the stored one when `stored IS NULL OR $eventAt >= account_event_at`. Then `account_event_at = GREATEST(account_event_at, $eventAt)`.
   - Null never overwrites.
   - When any of the four stored values changed, the batch counts as changed, which bumps `seq`.
   - Text widths: 64 for plan, seat and provider; 1024 for the base URL after sanitising.
6. **`sanitizeOtelBaseUrl(raw)`.**
   - Parse it with `new URL`. Unparsable or empty → `null`.
   - Otherwise return `${protocol}//${host}${pathname}` (host includes the port), dropping a lone trailing `/` path. Userinfo, query and fragment are removed.
   - Cut the result to 1024.
7. **Bucket grain.**
   - `CallContribution` gains `skill`, `mcpServer`, `effort` and `speed`, each taken from `skill_name`, `mcp_server_name`, `effort` and `speed` with `?? ''`.
   - `bucketKey` joins all 9 grain parts.
   - A call whose new fields changed moves its contribution: the old key is subtracted and the new one added.
   - `rebuildOtelBuckets` groups by and FULL JOINs on all 9 grain columns.
8. **Stack-key SQL.** `stackKeySql` and `teamStackKeySql` map `skill → fb.skill`, `mcpServer → fb.mcp_server`, `effort → fb.effort` and `speed → fb.speed`. `''` stays the "not reported" key. Defaults are unchanged.
9. **Plan mix.**
   - Type: `OtelPlanMixRow = { plan: string | null; sessions: number; costUsdMicros: string }`.
   - It is computed with the same filters and bucket source as the Total KPI (the `per_session` CTE pattern of `loadKpiSums`, `otel-facts-read.sql.ts:362`). Each row is `LEFT JOIN otel_session_state st ON st.session_id = per_session.session_id`, grouped by `NULLIF(st.plan,'')`, ordered by cost descending with NULL last.
   - Signature: `loadPlanMix(db: DrizzleDb, source: SQL): Promise<OtelPlanMixRow[]>`. `source` is the same `fb` CTE SQL that `loadKpiSums(db, source, tz)` (`otel-facts-read.sql.ts:362`) gets from `repoBucketSource(...)` or the team source, so the filters are identical by construction.
   - The route always returns it when it returns KPIs. The client shows the text only when some row has `plan !== null`.
   - It is never masked.
10. **Session plan response.**
    - Type: `OtelSessionPlan = { plan: string | null; seatType: string | null; provider: string | null; customBaseUrl: string | null }`.
    - `SessionOtelResponse.plan` is `null` when all four columns are null. It is read from `readOtelStateRow` on every response, deltas included.
    - `customBaseUrl` is forced to `null` when `attributesMasked`. That is the only new masked value.
    - The `skill`, `mcpServer`, `effort` and `speed` bucket keys and the `planMix` plan values are aggregates and stay unmasked on every route, `team-no-prompts` included. `stackKeySql` gets no mask branch.
11. **FR-6 SQL** (in `otel-cost.sql.ts`):
    - New exported constant `OTEL_SUBAGENT_COST_FIX_VERSION = '2.1.307'`.
    - New helper `ccVersionBeforeSql(versionExpr: SQL, version: string): SQL`. It compares `(regexp_match(v,'^(\d+)\.(\d+)\.(\d+)'))::int[] < ARRAY[a,b,c]` and yields NULL when unparsable.
    - New helper `subagentOtelCostSql({ claudeVersion, claudeVersionOtel, subSessionId, rootRowId }: Record<string, SQL>): SQL`. The first two are the sub-agent's `session_stats` version columns, `subSessionId` its `sessions.session_id` and `rootRowId` the root's `sessions.id`. It yields the float USD expression `CASE WHEN ${ccVersionBeforeSql(COALESCE(NULLIF(claudeVersion,''), claudeVersionOtel), OTEL_SUBAGENT_COST_FIX_VERSION)} THEN (SELECT SUM(oc.cost_usd_micros)::float / 1e6 FROM otel_calls oc WHERE oc.session_id = rootRowId AND oc.agent_id = regexp_replace(subSessionId,'^agent-','')) END`. It is NULL when the gate fails, the version is unknown, or there are no calls.
12. **FR-6 selection rule.** It is applied in SQL and pinned by a TypeScript twin, `selectSubagentCost({ transcriptCost, modelId, otelCostUsd })`, that has algorithm rows:
    - `cost = otel != null ? GREATEST(COALESCE(transcript,0), otel) : transcript`
    - `pricingMissing = otel == null && transcript == null && modelId != null`
    - `fromOtel = otel != null && otel > COALESCE(transcript,0)`
13. **FR-6 tree CTE.**
    - A new CTE `tree_subagent_rows(root_id, stats_session_id, cost, model_id, otel_cost)` keeps today's FROM, JOIN and WHERE (descendants with `depth > 0` that have a transcript, `LEFT JOIN session_stats sub_ss`, `LEFT JOIN session_costs sub_sc`). Its columns are `sub_ss.session_id`, `sub_sc.cost`, `sub_sc.model_id` and `subagentOtelCostSql({ claudeVersion: sub_ss.claude_version, claudeVersionOtel: sub_ss.claude_version_otel, subSessionId: ds.session_id, rootRowId: ds.root_id })`.
    - `tree_subagent_costs` then aggregates `tree_subagent_rows` per `root_id`. Its output column names and meanings stay the same:
      - `subagent_cost = COALESCE(SUM(CASE WHEN otel_cost IS NOT NULL THEN GREATEST(COALESCE(cost,0), otel_cost) ELSE cost END), 0)`
      - `subagent_count = COUNT(stats_session_id)`
      - `subagent_pricing_missing = COALESCE(BOOL_OR(otel_cost IS NULL AND cost IS NULL AND model_id IS NOT NULL), false)`
      - `subagent_unpriced_models` is the same `ARRAY_AGG(DISTINCT model_id::text)` with `FILTER (WHERE otel_cost IS NULL AND cost IS NULL AND model_id IS NOT NULL)`
      - the new column `subagent_cost_from_otel = COALESCE(BOOL_OR(otel_cost IS NOT NULL AND otel_cost > COALESCE(cost,0)), false)`
    - `TREE_COST_COLUMNS_SQL`, `TreeCostSqlRow`, `SessionTreeCost.subagentCostFromOtel` and `CostBreakdown.subagentCostFromOtel?: boolean` carry it.
    - The discrepancy and mismatch checks keep comparing full totals and are unchanged.
14. **FR-6 per sub-agent on the client.**
    - `selectSubagentStats(db, sessionRowIds, rootRowId: number)` gains a third parameter. Both callers know the root: `repositories.controller.ts:1825` and `session-logs-delta.service.ts:266`.
    - It selects `otelCostUsd: sql<number | null>` as `CASE WHEN o > COALESCE((SELECT sc.cost FROM session_costs sc WHERE sc.session_id = sessions.id), 0) THEN o END`, where `o` = `subagentOtelCostSql({ claudeVersion: session_stats.claude_version, claudeVersionOtel: session_stats.claude_version_otel, subSessionId: sessions.session_id, rootRowId })`. So the value is non-null exactly when `fromOtel` (DD-12) holds.
    - `/logs` and `/logs/delta` emit it in `subagentStats`.
    - The client looks the entry up with the key it already uses for sub-agent stats, `subagentStats['agent-' + agentId]` (`log-parser.ts:975`, `session-map-model.ts:707`). That is the `sessions.session_id` both Task and workflow sub-agents have, as verified in Design Decision 15. If it is missing, the client falls back to `subagentStats[agentId]`.
    - The client shows `otelCostUsd` instead of `computeCost(tokens)` when it is non-null, with the "from OTEL" hint.
    - The client has no copy of the rule.
15. **Matching key.** Verified on the dev DB (2026-11-04): `otel_calls.agent_id = 'a81ff8c6b7e3fb291'` matches the sub-agent `sessions.session_id = 'agent-a81ff8c6b7e3fb291'` of the same root. `otel_calls.session_id` is the root's `sessions.id`. Stripping `^agent-` also matches a bare `<agentId>` session id unchanged.
16. **Index.** `CREATE INDEX IF NOT EXISTS idx_otel_calls_session_agent ON otel_calls (session_id, agent_id) WHERE agent_id IS NOT NULL`, with no `CONCURRENTLY`. It keeps the FR-6 correlated sum within the perf NFR. Lock profile for the migration header: a SHARE lock on `otel_calls` while the partial index builds, so writes wait and reads continue. This is a one-off at upgrade and is bounded by the number of rows with `agent_id` set.
17. **"Not reported" label.**
    - `otelSeriesLabel(stackBy, '')` returns `'not reported'` for `skill | mcpServer | effort | speed` and keeps `'(unknown)'` for the existing groupings.
    - The legend item of that series gets an ⓘ with a tooltip, stored as `OTEL_NOT_REPORTED_HINT`: "Calls without this attribute: not sent by this Claude Code version or left at the default value; skill / MCP names also need OTEL_LOG_TOOL_DETAILS=1."
    - Series values are shown verbatim.
    - The team tab keeps `''` as `''` in `otelTeamDisplayKey` (`team-otel-display.ts:31`). The team chart must still pass display keys through `otelSeriesLabel` and the grey pin. If it doesn't, apply both there.
18. **Plan explanation text.**
    - `OTEL_PLAN_NOTE(plan)` and `OTEL_PLAN_EXPLANATION` live in `client/src/viewer/pages/repository/otel/otel.constants.ts`.
    - Note: "Claude Code reports plan {plan}. On a subscription plan, OTEL cost_usd is a list-price equivalent, not billed money."
    - Explanation line, for the plan mix: "On subscription plans cost_usd is list-price equivalent, not billed."
    - The "What is this?" link is the existing `OtelHelpLink` (`otel/OtelHelpLink.tsx`) with a new key `plan: 'plan-and-notional-cost'` in `OTEL_HELP_ANCHORS` (`otel.constants.ts:40`). The anchor is the slug of the plain heading `## Plan and notional cost` in `user-docs/otel-tab.md`; no `{#id}` syntax.
    - Amounts keep their format.
19. **Backfill.** Bumping `OTEL_PROJECTION_VERSION` to 2 is enough: `database-init.ts:164-175` requeues chunks below v2 and the normal drain re-projects them. No extra startup wait.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `server/drizzle/migrations/00NN_otel_cost_attribution.sql` | DDL | DD-1, 2, 3, 16; header style of `0078_otel_tabs_traces.sql`; `COMMENT ON COLUMN` for every new column |
| `server/drizzle/migrations/meta/_journal.json`, `migrations.lock.json` | register | `npm run migrations:lock` (server) |
| `server/src/database/schema/index.ts` | Drizzle schema | `otelCalls` l.478, `otelCostBuckets` l.569 (PK columns l.603), `otelSessionState` l.621 |
| `docs/knowledgebase/db_state.sql` | regenerated | `db-state-update` skill / `npm run db:state` |
| `server/src/logs/otel-chunk.ts` | helpers | `nullableTokenCountOf`, `cappedStringAttrOf` next to `tokenCountOf` l.75 |
| `server/src/logs/otel/otel-records.ts` | extraction | `ExtractedOtelCall` l.136, `extractOtelCalls` l.165, new `extractOtelAccount`, `sanitizeOtelBaseUrl` |
| `server/src/logs/otel/otel-facts-writer.ts` | writer | `StateDbRow`/`toState` l.96–137, `selectStateForUpdate` l.161, `OldCallRow` l.315, `CallContribution` l.336, `bucketKey` l.364, contributions l.419/434, `callDataChanged` l.453, `applyBucketDeltas` l.485, old-row SELECT l.589, upsert l.666, `applyOtelLines` l.939, `rebuildOtelBuckets` l.1005 |
| `server/src/logs/otel/otel-facts.constants.ts` | version | l.35 → `2` |
| `server/src/logs/otel/otel-facts.types.ts` | API types | stack-by literals l.83–94; `OtelPlanMixRow`, `OtelSessionPlan`; responses l.258/359/411 |
| `server/src/logs/otel/otel-facts.controller.ts`, `otel-team-facts.controller.ts` | enums | `REPO_STACK_BY` l.38, `SESSION_STACK_BY` l.44, `TEAM_STACK_BY` l.28 |
| `server/src/logs/otel/otel-facts-read.sql.ts` | read SQL | `OtelStackColumn`/`stackKeySql` l.125, bucket sources l.187–222, new `loadPlanMix`, `readOtelStateRow` l.1022, `teamStackKeySql` l.1338 |
| `server/src/logs/otel/otel-facts.reader.ts` | wiring | `getRepoOtelFacts` l.535, `getTeamOtelFacts` l.661, `getSessionOtel` l.815 |
| `server/src/logs/otel-cost.sql.ts` | FR-6 helpers | DD-11, DD-12; `CostBreakdown` l.183 |
| `server/src/logs/otel-cost.sql.algo.spec.ts` | algo spec | new `kind: 'subagent'` |
| `server/src/logs/session-tree-cost.sql.ts` | FR-6 CTE | DD-13 |
| `server/src/logs/repositories.controller.ts` | breakdown + `/logs` | `costBreakdown` l.705, `subagentStatsJson` l.2008 |
| `server/src/logs/session-logs-delta.service.ts` | `selectSubagentStats` | l.37 and its caller l.266, DD-14 |
| `server/src/sessions/sessions.service.ts`, `server/src/logs/analytics/active-sessions.service.ts`, `server/src/logs/reports/executive-summary.service.ts`, `server/src/logs/reports/attribution-breakdown.service.ts`, `server/src/logs/turn-end-cost-advisor/turn-end-cost-advisor.service.ts` | `treeCostCtes` consumers | check only: they compile and any typed row / explicit column list takes `subagent_cost_from_otel` |
| `server/src/logs/otel/otel-facts.algo.spec.ts` | algo spec | new kinds `account`, `baseUrl` |
| `client/src/models/repositories.ts`, `client/src/models/teams.ts` | mirror types | stack-by literals, `planMix`, `plan`, `costBreakdown.subagentCostFromOtel` |
| `client/src/viewer/api.ts` | mirror | `SubagentStats.otelCostUsd?` l.1398 |
| `client/src/viewer/pages/repository/otel/OtelChartControls.tsx`, `otel-url-state.ts` | options | l.85, l.94 |
| `client/src/viewer/pages/repository/otel/otel-chart-data.ts`, `OtelCostChart.tsx` | not-reported | DD-17; legend l.228 |
| `client/src/viewer/pages/repository/otel/OtelKpiTile.tsx`, `OtelKpiTiles.tsx` | chip, plan mix | new `chip?: ReactNode` prop; Total tile l.87, session tile l.237 |
| `client/src/viewer/pages/repository/otel/otel-merge.ts` | delta merge | carry `plan` (l.164) |
| `docs/algorithm-examples/otel-delta-merge.json`, `docs/knowledgebase/algorithms/otel-delta-merge.md` | algo rows/doc | `plan` replaced by the delta's value; absent on an old server keeps the previous value |
| `client/src/viewer/pages/repository/otel/otel.constants.ts` | constants | `OTEL_HELP_ANCHORS.plan`, `OTEL_PLAN_NOTE`, `OTEL_PLAN_EXPLANATION` (DD-18) |
| `client/src/viewer/pages/repository/otel/OtelHelpLink.tsx` | reused | "What is this?" link, no change expected |
| `client/src/viewer/pages/teams/otel/team-otel-display.ts` | team labels | only if DD-17's team check fails |
| `client/src/viewer/pages/repository/session-log/summary/SummaryExecutiveBand.tsx` | "from OTEL" hint | passes `subAgentCostFromOtel` (l.162) |
| `client/src/viewer/pages/repository/otel/OtelPlanMix.tsx` (new) | plan-mix text | shared by repository and team Total tiles |
| `client/src/viewer/pages/repository/session-log/otel/SessionOtelTab.tsx` | Account row, note | `STACK_OPTIONS` l.61, status line l.228 |
| `client/src/viewer/pages/repository/session-log/otel/SessionOtelAccount.tsx` (new) | Account row + note | wireframe 2 |
| `client/src/viewer/pages/teams/otel/TeamOtelTab.tsx` | options, plan mix | l.113 |
| `client/src/viewer/pages/repository/session-log/types.ts` | `SubAgentNode.otelCostUsd?` | l.262 |
| `client/src/viewer/pages/repository/session-log/log-parser.ts`, `session-map/session-map-model.ts` | populate `otelCostUsd` | from `subagentStats['agent-'+id]` (l.975, l.1264; l.707) |
| `client/src/viewer/pages/repository/session-log/SubAgentDetail.tsx`, `WorkflowAgentsTable.tsx`, `AgentActivationItem.tsx` | show OTEL cost | DD-14 |
| `client/src/viewer/components/CostBreakdownTooltip.tsx`, `SessionDetailHeader.tsx` | "from OTEL" hint | `subAgentCostFromOtel?` prop |
| `docs/algorithm-examples/otel-facts.json`, `docs/knowledgebase/algorithms/otel-facts.md` | algo rows/doc | OF-50+ |
| `docs/algorithm-examples/otel-cost-selection.json`, `docs/knowledgebase/algorithms/otel-cost-selection.md` | algo rows/doc | new kind `subagent`, rule 1 exception |
| `server/test/contract/fixtures/world-v1.sql.ts` | seed | `otelStatements()` l.2757 |
| `server/test/contract/registry/f25-otel.ts`, `f17-sessions.ts`, `f20-analytics.ts`, `f21-reports.ts` | contract rows | see Test coverage plan |
| `tests/scenarios/fixtures/otel/otel-lines.ts` | fixture builder | optional attributes + resource attrs on `OtelCallSpec` (l.79–122) |
| `tests/scenarios/view/s-otel-01.spec.ts`, `tests/scenarios/hook/s-compat-01.spec.ts`, `tests/scenarios/view/s-cost-01.spec.ts` | scenario steps | see Test coverage plan |
| `user-docs/otel-tab.md`, `docs/knowledgebase/otel-tabs.md`, `docs/knowledgebase/db-tables.md`, `docs/knowledgebase/llm-call-math.md`, `docs/knowledgebase/ui-principles.md` (if a new tooltip pattern) | docs | offline help, grain, compat matrix |

## API changes

All changes are additive. Old clients ignore the new fields, and old servers simply do not send them.

| Endpoint | Change |
|---|---|
| `GET /api/v1/repositories/:repoId/otel/facts` | `stackBy` also accepts `skill`, `mcpServer`, `effort`, `speed` (unknown → 400 as today). Response adds `planMix?: OtelPlanMixRow[]` |
| `GET /api/v1/repositories/:repoId/sessions/:sessionId/otel` | `stackBy` accepts the same 4. Response adds `plan?: OtelSessionPlan \| null` (DD-10), on snapshots and `since=` deltas |
| `GET /api/v1/teams/:teamId/otel/facts` | `stackBy` accepts the same 4. Response adds `planMix?: OtelPlanMixRow[]` |
| Sessions list / session header (`costBreakdown`) | adds `subagentCostFromOtel?: boolean`; `subagentCost` / totals may rise for old-CC sessions (FR-6) |
| `GET …/sessions/:sessionId/logs` and `…/logs/delta` | `subagentStats[sessionId].otelCostUsd?: number \| null` (DD-14) |

Types:

```ts
type OtelAttributionStackBy = 'skill' | 'mcpServer' | 'effort' | 'speed'; // added to Repo/Session/TeamOtelStackBy
interface OtelPlanMixRow { plan: string | null; sessions: number; costUsdMicros: string }
interface OtelSessionPlan { plan: string | null; seatType: string | null; provider: string | null; customBaseUrl: string | null }
```

## Database changes

Migration `00NN_otel_cost_attribution.sql` (DD-1). It is additive and has no data rewrite except the primary-key rebuild.

1. `ALTER TABLE otel_calls ADD COLUMN IF NOT EXISTS …`: the 9 nullable columns of DD-3.
2. `ALTER TABLE otel_cost_buckets ADD COLUMN IF NOT EXISTS skill varchar(255) NOT NULL DEFAULT ''`, and the same for `mcp_server varchar(255)`, `effort varchar(64)` and `speed varchar(64)`. These are metadata-only on PG11+, and existing rows read as `''` = "not reported".
3. The primary-key recreate per DD-2.
4. `ALTER TABLE otel_session_state ADD COLUMN IF NOT EXISTS plan varchar(64), seat_type varchar(64), provider varchar(64), custom_base_url varchar(1024), account_event_at timestamptz`.
5. The index per DD-16.
6. `COMMENT ON COLUMN` for every new column.

Then: a journal entry, `npm run migrations:lock`, apply to the local dev DB, `npm run db:state`. The `db-state-update` and `migrations-data-integrity` skills apply. Existing totals are unchanged, and FR-7 re-projection fills the new data.

## Test coverage plan

The project's test policy allows only these three kinds.

**Algorithm**
- `algorithms/otel-facts.md` with rows in `docs/algorithm-examples/otel-facts.json` (OF-50 onward), run by `otel-facts.algo.spec.ts`:
  - `calls` rows with the 5m/1h split, with each of the 7 attributes, and with oversized values (capped). These cover AC-1 and AC-2.
  - A pre-2.1.300 `calls` row in which every new field is explicitly `null` (`toMatchObject`), for AC-9.
  - A new kind `account`: record vs resource precedence, latest event time wins, null never overwrites, spans. Covers AC-4.
  - A new kind `baseUrl`: userinfo, query and fragment stripped, the port kept, unparsable → null, capped. Covers AC-4.
- `algorithms/otel-cost-selection.md` with rows in `otel-cost-selection.json`, run by `otel-cost.sql.algo.spec.ts`. A new kind `subagent` for `selectSubagentCost` (AC-6):
  - OTEL above transcript → OTEL, `fromOtel`
  - OTEL below transcript → transcript
  - no OTEL → transcript
  - unpriced transcript plus OTEL → OTEL, not missing
  - unpriced without OTEL → missing
- `algorithms/otel-delta-merge.md` with rows in `otel-delta-merge.json`, run by `otel-merge.algo.test.ts`: a delta with `plan` replaces the previous value; a delta without `plan` (old server) keeps it.

**API contract**
- `server/test/contract/registry/f25-otel.ts`, with seed in `world-v1.sql.ts` `otelStatements()`: calls with attributes; one state row with a plan, one without; buckets seeded with the new grain.
  - For each new `stackBy` on the repository, session and team routes, a row whose bucket sum equals the ungrouped total and includes `''` (AC-3).
  - A session-plan row (AC-4), a no-plan row with `plan: null`, and a masked row with `customBaseUrl: null`.
  - A `planMix` row on the repository and team routes (AC-5).
  - A team `team-no-prompts` row with unmasked skill keys and plan values.
- `f17-sessions.ts`: one root with an old-CC sub-agent that has OTEL calls above its transcript cost, and one new-CC sub-agent.
  - The sessions list and the single-session header route: `costBreakdown.subagentCost` and `subagentCostFromOtel`.
  - `f20-analytics.ts` (timeline `totalCost`) and `f21-reports.ts` (executive summary `totalCost`): the raised total for the old-CC root. The other `treeCostCtes` surfaces share the same CTE and are covered through it.
  - `/logs` and `/logs/delta` (no cursor, so every sub-agent is new) `subagentStats[*].otelCostUsd` (AC-6).

**Scenario**
- `tests/scenarios/view/s-otel-01.spec.ts`:
  - Extend the step at l.303 (the stack-by controls) with Skill, MCP server, Effort and Fast mode, plus the "not reported" legend item and its tooltip (AC-3).
  - Extend the session-tab step at l.354 with the Account row, the plan note and the `plan:` chip (AC-4, AC-5).
  - Extend the repository tab with the plan-mix text (AC-5).
  - Extend the AC-12/13 re-projection step at l.423, which uses `resetOtelProjection` + `waitForOtelProjected`, to assert non-empty `stackBy=skill` buckets after re-projection (AC-7).
  - The fixture lines come from `otel-lines.ts` with the new optional attributes.
- `tests/scenarios/hook/s-compat-01.spec.ts` step 12 (l.435, frozen 2.28.0 OTEL) gets a new step (AC-8): each new `stackBy` returns a single `''` bucket equal to the total; the session route returns `plan: null`; the UI shows no Account row, note or chip and no plan-mix text.
- `tests/scenarios/view/s-cost-01.spec.ts` gets a new step after step 14 (AC-6, UI). In GS-02 (the three-sub-agent tree):
  - One sub-agent gets `claude_version` `2.1.300` (set through its upload, or an SQL patch the scenario helpers allow) and OTEL `api_request` lines whose `agent_id` is its bare id and whose `cost_usd` is above its transcript cost. Feed them through `otel-lines.ts`.
  - Then: the sub-agent's cost in `SubAgentDetail` shows the OTEL amount with "from OTEL"; the header `CostBreakdownTooltip` shows "Sub-agents (from OTEL)"; the list total rises by the difference.
- Perf: `npm run perf` before and after, for `otel:repo-facts-week` and `otel:session-snapshot`. Both must stay within +20 %. This is not a test file.

## Visual/UX notes

- **Stack by.** The segmented control appends Skill, MCP server, Effort and Fast mode after the existing options. The session tab gets the same options without CC version. Labels per wireframe `otel-stack-by-attribution.svg`.
- **"Not reported" series.** Neutral grey (`#64748b`, the last palette entry) is pinned to the `''` key for the new groupings. The legend item reads "not reported ⓘ" with `TooltipContent` (light variant, per ui-principles "Hint/tooltip surfaces").
- **Account row.** It goes under the session OTEL status line: muted text "Account:" followed by chips (`bg-slate-50 text-slate-700 ring-1 ring-slate-100`) for plan, seat, provider and base URL. Null chips are omitted, and the row is hidden when all are null.
- **Plan note.** A blue info strip (`bg-blue-50 text-blue-700`) with `OTEL_PLAN_NOTE` and the "What is this?" link.
- **Session OTEL cost tile.** The chip `plan: <value>` sits in the new `chip` slot, with the same tooltip text.
- **Repository/team Total tile.** The secondary line reads "Mix of plans: max · 12 sessions · $96.40 — pro · 3 · $10.20 — not reported · 40 · $172.35", followed by the one-line explanation.
- **Sub-agent cost.** A "from OTEL" muted suffix appears next to the cost, and `CostBreakdownTooltip` shows "Sub-agents (from OTEL)".

## Wireframes

No changes. `wireframes/otel-stack-by-attribution.svg` and `wireframes/session-otel-plan-notional.svg` are implemented as drawn.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Migration + Drizzle schema | 5 | first; everything reads the new columns |
| 2 | OTEL extraction functions | 5 | pure functions used by chunk 3 |
| 3 | Facts writer + projection version | 7 | needs 1, 2 |
| 4 | Facts read API (stackBy, planMix, plan) | 7 | needs 1, 3 |
| 5 | FR-6 sub-agent cost (server) | 8 | needs 1; independent of 2–4 |
| 6 | Client OTEL stack-by + not-reported | 6 | needs 4 (API shapes in plan) |
| 7 | Client plan / account UI | 6 | needs 4 |
| 8 | Client sub-agent OTEL cost | 6 | needs 5 |
| 9 | Docs and user help | 6 | after code |
| 10 | Algorithm rows | 6 | tests |
| 11 | Contract rows | 6 | tests |
| 12 | Scenarios, perf, real-data check | 7 | tests, last |

### Chunk 1 — Migration + Drizzle schema
- [ ] Create `server/drizzle/migrations/00NN_otel_cost_attribution.sql` (number per Design Decision 1) with the statements of Database changes 1–5, in a header comment in the style of `0078_otel_tabs_traces.sql` (purpose, additive, lock profile).
- [ ] Add `COMMENT ON COLUMN` for every new column in the same migration (Database changes 6).
- [ ] Add the journal entry in `server/drizzle/migrations/meta/_journal.json` and run `npm run migrations:lock` from `server/`.
- [ ] Update `server/src/database/schema/index.ts`: the new columns on `otelCalls`, `otelCostBuckets` (and the `otel_cost_buckets_pk` columns list) and `otelSessionState`, plus index `idx_otel_calls_session_agent`, per Design Decisions 3 and 16.
- [ ] Apply the migration to the local dev DB, then follow the `db-state-update` skill (`npm run db:state`) to regenerate `docs/knowledgebase/db_state.sql`.

### Chunk 2 — OTEL extraction functions
- [ ] In `server/src/logs/otel-chunk.ts`, add `nullableTokenCountOf(attrs, key): number | null` and `cappedStringAttrOf(attrs, key, max): string | null` per Design Decision 4, next to `tokenCountOf`.
- [ ] In `server/src/logs/otel/otel-records.ts`, add the 9 fields of the Design Decision 4 table to `ExtractedOtelCall` and fill them in `extractOtelCalls`.
- [ ] In `otel-records.ts`, add an exported `sanitizeOtelBaseUrl(raw: unknown): string | null` per Design Decision 6.
- [ ] In `otel-records.ts`, add an exported `extractOtelAccount(lines: unknown[]): ExtractedOtelAccount | null` (type `{ plan, seatType, provider, customBaseUrl: string | null; eventAt: Date }`) per Design Decision 5, using `resolveOtelEventTime` and the `serviceVersionOf` resource pattern.
- [ ] In `server/src/logs/otel/otel-facts.algo.spec.ts`, add `kind: 'account'` (calls `extractOtelAccount`) and `kind: 'baseUrl'` (calls `sanitizeOtelBaseUrl`) cases to the switch.

### Chunk 3 — Facts writer + projection version
- [ ] In `otel-facts-writer.ts`, extend `OldCallRow` and the old-row SELECT (l.589) with the 9 new `otel_calls` columns, and the calls upsert (l.666) column list and `SET` list with them (Design Decision 3).
- [ ] Extend `callDataChanged` (l.453) so that a difference in any of the 9 new fields counts as changed.
- [ ] Extend `CallContribution`, `bucketKey`, `contributionOfOld` and `contributionOfNew` with `skill`, `mcpServer`, `effort` and `speed` per Design Decision 7.
- [ ] Extend `applyBucketDeltas` (l.485): the `jsonb_to_recordset` column list, the INSERT columns and the conflict target keep `ON CONSTRAINT otel_cost_buckets_pk`, with the 4 grain columns added.
- [ ] Extend `rebuildOtelBuckets` (l.1005) with GROUP BY and FULL JOIN on the 4 new grain columns (Design Decision 7).
- [ ] In `applyOtelLines` (l.939), call `extractOtelAccount` and add the account columns to `StateDbRow`/`toState`/`selectStateForUpdate`. Update `plan`, `seat_type`, `provider`, `custom_base_url` and `account_event_at` per Design Decision 5, and count a changed value as `changed`.
- [ ] Set `OTEL_PROJECTION_VERSION = 2` in `server/src/logs/otel/otel-facts.constants.ts` (Design Decision 19).

### Chunk 4 — Facts read API (stackBy, planMix, plan)
- [ ] In `otel-facts.types.ts`, add `skill | mcpServer | effort | speed` to `RepoOtelStackBy`, `SessionOtelStackBy` and `TeamOtelStackBy`. Add `OtelPlanMixRow` and `OtelSessionPlan` per API changes. Add `planMix?` to the repository and team responses and `plan?` to `SessionOtelResponse`.
- [ ] Add the 4 values to `REPO_STACK_BY` and `SESSION_STACK_BY` in `otel-facts.controller.ts` and to `TEAM_STACK_BY` in `otel-team-facts.controller.ts`. Defaults stay unchanged.
- [ ] In `otel-facts-read.sql.ts`, extend `OtelStackColumn`/`stackKeySql` and `teamStackKeySql` per Design Decision 8, and add `skill`, `mcp_server`, `effort` and `speed` to the explicit `fb` column lists of `repoBucketSource`/`sessionBucketSource`.
- [ ] In `otel-facts-read.sql.ts`, add `loadPlanMix(db, source): Promise<OtelPlanMixRow[]>` per Design Decision 9, usable for both the repository and team bucket sources.
- [ ] Extend `readOtelStateRow` (l.1022) with `plan`, `seat_type`, `provider` and `custom_base_url`.
- [ ] In `otel-facts.reader.ts`, call `loadPlanMix` inside the KPI `Promise.all` of `getRepoOtelFacts` and `getTeamOtelFacts` and set `planMix`. Set `plan` in `getSessionOtel`, including the empty-delta fast path (l.862), per Design Decision 10.
- [ ] Mask `customBaseUrl` to `null` in `getSessionOtel` when `attributesMasked` (l.823) is true.

### Chunk 5 — FR-6 sub-agent cost (server)
- [ ] In `server/src/logs/otel-cost.sql.ts`, add `OTEL_SUBAGENT_COST_FIX_VERSION`, `ccVersionBeforeSql` and `subagentOtelCostSql` per Design Decision 11.
- [ ] In `otel-cost.sql.ts`, add the exported pure `selectSubagentCost({ transcriptCost, modelId, otelCostUsd }): { cost: number | null; pricingMissing: boolean; fromOtel: boolean }` per Design Decision 12, and `subagentCostFromOtel?: boolean` on `CostBreakdown`.
- [ ] Rewrite `tree_subagent_costs` in `treeCostCtes` (`session-tree-cost.sql.ts`) per Design Decision 13, applying the Design Decision 12 rule in SQL and adding the `subagent_cost_from_otel` column.
- [ ] Carry `subagent_cost_from_otel` through `tree_costs`, `TREE_COST_COLUMNS_SQL`, `TreeCostSqlRow`, `readTreeCost` and `SessionTreeCost.subagentCostFromOtel: boolean`. Check that the `treeCostCtes` consumers in the Files table still compile with it.
- [ ] Add `kind: 'subagent'` (calls `selectSubagentCost`) to the switch in `server/src/logs/otel-cost.sql.algo.spec.ts`.
- [ ] In `repositories.controller.ts` (l.705), set `costBreakdown.subagentCostFromOtel` from the tree cost.
- [ ] In `selectSubagentStats` (`session-logs-delta.service.ts:37`), add the `rootRowId` parameter and `otelCostUsd` per Design Decision 14, and pass the root id from both callers. `SubagentStatsRow` picks up the field automatically.
- [ ] Emit `otelCostUsd` in the `/logs` `subagentStatsJson` builder (`repositories.controller.ts` ~l.2008). Confirm that `/logs/delta` passes it through unchanged.

### Chunk 6 — Client OTEL stack-by + not-reported
- [ ] Add `skill | mcpServer | effort | speed` to the stack-by mirror types in `client/src/models/repositories.ts` and `client/src/models/teams.ts`.
- [ ] Add options Skill/`skill`, MCP server/`mcpServer`, Effort/`effort` and Fast mode/`speed` to `OTEL_REPO_STACK_OPTIONS` (`OtelChartControls.tsx:85`) and `STACK_BY_VALUES` (`otel-url-state.ts:94`).
- [ ] Add the same 4 options to `STACK_OPTIONS` in `SessionOtelTab.tsx:61` and `TEAM_STACK_OPTIONS` in `TeamOtelTab.tsx:113`.
- [ ] In `otel-chart-data.ts`, make `otelSeriesLabel` return `'not reported'` for `''` under the 4 new groupings (Design Decision 17) and export `OTEL_NOT_REPORTED_HINT` and `isAttributionStackBy(stackBy)`.
- [ ] Pin the `''` series color to `#64748b` for attribution groupings in `buildOtelSeries` or its color assignment.
- [ ] In `OtelCostChart.tsx` (legend l.228), render an ⓘ with `TooltipContent` showing `OTEL_NOT_REPORTED_HINT` on the `''` legend item when `isAttributionStackBy`. Verify that the team tab gets the label, grey pin and ⓘ too; if not, fix it in `team-otel-display.ts` (Design Decision 17).

### Chunk 7 — Client plan / account UI
- [ ] Add `OtelPlanMixRow`, `OtelSessionPlan`, `planMix?` and `plan?` mirror types to `client/src/models/repositories.ts` and `teams.ts` per API changes. Carry `plan` in `mergeOtelDelta` (`otel-merge.ts:164`): use the delta's value when present, otherwise keep the previous one.
- [ ] Add an optional `chip?: ReactNode` prop to `OtelKpiTile` (`OtelKpiTile.tsx:66`), rendered beside the label.
- [ ] Add `OTEL_HELP_ANCHORS.plan`, `OTEL_PLAN_NOTE` and `OTEL_PLAN_EXPLANATION` to `otel.constants.ts` per Design Decision 18. Create `session-log/otel/SessionOtelAccount.tsx`: the Account chips row plus the plan note with an `OtelHelpLink` to `plan` (Visual/UX notes). It renders nothing when `plan` is null.
- [ ] In `SessionOtelTab.tsx`, render `SessionOtelAccount` under the status line (l.228), and pass `chip` = `plan: <value>` with a tooltip to the session "OTEL cost" tile (`OtelKpiTiles.tsx:237`) when `plan.plan` is non-null.
- [ ] Create `client/src/viewer/pages/repository/otel/OtelPlanMix.tsx`: renders the "Mix of plans" text plus the explanation from `planMix`, or nothing when no row has a non-null `plan` (Visual/UX notes).
- [ ] Use `OtelPlanMix` as the `secondary` content of the Total OTEL cost tile (`OtelKpiTiles.tsx:87`) for the repository and team tabs (`TeamOtelTab.tsx`).

### Chunk 8 — Client sub-agent OTEL cost
- [ ] Add `otelCostUsd?: number | null` to `SubagentStats` (`client/src/viewer/api.ts:1398`), and `subagentCostFromOtel?: boolean` to the client `costBreakdown` type (`client/src/models/repositories.ts:~116`).
- [ ] Add `otelCostUsd?: number | null` to `SubAgentNode` (`session-log/types.ts:262`), and fill it from `subagentStats['agent-'+agentId]` in `log-parser.ts` (l.975, l.1264) and `session-map/session-map-model.ts` (l.707).
- [ ] In `SubAgentDetail.tsx` (l.117), show `formatCost(agent.otelCostUsd)` with a muted "from OTEL" suffix when it is non-null; otherwise use `computeCost` as today.
- [ ] Apply the same rule in `WorkflowAgentsTable.tsx` (l.42 cost helper) and `AgentActivationItem.tsx` (l.161), using the `otelCostUsd` of the matching stats entry.
- [ ] Add a `subAgentCostFromOtel?: boolean` prop to `CostBreakdownTooltip.tsx` that labels the sub-agent line "Sub-agents (from OTEL)".
- [ ] Pass `costBreakdown.subagentCostFromOtel` to it from `SessionDetailHeader.tsx:242` and `SummaryExecutiveBand.tsx:162`.

### Chunk 9 — Docs and user help
- [ ] Update `user-docs/otel-tab.md`:
  - The new groupings and "not reported" in the Repository (l.12), Session (l.45) and Team (l.76) sections.
  - The new plain-heading section `## Plan and notional cost` (slug `plan-and-notional-cost`, Design Decision 18).
  - A note that FR-6 raises old-CC sub-agent costs.
  - Then run `npm run build:help`.
- [ ] Update `docs/knowledgebase/otel-tabs.md`: the bucket grain (DD-7 section), the account latest-wins rule, projection version 2, the new route params and fields. Add Claude Code compatibility rows to the matrix (l.342): `< 2.1.300` → 5m/1h NULL; no attribution attributes → one "not reported" group; `< 2.1.307` → sub-agent cost from OTEL; `< 2.1.317` → `plan: null`, no Account row.
- [ ] Update `docs/knowledgebase/algorithms/otel-facts.md` rule 8 with the new call fields, plus new rules for account extraction and base-URL sanitising (Design Decisions 4–6).
- [ ] Update `docs/knowledgebase/algorithms/otel-cost-selection.md`: the rule 1 exception and a new sub-agent selection rule (Design Decisions 11–13). Update `docs/knowledgebase/llm-call-math.md` on sub-agent cost.
- [ ] Update `docs/knowledgebase/db-tables.md` §"OTEL tab tables" with the new columns and their writer (`applyOtelLines`).
- [ ] Update `docs/knowledgebase/ui-principles.md` only if the not-reported legend ⓘ introduces a new tooltip pattern; otherwise leave it unchanged.

### Chunk 10 — Algorithm rows
- [ ] Add `calls` rows to `docs/algorithm-examples/otel-facts.json` (OF-50 onward) with the 5m/1h split present and absent, each of the 7 attributes present and absent, and an over-width value capped (AC-1, AC-2).
- [ ] Add a pre-2.1.300 `calls` row with all 9 new fields explicitly `null` and the existing fields as today (AC-9).
- [ ] Add `account` rows: record over resource, resource fallback, latest event wins, null does not overwrite, span-sourced value, no attributes → `null`.
- [ ] Add `baseUrl` rows: userinfo, query and fragment stripped, the port kept, trailing `/` dropped, unparsable → `null`, over-1024 capped.
- [ ] Add `subagent` rows to `docs/algorithm-examples/otel-cost-selection.json`, covering the five cases in Test coverage plan → Algorithm.
- [ ] Add `plan` rows to `docs/algorithm-examples/otel-delta-merge.json` (the delta replaces it; absent keeps it), and update the `docs/knowledgebase/algorithms/otel-delta-merge.md` rule text.

### Chunk 11 — Contract rows
- [ ] Extend `otelStatements()` in `server/test/contract/fixtures/world-v1.sql.ts`:
  - Calls with `skill_name`, `mcp_server_name`, `effort` and `speed` on some rows; buckets with the matching grain.
  - One state row with plan, seat, provider and a sanitised base URL; one without.
- [ ] In `world-v1.sql.ts`, next to the existing sub-agent seed, add two roots, each with one sub-agent. Each sub-agent has a `sessions` row (`agent-<id>`, `parent_session_id` = the root's `session_id`), a transcript `logs` row, `session_stats.claude_version` (`2.1.300` / `2.1.310`) and `session_costs`. Add OTEL calls on the root with `agent_id` = `<id>`, above the transcript cost.
- [ ] Add rows to `f25-otel.ts` for each new `stackBy` on the repository, session and team routes, asserting that the bucket sum equals the ungrouped total and includes `''` (template `F25-repo-buckets` l.742; use `bucketsOf()` l.68).
- [ ] Add rows to `f25-otel.ts` for the session `plan` (with a plan / without → `null` / masked `customBaseUrl: null`), for repository and team `planMix`, and for team `team-no-prompts` unmasked skill keys and plan values.
- [ ] Add rows to `f17-sessions.ts` for the sessions list and the session header: `costBreakdown.subagentCost` is raised and `subagentCostFromOtel: true` for the old-CC root, while the new-CC root is unchanged. Add rows to `f20-analytics.ts` (timeline) and `f21-reports.ts` (executive summary) for the raised total.
- [ ] Add rows to `f17-sessions.ts`: `/logs` and `/logs/delta` (no cursor) `subagentStats[*].otelCostUsd` is non-null only for the old-CC sub-agent.

### Chunk 12 — Scenarios, perf, real-data check
- [ ] Extend `OtelCallSpec`/`apiRequestLine` in `tests/scenarios/fixtures/otel/otel-lines.ts` with optional `attributes` (the new keys) and `resourceAttributes` merged into the fixed resource (l.74).
- [ ] In `tests/scenarios/view/s-otel-01.spec.ts`:
  - Feed attributed and plan lines.
  - Extend the step at l.303 with the 4 new stack-by options and the "not reported" legend tooltip (AC-3).
  - Extend the session step at l.354 with the Account row, plan note and chip (AC-4, AC-5).
  - Assert the repository plan-mix text.
- [ ] Extend the step at l.423 in `s-otel-01.spec.ts` (`resetOtelProjection` + `waitForOtelProjected`) to assert non-empty `stackBy=skill` buckets after re-projection under v2 (AC-7).
- [ ] Add a step to `tests/scenarios/hook/s-compat-01.spec.ts` after step 12 (l.435), per Test coverage plan → Scenario (AC-8).
- [ ] Add the FR-6 UI step to `tests/scenarios/view/s-cost-01.spec.ts` after step 14, per Test coverage plan → Scenario (AC-6).
- [ ] Run `npm run perf` on `main` and on the branch for `otel:repo-facts-week` and `otel:session-snapshot`. Confirm ≤ +20 %, and record the numbers in requirements.md Notes.
- [ ] Run the FR-6 real-data check: on the dev DB, compare old-CC sub-agent transcript cost with the OTEL sum, and spot-check 5m/1h against transcript `ephemeral_1h`. Record the results in requirements.md Notes (AC-6).
