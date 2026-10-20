# T-120: Open questions

The first-iteration questions (2026-08-28) are closed and integrated into `requirements.md`.
After the scope extension on the same day, two **non-blocking** questions remain — planning
can start without waiting for the answers.

## Open

- **OQ-1 (naming).** The owner's label is **"Merge surface threshold"**, whereas
  the feature itself, the KB article, the DB columns and the API fields are called **change surface**.
  Proposal: keep the owner's label in the UI as is, and in the documentation state the code-level
  name next to it, so that the two names are not confused. The name of the stored field
  needs to be fixed during planning: `mergeSurfaceThreshold` or
  `changeSurfaceFocusedMaxFiles`.
- **OQ-2 (validation upper bound).** Proposal — **1000 files**: above this
  value any real scope becomes focused and the "scattered" band stops being
  reachable. Confirm during planning.

## Closed earlier (summary; details in `design-decisions.md`)

- The fix is on the server, as it is done now; we do not overcomplicate.
- Rule: a change up to and including the threshold in size — the "focused" band
  (implementation: floor `concentration = max(score, 60)`).
- Threshold: previously a hardcoded 5 files; **now a repository setting with a default of
  10** — separately for a private repository and for a team, resolution
  user → team → default.
- The "2 files in 2 unrelated top modules" case also flips to focused.
- We consider T-117 done and do not keep its wording — the artifacts are simply
  updated for the new behavior.
- "Top folder" — a folder at the project root (`topLevelModules` / T).
- The AC-2 anchor from KB §2 (6 files / 6 modules, score 8 → scattered) stays, but is now
  written with the effective threshold stated explicitly; with the default of 10 an
  additional anchor above the threshold is needed.

## Note on the plan

`impl-plan.md` is outdated: it covers only the server constant edit (3 chunks) and does not
account for the config, validation, API and UI. Before implementation — `/task-plan-deep T-120`.
