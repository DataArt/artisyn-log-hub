---
type: "Idea"
title: "Product idea: code-quality signal from editor diagnostics"
description: "Backlog idea, not built: use the language-server diagnostics Claude Code records in the transcript to show where agent-written code stayed broken, per repo and team, by diagnostics source. Evidence, limits, competitor check, open questions. Read before planning code-quality analytics."
tags:
  - product
  - idea
  - quality
timestamp: "2026-11-11T00:00:00+04:00"
---

# Product idea: code-quality signal from editor diagnostics

**Status:** idea, not a task yet. It comes from the harness-entries review
(`docs/tasks/todo/2026-11-10-harness-entries-ui-review/`, follow-ups F7 and F13).

## The idea

When a diagnostics source is present (a language-server plugin or an IDE extension), Claude Code writes
`diagnostics` attachments with severity, code, file and line for each problem. These are written right after the
agent's edits.

If a later Edit or Write of the same file makes the diagnostic disappear, it was fixed. Otherwise it is
"never fixed".

The idea is a repo/team report per raw `source`: sessions with diagnostics, items by severity, the never-fixed
share, and the top files and codes. Codes are shown as data only. The fixed / not-fixed rule uses severity, the
file and a later edit, so it works for any language.

Questions it answers:

- "Where does agent-written code stay broken?"
- "Is it getting better week over week?"

## Evidence and limits

- Local-prod survey: `diagnostics` in 145 of 291 sessions, all from one source (`typescript`). The rate must be
  read on sessions that have a diagnostics source. A session without one is "none seen", never "clean".
- Setup-dependent by nature. It must never be used to compare developers who have a source with those who do not.

## Competitors

No tool in `competitive-research/` reports editor diagnostics. Datadog's Detected Problems ("skipped checks") is
the nearest: it infers missing checks from commands, not from diagnostics. The
`budgets-forecasts-waiting.md` study has nothing on code quality.

## Open questions

- Should a never-fixed error diagnostic before a commit become evidence for the "commit without a check" pattern
  of `2026-11-02-session-antipatterns`?
- Is a diagnostic that disappears without an edit of that file (fixed elsewhere) counted as fixed?
