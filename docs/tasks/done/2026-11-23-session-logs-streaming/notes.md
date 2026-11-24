---
type: "Note"
title: "Session logs streaming: evidence and analysis notes"
description: "Measurements, root-cause analysis and background evidence behind the requirements of 2026-11-23-session-logs-streaming."
---

# Session logs streaming: notes

## 2026-11-23 — evidence moved from requirements.md

### Raw idea and the user's words

Raw idea (from the 2026-11-23 analysis session):

> Session logs endpoint (`GET /api/v1/repositories/:repoId/sessions/:sessionId/logs`) is slow and
> memory-hungry on weak machines. Goals: 1) store logs pre-compressed (gzip bytea next to jsonb,
> written asynchronously at ingest) so serving needs no jsonb->text conversion and no compression
> per request; 2) deliver the session in several compressed parts (main log, then subagents in
> batches) instead of one 42 MB blob, with a UI progress indicator "loading session logs 3 of 20";
> 3) stream row by row with backpressure so server memory per request is bounded and does not grow
> with session size. Keep backward compatibility with old clients/hooks.

The user's words on the three goals: "храним пре сжатый текст, это увеличит нагрузку при записи но
она все равно асинхронная"; "отдаем частями … в несколько сжатых частей и можно индикатор прогресса
показывать на UI — читаю логи сессий 3 из 20"; "отдача по строкам важна т.к. при большой нагрузке
память станет проблемой. надо чтобы размер сессии не требовал больше и больше памяти от машины".

On priority: "самое важное это память — если подождать чуть-чуть больше не так страшно, то вот если
сервер падает то это катастрофа".

### Measured on the weak-environment stand (Pi, 10.1.1.120)

The Pi stand deliberately simulates a weak network and a weak / loaded machine (Pi 3B, 1 GB RAM,
CPU throttled to 600 MHz, app `mem_limit 448m` with a cluster primary + 3 workers, Wi-Fi ~19 Mbit/s).
Session `c0d1de05-ef41-4e94-bd6a-1b76af75d66e` (repo 77, a live session with 45 subagents):

| Measure | Value |
|---|---|
| `/logs` response | 42 MB uncompressed JSON (gzip would be ~10 MB; no response compression today) |
| of which subagent logs | 34.5 MB (83 %), 45 subagents; main transcript 6.3 MB; harness snapshot 0.3 MB |
| `/logs` in the browser | ~29.6 s; every other request of the page 0.1–2 s |
| server time to first byte | 15–23 s (varies with background load) |
| transfer | ~18 s — the stand's link tops out at ~2.3 MB/s (static 1.5 MB bundle measured at the same rate) |
| Postgres `body::text` of the 45 subagent `jsonb` bodies (35 MB) | 2.7 s; the same text read from a `text` column: 1.35 s |
| server memory | one request grew a worker to ~294 MB anon RSS; the memory cgroup OOM-killed it (`worker slot 2 exited (signal=SIGKILL)`) |

### Where the time and memory go today

`getSessionLogs` in `server/src/logs/repositories.controller.ts`:

- selects `body::text` of the `artisyn` + `claude` rows, then every descendant `claude-subagent`
  body in one query — Postgres converts each `jsonb` value to text on every request;
- `JSON.parse`s the whole claude body only to run `extractWorkflows`;
- builds `subagentJson` (one 35 MB string) and then the whole response as one string passed to
  `res.end()` — several 10+ MB copies alive at once, so peak memory grows linearly with session size;
- sends no `Content-Encoding`, so every byte crosses the network uncompressed.

On top of that the client (`useRepositoryData`) silently refetches the whole `/logs` every time the
selected session's end-time watermark moves — i.e. after each hook upload of a live session — so an
open live session re-pulls the full 42 MB every 20–40 s (see `docs/knowledgebase/session-map.md`,
"Watermark suspension").

### Ingest skip: state today (FR-5)

Nothing skips ingest work today: the hook dedups only by file size, and the current session's
`artisyn` file is never manifested, so it is re-sent on every `Stop`; the server's upsert in
`logs.service.ts` (`excluded.body`) rewrites `body` unconditionally and, for `claude` /
`claude-subagent`, re-extracts `session_stats` from the whole transcript every time.

### Why FR-6 (not FR-5 / FR-7) relieves a live session

The analysis found the live transcript really changes between consecutive uploads
(5053 → 5296 → 5330 KB in ~2 minutes), so the FR-5 / FR-7 skips help only with duplicate uploads,
not with live-session load.

### Deleted sessions: state today (FR-7a)

A soft-deleted session keeps its `sessions` row with `deleted = true`, and `LogsService.upsert`
rejects later uploads of that session id (`logs.service.ts:296-308`, also zip import at :978). Only
those two paths check `sessions.deleted`, and only for the upload's own session id: a subagent
uploaded after the Delete creates a normal, non-deleted row under the deleted root, and whether the
OTEL ingest checks it is unverified. A session purged by retention has no `sessions` row left, so a
later upload of a grown transcript re-creates it.

### Why whole-transcript re-processing exists

The hook sends the whole file (dedup only by file size in `.claude-logs.sent`), and the server
replaces `logs.body` on each upload because nothing guarantees the new file is a longer version of
the old one (`docs/knowledgebase/db-tables.md`, "logs"). That keeps ingest idempotent and
self-healing (a lost, retried or out-of-order upload converges on the latest file) and keeps cost,
tool usage, budgets and the live view current while the session runs. Old hooks will keep sending
whole files for a long time, so the server must accept them regardless.

## 2026-11-23 — plan-deep PoC

- PoC [docs/pocs/2026-11-23-1753-logs-body-trigger-gzip/](../../../pocs/2026-11-23-1753-logs-body-trigger-gzip/README.md): the `BEFORE INSERT OR UPDATE OF body` guard trigger bumps a monotonic (gapped) revision on every body write incl. upsert, clears the hash when a writer does not supply one, and does not fire on a gz-only update; gzip-6 compresses real bodies 3.6-4.3x at about 12 ms/MB on a dev CPU.

## 2026-11-23 — perf run (chunk 16)

`npm run perf` from `server/` against the dev server (`npm run start:dev`, port 3000) on the
developer machine, defaults from `perf-tests/constants.json` (500 iterations, 5 parallel; heavy
scenarios 20 iterations). "Before" is the last run before this task's code on the same machine,
`tmp/perftests/results_2026-11-21_19-24-49.json`; "after" is
`tmp/perftests/results_2026-11-23_16-16-52.json` (the tool's own Δ column compares against the
older stored `baseline.json` of 2026-11-03).

| Scenario | p95 before | p95 after | Δ p95 | mean before → after | p50 before → after |
|---|---|---|---|---|---|
| `repos:session-logs-heavy` | 39.17 ms | 48.17 ms | +23 % | 33.41 → 29.70 ms | 32.60 → 31.39 ms |
| `repos:session-log-parts-heavy` (new) | — | 9.92 ms | new | 9.16 ms | 8.80 ms |
| `repos:session-log-part-claude-heavy` (new) | — | 32.32 ms | new | 27.70 ms | 26.28 ms |
| `logs:v2-small` | 8.44 ms | 46.90 ms | +456 % | 6.56 → 13.02 ms | 6.27 → 9.94 ms |

The light (non-heavy) session-read scenarios ran in neither file: the harness seeds no regular
session id on this machine, so only the `-heavy` variants of the session routes are measured.

Reading:
- `repos:session-logs-heavy`: the p95 of 20 samples is the second-largest sample; mean and p50
  went down and the max is flat (46.51 → 49.49 ms). Against the stored baseline the tool
  reports −52.6 ms p95 (FASTER). Within noise, but formally above the 20 % line — flagged for
  the user.
- The new routes have no "before". The viewer now opens the manifest (≈10 ms) plus the root
  parts in parallel instead of one `/logs` of the whole tree.
- `logs:v2-small` is background contention, not the request path: re-measured right after the
  run on the idle server (300 sequential `POST /api/v2/logs`, 5-line body,
  one session id, a throwaway script) it is p50 5.87 ms, p95 7.53 ms, mean 6.09 ms — the 2026-11-21
  level. During the perf run every ingest also wakes the gzip builder (`LogBodyGzService`) and
  the queue worker processes the 600 uploads the write scenarios just queued.
- At cleanup the harness reported `queue not drained in 120000 ms — dropped 734 pending
  uploads`: the upload-queue tick now passes `RebuildGovernor.admit()`, which slows it while
  the perf load keeps the CPU busy. Expected under DD-15, but worth a look on the Pi stand.
- Other scenarios over 20 % p95 are millisecond-scale reads with n = 20 (`repos:get-heavy`
  2.41 → 7.55 ms with one 68 ms outlier, `repos:sessions-ids-heavy`, `repos:branches-heavy`)
  or `health` (1.25 → 2.88 ms): the same background load, no code change on those paths.

## 2026-11-23 — perf re-run (chunk 19, plan-check gap)

The chunk 16 run was taken right after other work had left the queue and the gzip builder busy,
so it was re-run on a freshly started dev server (`npm run start:dev`, nothing else running), same
defaults. The "before" is still the 2026-11-21 run: there is no pre-change build to run now
without changing the working tree, and the 2026-11-21 file is the last run on the same machine
and the same data shape before this task's code.

Run 1: `tmp/perftests/results_2026-11-23_17-04-25.json` (log `tmp/c19-perf-run1.log`), governor
at its defaults.

| Scenario | p95 before | p95 now | Δ p95 | mean before → now | p50 before → now |
|---|---|---|---|---|---|
| `repos:session-logs-heavy` | 39.17 ms | 26.10 ms | −33 % | 33.41 → 17.07 ms | 32.60 → 19.05 ms |
| `repos:session-log-parts-heavy` (new) | — | 9.23 ms | new | 8.13 ms | 7.82 ms |
| `repos:session-log-part-claude-heavy` (new) | — | 22.54 ms | new | 18.20 ms | 17.69 ms |
| `logs:v2-small` | 8.44 ms | 8.60 ms | +2 % | 6.56 → 6.77 ms | 6.27 → 6.44 ms |

All four are within the 20 % line; the chunk 16 `+23 %` / `+456 %` were background contention, as
suspected. In the whole run only three scenarios are formally above +20 % p95, all on paths this
task does not touch and all with flat p50: `repos:branches-heavy` 5.07 → 6.19 ms (n = 20, p50
+7 %), `repos:sessions-ids` 15.26 → 19.14 ms (p50 +4 %), `api-keys:list` 15.60 → 18.74 ms
(+20.1 %, p50 +2 %). The tool's own budget report passes every budgeted scenario.

Queue drop at cleanup (`dropped 692 pending uploads` in run 1): to check whether the governor
causes it, run 2 restarted the server with `REBUILD_SLOWDOWN_CPU_PERCENT=100
REBUILD_PAUSE_CPU_PERCENT=100` (governor never slows) —
`tmp/perftests/results_2026-11-23_17-08-56.json`, log `tmp/c19-perf-run2-nogov.log`. It dropped
690 — the same. So the governor is not the cause. The drop is older than this task: the harness
seeds about 2 500 uploads in its write scenarios and gives the worker 120 s, and earlier runs on
this machine dropped 343 (2026-11-03), 248 (2026-11-21 baseline) and 530 / 187 (2026-11-21, other
tasks). It is a harness limit, not a regression. With the governor off, the small heavy reads got
noisier (`repos:summary-heavy` p95 2.33 → 10.72 ms, `repos:branches-heavy` +50 %), because the
background drains were no longer held back under load — which is what the governor is for.
`repos:session-logs-heavy` was again 26.66 ms p95 and `logs:v2-small` 8.76 ms.

## 2026-11-23 — final full run

The full set (`adlc-lh:check-health` with `finalRun: true`: fast set plus `contract`,
`scenarios-a..d`, `e2e-fast`, `e2e-full`) is run once by the implement-deep orchestrator as its
final verification after chunk 19; chunk agents may not run final-only checks. Its result is
recorded by that step.

## 2026-11-23 — final verification and Pi stand

Final verification (`adlc-lh:check-health`, `finalRun: true`): 24/24 checks pass (fast set,
`contract`, `scenarios-a..d`, `e2e-fast`, `e2e-full`, Work Hub). The first run failed once in
`@S-NAV-01` (Summary stuck on its skeleton: the browser processed the manifest response ~10 s late,
so no part was requested). Fixed in `useSessionLogParts.ts`: `useQueries` no longer uses `combine`,
whose result TanStack runs through `replaceEqualDeep`, deep-walking every loaded log body on each
state change of any part. `scenarios-a` budget raised to 1200 s (runs take ~17 min).

Pi stand (Pi 3B, 1 GB, Wi-Fi), working-tree image, session `c0d1de05` (repo 77, 47 parts):

| Criterion | Limit | Before (old build) | Right after deploy (no gzip copies yet, drains busy) | After the gzip drain |
|---|---|---|---|---|
| worker OOM-killed | none | yes (SIGKILL, ~294 MB anon RSS) | none | none |
| app container memory (3 workers) | — | — | 254 → peak 358 MiB / 448 | 215 → peak 328 MiB / 448 |
| manifest | — | — | 11.8 s | 1.1 s |
| root parts loaded (Logs tab can render) | ≤ 10 s | — | 42.7 s | 3.8 s |
| all 47 parts | — | — | 136 s | 13.0 s |
| bytes for all parts | ≤ 12 MB | — | 41.0 MB (identity) | 10.3 MB (47/47 gzip) |

- Largest single log row text: 5.56 MB, so the per-worker RSS limit is about 81 MB. Only the whole
  container was sampled (`docker stats`), not each worker: +113 MiB over three workers while the
  background drains were also running.
- The gzip drain built all 306 copies in about 4 minutes. The workflows backfill was still slow
  (246 of 255 sessions pending ~10 minutes after the deploy, CPU-governed on a loaded Pi); `c0d1de05`
  itself was already backfilled.
- Not measured on the Pi: the burst-coalescing criterion (five uploads → one processed row plus
  `superseded`). It is covered by `@S-INGEST-02` on the scenario stand.

## 2026-11-24 — Session Map moved to the log parts

A tab-by-tab check of session `9fc6b5cc` (64 parts) on the Pi found the Session Map took ~42 s: its
first `/logs/delta` answer was the whole tree as one uncompressed document (55 MB, server TTFB
~11 s because `readSliceMeta` de-toasts every body). The plan had only streamed the delta route.

- The Map now builds its state from the parts (`buildSessionMapState`, algorithm doc
  `session-map-state.md`, which replaces `session-map-delta-merge.md`), rendered behind
  `AllSessionPartsGate` with the new `keepOnceLoaded` so a live session's new agent does not
  unmount the tab.
- The parts manifest gained `liveness` and `serverTime` (additive; an older server's manifest
  reads as not live). While live, the Map's manifest observer refetches every
  `SESSION_MAP_POLL_MS`; changed parts follow by `rev`.
- `/logs/delta` stays, unchanged, for a cached older SPA; the client no longer calls it.
  `suspendSilentLogsRefetch` and the Map's own Refresh routing are gone.
- Other tabs on the same session: OTEL ~11 s (9.2 MB uncompressed `spans`) is pre-existing and
  out of scope; the rest 4–12 s.
