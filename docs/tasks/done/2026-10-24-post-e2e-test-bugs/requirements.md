# 2026-10-24: Post-E2E-Test Bugs (Umbrella)

**Status:** todo
**Priority:** high
**Type:** bug
**Module(s):** hook
**Owner:** denis.tsyplakov
**Created:** 2026-10-24

## Description

Umbrella for the real product bugs found by the `/big-prod-e2e-test` run `20261023-192004`
(report: `log_hub_big_test-20261023-192004/_report/index.html`). Every failed row of that run was
analysed one by one by a separate read-only subagent to tell product bugs from test-tooling defects.
Only confirmed product bugs are tracked here. The ESM crash below was first a separate task
(`2026-10-23-hook-esm-host-repo-crash`, merged into this one on 2026-10-24 as a duplicate).

Classification rule (user decision, 2026-10-24): a check that **did not run** is a test defect, even
when its precondition was lost to a product bug elsewhere — every check must have its own source of
data. Sessions always start at the project root; a subdirectory cwd is out of scope for now.

| Bug | Failed rows it explains | State |
|---|---|---|
| **ESM crash:** the CommonJS hook scripts crash in a repo whose `package.json` has `"type": "module"`; nothing is recorded or uploaded | S1, S2, S7, V1, FR-7, V5 | fixed in hook 2.24.1 (plugin ships `scripts/package.json` = `{"type": "commonjs"}`), verified |

**Steps to reproduce (ESM crash, before 2.24.1):** install the hook into a repo whose root
`package.json` has `"type": "module"` and run `claude -p "hi"` there. Expected: hooks exit 0,
`.artisyn/ai_work_dir/` exists, the session appears in Log Hub. Actual: every hook exits 1 with
`ReferenceError: require is not defined in ES module scope … '<repo>package.json' contains "type": "module"`;
no `ai_work_dir/`, no upload. Evidence: `log_hub_big_test-20261023-192004/_state/sessions/S1.attempt-1.stream.jsonl`.

Per-row verdicts (all high confidence):

- **S1** — product bug (ESM crash). `S1.attempt-1.stream.jsonl` SessionStart hook:
  `lifecycle-hook.js:13 … ReferenceError: require is not defined in ES module scope`. The fixture
  has had `"type": "module"` since the first commit; the 2026-10-20 run passed only because all
  repos then shared one `artisyn` marketplace and the plugin ran from `dotnet-api` (no
  `package.json`). Released hook 2.21.1 is affected too.
- **S2, S7** — the same crash; both sessions did their work, only the upload failed.
- **V1, FR-7** — U1 does not see node-service because the repo does not exist on the server; no
  leak, expectations correct (the check ran and failed honestly).
- **V5** — the check ran; team linking by URL before ingest is intended and the nav hides a linked
  repo with no data. Consequence of the ESM crash.

Not product bugs:

- **FC, FR-FC1, FR-FC2** — test defect (did not run: its only source session S7 lived in the ESM
  repo). Fixed: S7 moved to `dotnet-api`, FC runs there.
- **V8** — test defect (the direct-URL half did not run: hard-wired to S1). Product access rule is
  correct (admin gets 403). Fixed: V8 opens the first of S1/S5/S6/S3 whose owner gets HTTP 200 on
  its logs, so the 403 also proves the session exists.
- **S10, S11** — out of scope: they started in `packages/web`; the viewer then shows absolute
  paths (known, task `2026-10-23-subdir-session-abs-paths`, deferred). Both now start at the project
  root.

## Functional Requirements

- The hook scripts run as CommonJS no matter what `type` the host repo's `package.json` declares, on
  every current Node.js LTS line; the fix ships through the installer, so existing installs get it
  on update.
- A hook that cannot start is reported at install time: the installer runs every hook entry script
  the way Claude Code will and says so instead of "ready to use" (user decision 2026-10-24).
- After the fixes, `/big-prod-e2e-test` is re-run and the rows listed above pass.

## Acceptance Criteria

- [x] In a repo whose root `package.json` has `"type": "module"`, a session is recorded and
      listed in Log Hub; `"type": "commonjs"` and package.json-less repos keep working — on Node
      18.19, 22, 24, 26 (`FR-NODE`, run `20261023-233414`).
- [x] A scenario step covers an ESM host repo: `@S-INST-01` step 8c installs the real archive into a `"type": "module"` repo, the load check passes and the installed Stop hook uploads (in the installer scenario rather than `tests/scenarios/hook`: the hook scenarios run the hook sources, not the shipped plugin with its `scripts/package.json`).
- [x] The installer checks after install that every hook script starts (`--self-check`) and does
      not print "ready to use" when one does not; covered by `@S-INST-01` step 8d (installer 1.0.78, hook 2.24.2).
- [x] A fresh `/big-prod-e2e-test` run passes S1, S2, S7, V1, FR-7, V5, plus FC, FR-FC1, FR-FC2,
      V8, S10 and S11 with the fixed test. (run `20261023-233414`, PASS)
- [x] Any new product bug that re-run finds is added to the table above as a new child task; any
      check that did not run is fixed in the test.

## Notes

**2026-10-24:** Correction carried into hook-esm-host-repo-crash: its Description said the earlier
passing run's hooks "ran from the plugin cache outside the repo" — wrong; they ran from
`dotnet-api/.artisyn/marketplace/…` (shared `artisyn` marketplace, last install wins). Hook
2.21.1 is affected too. Hooks run with the user's own `node` from PATH (`hooks.json` command
`node`), not a runtime bundled with Claude Code, so the fix must hold on every supported Node
(`engines` `>=18.19`).

**2026-10-24:** Test-tooling fixes done in `.claude/skills/big-prod-e2e-test/`: S7 → dotnet-api
(FC_REPO), V5/V6 rows adjusted, V8 direct-URL candidates with an owner-200 precondition, S10/S11
start at the root, SKILL.md analysis rule "did not run = test defect". Remaining tooling idea:
visibility rows whose expected sessions are all "not ingested" could say "blocked by …" in the
detail.

**2026-10-24 (night runs):**
- Run `20261023-230004` (built before the fix, hook 2.24.0): FAIL — S1, S2, V1, FR-7, V5 = the ESM crash (unchanged), FR-3 = files edited in the git root during the run (developer edits, not the test). The test fixes held: S7 (dotnet-api), FC/FR-FC1/FR-FC2 (non-zero stats in both categories), V8 (opened S5: owner HTTP 200, admin 403), S10/S11 (root cwd, repo-relative path) all passed for real.
- Run `20261023-233322`: infra stop in P1 — Docker Hub `429 Too Many Requests` on `FROM node:22.23.4-slim` (anonymous pull limit, used up by the Node-image pulls). Worked around by pulling `public.ecr.aws/docker/library/node:22.23.4-slim` and tagging it locally; buildx then used the local image.
- Run `20261023-233414` (hook 2.24.1, ESM fix + new phase P5c): **PASS, exit 0** — every infra step, AC row (incl. `FR-NODE`: algo tests + smoke in cjs / esm / no-package.json repos on Node 18.19.0, 22, 24, 26 — 16 cells), S1–S11, L1, FC and V1–V8; verdict fields 100 pass, 0 fail, 0 skipped.

**2026-10-24: Found by the run-230004 analysis, needs triage (not yet child tasks):**
1. **Installer reports success when telemetry is broken — FIXED (installer 1.0.78 / hook 2.24.2):** the summary now reports the failed load/receiver check instead of "ready to use". Original finding: With the ESM crash the installer warned "OTEL receiver could not be verified on 127.0.0.1:<port>" but still printed "✓ Hooks installed successfully… fully configured and ready to use" and exited 0 (`_state/installer-node-service.log`). Any receiver start failure looks green to the user.
2. **File-read stats count tool-output bytes, not file bytes — RESOLVED, not a bug (user decision 2026-10-24: `bytes` means what entered the context).** Documented in `docs/knowledgebase/api-reference.md` (`fileStatsByCategory`); `db-tables.md` already says "bytes returned by matched Read calls". Original finding: S7's FC stats: `Program.cs` 368 B / `HealthTests.cs` 638 B vs 338 B / 569 B on disk; the +30 / +69 match the `N\t` line-number prefixes of the Read output (12 and 25 lines). The KB does not say which one `bytes` means.
3. **Test gap — FIXED:** FC now requires an exact `{files, bytes}` match per category, computed from S7's transcript by mirroring `server/src/logs/claude-extractor.ts` `extractFileStatsByCategory()` / `computeToolResultBytes()` (checked against run 233414: sources 1/367, tests 1/638). Original: FC passed on any non-zero numbers, so a wrong byte count can never fail it. Fix is clear now: expect `bytes` = the byte length of the Read tool-result text in S7's transcript, per category.
4. **Test infra — FIXED:** P0 pre-pulls the root `Dockerfile` base images and `POSTGRES_IMAGE` from the `public.ecr.aws` mirror and tags them locally (a failure is a warning). Original: P1's base image and P5c's Node images come from registries with anonymous pull limits; a run can die on 429 with no product change. Consider pre-pulling from the `public.ecr.aws` mirror in P0.

**2026-10-24:** Tooling idea done: a failed visibility row whose every expected item was not ingested now says `blocked by <ids> (not ingested) — …` (status stays fail). Side finding while mirroring the server rule: `bytes` is `String.length` of the tool-result text, i.e. UTF-16 code units, not UTF-8 bytes — identical for ASCII, smaller for non-ASCII text; failed Reads count toward `files` and `bytes`; repeated Reads are not deduplicated. Decision (user, 2026-10-24): keep it as is and document it (`api-reference.md`, `db-tables.md`).
