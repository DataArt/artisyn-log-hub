---
type: "Research"
title: "How Claude Desktop's Code tab can work inside a Work Hub container"
description: "Comparison of every documented way to attach Claude Desktop (Code tab) to a Work Hub workstream container for non-technical users; picks SSH (2026-11-25)"
---

Sources: Claude Code docs (code.claude.com/docs/en/): `desktop.md`, `desktop-wsl.md`,
`cloud-environments.md`, `self-hosted-environments.md`, `permissions.md`, `managed-settings.md`,
`mcp.md`, `sandboxing.md`. Checked 2026-11-25.

## Hard constraints

1. Prompts come from the Code tab of Claude Desktop, nothing else.
2. Everything the agent does stays inside the container.
3. The users are business analysts and managers, so they must not use a terminal, edit config files
   or handle SSH keys.

## What the Desktop Code tab offers

| Environment | Where tools run | Fits constraint 2? |
|---|---|---|
| Local | the user's machine | no |
| WSL (Windows) | WSL 2 on the user's machine | no |
| Cloud (Anthropic-managed) | Anthropic VMs; the base image can't be replaced, only a setup script | yes, but not in Work Hub's container |
| Cloud → self-hosted environment | your own runners (public beta, Team/Enterprise only, off by default, own runner image around the `claude` binary) | yes, but the runner's container, not the workstream's |
| SSH | Claude Code is installed on the remote and runs there; shell, file tools and stdio MCP all run as the remote user | **yes** |

## Options compared

| # | Option | Isolation | Non-technical UX | Verdict |
|---|---|---|---|---|
| A | **SSH environment into the workstream container through a Work Hub SSH gateway** | Complete: the agent loop itself runs in the container. Local Bash/Edit do not apply in an SSH session; the file pane is view-only. | Work Hub shows a `claude://code/new?ssh_host=…&ssh_port=…&ssh_folder=…` link (Desktop ≥ v2.110.0) that opens the SSH session pre-filled. The user pastes a per-workstream password once and Desktop can remember it. No keys, no terminal, no config files. | **Pick** |
| B | Local session + an MCP server that exposes exec/file tools for the container | Weak: built-in tools must be removed with `permissions.deny` in managed settings on every user machine, and claude.ai connectors and `claude_desktop_config.json` servers still load. One misconfiguration breaks constraint 2. | Needs managed settings and an MCP install per machine, which is admin work. | Reject |
| C | Self-hosted cloud environment (Work Hub as a runner) | Good, but the session runs in the runner's own container, not the prepared workstream container, so FR-6 and Work Hub's lifecycle are lost. | No local setup, but Team/Enterprise only, a beta, an owner must switch it on, and no documented Desktop link. Not available under ZDR/HIPAA. | Keep as a future option for org-wide rollouts |
| D | Anthropic cloud environments | Good, but outside Work Hub: no checkpoint image, no git proxy, no access to an on-prem Work Hub. | Good | Out of scope (not Work Hub) |
| E | Claude Code sandboxing (Seatbelt/bubblewrap) | Shell only; file tools and MCP run outside the sandbox; no native Windows support | — | Reject |
| F | Dev container / Docker environment type in Desktop | Not documented | — | Not available |

## Why A

- It is the only option where nothing runs locally by design, rather than by deny rules that have
  to be kept correct.
- The container stays the workstream container, so the checkpoint image, Configure tools and git
  proxy remotes (FR-6) and Work Hub's lifecycle all keep working.
- Setup is one link click plus one paste, which is within reach of BAs.
- It works with any Claude plan that has the Code tab; no Team/Enterprise beta is needed.

## What A needs on the Work Hub side (input for planning)

- **SSH endpoint.** One TCP port on the Work Hub host, with a stable host key. Two shapes:
  - (preferred) an SSH gateway in the Work Hub server that authenticates
    `username = workstream id`, `password = attach token`, then bridges exec, shell and SFTP into
    the container through the Docker API. Auth, revocation and the "attached" indicator are central,
    and no per-container keys are needed.
  - (alternative) `sshd` in every container behind a `ProxyCommand docker exec -i … sshd -i`. This
    is the documented Desktop pattern, but it needs keys and access to the Docker host.
- **Container requirements from Desktop.** x86_64/arm64 with glibc 2.17+ or musl, an SFTP subsystem,
  a POSIX shell, `~/.claude/remote/` not on a `noexec` mount, and about 1 GB of disk. Desktop
  installs Claude Code on first connect; if the container has no internet, Desktop uploads it.
- **Claude sign-in.** Desktop renews the user's Claude sign-in on the remote while it is connected.
  This is the user's own credential in the user's own container, not a Work Hub secret.
- **Client prerequisites.** Desktop ≥ v2.110.0 for the link. On Windows, Desktop ≥ v2.2553.0 and
  OpenSSH ≥ 9.4 (Windows 11 24H2 ships 9.5; Windows 10 ships 8.1).
- **Org hardening (optional, admin-side).** The Desktop enterprise keys `disableDesktopLocalSessions`,
  `sshHostAllowlist` and `sshConfigs` (managed connections users cannot delete) stop a user from
  falling back to a Local session.
- **Inference still goes to Anthropic.** The conversation reaches `api.anthropic.com` in every
  option. Constraint 2 covers execution, not inference.

## Not documented — verify in a PoC first

- How Desktop carries the Claude sign-in to the remote, and what it writes under `~/.claude/remote/`.
- Whether Desktop's "remember SSH password" works on Windows and macOS for a host opened from a
  `claude://` link.
- Whether Desktop accepts a password-only (keyboard-interactive) server with no key.
