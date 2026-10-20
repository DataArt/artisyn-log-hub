---
name: big-prod-e2e-test
description: "Manual pre-prod test, only when the user explicitly invokes /big-prod-e2e-test. Builds a disposable amd64 stand from the working tree, onboards users through the UI, installs the hook into five fixture repos, runs seven isolated claude -p sessions (one with a Postgres MCP server on a local test database), verifies them in the UI, checks UI-configured file categories and team visibility and writes a report. Takes 30-90 min and spends real Claude credits."
argument-hint: "[--keep]"
---

# Big pre-prod e2e test

Arguments: `$ARGUMENTS` (optional: `--keep` leaves the stand running after the run).

The whole test is a deterministic Node orchestrator,
`.claude/skills/big-prod-e2e-test/scripts/run.mjs`. It runs every phase, writes the report and
exits `0` (PASS), `1` (FAIL) or `2` (an infra step failed). This skill only launches it, waits
for it, and relays the result. Do not re-implement or "help" any phase by hand.

Background and the report layout: `docs/knowledgebase/test/big-prod-e2e-test.md`.

## Clean-context check

This skill must run against a clean context. Before step 1, check whether the message that
invoked it is the FIRST user message in the current conversation, with no prior user prompts and
no work already done in this session.

If it is not, STOP at once. Do not run step 1 or take any other action. Tell the user:

> This skill must run on a clean context. Run `/clear`, then re-invoke `/big-prod-e2e-test`.

Only continue once you have confirmed this is the first user message of the session.

## Credentials warning (tell the user before starting)

Say this to the user in one short paragraph, then continue without waiting:

> The run gives every nested `claude` an isolated config (`<run-dir>/_claude-config`). If
> `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` is set, it is passed through. Otherwise
> `~/.claude/.credentials.json` is **copied** into the isolated config, and a nested session may
> refresh and **rotate the OAuth refresh token**. If that happens, your main Claude Code login can
> drop and you will need to log in again. To avoid it, set `CLAUDE_CODE_OAUTH_TOKEN`
> (`claude setup-token`) before the run.

## Steps

1. **Launch in the background.** From the repo root, start a single Bash call with
   `run_in_background: true`:

   ```sh
   node .claude/skills/big-prod-e2e-test/scripts/run.mjs $ARGUMENTS
   ```

   Pass only `--keep` or nothing; the script rejects any other argument with exit `2`.
   Never start a second instance while one runs: both would use ports 3001/5433.
   The local Postgres from `server/.env` (or `BIG_TEST_MCP_PG_URL`) must be running: P0 creates the
   S7 MCP test database `big_test_mcp` there additively and never drops it.

2. **Wait.** The run takes 30–90 minutes. The first image build alone can take about 7 min.
   Do not poll in a loop and do not sleep. You are notified when the background command exits.
   You may read its output file once or twice if the user asks for progress. Every line starts
   with `[<step>]`, and the `[preflight] run dir: …` line names the run dir.

3. **Find the report.** Near its end the output prints `[run] report: <path>/_report/index.md`
   and `[run] overall PASS|FAIL — exit <code>`. If the output was lost, the run dir is the newest
   `log_hub_big_test-<stamp>` directory next to the git root (`<git-root>/../`).

4. **Delegate the analysis.** Read `.claude/skills/big-prod-e2e-test/models.json` and take its
   `analysis` value. Spawn one `Agent` subagent with `model` set to that value. Give it the run
   dir and ask it to:
   - read `_report/index.md` and `_report/report.json`;
   - for every failed infra step, AC check, session, feature check (FC) and visibility row, read
     the relevant evidence: `_report/<S#>/verdict.json`, `_report/FC/`, the mismatch and evidence screenshots, the
     `_state/sessions/<S#>.result.json` / `.attempt-<n>.stream.jsonl` / `.verify.stderr.log`,
     `_state/installer-<repo>.log`, `_state/stand-up.log`, `_state/app-container.log` (server
     container output, e.g. a boot crash) and `_state/run.log` as needed;
   - explain each failure: what was expected, what happened, the likely cause, and whether it
     looks like a **product defect** (server, client or hook) or a **test-script defect** (the
     orchestrator, a selector, a flaky wait);
   - return a short structured summary. It must not edit any file or re-run anything.

   The main session does no heavy analysis itself: no reading screenshots or stream logs here.

5. **Relay** to the user, briefly:
   - the overall result (PASS / FAIL), the exit code and the run dir;
   - each failure with the subagent's one-line cause and its product/script classification, and
     a link to `_report/index.md`;
   - the stand info from the report's "Stand" section: with `--keep`, the URL
     `http://localhost:3001` and the exact `docker compose … down` command; in every case, the
     `docker image rm artisyn-log-hub:big-test-<stamp>` command, because the image is kept on
     disk;
   - if the exit code is `2` and the failed step is `preflight`, the fix from the KB
     troubleshooting section (busy port, missing tool, missing credentials, unreachable local
     Postgres).

Do not fix anything as part of this skill. Product defects are reported, not fixed here.
