---
type: Test Suite
title: Big pre-prod e2e test (manual skill)
description: Manual, reproducible pre-prod run of the whole product on a disposable amd64 docker stand. It covers UI onboarding, hook install, seven isolated claude -p sessions (one with a Postgres MCP server) verified in the UI, a UI-configured file-categories check by a nested Claude + Playwright, and team visibility, and writes a report with screenshot evidence.
resource: .claude/skills/big-prod-e2e-test/scripts/run.mjs
tags: [testing, e2e, pre-prod, docker, playwright, hook, manual]
timestamp: 2026-10-12T00:00:00Z
---

# Purpose

This is the release gate the other layers cannot provide. It builds the image **from the working
tree**, starts it as a separate stand next to the dev app, and drives the product the way a real
customer would:

- sign up through the UI;
- install the hook with the UI's one-liner;
- run real Claude Code sessions in real repos, including a skill, a path-scoped rule, a saved
  workflow and subagents;
- check that the UI shows what actually happened, and that team visibility works.

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

The S1–S7 scenario models are test data and live in `scripts/scenarios.mjs`.

# Phases

`run.mjs` runs one fixed list. A `[<step>] …` progress line goes to stdout and to
`_state/run.log`. The report is rewritten after every phase.

| # | Step | What happens |
|---|---|---|
| P0 | `preflight` | tools, buildx amd64, free ports 3001/5433, dev-port snapshot, run dir, isolated `_claude-config/`; ensures the S7 MCP test database `big_test_mcp` and pre-downloads its MCP server package |
| P1 | `build` | `docker buildx build --platform linux/amd64 -t artisyn-log-hub:big-test-<stamp> --load .`; asserts amd64 and `:latest` unchanged |
| P2 | `stand` | generated compose (`log-hub-big-test-<stamp>`, `127.0.0.1:3001`/`:5433`, `AUTH_MODE=password`, `PUBLIC_BASE_URL=http://localhost:3001`) up and ready; fails fast if the app container exits |
| P3 | `repos` | five fixture repos copied (`dot-claude/` → `.claude/`), `git init`, fake `origin`, one commit |
| P4 | `onboarding` | scripted Playwright signup of admin, U1, U2, U3 + consent + role check + "Give Me String" one-liner |
| P5 | `hooks` | one-liner installer run in each repo with the isolated `CLAUDE_CONFIG_DIR` |
| P6 | `teams` | `T-restricted` (U1 → U2) and `T-transparent` (U2 → U3): create, mode, invite, accept, link repos |
| P7 | `smoke` | isolated `claude -p "Reply with OK"` must succeed |
| P8 | sessions | S1–S7 `claude -p` sessions, retried up to 3× until the scenario is actually exercised |
| P9 | verify | wait for ingestion, then a nested `claude -p` + Playwright MCP checks the session in the UI |
| P9b | file-categories | U1 sets categories `sources` → `^src/` and `tests` → `^tests/` on node-service through Settings → File Categories; API must return them (FR-FC1) and S7 must have reads under both (FR-FC2); case `FC` |
| P10 | visibility | rows V1–V7: personal "My Repos" lists and team session lists |
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
| S7 | node-service (U1) | sonnet | MCP server `big-test-pg` (`@modelcontextprotocol/server-postgres`) queries `products`; reads `src/…` and `tests/…` for the FC check |

## S7 MCP test database

S7 is the only session started with an MCP server: `claude -p --mcp-config _verify/mcp-session-S7.json
--strict-mcp-config`, so that file is its only MCP source. The server points at a dedicated
database `big_test_mcp` (one table `products(id, name, price)`, three seed rows) on the developer's
**already running local Postgres**. The admin URL is env `BIG_TEST_MCP_PG_URL`, else `DATABASE_URL`
from the repo's `server/.env`; only the database name is swapped. P0 creates it **additively**
(`CREATE DATABASE` only when missing, `CREATE TABLE IF NOT EXISTS`, `ON CONFLICT DO NOTHING`) and
never drops or truncates it. Passwords are masked (`***`) in every log and report line. The
isolation check allows exactly the scenario's own MCP servers, each `connected`; any other server
still fails it. The verifier checks a 7th field `mcp`: the `MCP` rows on the Harness usage tab
(`big-test-pg:query`), and no `MCP` row for S1–S6.

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
| `_verify/` | verifier cwd (not a git repo, no hook); `mcp-<S#>.json` (verifier Playwright), `mcp-session-S7.json` (S7's Postgres MCP) |
| `_state/mcp-warmup.log` | the P0 `npx -y @modelcontextprotocol/server-postgres` warm-up |
| `_report/index.md`, `_report/report.json` | the report |
| `_report/<S#>/`, `_report/FC/`, `_report/visibility/` | verdicts and screenshots |
| `node-service/`, `ts-webapp/`, `java-lib/`, `js-cli/`, `dotnet-api/` | the test repos |

# Reading the report

Open `_report/index.md`. It has these sections, in order:

1. **Title**: `Big pre-prod e2e test — PASS|FAIL`, then the stamp, run dir and image.
2. **Infra**: one row per step, with failed steps first. A failure here means the run stopped
   early (exit `2`).
3. **AC checks**: one row per check ID (`FR-2` … `FR-11`, `FR-FC1`, `FR-FC2`, as keyed in `scripts/run.mjs`). The detail lists every contributing
   phase. `not evaluated (phase skipped or crashed)` means an earlier infra failure stopped the
   run before that phase.
4. **Sessions**: status per S#. The possible statuses are `pass`, `fail` (a UI mismatch or a
   failed isolation check), `scenario not exercised`, `fail: session error`, `fail: not ingested`
   and `fail: verifier error`. The row also shows every attempt's session id.
5. **Feature checks**: the `FC` file-categories check.
6. **Visibility**: rows V1–V7.
7. **Mismatches**: every failing field or row, with a link to its screenshot.
8. **Stand**: the URL, the exact `docker compose … down` command and the `docker image rm`
   command.
9. **Evidence**: one 🟢/🔴 subsection per session, the FC check (`FC/settings.png`, `FC/analytics-files.png`) and V-row. A passing case shows what was checked
   and the inline evidence screenshots (`summary`, `harness-usage`, `logs`, or `visibility/V#.png`).
   A failing case first lists "What is wrong" (expected vs observed), then the mismatch
   screenshots, then the regular evidence.

`report.json` holds the same data in machine-readable form.

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
- **`fail: verifier error`**: the verifier wrote no valid verdict, or a mandatory screenshot is
  missing. Check `_state/sessions/<S#>.verify.stdout.json` / `.verify.stderr.log`.
- **`cannot reach the local Postgres`** (P0): the S7 MCP test database needs the local Postgres
  from `server/.env` running, or `BIG_TEST_MCP_PG_URL` pointing at another one.
- **An isolation failure** (`mcp_servers not empty`, `mcp server big-test-pg is failed`, a global skill, a foreign plugin): the nested
  session saw something from the user-level config. Check the `init` event in the attempt stream.
- **A UI step times out in `onboarding` / `teams`**: the infra error names the step and the
  selector. Treat it as a test-script defect after a UI change (fix the selector in
  `scripts/lib/browser.mjs` / `teams.mjs`), unless the screen is really broken.

# Files

- `.claude/skills/big-prod-e2e-test/SKILL.md`: the skill (clean-context check, background launch,
  analysis delegation, credential warning)
- `scripts/run.mjs`: the orchestrator (phases, AC rows, exit codes, teardown)
- `scripts/scenarios.mjs`: S1–S7; `scripts/lib/mcpdb.mjs`: the S7 test database + MCP config;
  `scripts/lib/filecategories.mjs`: the FC check; `scripts/prompts/verify-session.md`: the verifier prompt
- `scripts/lib/`: `config`, `proc`, `api`, `report`, `preflight`, `stand`, `repos`, `browser`,
  `hooks`, `teams`, `evidence`, `sessions`, `verify`, `visibility`
- `fixtures/<repo>/`: the five fixture repos; harness files are stored as `dot-claude/` so this
  repo's own Claude Code never discovers them
