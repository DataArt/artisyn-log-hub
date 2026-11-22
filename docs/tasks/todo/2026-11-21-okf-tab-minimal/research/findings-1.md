## Requirements summary

Both OKF tabs (repository over a period, session for one tree) are cut down to one summary line plus four views built by the same components: Versions, Wrong format, Hot files and Explorer.

- **Summary:** "KB read in N of M sessions · ≈ X tokens · ≈ $Y (≈ P % of $T spend) · snapshot from `<branch>`, `<date>`"; the session tab uses agents as the unit.
- **Counting rules (FR-0):**
  - A read is a `session_okf_access` row with `op` `read` or `grep` under a bundle root of the reference snapshot, `after_own_edit` included.
  - Tokens are `bytes / 4`; reads are `calls`.
  - `list`, `write`, glob paths and `.md` outside every bundle count nowhere.
  - Each file belongs to its deepest bundle.
  - A folder-level grep is a "searches across this folder" row.
  - `index.md` / `log.md` are excluded from hot files and the format checks but included in totals and the explorer.
  - Hot files and the explorer come from one `files[]` list.
- **Cost (FR-5a):** per agent, min(1, KB tokens / (`input_tokens` + `cache_write_tokens`)) × (`cost_input` + `cost_cache_write_5m` + `cost_cache_write_1h` + `cost_cache_read`), returned as optional per-file and total fields; P = KB cost / T.
- **Removed (FR-6/FR-7):** verdict, checks, anomalies, KPI tiles, section B, upkeep, histogram, not-read list, agents panel, agent trail and article drill-down with their routes and URL params, bundle cards, tree markers, WRITE bar, thresholds chip and the Settings section, plus the server code, algorithm docs and rows that only fed them.
- **Compatibility (FR-8):** hook untouched, old uploads accepted, facts route contract unchanged, unused tables not dropped, a settings PUT with `okf` accepted and ignored, `okfDefaults` / `okfFixedLimits` leave the responses.
- **Docs and tests (FR-9, AC):** KB, in-app help and index rewritten; the existing OKF scenario is cut down, no new scenario file.

## Wireframes

Three SVGs in `docs/tasks/todo/2026-11-21-okf-tab-minimal/wireframes/`. All sums drawn on them were recomputed and hold.

**`repo-okf-tab.svg` (1600×1010)**
- Filter strip top right: Period, Branches, Users, KB folder. The attribute filter that FR-6 keeps is not drawn.
- Summary line at y=128 with the snapshot on the right.
- Versions (collapsed, "4 KB folders, all on format 0.3", x=44) and Wrong format ("✓ All 169 articles are well-formed · 6 index files are not checked", x=740) share one row at y=185.
- Hot files on the left (x 40–900): columns File / Sessions / Reads ⓘ / ≈ Tokens ⓘ ▾ / ≈ $ ⓘ, full repo-relative paths, dollar cells without a "$" sign ("2.59"), "Show all 167 files", then the index line.
- Explorer on the right (x 916–1576): header "154 of 175 files opened", chips All / Opened (154) / Never opened (21), columns File/folder, Files opened, Sessions, ≈ Tokens. Never-opened file rows show "—". A "not in git" chip marks a gitignored bundle. "Not in this snapshot ⓘ" is the last root, with "19 files".
- Checks:
  - tokens: 3430 + 34.4 + 88.0 + 155 + 64.2 = 3771.6K = 3.77M
  - files opened: 121 + 27 + 3 + 3 = 154; snapshot files: 129 + 39 + 3 + 4 = 175 = 169 + 6
  - 167 + 6 = 173 = 154 + 19; 175 − 154 = 21
  - 52.61 / 3017 = 1.74 % → "1.7 %"

**`session-okf-tab.svg` (1600×694)**
- Same layout with "Agents" columns; explorer header "20 of 175 files opened in this session"; no "Not in this snapshot" root drawn.
- The summary reads "KB read **by** 7 of 39 agents", while requirements FR-5 says "KB read in … (session tab: N of M agents)". The wording differs.
- Checks: 51.0 + 4.0 = 55.0K; 17 + 3 = 20 = 18 + 2; 175 − 20 = 155; 0.79 / 45.58 = 1.73 % → "1.7 %".

**`okf-states-and-tooltip.svg` (1600×944)**
- A: Versions expanded — header "current format: 0.3 ⓘ"; rows are path, "N files", version or "not declared", "older than the current format 0.3"; footnote on `okf_version`.
- B: "Wrong format — 9 of 169 articles" — collapsible groups with counts 3 + 2 + 2 + 1 + 1 = 9, titled: No front matter / No "type" in the front matter / Old "timestamp" key (format 0.1) / Deprecated ("→ replaced by X") / Past its "stale after" date.
- C: old-hook line "Update the hook to see versions and format problems." (summary, hot files and explorer still work); no-snapshot line "No KB snapshot — update the hook."
- D: "Never opened" filter — a single "Never opened" count column, 8 + 12 + 1 = 21, "Not in this snapshot" hidden.
- E: exact tooltip texts for ≈ $ / % of spend (ending "All reads in this period have a cost."), Reads, ≈ Tokens, snapshot, Not in this snapshot, searches across this folder.
- F: row legend.

**Token format implied by the wireframes:** "3.77M", "270K", "55.0K", "0.6K" — two decimals for M, integer K from 100K, one decimal K below that, including below 1K. No existing formatter produces this.

## Knowledgebase

- `docs/knowledgebase/okf-usage.md` — the feature article: data flow, tables, routes, team fail-closed filter, lifecycle, compatibility table. Must be rewritten (FR-9). Facts worth keeping in mind:
  - the facts route reparses transcripts and never reads the `session_okf_*` tables;
  - the snapshot is bound to the root only, first upload wins;
  - `created_at` is the current `snapshot.takenAt`;
  - today's reference snapshot is that of the newest root with a snapshot (DD-29), with no branch rule.
- `docs/knowledgebase/algorithms/okf-metadata.md` (kept) — `okfVersionHint`, `articleMetaFlags`, `bundleMetaSummary`, `hasHookMeta`. Its Code section points to `bundleArticles` in `okf-verdict.ts` (line 29) and must be re-pointed.
- `docs/knowledgebase/algorithms/okf-verdict.md` (to delete) — currently the only doc home of the "Articles", "Dot paths" and deepest-bundle rules (`bundleArticles`, `isReservedOkfName`, `isDotPathUnderRoot`, `bundleOfPath`) and of the team filter. Those rules need a new doc.
- `docs/knowledgebase/algorithms/okf-value-signals.md` (to delete) — also documents the trail (rule 11).
- `docs/knowledgebase/algorithms/okf-access-extraction.md` (kept) — rules 14–15 stay. Lines 22–24 and 374–378 reference value-signals and the trail route and need editing. Globs are reduced to their static prefix (rule 4 / line 176).
- `docs/knowledgebase/algorithms/okf-task-context.md`, `okf-snapshot.md` — kept unchanged.
- `docs/knowledgebase/algorithms/README.md:80-81` — rows for okf-verdict and okf-value-signals to remove; `docs/knowledgebase/index.md:71,116,117` likewise.
- `docs/knowledgebase/session-metrics-scope.md` — additive metrics go over root plus all descendants. Use `descendantSessionsCte` (`session-tree.sql.ts`) and `treeCostCtes` / `loadTreeCostRows` / `readTreeCost` (`session-tree-cost.sql.ts`); never hand-roll the walk. Apply the OTEL-only guard (`EXISTS` on a `claude` / `claude-subagent` log). An unpriced sub-agent nulls the tree cost.
- `docs/knowledgebase/budgets.md` — the Spend tab is period / offset / tz based, with its own root selection (`loadPeriodTrees`: no `claude`-log requirement, anchor time) and cost = max(hook tree cost, OTEL cost) via `selectBudgetTreeCostMicros`. It has no branches / users / attr filters.
- `docs/knowledgebase/token-byte-ratio.md` — client `BYTES_PER_TOKEN = 3.5` for byte-to-token estimates; the requirement fixes `bytes / 4` for this tab.
- `docs/knowledgebase/ui-principles.md` — "No access" / "Error" texts, light scheme only, status colours, tooltips via `ui/tooltip.tsx` (light variant) or `ViewportPopover` / `HoverPopover`, hints applied uniformly across a row.
- `docs/knowledgebase/client-component-map.md:87,89,124,168` — OKF rows to update.
- `docs/knowledgebase/server-endpoint-map.md:231,297,300,306` — mentions of the article and trail routes and `okfDefaults` to update.
- `docs/knowledgebase/db-tables.md:49,102,331-351` — event / pointer table notes, to be marked as no longer written if the writer stops.
- `docs/knowledgebase/hook-api-versioning.md:71,77,631-674` — OKF snapshot from hook 2.26.0, metadata from 3.1.0.
- `docs/knowledgebase/test/index.md` → `scenarios.md`, `contract-tests.md` — the suites.
- User docs: `user-docs/okf-tab.md` (271 lines; headings for sections A/B, Checks, Article drill-down, Actions, Upkeep, Thresholds, "No OKF analysis yet"; images `images/okf-kb-value.png` and `okf-kb-value-heuristic.png`) and `user-docs/tuning-your-setup.md:43-51,114` (OKF thresholds; anchor `okf-tab.md#thresholds`). `client/public/help/*.md` is generated by `npm run build:help`.

## Existing patterns

**Server — routes and service** (`ce search "okf-usage" -k Endpoint` returned five routes)
- `server/src/logs/repositories.controller.ts:1515` — session `okf-usage` (kept); scope via `resolveChangeSurfaceSessionScope`, empty response for an invisible session. `:1574` — the `trail` route (remove).
- `server/src/logs/reports/reports.controller.ts:366` — repo `okf-usage` (kept; `resolveUsageScope`, `bundle` param). `:413` — the `article` route (remove). Both call `resolveOkfThresholds` / `okfCanRecompute`, which go.
- `server/src/logs/okf/okf-usage.service.ts` (2369 lines) — loaders to reuse:
  - `findSessionDbId` :746
  - `loadTreeNodes` :1932 (descendants with rows)
  - `loadRootSnapshot` :2009
  - `loadRepoTreeRows` :2027 (rows per root and node)
  - `loadRootSnapshots` :2302 (body and `created_at` per root)
  - `buildRepoView` :1214 (reference-snapshot choice :1229-1239, team filter :1275, bundle select :1281, row classification by `bundleOfPath` :1297)
  - To remove: `getSessionOkfTrail` :1067, `getRepoOkfArticle` :1687, the signal loaders :2104-2300.
- `server/src/logs/okf/okf-usage.types.ts` — response types, mirrored by hand in `client/src/models/repositories.ts:918+`. `OkfFactsResponse` / `OkfFactsSeqItem` (:372-412) must stay as is.
- `server/src/logs/analytics/scoped-sessions.sql.ts:163` `loadScopedRootSessions` — the root set (M). Requires an `artisyn` log with `first_prompt`, a `claude` log and `deleted = false`; carries `branch` (`l.git_branch`), `userId`, `startTime`. The Sessions list route uses the same predicates (`repositories.controller.ts:623-640`) but takes only `branch`, `attr` and `otelReason`, with no date or users parameters.

**Server — helpers imported from `okf-verdict.ts` by kept code**
- `bundleOfPath` :216 — used by `okf-facts.service.ts:43`.
- `bundleArticles` :392 — used by `okf-metadata.ts:19`.
- `isDotPathUnderRoot` :191 — used by `okf-snapshot.ts:19`.
- `isReservedOkfName` :206, `OkfVerdictRow` :68 (type used by `okf-usage-tree.ts:31`), private `normaliseRoot` / `isUnderRoot`.
- `HOT_FILES_TOP_N`, `READ_TOP_N`, `TASK_HEAD_MAX_CHARS` — used by `repositories.service.ts:88-92` for `OKF_FIXED_LIMITS`.

**Server — team filter and metadata**
- `server/src/logs/okf/okf-usage-tree.ts:124` `applyOkfTeamFilter` (kept; a snapshot-less tree contributes nothing; ignored bundles and files are dropped) and the path helpers :36-56. `buildOkfTree` :484 carries markers and value signals and needs a rewrite or replacement.
- `server/src/logs/okf/okf-metadata.ts` — `hasHookMeta` :57 (the old-hook test), `okfVersionHint` :67, `articleMetaFlags` :160 (needs `refMs`: session start on the session route, now on the repo route), `OKF_CURRENT_FORMAT_VERSION` :22.

**Server — writer, facts and settings**
- `server/src/logs/okf/okf-access-writer.ts:277` `rebuildSessionOkfAccess` — writes access, events, pointers and the marker; `writeOkfExtractMarker` (:266) must stay. `loadSnapshotForNode` :75 is also used by the trail.
- `server/src/logs/okf/okf-facts.service.ts:364,414` — builds `accessSeq` from `extractOkfDetail(...).seq` on the stored transcripts. A grep shows the only SQL readers of `session_okf_event` / `session_okf_pointer` are `okf-usage.service.ts:2136-2264` (to be removed) and the delete path in `sessions.service.ts:239-245`. So the facts route does not read those tables and the writer can stop filling them (FR-8 condition met).
- `loadOkfNodeTranscripts` (`okf-facts.service.ts:224`) stays for the facts route.
- `server/src/logs/repositories.service.ts`:
  - `okfDefaults` / `okfFixedLimits` in `RepoSettingsResponse` (:112-139, :704-708)
  - `resolveOkfThresholds` :723, `okfCanRecompute` :757
  - `validateOkfThresholds` on save :1060
  - `sameConfigIgnoringOkf` :145, used at :1171 and :1232
  - `recomputeOkfAccess` :1655 (kept)
- Cost data per node: `session_stats.input_tokens`, `cache_write_tokens`; `session_costs.cost_input`, `cost_cache_write_5m`, `cost_cache_write_1h`, `cost_cache_read`, with `cost` NULL when unpriced (`docs/knowledgebase/db_state.sql:927`, `:1085`).
- Modules that become removable: `okf-verdict.ts` (after the helpers move), `okf-value-signals.ts`, `okf-thresholds.ts`, `okf-trail.ts`, with their specs `okf-verdict.algo.spec.ts` and `okf-value-signals.algo.spec.ts`; and the constants `OKF_TRAIL_MAX_ITEMS`, `OKF_TOP_PATTERNS`, `OKF_SEARCH_FOLDER_MIN_DEPTH`, `OKF_CODE_ROOTS_MAX` in `okf-constants.ts`.

**Client**
- `client/src/viewer/pages/repository/okf/RepoOkfTab.tsx` — query keyed by filters, filter strip, loading / error / empty states; test ids `repo-okf-tab`, `okf-empty`, `okf-error`, `okf-loading`.
- `okf/OkfFilterStrip.tsx` (305 lines; kept, minus the Bytes/Calls toggle).
- `okf/okf-url-state.ts` — `okfFiltersFromParams` / `writeOkfFilters` kept. To remove: `OKF_ARTICLE_PARAM` :83, `OKF_AGENT_PARAM` :115, `okfSessionTrailParams` :138, `OKF_THRESHOLDS_FOCUS` :156, `okfThresholdsSettingsParams` :165.
- `okf/OkfHotFiles.tsx` — the current hot list (clickable rows, bytes, yield); to be rewritten as a sortable table.
- To delete in `okf/`: `OkfAnalysisCoverageBanner`, `OkfKpiTiles`, `OkfNotReadList`, `OkfShareHistogram`, `OkfSignalFindings`, `OkfUpkeepPanel`, `RepoOkfOverview`, and the `article/` folder.
- `client/src/viewer/pages/repository/session-log/okf/` — keep or rework `SessionOkfTab.tsx`, `SessionOkfStates.tsx` (`EmptyState`, `LoadingSkeleton`) and the tree files (`OkfTree.tsx`, `okf-tree.ts`, `okf-tree-rows.tsx`, `okf-tree-columns.tsx`, `okf-tree-meta-chips.tsx`) as the base for the explorer. The rest goes: trail, agents panel, bundle cards, checks, finding line, miss check, read top, section, thresholds chip, value-signal files, verdict card.
- `client/src/viewer/lib/okf/` — `okf-action-text.ts`, `okf-check-text.ts`, `okf-verdict-text.ts`, `okf-agent-label.ts` all become unused.
- Settings: `OkfThresholdsSection.tsx`, `OkfCodeRootsInput.tsx`, `okf-thresholds-form.ts`, wired in `RepositorySettings.tsx:26-29,161-171,360-366`. Types `okfDefaults` / `okfFixedLimits` in `viewer/api.ts:1399-1406`; fetchers `fetchSessionOkfTrail` :865 and `getOkfArticle` :932.
- `useRepositoryViewState.ts:13,154-172,198-199,216,264-266` — the `OKF_AGENT_PARAM` handling to drop; the `okf*` param cleanup on leaving the tab stays.
- Sortable header pattern (`aria-sort`): `reports/HarnessUsageTable.tsx`, `reports/BranchSummaryReport.tsx`, `tools/ToolsTree.tsx`.
- Formatters: `viewer/lib/format.ts:73` `formatCost` (4 decimals), `:78` `formatTokens` (1 decimal for both K and M, plain number below 1000), `spend/spend-format.ts:134` `formatPercent` (whole percent). None matches the wireframe formats.
- Lazy chunks: `repository-tabs-lazy-group.ts:12`, `session-tabs-lazy-group.ts:10`. No new chunk is needed.
- There is no client `*.algo.test.ts` for OKF.

**Tests — algorithm**
- `docs/algorithm-examples/okf-metadata.json` — 33 rows; spec cases `versionHint`, `staleAfter`, `flags`, `summary`.
- `okf-snapshot.json` — 31 rows, hook test `hook/.claude/telemetry_tool/__tests__/okf-snapshot.algo.test.js`.
- `okf-access-extraction.json` — 38 rows; `okf-task-context.json` — 18 rows.
- `okf-verdict.json` — 47 rows (24 session, 23 repo), to delete. Rows that today cover kept helpers: RV-12 / RV-13 (team filter), RV-14 (deepest bundle), OV-22 / OV-23 / RV-23 (reserved names and dot paths), OV-16 (index is not an article).
- `okf-value-signals.json` — 16 rows, to delete; its spec also tests `buildOkfTrail`.

**Tests — contract** (`server/test/contract/registry/`)
- `f19-change-surface.ts` — session route rows `F19-okf-session` :364, `-agents` :426, `-signals` :473, `-team` :524, `-meta-tree` :543, `-meta-tree-team` :560, `-none` :578, `-outsider` :620; trail rows `F19-okf-trail*` :631-667 (delete).
- `f21-reports.ts` — `F21-okf-usage` :391, `-hot-files` :467, `-bundles` :601, `-outsider` :638; article rows `F21-okf-article*` :652-769 (delete).
- `f14-repositories.ts` — `OKF_DEFAULTS` / `OKF_FIXED_LIMITS` :31-53 in every settings expectation, `F14-put-user-settings-okf` :422, `F14-put-team-settings-okf` :465, `F14-put-user-settings-okf-invalid` :498 (currently 400; must become 200).
- `f16-post-turn.ts:393-450` — `F16-okf-facts*`, unchanged, with `accessSeq` `[]`.
- `f15-ingest.ts:312-435` — snapshot upload rows, unchanged.
- `f23-export-import.ts:271-290` — recompute expects `session_okf_event` / `session_okf_pointer` rewritten and `okf_extract_version = 4`.
- Fixture `fixtures/world-v1.sql.ts:501` (snapshot body, `okfVersion '0.2'`), :2147-2251 (access, event and pointer rows). Costs are filled by `setup/world-session-costs.ts`.

**Tests — scenarios** (`tests/scenarios/`)
- `repos/s-repo-16.spec.ts` `@S-REPO-16` (mode a) — the main OKF scenario:
  - steps 7–11: team vs personal, recompute, bundle filter;
  - steps 12–16: value signals, article drill-down, thresholds chip and Settings (:653-676), trail;
  - step 17: v0.3 chips.
- `view/s-sess-09.spec.ts` `@S-SESS-09` (a, c) — steps 7–12, session OKF tab, verdict, trail.
- `view/s-rept-01.spec.ts` `@S-REPT-01` (a, c) — steps 8–10, repo verdict card and tiles; five trees, 2 on `main`, 3 on `feat/okf`.
- `hook/s-compat-01.spec.ts` `@S-COMPAT-01` (a, c) — steps 10, 11, 11b: old hooks, "partial data", `okf-empty` "No OKF knowledge base".
- `hook/s-hook-01.spec.ts` `@S-HOOK-01` step 4b and `hook/s-hook-09.spec.ts` `@S-HOOK-09` step 4b — hook side, unaffected.
- `repos/s-repo-09.spec.ts` `@S-REPO-09` — export / import; step 5a asserts event and pointer rows survive, step 9 their deletion.
- `repos/s-repo-11.spec.ts` `@S-REPO-11` steps 17–19 — snapshot binding on import.
- `view/s-sess-01.spec.ts:236` — summary card `okf`.
- Tours: `tours/screen-registry.ts:626-636,759-768` (expects `repo-okf-tab`, `session-okf-tab`, empty text "No OKF knowledge base", docRef headings "Repository OKF tab" / "Session OKF tab" in `okf-tab.md`); `tours/tour-04-analytics-reports.spec.ts:113` (expects `okf-verdict-card` or `okf-empty`).
- Helper `helpers/okf.ts` — `uploadOkfSessionTree` (snapshot spec with `meta`, `okfVersion`, `snapshot: null`, sub-agents, branch), `expectOkfTreeFits` :427 (viewport resize pattern).

## Open gaps

1. **Default branch.** No notion of a repository default branch exists in the server, DB, hook or client (a grep for `default_branch`, `defaultBranch`, `origin/HEAD`, `symbolic-ref` returned nothing). The snapshot body carries no branch; only `logs.git_branch` of the root is known. The plan must define the rule (for example `main` / `master` by name, or the most frequent branch) and its fallback.
2. **T, "the Spend tab's total under the same filters".** The Spend tab has no date-range, branches, users or attr filters and uses another root set and max(hook, OTEL) cost. Equality with the tab's own filters is not obtainable as written. The plan must define T (most likely the `readTreeCost(...).total` sum over the M roots via `treeCostCtes`), what "unknown" means when any tree is unpriced, and what the AC compares against.
3. **M versus the Sessions tab.** The predicates match, but the Sessions list route takes no date or users parameters. The AC needs a concrete comparison point.
4. **Cost inputs.** No existing query returns per-node `session_stats` tokens with `session_costs` components; it needs a new SQL over `descendantSessionsCte`. Still to decide: handling of `stale` costs, nodes with a zero denominator, and whether the OTEL-only guard applies.
5. **New home for the helpers and their rules.** `bundleOfPath`, `bundleArticles`, `isReservedOkfName`, `isDotPathUnderRoot`, `OkfVerdictRow` and `applyOkfTeamFilter` are documented and row-tested only through `okf-verdict`. The FR-0 counting and FR-5a cost rules have no algorithm doc. The AC lists only four remaining docs, so either one of them absorbs these rules and rows, or they are left to contract and scenario coverage.
6. **Snapshot-less sessions in the team view.** `applyOkfTeamFilter` zeroes every tree without its own snapshot, while FR-0 classifies rows against the reference snapshot. The personal-view behaviour for old-hook sessions and the team-view N need an explicit rule.
7. **Stored glob paths.** The current extractor reduces globs to a static prefix, but rows from older extract versions may hold glob characters. FR-0 needs a read-time filter.
8. **Response shape.** `files[]`, folder-search rows, versions, format groups, totals, the "reads without cost" count, snapshot `branch` — and whether old fields (`verdict`, `tiles`, `tree`, `hotFiles`, …) are removed outright (FR-7) although older clients read them.
9. **Settings PUT.** FR-8 says the stored `okf` is "kept untouched", but today's client does a read-modify-write of the whole config. Whether the server preserves the stored section when the body omits it, and what happens to `sameConfigIgnoringOkf`, must be decided. Contract row `F14-put-user-settings-okf-invalid` flips from 400 to 200.
10. **"Scenario step on the corpus repo" (non-functional AC).** The corpus set `tests/corpus/sets/2026-10_cc-2.1.280` has 0 `okf-snapshot` lines in its three hook files, is gitignored and is skipped when absent; the golden tour repo has no snapshot either. Under FR-5 the tab there is the one-line "No KB snapshot", so the 1600×1000 check needs another repo (for example the S-REPO-16 data) or new corpus data.
11. **"Upload from hook 2.26" (FR-8 AC).** Frozen hooks exist only for 1.6.2, 2.6.1, 2.28.0 and 2.32.3 (`tests/fixtures/legacy-hooks/`). The nearest is 2.28.0 in S-COMPAT-01; 2.6.1 sends no repo root, so it stores no rows.
12. **Which scenario is "the existing OKF scenario".** OKF steps live in S-REPO-16, S-SESS-09, S-REPT-01 and S-COMPAT-01, plus the tour expectations. All assert removed UI and need cutting, not only one file.
13. **Token and money formatters.** No shared formatter gives "3.77M / 270K / 55.0K / 0.6K", "$52.61", "< $0.01", "$3,017" or "≈ 1.7 %" / "< 0.1 %". The requirement's `/4` also differs from the client's `BYTES_PER_TOKEN = 3.5`; a new local constant should not reuse that one.
14. **Hot-files tie-break and sort state.** The secondary sort order, and whether the sort or the explorer filter lives in the URL, are not specified.
15. **Branch state.** Requirements say the task sits on top of the merged `2026-11-19-okf-v03-support`; the working branch is `feature/2026-11-19-okf-v03-support` and `main` (2262ffa) does not contain it yet.
16. **Explorer details not specified.** Order of roots and rows; whether a root-level "searches across this folder" row exists for a bundle root; how the `bundle` filter affects the M, N and T totals.
17. **Not opened during this research.** `OkfFilterStrip.tsx`, `SessionOkfTab.tsx`, the tree files and `OkfThresholdsSection.tsx` were located and sized but not read line by line; the same goes for the body of `user-docs/okf-tab.md` and the two images it references.

`open_questions_ru.md` and `notes.md` hold no decision that is missing from `requirements.md`. Both answered questions are already reflected: grep counts as a read (FR-0), and no agent → files list on the session tab ("Common sense considerations").
