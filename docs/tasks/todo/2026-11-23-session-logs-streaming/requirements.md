---
type: "Task"
title: "Session Logs: Pre-Compressed Storage, Delivery in Parts, Bounded Memory"
description: "Make opening a large session cheap on weak machines: store logs pre-compressed at ingest, deliver the session in several compressed parts with a UI progress indicator, and stream row by row so server memory does not grow with session size; skip unchanged uploads and defer rebuilds under load."
---

# 2026-11-23: Session Logs: Pre-Compressed Storage, Delivery in Parts, Bounded Memory

**Status:** todo
**Priority:** high
**Type:** feature
**Module(s):** server | client | hook
**Owner:** denis.tsyplakov
**Created:** 2026-11-23
**Tracker:** GH-166 https://github.com/DataArt/artisyn-log-hub/issues/166

## Description

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

### Priority between the goals

**Memory first (FR-3).** The user's call: "самое важное это память — если подождать чуть-чуть
больше не так страшно, то вот если сервер падает то это катастрофа". A slower page is acceptable; a
worker killed by OOM is not (it drops every request on that worker, including hook uploads). FR-3
ships first and on its own if needed; FR-1 / FR-2 / FR-4 are speed improvements on top of it and
must never raise peak memory per request.

## Functional Requirements

**FR-1 — Pre-compressed log storage.**
- Every `logs` row that `/logs` serves (`artisyn`, `claude`, `claude-subagent`) also gets its body
  stored as gzip-compressed UTF-8 JSON text (e.g. a `bytea` column) next to the existing `jsonb`
  `body`, which stays for server-side queries.
- The compressed form is written whenever `body` is written (hook upload upsert, zip import, heal /
  recompute paths), asynchronously from the request that delivered the log, so ingest latency for
  the hook does not grow.
- Existing rows are backfilled in the background; until a row has its compressed form, serving falls
  back to the `jsonb` path for that row.
- The compressed form can never go stale relative to `body`: a reader must be able to tell whether
  it matches the current `body` (e.g. by a version / `updated_at` marker), and use the fallback
  otherwise.

**FR-2 — Delivery in several compressed parts.**
- The session view loads a session as several parts instead of one blob. **A part is the
  compressed log of one session node, without its subagents** (decided 2026-11-23): the root
  session's log (artisyn + claude) plus metadata is the first part, then each subagent's own log
  is one part.
- **One HTTP request per part** (decided 2026-11-23) — no multi-member gzip in one response.
- **Subagent parts load only when needed (decided 2026-11-23):** opening a session loads the root
  part only; a subagent's part is fetched when a view needs it (the subagent is expanded / opened,
  or a tab that needs every subagent's log is opened — then with the "N of M" progress). Tree-wide
  figures the session header shows on open (cost, tokens, code impact) must come from server-side
  metadata (`subagentStats` / `rootStats` already exist), not from loading every subagent log.
- Each part is sent as the stored gzip bytes with `Content-Encoding: gzip` (or an equivalent that
  needs no per-request compression on the server).
- The UI shows a progress indicator while parts load, e.g. "Loading session logs 3 of 20", and
  renders the main log as soon as it arrives where the view can work without the remaining parts.
- The existing single `/logs` response keeps working for old clients (same shape), so a client
  older than this change still opens sessions.

**FR-3 — Bounded server memory per request (top priority).**
- The server reads log bodies row by row (cursor / streamed query) and writes each to the response
  with backpressure (`res.write` + wait for `drain`), never holding all bodies or the whole response
  in memory.
- Peak memory of one request is bounded by the largest single log row plus a constant, not by the
  session size.
- Several concurrent opens of large sessions must not add up to an OOM either: bound the number of
  large-log responses a worker serves at once (queue the rest — waiting is acceptable, crashing is
  not).
- All access checks and the small metadata queries (stats, attribution, advisor, harness snapshot)
  run before the first byte is written, so an error can still be answered with a proper status.
- The per-request `JSON.parse` of the whole claude body (for `extractWorkflows`) is removed — the
  workflows are computed at ingest and stored, or computed on the client.

**FR-4 — No full re-download of a live session.**
- While a live session is open, a hook upload must not make the client re-pull every part: only the
  parts whose log changed are refetched (the stored form's version / `updated_at` tells which).

**FR-5 — Skip ingest work when a log did not change.**
- Today nothing skips it: the hook dedups only by file size, and the current session's `artisyn`
  file is never manifested, so it is re-sent on every `Stop`; the server's upsert in
  `logs.service.ts` (`excluded.body`) rewrites `body` unconditionally and, for `claude` /
  `claude-subagent`, re-extracts `session_stats` from the whole transcript every time.
- The server stores a content hash of each log body and, when an upload's body hashes the same as
  the stored one, skips the rewrite, the stats extraction and every rebuild it would trigger (only
  bookkeeping such as "last seen" may be touched).
- Exact skip conditions and what must always bypass the skip are defined in
  `send-recompute-analysis.md` §4.2. In short: hash the raw body before parsing, but always run the
  ownership / lock / session-update steps first; skip the rest only when the body hash, an ingest
  version constant, the uploading user and — for transcripts — the revision of the tree's
  `artisyn` log all match (claude stats depend on `artisyn` edit records, §3); write the hash in the
  same statement as `body` and clear it by a DB trigger whenever `body` changes without it (zip
  import, server downgrade); never hash-skip `artisyn` in the first phase. Recompute paths and
  extractor-version bumps work from stored bodies and are never blocked by the skip.
- Works for old hooks unchanged — the check is server-side only.
- A content hash, not the size: equal size does not prove equal content (e.g. the hook's injected
  `artisyn` status lines can change without changing length), and a wrong skip silently loses data
  until the next change. Size may serve as a fast pre-check (different size → changed, no hash
  needed); equal size must still be confirmed by the hash. Hashing a few MB is milliseconds next
  to the full re-extraction it saves.

**FR-6 — Lower priority for derived-data rebuilds under load, with a guaranteed final rebuild.**
- Rebuilds of derived per-session data after an upload (session stats, tool usage, OTEL projection
  / reclassification, OKF access, the pre-compressed body of FR-1) stay **full rebuilds from the
  whole stored log** — no incremental computation (decided 2026-11-23: incremental processing is
  too easy to get subtly wrong).
- When the machine is under load, they are coalesced per session instead of run after every
  upload: later uploads of the same session replace the pending one, so a burst of N uploads costs
  one rebuild of the latest version.
- **Gradual slowdown, not a cut-off (decided 2026-11-23):** the rebuild rate is reduced smoothly as
  CPU load grows, starting from a configurable threshold (default ~60 % CPU — an empirical number
  to tune on the Pi stand); rebuilds are never forbidden, only slowed. How exactly to measure the
  load and shape the curve is for the plan.
- **What is never slowed (decided 2026-11-23):** only what feeds realtime views (the Live view /
  realtime OTEL path) is processed without slowdown. Everything else may lag, and the UI contract
  says so: where derived data may be behind, the UI tells the user it can take a couple of minutes
  more.
- **Hard cap (decided 2026-11-23):** if a rebuild has been deferred because CPU load stayed at
  99 %+ for more than 5 minutes, stop waiting and run the deferred rebuilds anyway — under such load
  the machine will never get idle on its own. Threshold (99 %) and duration (5 min) are config
  variables (env), like the ~60 % slowdown threshold.
- A deferred rebuild is never dropped, so the data always converges on the latest upload (see the
  hard cap below).
- With no load the behaviour is as today (rebuild right after the upload), so a lightly loaded
  instance keeps a near-realtime live view.
- User requests (opening sessions, lists) take priority over these rebuilds; slower updates of a
  live session under load are acceptable.
- This is the requirement that actually relieves a live session: the analysis found the live
  transcript really changes between consecutive uploads (5053 → 5296 → 5330 KB in ~2 minutes), so
  FR-5 / FR-7 skips help only with duplicate uploads, not with live-session load.

**FR-7 — Hook does not send unchanged logs, and recovers when the server lost them.**
- Base rules in `send-recompute-analysis.md` §4.1, narrowed by the user's decisions of 2026-11-23
  (below). The current session's `artisyn` is never skipped. `.claude-logs.sent` stays as is for
  old hooks; a separate v2 manifest stores per file size, mtime and the upload parameters.
- **Skip rule (decided):** a transcript is skipped when its size **and** mtime both equal the
  manifest entry (and the upload parameters are unchanged). No content hashing of already-sent
  files on every `Stop`. A different size or mtime means "send".
- `.claude-logs.pending` stores a content hash so a chunked upload resumes only onto identical
  content (FR-8).
- **No history recovery (decided):** a server switch (new URL, reset or restored DB) or data lost
  on the server is not something the hook repairs — the new server gets sessions from that point
  on, history is not re-sent. So no server identity in the manifest, no `verify` route and no
  periodic verify sweep; `send-recompute-analysis.md` §4.1 recovery parts (H6, S2, S18) are dropped.
- Backward compatibility both ways per the matrix in §5 (old/new hook × old/new server).

**FR-7a — A deleted session stays deleted (decided).**
- A session deleted by its user (UI Delete = soft delete) already stays deleted: the `sessions`
  row keeps `deleted = true` and `LogsService.upsert` rejects later uploads of that session id
  (`logs.service.ts:296-308`, also zip import at :978). This task must keep that behaviour.
- A session purged by **retention** has no `sessions` row left, so today a later upload of a
  grown transcript re-creates it. Decided: it must not be re-created (e.g. by checking
  `deleted_session_log`).
- **Everything that flows into a deleted session is silently ignored (decided 2026-11-23).** Not
  only uploads with the deleted session's own id: also logs of its subagents at any depth that
  arrive after the Delete (late uploads, or new subagents of a resumed session), OTEL chunks and
  realtime OTEL for it, `tool-calls`, snapshots and any other ingest path. Today only
  `LogsService.upsert` and zip import check `sessions.deleted` for the upload's own session id; a
  subagent uploaded after the Delete creates a normal, non-deleted row under the deleted root, and
  whether the OTEL ingest checks it is unverified. The plan must enumerate every ingest path and
  close each one (a scenario step per path).
- Data that stays after a soft delete today (`logs_otel`, `otel_api_calls`,
  `session_changed_paths`, `session_harness_usage`, `session_tool_stats`, attribution tables — see
  `docs/knowledgebase/db-tables.md` "Soft delete") must not be shown anywhere; the plan checks
  whether any read path can still surface it and either purges it on Delete or filters it out.
- **Account or repository deletion is a fresh start (decided 2026-11-23):** after the account /
  repository is deleted and added again, uploads are accepted as if nothing had existed before —
  the "stays deleted" check above must not block them (its records for that account / repository
  are cleared, or the check ignores them).
- The server answers such an upload with a success-class status that tells the hook not to retry
  (an old hook must not loop on it), and the hook may mark the file as sent.

**FR-8 — Close the data-loss gaps that exist today** (found by the analysis, §2; a skip would make
them permanent instead of healing on the next upload, so they are fixed together with FR-5 / FR-7):
- ~~the manifest does not know which server the files went to~~ — not fixed by decision (FR-7: no
  history recovery after a server switch / reset);
- a 2xx only means "staged": a later processing failure is never re-sent — handle it within the
  upload response / retry path, without a verify sweep;
- a chunked upload resume checks only `totalSize` (`hook/…/upload-logs.js:885-891`) and the server
  never verifies the reassembled content — a changed file of the same length is spliced onto old
  chunks;
- two workers or a deadlock retry can process an older upload after a newer one and overwrite the
  newer body — a "newer upload wins" guard is needed (for `artisyn` the older upload must still
  store its harness / OKF snapshot and code-inventory lines);
- an `artisyn` upload never re-extracts claude stats that depend on its edit records (S12) — **fix
  it (decided 2026-11-23)**: when the tree's `artisyn` edit records change, the dependent claude /
  subagent stats are re-extracted in the background (a full re-extraction from the stored bodies,
  through the same FR-6 rebuild path);
- `tool-calls` change detection by a sum of file sizes can miss changes; a subagent's `.meta.json`
  arriving later never corrects its parent;
- zip import does not re-extract subagent stats.

## Non-Functional Requirements

- Backward compatibility (CLAUDE.md "Hook API", "Compatability"): the hook upload API and payload do
  not change; old hooks keep sending whole files. The current `/logs` response shape stays valid for
  old clients.
- The DB migration is additive (new column(s)), never rewrites or drops `body`; see the
  `migrations-data-integrity` skill.
- Offline first: nothing new depends on network access.
- Ingest-side cost: compressing at write time must not slow the hook-facing request; measure the
  added CPU on the Pi stand under a live session.

## Acceptance Criteria

- [ ] FR-1: after a hook upload, the session's `artisyn`, `claude` and `claude-subagent` rows have a
      compressed body that decompresses to exactly `body::text`; rows written before the change get
      it from the backfill; a row without it (or with a stale one) is still served correctly.
- [ ] FR-2: opening session `c0d1de05` on the Pi stand shows a "Loading session logs N of M" style
      indicator, the main log renders before the subagents finish, and the transferred bytes are
      the compressed size (≈ 10 MB or less in total, not 42 MB).
- [ ] FR-2: a client built before this change opens the same session through the old `/logs`
      response unchanged.
- [ ] FR-3: on the Pi stand, opening session `c0d1de05` does not OOM-kill a worker, and the worker's
      peak RSS growth during the request stays within a bound set by the largest single log row
      (record before/after numbers in the task notes).
- [ ] FR-3: an access error or a missing session still returns a proper 4xx status, not a truncated
      200.
- [ ] FR-4: with a live session open, one hook upload refetches only the changed parts (checked in
      the browser network log).
- [ ] FR-5: re-uploading a byte-identical log leaves `logs.updated_at`, `session_stats` and the
      derived tables untouched and triggers no rebuild (checked in the app log); a changed log is
      processed as before.
- [ ] FR-6: with a live session on the loaded Pi stand, several uploads in a row produce one
      coalesced rebuild, not one per upload; after the uploads stop, the derived data reflects the
      last upload within the configured maximum delay, also while load stays high.
- [ ] FR-6: on an idle instance a single upload is rebuilt right away, as today.
- [ ] FR-7: a new hook does not re-send a transcript whose size and mtime are unchanged; a changed
      size or mtime is sent; the current session's `artisyn` is sent every time; against an old
      server it behaves as today.
- [ ] FR-7a: an upload for a deleted or retention-purged session does not re-create it, and an old
      hook does not retry it in a loop.
- [ ] FR-7a: after Delete of a session, a later upload of one of its subagents (new or late), its
      OTEL chunks / realtime OTEL and its `tool-calls` are accepted with a success status and
      written nowhere; nothing of the deleted session is visible in any UI view, analytics,
      export or MCP read.
- [ ] FR-8: each gap still listed under FR-8 has a scenario step that reproduces it before the fix
      and passes after it (same-length changed file on chunk resume, out-of-order uploads,
      processing failure after 2xx).
- [ ] Time to a usable session view for `c0d1de05` on the Pi stand drops well below today's ~30 s;
      before/after numbers recorded in the task notes.

## Open Questions

Decided 2026-11-23 (`send-recompute-analysis.md` §6): server switch / data lost on the server —
no history recovery (Q1, and with it Q4 OTEL recovery and Q6 verify cadence); deleted / purged
session stays deleted (Q2, FR-7a), but account / repository deletion is a fresh start; stat-only
skip on equal size + mtime is accepted (Q3); S12 is fixed (Q5, FR-8); one request per part, a part
= one session node's log, subagent parts loaded only when needed (FR-2); gradual rebuild slowdown
from ~60 % CPU, only realtime never slowed, hard cap 99 %+ for 5 min, all thresholds in config
(FR-6).

- Compression level and where it runs: gzip level 6 vs 9 at ingest, and whether it runs in the
  upload-queue worker or a separate background job.
- FR-6: the exact load signal and slowdown curve (thresholds are decided: slowdown from ~60 % CPU,
  hard cap at 99 %+ for 5 min) — for the plan.

## Notes

- Related: `2026-06-21-session-parse-indicator` (client-side *parsing* indicator after the fetch);
  this task's indicator covers the *loading* phase — keep the two consistent in the UI.
- Related, archived: `2026-10-31-session-list-slow-jsonb` (same family of `jsonb` cost on the list).
- Out of scope: incremental ingest (parsing only the appended tail of a transcript). Rejected on
  2026-11-23 — too many subtleties, too easy to silently lose a value. Whole-file replace plus full
  rebuilds stay; FR-5 and FR-6 only make them cheaper (skip unchanged, coalesce under load).
- **2026-11-23:** Why whole-transcript re-processing exists: the hook sends the whole file (dedup
  only by file size in `.claude-logs.sent`), and the server replaces `logs.body` on each upload
  because nothing guarantees the new file is a longer version of the old one
  (`docs/knowledgebase/db-tables.md`, "logs"). That keeps ingest idempotent and self-healing (a
  lost, retried or out-of-order upload converges on the latest file) and keeps cost, tool usage,
  budgets and the live view current while the session runs. Old hooks will keep sending whole files
  for a long time, so the server must accept them regardless.
