# T-96: Perf Harness Reports Failed Scenarios As Passing, Making The 20% Gate Unenforceable

**Status:** todo
**Priority:** high
**Type:** bug
**Module(s):** server (`server/perf-tests/`)
**Owner:** denis.tsyplakov
**Created:** 2026-08-13

## Description

`.claude/rules/server.md` requires `npm run perf` after every server change, with a hard rule:
*"Ensure metrics do not degrade more than 20%. Stop and ask the user if performance degrades more
than 20%."* That gate cannot currently be enforced, because the harness silently reports failed
scenarios as passing and its own regression threshold does not match the rule.

Any real regression on a log-ingest route can therefore pass unnoticed, and any false alarm costs a
long manual investigation. Found while verifying T-95 (gzip log upload), whose perf question is
consequently unmeasured rather than measured-good — see `notes.md`. See
`docs/knowledgebase/server-conventions.md` § "Performance Testing Framework" for the framework
overview (that article needs updating once this is fixed).

## Functional Requirements

- A scenario with any failed iteration must not be reported as passing. `runner.ts:92-94` prints
  `✓` unconditionally; the console line, the JSON report and the process exit code must all
  reflect failure.
- Every scenario result carries an explicit outcome. `ScenarioResult` (`types.ts:46-52`) gains
  `status: 'passed' | 'failed' | 'skipped'`, `skipReason?: string`,
  `statusCodes: Record<string, number>`, `sampleFailureBody?: string` and `successCount: number`.
- Statistics cover successful requests only. `runner.ts:59-66` currently pushes every attempt's
  duration into `durations[]` regardless of outcome, so a scenario failing 500/500 reports its
  failure latency as its performance. For a partially-failing scenario the percentiles cover the
  successful subset: `Stats.count` means successful samples, `iterations` stays the attempt count.
  A scenario with zero successful requests reports `mean`/`p50`/`p95`/`p99` as `null`, not `0`
  (`calcStats([])` returns all-zeros at `runner.ts:4-7`), renders as `—` in console and HTML, and is
  excluded from the regression/improvement comparison entirely — it can never be classified as
  FASTER or OK.
- Failures must be diagnosable. `Scenario.fn` returns
  `{ ok: boolean; status?: number; body?: string; error?: string }` — `types.ts:28` declares
  `Promise<{ ok: boolean }>` today, all 25 scenarios return only `ok`, and `runner.ts:62`
  (`catch { ok = false }`) discards everything. Report a status-code histogram plus one sample body
  per distinct failing status. Transport-level exceptions (`runner.ts:59-64`, which has no
  `Response` at all) bucket under a synthetic histogram key derived from `err.code`/`err.message`,
  e.g. `ERR:ECONNRESET`. Multi-request scenarios (`teams:create-delete`, `api-keys:create-delete`,
  `repos:session-favorite`) report the first non-ok response. Bodies are read *after* the duration
  is recorded, so diagnostics never inflate the latency they explain, and are truncated to 500
  characters.
- The regression gate must be percentage-based to match `.claude/rules/server.md`, and all three
  threshold sites must share that one rule: the console gate (`reporter.ts:211-218`, currently an
  absolute `md > 10` ms), the HTML delta colouring (`deltaCell`, `reporter.ts:81-88`, currently an
  absolute ±5ms) and the HTML footer text `"Threshold ±5ms"` (`reporter.ts:178`). The current
  absolute threshold disagrees with the 20% rule in both directions — it flagged only `logs:large`
  while five other scenarios were over 20%.
- Baselines predating this task must keep loading (CLAUDE.md's backward-compatibility rule).
  `loadBaseline` (`reporter.ts:17-26`) blind-casts the file to `Report` and the live
  `docs/perftests/baseline.json` has none of the new fields, so rows missing `status` are treated as
  `passed` with no histogram, and a `null` metric on either side suppresses the delta instead of
  throwing or rendering `0`.
- Scenarios that cannot run under the active `AUTH_MODE` must be skipped and reported as skipped,
  never counted as passing. `auth:login` POSTs `/api/v1/auth/login`, which `AuthModeGuard` 404s
  under `AUTH_MODE=none` — the project's normal mode, see `CLAUDE.local.md`. The gate is
  declarative and covers all four modes: `AuthClient` exposes the mode it detects in `_ensureUser()`
  via a public getter (mirroring the existing `userId`/`apiKeyHeader` getters), `buildScenarios`
  receives it, and `Scenario` gains `requiresAuthModes?: string[]` with `auth:login` declared
  `['password', 'password-confirm']` — `auth-mode.guard.ts` and `auth.controller.ts:84,112` show
  four modes (`none`, `password`, `password-confirm`, `azure-oauth`) and login/signup 404 under
  `azure-oauth` too, so the rule is not simply "not none".
- No scenario may silently disappear from a report. A seed failure (`run.ts:39-44` warns and returns
  `{}`) currently removes ~12 `repos:*`/`session:*` scenarios from the results array while the run
  still prints `✓ Done — N scenarios, 0 total errors` and exits 0. Every declared scenario must
  appear in every report as passed, failed or skipped so the scenario count stays constant, and the
  baseline comparison must iterate the union of baseline and current scenario names, printing
  `(missing)` for a baseline scenario absent from the current run.
- Run-to-run variance must be brought low enough that a 20% threshold is meaningful, or the gate
  must be redefined (e.g. multiple runs + median, or explicit confidence bounds). Two back-to-back
  runs on identical code differed by up to **±94%** — measurements in `notes.md`.

### Intended console output

```
✓ logs:small        mean  8.42ms  p95 14.10ms   500/500 ok
✗ logs:medium       FAILED        500 errors    404×500        <sample body>
⊘ auth:login        SKIPPED       requires AUTH_MODE=password|password-confirm
⚠ repos:analytics   mean 21.30ms  p95 38.90ms   REGRESSION +81% (baseline 11.80ms)
```

## Non-Functional Requirements

- Cleanup must remain complete: any user/session/log/repo row a run creates must be removed, and
  cleanup must run in a `finally` block so it still happens when the run exits non-zero. The harness
  deletes the perf user via `DELETE FROM users` (`run.ts:158-164`) gated on `userWasCreated`.
- Log-scenario session ids must be registered in `idCollector` before the request is issued. They
  are added only on success today (`scenarios.ts:69, 91, 114, 135, 156` —
  `if (res.ok) idCollector.sessionUuids.add(sid)`), so a request the server persisted but which then
  failed (timeout, socket reset) leaves rows `cleanupDb` (`run.ts:135-147`) never deletes.

## Acceptance Criteria

- [ ] A scenario failing every iteration exits non-zero and is visibly reported as failed.
- [ ] A scenario failing every iteration is never reported as FASTER or OK in the Δ-vs-baseline
      table; its metrics render as `—`, not `0`.
- [ ] `mean`/`p95` for a partially-failing scenario are computed only over successful requests.
- [ ] A failing scenario's report includes its status-code histogram and at least one response body.
- [ ] The regression gate triggers on a >20% degradation, matching `.claude/rules/server.md`.
- [ ] The HTML report's delta colouring and legend text use the same threshold as the console gate.
- [ ] A report generated against the pre-fix `docs/perftests/baseline.json` (no `status` field) runs
      without error and treats every baseline row as passed.
- [ ] `npm run perf` completes with zero errors under `AUTH_MODE=none`, with password-only
      scenarios explicitly listed as skipped.
- [ ] Every report lists all 25 declared scenarios regardless of skips or failures.
- [ ] A run where seeding fails lists every dependent `repos:*`/`session:*` scenario as skipped and
      does not print `0 total errors` as success.
- [ ] Two consecutive runs on unchanged code stay within the gate's own threshold.
- [ ] After a run that includes failed log POSTs, no `sessions`/`logs`/`repositories` rows created
      by the run remain (verified by row counts before and after).
- [ ] DB cleanup runs even when the run exits non-zero.
- [ ] The root cause of the run-B failure burst is identified or shown to be resolved.
- [ ] `docs/knowledgebase/server-conventions.md` § "Performance Testing Framework" reflects the
      new behaviour.

## Common sense considerations

- Threshold and gate constants live in `perf-tests/constants.json`, not inline in `reporter.ts`.
- Iteration count, warmup and parallelism stay at their current `constants.json` values (500 / 100 /
  5), with the existing `PERF_ITERATIONS` / `PERF_WARMUP` / `PERF_PARALLEL` overrides
  (`config.ts:12-24`) unchanged.
- Skipping `auth:login` under `AUTH_MODE=none` does not require a substitute `auth:identify`
  scenario; `auth:me` (`scenarios.ts:44-51`) still covers the session-read path.
- Overlapping `npm run perf` runs are out of scope — CLAUDE.md's `app` resource group already forbids
  running app-level suites concurrently against the real DB.
- Deleting the stale tracked `.js` files noted below stays optional and out of this task's
  acceptance criteria.

## Steps to Reproduce

1. Ensure `AUTH_MODE=none` (this project's default).
2. From `server/`, run `npm run perf`.
3. Observe `auth:login` reporting `✓ mean 2.32ms p95 5.54ms err 500/500` — a passing tick and a
   "-72% faster" delta computed entirely from 404 responses.
4. Run `npm run perf` a second time, immediately after the first.

**Expected:** failed scenarios are reported as failures with diagnosable causes; two consecutive
runs on identical code produce comparable numbers.

**Actual:** run B reported **2148 errors** across five log scenarios while printing `✓` for all 25,
and `logs:medium` was reported as **"✓ FASTER, -92%"** (32.8ms → 2.13ms) purely because its failures
returned faster than its successes. Full breakdown in `notes.md`.

## Open Questions

- **Why did run B's log POSTs fail at all?** The server log has no entries in that window and no
  errors; failures took ~2ms, i.e. they died before reaching application code. Cause not
  established — diagnosing it needs the status capture required above. Possibly client-side
  (socket/ephemeral-port exhaustion after run A's ~12,500 requests two minutes earlier), but this
  is unverified.
- **Cleanup semantics under `AUTH_MODE=none`.** `_identify()` deliberately does not set
  `userWasCreated`, because identify is idempotent auto-provisioning and cannot report whether the
  row already existed; leaving one reusable user behind was chosen over risking
  `DELETE FROM users` on a row the run did not create. Consequence: the perf user now persists
  across runs. Decide whether that is acceptable or a pre-existence check should be added.
- Should the baseline be re-recorded? The current `docs/perftests/baseline.json` is from
  2026-08-10 and predates both the T-95 changes and the harness fixes.
- **At what error rate does `npm run perf` exit non-zero?** The Functional Requirements say a
  scenario with *any* failed iteration must make the exit code reflect failure (1/500 → non-zero);
  the Acceptance Criteria only require it for a scenario failing *every* iteration. Since
  `.claude/rules/server.md` mandates `npm run perf` after every server change, zero tolerance would
  fail nearly every run (run B alone had `logs:small` 128/500 and `logs:large` 20/500), while an
  all-fail-only rule lets a 128/500 burst pass green. Pick one: any error, or an error rate above a
  named threshold (e.g. >1%, with a `PERF_ALLOWED_ERROR_RATE` override)?
- **Does a >20% regression exit non-zero, or only print a warning?** `.claude/rules/server.md` says
  "stop and ask the user", which reads as advisory; `run.ts:245-251` currently exits non-zero only on
  a fatal throw. If non-zero, should it use a distinct code from the failed-scenario case (e.g. 2 vs
  1) so CI can tell a regression from a broken run?
- **Which metric does the gate compare, and what absolute noise floor accompanies the 20% rule?**
  `printConsoleComparison` (`reporter.ts:211-214`) computes both mean and p95 deltas but derives its
  status from mean only, so a p95-only regression currently reports OK. And a pure percentage rule
  fires inside measured noise: baseline means are 8-45ms, so 20% is 1.6-9ms, while unchanged code
  moved `repos:analytics-work-time` 11.8 → 21.3ms (+81%) on a pure success path. The removed
  `md > 10` was implicitly the noise floor. Decide: mean, p95, or either; and the floor value N in
  "flagged only when the delta exceeds both +20% and +N ms". Should scenarios whose baseline mean is
  below ~1ms be reported as below-noise-floor and never flagged at all?
- **What wall-clock budget may `npm run perf` consume, and what is the variance target?** "Brought
  low enough that a 20% threshold is meaningful" is not measurable, and repeating each scenario R
  times to take a median multiplies the runtime of a step mandated after every server change (25+
  scenarios × 500 iterations × 100 warmup today). Name the target (e.g. two back-to-back runs agree
  within ±20% on mean and p95 for every scenario above the floor), the R value if repeats are used,
  and the maximum acceptable total runtime. Note that widening the gate to swallow the variance would
  satisfy the current acceptance criterion while defeating the task — is that ruled out?

## Notes

**2026-08-13:** `perf-tests/auth-client.ts` `_ensureUser()` was made auth-mode aware as part of T-95,
not this task: it reads `GET /api/v1/auth/config` and uses `POST /api/v1/auth/identify` under
`mode: none`, falling back to the original login/signup flow otherwise. Before that fix the harness
could not authenticate at all under `AUTH_MODE=none` and aborted with
`Fatal error: Signup failed: 404`.

**2026-08-13:** Unrelated hygiene issue in the same directory — stale compiled `.js` files are
tracked in git alongside their `.ts` sources (`auth-client.js`, `config.js`, `data.js`,
`reporter.js`, `run.js`, `runner.js`, `scenarios.js`, all dated Jun 26). They are dead code:
`npm run perf` compiles to `perf-tests/dist/` and runs `dist/run.js`. `auth-client.js` still
contains the old signup-only flow, so anyone reading it gets a misleading picture. Consider
deleting them and gitignoring the pattern.

Measurement evidence (run-to-run variance table, run B failure breakdown, T-95 context): `notes.md`.
