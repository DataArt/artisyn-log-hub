---
type: "Algorithm"
title: "AgentBook override-config generation"
description: "Builds the --override-config devcontainer.json (and for compose configs the extra tool compose file) that devcontainer up gets for a project-Equipment laptop: only what the layered image's devcontainer.metadata label lacks, plus the tool's run arguments and mounts, never repeating label-carried keys."
tags: [algorithm, agentbook]
generated: { by: "claude-code", at: "2026-11-25T23:30:00+04:00" }
reviewed: no
reviewer: none
---

# AgentBook override-config generation

## Purpose

A laptop must start exactly as `devcontainer up` would start the project, plus the tool's SSH port,
volume and mounts, and with the shared folder (not the enclosing git root) as the workspace.
Repeating a key the image label already carries runs lifecycle commands twice (PoC
`docs/pocs/2026-11-25-2146-devcontainer-laptop-layer/`), so the override holds only what is missing
(FR-7, AC-6).

## Code

- Implementation: `agentbook/crates/core/src/override_config.rs` (`generate`, `mount_string`,
  `home_volume`, `compose_project`, `ToolRun`, `GivenMount`, `Override`; constants `KEY_MOUNT`,
  `BIN_MOUNT`, `STATE_MOUNT`, `RUN_TMPFS`). Shared-folder path: `agentbook-container-paths`.
- Twins: none.
- Test: `agentbook/crates/core/tests/algo.rs` (`agentbook_override_config`).

## Input and output

`merged` — the project's merged configuration; `run` — the tool's part: `laptopId`, `image` (the
layered `agentbook-laptop:…`), `shared` (host path), `configDir` (host folder of the selected config),
`port`, `home` (the SSH user's home), `keyDir`, `binDir`, `stateDir`, `given` (`{source, target,
readOnly}`), `labels` (`[key, value]` pairs), `composeFile` (where the tool compose file goes) →
`{config, compose, workspaceFolder, composeProject}`; `compose` and `composeProject` are `null` for
image and Dockerfile configs.

## Rules

1. The override holds only `name` (when the project sets one), the image or compose keys below,
   `workspaceMount`/`workspaceFolder`, `runArgs` and `mounts`. Everything else (users, `containerEnv`,
   `remoteEnv`, lifecycle commands, features, the project's `mounts`, customizations, ports,
   `overrideCommand`, `shutdownAction`, …) is carried by the image label and never repeated.
2. Image and Dockerfile configs: `image` = the layered image; `build` / the project's `image` are not
   written.
3. Workspace (image and Dockerfile):
   a. The project sets `workspaceMount`: keep it verbatim; `workspaceFolder` = the project's, else the
      mount's `target`, else `/work/<basename>`.
   b. It does not: `workspaceFolder` = the shared-folder path (`agentbook-container-paths` rule 3:
      the project's `workspaceFolder`, else `/work/<basename>`), and `workspaceMount` =
      `source=<shared>,target=<workspaceFolder>,type=bind` — always, because the CLI's default would
      mount the enclosing git root.
4. `runArgs` = the project's `runArgs`, then `-p 127.0.0.1:<port>:22`, `--tmpfs /run/agentbook`, then
   `--label k=v` per label in order.
5. `mounts` = the tool's only, in order: `source=agentbook-home-<id>,target=<home>,type=volume`; the
   key, bin and state folders at `/opt/agentbook/{key,bin,state}` with `readonly`; then each given
   folder as a bind, with `readonly` when View only.
6. Compose configs (`dockerComposeFile` set): `dockerComposeFile` = the project's files (a string is
   one file), each joined onto `configDir` unless absolute (a drive or a leading `/` or `\`; joined
   with `\` when `configDir` has one, `..` left for Docker), then `composeFile`; plus `service`,
   `runServices` (when set) and `workspaceFolder`. No `image`, `runArgs` or `mounts`.
   `composeProject` = `agentbook-<id>`.
7. The tool compose file sets, for the primary service: `image`, `ports: ["127.0.0.1:<port>:22"]`,
   `tmpfs: ["/run/agentbook"]`, `labels` (a map) and `volumes` in rule 5's order in long syntax
   (`{type, source, target, read_only?}`, so Windows drive colons are safe), and declares the home
   volume `{name, external: true}` (the engine creates it, labelled). It is written as JSON, which is
   valid YAML.
8. Compose without `workspaceFolder`: the tool binds the shared folder at `/work/<basename>` as the
   last volume and uses that as `workspaceFolder`; with one, the project's compose mounts its own
   workspace.
9. Mount strings: each `source=` / `target=` field that holds a `,` or `"` is CSV-quoted as a whole
   (`"source=C:\a,b"`, inner `"` doubled).

## Edge cases

- Image config with every label-carried key in the input: OC-01.
- Dockerfile config, project runArgs, given folders: OC-02.
- Custom `workspaceMount`: OC-03; without `workspaceFolder`: OC-05; `workspaceFolder` only: OC-04.
- Compose: OC-06; single file, no `workspaceFolder`: OC-07; absolute files: OC-09.
- Comma in a path: OC-08.

## Examples

Rows (9): [`docs/algorithm-examples/agentbook-override-config.json`](../../algorithm-examples/agentbook-override-config.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Copying label-carried keys (lifecycle commands, env, the project's mounts) -> OC-01, OC-06.
- Leaving `build` in -> OC-02.
- No `workspaceMount` when the project sets none -> OC-01, OC-04.
- Replacing the project's `workspaceMount` -> OC-03.
- Tool runArgs before the project's -> OC-02.
- Compose home volume not `external` (compose would own and delete it) -> OC-06.
- Relative compose files left relative -> OC-06, OC-07; absolute ones joined -> OC-09.
- No CSV quoting -> OC-08.

## Where the result is visible

`laptops/<id>/gen/devcontainer.json` and `agentbook-compose.yml` in the data folder; the laptop
container's ports, mounts and labels in `docker inspect`; lifecycle commands running once.
