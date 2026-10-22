# 2026-10-22: Claude-Docker Full-Screen Menu Kills the JetBrains Terminal

**Status:** todo
**Priority:**
**Type:** bug
**Module(s):** dev tooling (scripts/claude-docker)
**Owner:** denis.tsyplakov
**Created:** 2026-10-22

## Description

Investigate why the claude-docker full-screen menu (Node `process.stdin.setRawMode`) kills the
whole WebStorm/JetBrains terminal on Windows after a real key press when raw mode is switched off /
the process exits, while the line menu, `docker exec -it` and Claude Code (Bun native) work in the
same terminal. Build a minimal repro (raw mode, Enter, exit), confirm in WebStorm terminal vs
conhost vs Windows Terminal, find the root cause (Node/libuv console read cancellation vs
pty4j/ConPTY), then either fix the full-screen menu so it works in JetBrains terminals (and drop the
line-menu fallback) or file a bug upstream (JetBrains / Node) with the repro.

**What is known so far** (from the 2026-10-22 debugging, see
`docs/tasks/done/2026-10-15-claude-dev-container/notes.md` and KB
`docs/knowledgebase/docker-dev-container.md` → Menu):

- In the WebStorm terminal (Windows PowerShell 5.1) the full-screen menu read Enter in raw mode,
  then turned raw mode off (`detach()`: `setRawMode(false)`, `stdin.pause()`, leave the alternate
  screen). Shortly after, the whole terminal tab closed. The launcher then hit `EPIPE` writing to
  stdout (logged to `tmp/claude-docker/launcher-errors.log`).
- With the menu ending right after the key (no child processes in the menu's process), the tab
  still closed: the wrapper `.ps1` never got to read the next-command file.
- A line menu (readline `terminal: false`, no raw mode) works in the same terminal; so do
  `claude-docker.ps1 <name>` (no raw mode), `docker exec -it` and Claude Code.
- Not reproduced in conhost or Windows Terminal with the same sequence **without** a real key
  press; injecting a key with `WriteConsoleInputW` from a sibling process did not reach Node.
- Current workaround: `useSimpleMenu()` in `scripts/claude-docker/menu.mjs` picks the line menu
  when `TERMINAL_EMULATOR=JetBrains-JediTerm` (`CLAUDE_DOCKER_MENU=simple|full` forces either);
  the `--prune` `y/N` prompt uses `terminal: false` too.

## Functional Requirements

- FR-1: A minimal standalone repro script (raw mode on, wait for Enter, raw mode off / exit; no
  claude-docker code) exists in the task folder.
- FR-2: The repro is run by hand in the WebStorm terminal, conhost and Windows Terminal, each with
  Windows PowerShell 5.1 and pwsh 7, and the results are recorded.
- FR-3: The variants that isolate the trigger are recorded: Enter vs another key; `setRawMode(false)`
  vs exit without it; with/without `stdin.pause()`; with/without the alternate screen; Node vs Bun
  running the same script.
- FR-4: The root cause is identified (or narrowed down as far as the repros allow) and written down.
- FR-5: Either the full-screen menu is fixed so it works in JetBrains terminals and the line-menu
  fallback (and its auto-detection) is removed, or a bug is filed upstream (JetBrains and/or Node)
  with the repro and the fallback stays, documented with the upstream link.

## Acceptance Criteria

- [ ] The repro script and its result table (terminal × shell × variant → terminal survives / dies)
      are in the task folder.
- [ ] The trigger is stated as a single condition that the repro confirms (e.g. "raw mode turned
      off after a key press in pty4j").
- [ ] Fix path: `claude-docker.ps1` with no arguments in the WebStorm terminal opens the
      full-screen menu, Enter opens a Claude session and the terminal stays open; `useSimpleMenu`
      no longer auto-selects for JetBrains, and the KB Menu section is updated.
- [ ] Or upstream path: an issue URL is recorded in `notes.md` and in the KB Menu section next to
      the fallback explanation.

## Notes

<!-- Append timestamped notes here as work progresses -->

**2026-10-22 — full-screen menu works in WebStorm (user-confirmed).** On Windows the menu no longer
uses Node's raw mode at all: `scripts/claude-docker/keys.mjs` reads keys in a PowerShell child with
`[Console]::ReadKey($true)` and pipes them to the menu, so nothing changes the console mode. The
JetBrains auto-switch to the line menu was removed (`CLAUDE_DOCKER_MENU=simple` still forces it).
What remains of this task is optional: the root cause inside Node/libuv vs pty4j (FR-1…FR-4) and an
upstream report; FR-5's "fix" branch is done by avoiding raw mode rather than repairing it.
