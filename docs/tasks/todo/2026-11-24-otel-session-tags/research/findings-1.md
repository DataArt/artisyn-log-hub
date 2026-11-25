---
type: "Research"
title: "otel-session-tags — research findings 1"
description: "Codebase research report for the 2026-11-24-otel-session-tags implementation plan (audit archive)."
---

## Requirements summary
The task replaces the hook-config session "context" (`log-hub.json` `context`, legacy `CTX_*`, tables `contexts` / `log_contexts`) with a generic `session_tags` table: `(root session id, key, value, source)`. The first source is `otel`. Tags come from the user's attributes in each OTEL line's `resource`. Any key whose prefix is not on a server deny-list counts: `artisyn.`, `service.`, `os.`, `anthropic.`, `wsl.`, `session.`, and so on.

- **Ingest:** extraction happens inside `applyOtelLines`, so both the chunk and the realtime channel feed it. It is an idempotent upsert that keeps every distinct value of a key.
- **Limits:** key ≤ 64 chars, value ≤ 256, ≤ 20 pairs per session. Over-length pairs are dropped. Keys are case-sensitive.
- **Backfill:** bump `OTEL_PROJECTION_VERSION` from 2 to 3.
- **Migration:** copy every existing context pair to the root session with `source=config`, then drop both old tables.
- **API:** session row and session-detail responses carry `tags[]`. A new discovery endpoint (modelled on `session-attribution/values`) feeds the pickers. `tag=<k>[:<v>]` (AND across keys, OR within a key) and `groupBy=tag:<k>` work on every route that takes `attr=` / `groupBy=attr:`. Both `.../contexts` routes keep their shape, read from `session_tags`, and the repo route gains period, branch, user and access scoping.
- **UI:** a Tags row in the session header, "By tag" grouping and a tag filter in the session list, a "Tag" slice on Spend and a "Group by tag" option on Analytics. The repo header chips stay.
- **Hook / installer:** stop reading and writing `context`; the `.env` conversion prints one line saying `CTX_*` is no longer used.
- **Open:** Q1 (a session with two values of the grouped key: count it in both groups, or split its cost) is still unanswered.

## Wireframes
- **`session-header-tags.svg`:** a "TAGS" row under the HeaderStat grid in `SessionDetailHeader.tsx`, next to the existing Session Attributes row. Chips read `key=value` with tooltip "source: otel" and the caption "from OTEL resource attributes". Two values of one key are both shown. Long values are cut with … and the full value goes in the title. A session without tags shows no label and no empty state.
- **`session-list-tag-filter-group.svg`:**
  - New "BY TAG" options ("By tag: feature" / "By tag: team") in the view-mode select. The section appears only when the repo has tagged sessions in the period.
  - Group headers show count, duration and cost, plus an "(untagged)" group.
  - Rows show a `feature=…` chip and "+1" for extra tags.
  - The filter popover gets a TAGS section under the existing SESSION ATTRIBUTES: per key an "(any value)" entry, each value, and "(no feature tag)".
  - The note says the filter is URL-backed (`tag=feature:checkout-v2`) like `attr=`. Today the session-list attribute filter is client-side only, not URL-backed (see gaps).
- **`spend-slice-by-tag.svg`:**
  - A "Tag: feature ⌄" chip appended to Spend's Slice-by chips (Model/User/Repository/Branch/Sub-agent/Skill/MCP server), with a key menu. The chip is hidden when no session in scope has tags.
  - A table with FEATURE / SESSIONS / COST / SHARE columns and an "(untagged)" row; the Total must equal the period total (AC-7).
  - A "TAGS" section in the Analytics Group-by menu (`groupBy=tag:feature`); charts stack one series per value plus "(untagged)".
  - The numbers are illustrative and do not add up:
    - **Spend shares:** rows $0.51+$0.37+$0.14+$0.11 = $1.13, but the exact shares of those amounts are 45.13 / 32.74 / 12.39 / 9.73 %, while the wireframe shows 45.1 / 32.4 / 12.6 / 9.9.
    - **List vs Spend:** the list's group costs are $0.5120 / $0.3669 / $0.1375 / $0.1116 (sum $1.1280). The $0.1375 session appears in both checkout-v2 and checkout-v3 (fan-out), so the deduplicated total is $0.9905, not $1.13.

## Knowledgebase
- `docs/knowledgebase/turn-end-cost-advisor.md` §Attribute extraction / §Attributes as a chart dimension: `attr=` uses one shared predicate helper; `groupBy=attr:<key>` is validated against definitions (tags must skip that); `string[]` values fan out and `GroupByFanOutCaveat` is shown.
- `docs/knowledgebase/session-metrics-scope.md` §"Attributes as a Group by dimension": the ATTRIBUTES section in the Analytics and Reports group-by menus and the fan-out rule. Tags need a parallel TAGS section.
- `docs/knowledgebase/db-tables.md`:
  - ER diagram (`log_contexts → contexts`).
  - Soft vs hard delete: soft delete keeps the `sessions` row, so a FK cascade does not fire. `purgeSessionChildData` must delete `session_tags` explicitly. The DD-28 survivors list is relevant here.
  - §OTEL tab tables: every row belongs to the root, `otel_session_state` is the lock row.
  - §logs_otel: the ingest upsert resets `otel_projection_version` to NULL.
- `docs/knowledgebase/db-schema-code.md`:
  - Schema lives in `server/src/database/schema/index.ts`.
  - Hand-written migration `0098_*.sql` (latest is `0097_upload_queue_start_line.sql`) with `COMMENT ON`, a `_journal.json` entry, `npm run migrations:lock`, then the `db-state-update` skill (`npm run db:state`).
  - Never `drizzle-kit generate`; no `CONCURRENTLY`.
  - Also run the `migrations-data-integrity` skill, since this migration moves data.
- `docs/knowledgebase/db_state.sql`: `contexts.context_key varchar(255)`, `context_value varchar(4000)`, `UNIQUE(context_key, context_value)`; `log_contexts(log_id → logs ON DELETE CASCADE, context_id → contexts)`.
- `docs/knowledgebase/otel-tabs.md`: projection drain, realtime route, access rules, `teamId` gives 403 semantics.
- `docs/knowledgebase/algorithms/otel-facts.md` plus `docs/algorithm-examples/otel-facts.json` and `server/src/logs/otel/otel-facts.algo.spec.ts`:
  - Pure extraction rules switch on `input.kind` (`calls`, `spans`, `account`, …).
  - A new `kind: "tags"` row set is the natural algorithm-test home for the deny-list, limits, coercion, trimming and multi-value rules.
  - `{"$repeat": [...]}` expands long strings, which fits the 300-char case in AC-9.
- `docs/knowledgebase/otel-receiver.md`: line shape `{signal, receivedAt, resource:{flat strings}, record}`; `artisyn.repo` is the only Log Hub resource tag; `session.id` can sit on the resource.
- `docs/knowledgebase/hook-installation.md` §Context Metadata (line ~294: the `context` key, keys lowercased) and line ~241 (`CTX_*` collapse). Both need rewriting. §"OTEL_RESOURCE_ATTRIBUTES in the mirror" (~588) is where to tell users to add `feature=…`.
- `docs/knowledgebase/hook-api-versioning.md`: per-version additive-field history. Record that `prompt_start.context` is no longer sent (MINOR bump) and that the server ignores it.
- `docs/knowledgebase/server-endpoint-map.md`: guards and access rules (admin gets no session data); update it with the new discovery route.
- `docs/knowledgebase/budgets.md`: Spend slices (DD-8), `spend/sessions?slice=` drill-down, root selection.
- `docs/knowledgebase/test/scenarios.md` and `test/contract-tests.md`: scenario stand and contract registry conventions.

## Existing patterns
- **`server/src/logs/attribute-filter.sql.ts`:** the template to mirror in a `tag-filter.sql.ts`.
  - `parseAttributeFilters`, `attributeFilterSql(filters, sessionIdColumn)` (same key OR'd in one EXISTS, different keys AND'd), `normalizeRepeatableParam`, `parseGroupByAttrKey`, `assertNoGroupByAttrFilterConflict`.
  - `attributeGroupLabels` does TS-side fan-out bucketing; `attrGroupKeysSql` is the set-returning SQL fan-out for work-time.
- **Routes that take `attr=`** (all need `tag=`):
  - `repositories.controller.ts`: `sessions` (:562), `sessions/branches` (:1054), `analytics/timeline` (:2265), `analytics/change-surface` (:2973), `analytics/work-time` (:3150).
  - `reports/reports.controller.ts`: executive-summary, cache-read-ratio, harness-usage, okf-usage, change-surface, attribution-breakdown, tool-analytics, token-usage, productivity-counters, active-sessions, claude-versions.
  - `analytics/usage-analytics.controller.ts`: tools, tokens, productivity, active-sessions, claude-versions.
- **Routes that take `groupBy=attr:`:** timeline, change-surface (analytics and report), work-time, cache-read-ratio, harness-usage. Consumers: `change-surface-aggregate.service.ts`, `cache-read-ratio.service.ts`, `harness-usage.service.ts`.
- **`server/src/logs/analytics/scoped-sessions.sql.ts` `loadScopedRootSessions`:** Phase A root selection with an `attributeFilters` field on `AnalyticsScope`. Add `tagFilters` alongside it.
- **`repositories.controller.ts:1243` `getSessionAttributionValues`:** the model for FR-8. Same `teamId` / `startDate` / `endDate` scope, `resolveRepoIds`, `resolveTeamScope` plus `teamScopeUserFilterSql(teamId, scope, 'l')` (:196), returning `Record<key, {value, sessionCount}[]>`. Contract row `F17-attribution-values` in `server/test/contract/registry/f17-sessions.ts:659` uses `listedRootsSql`; copy it for the tags row.
- **`repositories.controller.ts:847-972`:** per-listed-session batch query that attaches `attribution` to each session row. Use the same shape for `tags`.
- **`gatherSessionLogsMeta` (`repositories.controller.ts` ~1891, 2064-2171):** builds the session-detail extras (`sessionAttribution`) for `/logs` (`tailJson` at :1793) and the parts manifest. Add `tags` there, resolved via the root for sub-agents.
- **`repositories.controller.ts:1346` / `:1385`:** the current contexts routes. The session route already applies the owner filter and `assertSessionVisibleBySessionId`; the repo route does not (the gap behind AC-10a).
- **`server/src/logs/otel/otel-facts-writer.ts:1445` `applyOtelLines`:** callers are `OtelProjectionService.projectRoot` (:278) and `OtelRealtimeService.ingest` (:85).
  - The account fields show the pattern for pulling from line `resource`: `extractOtelAccount` in `otel-records.ts:306` and `resourceAttrOf` (:294). A pure `extractOtelTags(lines)` belongs in `otel-records.ts`.
  - It runs under the `otel_session_state` lock, so a `changed` flag should bump `seq` if tags should count as a change.
- **`server/src/logs/otel/otel-facts.constants.ts:35`:** `OTEL_PROJECTION_VERSION = 2`. `database-init.ts:177` re-queues lower versions at startup.
- **`server/src/logs/budgets/spend.service.ts`:**
  - `SPEND_SLICE_KINDS`, `buildTreeParts`, `aggregateSlices`.
  - Whole-tree slices (user/repo/branch) put the full tree cost into one part. Part-based slices (skill/mcp from OTEL calls) can split cost and leave a "Not reported" gap.
  - Both of Q1's options map onto this. `budgets.types.ts` `SpendSliceKind` and `budget-query.ts` `SPEND_SESSIONS_SLICES` are the drill-down params.
- **`server/src/sessions/sessions.service.ts:379-394`:** `purgeSessionChildData` (logs delete cascading `log_contexts`, plus orphan-contexts cleanup); `teams.service.ts:645`. Replace with an explicit `session_tags` delete, because soft delete keeps the `sessions` row.
- **`server/src/logs/logs.service.ts:1078` Step 6 and `artisyn-extractor.ts:609` `extractContextPairs`:** to delete. The import path (`importSession`) never wrote contexts.
- **Hook:**
  - `hook/.claude/telemetry_tool/env-context.js`: `CONFIG_DEFAULTS.context` (:95), `CONFIG_TYPES` (:123), `getEnvContext` (:585).
  - `coerceConfigValue` passes unlisted keys through silently. The removed `guardrail*` keys are the precedent for dropping a key with no warning.
  - `telemetry-hook.js:116-125`.
- **Installer:**
  - `artisyn-hooks-installer/src/install.ts:453-460` (`CTX_*` conversion) and `LogHubConfig.context` (:1381).
  - The template default comes from `scripts/build-hooks-installer.js:332` (`{ serverUrl, telemetryDir, context: [] }`).
- **Client:**
  - `client/src/viewer/api.ts:529` `fetchRepositoryContexts`, `:497` `fetchSessionAttributionValues`.
  - `useRepositoryData.ts:134` `repoContextsQuery`; `RepositoryHeader.tsx` chips (`RepoContext`).
  - `SessionDetailHeader.tsx` (`buildAttributionDisplay` row).
  - `session-list/SessionListPanel.tsx`: `ViewMode = 'branch'|'date'|'user'|'plain'`, the `groupSessionsByDate` / `ByUser` memos, `AttributeFilterPopover`.
  - `session-list-helpers.tsx`: `AttributeFilterSelection`, `sessionMatchesAttributeFilter`, `filterVisibleSessions`.
  - Analytics: `analytics/analytics-state.ts` / `analytics-url.ts` / `AnalyticsControls.tsx` (`attr:${string}` groupBy type and ATTRIBUTES optgroup).
  - Reports: `reports/report-url.ts`, `ReportParameterStrip.tsx`, `report-catalog.ts` `supportsAttributeFilter`, `GroupByFanOutCaveat.tsx`.
  - Spend: `pages/spend/SpendTab.tsx` / `SliceTable.tsx`.
  - Filter strip: `okf/OkfFilterStrip.tsx` plus `okf-url-state.ts` `attrParamsToSelection`. This is the only screen with a URL-backed `attr=` filter UI.
- **Tests to extend:**
  - Contract rows `F14-contexts*` (`f14-repositories.ts:539-603`), `F17-session-contexts*` (`f17-sessions.ts:683+`), and `f18-session-delete-retention.ts` (:39, :93-102). The world-v1 fixture seeds `contexts` / `log_contexts` (`world-v1.sql.ts:1756`).
  - Scenarios: `s-ingest-02` steps 7–8 (context junk and values; good for the "old hook still sends context" step), `s-slife-07` (orphan contexts on delete), `s-slife-10` and `s-team-02` / `s-team-03` / `s-acc-01` / `s-repo-03` (contexts route access), `s-otel-01` / `s-otel-02` (OTEL ingest), `s-budg-01` (Spend), `s-anlt-01` / `s-rept-01` (analytics and reports).
  - Scenario helpers: `tests/scenarios/fixtures/otel/otel-lines.ts` `OtelCallSpec.resourceAttributes` (inject `feature=…`); `helpers/otel.ts` `uploadOtelChunk`, `sendRealtime`, `waitForOtelProjected`, `resetOtelProjection` (simulates the AC-4 backfill).

## Open gaps
1. **Q1 is unanswered.** A session with two values of the grouped key: fan out (as `attr:` does, with the caveat) or split cost by the OTEL lines that carried each value. Split needs the tag stored per call/line, e.g. a tag on `otel_calls` or a `first_seen`/line-count column. The plain `(session, key, value, source)` model cannot split.
2. **Nothing to copy for Reports / Analytics filter UI.** The client never sends `attr=` on Analytics or Reports today: `usageAnalyticsQuery` and `fetchAnalyticsTimeline` have no attr, and `supportsAttributeFilter` is set but not rendered. Only the OKF tab has a filter UI. FR-7/AC-7a ("every Reports and Analytics screen offers a tag filter") therefore needs a new filter-bar control and new param plumbing in every fetcher.
3. **The session-list attribute filter is client-side and not URL-backed.** The wireframe says the tag filter is URL-backed and FR-6 defines a server `tag=` param. The plan must choose between server filtering (which also affects branch mode, where each `BranchSection` fetches its own list) and client filtering over the `tags` field. "By tag" grouping has no server counterpart either.
4. **Spend has no `attr=` / `groupBy=attr:` today.** A Tag slice is a new `SpendSliceKind`, and it needs a key parameter: `?sliceTagKey=` on `spend` and a `slice=tag` plus key on the `spend/sessions` drill-down. The response shape has one `rows` per kind, so a per-key variant needs design. Team Spend (`/api/v1/teams/:teamId/spend`) and the Budget report `topSlices` are affected too.
5. **Discovery for team-level and Spend scopes.** The FR-8 endpoint follows the repo-scoped `session-attribution/values`. Team Spend and team analytics would need a team-scoped variant or `repoId`-less form; nothing like it exists.
6. **Migration edge cases with no precedent:**
   - Legacy keys can be up to 255 chars and values up to 4000; the new limits are 64 / 256. Over-limit pairs: drop or keep?
   - The 20-pair cap may be exceeded for a migrated session.
   - Legacy keys are already lowercased.
   - Pairs belong to `artisyn` logs of root sessions, so root = `logs.session_id`; soft-deleted sessions have no rows left.
   - The routes have to dedup `config` and `otel` sources.
7. **Delete semantics.** "The cascade on session / team delete" is not enough for soft delete, because the `sessions` row stays. Add an explicit `session_tags` delete to `purgeSessionChildData` and the deleted-session cleanup, and make sure the projection and realtime writers do not write tags for a deleted root.
8. **Export/import.** The zip export carries no `logs_otel`, and import never wrote contexts. Imported sessions lose OTEL tags, and `config` tags are not exported. The requirements are silent on this.
9. **Write-side details to decide:** whether tags change `seq` / OTEL `changed`; where to cap 20 pairs atomically across concurrent chunk and realtime writers (the state lock covers both); the unique key `(session_id, key, value, source)` vs `(session_id, key, value)`; indexes for `tag=` EXISTS predicates and for discovery.
10. **Wireframe filter/popover text** still calls key-only filters, AND/OR and the meaning of "untagged" open questions. The requirements have settled them (FR-6), so the wireframe captions are stale.
11. **User docs.** No `user-docs/` page mentions `context` or `CTX_*`; only `user-docs/otel-tab.md:338` mentions `OTEL_RESOURCE_ATTRIBUTES`. A new user-facing "how to tag sessions" section has no existing home and needs a `nav.json` decision.
