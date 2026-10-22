---
type: "Architecture Guide"
title: "OTEL Receiver (per-project loopback OTLP listener)"
description: "Why the hook runs its own loopback OTLP/JSON receiver, the one-receiver-per-project rule, the spawn/register handshake, the 409 owner-mismatch guard, the stale-receiver restart sequence, receiver behaviour, the on-disk chunk layout, and how chunks are collected, uploaded and pruned."
tags:
  - hooks
  - otel
timestamp: "2026-10-14T00:00:00+04:00"
---

# OTEL Receiver

Claude Code can export its own OpenTelemetry logs and metrics over OTLP/HTTP. The installer points
that exporter at a loopback endpoint (see [hook-installation.md](hook-installation.md) § "OTEL
Settings"), and `hook/.claude/telemetry_tool/otel-receiver.js` is what listens there, files the
records per session, and lets the normal `Stop` upload ship them as the `claude-otel` namespace
(hook `2.3.0`+). The rest of the hook is described in
[hook-system-overview.md](hook-system-overview.md).

## Why a local receiver

- Claude Code has no OTEL **file** exporter: the logs exporter is `console`, `otlp` or `none`.
  Its OTLP exporter retries in memory only, so anything not delivered before the process exits is
  lost. The records therefore have to be landed on disk first, and the existing uploader ships them
  later, like any other session file.
- The exporter is configured for `http/json`, so a plain Node `http` server is enough. There is no
  collector binary to install.
- Server-side, each uploaded chunk becomes one `logs_otel` row (see
  [db-tables.md](db-tables.md#logs_otel)), and `server/src/logs/otel-chunk.ts` derives the
  normalized per-session record from them. OTEL `cost_usd` is a reconciliation source next to the
  computed cost (see [llm-call-math.md](llm-call-math.md) § "Two cost sources").
- `session.id` sits on each log record and metric datapoint, not on the OTLP resource, which is why
  the receiver demultiplexes per record (see "On-disk chunk layout" below).

### Rejected alternatives

- Plugin `monitors` are not used as the transport because every stdout line they print goes to the
  model, their schema is experimental, and they run only in interactive sessions.
- A shared, machine-wide receiver is not used because it would need ownership metadata, adoption,
  watermarks and a tenancy guard between projects (see the next section).

## One receiver per project — always

**The project directory is the unit.** Every project gets its own OTEL directory, its own randomly
allocated port and its own receiver. There is no shared location, no machine-wide mode, and no
override that can make two projects overlap:

- The directory is `<telemetryDir>/otel/`, resolved by `env-context.js`'s
  `resolveOtelDir(cwd, config)`. It is anchored on the **git root** exactly like `.artisyn/config/`,
  `.artisyn/ai_work_dir/` and `telemetryDir` itself, so linked worktrees of one repo are correctly
  one project (one config, one telemetry dir, one port, one receiver). Because the default location
  lives under `.artisyn/ai_work_dir/`, whose `.gitignore` contains `*`, it is already gitignored.
- `ARTISYN_OTEL_DIR` exists **only** as the transport twin of the receiver's `--dir` argv (hooks
  &le; `2.5.1` launch the receiver on Windows through a VBScript command line that carries no argv).
  It is not an input to `resolveOtelDir` and cannot redirect a project.
- `listJsonlFiles()` is top-level-only, so the `otel/` subdirectory is invisible to the `artisyn`
  collection pass — no cross-contamination between namespaces.

Because a receiver only ever sees one project's files, the whole cross-project apparatus that a
shared directory would need does not exist. The existing per-project
`acquireUploadLock(telemetryDir, …)` already covers collection, upload and prune.

## Spawn and register handshake

Two call sites, both gated on `config.otelEnabled`:

| Call site | Event | When |
|---|---|---|
| `lifecycle-hook.js` | `SessionStart` | Primary — once per session, before the first prompt (`session.count`, `mcp_server_connection` and `plugin_loaded` all fire that early). The hook's terminal exit is `setImmediate(() => process.exit(0))` so a spawn failure surfaced asynchronously on the child's `'error'` event still reaches `hook.log`. |
| `telemetry-hook.js` | `UserPromptSubmit` | Re-arm — recovers a receiver that self-exited mid-session. Throttled to one attempt per `OTEL_RESPAWN_THROTTLE_MS` (60s) via `<workDir>/otel-receiver-spawn.json`, the same throttle-state pattern `prompt-upload-throttle.json` uses. |

Both call `otel-register.js`, which does two things in this order:

1. **Register** — an awaited `POST /artisyn/register` with `{sessionId, gitRoot, repo, hookVersion}`
   to `http://127.0.0.1:<port>`, bounded by `REGISTER_TIMEOUT_MS` (2s) on the fast path. This
   covers "a receiver is already running". It is the only call that can surface a `409` (below) or
   trigger a stale-receiver restart.
2. **Spawn** — `spawnDetachedHidden(otel-receiver.js, …)` with every parameter passed as **both**
   argv and an `ARTISYN_OTEL_*` env var (argv first, env fallback — cross-version insurance for
   hooks whose Windows launcher carried env only, see `spawn-hidden.js` in
   [hook-system-overview.md](hook-system-overview.md) § "Files"). This covers "no receiver was
   running". If one already holds the port, the new process gets `EADDRINUSE` and exits `0`, which
   is the normal path for the second and later sessions of a project. The step is skipped when the
   register step already spawned a replacement during a restart.

**Neutral working directory (hook `2.21.0`+).** The receiver is long-lived and outlives the
session that spawned it, so it must not hold the project folder as its cwd — on Windows that pins
the folder and the user cannot delete or rename the project while a receiver runs.
`spawnDetachedHidden(script, args, opts)` (`spawn-hidden.js`) takes an optional `opts.cwd`
(omitted ⇒ the old inherit-the-caller behaviour), and `otel-register.js` passes `os.tmpdir()` at
both spawn sites. `otel-receiver.js` `main()` also calls `process.chdir(os.tmpdir())` first thing,
inside `try/catch` (a failure logs `chdir-failed` and continues), so a receiver launched by an
older hook without the option ends up in the neutral directory too. The receiver never needs the
project cwd: every path it uses (`--dir`, owner `gitRoot`) arrives absolute.

Every register outcome is non-fatal and never retried: a connection refusal (no receiver yet) and a
`404` (a receiver older than `2.3.0`, with no such endpoint) are both silent.

**Port resolution at runtime** (`resolveOtelPort(config, env, cwd)`), first match wins: the port
parsed out of `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` (the authority — binding anything else means
receiving nothing), then `config.otelReceiverPort` when it is a positive integer (the installer
writes it into the gitignored `log-hub.local.json` since `1.0.75`, into `log-hub.json` before), then
`OTEL_FALLBACK_PORT` (`25317`). Two disagreements each produce at most one `hook.log` `warn` line:
endpoint vs. config, and a metrics endpoint pointing at a different port than the logs endpoint
(only one port is bound, so metrics would not be captured). The hook never reads
`.artisyn/config/otel-port.json` at runtime — that file is the installer's record, and the endpoint
it wrote into the gitignored `.claude/settings.local.json` (installer `1.0.72`+; older installers
wrote `.claude/settings.json`, and the next `install`/`upgrade` moves the keys and rewrites a stale
Artisyn endpoint to the recorded port) is already the authority.

## The `409 owner-mismatch` guard

Each project has its own receiver, so the only way a project's telemetry can reach the *wrong*
listener is a port collision — two projects that independently allocated the same port, or an
`otel-port.json` that was copied instead of allocated. Rare, but silent if unchecked: the foreign
receiver would file the records into its own project's directory and upload them under **its** API
key.

The receiver's owner is fixed at startup from `--owner`/`ARTISYN_OTEL_OWNER_JSON`
(`{"gitRoot":"…","repo":"…"}`) and it refuses to start ownerless. On `POST /artisyn/register` it
compares the caller's `gitRoot` against its own:

| Outcome | Response |
|---|---|
| Same `gitRoot` | `200 {"ok":true,"receiverVersion":"<v>","port":<n>}`, idle timer re-armed |
| Different `gitRoot` | `409 {"ok":false,"error":"owner-mismatch","ownerRepo":"<repo>"}`, nothing written |
| Missing `gitRoot`, or a `sessionId` failing the `^[A-Za-z0-9._-]{1,128}$` allow-list | `400`, nothing written |

On a `409` the hook writes exactly one `warn` line naming the port and the owning repo, and telling
the user to re-run the installer with `--otel-port <n>`. **Detection and logging only** — no
automatic re-allocation, no takeover, no retry. The hook could not fix it at runtime anyway: Claude
Code's exporter is already pointed at that port by the `env` block in `.claude/settings.local.json`,
so only an install-time change moves it (`install --otel-port <n>` rewrites the Artisyn-owned
endpoints there; running sessions must be restarted).

**Documented residual:** records arriving on `/v1/logs` and `/v1/metrics` are not attributable to a
project and are accepted as-is, so between a collision starting and the user acting on the warning,
the colliding project's records land in this project's directory and are uploaded under this
project's key. The warning is the mitigation, by explicit decision.

Cross-version behaviour (a hook and a receiver at different versions) is documented in
[hook-api-versioning.md](hook-api-versioning.md) § "Hook ↔ OTEL receiver".

## Stale receiver restart

`otel-receiver.js` never relaunches itself, so a receiver started by an older hook keeps running
until something asks it to stop. Two callers do that with the same sequence:

- **The hook.** When a register `200` reports a `receiverVersion` older than the hook's own
  version, `otel-register.js` (`handleRegisterResponse`) logs one `warn` line, calls
  `stopReceiverAndWait()` and spawns a replacement. The restart branch is throttled per project
  through `otel-receiver-restart.json` (same 60s window as the re-arm), so two near-simultaneous
  `SessionStart`s do not both race a shutdown/spawn cycle. A throttled call falls through to the
  normal spawn-if-absent step.
- **The installer.** Before extracting the plugin, `install.ts` calls
  `stopExistingReceiverIfRunning(otelPort, cwd)` from `artisyn-hooks-installer/src/otel-restart.ts`
  (it has no `sessionId` to send). It never fails the install: it is silent when no receiver was
  running and prints a warning if the port could not be confirmed free.

The sequence lives in `hook/.claude/telemetry_tool/otel-restart.js` (`stopReceiverAndWait`) and is
ported once to the installer's TypeScript mirror, since the two codebases cannot import each other:

1. `POST /artisyn/shutdown {gitRoot, sessionId}`. Anything other than `200` — nothing listening, a
   pre-`2.3.0` receiver answering `404`, a `409` from another project's receiver, any other status —
   means "nothing to wait for" and returns at once (fail-open).
2. On `200`, poll the port with a bare TCP connect for up to `SHUTDOWN_GRACE_MS` (3s) while the
   receiver flushes its response and exits.
3. If the port is still occupied, resolve the PID bound to it (`findPidOnPort`) and force-kill it.
4. Poll again to confirm the port is free.

`stopReceiverAndWait` never throws and always resolves `{stopped, reason?}`; the caller proceeds
either way. The receiver validates `/artisyn/shutdown` exactly like `/artisyn/register`, including
the owner-mismatch `409`, so a foreign project sharing the port cannot stop it. On success it
answers `200` and exits only once the response has been flushed.

## Receiver behaviour

| Aspect | Behaviour |
|---|---|
| Bind | `127.0.0.1` only — loopback, so no firewall prompt. `EADDRINUSE` ⇒ one log line and `exit 0` (the normal second-session path); any other listen error ⇒ `exit 1`. |
| Routes | `POST /v1/logs`, `POST /v1/metrics`, `POST /artisyn/register`, `POST /artisyn/shutdown`. Anything else ⇒ `404`; non-`POST` on a known path ⇒ `405`. |
| Browser-origin defence | Any request carrying `Origin` or `Referer` ⇒ `403`; `Content-Type` other than `application/json` ⇒ `415`. |
| Body cap | Wire bytes (pre-decompression) over `otelReceiverMaxBodyKb` ⇒ `413` + `req.destroy()`, nothing written. |
| Compression | `gzip`/`deflate` decompressed before parsing; any other non-empty `Content-Encoding` ⇒ `415`. A decompression or JSON failure ⇒ `400`. |
| Idle timer | One timer, re-armed at the **start** of every request including rejected ones; firing ⇒ one last tail sweep (below), then `exit 0` after `otelReceiverIdleTimeoutMs` (10 min default). It is the only exit path — there is no per-session tracking; any active session's exports keep re-arming it. |
| Tail sweep | Every `SWEEP_INTERVAL_MS` (60 s, `unref()`'d interval) — see "Telemetry tail sweep" below. |
| Working directory | `os.tmpdir()` (see "Neutral working directory" above). |
| Missing otel dir | `dir-gone` — see "On-disk chunk layout". |
| Crash safety | Every handler is wrapped in `try/catch` ⇒ `500`; `uncaughtException` is logged and the process keeps running. |
| Dependencies | Node built-ins only (`http`, `fs`, `path`, `zlib`, `os`, `child_process`); it `require`s no other hook module, so every parameter is passed in. It launches the uploader **by path** (`send-logs-hook.js` next to itself), never by `require`. |
| Diagnostics | `<ISO> <event> <message>` lines appended to `<telemetryDir>/otel/receiver.log`, truncated to empty above 1 MiB. Named `.log`, not `.jsonl`, so it is never uploaded. |

**Why the origin defence is not optional:** this is an unauthenticated local HTTP endpoint whose
writes are later uploaded under the user's real API key. Without it, any web page the developer
visits could `fetch()` the loopback port and inject arbitrary NDJSON. Requiring
`application/json` is the decisive control — that is not a CORS *simple* request, so a browser must
preflight, and the receiver sends no CORS headers, so the preflight fails. Rejecting
`Origin`/`Referer` is the belt-and-braces layer. A random high port is obscurity, not a control, and
is not relied on.

## On-disk chunk layout

Records are demultiplexed by the `session.id` OTLP attribute, resolved **record-level first,
resource-level second**. `session.id` becomes a directory name, so it is validated against
`^[A-Za-z0-9._-]{1,128}$` — an allow-list, which is the sole path-traversal defence (absolute
paths, encoded traversal, separators and over-length ids are all rejected by construction).
Unresolvable records are dropped, counted in one summary `receiver.log` line per request.

Each inbound request produces **one chunk file per session it carries**, never an append to a
shared file:

```
<telemetryDir>/otel/<session-id>/<epochMs>-<seq>.jsonl
```

- The session id is a directory, not a filename prefix, because session ids are UUIDs containing
  hyphens and could not be parsed back out of a combined name.
- `<epochMs>` is fixed-width and `<seq>` is a zero-padded per-process counter, so lexicographic
  order equals write order — the order the uploader ships in.
- Each chunk is written to a `.tmp` sibling and `renameSync`d into place. Rename within one
  directory is atomic, so the uploader (which only picks up `.jsonl`) never sees a half-written
  chunk. A process killed mid-write leaves only an inert `.tmp`, which the prune sweeps.
- **`dir-gone` (hook `2.21.0`+).** `writeGroups()` first checks that the project's `otelDir`
  still exists. If it is gone (the project folder was deleted or moved under a running receiver),
  it logs one `dir-gone` line and **drops** the request's groups instead of recreating the tree —
  a recursive `mkdir` would resurrect a ghost project folder. Otherwise it creates only the
  session level with a non-recursive `mkdirSync(sessionDir)`, tolerating `EEXIST`. The startup
  `mkdirSync(dir, {recursive:true})` is unchanged; the idle timer retires the orphaned receiver.

One line per log record / per metric datapoint, so every line belongs to exactly one session:

```json
{"signal":"logs","receivedAt":"<ISO>","resource":{"<attr>":"<val>"},"scope":{"name":"…","version":"…"},"record":{ }}
{"signal":"metrics","receivedAt":"<ISO>","resource":{ },"scope":{ },"metric":{"name":"…","unit":"…","description":"…","type":"sum"},"dataPoint":{ }}
```

`receivedAt` is receive time and is **never** substituted for the record's own `timeUnixNano` /
`event.timestamp`, which survive verbatim inside `record`/`dataPoint`.

## Collection, upload and prune (`send-logs-hook.js`)

All three run on the `Stop`/`Interrupt` path, inside the upload lock `main()` already holds, and
are gated on `config.otelEnabled`:

- **Collection** — every chunk under `resolveOtelDir(cwd, config)` is uploaded as namespace
  `claude-otel` with **no filtering**, manifest key `claude-otel/<session-id>/<chunk>`. No
  `artisyn`-style context prepends apply. Chunks are complete by construction (temp + rename), so
  they are shipped verbatim with no trailing-partial-line trim — a trim would silently turn a
  genuinely malformed chunk into a "valid" one and hide the corruption.
- **Delete on upload** — a chunk is immutable once written, so a successfully uploaded chunk is
  deleted at once instead of being fingerprinted in `.claude-logs.sent`. A chunk that cannot be
  deleted (locked, permissions) is fingerprinted instead so the next run skips it, and a chunk an
  older hook already recorded at its current size is deleted when it is skipped. This keeps the
  otel tree out of every later run's directory walk and out of the manifest. On the server, the
  chunk's content hash is its `chunk_key`, so re-ingesting the same chunk upserts over itself.
- **Prune** — `pruneOtelDir()` walks each `<otelDir>/<session-id>/` directory and deletes chunks
  older than `otelRetentionDays` by mtime, plus zero-byte `*.jsonl` and abandoned (expired) `.tmp`
  files. It never deletes the current session's chunks. Each unlink is individually `try/catch`ed
  and one summary line is written to `hook.log`. See [data-retention.md](data-retention.md).
- **Prune guard (hook `2.21.0`+)** — `runUpload` collects the paths of the OTEL chunks whose upload
  **failed in this run** and passes them as `pruneOtelDir(otelDir, retentionDays, hookSessionId,
  cwd, failedPaths)`. A `.jsonl` in `failedPaths` is never pruned, even past retention, so a server
  outage on the day a chunk ages out cannot silently destroy unsent telemetry.

## Telemetry tail sweep (`--otel-sweep`, hook `2.21.0`+)

The `Stop` upload runs when a turn ends, but Claude Code keeps exporting after that (the last
`api_request` records, utility calls, the shutdown flush). Before the sweep those tail chunks sat on
disk until the **next** session in the project ran `Stop`, so the server's telemetry total was low
for the most recent session.

- The receiver records `runtime.lastRequestAt` on every request and runs a `SWEEP_INTERVAL_MS`
  (60 s) `setInterval`, `unref()`'d so it never keeps the process alive.
- On a tick where `Date.now() − lastRequestAt ≥ SWEEP_QUIET_MS` (60 s) and at least one
  `<otelDir>/<session>/<chunk>.jsonl` exists, it spawns the uploader. The idle-exit handler does
  the same once before `process.exit(0)`. A tick with nothing to do writes nothing to `receiver.log`.
- The spawn is `child_process.spawn(process.execPath, [<receiver dir>/send-logs-hook.js,
  '--otel-sweep', '--cwd', owner.gitRoot], {detached:true, stdio:'ignore', windowsHide:true,
  cwd: os.tmpdir()})` plus `unref()`, logged as `sweep-spawn` / `sweep-skip` / `sweep-error`.

`send-logs-hook.js` `main()` checks argv for `--otel-sweep` **before** reading stdin (there is no
hook payload). In that mode (`runOtelSweep`):

- `loadConfig(cwd)`; exits quietly when `serverUrl` or `apiKey` is missing.
- Takes the project's upload lock with the short `LOCK_WAIT_STOP_MS` budget. A busy lock means a
  real upload is running (and will ship these chunks), so it exits and the next quiet tick retries.
- Uploads **only** `listOtelChunks()` entries, in write order, through the same read → sanitize →
  upload → unlink path as the `Stop` run, but with **no manifest** read or write, **no prune**, no
  other namespace and no receiver re-arm. `hookLog` lines carry `sessionId` `null` and end with one
  `otel-sweep done: uploaded=… failed=… total=…` summary.

Re-uploading a chunk the `Stop` run also picks up is harmless: the server upserts on
`(session_id, chunk_key)` (and `otel_api_calls` on `(session_id, call_key)`).

`prompt-upload-hook.js` deliberately does **not** upload otel files — that fast path exists to keep
the current session's `artisyn`+`claude` files fresh, and extra files per prompt cost more than
they buy.

## Related

- [hook-system-overview.md](hook-system-overview.md) — the rest of the hook, file table and upload
  namespaces
- [hook-installation.md](hook-installation.md) — OTEL settings, port allocation and the
  `.claude/settings.local.json` `env` block (ownership, per-key merge, stale-endpoint rewrite)
- [hook-api-versioning.md](hook-api-versioning.md) — hook ↔ receiver cross-version contract
- [upload-queue.md](upload-queue.md) — what happens to a chunk once the server receives it
