# 2026-10-31: Session List Slow Due To Transcript JSONB Scans

**Status:** todo
**Priority:** high
**Type:** bug
**Module(s):** server (`server/src/logs/`, `server/perf-tests/`)
**Owner:** denis.tsyplakov
**Created:** 2026-10-31
**Tracker:** GH-69 https://github.com/DataArt/artisyn-log-hub/issues/69

## Description

`GET /api/v1/repositories/:repoId/sessions` takes 10–12 s on local prod (809 sessions, 169 MB of
claude jsonb bodies) because `getRepositorySessions` (`server/src/logs/repositories.controller.ts`)
scans transcript jsonb on every load: the `assistant_lines` / `session_events_jsonb` CTEs (~10.5 s)
and the `Workflow` jsonb query (~2.7 s), both growing with total transcript volume. Fix: denormalize
the needed flags into `session_stats` at ingest, backfill, drop the jsonb scans from the list, and
add a heavy-seed perf scenario with an absolute latency budget.

Facts that constrain the fix:

- The CTE model is not a response field: it is only the `rootModel` fallback of
  `readTreeCost(row, row.model)` (feeding `costBreakdown.unpricedModels` and
  `costUnavailableReason`), and the CTE also decides which sessions get a cost entry at all —
  only sessions with ≥ 1 non-sidechain assistant line (`FROM session_events_jsonb JOIN tree_costs`).
- `session_stats.model` cannot be reused: it falls back to the sidechain model, while the list
  shows the first main-thread (non-sidechain) model.
- `npm run perf` missed this because its seed transcript is tiny and its gate is only relative to
  `baseline.json`. The separate `2026-08-13-perf-harness-reliability` bug (failed scenarios
  reported as passing) is not a dependency, but the absolute budget must fail the run through a
  path that works regardless of it.

## Functional Requirements

- FR-1. `session_stats` gains `main_model` (nullable varchar): the first non-null
  `message.model` among assistant events of the session's own `claude` transcript that are not
  sidechain (`isSidechain` is not `true`), in log order — exactly the rule the current
  `assistant_lines` / `session_events_jsonb` CTEs implement (one line per `message.id`, falling
  back to `uuid`).
- FR-2. `session_stats` gains `has_workflow` (boolean, not null, default false): true when the
  session's `claude` transcript has an assistant event whose `message.content` holds a `tool_use`
  block named `Workflow` with a non-empty string `id` — the same predicate as `extractWorkflows`
  (`workflow-extractor.ts`) and the current list query.
- FR-2a. `session_stats` also gains `has_main_assistant` (boolean, not null, default false): true
  when the claude transcript has ≥ 1 non-sidechain assistant event (with or without a model), and
  `list_flags_version` (smallint, nullable): NULL = not yet computed, otherwise the version of the
  rule that computed the three flags (precedent: `sessions.tool_usage_version`).
- FR-3. Every path that writes `session_stats` from a claude transcript — `claude` log upsert,
  `importSession`, `recomputeAllSessionStats` (all via `extractClaudeStats` +
  `upsertSessionStatsRow`) — sets `main_model`, `has_workflow`, `has_main_assistant` and
  `list_flags_version`, computed in JS from the already-parsed events (no extra pass over the jsonb
  in SQL), in the same transaction. Paths that write `session_stats` without a claude transcript
  (`claude-subagent` uploads, the `telemetry_cost` insert) never overwrite these columns. A
  re-upload of the same session recomputes them.
- FR-4. Existing sessions are backfilled by a startup step inside `initializeDatabase()` (per
  `.claude/rules/server.md`): a set-based SQL `UPDATE session_stats … WHERE list_flags_version IS
  NULL`, reusing the current `assistant_lines` CTE and `Workflow` predicate verbatim (exact parity
  with today's list), committed per repository so an interrupted run resumes where it stopped. It
  marks every pending row, including rows without a claude log (flags false/NULL). The migration
  only adds columns — no data is deleted or rewritten.
- FR-5. `getRepositorySessions` reads the `readTreeCost` root-model fallback from
  `session_stats.main_model`, selected as `ss.main_model AS root_model` (no clash with
  `tc.main_model` of `TREE_COST_COLUMNS_SQL`), and `hasWorkflow` from `session_stats.has_workflow`;
  the `assistant_lines` / `session_events_jsonb` CTEs and the separate `Workflow` jsonb query are
  removed. Cost-entry membership stays as today: a session gets cost fields only when
  `has_main_assistant` is true; a session with main-thread assistant events but no model gets cost
  fields with a null root model; a session with none gets the same nulls / `EMPTY_COST_BREAKDOWN`
  as today.
- FR-6. The response shape of `GET /api/v1/repositories/:repoId/sessions` does not change. Old
  hooks need no update: the server derives the new columns from the logs they already send.
- FR-7. Any other route that computes the "first main-thread model" or `hasWorkflow` from raw
  jsonb the same way switches to the new columns too (grep during planning).
- FR-8. Perf test: a heavy seed in a separate perf repo with realistic transcript volume
  (order of 30 sessions × ~1 MB claude transcript, some with `Workflow` tool_use and sub-agents)
  and a scenario `repos:sessions-heavy` on it. `Scenario` gets optional per-scenario
  `iterations` / `warmupIterations` / `parallel` overrides; `repos:sessions-heavy` uses 20 / 2 / 1.
  The harness gets a per-request timeout of 30 s; a timed-out request counts as an error.
- FR-9. Perf test: an absolute latency budget per scenario in `server/perf-tests/budgets.json`
  (next to `constants.json`), format `{ "<scenario>": { "p95Ms": <n> } }`, compared against the p95
  of the scenario's iterations with warm-up excluded. Starting values: `repos:sessions-heavy` and
  `repos:sessions` p95 ≤ 500 ms. A budgeted scenario fails when its p95 exceeds the budget or it has
  errors > 0; scenarios without an entry are unbudgeted; a skipped scenario is reported as skipped,
  not as a failure. Any budget failure fails `npm run perf` with a non-zero exit code,
  independently of the `baseline.json` comparison.
- FR-10. Perf test against an existing instance with real data (e.g. the maintainer's local prod
  at http://localhost:5003). The target URL override already
  exists (`PERF_BASE_URL`, `server/perf-tests/config.ts`); add:
  - a test-user email override (`PERF_EMAIL`, plus `PERF_PASSWORD` for password modes) — repos
    are private to their owner, so the run must identify as the repo owner to see real sessions;
  - a target repo override (`PERF_REPO_ID`) used instead of the seeded repo by the repo-scoped
    read scenarios (`repos:sessions`, `repos:summary`, `repos:branches`, analytics, …);
    session-scoped scenarios use the most recent session of that repo. Before the scenarios run,
    the harness checks that `GET /repositories/:PERF_REPO_ID/sessions` returns ≥ 1 session for the
    identified user, otherwise it aborts with a clear message (repo not found / not visible to
    `PERF_EMAIL` / no sessions) and a non-zero exit code;
  - a **read-only mode** (`PERF_READONLY=1`, forced on whenever `PERF_REPO_ID` is set): no seed
    upload, no heavy seed, and every scenario that writes (`logs:*` uploads, `otel:realtime-*`,
    `*:create-delete`, favorites, …) is skipped and reported as skipped. The harness itself also
    does not create/delete its API key, never signs up a user (fails fast with a clear message if
    login/identify fails), does not require `DATABASE_URL` and opens no pg connection (no seed
    drain polling, no `cleanupDb`), so a run never writes to the target DB. The run's baseline /
    report go to a separate file per target, never mixing with the dev baseline.

## Non-Functional Requirements

- On local prod data (809 sessions, 169 MB of claude bodies) the session list responds in
  **< 500 ms** (target well below; today 10–12 s).
- The one-time backfill on that DB finishes within about a minute (≈ 13 s expected); later starts
  find no pending rows and add no startup time.
- Backward compatibility: older hooks and older API clients keep working unchanged.

## Acceptance Criteria

- [ ] AC-1 (FR-1, FR-5). For every session on a copy of real data, `totalCost`, `computedCost`,
      `costBreakdown` (including `unpricedModels`) and `costUnavailableReason` returned by the list
      after the change equal the values before the change — including a session whose transcript
      has only sidechain assistant lines and one with main-thread assistant lines but no model.
- [ ] AC-2 (FR-2, FR-5). For every session, `hasWorkflow` after the change equals the value before
      the change.
- [ ] AC-3 (FR-3). Uploading a new session (and re-uploading it with a `Workflow` call added)
      updates `main_model` / `has_workflow` without a restart; running `recomputeAllSessionStats`
      or an import afterwards leaves the list output unchanged.
- [ ] AC-4 (FR-4). After upgrading a DB with existing sessions, no `session_stats` row has
      `list_flags_version` NULL after the first start; a second start selects 0 rows.
- [ ] AC-5 (FR-5, NFR). On local prod the list query plan contains no `jsonb_array_elements` /
      `@>` over `logs.body` for claude logs, and the endpoint answers in < 500 ms.
- [ ] AC-6 (FR-6). The sessions-list API contract row and the scenario covering the session list
      pass unchanged.
- [ ] AC-7 (FR-8, FR-9). On the code before the fix, `npm run perf` fails on the
      `repos:sessions-heavy` budget; on the code after the fix, it passes.
- [ ] AC-8 (FR-9). The failure is visible in the console output and as a non-zero exit code.
- [ ] AC-9 (FR-10). `PERF_BASE_URL=http://localhost:5003 PERF_EMAIL=<owner> PERF_REPO_ID=1 npm run perf`
      runs the read scenarios against local prod and shows `repos:sessions` at 10+ s before the
      fix and under the budget after it.
- [ ] AC-10 (FR-10). After such a run the target DB has no new rows from the run: row counts of
      `sessions`, `logs`, `repositories`, `teams`, `api_keys`, `upload_queue` are unchanged
      (the identify call may create the user row only if it did not exist), and the run sent no
      POST/PUT/PATCH/DELETE request other than the identify/login call.

## Steps to Reproduce

1. Run a production build with a repo that has ~170 claude transcripts (~170 MB of jsonb), e.g.
   local prod at http://localhost:5003, identify as the repo owner.
2. `curl -w "%{time_total}" http://localhost:5003/api/v1/repositories/1/sessions` with the session
   cookie.

**Expected:** the list returns in well under a second.
**Actual:** 10–12 s; the time is spent in the `assistant_lines` CTE (~10.5 s) and the `Workflow`
jsonb scan (~2.7 s).

## Common sense considerations

- Backfill state is tracked by an explicit `list_flags_version` marker column, not inferred from NULL/false values.
- The backfill is set-based SQL inside `initializeDatabase()`, reusing the current CTE verbatim, committed per repository.
- Cost-entry membership is unchanged (FR-6), stored as `has_main_assistant`.
- AC-1 checks every cost field, plus the sidechain-only and no-model edge cases.
- The new model is selected as `root_model` to avoid clashing with `tc.main_model`.
- Every claude-transcript writer sets the new columns; other writers never touch them.
- The budget compares p95 (warm-up excluded) at 500 ms, the NFR target.
- Budgets live in `server/perf-tests/budgets.json`; scenarios without an entry are unbudgeted.
- Errors > 0 fail a budgeted scenario; a skipped scenario does not.
- Per-scenario iteration overrides: `repos:sessions-heavy` runs 20 iterations, 2 warm-up, parallel 1.
- Per-request timeout: 30 s, and a timeout counts as an error.
- Read-only mode skips the API key, signup and every DB connection.
- AC-10 also forbids mutating requests apart from identify/login.
- A misconfigured `PERF_REPO_ID` / `PERF_EMAIL` aborts the run up front; session-scoped scenarios use the most recent session.

## Open Questions

None.

## Notes

<!-- Append timestamped notes here as work progresses -->

- Investigation measurements and perf-gap analysis: see `notes.md`.
