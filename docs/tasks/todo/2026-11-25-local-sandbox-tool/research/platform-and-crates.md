---
type: "Research"
title: "AgentBook: platform probes and crate licences"
description: "How the tool finds the Docker engine, Claude Desktop and OpenSSH versions on Windows, and which UI/runtime crates pass the licence allowlist."
---

# Platform probes and crate licences (2026-11-25)

## Docker engine (FR-9)

- `~/.docker/config.json` → `currentContext` (here `desktop-linux`); the context's endpoint is in
  `~/.docker/contexts/meta/<sha256(context name)>/meta.json` → `Endpoints.docker.Host`
  (`npipe:////./pipe/dockerDesktopLinuxEngine`). Verified: sha256("desktop-linux") is the folder name.
- The `default` context is `npipe:////./pipe/docker_engine`.
- Resolution order for the tool: `DOCKER_HOST` → `DOCKER_CONTEXT` / `currentContext` meta → default pipe
  (Windows) or `~/.docker/run/docker.sock` / `/var/run/docker.sock` (macOS). bollard's
  `connect_with_defaults` does not read contexts, so the tool resolves the endpoint itself and connects with
  the matching bollard constructor.
- A host-side client may pass Windows paths as bind sources unchanged (PoC
  `docs/pocs/2026-11-25-2146-devcontainer-laptop-layer/`, item 5).

## Claude Desktop version (FR-10)

- The current Windows Desktop is an MSIX package `Claude` (publisher id `pzs8sxrjxfjjc`), registering the
  `claude:` protocol in its manifest. Package version and `app\claude.exe` ProductVersion agree (a 6.x number, not
  the 2.x scheme of the FR-10 floors; the tool compares dotted numbers).
- An older Squirrel install can remain under `%LOCALAPPDATA%\AnthropicClaude\app-<version>`, and
  `HKCR\claude\shell\open\command` may still point at it although the MSIX package handles the protocol. The
  registry handler is therefore not a reliable version source.
- Not used (owner, 2026-11-25: no Desktop version check). Former rule: read the version of the installed `Claude` MSIX package for the current user (Windows
  PackageManager API); if there is none, fall back to the highest `app-<version>` of the Squirrel install;
  compare dotted numbers against the FR-10 floors.

## OpenSSH (FR-10)

- `C:\Windows\System32\OpenSSH\ssh.exe -V` prints `OpenSSH_for_Windows_<X.Y>p<N>, LibreSSL <v>` (to stderr).
  The tool runs the `ssh.exe` that PATH resolves (the one Desktop uses) and parses `OpenSSH_for_Windows_X.Y`.
  A Git-for-Windows `ssh` on a POSIX PATH prints `OpenSSH_10.x` and is not what Desktop uses.

## devcontainer CLI and Node

- `@devcontainers/cli` 0.91.0 is the current release; its npm package has no runtime dependencies
  (`dependencies = {}`, 1.9 MB unpacked), so one tarball + a Node runtime is the whole download.
- The CLI drives the `docker` executable (and compose), so project Equipment needs a `docker` CLI on the
  machine (Docker Desktop and Rancher Desktop ship one); the standard Equipment does not.

## Crate licences (crates.io, latest versions)

| Crate | Version | Licence |
|---|---|---|
| eframe / egui | 0.37.0 | MIT OR Apache-2.0 |
| epaint_default_fonts | 0.37.0 | (MIT OR Apache-2.0) AND OFL-1.1 AND Ubuntu-font-1.0 — outside the allowlist |
| keyring | 4.2.0 | MIT OR Apache-2.0 |
| bollard | 0.21.1 | Apache-2.0 |
| reqwest | 0.13.5 | MIT OR Apache-2.0 |
| rfd | 0.18.0 | MIT |

egui's bundled fonts are the only licence problem; using the OS fonts (Segoe UI and its fallbacks on Windows,
the system font on macOS) through the platform layer avoids it and covers non-ASCII folder names better.
