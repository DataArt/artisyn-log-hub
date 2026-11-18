## Context for the receiver upload queue plan (task 2026-11-18-receiver-upload-queue)

This is research only; no files were changed. Structural questions were answered with grep and by reading the code, not with the `ce` graph.

### Requirements summary
Hook 3.0.0 / Log Hub 1.5.0. The per-user shared receiver (`otel-receiver.js`) becomes the only uploader for every repo of an OS user:
- **Queue:** `Stop` and `SessionEnd` write one job file into `~/.artisyn/upload/queue/`, named `<sessionId>_<timestamp>.json`, written as tmp then rename. The file holds no API key and carries cwd, gitRoot, transcriptPath, hookEvent, the env keys, the uploader path and the trigger. Then the hook exits (~100 ms target, ≤ ~200 ms).
- **Running a job:** the receiver runs each job by spawning that repo's own `send-logs-hook.js --run-job <path>`, checked with `isAllowedUploader`. The uploader takes the per-repo `.upload.lock` itself.
- **Retries and failures:** retryable errors back off and retry. Permanent errors, over-age jobs and jobs past the attempt cap go to `~/.artisyn/upload/failed/` with a `hook.log` line and a `hook-status` report.
- **Heartbeat:** `~/.artisyn/upload/heartbeat.json` with pid, version, capability and timestamp.
- **Fallback:** when the heartbeat is missing or stale, or the receiver is old, the hook uploads in-process as today. In that case `SessionEnd` waits < 1 s for the lock, then queues a job or logs `skipped`. A stuck job is taken over only by a `Stop` of its own repo, under the lock.
- **Receiver lifetime:** no idle-exit while retryable jobs are queued; leftover jobs are drained on start. The receiver starts regardless of `otelEnabled`, but OTEL records are stored only for repos with it on. Uploading must not depend on binding the OTLP port.
- **Phases:** (1) `SessionEnd` via the queue, (2) `Stop` plus retry, (3) receiver mandatory.
- **Also in the release:**
  - FR-11: check post-turn analysis ordering.
  - FR-16: Node unpatched/EOL warning, using a version table shipped in the hook. It appears as a `SessionStart` `systemMessage` merged with the OTEL warning, throttled to once a day per user. The installer prints the same warning, and `hook-status` gains a `nodeVersion` field.
  - FR-17: `/status` troubleshooting text in the docs.
  - Docs, diagrams and tests under the 3-kinds policy. No `~/.claude` user settings changes. Each repo's install stays self-contained.

### Wireframes
None referenced. Diagrams must follow the existing plain-text box style: fenced ```` ```text diagram=<id> ```` blocks using `┌─┐│└` and `──►`, as in `user-docs/otel-architecture.md:16-26`, `:43-55`, `:72-80`, `:88-98`, `:148-157`.

Also read:
- `notes.md` (hook.log evidence, 4 of 20 `SessionEnd` runs killed).
- PoC `docs/pocs/2026-11-18-1712-sessionend-hook-timeout/README.md`: `SESSION_END_HOOK_TIMEOUT_MS_DEFAULT = 1500`; a plugin hook's `timeout` field is ignored (killed at 1618 ms).
- `open_questions_ru.md`: both questions are answered — one task, no user-level hooks.

### Knowledgebase
- **`docs/knowledgebase/otel-receiver.md`** — the main article to extend.
  - User state is resolved per call from `os.homedir()` and never cached, so scenarios can fake HOME (:61-77).
  - Writes are tmp + rename with mode 0o600.
  - Receiver rules: Node built-ins only, never `require`s a hook module, cwd `os.tmpdir()` (:58-59, :454).
  - A hook never restarts a shared receiver; newer code takes over after idle-exit (:114-117).
  - New behaviour is announced as a new capability string, never by changing an existing one (:163-174; hook-api-versioning :228-233).
  - The sweep spawns the registered uploader with `--otel-sweep` (:604-635).
  - Idle timer and sweep tables: :440-455.
- **`docs/knowledgebase/hook-system-overview.md`**
  - Event wiring is `HOOKS_JSON` in `scripts/build-hooks-installer.js` (:41-57).
  - Upload pipeline and order within a `Stop` run: the current session's transcript goes first "because post-turn analysis needs it on the server" (:186-193). This bears directly on FR-11.
  - Lock budgets (:214-231), injected `hook-status` / `otel-status` lines (:253-283), local files table (:286-305).
  - Design rules: fail-open, built-ins only, every Node LTS, `engines` floor not raised (:311-332).
- **`docs/knowledgebase/hook-api-versioning.md`**
  - "Hook ↔ OTEL receiver" (:196-275) is where a receiver ↔ uploader `--run-job` contract and a new capability would be documented.
  - The `--otel-sweep` precedent (:523-540).
  - The "Hook-side behaviour history" table (:769+) needs a 3.0.0 row.
- **`docs/knowledgebase/hook-installation.md`** — OTEL settings (:392-645), per-user state. FR-14 asks for the `~/.artisyn/` layout and the receiver starting regardless of `otelEnabled` here.
- **`docs/knowledgebase/turn-end-cost-advisor.md:91-106`** ("Sessions not yet ingested") — the server accepts an advisor run for a session it has not ingested yet; orphan rows are cleaned after 24 h.
- **`docs/knowledgebase/twins-and-cross-cutting-rules.md`** — register the Node minimum-version table twin (hook JS ↔ installer TS) here. The "new background job → SKIP LOCKED" rule at :109 is server-only and does not apply to a local file queue.
- **`docs/knowledgebase/algorithms/README.md`** — doc-driven table tests:
  - Rows go in `docs/algorithm-examples/<name>.json`.
  - Rows are loaded with `scripts/algo-docs/load-examples.cjs`.
  - Hook tests are `__tests__/*.algo.test.js`, run by `hook/scripts/run-tests.js`, which reads the directory, so a new file is picked up automatically.
  - Candidate existing doc: `algorithms/otel-shared-routing.md`. New docs could be the job-name grammar, the hand-off decision, retry classification and Node classification.
- **`docs/knowledgebase/release-pipeline.md:56-78`** — root `package.json` holds the X.Y line; the patch comes from git tags (`scripts/ci/release-version.js`, `release-notes.js`).
- **`.claude/rules/hook.md`** — version bump steps:
  - bump `hook/.claude/telemetry_tool/version.json` (single source of truth);
  - run `npm run build:hooks-installer`;
  - copy the changed files into `.artisyn/marketplace/plugins/log-hub-hooks/scripts/` and update that plugin's `.claude-plugin/plugin.json` version;
  - run `npm run lint:fix` and `npm run lint` in `hook/`;
  - run the `update-install-instructions` skill (its file list is stale and does not mention `send-logs-hook.js`, `lifecycle-hook.js` or `otel-receiver.js`).

### Existing patterns
Paths below are under `hook/.claude/telemetry_tool/` unless shown otherwise.

**Upload entry point (`send-logs-hook.js`)**
- `:75-77` — `LOCK_WAIT_STOP_MS=2000`, `LOCK_WAIT_SESSION_END_MS=20000` (the bug), `LOCK_POLL_INTERVAL_MS=250`.
- `:633-643` `parseOtelSweepArgs` and `:860-867` the argv branch before the stdin read. This is the pattern for `--run-job <path>`.
- `:706-751` `runOtelSweep` — loads config from cwd, takes the lock with the short budget, exits 0 if busy, logs one summary line. A template for the job runner.
- `:824-858` `maybeWriteOtelStatus` — reads `process.env` (`:801`, `:831`) and the transcript path. A job run must rebuild this env from the job's recorded keys.
- `:860-976` `main()`:
  - `maybeReArmOtelSession` (`:915`) and `maybeWriteOtelStatus` (`:919`) both run before the lock.
  - Lock choice is at `:938-948`; dispatch to `runSessionEndFlush` / `runUpload` at `:950-961`.
  - The handshake can cost up to `HELLO_TIMEOUT_MS` 2000 plus `REGISTER_TIMEOUT_MS` 2000 when the 60 s throttle slot is claimed, which does not fit the 200 ms budget. `lifecycle-hook.js:259` re-arms on every other event anyway.
- `:1010-1051` `runSessionEndFlush` — the scoped flush, no manifest.
- `:1060+` `runUpload` — the full scan. It needs only cwd, sessionId, config and `CLAUDE_CONFIG_DIR` (`:1102`). It returns no overall status: failures are counted per file (`:1698/1725/1817`), the timeout recommendation is at `:1862`, and the final `done:` line at `:1940`.
- `:1893-1900` `hookStatusEvent` — the place for the additive `nodeVersion` field and for queue/failed-job reporting.
- `:1952-1958` — the uploader always exits 0, so there is no exit-code channel back to a caller today.

**Upload helpers**
- `upload-logs.js:432-616` `uploadFile` — failure results carry `statusCode` (null for timeout or network errors) plus `reason`. The `uploadFileChunked` result (`:789-922`) also carries it. This is the basis for retryable vs permanent classification.
- `upload-logs.js:1018-1200` lock code:
  - `tryCreateUploadLock` uses `wx` and writes `{startedAt,pid,host}`.
  - `isUploadLockStale` checks dead-pid and age; the stale window is `2*sendLogsOnPromptTimeoutMs` (60 s × 2 = 120 s by default).
  - `acquireUploadLockWithWait`, `describeUploadLockHolder`, `releaseUploadLock`.

**Receiver (`otel-receiver.js`)**
- `:1125-1157` `spawnUploader` — detached, `windowsHide`, cwd `os.tmpdir()`, `unref`. A job runner needs a non-unref'd variant that listens for `exit` to drive retries.
- `:1187-1196` `resolveSweepUploader` — re-checks `isAllowedUploader` (`:2332-2346`).
- `:1033-1072` `armIdleTimer` — the hook point for "no idle-exit while retryable jobs are queued".
- `:1230-1250` `sweepTick` / `startSweepTimer` — an `unref`'d 60 s interval. Model for a queue poll timer and heartbeat timer.
- `:152` `CAPABILITIES` — add a new string, e.g. an upload-queue capability, and also put it in the heartbeat.
- `:3799-3835` `startShared` — exits when there is no token; drain the queue on start here.
- `:3837-3920` `listen` — `EADDRINUSE` leads to `process.exit(0)` at `:3874-3881` and any other error to `exit(1)`. This conflicts with FR-10 (see gaps).

**User state, registration, lifecycle**
- `user-state.js:59-110` — `otelStateDir` (per-call `os.homedir()`), `stateFilePath`, `atomicWriteJson` (tmp + rename, 0o600, dir 0o700). Model for `uploadStateDir`. The receiver cannot `require` it, so it needs a copy (as with `repoKey`/`ownerHash`).
- `otel-register.js`:
  - `:181-204` `buildRegistrationPayload` — signals are already turned off when `otelEnabled === false`, so phase 3 can register with all signals off.
  - `:697-750` `announceShared` — hello, spawn, register.
  - `:1010-1018` `maybeReArmOtelSession` — the `otelEnabled` gate to remove in phase 3.
- `lifecycle-hook.js`:
  - `:233` — `SessionStart && config.otelEnabled` gate (phase 3).
  - `:258` — single `fs.writeSync(1, JSON.stringify({systemMessage}))`. Merge the Node warning here.
  - `:268` — `setImmediate(() => process.exit(0))`.
  - `telemetry-hook.js:189` is another re-arm call site.
- `otel-endpoint-check.js:308-333` `checkOtelEndpoints` — returns a string or null and never throws. Model for `checkNodeVersion`.
- `throttle-state.js:52-99` `claimThrottleSlot` and `:197-213` `claimSessionWarning` — these are **per repo** (`<gitRoot>/.artisyn/ai_work_dir/`). The per-user daily Node throttle needs new state under `~/.artisyn/`.
- `spawn-hidden.js:55-80` `spawnDetachedHidden(script, argv, {env, role, sessionId, cwd, onError, onSpawned})` — hook-side spawns, and `process-marker.js:50` `buildProcessMarkerEnv`.

**Post-turn analysis (FR-11)**
- `post-turn-analysis-hook.js:91-113` — a separate `Stop` hook entry, run alongside `send-logs-hook.js` (wiring in `scripts/build-hooks-installer.js:362-366`, generated `hooks.json:223`). It spawns a detached worker that reads the local transcript.
- `post-turn-analysis-worker.js:2041` — `GET /api/v2/post-turn-analysis/config`. The aggregate comes from the DB; when it is null or `hasTelemetry=false`, the worker builds it locally (`:506`, `:1233`, `:1279`).
- `server/src/logs/turn-end-cost-advisor/turn-end-cost-advisor.controller.ts:29-50` with `service.ts:233-266` — the POST only checks ownership, and a `not-ingested` session is stored like `ok`.
- Conclusion: the POST does not need the session uploaded. The config aggregate does get worse (it falls back to the local build) when the upload has not happened yet.

**Installer (`artisyn-hooks-installer/src/install.ts`)**
- `:807-811` — `port.json` and `token` are already created on every install, with no `otelEnabled` gate.
- `:874-896` — `upsertRepoEntry` and `copyReceiverBin` (`:1777-1782`, `RECEIVER_BIN_FILES`).
- `:2408-2425` `warnIfNodeEol` — only checks major < 22. Extend it to the patched-minimum table. Called at `:958`, `:1187`, `:1268`.
- `:946` — "not working yet" text already names 22.23.5 / 24.22.3 / 26.13.1.

**Server**
- `server/src/logs/artisyn-extractor.ts:296-360` `extractHookStatus` — whitelists fields and silently drops unknown ones, so `nodeVersion` is accepted unchanged.
- `server/src/main.ts:96` — `ValidationPipe({whitelist:true, forbidNonWhitelisted:false})`.
- No route change is needed, so no contract registry row. `server/test/contract/registry/f15-ingest.ts` covers only `POST /api/v2/logs`.

**Scenarios**
- `tests/scenarios/hook/s-hook-01.spec.ts`:
  - `:308` step 7 — SessionEnd scoped flush.
  - `:330` step 9 — lock held / stale.
  - `:345-361` step 10 — **asserts SessionEnd waits ≥ 1500 ms for a busy lock. This must change** under FR-7 (< 1 s, then queue or skip).
  - `:367` step 11 — counts activate/done lines.
  - `:474` — `--otel-sweep`.
- `tests/scenarios/hook/s-hook-07.spec.ts`:
  - steps 15-27 cover the shared receiver: hello, auth, register, two repos (`:577`), `otelTraces` off (`:598`), restart / registry (`:703`), idle exit + sweep (`:730`).
  - `:741` step 27 — a foreign server on the port makes the receiver exit 0. This assertion must change under FR-10.
- `tests/scenarios/hook/s-compat-01.spec.ts:215` — frozen 1.6.2 / 2.6.1 / 2.28.0 hooks; legacy receiver beside the shared one at `:570-628`.
  - For AC-10b/AC-7 a 2.32.x frozen fixture may be needed: `scripts/scenarios/freeze-legacy-hook.mjs`, `tests/fixtures/legacy-hooks/`.
- `tests/scenarios/hook/s-hook-04.spec.ts:125` — server down / hanging / 500 / 401. Natural place for retry and `failed/` steps.
- Also touching this area: `sessions/s-hstate-03.spec.ts` (Hook State panel, for `nodeVersion` / failed-job reporting), `installer/s-inst-01.spec.ts:420`, `installer/s-inst-04.spec.ts`.
- Helpers in `tests/scenarios/helpers/hook-process.ts`:
  - `makeFakeHome` / `fakeHomeEnv` set HOME and USERPROFILE (`:176-190`).
  - `runScript` / `runNodeScript` (with `argv`, `home`) at `:347`; `readHookLog` at `:382`.
  - `spawnSharedReceiver` / `startSharedReceiver` (`:866-900`, with `--idle-timeout-ms`); `writeSharedState` at `:794`.
  - `startFakeLogHub` (`:491`) uses a custom responder, which can simulate 5xx / 429 / 4xx.
- Design docs for the scenarios: `docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md` (S-HOOK-01 at `:209`, S-HOOK-07 at `:330`, S-COMPAT-01 at `:401`).

**Docs to update (line anchors)**
- `hook/README.md` — `:9-10` Node requirement, `:24` / `:34` SessionStart and SessionEnd, `:59-100` OTEL / receiver.
- `hook/INSTALL_HOOK.md` — `:9-16` Node, `:59` background processes, `:113-152` install steps.
- `hook/HOW_HOOK_WORKS.md` — `:438-479` upload mechanics and the 20 s SessionEnd wait, `:614` prompt upload, `:686` hook log, `:717` skip reasons.
- `user-docs/otel-architecture.md` — `:37` one receiver, `:143-157` troubleshooting.
- `user-docs/data-collection.md` — `:123` when uploads happen, `:131` how, `:192` troubleshooting.
- `INSTALL_HOOK.md` event names are drift-checked against `HOOKS_JSON` (`build-hooks-installer.js:393-516`).

**Versions and changelog**
- Hook `version.json` and `plugin.json` are at 2.32.3; root `package.json:3` is 1.4.0.
- Changelog entries go to `docs/changelog/<YYYY-MM-DD-HHmm>-<slug>.md`.
- No test was found that checks `version.json` and `plugin.json` carry the same number.

### Open gaps (decide in the plan)
1. **No result channel from uploader to receiver.** `send-logs-hook.js` always exits 0 and `runUpload` returns no overall status. `--run-job` needs one, e.g. defined exit codes (0 done / retryable / permanent / lock-busy) or a result file next to the job. A per-file failure inside a full scan has to be mapped to a job-level outcome.
2. **Single instance without the port.** Today the OTLP bind *is* the single-instance guard: `EADDRINUSE` leads to exit 0 (`otel-receiver.js:3874`). FR-10 requires job processing to survive a port conflict. Options:
   - a pid/lock file in `~/.artisyn/upload/` as the uploader's guard, with the receiver staying alive (no listener) when the bind fails;
   - or a separate "queue-only" mode.

   The idle timer is currently armed only by HTTP requests (`listen` → `armIdleTimer`), so a listener-less receiver needs its own lifetime rule.
3. **Who starts the receiver when hooks only hand off.** It is started by the `SessionStart` / re-arm paths. A fresh or stale heartbeat on `Stop` / `SessionEnd` means a fallback unless something spawns it. Decide whether a hand-off-path spawn fits the ~200 ms budget, given that `announceShared` with `helloAfterSpawn` can take up to 2 s.
4. **Re-arm in the hand-off path.** `maybeReArmOtelSession` in `send-logs-hook.js:915` can cost seconds. Either drop it from `Stop` / `SessionEnd` (lifecycle-hook re-arms anyway) or make it fire-and-forget.
5. **No existing on-disk job queue in the hook.** The server-side `upload-queue.md` pattern (SKIP LOCKED) does not apply. Still to design:
   - the job JSON schema and its version field;
   - name grammar and same-millisecond disambiguator;
   - a claim mechanism (rename to `.running` or a lease file) so two receivers never run one job;
   - backoff formula (the existing `forwardBackoffMs = min(1000·2^(n−1), 60000)` and `nextRealtimeDelay` are models);
   - max age and max attempts;
   - stuck-job threshold, heartbeat interval and staleness;
   - coalescing of `Stop` jobs per repo.
6. **Per-user throttle state.** `throttle-state.js` is per repo only, so the daily Node warning needs a new `~/.artisyn/` state file. `user-state.js` covers only `~/.artisyn/otel/`; a new `~/.artisyn/upload/` helper is needed, plus a standalone copy inside the receiver.
7. **Node version table twin.** Nothing in the hook reads `process.versions.node` today. Needed: a new hook module and a TS twin in the installer replacing `warnIfNodeEol`. Register the twin in `twins-and-cross-cutting-rules.md`; add an algorithm doc and rows file if the classification is table-tested.
8. **`hook-status` reporting of failed / stuck jobs.** The server extractor drops unknown fields, so these show up only in `logTail` and `recommendations` unless the extractor changes. A `recommendations` rule (like `timeout-on-upload`) is the existing additive channel. `nodeVersion` is ignored by the server today, which is fine since the UI is a follow-up.
9. **FR-11.**
   - The advisor POST is safe without upload.
   - The config aggregate falls back to the local build when the session is not yet on the server. Results equal "before" only if the local aggregate matches.
   - The ordering comment in `hook-system-overview.md:188-190` and `turn-end-cost-advisor.md:91-92` must be revised.
10. **Tests that must change.**
    - `s-hook-01` step 10 (SessionEnd ≥ 1500 ms wait) and `s-hook-07` step 27 (port conflict leads to exit) contradict the new behaviour.
    - AC-10b may need a frozen 2.32.x legacy fixture in `tests/fixtures/legacy-hooks/` for the "old hook + new receiver on one repo" step.
11. **Stale reference.** `s-hook-01.spec.ts:24` and the research agent mention `__tests__/send-logs-hook.test.js` and `no-visible-window.test.js`, but neither exists in `hook/.claude/telemetry_tool/__tests__/`. This needs no action beyond not relying on them.
