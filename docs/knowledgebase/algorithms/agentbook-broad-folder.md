---
type: "Algorithm"
title: "AgentBook whole-disk, home and ancestor detection"
description: "Decides whether a folder the user gives to a laptop is a drive root, the home folder or an ancestor of it, in which case the tool asks for an explicit confirmation because Claude would get the whole disk."
tags: [algorithm, agentbook]
generated: { by: "claude-code", at: "2026-11-25T23:30:00+04:00" }
reviewed: no
reviewer: none
---

# AgentBook whole-disk, home and ancestor detection

## Purpose

Giving `C:\`, the home folder or `C:\Users` hands Claude (nearly) everything the user owns. The tool
asks for an explicit confirmation before connecting such a folder (FR-8, AC-7).

## Code

- Implementation: `agentbook/crates/core/src/broad_folder.rs` (`classify`, `Breadth`).
- Twins: none.
- Test: `agentbook/crates/core/tests/algo.rs` (`agentbook_broad_folder`).

## Input and output

`path` (the chosen folder) and `home` (the user's home folder), both absolute as the folder picker
returns them → `{breadth, confirm}`, `breadth` one of `drive-root`, `home`, `home-ancestor`, `none`;
`confirm` is true for all but `none`.

## Rules

1. Normalise: drop a `\\?\` prefix. A path starting with a single `/` is POSIX: split on `/`, compare
   exactly. Anything else is Windows: `/` counts as `\`, split on `\`, compare in Unicode lowercase. Empty
   and `.` segments are ignored (so a trailing separator changes nothing).
2. Drive root: a Windows path whose only component is `X:`, a UNC path with at most server and share,
   or POSIX `/` → `drive-root` (checked first, so `C:\` is not reported as an ancestor).
3. Components equal to home's → `home`.
4. Components a strict prefix of home's (same style) → `home-ancestor`.
5. Otherwise → `none`.

## Edge cases

- Drive roots: `C:\` BF-01, `C:` BF-02, other drive BF-03, UNC share BF-10.
- Home: exact BF-04, case / slashes / trailing separator BF-05, non-ASCII case BF-13.
- Ancestor BF-06, verbatim prefix BF-09; other drive BF-12.
- Narrow: inside home BF-07, text prefix only BF-08, below a share BF-11.
- POSIX: BF-14..BF-17 (case-sensitive BF-17).

## Examples

Rows (17): [`docs/algorithm-examples/agentbook-broad-folder.json`](../../algorithm-examples/agentbook-broad-folder.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Text prefix instead of components -> BF-08.
- Case-sensitive on Windows -> BF-05, BF-13; case-insensitive on POSIX -> BF-17.
- Only the system drive counted as a root -> BF-03.
- Ancestor check before the root check -> BF-01.
- Drive ignored in the ancestor check -> BF-12.

## Where the result is visible

The whole-disk confirmation in the Get a laptop and Give a folder dialogs ("Claude would get the
whole disk").
