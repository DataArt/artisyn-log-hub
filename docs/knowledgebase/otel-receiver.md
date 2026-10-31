---
type: "Architecture Guide"
title: "OTEL Receiver (per-user shared loopback OTLP listener)"
description: "Why the hook runs its own loopback OTLP/JSON receiver, why it is one receiver per OS user since hook 2.30.0 (the ~/.artisyn/otel state dir, repoKey, shared launch, HMAC hello/auth, register contract 1, session-status, per-record routing with the pending spool, per-repo uploads and realtime, forwarding to a foreign collector, the user-level SessionStart hook, legacy callers), the legacy per-project mode with its 409 owner-mismatch guard and stale-receiver restart, receiver behaviour, the on-disk chunk layout, traces and the hookVersion line field, the realtime sender, and how chunks are collected, uploaded and pruned."
tags:
  - hooks
  - otel
timestamp: "2026-10-31T00:00:00+04:00"
---

# OTEL Receiver

Claude Code can export its own OpenTelemetry logs, metrics and traces over OTLP/HTTP. The installer
points that exporter at a loopback endpoint (see [hook-installation.md](hook-installation.md) §
"OTEL Settings"), and `hook/.claude/telemetry_tool/otel-receiver.js` is what listens there, files
the records per session, and lets the normal `Stop` upload ship them as the `claude-otel` namespace
(hook `2.3.0`+). The rest of the hook is described in
[hook-system-overview.md](hook-system-overview.md).

Since hook `2.30.0` (task `2026-10-30-otel-shared-receiver`, GH-67) there is **one receiver per OS
user**, serving every repo of that user ("shared mode"). The older one-receiver-per-project design
survives as the **legacy mode**: hooks `≤ 2.29.0` use it, and a `2.30.0` hook falls back to it only
while the installer has not yet written `~/.artisyn/otel/port.json` (see "Legacy per-project mode"
below).

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

Plugin `monitors` are not used as the transport because every stdout line they print goes to the
model, their schema is experimental, and they run only in interactive sessions.

## Why one receiver per OS user (hook `2.30.0`+)

From Claude Code `2.1.282` on, telemetry keys in the project scopes (`.claude/settings.json`,
`.claude/settings.local.json`) are ignored: OTEL can only be enabled from user or managed settings.
User settings are one file per OS user, so there is one OTLP endpoint per user — and therefore one
port and one receiver for every repo. The per-project receivers (one random port each, endpoint in
the project's `settings.local.json`) stopped receiving anything on those versions.

What stays per repo: the OTEL chunk directory (`<telemetryDir>/otel/`, resolved by
`env-context.js` `resolveOtelDir(cwd, config)` and anchored on the git root, so linked worktrees are
one repo), the upload lock, the uploader, the API key and the realtime target. What becomes per
user: the port, the listener and the session registry that tells the receiver which repo a record
belongs to.

The receiver is still project-agnostic at the process level: Node built-ins only, no `require` of
any hook module, every parameter passed in, cwd `os.tmpdir()`.

### User-level state: `~/.artisyn/otel/` (DD-4)

`path.join(os.homedir(), '.artisyn', 'otel')`, resolved per call and never cached (so a fake
`HOME`/`USERPROFILE` isolates it in scenarios). Helpers: `hook/.claude/telemetry_tool/user-state.js`
and its TS twin `artisyn-hooks-installer/src/user-state.ts`. Files are written tmp + rename, mode
`0o600` on POSIX (no ACL on Windows, the profile dir is already user-only).

| File | Writer | Shape |
|---|---|---|
| `port.json` | installer | `{version:1, port, allocatedAt}` — the shared port |
| `token` | installer, or the hook if missing | 64 lowercase hex chars (32 random bytes), no newline; created with `wx`, the loser of a race reads the winner's token |
| `repos.json` | installer | `{version:1, repos:[{repoKey, gitRoot, otelDir, uploader, traces, installedAt, hookVersion}]}` |
| `registry.json` | receiver only | `{version:1, savedAt, sessions:{[sessionId]: RegistryEntry}}` |
| `forward.json` | installer | `{version:1, mode:'proxy'\|'keep'\|'replace'\|'none', fingerprint, signals:{logs?,metrics?,spans?:{endpoint, protocol}}, original:{env:{…}, otelHeadersHelper?, envOrder?}, savedAt}` — `original.env` holds the foreign connection keys plus every Artisyn-written key the user had set (e.g. `CLAUDE_CODE_ENABLE_TELEMETRY`), `envOrder` the user `env` key names in their original order (names only) |
| `receiver.log` | receiver | shared diagnostics log, truncated above 1 MiB (`RECEIVER_LOG_MAX_BYTES`) |
| `claude-version.json` | hook | `{version, seenAt}` — cached Claude Code version (`otel-status.js`) |
| `bin/otel-receiver.js`, `bin/version.json`, `bin/otel-ensure-receiver.js` | installer | receiver copy and the user-level SessionStart hook (below) |

**`repoKey` (DD-5)** = the first 16 hex chars of `sha256(normalizedGitRoot)`, where
`normalizedGitRoot` = `path.resolve(gitRoot)` with forward slashes, lowercased on win32. It is the
only repo identifier that travels in OTEL resource attributes (`artisyn.repo=<repoKey>`, constant
`REPO_ATTR_KEY`), so no local path leaks to a foreign collector.

### Port resolution in the hook (DD-6)

`env-context.js` `resolveOtelPort(config, env, cwd, opts)` returns `{mode, port}`:

- `port.json` present → `mode:'shared'` on its port. A different port in the user-scope logs
  endpoint → one `warn` per session `otel port-mismatch …` (cross-check only).
- `port.json` missing (the plugin auto-updated the scripts but the installer never ran) →
  `mode:'legacy'`: the old per-project path (`otelReceiverPort`, `--owner` launch) with one `warn`
  "run the log-hub installer to enable the shared receiver". A missing-install fallback, not a
  toggle.

### Shared launch (DD-7, DD-8)

```
node otel-receiver.js --shared --owner-home <home> --state-dir <dir> --port <n>
                      --idle-timeout-ms <ms> --max-body-bytes <n>
```

- Env twins: `ARTISYN_OTEL_SHARED=1`, `ARTISYN_OTEL_OWNER_HOME`, `ARTISYN_OTEL_STATE_DIR`, plus the
  existing `ARTISYN_OTEL_PORT`, `ARTISYN_OTEL_IDLE_TIMEOUT_MS`, `ARTISYN_OTEL_MAX_BODY_BYTES`
  (`buildReceiverLaunch` in `otel-register.js`; the legacy-only env vars are stripped from a shared
  launch and vice versa).
- `--shared` together with `--owner` or `--dir` → exit 2 (`EXIT_USAGE`) with one stderr line. No
  usable `<stateDir>/token` at start → one log line and exit 0.
- **Which script:** a repo hook spawns its **own** plugin copy of `otel-receiver.js` ("first
  spawner wins"); only `otel-ensure-receiver.js` spawns the `bin/` copy. After start nothing is read
  next to the script.
- **Idle timeout:** fixed `SHARED_IDLE_TIMEOUT_MS` = 600000 (10 min). The repo key
  `otelReceiverIdleTimeoutMs` is ignored for a shared launch (no single repo owns the receiver).
  Scenarios pass a small `--idle-timeout-ms`.
- **A newer hook meets an older running receiver:** the hook uses it as is. It writes only the
  one-time capability `warn` (below) and **never restarts** a shared receiver; the newer code takes
  over after the old receiver's idle-exit.
- Cwd is `os.tmpdir()`; `EADDRINUSE` → exit 0 (both unchanged).

### Auth handshake (DD-9)

The receiver serves every repo of the user and spawns uploaders, so the control routes are
authenticated with HMAC-SHA256 keyed by `token` (Node `crypto`, compared with `timingSafeEqual`):

1. `POST /artisyn/hello` `{clientNonce, ownerHash}` — `clientNonce` 32 hex chars, `ownerHash` =
   `sha256(normalizedHome)` hex.
   - An `ownerHash` other than the receiver's own → `409 {error:'owner-mismatch'}` (no path in the
     answer).
   - Otherwise `200 {serverNonce, proof, receiverVersion, contract, capabilities}` with
     `proof = HMAC(token, "srv\n"+clientNonce+"\n"+serverNonce)`. Server nonces are single-use,
     expire after `NONCE_TTL_MS` (30 s), at most `NONCE_MAX` (256) outstanding, oldest evicted.
   - Each hello also re-reads `forward.json` when its mtime changed.
2. The hook verifies `proof` before it sends anything secret. A bad proof, a non-JSON answer, a
   non-200 or a 409 → `port-conflict` (below).
3. `register`, `session-status` and `shutdown` carry
   `x-artisyn-auth: v1 <serverNonce> <HMAC(token, "cli\n"+serverNonce+"\n"+urlPath+"\n"+sha256hex(rawBody))>`.
   A missing or bad header, or an unknown or used nonce → `401 {error:'unauthorized'}` plus one
   `auth-reject route=…` log line. Nothing is spawned or registered.

The Origin/Referer and Content-Type defences (below) run first, unchanged. The TS client for the
installer is `artisyn-hooks-installer/src/otel-handshake.ts`.

**Port conflict (DD-17).** A failed hello as above, or a spawned receiver that dies with
`EADDRINUSE` while hello still fails within `SPAWN_HELLO_RETRY_MS` (2 s) → one `warn`
`otel port-conflict port=<n>` per session, and the session's `otel-status` reports
`reason=receiver-down`, `detail=port-conflict`. The hook never allocates a port.

### Register contract 1 (DD-10)

`POST /artisyn/register` (authenticated), sent by `otel-register.js` on `SessionStart` and on the
throttled re-arms:

- **Request:** `{sessionId, gitRoot, otelDir, hookVersion, contract:1, repoKey,
  signals:{logs,metrics,spans}, uploader, realtime:{enabled, serverUrl, apiKey, intervalMs}|null}`.
  - Required: `sessionId` (`^[A-Za-z0-9._-]{1,128}$`), `gitRoot`, `otelDir` (absolute),
    `hookVersion`. Missing or invalid → `400 {error:'bad-request', reason:'<field> missing|invalid'}`.
    Unknown fields are ignored.
  - `uploader` is accepted only as an absolute, existing file named `send-logs-hook.js` whose
    realpath lies under `gitRoot` or under `<home>/.claude/plugins/` → else
    `400 {reason:'uploader-not-allowed'}` (`isAllowedUploader`; the receiver would otherwise run
    arbitrary code).
  - `signals` defaults: logs and metrics on, spans off (`normalizeSignals`). A `repoKey` that is not
    16 hex is recomputed from `gitRoot`.
- **Response 200:** `{ok:true, receiverVersion, contract:1, capabilities, rebound}` with
  `capabilities` = `CAPABILITIES` = `['shared','auth-v1','spans','realtime','forward','session-status']`.
- **RegistryEntry** = the request fields plus `registeredAt`, `lastSeenAt`,
  `received:{logs,metrics,spans}` and `firstRecordAt`. TTL `REGISTRY_TTL_MS` (24 h) since
  `lastSeenAt`, which register and every routed record refresh. A re-register replaces the entry
  but keeps its counters and logs `register-rebind session=… from=<repoKey> to=<repoKey>` when the
  repo changed. Persisted to `registry.json` with a `REGISTRY_PERSIST_DEBOUNCE_MS` (5 s) debounce,
  at idle-exit and on shutdown; loaded at start without expired entries (`pruneRegistry`).
- **Capability check (FR-A10):** the hook needs `session-status` always, `spans` when it asks for
  traces and `realtime` when realtime is on. Anything missing from the receiver's `capabilities` →
  one `warn` per session "otel receiver <v> … lacks capabilities … — it keeps running; the newer
  receiver takes over after its idle-exit". No restart.

### Session status (DD-11)

`POST /artisyn/session-status {sessionId}` (authenticated) →
`{receiverVersion, registered, received:{logs,metrics,spans}, firstRecordAt|null, pending, forward:'ok'|'degraded'|'off'}`.
An unknown session → `registered:false` with zero counts. `received` counts only routed records
(pending ones are in `pending`). The hook asks it at `Stop` and `SessionEnd` to build the
`otel-status` event ([hook-system-overview.md](hook-system-overview.md) § "`otel-status` event",
algorithm [otel-status-reason](algorithms/otel-status-reason.md)).

### Per-record routing and the pending spool (DD-18)

Each log record, metric datapoint and span is routed on its own (`routeRecord`, pure; algorithm
doc [otel-shared-routing](algorithms/otel-shared-routing.md)):

1. Resolve `session.id` (record attribute first, then resource). None → pending under the key
   `"__none__"`, which only expires.
2. A live registry entry → that repo when its `signals[signal]` is true, else drop and count
   `dropped-signal`. A conflicting `artisyn.repo` tag is ignored: **register wins**.
3. Else an `artisyn.repo=<repoKey>` resource attribute matching a `repos.json` entry → that entry's
   `otelDir`, with logs + metrics, plus spans when the entry has `traces`.
4. Else → the pending spool under the session id.

The spool is in memory: `PENDING_TTL_MS` (5 min) per record, `PENDING_MAX_RECORDS` (5000) per
receiver; on overflow the oldest record is dropped and counted (`pending-overflow`), expired records
are dropped and counted (`pending-expire`). A register re-routes the session's spooled records
(`reroutePending`).

### Uploads, realtime and log lines per repo (DD-19)

- **Sweep:** one quiet-timer per `gitRoot` with routed data; it spawns that repo's registered
  `uploader` (for tag-routed repos the `repos.json` `uploader`) with
  `--otel-sweep --cwd <gitRoot>`.
- **Realtime:** queue, timers and backoff are keyed by `gitRoot` and use the registration's
  `realtime` target. `RT_BUFFER_MAX_LINES` applies per key. `readRealtimeTarget(gitRoot)` (reading
  the repo config) stays for legacy mode only.
- **Line fields:** chunk lines get `hookVersion` from the registry entry and a new
  `receiverVersion`.
- **Spawning repo deleted (AC-A5):** records routed to a repo whose `otelDir` is gone hit the
  `dir-gone` check, are dropped and counted for that repo only (one `dir-gone repo=<repoKey>` line);
  its sweep and realtime timers stop. Every other repo keeps being served. Its registry and
  `repos.json` entries stay until the TTL or an uninstall.
- **Who creates `otelDir` (hook `2.30.2`+):** the write path never does (it must not resurrect a
  deleted project). A shared receiver has no `--dir` to create at start, so `handleSharedRegister`
  creates the registered `otelDir` (`ensureRegisteredOtelDir`) when `gitRoot` exists and `otelDir`
  lies inside it, and clears the repo's `dir-gone` mark; the installer (`1.0.89`+) also creates it at
  install, for repos reached by their `artisyn.repo` tag before any session registered. Before
  2.30.2 every record of a fresh shared install was dropped as `dir-gone`.
- **Logs (FR-E3, FR-E4):** the shared log is `<stateDir>/receiver.log`, format unchanged
  (`<ISO> <event> <message>`). Each per-repo slice of an OTLP request writes
  `ingest repo=<repoKey> receiverVersion=<v> signal=… bytes=… sessions=… records=… dropped=… writeErrors=…`
  there and mirrors the same line into that repo's `<otelDir>/receiver.log`. Pending records log
  `ingest repo=pending …` in the shared log only. Idle-exit logs
  `idle-exit idleMs=<n> ingests=<count since start> sessions=<registry size>`, followed by a `no-data` line when
  `ingests` is 0 (Claude Code never exported to this receiver — hook 2.30.3+). An `addr-in-use` exit is skipped when
  the last log line is already `addr-in-use`, so a burst of losing spawns leaves one line.

### Forwarding to a foreign collector (DD-20)

When `forward.json` says `mode:'proxy'` (the user chose to keep their own collector behind Log Hub,
see [hook-installation.md](hook-installation.md) § "Foreign collector"), the receiver forwards:

- Each OTLP request for a signal listed in `forward.json.signals` is queued **before** routing, so
  every session is covered, including unregistered ones and repos without the hook.
- The upstream gets the raw request bytes and every incoming header except `host`, `connection`,
  `content-length`, `transfer-encoding` and `x-artisyn-*` (`forwardHeaders`). Claude Code gets its
  `200` after the local write; forwarding is async.
- A signal is forwarded only to an absolute `http:`/`https:` URL that does not point back at the
  receiver itself (`parseForwardConfig`).
- Queue cap `FORWARD_QUEUE_MAX_REQUESTS` (1000) or `FORWARD_QUEUE_MAX_BYTES` (32 MiB) per signal.
  429, 5xx and network errors retry with `forwardBackoffMs` = `min(1000·2^(attempt−1), 60000)`, at
  most `FORWARD_MAX_ATTEMPTS` (6); other 4xx are dropped.
- Log line `forward signal=… status=… queued=… dropped=…` — never header values — and an idle-exit
  summary.
- `session-status.forward` (`forwardHealth`): `off` when the mode is not `proxy`; `degraded` after
  a drop or retry within `FORWARD_DEGRADED_WINDOW_MS` (5 min); else `ok`.

### User-level SessionStart hook (DD-21)

Only in `proxy` mode the receiver is the user's only path to their collector, so it must run for
every Claude Code session, including repos without the Log Hub hook. The installer adds to
`~/.claude/settings.json`:

```
hooks.SessionStart[{hooks:[{type:'command', command:'node "<home>/.artisyn/otel/bin/otel-ensure-receiver.js"', timeout:5}]}]
```

`otel-ensure-receiver.js` (standalone, Node built-ins only) reads `port.json` and `token`, sends a
hello with `ENSURE_HELLO_TIMEOUT_MS` (500 ms), spawns `bin/otel-receiver.js` with the shared argv
when nothing answers, and always exits 0 silently. An answer that fails the proof is left alone.
The entry is recognised by its command containing `.artisyn/otel/bin/otel-ensure-receiver.js`
(`USER_ENSURE_HOOK_MARKER` in `user-settings.ts`).

### Legacy callers on the shared port (DD-22)

Old hooks never read `port.json` (FR-A11): a repo that still runs a `≤ 2.29.0` hook keeps its own
per-project port and receiver, side by side with the shared one. If an old hook does reach the
shared port (for example through a stale `otelReceiverPort`):

- an unauthenticated `--owner`-style register or shutdown gets `401`;
- the shared receiver keeps running;
- the old hook's restart path then hits `EADDRINUSE` and its spawned copy exits 0.

`s-compat-01` pins this with the frozen `2.28.0` fixture. Cross-version rules:
[hook-api-versioning.md](hook-api-versioning.md) § "Hook ↔ OTEL receiver".

## Legacy per-project mode (hooks `≤ 2.29.0`, or no `port.json`)

Before `2.30.0` **the project directory was the unit**: every project had its own OTEL directory,
its own randomly allocated port and its own receiver, owned by that project's git root. This mode
is still started by older hooks, and by a `2.30.0` hook while `port.json` is missing (DD-6). The
rules below apply only to it.

- The directory is `<telemetryDir>/otel/` (same as in shared mode).
- `ARTISYN_OTEL_DIR` exists **only** as the transport twin of the receiver's `--dir` argv (hooks
  &le; `2.5.1` launch the receiver on Windows through a VBScript command line that carries no argv).
  It is not an input to `resolveOtelDir` and cannot redirect a project.
- `listJsonlFiles()` is top-level-only, so the `otel/` subdirectory is invisible to the `artisyn`
  collection pass — no cross-contamination between namespaces (true in both modes).

### Spawn and register handshake (legacy)

Two call sites, both gated on `config.otelEnabled` (the same call sites announce a shared-mode
session — hello, spawn when nothing answers, authenticated register — see "Register contract 1"):

| Call site | Event | When |
|---|---|---|
| `lifecycle-hook.js` | `SessionStart` | Primary — once per session, before the first prompt (`session.count`, `mcp_server_connection` and `plugin_loaded` all fire that early). The hook's terminal exit is `setImmediate(() => process.exit(0))` so a spawn failure surfaced asynchronously on the child's `'error'` event still reaches `hook.log`. |
| `telemetry-hook.js` | `UserPromptSubmit` | Re-arm — recovers a receiver that self-exited mid-session. Throttled to one attempt per `OTEL_RESPAWN_THROTTLE_MS` (60s) via `<workDir>/otel-receiver-spawn.json`, the same throttle-state pattern `prompt-upload-throttle.json` uses. |

In legacy mode both call `otel-register.js`, which does two things in this order:

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

**Legacy port resolution at runtime** (`resolveLegacyOtelPort`, reached through
`resolveOtelPort` only when `port.json` is missing), first match wins: the port
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

### The `409 owner-mismatch` guard (legacy)

In legacy mode each project has its own receiver, so the only way a project's telemetry can reach the *wrong*
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

### Stale receiver restart (legacy ports only)

**Scope.** This applies only to per-project receivers on legacy ports. A shared receiver is never
restarted by a hook (DD-7): a newer hook logs the capability `warn` and lets the old receiver
idle-exit. The installer no longer stops any receiver on install or upgrade (DD-25): an old
per-project receiver keeps its port until its own idle-exit. The only deliberate stop of a shared
receiver is the installer action `--restart-otel-receiver` (and the last `uninstall`), through an
authenticated `POST /artisyn/shutdown` (`otel-handshake.ts` `shutdown`), then the same wait as
below ([hook-installation.md](hook-installation.md)).

`otel-receiver.js` never relaunches itself, so a legacy receiver started by an older hook keeps
running until something asks it to stop. A legacy-mode hook does that:

- **The hook.** When a register `200` reports a `receiverVersion` older than the hook's own
  version, `otel-register.js` (`handleRegisterResponse`) logs one `warn` line, calls
  `stopReceiverAndWait()` and spawns a replacement. The restart branch is throttled per project
  through `otel-receiver-restart.json` (same 60s window as the re-arm), so two near-simultaneous
  `SessionStart`s do not both race a shutdown/spawn cycle. A throttled call falls through to the
  normal spawn-if-absent step.
- **The installer (before `2.30.0`).** Older installers called
  `stopExistingReceiverIfRunning(otelPort, cwd)` (`artisyn-hooks-installer/src/otel-restart.ts`)
  before extracting the plugin. The current installer does not call it any more; the function and
  `stopReceiverAndWait` stay for the shared-receiver stop above.

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
| Routes | `POST /v1/logs`, `POST /v1/metrics`, `POST /v1/traces` (hook `2.29.0`+), `POST /artisyn/register`, `POST /artisyn/shutdown`; shared mode adds `POST /artisyn/hello` and `POST /artisyn/session-status`, and `register` / `session-status` / `shutdown` need `x-artisyn-auth` there. Anything else ⇒ `404`; non-`POST` on a known path ⇒ `405`. |
| Browser-origin defence | Any request carrying `Origin` or `Referer` ⇒ `403`; `Content-Type` other than `application/json` ⇒ `415`. |
| Body cap | Wire bytes (pre-decompression) over `otelReceiverMaxBodyKb` ⇒ `413` + `req.destroy()`, nothing written. |
| Compression | `gzip`/`deflate` decompressed before parsing; any other non-empty `Content-Encoding` ⇒ `415`. A decompression or JSON failure ⇒ `400`. |
| Idle timer | One timer, re-armed at the **start** of every request including rejected ones; firing ⇒ one last tail sweep (below), then `exit 0` after `otelReceiverIdleTimeoutMs` (10 min default; shared mode: the fixed `SHARED_IDLE_TIMEOUT_MS`, and the registry is flushed first). Apart from an authenticated shutdown it is the only exit path; any active session's exports keep re-arming it. |
| Tail sweep | Every `SWEEP_INTERVAL_MS` (60 s, `unref()`'d interval) — see "Telemetry tail sweep" below. |
| Working directory | `os.tmpdir()` (see "Neutral working directory" above). |
| Missing otel dir | `dir-gone` — see "On-disk chunk layout". |
| Crash safety | Every handler is wrapped in `try/catch` ⇒ `500`; `uncaughtException` is logged and the process keeps running. |
| Dependencies | Node built-ins only (`http`, `https`, `fs`, `path`, `zlib`, `os`, `crypto`, `child_process`); it `require`s no other hook module, so every parameter is passed in. It launches the uploader **by path** (`send-logs-hook.js` next to itself), never by `require`. |
| Diagnostics | `<ISO> <event> <message>` lines appended to `<telemetryDir>/otel/receiver.log` (shared mode: `~/.artisyn/otel/receiver.log`, with the per-repo `ingest` lines mirrored into each repo's file), truncated to empty above 1 MiB. Named `.log`, not `.jsonl`, so it is never uploaded. |

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

One line per log record / per metric datapoint / per span (hook `2.29.0`+), so every line belongs to exactly one session:

```json
{"signal":"logs","receivedAt":"<ISO>","resource":{"<attr>":"<val>"},"scope":{"name":"…","version":"…"},"record":{ }}
{"signal":"metrics","receivedAt":"<ISO>","resource":{ },"scope":{ },"metric":{"name":"…","unit":"…","description":"…","type":"sum"},"dataPoint":{ }}
{"signal":"spans","receivedAt":"<ISO>","resource":{ },"scope":{ },"record":{"traceId":"…","spanId":"…","parentSpanId":"…","name":"claude_code.llm_request","attributes":{ }},"hookVersion":"2.29.0"}
```

Since hook `2.29.0` every line also carries `hookVersion` (see "Traces" below).

`receivedAt` is receive time and is **never** substituted for the record's own `timeUnixNano` /
`event.timestamp`, which survive verbatim inside `record`/`dataPoint`.

## Traces (`/v1/traces`, hook `2.29.0`+)

- `OTLP_TRACES_PATH = '/v1/traces'` is in `KNOWN_PATHS`. Claude Code sends to it only when the
  installer wrote the three trace keys (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`,
  `OTEL_TRACES_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:<port>/v1/traces`,
  `otelTraces: true` in `log-hub.json`, see [hook-installation.md](hook-installation.md)).
- `walkSpans()` is shaped like `walkLogs()`: it walks `resourceSpans[].scopeSpans[].spans[]`,
  demuxes each span by its `session.id` (span attribute first, resource attribute second — the
  same `resolveSessionId`) and writes one `signal:"spans"` line per span. Spans without a
  resolvable session id are dropped and counted, like log records.
- Span lines go into the same `<session-id>/<epochMs>-<seq>.jsonl` chunks and upload as
  `claude-otel` with no upload change. An older server stores them in `logs_otel.body` and ignores
  them (`summarizeOtelChunk` counts every line in `record_count`, so chunk volume grows a little);
  a newer server's projection drain turns them into `otel_spans` — also for chunks an old server
  stored before the upgrade (see [otel-tabs.md](otel-tabs.md)).

### `hookVersion` on every line

The receiver reads its own `version.json` once with `fs` (`getReceiverVersion()`) and stamps
`hookVersion` on every chunk line it writes (`withHookVersion()`; the field is absent, not `null`,
when the version cannot be read). The server keeps the highest value per session in
`otel_session_state.otel_hook_version` and uses it for the "slow updates / upgrade the hook"
banner (`OTEL_LIVE_HOOK_MIN_VERSION` = `2.29.0`). Older servers ignore the field.

## Realtime sender (hook `2.29.0`+)

Besides writing chunks, the receiver forwards the same `logs` and `spans` lines (never `metrics`,
`RT_SIGNALS`) to `POST /api/v2/otel-realtime` so the OTEL tabs update while a session runs. It is
best-effort: memory only, and every line it sends or drops is still in a chunk file, which the
regular upload ships. Chunk writing, the 60 s sweep, `Stop` and the upload lock are unchanged; a
realtime failure never touches chunk files.

- **Target** — shared mode: the `realtime` object of the session's registration, keyed per
  `gitRoot` (see "Uploads, realtime and log lines per repo"). Legacy mode:
  `readRealtimeTarget(runtime.owner.gitRoot)` (never `cwd`: the receiver `chdir`s to
  `os.tmpdir()`) shallow-merges `.artisyn/config/log-hub.json` and `log-hub.local.json` with `fs`
  (local wins, as `env-context.js` does) into `{ serverUrl, apiKey, enabled: otelRealtime !== false,
  intervalMs }`, and re-reads on a config file mtime change. No `serverUrl` / `apiKey` → no
  realtime. Built-ins only (`http` / `https` / `zlib`), no `require` of hook modules.
- **Queue** — after each chunk write, the lines are appended to an in-memory per-session queue.
  `RT_BUFFER_MAX_LINES` = 2000 per receiver: on overflow the oldest lines are dropped and counted
  in `droppedLines` (`rt-overflow` log line).
- **Sending** — a per-session timer sends at most one POST every
  `max(otelRealtimeIntervalMs, serverMinIntervalMs)`: the config value (default and floor
  `RT_MIN_INTERVAL_MS` = 5000) and the latest `minIntervalMs` from the server's response (honoured
  up to `RT_SERVER_INTERVAL_CAP_MS` = 1 h). Body `{ sessionId, hookVersion, receiverId, batchSeq,
  droppedLines, lines }`, gzipped above `RT_GZIP_MIN_BYTES` = 8 KiB. `receiverId` is random per
  receiver start; `batchSeq` grows per session.
- **Limits** — one request in flight per receiver, `RT_REQUEST_TIMEOUT_MS` = 5000; a batch holds
  at most `RT_MAX_BATCH_BYTES` = 786432 uncompressed bytes (under the server's 1 MiB hook limit),
  the rest waits; a single line over `RT_MAX_LINE_BYTES` = 262144 is never sent in realtime, only
  counted in `droppedLines`.
- **Retry** — a failed or timed-out batch goes back to the front of the queue with the **same**
  `batchSeq`; the server treats a repeated `batchSeq` as a replay (idempotent upserts, no gap).
  Backoff after a 5xx / timeout / network error is the pure exported
  `nextRealtimeDelay(failures)` = `min(5000·2^failures, 60000)` (algorithm doc
  `algorithms/otel-realtime-backoff.md`); a success resets it (`rt-fail` / `rt-recovered`).
- **Auto-disable** — `404` (old server), `401` or `403` stop realtime for the whole receiver for
  `RT_DISABLE_MS` = 1 h with one `rt-disable` line; a config file mtime change ends it early
  (`rt-enable`). `409` (foreign session) stops realtime for that session (`rt-session-stop`).
  `413` halves the batch once, then drops its lines (`rt-too-large`). Any other 4xx drops the
  batch (`rt-rejected`). Dropped lines still arrive by chunk.
- **Shutdown** — on idle exit the receiver tries one final send, bounded by
  `RT_SHUTDOWN_FLUSH_MS` = 2000. A restart starts a new `receiverId` with an empty queue; the
  chunks cover anything unsent. The server cannot see that case as a gap (documented in the user
  help).
- **Turning it off** — `"otelRealtime": false` in `log-hub.json` (or `log-hub.local.json`). The
  chunks still upload at each turn end, so the tabs just update more slowly.

The exported constants (`RT_*`, `nextRealtimeDelay`) are in `module.exports` for the algorithm
test and the scenarios.

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
- Shared mode (hook `2.30.0`+) runs this check per `gitRoot` with routed data and spawns that
  repo's registered (or `repos.json`) `uploader` with `--cwd <gitRoot>` instead of its own
  sibling script (DD-19).

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
- [algorithms/otel-shared-routing.md](algorithms/otel-shared-routing.md) — per-record routing,
  register validation and forwarding rules
- [algorithms/otel-status-reason.md](algorithms/otel-status-reason.md) — effective config, state,
  reason and the `otel-status` write rule
- [otel-tabs.md](otel-tabs.md) — what the server does with the data and the per-session status
- [upload-queue.md](upload-queue.md) — what happens to a chunk once the server receives it
