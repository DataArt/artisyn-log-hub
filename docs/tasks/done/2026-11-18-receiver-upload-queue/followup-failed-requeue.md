# Follow-up: receiver re-queues `failed/` jobs (user decision, 2026-11-18)

Decided while chunks 1–15 were running; becomes **Chunk 16** of `impl-plan.md` once that workflow
finishes (added after it, so the running plan check does not report it as a gap).

## Problem

A job lands in `failed/` after `over-age` (24 h) or `max-attempts` (10, about 1.5 h of retries with
no connection, e.g. no VPN). Its data is not lost (files stay unmanifested), but today only the next
`done` full scan **of the same repo** uploads it. If the user works in another repo after the
laptop is back online, the old repo's sessions wait until that repo is opened again.

## Decision

The uploader-role receiver moves eligible `failed/` jobs back to the queue:

- **Triggers:**
  - a job exits `done` (0), meaning the server is reachable again; at most once per
    `FAILED_REQUEUE_MIN_GAP_MS` = 60000;
  - a periodic timer every `FAILED_REQUEUE_INTERVAL_MS` = 1800000 (30 min) while the role is held
    (unref'd).
- **Eligible `failedReason`:** `over-age`, `max-attempts`, `uploader-crash` only
  (`isRequeueableFailure(reason)`). Never re-queued: `invalid-json` / schema-invalid,
  `upload-rejected` (4xx), `uploader-not-allowed`, `uploader-too-old`, `uploader-version-unknown`.
  Without that filter a 4xx job would loop forever.
- **Action per `telemetryDir`:**
  - if the queue already holds a job of that `telemetryDir`, skip it; that job's `done` full scan
    already cleans `failed/` (DD-9);
  - otherwise build **one** new `stop` job from the newest eligible record: fresh DD-3 name and
    `createdAt`, `attempts: 0`, `nextAttemptAt: null`, `lastError: null`, `requeuedFrom: [<names>]`,
    `requeueCount: max(record.requeueCount) + 1`. It is a `stop` job, so it runs a full scan that
    covers every session of the repo, even when the failed record was a `session-end` job;
  - before writing, it must pass the receiver's pre-spawn validation (`validateQueueJob`) and have
    an `uploaderContract` in `SUPPORTED_UPLOAD_CONTRACTS`; otherwise it stays in `failed/`;
  - write it atomically (`0o600`), then delete the grouped `failed/` records;
  - log `receiverLog('job-requeued', '<new name> from <n> failed (<reasons>)')`.
- No cap on `requeueCount`, because data safety wins. An offline cycle is cheap (3 s connect
  timeout per attempt). `requeueCount` is only for diagnostics.
- The hook side is unchanged. The `upload-jobs-failed` recommendation disappears through the
  existing `done` full-scan cleanup.
- New receiver twin: `buildJobName` (DD-3) next to `parseJobName`. It is pinned by the
  `upload-job-queue` algorithm rows on both exports. `isRequeueableFailure` lives in the receiver
  only.

## Items (Chunk 16)

- [ ] `otel-receiver.js`: constants above, `isRequeueableFailure`, twin `buildJobName`,
      `requeueFailedJobs(now)`, both triggers; export the new functions.
- [ ] Algorithm: rows in `docs/algorithm-examples/upload-job-queue.json` for
      `isRequeueableFailure` and the `buildJobName` twin; doc section in
      `docs/knowledgebase/algorithms/upload-job-queue.md`.
- [ ] Scenario `s-hook-07` new step ("after reboot"):
      - setup: a stale `uploader.lock`, `heartbeat.json` and `.claim` of a dead pid; `failed/` holds
        a `max-attempts` job of repo X and an `upload-rejected` job of repo Z; queue holds a job of
        repo Y; the fake Log Hub is reachable;
      - expected: the receiver takes the role and runs Y (`done`); then X is re-queued as one `stop`
        job and uploaded, and X's `failed/` record is gone; Z stays in `failed/`.
- [ ] Docs: `upload-job-queue.md` (re-queue rules), `otel-receiver.md`, `hook/README.md`
      troubleshooting ("jobs in `failed/` retry automatically once the server is reachable").
- [ ] Dogfood refresh + `npm run build:hooks-installer`, then `adlc-lh:check-health` `finalRun: true`.
