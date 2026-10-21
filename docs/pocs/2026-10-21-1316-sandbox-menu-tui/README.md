# PoC: `claude-docker` interactive menu (UI only)

Task: [2026-10-15-claude-dev-container](../../tasks/todo/2026-10-15-claude-dev-container/requirements.md) — FR-W8.

## Question

How does the keyboard-driven, Claude-Code-style sandbox menu look and feel in a real terminal
(WebStorm's Terminal tool window in particular), and is a zero-dependency Node implementation good
enough, or does it need a TUI library?

## What it is

`menu.js` — a single CommonJS file, Node built-ins only (nothing to install). No Docker, no git: six
mock sandboxes cover every state (running with a session, stopped with/without work, stale > 7 days,
merged, touching files outside `docs/`). Actions change only the in-memory list, or leave the menu
and print the command the real launcher would run.

Keys: `↑↓` select · `Enter` continue (or create on "+ New sandbox") · `R` resume picker · `S` shell ·
`T` stop · `M` merge · `D` remove · `P` prune plan (`y` / `F` / `Esc`) · `Q`/`Esc`/`Ctrl+C` quit.

## Run

From this folder, in an interactive terminal (WebStorm: **Terminal** tool window):

```
node menu.js
```

The WebStorm **Run** console is not a TTY; the menu then prints a hint and exits with code 1
(or enable "Emulate terminal in output console" in the run configuration).

## Result

- Scripted smoke run (stubbed TTY, keys fed programmatically): list, merge refusal, prune plan,
  force-remove confirmation and the new-sandbox input all render and behave as specified; the
  non-TTY path prints the hint and exits 1.
- Visual check in the WebStorm Terminal tool window (2026-10-21): approved by the user as is.
- Conclusion: adopted for the plan — the launcher menu is built the same way (raw ANSI + readline
  keypress, Node built-ins only, no TUI library), with this layout and key map.
