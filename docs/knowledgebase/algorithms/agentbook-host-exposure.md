---
type: "Algorithm"
title: "AgentBook host-exposure detection"
description: "Finds what in a devcontainer's merged config hands the laptop a piece of the host (writable bind mounts other than the workspace, the Docker socket, privileged, host network or PID namespace), so the tool can name each in a warning without blocking it."
tags: [algorithm, agentbook]
generated: { by: "claude-code", at: "2026-11-25T23:30:00+04:00" }
reviewed: no
reviewer: none
---

# AgentBook host-exposure detection

## Purpose

A laptop is meant to keep Claude away from the rest of the computer. A project devcontainer may open
holes (the Docker socket, writable host folders, privileged mode); the user must see each one named
(FR-7, AC-6).

## Code

- Implementation: `agentbook/crates/core/src/host_exposure.rs` (`detect`, `parse_mount_string`,
  `parse_volume_arg`, `Exposure`). The input is the merged configuration from
  `devcontainer read-configuration --include-merged-configuration`.
- Twins: none.
- Test: `agentbook/crates/core/tests/algo.rs` (`agentbook_host_exposure`).

## Input and output

`config`: the merged config (`mounts`, `privileged`, `runArgs`, `workspaceFolder`) → `findings`, a list
of `{kind, source?}`, `kind` one of `writable-bind`, `docker-socket`, `privileged`, `host-network`,
`host-pid`.

## Rules

1. Mounts are strings (`type=…,source=…,target=…[,readonly]`, CSV with `"` quoting; `src`, `dst`,
   `destination`, `ro` accepted) or objects `{type, source, target}`. The type defaults to `volume`.
2. A mount whose source or target ends in `docker.sock` (or a `docker_engine` pipe) →
   `docker-socket` with its source, read-only or not.
3. Otherwise a `bind` mount that is not read-only and whose target is not the `workspaceFolder` →
   `writable-bind` with its source. Volumes and read-only binds are not findings.
4. `privileged: true` → `privileged`.
5. `runArgs`, read as flags with values inline (`--x=v`) or in the next argument: `--privileged`
   (unless `=false`) → `privileged`; `--network` / `--net` `host` → `host-network`; `--pid host` →
   `host-pid`; `-v` / `--volume src:dst[:opts]` (a drive `C:` stays in the source; a source with a
   path separator is a bind, a bare name a volume; `ro` makes it read-only) and `--mount` are
   checked like mounts by rules 2–3. An argument that does not start with `-` is never a flag.
6. Order: mounts, then `privileged`, then `runArgs`; a finding equal to an earlier one is dropped.

## Edge cases

- Socket: HE-02, read-only socket HE-19.
- Binds: writable HE-03, read-only HE-04, object form HE-06, workspace HE-18; volumes HE-05, HE-07.
- Privileged: key HE-08, twice HE-09, `=false` HE-22.
- Namespaces: HE-10..HE-13.
- `-v` / `--volume` / `--mount`: HE-14..HE-17.
- Order and dedup: HE-20, HE-23; value of another flag HE-21.

## Examples

Rows (23): [`docs/algorithm-examples/agentbook-host-exposure.json`](../../algorithm-examples/agentbook-host-exposure.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Socket only when writable -> HE-19.
- Read-only binds reported -> HE-04, HE-15.
- Workspace mount reported -> HE-18.
- `-v C:\data:/data` split at the drive colon -> HE-14.
- Only inline `--net=host` recognised -> HE-11.
- No dedup -> HE-09, HE-23.

## Where the result is visible

The host-exposure warning on the folder's Equipment ("This Equipment gives the laptop: the Docker
socket, …").
