# T-120 research findings (pass 2, 2026-08-28)

_Archive only — the authoritative plan is `impl-plan.md`. Written after the FR-6…FR-13 scope
extension; supersedes `findings-1.md`, which predates both the extension and the already-shipped
focused floor._

## Requirements summary

T-120 has two halves. **(a) Behaviour:** the change-surface "focused floor" in `computeChangeSurface()` must band any scope whose distinct changed-file count is ≤ an effective threshold as `focused` (implementation shape settled as a score floor `concentration = max(score, BAND_FOCUSED_MIN)`), so the reported 3-file/2-module session stops reading "scattered"; genuinely large+spread scopes keep pure score-based banding (FR-1…FR-5). **(b) Configurability:** the current hardcoded `FOCUSED_SMALL_CHANGE_MAX_FILES = 5` becomes a per-repository, dual-scope (personal + team) optional integer in the existing `repo_config.config` jsonb, default **10**, resolved user→team→default per reader/repo, validated server-side (integer, `>= 1`, `<= MAX` — proposal 1000, OQ-2), edited in Repository Settings → Analysis tab as "Merge surface threshold (files)", and threaded as an option into the single `computeChangeSurface()` fold so all five surfaces (session tab, Summary tile, report period, chart buckets, group aggregates) use the same value (FR-6…FR-13). No DB migration, no API shape break; concentration/band are never stored. Field-name choice (`mergeSurfaceThreshold` vs `changeSurfaceFocusedMaxFiles`) is OQ-1, to settle in planning.

Note: **the floor itself already exists** (`FOCUSED_SMALL_CHANGE_MAX_FILES = 5`, `change-surface-metrics.ts:52,481-486`) — T-117 shipped it. The residual behaviour work is only raising/parameterising the constant, so FR-1/FR-2's "take T and F into account" is already satisfied indirectly by F; T gets no new weight.

## Wireframes

Both reviewed; both **predate FR-6…FR-13** (no settings control is drawn) and their numbers are marked illustrative.

- `wireframes/change-surface-tab-headline.svg` — 3 panels of the 6-cell headline row. BEFORE: 3 files / 3 folders / 2 modules / depth 0 → `28 / 100 scattered`. AFTER: same session → `62 / 100 focused`. NO-REGRESSION: 14 files / 11 folders / 6 modules → `8 / 100 scattered`. Only the Concentration cell changes; no layout change. Footer sketches `topLevelFolders ≤ N AND changedFiles ≤ M ⇒ never scattered` — superseded by FR-3's file-count-only score floor.
- `wireframes/summary-change-surface-tile.svg` — the Summary tile flips with the tab (same server band, T-117 DD-13). Notes CS-1 (`change-surface-spread`) already silent here via `foldersTouched >= 5`.
- **Wireframe/implementation discrepancy to flag in the plan:** the score floor produces **exactly 60**, not 62. The reported session's raw score is 28 (per the screenshot) and `max(28, 60) = 60`. Any AC/KB/test copy should say 60.

## Knowledgebase

| Path | Convention / pattern |
|---|---|
`docs/knowledgebase/change-surface.md` | Governing article and an FR-5/AC-10 deliverable. §2 holds the formula, the two-tier leniency block (Tier 1 floor / Tier 2 blend) and the **worked-checks table that is the pinned contract** — each row must now state the threshold in force. §2 "band boundaries live in one place": `concentrationBand()` is the only producer of `band`; client never recomputes `< 40`. §5: concentration deliberately not a column → historic sessions pick up the new rule free. §11 checklist item 1: no second metric implementation.
`docs/knowledgebase/db-tables.md:615-643` | `repo_config` table + the `highCacheCreationThreshold` paragraph — the exact template for documenting a new optional jsonb field: "no DB default, missing field means the TS constant, mirrored client-side, `validateConfig` rejects out-of-range with 400".
`docs/knowledgebase/api-reference.md:110-127, 1005-1040` | `RepoConfig` interface comment block + the two `PUT .../settings/{team,user}` blocks (whole-blob replace, read-modify-write requirement, the 400 error line listing threshold bounds).
`docs/knowledgebase/server-endpoint-map.md:626-632` | The T-83 note under the settings PUTs — same shape for the new field.
`docs/knowledgebase/client-component-map.md:140` | `AnalysisSettings.tsx` entry documenting `CacheCreationThresholdSetting` / `TurnEndCostAdvisorSetting`; must gain the third control.
`docs/knowledgebase/ui-principles.md` | Bounded 0–100 ratio ⇒ fixed axis + fixed band colours, never `zoneColor()`. No band-colour change needed here.
`docs/knowledgebase/llm-call-math.md:468-490` | Prose precedent for describing a resolved per-repo threshold (not a deliverable unless you want symmetry).
`docs/knowledgebase/test/index.md` (+ `client-unit-tests.md`, `server-tests.md`, `e2e-tests.md`) | Three-layer test conventions and canonical run commands.
`docs/knowledgebase/session-metrics-scope.md` | Union/set-metric class the four `cs_*` columns belong to; unchanged, but referenced by change-surface.md.

## Existing patterns

**The metric (fix target)**
- `server/src/logs/change-surface/change-surface-metrics.ts:34-52` — the two-tier leniency doc comment + `SMALL_CHANGE_MAX_FILES = 6` (FR-13: stays hardcoded) and `FOCUSED_SMALL_CHANGE_MAX_FILES = 5` (becomes the configurable default 10).
- `change-surface-metrics.ts:67-77` — `ComputeChangeSurfaceOptions` (`computed`, `repoRootKnown`) — **the exact seam to add `focusedMaxFiles?: number` to** (FR-11).
- `change-surface-metrics.ts:475-486` — score → clamp/round → floor. The floor line is the one-line change.
- `change-surface-metrics.ts:29-32` weights (E .40 / S .25 / M .20 / D .15); `:55-56` `BAND_FOCUSED_MIN = 60`, `BAND_MIXED_MIN = 40`; `:111-116` `concentrationBand()`.

**Every `computeChangeSurface()` call site that must be threaded (FR-11)**
- `server/src/logs/change-surface/change-surface.service.ts:73` (session aggregate), `:159` (`notComputedAggregate()`).
- `server/src/logs/change-surface/change-surface-aggregate.service.ts:151` (repo fold), `:159` (per-session), `:224` (per-group), **`:351` (per-bucket — currently option-less, explicitly named by FR-11)**, `:373` (empty result). `:337 buildBuckets(facts)` is a module-level function, so the threshold needs plumbing through its signature.
- Options interfaces to extend: `ChangeSurfaceAggregateOptions` (`change-surface-aggregate.service.ts:58-64`) and `ChangeSurfaceReportOptions` (`server/src/logs/reports/change-surface-report.service.ts:32-36`).
- Consumers: `change-surface-report.service.ts:50` (`build(..., {bucket:'week'})`), `server/src/logs/repositories.controller.ts:2894` (analytics chart), `reports.controller.ts` `getChangeSurfaceReport` (~line 352-395), `repositories.controller.ts:1388` (session aggregate route).

**The T-83 stack to copy verbatim (FR-6…FR-10)**
- `server/src/database/schema/index.ts:830-841` — `RepoConfigJson.highCacheCreationThreshold?: number` with the "no DB default" doc comment. Add the sibling field here.
- `server/src/database/schema/index.ts:88-95` — `CacheThresholdSource = 'user'|'team'|'default'` + `EffectiveCacheThreshold { threshold, source }`.
- `server/src/logs/repositories.service.ts:98-108` — `readConfigThreshold()`: garbage-tolerant reader (`typeof === 'number' && Number.isInteger`). Generalise or clone.
- `server/src/logs/repositories.service.ts:810-885` — `getEffectiveCacheThreshold(userId, repoIds, teamId?)`: the full user-row → team-row → default walk, including the `repoIds` list (same `repo_url`, several `repositories` rows) and the owned-teams union for the no-`teamId` case. **The exact walk FR-7 mandates.**
- `server/src/logs/repositories.service.ts:656-673` — the `validateConfig` threshold block (integer check → range check → `BadRequestException`), and `CACHE_CREATION_THRESHOLD_MIN/_MAX` imported from `server/src/logs/cache-ratio.sql.ts:58-72` alongside `DEFAULT_HIGH_CACHE_CREATION_THRESHOLD = 25_000`.
- `server/src/logs/reports/reports.controller.ts:258-272` — controller resolving the effective threshold via `Promise.all` and passing it into the service as an option. Template for all four change-surface routes.
- `server/src/logs/repositories.controller.ts:1430-1440+` — `resolveChangeSurfaceSessionScope()` already returns `repoIds`, so the session route can resolve the threshold with no extra access work; `repositoriesService` is already injected (`:302-303`).

**Client**
- `client/src/models/repositories.ts:11-41` — `RepoConfig` mirror; add the optional field with the same comment style.
- `client/src/viewer/lib/cache-ratio-ui.ts:20-35` — `CACHE_CREATION_THRESHOLD_MIN` / `_MAX` / `DEFAULT_HIGH_CACHE_CREATION_THRESHOLD`, each with a "mirrored server-side, keep in sync" comment. FR-8 says the new default/bounds go in the client's change-surface constants module: `client/src/viewer/lib/change-surface-ui.ts` is the natural home (it currently holds only labels/colours/formatters and explicitly never re-derives a band — adding a *threshold display* constant there is consistent; note `CHANGE_BAND_LEGEND:59-67` prints `≥ 60 / 40–59 / < 40` as display copy and stays truthful under a score floor).
- `client/src/viewer/pages/repository/AnalysisSettings.tsx:17-100` — `CacheCreationThresholdSetting`: controlled number input, local `isValid` range check, `canSave = !readOnly && isValid && parsed !== initialValue && !isSaving`, `readOnly` → "Managed by team owner", `data-testid`, default stated in the helper text. Clone as `MergeSurfaceThresholdSetting` in the same file.
- `client/src/viewer/pages/repository/RepositorySettings.tsx:121-150` — `savedScopeConfig` / `savedThreshold` / `effectiveThreshold` derivation, `withSavedAnalysisSettings()` (must carry the new field through the File-Categories save path too, or it is clobbered) and `saveThreshold()`'s read-modify-write. `:300-332` — the Analysis tab body where the third control mounts (`key={effectiveThreshold}` remount idiom, `border-t border-border pt-8` divider).
- `client/src/viewer/api.ts:975-1028` — `RepoSettingsResponse` / `getRepoSettings` / `putUserConfig` / `putTeamConfig`; `:702-726` the session change-surface fetchers (no signature change needed — the threshold is resolved server-side per requester).
- Render path, unchanged: server `band` → `session-summary-derive.ts:88-100` (`changeSurfaceBand`) → Summary tile; `session-log/change-surface/ChangeSurfaceHeadline.tsx:69-77` (`formatConcentration` + `bandTextClass`/`bandLabel`).
- Detectors (no change, AC-1 no-regression): `summary/detectors/thresholds.ts:32-41` (`CHANGE_SURFACE_SCATTERED_MIN_FOLDERS = 5` etc.), `detectors/change-surface-spread.ts` fires on `band === 'scattered'` only.

**Tests**
- `server/src/logs/change-surface/change-surface-metrics.spec.ts:15-42` — the `fact(relPath, over?)` builder; `:67-195` DD-1 worked checks; `:197-268` the leniency describe block. **Cases that flip when the default goes 5 → 10 and need an explicit threshold argument:** the 6-files/6-folders/6-modules → `8`/`scattered` case (~`:89-103`), "ranks a one-folder session above a one-file-per-folder session of equal size" (6 files, pins `scattered.concentration = 8`, `:166-176`), and "does not blend once fileCount exceeds SMALL_CHANGE_MAX_FILES" (7 files, `expect(band).not.toBe('focused')`, `:258-267`).
- `server/src/logs/repositories.service.spec.ts:109-275` — `makeConfig(threshold?)` + `validateConfig` accept/reject table + `getEffectiveCacheThreshold` resolution-order tests (user wins, team next, default, malformed-string→default, wrong-team ignored, empty `repoIds`) with `makeMockDb` query-order assertions. Direct template for AC-6/AC-7/AC-8.
- `server/test/change-surface.e2e-spec.ts:331-354` — pinned constants (`FOCUSED_CONCENTRATION = 100`, `SCATTERED_CONCENTRATION = 8`, `NEAR_CONCENTRATION = 72`, `FAR_CONCENTRATION = 60`, `TREE_CONCENTRATION = 62`) with hand-derived comments. **`SCATTERED_CONCENTRATION`/`band: 'scattered'` at `:813-822` (6-file/6-module fixture) flips at default 10** — either pin a sub-6 threshold via `repo_config` for that test or grow the fixture to 12 files.
- `server/test/change-surface-report.e2e-spec.ts:242-246` (`REPO_CONCENTRATION = 62`, `P_ = 100`, `Q_ = 62`) and `change-surface-analytics.e2e-spec.ts:303` (`100`) — all already ≥ 60 at ≤ 3 files, so **none of these flip**.
- `server/test/cache-read-ratio-report.e2e-spec.ts:880-1022` — e2e pattern for exercising team-scoped then user-scoped thresholds via the real `PUT .../settings/{team,user}` routes; the model for AC-6/AC-7/AC-9 e2e.
- `client/src/viewer/__tests__/components/RepositorySettings.test.tsx:89-150` — `renderSettings('/repo?stab=analysis')` + `makeSettingsResponse()` + `mockPutUserConfig` round-trip assertions; note its existing comment about "the Analysis tab also renders `CacheCreationThresholdSetting`'s own Save button above this one — the advisor's Save is the last of the two" → **adding a third control breaks that `saveButtons[last]` indexing assumption**; prefer scoping by `data-testid`.
- `tests/e2e/change-surface-tab.spec.ts`, `tests/e2e/summary-tab.spec.ts`, `tests/e2e/repo-file-categories.spec.ts` — Playwright coverage for the affected surfaces and the settings tab.

## Exact computed values (not estimates — re-implemented the formula and validated it against every KB-pinned figure: 23, 72, 8, 31 all reproduce)

| Scope | F/K/T | raw score | at threshold 5 | at threshold 10 |
|---|---|---|---|---|
`a/x` + `z/y` (AC-4) | 2/2/2 | **23** | 60 focused | 60 focused |
`a/b/c` + `a/b/d` | 2/2/1 | **72** | 72 focused | 72 focused |
6 files, 6 folders, 6 modules (AC-2 low anchor) | 6/6/6 | **8** | 8 **scattered** | 60 focused |
7 files `mod/a..mod/g` | 7/7/1 | **31** | 31 scattered | 60 focused |
10 files, 10 modules (AC-5 lower edge) | 10/10/10 | **5** | 5 scattered | **60 focused** |
11 files, 11 modules (AC-5 upper edge) | 11/11/11 | **4** | 4 scattered | **4 scattered** |
12 files/12 folders/12 modules (AC-2 high anchor) | 12/12/12 | **4** | 4 scattered | **4 scattered** |
reported-session shape, 3 files / 3 folders / 2 modules | 3/3/2 | 24–30 (28 per screenshot) | 60 focused | **60 focused** |

Derivations for the two new AC anchors: at F > 6 the blend is inert (`smallness = 0`) and with one file per own top-level folder `E' = 0`, `D = 0`, `S' = M = 1/F`, so `score = (0.25 + 0.20)/F = 0.45/F`. F = 12 → `0.0375` → `round(3.75) = 4`; F = 11 → `0.040909` → `4`; F = 10 → `0.045` → `5`.

## Open gaps

1. **Stored field name (OQ-1)** — `mergeSurfaceThreshold` (matches the owner's UI label) vs `changeSurfaceFocusedMaxFiles` (matches the code/KB/DB family). Undecided; the plan must pick, and it is permanent once written to jsonb.
2. **Upper bound (OQ-2)** — proposal 1000. No precedent to copy other than the cache pair's arbitrary `10_000_000`.
3. **Threshold plumbing into `buildBuckets()`** — it is a module-level function taking only `facts`; there is no existing pattern in this file for passing per-call options down to it. Signature change vs. closure vs. moving it onto the service is an unmade decision.
4. **No precedent for a `repo_config`-scoped value affecting the *session-detail* route.** T-83's threshold only ever reached report/analytics controllers; `repositories.controller.ts`'s two session change-surface routes have never resolved a config value. Whether to resolve it inside `ChangeSurfaceService` (needs `RepositoriesService` injected — check for a DI cycle: `RepositoriesController` already injects both) or in the controller is undecided.
5. **`ChangeSurfaceService.getSessionFiles()` / `notComputedAggregate()`** take no threshold and need none semantically (no band), but FR-11's "no caller may keep using the built-in default implicitly" reads as absolute — the plan should carve out the `F = 0` / files-listing cases explicitly.
6. **Caching/invalidation on save.** T-83's save triggers `recomputeForRepo()` because `session_cause_stats` is materialised; change-surface concentration is not stored, so *nothing* needs recomputing — but the client's react-query caches (`['repoSettings', …]`, plus the change-surface aggregate/report/analytics query keys) will serve stale bands after a save. No existing invalidation pattern covers cross-feature keys; `RepositorySettings.tsx:88-92` only invalidates `['repo-detail', repoId]`.
7. **Export/import round-trip** — `repository-export-import.service.ts` carries `repo_config` blobs; a new optional field should ride along free, but this was not verified.
8. **Where the client-side constants live** — FR-8 says "in the style of `cache-ratio-ui.ts`". `change-surface-ui.ts` is documented as "never re-derives a band from a number"; adding a threshold constant there is defensible but the plan should state it (or create a new module) so the file's own invariant comment stays accurate.
9. **Stale task-folder artifacts** — `impl-plan.md`, `design-decisions.md`, `tldr-overview.md`, `open-questions.md` and `research/findings-1.md` all predate FR-6…FR-13 (findings-1.md additionally predates the already-shipped floor and claims pinned cases will flip that have already flipped). Only `requirements.md` + `notes.md` are authoritative. Any task-folder doc the plan writes is in English (CLAUDE.md → "Documentation language").
