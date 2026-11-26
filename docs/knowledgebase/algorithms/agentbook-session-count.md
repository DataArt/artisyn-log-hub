---
type: "Algorithm"
title: "AgentBook session count"
description: "Counts the Claude Desktop sessions attached to a laptop as the ESTABLISHED TCP sockets on the laptop's sshd port, parsed from /proc/net/tcp and /proc/net/tcp6, which needs nothing but sh and cat in the container."
tags: [algorithm, agentbook]
generated: { by: "claude-code", at: "2026-11-25T23:30:00+04:00" }
reviewed: no
reviewer: none
---

# AgentBook session count

## Purpose

Sleep, Remove and on-the-go changes warn how many Desktop sessions they disconnect. The count must
work in any image without installing tools (FR-4, AC-4a, PoC item 6).

## Code

- Implementation: `agentbook/crates/core/src/sessions.rs` (`count_established`; constant
  `SSHD_PORT`). The engine runs `cat /proc/net/tcp /proc/net/tcp6` in Working laptops every 5 s
  while the window is open.
- Twins: none.
- Test: `agentbook/crates/core/tests/algo.rs` (`agentbook_session_count`).

## Input and output

`text` (the concatenated output, as a string or a list of lines) and an optional `port` (default 22)
→ `{count}`.

## Rules

1. Split into lines and each line into whitespace-separated fields.
2. Skip a line whose first field does not end in `:` (the headers, error text) or that has fewer than
   four fields.
3. Count a line when field 4 (`st`) is `01` (ESTABLISHED) and the port after the last `:` of field 2
   (`local_address`, hex) equals `port`. The remote port does not matter.
4. Each counted line is one socket; the count is shown as-is (only zero versus non-zero is
   guaranteed).

## Edge cases

- Listener only SC-01; one session SC-02; tcp + tcp6 SC-03; several sockets SC-10.
- Other local port SC-04; remote port 22 SC-05; TIME_WAIT SC-06.
- Empty SC-07; error line from a kernel without IPv6 SC-08; another port SC-09.

## Examples

Rows (10): [`docs/algorithm-examples/agentbook-session-count.json`](../../algorithm-examples/agentbook-session-count.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Counting LISTEN (`0A`) too -> SC-01.
- Matching the remote port -> SC-05.
- Port compared as decimal text (`0016` vs `22`) -> SC-02.
- tcp6 ignored -> SC-03.
- Any non-`0A` state counted -> SC-06.

## Where the result is visible

"N sessions" on the laptop card, and the counts in the Sleep, Remove and Give a folder confirmations.
