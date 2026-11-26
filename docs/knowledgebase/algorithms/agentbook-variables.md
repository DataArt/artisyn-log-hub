---
type: "Algorithm"
title: "AgentBook variables: Hidden-by-name, resolution and the session env file"
description: "Which variable names start Hidden, which names are valid, where Hidden values are kept in the credential store, the effective value of each variable for one laptop (laptop over folder over project default), and the exact env file that delivers them to every SSH session."
tags: [algorithm, agentbook]
generated: { by: "claude-code", at: "2026-11-25T23:30:00+04:00" }
reviewed: no
reviewer: none
---

# AgentBook variables: Hidden-by-name, resolution and the session env file

## Purpose

Programs in a laptop (for example a project script reading `JIRA_URL` and `JIRA_PAT`) see the values
the user set, secrets start masked and never reach the tool's files, and every SSH session gets the
same values (FR-12, AC-16).

## Code

- Implementation: `agentbook/crates/core/src/variables.rs` (`starts_hidden`, `is_valid_name`,
  `credential_target`, `resolve_container_env_refs`, `resolve`, `render_env_file`; constants
  `HIDDEN_SUBSTRINGS`, `HIDDEN_WORDS`, `CREDENTIAL_PREFIX`). The stored settings are
  `state::VarSetting` (`agentbook-state-file`).
- Twins: the layer's `session.sh` sources the env file (format fixed, External surface).
- Test: `agentbook/crates/core/tests/algo.rs` (`agentbook_variables`).

## Input and output

`input.op`: `hidden` / `valid` (`name`); `credential` (`prefix`, `folder`, optional `laptop`, `name` →
`target`); `container-refs` (`value`, `containerEnv` → `value`); `resolve` (`defaults` and
`containerEnv` as `[name, value]` pairs, `folder` and `laptop` settings `{name, value}` or
`{name, hidden: true}` → `vars`); `env-file` (`vars` as pairs → `text`). In `vars`, a Hidden value is
`{"hidden": true}`.

## Rules

1. Starts Hidden: the name, uppercased, contains `TOKEN`, `SECRET`, `PASSWORD` or `KEY`, or has `PAT`
   as a whole word (words are split on every non-alphanumeric character, `_` included). `PAT` is a
   word, not a substring, so `PATH`, `PATCH`, `COMPAT` stay plain; the others are substrings.
2. Valid name: `[A-Za-z_][A-Za-z0-9_]*` (ASCII).
3. Credential-store entry of a Hidden value: `<prefix><folderId>/<NAME>` folder-wide,
   `<prefix><folderId>/<laptopId>/<NAME>` for one laptop; `prefix` is `AgentBook/` (a scenario stand
   uses its own).
4. `${containerEnv:NAME}` / `${containerEnv:NAME:default}` → the container's value (the last entry of
   that name), else the default, else empty. Other `${…}` and an unterminated reference stay as they are.
5. Project defaults in order (`containerEnv`, then `remoteEnv`): a repeated name takes the later value
   and keeps its first position. A value holding `${containerEnv:` is resolved by rule 4 and is not
   editable (delivered, not listed in the dialog); every other default is editable.
6. Each folder setting replaces the value of its name (source `folder`) or is appended.
7. Each laptop setting then replaces the value of its name (source `laptop`) or is appended.
8. `needsValue` is true exactly when the effective value is the empty plain value.
9. Env file: for each `(name, value)` with a valid name (rule 2), in order, one line
   `NAME='value'` + newline, with every `'` in the value written as `'\''`. Nothing else is escaped:
   newlines, `$`, backticks and backslashes are literal inside single quotes. Invalid names are left out.

## Edge cases

- Hidden-by-name: TOKEN VR-01, PAT VR-02, SECRET VR-03, PASSWORD VR-04, KEY VR-05; plain VR-06;
  `PAT` only as a word VR-07, VR-08, VR-11, VR-12; case VR-09; substring VR-10, VR-13.
- Names: VR-14..VR-19.
- Credential names: VR-20..VR-22.
- `${containerEnv:…}`: VR-23..VR-27.
- Resolution: defaults only VR-28; Hidden folder value VR-29; laptop wins VR-30; added names VR-31;
  repeated default VR-32; derived `PATH` VR-33; explicit empty override VR-34.
- Env file: VR-35..VR-40.

## Examples

Rows (40): [`docs/algorithm-examples/agentbook-variables.json`](../../algorithm-examples/agentbook-variables.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- `PAT` as a substring (`PATH` starts Hidden) -> VR-07; case-sensitive check -> VR-09.
- Folder value over laptop value -> VR-30.
- A repeated default appended twice or keeping the first value -> VR-32.
- Derived defaults editable, or `${containerEnv:…}` left unresolved -> VR-33.
- Hidden counted as needing a value -> VR-29.
- Double quotes or backslash escaping in the env file -> VR-36, VR-37.
- Invalid names written to the env file -> VR-38.

## Where the result is visible

The Variables dialog (Hidden starts checked, the name field's validation), the laptop card's "needs a
value" note, the OS credential manager entries, and `printenv` in a new Claude Desktop session.
