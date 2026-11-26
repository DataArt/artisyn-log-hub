---
type: "Algorithm"
title: "AgentBook state file: load, write-back and ids"
description: "How AgentBook reads and writes its per-user state.json so that an older and a newer copy of the tool can share one data folder: unknown fields survive, a newer schema opens read-only, Hidden variable values are only a marker, and how laptop and folder ids are formed."
tags: [algorithm, agentbook]
generated: { by: "claude-code", at: "2026-11-25T23:30:00+04:00" }
reviewed: no
reviewer: none
---

# AgentBook state file: load, write-back and ids

## Purpose

The installed AgentBook and a copy run straight from Downloads share `%LOCALAPPDATA%\AgentBook\state.json`.
Whichever version writes it must not lose the other's data, a file from a newer tool must never be
overwritten by an older one, and a Hidden variable value must have no way into the file.

## Code

- Implementation: `agentbook/crates/core/src/state.rs` (`parse_state`, `write_state`, `render_state`,
  `id_from_bytes`, `is_valid_id`; types `State`, `Folder`, `EquipmentRef`, `Laptop`, `Given`,
  `VarSetting`, `VarValue`; constant `STATE_SCHEMA_VERSION` = 1).
- Twins: none.
- Test: `agentbook/crates/core/tests/algo.rs` (`agentbook_state_file`), run by `npm run test:algo`
  from `agentbook/`.

## Input and output

`input.op` picks the operation:

- `load` — `file` (a JSON value, written out as text) or `text` (raw text) → `{ok, readOnly, folders,
  laptops}` (counts) or `{ok: false, error: "invalid"}`;
- `roundtrip` — the same, then written back: adds `written` (the written file parsed again) or
  `error: "read-only"`;
- `id` — `bytes` (5 numbers) → `{id, valid}`; `valid-id` — `id` → `{valid}`.

## Rules

1. Load: the text must be JSON, the top level an object, and `schema_version` a whole number ≥ 1;
   otherwise the file is invalid. A version above `STATE_SCHEMA_VERSION` loads, but **read-only**.
2. Every object (top level, folder, equipment, variable setting, laptop, given folder) keeps the keys
   this version does not know and writes them back unchanged. String enums (`equipment.kind`,
   `origin`, `libc`) keep a value this version does not know. A variable value of an unknown
   `kind` is kept whole.
3. Write: pretty JSON. Known lists (`folders`, `laptops`, `recent`, `vars`, `given`, `laptop_vars`)
   are always written, empty when they were missing; optional keys (`claude_dir`, `config`,
   `equipment_hash`, `libc`) are written only when present.
4. A read-only state is never written ("update AgentBook").
5. A variable value is `{"kind":"plain","text":…}` (the text is required) or `{"kind":"hidden"}`.
   Hidden carries nothing: any other key next to `"hidden"` is dropped, so the next write cannot
   carry a value. The value itself lives in the OS credential store (`agentbook-variables`, rule 3).
6. Ids (laptop and folder): 5 random bytes, read as 40 bits, cut into eight 5-bit groups from the
   top, each mapped to `abcdefghijklmnopqrstuvwxyz234567` (RFC 4648 base32, lowercase). A valid id is
   exactly 8 characters of that alphabet.

## Edge cases

- The v1 fixture loads and writes back unchanged: SF-01, SF-02.
- Unknown keys at every level: SF-03; unknown enum values and value kind: SF-06.
- Newer schema read-only and refused on write: SF-04, SF-05.
- Hidden value with a stray text: SF-07.
- Minimal file: SF-08. Invalid: no version SF-09, version 0 SF-10, cut-off JSON SF-11, array SF-12,
  plain value without text SF-13.
- Ids: all zero SF-14, all ones SF-15, mixed SF-16; validity SF-17..SF-20.

## Examples

`input.file` is the file content as JSON (the test writes it out as text). `expected` lists the keys
the row pins.

Rows (20): [`docs/algorithm-examples/agentbook-state-file.json`](../../algorithm-examples/agentbook-state-file.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Unknown keys dropped (no flatten / `deny_unknown_fields`) -> SF-03.
- An unknown enum value or value kind rejected or mapped to a default -> SF-06.
- Newer version rejected instead of read-only -> SF-04; written anyway -> SF-05.
- Hidden value keeps its text -> SF-07.
- Missing lists left out on write -> SF-08, SF-06.
- Version 0 or a missing version accepted -> SF-10, SF-09.
- Base32 with uppercase or `0-5` digits -> SF-14, SF-16, SF-19.

## Where the result is visible

Safe behaviour: a second copy of the tool sharing the data folder keeps the other copy's laptops and
fields; with a newer file the UI shows the laptops with "update AgentBook" and changes nothing. The
id is the `sbx-<id>` SSH alias and the Docker label value.
