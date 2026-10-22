# How the Telemetry Hook Works

Technical reference for the artisyn-log-hub hook system. For installation steps see [INSTALL_HOOK.md](INSTALL_HOOK.md).

---

## Configuration reference

All configuration lives in two JSON files under `.artisyn/config/`, resolved from the **git repo root**:

- `log-hub.json` — tracked, non-secret settings shared by every checkout.
- `log-hub.local.json` — gitignored per-developer settings: `apiKey`, `serverUrl`, `otelReceiverPort` (the installer
  writes all three there since installer `1.0.75`). Overrides `log-hub.json` per top-level key (whole-value
  replacement, not a deep merge — an array key like `context` is replaced entirely, never concatenated). An
  explicit `null` in the local file means "absent" and falls through to the base file's value.

A missing file uses defaults silently. A file that's unparseable JSON or has a non-object root falls back to
defaults for every key it would have contributed, plus one `[warn]` line in `.artisyn/ai_work_dir/hook.log` naming the file.
A single present-but-wrong-typed value (e.g. a string where a number is expected, or a negative number) falls back
to just that key's default, plus one `[warn]` line naming the file and key — the hook never throws or blocks a tool
call over a config problem.

### Telemetry directory

```json
{ "telemetryDir": ".artisyn/ai_work_dir/telemetry" }
```

Relative to project (git repo) root, or absolute. Default: `""` → `<repo-root>/.artisyn/ai_work_dir/telemetry`.

### Context labels

Attach arbitrary metadata to every recorded event via the `context` array:

```json
{
  "context": [
    { "key": "project", "value": "my-project" },
    { "key": "env", "value": "production" },
    { "key": "team", "value": "backend" }
  ]
}
```

Produces `"context": { "project": "my-project", "env": "production", "team": "backend" }` on every record. Keys are
lowercased; a non-string `value` is coerced with `String(value)`; an entry with a missing/blank `key` is skipped
(one `[warn]` line); duplicate keys — last entry wins. Default: `[]`; absent or empty → no `context` field emitted.

### Log upload settings

`log-hub.json`:
```json
{
  "sendLogsTimeoutMs": 10000,
  "sendLogsOnPromptEnabled": true,
  "sendLogsOnPromptTimeoutMs": 60000
}
```

`log-hub.local.json` — `serverUrl`, and `apiKey` sent as the `X-API-Key` header (a `serverUrl` in `log-hub.json`
also works, as a shared fallback):
```json
{ "serverUrl": "https://your-server", "apiKey": "your-api-key" }
```

- `sendLogsTimeoutMs` (default `10000`) — per-request HTTP timeout for a single upload request (or a single chunk
  request, for a chunked upload).
- `sendLogsOnPromptEnabled` (default `true`) — gates whether `UserPromptSubmit` also spawns a detached,
  prompt-triggered background upload of the current session's own files, in addition to the normal `Stop`-triggered
  upload. See [Prompt-triggered background upload](#prompt-triggered-background-upload) below.
- `sendLogsOnPromptTimeoutMs` (default `60000`) — watchdog timeout for that prompt-triggered upload; also drives
  the shared upload lock's staleness window (`2x` this value — see below), so changing this one value moves both
  together.

---

## Recorded events (JSONL)

All events are written to `<TELEMETRY_DIR>/<session_id>.jsonl`, one JSON object per line.

### `prompt_start` — fires on `UserPromptSubmit`

```json
{
  "event": "prompt_start",
  "timestamp": "2025-01-15T10:23:00.000Z",
  "session_id": "abc123",
  "prompt": "fix the login bug",
  "context": { "project": "my-project" },
  "git": { "repo": "git@github.com:org/repo.git", "branch": "main", "user": "Jane Dev" }
}
```

`context` is omitted when no `CTX_*` vars are set. `git` is `null` outside a git repo.

**`cwd` outside a git repo (hook `2.21.0`+).** When `git` is `null`, the event also carries a top-level
`cwd` — the absolute working folder from the hook payload (e.g. `"cwd": "/home/jane/notes"`). The server
uses it to group such sessions under a per-user local repository, since there is no remote to identify them.
It is never sent when `git` is present. Older servers ignore the field.

### `prompt_stop` — fires in two situations

1. **Interrupted turn recovery** — by `telemetry-hook.js` on `UserPromptSubmit`. Before writing the new `prompt_start`, the hook checks whether the last event is an unclosed `prompt_start`. If so a `prompt_stop` is appended to close that work period (handles Escape-interrupted turns).
2. **Session end** — by `send-logs-hook.js` on `Stop`. Written immediately before upload. Duplicate trailing stops are deduplicated.

```json
{ "event": "prompt_stop", "timestamp": "2025-01-15T10:30:00.000Z", "session_id": "abc123" }
```

**Work-time calculation:** each `prompt_start` opens a segment that closes at the next `prompt_start` or `prompt_stop`. Summing all segment durations gives total autonomous work time.

### Lifecycle events — fire on the 12 events handled by `lifecycle-hook.js`

`PostToolUse`, `PostToolUseFailure`, `SessionStart`, `SessionEnd`, `PermissionRequest`,
`PermissionDenied`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `PostToolBatch`,
`StopFailure`. Unlike the events above these are keyed by `hook_event_name`, not `event`:

```json
{
  "type": "artisyn",
  "hook_event_name": "SessionStart",
  "timestamp": "2025-01-15T10:22:55.000Z",
  "session_id": "abc123",
  "git": { "repo": "git@github.com:org/repo.git", "branch": "main", "user": "Jane Dev" }
}
```

Each event adds its own fields (`tool_name`/`tool_input`/`tool_result`, `agent_id`, `transcript_path`, …).

**`SessionStart` carries `git`** — same shape as `prompt_start`, `null` outside a git repo. This is
what lets the server associate the session with its repository from the very first uploaded chunk.
Without it, `git.repo` would first appear only on `prompt_start`, so a session uploaded before its
first prompt (see [Prompt-triggered background upload](#prompt-triggered-background-upload)) would
have nothing to link against and stay invisible on the repo's session list. Added in hook `2.2.1`;
older hooks omit the field and servers that do not read it are unaffected. Like `prompt_start`, a
`SessionStart` outside a git repo also carries a top-level `cwd` (hook `2.21.0`+).

---

### `hook_service` — marks a session spawned by a hook-triggered `claude -p` call

Whenever a hook invokes `claude --print --output-format json` — since hook `2.9.0`, either branch of
`post-turn-analysis-worker.js`'s `claude -p` call (via the shared async `callLlmAsync()`,
`claude-invoke-async.js`) — the JSON envelope returned by that call includes the spawned
session's UUID. The calling hook writes this event directly into **that spawned session's**
telemetry file so the artisyn server can identify it as an internal service session rather than a
user session.

```json
{
  "type": "artisyn",
  "event": "hook_service",
  "hook_service_type": "turn-end-cost-advisor",
  "timestamp": "2025-01-15T10:24:00.000Z",
  "session_id": "<spawned-session-uuid>"
}
```

| Field | Value |
|-------|-------|
| `hook_service_type` | `"turn-end-cost-advisor"` \| `"session-attribution"` — identifies which hook/branch produced the session |
| `session_id` | The UUID of the spawned `claude` process session |
| `invoking_session_id` | `session-attribution` markers only — the id of the real user session that triggered this evaluation (needed because the Attribution Spend Executive Summary section has no other way back to the invoking session's branch/user context; `turn-end-cost-advisor` doesn't need this field, since its own run table already stores the invoking session directly) |

The artisyn-log-hub server uses JSONB containment (`@> '[{"event":"hook_service"}]'`) to set `isHookService: true` on those sessions, which the UI filters out by default.

**`ARTISYN_HOOK_SERVICE` — the hook-side companion to this marker (since 2.10.1).** The telemetry
event above is retrospective: it tells the *server* what a session was, after the fact. It cannot
stop the spawned session's own `Stop` from firing, and that `Stop` runs
`post-turn-analysis-hook.js`, which would launch a full advisor + attribution evaluation *of the
service session*, whose own two `claude -p` calls would each do the same again — one real user turn
fanning out into an unbounded chain of LLM calls (measured before the fix: 534 worker runs in 33
minutes, 502 of them hook-service sessions).

So the spawn site — `callLlmAsync()` (`claude-invoke-async.js`, value `post-turn-analysis`) — exports `ARTISYN_HOOK_SERVICE=<service name>` into the
child `claude` process. Claude Code runs hooks as child processes of the CLI, so every hook inside
the spawned session inherits it, and `post-turn-analysis-hook.js` exits immediately when it is set
(`post-turn-analysis-worker.js` re-checks it too, so the guard still holds when a newer worker is
paired with a trigger script older than 2.10.1). Do not export this variable in a normal shell: an
interactive session started with it set gets no turn-end advisor and no session-attribution
evaluation at all.

---

## Harness snapshot — the one synthetic event injected at upload time

Before uploading the *current session's own* `artisyn` file, `send-logs-hook.js` prepends one or
two synthetic lines built from `harness-snapshot.js` + `skill-catalog.js`. These are **never
written to the local JSONL file** — they exist only in the uploaded payload, for the `artisyn`
namespace only, and only for the session's own current-run upload (a backlog session's re-upload
carries neither line).

**`harness-snapshot-ref`** is sent on every such upload — just the id:

```json
{ "type": "harness-snapshot-ref", "snapshotId": "3f9c2a1e..." }
```

**`harness-snapshot`** (the full body) is sent *in addition*, only when that id is not yet known to
have reached the server (tracked in `harness-state.json`'s `knownSnapshotIds`, see "Hook diagnostic
log" / `harness-state.js` below). It describes the harness itself — the skill/workflow/command
catalog, project agents, MCP servers and CLAUDE.md/rules context — not anything about the session:

```json
{
  "type": "harness-snapshot",
  "snapshotId": "3f9c2a1e...64 lowercase hex...",
  "schemaVersion": 1,
  "perToolDetailSupported": true,
  "skills": [
    {
      "name": "task-implement",
      "kind": "skill",
      "source": "project",
      "description": "Implement a task plan chunk-by-chunk",
      "argumentHint": "T-N",
      "body": "...",
      "path": ".claude/skills/task-implement/SKILL.md",
      "bytes": 1234,
      "contentHash": "a94a8f..."
    },
    {
      "name": "adlc-lh:tracker",
      "kind": "skill",
      "source": "plugin",
      "description": "...",
      "body": "...",
      "path": "adlc-lh@1.3.1/skills/tracker/SKILL.md",
      "bytes": 2048,
      "contentHash": "b7e23e...",
      "plugin": { "id": "adlc-lh@artisyn", "name": "adlc-lh", "marketplace": "artisyn", "version": "1.3.1" }
    }
  ],
  "agents": [
    {
      "name": "task-implement-orchestrator",
      "description": "Orchestrate chunk-by-chunk implementation of a task plan",
      "body": "...",
      "path": ".claude/agents/task-implement-orchestrator/AGENT.md",
      "bytes": 2100,
      "contentHash": "c4ca42...",
      "source": "project"
    }
  ],
  "mcpServers": [
    { "name": "postgres", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"], "configSource": "project", "connected": true, "tools": [{ "name": "query", "schemaSizeTokens": 42 }] },
    { "name": "playwright", "command": "npx", "args": ["@playwright/mcp"], "configSource": "user", "connected": false, "tools": [] }
  ],
  "systemContext": {
    "totalBytes": 12800,
    "files": [
      { "path": "CLAUDE.md", "bytes": 9800, "contentHash": "d41d8c..." },
      { "path": ".claude/rules/installer.md", "bytes": 455, "contentHash": "e2fc71...", "content": "# Rule content..." }
    ]
  }
}
```

No field anywhere is an absolute local path, and there is no `lastModified`/mtime field — every
path is already relative (see "Paths" below) and change detection is by `contentHash` equality
(a touch with no content change reproduces the same `snapshotId`; a content edit always produces a
new one, even if it preserves the file's mtime).

### Catalog scan (`skill-catalog.js`'s `buildSkillCatalog()`)

Collects skills/workflows/commands from three kinds of source:
- **Project** — `.claude/skills/<name>/SKILL.md` (kind `skill`), `.claude/workflows/*.js` (kind
  `workflow`; name/description parsed from the file's `meta = {...}` block by regex — the file is
  never executed), top-level `.claude/commands/*.md` (kind `command`). Tagged `source: "project"`.
  Always wins on a name clash with any other source.
- **User** — the same three folders under `<claudeConfigDir>/.claude/` (or wherever
  `CLAUDE_CONFIG_DIR` points — see `claude-config-dir.js`). Tagged `source: "user"`, path shaped
  `~/.claude/<rel>`.
- **Plugin** — for every plugin this project has *actually enabled*: `enabledPlugins` is merged
  from `<claudeConfigDir>/settings.json`, then the project's own `.claude/settings.json`, then
  `.claude/settings.local.json` (a later file's `false` disables an earlier `true`); each surviving
  `<name>@<marketplace>` is then resolved against `<claudeConfigDir>/plugins/installed_plugins.json`
  (scope order: `local` with a matching `projectPath`, then `project`, then `user`) to find its
  `installPath`. An enabled-but-unresolved plugin is skipped with a `hook.log` line, never a thrown
  error. The same three folders are scanned under that `installPath`, plus any extra paths the
  plugin's own `plugin.json` lists under `skills`/`commands`. Entries are named
  `<pluginName>:<name>` and tagged `source: "plugin"`, with a `plugin` object
  (`{id, name, marketplace, version, gitCommitSha?}`).

A project/user name collision resolves **project wins**. This replaces the old recursive scan of
`~/.claude/plugins/` and the directory-marketplace working-copy scan from earlier hook versions —
only a project's own *resolved, enabled* plugin install is read now.

### Paths (per source)

| Source | Path format |
|---|---|
| `project` | Relative to the project root, forward slashes. |
| `user` | `~/.claude/<rel>`. |
| `plugin` | `<pluginName>@<version>/<rel inside installPath>`. |

### MCP servers and the live `tools/list` probe

Reads MCP servers from three sources (higher-priority entries shadow lower-priority ones of the
same name): project-level `.mcp.json`, user-level `<claudeConfigDir>/mcp.json`, user-level
`<claudeConfigDir>/settings.json` — tagged `configSource: "project"`/`"user"` respectively.
Credentials in args (e.g. `postgresql://user:pass@host/db`) are scrubbed to
`postgresql://host/db`.

**Live `tools/list` probe (2.7.0+; run per-snapshot, not per-file, since 2.22.0):** only once the
snapshot's id turns out unknown (never for a ref-only upload — the body isn't being resent, so
there's nothing to probe for), for each server with a `command` (stdio transport only — a
`url`/SSE-based server is left without `connected`/`tools`, same as an old hook) the hook spawns it,
sends a JSON-RPC `initialize` then `tools/list` over stdin, and merges the result onto that
server's entry — sequentially, one server at a time, each capped at `mcpProbeTimeoutMs` (default
`3000`, see the config table above). Any failure (spawn error, timeout, malformed response)
resolves `connected: false, tools: []` rather than throwing. `schemaSizeTokens` is a fixed, coarse
`÷4` estimate of `JSON.stringify({name, description, inputSchema})`'s length — deliberately a
different constant from the per-model token-estimation ratios used elsewhere. The snapshot's
top-level `perToolDetailSupported: true` flag is what tells a server-side reader "this hook
attempted the probe" apart from "old hook, never tried" — see
`docs/knowledgebase/hook-api-versioning.md`'s `perToolDetailSupported` section in the main repo.

### `snapshotId` (DD-2) and known-state (DD-6)

`snapshotId = sha256Hex(JSON.stringify(canon))`, where `canon` is a fixed, sorted projection of
`skills`/`agents`/`mcpServers`/`systemContext.files` built from each entry's `contentHash` (never
the raw body text) — deliberately excluding the MCP probe's `connected`/`tools` and
`perToolDetailSupported`, so probing or getting a different probe result never changes the id. The
server **never recomputes** this id; it only format-validates it. `harness-state.json` (v2) tracks
`knownSnapshotIds` (most-recent-first, capped at 20) and `sessionSnapshots` (per-session last-sent
id, used by the prompt-triggered background upload below to send a ref-only line without rebuilding
the catalog or re-running the probe). An id is recorded as known only after a successful upload
that carried the full snapshot, and forgotten again if the server ever answers back
`unknownSnapshotId` for it (see `docs/knowledgebase/hook-api-versioning.md`'s
`snapshotId`/`snapshotFull`/`unknownSnapshotId` section) — the next upload then resends the full
body.

---

## Upload mechanics

`send-logs-hook.js` runs in two modes. On `Stop` (end of each assistant turn) it does the **full run**
described in this section. On `SessionEnd` (hook `2.8.0`+) it instead does a short **scoped flush** of only the
ending session's own `artisyn` + `claude` files — see "SessionEnd flush" below.

The full run uploads three namespaces:

| Namespace | Source |
|-----------|--------|
| `artisyn` | `TELEMETRY_DIR` — artisyn JSONL files |
| `claude` | `~/.claude/projects/<slug>/` — Claude Code session logs |
| `claude-subagent` | `~/.claude/projects/<slug>/<session>/subagents/` — sub-agent logs |

Zero-byte files are skipped. A manifest file (`<TELEMETRY_DIR>/.claude-logs.sent`) records the byte-size of each successfully uploaded file so unchanged files are not re-uploaded on subsequent sessions.

**Current-session race condition (narrowed in hook `2.8.0`):** the current session's `claude`, `claude-subagent` and
`claude-otel` files *are* recorded in the manifest, by their stat-time on-disk size. Claude Code appends a
`turn_duration` event to the transcript after the Stop hook fires, so the file grows and the next Stop run sees a
different size and re-uploads it — the size comparison skips only a transcript that genuinely did not change since
the last upload. Before `2.8.0` these entries were omitted entirely, which re-uploaded every current-session
transcript on every turn even when nothing had been appended.

The current session's own **`artisyn`** file stays exempt, and is still re-uploaded every run: its uploaded body
carries the synthetic context prepends and this run's `hook-status` event, none of which the on-disk size reflects,
so an unchanged size there would wrongly skip a body that differs every run.

### SessionEnd flush (hook `2.8.0`+)

`Stop` used to be the only trigger that shipped a session's own `artisyn`/`claude` files, and it exited silently
whenever the shared upload lock was held. Because a catch-up `Stop` run in one session can hold that lock for tens of
seconds, a second session ending inside that window left its final delta on disk — and a session whose uploaded
artisyn body has no `prompt_start` event lands server-side with `first_prompt = NULL`, which the repository
session-list query filters out entirely. The session then simply never appears in the UI.

Two changes close that gap:

- **`SessionEnd` also runs `send-logs-hook.js`** (alongside `lifecycle-hook.js`), calling `runSessionEndFlush()` —
  the ending session's `artisyn` + `claude` files only, via `session-files.js`'s `collectScopedFiles()`. No
  multi-session scan, no manifest write, no context prepends, no `hook-status`, no otel prune.
- **The lock is now waited on**, via `upload-logs.js`'s `acquireUploadLockWithWait()`: 2s on `Stop` (it blocks the
  interactive turn and another trigger will follow), 20s on `SessionEnd` (it blocks nothing and is the session's last
  chance), polling every 250ms.

Like the prompt-triggered path, the flush writes no `.claude-logs.sent` entry, so the next full run still processes
the file normally.

**Upload endpoints:**
- Artisyn + Claude: `POST <SERVER_URL>/api/v2/logs?type=<namespace>&sessionId=<id>`
- Sub-agents: `POST <SERVER_URL>/api/v2/logs?type=claude-subagent&sessionId=<agentId>&parentSessionId=<parentId>`

A `201` response is success; any other status or network error is logged to stderr and the hook continues (always exits 0). The `201` response body may carry `{ warnings: string[] }` — one message per broken/unprocessable file the server queue found for this user since the last check. The hook surfaces any such warnings via a `broken-upload-file` recommendation, the same mechanism used for `timeout-on-upload` (persisted to `.artisyn/ai_work_dir/hook-recommendations.json` and surfaced through the `hook-status` event).

**Large sessions:** a payload over 40 MB logs a `warn` line before the upload attempt (informational only — the upload still proceeds). Two things commonly cause a *big* session to fail outright:
- **Server body-size limit** (currently 50 MB on the server) — surfaces as `HTTP 413`, or occasionally `HTTP 400` for payloads over 40 MB, from a reverse proxy / body-parser rejecting the request.
- **`SEND_LOGS_TIMEOUT_MS`** (default 10000 ms) — surfaces as a `timeout` failure if the upload can't complete in time; large files on a slow connection are the usual cause.

Failure log lines include the payload size, the configured timeout, the destination origin (`target=<origin>`) and (for HTTP failures) a snippet of the server's response body, so the actual cause is visible in `hook.log` without needing to reproduce the failure. `target=` is also appended to the per-run `done: …` line, so a successful upload to a stale/wrong `serverUrl` is just as visible as a failing one — the destination is entirely config-driven and no host is hardcoded in the hook. Only the origin is logged: the query string carries the `sessionId` and the API key travels in the `X-API-Key` header, and neither reaches the log. For persistent large-session failures, raise `sendLogsTimeoutMs` in `.artisyn/config/log-hub.json` or check the server/proxy body-size limit.

### Gzip transport (hook `2.8.0`+)

Since `2.8.0` every request body is gzip-compressed by default, on both the single-request and the chunked path.
NDJSON transcripts compress roughly 8–15x, so this is what makes a large session's upload finish in a fraction of
the requests and the wall-clock it used to need. There is **no config key** — the decision is made per request from
three facts:

- **Loopback is never compressed.** `isLoopbackServerUrl()` returns true for `localhost`, `*.localhost`,
  `127.x.x.x` and `::1`, where compression only burns CPU for no transfer win. URL-only — no probing, no flag.
- **A compressed body that isn't smaller is not sent.** The single-request path (`uploadFileMaybeCompressed()`)
  gzips once and falls back to the plain body if the result is not strictly smaller or would exceed
  `CHUNK_SIZE_BYTES` — gzip adds ~18 bytes of framing, so a near-incompressible body can grow.
- **A peer that rejects gzip is remembered for the process.** A `415`, or a `400` whose body is none of the
  server's own validation messages, is classified by `isEncodingRejection()` as "this peer does not accept gzip":
  the same data is resent uncompressed immediately and every later file in that process is sent plain, with no
  further rejected round-trip. This is the module's one piece of module-level state — a *transport capability of
  the peer*, not per-project state, so sharing it across projects is exactly right.

Compression uses plain `zlib.gzipSync(buf)` (level 6, zlib's default), pinned so the CPU/ratio trade-off is not
re-litigated per call site. The request carries `Content-Encoding: gzip` and a `Content-Length` equal to the
**compressed** length. Chunk query params (`totalSize` in particular) always describe **uncompressed** bytes, so the
server's reassembly and its `upload_queue.size_bytes` stay truthful regardless of encoding.

Server side, `POST /api/v2/logs` (the only upload route) accepts either form: a declared `Content-Encoding:
gzip` is inflated by body-parser, and a body whose header a proxy stripped is still detected by its `1f 8b` magic
bytes and inflated by the `inflateSniffedGzip` middleware. A body that starts with those bytes but fails to inflate
answers `400 Malformed gzip request body`; one that inflates past `LOGS_MAX_BODY_MB` answers `413`.

### Chunked upload (bodies over `CHUNK_SIZE_BYTES`)

Both upload paths — the `Stop`-triggered `send-logs-hook.js` and the prompt-triggered `prompt-upload-hook.js`
(below) — share one chunking implementation in `upload-logs.js`. Whenever a file's final body (after all `artisyn`
prepends) exceeds `CHUNK_SIZE_BYTES` (hardcoded 900 KB, not configurable — sized to clear the 1 MB
`client_max_body_size` an unconfigured nginx defaults to), the file is split into sequential chunk requests
instead of one single-request upload. Since `2.8.0` `CHUNK_SIZE_BYTES` is the budget for the **on-the-wire** body,
so a compressed chunk carries several megabytes of NDJSON inside a sub-900 KB request:

- Each chunk is POSTed to the same `POST /api/v2/logs` endpoint with four extra query params: `uploadId` (a
  fresh `crypto.randomUUID()` per file), `chunkIndex` (0-based), `totalChunks`, and — on `chunkIndex=0` only —
  `totalSize` (the full un-chunked, **uncompressed** byte length).
- Every non-final chunk gets back `{ complete: false }`; the final chunk gets back `{ complete: true, warnings }`.
  The caller (`send-logs-hook.js`/`prompt-upload-hook.js`) only treats the file as uploaded once `complete: true`
  arrives — a chunk failure partway through marks the whole file's upload failed for that run.
- Bodies at or under `CHUNK_SIZE_BYTES` uncompressed still take the single-request path (possibly gzipped): no
  chunk query params, one request. That routing test is deliberately the *uncompressed* size, so it does not
  depend on how well a particular body happens to compress.

**Adaptive slice planning.** The server pins `totalChunks` at chunk 0, so the whole split is computed locally before
anything is sent, by `planCompressedSlices(body, startRatio, wireBudget)`:

- predict an uncompressed slice length as `wireBudget × ratio × 0.8` (`GZIP_SAFETY_MARGIN`), capped at 16 MB
  (`GZIP_MAX_SLICE_BYTES`);
- move its end back to the nearest preceding `\n` via `alignSliceBoundary()`, so no slice ever splits a JSON line —
  and, for a body with no newline at all, back off a UTF-8 continuation byte so no slice splits a character either;
- gzip it; accept if the result fits the budget, otherwise halve the predicted length and retry, at most
  `GZIP_MAX_RECOMPRESS` (4) times;
- after four overshoots, that one slice falls back to `identity` (uncompressed) at the budget size — a
  near-incompressible file therefore still completes, it just stops saving anything;
- a slice that compresses to under half the budget re-derives the ratio upward for the following slices.

The plan holds offsets only (`{s, e, enc}`); each slice is re-gzipped at send time, so peak memory is one compressed
slice rather than the whole compressed body.

**Ratio memory** — `<telemetryDir>/gzip-stat.json` (`{"ratio": <number>, "updatedAt": "<ISO>"}`) remembers the last
observed compression ratio and seeds the next run's first prediction, so a second upload of similar data needs no
warm-up shrinks. A missing, unreadable, malformed or out-of-range (outside `[1, 100]`) value simply yields the
default ratio of `8.0`; the file is never required and a failed read or write never fails an upload.

**Resumability across process restarts** — `.claude-logs.pending` (same directory as `.claude-logs.sent`). Since
`2.8.0` this is a whole-file **JSON** document rather than one text line per upload, because a resumed run must
replay the exact same slice boundaries the original `totalChunks` was derived from:

```json
{
  "version": 2,
  "entries": {
    "claude/1c2f….jsonl": {
      "uploadId": "0f1e…",
      "totalSize": 6291456,
      "totalChunks": 7,
      "nextChunkIndex": 3,
      "slices": [{ "s": 0, "e": 912345, "enc": "gzip" }]
    }
  }
}
```

- `nextChunkIndex` is the next chunk **to send** (the pre-`2.8.0` line format stored the last *acked* index).
- After each successfully-acked chunk the record is rewritten; it is deleted the moment the server responds
  `complete: true`.
- Before starting a chunked upload, a record for the same file whose `totalSize` still matches the current body
  length is resumed: same `uploadId`, same `slices`, same `totalChunks`, ignoring the remembered ratio — so a
  resumed run can never announce a different `totalChunks` for a live `uploadId`. A differing size discards the
  record and mints a fresh `uploadId`.
- The reader validates the whole document (`version === 2`, plain-object `entries`) and each entry independently
  (non-empty `uploadId`, non-negative integer counters, `slices.length === totalChunks`, `slices[0].s === 0`, the
  last `e === totalSize`, and contiguous `e`→`s` offsets). Anything that fails is ignored and the upload simply
  starts from chunk 0 — a pre-`2.8.0` positional file fails `JSON.parse` and is dropped, never mis-parsed.

**Failure handling during the send loop**, in precedence order:
- **Resume-target-gone:** an `HTTP 400` on the first chunk of a *resumed* upload (e.g. the server-side row was
  cleaned up, or the process died before chunk 0 ever succeeded) restarts once from `chunkIndex=0` with a brand-new
  `uploadId`, within the same call.
- **`413`:** the wire budget itself is too high (an intermediary stricter than 900 KB). The budget is halved —
  floored at `GZIP_MIN_WIRE_BUDGET` (128 KB) — the pending record is discarded, a new `uploadId` is minted, and the
  whole file is re-planned and resent from chunk 0, at most twice per call. The lowered budget also caps the
  per-slice `identity` fallback, so no plain slice can breach it either.
- **Encoding rejection** (`415`, or a non-validation `400`): the process-level flag is set, the pending record
  discarded, a new `uploadId` minted, and the file re-planned as fixed-size newline-aligned uncompressed slices
  from chunk 0 — once per call.
- Anything else fails that one file's upload for this run; the hook run itself continues and always exits 0.

**Reporting.** Both `uploadFileMaybeCompressed()` and `uploadFileChunked()` return `wireBytes`, `plainBytes`,
`requests` and `fallback` alongside `{success, reason, warnings}`, which the callers render as a single `hook.log`
`result` line — `… uploaded 5760 KB → 576 KB gz (10.0x) in 7 requests`, or `… uploaded 880 KB uncompressed in 1
request`, with ` [gzip fallback]` appended whenever a rejected gzip body forced the plain retry.

### Prompt-triggered background upload

In addition to the `Stop`-triggered upload above, every `UserPromptSubmit` can also kick off a **detached**
background upload of just the current session's own files — so a long-running session's data reaches the server
before it ends, not only at `Stop`. This is gated by `sendLogsOnPromptEnabled` (default `true`).

**Spawn wiring (`telemetry-hook.js`):** after writing the `prompt_start` telemetry event, if
`sendLogsOnPromptEnabled` is true and the throttle below allows it, `telemetry-hook.js` calls
`spawn-hidden.js`'s `spawnDetachedHidden()` to launch `prompt-upload-hook.js` detached, and never awaits or reads
anything back from it — this is what keeps `UserPromptSubmit` itself from getting any slower.

**Hidden launch (`spawn-hidden.js`):** one spawn, identical on every platform —
`spawn(process.execPath, [scriptPath, ...argv], { detached: true, stdio: 'ignore', windowsHide: true }).unref()`.
On Windows `detached: true` is what does the work: libuv translates it to `DETACHED_PROCESS`, so the child is given
no console *at all* (measured on Windows 11 / Node 24 from a console-owning parent: no `conhost` child, no window,
with or without `windowsHide`).

Before v2.6.0 this file routed the Windows launch through `wscript.exe //B //Nologo` running a self-deleting
VBScript written to `%LOCALAPPDATA%\Temp`, to avoid a console flash. **That diagnosis was one level too high.** The
flash was real, but it came from the grandchildren: because a detached process has no console, when it shells out
to a console-subsystem exe Windows allocates a fresh *visible* console for that child — here
`prompt-upload-hook.js` reaching `git.exe` through `git-context.js` on every prompt past the throttle.
`WScript.Shell.Run(cmd, 0, False)` merely masked it by handing the detached process a real-but-*hidden* console for
its grandchildren to inherit. The fix belongs at the call sites: every `execFileSync`/`spawnSync` in the hook passes
`windowsHide: true`, pinned by `__tests__/no-visible-window.test.js`. The VBScript detour is gone: a temp-dir
script launched through Windows Script Host tends to trip endpoint-security heuristics, and a plain detached
`node` child does the same job without it.

`cwd`/`sessionId` are still passed **both** as argv and as
`ARTISYN_PROMPT_UPLOAD_CWD`/`ARTISYN_PROMPT_UPLOAD_SESSION_ID` env vars, and `prompt-upload-hook.js` still reads
argv first with an env fallback — that redundancy is now kept purely for cross-version compatibility, since a hook
&le; 2.5.1 launches these scripts through the old VBScript command line, which carried env only.

**Throttle** — independent of everything below, checked *before* spawning at all: a state file
(`<workDir>/prompt-upload-throttle.json`, `{ lastAttemptAt }`) is checked against a hardcoded
`PROMPT_UPLOAD_THROTTLE_MS` (60 000 ms, not configurable). If the last attempt was more recent than that, the
spawn is skipped entirely (logged, no error) — a rapid-fire sequence of prompts triggers at most one spawn per
throttle window. The state file is updated synchronously *before* spawning (optimistic update), so a burst of
near-simultaneous prompts can't all pass the check before any of them records the attempt.

**Scoped file collection (`prompt-upload-hook.js`):** unlike the `Stop`-triggered path's full multi-session scan,
this script uploads exactly two files — `<telemetryDir>/<sessionId>.jsonl` (artisyn) and the current session's
own Claude transcript file (`~/.claude/projects/<slug>/<sessionId>.jsonl`) — no subagent/workflow files, no other
sessions. Both go through the same chunk-aware, gzip-aware
`uploadFileMaybeCompressed()`/`uploadFileChunked()` as the `Stop` path. **No manifest read/write**:
`.claude-logs.sent` is never read or written by this path, so a file can legitimately be re-uploaded on the next
prompt; the server's upsert is idempotent, so this is treated as an acceptable, safe tradeoff rather than a bug.

**Watchdog:** the very first thing `prompt-upload-hook.js` does after loading config is arm
`setTimeout(() => process.exit(1), sendLogsOnPromptTimeoutMs)` (default 60 000 ms) — deliberately *not*
`.unref()`'d, so it can force-kill the process if the upload work hangs. Any other failure (network error,
malformed config, missing file) is caught and logged with `process.exit(0)` instead — the watchdog's
`process.exit(1)` is the only non-zero exit this script ever produces, and it's always a forced kill, not a
graceful failure.

**Shared upload lock (`<telemetryDir>/.upload.lock`, from `upload-logs.js`):** mutually excludes the
`Stop`-triggered `send-logs-hook.js` and the prompt-triggered `prompt-upload-hook.js` from ever uploading for the
same project at the same time. The lock file holds `{ startedAt: <ISO timestamp> }`; on acquire, if an existing
lock is younger than the staleness window (`2 * sendLogsOnPromptTimeoutMs`, computed dynamically — this is why
that one config value moves both the watchdog and the lock-exclusion window together), the acquiring script logs
`skipped: upload lock held` and exits `0` immediately, before any file scanning or network I/O. Otherwise it
writes a fresh lock and proceeds, deleting the lock file in a `finally` on normal completion. A force-killed
process (crash, OS kill) never runs that `finally` and leaves the lock in place — the staleness check above is
what recovers from that on the next run, not any kind of PID-liveness check.

---

## Hook diagnostic log

Every hook appends to `<project-root>/.artisyn/ai_work_dir/hook.log`. Format:

```
<ISO-timestamp> [<hook-file>] [<session_id>] [<event>] <message>
```

For `activate` events a `[hook v<version>]` suffix is appended when `version.json` is present in `telemetry_tool/`.

```
2025-01-15T10:23:00.000Z [telemetry-hook.js] [abc123] [activate] UserPromptSubmit received [hook v1.0.3]
2025-01-15T10:23:00.001Z [telemetry-hook.js] [abc123] [result] telemetry written to /project/.artisyn/ai_work_dir/telemetry
2025-01-15T10:30:01.200Z [send-logs-hook.js] [abc123] [result] done: uploaded=2 skipped=1 failed=0 total=3
```

`hook.log` rotates at 100 KB; up to 3 files are retained (`hook.log`, `hook.log.1`, `hook.log.2`).

**The two turn-end-analysis branches of `post-turn-analysis-worker.js` log to their own dedicated files**, not
`hook.log`: the Turn-End Cost Advisor branch writes `.artisyn/ai_work_dir/analysis.log`, and the
AI Session Attribution branch writes `.artisyn/ai_work_dir/attribution.log` — same line format and
same independent 100 KB / 3-file rotation as `hook.log` (each file rotates on its own; one filling
up never rotates another). Worker-level events that precede or span both branches (the run
starting, the combined config fetch failing, no `repoUrl` resolvable, or an uncaught top-level
error) still go to the shared `hook.log`, since they aren't attributable to one branch. Any other
hook script wanting its own dedicated log file can call `hookLogTo(logFileName, ...)` from
`hook-log.js` the same way — `hookLog(...)` (fixed at `hook.log`) is unchanged for every existing
caller.

**`send-logs-hook.js` always writes exactly one line per run (hook `2.8.0`+).** Every early exit from `main()` now
logs an `exit: …` message naming both the reason and the directory it wrote into — unreadable/non-JSON stdin, a
`hook_event_name` that is not `Stop`/`SessionEnd`, a missing `serverUrl`/`apiKey`, and the top-level
`exit: unhandled error: …` catch. The successful path's `activate` line carries the same `logDir=` marker:

```
2026-08-13T10:30:00.000Z [send-logs-hook.js] [abc123] [activate] Stop event received (logDir=/project/.artisyn/ai_work_dir) [hook v2.8.0]
2026-08-13T10:30:00.000Z [send-logs-hook.js] [abc123] [result] exit: hook_event_name=PostToolUse is not Stop/SessionEnd (logDir=/project/.artisyn/ai_work_dir)
```

That makes the three ways this hook can look silent distinguishable without reproducing anything: a wrong event
name says so, lines landing in another repo's `hook.log` show a `logDir=` you did not expect, and *no line at all*
now means the script never ran (bad wiring, a `require` crash, or an unwritable log directory).

---

## Cleanup

```sh
# Remove diagnostic logs
rm -f .artisyn/ai_work_dir/hook.log .artisyn/ai_work_dir/hook.log.1 .artisyn/ai_work_dir/hook.log.2
rm -f .artisyn/ai_work_dir/analysis.log .artisyn/ai_work_dir/analysis.log.1 .artisyn/ai_work_dir/analysis.log.2
rm -f .artisyn/ai_work_dir/attribution.log .artisyn/ai_work_dir/attribution.log.1 .artisyn/ai_work_dir/attribution.log.2

# Remove local JSONL files
rm .artisyn/ai_work_dir/telemetry/*.jsonl
```

Both are regenerated automatically on the next Claude Code session.
