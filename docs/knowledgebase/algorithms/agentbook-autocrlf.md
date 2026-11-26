---
type: "Algorithm"
title: "AgentBook effective core.autocrlf"
description: "The core.autocrlf value AgentBook writes into a laptop's global git config, so git inside sees the shared Windows/macOS working tree as the host's git does and does not report every file as changed."
tags: [algorithm, agentbook]
generated: { by: "claude-code", at: "2026-11-25T23:30:00+04:00" }
reviewed: no
reviewer: none
---

# AgentBook effective core.autocrlf

## Purpose

The shared folder is a host working tree. If git in the laptop used a different `core.autocrlf` than
the host, `git status` inside would show every CRLF file as modified (FR-3, AC-3).

## Code

- Implementation: `agentbook/crates/core/src/autocrlf.rs` (`effective`, `normalize`). The platform
  layer reads the host's global and system values (`host_git_autocrlf`) on every Open.
- Twins: none.
- Test: `agentbook/crates/core/tests/algo.rs` (`agentbook_autocrlf`).

## Input and output

`global`, `system` (optional raw values), `git` (the host has git), `windows` → `{value}`: `true`,
`false` or `input`.

## Rules

1. The host has no git: `true` on Windows, `input` on macOS (whatever values are passed).
2. Else the global value, when set and valid.
3. Else the system value, when set and valid.
4. Else git's default, `false`.

Valid values, trimmed and case-insensitive: `true` / `yes` / `on` / `1` → `true`; `false` / `no` /
`off` / `0` → `false`; `input`. The empty value and anything else count as not set.

## Edge cases

- Priority: CR-01..CR-04, CR-08. No git: CR-05, CR-06, CR-11.
- Normalisation: CR-07, CR-12; invalid falls through CR-09; empty CR-10.

## Examples

Rows (12): [`docs/algorithm-examples/agentbook-autocrlf.json`](../../algorithm-examples/agentbook-autocrlf.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- System before global -> CR-02.
- OS default when git is present but unset -> CR-04.
- No boolean synonyms -> CR-07, CR-12; an invalid value stops the search -> CR-09.
- Host values read when git is absent -> CR-11.

## Where the result is visible

`git config --global core.autocrlf` in a laptop, and a clean `git status` inside for a repo that is
clean on the host.
