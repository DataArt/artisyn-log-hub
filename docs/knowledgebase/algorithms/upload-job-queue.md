---
reviewed: no
reviewer: none
---

# Upload job queue

## Purpose

Since hook `3.0.0` a `Stop` / `SessionEnd` hook hands its log upload to the shared OTEL receiver
(the single uploader of the OS user) by writing a job file into `~/.artisyn/upload/queue/`, instead
of uploading in process and making the user wait. These rules decide when a hook may hand off, how
job files are named and ordered, when a job is "being run", "stuck" or finished, how long a failed
run waits before the next try, and which network errors mean "no connection at all" (stop the run
in ~3 s instead of paying a timeout per file).

## Code

- Implementation: `hook/.claude/telemetry_tool/upload-queue.js` — `buildJobName`, `parseJobName`,
  `listJobs`, `isHeartbeatFresh`, `decideHandOff`, `isClaimStale`, `isJobStuck`,
  `classifyRunOutcome`, `backoffMs`, `jobLimitReason`, `JOB_EXIT` and the constants below;
  `hook/.claude/telemetry_tool/upload-logs.js` — `isUnreachableError` (`UNREACHABLE_ERROR_CODES`).
- Twins: `hook/.claude/telemetry_tool/otel-receiver.js` keeps standalone copies of `buildJobName`,
  `parseJobName`, `isHeartbeatFresh`, `isClaimStale`, `backoffMs`, `JOB_EXIT` and the shared
  constants (the receiver must not `require` hook modules). The rows of kinds `buildName`,
  `parseName`, `heartbeat`, `claimStale`, `backoff`, `jobExit` and `constants` run against both
  copies. The receiver has no `decideHandOff`, `isJobStuck`, `classifyRunOutcome`, `jobLimitReason`
  or `isUnreachableError`, so those rows run against the hook only.
- Receiver only: `otel-receiver.js` — `isRequeueableFailure` (rows of kind `requeueable`) and
  `requeueFailedJobs`, the `failed/` re-queue (rule 13).
- Test: `hook/.claude/telemetry_tool/__tests__/upload-job-queue.algo.test.js`.
- Design: [../upload-job-queue.md](../upload-job-queue.md).

Constants: `HEARTBEAT_STALE_MS` = 15000, `JOB_RUN_TIMEOUT_MS` = 900000, `JOB_STUCK_MS` = 300000, `JOB_MAX_AGE_MS` = 86400000, `JOB_MAX_ATTEMPTS` = 10,
`UPLOAD_CONTRACT` = 1, `JOB_SCHEMA` = 1, `UPLOAD_QUEUE_CAPABILITY` = `upload-queue-v1`, backoff base
30000 and cap 900000; dir and file names `upload`, `queue`, `failed`, `heartbeat.json`,
`uploader.lock`.

## Input and output

Every row has `input.kind`, which picks the function:

| `kind` | Call | Compared |
|---|---|---|
| `buildName` | `buildJobName({sessionId, trigger, now: Date.parse(now), pid, rand})` | `{name}`, or `{error: true}` when it throws |
| `parseName` | `parseJobName(name)` | `null`, or `{sid, ts, tsMs, trigger, pid, rand}` |
| `listOrder` | a temp dir with an empty file per `files[]` name, then `listJobs(dir)` | the array of returned `name`s |
| `heartbeat` | `isHeartbeatFresh(heartbeat, now)` | `{fresh}` |
| `decide` | `decideHandOff({event, heartbeat, queueDirUsable, now})` | `{decision}` |
| `claimStale` | `isClaimStale(claim, now, pid => alivePids.includes(pid))` | `{stale}` |
| `stuck` | `isJobStuck(parseJobName(name), claim, now, pid => alivePids.includes(pid))` | `{stuck}` |
| `outcome` | `classifyRunOutcome(result)` | `{outcome}` |
| `backoff` | `backoffMs(n)` | `{delayMs}` |
| `limit` | `jobLimitReason({createdAt, attempts}, now)` | `{reason}` |
| `jobExit` | `JOB_EXIT` | the whole object |
| `constants` | the shared constants by name | `{name: value}` |
| `unreachable` | `isUnreachableError(code)` | `{unreachable}` |
| `requeueable` | `isRequeueableFailure(reason)` (receiver) | `{requeueable}` |

`now` is epoch ms except in `buildName`, where it is an ISO string.

## Rules

1. **Job name** (`buildJobName`): `<sid>_<ts>_<trigger>_<pid>-<rand>.json`.
   - `sid`: the session id with every char outside `[A-Za-z0-9-]` removed, cut to 64 chars;
     `nosession` when nothing is left.
   - `ts`: the UTC instant as `YYYYMMDDTHHmmssSSSZ` (the ISO string without `-`, `:` and `.`).
   - `trigger`: `stop` or `session-end`; anything else throws.
   - `pid`: the writing process; `rand`: 4 lowercase hex chars (`crypto.randomBytes(2)`), the
     same-millisecond disambiguator.
2. **Parse** (`parseJobName`): the name must match
   `^([A-Za-z0-9-]{1,64})_(\d{8}T\d{9}Z)_(stop|session-end)_(\d+)-([0-9a-f]{4})\.json$` and its `ts`
   must be a real instant: formatting `Date.parse` of it back must give the same 19 chars (so month
   13 or Feb 30 fail). Otherwise `null` — the file is not a job. `tsMs` is that `Date.parse`.
3. **Order** (`listJobs`): `.tmp` and `.claim` files and names that do not parse are skipped; jobs
   are ordered by `ts` (string compare), then by the full name (string compare).
4. **Fresh heartbeat** (`isHeartbeatFresh`): the heartbeat is an object, `ts` is a finite number,
   `now − ts ≤ HEARTBEAT_STALE_MS` (no lower bound), `capabilities` is an array containing
   `upload-queue-v1`, and `uploadContract` is a number `≥ UPLOAD_CONTRACT`. No pid probe.
5. **Hand-off decision** (`decideHandOff`):
   - an event other than `Stop` / `SessionEnd` → `null`;
   - `queueDirUsable === true` and the heartbeat is fresh → `queue`;
   - otherwise `Stop` → `in-process-stop`, `SessionEnd` → `session-end-fallback`.
6. **Stale claim** (`isClaimStale(claim, now, isAlive)`), first match wins:
   - `claim` is not an object or its `pid` is not an integer → stale;
   - `Date.parse(startedAt)` is not finite → stale;
   - `isAlive(pid)` is false → stale;
   - `now − startedAt > JOB_RUN_TIMEOUT_MS` → stale; otherwise live.
7. **Stuck job** (`isJobStuck`): `parsedName` is null → false; else
   `now − tsMs > JOB_STUCK_MS && isClaimStale(claim, now, isAlive)`.
8. **Run outcome** (`classifyRunOutcome({uploaded, retryableFailures, permanentFailures,
   aborted})`): `retryable` when `aborted` or `retryableFailures > 0`; else `permanent` when
   `permanentFailures > 0 && uploaded === 0`; else `done`. (A failed file is retryable when its
   `statusCode` is null, ≥ 500 or 429; any other 4xx is permanent — counted by the uploader.)
9. **Backoff** (`backoffMs(n)`): `k = n` when `n ≥ 1`, else 1; `min(30000 · 2^(k−1), 900000)`.
10. **Exit codes and constants**: `JOB_EXIT` = `done` 0, `retryable` 10, `permanent` 11, `busy`
    12, `dropped` 13; the constants listed under Code are equal in both twins.
11. **Unreachable** (`isUnreachableError(code)`): true only for `ECONNREFUSED`, `ENOTFOUND`,
    `EAI_AGAIN`, `EHOSTUNREACH`, `ENETUNREACH` and `ECONNTIMEOUT` (the 3 s connect timer of
    `UPLOAD_CONNECT_TIMEOUT_MS`); any other code, or none, is false.
12. **Job limits** (`jobLimitReason(job, now)`, DD-9 step 3): `over-age` when
    `now − Date.parse(createdAt) > JOB_MAX_AGE_MS` (checked first); else `max-attempts` when
    `attempts ≥ JOB_MAX_ATTEMPTS`; else `null`. A job with a reason goes to `failed/` (exit 11)
    without a claim or an upload; the coalescing `stop` run skips such jobs.
13. **Re-queue of `failed/` jobs** (receiver only, `requeueFailedJobs(now)`):
    - eligible (`isRequeueableFailure(reason)`): `failedReason` is exactly `over-age`,
      `max-attempts` or `uploader-crash`. Every other reason (`invalid-json`, `unknown-schema`,
      `upload-rejected`, `uploader-not-allowed`, `uploader-too-old`, `uploader-version-unknown`, a
      missing one) is never re-queued — it would fail the same way again, forever;
    - triggers: a job exits `done` (at most once per `FAILED_REQUEUE_MIN_GAP_MS` = 60000), and a
      timer every `FAILED_REQUEUE_INTERVAL_MS` = 1800000 while the uploader role is held;
    - eligible records are grouped by `telemetryDir`; a group whose `telemetryDir` already has a
      job in `queue/` is skipped (that job's `done` full scan cleans `failed/`);
    - otherwise one new `stop` job is built from the group's newest record (rule 3 order): fresh
      rule 1 name and `createdAt`, `attempts` 0, `nextAttemptAt` / `lastError` null,
      `requeuedFrom` = the grouped names, `requeueCount` = the group's highest + 1 (no cap);
    - it must pass the receiver's pre-spawn validation and speak a supported contract, else the
      records stay; it is written atomically (0o600), then the grouped records are deleted.

## Edge cases

- Session id sanitising, empty id and the 64-char cut: UQ-02, UQ-03, UQ-04; unknown trigger: UQ-05.
- Temp and claim files are not jobs: UQ-07, UQ-08, UQ-15; uppercase rand: UQ-09; impossible dates:
  UQ-11, UQ-12; `_` in the sid: UQ-13; 65-char sid: UQ-14.
- Same-millisecond jobs and ts before name: UQ-15.
- Heartbeat age on both sides of 15 s: UQ-16, UQ-17; a future ts: UQ-23; missing capability,
  old and newer contract: UQ-18, UQ-19, UQ-20; no heartbeat or a string ts: UQ-21, UQ-22.
- Decision per event, stale heartbeat and unusable dir: UQ-24 … UQ-30; `Stop` with an unusable
  dir, a 15 s-old heartbeat and a pre-3.0.0 receiver: UQ-66, UQ-67, UQ-68.
- Claim: missing, malformed pid, bad date, dead pid: UQ-31 … UQ-34; the 15-min limit on both
  sides: UQ-35, UQ-36.
- Stuck on both sides of 5 min: UQ-38, UQ-39; a live claim protects an old job: UQ-40; a dead one
  does not: UQ-41; a non-job name: UQ-42.
- Outcome precedence: UQ-44, UQ-45; partial success is done: UQ-47; nothing to do: UQ-48.
- Backoff growth, cap and `n < 1`: UQ-49 … UQ-54, UQ-69 … UQ-71 (n = 1 … 7 all covered).
- Job limits on both sides of 24 h and 10 attempts, and their precedence: UQ-72 … UQ-77.
- Unreachable vs other network errors: UQ-57 … UQ-65.
- Re-queue eligibility: the three eligible reasons UQ-78 … UQ-80; never re-queued UQ-81 … UQ-85;
  case and a missing reason: UQ-86, UQ-87. A year-end name and pid 0 (both twins): UQ-88.

## Examples

Rows (88): [`docs/algorithm-examples/upload-job-queue.json`](../../algorithm-examples/upload-job-queue.json) — test data for the table test; the rules above are enough to understand the algorithm. Timestamps use `2026-11-18T19:33:01.123Z` (= 1795030381123) for job names and `now` = 1800000000000 (`2027-01-15T08:00:00.000Z`) for heartbeats and claims.

## Mutations

- "Order by full name only" (the `zzz` job would be last) -> UQ-15.
- "Heartbeat fresh with `<` instead of `≤`" -> UQ-16; "no capability check" -> UQ-18.
- "Claim timeout compared with `≥`" -> UQ-35; "a dead pid ignored while the claim is young" -> UQ-34.
- "Stuck ignores the claim" -> UQ-40.
- "Permanent wins over retryable" -> UQ-45; "any permanent failure fails the job" -> UQ-47.
- "No backoff cap" -> UQ-52, UQ-71.
- "Over age with `≥`" -> UQ-73; "attempts compared with `>`" -> UQ-76; "attempts checked first" -> UQ-77.
- "`ECONNRESET` aborts the run" -> UQ-63.
- "re-queue every failed job" (a 4xx loops forever) -> UQ-81; "case-insensitive reason" -> UQ-86.
- "the receiver's `buildJobName` drifts from the hook's" -> UQ-01 … UQ-05, UQ-88 `[otel-receiver]`.

## Where the result is visible

The job files in `~/.artisyn/upload/queue/` and `failed/`; the `queued: job=<name> elapsedMs=…`,
`run-job <outcome>: <name>` and `aborted: server unreachable (…) — N files left for the next run`
lines in the repo's `hook.log`; the `job-start` / `job-done` / `job-retry` / `job-requeued` lines in
`~/.artisyn/otel/receiver.log`; how fast `Stop` / `SessionEnd` return to Claude Code.
