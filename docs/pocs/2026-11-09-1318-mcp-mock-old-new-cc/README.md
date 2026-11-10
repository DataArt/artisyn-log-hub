# PoC: mock MCP server driven by `claude -p` on old and new Claude Code

Task: [2026-11-09 Morning Check Follow-Ups](../../tasks/todo/2026-11-09-morning-check-followups/requirements.md),
item 3 (background MCP calls) and the plan's compatibility rule: Log Hub must handle MCP calls
from both old and new Claude Code. Follows up
[`2026-11-09-1236-cc-bg-mcp-deny-policy`](../2026-11-09-1236-cc-bg-mcp-deny-policy/), which
captured one background call on 2.1.319.

## Questions

1. How do we test the background-MCP fix on real transcripts? We need fast and slow tools, a
   success and a failure of each, and runs on both an old and a new Claude Code.
2. Which Claude Code version introduced the background hand-off? Is "old" really "before 2.1.319"?
3. Which transcript shapes does the planned join (impl-plan DD-2…DD-7) meet, and does it give
   the right result for each, without changing anything on old transcripts?

## Files

| File | What |
|---|---|
| `mock-mcp.cjs` | stdio MCP server without an SDK. Tools: `fast_echo` (at once), `fast_fail` (at once, `isError`), `slow_echo` and `slow_fail` (after `MOCK_SLOW_MS`, default 8000). It has no MCP `tasks` capability: backgrounding comes only from the client's auto-background threshold. Traffic is logged to `raw/mcp-traffic.log` |
| `mcp.json`, `claude-config/settings.json` | `--mcp-config` (server `mock`) and `--settings`, which allows the four tools |
| `cc/old/`, `cc/new/` | Claude Code **2.1.211** (the last version without the hand-off) and **2.1.319**, each installed in its own folder (`node_modules/` is ignored) |
| `run.cjs` | runs one headless haiku session that calls the four tools in order and copies the transcript to `raw/`. Modes: `full` keeps the session alive 45 s so notifications arrive; `cut` uses 60 s tools, snapshots the live transcript at 15 s (`<ver>-live`), then kills the process (`<ver>-kill`) |
| `check.cjs` | applies today's pairing and the planned join to each capture and checks the expectations (PASS/FAIL, exit 1 on a failure) |
| `bisect.cjs` | binary search over the published `@anthropic-ai/claude-code-win32-x64` versions for the first binary that contains `moved to the background as task` |
| `sanitize.cjs` | `raw/` → `fixtures/`: drops ids, paths, e-mail and thinking |
| `fixtures/*.transcript.jsonl` | the six sanitized captures (table below) |

## How to run

From this folder; `<scratch-*>` are existing empty folders outside the repo. Each session costs
about $0.01 (haiku).

```sh
(cd cc/old && npm install) && (cd cc/new && npm install)
node run.cjs old full <scratch-1>      # -> raw/old-full
node run.cjs new full <scratch-2>      # -> raw/new-full
node run.cjs new cut  <scratch-3>      # -> raw/new-live, raw/new-kill
node sanitize.cjs
node check.cjs                         # checks fixtures/ (or: node check.cjs raw)
node bisect.cjs                        # optional: re-find the first version with the hand-off
```

`run.cjs` sets `CLAUDE_AUTO_BACKGROUND_TASKS=1` and `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=2000`, so
a headless run backgrounds any MCP call that runs longer than 2 s. Two more captures came from
earlier runs of the same script:
- `mid-full`: `full` on 2.1.318;
- `new-close`: a `cut` variant on 2.1.319 that ended stdin at once instead of holding it.

## Result

**Q2: the hand-off is older than 2.1.319.**
- `node bisect.cjs`: the first binary with the hand-off text is **2.1.212**; 2.1.211 does not have it.
- 2.1.318 backgrounds MCP calls exactly as 2.1.319 does (`mid-full`).
- So "old Claude Code" for this fix means **< 2.1.212**, and the plan/KB must not say "since 2.1.319". 2.1.319 only changed the defaults (terminal auto-background after 120 s, task-capable servers).
- Version gating would be wrong in both directions. The join must stay shape-based (DD-1).

**Q3: the shapes met, and the planned join on each** (`node check.cjs`: all checks passed).

| Capture | CC | What happens | Today | Planned join |
|---|---|---|---|---|
| `old-full` | 2.1.211 | no hand-off; slow calls block ~8 s | correct (`slow_echo` success 8004 ms, `slow_fail` failure) | no ack match, so identical to today |
| `mid-full` | 2.1.318 | hand-off at 2 s; user-line notifications `completed` / `failed` | `success` at 2008 ms with the ack text, for **both** slow calls | `slow_echo` success 8071 ms `"slow_echo: c"`; `slow_fail` **failure** 8110 ms |
| `new-full` | 2.1.319 | same as `mid-full` | same error | same fix (8079 ms / 10006 ms) |
| `new-live` | 2.1.319 | live snapshot, tasks still running: **no notification** | `success` 2011 ms | `unresolved` → "background, no result" |
| `new-kill` | 2.1.319 | process hard-killed: **no notification** is ever written | `success` | `unresolved` |
| `new-close` | 2.1.319 | plain `-p` ends its turn, closes the MCP connection, and both tasks fail. The notification appears **only as a `queue-operation` enqueue**, with no user line: `<status>failed</status>`, `<result>Task failed: Connection closed</result>` | `success` | **failure** 10299 ms (from the enqueue) |

The fast calls and pre-hand-off failures are never touched: no ack, so planned == today in
every capture. The ack text is identical in 2.1.318 and 2.1.319:

```
MCP tool "mock/slow_echo" is still running after 2s. It was moved to the background as task kkumm8n15 and keeps running; you'll receive a notification with the result when it completes. … TaskStop with task_id "kkumm8n15". …
```

**Findings that change the plan:**

1. **Version.** The hand-off exists since 2.1.212, not 2.1.319. The KB and plan wording must change. The old-CC regression fixture is 2.1.211.
2. **The enqueue fallback is required, not optional.** In `new-close` the enqueue is the only notification.
3. **Failed tasks carry `<status>failed</status>`.** `<result>` is prefixed with `Task failed: ` (the tool's error, or `Connection closed`). The plan's "any status but `completed` → failure" is right, and the shown result keeps the prefix.
4. **"Background, no result" is real.** It occurs for live sessions (a mid-session upload) and for hard-killed sessions.
5. **Old CC can fail the first MCP call with "No such tool available".** That happens when the call races the server connect (2.1.211, `old-full`). It is `is_error: true` with no hand-off, so the join leaves it alone.

**Q1: how to test.**
- **Now:** the sanitized fixtures are the input for the plan's scenario step (S-SESS-03). It uploads `old-full`, `new-full`, `new-live` and `new-close` and checks the Logs modal, so every shape above is covered without a live Claude run in CI.
- **When Claude Code changes the wording or shape:** re-run `run.cjs` on the new version, then `check.cjs`. A FAIL there means the server/client join must follow.
- A live `claude -p` run is not part of the automated suites: it costs credits, needs a login and is slow. The manual pre-prod `big-prod-e2e-test` skill already runs real `claude -p` sessions with MCP and is the place for a live check.
