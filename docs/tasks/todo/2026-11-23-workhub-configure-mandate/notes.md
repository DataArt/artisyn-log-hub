---
type: "Note"
title: "Work Hub Configure Mandate: Evidence and Owner Notes"
description: "Motivating configure session write-up, follow-up confirmation in a new workstream and owner scope notes for 2026-11-23-workhub-configure-mandate"
---

# Notes: Work Hub Configure Mandate

## 2026-11-23 (moved from requirements.md)

### Motivating configure session

In a real Configure session the user asked the agent to make Playwright work in the workspace:

- The agent installed Playwright globally and Chromium with system deps into `/opt/ms-playwright`
  (fine — that lands in the container and is kept by the checkpoint).
- It tried to persist `PLAYWRIGHT_BROWSERS_PATH` / `NODE_PATH` into `/etc/profile.d` and
  `~/.bashrc`; those writes were denied by a permission prompt.
- It refused to edit `.devcontainer/devcontainer.json` (`containerEnv` + `postCreateCommand`)
  because the configure system prompt says *"Do not change the project files in /workspace/repo"*
  (`CONFIGURE_PROMPT`, `work-hub/server/src/agent/claude.rs:8`), and asked the user for permission
  for each step — the user had to answer "меняй devcontainers".
- It also changed `~/.claude/settings.json` (user-level agent settings) on its own.
- After the user said "меняй devcontainers" it added `containerEnv` and a `postCreateCommand`
  (global Playwright + Chromium with deps, ~20 min) to `.devcontainer/devcontainer.json`, but did
  **not** verify it ("I did not run the container build, so the new config is not checked") and
  ended with "The change is not committed yet. Do you need a commit?" — the user had to answer
  "ну а ты сам как думаешь?".
- Asked "will it rebuild if I start a workstream?", the agent answered "I don't know exactly … I
  can't see what your platform does with this file" and offered to add a `postStartCommand` —
  a key Work Hub ignores. Actual behaviour (code, `workspaces/mod.rs`): the workstream starts from
  the checkpoint, so Playwright installed during configure is already there after Finish, and the
  edited `devcontainer.json` is not re-applied while a checkpoint exists.

### Confirmation in a new workstream

Confirmed in a new workstream (`test-pw`) after the configure session above: `playwright` 1.65.1
is in `/usr/local/bin` and Chromium in `/opt/ms-playwright` (carried by the checkpoint), but
`PLAYWRIGHT_BROWSERS_PATH` / `NODE_PATH` from the edited `containerEnv` are not set in the agent's
shell, so Playwright looks in `~/.cache/ms-playwright` and fails with "Executable doesn't exist"
until the variable is set by hand. The workstream agent also guessed ("probably the container was
not recreated…") and offered "Rebuild Container" — an action Work Hub does not have. Motivates
FR-11 and FR-12.

### Owner scope notes

**Owner, scope added to this task:** "у меня 0 открытых стримов а места дофига
занято … если воркстрим не живой сейчас то места не занимает. не надо хранить контейнер - это
очень дорого - закрыл - все - осталось только что закомитили. это чуть меняет требования но надо
менять". Admin Resource overview for workspace `research` at that moment: workstreams 1 / 4,
files 265 MB, containers 1.1 GB, volumes 0 B, images 1.6 GB, total 3.0 GB. → FR-13…FR-17.

**Owner:** "давай вообще повторное открытие уберем - тайм машина дорогое
удовольствие и не факт что нужное. вот закрыли - все ушло. можно разве историю названий и дат
хранить" → FR-15: no reopen, only a history record of names and dates.
