# 2026-11-18: Shared Receiver as the Single Log Uploader (Job Queue + Heartbeat)

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** hook
**Owner:** denis.tsyplakov
**Created:** 2026-11-18
**Tracker:** GH-153 https://github.com/DataArt/artisyn-log-hub/issues/153

## Description

Raw idea (as given):

> Hook: move log uploads into the per-user shared receiver (today's OTEL receiver) as a mandatory,
> single local uploader for all projects, with an on-disk job queue and a file heartbeat.

### Problem (found 2026-11-18 by morning-check + `hook.log` analysis, hook v2.32.3)

- `send-logs-hook.js` on `SessionEnd` waits for the per-repo upload lock for up to
  `LOCK_WAIT_SESSION_END_MS = 20000` (`hook/.claude/telemetry_tool/send-logs-hook.js:76`), but
  Claude Code kills `SessionEnd` hooks after 1500 ms and reports `SessionEnd hook [...] failed:
  Hook cancelled` (confirmed by the PoC, see Notes); in that day's `hook.log`, 4 of 20 `SessionEnd` runs were killed mid-way
  (per-session evidence in `notes.md`). A killed holder also leaves the lock behind until the
  dead-pid check (hook 2.32.3, `ca6f6fb`).
- Claude Code 2.1.327 now shows `SessionEnd` hook failures to the user on `/clear` and `/resume`
  (and `SubagentStop` failures in background agents), so this becomes user-visible. Scenario: two
  sessions in one project (or a post-turn-analysis `claude -p` session that just ended); session
  A's `Stop` holds the lock for 1–3 s; the user types `/clear` in session B; B's `SessionEnd` hook
  waits for the lock and is killed.
- `Stop` uploads synchronously too: "Uploading logs..." blocks every turn for up to
  `sendLogsTimeoutMs` (10 s default). On a slow network with a big log an upload can legitimately
  take 10 s or more.
- No data loss today: every completed `SessionEnd` flush had `total=0`, and the next `Stop` full
  scan picks up leftovers. The problem is UX (blocked turns, visible hook failures) and lock churn.

### Decision (user)

- Do **not** spawn a worker process per hook event. Make the existing per-user shared receiver
  (one per OS user since hook 2.30.0 — see `docs/knowledgebase/otel-receiver.md`; it already has
  the session → repo registry, HMAC hello/auth and per-repo uploads/realtime) the **single,
  non-optional uploader for all projects** of that user, fed by an on-disk queue of idempotent
  job files and a file heartbeat (FR-1 – FR-10). Raising the `SessionEnd` timeout is not an
  option: the env override is the user's, and a hook's `timeout` field does not apply to plugin
  hooks like Log Hub's.
- Everything ships in this one task, as one release: hook **3.0.0** (major) and Log Hub **1.5.0**.
- User settings are not touched: no user-level hooks or `~/.claude` settings are added; the
  receiver is started only from the repo hooks.
- Repo atomicity is kept: each repo's install stays self-contained — its jobs run with its own hook
  code and its own config, and installing, upgrading or removing the hook in one repo never
  changes another repo.

## Functional Requirements

- **FR-1 Job files.** The hook expresses an upload as a job: one JSON file per job in a per-user
  queue directory (under `~/.artisyn/`, next to the shared receiver's state). The file describes
  what to upload and where: repo root / telemetry dir, session id, trigger (`stop` /
  `session-end`), the namespaces/files or the scope to collect, the target server URL, hook
  version and creation time, the absolute path of the repo's own uploader (`send-logs-hook.js`),
  and every input the in-hook run reads: raw payload `cwd`, `gitRoot`, `transcriptPath`,
  `hookEvent` and the env keys the upload path uses (at least `CLAUDE_CONFIG_DIR` and the OTEL
  endpoint keys). It holds no secrets beyond what the repo config already holds; the API key is
  resolved from the repo config when the job runs.
- **FR-2 Job file names.** Names follow `<sessionId>_<timestamp>.json` (final grammar designed in
  the plan): long and informative, unique, sortable by creation time. A job is written atomically
  (temp file + rename), so the receiver never reads a half-written job.
- **FR-3 Idempotency.** Running a job twice, running two jobs for the same session, and resuming
  after a job was interrupted (idle-exit, version change, crash, reboot) are all safe and give
  the same server state. Relies on the server's idempotent upsert. A job is removed only after it
  has finished.
- **FR-4 Receiver as uploader.** The shared receiver picks up jobs from the queue and runs each by
  spawning the job's recorded uploader (validated with `isAllowedUploader`, as the OTEL sweep does
  today) in a new backward-compatible argv mode, e.g. `send-logs-hook.js --run-job <jobPath>`; the
  uploader takes the per-repo lock itself and reuses the existing upload code paths (scoped
  `SessionEnd` flush, full `Stop` scan, OTEL chunk upload). So each repo uploads with its own hook
  version, and a job whose uploader lacks the mode is never handed to it. The receiver only
  schedules, retries and deletes jobs. Retryable errors (network, timeout, 5xx, 429) are retried
  with backoff; a permanent error (other 4xx, unparsable job, unknown job schema version) or a job
  past a maximum age / attempt count (set in the plan) moves the job to `~/.artisyn/upload/failed/`,
  logs a `hook.log` line and is reported in `hook-status`. It never blocks its OTLP listener while
  uploading.
- **FR-5 Heartbeat.** The receiver writes a heartbeat file periodically (interval designed in the
  plan) carrying at least its pid, version, uploader capability/contract version and a
  timestamp.
- **FR-6 Hand-off in the hooks.** `Stop` and `SessionEnd` read the heartbeat. When it is fresh and
  advertises the uploader capability, they write a job and exit (target ~100 ms, always well under
  Claude Code's `SessionEnd` limit). Otherwise they fall back to the current in-hook upload. The
  `otel-status` write (`maybeWriteOtelStatus`) moves into the job run, inside the lock, before the
  upload; whatever of `maybeReArmOtelSession` stays in the hand-off path must fit the ≤ ~200 ms
  budget (exact split fixed in the plan).
- **FR-7 Fallback and stale jobs.** When the receiver is missing, cannot start (port conflict,
  antivirus) or its heartbeat is stale, the hook uploads in-process as today. A job older than a
  threshold (designed in the plan) is treated as stuck: only a `Stop` hook of the job's own repo
  takes it over, under the per-repo lock with the normal `Stop` wait, runs it and reports it via
  `hook-status`; a hook that finds the lock busy leaves it alone; `SessionEnd` never takes over a
  job. Whoever completes a job deletes its file; a job file already gone at delete time is not an
  error. In every fallback case (no receiver, stale heartbeat, receiver cannot start, old
  receiver) `SessionEnd` waits for the lock < 1 s; if it is busy it writes a job when the queue
  dir is usable, otherwise exits quietly with a `skipped` `hook.log` line, relying on the next
  `Stop` full scan.
- **FR-8 Shared lock with old hooks.** The per-repo upload lock remains the shared protocol: the
  job's uploader takes it before uploading a repo, so the receiver's jobs, old in-process hooks
  and the prompt-time upload (`prompt-upload-hook.js`, unchanged — it already skips when the lock
  is held) never upload the same repo at the same time. A lock held by another uploader means
  "busy, retry later", not a stuck job.
- **FR-9 Idle-exit and restart.** The receiver does not idle-exit (`SHARED_IDLE_TIMEOUT_MS`, 10
  min) while the queue holds retryable jobs. On start it drains leftover jobs. An older receiver that is
  still running (shared receivers are never restarted; newer code takes over after idle-exit)
  does not advertise the capability, so new hooks fall back until it is replaced.
- **FR-10 Non-optional process.** The receiver is started regardless of `otelEnabled`: phase 3
  removes the `otelEnabled` gate from receiver start in the repo hooks (`lifecycle-hook.js`,
  `otel-register.js`), and the installer always creates `~/.artisyn/otel/port.json` and `token`
  and copies the receiver to `bin/`. A legacy install with no `port.json` keeps uploading
  in-process with no hand-off. `otelEnabled` stays a per-repo rule: the receiver always runs the
  uploader and stores OTEL records only for sessions whose repo has `otelEnabled: true` (repos with
  it off register with all signals off; their records are dropped, no chunks written). The
  uploader does not depend on the OTLP port: a port conflict or blocked bind never stops job
  processing.
- **FR-11 Post-turn analysis ordering.** `post-turn-analysis-hook.js` is spawned on `Stop` after
  the upload today. Check whether it relies on the turn's data already being on the server, and
  keep it correct when `Stop` only queues a job; in particular, whether the
  `/api/v2/turn-end-cost-advisor` POST from `post-turn-analysis-worker.js` needs the session
  already uploaded.
- **FR-12 Phasing.** Implement in phases, each leaving the repo green; all of them ship together
  in hook 3.0.0 / Log Hub 1.5.0:
  (1) `SessionEnd` via the job queue, with fallback — fixes the visible failure;
  (2) `Stop` via the job queue, plus retries/backoff;
  (3) the receiver becomes mandatory, independent of `otelEnabled`.
- **FR-13 Versions.** The hook version becomes 3.0.0 and the Log Hub version (root `package.json`)
  1.5.0, with the usual release-note / changelog entries. The major hook bump does not relax
  backward compatibility: 2.x hooks in other repos keep working with the 3.0.0 receiver and server.
- **FR-14 Documentation.** Update every doc that describes the upload path or the receiver, in the
  same phase that changes the behaviour:
  - development KB: `docs/knowledgebase/otel-receiver.md` (receiver is now also the uploader: job
    queue, heartbeat, idle-exit rule, non-optional start), `docs/knowledgebase/hook-system-overview.md`
    (upload pipeline, lock, event wiring), `docs/knowledgebase/hook-installation.md` (receiver
    started regardless of `otelEnabled`, `~/.artisyn/` state layout), plus `index.md` descriptions
    if an article's scope changes, or a new KB article for the job queue if it outgrows
    `otel-receiver.md`;
  - shipped user docs (offline first): `hook/README.md`, `hook/INSTALL_HOOK.md` (what the
    background process is, where the queue and heartbeat live, how to check them when uploads
    stall), `user-docs/otel-architecture.md` and `user-docs/data-collection.md` where they describe
    when and how data leaves the machine; then `npm run build:help` regenerates the in-app help;
  - an algorithm doc + rows file under `docs/knowledgebase/algorithms/` / `docs/algorithm-examples/`
    only if the plan introduces a table-testable algorithm (e.g. job-name grammar, heartbeat
    staleness / hand-off decision).
- **FR-15 Diagrams.** Draw the new flow, in the docs' existing style (plain-text box diagrams as
  in `user-docs/otel-architecture.md`, readable offline and in the in-app help):
  - component diagram: hooks of several repos → job queue dir → shared receiver (uploader + OTLP
    listener) → Log Hub server, with the heartbeat file and the per-repo upload lock;
  - sequence diagram for `Stop` / `SessionEnd`: read heartbeat → write job → exit; receiver picks
    up the job → takes the lock → uploads → deletes the job;
  - fallback sequence: missing/stale heartbeat or stuck job → in-hook upload (old path), and an old
    hook coexisting with the new receiver on the same repo.
  The component diagram goes into the KB article and the user doc; the sequences into the KB.
- **FR-16 Warn on an unpatched / end-of-life Node.js (independent of the uploader work, ships in
  the same release).** The hook runs with the user's own `node`. Node.js 18 and 20 are
  end-of-life, and the November 2026 security release (7 high, incl. HTTP/2 and TLS) is fixed only
  in 22.23.5 / 24.22.3 / 26.13.1. Today this is only written in `hook/README.md` and
  `hook/INSTALL_HOOK.md` (commit `5da75b5`); nothing tells a user at runtime. Required:
  - the hook detects `process.versions.node` and classifies it against a table of minimum patched
    versions per supported release line shipped **inside the hook** (offline first: no download
    of the Node release schedule); a line below the oldest supported line, or an odd line at or
    below the newest known line (18, 20, 21, 23, …), is end-of-life; a known line below its patched
    minimum is unpatched; a line newer than the newest line in the table is unknown and gets no
    warning;
  - **explicit warning to the user** in Claude Code when the version is below the patched minimum
    or end-of-life: via the `SessionStart` `systemMessage` (same channel as the existing OTEL
    endpoint warning in `lifecycle-hook.js`; `SessionStart` builds one output object, joins both
    warnings into one `systemMessage` written once, and runs the Node check regardless of
    `otelEnabled`), naming the running version, why it matters and the
    target versions. Throttled so it is not shown on every session (e.g. once per day per user,
    state in `~/.artisyn/`); never blocks, never exits non-zero — the `>=18.19` technical floor
    stays (backward compatibility);
  - the installer prints the same warning at install / upgrade time;
  - the hook reports its Node version (field `nodeVersion`) in its `hook-status` / self-check data so the Log Hub UI can
    show who runs an unpatched Node (additive field; old servers ignore it); the UI view is a
    follow-up;
  - updating the table is part of the release checklist whenever a Node security release lands
    (the morning check's `security` step already watches Node advisories).
- **FR-17 Hook troubleshooting docs.** Add to the shipped hook docs (`hook/README.md` /
  `hook/INSTALL_HOOK.md` troubleshooting): run `/status` in Claude Code — since 2.1.327 it lists
  broken agent / skill / command / output-style files and hook matchers that never match. Document
  the FR-16 warning (what it means, how to upgrade Node) next to the existing Node.js requirement
  text.

## Non-Functional Requirements

- Backward compatibility (CLAUDE.md "Hook API" and "Compatability"): old hooks in other projects
  keep working unchanged; a new hook works with an old receiver (fallback) and with no receiver at
  all. No server API change is expected; if one becomes necessary it must be additive.
- `Stop` and `SessionEnd` hook wall time with a healthy receiver stays ≤ ~200 ms on every platform
  (Windows, macOS, Linux); hooks always exit 0 and print nothing on stdout/stderr in the hand-off
  path.
- Offline first: no new network dependency; the receiver uploads only to the configured Log Hub
  server.
- No secrets in job files or in the heartbeat file; queue and heartbeat files are created with
  user-only permissions where the OS supports it.
- Path handling is OS-agnostic (no developer-machine paths, see CLAUDE.md).

## Acceptance Criteria

- [ ] AC-1 (FR-1, FR-2): a `SessionEnd` with a healthy receiver creates exactly one job file named
      per the designed grammar in the queue directory, written atomically, with no API key inside.
- [ ] AC-2 (FR-3): running the same job twice, or two jobs for one session, leaves the server in
      the same state as one run; killing the receiver mid-job and restarting it completes the job.
- [ ] AC-3 (FR-4): the receiver uploads the job's files and deletes the job file only after
      success; a network error leads to a retry with backoff, not a lost job; a permanent error
      moves the job to `failed/` with a `hook.log` line and a `hook-status` report, and does not
      keep the receiver from idle-exiting. Two repos with different hook versions each upload with
      their own hook version, and a job run yields the same harness snapshot id as an in-hook run
      of the same session.
- [ ] AC-4 (FR-5): the heartbeat file is refreshed at the designed interval and carries pid,
      version, capability and timestamp.
- [ ] AC-5 (FR-6): with a healthy receiver, `SessionEnd` and (phase 2) `Stop` hooks finish within
      ~200 ms in `hook.log` timings; the "two sessions + `/clear`" scenario from the Description no
      longer gets the `SessionEnd` hook killed.
- [ ] AC-6 (FR-7): with no receiver, a stale heartbeat or a stuck job older than the threshold,
      the hook uploads in-process and the data reaches the server; a stuck job is reported via
      `hook-status`. The "two sessions + `/clear`" scenario also passes with no receiver and with
      an old receiver: `SessionEnd` with a busy lock exits in < 1 s with a `skipped` `hook.log`
      line, and the next `Stop` uploads the leftovers.
- [ ] AC-7 (FR-8): an old in-process hook (previous release), the prompt-time upload and the new
      receiver's jobs working on the same repo never upload concurrently (lock held by one of them
      at a time).
- [ ] AC-8 (FR-9): the receiver does not idle-exit with a non-empty queue and drains leftover jobs
      on start; with an old receiver running, new hooks fall back and nothing is lost.
- [ ] AC-9 (FR-10): one receiver serving two repos, one with `otelEnabled: true` and one with
      `false`, uploads jobs of both and stores OTEL records only for the first; with the OTEL port
      occupied, jobs are still uploaded.
- [ ] AC-10 (FR-11): post-turn analysis produces the same results as before with `Stop` queueing a
      job.
- [ ] AC-10a (FR-12): after phase 1 only, `SessionEnd` uses the queue while `Stop` still uploads
      in-process unchanged; each phase passes the full check set on its own.
- [ ] AC-10b (FR-13, Decision): the hook reports version 3.0.0 and Log Hub 1.5.0; a 2.32.x hook in
      another repo keeps uploading against the new receiver and server; installing the hook adds
      nothing to the user-level `~/.claude` settings, and installing or removing it in one repo
      leaves other repos' installs unchanged.
- [ ] AC-11 (tests, CLAUDE.md test policy): behaviour is covered by steps in existing hook
      scenarios in `tests/scenarios/` (grep first); algorithm rows are added only if an algorithm
      doc is touched (e.g. `otel-shared-routing`); no unit tests.
- [ ] AC-12 (FR-14): the KB articles, shipped hook docs and user docs listed in FR-14 describe the
      job queue, heartbeat, fallback and non-optional receiver; no doc still says `Stop` /
      `SessionEnd` upload in-process as the only path; `docs/knowledgebase/index.md` is updated;
      `npm run build:help` output is regenerated.
- [ ] AC-13 (FR-15): the component, hand-off sequence and fallback sequence diagrams exist in the
      places named in FR-15, match the implemented behaviour (file names, lock, heartbeat) and
      render as plain text (no online-only renderer).
- [ ] AC-14 (FR-16): on Node 18.x / 20.x, or 22 / 24 / 26 below 22.23.5 / 24.22.3 / 26.13.1, a new
      session shows a `systemMessage` warning naming the running and target versions; on a patched
      version nothing is shown; the warning appears at most once per throttle window; the hook
      still works and exits 0 on Node 18.19; the installer prints the same warning; a line newer
      than the table shows no warning; with the OTEL endpoint warning also due, `SessionStart`
      prints one valid JSON object with both in one `systemMessage`; the `hook-status` event
      carries `nodeVersion` and an old server accepts it unchanged.
- [ ] AC-15 (FR-16): the minimum-version table ships inside the hook (no network fetch), and the
      classification is covered by algorithm rows if an algorithm doc is added for it.
- [ ] AC-16 (FR-17): the hook docs mention `/status` for troubleshooting and explain the Node
      warning; in-app help is regenerated if user docs changed.

## Common sense considerations

- Queue and heartbeat live in a new per-user dir `~/.artisyn/upload/` (`queue/`, `heartbeat.json`),
  resolved per call from `os.homedir()` like `user-state.js`; `~/.artisyn/otel/` stays OTEL-only.
- The receiver keeps its file and process names (`otel-receiver.js`, `otel-ensure-receiver.js`);
  old hooks and the user-level `SessionStart` hook reference them. Docs call it "the shared
  receiver" and describe both roles.
- Job-name grammar (timestamp format, same-millisecond disambiguator), heartbeat interval,
  staleness and stuck-job thresholds are design details fixed in the plan.
- Pending `Stop` jobs of the same repo coalesce into one run (a `Stop` job is a full scan, so one
  run covers them all).
- The receiver re-reads the repo config when it runs a job; the job's server URL is informational.
- A job whose repo or telemetry dir no longer exists is dropped and logged to `hook.log`.
- The Node warning (FR-16) is shown at most once per day per OS user and again immediately when
  the running Node version changes.
- The hook reports its Node version in `hook-status` in this task (additive field); showing it in
  the Log Hub UI is a follow-up task.
- A job runs in the repo's own `send-logs-hook.js` (`--run-job`), never in the receiver's code copy.
- A job file carries every input the in-hook run reads (cwd, gitRoot, transcriptPath, hookEvent, env keys).
- `otel-status` is written by the job run; re-arm in the hand-off path must fit the ≤ ~200 ms budget.
- `prompt-upload-hook.js` stays unchanged; a lock held by it is "busy", not "stuck".
- ACs added for FR-12, the FR-7 `SessionEnd` rule and the FR-16 `nodeVersion` field.
- The uploader never depends on binding the OTLP port.
- `otelEnabled` is per repo: the receiver stores OTEL records only for repos with it on.
- Phase 3 drops the `otelEnabled` gate on receiver start and always creates `port.json`/`token`; no `port.json` → in-process upload.
- `SessionStart` writes one JSON object; OTEL and Node warnings share one `systemMessage`.
- Permanent upload errors and over-age jobs go to `~/.artisyn/upload/failed/`; only retryable jobs block idle-exit.
- Only `Stop` of the job's own repo takes over a stuck job, under the lock; a missing job file at delete is not an error.
- In every fallback case `SessionEnd` waits < 1 s for the lock, then queues a job or exits quietly.
- A Node line newer than the hook's table gets no warning.

## Open Questions


## Notes

<!-- Append timestamped notes here as work progresses -->
- 2026-11-18: `hook.log` evidence, the `SessionEnd` timeout PoC
  (`docs/pocs/2026-11-18-1712-sessionend-hook-timeout/`) and the FR-11 review finding are in `notes.md`.
- 2026-11-18: planning PoC `docs/pocs/2026-11-18-1933-upload-handoff-cost/` — the hand-off path
  costs ~46 ms p50 / 63 ms p95 (budget holds); a rename-based job claim is not exclusive on Windows,
  an exclusive-create (`wx`) claim file is. FR-11 needs no code change. Details:
  `research/handoff-design.md`.
