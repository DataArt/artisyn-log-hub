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

The session logs endpoint (`GET /api/v1/repositories/:repoId/sessions/:sessionId/logs`) is slow and
memory-hungry on weak machines. On the Pi stand (10.1.1.120, a deliberately weak / loaded machine)
session `c0d1de05-ef41-4e94-bd6a-1b76af75d66e` (repo 77, 45 subagents) returns 42 MB of uncompressed
JSON in ~30 s, and one request OOM-killed a worker. `getSessionLogs` converts every `jsonb` body to
text per request, parses the whole claude body for `extractWorkflows`, builds the whole response as
one string and sends it uncompressed; the client re-pulls the full `/logs` after every hook upload
of an open live session. Measurements and the full analysis are in `notes.md`.

Goals: store logs pre-compressed, deliver a session in compressed parts with a progress indicator,
stream row by row so memory does not grow with session size, and stop redundant ingest work —
keeping backward compatibility with old clients and hooks.

### Priority between the goals

**Memory first (FR-3).** A slower page is acceptable; a worker killed by OOM is not (it drops every
request on that worker, including hook uploads). FR-3 ships first; FR-1 / FR-2 / FR-4 are speed
improvements on top of it and must never raise peak memory per request.

## Functional Requirements

**FR-1 — Pre-compressed log storage.**
- Every `logs` row that `/logs` serves (`artisyn`, `claude`, `claude-subagent`) also gets its body
  stored as gzip-compressed UTF-8 JSON text (e.g. a `bytea` column) next to the existing `jsonb`
  `body`, which stays for server-side queries.
- The compressed form is written whenever `body` is written (hook upload upsert, zip import, heal /
  recompute paths), asynchronously from the request that delivered the log, so hook ingest latency
  does not grow.
- Existing rows are backfilled in the background; until a row has its compressed form, serving falls
  back to the `jsonb` path for that row.
- The compressed form can never go stale relative to `body`: a reader can tell whether it matches the
  current `body` (e.g. by a version / `updated_at` marker) and uses the fallback otherwise.

**FR-2 — Delivery in several compressed parts.**
- A part is the compressed log of one session node, without its subagents: the root session's log
  (artisyn + claude) plus metadata is the first part, then each subagent's own log is one part.
- One HTTP request per part — no multi-member gzip in one response.
- Opening a session loads the root part only; a subagent's part is fetched when a view needs it (the
  subagent is expanded / opened, or a tab that needs every subagent's log is opened — then with the
  "N of M" progress).
- Tree-wide figures the session header shows on open (cost, tokens, code impact) come from
  server-side metadata (`subagentStats` / `rootStats`), not from loading every subagent log.
- Each part is sent as the stored gzip bytes with `Content-Encoding: gzip` (or an equivalent that
  needs no per-request compression on the server).
- The UI shows a progress indicator while parts load, e.g. "Loading session logs 3 of 20", and
  renders the main log as soon as it arrives where the view can work without the remaining parts.
- The existing single `/logs` response keeps working for old clients with the same shape.

**FR-3 — Bounded server memory per request (top priority).**
- The server reads log bodies row by row (cursor / streamed query) and writes each to the response
  with backpressure (`res.write` + wait for `drain`), never holding all bodies or the whole response
  in memory.
- Peak memory of one request is bounded by the largest single log row plus a constant, not by the
  session size.
- The number of large-log responses a worker serves at once is bounded, so concurrent opens of large
  sessions cannot add up to an OOM; the rest queue (waiting is acceptable, crashing is not).
- All access checks and the small metadata queries (stats, attribution, advisor, harness snapshot)
  run before the first byte is written, so an error can still be answered with a proper status.
- The per-request `JSON.parse` of the whole claude body (for `extractWorkflows`) is removed — the
  workflows are computed at ingest and stored, or computed on the client.

**FR-4 — No full re-download of a live session.**
- While a live session is open, a hook upload makes the client refetch only the parts whose log
  changed (the stored form's version / `updated_at` tells which).

**FR-5 — Skip ingest work when a log did not change.**
- The server stores a content hash of each log body and, when an upload's body hashes the same as
  the stored one, skips the rewrite, the stats extraction and every rebuild it would trigger (only
  bookkeeping such as "last seen" may be touched).
- Exact skip conditions and what always bypasses the skip are defined in
  `send-recompute-analysis.md` §4.2. In short: hash the raw body before parsing, but always run the
  ownership / lock / session-update steps first; skip the rest only when the body hash, an ingest
  version constant, the uploading user and — for transcripts — the revision of the tree's `artisyn`
  log all match (claude stats depend on `artisyn` edit records, §3); write the hash in the same
  statement as `body` and clear it by a DB trigger whenever `body` changes without it (zip import,
  server downgrade); never hash-skip `artisyn` in the first phase. Recompute paths and
  extractor-version bumps work from stored bodies and are never blocked by the skip.
- Works for old hooks unchanged — the check is server-side only.
- The skip uses a content hash, not the size: equal size does not prove equal content (the hook's
  injected `artisyn` status lines can change without changing length), and a wrong skip silently
  loses data. Size may serve as a fast pre-check (different size → changed); equal size must still
  be confirmed by the hash.

**FR-6 — Lower priority for derived-data rebuilds under load, with a guaranteed final rebuild.**
- Rebuilds of derived per-session data after an upload (session stats, tool usage, OTEL projection
  / reclassification, OKF access, the pre-compressed body of FR-1) stay full rebuilds from the whole
  stored log — no incremental computation (too easy to get subtly wrong).
- Under load they are coalesced per session: later uploads of the same session replace the pending
  one, so a burst of N uploads costs one rebuild of the latest version.
- The rebuild rate is reduced smoothly as CPU load grows, starting from a configurable threshold
  (default ~60 % CPU, to tune on the Pi stand); rebuilds are only slowed, never forbidden. How to
  measure the load and shape the curve is for the plan.
- Only what feeds realtime views (the Live view / realtime OTEL path) is processed without slowdown;
  everything else may lag, and where derived data may be behind the UI tells the user it can take a
  couple of minutes more.
- Hard cap: if a rebuild has been deferred because CPU load stayed at 99 %+ for more than 5 minutes,
  the deferred rebuilds run anyway; the threshold (99 %) and duration (5 min) are env config
  variables, like the ~60 % slowdown threshold.
- A deferred rebuild is never dropped, so the data always converges on the latest upload.
- With no load the behaviour is as today (rebuild right after the upload), so a lightly loaded
  instance keeps a near-realtime live view.
- User requests (opening sessions, lists) take priority over these rebuilds; slower updates of a
  live session under load are acceptable.
- FR-6 is what relieves a live session: its transcript really changes between consecutive uploads,
  so the FR-5 / FR-7 skips only help with duplicate uploads.

**FR-7 — Hook does not send unchanged logs.**
- Base rules are in `send-recompute-analysis.md` §4.1, narrowed by the decisions below; its recovery
  parts (H6, S2, S18) are dropped.
- The current session's `artisyn` is never skipped.
- `.claude-logs.sent` stays as is for old hooks; a separate v2 manifest stores per file size, mtime
  and the upload parameters.
- A transcript is skipped when its size and mtime both equal the manifest entry and the upload
  parameters are unchanged; a different size or mtime means "send". No content hashing of
  already-sent files on every `Stop`.
- `.claude-logs.pending` stores a content hash so a chunked upload resumes only onto identical
  content (FR-8).
- No history recovery: after a server switch (new URL, reset or restored DB) or data lost on the
  server, the hook does not re-send history — the new server gets sessions from that point on. So
  no server identity in the manifest, no `verify` route and no periodic verify sweep.
- Backward compatibility both ways per the matrix in `send-recompute-analysis.md` §5 (old/new hook ×
  old/new server).

**FR-7a — A deleted session stays deleted.**
- A soft-deleted session (UI Delete) keeps rejecting later uploads of its own session id, as
  `LogsService.upsert` and zip import do today.
- A session purged by retention is not re-created by a later upload (detected via
  `deleted_session_log`).
- Everything that flows into a deleted session is silently ignored: uploads with its own id, logs of
  its subagents at any depth arriving after the Delete (late uploads, or new subagents of a resumed
  session), OTEL chunks and realtime OTEL, `tool-calls`, snapshots and any other ingest path. The
  plan enumerates every ingest path and closes each one (a scenario step per path).
- Data that stays after a soft delete (`logs_otel`, `otel_api_calls`, `session_changed_paths`,
  `session_harness_usage`, `session_tool_stats`, attribution tables — see
  `docs/knowledgebase/db-tables.md` "Soft delete") is never shown anywhere; the plan checks whether
  any read path can still surface it and either purges it on Delete or filters it out.
- Account or repository deletion is a fresh start: after the account / repository is deleted and
  added again, uploads are accepted as if nothing had existed before (the "stays deleted" records
  for it are cleared, or the check ignores them).
- The server answers such an upload with a success-class status that tells the hook not to retry
  (an old hook must not loop on it), and the hook may mark the file as sent.

**FR-8 — Close today's data-loss gaps** (fixed together with FR-5 / FR-7, because a skip would make
them permanent instead of healing on the next upload; see `send-recompute-analysis.md` §2):
- A 2xx only means "staged", so a later processing failure is never re-sent — handle it within the
  upload response / retry path, without a verify sweep.
- A chunked upload resume checks only `totalSize` (`hook/.claude/telemetry_tool/upload-logs.js:885-886`)
  and the server never verifies the reassembled content, so a changed file of the same length is
  spliced onto old chunks — fix it.
- Two workers or a deadlock retry can process an older upload after a newer one and overwrite the
  newer body — add a "newer upload wins" guard (for `artisyn` the older upload still stores its
  harness / OKF snapshot and code-inventory lines).
- When the tree's `artisyn` edit records change, the dependent claude / subagent stats are
  re-extracted in the background (full re-extraction from the stored bodies, through the FR-6
  rebuild path).
- `tool-calls` change detection by a sum of file sizes can miss changes, and a subagent's
  `.meta.json` arriving later never corrects its parent — fix both.
- Zip import re-extracts subagent stats.

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
- [ ] FR-2: opening session `c0d1de05` on the Pi stand fetches only the root part and renders it;
      opening a view that needs every subagent shows a "Loading session logs N of M" style
      indicator, and the bytes transferred for all parts together are the compressed size
      (≈ 10 MB or less, not 42 MB).
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
      last upload within the hard-cap duration (default 5 min) plus one rebuild, also while load
      stays at 99 %+.
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
- [ ] FR-8: each gap listed under FR-8 has a scenario step that reproduces it before the fix
      and passes after it (same-length changed file on chunk resume, out-of-order uploads,
      processing failure after 2xx).
- [ ] Time to a usable session view for `c0d1de05` on the Pi stand drops well below today's ~30 s;
      before/after numbers recorded in the task notes.

## Common sense considerations

- The compressed body (FR-1) uses gzip level 6 (zlib default) and is produced by the FR-6 rebuild
  path, never in the hook-facing request.
- The exact FR-6 load signal and slowdown curve are chosen in the plan within the decided thresholds.
- FR-3's memory bound covers every route that reads whole session bodies: the legacy `/logs`, the
  new per-part routes and the full-snapshot path of the existing Session Map route
  `GET …/sessions/:sessionId/logs/delta` (`session-logs-delta.service.ts`, which also reads the
  whole claude body as text for workflows).
- FR-4 reuses the version / fingerprint approach of `/logs/delta` where it fits instead of
  inventing a second change-detection scheme; the Session Map keeps its own route.
- The per-worker limit on concurrent large-log responses (FR-3) applies to every route above, its
  value is an env variable, and queued requests wait rather than fail.
- Client consumers that need the whole tree (session export, harness usage, bash tab and other
  "all subagents" tabs) load the remaining parts with the FR-2 progress indicator.
- Every new route gets its row in `server/test/contract/registry/`; behaviour is checked by steps in
  existing scenarios, and FR-5's skip decision gets algorithm-doc rows only if it is documented as
  an algorithm.
- Retention-purged session detection (FR-7a) uses the existing `deleted_session_log` table.

- The task is not split (decided 2026-11-23): every FR is delivered within this one task, FR-3
  first.

## Open Questions

None.

## Notes

- Related: `2026-06-21-session-parse-indicator` (client-side *parsing* indicator after the fetch);
  this task's indicator covers the *loading* phase — keep the two consistent in the UI.
- Related, archived: `2026-10-31-session-list-slow-jsonb` (same family of `jsonb` cost on the list).
- Out of scope: incremental ingest (parsing only the appended tail of a transcript) — too easy to
  silently lose a value. Whole-file replace plus full rebuilds stay (they keep ingest idempotent and
  self-healing, and old hooks keep sending whole files); FR-5 and FR-6 only make them cheaper.
- Measurements, the root-cause analysis, the user's original words and background evidence:
  `notes.md`.
