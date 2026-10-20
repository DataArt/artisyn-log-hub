---
type: "Architecture Guide"
title: "Hook System Overview"
description: "Hook system architecture: event triggers, telemetry recording, the per-project OTEL receiver, log upload with deduplication, and design principles."
tags:
  - hooks
  - otel
timestamp: "2026-09-26T00:00:00+04:00"
---

# Hook System Overview

The artisyn hook system is a set of Node.js scripts wired into Claude Code's hook event system. It collects telemetry from Claude sessions and uploads collected logs to the artisyn-log-hub server. It is monitoring/logging only and never blocks a tool call — the `PreToolUse` guardrail (`guardrail-hook.js`, static file-access and LLM Bash checks, `guardrail*` config keys) was removed in hook `2.19.0`; an upgrade deletes the stale script from the installed plugin, and leftover `guardrail*` keys in `log-hub.json` are ignored but deliberately left in place (an older hook reading a config without them would fall back to its guardrail-on defaults).

All hooks use only Node.js 18+ built-ins (`fs`, `path`, `child_process`, `http`, `https`, `os`, `zlib`) — no `npm install` is needed in the project being monitored.

---

## Files

The hook ships as a Claude Code plugin (`log-hub-hooks`), extracted by the installer into
`.artisyn/marketplace/plugins/log-hub-hooks/`:

| File | Role |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest — `name`, `displayName`, `version`, `description`, `author` |
| `hooks/hooks.json` | All hook wiring — 14 events (no `PreToolUse`), exec form (`{"type":"command","command":"node","args":["${CLAUDE_PLUGIN_ROOT}/scripts/<script>.js"]}`) |
| `scripts/telemetry-hook.js` | Fired on `UserPromptSubmit` — writes `prompt_start` event; also throttle-checks and, if enabled, spawns a detached `prompt-upload-hook.js` child process |
| `scripts/lifecycle-hook.js` | Fired on 12 lifecycle events — writes `type: 'artisyn'` events for tool calls, permissions, subagents, compaction, session start/end, stop failure |
| `scripts/send-logs-hook.js` | Fired on `Stop` / `Interrupt` (full run) and on `SessionEnd` (scoped flush, hook `2.8.0`+) — uploads collected logs to server |
| `scripts/session-files.js` | Shared utility (hook `2.8.0`+): `collectScopedFiles(cwd, sessionId, telemetryDir)` resolves just the current session's own `artisyn` + `claude` files. Extracted from `prompt-upload-hook.js` so the `UserPromptSubmit` background upload and the `SessionEnd` flush share one implementation of the project-slug resolution. |
| `scripts/prompt-upload-hook.js` | **Not a Claude Code hook entry point** — a detached child process spawned by `telemetry-hook.js` on `UserPromptSubmit`. Uploads just the current session's `artisyn` and `claude` files in the background so large sessions stay closer to up-to-date on the server without adding latency to the prompt turn. See "UserPromptSubmit background upload" below. |
| `scripts/otel-receiver.js` | **Not a Claude Code hook entry point** (hook `2.3.0`+) — a detached, long-lived loopback OTLP/JSON receiver spawned by `lifecycle-hook.js` (`SessionStart`) and re-armed by `telemetry-hook.js` (`UserPromptSubmit`). Binds `127.0.0.1:<otelReceiverPort>`, accepts `POST /v1/logs`, `POST /v1/metrics`, `POST /artisyn/register` and `POST /artisyn/shutdown`, demultiplexes records by `session.id` and writes one chunk per request and session to `<telemetryDir>/otel/<session-id>/<epochMs>-<seq>.jsonl`. Uses **only** `http`/`fs`/`path`/`zlib` and deliberately `require`s no other hook module (it cannot resolve a git root or read a project config — every parameter is passed in). See [otel-receiver.md](otel-receiver.md). |
| `scripts/otel-register.js` | Shared utility: `buildOwnerPayload()` / `buildRegistrationPayload()` / `buildReceiverLaunch()` (the argv+env pair the spawn needs) plus `fireRegister()`, the non-blocking `POST /artisyn/register` client used by both receiver spawn call sites. Fire-and-forget (socket `unref()`'d, no retry, every failure swallowed); its only observable output is a `hook.log` `warn` line on `409 owner-mismatch` or an older `receiverVersion`. |
| `scripts/upload-logs.js` | Shared utility: the network-upload primitives — `CHUNK_SIZE_BYTES` (900KB as of `2.6.1`; the **on-the-wire** budget per request as of `2.8.0`), `uploadFile()`, `uploadFileMaybeCompressed()` (single-request upload that decides its own encoding and retries plain once if the peer rejects gzip), `uploadFileChunked()` (chunk-splitting + resumability for files over that threshold), the gzip layer added in `2.8.0` (`isLoopbackServerUrl()`, `alignSliceBoundary()`, `planCompressedSlices()`/`planIdentitySlices()`, `readGzipRatio()`/`writeGzipRatio()`, `isEncodingRejection()`/`resetGzipSupport()`), `readPendingUploads()`/`writePendingUploads()` (the v2 JSON `.claude-logs.pending` record) and `acquireUploadLock()`/`releaseUploadLock()` (mutual exclusion between `send-logs-hook.js` and `prompt-upload-hook.js`). Required by both upload-triggering scripts so there is exactly one chunking/compression/locking implementation. |
| `scripts/spawn-hidden.js` | Shared utility: `spawnDetachedHidden()` launches a detached background Node process with no visible window — one `spawn(…, {detached: true, stdio: 'ignore', windowsHide: true})` on every platform, where `detached` (→ `DETACHED_PROCESS`) is what guarantees the child gets no console on Windows. Used by `telemetry-hook.js` to launch `prompt-upload-hook.js` and, since `2.3.0`, by both receiver spawn call sites to launch `otel-receiver.js`. **Before `2.6.0`** it routed the Windows launch through a self-deleting VBScript run via `wscript.exe //B //Nologo` from `%LOCALAPPDATA%\Temp`; that is not used (EDR flagged it as malware — four commodity-loader indicators at once) after establishing the console flash it was added for actually comes from *grandchild* processes that omit `windowsHide`, not from the launch itself. Every receiver parameter is still passed as **both** argv and an `ARTISYN_OTEL_*` env var, now purely for cross-version compatibility with hooks &le; `2.5.1`, whose VBScript command line carried env only. |
| `scripts/process-marker.js` | Shared utility (hook `2.11.0`+): `buildProcessMarkerEnv(role, meta)` returns the `ARTISYN_PROC_*` provenance env vars (`ROLE`, `STARTED_AT`, `STARTED_EPOCH_MS`, `PARENT_PID`, `PARENT_SCRIPT`, `SESSION_ID`, `HOOK_VERSION`) stamped into every child the hooks spawn — inert metadata, never branched on, unlike the `ARTISYN_HOOK_SERVICE` re-entrancy guard. `killProcessTree(child)` is the mandatory replacement for `child.kill()` on any `shell: true` child: on Windows that child is a `cmd.exe` wrapper and the real program is its **grandchild**, so a plain kill orphaned live MCP servers and timed-out `claude -p` calls (six orphans up to five days old were found on the dev machine). Wired into the MCP probe and `claude-invoke-async.js`, and centrally inside `spawnDetachedHidden()` so no `spawn-hidden.js` call site can forget. Note: Windows does not expose another process's environment via `Win32_Process` — these are readable from inside the child, or externally only with a PEB reader (Process Explorer); on Linux/macOS `/proc/<pid>/environ` and `ps eww` show them directly. |
| `scripts/harness-state.js` | Shared utility (hook `2.12.0`+): mtime-based fingerprint of the harness elements (CLAUDE.md files, skill and agent catalogs, MCP config files) plus the once-per-session report state in `.artisyn/ai_work_dir/harness-state.json`. See "Context injection" below. |
| `scripts/write-telemetry.js` | Shared utility: appends a JSON event line to a JSONL file. **Suppressed entirely when `ARTISYN_HOOK_SERVICE` is set (hook `2.12.0`+)** — the hook's own `claude -p` evaluation sessions run Claude Code's full hook set and inherit the spawner's environment, so without the suppression each would record a full session log of itself (57.7% of all artisyn files on a measured dev machine), which would then become another session to upload and classify. Since `2.13.0` the one-line `hook_service` marker is not written either, so an evaluation session produces **no artisyn file at all** — the marker only ever existed to let the server hide these sessions, which is moot once they are never uploaded. Reports were never affected: `turn_end_advisor_runs` / `session_attribution_runs` store `invoking_session_id` in their own columns precisely so no report scans `logs.body`. The server's `logs.body @> '[{"event":"hook_service"}]'` check is retained for sessions uploaded by older hooks. |
| `scripts/git-context.js` | Shared utility: resolves git root, remote URL, branch, user. Since `2.16.0` it also resolves the **worktree** root (`git rev-parse --show-toplevel`) alongside the existing `--git-common-dir` root, and both are uploaded as `git.root` / `git.worktreeRoot` — without the second, every path in a session run inside a linked worktree would be classified out-of-repo |
| `scripts/code-inventory.js` | Shared utility (hook `2.16.0`+): `buildCodeInventory(projectRoot)` measures the tracked codebase at HEAD with ONE `git diff --numstat <EMPTY_TREE_SHA> HEAD` call (`EMPTY_TREE_SHA` is git's well-known empty-tree object id, a named constant here) plus a `rev-parse HEAD`. Returns `null` — never a partial or zeroed record — when the repo cannot be measured, so no `code-inventory` event is emitted and the server reports `n/a` instead of a zero denominator. |
| `scripts/edit-result-counts.js` | Shared utility (hook `2.16.0`+): `deriveEditResultCounts(toolName, toolResponse)` → `{ filePath, added, removed, changeKind }` for `Edit`/`Write`/`MultiEdit` only, `null` for everything else and for an edit with no countable diff. Derived ON THE MACHINE: `structuredPatch`, `originalFile` and every non-edit tool result stay local and are never uploaded. |
| `scripts/env-context.js` | Shared utility: `loadConfig(cwd)` reads `.artisyn/config/log-hub.json` + `log-hub.local.json` (anchored at the git repo root, not `${CLAUDE_PLUGIN_ROOT}`, since that path changes on every plugin update), resolves telemetry dir, extracts the `context` array. Also owns the OTEL resolvers (`2.3.0`+): `resolveOtelDir(cwd, config)` → `<telemetryDir>/otel`, `resolveOtelPort(config, env, cwd)` and `OTEL_FALLBACK_PORT`. |
| `scripts/hook-log.js` | Shared utility: writes diagnostic lines to `.artisyn/ai_work_dir/hook.log`; also exports `getHookVersion()` (cached read of `version.json`) and `readLogTail(cwd, n)` (last `n` non-empty `hook.log` lines) |
| `scripts/recommendations.js` | Shared utility: `readRecommendations(cwd)` / `upsertRecommendation(cwd, entry)` — reads/writes `.artisyn/ai_work_dir/hook-recommendations.json` |
| `scripts/version.json` | Hook content version (must agree with `plugin.json`'s `version`) |
| `config-template/log-hub.json` | Blanked config template the installer reconciles into the project's own `.artisyn/config/log-hub.json` |

The project's own `.artisyn/config/log-hub.json` (tracked) and `.artisyn/config/log-hub.local.json` (gitignored,
`apiKey`) live outside the plugin tree, at the repo root, alongside `.artisyn/marketplace/`.

Hook commands resolve config/output paths via `git rev-parse --git-common-dir` (parent of the resolved `.git`
directory), not `${CLAUDE_PLUGIN_ROOT}` (which points into `~/.claude/plugins/cache/` and changes on every plugin
update), so paths resolve correctly regardless of which subdirectory Claude Code opens from, on any OS — and, since
`--git-common-dir` always points at the main repo's shared `.git` directory, sessions opened inside a linked
worktree resolve to the main repo root as well, not the worktree's own checkout directory.

---

## Hook Events

### `UserPromptSubmit` → `telemetry-hook.js`

Fires on every user prompt. Writes a `prompt_start` event to `<TELEMETRY_DIR>/<session_id>.jsonl`:

```json
{
  "event": "prompt_start",
  "timestamp": "2025-01-15T10:23:00.000Z",
  "session_id": "abc123",
  "prompt": "fix the login bug",
  "context": { "project": "my-project", "lab": "team-a" },
  "git": { "repo": "git@github.com:org/repo.git", "branch": "main", "user": "Jane Dev" }
}
```

`context` is populated from `CTX_*` env vars. `git` comes from `git-context.js`.

**Background upload spawn (hook `1.8.0`+):** after writing `prompt_start`, if `config.sendLogsOnPromptEnabled`
(default `true`) is true, `telemetry-hook.js` checks a throttle state file (`<workDir>/prompt-upload-throttle.json`,
`{lastAttemptAt}`); if the last attempt was less than `PROMPT_UPLOAD_THROTTLE_MS` (60s, hardcoded) ago, it skips
spawning. Otherwise it writes the new `lastAttemptAt` synchronously (optimistic, before spawning, so a burst of
near-simultaneous prompts can't all pass the check) and launches `prompt-upload-hook.js` via `spawn-hidden.js`'s
`spawnDetachedHidden()`, passing `--cwd`/`--sessionId` on `process.argv` rather than the JSON-on-stdin contract
every real hook entry point uses (the detached child has no stdin pipe). `cwd`/`sessionId` also travel as
`ARTISYN_PROMPT_UPLOAD_CWD`/`ARTISYN_PROMPT_UPLOAD_SESSION_ID` env vars and `prompt-upload-hook.js` reads argv first
with an env fallback — kept for cross-version compatibility with hooks &le; `2.5.1`, whose Windows VBScript launch
path carried env only (see `spawn-hidden.js`'s row above). The spawn is fire-and-forget — `telemetry-hook.js` never
awaits or reads a result, and it defers its own `process.exit(0)` by one `setImmediate` tick (negligible) so a spawn
failure surfaced asynchronously on the child's `'error'` event still reaches `hook.log`.

This is also the one detached script that shells out: `loadConfig()`/`getGitRoot()` fork `git.exe`. Because a
detached process has no console to inherit, that call **must** pass `windowsHide: true` or Windows allocates a fresh
visible console window for it (a visible console flash). Pinned by `__tests__/no-visible-window.test.js`.

### `prompt-upload-hook.js` (detached child, not a hook event)

Runs as a background process, scoped to exactly two files — `<telemetryDir>/<sessionId>.jsonl` (`artisyn`) and the
current session's Claude transcript file (same `getGitRoot` → slugify → `~/.claude/projects/<slug>/<sessionId>.jsonl`
resolution `send-logs-hook.js` uses) — no multi-session scan, no sub-agent/workflow discovery. Both files go through
`upload-logs.js`'s `uploadFileMaybeCompressed()`/`uploadFileChunked()`, gzipped and chunked automatically on exactly
the same terms as any other upload path.
Neither file is recorded in `.claude-logs.sent` — this path never reads or writes the manifest at all — so the
server's idempotent upsert absorbs the overlap with whatever the next Stop run re-uploads.

Three mechanisms bound its lifetime and prevent it from racing `send-logs-hook.js`:

- **Watchdog** — the first thing done after parsing argv/config: `setTimeout(() => process.exit(1), config.sendLogsOnPromptTimeoutMs)`
  (default `60000`ms), deliberately not `.unref()`'d so it can force-exit the process if the upload work hangs.
- **Shared upload lock** — `<telemetryDir>/.upload.lock` (JSON `{startedAt}`), acquired/released via `upload-logs.js`'s
  `acquireUploadLock()`/`releaseUploadLock()`, the same helper `send-logs-hook.js` now uses around its own `main()`
  (Stop/Interrupt path). If a non-stale lock is already held, the script logs a skip and exits 0 immediately without
  any file scanning or network I/O. Staleness window = `2 * sendLogsOnPromptTimeoutMs`, computed from config so both
  the watchdog and the lock-exclusion window move together.
- **Failure isolation** — any error (network failure, malformed config, missing file) is caught at the top level and
  logged via `hookLog(..., 'error', ...)`, then `process.exit(0)` — the same fail-open pattern every other hook script
  follows. Only the watchdog's own timeout is a deliberate non-zero exit (`process.exit(1)`).

### `SessionEnd` → `send-logs-hook.js` (hook `2.8.0`+)

`SessionEnd` runs **two** scripts: `lifecycle-hook.js` (writes the `SessionEnd` telemetry event, as before) and
`send-logs-hook.js`, which performs a **scoped flush** — `runSessionEndFlush()` uploads only the ending session's own
`artisyn` and `claude` files via `session-files.js`'s `collectScopedFiles()`. It is deliberately *not* the full
`runUpload()` scan: no multi-session sweep, no manifest write, no context-injection prepends, no `hook-status` event,
no otel prune — all of that stays on `Stop`/`Interrupt`.

**Why it exists.** `Stop` was the only trigger that ships a session's own `artisyn`/`claude` files, and it gave up
silently (`process.exit(0)`) whenever the shared upload lock was held. A `Stop` catch-up run in one session can hold
that lock for tens of seconds, so a second session ending inside that window stranded its final delta on disk until
some unrelated session happened to run a full scan later. The server-side consequence is not merely staleness: a
session whose uploaded artisyn body contains no `prompt_start` event gets `logs.first_prompt = NULL`, and the
repository session-list query filters on `first_prompt IS NOT NULL` — so the session exists in `sessions` but is
invisible in the UI. See `session-id-vs-sessionid.md` for the related id-vs-key distinction.

**Lock waiting (hook `2.8.0`+).** `upload-logs.js` gained `acquireUploadLockWithWait(telemetryDir, staleWindowMs,
maxWaitMs, pollIntervalMs)` — the plain `acquireUploadLock` retried on an interval until the budget runs out. Budgets
differ by event because the cost of waiting differs:

| Event | Lock budget | Rationale |
|---|---|---|
| `Stop` / `Interrupt` | `LOCK_WAIT_STOP_MS` = 2000ms | Blocks the interactive turn ("Uploading logs…"), and another trigger will follow. |
| `SessionEnd` | `LOCK_WAIT_SESSION_END_MS` = 20000ms | Blocks nothing, and is the session's last chance — giving up strands the files. |

Both poll at `LOCK_POLL_INTERVAL_MS` = 250ms. `maxWaitMs <= 0` degrades to exactly the old try-once behaviour.

Like `prompt-upload-hook.js`, the flush writes **no** `.claude-logs.sent` entry — the manifest records
what a *full* run has shipped, so a scoped flush claiming credit would make the next full run skip a file it never
really processed. The server's idempotent upsert absorbs the overlap.

`claude-subagent` and `claude-otel` are out of the flush's scope: sub-agent files are only discovered by the full
run's directory scan, and otel chunk files are collected unfiltered by *any* session's `Stop` run (every file in the
otel dir belongs to the project), so neither is at risk of being stranded by one session ending.

**Early-exit logging (hook `2.8.0`+).** `main()`'s unsupported-event and missing-`serverUrl`/`apiKey` paths now each
write one `hook.log` line naming the reason, instead of exiting silently. "`send-logs-hook.js` produced no `hook.log`
lines at all" is therefore no longer an ambiguous state — it now means the script never ran or crashed on `require`.

### `Stop` → `send-logs-hook.js`

Fires at the end of each assistant turn. Uploads four namespaces of log files to `POST /api/v2/logs` (hook `1.7.0`+; earlier hook versions post to `POST /api/v1/logs` — see `docs/knowledgebase/hook-api-versioning.md` for the version/route compatibility matrix):

| Namespace | Source path | Notes |
|---|---|---|
| `artisyn` | `TELEMETRY_DIR/<session_id>.jsonl` | Events from `telemetry-hook.js` |
| `claude` | `~/.claude/projects/<slug>/` | Claude Code's own session JSONL logs |
| `claude-subagent` | `~/.claude/projects/<slug>/<session>/subagents/*.jsonl` | Regular sub-agent session logs |
| `claude-subagent` | `~/.claude/projects/<slug>/<session>/subagents/workflows/<wf-id>/agent-*.jsonl` | Workflow agent logs (v1.2.0+) |
| `claude-otel` | `<telemetryDir>/otel/<session_id>/<epoch-ms>-<seq>.jsonl` | OTLP logs/metrics written by `otel-receiver.js`, one chunk file per inbound request (hook `2.4.0`+). Gated on `otelEnabled`; every file in that directory belongs to this project, so there is no filtering. See [otel-receiver.md](otel-receiver.md). |

`~/.claude` here (and for user-level skills, plugins and `settings.json`/`mcp.json`) means Claude Code's user config dir: `$CLAUDE_CONFIG_DIR` when that env var is set, else `~/.claude` — resolved by `claudeConfigDir()` in `hook/.claude/telemetry_tool/claude-config-dir.js` (hook `2.18.1`+). Earlier hooks always read `~/.claude`, so a user running Claude Code with `CLAUDE_CONFIG_DIR` got no `claude`/`claude-subagent` uploads at all.

Workflow agent files are in a nested `workflows/<wf-id>/` subdirectory under `subagents/`. Like regular sub-agent files, their `parentSessionId` is now derived from nested-linkage resolution (see "Sub-agent linking" below) rather than always being the main session; the server's recursive descendant lookup includes them in `session.totalCost` at any depth.

**Upload order (hook `2.14.0`+).** All namespaces are collected into one `filesToProcess`
list, then partitioned/uploaded in this order:

1. **The current session's own `claude`/`claude-subagent` files, first** — so a session being
   actively worked on (e.g. its Turn-End Cost Advisor / Session Attribution analysis, which needs
   the server to already have ingested this session's transcript) shows up promptly instead of
   waiting behind however large the backlog is. This is a pure reorder of the existing entries,
   not an extra pass: `otherEntries` is partitioned into `priorityEntries` (current-session
   `claude`/`claude-subagent`) and `remainder` (everything else, original relative order kept),
   then uploaded as `[...priorityEntries, ...remainder]`.
2. **Everything else in `remainder`** — every backlog session's `artisyn`/`claude`/`claude-subagent`
   files, and every `claude-otel` chunk (current session's included) — in the same relative order
   a single pass would produce. Because `claude-otel` entries are never pulled into
   `priorityEntries`, their relative order to each other is unchanged by this reorder — the
   namespace's own global write-order invariant (see below) still holds.
3. **The current session's own `artisyn` file, last, unconditionally** — unaffected by and
   unchanged by the priority reorder above; see the `hook-status` section below for why it must be
   deferred to the very end of the run.

**Deduplication:** a manifest file (`.claude-logs.sent`) tracks already-uploaded files by byte size. Files unchanged since last upload are skipped.

**`claude-otel` chunks are DELETED once uploaded (hook `2.13.0`+), never fingerprinted.**
A chunk is immutable by construction — `writeGroups()` in `otel-receiver.js` states it outright:
"one inbound OTLP request produces one file per session it carries, never an append to a shared
file", each written to a `.tmp` and renamed into place. So an uploaded chunk can only ever be
re-uploaded identically, which makes the local copy dead weight. `processFile()` therefore unlinks it
and removes its manifest entry, on **both** paths: after a successful upload, and in the skip branch
when an entry already records the chunk at its current size (which proves an earlier run uploaded
it — that entry is only ever written after success). The second path is what reclaims chunks left
behind by an older hook version; without it they would be skipped before reaching the delete and
would linger until `otelRetentionDays` expired them. The current session's chunks are included —
there is no live file being appended to. Measured on this repo: 31,748 chunks / 473 MB reclaimed and
the manifest fell from 35,036 to 3,262 entries, taking the warm run from 3.5 s to **1.7 s**.
`pruneOtelDir()` remains the safety net for what deletion cannot reach: zero-byte chunks (never
uploaded, since `listJsonlFiles` filters them out) and `.tmp` files abandoned by a killed receiver.

**Manifest pruning (hook `2.13.0`+).** After the scan, `pruneManifest()` drops every entry
whose file the scan did not see, so the store stays bounded — files really do disappear (otel
deletion above, retention, users deleting old transcripts), and since every write rewrites the whole
map, dead entries cost time on every run forever. It is a set difference, so it is gated on
`prunableNamespaces`: a namespace is only prunable once its root was actually enumerated
(`claude`/`claude-subagent` require at least one resolved project slug dir). Without that gate a
failed directory resolve would look like "this namespace is empty" and take thousands of entries with
it, re-uploading everything next run. Entries in an unrecognised namespace are always kept.

**Manifest write batching (hook `2.11.0`+).** `writeManifest()` serialises and rewrites the
WHOLE map (37k entries / 3 MB on the dev machine), so it must not run once per uploaded file — that
made the per-file cost scale with total history instead of with the file being uploaded. `runUpload()`
now routes every commit through `flushManifest()`, which writes on whichever comes first:
`MANIFEST_FLUSH_EVERY` (25) new entries or `MANIFEST_FLUSH_INTERVAL_MS` (1000 ms), plus a forced
flush once every manifest-writing upload has finished. Batched rather than deferred to the end on
purpose: a run that dies mid-way (hook timeout, sleep) must keep credit for what it already shipped,
or a large backlog never converges. The fingerprint is still only written *after* a successful
upload, so the worst case on a hard kill is a bounded number of redundant re-uploads — never a
skipped upload.

**Current-session manifesting (hook `2.8.0`+).** Every current-session file is recorded in the manifest
*except* `artisyn`. Omitting all current-session files would re-upload every one of them on every Stop:

| Namespace, current session | Manifest entry | Effect |
|---|---|---|
| `claude`, `claude-subagent`, `claude-otel` | written, holding the stat-time on-disk size | Claude Code appends `turn_duration` (and the receiver flushes late otel records) *after* the Stop hook fires, so the size changes and the next run re-uploads anyway. The comparison now skips only a transcript that genuinely did not change — which is the common case on a turn that touched few files. |
| `artisyn` | still omitted | Its uploaded body carries the context prepends and this run's `hook-status` event, none of which the on-disk size reflects. An unchanged size there would wrongly skip a body that differs on every run. |

Both the skip check and the manifest write use the same guard, `!(isCurrentSession && namespace === 'artisyn')`, so
the two can never drift apart.

**Chunked upload for large files (hook `1.8.0`+):** the upload primitives (`uploadFile()`, `uploadFileChunked()`,
`CHUNK_SIZE_BYTES`) live in the shared `upload-logs.js` module, required by both `send-logs-hook.js` and
`prompt-upload-hook.js`. `CHUNK_SIZE_BYTES` was lowered from 10MB to 900KB in hook `2.6.1` — see
`docs/knowledgebase/hook-api-versioning.md`'s "Known limitation" section for why (a reverse proxy in front of the
server can enforce its own body-size cap, commonly 1MB by default, independently of and below whatever the app
itself allows). For any file whose final body (after context-injection prepends) exceeds `CHUNK_SIZE_BYTES`,
`uploadFileChunked()` splits it into pieces and POSTs each sequentially to `POST /api/v2/logs`
with `uploadId`/`chunkIndex`/`totalChunks`/`totalSize` query params, reading `{complete}` from each response; the
caller only treats the file as uploaded once the final chunk's response reports `complete: true`. Files
`<=CHUNK_SIZE_BYTES` take the single-request path with no chunk params — this preserves old-hook
compatibility, since a server that doesn't recognize the chunk params simply behaves as before. That routing test
is always the **uncompressed** body size, so it does not depend on how well a given body happens to compress.

**Gzip transport (hook `2.8.0`+).** Every request body is gzipped by default, on both the single-request and
the chunked path, with `Content-Encoding: gzip` and a `Content-Length` equal to the compressed length. There is no
config key; the decision is made per request:

- **Loopback is skipped.** `isLoopbackServerUrl(serverUrl)` — `localhost`, `*.localhost`, `127.x.x.x`, `::1`,
  URL-parse only, no probing — sends plain, since compressing to a server on the same machine only burns CPU.
- **A compressed body that isn't smaller is not sent.** `uploadFileMaybeCompressed()` (the single-request wrapper
  both callers now use in place of a bare `uploadFile()`) reverts to the plain body when the gzip result is not
  strictly smaller, or would exceed `CHUNK_SIZE_BYTES`.
- **A peer that rejects gzip is remembered process-wide.** A `415`, or a `400` whose body matches none of the
  server's own validation messages, is classified by `isEncodingRejection()` and flips a module-level
  `gzipUnsupported` flag — this module's one deliberate exception to its no-module-level-state rule, because it
  records a capability of the *peer*, not per-project state. The rejected data is resent plain immediately and
  every later file in that process goes plain with no further rejected round-trip.
- **`CHUNK_SIZE_BYTES` is now the on-the-wire budget**, so one sub-900KB request carries several MB of NDJSON.
  `planCompressedSlices()` computes the whole split locally before chunk 0 (the server pins `totalChunks` there):
  predict an uncompressed slice length from a ratio × `0.8` safety margin, pull its end back to the nearest
  preceding `\n` via `alignSliceBoundary()` (which also refuses to split a UTF-8 character when a body has no
  newline at all), gzip it, and halve the prediction on overshoot up to 4 times before that one slice falls back
  to an uncompressed `identity` slice at budget size. `totalSize` and the server-side `upload_queue.size_bytes`
  keep counting **uncompressed** bytes, so nothing server-side changes meaning.
- **Ratio memory** — `<telemetryDir>/gzip-stat.json` (`{"ratio": <number>, "updatedAt": "<ISO>"}`, written after
  any plan that produced at least one gzip slice) seeds the next run's first prediction so it needs no warm-up
  shrinks. Missing, unreadable, malformed or outside `[1, 100]` → the `8.0` default; never fails an upload.
- **`413` means the budget, not the encoding** — the in-call wire budget is halved (floored at 128KB), the pending
  record discarded, a new `uploadId` minted and the file re-planned from chunk 0, at most twice per call.

Server-side both log-ingest routes accept a gzipped body either with the header or with it stripped by a proxy —
see `docs/knowledgebase/hook-api-versioning.md`'s gzip section and `inflateSniffedGzip` in
`docs/knowledgebase/server-endpoint-map.md`.

**Resumability — `.claude-logs.pending` (v2 JSON since hook `2.8.0`).** Same directory as `.claude-logs.sent`, but
a whole-file JSON document rather than one text line per upload, because a resumed run must replay the exact slice
boundaries the original `totalChunks` was derived from:

```json
{
  "version": 2,
  "entries": {
    "claude/1c2f….jsonl": {
      "uploadId": "0f1e…", "totalSize": 6291456, "totalChunks": 7, "nextChunkIndex": 3,
      "slices": [{ "s": 0, "e": 912345, "enc": "gzip" }]
    }
  }
}
```

`nextChunkIndex` is the next chunk **to send** (the pre-`2.8.0` line format stored the last *acked* index — the
semantics changed deliberately). The record is rewritten after each acked chunk and deleted on `complete: true`. A
resumed entry applies only when its `totalSize` matches the current body length, and it replays `slices` and
`totalChunks` verbatim, ignoring the remembered ratio — so a resume can never announce a different `totalChunks`
for a live `uploadId`. `readPendingUploads()` validates the document (`version === 2`, plain-object `entries`) and
each entry independently (non-empty `uploadId`, non-negative integer counters, `slices.length === totalChunks`,
`slices[0].s === 0`, last `e === totalSize`, contiguous offsets); anything failing is ignored and the upload starts
from chunk 0. A pre-`2.8.0` positional file fails `JSON.parse` and is dropped, never mis-parsed. If a resumed chunk
request comes back `400` (e.g. the server-side row was cleaned up), the hook discards the pending record and
restarts that one file's upload from `chunkIndex=0` with a fresh `uploadId` — this never aborts the rest of the run.

**Shared upload lock (hook `1.8.0`+):** `send-logs-hook.js`'s `main()` acquires `upload-logs.js`'s shared
`<telemetryDir>/.upload.lock` immediately after the `serverUrl`/`apiKey` presence check and before any file scanning,
releasing it in a `finally`. This keeps a Stop-triggered upload and a background `prompt-upload-hook.js` run (see
above) mutually exclusive — see `prompt-upload-hook.js`'s section for the lock's staleness/recovery mechanics, which
are identical for both callers.

**Context injection:** before uploading `artisyn` namespace files, several synthetic events are prepended: a `system-context` event (file sizes of all `CLAUDE.md` / `CLAUDE.local.md` files found in the project tree), `skill-definitions`, `agent-definitions`, and `mcp-config` events. `claude` and `claude-subagent` namespaces are uploaded as-is without modification. This metadata supports context analysis on the server.

**Since hook `2.12.0` these four events are reported at most ONCE PER SESSION, on the
current session's own `artisyn` body only** — a backlog session's log carries none of them. They
describe the HARNESS, not the session, and the server upserts them **per repository**
(`upsertHarnessElements(tx, repoId, …)` in `logs.service.ts`), skipping the upsert entirely when
they are absent rather than clearing what it knows — so attaching them to 2,399 old logs produced
one identical repo-level upsert 2,399 times, at 573 KB a copy (an 1,811-byte session log shipped as
581 KB; ~1.3 GB across the backlog).

Change detection is by **last-modified time**, in `harness-state.js`: the three file-based builders
already stat everything they describe and carry `lastModified` per entry, so the fingerprint costs
nothing beyond a walk that was happening anyway and never reads the 521 KB of skill bodies. mtime is
not a perfect oracle (a touch re-reports; an mtime-preserving edit does not) — accepted, since the
consequence is one redundant or one delayed catalog upsert, never wrong session data. MCP is
fingerprinted from the mtimes of `.mcp.json`, `~/.claude/mcp.json` and `~/.claude/settings.json`,
because `buildMcpConfig()` returns live probe results that no file mtime reflects.

The decision is **frozen for the session** at its first full upload run: a skill edited mid-session
is reported by the NEXT session, not by this session's next `Stop`. State lives in one JSON,
`.artisyn/ai_work_dir/harness-state.json` (`{version, fingerprint, decidedForSessionId, reported,
updatedAt}`), written temp-file + rename, and committed only **after** the upload carrying the
report succeeded — same commit-after-success rule as the manifest.

**Code-inventory injection (hook `2.16.0`+) — a FIFTH prepended event, on its OWN throttle.**
`send-logs-hook.js` also prepends
`{ type: 'code-inventory', projectRoot, trackedFiles, trackedLines, trackedBinaryFiles, commitSha,
branch, capturedAt }` when its own time window has elapsed. It is the **denominator** behind the
Change Surface report's two "share of the codebase touched" indicators (see
[`change-surface.md`](change-surface.md)), and it is deliberately **not** hung off the harness
fingerprint above:

- That fingerprint covers CLAUDE.md / skills / agents / MCP config, which on a working repo almost
  never change. An inventory gated on it would be measured once and then go stale for weeks while
  the codebase it describes grew — and a stale denominator silently skews every percentage computed
  from it. A plain **time window** is the right gate for a measurement of something that changes
  with every commit.
- There is no once-per-session rule either: the throttle is the only limit, so a session spanning
  several windows legitimately reports a fresh snapshot in each. The server keeps the *history*
  (`repo_code_inventory`) and each report divides by the newest snapshot at or before its own
  period end.
- State is its own file (`code-inventory-state.json`, keyed by project root) and is committed only
  **after** the upload carrying the snapshot succeeded — the same commit-after-success rule the
  manifest and `harness-state.json` use.

The measurement itself (`code-inventory.js`) is **one** git call —
`git diff --numstat <EMPTY_TREE_SHA> HEAD` — which reads the object store rather than the working
tree, is git-tracked-only by construction, and needs no per-file reads (~0.6 s on a 1,700-file
repo). `git ls-files` is deliberately not used: it reports the *index*, which would disagree with
the line total's HEAD basis. A repo that cannot be measured (no git, not a repository, or the usual
case of no commits yet) yields `null` and **no event at all** — the report then renders
`n/a · denominator unavailable` rather than a codebase of zero files that would make every
percentage `Infinity` or `0 %`.

**Do not move the build back inside the per-file loop.** `buildMcpConfig()` spawns every stdio MCP
server and waits for an `initialize` + `tools/list` handshake, sequentially, bounded by
`mcpProbeTimeoutMs` each — measured at 4,690 ms for 4 servers, and it was paid per uploaded file.
That put upload lines in `hook.log` exactly 4.7–4.9 s apart and turned 2,399 artisyn files into a
~188-minute run that never once reached its own `done:` line. The build is also **lazy**, so a run
with nothing to report spawns no probe at all. Pinned by the `per-run context prepends` tests
in `__tests__/send-logs-hook.test.js`.

**`mcp-config`'s live `tools/list` probe (hook `2.7.0`+):** for each server declared in
`.mcp.json` / `~/.claude/mcp.json` / `~/.claude/settings.json` with a `command` (stdio transport
only — `url`/SSE-based servers are out of scope and keep `connected`/`tools` `undefined`, same as
an old hook), `buildMcpConfig()` calls `probeMcpServerTools(name, cfg, mcpProbeTimeoutMs)`
**sequentially, one server at a time** (bounds added latency to `mcpProbeTimeoutMs × serverCount`,
default `3000`ms per server, configurable via `env-context.js`'s `mcpProbeTimeoutMs` option): spawn
`cfg.command` with `cfg.args`, write a JSON-RPC `initialize` request followed by `tools/list` to
its stdin (newline-delimited JSON, MCP's stdio transport), read stdout until the matching
`tools/list` response arrives or the timeout fires, then kill the process. Any failure (spawn
error, timeout, malformed response) resolves `{connected: false, tools: []}` rather than throwing
— fail-open, exactly like every other hook capability. A successful probe adds
`connected: true` and `tools: [{name, schemaSizeTokens}]` to that server's `mcp-config` entry,
where `schemaSizeTokens = Math.round(JSON.stringify({name, description, inputSchema}).length /
MCP_SCHEMA_CHARS_PER_TOKEN)` — a deliberately coarse, fixed `÷4` estimate (`MCP_SCHEMA_CHARS_PER_TOKEN`
in `send-logs-hook.js`), distinct from the per-model `chars_per_token` ratios in
`token-byte-ratio.md` that drive token estimation everywhere else.

The `mcp-config` event also gains a top-level `perToolDetailSupported: true` flag whenever this
probe code ran at all (regardless of whether any individual server connected) — see
`hook-api-versioning.md`'s `perToolDetailSupported` section for the exact backward-compatibility
contract this flag exists to provide. Server-side: `extractHarnessMcpInventory()`
(`artisyn-extractor.ts`) reads the extended shape; `harness-elements-writer.ts` upserts `mcp`- and
MCP-sourced `tool`-kind rows into `harness_elements`; see `docs/knowledgebase/db-tables.md`.

**Sub-agent linking (v1.5.0+):** Claude Code can spawn agents that themselves spawn further agents (orchestrator → chunk-agent → research-agent, 3+ levels). For each sub-agent file (regular or workflow), the hook reads the sibling `<agent-id>.meta.json` and extracts `parentAgentId`; when present, the upload's `parentSessionId` query param is set to `agent-<parentAgentId>` — the true immediate spawning session/agent, not always the root. When `.meta.json` is missing, has no `parentAgentId` (older Claude Code versions, or a true depth-1 agent), or fails to parse, the hook falls back to the previous behavior (`parentSessionId = <main-session-id>`) — fail-open, per this hook's design principles. The server links child sessions to their parent via `sessions.parent_session_id`, using a recursive (any-depth) descendant query rather than a single-level match, since a grandchild's `parent_session_id` now points at its direct parent agent, not the root.

**Workflow linking (v1.6.0+):** for workflow-subdir agent files only (the `subagents/workflows/<wf-id>/` namespace above), the upload also sets a `workflowRunId` query param to `wfDir.name` (the wf-id folder name, e.g. `wf_b4978a0b-2af`), alongside the existing `parentSessionId`. Regular (non-workflow) sub-agent uploads never send this param. The server stores it on `sessions.workflow_run_id` and uses it to resolve `WorkflowRun.agentSessionIds` — the full multi-level agent linkage for each completed `Workflow` tool run — independently of the `parentSessionId`-driven nesting tree (both columns can be set on the same row).

Exits 0 even on upload failure — never blocks Claude Code.

**`hook-status` synthetic event (v1.4.0+, Hook State Panel):** every `artisyn` upload of the **current session's own** file (not other sessions' files, and not a separate upload) gets one additional synthetic event prepended, after every other file in this run has been processed so the event can report this run's own outcomes:

```json
{
  "type": "hook-status",
  "hookVersion": "1.4.0",
  "timestamp": "2025-01-15T10:23:00.000Z",
  "logTail": ["2025-01-15T10:22:58.000Z [send-logs-hook.js] [abc123] [result] ..."],
  "nonUploadableLogs": [{ "file": "/path/to/some.jsonl", "reason": "timeout after 10000ms (size=42.0MB)" }],
  "recommendations": [{ "rule": "timeout-on-upload", "message": "Log uploads are timing out — consider raising sendLogsTimeoutMs in .artisyn/config/log-hub.local.json", "detectedAt": "2025-01-15T10:23:00.000Z" }]
}
```

- `hookVersion` — from `hook-log.js`'s `getHookVersion()` (reads `version.json`, cached).
- `logTail` — last 50 non-empty `hook.log` lines via `readLogTail(cwd, 50)`.
- `nonUploadableLogs` — `{file, reason}` for every file that failed to upload *in this run only* (not accumulated across runs).
- `recommendations` — the current contents of `.artisyn/ai_work_dir/hook-recommendations.json` via `recommendations.js`'s `readRecommendations(cwd)`.
- Server-side: extracted by `extractHookStatus()` (`server/src/logs/artisyn-extractor.ts`) and applied to the linked `repositories` row(s) by `logs.service.ts`'s `upsert()` on every artisyn upload that contains this event — see `docs/knowledgebase/db-tables.md`'s `repositories.hook_*` columns. Trade-off: if this specific upload itself fails (e.g. times out), the status report for this run is lost until the next successful `Stop` event for that session/repo — accepted, consistent with the hook's fail-open design.

**`recommendations.js` — upsert-by-rule semantics:** `upsertRecommendation(cwd, { rule, message, detectedAt })` reads `.artisyn/ai_work_dir/hook-recommendations.json` (`readRecommendations`, returns `{ recommendations: [] }` on a missing/corrupt file), replaces the entry with a matching `rule` **in place** (or appends if the rule hasn't fired before), and writes the file back. This means each distinct rule ever contributes at most one entry to the array — e.g. two files timing out in the same run still produce a single `timeout-on-upload` recommendation, not two. Extensible: any future misconfiguration check just calls `upsertRecommendation` with a new `rule` value.

**`SEND_LOGS_TIMEOUT_MS` misconfiguration check:** `send-logs-hook.js` reads the raw `SEND_LOGS_TIMEOUT_MS` env value; if it's non-empty and `parseInt(raw, 10)` is `NaN`, it logs a `hookLog(..., 'error', ...)` line naming the bad value and falls back to the 10000ms default (the value is never silently swallowed). Separately, when an upload fails with a timeout (`reason` starting with `"timeout after"`), the `timeout-on-upload` recommendation above is triggered — this is the only misconfiguration currently detected, since `SEND_LOGS_TIMEOUT_MS` is the only numeric env var `send-logs-hook.js` reads.

**`broken-upload-file` recommendation (hook `1.7.0`+):** `uploadFile()`'s `201` response handler buffers the response body (same 2000-byte cap as the failure-branch snippet) and `JSON.parse`s it, fail-open to `{ warnings: [] }` on any parse error. `POST /api/v2/logs` returns `{ warnings: string[] }` — one message per row the server's async upload queue found stuck in `status = 'failed'` for the calling user since the last check (see `docs/knowledgebase/hook-api-versioning.md`). `processFile()` forwards `warnings` through to its own return value, and `main()` collects every `result.warnings` across both the `otherEntries` and `currentArtisynEntries` upload loops into one `allWarnings` array. After the loop completes: if `allWarnings.length > 0`, `upsertRecommendation(cwd, { rule: 'broken-upload-file', message: allWarnings.join('; '), detectedAt })` is called; otherwise `removeRecommendation(cwd, 'broken-upload-file')` clears any previously recorded warning — the same upsert/clear pattern `timeout-on-upload` uses. `POST /api/v1/logs` (used by hook versions before `1.7.0`) always returns an empty body, so older hooks never see or act on this recommendation.

## OTEL receiver

Since hook `2.3.0`, `otel-receiver.js` is a detached loopback OTLP/JSON listener — one per project, on
its own port — that files Claude Code's OTEL logs and metrics as per-session chunk files under
`<telemetryDir>/otel/`. The `Stop` upload ships them as the `claude-otel` namespace and deletes each
chunk once uploaded. The spawn/register handshake, the `409 owner-mismatch` guard, the stale-receiver
restart, the chunk layout and the prune are described in [otel-receiver.md](otel-receiver.md).

---

## Telemetry Storage

JSONL files are written to `TELEMETRY_DIR` (default: `<project_root>/.artisyn/ai_work_dir/telemetry`). One file per session, named `<session_id>.jsonl`.

OTEL records live one level down, in `<TELEMETRY_DIR>/otel/` (hook `2.3.0`+) — one directory per session holding one chunk file per inbound request (`<session_id>/<epochMs>-<seq>.jsonl`, see [otel-receiver.md](otel-receiver.md)), written by `otel-receiver.js` rather than by a hook event, plus a non-uploaded `receiver.log` diagnostics file. Since `listJsonlFiles()` is top-level-only, the two sets never mix.

Five non-uploaded sidecar files live alongside them in `TELEMETRY_DIR`, all owned by the upload paths and all
safe to delete (each is re-created, and a missing/corrupt one only costs work, never correctness):

| File | Written by | Contents |
|---|---|---|
| `.claude-logs.sent` | `send-logs-hook.js` | Upload manifest — `<manifestKey> <byteSize>` per uploaded file |
| `.claude-logs.pending` | `upload-logs.js` | In-progress chunked uploads. Whole-file JSON (`{version: 2, entries: {…}}`) since hook `2.8.0`; a pre-`2.8.0` positional file is ignored, not mis-parsed |
| `gzip-stat.json` | `upload-logs.js` (hook `2.8.0`+) | `{"ratio": <number>, "updatedAt": "<ISO>"}` — the last observed compression ratio, seeding the next run's slice-size prediction |
| `.upload.lock` | `upload-logs.js` | `{ startedAt: <ISO> }` — mutual exclusion between the Stop-triggered and prompt-triggered upload paths |
| `<session_id>.jsonl.lock` | `write-telemetry.js` (hook `2.17.4`+) | Empty; exists only for the duration of one append. Serializes concurrent hook processes appending to the same session `.jsonl` — on WSL `/mnt/<drive>` (DrvFs/9p) and network shares `O_APPEND` is not atomic across processes, and two same-offset writes left torn lines. Created with `wx`; waited on for ≤3s, then the append goes ahead unlocked (never blocks telemetry); broken as stale after 2s |

Event types written locally:
- `prompt_start` — on every user prompt (from `telemetry-hook.js`)
- `type: 'artisyn'` events — from `lifecycle-hook.js`; `hook_event_name` is one of: `PostToolUse`, `PostToolUseFailure`, `SessionStart`, `SessionEnd`, `PermissionRequest`, `PermissionDenied`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `PostToolBatch`, `StopFailure`
- `type: 'code-inventory'` — the tracked-file/tracked-line snapshot prepended by `send-logs-hook.js` on its own throttle (hook `2.16.0`+); see "Context injection" above

**`PostToolUse` payload change (hook `2.16.0`+).** The event carries the call's
IDENTITY (`tool_name`, `tool_input`, `tool_use_id`, `agent_id`, `agent_type`) plus, for
`Edit`/`Write`/`MultiEdit` only, a small derived `edit_result: { filePath, added, removed,
changeKind }` — never the tool's own output. The old `tool_result` field is **retired**: it was
built from `input.tool_result`, a key that has never existed on a Claude Code payload (the real
one is `tool_response`), so it shipped as `""` on every event this hook has ever written. It was
not simply repointed at the right key because that payload holds file contents, patch text and
command output, while the metric needs four derived numbers, not the bytes. `edit_result` is the
**only** source of `+`/`−` and change kind for workflow-agent transcripts, whose `toolUseResult`
is never usable; when it is absent the call stays *uncovered* server-side rather than being
recorded as a confident zero-line change.

---

## Diagnostic Log

All hook activity is appended to `<project_root>/.artisyn/ai_work_dir/hook.log`:

```
2025-01-15T10:23:00.000Z [telemetry-hook.js] [abc123] [activate] UserPromptSubmit [hook v1.2.0]
2025-01-15T10:23:00.012Z [telemetry-hook.js] [abc123] [result] prompt_start written
```

Format: `<ISO-timestamp> [<file>] [<session_id>] [<event>] <message> [hook v<version>]`

Event types in log: `activate`, `result`, `error`, `fail` (send-logs only).

Two `send-logs-hook.js` line formats changed in hook `2.8.0`:

- **One line per run, always.** Every `main()` early exit now writes an `exit: …` message naming the reason and the
  `logDir=` it wrote into (unreadable/non-JSON stdin, a `hook_event_name` outside `Stop`/`Interrupt`/`SessionEnd`, a
  missing `serverUrl`/`apiKey`, and the top-level `exit: unhandled error: …` catch); the `activate` line carries the
  same `logDir=` marker. *No* line at all therefore now means the script never ran — bad wiring, a `require` crash,
  or an unwritable log dir — rather than being indistinguishable from a silent early exit.
- **Two-count result lines.** `<key>: uploaded 5760 KB → 576 KB gz (10.0x) in 7 requests` for a compressed upload,
  `<key>: uploaded 880 KB uncompressed in 1 request` otherwise, with ` [gzip fallback]` appended when a rejected
  gzip body forced the plain retry. Both upload paths render them identically.

---

## Design Principles

- **Fail-open** — hooks always exit 0; no hook failure can block Claude Code
- **No external deps** — only Node.js 18+ built-ins (`fs`, `path`, `child_process`, `http`, `https`, `os`, `zlib`)
- **Transparent code only** — everything the hook ships must be plain, human-readable JavaScript that a user can open and audit in the installed plugin folder. No compiled or opaque artifacts: no native binaries/executables (Rust, Go, C, …), no `.node` addons, no WASM, no minified/obfuscated or bundled blobs. The hook runs on users' machines with access to their repos and session transcripts, so users (and their security teams / AV) must be able to see exactly what it does. Performance-motivated native code (e.g. a Rust JSONL analyzer) belongs on the **server** side, never in the hook
- **Git-rooted paths** — config and telemetry resolve against the repo root, not session cwd, so subdirectory sessions behave the same
- **Manifest deduplication** — avoids re-uploading unchanged log files on repeated Stop events
- **Multi-format path normalisation** — handles Windows, WSL, and Git Bash path formats uniformly
- **Secrets in `log-hub.local.json`** — `apiKey` lives in a gitignored file (`.artisyn/config/log-hub.local.json`); base `.artisyn/config/log-hub.json` is safe to commit
