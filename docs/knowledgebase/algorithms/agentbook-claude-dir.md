---
type: "Algorithm"
title: "AgentBook .claude/ discovery"
description: "Decides where Claude starts in a shared folder: the root when there is no .claude/ directory, the folder holding it when there is one, and a one-time question (remembered per folder) when there are several."
tags: [algorithm, agentbook]
generated: { by: "claude-code", at: "2026-11-25T23:30:00+04:00" }
reviewed: no
reviewer: none
---

# AgentBook .claude/ discovery

## Purpose

A shared folder may hold several projects. Claude should start where the project's `.claude/`
configuration is, and the user is asked at most once per folder when that is ambiguous (FR-1, AC-2).

## Code

- Implementation: `agentbook/crates/core/src/claude_dir.rs` (`scan_descends`, `candidates`, `decide`;
  constants `SKIPPED_DIRS`, `CLAUDE_DIR`). The engine walks the folder and calls these.
- Twins: none.
- Test: `agentbook/crates/core/tests/algo.rs` (`agentbook_claude_dir`).

## Input and output

- `descends` — a directory `name` → `{descends}`: whether the walk enters it.
- `decide` — `dirs` (every directory found, relative to the shared folder) and an optional
  `remembered` answer → `{candidates, decision}` with `decision` `root`, `use` (+ `folder`) or `ask`
  (+ `ask`, the list offered).

## Rules

1. The walk never enters `.git`, `node_modules` or `.claude` (it records a `.claude` but does not look
   inside it). Paths may use `/` or `\`; empty and `.` segments are ignored.
2. Candidates: for every path whose last segment is `.claude` and none of whose other segments is a
   name from rule 1, its parent path joined with `/` (`""` = the shared folder's root). Sorted by
   bytes, duplicates removed.
3. No candidate: start in the root.
4. One candidate: start there, without asking.
5. Several: if the answer remembered for this folder is one of them, use it; otherwise ask, offering
   the candidates. The answer is stored as the folder's `claude_dir`.

## Edge cases

- Nothing found: CD-01, CD-02. Root `.claude`: CD-03. One in a subfolder: CD-04.
- Several: ask CD-05; remembered CD-06; remembered but gone CD-07; root among them CD-12, CD-13.
- Skipped paths: `node_modules`, `.git` CD-08; nested `.claude` CD-09.
- Separators and duplicates: CD-10, CD-11. Non-ASCII: CD-14.
- Walk: CD-15..CD-18.

## Examples

Rows (18): [`docs/algorithm-examples/agentbook-claude-dir.json`](../../algorithm-examples/agentbook-claude-dir.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Not skipping `node_modules` / `.git` -> CD-08.
- Entering `.claude` (nested ones become candidates) -> CD-09, CD-17.
- Remembered answer used even when no longer a candidate -> CD-07.
- Asking with a single candidate -> CD-03, CD-04.
- `\` not treated as a separator -> CD-10.
- No dedup -> CD-11.

## Where the result is visible

The "Choose where Claude starts" question when a folder is added, and the `ssh_folder` of the
`claude://` link (Claude Desktop opens in that folder).
