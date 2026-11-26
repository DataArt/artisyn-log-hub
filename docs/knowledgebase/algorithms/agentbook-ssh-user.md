---
type: "Algorithm"
title: "AgentBook SSH user resolution"
description: "Decides which user Claude Desktop logs into a laptop as (the devcontainer's remoteUser, else containerUser, else a tool-created claude user), its home folder that the laptop volume covers, and whether sshd allows root login."
tags: [algorithm, agentbook]
generated: { by: "claude-code", at: "2026-11-25T23:30:00+04:00" }
reviewed: no
reviewer: none
---

# AgentBook SSH user resolution

## Purpose

Claude should work as the user the project's devcontainer expects, never as root by accident, and the
laptop volume must cover that user's home (FR-4, AC-7a).

## Code

- Implementation: `agentbook/crates/core/src/ssh_user.rs` (`resolve`, `SshUser`; constant `TOOL_USER`).
  The inputs come from the merged config of `devcontainer read-configuration`.
- Twins: the laptop layer's `install.sh` creates `claude` when asked and writes `PermitRootLogin`.
- Test: `agentbook/crates/core/tests/algo.rs` (`agentbook_ssh_user`).

## Input and output

`remoteUser`, `containerUser` (optional strings) → `{user, create, home, permitRootLogin}`. Some rows
also carry `imageUser` to show that the image's own default user is **not** an input.

## Rules

1. The first of `remoteUser`, `containerUser` that is set and not blank after trimming.
2. Its part before `:` (a `user:group` form); `0` means `root`.
3. Neither set: `TOOL_USER` = `claude`, created by the layer (`create` true), also when the image runs
   as root and also when the image has its own non-root user.
4. Home: `/root` for root, else `/home/<user>`.
5. `PermitRootLogin`: `prohibit-password` (key only) when the user is root, else `no`.

## Edge cases

- Priority: SU-01, SU-02, blank SU-06.
- Explicit root versus an unset user on a root image: SU-04 versus SU-03; containerUser root SU-05;
  uid 0 SU-08.
- `user:group`: SU-07.
- Image user ignored: SU-03, SU-09; nothing set SU-10.

## Examples

Rows (10): [`docs/algorithm-examples/agentbook-ssh-user.json`](../../algorithm-examples/agentbook-ssh-user.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- containerUser before remoteUser -> SU-01.
- Falling back to the image user -> SU-03, SU-09.
- Blank remoteUser taken as set -> SU-06.
- `PermitRootLogin yes` or `no` for root -> SU-04.
- Home `/home/root` -> SU-04.

## Where the result is visible

`whoami` in a Claude Desktop session; the owner of `~/.claude` in the laptop volume.
