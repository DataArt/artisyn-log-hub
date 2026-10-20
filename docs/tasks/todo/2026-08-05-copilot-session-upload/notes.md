# T-77: Copilot Session Upload — Notes

<!-- Investigation artifacts, experiment write-ups, and review changelogs go here. -->

## 2026-08-05 — Investigation: Copilot hook format

Reference hook implementation examined to confirm confirmed-hook-behaviour constraints:
a private reference implementation of a Copilot session-log hook
(`.github/copilot-hooks/session-log-hook.js`).

Findings captured in `requirements.md` §"Context: confirmed hook behaviour": `args` field is
silently ignored, full command must be a single string, payload is delivered via stdin in snake_case
format, `transcript_path` is a direct absolute path.
