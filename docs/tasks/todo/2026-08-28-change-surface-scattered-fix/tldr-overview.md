# T-120: In brief — what we change and what we get

A session with 3 changed files in `docs/` and `client/` is marked as **scattered**
(a "scattered" change), although in fact it is a very focused change.

**What will be changed (taking into account the scope extension of 2026-08-28):**

1. **Server, metric.** In `server/src/logs/change-surface/change-surface-metrics.ts` —
   a score floor: if the number of changed files in the scope is not above the threshold,
   `concentration = max(score, 60)`, i.e. the band automatically becomes **focused**
   (the 60/40 band boundaries and `concentrationBand()` are not touched). The threshold stops being
   a constant and is passed as a parameter into the single rollup function
   `computeChangeSurface(facts, options)` — through all its calls (session, report period,
   chart buckets, groups).
2. **A new setting "Merge surface threshold" (in number of files).** It is configured
   **separately for a private repository (personal value) and for a team**. It is stored in
   the already existing jsonb blob `repo_config.config` (`RepoConfigJson`) — a new
   optional integer field, like `highCacheCreationThreshold` from T-83. No new
   table and no migration.
3. **Resolution order:** personal row → team row → built-in default
   value, exactly as in `getEffectiveCacheThreshold()`. The default value is
   **10 files** (previously a hardcoded 5): "a developer is able to review 10 files
   in any case".
4. **UI:** a new control on the Repository Settings → **Analysis** tab, next to
   "High cache-creation threshold". The team owner edits the team value,
   others see it read-only with the caption "Managed by team owner"; the personal
   value can be set by any user, and it overrides the team value.
5. **Validation:** integer only, `>= 1`, not above an upper bound (proposal — 1000);
   a violation — HTTP 400. Garbage in the blob is treated as "no value".

**Result:** any change up to and including the threshold in size (10 files by default)
is shown as "focused" in the Change surface tab header and the Summary tile
(for the session from the bug: it was "28 / 100 scattered", it will be "60 / 100 focused").
Genuinely scattered changes (many files in many unrelated top folders)
still remain scattered. A team can tighten or loosen the threshold for itself, and
an individual developer can override it personally. Historical sessions pick up the
rule automatically: concentration/band are not stored and are recomputed on read,
there are no migrations.

**Wireframes:** the "before/after" diagrams in `wireframes/` stay current — the value
"62 / 100" on the AFTER panel is marked as illustrative, the actual one will be 60.

**Implementation plan:** `impl-plan.md` is **outdated** — it describes the edit of only the server
constant (3 chunks) and does not account for the config, API and UI. Before implementation the task
needs to be re-planned (`/task-plan-deep T-120`).
