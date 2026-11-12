---
type: "Idea"
title: "Product idea: hook-run health across a team"
description: "Backlog idea, not built: per-invocation runs, errors and durations of every Claude Code hook (not only Log Hub's), per repo and team, filterable by setup. What the transcript already carries, how competitors compare, open questions. Read before planning hook monitoring or a hook-health report."
tags:
  - product
  - idea
  - hooks
timestamp: "2026-11-11T00:00:00+04:00"
---

# Product idea: hook-run health across a team

**Status:** idea, not a task yet. It comes from the harness-entries review
(`docs/tasks/todo/2026-11-10-harness-entries-ui-review/`, follow-ups F4, F6 and F12).

## The idea

Claude Code writes a `hook_success` / `hook_non_blocking_error` record for each hook invocation into the session
transcript. It also writes a `stop_hook_summary` for each Stop. The records carry the event, command, exit code and
duration. Log Hub already uploads this data and does not show it.

The idea is a repo/team report with one row per hook × event: runs, error rate, blocked continuations, p50 / p95
duration and the hook's share of session wall time. The report filters by entrypoint (CLI, `claude -p`, SDK), IDE,
OS family and Claude Code version.

Questions it answers:

- "Which hook slows every turn for the whole team?"
- "Does a hook fail only on one OS or surface?"
- "How much of our session time goes to hooks?"

## Evidence

- Local-prod survey (291 sessions, one user): `hook_success` in 247 of 249 sessions that have hooks (1,975
  records). `hook_non_blocking_error` in 5 sessions.
- The data exists for any hook, Log Hub's or not, and needs no hook change.

## Competitors

This is not competitor parity. No tool in the studies shows hook runtime or errors:

- `competitive-research/budgets-forecasts-waiting.md` (18 tools): none breaks time down by hook. Anthropic OTel
  gives `interaction.duration_ms` per turn only.
- ccboard shows configured hook counts per event, which is configuration, not runs.
- agents-observe and Beezi use hooks as their data source but do not report on hook health.

So this would be a differentiator. It fits the "harness analysis" area where Log Hub already leads.

## Open questions

- Can a hook that has only a status message be labelled by that text in a team view, or only as
  "status-text · event"?
- How should hook time join the waiting breakdown (`2026-11-09-session-waiting-breakdown`)? Is it working time,
  or a separate slice?
- Should it get a threshold notice ("a hook adds > N s per turn"), shown alongside the antipattern catalog
  (`2026-11-02-session-antipatterns`)?
