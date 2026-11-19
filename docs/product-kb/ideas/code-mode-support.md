---
type: "Idea"
title: "Product idea: support Claude Code Code Mode sessions"
description: "Backlog idea, parked: show Claude Code 'Code Mode' sessions (the REPL tool, JavaScript that makes several tool calls in one step) correctly in Log Hub. Why it is parked (Code Mode does not start with OTEL export on), what is known from the docs, what is unknown and the ready capture PoC. Read before planning Code Mode support or when a user asks why Code Mode does not start with Log Hub installed."
tags:
  - product
  - idea
  - claude-code
  - code-mode
generated: { by: "human:denistsyplakov", at: "2026-11-15T00:00:00+04:00" }
---

# Product idea: support Claude Code Code Mode sessions

**Status:** idea, parked (2026-11-15). Not a task. Revisit when Code Mode leaves the experimental
stage or starts working with OpenTelemetry export on.

## The idea

Claude Code 2.1.323 added Code Mode (experimental, off by default,
`CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1`): Claude writes JavaScript that makes several tool calls in
one step, and only what the code returns goes back into the context. If it becomes common, Log Hub
should show such sessions correctly: the `REPL` tool call with its code, the tool calls made from
the code, and the file reads and edits they did.

## Why it is parked

**Code Mode does not start when OpenTelemetry export is on** (the session says
`Code Mode (experimental) isn't available … OpenTelemetry is on`). The Log Hub installer writes
`CLAUDE_CODE_ENABLE_TELEMETRY=1` into the user settings, so a user with Log Hub OTEL on cannot run
Code Mode at all, and there are no such sessions to show. It is also unavailable with `claude -p`,
the Agent SDK, the VS Code panel, the Desktop app, cloud sessions, gateways and cloud providers,
and it "may change or be removed in any release".

## What is known (official docs page, read 2026-11-15)

- The tool that runs the code is `REPL`; the code is in `tool_input.code`.
- Every tool call made from the code goes through `deny` / `ask` rules and `PreToolUse` hooks.
- A Code Mode session can be resumed only with Code Mode on.
- The token savings quoted in news posts (150k → 2k tokens) are not in the docs.

## What is unknown

- Whether `PostToolUse` fires for the calls made from the code, and with which fields.
- Whether those calls are written to the transcript as `tool_use` / `tool_result` blocks. If not,
  Change Surface and OKF access would miss the edits and reads made from the code.
- How the Logs, Map and Tools/MCP views show the unknown tool `REPL`.

A capture kit that answers these is ready and not run yet:
`docs/pocs/2026-11-15-2334-code-mode-capture/` (needs Claude Code ≥ 2.1.323, an interactive
terminal and OTEL turned off for the test).

## When it is picked up

1. Run the PoC and fill in its Result.
2. If Code Mode still excludes OTEL: document it in `user-docs/otel-tab.md` (the two exclude each
   other, how to turn OTEL off), and consider an OTEL status reason for it.
3. Otherwise scope the UI and extractor work from the PoC findings. The automated suites cannot
   cover it while Code Mode is unavailable in `claude -p`.
