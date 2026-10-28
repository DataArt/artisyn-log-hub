## OKF usage tab: context for the implementation plan

### Requirements summary
The feature reports how a repo's OKF knowledge-base bundles are used, per session tree and per repository, without any LLM.

- **Phase 1, server.** At ingest of `claude` / `claude-subagent` logs, extract `.md` accesses at file level only (read, grep, list, write) using the existing session analyser (`analyzeBash` plus the Read/Edit/Write/Grep/Glob inputs). Store `tool_result` bytes; a multi-file Bash call splits its bytes evenly across its files. Paths are normalised against the repo and worktree roots, and anything unresolvable is not stored.
  - New table `session_okf_access`, one set of rows per tree node, with an `after_own_edit` split.
  - Written wherever `writeSessionFileStats` runs. Backfilled through `recompute-all-sessions`.
  - First explain the duplicate Read pairs seen in sub-agent logs (FR-6).
- **Phase 2, hook.** The hook detects every OKF bundle: an `index.md` with `okf_version` in its front matter. A file belongs to the deepest bundle; a nested `index.md` with its own `okf_version` starts a new bundle. Exclusions come from `okf.exclude` and default `tmp/`.
  - Snapshot per file: path, `ignored` (via `git check-ignore --stdin`), size, hash.
  - Content-addressed and delivered exactly like the harness snapshot, only on the root `artisyn` upload. The root session binds to its first snapshot and is never rebound.
  - Mirror the orphan sweep and export/import of harness snapshots.
- **Phase 3, session OKF tab.** A verdict card (OK / fix / mess / KB not used / partial data), why-lines, top-5 reads, how each agent reached the KB, an Agents panel, then bundle cards and a bundle → folder → file tree with read heat (bytes or calls) and write heat, plus info-only markers.
- **Phase 4, repo OKF tab.** Filters: period, branch, user, `attr`, bundle. Verdict plus anomalies, with three rules: `always_read`, `kb_flood`, `coarse_article`. Tiles, a file-share histogram, hot files, an info-only "not read" list, and the tree folded into the latest snapshot. The team view filters gitignored paths on the server and fails closed.
- **Routes (FR-18).** The verdict is sent as rule ids plus params, never as text:
  - `GET …/sessions/:sessionId/okf-usage`
  - `GET …/reports/okf-usage` (uses `resolveUsageScope`)
- **Phase 5.** `GET /api/v2/okf-usage/facts`, API-key auth, owner only, returns per-agent facts for the on-demand skill. `analyzeBash` / `buildBashView` move into `packages/`. There is no LLM analysis anywhere in this feature (FR-19).

### Wireframes
- **`wireframes/session-okf-tab.svg`**
  - New session tab "OKF", placed between "Harness usage" and "Raw Logs".
  - Header: "whole session tree (main + N sub-agents) · N bundles" and a Bytes/Calls toggle.
  - Verdict card: badge with OK/fix/mess scale; WHY lines (e.g. "agent 9c1d read 27 % of docs/knowledgebase files (22 of 82)"); READ top 5 by bytes with the ↻ own-edit icon and "+ N more"; HOW AGENTS REACHED THE KB with chips `✓ index` / `grep` / `given`.
  - Bundle cards: tracked or gitignored chip, "✓ started from index.md", FILES READ `28 / 82 · 34 %`, BYTES INTO CONTEXT.
  - Tree columns: READ (bytes), WRITE, MARKERS. Markers: entry point, read by N, `grep -rn over folder ×3`, `↻ own edit ×14`, `grep -n ×4`. "Not read" rows are neutral and sorted last; the gitignored bundle shows "personal view only".
  - Legend; right-hand AGENTS panel (id, how it reached the KB, task head, "N KB files · X into context", click filters the tree).
  - DEEPER ANALYSIS info box pointing to the local skill.
  - FR-14 variant: a warning banner "No KB snapshot … Update the Log Hub hook" with a "How to update" link.
- **`wireframes/repo-okf-tab.svg`**
  - New top-level repo tab "OKF" between Reports and Settings.
  - Filter strip: date range, branches, users (team view), attributes, Personal/Team **view toggle**, bundle select, read heat Bytes/Calls. Note: "Filters apply at once — no Generate button."
  - Verdict card with session count ("49 KB SESSIONS") and an anomaly list with rule chips (always read / KB flood / coarse article).
  - Tiles: KB files (with snapshot date and branch), not read (info only), sessions touched KB `49 / 70`, started from index (info only), median file share (with max).
  - Tree columns: READ (bytes, all sessions), SESSIONS, WRITE, AGENTS. Markers "🔥 hot #1" and "coarse · ~4 KB/read of 161 KB"; a "No longer in KB" group; the gitignored bundle "hidden in Team view".
  - Clicking a node opens a side drawer listing the sessions that touched it. This drawer is not in the FRs.
  - File-share histogram with bins 0–10 / 10–25 / 25–50 / &gt;50; hot files list with "Show all →"; not-read list with "Show all 29 →".

### Knowledgebase
- **`docs/knowledgebase/algorithms/README.md`**
  - One doc per algorithm, each with exactly one `examples` block whose rows are `{id, input, expected, note}`.
  - Required sections: Purpose, Code, Rules, Edge cases, Examples, Mutations, Where visible. Front matter `reviewed` / `reviewer`.
  - Test placement: server `&lt;module&gt;.algo.spec.ts` beside the module; client `*.algo.test.ts` loading the loader via `createRequire`; hook `hook/.claude/telemetry_tool/__tests__/&lt;name&gt;.algo.test.js`.
  - The four new docs (`okf-access-extraction`, `okf-snapshot`, `okf-task-context`, `okf-verdict`) also need a row in that README's table.
- **`docs/knowledgebase/algorithms/harness-snapshot.md`**
  - Pattern for the hook-side snapshot plus its content-only id: sha256 over a sorted canonical projection, never mtime.
  - The server only checks `^[0-9a-f]{64}$` and trusts the id. Twins: none.
- **`docs/knowledgebase/hook-api-versioning.md`**, §§281-349 (`snapshotId` / `snapshotFull` / `unknownSnapshotId`)
  - The real harness param names are `snapshotId`, `snapshotFull=1` and `unknownSnapshotId`. FR-10's `okfSnapshotId`, `okfSnapshotFull` and `unknownOkfSnapshotId` are new parallel names.
  - Behaviour to copy: an invalid id is silently ignored, never a 400. "Known" = a stored row, or a pending/processing/partially_uploaded `upload_queue` row with that id. `unknown…Id` is returned only on single and chunk-complete responses.
  - Hook side: forget/remember/record the snapshot id. Accept the DD-21 race. The doc's compatibility matrix must get a new section for this.
- **`docs/knowledgebase/session-metrics-scope.md`** §3–4
  - Store per node, own transcript only, and roll up at read time with `descendantSessionsCte` / `getDescendantSessionIds` (`server/src/logs/session-tree.sql.ts`).
  - `recomputeAllSessionStats` gathers through `getDescendantSessionIds`, because `log_repositories` links only artisyn logs, i.e. roots.
- **`docs/knowledgebase/change-surface.md`** §6
  - Root rule: two roots, longest case-insensitive match on a `/` boundary.
  - `stripRepoRootPreservingCase` returns `null` outside all roots; `normaliseReadPath` falls back to the absolute path, which FR-2 forbids.
  - Upload-order heal: `rewriteSessionTreeFileStats` reparses the stored `claude` bodies when the artisyn root first arrives. `session_okf_access` keeps no `raw_path`, so it must heal by reparsing, not by renormalising.
- **`docs/knowledgebase/harness-usage-tab.md`**
  - The slash-command shape rule: `&lt;command-message&gt;`-first is a real skill; `&lt;command-name&gt;`-first is a CLI utility such as `/clear`. Reuse it for the `okf-task-context` prompt filter.
- **`docs/knowledgebase/repo-local-packages.md`** — rules for a new `packages/&lt;name&gt;/`:
  - Pure TypeScript, **no dependencies, no Node or DOM APIs**, erasable syntax only, `.ts` relative imports.
  - Server: a `file:` dependency. Client: a Vite plus tsconfig alias (`paths` and `include`). Add a row to the package table.
  - Conflict: bash-view depends on `web-tree-sitter` (WASM). See open gaps.
- **`docs/knowledgebase/algorithms/bash-command-view.md`**
  - Rule 5 (`analyzeBash` file summary: changes / reads / runs / inline / unresolved) is the source for Bash reads and writes.
  - Its Code section lists `bash-parser.ts` (runtime-agnostic loader) and `browser-parser.ts` (Vite-only).
- **`docs/knowledgebase/db-tables.md`**
  - Pattern rows: `sessions.harness_snapshot_id` (COALESCE-bound, indexed, no FK), `harness_snapshots`, `upload_queue.harness_snapshot_id`, `session_file_stats` (not to be reused), and the migration history table.
  - The next migration is `0075_*`.
- **`docs/knowledgebase/data-retention.md`**, "Orphan harness-snapshot cleanup"
  - `purgeSessionChildData()` step g nulls `sessions.harness_snapshot_id`, then step h runs `deleteOrphanHarnessSnapshots(tx)`. Add `okf_snapshot_id` to both steps.
- **`docs/knowledgebase/server-endpoint-map.md`** (lines 278 and 290-291 are the patterns) and `docs/knowledgebase/api-reference.md` — add the three new routes.
- **`docs/knowledgebase/session-export-import.md`** — the export/import format (harness snapshot lines) to extend.
- **`docs/knowledgebase/hook-installation.md`** and `hook/INSTALL_HOOK.md:406-437` — the config key reference; add `okf.exclude`.
- **`docs/knowledgebase/test/scenarios.md`** and **`docs/knowledgebase/test/contract-tests.md`** — test conventions.
- **`docs/knowledgebase/client-component-map.md`** — :139-180 repo view and tab bars, :383-393 the change-surface and harness-usage folders, :544-551 bash-view. Update it for the new components.
- **`docs/knowledgebase/ui-principles.md`** — light-only colour scheme and chart conventions. Not read in detail.

### Existing patterns
**Server** (paths relative to `server/`)
- **Harness snapshot module** (`src/logs/harness-snapshot.ts`) — clone it as `okf-snapshot.ts`:
  - `:29` `HARNESS_SNAPSHOT_MAX_BYTES`
  - `:129-188` `extractHarnessSnapshot`; `:190` `extractHarnessSnapshotRef`
  - `:209` `storeHarnessSnapshot` (`ON CONFLICT DO NOTHING`)
  - `:229-245` `bindSessionSnapshot` (`WHERE … IS NULL`, never rebinds)
  - `:248` `loadHarnessSnapshot`; `:273` `isHarnessSnapshotKnown`
  - `:310-319` `deleteOrphanHarnessSnapshots`
- **Orphan sweep call sites:** `src/sessions/sessions.service.ts:224` (null the column) and `:229` (sweep); `src/teams/teams.service.ts:641`.
- **Non-activity lines:** `src/logs/artisyn-extractor.ts:87-98` `NON_ACTIVITY_LINE_TYPES` (skipped at `:133`). Add `okf-snapshot` and `okf-snapshot-ref` here.
- **Upload controller** (`src/logs/logs-v2.controller.ts`):
  - `:53-54` snapshot query params; `:86-93` silent validation and the full-flag gate for the queue column
  - `:121`, `:228` passed to `saveRawUpload` / `saveChunk`
  - `:128-134`, `:239-249` the `unknownSnapshotId` response field; `:270` `resolveUnknownSnapshotId`
  - `:98` `uploadQueueService.isForeignSession`
- `src/logs/upload-queue.service.ts:18,32,113,183` — queue metadata and the `harnessSnapshotId` column insert.
- **Ingest** (`src/logs/logs.service.ts`):
  - `:579-614` Step 5d store-then-bind; `:616-690` re-read of the bound id
  - `:1068-1081` the same in import (`importSession` `:853`)
  - `:452` ingest Step 3b `writeSessionFileStats`; `:1041` import; `:732` the heal call
- **File-stats writer** (`src/logs/session-file-stats-writer.ts`):
  - `:56-103` `writeSessionFileStats`: per-scope delete-then-insert. `session_okf_access` has no scope; use per-node delete-then-insert.
  - `:211` `rewriteSessionTreeFileStats` (heal, reparses tree bodies; call at `:260`); `:112` `resolveSessionTreeRepoUrls`
- **Recompute** (`src/logs/repositories.service.ts`):
  - `:1647` `writeFileStatsForTree` (call `:1679`), `:1630` `recomputeSessionFileStats`, `:1067` `recomputeForRepo`, `:1280` `recomputeAllSessionStats`
  - Route: `src/logs/repositories.controller.ts:2219-2247` `POST :repoId/recompute-all-sessions`
- **Path helpers** (`src/logs/change-surface/path-normalise.ts`): `:117` `usableRepoRoots`, `:135` `stripRepoRootPreservingCase`; build the FR-2 `string | null` helper on these. Do not use `src/logs/claude-extractor.ts:86-94` `normaliseReadPath` (absolute fallback).
- **Byte counting** (`src/logs/claude-extractor.ts`):
  - `:1391-1403` `computeToolResultBytes` counts UTF-16 `.length`, not bytes, and only for Read.
  - `:612` `bytesOfUtf8` gives true UTF-8 bytes.
  - `:1327-1389` `extractFileStatsByCategory` is the existing Read walk over a transcript.
- **Tree helpers** (`src/logs/session-tree.sql.ts`): `:36-47` `descendantSessionsCte`; `:101` `getDescendantSessionIds` (returns a Map root → descendants).
- **Session route to copy** (`src/logs/repositories.controller.ts`):
  - `:1443` `GET :repoId/sessions/:sessionId/change-surface` (optional `teamId`)
  - `:1511-1549` `resolveChangeSurfaceSessionScope`: `assertRepoAccess` → `resolveRepoIds` → `resolveTeamScope` → `assertSessionVisibleBySessionId`; returns `visibleUserIds`
  - `:1559` `assertSessionVisibleBySessionId`
  - `:1689`, `:1768-1772` a read path that loads the bound snapshot
- **Report route to copy** (`src/logs/reports/reports.controller.ts`):
  - `:294-339` `reports/harness-usage` → `src/logs/reports/harness-usage.service.ts`
  - `:350-389` `reports/change-surface`
  - `:698-750` `resolveUsageScope` → `AnalyticsScope` {teamId, requesterUserId, scope, dates, branches, users, attributeFilters}
  - `:681` `resolveReportScope` (403 when analytics is not allowed in a team view); `:757` `resolveAttributeFilters`
- **API-key hook GET route:** `src/logs/post-turn-analysis/post-turn-analysis.controller.ts:57-119` (`@Controller('api/v2/…')`, `ApiKeyAuthGuard`, `req.userId`). The owner check lives in the services (`src/logs/turn-end-cost-advisor/turn-end-cost-advisor.service.ts:455`, `src/logs/session-attribution/session-attribution.service.ts:212`).
- **Export/import:** `src/logs/repository-export-import.service.ts:938`, `:950-985` (harness line emission), `:1045` (selected id), `:649` (import via `importSession`).
- **Schema** (`src/database/schema/index.ts`): `:143-148,157` `sessions.harness_snapshot_id` and its index; `:167-186` `harness_snapshots`; `:1315-1321` the `upload_queue` column; `:1229-1246` `session_file_stats` (partial unique indexes exist in SQL only).
- **Migrations:** `drizzle/migrations/0073_harness_snapshots.sql` is the template; the latest is `0074_pricing_tiers_session_costs.sql`. Run `npm run migrations:lock` after adding one.
- **Algorithm test pattern:** `src/logs/tool-stats.algo.spec.ts:7-17` (`loadExamples&lt;In,Out&gt;(…)`).
- **Contract registry** (`test/contract/registry/`):
  - `f19-change-surface.ts:26-64` is the GET row template (`id, route, actor, params, expect.bodyMatches, read{sql,args,shape,fields}`).
  - `f15-ingest.ts:76-226` holds the harness snapshot ingest cases; `f16-post-turn.ts` the API-key routes; `f21-reports.ts` the reports.
  - Meta-test: `test/contract/routes.contract-spec.ts:126-189`.

**Client** (paths relative to `client/src/viewer/`)
- **Session tab:** `tab-ids.ts:11-31` `SESSION_TABS`; `pages/repository/SessionTabBar.tsx:44-97` (Change surface `:67`, Harness usage `:68`); `pages/repository/SessionDetailPane.tsx:45-58` lazy imports and the ternary at `:301-380`.
- **Repo tab:** `tab-ids.ts:34-39` `REPO_MAIN_TABS`; `pages/repository/RepositoryView.tsx:47-52` labels, `:350-460` `PageTabs` / `PageTabsContent`, `:98` `canSeeTeamWideTabs`; hardcoded `mtab` list at `pages/repository/useRepositoryViewState.ts:105`.
- **Fetch pattern:** `pages/repository/session-log/change-surface/SessionChangeSurfaceTab.tsx:62` (direct `useQuery` at `:70`/`:75`); `api.ts:702,717,770-787` (`URLSearchParams`, comma-joined); types in `src/models/repositories.ts:656`.
- **Tree with bars:** `pages/repository/session-log/change-surface/change-surface-tree.ts:191` `buildChangeSurfaceTree`; `pages/repository/session-log/change-surface/change-surface-tree-rows.tsx:19,36,60` (`ROW_HEIGHT`, `ChurnBar`, `NodeRow`); `ChangeSurfaceFileTree.tsx:40`.
- **Filters:**
  - `pages/repository/reports/ReportParameterStrip.tsx:80` (`toggleBranch` `:134`, `toggleUser` `:141`)
  - `pages/repository/analytics/DateRangePicker.tsx:21`
  - `pages/repository/reports/report-url.ts:3,32,82,111`
  - `pages/repository/session-list/AttributeFilterPopover.tsx:51` (values from `api.ts:463`)
- **Charts and tiles:**
  - `pages/repository/analytics/ChangeSurfaceBarChart.tsx` and `pages/repository/analytics/ChangeSurfaceChartParts.tsx` (`BandLegend` `:39`, `BucketTooltip` `:104`) for the histogram
  - `components/ChartResponsiveContainer.tsx`
  - `pages/repository/reports/executive-summary/KpiTiles.tsx:80`; `pages/repository/session-log/change-surface/ChangeSurfaceHeadline.tsx:19` `HeadlineCell`
  - `ui/badge.tsx:59`
- **Bash view** (`lib/bash-view/`):
  - `bash-analyze.ts:160` `analyzeBash`; `bash-view.ts:49` `buildBashView`
  - `bash-parser.ts:15,50,89,103`: `loadBashParser(assets)` is runtime-agnostic and does a dynamic `import('web-tree-sitter')`
  - `browser-parser.ts` is Vite-only (`?url` / `?raw`)
  - Sole importer: `pages/repository/session-log/tool-call-view/useBashView.ts:26`; test `bash-view.algo.test.ts:15-28` (`createRequire` + `readFileSync` of the WASM)
  - Dependencies: `client/package.json:38-39` (`tree-sitter-bash` 0.25.1, `web-tree-sitter` 0.27.1); `client/vite.config.ts:21-23` excludes it from `optimizeDeps`
- **Package alias:** `client/vite.config.ts:17,32`; `client/tsconfig.json:21,24`.

**Hook** (`hook/.claude/telemetry_tool/`)
- **Snapshot build:** `harness-snapshot.js:347` `computeSnapshotId`; `:399` `buildHarnessSnapshot`.
- **Snapshot state:** `harness-state.js:32-35,125,138,155,174` (`harness-state.json`, `knownSnapshotIds`, remember/forget/record).
- **Upload side** (`send-logs-hook.js`):
  - `:1204-1268` `getHarnessPrefix` (ref always, full when unknown)
  - `:1448`, `:1460` the `artisyn &amp;&amp; isCurrentSession` gate; `:1540`, `:1614-1625`
  - `:1276-1297` `commitHarnessReport`
  - `:1605-1612` the `hook-status` event carries `hookVersion`
- **Query and response:** `upload-logs.js:448-453` query params; `:504-520`, `:876` `unknownSnapshotId` parsing. `prompt-upload-hook.js:160-168,185-187` sends the ref only.
- **Config** (`env-context.js`): `:64-84` `CONFIG_DEFAULTS`, `:86-106` `CONFIG_TYPES` (no `'object'` type), `:231` `shallowMergeConfigs` (top-level replace), `:259-289` `loadConfig`.
- **Git:** `git-context.js:26` `git(args, cwd, timeoutMs)` uses `execFileSync`, without stdin piping. Nothing in the hook calls `git check-ignore` or `git ls-files` today (`code-inventory.js:20-25` explains why `ls-files` is avoided).
- **Version:** `version.json` = `2.25.0`, read by `hook-log.js:9-20`.
- **Algorithm tests:** `__tests__/harness-snapshot.algo.test.js:155` is the template; `__tests__/test-helpers.js:134-151` writes both config files.
- **Docs:** `hook/HOW_HOOK_WORKS.md:195-216,326-338` (snapshot lines and known-state).

**Scenarios** (`tests/scenarios/`; extend these, do not add new files)
- **Session tab:** `@S-SESS-09` (`view/s-sess-09.spec.ts:80`, Change surface tab); `@TOUR-05` (`tours/tour-05-session-detail.spec.ts:99`, loops over all session tabs; registry `tours/screen-registry.ts:557,657`).
- **Hook snapshot end to end:** `@S-HOOK-09` (`hook/s-hook-09.spec.ts:116`, real plugin against the stand; steps 4–5 at `:231-292`); `@S-HOOK-01` (`hook/s-hook-01.spec.ts:67`, ref/full/resend steps at `:156-218`, `startFakeLogHub`).
- **Ingest isolation:** `@S-INGEST-02` step 10 (`ingest/s-ingest-02.spec.ts:274`).
- **Old hook:** `@S-COMPAT-01` (`hook/s-compat-01.spec.ts:174`; frozen 1.6.2 / 2.6.1 hooks; `:285-291` asserts a null snapshot id).
- **Export/import:** `@S-REPO-09` (`repos/s-repo-09.spec.ts:67-75,141-143`); `@S-REPO-11` (`repos/s-repo-11.spec.ts:378-435`, rebind); `@S-REPO-12`.
- **Team view and recompute:** `@S-REPO-16` (`repos/s-repo-16.spec.ts:32`, team analytics; recompute at `:155-165`); `@S-REPO-07`; `@S-TEAM-02/03`; `@S-SLIFE-10`.
- **Reports and analytics:** `@S-REPT-01/02`, `@S-ANLT-01`, `@TOUR-04` (`tours/tour-04-analytics-reports.spec.ts:35`).
- **Helpers:**
  - `helpers/session-view.ts:33,81` (`uploadGoldenRepo`, `openSession(…, {tab})`)
  - `helpers/golden.ts:300,393`; `helpers/reports.ts:51,113,130`; `helpers/ingest.ts:24` (`postLogs`, `ndjson`)
  - `helpers/db-seed.ts:35`; `helpers/export-import.ts`; `helpers/teams.ts`
  - `helpers/hook-process.ts:239,345,478,901` (`writeConfig`, `runHook`, `startFakeLogHub`, `installBuiltPlugin`)

**PoC**
- `docs/pocs/2026-10-27-1950-okf-analysis-cost/facts.ts` is a bun script with no exports. It is the reference for:
  - the extraction loop (`:118-150`) and the `toRepoPath` rule (`:23-31`)
  - `cleanPrompt` (`:41-52`)
  - the output shape `{sessionId, startedAt, prompts, reads[], changes[], runs[], unparsedBash, agents[{id, prompt, kbSeq, kbReads, otherReadsTop, changes}]}`
- `toRepoPath` hardcodes `/_repo/` and the KB prefixes, so it must be replaced by FR-2 and the snapshot bundles.

### Open gaps
1. **Moving bash-view to `packages/` conflicts with the package rules.** `analyzeBash` needs a tree-sitter parser; `web-tree-sitter` plus the `tree-sitter-bash` WASM are client dependencies, while packages must have "no dependencies". The plan must decide:
   - keep the parser loading on each side and move only pure logic, so the package takes the parser as an argument as `loadBashParser(assets)` already allows;
   - add both dependencies to `server/package.json`;
   - make ncc bundle or copy the two `.wasm` files into `dist/` and Docker;
   - replace or split `browser-parser.ts`.

   The repo-local-packages KB article also needs a rule change for this.
2. **Byte unit.** The existing `computeToolResultBytes` counts UTF-16 characters, and only for Read. FR-1 says bytes; the PoC used `Buffer.byteLength` (UTF-8). Pick one and pin it in `okf-access-extraction.md`.
3. **Even split rounding.** The PoC uses `Math.round(bytes / n)`, which does not preserve the total. Choose floor plus remainder, or rounding, and pin it.
4. **FR-6 duplicate Read pairs** have not been investigated. There is no existing dedupe for sub-agent logs; the plan needs an investigation step, and possibly a dedupe key such as `tool_use_id`.
5. **Hook config shape.** `okf.exclude` is nested, but `CONFIG_TYPES` has no `'object'` type and `shallowMergeConfigs` replaces whole top-level keys. Either add an object type or use a flat key. Either way, the key must be backward compatible for an old hook that ignores it.
6. **Git with stdin.** `git-context.js` `git()` uses `execFileSync` without stdin piping. `check-ignore --stdin` needs `input:` support, and the exit code is 1 when nothing is ignored.
7. **Hook-side OKF detection is entirely new:** fs walk, front matter, deepest bundle, links outside the repo, the default `tmp/` exclusion. Also new: the separate `okf-state` / known-ids cache (parallel to `harness-state.json`) and the optional mtime-tree cache from the NFR. The hook version bump (2.25.0 → next) needs a `hook-api-versioning.md` section.
8. **Wire and upload details.**
   - An OKF snapshot size cap is needed (parallel to `HARNESS_SNAPSHOT_MAX_BYTES`).
   - The upload chunk-0 handling for the new params must be decided.
   - The `prompt-upload-hook.js` path, which sends harness refs only, needs an OKF counterpart.
9. **Heal without `raw_path`.** `session_okf_access` stores only resolved paths, so the claude-before-artisyn heal must reparse bodies through `rewriteSessionTreeFileStats`. Decide whether it hooks in there or gets its own tree rewrite.
10. **Snapshot binding for sub-agents.** Sub-agent rows keep `okf_snapshot_id` null; each read walks to the root, and there is no existing helper that resolves the root's snapshot for a node. Similarly, the "latest snapshot in the filtered range, per branch" lookup for the repo route is new SQL.
11. **Personal/Team.** It is route-based (`/repos/:id` vs `/teams/:t/repos/:id`), not a toggle as the repo wireframe shows. The client also never sends `attr=` today: no API helper appends it. The OKF tab needs its own filter strip and must wire `attr` and `bundle`; `ReportParameterStrip` is tied to `mtab=reports`.
12. **Not in the FRs.** The wireframe's node side drawer (per-session list) and the "Show all" lists have no FR or route field. Decide whether they are in scope.
13. **No histogram component** exists. Build the four-bin chart from the D3 bar charts or as plain CSS bars.
14. **The facts route lacks what the kb-completeness-deep skill needs.** That skill's FR-2 wants to rank candidate sessions by OKF verdict through the API key, but FR-20 serves only one session's facts. There is no API-key list or verdict route, so this is a cross-task gap.
15. **Session owner check for an API-key GET.** Existing API-key routes check ownership inside services; there is no shared helper returning 404 for another user's session.
16. **The purge path** (`purgeSessionChildData` steps g/h) and `teams.service.ts:641` both need the OKF sweep. `session_okf_access` is covered by the FK cascade.
17. **Scenario coverage.** Old-hook coverage exists (`@S-COMPAT-01`), but nothing covers "new hook against an old server" for the new query params. The plan must choose a scenario to extend, most likely `@S-HOOK-01` with `startFakeLogHub` simulating an old server.
