# T-120 — Implementation Plan

> Numbered decisions in this file are cited as **plan DD-N**, to avoid collision with T-117's
> in-code `Design Decision N` comments and with the sibling `design-decisions.md`, which
> numbers a different set.

## TL;DR

- **No new behaviour is invented server-side**: the "focused floor" already ships (T-117,
  `change-surface-metrics.ts:481-486`). This task raises its default 5 → 10 and makes it a
  per-repo, dual-scope setting.
- **DB changes:** none. One new optional integer in the existing `repo_config.config` jsonb —
  `changeSurfaceFocusedMaxFiles` (plan DD-1). No table, no column, no migration, no backfill.
- **API changes:** none to any request/response shape. The threshold is resolved server-side per
  requester on the 4 existing change-surface read routes; `PUT .../settings/{team,user}` gains one
  more accepted (and validated) jsonb key.
- **New service function:** `RepositoriesService.getEffectiveChangeSurfaceThreshold(userId,
  repoIds, teamId?)` → `{ threshold, source }`, built by generalizing T-83's existing
  `getEffectiveCacheThreshold` walk into a shared private helper (plan DD-9) rather than cloning it.
- **One cross-feature symbol change:** the exported `CacheThresholdSource` becomes an alias of a new
  `ConfigValueSource`. `reports/cache-read-ratio.service.ts:13` imports it, so it must stay exported
  from `repositories.service.ts`.
- **New signature threading (FR-11):** `focusedMaxFiles` becomes a **required** option on
  `ChangeSurfaceAggregateOptions`, `ChangeSurfaceReportOptions` and `ChangeSurfaceSessionScope`,
  and a required 2nd parameter on the module-level `buildBuckets()` (plan DD-4/DD-5).
- **New constants, mirrored both sides:** default 10 / min 1 / max 1000, exported from
  `change-surface-metrics.ts` (server) and `change-surface-ui.ts` (client, plan DD-6).
- **New UI:** a third control, `MergeSurfaceThresholdSetting`, in Repository Settings → Analysis,
  cloning `CacheCreationThresholdSetting`. Its displayed value is derived **per field** rather than
  from `effectiveConfig`, which is a whole-row winner (plan DD-14).
- **Cross-feature cache invalidation** on save (plan DD-7): the settings mutation must now
  invalidate three change-surface react-query key prefixes it has never touched.
- **Pinned-artifact churn is wide:** 3 metric specs, the e2e scatter fixture (grown) plus one new
  mid-size fixture, the KB worked-checks table, stale "up to 5 files" comments in 3 client files,
  5 KB pages and both wireframe SVGs.
- **Two out-of-feature cleanups ride along:** `RepositorySettings.test.tsx`'s index-based
  Save-button lookup breaks once a third control exists and must be re-scoped by `data-testid`;
  new Playwright coverage lands in `tests/e2e/change-surface-tab.spec.ts`.
- No new npm packages.

## Reference

- Requirements: [`requirements.md`](requirements.md)
- Research archive (non-authoritative): [`research/findings-2.md`](research/findings-2.md)

## Design Decisions

- **plan DD-1 — Stored field name (resolves OQ-1): `changeSurfaceFocusedMaxFiles`.** The jsonb key
  is a permanent code-level artifact and the whole family it joins (`cs_*` columns, the KB article,
  the metric module, `ComputeChangeSurfaceOptions`) is named *change surface*; the owner's
  **"Merge surface threshold (files)"** label is used verbatim in the UI only, and the KB names both
  so they are never confused.
- **plan DD-2 — Bounds (resolves OQ-2):** `DEFAULT = 10`, `MIN = 1`, `MAX = 1000`. Above 1000 no
  realistic scope stays out of the floor and the `scattered` band becomes unreachable.
- **plan DD-3 — Implementation shape is the score floor**, not a band override (FR-3): keep T-117's
  `concentration = max(concentration, BAND_FOCUSED_MIN)` guarded by `1 <= fileCount <=
  focusedMaxFiles`. `concentrationBand()` therefore stays the single band producer (KB §2) and the
  client's printed `≥ 60 / 40–59 / < 40` legend stays truthful.
- **plan DD-4 — `buildBuckets()` gains a required second parameter** `focusedMaxFiles: number`
  rather than a closure or a move onto the service: it keeps the function pure and makes the
  currently-implicit per-bucket call (`change-surface-aggregate.service.ts:351`) a compile error
  until it is threaded, which is exactly what FR-11 asks for.
- **plan DD-5 — `focusedMaxFiles` is required on the service-level option objects**
  (`ChangeSurfaceAggregateOptions`, `ChangeSurfaceReportOptions`, `ChangeSurfaceSessionScope`) so no
  production caller can fall back to the built-in default implicitly, but stays **optional** on
  `ComputeChangeSurfaceOptions` (whose whole `options` argument is already optional). The two
  zero-file constructors — `change-surface.service.ts:159 notComputedAggregate()` and
  `change-surface-aggregate.service.ts:373 emptyResult()` — are deliberately left option-less:
  `computeChangeSurface` returns `concentration: null` and `band: null` before ever reaching the
  floor, so a threshold there would be dead code. `getSessionFiles()` likewise ignores it (it
  produces no band).
- **plan DD-6 — Client-side constants live in `client/src/viewer/lib/change-surface-ui.ts`**,
  matching `cache-ratio-ui.ts` which already mixes band colours with
  `CACHE_CREATION_THRESHOLD_MIN/_MAX`. Its header comment ("this module never re-derives a band from
  a number") is extended to say the threshold constants are *settings-form bounds and display copy*,
  never a second implementation of the floor.
- **plan DD-7 — Saving the threshold invalidates client caches, and recomputes nothing
  server-side.** Unlike T-83 (which materialises `session_cause_stats`), concentration/band are
  never stored, so there is no `recomputeForRepo()` equivalent. The settings mutation's `onSuccess`
  (`RepositorySettings.tsx:87-104`) must invalidate the three change-surface query-key prefixes:
  `['session-change-surface']` (feeds both the tab and the Summary tile —
  `SessionChangeSurfaceTab.tsx:71`, `SessionDetailPane.tsx:155`), `['analytics-change-surface']`
  (`RepositoryAnalytics.tsx:155`) and `['report-change-surface']` (`ChangeSurfaceReport.tsx:256`).
  Prefix matching means one `invalidateQueries` call each.
- **plan DD-8 — The threshold is resolved in the controllers, never inside `ChangeSurfaceService` or
  `ChangeSurfaceAggregateService`.** This copies `reports.controller.ts:258-272` and avoids
  injecting `RepositoriesService` into the change-surface services (a new DI edge with cycle risk).
  For the two session routes the resolution rides inside the existing
  `resolveChangeSurfaceSessionScope()` helper, which already holds `user.id` and `repoIds`; for the
  report route the requester is read off `scope.requesterUserId` / `scope.teamId`, which
  `resolveUsageScope()` already populates (`reports.controller.ts:698-706`) — no new `AuthUser`
  binding is needed there.
- **plan DD-9 — Generalize T-83's resolution walk instead of cloning it.** Extract the ~70-line
  user-row → team-row → default walk (`repositories.service.ts:810-885`), including its owned-teams
  union, into a private `resolveEffectiveConfigNumber(userId, repoIds, read, fallback, teamId?)`;
  `getEffectiveCacheThreshold` becomes a thin delegate with identical behaviour (its existing spec
  must stay green untouched), and the new getter is a second delegate. Both the source type and the
  result interfaces live in `repositories.service.ts` beside `CacheThresholdSource` (:88-95) —
  **not** in `schema/index.ts` — and `CacheThresholdSource` must remain exported from there, because
  `reports/cache-read-ratio.service.ts:13` imports it.
- **plan DD-10 — Garbage tolerance is wider than T-83's:** the reader treats a value as absent
  unless it is an integer **and** within `[MIN, MAX]`, so an out-of-band write of `0` or `5000`
  falls through to the next scope instead of disabling or neutering the band (AC-8, second half).
- **plan DD-11 — The `source` marker (`user`/`team`/`default`) is resolved but not surfaced** in any
  change-surface view; only the settings tab consumes the resolved value (requirements: out of
  scope unless free).
- **plan DD-12 — The floored concentration is exactly `60`, not `62`.** Both wireframes' AFTER panel
  shows `62`; the reported session's raw score is 28 and `max(28, 60) = 60`. All copy (KB, tests,
  ACs, the SVG) uses 60.
- **plan DD-13 — The flipping e2e fixture grows, and a new mid-size fixture is added.**
  `change-surface.e2e-spec.ts`'s scatter session goes from 6 to 12 single-file top-level modules so
  it stays scattered at the default; because that removes the only session in the 6–10 file range, a
  **new 8-file / 8-module session** is seeded as the subject of the threshold-flip tests (60 focused
  at the default 10, `6`/scattered at a threshold of 5). No test-ordering dependency on a `PUT` is
  introduced for the existing fixtures.
- **plan DD-14 — The settings control derives its displayed value per field, not from
  `effectiveConfig`.** `resolveEffectiveConfig` (`repositories.service.ts:418-500`) returns the
  *whole winning row's* blob (`return { config: userConfig.config, teamId: null }`), so a user who
  has any personal `repo_config` row — even one holding only file categories — would see the default
  while a team value is actually in force on the read paths. FR-9 requires the control to show the
  value in force, so the new control computes it from the response's own `userConfig` / `teamConfig`:
  personal view `userConfig?.field ?? teamConfig?.field ?? DEFAULT`, team view
  `teamConfig?.field ?? DEFAULT`. The existing T-83 control keeps its current `effectiveConfig`
  behaviour — fixing that inherited quirk is out of scope here.
- **plan DD-15 — The files route pays one extra query, accepted.** Because the resolution lives in
  the shared `resolveChangeSurfaceSessionScope()` (plan DD-8), the band-less files route
  (`repositories.controller.ts:1402-1435`) also resolves a threshold it never uses. That is one
  indexed `repo_config` lookup over an already-authorised `repoIds` set, cheaper than splitting the
  helper into two variants that could drift apart.

### Shared contract — the threshold

| Concern | Value / location |
|---|---|
| jsonb key | `repo_config.config.changeSurfaceFocusedMaxFiles?: number` (`server/src/database/schema/index.ts`, `RepoConfigJson`) |
| Default | `10` — `DEFAULT_CHANGE_SURFACE_FOCUSED_MAX_FILES`, exported from `server/src/logs/change-surface/change-surface-metrics.ts` |
| Min / max | `1` / `1000` — `CHANGE_SURFACE_FOCUSED_MAX_FILES_MIN` / `_MAX`, same module |
| Client mirror | same three names in `client/src/viewer/lib/change-surface-ui.ts` (plan DD-6) |
| Resolution | `RepositoriesService.getEffectiveChangeSurfaceThreshold(userId, repoIds, teamId?)` → `{ threshold, source }` |
| Metric option | `ComputeChangeSurfaceOptions.focusedMaxFiles?: number` (optional; defaults to the constant) |
| Service option | `focusedMaxFiles: number` — **required** on `ChangeSurfaceAggregateOptions`, `ChangeSurfaceReportOptions`, `ChangeSurfaceSessionScope` |
| UI label | `Merge surface threshold (files)` |
| Rule | `1 <= changedFiles <= threshold` ⇒ `concentration = max(score, 60)` ⇒ band `focused` |

### Pinned figures used by the plan (exact, recomputed from the formula)

At `F > 6` the Tier-2 blend is inert (`smallness = 0`) and one file per own top-level folder gives
`E = 0`, `D = 0`, `S = M = 1/F`, so `score = 0.45 / F`.

| Scope (F files / K folders / T modules) | raw concentration | at threshold 5 | at threshold 10 (new default) |
|---|---|---|---|
| 3 / 3 / 2 — the reported session | 28 | 60 focused | **60 focused** (AC-1) |
| 2 / 2 / 2 — `a/x` + `z/y` | 23 | 60 focused | **60 focused** (AC-4) |
| 2 / 2 / 1 — `a/b/c` + `a/b/d` | 72 | 72 focused | 72 focused |
| 6 / 6 / 6 | 8 | **8 scattered** | 60 focused (AC-2 low anchor, needs explicit threshold 5) |
| 7 / 7 / 1 | 31 | 31 scattered | 60 focused |
| 8 / 8 / 8 — the new e2e flip fixture | 6 | **6 scattered** | **60 focused** (plan DD-13) |
| 10 / 10 / 10 | 5 | 5 scattered | **60 focused** (AC-5 lower edge) |
| 11 / 11 / 11 | 4 | 4 scattered | **4 scattered** (AC-5 upper edge) |
| 12 / 12 / 12 | 4 | 4 scattered | **4 scattered** (AC-2 high anchor, grown e2e fixture) |

## Files to create/modify

All paths are repo-relative. No new files.

| Path | Purpose | Note |
|---|---|---|
| `server/src/database/schema/index.ts` | `RepoConfigJson.changeSurfaceFocusedMaxFiles?: number` | Field goes after `highCacheCreationThreshold` (~:841). **No type additions here** (plan DD-9) |
| `server/src/logs/change-surface/change-surface-metrics.ts` | Export DEFAULT/MIN/MAX; `focusedMaxFiles` option; rewrite the Tier-1 comment; use it in the floor | Replaces the private `FOCUSED_SMALL_CHANGE_MAX_FILES = 5` (:52); floor at :481-486; options at :67-77; comment at :34-52 |
| `server/src/logs/change-surface/change-surface.service.ts` | `ChangeSurfaceSessionScope.focusedMaxFiles`; pass it in `getSessionAggregate` | Scope iface :37-40, call :73; `notComputedAggregate()` (:159) unchanged per plan DD-5 |
| `server/src/logs/change-surface/change-surface-aggregate.service.ts` | `ChangeSurfaceAggregateOptions.focusedMaxFiles`; thread into 4 folds + `buildBuckets` signature | Options :58-64; folds :151, :159, :224, :351; `buildBuckets` :337 + call sites :174, :227; `emptyResult()` (:373) unchanged |
| `server/src/logs/reports/change-surface-report.service.ts` | `ChangeSurfaceReportOptions.focusedMaxFiles`; forward through to the aggregate | Iface :32-36, forward at :50 |
| `server/src/logs/repositories.service.ts` | `ConfigValueSource` + `EffectiveChangeSurfaceThreshold`; generalized walk; `readChangeSurfaceThreshold`; `getEffectiveChangeSurfaceThreshold`; `validateConfig` block | Types beside `CacheThresholdSource` (:88-95), which stays exported; reader beside :98-108; walk :810-885; validation after the cache block (:656-673) |
| `server/src/logs/repositories.controller.ts` | Resolve + pass the threshold on the session and analytics routes | `resolveChangeSurfaceSessionScope()` :1441-1466; analytics `build()` call :2893-2905 |
| `server/src/logs/reports/reports.controller.ts` | Resolve + pass on the report route | `getChangeSurfaceReport` :351-393; requester read off `scope` per plan DD-8 |
| `client/src/models/repositories.ts` | Mirror the optional field on `RepoConfig` | After `highCacheCreationThreshold` (:20) |
| `client/src/viewer/lib/change-surface-ui.ts` | The three client constants + extended header comment | Per plan DD-6 |
| `client/src/viewer/pages/repository/AnalysisSettings.tsx` | New `MergeSurfaceThresholdSetting` component | Clone `CacheCreationThresholdSetting` (:17-100) |
| `client/src/viewer/pages/repository/RepositorySettings.tsx` | Derive (per plan DD-14) / save / mount the new control; extend cache invalidation | State :121-154, mount :300-332, `onSuccess` :87-104 |
| `client/src/viewer/pages/repository/session-log/summary/detectors/change-surface-spread.ts` | Comment only: the "floor bands any change of up to 5 files" claim (:6-8) becomes threshold-relative | Guard constants unchanged (AC-1 no-regression) |
| `client/src/viewer/pages/repository/session-log/summary/detectors/thresholds.ts` | Comment only: same stale claim at :24-26 | Constants unchanged |
| `server/src/logs/change-surface/change-surface-metrics.spec.ts` | Thread thresholds into 3 flipping cases; add 5 new cases; fix stale constant references (:129, :225) | Flipping: :89, :166, :256 |
| `server/src/logs/change-surface/change-surface-aggregate.spec.ts` | Widen the shared `SCOPE` type and add `focusedMaxFiles`; assert it reaches buckets/groups | `SCOPE` declared `const SCOPE: AnalyticsScope` at :79, spread at ~15 sites |
| `server/src/logs/repositories.service.spec.ts` | `validateConfig` accept/reject table + resolution-order tests | Mirror :109-275 |
| `server/test/change-surface.e2e-spec.ts` | Grow the scatter fixture; add the 8-file fixture; threshold-scope + 400 cases | Fixture :554-566; constant :338 (+ its comment :346); assertions/title :813-822 |
| `client/src/viewer/__tests__/unit/change-surface-detectors.test.ts` | Comments + one test title: the stale "up to 5 files" / "6+ files" rationale at :74-75 and :106-110, and the title at :107 | Assertions unchanged — the summaries are synthetic |
| `client/src/viewer/__tests__/components/RepositorySettings.test.tsx` | Scope Save lookups by `data-testid`; round-trip + range tests for the new control | Fixes the `saveButtons[last]` assumption at :89-150 |
| `tests/e2e/change-surface-tab.spec.ts` | Playwright: control visible/read-only + save flips the session band | Copy `navigateToAnalysisSettings()` from `tests/e2e/cache-read-ratio.spec.ts:95-101` |
| `docs/knowledgebase/change-surface.md` | Both leniency tiers, worked-checks table, §1, §4, §5, §11 checklist | :79-98, :113-121, :27-39, :176-190, :199+, :334-345 |
| `docs/knowledgebase/db-tables.md` | `repo_config` field paragraph + the stale "Two things live in the `config` blob" count | Paragraph mirrors :615-643; the count is at :613 and is now four |
| `docs/knowledgebase/api-reference.md` | `RepoConfig` block + both settings PUT blocks | :110-127, :1005-1040 |
| `docs/knowledgebase/server-endpoint-map.md` | Note under the settings PUTs | :626-632 |
| `docs/knowledgebase/client-component-map.md` | `AnalysisSettings.tsx` entry gains the third control | :140 |
| `…/2026-08-28-change-surface-scattered-fix/wireframes/change-surface-tab-headline.svg` | `62` → `60` (plan DD-12); restate the superseded footer rule; drop the resolved open-question captions | Captions at :73 and :108 |
| `…/2026-08-28-change-surface-scattered-fix/wireframes/summary-change-surface-tile.svg` | `62` → `60` in both places; drop the resolved open-question caption | Values at :21 and :32 |
| `…/2026-08-28-change-surface-scattered-fix/requirements.md` | Mark OQ-1 / OQ-2 resolved per plan DD-1 / DD-2 | Open Questions section |
| `…/2026-08-28-change-surface-scattered-fix/{design-decisions,open-questions,tldr-overview}.md` | Refresh the companion docs | `open-questions.md:9-15` still poses OQ-1; `design-decisions.md:33` still cites `62` |

## API changes

No endpoint is added, removed or re-shaped (FR-12). The changes are behavioural and payload-internal:

| Endpoint | Method | Change |
|---|---|---|
| `/api/v1/repositories/:repoId/sessions/:sessionId/change-surface` | GET | No param change. `concentration` / `band` in the `ChangeSurfaceAggregate` response are now computed with the requester's effective threshold. |
| `/api/v1/repositories/:repoId/analytics/change-surface` | GET | Same — applies to `repo`, every `group.aggregate` and every `bucket.concentration`. |
| `/api/v1/repositories/:repoId/reports/change-surface` | GET | Same — applies to `repo`, groups, weekly buckets and the medians population. |
| `/api/v1/repositories/:repoId/sessions/:sessionId/change-surface/files` | GET | Unchanged; the route produces no band (plan DD-5). |
| `/api/v1/repositories/:repoId/settings/team` | PUT | Request body (`RepoConfig`) accepts the optional `changeSurfaceFocusedMaxFiles: number`. Rejected with **400** if present and not an integer in `[1, 1000]`. Whole-blob replace, so callers must read-modify-write. |
| `/api/v1/repositories/:repoId/settings/user` | PUT | Same as above. |
| `/api/v1/repositories/:repoId/settings` | GET | `userConfig` / `teamConfig` / `effectiveConfig` may now carry the field; absent means "use 10". |

New/changed TypeScript contracts (all internal, both mirrored):

```ts
// server/src/database/schema/index.ts — the jsonb blob only
export interface RepoConfigJson {
  /* … */ changeSurfaceFocusedMaxFiles?: number;
}

// server/src/logs/repositories.service.ts — beside the existing CacheThresholdSource (:88-95),
// which must stay exported (reports/cache-read-ratio.service.ts:13 imports it).
export type ConfigValueSource = 'user' | 'team' | 'default';
export type CacheThresholdSource = ConfigValueSource;                      // kept as an alias
export interface EffectiveChangeSurfaceThreshold {
  threshold: number;
  source: ConfigValueSource;
}

// server/src/logs/change-surface/change-surface-metrics.ts
export const DEFAULT_CHANGE_SURFACE_FOCUSED_MAX_FILES = 10;
export const CHANGE_SURFACE_FOCUSED_MAX_FILES_MIN = 1;
export const CHANGE_SURFACE_FOCUSED_MAX_FILES_MAX = 1000;
export interface ComputeChangeSurfaceOptions {
  computed?: boolean;
  repoRootKnown?: boolean;
  focusedMaxFiles?: number;   // defaults to DEFAULT_CHANGE_SURFACE_FOCUSED_MAX_FILES
}

// required on every service-level option object (plan DD-5)
interface ChangeSurfaceSessionScope   { ownerUserId: number | null; focusedMaxFiles: number }
interface ChangeSurfaceAggregateOptions extends AnalyticsScope { /* … */ focusedMaxFiles: number }
interface ChangeSurfaceReportOptions    extends AnalyticsScope { /* … */ focusedMaxFiles: number }

// client/src/models/repositories.ts
export interface RepoConfig { /* … */ changeSurfaceFocusedMaxFiles?: number }
```

## Database changes

**No schema change and no migration.** The setting rides in the existing `repo_config.config`
jsonb column as one new optional key:

| Table | Field | Type | Constraints | Migration |
|---|---|---|---|---|
| `repo_config` | `config.changeSurfaceFocusedMaxFiles` | jsonb number (integer) | Application-level only: integer, `>= 1`, `<= 1000`, enforced in `validateConfig` (400). No DB default and no NOT NULL — absent means "use `DEFAULT_CHANGE_SURFACE_FOCUSED_MAX_FILES`". | **None.** Existing rows without the key resolve to the default; historic sessions pick up the new rule automatically because concentration/band are recomputed at read time (KB §5). |

Scoping follows the existing rows verbatim: a user-scoped row (`user_id` set, `team_id NULL`) and a
team-scoped row (`team_id` set, `user_id NULL`) may each carry the key for the same repo.

**Config propagation paths — both already correct, neither needs code changes:**

- `server/src/logs/repository-export-import.service.ts` **never touches `repo_config`** (no
  reference to the table anywhere in the file), so export/import is simply not a factor here.
- `server/src/teams/teams.service.ts:334-349` is the one place a config blob is copied across
  scopes: creating a team seeds each repo's team-scoped row from the *whole* owner user-scoped blob
  (`initialConfig = ownerUserConfig?.config ?? TEAM_CREATION_DEFAULT_CONFIG`), so the new field
  rides along untouched with no allow-list to update. `TEAM_CREATION_DEFAULT_CONFIG` (`:29`) holds
  only `fileCategories`, so a team seeded without an owner config has the field absent, which
  correctly resolves to the default.

## Test coverage plan

**Server unit — `change-surface-metrics.spec.ts`** (`npm run test` in `server/`)

- Existing cases that flip at the new default and must now pass an explicit `focusedMaxFiles: 5`
  so they keep pinning what they were written to pin (AC-2's "each pinned case states its
  threshold"): the 6-files/6-folders/6-modules → `8` case (:89), the equal-size ranking case
  (:166, also 6 files), and the "does not blend once fileCount exceeds `SMALL_CHANGE_MAX_FILES`"
  7-file case (:256). Their comments naming `FOCUSED_SMALL_CHANGE_MAX_FILES` (:129, :225) are
  updated to the new constant name.
- New: `10 / 10 / 10` → `60` focused and `11 / 11 / 11` → `4` scattered at the default (AC-5, the
  two edges).
- New: `12 / 12 / 12` → `4` scattered at the default — the above-threshold scattered anchor (AC-2).
- New: the reported session's shape (3 files across `docs/` and `client/`, 2 modules) → `60`
  focused (AC-1). `60`, not `62` (plan DD-12).
- New: a zero-file scope stays `concentration: null` for any `focusedMaxFiles`, including `1`
  (the plan DD-5 carve-out).
- `:122` (`a/x` + `z/y` → 60 focused) and `:224` (5 files / 5 modules → 60) already pass at the new
  default; AC-4 is satisfied by the existing case plus the KB table row.

**Server unit — `repositories.service.spec.ts`**

- `validateConfig`: accepts `1`, `10`, `1000` and omission; rejects `0`, `-1`, `1001`, `1.5`,
  `'10'`, `NaN` with 400 and a message naming `changeSurfaceFocusedMaxFiles` (AC-8 first half).
- `getEffectiveChangeSurfaceThreshold`: user row wins over team row; team row used when no user
  row; falls back to `10` with neither; a malformed value (string, `0`, `5000`) is treated as
  absent and falls through (AC-7, AC-8 second half, plan DD-10); a row belonging to a team the user
  is not in is ignored; empty `repoIds` short-circuits to the default.
- Regression: the existing `getEffectiveCacheThreshold` block must pass **unmodified** after the
  plan DD-9 refactor, including its `makeMockDb` query-order assertions.

**Server unit — `change-surface-aggregate.spec.ts`**

- `SCOPE` (:79) is declared `const SCOPE: AnalyticsScope`, so adding `focusedMaxFiles` needs the
  annotation widened to `AnalyticsScope & { focusedMaxFiles: number }` (or dropped) — a bare
  addition fails TypeScript's excess-property check. All ~15 spread sites then typecheck unchanged.
- One case proving the option reaches every fold: a scope whose per-bucket and per-group file
  counts sit between two thresholds yields `focused` at the higher and `scattered` at the lower —
  this is the unit-level half of AC-9.

**Server e2e — `server/test/change-surface.e2e-spec.ts`** (`npm run test` in `server/`, real DB)

- Grow the scatter fixture from 6 to 12 single-file top-level modules (`a`…`l`), update
  `SCATTERED_CONCENTRATION` from `8` to `4` (and its derivation comment at :346), the fixture's
  counts (`changedFiles`, `foldersTouched`, `singleFileFolders` → 12, `topLevelModules` → `a`…`l`)
  and the test title at :813 ("six files across six modules" → twelve). The "ranks focused strictly
  above scattered" case still holds (100 > 4).
- New fixture (plan DD-13): an 8-file / 8-single-file-top-level-module session, which is `60`
  focused at the default 10 and `6` scattered at a threshold of 5 — the subject of the flip tests
  below, since after the growth no other session sits in the 6–10 file range.
- New: `PUT .../settings/user` with `changeSurfaceFocusedMaxFiles: 5`, then re-fetch that 8-file
  session — the band must flip from `focused` to `scattered` (AC-6 + AC-9 across the session route).
- New (following `cache-read-ratio-report.e2e-spec.ts:880-1022`): a team-scoped value is seen by a
  member with no personal value; that member's own personal value overrides it and leaves a second
  member's view unchanged (AC-6, AC-7).
- New: a `PUT` with a non-integer, `0` and an above-max value each return 400 and leave the stored
  config untouched (AC-8).
- Verify `change-surface-report.e2e-spec.ts` (pinned `62`/`100`/`62` at :242-246) and
  `change-surface-analytics.e2e-spec.ts` (:303) still pass unchanged — all their fixtures are ≤ 3
  files and already ≥ 60. Adjust only if a figure actually moves.

**Client unit — vitest** (`bun run test` in `client/`)

- `RepositorySettings.test.tsx`: replace the index-based Save-button lookup (:89-150, which assumes
  exactly two controls on the Analysis tab) with `data-testid`-scoped queries, then add a
  round-trip test that typing a value and saving `PUT`s a config carrying both the new field and
  the pre-existing `highCacheCreationThreshold` / `turnEndCostAdvisor` values untouched.
- A validation test: `0`, `1001` and `1.5` mark the input `aria-invalid` and disable Save.
- A plan DD-14 test: with a `userConfig` that has **no** `changeSurfaceFocusedMaxFiles` and a
  `teamConfig` that has one, the personal-view control displays the team's value, not `10`.
- No detector assertion changes — `change-surface-spread` fires on `band === 'scattered'` and its
  `foldersTouched >= 5` guard is untouched (AC-1's no-regression half is already covered by
  `change-surface-detectors.test.ts`); only that file's stale rationale comment is corrected.

**Playwright e2e** (`npm run test:e2e` / `:e2e:full` from the repo root)

- Repository Settings → Analysis renders the "Merge surface threshold (files)" control showing the
  effective value, and a non-owner in a team view sees it read-only with "Managed by team owner".
- Saving a low threshold and reopening a session's Change surface tab shows the changed band —
  the end-to-end proof that plan DD-7's invalidation works.

## Visual/UX notes

- The new control is the **third** block in Repository Settings → Analysis, below
  `TurnEndCostAdvisorSetting`, separated by the same `border-t border-border pt-8` divider the
  advisor already uses; the tab body keeps its `flex flex-col gap-8` / `max-w-2xl` frame.
- Structure cloned from `CacheCreationThresholdSetting` (`AnalysisSettings.tsx:41-99`): optional
  "Managed by team owner" line when read-only, `<label>` + `<Input type="number">`
  (`h-8 w-48 text-sm`, `min`/`max` from the constants, `step={1}`), a `text-destructive` range
  message when invalid, a `text-muted-foreground` helper paragraph, and a single `Save` button
  rendered only when editable.
- Label: **"Merge surface threshold (files)"**. `id="merge-surface-threshold"`,
  `data-testid="merge-surface-threshold-setting"`.
- Helper copy states: a change touching this many distinct files or fewer is always reported as
  *focused* on the Change surface tab, the Summary tile, the report and the analytics chart;
  larger changes are scored on spread. Default is 10. **No** "saving recomputes…" warning — nothing
  is materialised (plan DD-7).
- Remount on a changed effective value via `key={effectiveMergeSurfaceThreshold}`, matching the
  existing two controls.
- No change to band colours, the fixed 0–100 axis, or the `≥ 60 / 40–59 / < 40` legend (plan DD-3).
- The range hint must stay conditional on `!isValid`, as in the cloned control. Rendering it
  persistently would make `tests/e2e/cache-read-ratio.spec.ts:376`'s unscoped
  `getByText(/Enter a whole number between/)` a strict-mode multi-match.
- **Component size:** `RepositorySettings.tsx` is already 14.9 KB — over the 10 KB soft-split
  threshold in `.claude/rules/client.md`, under the 20 KB hard limit. Chunk 5 adds roughly 25 lines
  to it (derive + save + mount + invalidations), which keeps it under the hard limit, so **no split
  is planned here**; `AnalysisSettings.tsx` is 5.7 KB and absorbs the new component comfortably.

## Wireframes

- `wireframes/change-surface-tab-headline.svg` — the AFTER panel's Concentration must read **60**,
  not 62 (plan DD-12), and the footer's `topLevelFolders ≤ N AND changedFiles ≤ M` rule is
  superseded by the file-count-only floor and should be restated as
  `changedFiles ≤ threshold ⇒ focused`. Layout is otherwise correct and unchanged.
- `wireframes/summary-change-surface-tile.svg` — the layout and the "band flips with the tab, CS-1
  stays silent" note are accurate, but it does print `62` twice (`:21` and `:32`); both become 60.
- Both SVGs carry captions describing questions this plan closes — "exact numbers are an open
  question" and whether the 2-files/2-modules case flips (`change-surface-tab-headline.svg:73`,
  `:108`) and the same on the tile (`:32`). Replace them with the settled rule.
- **No new wireframe** for the settings control: it is a pixel-for-pixel clone of the existing
  `CacheCreationThresholdSetting` block already shipped on the same tab.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Config field, constants & validation | 5 | Foundation — every later chunk imports these names |
| 2 | Effective-threshold resolution | 6 | Needs chunk 1's field, constants and reader bounds |
| 3 | Metric + fold threading | 6 | Needs chunk 1's constants; independent of chunk 2 |
| 4 | Controllers | 5 | Needs chunk 2's getter and chunk 3's option fields |
| 5 | Settings UI + stale client comments | 7 | Needs chunk 1's client mirror + constants; end-to-end works only after 4 |
| 6 | Knowledgebase, wireframes & task docs | 8 | Documents the behaviour chunks 1–5 landed |
| 7 | Server unit tests | 7 | Pins chunks 1–3 |
| 8 | e2e & client tests | 8 | Pins chunks 4–5; run after chunk 7 is green |

### Chunk 1 — Config field, constants & validation

- [ ] Add `changeSurfaceFocusedMaxFiles?: number` to `RepoConfigJson` in `server/src/database/schema/index.ts`, after `highCacheCreationThreshold` (~:841), with a doc comment stating dual scope, user→team→default resolution, and "no DB default — absent means the constant".
- [ ] In `server/src/logs/change-surface/change-surface-metrics.ts`, replace the private `FOCUSED_SMALL_CHANGE_MAX_FILES = 5` (:52) with exported `DEFAULT_CHANGE_SURFACE_FOCUSED_MAX_FILES = 10`, `CHANGE_SURFACE_FOCUSED_MAX_FILES_MIN = 1`, `CHANGE_SURFACE_FOCUSED_MAX_FILES_MAX = 1000` (plan DD-2).
- [ ] Add a `changeSurfaceFocusedMaxFiles` block to `validateConfig` in `server/src/logs/repositories.service.ts`, directly after the cache-threshold block (:656-673): integer check then range check against the MIN/MAX constants, each throwing `BadRequestException` naming the field.
- [ ] Mirror the optional field on `RepoConfig` in `client/src/models/repositories.ts` after `highCacheCreationThreshold` (:20), matching the existing comment style and pointing at `change-surface-ui.ts` for the default.
- [ ] Add the three constants to `client/src/viewer/lib/change-surface-ui.ts` with "mirrored server-side — keep in sync" comments, and extend the module header per plan DD-6.

### Chunk 2 — Effective-threshold resolution

- [ ] In `server/src/logs/repositories.service.ts`, add exported `ConfigValueSource` and `EffectiveChangeSurfaceThreshold` beside `CacheThresholdSource` (:88-95) and redefine `CacheThresholdSource` as an alias of `ConfigValueSource`, keeping it exported (plan DD-9).
- [ ] Extract the walk in `getEffectiveCacheThreshold` (:810-885) into a private `resolveEffectiveConfigNumber(userId, repoIds, read, fallback, teamId?)`, keeping the owned-teams union and the query order intact.
- [ ] Rewrite `getEffectiveCacheThreshold` as a thin delegate to that helper with no behaviour change.
- [ ] Add `readChangeSurfaceThreshold(config)` beside `readConfigThreshold` (:98-108), returning `null` unless the value is an integer within `[MIN, MAX]` per plan DD-10.
- [ ] Add `getEffectiveChangeSurfaceThreshold(userId, repoIds, teamId?)` delegating to the helper with that reader and `DEFAULT_CHANGE_SURFACE_FOCUSED_MAX_FILES`, returning `{ threshold, source }`.
- [ ] Verify the team-creation config seeding at `server/src/teams/teams.service.ts:334-349` carries the new field with no code change, as stated under Database changes; make no edit if it does.

### Chunk 3 — Metric + fold threading

- [ ] Add `focusedMaxFiles?: number` to `ComputeChangeSurfaceOptions` (`change-surface-metrics.ts:67-77`), default it to the exported constant, and use it in the floor guard at :481-486.
- [ ] Rewrite the Tier-1 leniency doc comment (`change-surface-metrics.ts:34-52`) for the configurable floor and its default of 10; state that Tier 2's `SMALL_CHANGE_MAX_FILES = 6` stays hardcoded (FR-13).
- [ ] Add required `focusedMaxFiles: number` to `ChangeSurfaceAggregateOptions` (:58-64) and pass it into the repo fold (:151), the per-session fold (:159) and the per-group fold (:224).
- [ ] Change `buildBuckets(facts)` to `buildBuckets(facts, focusedMaxFiles)` (:337) per plan DD-4, pass it to the per-bucket `computeChangeSurface` (:351), and update both call sites (:174, :227).
- [ ] Add required `focusedMaxFiles: number` to `ChangeSurfaceReportOptions` (`change-surface-report.service.ts:32-36`) and forward it in `build()` (:50).
- [ ] Add required `focusedMaxFiles: number` to `ChangeSurfaceSessionScope` (`change-surface.service.ts:37-40`), use it at :73, and comment `notComputedAggregate()` (:159) and `emptyResult()` (:373) with the zero-file carve-out per plan DD-5.

### Chunk 4 — Controllers

- [ ] In `resolveChangeSurfaceSessionScope` (`repositories.controller.ts:1441-1466`), after `resolveRepoIds`, await `getEffectiveChangeSurfaceThreshold(user.id, repoIds, teamId)` and return `focusedMaxFiles` on the returned `scope` object.
- [ ] Restructure the `ownerUserId` ternary at `repositories.controller.ts:1459-1463` so its `isTeamVisibilityEnabled` await is a plain expression, then run it and the threshold resolution in one `Promise.all` after `resolveRepoIds`.
- [ ] In the analytics change-surface route (`repositories.controller.ts:2893-2905`), resolve the threshold and pass `focusedMaxFiles` into `changeSurfaceAggregateService.build`.
- [ ] In `getChangeSurfaceReport` (`reports.controller.ts:351-393`), resolve the threshold from `scope.requesterUserId` and `scope.teamId` after `resolveUsageScope` (plan DD-8) and pass `focusedMaxFiles` into `changeSurfaceReportService.build`.
- [ ] Confirm the files route (`repositories.controller.ts:1402-1435`) compiles against the extended scope, accepting its unused extra resolution per plan DD-15, and that no route gains a query param or exposes `source` (plan DD-11, FR-12).

### Chunk 5 — Settings UI + stale client comments

- [ ] Add `MergeSurfaceThresholdSetting` to `client/src/viewer/pages/repository/AnalysisSettings.tsx`, cloning `CacheCreationThresholdSetting` (:17-100) with the label, ids, `step={1}` and bounds from Visual/UX notes.
- [ ] In `RepositorySettings.tsx`, derive `savedMergeSurfaceThreshold` and `effectiveMergeSurfaceThreshold` from the response's own `userConfig` / `teamConfig` per plan DD-14 — not from `effectiveConfig`.
- [ ] Extend `withSavedAnalysisSettings()` (:137-147) to carry `changeSurfaceFocusedMaxFiles` through the File-Categories save path so it is not clobbered.
- [ ] Add `saveMergeSurfaceThreshold(value)` as a read-modify-write mirroring `saveThreshold` (:149-154), and mount the control in the Analysis tab body (:300-332) under a `border-t border-border pt-8` divider with `key={effectiveMergeSurfaceThreshold}`.
- [ ] Extend the mutation's `onSuccess` (:87-104) to invalidate the three change-surface query-key prefixes listed in plan DD-7.
- [ ] Correct the stale "the floor bands any change of up to 5 files focused" claim in `detectors/change-surface-spread.ts` (:6-8) and `detectors/thresholds.ts` (:24-26) to be threshold-relative; leave every constant and guard unchanged.
- [ ] Correct the same stale rationale in `client/src/viewer/__tests__/unit/change-surface-detectors.test.ts` at :74-75 and :106-110, and retitle the test at :107 so it no longer asserts "6-file" is the smallest scattered scope; leave the synthetic summaries and assertions unchanged.

### Chunk 6 — Knowledgebase, wireframes & task docs

- [ ] Rewrite the Tier-1 "focused floor" block in `docs/knowledgebase/change-surface.md` (:79-92) for the configurable threshold and its default of 10, replacing every "up to five files" / "From `F = 6` up" phrasing.
- [ ] Update the Tier-2 block in the same file (:95-98) so "With the floor covering everything up to 5 files…" is restated against the configurable threshold, and state that `SMALL_CHANGE_MAX_FILES = 6` stays hardcoded (FR-13).
- [ ] Add a "threshold in force" column to the worked-checks table (:113-121) and the two new anchor rows from the pinned-figures table in this plan (10 files → 60 focused; 12 files → 4 scattered).
- [ ] Update `change-surface.md` §1 (:27-39), §4 (:176-190), §5 (:199+) and the §11 checklist (:334-345) to name the new config field, its resolution order, the per-requester threshold behind AC-9, and that nothing is stored or backfilled.
- [ ] Add a `changeSurfaceFocusedMaxFiles` paragraph to `docs/knowledgebase/db-tables.md` `repo_config` (:615-643) mirroring the `highCacheCreationThreshold` one, and fix the stale "Two things live in the `config` blob" count at :613 (now four).
- [ ] Document the field in `docs/knowledgebase/api-reference.md`'s `RepoConfig` block (:110-127) and both settings PUT blocks (:1005-1040) with the 400 bounds from API changes, and add the field note to `docs/knowledgebase/server-endpoint-map.md` (:626-632).
- [ ] Add the third control to `docs/knowledgebase/client-component-map.md` (:140), and correct both wireframe SVGs per the Wireframes section (60 not 62, restated footer rule, resolved open-question captions).
- [ ] Mark OQ-1 and OQ-2 resolved in `requirements.md` per plan DD-1 / DD-2, then refresh `open-questions.md`, `design-decisions.md` and `tldr-overview.md` (in English, per the CLAUDE.md documentation-language rule), including 62 → 60.

### Chunk 7 — Server unit tests

- [ ] Pass `focusedMaxFiles: 5` to the three `change-surface-metrics.spec.ts` cases that flip at the new default (:89, :166, :256) so each keeps pinning its original figure (AC-2), and rename the `FOCUSED_SMALL_CHANGE_MAX_FILES` references in their comments (:129, :225).
- [ ] Add metric specs for the AC-5 edges: 10 files across 10 top-level modules → `60`/`focused`, 11 → `4`/`scattered`, both at the default threshold.
- [ ] Add a metric spec for the above-threshold scattered anchor: 12 files / 12 folders / 12 modules → `4`/`scattered` at the default (AC-2).
- [ ] Add a metric spec for the reported session's shape — 3 files across `docs/` and `client/` (2 modules) → `60`/`focused` (AC-1, plan DD-12).
- [ ] Add a metric spec that a zero-file scope keeps `concentration: null` and `band: null` for any `focusedMaxFiles` including `1` (plan DD-5).
- [ ] Extend `repositories.service.spec.ts` with the `validateConfig` accept/reject table for the new field per Test coverage plan, and assert the existing cache-threshold block still passes unmodified.
- [ ] Add `getEffectiveChangeSurfaceThreshold` resolution-order specs per Test coverage plan, and widen `change-surface-aggregate.spec.ts`'s `SCOPE` annotation (:79) to add `focusedMaxFiles` plus one case proving it reaches the bucket and group folds.

### Chunk 8 — e2e & client tests

- [ ] Grow the scatter fixture in `server/test/change-surface.e2e-spec.ts` (:554-566) to 12 single-file top-level modules `a`…`l` per plan DD-13.
- [ ] Update `SCATTERED_CONCENTRATION` to `4` (:338, derivation comment :337), rename the dead `FOCUSED_SMALL_CHANGE_MAX_FILES` in the `FAR_CONCENTRATION` comment (:345-347), and change the AC-2 assertion (:813-822) to 12 files / 12 folders / 12 single-file folders / modules `a`…`l` plus a "twelve" title.
- [ ] Seed a new 8-file / 8-single-file-top-level-module session in the same file per plan DD-13, and assert it reads `60`/`focused` with nothing configured.
- [ ] Add an e2e case that `PUT`s a user-scoped `changeSurfaceFocusedMaxFiles: 5` and re-fetches that 8-file session, asserting the band flips to `scattered` with concentration `6` (AC-6, AC-9).
- [ ] Add an e2e case following `server/test/cache-read-ratio-report.e2e-spec.ts:880-1022`: a team-scoped value applies to a member, that member's personal value overrides it, and a second member's view is unchanged (AC-6, AC-7).
- [ ] Add an e2e case asserting 400 and no partial write for a non-integer, `0` and an above-max value (AC-8), then confirm `change-surface-report.e2e-spec.ts` and `change-surface-analytics.e2e-spec.ts` pass unchanged.
- [ ] Rework `client/src/viewer/__tests__/components/RepositorySettings.test.tsx` (:89-150) to scope Save-button lookups by `data-testid`, and add the round-trip, range-validation and plan DD-14 tests from Test coverage plan.
- [ ] Add the Playwright coverage from Test coverage plan to `tests/e2e/change-surface-tab.spec.ts`, copying `navigateToAnalysisSettings()` from `tests/e2e/cache-read-ratio.spec.ts:95-101`.
