---
type: "Notes"
title: "Local Sandbox Tool: notes"
description: "Evidence trail for the local sandbox tool task (PoC findings)."
---

# Notes

## 2026-11-25: Desktop SSH container PoC

PoC [docs/pocs/2026-11-25-1743-desktop-ssh-container/](../../../pocs/2026-11-25-1743-desktop-ssh-container/README.md)
confirmed the mechanism on Debian (glibc) and Alpine (musl) containers:

- A `claude://` link to a `~/.ssh/config` alias with a tool-generated key and a pre-seeded
  known_hosts opens Claude Desktop in the container with no fingerprint prompt.
- Only "Trust this workspace?" remains. Desktop keys it by alias + folder, so the tool reuses a
  stable alias and in-container path per source folder (one slot per parallel line of work) and
  rewrites only the port behind it. The BA then confirms once per folder and slot.
- The host stays untouched, and non-git top folders work with "Worktree" off.
- Project skills, user skills and the generated `~/.claude/CLAUDE.md` all load.
- Desktop installs about 380 MB under `~/.claude/remote`. Cache it per libc family, because the
  glibc and musl builds share a directory name.

## 2026-11-25: devcontainer laptop layer PoC (planning)

PoC [docs/pocs/2026-11-25-2146-devcontainer-laptop-layer/](../../../pocs/2026-11-25-2146-devcontainer-laptop-layer/README.md):
the laptop layer cannot be a devcontainer Feature from outside the project's `.devcontainer/`; the working
mechanism is `devcontainer build` → a tool-built layer that appends its entrypoint to the
`devcontainer.metadata` label → `devcontainer up --override-config` holding only non-label keys plus the
tool's run args and mounts (Dockerfile, image and compose configs, Debian and Alpine). Variables reach SSH
sessions through a `ForceCommand` wrapper that sources a tmpfs env file. Platform probes and crate licences:
[research/platform-and-crates.md](research/platform-and-crates.md).
