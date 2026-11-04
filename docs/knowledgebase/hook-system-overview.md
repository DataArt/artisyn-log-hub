---
type: "Architecture Guide"
title: "Hook System Overview"
description: "Current behaviour of the Claude Code hook: where its source lives versus the installed and dogfooded copies, event wiring, the non-obvious scripts, path resolution, the upload pipeline (namespaces, manifest, lock, chunking/gzip, injected lines), local files and the design rules (fail-open, transparent code, every Node.js LTS, CommonJS)."
tags:
  - hooks
  - otel
timestamp: "2026-11-03T00:00:00+04:00"
---

# Hook System Overview

The Log Hub hook is a set of plain Node.js scripts wired into Claude Code's hook events. It
records telemetry about each session and uploads the session's logs to the Log Hub server. It is
monitoring only: it never blocks a tool call and never returns a permission decision.

This article describes **current behaviour**. Which hook version introduced what, and what an old
hook still installed on a user's machine does, is in [hook-api-versioning.md](hook-api-versioning.md)
(compatibility matrix and § "Hook-side behaviour history"). Install / config keys:
[hook-installation.md](hook-installation.md). OTEL receiver: [otel-receiver.md](otel-receiver.md).

---

## Where the code lives — edit the source, not the installed copy

| Location | What it is |
|---|---|
| `hook/.claude/telemetry_tool/` | **The source of truth.** Every hook script, `version.json`, and the algorithm tests (`__tests__/*.algo.test.js`, run by `npm test` in `hook/`). Edit only here. |
| `scripts/build-hooks-installer.js` | Builds the plugin from that source: copies the files in its explicit `HOOK_JS_FILES` list (a module missing from the list would ship an install that dies with `MODULE_NOT_FOUND`, so `assertHookFilesComplete()` fails the build on drift), **generates** `hooks/hooks.json` from its `HOOKS_JSON` constant (there is no hand-written `hooks.json` in the source; its event list is checked against `hook/INSTALL_HOOK.md`), writes `.claude-plugin/plugin.json`, `config-template/log-hub.json` and `scripts/package.json`. Run via `npm run build:hooks-installer`. |
| `artisyn-hooks-installer/` | The installer package (TypeScript). Its version tracks the bundled hook version; some hook modules have TS twins here (`user-state.ts`, `managed-settings.ts`). Tarballs go to `server/src/public/static/` (gitignored) and are served by the installer download route. |
| `<user repo>/.artisyn/marketplace/plugins/log-hub-hooks/` | The **installed** plugin: `scripts/` (the source files), `hooks/hooks.json`, `.claude-plugin/plugin.json`, `config-template/`. Paths that hook logs and `hook.log` lines print (`scripts/…`) are these. |
| This repo's `.artisyn/marketplace/plugins/log-hub-hooks/` | This repo **dogfoods** its own install: a git-tracked installed copy, loaded via `.claude/settings.json` `enabledPlugins`. The build does not refresh it — copy changed files and bump `plugin.json` by hand (steps in `.claude/rules/hook.md`). |
| `hook/HOW_HOOK_WORKS.md`, `hook/INSTALL_HOOK.md`, `hook/README.md` | Shipped, user-facing docs (offline-first: they must stay self-contained). `HOW_HOOK_WORKS.md` has the per-event payloads, config reference and upload mechanics in user terms; keep it in sync via the `update-install-instructions` skill. |

Project config lives outside the plugin tree: `.artisyn/config/log-hub.json` (tracked) and
`log-hub.local.json` (gitignored, per developer: `apiKey`, `serverUrl`, …). Every hook change bumps
`version.json`; the hook API must stay backward compatible because installed hooks upgrade late.

---

## Event wiring

The authoritative wiring is `HOOKS_JSON` in `scripts/build-hooks-installer.js` (exec form
`{"type":"command","command":"node","args":["${CLAUDE_PLUGIN_ROOT}/scripts/<script>.js"]}`).

| Event(s) | Script | Does |
|---|---|---|
| `UserPromptSubmit` | `telemetry-hook.js` | Writes `prompt_start`; throttled spawn of the background upload; re-arms the OTEL receiver |
| `PreToolUse` (matcher `PowerShell`) | `tool-wrap-powershell.js` | Prefixes a PowerShell command that mentions a monitored CLI tool with a logging wrapper (`updatedInput`). Not a guardrail: no permission decision, exits 0 with no output on any failure. See [tool-monitoring.md](tool-monitoring.md) |
| Lifecycle events (`SessionStart`, `SessionEnd`, tool, permission, sub-agent, compaction, `PostToolBatch`, `StopFailure`) | `lifecycle-hook.js` | Writes `type: 'artisyn'` events; at `SessionStart` also spawns the OTEL receiver, generates the tool-wrap Bash shims and runs the OTEL config checks |
| `Stop` | `send-logs-hook.js`, then `post-turn-analysis-hook.js` | Full upload run; post-turn advisor / attribution ([turn-end-cost-advisor.md](turn-end-cost-advisor.md)) |
| `SessionEnd` | `lifecycle-hook.js` + `send-logs-hook.js` | Event, then a scoped flush of the ending session |

Detached processes that are **not** hook entry points: `prompt-upload-hook.js` (background
upload), `otel-receiver.js` (long-lived loopback OTLP receiver), `tool-wrap-tee.js` (stdout tee of
a wrapped CLI tool), `post-turn-analysis-worker.js`, and `otel-ensure-receiver.js` (a user-level
`SessionStart` hook the installer copies to `~/.artisyn/otel/bin/` in `proxy` mode only).

There was once a `PreToolUse` guardrail (`guardrail-hook.js`, `guardrail*` config keys). It is
gone; leftover `guardrail*` keys in `log-hub.json` are ignored but deliberately **not** removed by
the installer — an older hook reading a config without them would fall back to its guardrail-on
defaults.

---

## Scripts worth knowing about

The rest of `hook/.claude/telemetry_tool/` is named for what it does — list the folder. These carry
rules you would not guess:

- **`spawn-hidden.js`** — `spawnDetachedHidden()`: one `spawn(…, {detached: true, stdio: 'ignore',
  windowsHide: true})` on every platform; `detached` (→ `DETACHED_PROCESS`) is what guarantees no
  console on Windows. A former Windows path ran a self-deleting VBScript via `wscript.exe` from
  `%LOCALAPPDATA%\Temp`; it was **dropped because EDR flagged it as malware** (several
  commodity-loader indicators at once), and the console flash it was meant to fix actually came
  from *grandchild* processes that omit `windowsHide`. Hence the rule: every `child_process` call
  inside a detached script (e.g. `git` from `loadConfig()` / `getGitRoot()`) **must** pass
  `windowsHide: true`. Only `spawn-hidden.js` is pinned by a test (scenario `s-hook-09`, "no
  visible window"); the `git-context.js` calls are not. Detached children still receive every
  parameter both as argv and as an env var (`ARTISYN_OTEL_*`, `ARTISYN_PROMPT_UPLOAD_*`) for
  compatibility with old hooks whose launch carried env only.
- **`process-marker.js`** — `buildProcessMarkerEnv()` stamps `ARTISYN_PROC_*` provenance env vars
  into every spawned child (inert metadata, never branched on). `killProcessTree(child)` is the
  **mandatory** replacement for `child.kill()` on any `shell: true` child: on Windows that child is
  a `cmd.exe` wrapper and the real program its grandchild, so a plain kill orphaned MCP servers and
  timed-out `claude -p` calls for days. It is wired into `spawnDetachedHidden()` centrally. Windows
  does not expose another process's environment via `Win32_Process`; on Linux/macOS
  `/proc/<pid>/environ` shows the markers.
- **`write-telemetry.js`** — appends one JSON line. **Suppressed entirely when
  `ARTISYN_HOOK_SERVICE` is set**: the hook's own `claude -p` evaluation sessions inherit that env
  var and run the full hook set; without suppression each recorded a full session of itself (57.7 %
  of all artisyn files on a measured dev machine) that would then be uploaded and classified. So an
  evaluation session produces no artisyn file at all. Appends take a `<session_id>.jsonl.lock`
  (`wx`) because on WSL `/mnt/<drive>` and network shares `O_APPEND` is not atomic across
  processes; the wait is bounded and the append goes ahead unlocked after it (telemetry is never
  blocked).
- **`scripts/package.json` = `{"type": "commonjs"}`** (written by the build). The plugin runs from
  inside the user's repo and Node takes a `.js` file's module type from the nearest
  `package.json`; without it, a repo whose root says `"type": "module"` killed every hook with
  `require is not defined in ES module scope` and nothing was recorded.
- **`hook-log.js`** — `hook.log` writer, `getHookVersion()`, and `exitIfSelfCheck()`: every entry
  script calls it right after its requires, so `node <script> --self-check` loads the whole module
  graph and exits 0 — the installer's post-install load check.
- **`otel-receiver.js`** deliberately `require`s no other hook module; every parameter is passed
  in. **`otel-ensure-receiver.js`** is standalone too. Details: [otel-receiver.md](otel-receiver.md).
- **Twins** that must change together: `tool-wrap-names.js` ↔ `packages/tool-monitor`
  ([algorithms/tool-monitor-name-validation.md](algorithms/tool-monitor-name-validation.md));
  `user-state.js` / `managed-settings.js` ↔ the installer's `user-state.ts` / `managed-settings.ts`;
  the hook's own plain-JS cost copy ↔ `@loghub/pricing` ([repo-local-packages.md](repo-local-packages.md)).
- **`code-inventory.js`** — one `git diff --numstat <EMPTY_TREE_SHA> HEAD` (object store, tracked
  files only, HEAD basis; `git ls-files` is deliberately not used because it reports the index).
  An unmeasurable repo (no git, no commits) returns `null` → **no event**, so the report shows
  "n/a" instead of dividing by zero.
- **`edit-result-counts.js`** — derives `{filePath, added, removed, changeKind}` for
  `Edit`/`Write`/`MultiEdit` **on the machine**; `structuredPatch`, `originalFile` and every other
  tool result stay local and are never uploaded. `PostToolUse` carries the call identity plus this
  `edit_result`, never the tool's output. It is the only source of `+`/`−` for workflow-agent
  transcripts; when absent the call stays *uncovered* server-side, never a confident zero.
- **`otel-status.js`** — effective OTEL scope and the `otel-status` event rules:
  [algorithms/otel-status-reason.md](algorithms/otel-status-reason.md).

---

## Path resolution

- **Repo root from `git rev-parse --git-common-dir`**, never `${CLAUDE_PLUGIN_ROOT}` (that points
  into `~/.claude/plugins/cache/` and changes on every plugin update). So a session opened in any
  subdirectory, or inside a **linked worktree**, resolves to the main repo root. Config, telemetry
  dir and `ai_work_dir` hang off it.
- The **worktree root** (`--show-toplevel`) is resolved too and uploaded as `git.worktreeRoot`
  next to `git.root`; without it, every path in a worktree session would classify as out-of-repo.
- **`ARTISYN_PROJECT_ROOT` override** (`project-root-override.js`): when set to a non-blank
  directory **and** the hook's `cwd` is inside it, that directory replaces the `--git-common-dir`
  root everywhere (config, `ai_work_dir`, transcript slug, OTEL owner, code inventory, `git.root`).
  The Claude sandbox launcher sets it because the main checkout is not mounted
  ([docker-dev-container.md](docker-dev-container.md)). The cwd-inside rule keeps child processes
  in unrelated repos (test fixture repos) unaffected even when the variable is set container-wide.
- **`~/.claude` means `claudeConfigDir()`** (`claude-config-dir.js`): `$CLAUDE_CONFIG_DIR` when set,
  else `~/.claude` — for transcripts, user skills, plugins and settings. Never hard-code `~/.claude`.
- Windows, WSL and Git Bash path formats are normalised uniformly.

---

## Upload pipeline

All uploads go to `POST /api/v2/logs` (contract: [hook-api-versioning.md](hook-api-versioning.md);
server side: [upload-queue.md](upload-queue.md)). `send-logs-hook.js` exits 0 even when uploads
fail.

### Namespaces

| Namespace | Source | Notes |
|---|---|---|
| `artisyn` | `<telemetryDir>/<session_id>.jsonl` | The hook's own events, plus lines injected at upload (below) |
| `claude` | `<claudeConfigDir>/projects/<slug>/<session>.jsonl` | Claude Code transcripts, uploaded **as is** — never augmented |
| `claude-subagent` | `…/<session>/subagents/*.jsonl` and `…/subagents/workflows/<wf-id>/agent-*.jsonl` | `parentSessionId` = `agent-<parentAgentId>` from the sibling `<agent-id>.meta.json` (any nesting depth), falling back to the main session when the meta is missing; workflow agents also send `workflowRunId` = the `<wf-id>` folder name. Since `2.31.0` the same `.meta.json` read (`readAgentMeta`, one read per agent, fail-open) also gives `agentDescription` (its `description`) and `workflowPhase`, sanitised (`sanitizeAgentMeta`: trimmed, empty dropped, cut to 255 code points) and sent as query params only when non-empty, on the plain upload and every chunk — see [hook-api-versioning.md](hook-api-versioning.md) § "agentDescription / workflowPhase" |
| `claude-otel` | `<telemetryDir>/otel/<session_id>/<epochMs>-<seq>.jsonl` | One immutable chunk per inbound OTLP request; gated on `otelEnabled`; collected unfiltered |
| `tool-calls` | `<workDir>/tool-wrap/upload/<session_id>.jsonl` | Assembled by `tool-wrap-records.js` just before upload; the whole cumulative set is re-sent each time (the server keeps one per session) |

### Order within a `Stop` run

1. The current session's own `claude` / `claude-subagent` files first — the post-turn analysis
   needs the server to have this transcript already, so it must not wait behind a backlog.
2. Everything else in original relative order (backlog sessions, all `claude-otel` chunks — their
   global write order must be preserved).
3. The current session's own `artisyn` file **last**, because its `hook-status` line reports this
   run's own outcomes.

### Manifest (`.claude-logs.sent`) — dedup by byte size

- Files whose size equals the manifest entry are skipped. The entry is written only **after** a
  successful upload (worst case after a kill: a redundant re-upload, never a skipped one).
- The **current session's `artisyn` file is never manifested**: its uploaded body carries
  injected lines that the on-disk size does not reflect. The skip check and the write share one
  guard so they cannot drift. Other current-session files are manifested — Claude Code appends
  `turn_duration` after `Stop`, so a real change still re-uploads.
- **`claude-otel` chunks are deleted once uploaded**, never fingerprinted (a chunk is immutable,
  so the local copy is dead weight) — both after a successful upload and when a manifest entry
  already proves an earlier upload (that reclaims chunks left by older hooks). `pruneOtelDir()`
  stays as the safety net for zero-byte chunks and abandoned `.tmp` files.
- **Manifest pruning** drops entries whose file the scan did not see, but only for namespaces whose
  root was actually enumerated (`prunableNamespaces`) — otherwise a failed directory resolve would
  look like "empty" and wipe thousands of entries, re-uploading everything next run.
- **Write batching** (`flushManifest()`, `MANIFEST_FLUSH_EVERY` / `MANIFEST_FLUSH_INTERVAL_MS`):
  the whole map is rewritten on every write, so per-file writes made cost scale with history.
  Batched rather than deferred to the end so a run killed mid-way keeps credit for what it shipped.

### Concurrency and triggers

- **Shared lock** `<telemetryDir>/.upload.lock` (`acquireUploadLockWithWait()` in `upload-logs.js`)
  keeps `Stop`, `SessionEnd` and the background upload mutually exclusive. Wait budgets differ on
  purpose: `LOCK_WAIT_STOP_MS` is short (it blocks the interactive turn, and another trigger will
  follow); `LOCK_WAIT_SESSION_END_MS` is long (it blocks nothing and is the session's last chance).
- **Background upload on `UserPromptSubmit`** (`sendLogsOnPromptEnabled`): throttled by
  `PROMPT_UPLOAD_THROTTLE_MS` via `<workDir>/prompt-upload-throttle.json`, whose timestamp is
  written **before** spawning so a burst of prompts cannot all pass. The child gets `--cwd` /
  `--sessionId` on argv (a detached child has no stdin). It uploads only the current session's
  `artisyn` + `claude` files (`session-files.js`), has a watchdog
  (`sendLogsOnPromptTimeoutMs`, deliberately not `unref`'d), skips if the lock is held, and writes
  **no** manifest entries.
- **`SessionEnd` scoped flush** (`runSessionEndFlush()`): uploads only the ending session's own
  files, no sweep, no manifest, no injected lines except `otel-status`. Why it exists: a `Stop`
  in another session can hold the lock for tens of seconds; a session ending inside that window
  used to strand its final delta. A session whose artisyn body lacks `prompt_start` gets
  `logs.first_prompt = NULL` and is **invisible** in the session list — not just stale.

### Chunking, gzip, resume

Details and their server contract: `hook/HOW_HOOK_WORKS.md` § "Upload mechanics" and
[hook-api-versioning.md](hook-api-versioning.md). The rules that bite:

- `CHUNK_SIZE_BYTES` is the **on-the-wire** budget per request, kept well under 1 MB because a
  reverse proxy in front of the server can enforce its own body cap below the app's
  (hook-api-versioning § "Known limitation"). Whether a file is chunked is decided on the
  **uncompressed** size; small files take the single-request path with no chunk params (old-server
  compatible).
- Gzip is on by default, skipped for loopback servers and when it is not smaller. A peer that
  rejects gzip (`415`, or a `400` that matches none of the server's validation messages) flips a
  process-wide `gzipUnsupported` flag — `upload-logs.js`'s one deliberate piece of module-level
  state, because it records a capability of the *peer*. So the server must keep size errors as
  `413` and gzip errors as `400 Malformed gzip request body`.
- The whole slice plan is computed before chunk 0 because the server pins `totalChunks` there.
  `.claude-logs.pending` (whole-file JSON, `version: 2`) replays slice boundaries verbatim on
  resume; anything invalid restarts the file from chunk 0 with a fresh `uploadId`. `totalSize` and
  `upload_queue.size_bytes` count **uncompressed** bytes.

### Lines injected into the current session's `artisyn` upload

Backlog sessions get none of these.

- **`hook-status`** — hook version, `hook.log` tail, this run's non-uploadable files and the
  recommendations from `.artisyn/ai_work_dir/hook-recommendations.json` (upsert-by-`rule`, e.g.
  `timeout-on-upload`, `broken-upload-file` from the response `warnings`). Feeds the Hook State
  panel. If this upload fails, that run's status is lost until the next `Stop` (accepted).
- **Harness snapshot** (`harness-snapshot.js`, `skill-catalog.js`, `harness-state.js`) — a
  `harness-snapshot-ref` line always, the full `harness-snapshot` only when its `snapshotId` is not
  yet known to have reached the server. The id is a **content hash** (sha256 of a canonical
  projection; MCP probe results and capability flags are excluded), and the server never
  recomputes it. Known ids are committed only after a successful full upload and dropped again on
  an `unknownSnapshotId` response. **The MCP `tools/list` probe runs at most once per run**, only
  when the id is unknown: it spawns each stdio server sequentially with a per-server timeout, and
  the old per-file design turned a backlog into a multi-hour run that never finished. Catalog
  rules (enabled-plugin gates, project-wins collisions) and the shape: `hook/HOW_HOOK_WORKS.md`
  § "Harness snapshot" and [algorithms/harness-snapshot.md](algorithms/harness-snapshot.md).
- **OKF snapshot** — same ref/full pattern: [okf-usage.md](okf-usage.md),
  [algorithms/okf-snapshot.md](algorithms/okf-snapshot.md).
- **`code-inventory`** — on its **own time throttle** (`code-inventory-state.json`), not on the
  harness change detection: the harness rarely changes, so an inventory tied to it would go stale
  for weeks and silently skew every Change Surface percentage. No once-per-session rule; the server
  keeps the history and divides by the newest snapshot before each period end
  ([change-surface.md](change-surface.md)).
- **`otel-status`** — at `Stop` and `SessionEnd`, `maybeWriteOtelStatus` asks the receiver's
  `session-status` for routed record counts and appends a line when the write rule allows
  (per-session mark in the throttle state). Rules:
  [algorithms/otel-status-reason.md](algorithms/otel-status-reason.md); server side:
  [otel-tabs.md](otel-tabs.md).

---

## Local files

`TELEMETRY_DIR` defaults to `<project_root>/.artisyn/ai_work_dir/telemetry`: one
`<session_id>.jsonl` per session, `otel/` one level down (written by the receiver; top-level-only
listing keeps the two apart). Sidecars, all safe to delete (re-created; a missing or corrupt one
costs work, never correctness):

| File | Owner | Purpose |
|---|---|---|
| `.claude-logs.sent` | `send-logs-hook.js` | Upload manifest |
| `.claude-logs.pending` | `upload-logs.js` | In-progress chunked uploads (v2 JSON; an old positional file is ignored) |
| `gzip-stat.json` | `upload-logs.js` | Last compression ratio, seeds the next slice-size prediction |
| `.upload.lock` | `upload-logs.js` | Upload mutual exclusion |
| `<session_id>.jsonl.lock` | `write-telemetry.js` | Per-append lock (WSL / network shares) |

`.artisyn/ai_work_dir/` also holds `hook.log`, `hook-recommendations.json`, `harness-state.json`,
the throttle state and `tool-wrap/`.

**`hook.log`** — `<ISO> [<file>] [<session_id>] [<event>] <message> [hook v<version>]`.
`send-logs-hook.js` writes at least one line per run, including every early exit (`exit: …`), so
**no line at all means the script never ran** (bad wiring, `require` crash, unwritable log dir).
Debugging procedure: the `hook-debugging` skill.

---

## Design rules

- **Fail-open** — hooks always exit 0; nothing a hook does may block Claude Code.
- **Node.js built-ins only** — no `npm install` in the monitored project.
- **Runs on every current Node.js LTS line.** Hooks run with the **user's own `node` from `PATH`**
  (`"command": "node"`), so the version is whatever the machine resolves. No API or syntax newer
  than the oldest supported line, no reliance on version-specific module-loader behaviour (hence
  the explicit CommonJS marker above), and a fix that depends on Node behaviour is verified on
  each current LTS line. The `engines` floor in `hook/package.json` is not raised without a
  decision. Requiring Node on the user's machine is a deliberate trade-off (plain, auditable JS).
  **Rejected: running the hooks with Claude Code's own runtime** — the native `claude` executable
  is a Bun-compiled binary that does not run an arbitrary script (`BUN_BE_BUN=1 claude script.js`
  is treated as a prompt) and `CLAUDE_CODE_EXECPATH` only names the binary; even if it worked it
  would be an undocumented, non-Node interface.
- **Transparent code only** — everything shipped is plain, readable JavaScript a user (and their
  security team / AV) can audit in the installed folder: no native binaries, `.node` addons, WASM,
  minified or bundled blobs. Performance-motivated native code belongs on the server.
- **Never augment Claude Code's transcripts** — upload them as is; the hook's own knowledge goes
  into `artisyn` lines (`.claude/rules/hook.md`).
- **Secrets stay in `log-hub.local.json`** (gitignored); `log-hub.json` is safe to commit.
- **Backward compatible** — installed hooks upgrade late; a missing route on an older server reads
  as "feature off". See [hook-api-versioning.md](hook-api-versioning.md).
