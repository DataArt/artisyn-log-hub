# Research findings — 2026-11-03-okf-view-kb-value (pass 1, 2026-11-03)

## Requirements summary
GH-88 adds read-time "value signals" to the session and repo OKF tabs, each with a client-side action text, so a person can see which KB file to change and how. The signals are:
- **FR-1 pointer yield**
- **FR-2 searched after reading**
- **FR-3 routing miss**
- **FR-13 dead pointers**
- **FR-14 search patterns**
- **FR-15 catalog**
- **FR-16 action text for every finding**

It also fixes the misleading signals:
- **FR-4:** section reads (offset/limit, `sed -n`, `head`, `tail`) leave the `coarse_article` ratio.
- **FR-5:** reads by an agent that also edits the article are upkeep and are excluded.
- **FR-6:** the share histogram gets the `shareMinBundleFiles` guard.
- **FR-7:** `kb_flood` needs at least `floodMinSessions` sessions to change the verdict.
- **FR-8:** `entry: search` needs a real hit; `ls <file>` gives no folder row.
- **FR-9:** multi-file reads split bytes by snapshot size.
- **FR-10:** stale findings are judged by article hash.
- **FR-11:** a "no OKF analysis yet" share, with a per-session marker.

The rest:
- **FR-17:** all thresholds move into an optional `RepoConfigJson.okf` (personal or team, applied at read time).
- **FR-12:** the facts route gets additive per-agent ordered access sequences, patterns and new pointers.
- **Storage:** additive tables `session_okf_event` and `session_okf_pointer`, ranged counters on `session_okf_access`, and the per-session marker.
- Hooks do not change, there is no LLM, and older clients and skills keep working.

## Wireframes
- **`real-1-repo-overview.svg`:** the verdict card gets a "default thresholds ⚙" chip and the subtitle "126 KB sessions of 213 · 7 upkeep-only excluded". Findings are listed worst first, each with a "→ action" line. Info line: `kb_flood` below the minimum. KPI tiles: KB files, not read, sessions that touched the KB (+ upkeep-only), median article share, pointer yield (k of n reads), articles with routing misses (+ pair count). The tree gets new columns YIELD "k / n", EXPL. AFTER "agents · searches" and ROUTE MISS "X / Y", and markers `routing miss`, `§ section reads ×N`, `catalog N`, `N dead`, `upkeep ×N`, `stale · now X KB`, `not read`. Below the tree are a column legend, the histogram (bundles of 10+ files only, kb-local skipped), hot files with a Yield column, and a new "Upkeep" panel (article · sessions · bytes). There is also the FR-11 info banner.
- **`real-2-article-routing-miss.svg`:** a new article drill-down screen opened from a tree row, with a "← back to the tree" link.
  - **Header:** size, hash status, chips, and a read summary (section / whole / upkeep excluded).
  - **Value signals strip.**
  - **Pointer table:** "followed / shown", the first 17 rows, then "… N more · Show all".
  - **Routing-miss block:** "29 of 33", the top 5 patterns with counts, the most-searched files and the action. A "same finding on other articles" list and a table of the missing agents (session · agent · task head · search count, with the task head masked by the existing rule) complete the screen.
- **`real-3-article-catalog-dead-pointers.svg`:** the drill-down for the catalog and dead-pointer case.
  - **Pointers:** listed dead first.
  - **Actions:** separate blocks for dead pointers and for catalog.
  - **Stale example:** a VERSIONS (git, size) list that implies a size history per hash.
  - **Comparison table:** "dead pointers on other articles" (article · dead / followed · reads).
- **`real-4-session-okf-tab.svg`:** the session tab.
  - **Verdict and read list:** the verdict subtitle states that upkeep is excluded; Read top 5 gets `§ section ×N` chips and an "Upkeep" line.
  - **Value signals tile:** whole tree.
  - **Tree:** columns POINTERS USED and EXPL. AFTER; an expandable row lists each agent's pointers, ✓ for followed, plus "N paths already named in its prompt". Unread articles get "routing miss · N searches" rows carrying the action.
  - **Agents panel:** per agent its yield, routing misses, upkeep and search count.
- **`real-5-settings-okf-thresholds.svg`:** an "OKF thresholds" block in Settings.
  - **Table:** SETTING / DEFAULT / VALUE / WHAT IT AFFECTS / **ON THIS REPO (live hint)**, split into the verdict group and the value-signal group, with CODE_ROOTS as a list.
  - **Fixed limits:** a "Not settings" footer.
  - **Buttons:** **Save for this repo**, **Reset to defaults** and **Copy from team settings**, with the note "Saving writes only the fields that differ from the default".
  - **Chip preview:** "custom thresholds", whose hover lists the fields that differ.
  - The live-hint column, the "Copy from team settings" button and the diff-only save are in the wireframe but not in the FRs (see Open gaps).
- `repo-okf-tab.svg` and `session-okf-tab.svg` are early concept drafts that the `real-*` wireframes replace.

## Knowledgebase
- **`docs/knowledgebase/okf-usage.md`**
  - Data flow: hook snapshot → bind → extraction → read side.
  - Writers are called from ingest (Step 3b'), import, the heal (`rewriteSessionTreeFileStats`) and recompute (`recomputeOkfAccess`).
  - Team filter `applyOkfTeamFilter` runs before the verdict and fails closed.
  - Delete step c2 in `purgeSessionChildData`; export/import; the backward-compatibility table.
  - Must be updated with the new tables, signals and routes.
- **`docs/knowledgebase/algorithms/okf-access-extraction.md`** (rows in `docs/algorithm-examples/okf-access-extraction.json`, 23 rows OA-01…OA-23)
  - Rule 4 says Read `offset/limit` is ignored and rule 8 is the even split; FR-4 and FR-9 rewrite them.
  - `expected.rows` must match exactly, so the existing rows need the new counter fields.
  - The test harness builds `tool_result` from `result` or `resultBytes`, so pointer rows can use `result` text.
- **`docs/knowledgebase/algorithms/okf-verdict.md`** (rows in `docs/algorithm-examples/okf-verdict.json`, 30 rows OV/RV)
  - The DD-23 constants become config. RV-09 ("1 of 20 → fix") contradicts FR-7 and must change.
  - The wireframe says the threshold calibration is recorded here.
- **`docs/knowledgebase/algorithms/README.md`:** the required sections for the new algorithm doc `okf-value-signals.md` and its rows file.
- **`docs/knowledgebase/algorithms/bash-command-view.md`** (rule 5.9 `readAccess`): FR-4 ranges and FR-14 patterns are additive fields in `@loghub/bash-view`. Also `docs/knowledgebase/repo-local-packages.md` for the package rules.
- **`docs/knowledgebase/db-tables.md`:** sub-agents reach their repo and snapshot through the root (`topAncestorIdsSql`). `workflow_run_id` mirrors `parent_session_id`, so Workflow sub-agents are ordinary tree nodes. `tool_usage_version` is the precedent for a per-session rebuild marker.
- **`docs/knowledgebase/client-component-map.md`** (lines 83, 120, 163): the OKF folders. A new drill-down folder or component may need a map line.
- **`docs/knowledgebase/test/scenarios.md`** and **`docs/knowledgebase/test/contract-tests.md`:** the scenario stand and the contract registry rules.
- Skills to follow: `migrations-data-integrity`, `db-state-update` (regenerate `docs/knowledgebase/db_state.sql`) and `ui-components`.

## Existing patterns
**Extraction and writing**
- **`server/src/logs/okf/okf-access-extractor.ts`:**
  - `:180`: the Read case to extend with `offset`/`limit`.
  - `:217-229`: Bash `readAccess` handling to extend for code events and patterns.
  - `:146`: `isStoredKey` (`.md` only) — code events must bypass it.
  - `:319-328`: the DD-2 even split, replaced by the FR-9 size-proportional split.
  - `:331-361`: the `ownWritten` walk is after-edit only; FR-5 needs "writes this article anywhere in the node".
  - `:272-285`: the result pass keeps bytes only; it must also keep the text for pointers and the persisted/empty/error partial check.
- **`server/src/logs/okf/okf-access-writer.ts:25-79`:** the delete-then-insert writer with `onConflictDoUpdate`. Copy it for `session_okf_event` and `session_okf_pointer` and set the marker here. The bound snapshot must be passed in for the FR-9 sizes and `article_hash`.

**Read side and response shapes**
- **`server/src/logs/okf/okf-usage.service.ts`:**
  - `:352` `getSessionOkfUsage`, `:482` `getRepoOkfUsage`.
  - `:495-505`: latest snapshot = the bound snapshot of the newest root (reuse for FR-10).
  - `:614-623`: the histogram's best share has no guard (FR-6).
  - `:640-675`: hot files.
  - `:450`: `maskFirstPrompt` (task heads are masked; patterns must not be).
  - `:133` `normaliseSnapshot` — snapshot files already carry `hash` and `size`.
- **`server/src/logs/okf/okf-verdict.ts`:**
  - `:22-51`: the constants, to become settings.
  - `:300` `computeSessionVerdict`, `:371` `computeRepoVerdict`.
  - `:429`: `flooded > 0` (FR-7).
  - `:445+`: `coarse_article`.
- **`server/src/logs/okf/okf-usage-tree.ts`:** `applyOkfTeamFilter` and `buildOkfTree` with markers. New markers (`routing_miss`, `catalog`, `dead`, `upkeep`, `stale`, `section`) go in `OkfTreeMarker`.
- **`server/src/logs/okf/okf-usage.types.ts`:**
  - `:17` `OkfFindingRule`, to extend with `routing_miss`, `searched_after`, `dead_pointers`, `catalog`, `stale`, `not_read`.
  - `:23` `OkfFindingSeverity` has only `fix` and `mess`; FR-7 and FR-15 need `info`.
  - `:67` `OkfTreeNode`, `:126` `RepoOkfUsageResponse`, `:158` `OkfFactsResponse`.
  - Every addition must also go into the client mirror `client/src/models/repositories.ts:859+`.
- **`server/src/logs/okf/okf-facts.service.ts`:** `:79` `collectNodeFileFacts` and `:223` `getFacts`. It already re-parses transcripts with `extractOkfAccess` (`:280`); add `seq`, `events` and `pointers` per agent next to `otherReadsTop` (`:325`).
- **`packages/bash-view/src/bash-analyze.ts`:**
  - `:78-81`: `GREP_CMDS` (grep, rg, ag, egrep, fgrep) and `LIST_CMDS` (ls, find, tree, dir).
  - `:85` `BashReadAccess {path, kind}` — add optional `range` and `pattern` here.
  - `:272`: the `sed` branch; `:36`: `head`/`tail` listed.

**Config and settings**
- **`server/src/database/schema/index.ts`:**
  - `:1416` `RepoConfigJson`: follow the optional `highCacheCreationThreshold` / `turnEndCostAdvisor` pattern ("absent = constant, no migration").
  - `:1728` `sessionOkfAccess` table; `:156-180` `sessions.okfSnapshotId` and the `toolUsageVersion` marker with partial indexes.
- **`server/src/logs/repositories.service.ts`:**
  - `:637` `resolveEffectiveConfig`: whole-object resolution — a personal row wins entirely, with no per-field merge.
  - `:714` `validateConfig`; `:772-809`: the validation pattern for the optional fields.
  - `saveTeamConfig` (`~:970`) and `saveUserConfig` (`~:1030`) both call a full recompute (`recomputeTeamScope` / `recomputeForRepo`) after saving.
  - `:1468-1520` `recomputeOkfAccess`.
- **`server/src/logs/repositories.controller.ts`:**
  - `:490` `GET :repoId/settings`, `:508` `PUT settings/team`, `:528` `PUT settings/user`.
  - `:2108-2133` `recompute-all-sessions`: the team view needs the team owner (`isTeamOwner`); the personal view needs the repo owner.
- **`client/src/viewer/pages/repository/RepositorySettings.tsx`:**
  - `:129-180`: the read-modify-write save helpers `withSavedAnalysisSettings`, `saveThreshold`, `saveTurnEndCostAdvisor`. Reuse them for `okf`, and every other save path must carry `okf` through unchanged.
  - `:308-346`: the "analysis" tab content, where the OKF block fits.
  - `:127`: `readOnly = isTeamView && !canEditTeam`.
- **`client/src/viewer/pages/repository/MaintenanceSection.tsx:3,32`:** the `recomputeAllSessions(repoId, teamId)` call and its `readOnly` gating — reuse for the FR-11 link.

**Client rendering**
- **`client/src/viewer/lib/okf/okf-verdict-text.ts:82`:** `formatOkfFinding`, a switch on rule id with a raw fallback. Add an `okfActionText` beside it for FR-16.
- **`client/src/viewer/pages/repository/okf/`:** `RepoOkfTab.tsx` (7.8 KB), `OkfKpiTiles.tsx`, `OkfHotFiles.tsx`, `OkfShareHistogram.tsx`, `okf-url-state.ts` (holds the `okf*` URL params; a drill-down article selection would go here). `OkfFilterStrip.tsx` is already 10.1 KB.
- **`client/src/viewer/pages/repository/session-log/okf/`:** `SessionOkfTab.tsx` (8.3 KB), `OkfVerdictCard.tsx` (7.5 KB, where the "custom thresholds" chip goes), `okf-tree-rows.tsx` (6.4 KB, new columns), `OkfAgentsPanel.tsx`. Watch the 10 KB / 20 KB component-size limits.

**Lifecycle**
- **`server/src/sessions/sessions.service.ts:224-228`:** step c2 deletes `session_okf_access` explicitly (a soft delete does not cascade). Add the new tables there; `:265` clears `okfSnapshotId`.
- **Migrations:** the latest is `server/drizzle/migrations/0084_schema_comments.sql`, so the next is `0085_*`, plus `meta/_journal.json` and `npm run migrations:lock`. The OKF precedent is `0075_okf_usage.sql`.

**Tests**
- **Algorithm tests:** `server/src/logs/okf/okf-access-extractor.algo.spec.ts` and `okf-verdict.algo.spec.ts` are the table-test templates; the new one is `okf-value-signals.algo.spec.ts`.
- **Contract rows:**
  - Repo OKF route: `server/test/contract/registry/f21-reports.ts:338-440` (`F21-okf-usage`, `-hot-files`, `-outsider`).
  - Session OKF route: `f19-change-surface.ts:65`.
  - **The facts route rows are in `f16-post-turn.ts:394-444`, not f21.**
  - Settings: `f14-repositories.ts:178-357`.
  - Recompute: `f23-export-import.ts:254-335`.
  - The OKF fixture data is in `server/test/contract/fixtures/world-v1.sql.ts`.
- **Scenarios:**
  - `tests/scenarios/repos/s-repo-16.spec.ts:194-334` holds steps 7–11 (`okfSid`, `okfRowCount` by SQL, team vs personal pages, the recompute step at `:296`).
  - **Helper limits:** `tests/scenarios/helpers/okf.ts:62` `OkfAction` supports only `read` (with `bytes`), `grep` (a folder, no pattern) and `edit`. It needs result text with pointers, Grep `pattern`, Read `offset`/`limit` and a sub-agent prompt naming paths. `agentTranscriptLines` is at `:199`.

## Open gaps
1. **FR-13 "path not found":** the OKF snapshot (`OkfSnapshotFile`) lists only bundle `.md` files with path, ignored, size and hash, and nothing in `server/src` or `hook/scripts` lists the repo's code files. With no hook change allowed, decide on a proxy: for example "no code event in the whole scope ever touched the path or anything under it", or drop the mark.
2. **"No recompute needed" versus the settings save:** `saveUserConfig` and `saveTeamConfig` always run a full derived-stats recompute. Decide whether to skip it when only `okf` changed, or add a separate save path; otherwise the contract rows change.
3. **Per-field versus whole-object resolution:** `resolveEffectiveConfig` returns the personal row whole, so a personal row without `okf` hides the team's `okf`. FR-17's "personal → team → default" either needs a per-section fallback for `okf` or must accept today's behaviour. The wireframe's "Copy from team settings" assumes the two scopes are separate.
4. **Wireframe items not in the FRs:**
   - the "On this repo" live-hint column in Settings (it needs a preview endpoint);
   - the "Copy from team settings" button and the diff-only save;
   - the git version history per article in real-3;
   - a "most searched files" list in real-2.

   The plan needs to decide to build or drop each.
5. **Article area over all reads, not only the period:** `loadScopedRootSessions` is filtered by period. A second, date-free query is needed (with branch, user and team scope still applied?), and it must stay inside the response-time budget.
6. **FR-9 snapshot at extraction time:** the extractor and writer get no snapshot today. The writer must load the root's bound snapshot, and when the snapshot binds after the transcript (the heal or a later upload) the split falls back to even. Decide whether binding a snapshot later should trigger a re-extract.
7. **No `info` severity yet:** `OkfFindingSeverity` has only `fix` and `mess`. New values `info` and `stale`, and new rule ids, break exhaustive switches and older clients; check that older clients fall back to the raw-params display (the client already does for unknown rule ids).
8. **Code events from Bash:**
   - bash-view puts `find` in `LIST_CMDS`, while FR treats `find`/`ls` as search;
   - bash-view stores no pattern argument;
   - it is unclear whether `git grep` reaches `readAccess` at all (`git` is a sub-command tool);
   - "build output" exclusions need a defined list.
9. **Pointer extraction is new code:** back-ticked path regex, `:line` stripped, glob reduced to its prefix, the "new pointer" rule over all earlier node text (user, assistant, `system-reminder`, earlier results), and partial detection (`<persisted-output>`, empty after trim, `is_error`). There is no existing helper beyond `resolveRepoPath`/`toAbsolute`.
10. **Sub-agent read versus main-agent miss (FR-3):** this needs per-node identity in the read-side aggregates. Workflow agents are normal tree nodes through `parent_session_id`/`workflow_run_id` (db-tables.md), so the requirements' "workflow/ folder without a root" worry looks resolved on the server side; confirm with an ingest check of a Workflow transcript.
11. **Drill-down API:** no FR names a route or response shape for the per-article drill-down (pointer list, agent list, patterns). Decide between extending the repo `okf-usage` response and adding a new `…/okf-usage/article?path=` route, which would need a contract row.
12. **FR-11 marker:** decide the column (a nullable smallint version like `tool_usage_version`, or a timestamp) and whether `initializeDatabase()` should re-queue, which would collide with "only through recompute-all-sessions".
13. **Rows that will change:** OA-01 and the other `okf-access-extraction` rows (new fields in exact `expected.rows`), RV-09 for FR-7, and possibly RV-11.
