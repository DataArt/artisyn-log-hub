# Log Hub Hook for Claude Code

A Claude Code plugin that records what happens in a Claude Code session and uploads it to an
artisyn-log-hub server. Installation, configuration and the full list of settings are in
[INSTALL_HOOK.md](./INSTALL_HOOK.md); how each script works internally is in
[HOW_HOOK_WORKS.md](./HOW_HOOK_WORKS.md).

> **Disclaimer.** This project is not affiliated with or endorsed by Anthropic, Cursor or GitHub.
> "Claude" and "Claude Code" are trademarks of Anthropic.

## Hook events

The plugin wires these Claude Code hook events (`hooks/hooks.json`). Each script appends local
records to `<telemetryDir>/<session_id>.jsonl` (default `.artisyn/ai_work_dir/telemetry/`) or uploads
what has been collected.

| Claude Code event | Script | What it does |
|---|---|---|
| `UserPromptSubmit` | `telemetry-hook.js` | Writes a `prompt_start` record: the prompt text, git context (remote, repo root, branch, `user.name`) and configured `context` values. At most once a minute, starts a background upload (`prompt-upload-hook.js`) and re-arms the OTEL receiver. |
| `SessionStart` | `lifecycle-hook.js` | Writes a record with the git context (remote, repo root, branch, `user.name`); starts the loopback OTEL receiver when OTEL is enabled and checks that Claude Code's exporter points at it. |
| `PostToolUse` | `lifecycle-hook.js` | Writes the tool name, tool input, tool-use id, agent id/type and, for edit tools, added/removed line counts. The tool's output is not copied into this record. |
| `PostToolUseFailure` | `lifecycle-hook.js` | Writes the tool name, tool input, error text and (since `2.24.0`) tool-use id. |
| `PermissionRequest` | `lifecycle-hook.js` | Writes the tool name and tool input. |
| `PermissionDenied` | `lifecycle-hook.js` | Writes the tool name and tool input, plus (since `2.24.0`) the tool-use id and the denial reason. |
| `SubagentStart`, `SubagentStop` | `lifecycle-hook.js` | Writes the subagent id (and type on start). |
| `PreCompact`, `PostCompact` | `lifecycle-hook.js` | Writes a compaction record with the transcript path. |
| `PostToolBatch`, `StopFailure`, `SessionEnd` | `lifecycle-hook.js` | Writes a base record (event name, session id, timestamp). |
| `Stop` | `send-logs-hook.js` | Uploads the session's transcripts, local records, OTEL files and project context (see below) to the server. |
| `Stop` | `post-turn-analysis-hook.js` | Starts a detached worker that asks the server whether this turn should be analysed; if so, the worker calls a local `claude -p` and posts the result. |
| `SessionEnd` | `send-logs-hook.js` | Final upload of anything not yet sent. |

## What is collected

Installing the hook sends a lot of data to the server it is configured for. Read this before
installing it, and before asking anyone else to.

### Full transcripts

- The complete Claude Code transcripts of the project, **including earlier sessions** of the same
  repository that are still on disk when the hook is installed.
- That means every prompt, every tool input and tool result, the contents of every file Claude read,
  and the output of every command Claude ran. Anything secret that appeared in a session (keys in a
  `.env` file Claude read, tokens printed by a command) is uploaded with it.
- Transcripts are uploaded as they are; the hook does not redact them.

### Local context

- `CLAUDE.md` files, rules, skills, agents and the MCP server configuration of the project, plus
  user-level skills, plugins and MCP configs that apply to it.
- The git remote URL (with any `user:password@` part removed) and git `user.name`.
- Absolute paths, including the project root and the transcript paths, which usually contain your
  OS user name.
- `logTail`: the last 50 lines of the hook's own `hook.log`, sent with each upload run for diagnostics.

### Other channels

- **Post-turn analysis.** When the server asks for it, the hook runs a local `claude -p` (cost advisor
  and session attribution) using your Claude Code account and sends the result to the server.
- **OTEL export.** The installer adds an `env` block to `.claude/settings.local.json` (gitignored,
  per checkout) that turns on Claude
  Code's OpenTelemetry export to a loopback receiver, with `OTEL_LOG_TOOL_DETAILS=1` (tool names and
  parameters). The receiver writes the records to disk and the hook uploads them.
- **Code inventory.** The number of git-tracked files and lines (`trackedFiles`, `trackedLines`),
  used as the denominator for "share of the codebase touched".
- **Session attribution.** A short classification of what the session was about, produced by the
  post-turn analysis above.
- **MCP probe.** On each `Stop`, the hook starts each configured stdio MCP server briefly to list its
  tools, waiting at most `mcpProbeTimeoutMs` (default 3000 ms) per server.

### How to stop sending

- Remove `apiKey` or `serverUrl` from `.artisyn/config/log-hub.local.json` (and `serverUrl` from
  `.artisyn/config/log-hub.json`, if an older install put it there). With either one missing, the
  hook keeps recording locally but uploads nothing.
- Or uninstall the hook: `npx <server-origin>/static/artisyn-hooks-installer.tgz uninstall`
  (see [INSTALL_HOOK.md](./INSTALL_HOOK.md)). Delete `.artisyn/ai_work_dir/` too if you want the
  local records gone.

### Who operates the server, retention and your rights

- The data goes to whichever server `serverUrl` points at. Whoever runs that server (usually your
  employer or team) controls the data, decides how long it is kept and is responsible for it. This
  project does not run a hosted service and receives none of it.
- The server purges sessions older than its retention window (`SESSION_RETENTION_DAYS`, default
  30 days; the operator can change it). Users can delete their own account, which removes their
  data.
- If you are in the EU/EEA or another region with data-protection law, the operator is the party
  to ask for access, correction or deletion of your data.
- **Employers:** tell employees before you install the hook in their projects, explain what is
  collected (this section), who can see it and how long it is kept, and check that it fits your
  local employment and data-protection rules.

## Trust model

- **The server sees everything listed above.** Only point the hook at a server you trust, and
  prefer `https://` for anything that is not on your own machine; plain `http://` is accepted.
- **The API key identifies you.** Uploads are attributed to the key's owner. Keep the key in the
  gitignored `log-hub.local.json`, never in the tracked `log-hub.json`.
- **The server can make the hook run `claude -p`.** Post-turn analysis runs on the server's request
  with your Claude Code account and spends your usage.
- **The hook runs with your user rights.** Like any Claude Code plugin, its scripts can read anything
  you can. Review the scripts under `.artisyn/marketplace/plugins/log-hub-hooks/scripts/` if in doubt.
- **The OTEL receiver listens on `127.0.0.1` only** and accepts only `application/json` without
  CORS headers, so a web page cannot post to it. It has no token, so another local process running
  as you could.
- **The installer is fetched with `npx` from the server** with no checksum or signature check, so
  it is only as trustworthy as that server and the connection to it.

### WARNING: anyone who can commit to the repository controls the hook

The hook reads its settings from `.artisyn/config/log-hub.json`, a file tracked in the repository
it runs in. Whoever can commit to that repository can change how the hook behaves on the machine of
everyone who works in it, with no prompt from Claude Code:

- **Command execution on Windows.** `turnEndCostAdvisorModel` and `sessionAttributionLlmModel` are
  passed to `claude --model <value>` through `cmd.exe` and are not validated. A value such as
  `sonnet & <command>` runs `<command>` in a hidden background process after a turn.
- **Where your sessions go.** `serverUrl` decides which server receives your full transcripts.
- **Where files are written.** `telemetryDir` accepts an absolute path outside the repository.
- **MCP commands.** The hook's MCP probe starts every stdio server listed in the repository's
  `.mcp.json`, without the approval Claude Code asks for.

Install the hook only in repositories whose commits you review, and treat a change to
`.artisyn/config/log-hub.json` or `.mcp.json` in a pull request like a change to code: a model name
must be a plain id (letters, digits and `. _ : - [ ]`), and `serverUrl` must be the server you
expect. This repository's own review list is [`pr-merge-checks.md`](../pr-merge-checks.md).
