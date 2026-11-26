---
type: "Algorithm"
title: "AgentBook Docker endpoint resolution"
description: "Finds the Docker engine the way the docker CLI does (DOCKER_HOST, then the current context's meta.json, then the default pipe or socket), because bollard's defaults ignore contexts, and refuses an engine on another computer that cannot see this computer's folders."
tags: [algorithm, agentbook]
generated: { by: "claude-code", at: "2026-11-26T16:30:00+04:00" }
reviewed: no
reviewer: none
---

# AgentBook Docker endpoint resolution

## Purpose

AgentBook must talk to the same engine the user's `docker` command uses (Docker Desktop, Rancher
Desktop, any engine with the Docker API), and say plainly when that engine is on another computer,
because bind mounts of host folders would not work there (FR-9, AC-8).

## Code

- Implementation: `agentbook/crates/core/src/docker_endpoint.rs` (`resolve`, `parse_host`,
  `context_dir_name`, `EndpointInput`, `Resolution`; constants `WINDOWS_DEFAULT_PIPE`,
  `UNIX_SYSTEM_SOCKET`). The platform layer reads the environment and the files and probes the
  candidates.
- Twins: none.
- Test: `agentbook/crates/core/tests/algo.rs` (`agentbook_docker_endpoint`).

## Input and output

- `dir` — a context `name` → `{dir}`.
- `resolve` — optional `dockerHost`, `dockerContext`, `configJson` (`~/.docker/config.json`, an
  object or raw text), `metas` (context name → its `meta.json`), `home`, `windows` →
  `{source, candidates: [{kind, address}]}` or `{error: "not-local" | "unsupported", url}`.

## Rules

1. `DOCKER_HOST`, when set and not blank, is the endpoint (source `DOCKER_HOST`).
2. Else the context: `DOCKER_CONTEXT` when set and not blank, else `currentContext` of `config.json`
   (an unreadable file gives none). `default` means no context. Its
   `~/.docker/contexts/meta/<dir>/meta.json` → `Endpoints.docker.Host` is the endpoint (source
   `context:<name>`); a missing meta or host falls through to rule 3.
3. Else the default (source `default`): Windows `\\.\pipe\docker_engine`, then a `wsl`
   candidate with an empty address (the platform looks for a WSL distro running a Docker
   engine, skipping Docker Desktop's and Rancher Desktop's own distros); elsewhere
   `<home>/.docker/run/docker.sock`, then `/var/run/docker.sock`, tried in that order.
4. `<dir>` = lowercase hex sha256 of the context name.
5. Endpoint URLs: `npipe://` + path with `/` turned into `\` (`npipe:////./pipe/x` →
   `\\.\pipe\x`), kind `pipe`; `unix://` + path, kind `unix`; `tcp://`, `http://`, `https://` to
   `localhost`, `127.x.x.x` or `[::1]`, kind `tcp`, address the URL; to any other host, and every
   `ssh://`, → `not-local`; AgentBook's own `wsl://<distro>` (slashes trimmed, not empty), kind
   `wsl`, address the distro; any other scheme (and `wsl://` with no distro) → `unsupported`.

## Edge cases

- Context folder name: DE-01.
- DOCKER_HOST kinds: DE-02..DE-06; not local DE-07, DE-08; unsupported DE-09; blank DE-10.
- Contexts: currentContext DE-11, DOCKER_CONTEXT wins DE-12, DOCKER_HOST wins DE-13, `default`
  DE-14, missing meta DE-15, broken config DE-16, remote context DE-18.
- macOS default order: DE-17. Windows default, pipe then any WSL distro: DE-10, DE-14..DE-16.
- WSL engine: `wsl://<distro>` DE-19, no distro DE-20.

## Examples

Rows (20): [`docs/algorithm-examples/agentbook-docker-endpoint.json`](../../algorithm-examples/agentbook-docker-endpoint.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- currentContext before DOCKER_CONTEXT -> DE-12.
- Context before DOCKER_HOST -> DE-13.
- `default` looked up as a named context or erroring -> DE-14.
- A missing meta treated as an error -> DE-15.
- Remote TCP accepted -> DE-07; only `tcp://localhost` treated as local -> DE-05, DE-06.
- Pipe path left with `/` -> DE-02.

## Where the result is visible

The engine row of the prerequisites screen and the home footer (which engine AgentBook uses), and
the plain messages "No Docker-compatible engine found…" / "AgentBook needs a Docker engine on this
computer".
