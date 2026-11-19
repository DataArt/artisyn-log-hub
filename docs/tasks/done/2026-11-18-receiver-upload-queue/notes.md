# Notes: Shared Receiver as the Single Log Uploader

## 2026-11-18 — `hook.log` evidence (hook v2.32.3)

Source: `.artisyn/ai_work_dir/hook.log`.

- 4 of 20 `send-logs-hook.js` `SessionEnd` runs that day were killed mid-way:
  - `fb01a14f`, `c3d0f7bf`, `a4d37633` died while waiting for the upload lock behind another
    session's `Stop` full-scan upload;
  - `4b3815af` got the lock after 1302 ms (`session-end flush: upload lock taken`) and died before
    `session-end flush done` (normally ~100 ms later).
- `lifecycle-hook.js` `SessionEnd` ~110 ms and `SubagentStop` 3/3 recorded, both fine; only
  `send-logs-hook.js` `SessionEnd` is affected. Both hooks always exit 0 (`lifecycle-hook.js:272`,
  `send-logs-hook.js:1958`).

## 2026-11-18 — moved from requirements.md (PoC and review findings)

- PoC [`docs/pocs/2026-11-18-1712-sessionend-hook-timeout/`](../../../pocs/2026-11-18-1712-sessionend-hook-timeout/README.md):
  the `SessionEnd` budget is 1500 ms and a killed hook is reported as `failed: Hook cancelled`
  (Claude Code 2.1.311, also in `-p`). `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` raises it, but it
  is the user's env. A hook's `timeout` field raises it only for settings-file hooks, not for
  plugin hooks like Log Hub's, so the hand-off design stays. Claude also waits for `SessionEnd`
  before exiting, so a long hook blocks `/clear`.
- Review (FR-11): `post-turn-analysis-worker.js` calls the server
  (`/api/v2/post-turn-analysis/config`, `/api/v1/model-pricing`, `/api/v2/turn-end-cost-advisor`);
  the plan must check whether the advisor POST needs the session already uploaded.
