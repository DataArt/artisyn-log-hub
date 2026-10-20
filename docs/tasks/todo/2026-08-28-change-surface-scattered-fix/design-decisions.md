# T-120: Key design decisions

Updated 2026-08-28: the owner's answers from `open-questions.md` are integrated into
`requirements.md`; on the same day the owner extended the task scope — the threshold became
configurable (DD-14…DD-21). Current decisions:

- **A score floor, not a band override.** At the end of
  `computeChangeSurface()`: if the number of changed files does not exceed the threshold —
  `concentration = max(score, BAND_FOCUSED_MIN /* 60 */)`. The band stays a pure
  function of the score via the untouched `concentrationBand()`, and the client legend
  ("focused ≥ 60") stays truthful (DD-1).
- **The threshold is no longer a constant.** Previously it was "≤ 5 files inclusive"
  (`FOCUSED_SMALL_CHANGE_MAX_FILES = 5`); now it is a repository setting with a
  default value of **10**. Above the threshold the existing band logic applies.
  `SMALL_CHANGE_MAX_FILES = 6` (the second tier — "closeness blend") stays a hard
  internal constant and does NOT become configurable (DD-2, DD-21).
- For changes within the threshold, the spread across top modules deliberately does not matter
  (the owner's reasoning: "fixed an API on the server, a form on the client and the doc — that is a
  VERY focused change"). We do not add extra weight for T above the threshold —
  T is already part of the score as `M = 1/T` (DD-3).
- The floor applies in all scopes of the single `computeChangeSurface()` implementation:
  sessions, report periods, chart buckets, groups (DD-4).
- Empty scopes (0 files) do not change: `concentration: null` / `band: null` (DD-5).
- **The client does not change logically** as far as detectors go ("do it as it is now, let's not
  overcomplicate"): the CS-1 detector and the thresholds in `thresholds.ts` stay; only
  outdated comments and one outdated test fixture are edited. The only new thing on the
  client is the setting control (DD-6, DD-18).
- **We consider T-117 done and do not keep its wording** — the pinned
  tests/docs/comments are simply rewritten for the new rule, without "revises T-117"
  annotations (DD-7).
- The pinned case "2 files in 2 unrelated top modules (`a/x` + `z/y`) = 23 =
  scattered" **flips to focused**; likewise the `client/a.ts` +
  `server/b.ts` case. Cases already ≥ 60 (72, 62) do not change (DD-8, AC-4).
- "Top folder" = a folder at the project root, i.e. top modules (`topLevelModules` / T),
  not `foldersTouched` (K).
- AC-1 is tightened: the "3 files / 2 top modules" case must land specifically in the
  **focused** band, not merely "not scattered".
- No migration/backfill is needed: concentration/band are not stored and are recomputed
  on read — historical sessions will pick up the rule automatically (KB §5).
- No DB schema changes; the API shape does not break — only the returned
  `concentration`/`band` values for small changes change, plus one new
  optional field in the settings blob (type-level backward compatibility).

## Scope extension decisions (configurable threshold)

- **DD-14. Storage — in the existing jsonb `repo_config.config`.** A new
  optional integer field in `RepoConfigJson`, exactly like `highCacheCreationThreshold`
  (T-83). A missing field = "use the default value", so the product
  default can be changed without a migration. No new table and no migration.
- **DD-15. Two independent scopes.** A personal row (`user_id`, private repository)
  and a team row (`team_id`) — as with `fileCategories`. Resolution:
  **user → team → default**, reusing the logic of
  `getEffectiveCacheThreshold(userId, repoIds, teamId?)`, including handling of the
  "one `repo_url` — several `repositories` rows" case.
- **DD-16. Default = 10 files.** The owner's rationale: "a developer is able to review 10 files
  in any case". The constant is declared once on
  each side (server + a mirror on the client), like
  `DEFAULT_HIGH_CACHE_CREATION_THRESHOLD` / `cache-ratio-ui.ts`.
- **DD-17. Garbage is treated as "no value".** The blob is jsonb without a shape check at the
  DB level, so a non-integer/broken value is ignored on read and the threshold falls through to the
  next scope (the `readConfigThreshold()` pattern). Writing garbage is prevented by
  `validateConfig()`.
- **DD-18. UI — the Analysis tab in the repository settings**, next to "High
  cache-creation threshold", under the owner's label **"Merge surface threshold"** with
  the unit (files) stated explicitly. Permissions are the existing ones: the team value is edited by
  the team owner, others see it read-only with the caption "Managed by team
  owner"; the personal value is available to everyone and overrides the team value.
- **DD-19. Validation — integer, `>= 1`, not above an upper bound** (a pair of constants
  `*_MIN` / `*_MAX`, as for the cache threshold); a violation — HTTP 400, no partial write.
  The client control checks the same range before saving.
- **DD-20. The threshold is passed as a parameter into `computeChangeSurface(facts, options)`,
  not read inside the metric.** The metric stays a pure function, no second implementation
  of the rule appears, and no call may silently stay on the default — including
  the bucket call in `change-surface-aggregate.service.ts`, which is currently
  called without options.
- **DD-21. Only the "focused floor" becomes configurable.** The second tier
  (`closeness blend`, `SMALL_CHANGE_MAX_FILES = 6`) stays an internal constant:
  it is a smoothing of the formula, not a product review rule.
- **DD-22. The value source (`user` / `team` / `default`) is not shown in the change-surface
  UI** — out of the task scope, unless it comes "for free" (unlike the
  cache-ratio report, where `thresholdSource` is already displayed).
- **DD-23. All pinned cases in tests and the KB are rewritten with the effective threshold
  stated explicitly** — because the default rises from 5 to 10, the "6 files / 6 modules" case
  is no longer scattered under the default, so a separate anchor above the threshold is needed
  (for example, 12 files / 12 folders / 12 modules).
