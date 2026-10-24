---
type: Test Suite
title: Big pre-prod e2e test (manual skill)
description: Manual, reproducible pre-prod run of the whole product on a disposable amd64 docker stand. It covers UI onboarding, hook install (current and previous release, local config, upgrade), eleven isolated claude -p sessions plus a legacy-hook session verified in the UI with per-scenario checks (Bash tab, denied calls, cost, work time, context growth, workflow agents, system context, worktree override), a UI-configured file-categories check, and team and admin visibility, and writes a report with screenshot evidence.
resource: .claude/skills/big-prod-e2e-test/scripts/run.mjs
tags: [testing, e2e, pre-prod, docker, playwright, hook, manual]
timestamp: 2026-10-23T00:00:00Z
---

# Purpose

This is the release gate the other layers cannot provide. It builds the image **from the working
tree**, starts it as a separate stand next to the dev app, and drives the product the way a real
customer would:

- sign up through the UI;
- install the hook with the UI's one-liner, and the previous-release hook from git into one more repo;
- run real Claude Code sessions in real repos, including a skill, a path-scoped rule, a saved
  workflow, subagents (one in the background), an MCP server, Bash calls that succeed and fail, a
  denied tool call and a session in a linked git worktree (every session starts at the project
  root: a subdirectory cwd is out of scope for now);
- check that the UI shows what actually happened, and that team and admin visibility works.

It never touches the dev app (`:3000`/`:5173`), the dev DB (`:5432`) or `artisyn-log-hub:latest`.

It is **manual only**. It takes 30–90 min, spends real Claude credits, and is not part of
`adlc-lh:check-health`. The helper libs have unit tests in `scripts/__tests__/big-prod-e2e-test.test.js`
(run by `npm run test:scripts`), and those *are* part of the normal checks.

# How to run

In a **fresh** Claude Code session (the skill refuses to run in a used context):

```
/big-prod-e2e-test            # stand is torn down at the end
/big-prod-e2e-test --keep     # stand stays up on http://localhost:3001 for manual poking
```

The skill launches `node .claude/skills/big-prod-e2e-test/scripts/run.mjs [--keep]` in the
background and waits for it. It then hands `_report/` to an analysis subagent (model from
`models.json → analysis`) and relays the result. You can also run the script directly from the
repo root. Any argument other than `--keep` (or `--help`) is rejected with exit `2`.

Exit codes: `0` PASS, `1` FAIL (a session, visibility row or AC check failed), `2` infra failure
(a P0–P7 step or teardown failed, or the run was interrupted).

Prerequisites: Docker running with a buildx builder that lists `linux/amd64`; `git`, `claude`,
`npx` and `node` on PATH; the repo's Playwright chromium installed (`npx playwright install
chromium`); Claude credentials (see [Credentials](#credentials)); ports 3001 and 5433 free.

## Models

`.claude/skills/big-prod-e2e-test/models.json` maps the skill's own Claude roles to model aliases:

- `analysis` (default `opus`) is the report-analysis subagent;
- `verify` (default `sonnet`) is the per-session UI verifier and the smoke call.

The S1–S11 and L1 scenario models are test data and live in `scripts/scenarios.mjs`.

# Phases

`run.mjs` runs one fixed list. A `[<step>] …` progress line goes to stdout and to
`_state/run.log`. The report is rewritten after every phase.

| # | Step | What happens |
|---|---|---|
| P0 | `preflight` | tools, buildx amd64, free ports 3001/5433, dev-port snapshot, run dir, isolated `_claude-config/`; pre-pulls every missing base image (the root `Dockerfile`'s `FROM` images + `POSTGRES_IMAGE`; official library images only) from `public.ecr.aws/docker/library/<name>:<tag>` (`--platform linux/amd64`) and `docker tag`s it to its Docker Hub name, so an anonymous-pull `429` cannot stop P1/P2 (a failed pre-pull is a logged warning only); ensures the S7 MCP test database `big_test_mcp` and pre-downloads its MCP server package |
| P1 | `build` | `docker buildx build --platform linux/amd64 -t artisyn-log-hub:big-test-<stamp> --load .`; asserts amd64 and `:latest` unchanged |
| P2 | `stand` | generated compose (`log-hub-big-test-<stamp>`, `127.0.0.1:3001`/`:5433`, `AUTH_MODE=password`, `PUBLIC_BASE_URL=http://localhost:3001`) up and ready; fails fast if the app container exits |
| P3 | `repos` | five fixture repos copied (`dot-claude/` → `.claude/`), `git init`, fake `origin`, one commit |
| P4 | `onboarding` | scripted Playwright signup of admin, U1, U2, U3 + consent + role check + "Give Me String" one-liner |
| P5 | `hooks` | one-liner installer run in each repo with the isolated `CLAUDE_CONFIG_DIR`; `FR-LC`: `serverUrl` and `otelReceiverPort` live only in `log-hub.local.json`; `FR-UP`: java-lib (committed pre-split `log-hub.json`) upgrades cleanly; then prepares S11's linked worktree `ts-webapp-wt/` with its own OTEL port |
| P5b | `legacy-hook` | `FR-OLD`: `git archive` of `PREV_RELEASE_REF` into `_prev-src/`, `npm ci`, the old `build-hooks-installer.js` into `_prev-hook/` (versions checked), then `npx <file-url tgz> install` into `legacy-hook/` with U3's key. A failure is an `FR-OLD` fail (`infra: <step>: …`), not an infra stop; L1 is then not run |
| P5c | `node-lts` | `FR-NODE`: the plugin installed into `js-cli` on Node `18.19.0` (the `engines` floor) plus every even line alive today per `nodejs/Release` `schedule.json` (LTS, or Current due to become LTS; fallback 22/24/26 when offline), each in `docker run --rm --network none` from `public.ecr.aws/docker/library/node:<tag>-bookworm`: the hook algorithm tests and `scripts/node-lts/smoke.cjs` (SessionStart … SessionEnd stdin payloads; exit 0, clean stderr, `hook.log`, telemetry, OTEL receiver listening) in a CommonJS, an ESM (`"type": "module"`) and a package.json-less repo. Never stops the run; a failure is an `FR-NODE` fail. Matrix in `_state/node-lts.json` |
| P6 | `teams` | `T-restricted` (U1 → U2) and `T-transparent` (U2 → U3): create, mode, invite, accept, link repos |
| P7 | `smoke` | isolated `claude -p "Reply with OK"` must succeed |
| P8 | sessions | S1–S11 `claude -p` sessions, retried up to 3× until the scenario is actually exercised; `FR-WT` right after S11; L1 last, only when P5b passed |
| P9 | verify | wait for ingestion (and, for the `cost` check, up to 120 s for the telemetry cost), then a nested `claude -p` + Playwright MCP runs the scenario's verifier checks in the UI; `cost` and `workTime` are judged in JS; `FR-OLD` from L1 |
| P9b | file-categories | U3 sets categories `sources` → `^src/` and `tests` → `^tests/` on dotnet-api through Settings → File Categories; API must return them (FR-FC1) and S7's `fileStatsByCategory` must have reads under both and equal, per category, the `{files, bytes}` computed from S7's own main transcript (FR-FC2): `files` = its `Read` calls, `bytes` = the `.length` of their `tool_result` text (line-number prefixes included, i.e. what entered the context, not the file size on disk), classified by the categories on repo-relative paths — `lib/filecategories.mjs` `expectedFileStats` mirrors the server's `extractFileStatsByCategory()` (`server/src/logs/claude-extractor.ts`); case `FC` |
| P10 | visibility | rows V1–V8: personal "My Repos" lists, team session lists, and the admin row (no repo listed; the first of S1/S5/S6/S3 whose owner gets HTTP 200 on its logs, opened by the admin → 403). A failed row whose every expected session is `fail: not ingested` (or whose repos have no repo id) stays `fail`, with its detail prefixed `blocked by <ids> (not ingested) — ` |
| P11 | final | dev ports unchanged, no new path in the git root, `index.md` complete |
| P12 | `teardown` | kill the hook's `otel-receiver.js` for the run dir; `docker compose down` (skipped with `--keep`); assert no containers |

A failure in P0–P7 skips P8–P11 and still runs teardown (exit `2`). A failure in P8–P10 marks only
that session, check or row. Overall is PASS only when every infra step, AC check, session, feature
check (FC) and visibility row passed.

The session matrix:

| # | Repo (owner) | Model | Exercises |
|---|---|---|---|
| S1 | node-service (U1) | sonnet | nothing (plain edit, no harness, no subagent) |
| S2 | node-service (U1) | haiku | skill `add-jsdoc` via slash command |
| S3 | ts-webapp (U1) | opus | ≥1 subagent |
| S4 | java-lib (U1) | sonnet | saved workflow `java-refactor` |
| S5 | js-cli (U2) | haiku | path-scoped rule `cli-flags` |
| S6 | dotnet-api (U3) | sonnet | skill `api-endpoint` + ≥1 subagent |
| S7 | dotnet-api (U3) | sonnet | MCP server `big-test-pg` (`@modelcontextprotocol/server-postgres`) queries `products`; reads `src/Api/Program.cs` and `tests/Api.Tests/HealthTests.cs` for the FC check (not in node-service, so FC does not share that repo's failure modes) |
| S8 | js-cli (U2) | haiku | `--permission-mode default`: Bash `node --version` (ok), `node -e "process.exit(3)"` (error) and a denied `Write` of `denied.txt` |
| S9 | ts-webapp (U1) | haiku | background subagent (`run_in_background`), the main thread acts after the `<task-notification>`; turn work time |
| S10 | ts-webapp (U1) | haiku | `cat "{{REPO_ROOT}}/packages/core/src/index.ts"` (absolute path under the repo) shown repo-relative; started at the repo root |
| S11 | ts-webapp (U1) | haiku | as S10, at the root of the linked worktree `ts-webapp-wt/` with `ARTISYN_PROJECT_ROOT` = the worktree root; must stay the last ts-webapp session |
| L1 | legacy-hook (U3) | haiku | a plain read, recorded by the previous-release hook (`LEGACY_SCENARIO`, outside `SCENARIOS`) |

S1 also runs `cd "{{REPO_ROOT}}"; node --test tests/calc.test.js` for the Bash tab. Every scenario
lists its verifier checks (`verifyChecks`, `CHECKS` in `scripts/lib/verify.mjs`); each check is a
prompt fragment `scripts/prompts/checks/<id>.md` with its own verdict fields, screenshots and
call budget:

| Check | What the verifier looks at | Sessions |
|---|---|---|
| `model`, `harness`, `prompt` | Summary model; Harness usage rows (skills, rules, workflows, subagents, MCP); first prompt on Logs | all (L1: `model`, `prompt`) |
| `cost` | Info tab "Telemetry total"; judged in JS against the stream's `total_cost_usd` (Δ below max($0.05, 1 %)), `skipped` when either side is missing | S1–S11 |
| `bashTab` | Bash tab rows: status (`✗ error`), Working dir, FILES runs `node`, no absolute repo path | S1, S8 |
| `contextGrowth` | Charts → Context Growth step with tool calls | S1 |
| `agentsTable` | workflow agents table and the agent modal tabs | S4 |
| `systemContext` | System context rules / skills / files tabs | S2, S5 |
| `denied` | the `Write` call shows `⊘ rejected` with a denial text or title | S8 |
| `workTime` | turn-1 header duration ≥ the transcript's prompt → last main-thread answer span (judged in JS) | S9 |
| `bashPaths` | Bash tab FILES reads `packages/core/src/index.ts`, no absolute path | S10, S11 |

Prompts that need an absolute path use `{{REPO_ROOT}}`, filled at run time with the session root
(repo dir, or the worktree for S11) in forward-slash form; nothing machine-specific is hardcoded.

## S7 MCP test database

S7 is the only session started with an MCP server: `claude -p --mcp-config _verify/mcp-session-S7.json
--strict-mcp-config`, so that file is its only MCP source. The server points at a dedicated
database `big_test_mcp` (one table `products(id, name, price)`, three seed rows) on the developer's
**already running local Postgres**. The admin URL is env `BIG_TEST_MCP_PG_URL`, else `DATABASE_URL`
from the repo's `server/.env`; only the database name is swapped. P0 creates it **additively**
(`CREATE DATABASE` only when missing, `CREATE TABLE IF NOT EXISTS`, `ON CONFLICT DO NOTHING`) and
never drops or truncates it. Passwords are masked (`***`) in every log and report line. The
isolation check allows exactly the scenario's own MCP servers, each `connected`; any other server
still fails it. The verifier's `harness` check includes the field `mcp`: the `MCP` rows on the
Harness usage tab (`big-test-pg:query`), and no `MCP` row for the other sessions.

# Run-dir layout

Everything lives **outside** the repo, in `<git-root>/../log_hub_big_test-<stamp>/` (one new dir
per run; `<stamp>` is UTC `YYYYMMDD-HHMMSS`):

| Path | Content |
|---|---|
| `_log_hub/docker-compose.yml`, `_log_hub/.env`, `_log_hub/data/` | the stand (bind-mounted pgdata, logs, upload-queue) |
| `_claude-config/` | isolated `CLAUDE_CONFIG_DIR` (credentials + Claude's own state, transcripts under `projects/`) |
| `_state/run-state.json` | users, passwords, API keys, repo ids, team ids |
| `_state/run.log` | the progress log |
| `_state/sessions/<S#>.expected.json` | the expected params (repo, owner, session_id, model, skills, rules, workflows, subagents, mcp, prompt) |
| `_state/sessions/<S#>.result.json` | status, every attempt's session_id, isolation check, verdict |
| `_state/sessions/<S#>.attempt-<n>.stream.jsonl` / `.stderr.log` | raw `claude -p` output |
| `_state/sessions/<S#>.verify.stdout.json` / `.verify.stderr.log` | raw verifier output |
| `_state/smoke.stdout.json`, `_state/smoke.stderr.log` | smoke call output |
| `_state/installer-<repo>.log` | hook installer output |
| `_state/stand-up.log` | `docker build` / `compose up` / `down` output |
| `_state/app-container.log` | `compose ps -a` + `compose logs app`, saved when the app container exits during P2 and before every teardown `down` |
| `_verify/` | verifier cwd (not a git repo, no hook); `mcp-<S#>.json` (verifier Playwright), `mcp-session-S7.json` (S7's Postgres MCP), `settings-<S#>.json` (the root `--settings` file of a scenario with `rootSettings`; none today) |
| `_state/prev-hook-build.log` | the P5b archive / `npm ci` / build / version steps |
| `_state/node-lts.json` | the P5c matrix: tags, live lines (or the schedule error), per tag the algo result and one `smoke.cjs` JSON per repo kind |
| `_prev-src/`, `_prev-src.tar` | the `git archive` of `PREV_RELEASE_REF` (P5b) |
| `_prev-hook/` | the previous-release installer build (`installer-version.json`, the tgz) |
| `_state/mcp-warmup.log` | the P0 `npx -y @modelcontextprotocol/server-postgres` warm-up |
| `_report/index.html`, `_report/index.md`, `_report/report.json` | the report: HTML with inline screenshots, the same as Markdown, and the data |
| `_report/<S#>/`, `_report/FC/`, `_report/visibility/` | verdicts and screenshots |
| `node-service/`, `ts-webapp/`, `java-lib/`, `js-cli/`, `dotnet-api/` | the test repos (`js-cli` gets a generated `CLAUDE.md`; `java-lib` a committed pre-split `log-hub.json`) |
| `legacy-hook/` | the repo with the previous-release hook (owner U3, session L1) |
| `ts-webapp-wt/` | S11's linked worktree of `ts-webapp` (branch `big-test-wt`, own `.artisyn/` and OTEL port) |

# Reading the report

Open `_report/index.html` in a browser. It is one self-contained page (inline CSS/JS, no network)
rendered from the same model by `scripts/lib/report-html.mjs`: a PASS/FAIL badge, pass counts per
area, a **Failures** list (each failing item with its reason and screenshot, linked to its case),
the tables below, and the Evidence cases with every screenshot inline (`<img>` with a path relative
to `_report/`; a click enlarges it, the "evidence: failed only" checkbox hides passing cases).

`_report/index.md` has the same content as Markdown. It has these sections, in order:

1. **Title**: `Big pre-prod e2e test — PASS|FAIL`, then the stamp, run dir and image.
2. **Infra**: one row per step, with failed steps first. A failure here means the run stopped
   early (exit `2`).
3. **AC checks**: one row per check ID (`FR-2` … `FR-11`, `FR-FC1`, `FR-FC2`, `FR-LC`, `FR-UP`,
   `FR-OLD`, `FR-WT`, `FR-NODE`, as keyed in `AC_PHASES` in `scripts/run.mjs`). `FR-LC` / `FR-UP` carry
   the JSON of both config files; `FR-OLD` names the ref, installer and hook versions and L1's status. The detail lists every contributing
   phase. `not evaluated (phase skipped or crashed)` means an earlier infra failure stopped the
   run before that phase.
4. **Sessions**: status per S# and L1. The possible statuses are `pass`, `fail` (a UI mismatch or a
   failed isolation check), `scenario not exercised`, `fail: session error`, `fail: not ingested`,
   `fail: verifier error` and, for L1, `fail: legacy hook not installed`. The row also shows every
   attempt's session id and the verdict fields (`model ✓, cost skipped, …`). A line under the
   table counts the fields: `skipped` (only `cost`) is neither pass nor fail.
5. **Feature checks**: the `FC` file-categories check.
6. **Visibility**: rows V1–V8.
7. **Mismatches**: every failing field or row, with a link to its screenshot.
8. **Stand**: the URL, the exact `docker compose … down` command and the `docker image rm`
   command.
9. **Evidence**: one 🟢/🔴 subsection per session, the FC check (`FC/settings.png`, `FC/analytics-files.png`) and V-row. A passing case shows what was checked
   and the inline evidence screenshots, grouped per verifier check (a bold "Check `<id>`" line
   with the field outcomes, then that check's screenshots, e.g. `summary`, `harness-usage`,
   `logs`, `cost`, `bash`), or `visibility/V#.png`. A failing case first lists "What is wrong"
   (expected vs observed), then the mismatch screenshots, then the grouped evidence.

`report.json` holds the same data in machine-readable form. All three are rewritten after every
phase by `writeReport` in `scripts/lib/report.mjs`.

# `--keep` and cleanup

Without `--keep`, the compose stack goes down at the end. The data stays in the run dir, because
it is bind-mounted and `down` runs without `-v`. With `--keep`, the stand stays on
`http://localhost:3001`; log in as `big-test-u1@example.com` / `BigTest!2026-U1-Pass` (the other
users are in `_state/run-state.json`).

The image is **always** kept. To clean up by hand:

```sh
# stop a kept stand (exact command is printed in the report's "Stand" section)
docker compose -p log-hub-big-test-<stamp> -f "<run-dir>/_log_hub/docker-compose.yml" --env-file "<run-dir>/_log_hub/.env" down

# remove the image
docker image rm artisyn-log-hub:big-test-<stamp>

# remove the run dir (stand must be down first)
rm -rf "<git-root>/../log_hub_big_test-<stamp>"
```

The S7 test database `big_test_mcp` on the local Postgres is also kept and reused by every run;
the script never drops it.

A second run needs no cleanup: it gets a new stamp, a new run dir and a new compose project. Only
a stand still kept from an earlier run blocks it, through ports 3001/5433.

# Credentials

Every nested `claude` (sessions, smoke, verifier) and the installer get a scrubbed env: the
parent's `CLAUDE*`, `ANTHROPIC_*`, `OTEL_*` and `ARTISYN_*` vars are removed, and
`CLAUDE_CONFIG_DIR` is set to `<run-dir>/_claude-config`. `ANTHROPIC_API_KEY` /
`CLAUDE_CODE_OAUTH_TOKEN` are passed through when set. Otherwise
`~/.claude/.credentials.json` is copied into the isolated config. That copy can **rotate the
OAuth refresh token** and log out your main Claude Code session. Prefer
`CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`).

The hook must be ≥ 2.18.1, which resolves user-level Claude paths via `CLAUDE_CONFIG_DIR`. The
stand is built from the working tree, so it always ships the current hook.

# Troubleshooting

- **`port 3001 is busy — free it or stop the other stand; nothing was stopped`** (or 5433):
  something already listens there, usually a stand kept with `--keep`. Stop it with the `down`
  command from that run's report, or `docker ps` to find it. The script never stops anything it
  did not start.
- **`no Claude credentials`**: set `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`, or run
  `claude` once to log in so that `~/.claude/.credentials.json` exists.
- **`stand app container exited (…) before answering`**: the server crashed on boot. The error
  quotes the log tail; the full output is in `_state/app-container.log`. The image runs
  `NODE_ENV=production`, so startup validation applies: `AUTH_MODE=password` refuses to start
  without `PUBLIC_BASE_URL` (the stand sets it to `http://localhost:3001` in its `.env`). A new
  required production env var must be added to `renderCompose`/`renderEnv` in `lib/stand.mjs`.
- **`stand not ready at http://localhost:3001 within 180 s`** with the container still running:
  the app is up but slow or stuck (migrations, DB). Check `_state/app-container.log`.
- **`smoke` fails**: the isolated config cannot authenticate. Check `_state/smoke.stderr.log`.
  An expired or rotated token is the usual cause, so log in again.
- **`preflight tool check failed`**: the message lists every missing tool, a buildx builder
  without `linux/amd64`, or the missing Playwright chromium.
- **`scenario not exercised`**: the model did not do what the scenario needs (for example S3
  answered without spawning a subagent) in 3 attempts. Check the attempt's `gap` in
  `_state/sessions/<S#>.result.json` and the `.attempt-<n>.stream.jsonl`. This is model behaviour,
  not a product defect. Re-run, or tighten the prompt in `scripts/scenarios.mjs`. The last
  attempt is still UI-verified, so the UI half of the check is still meaningful.
- **`fail: not ingested`**: the hook did not upload the session within 5 min. Check the repo's
  `.artisyn/` hook logs inside the run dir and `_log_hub/data/logs/`. A hook older than 2.18.1
  ignores `CLAUDE_CONFIG_DIR` and never finds the transcripts.
- **A visibility row says `blocked by S5, S8 (not ingested) — …`**: the row ran and failed
  because nothing it should see reached the server; fix the ingestion failure of those sessions
  first (see `fail: not ingested`), the row itself is not the cause.
- **`FR-FC2`: `category "sources" has 1 file(s) / 360 B, the transcript gives 1 / 367 B`**: the
  server's file-read stats differ from what S7's transcript implies (Read calls and their
  tool-result text length). `no expected stats: the session transcript could not be read` means
  S7 left no local transcript (check `_state/sessions/S7.result.json` → `attempts[].transcript`).
  If the server's counting rule changed on purpose, update `expectedFileStats` in
  `lib/filecategories.mjs` to match.
- **`warning: pre-pull failed for <image>`** (P0): the `public.ecr.aws` mirror pull failed too.
  The run goes on; P1/P2 may still pull from Docker Hub, and a `429 Too Many Requests` there means
  the anonymous pull limit is used up: `docker login`, or pull the image by hand and re-run.
- **`fail: verifier error`**: the verifier wrote no valid verdict, or a mandatory screenshot is
  missing. Check `_state/sessions/<S#>.verify.stdout.json` / `.verify.stderr.log`.
- **`cannot reach the local Postgres`** (P0): the S7 MCP test database needs the local Postgres
  from `server/.env` running, or `BIG_TEST_MCP_PG_URL` pointing at another one.
- **An isolation failure** (`mcp_servers not empty`, `mcp server big-test-pg is failed`, a global skill, a foreign plugin): the nested
  session saw something from the user-level config. Check the `init` event in the attempt stream.
- **`FR-OLD` fails in P5b with `infra: <step>: …`** (`archive`, `npm ci`, `build`, `version`,
  `install`): the previous-release installer could not be built or installed, so L1 is
  `fail: legacy hook not installed`. Read `_state/prev-hook-build.log` and
  `_state/installer-legacy-hook.log`. A `version` mismatch means `PREV_RELEASE_REF` and the
  expected versions in `scripts/lib/config.mjs` disagree. `npx` needs the tgz as a `file://` URL:
  a bare Windows path hangs silently.
- **`FR-NODE` fails in P5c.** `infra: …` means the matrix did not run (no installed plugin in
  `js-cli`, Docker down). A cell like `24 (v24.x) smoke esm: SessionStart/lifecycle-hook.js: …` is
  a real hook defect on that Node line or repo kind — the full step list, stderr and `hook.log`
  errors are in `_state/node-lts.json`. `pull … failed` is a registry problem (the run uses the
  `public.ecr.aws` mirror because Docker Hub rate-limits anonymous pulls). Re-run the matrix
  alone with `lib/node-lts.mjs` `runNodeLtsMatrix`.
- **`cost` is `skipped`**: P9 waited `TELEMETRY_WAIT_MS` (120 s) and the session's
  `costBreakdown.telemetryCost` stayed null, or the stream had no `total_cost_usd`, or the Info
  tab showed no "Telemetry total". The run log says `telemetry cost not reported in time`. It does
  not fail the session. Check the repo's `.artisyn/ai_work_dir/telemetry/` and the OTEL receiver
  port in `log-hub.local.json`.
- **S11's OTEL lands in the main checkout, or `hook.log` says the receiver "belongs to another
  project"** (`409 owner-mismatch`, see [otel-receiver.md](../otel-receiver.md)): the worktree
  reused the main checkout's OTEL port. `prepareWorktree` must give `ts-webapp-wt/` a fresh port in
  both `log-hub.local.json` and `settings.local.json`. `FR-WT` fails when the S11 session id is not
  in the worktree's `ai_work_dir/hook.log` or is also in the main one; a later ts-webapp session in
  the main root also sweeps the worktree transcript, so S11 must stay the last ts-webapp session.
- **S8's denied `Write` shows `✗ error` instead of `⊘ rejected`**: the result line lost its
  `toolDenialKind`, so the UI falls back to the plain `is_error` status. Check the line in the
  attempt stream / transcript (expected `toolDenialKind: "user-rejected"`) and whether the server
  kept it. If the call was not denied at all (the session ran with broader permissions), the
  scenario is `not exercised`; check `permissionArgs` in `scripts/scenarios.mjs`.
- **A Bash row shows an absolute path in S1 / S10 / S11 on Windows**: the filled `{{REPO_ROOT}}`
  is `D:/…` (forward slashes), and Claude may echo it as `D:/…`, `D:\…` or the msys form
  `/d/…`. `toRepoRelative` (`client/src/viewer/lib/bash-view/display-paths.ts`) matches all of
  them case-insensitively, so a leftover absolute path points at the root the view received (the
  session's repo root), not at the prompt.
- **A UI step times out in `onboarding` / `teams`**: the infra error names the step and the
  selector. Treat it as a test-script defect after a UI change (fix the selector in
  `scripts/lib/browser.mjs` / `teams.mjs`), unless the screen is really broken.

# Files

- `.claude/skills/big-prod-e2e-test/SKILL.md`: the skill (clean-context check, background launch,
  analysis delegation, credential warning)
- `scripts/run.mjs`: the orchestrator (phases, `AC_PHASES`, exit codes, teardown)
- `scripts/scenarios.mjs`: S1–S11, `LEGACY_SCENARIO` (L1), `S8_DENIED`, `promptFor` (`{{REPO_ROOT}}`);
  `scripts/lib/mcpdb.mjs`: the S7 test database + MCP config; `scripts/lib/filecategories.mjs`: the FC check
- `scripts/prompts/verify-session.md`: the verifier frame (`{{STEPS}}`, `{{JUDGE}}`,
  `{{VERDICT_FIELDS}}`); `scripts/prompts/checks/<id>.md`: one fragment per verifier check
- `scripts/lib/`: `config`, `proc`, `api` (incl. `waitForTelemetry`), `report`, `preflight`,
  `stand`, `repos`, `browser`, `hooks` (incl. `checkLocalConfig`), `teams`, `evidence`,
  `sessions`, `verify` (`CHECKS`, `judgeCost`, `judgeWorkTime`), `visibility` (incl. V8),
  `legacy` (previous-release installer), `worktree` (S11 worktree, `FR-WT`), `node-lts` (P5c,
  `FR-NODE`: LTS lines from `schedule.json`, the Docker matrix, `judgeNodeMatrix`)
- `scripts/node-lts/smoke.cjs`: the in-container hook smoke of P5c (CommonJS, Node built-ins only,
  runs on the engines floor)
- `fixtures/<repo>/`: the five fixture repos plus `legacy-hook/`; harness files are stored as
  `dot-claude/` so this repo's own Claude Code never discovers them
