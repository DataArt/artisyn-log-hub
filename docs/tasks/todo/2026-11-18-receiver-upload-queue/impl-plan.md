# Implementation plan: Shared Receiver as the Single Log Uploader

## TL;DR

- New hook module `upload-queue.js` (job paths, name grammar, job build/validate, atomic write,
  heartbeat read, hand-off decision, `wx` claim, outcome classification, backoff, stuck detection).
  The receiver gets a standalone copy of the parts it needs (twin, table-tested on both copies).
- `send-logs-hook.js` gets a new argv mode `--run-job <jobPath>` with defined exit codes, and its
  `Stop` / `SessionEnd` paths hand off to the queue when the heartbeat is fresh. Re-arm and
  `otel-status` move out of the hand-off path. `otel-register.js` gains the export
  `spawnSharedReceiverNoHello` (spawns the receiver from a fallback run without the handshake).
- `otel-receiver.js` gets an uploader role: `uploader.lock`, heartbeat every 5 s, queue watcher,
  spawns `--run-job`, retries with backoff, no idle-exit while retryable jobs exist, queue-only mode
  on an OTLP port conflict. New capability `upload-queue-v1`.
- `upload-logs.js`: 3 s connect timeout and an `unreachable` flag; every upload run aborts on the
  first unreachable result (no connection → give up in ~3 s).
- `SessionEnd` lock wait drops from 20000 to 800 ms (`LOCK_WAIT_SESSION_END_MS`); on a busy lock
  it queues a job instead of waiting.
- New per-user state `~/.artisyn/upload/` (`queue/`, `failed/`, `heartbeat.json`, `uploader.lock`,
  `spawn.mark`) and `~/.artisyn/node-check.json`. Jobs in `failed/` lose no data (the next full
  scan re-uploads); they are surfaced via the new `upload-jobs-failed` recommendation. No DB change,
  no server API change.
- Phase 3 drops the `otelEnabled` gate on receiver start (`lifecycle-hook.js`, `otel-register.js`);
  the installer already creates `port.json` / `token` / `bin/` unconditionally (no change).
- New hook module `node-version-check.js` + installer twin `artisyn-hooks-installer/src/node-version.ts`
  (used by `warnIfNodeEol` and the "not working yet" text in `install.ts`). They give the Node
  unpatched/EOL warning as a `SessionStart` `systemMessage` merged with the OTEL warning, throttled
  per user per day. `hook-status` gains the additive `nodeVersion` and `uploadQueue` fields.
- Versions: hook 3.0.0, Log Hub 1.5.0. New KB article `upload-job-queue.md` and two new algorithm
  docs with rows files. New frozen test fixture `tests/fixtures/legacy-hooks/2.32.3/`.

## Reference

- Requirements: [requirements.md](requirements.md)
- Research archive: [research/findings-1.md](research/findings-1.md); analysis and PoC conclusions:
  [research/handoff-design.md](research/handoff-design.md); PoC
  `docs/pocs/2026-11-18-1933-upload-handoff-cost/`.

A bare file name (no directory, e.g. `send-logs-hook.js`) means `hook/.claude/telemetry_tool/<name>`;
every path with a directory (e.g. `artisyn-hooks-installer/src/install.ts`,
`scripts/build-hooks-installer.js`, `__tests__/x.js` = `hook/.claude/telemetry_tool/__tests__/x.js`
is the one exception) is relative to the repo root.

## Design Decisions

### DD-1 Phases and chunk order

The three phases of FR-12 are chunk groups 1–5, 6–9 and 10–15. Each group ends with its own
tests and docs chunks so the repo is green at every phase boundary (AC-10a): the last item of
chunks 5, 9 and 15 runs `adlc-lh:check-health` with `finalRun: true`. The rule "Schema →
Services → API → Frontend → Tests" applies inside each phase.

Timing bounds in scenarios: the ~200 ms target (AC-5) is the PoC measurement (p95 63 ms). On a
shared CI runner the scenarios assert `elapsedMs <= 500` in the `queued` line and a wall time
< 1000 ms per hand-off hook run. A `SessionEnd` fallback on a busy lock is bounded by its logged
lock wait (`waited Nms` < 1000) and a wall time < 2500 ms: about 130 ms of re-arm checks, the
800 ms wait and Node start-up give ~1150 ms (measured; accepted by the user on 2026-11-18).

### DD-2 Per-user state layout (`~/.artisyn/upload/`)

Resolved per call from `os.homedir()` in the hook (like `user-state.js`), and from `--owner-home`
in the receiver. Dirs are `0o700`, files `0o600`, every write is tmp + rename.

| Path | Writer | Content |
|---|---|---|
| `queue/<name>.json` | hook (create), uploader (rewrite under claim) | job, DD-4 |
| `queue/.<name>.json.tmp` | any writer | temp file of an atomic write; ignored by readers |
| `queue/<name>.json.claim` | uploader / takeover hook (`'wx'`) | `{pid, startedAt}` |
| `failed/<name>.json` | uploader or receiver | the job plus `failedAt`, `failedReason` |
| `heartbeat.json` | uploader-role receiver | DD-6 |
| `uploader.lock` | receiver (`'wx'`) | `{pid, startedAt, version}` — the uploader-role guard |
| `spawn.mark` | hook | epoch ms of the last hand-off-path receiver spawn |

`~/.artisyn/otel/` stays OTEL-only. `~/.artisyn/node-check.json` is the Node warning throttle
(DD-15).

### DD-3 Job file name grammar

`<sid>_<ts>_<trigger>_<pid>-<rand>.json`:

- `sid`: the session id with every char outside `[A-Za-z0-9-]` removed, cut to 64 chars, or
  `nosession` when empty.
- `ts`: UTC `YYYYMMDDTHHmmssSSSZ` (e.g. `20261118T193301123Z`).
- `trigger`: `stop` or `session-end`.
- `pid`: the writing process's pid.
- `rand`: 4 lowercase hex chars from `crypto.randomBytes(2)`; this is the same-millisecond
  disambiguator.
- Regex: `^([A-Za-z0-9-]{1,64})_(\d{8}T\d{9}Z)_(stop|session-end)_(\d+)-([0-9a-f]{4})\.json$`.
- Readers order jobs by the `ts` group, then the full name. A name that does not match is not a job.

### DD-4 Job schema (`schema: 1`)

`{ schema: 1, sessionId, trigger, createdAt (ISO), hookVersion, uploader (absolute path of the
writing repo's send-logs-hook.js), uploaderContract: 1, cwd, gitRoot, telemetryDir, transcriptPath
(string|null), hookEvent, serverUrl (informational only), env: {…}, attempts: 0, nextAttemptAt:
null, lastError: null }`.

- `env` holds only `JOB_ENV_KEYS` that are set in the hook's env. `JOB_ENV_KEYS` =
  `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_ENABLE_TELEMETRY`, `ARTISYN_PROJECT_ROOT`,
  `ARTISYN_MANAGED_SETTINGS_DIR`, plus every key starting with `OTEL_` except keys containing
  `HEADERS`.
- The job carries no API key; it is read from the repo config at run time.
- `attempts`, `nextAttemptAt` and `lastError` are rewritten only by the uploader that holds the
  claim (DD-9).
- `applyJobEnv(jobEnv)`: first delete from `process.env` every key that `pickJobEnv` would select
  (the four named keys and every `OTEL_*` key without `HEADERS`), then copy `jobEnv` in. This way
  the receiver's inherited env never leaks into another repo's run.

### DD-5 Uploader contract — `send-logs-hook.js --run-job <jobPath>`

- No stdin. The argv branch sits before the stdin read, like `--otel-sweep` (`send-logs-hook.js:860-867`).
- Exit codes:

| Code | Name | Meaning | Receiver action |
|---|---|---|---|
| 0 | `done` | uploaded, or nothing to do; the job and its claim are deleted | none |
| 10 | `retryable` | job rewritten with `attempts+1`, `nextAttemptAt`, `lastError`; claim released | retry at `nextAttemptAt` |
| 11 | `permanent` | job moved to `failed/`, `hook.log` line, recommendation set | none |
| 12 | `busy` | claim held by a live pid, or the per-repo lock is busy; job untouched | retry after `BUSY_RETRY_MS` |
| 13 | `dropped` | repo / telemetry dir gone; job deleted, `hook.log` line | none |

- Any other exit, a crash or the `JOB_RUN_TIMEOUT_MS` kill counts as a crash (DD-10).
- The exit codes are exported as `JOB_EXIT` from `upload-queue.js` and twinned in the receiver.
- The contract version is `uploaderContract: 1` in the job and `UPLOAD_CONTRACT = 1` in the
  receiver.
- Versioning rules:
  - a hook hands off only when the heartbeat's `uploadContract` is ≥ the contract it writes;
  - a receiver runs only jobs whose `uploaderContract` it lists in `SUPPORTED_UPLOAD_CONTRACTS`
    (`[1]`), and leaves any other job in the queue untouched for a newer receiver (never moves it to
    `failed/`);
  - the "uploader `version.json` major ≥ 3" check (DD-10) guards against a repo downgraded below the
    first hook version that has `--run-job`.

### DD-6 Heartbeat (`heartbeat.json`)

`{ schema: 1, pid, version (receiver version.json), capabilities (CAPABILITIES incl.
'upload-queue-v1'), uploadContract: 1, listening (bool: OTLP port bound), startedAt, ts (epoch ms)
}`.

- Written every `HEARTBEAT_INTERVAL_MS` = 5000 by the process that holds `uploader.lock`, and
  deleted on its exit.
- Fresh means `now - ts <= HEARTBEAT_STALE_MS` (15000), `capabilities` includes
  `upload-queue-v1` and `uploadContract >= 1`. There is no pid probe in the hook.

### DD-7 Hand-off decision (`decideHandOff`)

Inputs: `{ event, heartbeat, queueDirUsable }`. Output:

- `queue`: heartbeat fresh and `queueDirUsable`, for both `Stop` and `SessionEnd`.
- `in-process-stop`: `Stop`, otherwise. Behaviour as today, including `LOCK_WAIT_STOP_MS` 2000 and
  re-arm, plus a stuck-job takeover (DD-11).
- `session-end-fallback`: `SessionEnd`, otherwise. Waits for the per-repo lock for at most
  `LOCK_WAIT_SESSION_END_MS` = 800 (was 20000):
  - acquired → in-process scoped flush;
  - busy and `queueDirUsable` → write a job and log `queued (fallback): lock busy`;
  - busy and not `queueDirUsable` → log `skipped: upload lock held …` as today.

The hand-off path does no `maybeReArmOtelSession` and no `maybeWriteOtelStatus`, because the job
run writes `otel-status` (FR-6). `lifecycle-hook.js` re-arms on every other event. It logs
`queued: job=<name> elapsedMs=<ms since process start>`.

Receiver spawn from the hand-off path: when the heartbeat is not fresh,
`~/.artisyn/otel/port.json` exists, the launch resolves to shared mode and `spawn.mark` is older
than `RECEIVER_SPAWN_THROTTLE_MS` = 60000:

- the hook spawns its own `otel-receiver.js` with `buildReceiverLaunch()` argv via
  `spawnDetachedHidden` (no hello);
- it rewrites `spawn.mark`;
- it continues with the fallback.

### DD-8 Receiver roles

The receiver has two independent roles:

- **listener** (OTLP port bound);
- **uploader** (holds `uploader.lock`).

Rules:

- `startShared` tries to take the uploader role before `listen()`.
- On `EADDRINUSE`: uploader role held → keep running queue-only (log `queue-only: port <p> busy`);
  otherwise exit 0 as today.
- A listener without the uploader role retries the lock on every heartbeat tick.
- A lock is stale when its pid is dead (`process.kill(pid, 0)` → `ESRCH`), or when `heartbeat.json`
  is older than `HEARTBEAT_STALE_MS × 4`. A stale lock is removed and retaken with `'wx'`.
- On exit the uploader role deletes `heartbeat.json` and `uploader.lock`.
- The uploader role exists only in shared mode, and only with a valid token (no token → exit as
  today).

### DD-9 Job run (uploader side, `runJob(jobPath)`)

1. Read and validate the job (`validateJob`); invalid or unknown schema → `failed/`, exit 11.
2. `cwd` / `telemetryDir` missing → delete, exit 13.
3. Over age (`createdAt` older than `JOB_MAX_AGE_MS` = 24 h) or `attempts >= JOB_MAX_ATTEMPTS`
   (10) → `failed/`, exit 11.
4. `'wx'` claim; held by a live pid and younger than `JOB_RUN_TIMEOUT_MS` → exit 12.
5. Apply `job.env` over `process.env`, then `loadConfig(job.cwd)`; no `serverUrl` / `apiKey` → delete,
   exit 0.
6. Per-repo lock with `LOCK_WAIT_STOP_MS`; busy → release the claim, exit 12.
7. `maybeWriteOtelStatus` for this job (and every coalesced job).
8. `session-end` → `runSessionEndFlush`.
9. `stop` → coalesce: `'wx'`-claim every other unclaimed `stop` job with the same `telemetryDir`,
   then one `runUpload`. The current session is the newest coalesced job's `sessionId`.
10. Classify the run result per DD-12. `done` → delete all claimed jobs and their claims.
    `retryable` → rewrite each claimed job (`attempts+1`, `nextAttemptAt = now +
    backoffMs(attempts+1)`, `lastError`) and release the claims. `permanent` → move to `failed/`.
11. Release the lock and exit with the DD-5 code.

On every move to `failed/`:

- `hook.log` line `job failed: <name> reason=<…>`;
- `upsertRecommendation(cwd, {rule:'upload-jobs-failed', …})`.

`failed/` cleanup: after a full scan (in-process `Stop` or `stop` job) whose outcome is `done`,
delete every `failed/` job of this `telemetryDir` (their data was just re-uploaded, DD-12) and
remove the `upload-jobs-failed` recommendation. `uploadQueue.failedJobs` in that run's
`hook-status` is counted before the cleanup.

Return shapes: `runUpload`, `runSessionEndFlush` and `runOtelSweep` return `{ uploaded,
retryableFailures, permanentFailures, aborted }`. `main()` and the `--otel-sweep` branch ignore it;
only `runJob` and the takeover use it.

### DD-10 Receiver scheduler

- `fs.watch(queue/)` plus a `QUEUE_POLL_MS` = 10000 backstop.
- Order: DD-3. Skipped are:
  - jobs with `nextAttemptAt > now`;
  - jobs with a live claim;
  - jobs whose `telemetryDir` already has a running job.
- At most `MAX_PARALLEL_JOBS` = 2 jobs run at a time.
- Before spawn the receiver validates:
  - the JSON parses;
  - `schema === 1`;
  - `isAllowedUploader(job.uploader, job.gitRoot, ownerHome)`;
  - the sibling `version.json` major is ≥ 3.

  On failure it moves the job to `failed/` with `failedReason` and logs `receiverLog('job-failed', …)`.
- Spawn: `process.execPath [job.uploader, '--run-job', jobPath]`, with `windowsHide`, `stdio:
  'ignore'`, cwd `os.tmpdir()`, not detached. The child is killed after `JOB_RUN_TIMEOUT_MS`
  (900000).
- A crash or timeout increments an in-memory per-job crash counter and retries after
  `backoffMs(n)`. At `JOB_MAX_CRASHES` (3) the receiver moves the job to `failed/`.
- Exit 12 → retry after `BUSY_RETRY_MS` (5000).
- Drain on start: the first scan runs right after the uploader role is taken.
- Idle-exit (`armIdleTimer`): on expiry, if the process holds the uploader role and a job is running,
  or the queue holds a *blocking* job, it re-arms instead of exiting. A blocking job is a queue job
  with a parseable name, a `uploaderContract` in `SUPPORTED_UPLOAD_CONTRACTS` and no live claim. A
  job of an unsupported contract never blocks idle-exit, so a newer receiver can take over. A queue-only
  process also arms the idle timer at start and on every job event.

### DD-11 Stuck-job takeover (fallback `Stop` only)

- A job is stuck when its `ts` is older than `JOB_STUCK_MS` (300000) and it has no live claim.
- Signatures (both twins are table-tested):
  - `isClaimStale(claim, now, isPidAlive)`: `claim` is `{pid, startedAt}` or null, and
    `isPidAlive` is `(pid) => boolean`. Null or unparsable → true; a dead pid → true;
    `now - Date.parse(startedAt) > JOB_RUN_TIMEOUT_MS` → true; otherwise false.
  - `isJobStuck(parsedName, claim, now, isPidAlive)`: `parsedName` is from `parseJobName`. Returns
    `now - tsMs(parsedName) > JOB_STUCK_MS && isClaimStale(claim, now, isPidAlive)`.
- Only an `in-process-stop` run does a takeover, and only while it already holds the per-repo lock.
- Steps:
  1. `'wx'`-claim each stuck job of its own `telemetryDir`;
  2. write `otel-status` for each claimed job;
  3. run its normal full scan, which covers every session of the repo;
  4. on a non-aborted run, delete the claimed jobs; otherwise release the claims.
- Reports `uploadQueue.stuckTakenOver` in `hook-status` and logs `stuck jobs taken over: <n>`.
- `SessionEnd` never takes over a job.

### DD-12 Run outcome classification (`classifyRunOutcome`)

- Input: `{ uploaded, retryableFailures, permanentFailures, aborted }`.
- `upload-logs.js` returns `statusCode` and `unreachable` per file. A failure is retryable when
  `statusCode` is null (network error or timeout), ≥ 500, or 429; any other 4xx is permanent.
- Output:
  - `retryable` when `aborted` or `retryableFailures > 0`;
  - otherwise `permanent` when `permanentFailures > 0 && uploaded === 0`;
  - otherwise `done`.
- Per-file permanent failures in a partly successful run stay unmanifested and are reported via
  `nonUploadableLogs` as today.
- `backoffMs(n) = min(30000 × 2^(n−1), 900000)`.
- A job in `failed/` never loses data: the files stay unmanifested and the next `done` full scan of
  the repo uploads them.

### DD-13 Fast fail when there is no connection (user decision)

- `UPLOAD_CONNECT_TIMEOUT_MS` = 3000 in `upload-logs.js`. A timer starts when the request is
  created and is cleared on the socket's `connect` (http) or `secureConnect` (https) event, or at
  once if the socket is already connected. When it fires, `req.destroy(err)` with
  `code = 'ECONNTIMEOUT'`.
- Results with `err.code` in `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`,
  `ENETUNREACH`, `ECONNTIMEOUT` carry `unreachable: true` and `statusCode: null`.
- `runUpload`, `runSessionEndFlush` and `runOtelSweep` stop after the first `unreachable` result
  and log `aborted: server unreachable (<reason>) — <n> files left for the next run`.
- A response timeout after connecting is unchanged (per request, `sendLogsTimeoutMs`).
- `prompt-upload-hook.js` gets the connect timeout through the shared `uploadFile` without a code
  change of its own.

### DD-14 Fallback `Stop` stays as today (user decision)

There is no overall time budget on the in-process `Stop`: users upgrade to 3.0.0, so the fallback
is rare. DD-13 alone bounds the no-connection case.

### DD-15 Node version check (FR-16)

- `node-version-check.js` exports `NODE_PATCHED_MINIMUMS = { 22: '22.23.5', 24: '24.22.3', 26:
  '26.13.1' }`, `NODE_ADVISORY = 'November 2026'`, `classifyNodeVersion(v)` and
  `checkNodeVersion({ now, home })`.
- `classifyNodeVersion(v)` → `{ status, line, target }`, where `status` is one of `ok`,
  `unpatched`, `eol`, `unknown`:
  - major < 22, or odd major ≤ 26 → `eol`;
  - major in the table and below its minimum → `unpatched`;
  - major > 26 → `unknown`;
  - otherwise `ok`.
- `checkNodeVersion({ now, home })` returns the warning text or null and never throws.
- `ARTISYN_NODE_VERSION_OVERRIDE` (test-only, documented in the KB) replaces
  `process.versions.node` in both the hook and the installer.
- Throttle: `~/.artisyn/node-check.json` `{ nodeVersion, shownAt }`. The warning shows when the file
  is missing, `nodeVersion` changed, or `now - shownAt >= 86400000`.
- Text: `Log Hub: Node.js <v> <is end-of-life | misses the <advisory> security fixes> — upgrade to
  Node.js 22.23.5, 24.22.3 or 26.13.1 or newer. Log Hub hooks keep working.`
- Installer twin: `artisyn-hooks-installer/src/node-version.ts`, the same table, classification and
  text, with no throttle. It replaces the body of `warnIfNodeEol`.

### DD-16 `SessionStart` output and `hook-status` fields

- `lifecycle-hook.js` collects warnings in an array: the OTEL endpoint warning (only when
  `otelEnabled`) and the Node warning (always). It writes one
  `JSON.stringify({systemMessage: parts.join('\n\n')})` when the array is not empty.
- `hook-status` gains two additive fields:
  - `nodeVersion: process.versions.node`;
  - `uploadQueue: { mode, stuckTakenOver, failedJobs }`: `mode` is `'in-process'` for a hook-run
    full scan and `'job'` for a `--run-job` run; `failedJobs` is the count in `failed/` with this
    `telemetryDir`.
- The server's `extractHookStatus` drops unknown fields, so old servers accept the event unchanged.

### DD-16a Installer needs no gate change

`port.json` / `token` creation (`artisyn-hooks-installer/src/install.ts:807-811`) and
`copyReceiverBin` (`:874-896`) already run on every install regardless of `otelEnabled`. FR-10 needs
no installer change.

### DD-17 FR-11 needs no code change

- The worker already races the upload today, since both `Stop` hook entries run in parallel.
- It falls back to a local aggregate (`post-turn-analysis-worker.js:1631-1671`), and the advisor
  POST accepts a not-ingested session.
- Only the docs that claim strict upload-before-analysis ordering change.

### DD-18 Twins (register in `docs/knowledgebase/twins-and-cross-cutting-rules.md`)

| Twin pair | Pinned by |
|---|---|
| `upload-queue.js` ↔ `otel-receiver.js`: `parseJobName`, `JOB_EXIT`, `isHeartbeatFresh`, `backoffMs`, `isClaimStale`, constants | `upload-job-queue.algo.test.js`, which runs rows on both exports |
| `upload-queue.js` ↔ `otel-receiver.js`: job listing order (DD-3), the receiver's pre-spawn validation (subset of `validateJob`), and the `failed/` record (`moveJobToFailed`: the job plus `failedAt` ISO and `failedReason` string, atomic, `0o600`) | `s-hook-07` scenario steps only |
| `node-version-check.js` ↔ `artisyn-hooks-installer/src/node-version.ts` | not pinned by a test (TS); the algorithm doc names both |

### DD-19 Constants (all in `upload-queue.js`; receiver twins in brackets)

| Name | Value |
|---|---|
| `UPLOAD_DIR` / `QUEUE_DIR` / `FAILED_DIR` | `upload` / `queue` / `failed` [twin] |
| `HEARTBEAT_FILE` / `UPLOADER_LOCK_FILE` / `SPAWN_MARK_FILE` | `heartbeat.json` / `uploader.lock` / `spawn.mark` [twin except spawn.mark] |
| `UPLOAD_QUEUE_CAPABILITY` | `upload-queue-v1` [twin] |
| `UPLOAD_CONTRACT` | 1 [twin] |
| `JOB_SCHEMA` | 1 [twin] |
| `SUPPORTED_UPLOAD_CONTRACTS` | `[1]` [receiver only] |
| `HEARTBEAT_INTERVAL_MS` | 5000 [receiver only] |
| `HEARTBEAT_STALE_MS` | 15000 [twin] |
| `QUEUE_POLL_MS` | 10000 [receiver only] |
| `JOB_RUN_TIMEOUT_MS` | 900000 [twin] |
| `JOB_STUCK_MS` | 300000 |
| `JOB_MAX_AGE_MS` | 86400000 |
| `JOB_MAX_ATTEMPTS` | 10 |
| `JOB_MAX_CRASHES` | 3 [receiver only] |
| `BUSY_RETRY_MS` | 5000 [receiver only] |
| `MAX_PARALLEL_JOBS` | 2 [receiver only] |
| `RECEIVER_SPAWN_THROTTLE_MS` | 60000 |
| `LOCK_WAIT_SESSION_END_MS` (send-logs-hook.js) | 800 |
| `UPLOAD_CONNECT_TIMEOUT_MS` (upload-logs.js) | 3000 |

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `upload-queue.js` (new) | queue library | DD-2–DD-4, DD-7, DD-11, DD-12, DD-19 |
| `node-version-check.js` (new) | Node classification + throttle | DD-15 |
| `send-logs-hook.js` | `--run-job`, hand-off, fallback, takeover, abort, `hook-status` fields | DD-5, DD-7, DD-9, DD-11, DD-13, DD-16 |
| `upload-logs.js` | connect timeout, `unreachable` | DD-13 |
| `otel-receiver.js` | uploader role, heartbeat, scheduler, queue-only, idle rule, capability | DD-6, DD-8, DD-10 |
| `otel-register.js` | export a no-hello spawn helper; drop the `otelEnabled` gate in `maybeReArmOtelSession` | DD-7, phase 3 |
| `lifecycle-hook.js` | drop the `otelEnabled` gate on `SessionStart` announce; merged `systemMessage` | DD-16 |
| `version.json` | 3.0.0 | |
| `scripts/build-hooks-installer.js` | add the new modules to `HOOK_JS_FILES` | |
| `artisyn-hooks-installer/src/node-version.ts` (new), `install.ts` | installer twin, `warnIfNodeEol` | DD-15 |
| `package.json` (root) | 1.5.0 | |
| `.artisyn/marketplace/plugins/log-hub-hooks/**` | dogfood refresh, `plugin.json` 3.0.0 | `.claude/rules/hook.md` |
| `docs/knowledgebase/upload-job-queue.md` (new) | KB: queue protocol, roles, diagrams | FR-14, FR-15 |
| `docs/knowledgebase/algorithms/upload-job-queue.md` (new) + `docs/algorithm-examples/upload-job-queue.json` (new) | algorithm doc + rows | grammar, decision, outcome, backoff, freshness, stuck, claim |
| `docs/knowledgebase/algorithms/node-version-check.md` (new) + `docs/algorithm-examples/node-version-check.json` (new) | algorithm doc + rows | DD-15 |
| `__tests__/upload-job-queue.algo.test.js` (new), `__tests__/node-version-check.algo.test.js` (new) | table tests | allowed: new doc + rows |
| `docs/knowledgebase/otel-receiver.md`, `hook-system-overview.md`, `hook-installation.md`, `hook-api-versioning.md`, `turn-end-cost-advisor.md`, `twins-and-cross-cutting-rules.md`, `index.md` | KB updates | FR-14 |
| `hook/README.md`, `hook/INSTALL_HOOK.md`, `hook/HOW_HOOK_WORKS.md` | shipped docs | FR-14, FR-17 |
| `user-docs/otel-architecture.md`, `user-docs/data-collection.md`, `client/public/help/*.md` | user docs + regenerated help | `npm run build:help` |
| `tests/scenarios/hook/s-hook-01.spec.ts`, `s-hook-04.spec.ts`, `s-hook-07.spec.ts`, `s-hook-09.spec.ts`, `s-compat-01.spec.ts`, `tests/scenarios/installer/s-inst-01.spec.ts` | scenario steps | Test coverage plan |
| `tests/fixtures/legacy-hooks/2.32.3/` (new), `tests/fixtures/legacy-hooks/README.md` | frozen 2.32.3 hook + its README line | `scripts/scenarios/freeze-legacy-hook.mjs` |
| `docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md` | scenario design doc | new or changed steps |
| `docs/changelog/<YYYY-MM-DD-HHmm>-receiver-upload-queue.md` (new) | changelog | `changelog` skill |

## API changes

- No server route changes, so there is no contract registry row.
- The local process contracts are DD-5 (`--run-job` argv and exit codes), DD-6 (heartbeat) and the
  new receiver capability `upload-queue-v1`.
- The ingest payload gains the additive `hook-status` fields `nodeVersion` and `uploadQueue`
  (DD-16), which the server ignores.

## Test coverage plan

Under the CLAUDE.md test policy (algorithm rows, contract rows, scenario steps only):

- **Algorithm (new doc + rows + test):** `docs/knowledgebase/algorithms/upload-job-queue.md` with
  rows in `docs/algorithm-examples/upload-job-queue.json`, tested by
  `__tests__/upload-job-queue.algo.test.js` against `upload-queue.js` and, for the DD-18 twin
  functions, also against `otel-receiver.js` exports. The rows cover:
  - name build and parse (including invalid names and same-millisecond names);
  - `decideHandOff`;
  - `classifyRunOutcome`;
  - `backoffMs`;
  - `isHeartbeatFresh`;
  - `isJobStuck`;
  - `isClaimStale`;
  - `isUnreachableError` (imported from `upload-logs.js`).
- **Algorithm (new doc + rows + test):** `docs/knowledgebase/algorithms/node-version-check.md`, rows
  in `docs/algorithm-examples/node-version-check.json`, tested by
  `__tests__/node-version-check.algo.test.js`. The rows cover classification (eol, unpatched, ok,
  unknown, odd lines, 18.19) and throttle decisions.
- **API contract:** none, since no route changes.
- **Scenarios** (extend existing files):
  - `s-hook-01`:
    - step 10 changes: `SessionEnd` on a busy lock returns in < 1 s and queues a job;
    - new steps: `SessionEnd` and `Stop` hand-off with a fresh fake heartbeat (job file grammar, no
      API key, `queued` line with `elapsedMs`); `--run-job` uploads and deletes, a second run
      changes nothing; `stop` coalescing; over-age → `failed/`; a fallback `Stop` takes over a
      stuck job;
  - `s-hook-04`: step 1 asserts the abort line and a single request on `ECONNREFUSED`;
  - `s-hook-07`:
    - step 27 changes: on a port conflict the receiver stays queue-only with the uploader role;
    - new steps: heartbeat refresh; drain on start; jobs of an `otelEnabled: false` repo upload
      while its OTEL records are dropped; 503 → backoff; 400 → `failed/`; no idle-exit with a
      retryable job, idle-exit once the queue is empty; kill mid-job and restart completes;
  - `s-hook-09`: the `SessionStart` Node warning via `ARTISYN_NODE_VERSION_OVERRIDE`, merged with
    the OTEL warning in one JSON object, throttled, silent on a patched version; `hook-status`
    carries `nodeVersion`;
  - `s-compat-01`: frozen 2.32.3 hook, the prompt-time upload and 3.0.0 jobs on one repo never
    upload at the same time, and the 2.32.3 hook keeps uploading; with the frozen 2.32.3 receiver
    running, 3.0.0 hooks fall back, then hand off once a queue-only 3.0.0 receiver is up;
  - `s-hook-07` also: two repos with different hook versions each upload with their own version;
  - `s-inst-01`: installer warning via the override; install adds nothing to the user-level
    `~/.claude` settings, and install / uninstall in one repo leaves another repo's install
    unchanged.
- FR-11 / AC-10 is covered by the existing post-turn steps in `s-hook-04`, which must still pass.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Phase 1 — hook queue library | 8 | new `upload-queue.js`; no behaviour change yet |
| 2 | Phase 1 — upload fast-fail and `--run-job` (session-end) | 8 | needs chunk 1 |
| 3 | Phase 1 — receiver uploader role | 8 | needs DD-5 contract from chunk 2 |
| 4 | Phase 1 — `SessionEnd` hand-off and fallback in the hook | 5 | needs chunks 1–3 |
| 5 | Phase 1 — tests and docs | 8 | phase 1 ends green |
| 6 | Phase 2 — uploader: `stop` jobs, retries, failed, takeover | 6 | needs chunk 2 |
| 7 | Phase 2 — receiver: backoff, crashes, validation, parallelism | 5 | needs chunk 3 |
| 8 | Phase 2 — `Stop` hand-off in the hook | 4 | needs chunks 6–7 |
| 9 | Phase 2 — tests and docs | 8 | phase 2 ends green |
| 10 | Phase 3 — mandatory receiver | 4 | queue-only, gates removed |
| 11 | Phase 3 — Node version check (hook + installer) | 7 | independent of 10 |
| 12 | Phase 3 — versions and packaging | 5 | after all code |
| 13 | Phase 3 — algorithm and hook scenario tests | 6 | |
| 14 | Phase 3 — compat and installer tests | 4 | needs the packaged 3.0.0 hook |
| 15 | Phase 3 — docs, diagrams, help, changelog | 8 | last; ends with the full check set |
| 16 | Follow-up — receiver re-queues `failed/` jobs | 5 | user decision 2026-11-18, [followup-failed-requeue.md](followup-failed-requeue.md) |
| 17 | Follow-up — S-HOOK-10 offline laptop, power-off, recovery (Docker) | 6 | user request 2026-11-18; needs chunk 16 |

### Chunk 1 — Phase 1 — hook queue library

- [ ] Create `upload-queue.js` (Node built-ins only, CommonJS): the DD-19 constants and
      `uploadStateDir()`, `queueDir()` and `failedDir()` resolved per call from `os.homedir()`, per
      DD-2, with dirs `0o700`.
- [ ] Add `buildJobName({sessionId, trigger, now, pid, rand})` and `parseJobName(name)` per DD-3,
      and `listJobs(dir)` returning parsed jobs sorted by `ts` then name, ignoring `.tmp` and
      `.claim` files.
- [ ] Add `JOB_ENV_KEYS` selection `pickJobEnv(env)`, `buildJob(input)` and `validateJob(obj)`
      per DD-4, plus `writeJobAtomic(dir, name, job)` (tmp + rename, `0o600`) and
      `moveJobToFailed(jobPath, job, reason)` per DD-2.
- [ ] Add `readHeartbeat()`, `isHeartbeatFresh(hb, now)` (DD-6), `isQueueDirUsable()` (create dir +
      access check) and `decideHandOff({event, heartbeat, queueDirUsable, now})` returning
      `queue` / `in-process-stop` / `session-end-fallback` per DD-7.
- [ ] Add `claimJob(jobPath)` (`'wx'` `.claim` with `{pid, startedAt}`; an existing claim that
      `isClaimStale` is removed and retried once), `releaseClaim`, and `isClaimStale`, `isJobStuck`
      with the DD-11 signatures, plus `classifyRunOutcome`, `backoffMs` (DD-12) and `JOB_EXIT` (DD-5).
- [ ] Add `applyJobEnv(jobEnv)` (DD-4), `listJobsForRepo(telemetryDir)` (reads each job's JSON and
      keeps matching `telemetryDir`), `listStuckJobs(telemetryDir, now)`, `countFailedJobs(telemetryDir)`,
      and `shouldSpawnReceiver(now)` / `markReceiverSpawn(now)` over `spawn.mark` with
      `RECEIVER_SPAWN_THROTTLE_MS`.
- [ ] Add `'upload-queue.js'` to `HOOK_JS_FILES` in `scripts/build-hooks-installer.js`.
- [ ] Run `npm run lint` and `npm test` in `hook/`, and `npm run test:scripts` at the repo root.

### Chunk 2 — Phase 1 — upload fast-fail and `--run-job` (session-end)

- [ ] In `upload-logs.js`, add and export `isUnreachableError(code)` (DD-13 code list) and, in
      `uploadFile`, the `UPLOAD_CONNECT_TIMEOUT_MS` connect timer. Return `unreachable: true`
      (`statusCode: null`) for those codes, and pass `unreachable` through `uploadFileChunked` and
      `uploadFileMaybeCompressed`.
- [ ] In `send-logs-hook.js` `runUpload`, `runSessionEndFlush` and `runOtelSweep`, stop processing
      after the first `unreachable` result with the DD-13 `aborted:` log line, and return
      `{uploaded, retryableFailures, permanentFailures, aborted}` (retryable or permanent per DD-12).
- [ ] Add `parseRunJobArgs(argv)` and an argv branch in `main()` before the stdin read (next to
      `--otel-sweep`) that calls `runJob(jobPath)` and exits with its DD-5 code.
- [ ] Implement `runJob` steps 1, 2, 4–8, 10 and 11 of DD-9 for `trigger: 'session-end'` only,
      using `upload-queue.js` helpers (`applyJobEnv` in step 5). A `stop` job exits 12 in this phase.
- [ ] Phase-1 outcome mapping: `done` → delete job and claim, exit 0. `retryable` → release the
      claim, exit 10 without rewriting the job; `permanent` → `moveJobToFailed`, `hook.log` line,
      exit 11 (backoff and recommendation come in chunk 6).
- [ ] `runJob` writes `hook.log` lines through `hookLog(HOOK_FILE, job.sessionId, …, job.cwd)`:
      `run-job start: <name>` and `run-job <outcome>: <name> (<detail>)`.
- [ ] Set `version.json` to `3.0.0` (the receiver's DD-10 major ≥ 3 check needs it from phase 2 on).
- [ ] Run `npm run lint` and `npm test` in `hook/`.

### Chunk 3 — Phase 1 — receiver uploader role

- [ ] In `otel-receiver.js`, add the twin constants of DD-19, `'upload-queue-v1'` in
      `CAPABILITIES`, and standalone twins `parseJobName`, `isHeartbeatFresh`, `isClaimStale`,
      `backoffMs` and `JOB_EXIT` (no hook `require`). Export them in `module.exports`.
- [ ] Add `acquireUploaderRole()` / `releaseUploaderRole()` over `<ownerHome>/.artisyn/upload/uploader.lock`
      per DD-8 (stale lock rules), and call `acquireUploaderRole()` in `startShared` before `listen()`.
- [ ] Add a heartbeat timer (`HEARTBEAT_INTERVAL_MS`, unref'd) that, while the role is held,
      writes `heartbeat.json` per DD-6 atomically (`0o600`), and otherwise retries
      `acquireUploaderRole()`. Delete the heartbeat and lock on `process.on('exit')`.
- [ ] Add the queue scheduler per DD-10: `fs.watch` plus the `QUEUE_POLL_MS` poll, DD-3 order,
      skip claims that are not `isClaimStale`, skip jobs whose `uploaderContract` is not in
      `SUPPORTED_UPLOAD_CONTRACTS`, one job per `telemetryDir`, `MAX_PARALLEL_JOBS`, and a drain scan
      right after the role is taken.
- [ ] Add `runJobProcess(job, jobPath)`: re-check `isAllowedUploader` (`otel-receiver.js:2332`),
      spawn per DD-10 (not detached, `windowsHide`, cwd `os.tmpdir()`) and kill after
      `JOB_RUN_TIMEOUT_MS`. Map exit codes per DD-5. Phase 1: 12 retries after `BUSY_RETRY_MS`;
      10, a crash or a timeout kill retries after `backoffMs(n)` with an in-memory per-job counter `n`.
- [ ] Log every job event with `receiverLog`: `job-start`, `job-done`, `job-retry`, `job-failed`,
      `job-dropped`, `job-crash`, naming the job file and exit code.
- [ ] Change `armIdleTimer` per DD-10: with the uploader role and a running or *blocking* queued
      job, re-arm instead of exiting.
- [ ] Run `npm run lint` and `npm test` in `hook/`.

### Chunk 4 — Phase 1 — `SessionEnd` hand-off and fallback in the hook

- [ ] In `otel-register.js`, export `spawnSharedReceiverNoHello(config, cwd, hookFile, sessionId)`.
      It calls `buildReceiverLaunch()`, returns false unless the launch is shared mode and
      `~/.artisyn/otel/port.json` exists, and otherwise `spawnDetachedHidden` the hook's own
      `otel-receiver.js` with that argv.
- [ ] In `send-logs-hook.js` `main()`, for `SessionEnd` after `loadConfig` and the
      serverUrl/apiKey check: call `decideHandOff`. On `queue`, build the job (DD-4, `gitRoot` via
      `getGitRoot(cwd)`, `telemetryDir` via `resolveTelemetryDir`), write it, log the DD-7 `queued`
      line and exit 0 before re-arm and otel-status.
- [ ] Set `LOCK_WAIT_SESSION_END_MS = 800`. On `session-end-fallback`, keep re-arm and otel-status
      as today. A busy lock writes a job when `isQueueDirUsable()` (`queued (fallback): lock busy`),
      and otherwise logs the existing `skipped:` line.
- [ ] On a non-`queue` decision, spawn the receiver per DD-7 (`spawnSharedReceiverNoHello`, gated by
      `shouldSpawnReceiver` / `markReceiverSpawn`) before the fallback. Log
      `receiver: spawned for upload queue` or nothing.
- [ ] Run `npm run lint` and `npm test` in `hook/`.

### Chunk 5 — Phase 1 — tests and docs

- [ ] Write `docs/knowledgebase/algorithms/upload-job-queue.md` (format of the existing
      `algorithms/*.md`) covering the DD-3 grammar, DD-6 freshness, DD-7 decision, DD-11 stuck,
      claim staleness, DD-12 outcome and backoff, and DD-13 unreachable codes.
- [ ] Add `docs/algorithm-examples/upload-job-queue.json` rows for every function named in the
      doc, and `__tests__/upload-job-queue.algo.test.js` (pattern of `otel-shared-routing.algo.test.js`).
      Twin rows run against both `upload-queue.js` and `otel-receiver.js` exports.
- [ ] `tests/scenarios/hook/s-hook-01.spec.ts` step 10 (rewrite, new title): `Stop` part unchanged;
      `SessionEnd` with a busy lock logs a lock wait < 1000 ms (wall time < 2500 ms, DD-1) with no upload and leaves one job in the fake
      home's `~/.artisyn/upload/queue/`. A `SessionEnd` with a fresh fake heartbeat writes one job
      (DD-3 name, no `apiKey`) and a `queued … elapsedMs=` line (DD-1 bounds).
- [ ] `s-hook-01` new step: `send-logs-hook.js --run-job <job>` (via `runNodeScript` with `argv`)
      uploads `artisyn/cur` and `claude/cur`, exits 0 and deletes the job; re-running a copy gives the
      same uploads. Update step 11's activate/done/session-end-flush line counts for the runs added.
- [ ] `tests/scenarios/hook/s-hook-07.spec.ts` new step: a shared receiver with a queued
      `session-end` job writes `heartbeat.json` (DD-6 fields), runs the job against the fake Log Hub,
      deletes it, and does not idle-exit while the job runs.
- [ ] `tests/scenarios/hook/s-hook-04.spec.ts` step 1: assert one request and the
      `aborted: server unreachable` line on `ECONNREFUSED`.
- [ ] Docs: create `docs/knowledgebase/upload-job-queue.md` (DD-2–DD-10 protocol, phase-1 state)
      and add an "Uploader role" section with a link to `otel-receiver.md`. Update the `SessionEnd`
      lock and wait text in `hook-system-overview.md` and `hook/HOW_HOOK_WORKS.md`. Add the
      `--run-job` contract and the capability to `hook-api-versioning.md`. Update
      `docs/knowledgebase/index.md`.
- [ ] Run `npm run test:scenarios -- --mode a --only scenarios --grep
      "@S-HOOK-01|@S-HOOK-04|@S-HOOK-07"`, then `adlc-lh:check-health` with `finalRun: true`
      (phase 1 boundary).

### Chunk 6 — Phase 2 — uploader: `stop` jobs, retries, failed, takeover

- [ ] In `runJob`, enable `trigger: 'stop'` per DD-9 step 9: claim the coalesced `stop` jobs of the
      same `telemetryDir`, write `otel-status` for each, run one `runUpload` with the newest job's
      session as current, and apply the outcome to every claimed job.
- [ ] Extend `runJob` with DD-9 step 3 (over age / `JOB_MAX_ATTEMPTS` → `failed/`) and the full
      retryable path: rewrite the job atomically with `attempts+1`, `nextAttemptAt = now + backoffMs(attempts+1)`
      and `lastError`, release the claim, exit 10.
- [ ] On every move to `failed/`, upsert recommendation `upload-jobs-failed` (message names the
      count and `~/.artisyn/upload/failed/`). Apply the DD-9 `failed/` cleanup after every `done`
      full scan (in-process or `stop` job).
- [ ] Add the DD-16 `uploadQueue` field (`mode`, `stuckTakenOver`, `failedJobs` counted before the
      cleanup) to the `hook-status` event in `runUpload` (`send-logs-hook.js:1893`); `runUpload`
      takes a `mode` argument.
- [ ] Implement the DD-11 takeover in the `in-process-stop` path of `main()`: once the lock is taken,
      claim the stuck jobs of this `telemetryDir`, write their `otel-status`, run `runUpload`, delete
      them on a non-aborted run (else release), and log `stuck jobs taken over: <n>`.
- [ ] Run `npm run lint` and `npm test` in `hook/`.

### Chunk 7 — Phase 2 — receiver: backoff, crashes, validation, parallelism

- [ ] Scheduler: read `nextAttemptAt` from each job and skip it until due; replace the phase-1
      in-memory retry delay for exit 10 with it. Re-scan when the earliest due time arrives (one
      unref'd timer).
- [ ] Before spawn, validate per DD-10 (JSON, `schema === 1`, `isAllowedUploader`, sibling
      `version.json` major ≥ 3). On failure, move to `failed/` with `failedReason` (atomic write in
      the receiver) and log `job-failed`.
- [ ] Track per-job crashes in memory: a non-DD-5 exit or a timeout kill retries after
      `backoffMs(n)`, and at `JOB_MAX_CRASHES` moves the job to `failed/` with
      `failedReason: 'uploader-crash'`.
- [ ] Idle rule: only *blocking* jobs (DD-10) keep the receiver from idle-exit. Exit 11 and 13
      results never re-arm the idle timer.
- [ ] Run `npm run lint` and `npm test` in `hook/`.

### Chunk 8 — Phase 2 — `Stop` hand-off in the hook

- [ ] In `send-logs-hook.js` `main()`, route `Stop` through `decideHandOff` as well. On `queue`,
      write a `stop` job and exit 0 with the DD-7 `queued` line, skipping re-arm, otel-status and
      the upload.
- [ ] On `in-process-stop`, keep today's path (re-arm, otel-status, `LOCK_WAIT_STOP_MS`, full scan)
      plus the chunk 6 takeover, and spawn the receiver per DD-7 as for `SessionEnd`.
- [ ] Update the comment above the current-session-first ordering in `runUpload` to say the order
      is a best effort for post-turn analysis (DD-17); `post-turn-analysis-hook.js` is not edited.
- [ ] Run `npm run lint` and `npm test` in `hook/`.

### Chunk 9 — Phase 2 — tests and docs

- [ ] Add rows to `docs/algorithm-examples/upload-job-queue.json` for `stop` decisions, `backoffMs`
      (n = 1…7 → 30000, 60000, 120000, 240000, 480000, 900000, 900000) and over-age / max-attempts
      classification.
- [ ] `s-hook-01` new steps: `Stop` with a fresh fake heartbeat writes a `stop` job (DD-1 bounds)
      with no HTTP request; two `stop` jobs of one repo coalesce into one `--run-job` run (both
      deleted, one `done:` line) whose artisyn upload carries the same harness snapshot id as an
      in-process `Stop` of the same repo state.
- [ ] `s-hook-01` new step: a job with `createdAt` 25 h old goes to `failed/`. The next in-process
      `Stop`'s `hook-status` has `uploadQueue.failedJobs: 1` and the `upload-jobs-failed`
      recommendation; after that `done` run `failed/` is empty and the recommendation is gone.
- [ ] `s-hook-01` new step: with a stale heartbeat, a `Stop` takes over a stuck job older than
      `JOB_STUCK_MS` (backdated name) under the lock and logs `stuck jobs taken over: 1`. The
      `hook-status` body carries `uploadQueue.stuckTakenOver: 1`.
- [ ] `s-hook-07` new steps:
      - a 503 responder makes the job retry with `attempts: 1` and a future `nextAttemptAt`, and the
        receiver does not idle-exit;
      - a 400 responder sends the job to `failed/`;
      - an empty queue lets it idle-exit.
- [ ] `s-hook-07` new step: kill the receiver while a job's uploader runs, then start a new receiver.
      The job completes and the server has the same uploads (AC-2).
- [ ] Docs: `upload-job-queue.md` (retries, `failed/`, takeover, coalescing),
      `hook-system-overview.md` (`Stop` pipeline and order, lock budgets), `HOW_HOOK_WORKS.md`
      (upload mechanics, skip reasons), and `turn-end-cost-advisor.md` § "Sessions not yet ingested"
      per DD-17.
- [ ] Run the touched scenarios with `--mode a --only scenarios --grep
      "@S-HOOK-01|@S-HOOK-04|@S-HOOK-07"`, then `adlc-lh:check-health` with `finalRun: true`
      (phase 2 boundary).

### Chunk 10 — Phase 3 — mandatory receiver

- [ ] In `otel-receiver.js` `listen()`, on `EADDRINUSE` with the uploader role held, keep running
      queue-only per DD-8. Write the heartbeat with `listening: false`, arm the idle timer, and log
      `queue-only: port <p> busy`. Without the role, exit 0 as today.
- [ ] In `lifecycle-hook.js:233`, announce on `SessionStart` when `config.otelEnabled` or the
      `buildReceiverLaunch()` mode is shared. Keep `resolveClaudeVersion` and `checkOtelEndpoints`
      behind `config.otelEnabled`.
- [ ] In `maybeReArmOtelSession` (`otel-register.js:1010-1018`), replace the `otelEnabled` gate with
      "`otelEnabled` or shared launch mode" so that every shared-mode repo registers (signals off
      for `otelEnabled: false` via `buildRegistrationPayload`) and a legacy-mode repo with
      `otelEnabled: false` starts no receiver.
- [ ] Run `npm run lint` and `npm test` in `hook/`, and `npm run build:hooks-installer`.

### Chunk 11 — Phase 3 — Node version check (hook + installer)

- [ ] Create `node-version-check.js` per DD-15: `NODE_PATCHED_MINIMUMS`, `NODE_ADVISORY`,
      `classifyNodeVersion`, `nodeWarningText`, `shouldShowNodeWarning(state, version, now)`, and
      `checkNodeVersion({now, home})` reading and writing `~/.artisyn/node-check.json` atomically.
      It honours `ARTISYN_NODE_VERSION_OVERRIDE` and never throws.
- [ ] Add `'node-version-check.js'` to `HOOK_JS_FILES` in `scripts/build-hooks-installer.js`.
- [ ] In `lifecycle-hook.js` `SessionStart`, build the DD-16 warnings array: the OTEL warning only
      when `otelEnabled`, `checkNodeVersion()` always. Replace the single write at `:258` with one
      merged `systemMessage` write.
- [ ] Add `nodeVersion: process.versions.node` to the `hook-status` event in `send-logs-hook.js`
      `runUpload`.
- [ ] Create `artisyn-hooks-installer/src/node-version.ts`, the DD-15 twin (same table,
      classification, text and override env), and make `warnIfNodeEol` in `install.ts:2411` print
      its warning for `eol` and `unpatched`.
- [ ] Update `install.ts:946` "not working yet" text to import the target versions from
      `node-version.ts` instead of repeating them.
- [ ] Run `npm run lint` and `npm test` in `hook/` and `npm run build:hooks-installer`.

### Chunk 12 — Phase 3 — versions and packaging

- [ ] Set the root `package.json` `version` to `1.5.0` (`version.json` is already `3.0.0` from
      chunk 2).
- [ ] Run `npm run build:hooks-installer`.
- [ ] Refresh the dogfooded install per `.claude/rules/hook.md`: copy the changed hook files into
      `.artisyn/marketplace/plugins/log-hub-hooks/scripts/`, and set that plugin's
      `.claude-plugin/plugin.json` version to `3.0.0`.
- [ ] Run `npm run lint:fix` and then `npm run lint` in `hook/`.
- [ ] Run the `update-install-instructions` skill, adding `upload-queue.js` and
      `node-version-check.js` to its file list.

### Chunk 13 — Phase 3 — algorithm and hook scenario tests

- [ ] Write `docs/knowledgebase/algorithms/node-version-check.md`, `docs/algorithm-examples/node-version-check.json`
      and `__tests__/node-version-check.algo.test.js`. Rows: 18.19.0 / 20.11.0 / 21.0.0 / 23.1.0 →
      eol; 22.23.4 → unpatched; 22.23.5, 24.22.3 and 26.13.1 → ok; 28.0.0 → unknown; plus the
      throttle rows (missing, same version < 24 h, ≥ 24 h, version changed).
- [ ] `s-hook-07` step 27: the receiver started against the foreign port stays alive queue-only
      (heartbeat `listening: false`) and runs a queued job. A second receiver exits 0. Update the
      step title.
- [ ] `s-hook-07` new step: one receiver, repo A `otelEnabled: true` and repo B `false`. Jobs of
      both upload, and OTLP records are stored only for A (no chunk under B's otel dir).
- [ ] `s-hook-09` new step: `SessionStart` with `ARTISYN_NODE_VERSION_OVERRIDE=20.11.0` and
      `otelEnabled: true` with no OTEL exporter env prints one JSON object whose `systemMessage` holds
      the OTEL warning and the Node warning (20.11.0, 22.23.5). A second run prints no Node warning;
      `26.13.1` prints none.
- [ ] `s-hook-07` new step: two repos whose hook copies carry different `version.json` (3.0.0 and a
      copy set to 3.0.1) each queue a job. Each uploaded `hook-status` body (fake Log Hub) has the
      `hookVersion` of its own repo's copy and a `nodeVersion` field.
- [ ] Run `npm test` in `hook/` and the touched scenarios with `--mode a --only scenarios --grep
      "@S-HOOK-07|@S-HOOK-09"`.

### Chunk 14 — Phase 3 — compat and installer tests

- [ ] Freeze the 2.32.3 hook with `node scripts/scenarios/freeze-legacy-hook.mjs --commit ca6f6fb`
      and add its line to `tests/fixtures/legacy-hooks/README.md`. In `s-compat-01`, add a step: the frozen 2.32.3 `Stop`, the 3.0.0 `prompt-upload-hook.js`
      background upload and a 3.0.0 `--run-job` on one repo never overlap their lock, and all uploads
      reach the server.
- [ ] `s-compat-01` new step: the frozen 2.32.3 `otel-receiver.js` runs as the shared receiver (no
      heartbeat). A 3.0.0 `Stop` uploads in-process and spawns a 3.0.0 receiver, which goes
      queue-only; the next `Stop` queues a job and the job is uploaded.
- [ ] `tests/scenarios/installer/s-inst-01.spec.ts`: the installer run with
      `ARTISYN_NODE_VERSION_OVERRIDE=22.23.4` prints the unpatched warning. The user-level
      `~/.claude/settings.json` is byte-identical before and after install. Installing, then
      uninstalling, in one repo leaves a second repo's install unchanged.
- [ ] Update `docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md` for every changed or
      new step in S-HOOK-01/04/07/09, S-COMPAT-01 and S-INST-01. Run those scenarios with
      `--mode a --only scenarios --grep`.

### Chunk 15 — Phase 3 — docs, diagrams, help, changelog

- [ ] `docs/knowledgebase/upload-job-queue.md`: final state. Add three plain-text diagrams
      (```` ```text diagram=<id> ```` style of `user-docs/otel-architecture.md:16-26`):
      - the component diagram (hooks of several repos → queue → receiver uploader + OTLP listener
        → Log Hub, with heartbeat and per-repo lock);
      - the hand-off sequence;
      - the fallback sequence, including an old hook beside the new receiver.
- [ ] `otel-receiver.md`: the receiver is non-optional, has two roles, uses queue-only on a port
      conflict and the new idle rule. Copy the component diagram here.
- [ ] `hook-installation.md`: receiver started regardless of `otelEnabled`; the `~/.artisyn/`
      layout (`otel/`, `upload/`, `node-check.json`); `ARTISYN_NODE_VERSION_OVERRIDE`. Add the 3.0.0
      row to the `hook-api-versioning.md` history table.
- [ ] Register the DD-18 twins in `twins-and-cross-cutting-rules.md`. Add the two algorithm docs
      and `upload-job-queue.md` to `docs/knowledgebase/index.md`.
- [ ] `hook/README.md` and `hook/INSTALL_HOOK.md` (FR-14, FR-17):
      - the background process and where the queue, `failed/` and heartbeat live;
      - how to check stalled uploads;
      - `/status` for troubleshooting;
      - the Node warning next to the Node.js requirement;
      - add release checklist line: "update `NODE_PATCHED_MINIMUMS` and `node-version.ts` on each
        Node security release".
- [ ] `user-docs/otel-architecture.md` and `user-docs/data-collection.md`: when and how data leaves
      the machine (queue → receiver), the component diagram, fallback, troubleshooting. Then run
      `npm run build:help`.
- [ ] Write `docs/changelog/<YYYY-MM-DD-HHmm>-receiver-upload-queue.md` per the `changelog` skill
      (hook 3.0.0, Log Hub 1.5.0).
- [ ] In `hook/HOW_HOOK_WORKS.md`, `hook/README.md`, `hook/INSTALL_HOOK.md`,
      `docs/knowledgebase/hook-system-overview.md`, `otel-receiver.md`, `hook-installation.md` and
      `user-docs/*.md`, replace any `SessionEnd` 20000 ms / 20 s wait text and `otelEnabled`
      receiver-start text with the DD-7 / DD-8 behaviour. Then run `adlc-lh:check-health` with
      `finalRun: true`.

### Chunk 16 — Follow-up — receiver re-queues `failed/` jobs

Design: [followup-failed-requeue.md](followup-failed-requeue.md) (triggers, eligible reasons, one
`stop` job per `telemetryDir`, no cap).

- [x] `otel-receiver.js`: `FAILED_REQUEUE_MIN_GAP_MS` (60000), `FAILED_REQUEUE_INTERVAL_MS`
      (1800000), `isRequeueableFailure(reason)` (`over-age`, `max-attempts`, `uploader-crash` only),
      a twin `buildJobName` (DD-3), `requeueFailedJobs(now)` per the design note, triggered after a
      `done` job (debounced) and by an unref'd periodic timer while the uploader role is held. Log
      `job-requeued`. Export the new functions.
- [x] Rows in `docs/algorithm-examples/upload-job-queue.json` for `isRequeueableFailure` and the
      `buildJobName` twin (run against both `upload-queue.js` and `otel-receiver.js`), plus a
      section in `docs/knowledgebase/algorithms/upload-job-queue.md`.
- [x] `s-hook-07` new step: `failed/` holds a `max-attempts` job of repo X and an `upload-rejected`
      job of repo Z; a queued job of repo Y runs `done`; X is re-queued as one `stop` job and
      uploaded, X's `failed/` record is gone, and Z stays.
- [x] Docs: `upload-job-queue.md` (re-queue rules), `otel-receiver.md`, `hook/README.md`
      troubleshooting, the twins row in `twins-and-cross-cutting-rules.md`.
- [x] Refresh the dogfooded plugin copy and run `npm run build:hooks-installer`; run hook lint and
      `npm test`, then `--mode a --only scenarios --grep "@S-HOOK-07"`.

### Chunk 17 — Follow-up — S-HOOK-10: offline laptop, power-off, recovery (Docker)

User story: there is no VPN, the user works, sessions are created but not uploaded; the laptop is
switched off (all processes die); it is switched on, and the first session the user runs uploads
everything. The "laptop" is a Docker container; the Log Hub is the scenario stand (the server
listens on all interfaces, so the container reaches it at `host.docker.internal:<stand port>`).

- [x] New scenario `tests/scenarios/hook/s-hook-10.spec.ts` (`@S-HOOK-10 @mode-a`) with a helper
      `tests/scenarios/helpers/docker-laptop.ts`:
      - one long-lived container per run (`scn-laptop-<run>`), from a local Node LTS image that has
        `git` (reuse what `.claude/skills/big-prod-e2e-test/scripts/lib/node-lts.mjs` uses:
        `public.ecr.aws/docker/library/node:<lts>-bookworm`; pull once if missing), started with
        `--add-host host.docker.internal:host-gateway`, labelled with the run id and removed at the
        end (`docker rm -f` of its own container only);
      - the hook goes in as the **built, installed plugin** (as S-HOOK-09 / S-INST-01 install it),
        in two git repos X and Y inside the container with a real API key from the stand, and
        shared mode set up (`~/.artisyn/otel/port.json`, `token`, receiver `bin/`);
      - Claude transcripts are written into the container's `~/.claude/projects/<slug>/` as
        S-HOOK-09 fixtures do; hook events are fed with `docker exec -i … node <hook> < event.json`.
- [x] Step "no VPN": cut the network (`docker network disconnect` of the container, or point the
      repo `serverUrl` at a blackholed address — pick what yields a real `unreachable` code). Run
      `SessionStart` + three `Stop` / `SessionEnd` cycles for sessions X1, X2, X3 in repo X. Assert:
      each hook run returns in < 1000 ms wall time, the stand has none of X1–X3, jobs are in
      `~/.artisyn/upload/queue/`, `hook.log` has `aborted: server unreachable` or `queued` lines.
- [x] Step "a job already gave up": backdate one X job's `createdAt` by 25 h so its next run moves
      it to `failed/` with `over-age` (asserts the chunk 16 path, not only the queue path).
- [x] Step "power off": `docker kill` the container (SIGKILL of every process, like a power cut);
      the filesystem survives. Then `docker start` it, reconnect the network. Assert the stale
      `uploader.lock` / `heartbeat.json` / `.claim` are still on disk before the next hook run
      (realistic leftovers, pids reused from 1).
- [x] Step "power on, first session": run `SessionStart` + one `Stop` of a new session Y1 in repo
      **Y** (not X). Within a bounded wait (≤ 120 s, polling the stand API), all of X1, X2, X3 and
      Y1 are on the stand with their full transcripts; `queue/` and `failed/` end empty; X's
      `upload-jobs-failed` recommendation is gone after the next X run. A second variant in the
      same scenario: a new session in repo X itself also uploads everything (in-process path).
- [x] Docker availability: if `docker info` fails, the test fails with a clear preflight message
      (not a silent skip); add the Docker requirement to `tests/scenarios/README.md` and the
      preflight notes. Describe S-HOOK-10 in
      `docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md` (table row + section) and
      run `--mode a --only scenarios --grep "@S-HOOK-10"`, then `adlc-lh:check-health` with
      `finalRun: true`.
