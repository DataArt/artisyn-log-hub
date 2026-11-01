# Implementation plan — 2026-10-30-otel-shared-receiver (GH-67)

## TL;DR

- **Hook receiver becomes per-OS-user.** `otel-receiver.js` gains a `--shared` launch with an
  HMAC-authenticated handshake (`POST /artisyn/hello`), a persisted session registry, a pending
  spool, per-repo routing, uploads and realtime, a new `POST /artisyn/session-status` route and
  raw OTLP/HTTP-JSON forwarding upstream. The legacy `--owner` mode stays byte-compatible.
- **New hook modules:** `user-state.js` (the `~/.artisyn/otel/` state dir: port, token, registry,
  repos, forward backup), `managed-settings.js` (managed / OS-policy / remote-settings reader),
  `otel-status.js` (effective config → reason, counts → state, the write rule) and
  `otel-ensure-receiver.js` (the user-level SessionStart hook). The installer gets the TS twins
  `user-state.ts` and `managed-settings.ts`, plus the new modules `user-settings.ts`,
  `foreign-otel.ts` and `otel-handshake.ts`. The new hook files are added to `HOOK_JS_FILES` in
  `scripts/build-hooks-installer.js`.
- **Installer writes `~/.claude/settings.json`.** It also asks proxy / keep / replace when a
  foreign collector exists (`--otel-existing=`), adds `--restart-otel-receiver`, re-purposes
  `--otel-port` and writes `_artisynOtel` notes. Every write to the user file is validated against
  the expected types first.
- **Hook release 2.30.0, same branch and PR as `2026-10-30-otel-tabs-traces`.** It builds on that
  task's uncommitted work: unreleased hook 2.29.0 and migration 0078. The compatibility baseline is
  the already frozen 2.28.0 fixture.
- **DB:** migration `0079_otel_status.sql` adds three nullable `session_stats` columns:
  `otel_state`, `otel_reason`, `otel_status` jsonb. No backfill.
- **API (additive):**
  - New `otel-status` artisyn event at ingest.
  - `GET …/otel/facts` (repo and team) gains `coverage`.
  - `GET …/sessions/:sessionId/otel` gains `otelStatus` and `costExcludesUtilityCalls`.
  - `GET …/repositories/:repoId/sessions` gains `costBreakdown.costExcludesUtilityCalls` and an
    `otelReason` filter.
- **UI:**
  - A session reason panel, a partial banner and a utility-call cost marker.
  - A removable `OTEL: <reason>` filter chip on the Sessions panel.
  - A coverage banner with reason chips and a "Sessions with OTEL" tile on the repo and team OTEL
    tabs.
  - New help sections and a new `user-docs/otel-admin-guide.md`.
- **Upgrade and sandbox:** an upgrade no longer stops the old per-project receiver. It deletes
  `.artisyn/config/otel-port.json` and lets that receiver idle-exit. `docker-dev/provision.mjs`
  writes the user-scope state inside the sandbox. The offline READMEs (`hook/README.md`,
  `release-template/INSTALL.md`) get a self-contained summary.
- **High blast radius:** the installer edits the user's global `~/.claude/settings.json`. A
  wrong-typed known key makes Claude Code skip the whole file, so validation and an
  `.artisyn-bak` copy come before every write.

## Reference

- Requirements: [requirements.md](requirements.md)
- PoC: [docs/pocs/2026-10-30-2327-otel-user-scope-behaviour/](../../../pocs/2026-10-30-2327-otel-user-scope-behaviour/README.md)
- Research archive: [research/findings-1.md](research/findings-1.md)
- Sibling task (base): [2026-10-30-otel-tabs-traces/impl-plan.md](../2026-10-30-otel-tabs-traces/impl-plan.md)

## Design Decisions

### Base and release

- **DD-1 Base: the same branch.** The work is done on `feature/2026-10-30-otel-tabs-traces`, on top
  of that task's uncommitted changes: hook 2.29.0, migration 0078, `f25-otel.ts`, the OTEL tabs
  and `OtelEmptyState`. The two tasks ship as one PR, so there is no merge prerequisite.
  - Hook 2.29.0 is never released. This task bumps the hook to **2.30.0**
    (`hook/.claude/telemetry_tool/version.json` and the plugin's `plugin.json`), so local dogfood
    installs of the per-project 2.29.0 dev build get refreshed and can be told apart.
  - Migration **0079** stays separate from 0078, because dev databases have already applied 0078.
- **DD-2 Legacy fixture = the existing 2.28.0.** 2.28.0 is the last *released* hook, and it uses a
  per-project receiver. The compatibility steps use the already frozen
  `tests/fixtures/legacy-hooks/2.28.0/`, so no new freeze is needed. Its README row gets the
  addition "also the last per-project-receiver hook".
- **DD-3 PoC items 3–4 (AC-F1) — done 2026-10-31.** The results are in the PoC README, items 7
  and 8.
  - A managed endpoint overrides **per key**: a managed logs-only endpoint takes logs, while
    metrics and traces still reach the non-managed endpoint.
  - Managed `CLAUDE_CODE_ENABLE_TELEMETRY=0`, or all exporters set to `none`, stops all export.
  - The Windows path `%ProgramFiles%\ClaudeCode\managed-settings.json` is confirmed.
  - `claude doctor` lists the ignored project keys by name and reports remote managed settings.

  DD-12 and DD-15 below already reflect these results.

### User-level state

- **DD-4 State dir.** The dir is `path.join(os.homedir(), '.artisyn', 'otel')`, resolved per call
  (never cached, so a fake HOME / USERPROFILE in scenarios isolates it).
  - Files are written with tmp + rename. They are created with mode `0o600` on POSIX. On Windows
    no ACL is applied: the profile dir is already user-only.
  - `token` is created with the `wx` flag. The loser of a race reads the winner's token.

| File | Writer | Shape |
|---|---|---|
| `port.json` | installer | `{version:1, port, allocatedAt}` |
| `token` | installer, or hook if missing | 64 lowercase hex chars (32 random bytes), no newline |
| `repos.json` | installer | `{version:1, repos:[{repoKey, gitRoot, otelDir, uploader, traces, installedAt, hookVersion}]}` |
| `registry.json` | receiver only | `{version:1, savedAt, sessions:{[sessionId]: RegistryEntry}}` (DD-10) |
| `forward.json` | installer | `{version:1, mode:'proxy'\|'keep'\|'replace'\|'none', fingerprint, signals:{logs?,metrics?,spans?:{endpoint, protocol}}, original:{env:{…}, otelHeadersHelper?}, savedAt}` |
| `receiver.log` | receiver | shared log, 1 MiB truncate (existing `RECEIVER_LOG_MAX_BYTES`) |
| `claude-version.json` | hook | `{version, seenAt}` (DD-13) |
| `bin/otel-receiver.js`, `bin/version.json`, `bin/otel-ensure-receiver.js` | installer | receiver copy and user-level hook (DD-21) |

- **DD-5 repoKey.** `repoKey` = the first 16 hex chars of
  `sha256(normalizedGitRoot)`. `normalizedGitRoot` = `path.resolve(gitRoot)`, forward slashes,
  lowercased on win32. It is the only repo identifier that travels in OTEL resource attributes, so
  no local paths leak to a foreign collector.

### Receiver launch and auth

- **DD-6 Port resolution (new hook).**
  - `port.json` present → shared mode on its port. A different port in the user-scope logs
    endpoint → one `warn` (cross-check only).
  - `port.json` missing (for example the plugin auto-updated the scripts but the installer never
    ran) → the hook keeps the legacy per-project path (`otelReceiverPort`, `--owner` launch).
    It writes one `warn`: "run the installer to enable the shared receiver".

  This is a missing-install fallback, not a toggle.
- **DD-7 Shared launch contract (FR-A15).**
  - argv: `--shared --owner-home <home> --state-dir <dir> --port <n> --idle-timeout-ms <ms> --max-body-bytes <n>`.
  - Env twins: `ARTISYN_OTEL_SHARED=1`, `ARTISYN_OTEL_OWNER_HOME`, `ARTISYN_OTEL_STATE_DIR`, plus
    the existing `ARTISYN_OTEL_PORT`, `ARTISYN_OTEL_IDLE_TIMEOUT_MS` and
    `ARTISYN_OTEL_MAX_BODY_BYTES`.
  - `--shared` together with `--owner` or `--dir` → exit 2 with one stderr line.
  - **Which script:** a repo hook spawns its **own** plugin copy of `otel-receiver.js` (FR-A15,
    "first spawner wins"). Only `otel-ensure-receiver.js` spawns the `bin/` copy.
  - **Newer hook, older receiver already running:** the hook uses it as is. It writes only the
    FR-A10 one-time capability `warn` and never restarts it. The newer code takes over after the
    receiver's idle-exit.
  - Cwd is `os.tmpdir()` (unchanged).
  - `EADDRINUSE` → exit 0 (unchanged).
- **DD-8 Idle timeout.** Shared mode uses a fixed `SHARED_IDLE_TIMEOUT_MS = 600000` (10 min, the
  same as today's legacy default, per FR-A3). Hooks always pass it. The repo key
  `otelReceiverIdleTimeoutMs` is ignored for the shared launch, because no single repo owns the
  receiver. Scenarios pass a small `--idle-timeout-ms`.
- **DD-9 Auth handshake (FR-A2, FR-A14).** HMAC-SHA256 with `token` as the key. Node `crypto`
  only; compare with `timingSafeEqual`.
  1. `POST /artisyn/hello` with body `{clientNonce, ownerHash}`, where `clientNonce` is 32 hex
     chars and `ownerHash` = `sha256(normalizedHome)` hex.
     - An `ownerHash` that differs from the receiver's own → `409 {error:'owner-mismatch'}`, no path.
     - Otherwise → `200 {serverNonce, proof, receiverVersion, contract, capabilities}`, with
       `proof = HMAC(token, "srv\n"+clientNonce+"\n"+serverNonce)`.
     - Server nonces are single-use, expire after 30 s, and at most 256 are outstanding (oldest
       evicted).
  2. The hook verifies `proof` before it sends anything secret. A bad proof, a non-JSON answer or a
     409 → `port-conflict` (DD-17).
  3. `register`, `session-status` and `shutdown` carry the header
     `x-artisyn-auth: v1 <serverNonce> <HMAC(token, "cli\n"+serverNonce+"\n"+urlPath+"\n"+sha256hex(rawBody))>`.
     A missing or bad header, or an unknown or used nonce → `401 {error:'unauthorized'}`, plus one
     `receiver.log` line `auth-reject route=…`. Nothing is spawned or registered.

  The existing Origin/Referer and Content-Type defences run first, unchanged.
- **DD-10 Register contract (FR-A4, FR-A10, AC-A8).**
  - **Request:** `{sessionId, gitRoot, otelDir, hookVersion, contract:1, repoKey,
    signals:{logs,metrics,spans}, uploader, realtime:{enabled, serverUrl, apiKey, intervalMs}|null}`.
    - Required: `sessionId` (`SESSION_ID_RE`), `gitRoot`, `otelDir` (absolute), `hookVersion`.
    - A missing or invalid required field → `400 {error:'bad-request', reason:'<field> missing|invalid'}`.
    - Unknown fields are ignored.
    - `uploader` is accepted only if it is an absolute, existing file named `send-logs-hook.js`
      under `gitRoot` or under `~/.claude/plugins/` (realpath-checked). Otherwise
      `400 {reason:'uploader-not-allowed'}`.
  - **Response 200:** `{ok:true, receiverVersion, contract:1, capabilities, rebound}`.
    `capabilities` = `['shared','auth-v1','spans','realtime','forward','session-status']`.
  - **RegistryEntry** = the request fields plus `registeredAt`, `lastSeenAt`,
    `received:{logs,metrics,spans}` and `firstRecordAt`.
    - TTL is 24 h since `lastSeenAt`, which is updated by register and by every routed record.
    - A re-register replaces the entry but keeps its counters, and logs
      `register-rebind session=… from=<repoKey> to=<repoKey>` when `repoKey` changed.
    - The registry is persisted with a 5 s debounce, at idle-exit and on shutdown. It is loaded
      at start, dropping expired entries.
- **DD-11 Session-status contract (FR-A16).** `POST /artisyn/session-status {sessionId}` →
  `{receiverVersion, registered, received:{logs,metrics,spans}, firstRecordAt|null, pending, forward:'ok'|'degraded'|'off'}`.
  An unknown session → `registered:false` with zero counts.

### Effective config and reason

- **DD-12 Managed-settings sources (FR-C3).** The table lives in `managed-settings.js` and its TS
  twin. Rules:
  - Rules are **per signal** (PoC item 7): the managed scope wins key by key, and
    `readManagedOtel` returns `pinnedSignals` and `disabledSignals`.
  - **Pinned:** a signal is pinned when a managed source sets its per-signal endpoint, or the
    generic `OTEL_EXPORTER_OTLP_ENDPOINT`. The generic case was not PoC-tested and is assumed to
    cover every signal.
  - **Disabled:** a signal is disabled when the managed `CLAUDE_CODE_ENABLE_TELEMETRY` is
    `0`/`false` (all signals), or when that signal's managed exporter is `none`.
  - `managed-disabled` = at least one enabled signal is disabled and none of the enabled signals
    is pinned.
  - `managed-endpoint` = at least one enabled signal is pinned.
  - Unpinned signals keep flowing to the receiver, so a partly managed setup ends as `partial`
    with reason `managed-endpoint`.
  - The env `ARTISYN_MANAGED_SETTINGS_DIR` replaces the file location and disables the OS-policy
    reads. It is documented as test-only.

| OS | File | OS policy |
|---|---|---|
| win32 | `%ProgramFiles%\ClaudeCode\managed-settings.json` | `reg query HKLM\SOFTWARE\Policies\ClaudeCode` and `HKCU\…` value `Settings` (JSON string), `execFileSync`, timeout 1500 ms |
| darwin | `/Library/Application Support/ClaudeCode/managed-settings.json` | `/Library/Managed Preferences/com.anthropic.claudecode.plist` via `plutil -convert json -o -`, timeout 1500 ms |
| linux | `/etc/claude-code/managed-settings.json` | none |
| all | `<claudeConfigDir>/remote-settings.json` (server-managed cache) | — |

- **DD-13 Claude Code version.** The order of sources:
  1. a `version` field in the session transcript, scanning the last 64 KiB;
  2. the cache `claude-version.json`;
  3. once per 24 h, `claude --version` (`execFile`, shell on win32, timeout 1500 ms), which
     refreshes the cache.

  SessionStart logs `claude-version=<v|unknown> source=<transcript|cache|cli|none>` (FR-E1).
- **DD-14 Effective-config resolution (FR-B4, FR-E2, FR-D10).** Per Artisyn key, find the
  effective scope (managed > local > project > user for Claude Code < 2.1.282 — Claude Code's own
  settings precedence, where the user file is the lowest file scope; managed > user for ≥ 2.1.282 or
  unknown, because the project scopes are ignored for telemetry keys there) and list ignored keys.
  Corrected 2026-10-31: the first draft had user above local/project, contrary to the Claude Code
  settings docs.
  - One `warn` per SessionStart for each class:
    - `project-only`: keys only in project scope on ≥ 2.1.282;
    - `endpoint-drift`: the user-scope endpoint is not Artisyn-owned and `forward.json` mode is
      `proxy` or `replace`;
    - `port-mismatch`.
  - Never writes a file.
- **DD-15 Reason, state and the write rule.** These are pure functions in `otel-status.js`,
  documented in `algorithms/otel-status-reason.md`.
  - **State:** `ok` = every enabled signal has ≥ 1 record; `partial` = some do; `none` = none
    (`received` excludes pending).
  - **Reason**, first match wins:
    1. `receiver-down` (unreachable, or `port-conflict` detail);
    2. state `ok` → `null`;
    3. `managed-disabled`;
    4. `managed-endpoint`;
    5. `project-only`: no Artisyn endpoint in user scope, an Artisyn endpoint in project scope,
       version ≥ 2.1.282 or unknown;
    6. `not-configured`: no effective Artisyn endpoint;
    7. `unknown`.
  - **Write rule:**
    - At Stop: write if not yet written and total received ≥ 1, or if already written and the
      state rank improved (none < partial < ok).
    - At SessionEnd: write if not yet written, or if the state improved.
    - The per-session written state is kept in the existing `throttle-state.js` state file. It is
      an `otelStatusWritten: {[sessionId]: {state, at}}` map, read and written through two new
      exports, `readOtelStatusMark(sessionId)` and `writeOtelStatusMark(sessionId, state)`.
      Entries older than 24 h are pruned on write.
- **DD-16 `otel-status` event line (FR-C4).**

  ```json
  {"type": "otel-status", "timestamp": "<ISO>", "sessionId": "<id>",
   "state": "ok|partial|none", "reason": "<reason>|null", "detail": "<string>|null",
   "received": {"logs": 0, "metrics": 0, "spans": 0, "firstAt": "<ISO>|null"},
   "claudeVersion": "<v>|null", "forward": "ok|degraded|off",
   "hookVersion": "<v>", "receiverVersion": "<v>|null"}
  ```

  It is appended to the session's artisyn log before that Stop's or SessionEnd's upload, plus one
  `hook.log` line `otel-status state=… reason=…`. A missing `session-status` capability or a 404
  → `reason:'unknown'`, `detail:'no-session-status'`.
- **DD-17 Port conflict (FR-A1, AC-A11).** A non-200 or non-JSON hello, a bad proof, a 409, or a
  spawned receiver that dies with `EADDRINUSE` while hello still fails within 2 s → one `warn`
  `otel port-conflict port=<n>` per session and `reason=receiver-down`, `detail=port-conflict`.
  The hook never allocates a port.

### Routing, uploads, forwarding

- **DD-18 Routing (FR-A6, FR-A7, FR-A13).** Per record, documented in
  `algorithms/otel-shared-routing.md`:
  1. Resolve `session.id` (record first, then resource).
  2. If a registry entry exists → route there if its `signals[signal]` is true, else drop and
     count `dropped-signal`.
  3. Else, if the resource attribute `artisyn.repo=<repoKey>` matches a `repos.json` entry → route
     to that entry's `otelDir`, with signals logs + metrics, plus spans if `traces`.
  4. Else → pending spool.

  - **Spool:** in memory, TTL 5 min per record, cap 5000 records per receiver; on overflow the
    oldest is dropped and `pending-overflow` is counted. It is re-routed on register; expired
    records are dropped and counted.
  - **Register wins:** a tag that conflicts with the registration is ignored.
  - **Missing session id:** a record without a session id goes to pending under the key
    `"__none__"` and expires.
- **DD-19 Uploads and realtime per repo (FR-A8, FR-A9).**
  - The sweep keeps one quiet-timer per `gitRoot` with routed data. It spawns that repo's
    registered `uploader` with `--otel-sweep --cwd <gitRoot>`. For tag-routed repos it uses the
    `repos.json` `uploader`.
  - The realtime queue, timers and backoff are keyed by `gitRoot`. They use the registration's
    `realtime` target; `readRealtimeTarget(gitRoot)` stays only for legacy mode.
    `RT_BUFFER_MAX_LINES` applies per key.
  - Chunk lines get `hookVersion` from the entry and a new `receiverVersion`.
  - After start, nothing is read next to the script (FR-A12).
  - **Spawning repo deleted (AC-A5).** The receiver keeps serving every other repo.
    - Records routed to a repo whose `otelDir` is gone hit the existing `dir-gone` check, are
      dropped and counted for that repo only, and log one `dir-gone repo=<repoKey>` line.
    - That repo's sweep and realtime timers stop.
    - Its registry and `repos.json` entries stay until the TTL or an uninstall.
  - **Log lines (FR-E3, FR-E4).** The format stays `<ISO> <event> <message>`. The shared log is
    `<stateDir>/receiver.log`.
    - Each per-repo slice of an OTLP request writes
      `ingest repo=<repoKey> receiverVersion=<v> signal=… bytes=… sessions=… records=… dropped=… writeErrors=…`
      to the shared log. The same line is mirrored into `<otelDir>/receiver.log`, today's per-repo
      path, of the target repo.
    - Pending records log `ingest repo=pending …` in the shared log only.
    - The idle-exit line is `idle-exit idleMs=<n> ingests=<count since start> sessions=<registry size>`.
- **DD-20 Forwarding (FR-D5, FR-D6, FR-D8).** Enabled when `forward.json` `mode` is `proxy`;
  read at start and on each hello (mtime check).
  - Each OTLP request for a signal in `forward.json.signals` is queued **before** routing, so
    every session is covered, including unregistered ones.
  - The upstream gets the raw request bytes and every incoming header except `host`,
    `connection`, `content-length`, `transfer-encoding` and `x-artisyn-*`. The receiver answers
    Claude Code `200` after the local write.
  - Queue cap: 1000 requests or 32 MiB per signal.
  - Retry 429, 5xx and network errors with backoff 1 s → 60 s, at most 6 attempts. Other 4xx are
    dropped.
  - Log line `forward signal=… status=… queued=… dropped=…`, never header values. An idle-exit
    summary is logged.
  - `forward` = `off` when the mode is not `proxy`; `degraded` when there were drops or retries in
    the last 5 min; else `ok`.
- **DD-21 User-level SessionStart hook (FR-D7).** Installed only in `proxy` mode. It is the
  `~/.claude/settings.json` entry
  `hooks.SessionStart[{hooks:[{type:'command', command:'node "<home>/.artisyn/otel/bin/otel-ensure-receiver.js"', timeout:5}]}]`.
  `otel-ensure-receiver.js` (standalone, Node built-ins only):
  1. read `port.json` and `token`;
  2. hello with a 500 ms timeout;
  3. if there is no answer, spawn `bin/otel-receiver.js` with the shared argv, detached and
     hidden;
  4. exit 0 silently.

  It is recognised by its command containing `.artisyn/otel/bin/otel-ensure-receiver.js`.
- **DD-22 Legacy callers on the shared port.** Old hooks never read the shared port (FR-A11).
  If one does (for example a stale `otelReceiverPort`):
  - an unauthenticated `--owner`-style register or shutdown gets 401;
  - the receiver keeps running;
  - an old hook's 409/restart path then hits `EADDRINUSE` and its spawned copy exits 0.

  A scenario pins this (DD-2 fixture).

### Installer

- **DD-23 User settings writer (FR-B1, FR-D11).**
  - `readUserSettingsForMutation`: abort on invalid JSON with no write.
  - `validateUserSettingsShape` runs before every save. The checked types:
    - `env`: an object of string values;
    - `hooks`: an object of arrays;
    - `otelHeadersHelper`: a string;
    - `_artisynOtel`: an object.

    A violation → abort with a message, file untouched.
  - The pre-write copy goes to `<settings>.artisyn-bak`.
  - The per-key merge reuses `mergeOtelEnv` and `isArtisynOwnedOtelValue`. Ownership is extended
    so that the endpoint keys are owned when they point at the per-user port.
  - The `.claude/settings.local.json` mirror (FR-B2) points at the same port. It gains
    `OTEL_RESOURCE_ATTRIBUTES`. The local value = the user-scope value (if any) + the existing local
    value + `artisyn.repo=<repoKey>`, comma-joined and deduped. A local value replaces the user
    value, so the user's attributes are carried over.
- **DD-24 Foreign collector (FR-D1–FR-D4).**
  - **Foreign** = a user-scope or process-env OTLP endpoint key or `otelHeadersHelper` that is
    not Artisyn-owned.
  - **`fingerprint`** = `sha256` of a canonical JSON of the foreign keys, with header values
    replaced by `sha256(value)`.
  - **Choice resolution:** `--otel-existing=` → the stored mode when `forward.json.fingerprint`
    matches → a TTY prompt → `keep`.
  - **The prompt** lists per signal the endpoint, protocol, `headers: set` (never values) and the
    exporter. It names the added stream changes (FR-D9): `OTEL_LOG_TOOL_DETAILS=1`, export
    intervals, and traces if on.
  - **`grpc` or `http/protobuf`:** say so, then offer three choices: enter an OTLP/HTTP URL, `keep`,
    or `replace`. Non-interactive → `keep` plus a message.
  - **`_artisynOtel`** = `{note, mode, previous:{KEY: masked}, backup:'<path to forward.json>'}`,
    where masked = `set` for header keys and the value otherwise.
- **DD-25 Upgrade from the per-project receiver (FR-A0, AC-A9).**
  - `applyHooksUpdate` no longer calls `stopExistingReceiverIfRunning` for the shared port.
  - It writes the shared port into `otelReceiverPort` (`log-hub.local.json`) and the local mirror,
    and deletes `.artisyn/config/otel-port.json`.
  - The old per-project receiver is left to its idle-exit.
  - `verifyInstalledReceiver` runs the shared handshake: hello + an authenticated session-status
    against a receiver spawned from `bin/` when none answers.
  - `--otel-port <n>` pins `port.json` and rewrites the user file, every `repos.json` repo's
    local mirror and `otelReceiverPort`, then prints "restart Claude Code".
  - `--restart-otel-receiver` sends an authenticated `POST /artisyn/shutdown` and waits via
    `stopReceiverAndWait`.
- **DD-26 Managed (FR-C5, FR-C6).** When DD-12 finds managed OTEL keys:
  - the installer writes no user OTEL keys;
  - it still writes the local mirror and the `repos.json` entry;
  - it prints "OTEL is managed by your organization — OTEL tabs are unavailable, everything else
    works".
- **DD-27 Uninstall (FR-B3, AC-B2).** Removing the last `repos.json` entry:
  - restores the `forward.json.original` keys exactly;
  - removes the Artisyn keys, `_artisynOtel` and the DD-21 hook entry from the user file;
  - unlinks the listed state files one by one, then `rmdir` (non-recursive) `bin/` and `otel/` if
    empty.

  An entry that is not the last only removes itself. `~/.claude/settings.json.artisyn-bak` is
  kept: it is the user's safety copy and the uninstall message names it.

### Server and UI

- **DD-28 Storage (FR-C7).** The writer is `upsertSessionOtelStatus(db, sessionRowId, event)`,
  modelled on `upsertSessionClaudeVersionOtel` (`server/src/logs/session-stats-writer.ts:229`).
  - It is the sole writer of `otel_state`, `otel_reason` and `otel_status`, and is called from
    the artisyn ingest beside step 5c.
  - Latest event `timestamp` wins: no update when the stored `otel_status->>'timestamp'` is newer.
  - An unknown `state` or `reason` → `'unknown'`.
  - The `otel_status` jsonb holds `{timestamp, detail, received, claudeVersion, forward, hookVersion, receiverVersion}`.
  - `upsertSessionStatsRow` must not touch these columns.
- **DD-29 Coverage (FR-C7, AC-C4).** It is computed over the same root-session scope and filters
  as the facts reader.
  - `otelSessions` = roots where the existing `hasOtel` predicate holds, or `otel_state` is `ok`
    or `partial`.
  - `totalSessions` counts all roots in scope.
  - `otelUsers` = the distinct users among `otelSessions`.
  - `reasons` = the other roots grouped by `COALESCE(otel_reason, 'no-status')`, sorted by count
    descending.
  - The team version is summed across team repos.
- **DD-30 Cost marker.** `costExcludesUtilityCalls` = the root session has no `otel_calls` rows
  **and** `otel_state IS DISTINCT FROM 'ok'`. It is computed for the session list
  `costBreakdown` and for the session OTEL route.
- **DD-31 Reason UI table.** `OTEL_REASON_MESSAGES` in
  `client/src/viewer/pages/repository/otel/otel.constants.ts`. The title, body and help anchor for
  each key come verbatim from `wireframes/otel-reason-messages.svg`.

| Key | Chip colour | Help anchor (section in `user-docs/otel-tab.md`) |
|---|---|---|
| `managed-endpoint` | red | `admin-managed-otel` |
| `managed-disabled` | red | `admin-managed-otel` |
| `project-only` | amber | `claude-code-21282-change` |
| `not-configured` | amber | `enable-otel-and-traces` |
| `receiver-down` | amber | `troubleshooting-otel-tab-is-empty` |
| `unknown` | grey | `troubleshooting-otel-tab-is-empty` |
| `no-status` | grey | `otel-tab-is-empty` |

Anchors are the `rehype-slug` (github-slugger) ids of the headings, which drop dots: the heading
"Claude Code 2.1.282 change" gets the id `claude-code-21282-change` (originally planned as
`claude-code-2-1-282-change`, which no heading can produce; corrected in chunk 16).

The "Still works / Not available" lists are shared by every reason (wireframe
`session-otel-tab-no-data.svg`).

### Constants and docs content

- **DD-32 Constants.** Each constant is defined once in the file that owns it. JS and TS twins
  repeat the value with a comment that names the twin.

| Constant | Value | Home |
|---|---|---|
| `SHARED_IDLE_TIMEOUT_MS` | 600000 | `otel-receiver.js`, `otel-register.js` |
| `REGISTER_CONTRACT` | 1 | `otel-receiver.js`, `otel-register.js` |
| `CAPABILITIES` | DD-10 list | `otel-receiver.js` |
| `NONCE_TTL_MS` / `NONCE_MAX` | 30000 / 256 | `otel-receiver.js` |
| `REGISTRY_TTL_MS` / `REGISTRY_PERSIST_DEBOUNCE_MS` | 86400000 / 5000 | `otel-receiver.js` |
| `PENDING_TTL_MS` / `PENDING_MAX_RECORDS` | 300000 / 5000 | `otel-receiver.js` |
| `FORWARD_QUEUE_MAX_REQUESTS` / `FORWARD_QUEUE_MAX_BYTES` | 1000 / 33554432 | `otel-receiver.js` |
| `FORWARD_BACKOFF_MIN_MS` / `FORWARD_BACKOFF_MAX_MS` / `FORWARD_MAX_ATTEMPTS` | 1000 / 60000 / 6 | `otel-receiver.js` |
| `FORWARD_DEGRADED_WINDOW_MS` | 300000 | `otel-receiver.js` |
| `REPO_ATTR_KEY` | `'artisyn.repo'` | `otel-receiver.js`, `user-state.js`, `otel-env.ts` |
| `HELLO_TIMEOUT_MS` (hook) / `ENSURE_HELLO_TIMEOUT_MS` (user hook) | 2000 / 500 | `otel-register.js` / `otel-ensure-receiver.js` |
| `SESSION_STATUS_TIMEOUT_MS` | 2000 | `otel-register.js`, `otel-handshake.ts` |
| `SPAWN_HELLO_RETRY_MS` | 2000 | `otel-register.js` |
| `TRANSCRIPT_VERSION_SCAN_BYTES` | 65536 | `otel-status.js` |
| `CLAUDE_VERSION_CLI_INTERVAL_MS` / `CLAUDE_VERSION_CLI_TIMEOUT_MS` | 86400000 / 1500 | `otel-status.js` |
| `OS_POLICY_TIMEOUT_MS` | 1500 | `managed-settings.js`, `managed-settings.ts` |
| `CLAUDE_CODE_PROJECT_OTEL_CUTOFF` | `'2.1.282'` | `otel-status.js` |
| `OTEL_REASON_KEYS` / `OTEL_STATES` | the DD-31 keys without `no-status` / `['ok','partial','none','unknown']` | `server/src/logs/otel/otel-facts.constants.ts` (used by extractor, writer, controller validation) |
| `OTEL_REASON_FILTER_KEYS` | `OTEL_REASON_KEYS` + `'no-status'` | `server/src/logs/otel/otel-facts.constants.ts`; client mirror in `otel.constants.ts` |

- **DD-33 Session filter indicator.** `RepositorySessionsPanel.tsx` shows an active `otelReason`
  filter as a removable chip `OTEL: <reason title> ×`, styled like the existing filter chips.
  Clearing it resets the filter state in `useRepositoryViewState.ts`.
- **DD-34 User-docs content (FR-G).**
  - **"What Log Hub collects and how":**
    - Signals: logs, metrics, traces. Tool details come via `OTEL_LOG_TOOL_DETAILS`; no prompt or
      response content is collected.
    - The path: Claude Code → loopback receiver on a per-user port → per-repo chunks →
      upload/realtime.
    - The DD-23 keys and which file each goes to: `~/.claude/settings.json` because Claude Code ≥
      2.1.282 needs them there, and the `.claude/settings.local.json` mirror for older versions.
    - The proxy / keep / replace choice and the FR-D9 stream changes.
  - **"Claude Code 2.1.282 change":** from 2.1.282 Claude Code ignores telemetry keys in
    `.claude/settings.json` and `.claude/settings.local.json`; they must be in user or managed
    settings; older versions still read the project file. Link as an extra:
    `https://code.claude.com/docs/en/monitoring-usage`.
  - **"Admin-managed OTEL":** managed settings (file, OS policy/MDM, server-managed from the
    admin console) that pin the endpoint or disable telemetry win by design, and the user can do
    nothing about it.
    - Still works: sessions, prompts, tools, files, attribution, Log Hub cost.
    - Not available: OTEL tabs, traces, telemetry cost reconciliation, utility-call cost.
    - The only route is the admin.
  - **"Troubleshooting: OTEL tab is empty":** one subsection per DD-31 reason, each with what it
    means, how to check (`/status`, `claude doctor`, `claude --debug`, `hook.log`,
    `~/.artisyn/otel/receiver.log`) and how to fix (restart Claude Code after install, re-run the
    installer, upgrade the hook, ask the admin).
  - **The admin guide:** the DD-12 managed locations, the keys to set (DD-23 list, pointing at a
    collector that forwards to Log Hub), how to verify (`/status`, OTEL tab), and what users see
    (`managed-endpoint` / `managed-disabled` panels).

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `server/drizzle/migrations/0079_otel_status.sql` | new columns | DD-28; guarded `ADD COLUMN IF NOT EXISTS` |
| `server/drizzle/migrations/meta/_journal.json` | register 0079 | same as previous hand-written migrations |
| `server/src/database/schema/index.ts` | `sessionStats` columns | after `claudeVersionOtel` (:1082) |
| `server/src/logs/artisyn-extractor.ts` | `extractOtelStatus`, `NON_ACTIVITY_LINE_TYPES` | pattern `extractHookStatus` (:292), set at :87 |
| `server/src/logs/session-stats-writer.ts` | `upsertSessionOtelStatus` | DD-28 |
| `server/src/logs/logs.service.ts` | call writer | beside step 5c (:597) |
| `server/src/logs/otel/otel-facts.types.ts` | `OtelCoverage`, `OtelStatusDto`, `OtelReasonKey` | near `OtelRepoKpis` (:138), `OtelSessionStatus` (:285) |
| `server/src/logs/otel/otel-facts.constants.ts` | `OTEL_REASON_KEYS`, `OTEL_STATES`, `OTEL_REASON_FILTER_KEYS` | DD-32 |
| `server/src/logs/otel/otel-facts-read.sql.ts`, `otel-facts.reader.ts` | coverage SQL and assembly (repo, team), session `otelStatus` | DD-29 |
| `server/src/logs/otel/otel-facts.controller.ts`, `otel-team-facts.controller.ts` | return the new fields | routes at :233, :257, team :90 |
| `server/src/logs/otel-cost.sql.ts` | `costExcludesUtilityCalls` expression | DD-30; `telemetryCost` at :175–186 |
| `server/src/logs/repositories.controller.ts` | `costBreakdown.costExcludesUtilityCalls`, `otelReason` query param and validation | `costBreakdown` at :609/:687 |
| `scripts/build-hooks-installer.js` | add `user-state.js`, `managed-settings.js`, `otel-status.js`, `otel-ensure-receiver.js` to `HOOK_JS_FILES` (:97) | else `assertHookFilesComplete()` fails |
| `hook/.claude/telemetry_tool/throttle-state.js` | `readOtelStatusMark`, `writeOtelStatusMark` | DD-15 |
| `INSTALL_HOOK.md` | refreshed by the `update-install-instructions` skill | Chunk 11 |
| `hook/.claude/telemetry_tool/user-state.js` | new: state-dir paths, atomic JSON I/O, token, repoKey | DD-4, DD-5 |
| `hook/.claude/telemetry_tool/managed-settings.js` | new: managed sources reader | DD-12 |
| `hook/.claude/telemetry_tool/otel-status.js` | new: effective config, reason, state, write rule, Claude version | DD-13–DD-16 |
| `hook/.claude/telemetry_tool/otel-ensure-receiver.js` | new: user-level SessionStart hook | DD-21 |
| `hook/.claude/telemetry_tool/otel-receiver.js` | shared mode, auth, registry, routing, spool, status, forward | DD-7–DD-11, DD-18–DD-20 |
| `hook/.claude/telemetry_tool/otel-register.js` | hello, auth, shared register, capability warn, no restart on shared | DD-9, DD-10 |
| `hook/.claude/telemetry_tool/env-context.js` | `resolveOtelPort` shared path | DD-6 |
| `hook/.claude/telemetry_tool/otel-endpoint-check.js` | effective-config warnings | DD-14 |
| `hook/.claude/telemetry_tool/lifecycle-hook.js` | SessionStart version log | DD-13 |
| `hook/.claude/telemetry_tool/send-logs-hook.js` | `otel-status` at Stop and SessionEnd | DD-15, DD-16 |
| `hook/.claude/telemetry_tool/version.json` | 2.30.0 | DD-1 |
| `hook/.claude/telemetry_tool/__tests__/otel-shared-routing.algo.test.js` | new table test | DD-18 |
| `hook/.claude/telemetry_tool/__tests__/otel-status-reason.algo.test.js` | new table test | DD-15 |
| `artisyn-hooks-installer/src/user-state.ts` | new TS twin of `user-state.js` | erasable TS only |
| `artisyn-hooks-installer/src/managed-settings.ts` | new TS twin | DD-12 |
| `artisyn-hooks-installer/src/otel-handshake.ts` | new: TS hello, proof check, `x-artisyn-auth`, session-status and shutdown client | DD-9, DD-11 |
| `client/src/viewer/pages/repository/RepositorySessionsPanel.tsx` | active `otelReason` filter chip | DD-33 |
| `artisyn-hooks-installer/src/user-settings.ts` | new: read, validate, back up, merge user file, note, user hook entry | DD-23, DD-24, DD-21 |
| `artisyn-hooks-installer/src/foreign-otel.ts` | new: detection, fingerprint, prompt, `forward.json` | DD-24 |
| `artisyn-hooks-installer/src/install.ts` | upgrade flow, shared verify, uninstall, copy `bin/` | DD-25–DD-27 |
| `artisyn-hooks-installer/src/otel-env.ts` | `OTEL_RESOURCE_ATTRIBUTES` builder | DD-23 |
| `artisyn-hooks-installer/src/index.ts` | `--otel-existing=`, `--restart-otel-receiver`, `--otel-port` semantics, help/usage text for all three | pattern `--otel-traces=` (:76) |
| `artisyn-hooks-installer/src/otel-restart.ts` | authenticated shutdown | DD-25 |
| `docker-dev/provision.mjs` | write container `~/.artisyn/otel/port.json`, token, user settings | sandbox user scope |
| `.artisyn/marketplace/plugins/log-hub-hooks/scripts/*`, `.claude-plugin/plugin.json` | dogfood copy | per `.claude/rules/hook.md` |
| `tests/fixtures/legacy-hooks/README.md` | note on the 2.28.0 row: last per-project-receiver hook | DD-2 |
| `docs/pocs/2026-10-30-2327-otel-user-scope-behaviour/run.mjs`, `README.md` | `managed` experiment | DD-3 |
| `client/src/models/repositories.ts`, `client/src/models/teams.ts` | DTO mirrors | API changes |
| `client/src/viewer/api.ts` | `otelReason` sessions filter param | API changes |
| `client/src/viewer/pages/repository/otel/otel.constants.ts` | `OTEL_REASON_MESSAGES`, anchors | DD-31 |
| `client/src/viewer/pages/repository/otel/OtelReasonPanel.tsx` | new: session no-data panel | wireframe session |
| `client/src/viewer/pages/repository/otel/OtelCoverageBanner.tsx` | new: banner and chips | wireframe repo |
| `client/src/viewer/pages/repository/otel/OtelPartialBanner.tsx` | new: amber partial banner | pattern `OtelSlowUpdatesBanner.tsx` |
| `client/src/viewer/pages/repository/otel/OtelEmptyState.tsx` | `reason` variant (0 of M) | wireframe repo variant |
| `client/src/viewer/pages/repository/otel/OtelKpiTiles.tsx` | "Sessions with OTEL" tile | |
| `client/src/viewer/pages/repository/otel/RepoOtelTab.tsx` | banner, tile, 0-of-M variant | :206 |
| `client/src/viewer/pages/repository/session-log/otel/SessionOtelTab.tsx` | reason panel, partial banner | |
| `client/src/viewer/pages/teams/otel/TeamOtelTab.tsx` | banner | |
| `client/src/viewer/components/UtilityCallsMarker.tsx` | new: cost marker | DD-30 |
| `client/src/viewer/pages/repository/SessionDetailHeader.tsx`, `session-log/summary/SummaryExecutiveBand.tsx`, `client/src/viewer/lib/cost-hints.ts` | marker placement and text | :136/:274, :42 |
| `client/src/viewer/pages/repository/useRepositoryViewState.ts` | chip → sessions filter state | |
| `user-docs/otel-tab.md` | new sections | FR-G1–FR-G5 |
| `user-docs/otel-admin-guide.md`, `user-docs/nav.json` | new admin page | FR-G6 |
| `hook/README.md`, `release-template/INSTALL.md` | self-contained summary | FR-G1 |
| `docs/knowledgebase/otel-receiver.md`, `hook-installation.md`, `hook-api-versioning.md`, `otel-tabs.md`, `db-tables.md`, `api-reference.md`, `client-component-map.md`, `hook-system-overview.md`, `algorithms/README.md`, `index.md` | KB | Chunk 15 |
| `docs/knowledgebase/algorithms/otel-shared-routing.md`, `otel-status-reason.md` | new algorithm docs | test policy kind 1 |
| `server/test/contract/registry/f25-otel.ts`, `f17-sessions.ts`, `f15-ingest.ts` | contract rows | test policy kind 2 |
| `tests/scenarios/helpers/hook-process.ts` | `spawnSharedReceiver`, `sharedHello`, `authedRequest`, `startFakeCollector` | |
| `tests/scenarios/hook/s-hook-07.spec.ts`, `s-hook-01.spec.ts`, `s-compat-01.spec.ts`; `tests/scenarios/installer/s-inst-01.spec.ts`, `s-inst-04.spec.ts`; `tests/scenarios/view/s-otel-01.spec.ts`, `s-cost-01.spec.ts` | scenario steps | test policy kind 3 |

## API changes

All changes are additive. Old clients and old hooks ignore the new fields.

**Hook ↔ receiver (loopback, shared mode only):**

| Route | Auth | Request | Response |
|---|---|---|---|
| `POST /artisyn/hello` | none | `{clientNonce, ownerHash}` | `200 {serverNonce, proof, receiverVersion, contract:1, capabilities[]}` · `409 {error:'owner-mismatch'}` |
| `POST /artisyn/register` | `x-artisyn-auth` | DD-10 | `200 {ok, receiverVersion, contract, capabilities, rebound}` · `400 {error, reason}` · `401` |
| `POST /artisyn/session-status` | `x-artisyn-auth` | `{sessionId}` | DD-11 · `401` |
| `POST /artisyn/shutdown` | `x-artisyn-auth` | `{}` | `200 {ok}` then exit · `401` |
| OTLP `POST /v1/logs\|metrics\|traces` | none (unchanged) | OTLP JSON | `200` after the local write; forwarding is async |

**Hook → server:** the new artisyn line type `otel-status` (DD-16) goes through the existing upload
routes, and is added to `NON_ACTIVITY_LINE_TYPES`.

**Server → client:**

```ts
// server/src/logs/otel/otel-facts.types.ts (mirrored in client/src/models/repositories.ts / teams.ts)
export type OtelReasonKey =
  | 'managed-endpoint' | 'managed-disabled' | 'not-configured'
  | 'project-only' | 'receiver-down' | 'unknown' | 'no-status';
export interface OtelCoverage {
  otelSessions: number;
  totalSessions: number;
  otelUsers: number;
  reasons: { reason: OtelReasonKey; count: number }[];
}
export interface OtelStatusDto {
  state: 'ok' | 'partial' | 'none' | 'unknown';
  reason: Exclude<OtelReasonKey, 'no-status'> | null;
  detail: string | null;
  received: { logs: number; metrics: number; spans: number; firstAt: string | null };
  claudeVersion: string | null;
  hookVersion: string | null;
  receiverVersion: string | null;
  forward: 'ok' | 'degraded' | 'off' | null;
}
```

- `GET /api/v1/repositories/:repoId/otel/facts` and `GET /api/v1/teams/:teamId/otel/facts` gain
  `coverage: OtelCoverage`.
- `GET /api/v1/repositories/:repoId/sessions/:sessionId/otel` gains
  `status.otelStatus: OtelStatusDto | null` and `status.costExcludesUtilityCalls: boolean`.
  `status` is the `OtelSessionStatus` object.
- `GET /api/v1/repositories/:repoId/sessions` gains `costBreakdown.costExcludesUtilityCalls: boolean`
  per item, and an optional query param `otelReason=<OtelReasonKey>`. The param keeps only root
  sessions without OTEL data whose `COALESCE(otel_reason,'no-status')` equals it. An unknown value
  → 400, the same as other enum filters.

## Database changes

`0079_otel_status.sql`, hand-written (never `drizzle-kit generate`; follow the
`migrations-data-integrity` skill). Every statement is guarded.

```sql
ALTER TABLE session_stats ADD COLUMN IF NOT EXISTS otel_state varchar(16);
ALTER TABLE session_stats ADD COLUMN IF NOT EXISTS otel_reason varchar(32);
ALTER TABLE session_stats ADD COLUMN IF NOT EXISTS otel_status jsonb;
```

- Nullable, with no default and no backfill (NULL = no status reported). They are metadata-only
  `ADD COLUMN`s, so no table rewrite.
- No index: coverage reads filter by the already indexed session scope.
- Drizzle: `otelState: varchar('otel_state', {length:16})`,
  `otelReason: varchar('otel_reason', {length:32})`, `otelStatus: jsonb('otel_status')`.
- Rollback note in the header comment: drop the three columns. Nothing else depends on them.

## Test coverage plan

Per the CLAUDE.md test policy, only the three allowed kinds:

- **Algorithm (kind 1):**
  - The new doc `docs/knowledgebase/algorithms/otel-shared-routing.md` covers DD-18 routing, the
    signal filter, the spool TTL and overflow, tag fallback versus registration, and
    `uploader-not-allowed` validation, plus `forwardHeaders` and `forwardHealth` (DD-20). Its
    table test is
    `hook/.claude/telemetry_tool/__tests__/otel-shared-routing.algo.test.js`.
  - The new doc `otel-status-reason.md` covers DD-14 effective scope, DD-15 state, reason and the
    write rule. Its table test is `__tests__/otel-status-reason.algo.test.js`.
  - Both docs follow `algorithms/README.md` and use `scripts/algo-docs/load-examples.cjs`.
- **API contract (kind 2):**
  - `f25-otel.ts`:
    - `REPO_FACTS` and `TEAM_FACTS` rows assert `coverage` with SQL oracles, covering mixed,
      all-OTEL and zero-OTEL cases;
    - `SESSION_OTEL` rows assert `otelStatus` (null and populated) and `costExcludesUtilityCalls`.
  - `f17-sessions.ts`: `costBreakdown.costExcludesUtilityCalls` and the `otelReason` filter,
    including a 400 for an unknown value.
  - `f15-ingest.ts`: an artisyn upload with `otel-status` sets the three columns, an older
    timestamp does not overwrite, an unknown reason is stored as `unknown`, and `end_time` is
    unchanged.
- **Scenario (kind 3):** steps are added to existing specs.
  - `s-hook-07`: the shared receiver.
    - Hello, 409, 401 and proof checks.
    - Register 400/200 with capabilities.
    - Two-repo routing with a single listener.
    - `otelTraces:false` drops spans for one repo.
    - Pending → register delivery and TTL drop.
    - Registry survives a restart.
    - Tag fallback.
    - Session-status.
    - Idle-exit with a short `--idle-timeout-ms` (the ingest count is in the idle line).
    - Forwarding to a fake collector: byte-identical payloads, header passthrough, an upstream
      down → `degraded` with counted drops.
    - The `ingest` line mirrored into the repo `receiver.log`.
    - Port conflict.
    - Deleting the spawning repo.
  - `s-hook-01`: the `otel-status` write rule (Stop with records, SessionEnd none, a late
    correction to `ok`) and an old hub accepting it.
  - `s-compat-01`: frozen 2.28.0 keeps its per-project port next to a shared receiver; a legacy
    register or shutdown on the shared port → 401 and the receiver stays up.
  - `s-inst-01`:
    - user-file keys, local mirror, `OTEL_RESOURCE_ATTRIBUTES`, `port.json` and `repos.json`;
    - upgrade from the per-project receiver with no stale port;
    - `--otel-port` re-pin;
    - managed via `ARTISYN_MANAGED_SETTINGS_DIR`;
    - an invalid-typed user file → abort with no write;
    - the SessionStart version log and the project-only `warn`.
  - `s-inst-04`: proxy / keep / replace, the `grpc` message, non-interactive `keep`, the
    `_artisynOtel` note, uninstall restoring byte-identical settings and removing the state files,
    the drift `warn`, and no header values in any output or log.
  - `s-otel-01`: the reason panel per reason, the generic message, the partial banner, the
    coverage banner, tile and chips (the filter applies), the 0-of-M variant and the help links.
  - `s-cost-01`: the utility-call marker in the header and on the Summary tile.
- **AC-X1** is a manual final check (Chunk 19), not an automated test.

## Visual/UX notes

- **Session OTEL tab, no data** (`state` none or NULL):
  - Shown in the dashed `OtelEmptyState` panel area as `OtelReasonPanel`.
  - Status line (muted, small): `OTEL status: <state> · reason <key> · hook <v> · Claude Code <v> · forward <f>`.
  - Then: title (semibold), body, two side-by-side boxes "Still works ✓ / Not available ✗"
    (stacked under 640 px), the help button (`OtelHelpLink`) and the counts line
    `Received by the receiver at Stop: logs n · metrics n · spans n · first record <time|—>`.
  - NULL status → generic title and body from DD-31 `no-status`, with no status line.
- **Partial:** the normal chart, with a slim amber `OtelPartialBanner` above it: "Only <present>
  arrived — <missing> missing (reason …). Help →".
- **Repo and team tabs:**
  - `OtelCoverageBanner` sits under the chart header.
    - Text: "OTEL for N of M sessions — totals and averages below cover these N sessions only; the
      other M−N are not counted as zero."
    - Chips coloured per DD-31, with "Why no OTEL?". A chip click sets the sessions-list
      `otelReason` filter and switches to the Sessions tab.
    - Hidden when N = M.
  - KPI tile "Sessions with OTEL": `N / M`, sub-line `<round(N/M·100)> % coverage · <users> users`.
  - With N = 0: `OtelEmptyState` variant `reason` replaces the chart and tiles. It shows the
    dominant reason's body, a "Show 1 month" button (sets the period to 30 d) and help.
- **Cost marker:** muted text "excl. utility calls (no OTEL)" with an ⓘ tooltip (text in
  `cost-hints.ts`) next to the cost in `SessionDetailHeader`, and on the Summary Cost tile.
- **Components:** use the `ui-components` skill conventions and the existing amber banner and chip
  styles. Dark mode comes through the existing tokens.

## Wireframes

No changes: the three SVGs in `wireframes/` are the reference. DD-31 maps them to keys and anchors.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Schema | 4 | same branch, on top of 0078 (DD-1) |
| 2 | Pre-work: PoC + legacy fixture | 4 | before any hook edit; may amend DD-12 |
| 3 | Hook shared modules | 7 | needs 2 |
| 4 | Receiver: shared launch, auth, register | 7 | needs 3 |
| 5 | Receiver: routing, spool, uploads, status | 7 | needs 4 |
| 6 | Receiver: forwarding | 5 | needs 5 |
| 7 | Hook client side | 7 | needs 4, 5 |
| 8 | Hook `otel-status` event | 5 | needs 7 |
| 9 | Installer: user scope + upgrade | 8 | needs 3, 4 |
| 10 | Installer: foreign collector, managed, uninstall | 8 | needs 6, 9 |
| 11 | Hook release + propagation | 6 | needs 3–10 |
| 12 | Server ingest + API | 8 | needs 1 |
| 13 | Client data layer + session tab | 6 | needs 12 |
| 14 | Client repo/team coverage + cost marker | 8 | needs 13 |
| 15 | Knowledgebase | 7 | needs 3–14 |
| 16 | User docs | 6 | needs 15 |
| 17 | Algorithm tests + contract rows | 6 | needs 3, 5, 12 |
| 18 | Scenarios: hook + compat | 7 | needs 11, 12 |
| 19 | Scenarios: installer + view + final check | 8 | needs everything |

### Chunk 1 — Schema

- [ ] Create `server/drizzle/migrations/0079_otel_status.sql` with the three guarded `ADD COLUMN IF NOT EXISTS` statements and the header comment, per Database changes.
- [ ] Register 0079 in `server/drizzle/migrations/meta/_journal.json`, following the 0078 entry.
- [ ] Add `otelState`, `otelReason` and `otelStatus` to `sessionStats` in `server/src/database/schema/index.ts` after `claudeVersionOtel`, per Database changes.
- [ ] Run the `post-impl-check-migrations` steps (clean-DB migrate) locally to confirm 0079 applies on top of 0078.

### Chunk 2 — Pre-work: PoC + legacy fixture

- [x] Add a `managed` experiment to `docs/pocs/2026-10-30-2327-otel-user-scope-behaviour/run.mjs` (four variants per the PoC README; refuses unelevated; removes only its own file).
- [x] Developer ran `--only managed` elevated and captured `claude doctor` with project-only keys; record the results as PoC README items 7–8 (AC-F1).
- [x] Amend DD-12/DD-15 to the per-signal managed rules found by the PoC.
- [ ] Add "also the last per-project-receiver hook" to the 2.28.0 row of `tests/fixtures/legacy-hooks/README.md` per DD-2 (no new freeze).

### Chunk 3 — Hook shared modules

- [x] Create `hook/.claude/telemetry_tool/user-state.js` with: `otelStateDir()`, `readPortFile`, `readOrCreateToken`, `readRepos`, `readForward`, `atomicWriteJson`, `repoKey(gitRoot)`, `ownerHash(home)`. Files and shapes per DD-4 and DD-5; Node built-ins only.
- [x] Create `hook/.claude/telemetry_tool/managed-settings.js` with `readManagedOtel({homeDir, env})` → `{sources, env, pinnedSignals, disabledSignals}`. Sources, timeouts and the `ARTISYN_MANAGED_SETTINGS_DIR` override per DD-12; fail-silent per source.
- [x] Create `hook/.claude/telemetry_tool/otel-status.js` with the pure functions `resolveEffectiveOtel(scopes, claudeVersion)`, `deriveState(received, signals)`, `deriveReason(input)` and `shouldWriteStatus(phase, prev, next)`, per DD-14 and DD-15.
- [x] Add `resolveClaudeVersion({transcriptPath})` to `otel-status.js` per DD-13 (transcript tail → cache → `claude --version` once per 24 h, updating `claude-version.json`).
- [x] Create `hook/.claude/telemetry_tool/otel-ensure-receiver.js` per DD-21: standalone, Node built-ins only, with its own copy of the hello and proof check (DD-9). Use `ENSURE_HELLO_TIMEOUT_MS`, spawn `bin/otel-receiver.js` detached and hidden with the DD-7 argv, never print, always exit 0.
- [x] Export the pure functions from each module for table tests. Keep `otel-receiver.js` standalone: it must not `require` these modules (duplicate `repoKey`/`ownerHash` there, with a comment naming the twin).
- [x] Add `user-state.js`, `managed-settings.js`, `otel-status.js` and `otel-ensure-receiver.js` to `HOOK_JS_FILES` in `scripts/build-hooks-installer.js` (:97). Add `readOtelStatusMark`/`writeOtelStatusMark` to `throttle-state.js` per DD-15. Run `adlc-lh:check-health` with `finalRun: false`.

### Chunk 4 — Receiver: shared launch, auth, register

- [ ] Extend `parseArgs`/`ARGV_FLAGS`/`ENV_FALLBACKS` in `otel-receiver.js` (:161–255) with `--shared`, `--owner-home`, `--state-dir` and their env twins. Enforce the exclusivity and exit codes per DD-7; the legacy `--owner` path is unchanged.
- [ ] Add every `otel-receiver.js` constant from DD-32 near the existing constants (:70–100).
- [ ] In shared mode, load the token from `<stateDir>/token` at start. Without a token, exit 0 with one `receiver.log` line.
- [ ] Add a `POST /artisyn/hello` handler and an `x-artisyn-auth` verifier per DD-9. Expose the verifier as `requireAuth(req, rawBody)` for every shared-mode authenticated route (register here; session-status and shutdown in Chunk 5). A 401 logs `auth-reject`.
- [ ] Add the shared `handleRegister` branch: required-field and `uploader` validation, the 200 response shape and the rebind log, per DD-10.
- [ ] Add the registry: load at start (drop expired), 24 h TTL, 5 s debounced persist to `<stateDir>/registry.json`, flush at idle-exit and shutdown, per DD-10.
- [ ] Make the shared-mode logging go to `<stateDir>/receiver.log`. The `start listening` line names `mode=shared` and the `ownerHash` prefix, never the home path (FR-A2).

### Chunk 5 — Receiver: routing, spool, uploads, status

- [ ] Refactor `writeGroups` (:557) to take a target `{otelDir, gitRoot, hookVersion}` per group. Implement the shared routing per DD-18 as an exported pure `routeRecord(ctx)`; the per-repo `dir-gone` check stays.
- [ ] Add the pending spool (TTL 5 min, cap 5000, overflow and expiry counters) and re-route it on register, per DD-18.
- [ ] Change `withHookVersion` (:527) to stamp the entry's `hookVersion` plus `receiverVersion` on every chunk line, per DD-19.
- [ ] Make `spawnOtelSweep` (:796) per `gitRoot`, spawning the registered `uploader` (or the `repos.json` uploader for tag-routed repos) with `--otel-sweep --cwd <gitRoot>`, per DD-19.
- [ ] Key the realtime queues, timers and backoff by `gitRoot`, using the registration's `realtime` target. Keep `readRealtimeTarget` for legacy mode only, per DD-19.
- [ ] Add the shared-mode `POST /artisyn/session-status` (DD-11) and the shared `handleShutdown` branch (flush the registry, then exit), both behind `requireAuth`. This chunk owns both. Update the per-entry counters and `firstRecordAt` on routed records.
- [ ] Write the DD-19 "Log lines": the shared `ingest` line mirrored into the target repo's `<otelDir>/receiver.log`, the pending `ingest` line, and the idle-exit line with `ingests=`.

### Chunk 6 — Receiver: forwarding

- [ ] Read `<stateDir>/forward.json` at start and re-read it on mtime change at hello; enable it only for `mode:'proxy'` and the listed signals, per DD-20.
- [ ] Before routing, enqueue each OTLP request (raw bytes plus filtered headers) for forwarded signals; send it to the signal's upstream URL with `http`/`https` built-ins, per DD-20.
- [ ] Implement the bounded queue (1000 requests / 32 MiB per signal), retry with backoff 1 s → 60 s up to 6 attempts on 429, 5xx and network errors, drop on other 4xx, and the drop counters.
- [ ] Log `forward signal=… status=… queued=… dropped=…` (no header values) and the idle-exit forward summary. Compute the `forward` health for session-status per DD-20.
- [ ] Export the pure `forwardHeaders(incoming)` and `forwardHealth(stats, now)` helpers for the routing algorithm doc rows.

### Chunk 7 — Hook client side

- [ ] Change `resolveOtelPort` in `env-context.js` (:459) to return `{mode:'shared'|'legacy', port}` per DD-6. Update every caller, with one `warn` on a missing `port.json` or a port mismatch.
- [ ] Add `sharedHandshake(port)` to `otel-register.js`: hello, proof verification, the `x-artisyn-auth` builder, and a 409, bad proof or garbage answer → `port-conflict`, per DD-9 and DD-17.
- [ ] Extend `buildRegistrationPayload` (:102) to the DD-10 request (`signals` from `otelEnabled`/`otelTraces`, `uploader` = absolute path of this `send-logs-hook.js`, realtime target, `repoKey`, `contract:1`).
- [ ] Shared-mode launch in `buildReceiverLaunch` (:333) per DD-7, with idle `SHARED_IDLE_TIMEOUT_MS` (600000). Spawn only when hello gets no answer; after `EADDRINUSE`, retry hello for 2 s, then `port-conflict`.
- [ ] Make `handleRegisterResponse` (:188) never stop or restart in shared mode; write one `warn` per session for missing needed capabilities (`spans` if traces, `realtime` if enabled, `session-status`), per FR-A10.
- [ ] Update `otel-endpoint-check.js` to compute the effective config via `resolveEffectiveOtel` and `readManagedOtel`, and to emit the DD-14 warnings (`project-only`, `endpoint-drift`, `port-mismatch`) once per SessionStart with no file writes.
- [ ] In `lifecycle-hook.js` SessionStart (~:225), log the Claude Code version via `resolveClaudeVersion` per DD-13 before `announceOtelSession`.

### Chunk 8 — Hook `otel-status` event

- [ ] Add `queryOtelSessionStatus(port, sessionId)` to `otel-register.js` (authenticated, 2 s timeout). It returns the DD-11 body, `{unreachable:true}` or `{unsupported:true}` on 404 or a missing capability.
- [ ] Add `buildOtelStatusEvent(...)` to `otel-status.js`, producing the DD-16 line from the status answer, `deriveState`, `deriveReason` (managed, effective config, version) and the hook version.
- [ ] In `send-logs-hook.js` `main()` (:709), at Stop and SessionEnd, apply `shouldWriteStatus` with `readOtelStatusMark`/`writeOtelStatusMark` (DD-15), and append the event to the artisyn log before the upload (pattern `hook-status` :1727).
- [ ] Write one `hook.log` line `otel-status state=… reason=… detail=…` whenever an event is written.
- [ ] In legacy mode (DD-6 fallback), write `otel-status` with `reason` from `deriveReason` and counts `{0,0,0}`, `detail:'legacy-receiver'`, only at SessionEnd.

### Chunk 9 — Installer: user scope + upgrade

- [ ] Create `artisyn-hooks-installer/src/user-state.ts` and `managed-settings.ts` (TS twins of Chunk 3's modules, DD-4/5/12) and `otel-handshake.ts`: hello, proof check, the `x-artisyn-auth` builder, `sessionStatus` and `shutdown` per DD-9/DD-11. Erasable syntax only; DD-32 constants.
- [ ] Create `artisyn-hooks-installer/src/user-settings.ts` with: `readUserSettingsForMutation`, `validateUserSettingsShape`, `backupUserSettings`, `writeUserSettings` (atomic), and an owned-key merge reusing `mergeOtelEnv`/`isArtisynOwnedOtelValue` extended for the per-user port, per DD-23.
- [ ] In `install.ts`, allocate or reuse `port.json` via the existing `allocateOtelPort` (:1548), create the token, and upsert the `repos.json` entry for this repo, per DD-4.
- [ ] Write the Artisyn keys from `OTEL_ENV_KEYS`/`OTEL_TRACE_ENV_KEYS` to the user file, and the same port to the `.claude/settings.local.json` mirror plus `OTEL_RESOURCE_ATTRIBUTES` (new builder in `otel-env.ts`), per DD-23.
- [ ] Rework `applyHooksUpdate` (:656) per DD-25: drop `stopExistingReceiverIfRunning` for the shared port, write `otelReceiverPort` = the shared port, and delete `.artisyn/config/otel-port.json` and the readers of it.
- [ ] Copy `otel-receiver.js`, `version.json` and `otel-ensure-receiver.js` into `~/.artisyn/otel/bin/` on every install and upgrade (overwrite own files only).
- [ ] Rework `verifyInstalledReceiver` (:1762) to the shared handshake per DD-25, spawning the `bin/` receiver when none answers.
- [ ] Re-purpose `--otel-port <n>` (`index.ts`) to pin `port.json` and rewrite the user file, every `repos.json` repo's local mirror and `otelReceiverPort`, then print "restart Claude Code", per DD-25.

### Chunk 10 — Installer: foreign collector, managed, uninstall

- [ ] Create `artisyn-hooks-installer/src/foreign-otel.ts`: detect the user-scope and process-env foreign config, compute the `fingerprint`, and render the masked per-signal summary, per DD-24.
- [ ] Add `--otel-existing=proxy|keep|replace` parsing in `index.ts` (pattern `--otel-traces=` :76; rejected for uninstall). Resolve the choice in the order flag → stored matching fingerprint → TTY prompt (existing `prompt()` :1146) → `keep`.
- [ ] Implement the `grpc`/`http/protobuf` branch per DD-24: the message plus URL / keep / replace prompt, and `keep` with a message when non-interactive.
- [ ] Implement `proxy` and `replace`: save `forward.json` (original keys and per-signal upstream URLs; generic endpoint + `/v1/<signal>`), set the endpoints to the receiver, keep the header keys and `otelHeadersHelper` for proxy, and write `_artisynOtel` per DD-24.
- [ ] Add and remove the DD-21 user-level SessionStart hook entry in the user file, only for `proxy`, reusing the `settingsHasInstallerHooks`/`removeInstallerHookEntries` recognition pattern (:1867–1930).
- [ ] Managed branch per DD-26: skip the user OTEL keys, print the managed message, still write the local mirror and the `repos.json` entry.
- [ ] Extend `runUninstall` (:1095) per DD-27: the last-repo restore of the original keys, and removing the Artisyn keys, `_artisynOtel`, the user hook and the listed state files with a non-recursive `rmdir`.
- [ ] Add `--restart-otel-receiver` in `index.ts`, calling `otel-handshake.ts` `shutdown` and then `stopReceiverAndWait` from `otel-restart.ts`, per DD-25.

### Chunk 11 — Hook release + propagation

- [ ] Bump `hook/.claude/telemetry_tool/version.json` to `2.30.0`.
- [ ] Run `npm run build:hooks-installer` to sync the installer package and tarballs. Confirm the four new hook files are in the tarball, and update `scripts/__tests__/build-hooks-installer.test.js` only if it fails on the new list.
- [ ] Copy every changed and new hook script (incl. `user-state.js`, `managed-settings.js`, `otel-status.js`, `otel-ensure-receiver.js`) to `.artisyn/marketplace/plugins/log-hub-hooks/scripts/` and bump its `.claude-plugin/plugin.json`, per `.claude/rules/hook.md`.
- [ ] Run the `update-install-instructions` skill to refresh INSTALL_HOOK.md.
- [ ] Update `docker-dev/provision.mjs` so the sandbox writes `~/.artisyn/otel/port.json` (its fixed `SANDBOX_OTEL_PORT`), a token and the user-scope OTEL keys inside the container, besides the local mirror.
- [ ] Run the fast set (`adlc-lh:check-health`, `finalRun: false`).

### Chunk 12 — Server ingest + API

- [ ] Add `extractOtelStatus(lines)` to `server/src/logs/artisyn-extractor.ts` (pattern `extractHookStatus` :292; normalises unknown values to `unknown`), and add `'otel-status'` to `NON_ACTIVITY_LINE_TYPES` (:87).
- [ ] Add `upsertSessionOtelStatus` to `server/src/logs/session-stats-writer.ts` per DD-28. Confirm that `upsertSessionStatsRow` leaves the three columns out of its `set`.
- [ ] Call `upsertSessionOtelStatus` in `server/src/logs/logs.service.ts` next to step 5c (:597) for the upload's session row when the event is present.
- [ ] Add the `OtelReasonKey`, `OtelCoverage` and `OtelStatusDto` types to `server/src/logs/otel/otel-facts.types.ts`, and `otelStatus`/`costExcludesUtilityCalls` to `OtelSessionStatus` (:285), per API changes.
- [ ] Add the DD-32 server constants to `otel-facts.constants.ts`. Add the coverage SQL per DD-29 to `otel-facts-read.sql.ts` and its assembly in `otel-facts.reader.ts`. Return `coverage` from `GET :repoId/otel/facts` (`otel-facts.controller.ts:233`).
- [ ] Add the summed team coverage per DD-29 in `otel-facts-read.sql.ts`/`otel-facts.reader.ts`, returned from `GET :teamId/otel/facts` (`otel-team-facts.controller.ts:90`).
- [ ] Add the DD-30 expression to `server/src/logs/otel-cost.sql.ts`. Return `otelStatus` and `costExcludesUtilityCalls` from `GET :repoId/sessions/:sessionId/otel` (`otel-facts.controller.ts:257`) via `otel-facts.reader.ts`.
- [ ] In `repositories.controller.ts` (:609/:687), add `costBreakdown.costExcludesUtilityCalls` (DD-30, from `otel-cost.sql.ts`) and the `otelReason` query filter: validate it against `OTEL_REASON_FILTER_KEYS` (400 when unknown) and filter per API changes.

### Chunk 13 — Client data layer + session tab

- [ ] Mirror `OtelReasonKey`, `OtelCoverage`, `OtelStatusDto` and the new fields in `client/src/models/repositories.ts` and `client/src/models/teams.ts`, and `costExcludesUtilityCalls` in the session `costBreakdown` type.
- [ ] Add the `otelReason` param to the sessions-list call in `client/src/viewer/api.ts`, and the filter state in `useRepositoryViewState.ts`.
- [ ] Add `OTEL_REASON_MESSAGES`, the chip colours and the "Still works / Not available" lists to `otel.constants.ts` per DD-31; add the new anchors to `OTEL_HELP_ANCHORS` (:39).
- [ ] Create `client/src/viewer/pages/repository/otel/OtelReasonPanel.tsx` per Visual/UX notes (status line, title/body, two boxes, help link, counts line; the generic `no-status` variant).
- [ ] Create `OtelPartialBanner.tsx` (pattern `OtelSlowUpdatesBanner.tsx`), naming the present and missing signals, the reason and the help link.
- [ ] Wire `SessionOtelTab.tsx`: `state` none or NULL → `OtelReasonPanel`; `partial` → banner above the chart; `ok` → unchanged.

### Chunk 14 — Client repo/team coverage + cost marker

- [ ] Create `client/src/viewer/pages/repository/otel/OtelCoverageBanner.tsx` per Visual/UX notes (text, coloured chips, "Why no OTEL?", hidden when N = M; a chip click calls an `onReasonFilter` prop).
- [ ] Add the "Sessions with OTEL" tile to `OtelKpiTiles.tsx` (`N / M`, `<pct> % coverage · <users> users`, pct = `Math.round(N/M*100)`).
- [ ] Add the `reason` variant to `OtelEmptyState.tsx` for N = 0 (dominant reason body, "Show 1 month" → 30 d period, help link).
- [ ] Wire `RepoOtelTab.tsx` (:206): banner, tile, N = 0 variant; the chip sets the sessions `otelReason` filter and switches to the Sessions tab.
- [ ] Wire `client/src/viewer/pages/teams/otel/TeamOtelTab.tsx` with the banner and tile from the team `coverage` (chips without the filter action).
- [ ] Create `client/src/viewer/components/UtilityCallsMarker.tsx` (muted text + ⓘ tooltip, text in `client/src/viewer/lib/cost-hints.ts`, help link to the reason section).
- [ ] Render `UtilityCallsMarker` when `costExcludesUtilityCalls` is true, in `SessionDetailHeader.tsx` (:136/:274) and on the Summary Cost tile in `SummaryExecutiveBand.tsx`.
- [ ] Add the DD-33 removable `OTEL: <reason> ×` filter chip to `RepositorySessionsPanel.tsx`.

### Chunk 15 — Knowledgebase

- [ ] Rewrite `docs/knowledgebase/otel-receiver.md`: replace "One receiver per project — always" and "Rejected alternatives" with the shared design (DD-4–DD-11, DD-18–DD-22). Scope the stale-restart section to legacy ports.
- [ ] Update the `docs/knowledgebase/hook-installation.md` §"OTEL Settings": user-file writer, validation and backup, local mirror, resource attributes, `port.json`/`repos.json`, foreign-collector flow, the new flags and uninstall (DD-23–DD-27).
- [ ] Update `docs/knowledgebase/hook-api-versioning.md` §"Hook ↔ OTEL receiver": hello/auth, register contract 1, capabilities, session-status, FR-A11 compatibility reasoning, and the `otel-status` event; fix the stale "warn only" text.
- [ ] Update `docs/knowledgebase/otel-tabs.md` (coverage, reason UI, compat matrix rows for hooks ≤ 2.28.0 and Claude Code < / ≥ 2.1.282) and `db-tables.md` (three columns).
- [ ] Update `api-reference.md`, `client-component-map.md` (the new components) and `hook-system-overview.md` (new files, `otel-status` event).
- [ ] Write `docs/knowledgebase/algorithms/otel-shared-routing.md` and `otel-status-reason.md` in the `algorithms/README.md` format, with examples blocks covering DD-18 and DD-14/DD-15 rows; list them in `algorithms/README.md`.
- [ ] Update `docs/knowledgebase/index.md` if any KB file was added or renamed (algorithm docs are listed via `algorithms/README.md`).

### Chunk 16 — User docs

- [ ] Add the "What Log Hub collects and how" section to `user-docs/otel-tab.md`, with content per DD-34.
- [ ] Add the "Claude Code 2.1.282 change" section (anchor `claude-code-21282-change`) to `user-docs/otel-tab.md`, with content and link per DD-34.
- [ ] Add the "Admin-managed OTEL" and "Troubleshooting: OTEL tab is empty" sections to `user-docs/otel-tab.md`, with content per DD-34 and anchors per DD-31.
- [ ] Create `user-docs/otel-admin-guide.md` with content per DD-34 (admin guide) and add it to `user-docs/nav.json`.
- [ ] Add a self-contained summary (shared receiver, user settings, version boundary, managed OTEL, `--otel-existing`) to `hook/README.md` and `release-template/INSTALL.md`.
- [ ] Run `npm run build:help` and `npm run build:site`, and confirm every DD-31 anchor resolves (`user-docs-links` rules).

### Chunk 17 — Algorithm tests + contract rows

- [x] Create `hook/.claude/telemetry_tool/__tests__/otel-shared-routing.algo.test.js`, loading the `otel-shared-routing.md` examples via `scripts/algo-docs/load-examples.cjs` against `routeRecord`, the spool, `forwardHeaders`, `forwardHealth` and the uploader validation.
- [x] Create `__tests__/otel-status-reason.algo.test.js` for the `otel-status-reason.md` examples against `resolveEffectiveOtel`, `deriveState`, `deriveReason` and `shouldWriteStatus`.
- [x] Add `REPO_FACTS` and `TEAM_FACTS` rows to `server/test/contract/registry/f25-otel.ts` asserting `coverage` (mixed, all-OTEL, zero-OTEL) with SQL oracles; seed `otel_state`/`otel_reason` in the fixture rows.
- [x] Add `SESSION_OTEL` rows to `f25-otel.ts`: `otelStatus` null and populated, and `costExcludesUtilityCalls` true and false.
- [x] Add rows to `server/test/contract/registry/f17-sessions.ts`: `costBreakdown.costExcludesUtilityCalls`, the `otelReason` filter and a 400 on an unknown value.
- [x] Add rows to `server/test/contract/registry/f15-ingest.ts`: `otel-status` stored, an older timestamp ignored, an unknown reason → `unknown`, `end_time` unchanged. — (done in chunk 17: the contract run parks the upload worker, so `F15-upload-otel-status` pins only the enqueue of such a body; the stored columns, the older-timestamp rule, `unknown` and the unchanged `end_time` are checked by the new step 11 of `@S-INGEST-02`.)

### Chunk 18 — Scenarios: hook + compat

- [ ] Add `spawnSharedReceiver`, `sharedHello`, `authedRequest` (DD-9 header) and `startFakeCollector` (records raw bytes and headers, a switchable down mode) to `tests/scenarios/helpers/hook-process.ts`.
- [ ] `s-hook-07` steps: hello, 409, proof, 401; register 400/200 with capabilities; uploader rejected (AC-A8, AC-A10).
- [ ] `s-hook-07` steps:
  - two repos on one listener, each in its own `otelDir`, with entry `hookVersion` plus `receiverVersion` and the repo B uploader sweep;
  - `otelTraces:false` drop;
  - deleting the spawning repo;
  - ingest line mirroring.

  Covers AC-A1, A2, A5, A6, E2.
- [ ] `s-hook-07` steps: pending → register delivery and TTL drop; registry after restart and expiry; tag fallback; session-status; idle-exit with a short timeout and the ingest count; port conflict (AC-A4, A7, A11, A12, A13, E1).
- [ ] `s-hook-07` forwarding steps against `startFakeCollector`: byte-identical payloads for registered and unregistered sessions, header passthrough with no values in logs, upstream down → drops counted and `forward=degraded` (AC-D1, D5, D6, D9).
- [ ] `s-hook-01` steps: `otel-status` written at the first Stop with records, at SessionEnd with none, a late correction to `ok`, and an old hub accepting the upload (AC-C2).
- [ ] `s-compat-01` steps with frozen 2.28.0: per-project port untouched next to a shared receiver; a legacy register and shutdown on the shared port → 401, the receiver stays up (AC-A3, DD-22).

### Chunk 19 — Scenarios: installer + view + final check

- [ ] `s-inst-01` steps: user-file keys with other keys untouched; local mirror on the same port; `OTEL_RESOURCE_ATTRIBUTES`; `port.json`/`repos.json`; upgrade from the per-project receiver with no stale port; `--otel-port` re-pin (AC-B1, AC-A9).
- [ ] `s-inst-01` steps: managed via `ARTISYN_MANAGED_SETTINGS_DIR` → message, no user keys (AC-C1 installer part); an invalid-typed user file → abort, file unchanged; the project-only `warn` and the version line in `hook.log` (AC-B3, AC-E1).
- [ ] `s-inst-04` steps:
  - a mock collector at an arbitrary port and path;
  - `--otel-existing=proxy`, with the note and backup;
  - `keep`, `replace`;
  - non-interactive default `keep`;
  - `grpc` message;
  - uninstall restoring byte-identical settings and removing the state files and the user hook.

  Covers AC-D2, D3, D4, D7, B2.
- [ ] `s-inst-04` steps: a manual endpoint edit → one drift `warn` and no file change (AC-D8); no header value in installer output, `hook.log` or `receiver.log` (AC-D5).
- [ ] `s-otel-01` steps: the reason panel for each DD-31 reason with its help link; the generic `no-status` message; the partial banner (AC-C3, AC-G2).
- [ ] `s-otel-01` steps: the coverage banner, tile and chips on repo and team; a chip filtering Sessions; the 0-of-M variant; the banner hidden at full coverage (AC-C4). Then `s-cost-01`: the utility-call marker in the header and the Summary tile (AC-C1 UI part).
- [ ] Run the full set (`adlc-lh:check-health`, `finalRun: true`) and fix the failures.
- [ ] AC-X1 manual check: a real `claude` prompt on Claude Code ≥ 2.1.282. Take Playwright screenshots (`use-playwright`) of the session/repo/team OTEL tabs, a no-OTEL reason, the proxy case, the in-app help with the admin guide, and the built site.
