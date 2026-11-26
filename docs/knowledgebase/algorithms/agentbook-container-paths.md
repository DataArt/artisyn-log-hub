---
type: "Algorithm"
title: "AgentBook container paths, SSH alias and claude:// link"
description: "Where the shared and given folders appear inside a laptop (names kept as-is, -2/-3 on a collision), the laptop's stable SSH alias, and how the claude:// link that opens Claude Desktop on it is encoded."
tags: [algorithm, agentbook]
generated: { by: "claude-code", at: "2026-11-26T16:30:00+04:00" }
reviewed: no
reviewer: none
---

# AgentBook container paths, SSH alias and claude:// link

## Purpose

Claude and the user must recognise folders inside the laptop by the same names they have on the host
(spaces and non-ASCII included), two given folders must never land on one path, and the link that
opens Claude Desktop must survive any folder name (FR-3, FR-4, FR-8).

## Code

- Implementation: `agentbook/crates/core/src/paths.rs` (`host_basename`, `strip_verbatim`,
  `shared_container_path`, `given_container_paths`, `ssh_alias`, `encode_uri_component`,
  `claude_link`, `wsl_path`; constants `WORK_ROOT`, `GIVEN_ROOT`, `ALIAS_PREFIX`, `ROOT_NAME`).
- Twins: none.
- Test: `agentbook/crates/core/tests/algo.rs` (`agentbook_container_paths`).

## Input and output

`input.op`: `basename` (`host` → `name`), `shared` (`host`, optional `workspaceFolder` → `path`),
`given` (`hosts`, in the laptop's order → `paths`), `alias` (`id` → `alias`), `link` (`id`, `folder` →
`link`).

## Rules

1. Basename: drop a `\\?\` (or `\\?\UNC\` → `\\`) prefix, split on `/` and `\`, take the last
   non-empty segment as-is (case, spaces, non-ASCII kept).
2. A drive segment `X:` gives `X`; no segment at all (`/`) gives `ROOT_NAME` = `root`.
3. Shared folder: the devcontainer's `workspaceFolder` when set and not blank, else
   `/work/<basename>`.
4. Given folders, in order: `/work/given/<name>`, where `name` is the basename if no earlier given
   folder took it, else the first of `<basename>-2`, `-3`, … not yet taken. Names compare exactly
   (the container is case-sensitive).
5. Alias: `sbx-<id>`; never derived from the display name.
6. Link: `claude://code/new?ssh_host=<alias>&ssh_folder=<folder>`, both values encoded like
   JavaScript's `encodeURIComponent`: every UTF-8 byte except `A-Z a-z 0-9 - _ . ! ~ * ' ( )` becomes
   `%XX` with uppercase hex.
7. Engine path for a Docker engine inside WSL (`wsl_path`, the source of every bind mount when
   the endpoint is `wsl`): drop the verbatim prefix; a POSIX path is kept; `X:\rest` becomes
   `<mountRoot without trailing />/<x lowercase>/<rest with / separators>`, a drive root just
   `<mountRoot>/<x>`; empty segments are dropped.
8. A UNC path `\\wsl.localhost\<distro>\rest` or `\\wsl$\<distro>\rest` of the engine's own
   distro (case-insensitive) becomes `/<rest>`; any other UNC path (a share, another distro) has
   no engine path (`null`), and the laptop cannot be given it.

## Edge cases

- Spaces CP-01, CP-11; non-ASCII CP-02, CP-12, CP-19; trailing separator CP-02, CP-12.
- Drive root CP-03, CP-15; `/` CP-05; verbatim prefix CP-04.
- `workspaceFolder` wins CP-08; blank ignored CP-09.
- Collisions `-2` / `-3` CP-10..CP-12; literal suffix already taken CP-13; case CP-14.
- Link encoding: `/` CP-17, space CP-18, UTF-8 CP-19, query characters CP-20.
- WSL engine paths: drive CP-21, drive root CP-22, custom mount root and verbatim CP-23, own
  distro CP-24, CP-25, other distro CP-26, network share CP-27, POSIX CP-28.

## Examples

Rows (28): [`docs/algorithm-examples/agentbook-container-paths.json`](../../algorithm-examples/agentbook-container-paths.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Numbering from `-1` or counting duplicates instead of finding a free name -> CP-10, CP-13.
- Case-insensitive collision check -> CP-14.
- Sanitising names (spaces to `-`, ASCII only) -> CP-01, CP-12.
- `+` for space or `/` left unencoded -> CP-18, CP-17.
- Encoding `(`, `)` or `'` -> CP-20.
- Basename of `C:\` empty -> CP-03.
- Drive letter kept uppercase or a trailing `/` on a drive root -> CP-21, CP-22.
- Mount root joined without trimming (`//e`) -> CP-23.
- Any `\\wsl.localhost` path accepted regardless of the distro -> CP-26.

## Where the result is visible

`ws mounts` and `ws whoami` inside the laptop, the generated `~/.claude/CLAUDE.md`, the alias in
`~/.ssh/agentbook/config`, and the folder Claude Desktop opens.
