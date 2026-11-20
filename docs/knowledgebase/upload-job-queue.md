---
type: "Architecture Guide"
title: "Upload Job Queue (shared receiver as the single log uploader)"
description: "Hook 3.0.0: Stop / SessionEnd hand their log upload to the per-user shared OTEL receiver through job files in ~/.artisyn/upload/ — state layout, job name grammar and schema, the send-logs-hook.js --run-job uploader contract and exit codes, the receiver heartbeat, the hand-off decision and SessionEnd fallback, the receiver's uploader role, scheduler and queue-only mode, claims and stuck jobs, the no-connection fast fail, component / hand-off / fallback diagrams, troubleshooting, and which parts ship in which phase."
tags:
  - hooks
  - otel
  - upload
generated: { by: "human:denistsyplakov", at: "2026-11-18T23:00:00+04:00" }
---

# Upload Job Queue

Before hook `3.0.0` every `Stop` and `SessionEnd` hook uploaded its repo's logs **in process**:
Claude Code waited for the upload ("Uploading logs…"), and a `SessionEnd` that met a busy per-repo
upload lock waited up to 20 s for it. Since `3.0.0` the hook can hand the upload off: it writes a
small **job file** into a per-user queue and returns at once, and the per-user shared OTEL receiver
([otel-receiver.md](otel-receiver.md)) — which already runs once per OS user — runs every job as
the **single uploader** of that user. The hook keeps an in-process fallback for when no uploader is
up. Since `3.0.0` the receiver is no longer optional: in shared launch mode it is started for every
repo, `otelEnabled` or not (`isReceiverWanted` in `otel-register.js`; a repo with `otelEnabled:
false` registers with no signals, so its OTLP records are still dropped).

Task: `docs/tasks/todo/2026-11-18-receiver-upload-queue/` (plan DD-2 … DD-19). Rules that can be
computed by hand (name grammar, freshness, decision, claims, outcome, backoff, unreachable codes):
[algorithms/upload-job-queue.md](algorithms/upload-job-queue.md).

## Diagrams

### Components

```text diagram=upload-queue-components
 Developer machine (one OS user)

  repo A hook ─┐  Stop / SessionEnd
  repo B hook ─┼── 1. read heartbeat.json
  repo C hook ─┘   2. fresh? write a job ──► ~/.artisyn/upload/
        │                                     ├─ queue/<name>.json   ── fs.watch + 10 s poll ──┐
        │                                     ├─ failed/<name>.json  ◄─ jobs that gave up ─────┤
        │                                     ├─ heartbeat.json      ◄─ rewritten every 5 s ───┤
        │                                     └─ uploader.lock       ◄─ one holder ────────────┤
        │                                                                                       │
        │                                  Shared receiver (one process per OS user) ◄──────────┘
        │                                   ├─ uploader role ─► node <job.uploader> --run-job <job>
        │                                   │                   (≤ 2 at once, one per repo,
        │                                   │                    the job's OWN repo's hook copy)
        │                                   └─ OTLP listener 127.0.0.1:<port>  (absent when queue-only)
        │                                                  │
        │ fallback: in-process upload                      ▼
        └──────────────────────────────► <repo>/.upload.lock  (per repo: one upload at a time)
                                                           │
                                                           ▼ that repo's server URL and API key
                                                    Log Hub server
```

### Hand-off (fresh heartbeat)

```text diagram=upload-handoff-sequence
 Hook (Stop / SessionEnd)       ~/.artisyn/upload/          Receiver (uploader role)       Log Hub
   │ read heartbeat.json ────────►│◄──── heartbeat every 5 s ────│                              │
   │ fresh: ≤ 15 s, upload-queue-v1, uploadContract ≥ 1          │                              │
   │ write queue/<name>.json ────►│  (tmp + rename, no API key)  │                              │
   │ log "queued: job=… elapsedMs=…" and exit (~200 ms)          │                              │
                                  │──── fs.watch / 10 s poll ───►│ validate, isAllowedUploader  │
                                  │                              │ spawn node <job.uploader>    │
                                  │◄──── 'wx' claim ─────────────│   --run-job <job>            │
                                  │                              │ <repo>/.upload.lock, otel-status
                                  │                              │ upload ─────────────────────►│
                                  │◄──── done: delete job+claim ─│ exit 0                       │
                                  │◄──── retryable: attempts+1, nextAttemptAt ── exit 10        │
                                  │◄──── permanent: move to failed/ ──────────── exit 11        │
                                  │      busy (lock held): job untouched ─────── exit 12, retry in 5 s
```

### Fallback (no fresh heartbeat), and an old hook beside the new receiver

```text diagram=upload-fallback-sequence
 Hook 3.0.0, no fresh heartbeat (no receiver up, or a receiver < 3.0.0 holds the port)
   │ port.json present, shared launch, spawn.mark older than 60 s?
   │   └─ yes ─► spawn its own otel-receiver.js (no hello) ─► the new process takes uploader.lock;
   │             port busy ─► queue-only: runs jobs, no OTLP listener, idles out on an empty queue
   ├─ Stop ───────► in-process upload as before (2 s lock wait, full scan, takes over stuck jobs)
   └─ SessionEnd ─► wait ≤ 800 ms for <repo>/.upload.lock
                       ├─ acquired ───────────────► in-process scoped flush
                       ├─ busy, queue dir usable ─► write a job: "queued (fallback): lock busy"
                       └─ busy otherwise ─────────► "skipped: upload lock held" (next full scan)

 Hook < 3.0.0 in a repo next to a 3.0.0 receiver
   │ never reads the queue or the heartbeat ─► uploads in process exactly as before
   └─ its upload and a 3.0.0 job of the same repo both take <repo>/.upload.lock ─► never at once:
      the job run exits 12 (busy) and the receiver retries it after 5 s
```

## Code

| File | Role |
|---|---|
| `hook/.claude/telemetry_tool/upload-queue.js` | the queue library: paths, names, job build/validate, atomic write, heartbeat read, `decideHandOff`, claims, `classifyRunOutcome`, `backoffMs`, `jobLimitReason`, per-repo job and `failed/` listings, spawn throttle |
| `hook/.claude/telemetry_tool/send-logs-hook.js` | the hand-off in `main()` (`enqueueUploadJob`, `maybeSpawnUploadReceiver`), the stuck-job takeover (`claimStuckJobs`), the uploader `runJob` (`--run-job`: `claimCoalescedStopJobs`, `rescheduleJob`, `failJob`, `clearFailedJobs`) |
| `hook/.claude/telemetry_tool/otel-receiver.js` | the uploader role: `uploader.lock`, heartbeat, queue watch and scan, `runJobProcess`, idle rule; standalone twins of the shared rules |
| `hook/.claude/telemetry_tool/otel-register.js` | `spawnSharedReceiverNoHello` — the hand-off path's receiver spawn |
| `hook/.claude/telemetry_tool/upload-logs.js` | `UPLOAD_CONNECT_TIMEOUT_MS`, `isUnreachableError` (fast fail) |

## Per-user state: `~/.artisyn/upload/` (DD-2)

Resolved per call from `os.homedir()` in the hook and from `--owner-home` in the receiver (a
receiver the hook spawns inherits the user's env, so both are the same home). Dirs are `0o700`,
files `0o600`, every write is tmp + rename. `~/.artisyn/otel/` stays OTEL-only.

| Path | Writer | Content |
|---|---|---|
| `queue/<name>.json` | hook (create), uploader (rewrite under claim) | a job (below) |
| `queue/.<name>.json.<rand>.tmp` | any writer | temp file of an atomic write; readers ignore it |
| `queue/<name>.json.claim` | uploader (`'wx'`) | `{pid, startedAt}` — "this job is being run" |
| `failed/<name>.json` | uploader or receiver | the job plus `failedAt` (ISO) and `failedReason` |
| `heartbeat.json` | the uploader-role receiver | DD-6, below |
| `uploader.lock` | receiver (`'wx'`) | `{pid, startedAt, version}` — the uploader-role guard |
| `spawn.mark` | hook | epoch ms of the last hand-off-path receiver spawn |

## Job files (DD-3, DD-4)

**Name**: `<sid>_<ts>_<trigger>_<pid>-<rand>.json`, e.g.
`cur_20261118T193301123Z_session-end_4242-a1b2.json` — the sanitised session id, the UTC
`YYYYMMDDTHHmmssSSSZ` time, `stop` or `session-end`, the writer's pid and 4 random hex chars.
Readers order jobs by `ts`, then by name; a name that does not match the grammar is not a job.

**Content** (`schema: 1`): `sessionId`, `trigger`, `createdAt`, `hookVersion`, `uploader` (the
absolute path of the writing repo's `send-logs-hook.js`), `uploaderContract: 1`, `cwd`, `gitRoot`,
`telemetryDir`, `transcriptPath`, `hookEvent`, `serverUrl` (informational), `env`, `attempts`,
`nextAttemptAt`, `lastError`.

- **The job never carries the API key.** The run reads it from the repo config, like any hook run.
- `env` holds only the set keys of `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_ENABLE_TELEMETRY`,
  `ARTISYN_PROJECT_ROOT`, `ARTISYN_MANAGED_SETTINGS_DIR` and every `OTEL_*` key without `HEADERS`.
  `applyJobEnv` first deletes those keys from the run's env and then copies the job's in, so the
  receiver's own env never leaks into another repo's run.

## Uploader contract: `send-logs-hook.js --run-job <jobPath>` (DD-5, DD-9)

The receiver runs each job as `node <job.uploader> --run-job <jobPath>` — the **job's own repo's**
hook version, not the receiver's. No stdin; the argv branch sits before the stdin read, like
`--otel-sweep`. Exit codes (`JOB_EXIT`):

| Code | Name | Meaning | Receiver action |
|---|---|---|---|
| 0 | `done` | uploaded, or nothing to do; job(s) and claim(s) deleted | none |
| 10 | `retryable` | network error, 5xx, 429 or an unreachable abort; job rewritten with `attempts+1`, `nextAttemptAt`, `lastError`; claim released | run again once `nextAttemptAt` is due |
| 11 | `permanent` | invalid job, over age / out of attempts, or only 4xx rejections; job moved to `failed/` | none |
| 12 | `busy` | claimed by a live run, or the per-repo upload lock is busy; job untouched | retry after `BUSY_RETRY_MS` (5 s) |
| 13 | `dropped` | the repo or its telemetry dir is gone; job deleted | none |

Any other exit, a crash or the `JOB_RUN_TIMEOUT_MS` (15 min) kill counts as a crash (see the
scheduler below).

A run (`runJob`, DD-9):

1. Validate the job (invalid or unknown schema → `failed/`, 11).
2. Repo or telemetry dir gone → delete, 13.
3. **Limits** (`jobLimitReason`): `createdAt` older than `JOB_MAX_AGE_MS` (24 h) → `over-age`, or
   `attempts ≥ JOB_MAX_ATTEMPTS` (10) → `max-attempts`; either → `failed/`, 11, no upload.
4. `'wx'` claim (held by a live run → 12).
5. Apply `job.env`, `loadConfig(job.cwd)` (no `serverUrl` / `apiKey` → delete, 0).
6. Take the per-repo upload lock with the short `LOCK_WAIT_STOP_MS` (busy → release the claim, 12).
7. A **`stop` job coalesces**: it `'wx'`-claims every other runnable `stop` job of the same
   `telemetryDir` (valid, a supported contract, within its limits, no live claim) and logs
   `run-job coalesced <n> stop jobs: <names>`. One full scan serves them all.
8. Write each claimed job's `otel-status` line.
9. `session-end` → the scoped `runSessionEndFlush` of its session; `stop` → one `runUpload` (the
   full scan of the repo, `hook-status.uploadQueue.mode: 'job'`) with the newest claimed job's
   session as the current one.
10. Classify (`classifyRunOutcome`) and apply the outcome to **every** claimed job: `done` deletes
    them; `retryable` rewrites each atomically (`attempts+1`, `nextAttemptAt = now +
    backoffMs(attempts+1)`, `lastError`) and releases its claim; `permanent` moves each to `failed/`
    with `failedReason: 'upload-rejected'`.
11. Release the lock and exit with the code above.

`hook.log` gets `run-job start: <name>` and `run-job <outcome>: <name> (<detail>)`; a coalesced job
gets no `run-job start` line of its own.

## Retries and `failed/` (DD-9, DD-12)

- **Backoff**: `backoffMs(n) = min(30 s · 2^(n−1), 15 min)` — 30 s, 1 min, 2 min, 4 min, 8 min, then
  15 min. The uploader writes it into the job as `nextAttemptAt`; the receiver only reads it.
- **`failed/`**: a job moves there (the job plus `failedAt` ISO and `failedReason`) when it is
  invalid, over age, out of attempts, rejected by the server (`upload-rejected`), or crashed its
  uploader 3 times (`uploader-crash`, receiver side). Every move logs
  `job failed: <name> reason=<reason>` in the repo's `hook.log` and upserts the repo's
  `upload-jobs-failed` recommendation (it names the count and `~/.artisyn/upload/failed/`, and
  rides in the next `hook-status`).
- **No data is lost**: the files a failed job stood for stay unmanifested. The next **full scan
  with the outcome `done`** — an in-process `Stop` or a `stop` job — uploads them, then deletes
  every `failed/` job of that `telemetryDir`, logs `failed jobs cleared: <n>` and removes the
  recommendation. `hook-status.uploadQueue.failedJobs` of that run is counted **before** the
  cleanup, so the server sees the failure once.
- **Re-queue by the receiver** (follow-up): a full scan of *that* repo is only one way out — the
  uploader-role receiver also moves eligible `failed/` jobs back to the queue, so a repo the user
  no longer works in uploads too once the connection is back:
  - **eligible** `failedReason` (`isRequeueableFailure`): `over-age`, `max-attempts`,
    `uploader-crash` only. `invalid-json` / schema errors, `upload-rejected` (4xx),
    `uploader-not-allowed`, `uploader-too-old` and `uploader-version-unknown` stay — they would fail
    the same way again, forever;
  - **triggers**: a job exits `done` (at most once per `FAILED_REQUEUE_MIN_GAP_MS` = 60 s), and an
    unref'd timer every `FAILED_REQUEUE_INTERVAL_MS` = 30 min while the role is held;
  - **per `telemetryDir`**: skipped while the queue holds a job of that repo (its `done` full scan
    cleans `failed/`); otherwise **one `stop` job** from the newest eligible record — fresh DD-3 name
    (`buildJobName`, the receiver's twin) and `createdAt`, `attempts: 0`, `nextAttemptAt` /
    `lastError` null, `requeuedFrom: [<names>]`, `requeueCount` = highest + 1. A `stop` job runs a
    full scan, so it covers every session of the repo even when the record was a `session-end` job;
  - it must pass the pre-spawn validation and a supported contract, else the records stay; written
    atomically (0o600), then the grouped records are deleted; logged `job-requeued`;
  - **no cap** on `requeueCount` (data safety wins; an offline cycle costs a 3 s connect timeout per
    try). The hook side is unchanged; the `upload-jobs-failed` recommendation goes away through the
    usual `done` full-scan cleanup.
  Rules: [algorithms/upload-job-queue.md](algorithms/upload-job-queue.md) rule 13.

Versioning: a hook hands off only when the heartbeat's `uploadContract` is ≥ the contract it
writes; a receiver runs only jobs whose `uploaderContract` it supports (`[1]`) and leaves any other
job in the queue, untouched, for a newer receiver.

## Heartbeat (DD-6)

`heartbeat.json` = `{schema: 1, pid, version, capabilities, uploadContract: 1, listening, startedAt,
ts}`, written every `HEARTBEAT_INTERVAL_MS` (5 s) by the process that holds `uploader.lock`, and
deleted on its exit. `listening` says whether that process also has the OTLP port. A hook calls it
**fresh** when `now − ts ≤ 15 s`, `capabilities` lists `upload-queue-v1` and `uploadContract ≥ 1`
— there is no pid probe in the hook.

## Hand-off decision and the `SessionEnd` fallback (DD-7)

`decideHandOff({event, heartbeat, queueDirUsable})`:

- **`queue`** — fresh heartbeat and a usable queue dir: write one job, log
  `queued: job=<name> elapsedMs=<ms since process start>` and exit. No OTEL re-arm and no
  `otel-status` on this path: the job run writes `otel-status`, `lifecycle-hook.js` re-arms on
  every other event. Measured ≈ 150 ms in the hook, ≈ 200 ms wall.
- **`session-end-fallback`** — `SessionEnd` otherwise: re-arm and `otel-status` as before, then
  wait for the per-repo lock for at most `LOCK_WAIT_SESSION_END_MS` = **800 ms** (was 20 s):
  - acquired → the in-process scoped flush, as before;
  - busy and the queue dir usable → write a job instead (`queued (fallback): lock busy job=…`), so
    the session's own files are not stranded — the next uploader runs it;
  - busy otherwise → `skipped: upload lock held …`, as before.
- **`in-process-stop`** — `Stop` otherwise: today's full upload (re-arm, `otel-status`, the 2 s
  `LOCK_WAIT_STOP_MS`, full scan), plus the stuck-job takeover below.

`queue` applies to both events: a `Stop` writes a `stop` job, a `SessionEnd` a `session-end` job.
When the job write fails although the dir looked usable, the hook falls back to the in-process
path of its event.

Before a fallback, the hook (re)spawns an uploader when the heartbeat is not fresh,
`~/.artisyn/otel/port.json` exists, the launch resolves to shared mode and `spawn.mark` is older
than `RECEIVER_SPAWN_THROTTLE_MS` (60 s): its own `otel-receiver.js` with the shared argv, no hello
(`spawnSharedReceiverNoHello`), logged `receiver: spawned for upload queue`.

## The receiver's uploader role (DD-8, DD-10)

See also [otel-receiver.md](otel-receiver.md) § "Uploader role". The receiver has two independent
roles: **listener** (the OTLP port) and **uploader** (`uploader.lock`).

- `startShared` takes the uploader role **before** `listen()`. A lock is stale when its pid is dead
  or `heartbeat.json` is older than 4 × 15 s; a stale lock is removed and retaken with `'wx'`. A
  receiver without the role retries on every heartbeat tick. Shared mode only, and only with a valid
  token.
- **Scheduler**: `fs.watch(queue/)` plus a 10 s poll backstop and a drain scan right after the role
  is taken. Jobs run in DD-3 order; skipped are jobs whose `nextAttemptAt` is still ahead, jobs
  waiting for an in-memory busy / crash retry, jobs with a live claim, jobs of an unsupported
  contract and jobs whose `telemetryDir` already has a running job. One unref'd timer re-scans when
  the earliest due time arrives. At most `MAX_PARALLEL_JOBS` = 2 at a time.
- **Pre-spawn validation**: the JSON parses, `schema === 1`,
  `isAllowedUploader(job.uploader, job.gitRoot, ownerHome)` (the same rule as the register
  contract) and the uploader's sibling `version.json` major is ≥ 3. A failure moves the job to
  `failed/` with that `failedReason` and logs `job-failed`.
- **Spawn**: `process.execPath [job.uploader, '--run-job', jobPath]`, `windowsHide`,
  `stdio: 'ignore'`, cwd `os.tmpdir()`, not detached; killed after 15 min.
- **Crashes**: a non-DD-5 exit, a spawn failure or the timeout kill grows an in-memory per-job
  counter `n` and retries after `backoffMs(n)`; at `JOB_MAX_CRASHES` (3) the job goes to `failed/`
  with `uploader-crash`. The counter does not survive a receiver restart.
- **A receiver killed mid-job** leaves `uploader.lock`, `heartbeat.json`, the job and its claim
  behind. The next receiver retakes the lock (dead pid), the job's claim is stale (dead pid), so
  the job runs again; its per-repo `.upload.lock` is freed because its holder is dead. The server
  receives the same uploads as from an uninterrupted run.
- **Idle exit**: on expiry, a process that holds the role and has a running job or a *blocking*
  queued job (a parseable name, a supported contract, no live claim) re-arms instead of exiting. A
  job waiting for its `nextAttemptAt` is blocking, so a receiver with a retryable job stays up; exit
  11 and 13 never re-arm the timer, so an empty queue lets it idle out.
- **Queue-only** (`EADDRINUSE` while it holds the uploader role): the port belongs to another
  process — typically a receiver older than `3.0.0`, or a foreign program — so this receiver keeps
  running the queue without a listener (`runtime.queueOnly`, heartbeat `listening: false`, log
  `queue-only: port <p> busy …`). It arms the idle timer at start and on every job event, and exits
  once no job is running or blocking. Without the role, `EADDRINUSE` still means exit 0.
- `receiver.log` lines: `queue-only`, `uploader-role`, `uploader-lock-stale`, `job-start`, `job-done`,
  `job-retry`, `job-failed`, `job-dropped`, `job-crash`, `job-requeued`, `job-requeue-skip`.
- **`failed/` re-queue**: after a `done` job (debounced 60 s) and every 30 min — see "Retries and
  `failed/`" above.
- On exit it deletes `heartbeat.json` and `uploader.lock` (each only while it names its pid).

## Claims and stuck jobs (DD-11)

A claim is **stale** when it is missing or unparsable, its pid is dead, or it is older than
`JOB_RUN_TIMEOUT_MS`; a stale claim is removed and retaken once. A job is **stuck** when its `ts`
is older than `JOB_STUCK_MS` (5 min) and it has no live claim.

**Takeover** (only an `in-process-stop`, only while it holds the per-repo lock; `SessionEnd` never
takes over): claim every stuck job of its own `telemetryDir` (a newer contract's jobs are left
alone), write their `otel-status`, run the normal full scan — it covers every session of the repo
— and delete the claimed jobs on a non-aborted run (release the claims otherwise). It logs
`stuck jobs taken over: <n> (<names>)` and reports `hook-status.uploadQueue.stuckTakenOver`.

## `hook-status.uploadQueue` (DD-16)

Every full scan adds `uploadQueue: {mode, stuckTakenOver, failedJobs}` to the `hook-status` line:
`mode` is `in-process` (a hook-run `Stop`) or `job` (a `stop` job), `stuckTakenOver` the takeover
count, `failedJobs` the `failed/` jobs of this `telemetryDir` before the cleanup. Additive: older
servers drop it.

## Fast fail when there is no connection (DD-13)

`upload-logs.js` gives every request a 3 s **connect** timeout (`UPLOAD_CONNECT_TIMEOUT_MS`,
cleared on `connect` / `secureConnect`; fires as `ECONNTIMEOUT`). A result with `ECONNREFUSED`,
`ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`, `ENETUNREACH` or `ECONNTIMEOUT` carries
`unreachable: true`; `runUpload`, `runSessionEndFlush` and `runOtelSweep` stop at the first one and
log `aborted: server unreachable (<code>) — <n> files left for the next run`. The response timeout
after connecting stays per request (`sendLogsTimeoutMs`). These three functions return
`{uploaded, retryableFailures, permanentFailures, aborted}`, which only `runJob` classifies.

## Phases and current state

| Phase | What | State |
|---|---|---|
| 1 | queue library; `--run-job` for `session-end` jobs; receiver uploader role, heartbeat, scheduler, idle rule; `SessionEnd` hand-off and 800 ms fallback; fast fail | **done** |
| 2 | `stop` jobs (coalesced per repo), job rewrite with `attempts` / `nextAttemptAt`, `failed/` + `upload-jobs-failed` recommendation, receiver backoff / crash limits / pre-spawn validation, `Stop` hand-off, stuck-job takeover | **done** |
| 3 | receiver started regardless of `otelEnabled` (shared mode), queue-only mode on an OTLP port conflict, Node version check ([algorithms/node-version-check.md](algorithms/node-version-check.md)), hook 3.0.0 / Log Hub 1.5.0 packaging | **done** |

Scenario coverage: `s-hook-01` steps 10–11d (hand-off, `--run-job`, coalescing, `failed/`,
takeover), `s-hook-07` steps 27–33 (queue-only on a port conflict, uploader role, retries,
`failed/`, idle rule, a killed receiver, an `otelEnabled: false` repo, two hook versions, the
`failed/` re-queue after a reboot),
`s-compat-01` steps 16–17 (a frozen 2.32.3 hook and receiver beside 3.0.0), `s-hook-09` step 13
(Node warning), `s-inst-01` (installer Node warning, per-repo install isolation).

## Troubleshooting

- **Is an uploader up?** `~/.artisyn/upload/heartbeat.json` with a `ts` from the last few seconds;
  `listening: false` means queue-only. `~/.artisyn/otel/receiver.log` shows `uploader-role`,
  `job-*` and `queue-only` lines.
- **Stalled uploads**: jobs that stay in `~/.artisyn/upload/queue/` — look at their `attempts`,
  `nextAttemptAt` and `lastError`. A `.claim` next to a job means a run is in progress (or its
  runner died; it goes stale after 15 min or at once with a dead pid).
- **Given up**: `~/.artisyn/upload/failed/` with `failedReason`; the repo's `hook.log` has
  `job failed: …`, and the Hook State panel shows the `upload-jobs-failed` recommendation. Nothing
  is lost: the next successful full scan of that repo uploads the files and clears the folder.
  `over-age` / `max-attempts` / `uploader-crash` jobs also retry automatically once the server is
  reachable (after the next `done` job, or within 30 min): `job-requeued` in `receiver.log`.
- The repo's `hook.log` says which path a hook run took: `queued: …`, `queued (fallback): …`,
  `run-job …`, `stuck jobs taken over: …`, `aborted: server unreachable …`.

## Related

- [otel-receiver.md](otel-receiver.md) — the shared receiver, its state dir and the uploader role
- [hook-system-overview.md](hook-system-overview.md) — the upload pipeline, lock and triggers
- [hook-api-versioning.md](hook-api-versioning.md) — the `--run-job` contract and the
  `upload-queue-v1` capability across hook versions
- [algorithms/upload-job-queue.md](algorithms/upload-job-queue.md) — the table-tested rules
