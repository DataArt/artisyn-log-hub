---
type: "Algorithm"
title: "AgentBook forwarded ports"
description: "Which laptop ports AgentBook forwards to this computer: the defaults read from a devcontainer's forwardPorts, the effective list of a laptop (the user's list, else those defaults) and the check of a list typed in Ports…"
tags: [algorithm, agentbook]
generated: { by: "claude-code", at: "2026-11-26T20:30:00+04:00" }
reviewed: no
reviewer: none
---

# AgentBook forwarded ports

## Purpose

A dev server the agent starts in a laptop (Vite on 5173, an API on 3000) must open in the user's
browser at `localhost:<port>`. AgentBook keeps an SSH tunnel per forwarded port while the laptop
works; this algorithm decides which ports those are and rejects a list that cannot work.

## Code

- Implementation: `agentbook/crates/core/src/ports.rs` (`devcontainer_ports`, `effective`,
  `check`); the list lives in `Laptop.ports` (`state.json`).
- Twins: none.
- Test: `agentbook/crates/core/tests/algo.rs` (`agentbook_forward_ports`).

## Input and output

`input.op`: `devcontainer` (`merged`: a merged devcontainer config → `ports`), `effective` (`set`:
the user's list of `{port, host}` or absent, `devcontainer`: port numbers → `ports` as
`{port, host}`), `check` (`list` → `ok`, or `error` with the message).

## Rules

1. Devcontainer defaults: the items of `forwardPorts`, in order, duplicates dropped. A number in
   1..=65535 is a port; a string `"<n>"`, `"localhost:<n>"` or `"127.0.0.1:<n>"` is port `n`; a
   string naming another host (`"db:5432"`, a compose service) and anything else is skipped.
2. Effective list: the user's list when set (also when empty: the user removed them all), else
   every devcontainer port on the same port of this computer.
3. Check: every port is 1..=65535 (0 is refused); a port of this computer appears once. The same
   laptop port twice on different ports of this computer is allowed.

## Edge cases

- Numbers and strings FP-01; other host skipped FP-02; duplicates FP-03; out of range FP-04; no
  `forwardPorts` FP-05.
- User list wins FP-06; empty user list wins FP-07; defaults FP-08.
- Check: fine FP-09; host twice FP-10; zero FP-11; same laptop port twice FP-12.

## Examples

Rows (12): [`docs/algorithm-examples/agentbook-forward-ports.json`](../../algorithm-examples/agentbook-forward-ports.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Keeping `"db:5432"` -> FP-02.
- Not dropping duplicates -> FP-03.
- An empty user list falling back to the defaults -> FP-07.
- Checking laptop ports instead of host ports for duplicates -> FP-10, FP-12.

## Where the result is visible

The Ports section of a laptop card and the Ports… dialog, `ws ports` inside the laptop, and
`localhost:<host>` in the user's browser.
