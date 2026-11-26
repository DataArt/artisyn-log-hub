---
type: "Algorithm"
title: "AgentBook Equipment change and libc switch"
description: "The Equipment config hash that keys AgentBook's image cache and marks laptops 'Equipment changed — Update laptop', the card state it gives, and whether Update laptop clears the downloaded Claude Code CLI because the image's libc family switched."
tags: [algorithm, agentbook]
generated: { by: "claude-code", at: "2026-11-25T23:30:00+04:00" }
reviewed: no
reviewer: none
---

# AgentBook Equipment change and libc switch

## Purpose

An edited devcontainer, or a tool update that ships a new standard Equipment or laptop layer, must
show "Equipment changed" on existing laptops and never rebuild needlessly; a laptop whose image moved
from glibc to musl must get the matching Claude Code CLI (FR-7, AC-6).

## Code

- Implementation: `agentbook/crates/core/src/equipment.rs` (`config_hash`, `sha256_hex`,
  `equipment_state`, `clears_ccd_cli`; constant `HASH_TAG`). The engine collects the files (the
  selected config, every file in its folder, the compose files and Dockerfile it references).
- Twins: none.
- Test: `agentbook/crates/core/tests/algo.rs` (`agentbook_equipment`).

## Input and output

`input.op`: `hash` (`files` as `[path, text]` pairs, `std`, `layer` → `hash`); `compare` (two such
specs `a`, `b` → `same`); `state` (optional `recorded`, `current` → `state`); `libc` (optional
`recorded`, `new` → `clear`).

## Rules

1. Paths: `\` becomes `/`; files are sorted by path (bytes).
2. A repeated path counts once, its first entry in the given order.
3. The hash is lowercase hex sha256 over: `HASH_TAG` (`agentbook-equipment-v1`) and `\n`; for each
   file its path, one 0 byte, its length as 8 big-endian bytes, its bytes; then
   `std=<standard version>\n` and `layer=<layer version>\n`. File bytes are hashed raw (no line-ending
   normalisation).
4. Card state: no recorded hash → `not-built`; equal → `current`; different → `changed`.
5. Update laptop clears `~/.claude/remote/ccd-cli` when the new libc family differs from the recorded
   one; nothing recorded counts as different.

## Edge cases

- Exact layout: EQ-01 (no files), EQ-02 (one file).
- Order-independence EQ-03; separators EQ-06; duplicates EQ-11.
- Changes: content EQ-04, line endings EQ-05, versions EQ-07, EQ-08, rename EQ-09, boundary shift EQ-10.
- States: EQ-12..EQ-14. libc: EQ-15..EQ-18.

## Examples

Rows (18): [`docs/algorithm-examples/agentbook-equipment.json`](../../algorithm-examples/agentbook-equipment.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- No sort -> EQ-03. No separator normalisation -> EQ-06.
- Path not hashed -> EQ-09. No length / separator -> EQ-10.
- Versions not hashed -> EQ-07, EQ-08.
- Line endings normalised -> EQ-05.
- Unknown libc treated as unchanged -> EQ-17.

## Where the result is visible

The laptop card's Equipment state ("Getting equipment", "Equipment changed — Update laptop"), the
`agentbook-eq:<hash>` image tag, and Claude Desktop re-downloading its CLI after a libc switch.
