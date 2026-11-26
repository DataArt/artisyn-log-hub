---
type: "Algorithm"
title: "AgentBook OpenSSH version floor"
description: "Parses the version that ssh -V prints and checks it against OpenSSH 9.4, the lowest version Claude Desktop's SSH remote works with on Windows, for the prerequisites check."
tags: [algorithm, agentbook]
generated: { by: "claude-code", at: "2026-11-25T23:30:00+04:00" }
reviewed: no
reviewer: none
---

# AgentBook OpenSSH version floor

## Purpose

Older Windows builds ship OpenSSH 8.x, with which Claude Desktop's SSH link fails. The prerequisites
check names the problem instead (FR-10, AC-8).

## Code

- Implementation: `agentbook/crates/core/src/openssh.rs` (`parse_version`, `meets_floor`; constant
  `OPENSSH_FLOOR` = (9, 4)). The platform layer runs the `ssh.exe` that PATH resolves and passes its
  output (stderr).
- Twins: none.
- Test: `agentbook/crates/core/tests/algo.rs` (`agentbook_openssh_version`).

## Input and output

`output` (what `ssh -V` printed) → `{version: "M.m" | null, ok}`.

## Rules

1. Find `OpenSSH_for_Windows_`, else `OpenSSH_`; right after it read `<digits>.<digits>` (the rest,
   such as `p1`, is ignored). No marker or no such number → no version.
2. `ok` = a version was read and (major, minor) ≥ (9, 4), compared as numbers.

## Edge cases

- Above, at and below the floor: OV-01, OV-02, OV-03, OV-04.
- Two-digit minor: OV-05; major 10: OV-06.
- Non-Windows form: OV-07.
- Unparsable: no ssh OV-08, no digits OV-09, no minor OV-10.

## Examples

Rows (10): [`docs/algorithm-examples/agentbook-openssh-version.json`](../../algorithm-examples/agentbook-openssh-version.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- String comparison of versions -> OV-05.
- `>` instead of `>=` -> OV-02.
- Only the Windows marker accepted -> OV-07.
- A missing version treated as OK -> OV-08.

## Where the result is visible

The OpenSSH row of the prerequisites screen and the home footer's OpenSSH version.
