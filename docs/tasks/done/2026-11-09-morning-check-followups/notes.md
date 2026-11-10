# Notes: 2026-11-09 Morning Check Follow-Ups

## 2026-11-09: Evidence moved from requirements.md

### Item 1: security-scans run 42470567545 root cause

From `gh run view 42470567545 --log`: github.com release downloads returned HTTP 504 at
10:14–10:15 UTC (`curl: (22) The requested URL returned error: 504`) in both the actionlint
(`security-scans.yml:727`) and hadolint (`:932`) install steps, and the same 504 failed the
`snyk-oss` job (`:191`). The hadolint "no output" row came from the failed install. The previous five
runs were green.

### Item 3: background MCP call, PoC `docs/pocs/2026-11-09-1236-cc-bg-mcp-deny-policy/`

A real CC 2.1.319 session was captured in `fixtures/bg-mcp.transcript.jsonl` (sanitized). Timings are
from the `tool_use`:

- 0 ms: an assistant `tool_use` (`toolu_…`).
- +2.2 s: a `tool_result` for that `tool_use_id`, without `is_error`. It is a hand-off
  acknowledgement, "…moved to the background as task `<task-id>`…". `toolUseResult` holds the same
  text, with no task id field, duration or status.
- +10.1 s: a user entry whose string content is
  `<task-notification><task-id>…</task-id><status>completed</status>…<result>…</result>`, with
  `origin.kind: "task-notification"`. It has no `<tool-use-id>`. The only link back to the call is
  the task id in the acknowledgement text.
- Hooks: `PostToolUse` fires at the acknowledgement (`duration_ms` ≈ hand-off time). Nothing fires for
  the late result.

`pairing-demo.cjs` runs the fixture through Log Hub's pairing. It shows status `ok` (a failed task
would also show `ok`), a duration of 2228 ms instead of ~10.1 s, and the placeholder sentence as the
result.

### Item 6: hook on Node 18/20, PoC `docs/pocs/2026-11-09-1236-hook-node18-compat/`

The current installer (1.0.95, hook 2.31.1) installs, and all 17 hook commands run with exit 0, on
Node 18.19.1, 20.20.2 and 22.23.4 (21/21 checks each). A static scan finds no Node API newer than
18.19.
