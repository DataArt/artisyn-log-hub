---
type: "Task"
title: "Work Hub as an Isolated Environment for an External Claude Code Agent"
description: "Let Claude Code in Claude Desktop (agent running outside) connect to a local or remote Work Hub workstream container and use it as a safe sandbox for commands and file edits."
---

# 2026-11-25-wh-isolated-agent-env: Work Hub as an Isolated Environment for an External Claude Code Agent

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** work-hub
**Owner:** denis.tsyplakov
**Created:** 2026-11-25
**Tracker:** GH-178 https://github.com/DataArt/artisyn-log-hub/issues/178

## Description

Raw idea (verbatim, Russian):

> нужен изолированный режим рабты так чтобы к WH развернутому локально (или не локально) как-то мог
> подключаться claude desktop code
> т.е. агень крутится в нем, а WH/контейнер с окружением используется как безопасная среда

In English: a new isolated working mode is needed. Claude Code running in Claude Desktop (the
"Code" part of the desktop app) should be able to connect to a Work Hub instance — deployed locally
or on another machine — and use it as its working environment. The agent loop itself runs in Claude
Desktop; Work Hub and its container with the prepared environment serve as the safe place where the
agent's commands run and files change.

Today the agent runs *inside* the Work Hub workstream container (see
`docs/knowledgebase/work-hub.md`). This task adds the opposite arrangement: agent outside, execution
inside the container.

## Functional Requirements

- FR-1: Claude Code in Claude Desktop can attach to a Work Hub workstream (or workspace) container
  and run its tools there — shell commands, file reads and edits happen inside the container, not
  on the user's machine.
- FR-2: It works both for a Work Hub running on the user's own machine and for one running on
  another host reachable over the network.
- FR-3: The container keeps its isolation: the attached agent sees only that container's
  filesystem and processes, not the Work Hub host or other users' workspaces.
- FR-4: Access is authenticated and scoped to the Work Hub user who owns the workspace; an attach
  for one container cannot be used to reach another.
- FR-5: Work Hub shows how to connect (what to configure in Claude Desktop) for a given
  workstream, and which containers currently have an external agent attached.
- FR-6: The container is the same environment workstreams already use (checkpoint image,
  configured tools, git proxy remotes), so the external agent gets the prepared toolchain.

## Non-Functional Requirements

- Security: no secrets of the Work Hub host or of other users leak into the attached session; the
  existing rule "secrets never go into containers" still holds.
- Offline first: the connection setup is documented inside the product, not only online.

## Acceptance Criteria

- [ ] AC-1 (FR-1): from Claude Desktop, an agent asked to create a file and run a command in the
      attached workstream produces the file and the command output inside the container; nothing
      appears on the user's local disk.
- [ ] AC-2 (FR-2): the same flow works against a Work Hub on `localhost` and against one on a
      remote host.
- [ ] AC-3 (FR-3): from the attached session, the host filesystem and other workspace containers
      are not reachable.
- [ ] AC-4 (FR-4): a connection without valid credentials, or with credentials of another user, is
      refused.
- [ ] AC-5 (FR-5): the workstream page shows the connection instructions and an "external agent
      attached" indicator while a session is connected.
- [ ] AC-6 (FR-6): a tool installed through Configure (checkpoint) is available to the external
      agent.

## Open Questions

- Connection mechanism: what Claude Desktop's Code mode can actually attach to — SSH remote
  environment, an MCP server exposing exec/file tools, a dev container / remote environment
  feature, or something else? This decides most of the design.
- Does the attach target a workstream container only, or also the workspace container (e.g. during
  Configure)?
- Is the in-container agent (current mode) still started for a workstream with an external agent
  attached, or are the two modes exclusive per workstream?
- Remote Work Hub: how is the endpoint exposed (Work Hub's own port, a separate SSH gateway, a
  tunnel)? TLS / auth model?
- Should Work Hub capture the external agent's activity (session logs, diffs) the way it does for
  its own agent sessions?

## Notes

<!-- Append timestamped notes here as work progresses -->
