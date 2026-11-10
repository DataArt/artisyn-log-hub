# PoC: background MCP calls and `denyInsteadOfPrompting` in Claude Code 2.1.319

Task: [2026-11-09 Morning Check Follow-Ups](../../tasks/todo/2026-11-09-morning-check-followups/requirements.md),
items 3 and 4 (and the Open Questions about installing 2.1.319 and what counts as the real result).

## Questions

- **Q3 (item 3).** Since CC 2.1.319 MCP tool calls can run as background tasks. What do the
  `tool_use`, the immediate `tool_result` and the late result look like in the transcript, what
  links them, and does Log Hub show the right result / status / duration today?
- **Q4 (item 4).** With `permissions.denyInsteadOfPrompting: true`, which hooks fire for a call
  that would have prompted, what does OTEL `claude_code.tool_decision` carry (`decision`,
  `source`), and how does the denial look in the transcript?

## How it was run

Claude Code 2.1.319 is installed locally in this folder (`npm install`, `node_modules/` is
ignored); the global install and `~/.claude` settings were not touched. Sessions ran with the cwd
in a scratch folder outside the repo, `--setting-sources project` (that folder has no project
settings, so no user-level hooks, plugins or OTEL env applied) and only
`--settings claude-config/settings.json`. Model `haiku`, `--max-budget-usd 0.5`; five sessions,
about $0.01 in total.

Files:

| File | What |
|---|---|
| `mcp-server.cjs` | stdio MCP server without an SDK, tool `slow_echo` (sleeps `SLOW_ECHO_MS`, default 8000). It advertises the MCP `tasks` capability and `execution.taskSupport: "optional"`, and logs all JSON-RPC traffic to `raw/mcp-traffic.log` |
| `mcp.json` | `--mcp-config` for server `poc` (`${POC_DIR}` is expanded by CC) |
| `claude-config/settings.json` | `permissions.denyInsteadOfPrompting: true`, allow `mcp__poc__slow_echo`, and a `hook-log.cjs` command hook for 21 hook events |
| `hook-log.cjs` | hook that appends each stdin payload to `raw/hooks.jsonl` |
| `otlp-receiver.cjs` | OTLP/HTTP-JSON receiver on 127.0.0.1:4399 that writes to `raw/otlp.jsonl`. It is needed because CC drops the `console` exporter under `--output-format stream-json` (`hasFormattedOutput`) |
| `run-session.cjs` | runs one headless session and writes stdout/stderr to `raw/` (`POC_STDIN_HOLD_MS` keeps a stream-json stdin open so a late task notification can start a second turn) |
| `sanitize.cjs` | turns `raw/` into `fixtures/`: drops ids, paths, e-mail, attachments, API snapshots and thinking |
| `otlp-tool-events.cjs` | prints the tool-related OTEL log records without identity attributes |
| `pairing-demo.cjs` | runs the fixture through Log Hub's current pairing, then through the proposed join |
| `fixtures/` | sanitized captures: transcript, hooks and stream-json for `bg-mcp.*` and `deny-policy.*`, plus OTEL tool events |

Commands (from this folder; `<scratch>` is any empty folder outside the repo):

```sh
npm install
node otlp-receiver.cjs 4399            # in a second terminal (Q4 only)
# Q3: background MCP call (headless needs the two env vars, see Result)
POC_STDIN_HOLD_MS=30000 CLAUDE_AUTO_BACKGROUND_TASKS=1 CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=2000 SLOW_ECHO_MS=10000 \
  node run-session.cjs s3-bg-mcp <scratch> "Call the slow_echo tool with text hi. If it is moved to the background, just say 'waiting' and end your turn; when the completion notification arrives, tell me exactly what it returned." --allowedTools mcp__poc__slow_echo
# Q4: a Bash call that needs approval, under denyInsteadOfPrompting
node run-session.cjs s5-deny <scratch> "Use the Bash tool to run exactly this command: node -e \"require('fs').writeFileSync('poc-out.txt','1')\" . If the call is denied, do not retry and do not use any other tool; just quote the denial message you received verbatim."
# copy ~/.claude/projects/<encoded scratch>/<session>.jsonl to raw/s3|s5/transcript.jsonl, move the raw files to raw/s3|s5, then:
node sanitize.cjs
node pairing-demo.cjs
```

Sessions: s1 had no env vars, ran synchronously, and did not go to the background. In s2 the call
went to the background, but `-p` exited and the task was stopped. s3 is the complete
background flow. In s4, `node -v` was auto-allowed as read-only, so it is not a denial. s5 is the
denial.

## Result

### Q3: background MCP call

**What controls it.** Two mechanisms produce the same `mcp_task`:

1. A real MCP-protocol task. The server returns a task id for `tools/call`, and the call goes to
   the background at once. CC 2.1.319 uses the new SEP-2663 task protocol for this. It did not
   send `params.task` to this PoC's server, which speaks the older 2025-11-25 tasks shape, so this
   path was not captured.
2. Auto-backgrounding of any MCP call that runs longer than `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`.
   This works for every MCP server and is what was captured.

From the 2.1.319 binary: the default threshold is 120000 ms when the `tengu_mcp_auto_background`
flag is on. For a non-interactive (`-p`) session it is 0 (off) unless
`CLAUDE_AUTO_BACKGROUND_TASKS` is set. `CLAUDE_CODE_DISABLE_MCP_TASKS=1` and
`CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND` switch it off.

So in the terminal a plain MCP call longer than 2 min moves to the background, and a task-capable
server's call moves at once. In headless runs neither happens unless
`CLAUDE_AUTO_BACKGROUND_TASKS` is set.

**Transcript shape** (`fixtures/bg-mcp.transcript.jsonl`; times are relative to the `tool_use`):

| t | Entry | Content |
|---|---|---|
| 0 ms | `assistant` | `tool_use {id: toolu_01Tn…, name: "mcp__poc__slow_echo", input: {text: "hi"}}`, the same as a normal call |
| +2228 ms | `user` | `tool_result {tool_use_id: toolu_01Tn…}`, **no `is_error`**. The text is the ack: `MCP tool "poc/slow_echo" is still running after 2s. It was moved to the background as task kce4n8y9u and keeps running; you'll receive a notification…`. `toolUseResult` is just the same content-block array. It has **no `taskId`, `durationMs` or status field**. `permissionDecision: {decision: accept, source: config, reasonType: rule, ruleSource: flagSettings}` |
| +10092 ms | `queue-operation` | `enqueue`, content = the `<task-notification>` XML |
| +10144 ms | `user` | `message.content` is a **string**: `<task-notification><task-id>kce4n8y9u</task-id><status>completed</status><summary>MCP task kce4n8y9u (poc/slow_echo) completed.</summary><result>slow_echo says: hi (after 10000 ms)</result></task-notification>`, with `origin: {kind: "task-notification", producer: "session-task", runId: "0mw90ih7a-…"}`, `promptSource: "system"` and `turnOrigin: "task_notification"`. A new assistant turn follows |

**What links them.** In the transcript, the only link is the task id: it appears as free text
in the ack (`moved to the background as task <id>`) and as `<task-id>` in the notification.
**The notification has no `<tool-use-id>`**, unlike async-agent / Workflow notifications. The
transcript does not record `runId` against the call either.

The stream-json output (`fixtures/bg-mcp.stream.jsonl`) does carry the link explicitly:
`system/task_started {task_id, run_id, tool_use_id, task_type: "mcp_task"}` and
`system/task_notification {task_id, tool_use_id, status}`. These are not written to the
transcript JSONL.

**Hooks** (`fixtures/bg-mcp.hooks.jsonl`):

- `PreToolUse` fires, then `PostToolUse` at the ack (+2.15 s) with `duration_ms: 2004` and the
  ack text as `tool_response`.
- No PostToolUse, TaskCreated or TaskCompleted fires for the late result.
- The notification fires `UserPromptSubmit`, and its `prompt` is the notification XML.
- `Stop.background_tasks` lists `{id, type: "MCP task", status: "running", server, tool}`.

In s2, where `-p` exited before the task finished, the stream reported `status: "stopped"` and
the transcript has no notification.

**Log Hub verdict: not correct today.** `node pairing-demo.cjs` on the fixture:

```
== current pairing (as Log Hub does it today)
mcp__poc__slow_echo toolu_01TnFdE57EPa5KWvHoKTyKFK
  status=ok duration=2228 ms (timestampDelta)
  agent-saw="MCP tool "poc/slow_echo" is still running after 2s. It was moved to the background as task..."
== workflow-extractor join: notifications with <tool-use-id>: 0 of 1
== proposed join (ack text task id -> <task-id>)
toolu_01TnFdE57EPa5KWvHoKTyKFK: task=kce4n8y9u status=completed -> ok
  duration=10144 ms (tool_use -> notification; ack after 2228 ms)
  real result="slow_echo says: hi (after 10000 ms)"
```

Why each part of Log Hub gets it wrong:

- **Pairing.** The `tool_use_id → tool_result` pairing (`claude-extractor.ts`, first result per
  id wins; `tool-monitoring/mcp-call-extractor.ts`; client `log-parser.ts` around line 1792)
  picks the ack.
- **Status.** `classifyToolOutcome` → `transcriptCallStatus` gives `ok`, because the ack has no
  `is_error`. A failed or stopped background task would still show as ok.
- **Duration.** `resolveToolDuration` falls through to `timestampDelta` and gives the
  hand-off time. That is the auto-background threshold, about 2 s here and 120 s by default.
  A hook-supplied `duration_ms` would be 2004, also only the hand-off.
- **Output.** The MCP call output / agent-saw text is the placeholder sentence. The real result
  is only in the notification.
- **Prompts and turns.** `turn-walk.ts:117` and `claude-extractor.ts:151` correctly treat the
  notification as a non-prompt, and the client keeps it inside the turn. Nothing is broken
  there, but nothing joins it either.
- **Async-agent join.** The join in `workflow-extractor.ts` (`parseTaskNotification`, around
  line 60, which returns null without `<tool-use-id>`; the enqueue map is keyed by
  `toolUseId`) **cannot be reused as is**.

**Minimal fix:** a background-MCP join step next to the MCP call extraction, with a client twin:

- **Detect.** An `mcp__*` tool_result whose text matches
  `/moved to the background as task ([A-Za-z0-9_-]+)/` is a background call.
- **Join.** Match the captured id to `<task-id>` of a later `<task-notification>`. Read it from
  the string-content user entry with `origin.kind === "task-notification"`, or from the
  `queue-operation` enqueue, the same source the Workflow join reads.
- **Result.** If the join succeeds:
  - result text = `<result>`;
  - status from `<status>`: `completed` → ok, `failed`/`killed`/`stopped` → error;
  - duration = notification timestamp − `tool_use` timestamp, as a new duration source such as
    `backgroundTask`.
- **No notification** (session ended first): show "background, no result". Do not show ok.

Parsing `<task-id>` can be shared with the Workflow parser by making `<tool-use-id>` optional
there. The ack wording is CC's free text, so keep the regex in one place and have an algorithm
row cover it. A more robust key would need the stream-json `task_started` event, which Log Hub
does not ingest.

### Q4: `denyInsteadOfPrompting`

The key is exactly `permissions.denyInsteadOfPrompting: true`. The schema description in the
2.1.319 binary reads: "Never wait for a person to answer a tool permission prompt: a call that
would prompt is denied at once, the model is told, and the turn carries on… Allow rules, the
permission mode, auto mode's classifier and PermissionRequest hooks decide first".

After 3 refusals in a row it also ends the turn (`refused_streak_stop`).

**Hooks fired for the denied call** (`fixtures/deny-policy.hooks.jsonl`):

- **Fired:** `PreToolUse`, `PermissionRequest` and `PostToolBatch`, then `Stop`.
  - `PermissionRequest` carries `{tool_name, tool_input, permission_suggestions}` and **no
    `tool_use_id`**. That matches the comment in `lifecycle-hook.js:146-149`.
  - `PostToolBatch.tool_calls[]` carries `{tool_name, tool_input, tool_use_id, tool_response}`,
    where `tool_response` is the denial text.
- **Not fired:** `PermissionDenied`, `PostToolUseFailure` and `PostToolUse`. This confirms
  `lifecycle-hook.js:152-153` ("PermissionDenied fires only for auto-mode classifier denials").

So the hook records a PermissionRequest with no resolution, and no hook says "denied". The only
hook trace of the outcome is the `PostToolBatch` payload, which the Log Hub hook does not record
today.

**OTEL `claude_code.tool_decision`** (`fixtures/deny-policy.otel-tool-events.txt`):
`decision: "reject"`, `source: "config"`, `tool_name: "Bash"`, `tool_use_id`, `tool_parameters`,
`permission_mode: "default"`, `request_id`. No `claude_code.tool_result` event is emitted for
the denied call.

`source: "config"` is the same value as a deny rule, and as the auto-allow of `node -v`
(`fixtures/auto-allow.otel-tool-events.txt`: `accept` / `config`). On the OTEL side,
"denied (policy)" is therefore indistinguishable from a configured deny rule.

**Transcript** (`fixtures/deny-policy.transcript.jsonl`). The `tool_result` has
`is_error: true`, and the content starts "Permission for this tool use was denied. It requires
approval, and this session has no approval surface…". The entry carries these top-level fields:

- `toolDenialKind: "permission-rule"`;
- `permissionDecision: {decision: "reject", source: "config", reasonType: "asyncAgent", reasonCode: "bashMiss:no-rule-match"}`;
- `toolUseResult: "Error: Permission for this tool use was denied…"`.

The stream-json output also has `system/permission_denied {decision_reason_type: "asyncAgent",
decision_reason: "no approval surface in this session; permission request denied automatically"}`
and `result.permission_denials[]`.

Static reading of the binary: the reason string "no approval surface in this session" belongs to
the `deny_instead_of_prompting` code path. A plain headless run without the setting uses "nobody
can be asked in this headless run". The `reasonType` is `asyncAgent` in both cases. This was not
captured: there was no control session.

**Log Hub today.** The server already reads `toolDenialKind`. `classifyToolOutcome` maps
`permission-rule` → `unresolved`, so the call already counts as a denial and not as a failure.

What is missing is the "policy" label. It can come from the transcript
`permissionDecision.reasonType === "asyncAgent"`, with the reason text as a fallback, **without
any OTEL ingest or schema change**. OTEL `tool_decision` cannot tell it apart (`source: config`),
so it is not a good driver for that badge.
