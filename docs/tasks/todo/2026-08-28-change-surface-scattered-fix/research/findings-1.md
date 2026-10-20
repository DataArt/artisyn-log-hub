# T-120 research findings (audit archive) — 2026-08-28

## Requirements summary

T-120 fixes a misclassification in the server-side change-surface concentration banding: a session with 3 changed files across 2 top-level modules (`client/`, `docs/`) currently scores ≈28 and bands "scattered". The new rule: any session with **≤ 5 changed files bands as "focused"** regardless of top-level module spread (FR-3; exact shape — score floor vs. band override — is a planning decision); sessions with 6+ files keep the existing score-based banding, so genuinely scattered changes (KB §2 anchor: 6 files / 6 folders / 6 modules, score 8) stay scattered (FR-4/AC-2). The fix lives entirely in `computeChangeSurface()` / `concentrationBand()` on the server (T-117 DD-13: bands are server-only); the client CS-1 detector needs no change (its `foldersTouched >= 5` guard already silences it for the reported session — AC-1's detector clause is a no-regression check). Pinned tests, the KB worked-checks table, and leniency comments are updated to the new behavior (FR-5, AC-3, AC-4). No migration: concentration/band are never stored, recomputed at read time.

## Wireframes

Two SVGs, both reviewed:
- `docs/tasks/todo/2026-08-28-change-surface-scattered-fix/wireframes/change-surface-tab-headline.svg` — 3 panels: BEFORE (3 files / 3 folders / 2 modules / depth 0 → "28 / 100 scattered"), AFTER (same session → "62 / 100 focused" — **explicitly marked illustrative**), NO-REGRESSION (14 files / 11 folders / 6 modules → "8 / 100 scattered" stays). Only the Concentration cell changes; no layout change. Footer sketches a guard `topLevelFolders ≤ N AND changedFiles ≤ M ⇒ never scattered` — note the footer's open questions are now resolved by requirements.md (≤ 5 files ⇒ focused; "top folder" = `topLevelModules`/T; the 2-file case flips).
- `wireframes/summary-change-surface-tile.svg` — Summary tile flips together with the tab (same server band); "62 / 100 focused" again marked illustrative; notes CS-1 no-regression.
- Caveat: `design-decisions.md` in the task folder is stale relative to requirements.md (still says "not-scattered is enough", "2-file case undecided") — requirements.md + `open-questions.md` answers are authoritative (owner: "any change up to 5 files is focused", 2-file `a/x`+`z/y` case "must be focused").

## Knowledgebase

- `docs/knowledgebase/change-surface.md` — the governing article. §2 has the exact formula, the leniency block, the worked-checks table (must be updated), and the "band boundaries live in one place" rule; §11 checklist (never compare against 60/40 in client code, single `computeChangeSurface()` implementation). This file itself is a deliverable (FR-5).
- `docs/knowledgebase/session-metrics-scope.md` — union/set-metric class; no changes expected but referenced by change-surface.md.
- Conventions to follow: exactly one metric implementation; bands computed only in `concentrationBand()`; client only maps `band` → label/colour; concentration never stored.

## Existing patterns

**Server metric (the fix target):**
- `server/src/logs/change-surface/change-surface-metrics.ts:46` — `SMALL_CHANGE_MAX_FILES = 6`; its doc comment (lines 34–45) explicitly asserts "2 files in two *unrelated* top-level modules must still score scattered" — directly contradicted by the new rule, FR-5 says update it.
- `change-surface-metrics.ts:49-50` — `BAND_FOCUSED_MIN = 60`, `BAND_MIXED_MIN = 40`. **Exact current banding: focused ≥ 60, mixed 40–59, scattered < 40** (`concentrationBand()` at lines 105–110; `null` → `null`, never scattered).
- `change-surface-metrics.ts:29-32` — weights: E 0.40, S 0.25, M 0.20, D 0.15.
- `change-surface-metrics.ts:459-474` — score computation: `smallness = F ≤ 6 ? 1 − (F−1)/6 : 0`; `closeness = smallness × D`; `E' = E + closeness(1−E)`, `S' = S + closeness(1−S)`; `concentration = clamp(round(100·(0.40E' + 0.25S' + 0.20M + 0.15D)), 0, 100)`. `E = 1 − H/ln K` (1 if K=1), `S = max(nᵢ)/F`, `M = 1/T`, `D = 1 − meanSep` (1 if K<2), `sep(u,v) = ((dᵤ−c)+(dᵥ−c))/(dᵤ+dᵥ)`.
- `change-surface-metrics.ts:474` — note `Math.round` half-up: the far pair is 0.225 → 22.5 → **23**.
- Callers (no second implementation to touch): `change-surface.service.ts:73,159`; `change-surface-aggregate.service.ts:151,159,224,351,373`.

**Pinned server unit tests** (`server/src/logs/change-surface/change-surface-metrics.spec.ts`):
- Line 122-133 — `a/x` + `z/y` (F=2): pins `concentration 23`, `band 'scattered'` → **flips to focused** (AC-4 explicitly demands updating this test).
- Line 209-218 — `client/a.ts` + `server/b.ts` (F=2, score 23): pins `band 'scattered'`; test title "file count alone is not enough" contradicts the new rule → **flips to focused**.
- Line 145-160 — shallow pair `a/one.ts` + `z/two.ts` (F=2): pins `shallow.concentration = 23` (band not asserted); score assertion survives only if the implementation is a band-override that leaves the score at 23; band would now be focused.
- Line 89-103 — 6 files / 6 folders / 6 modules → 8, scattered: F=6 > 5, **must stay** (AC-2 anchor).
- Line 105-120 — near pair → 72 focused; line 220-231 — 7 files one-per-folder under `mod/` → band not focused (exact score 31: E'=0, S=1/7=0.142857, M=1, D=0.5 → 0.310714 → 31 → scattered) — F=7, unaffected.
- Line 268-284 — `concentrationBand` boundary tests (39/40/59/60) — unchanged unless boundaries move.

**Pinned e2e tests** (`server/test/change-surface.e2e-spec.ts`):
- Line 347 — `FAR_CONCENTRATION = 23`, asserted at 853-854 and 870 (far pair, F=2). No `band` assertion exists for the far session, so under a band-override implementation these survive untouched; under a score-floor implementation the constant must change.
- Line 338 — `SCATTERED_CONCENTRATION = 8` (6 files), asserted with `band 'scattered'` at 812-821 — must keep passing.
- Line 344 `NEAR_CONCENTRATION = 72`, line 353 `TREE_CONCENTRATION = 62` (3 files, already focused) — survive under band-override; change under score-floor.

**Client (no logic change expected, comments/tests reference the old fact):**
- `client/src/viewer/pages/repository/session-log/summary/detectors/thresholds.ts:31` — `CHANGE_SURFACE_SCATTERED_MIN_FOLDERS = 5` (plus `CHANGE_SURFACE_MAX_TOP_MODULES = 4`, `CHANGE_SURFACE_SINGLE_FILE_FOLDER_SHARE = 0.5`, `CHANGE_SURFACE_SINGLE_FILE_MIN_FOLDERS = 4`). Doc comment at lines 25-27 says "a 2-file/2-folder change scores in the scattered band" — becomes stale.
- `detectors/change-surface-spread.ts:47` — CS-1 fires only on `band === 'scattered'` AND `foldersTouched >= 5`; comment lines 6-8 reference the 2-file scattered case — stale.
- Band → UI path: server payload `band` → `session-summary-derive.ts:392` (`changeSurfaceBand: cs?.band ?? null`) → Summary tile `SummaryExecutiveBand.tsx:239,253` (`bandLabel`/`bandTextClass`); tab headline `change-surface/ChangeSurfaceHeadline.tsx:73-74`. Label/colour mapping + legend copy: `client/src/viewer/lib/change-surface-ui.ts:59-67` (`CHANGE_BAND_LEGEND` prints "≥ 60 / 40–59 / < 40" — display copy only, but becomes misleading if a band override lets "23 / 100 focused" render).
- Client tests take `band` from fixtures (`__tests__/unit/change-surface-detectors.test.ts`, `session-summary-derive.test.ts:825`), so none flip from the server change.

**KB worked-checks table** (`docs/knowledgebase/change-surface.md`, §2 table at lines 99-109): row "`a/x` + `z/y`, 1 file each → 23" — its implied band **flips to focused** (AC-4). Rows staying: 6-files case (8, scattered, F=6), near pair (72, focused), `srv/api`+`srv/web` (62, focused, F=3 — already focused). Also stale: §2 leniency prose (lines 82-93, "2 files in two unrelated top-level modules must still score scattered") and the detector-guard note at lines 140-143 ("a 2-file/2-folder session scores 23 (scattered)").

**Complete list of pinned artifacts whose expected band changes under "≤ 5 files ⇒ focused":** spec lines 122-133 (`a/x`+`z/y`, 23/scattered→focused), spec lines 209-218 (`client`+`server`, scattered→focused), spec lines 145-160 (shallow pair — band unasserted, but score 23 pinned), KB §2 table `a/x`+`z/y` row, KB §2 leniency prose + line 141 note, thresholds.ts + change-surface-spread.ts + change-surface-metrics.ts comments; e2e `FAR_CONCENTRATION = 23` only if the score (not just the band) changes. Nothing pinned currently bands "mixed" at F ≤ 5.

## Open gaps

- **Implementation shape (FR-3 leaves it to planning): band override vs. score floor.** Wireframes show a changed *score* ("62 / 100 focused", marked illustrative); a pure band override would render e.g. "23 / 100 focused", contradicting the displayed legend copy `focused ≥ 60` (`CHANGE_BAND_LEGEND`, KB §2, wireframe legends). If a score floor (e.g. concentration = max(score, 60) when F ≤ 5) is chosen, the pinned scores 23 (spec ×2, e2e `FAR_CONCENTRATION`) change and the legend stays truthful; if a band override, the legend copy in `change-surface-ui.ts:59-67` and KB §2 band line need re-wording ("or ≤ 5 files"). The plan must pick one.
- **Aggregate scopes**: `computeChangeSurface()` also runs over report periods, chart buckets, and groups — a week bucket with ≤ 5 files in its union would also band focused under the new rule. Requirements only discuss sessions; behavior for multi-session scopes is implicitly "same rule" (single implementation) — plan should state this consciously.
- FR-1/FR-2 ask that `topLevelModules` (T) and total files both be "taken into account", but the concrete resolved rule (FR-3) only uses file count; whether T gets any additional weight for the 6+-file regime is undecided (owner: "use common sense"). The 6-file anchor constrains it: 6 files / 6 modules must stay scattered.
- Task-folder companion docs (`design-decisions.md`, `open-questions.md`, `tldr-overview.md`) must be refreshed when the plan writes/updates task documents.
