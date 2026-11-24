---
type: "Research"
title: "When to Send and When to Re-process Session Logs"
description: "Per-log-type analysis of when the hook may skip an upload and when the server may skip re-processing, with every data-loss scenario a naive skip would cause and conservative rules that stay backward compatible."
---

# When to Send and When to Re-process Session Logs

Analysis for FR-5 / FR-6 of [requirements.md](requirements.md). Read-only analysis, 2026-11-23.
Line numbers refer to the working tree of branch `feature/2026-11-22-workhub-remote-git-vault`.
Hook paths are relative to `hook/.claude/telemetry_tool/`; server paths to `server/src/`.

**Main conclusion up front.** On a live session the big transcript really does change between
uploads. The local `hook.log` shows `claude/c0d1de05….jsonl` sent as 5053 → 5296 → 5330 KB
within ~2 minutes. Of 71 non-OTEL uploads in the three local `hook.log` files, only 8 had the
same KB size as the previous upload of the same file. This sample is small and only indicative.
So "skip if unchanged" cannot remove most of the live-session load, on either side. Only FR-6
coalescing can do that. Skipping still pays off in these cases:

- duplicate uploads: the prompt-time upload, `Stop` and `SessionEnd` sending the same content;
- a hook timeout after the server already staged the upload, which leads to a retry;
- old hooks;
- a lost manifest that causes a mass re-send;
- the receiver retrying a job.

Several of the risks below already exist today and are not caused by skipping. Skipping would
make them permanent instead of healing on the next upload.

---

## 1. Current behaviour per log type

### 1.1 How the hook decides to send (all namespaces)

- **Manifest** `<telemetryDir>/.claude-logs.sent` has one `"<key> <size>"` line per file
  (`readManifest` `send-logs-hook.js:192-210`, `writeManifest` :219-245, temp file + rename).
  - It is **not keyed by server URL or server instance**.
  - The skip test is `recorded === size`, where `size` is the **stat-time** size from the
    directory scan (:2186-2210).
  - An entry is written only after a 2xx (:2315-2353), and is batched (:1855-1867).
  - Entries whose file disappeared are pruned only for namespaces that enumerated successfully
    (:1840-1852, :2452-2464).
- **Only the full `Stop` scan (`runUpload`, :1563) reads or writes the manifest.**
  - The prompt-time upload (`prompt-upload-hook.js`, header :15-19) never touches it.
  - The `SessionEnd` scoped flush (`runSessionEndFlush` :1495-1545) never touches it either.
  - All three always send what is on disk.
- **Order within a full scan:** the current session's `claude` / `claude-subagent` first, then
  everything else, with `claude-otel` in lexicographic order. The current session's `artisyn`
  goes last and carries `hook-status` (:2387-2414, :2472-2503).
- **Sanitising:** every full-scan upload passes `sanitizeNdjson()` (:2234-2248,
  `ndjson-sanitize.js`), which drops lines that do not parse.
  - So the **uploaded body ≠ the on-disk file** whenever a line is torn. This includes a partial
    last line that Claude Code is still writing.
  - The `SessionEnd` flush does **not** sanitise (:1509-1522). The prompt-time upload does.
- **Size used vs bytes read:** the manifest records the stat-time size (:2351), but the body is
  read later (:2215). A file that grew in between is recorded smaller than what was sent. That
  only causes a redundant re-send, never a skip.
- **Chunking / resume** (`upload-logs.js:853-994`): a body over 900 KB is sent in slices.
  `.claude-logs.pending` stores `{uploadId, totalSize, totalChunks, nextChunkIndex, slices}` per
  manifest key.
  - **Resume is decided on `totalSize` equality only** (:885-891).
  - The server reassembles chunks with no content check: a size mismatch only logs a warning
    (`logs/upload-queue.service.ts:304-324`).
  - **Existing hazard:** a body that changed but kept the same length resumes onto chunks of the
    old body. Line boundaries are aligned to the old body, so the server gets a spliced file. A
    torn junction line is then silently dropped by the 10 % tolerant parser.
  - The current-session `artisyn` key is shared by the three upload paths (`Stop`, prompt-time,
    `SessionEnd`), each with a different prefix. That makes same-length bodies with different
    content plausible, if rare.

### 1.2 Per namespace

| Namespace | Source / send rule today | Uploaded body vs on-disk file | Content change without size change |
|---|---|---|---|
| `claude` | `<claudeConfigDir>/projects/<slug>/<session>.jsonl` (:1649-1660). Size manifest; the current session's file is also manifested (:2343-2352). Prompt-time and `SessionEnd` re-send it unconditionally. | Sanitised file bytes (no prefix). Never augmented. | Only if Claude Code or a user rewrote the file in place. Claude Code is append-only as far as this code assumes; not verified against Claude Code. A sync tool restoring a different version is the other case. |
| `claude-subagent` | `…/<session>/subagents/*.jsonl` and `…/subagents/workflows/<wf>/agent-*.jsonl` (:1676-1731). Size manifest. Not in the prompt-time or `SessionEnd` scope. | Sanitised file bytes **plus query params** `parentSessionId`, `workflowRunId`, `agentDescription`, `workflowPhase` from `.meta.json` (:1679-1691, :1714-1730). | Same as `claude`. **In addition, the params can change with the body unchanged:** if `.meta.json` appears or changes after the transcript was sent, `parentSessionId` switches from the main session to `agent-<parentAgentId>` (:1680). A size skip never resends it, and the server only learns the correct parent or labels when the transcript grows (`logs.service.ts:359-376` overwrites them only on upload). |
| `artisyn` (current session) | `<telemetryDir>/<session>.jsonl`. **Never manifested**, sent on every `Stop` (:2188, :2343). Also sent by the prompt-time upload and by `SessionEnd`. | **Differs per path.** `Stop`: `hook-status` + harness ref (+ full snapshot) + code-inventory (throttled) + OKF ref (+ full) + file (:2254-2288, :2472-2488). Prompt-time: harness ref + file (`prompt-upload-hook.js:161-166`). `SessionEnd`: raw file only. `hook-status` has a timestamp and the `hook.log` tail, so the `Stop` body is different every run. | The file is append-only (`write-telemetry.js`). In practice every turn appends `prompt_start`, so the file changes each turn anyway. |
| `artisyn` (backlog) | Size manifest. | OKF ref (+ full) prefix + file (:2275-2285). The OKF ref is the **current** OKF snapshot, so the body depends on when it is sent. | As above. |
| `claude-otel` | One immutable chunk per OTLP request (:1749-1762). **Deleted after upload** (:2324-2342), so it can never be re-sent. | Sanitised chunk. The server keys it by content: `computeChunkKey` = sha256 of the parsed lines (`logs/otel-chunk.ts:24`), upserted into `logs_otel` (`logs.service.ts:1285-1308`). | Never: chunks are written via temp file + rename. |
| `tool-calls` | Assembled per session from `tool-wrap/<session>/`. The manifest "size" is a **fingerprint = Σ(size+1) over `calls/*`, `breaker/*`, `preflight.json`** (`tool-wrap-records.js:426-449`; use :1773-1801). Cumulative re-send. | A freshly assembled file whose status line carries `hookVersion` and `at` (now) (`tool-wrap-records.js:309-323`). It is capped and older call text is dropped (:252-268), so the body differs on each assembly. | **Yes, several ways:** one file grows while another shrinks by the same amount; a breaker marker is swapped for a same-length name; `preflight.json` is rewritten with the same length; a call record is rewritten in place. The sum-of-sizes fingerprint does not see any of these. |
| harness / OKF snapshots, code-inventory, `otel-status`, `hook-status` | Not separate files: lines injected into the `artisyn` body (above). Harness and OKF use their own **content-hash ids** with server feedback (`unknownSnapshotId` / `unknownOkfSnapshotId`, :2016-2037, :2080-2099). Code-inventory uses a 6 h throttle and commits only after a 2xx (:2119-2165). | n/a | n/a. Harness and OKF are already the "hash + server confirms it knows the hash" pattern this analysis recommends for files. |

The OTEL realtime channel (`/api/v2/otel-realtime`) does not go through `logs` and is out of
scope.

### 1.3 Server ingest

- **Staging:** `POST /api/v2/logs` (`logs/logs-v2.controller.ts`) stages the raw body and
  answers `201` before any parsing.
  - A foreign session is answered `201` / `complete:true` with a warning and nothing is staged
    (:132-145, :235-240).
  - **So a 2xx means "staged", not "ingested".**
- **Claim:** `claimNextPendingRow` takes the oldest `pending` row with `FOR UPDATE SKIP LOCKED`
  (`logs/upload-queue-scheduler.service.ts:329-348`).
  - Nothing stops two workers from holding two rows of the same session at once. The tree
    advisory lock in `upsert` serialises them, but **not in arrival order**.
  - A row sent back after a transient error such as `40P01` waits `attempts × 2 s`. By then a
    newer row of the same log may already have been ingested.
  - **The older body then overwrites the newer one.** It stays stale until the next upload of
    that file. Today that upload comes only if the file changes.
- **Parse:** `parseNdjsonLinesTolerant` over the whole body (:391) runs before any decision.
- **`LogsService.upsert`** (`logs/logs.service.ts:284-886`):
  - soft-deleted session → `deleted`, nothing written (:297-308);
  - owner lock and foreign check (:316-326), then the tree lock (:332);
  - `sessions` upsert, which overwrites the parent / workflow / labels when sent (:350-377);
  - **`logs` upsert with `body = excluded.body`, `updated_at = now()`, unconditionally**
    (:430-459);
  - for `claude` / `claude-subagent` the full re-extraction (:466-544): `session_stats`,
    request ids, OTEL reclass enqueue, call tokens, costs, changed paths, tool stats, harness
    usage, file stats, OKF access, cause stats;
  - for `claude` / `claude-subagent` / `tool-calls`, `markTreeStale` (:548-554), which the
    tool-usage drain rebuilds after commit (:884);
  - for `artisyn` (:559-845): repo upsert and link, `max_upload_bytes`, hook-status columns
    (only when the line is present), `otel-status`, harness store/bind/inventory, OKF
    store/bind, code-inventory, **tree-wide `renormaliseSessionChangedPaths` on every upload**
    (:822), and the file-stats heal gated on new insert / new link / new roots / OKF bound
    (:838-845). Contexts are written only on a new insert (:848).
- **Zip import** (`writeImportedLog`, :1088-1230): keeps the longer body by line count.
  - It re-extracts only for `claude`, **not** for `claude-subagent` (:1167), and without hook
    edit records. This is an existing gap.
- **Re-processing that does not depend on uploads:**
  - tool-usage re-queue on an extractor version bump (`database/database-init.ts:155-170`);
  - OTEL projection re-queue (:172-185);
  - session-list flag backfill (:190);
  - `ShellFiguresBackfillService` (below `OKF_EXTRACT_VERSION`, PowerShell nodes only);
  - stale session-cost drain (`session-cost/session-cost-writer.ts:229`, `drainStaleSessionCosts`);
  - admin `recompute-all-sessions` (`logs/repositories.service.ts:1356`).
  - **There is no version marker for `session_stats` / file stats / cause stats / OKF access /
    changed paths.** Today an extractor fix reaches existing sessions only through a re-upload or
    `recompute-all-sessions`.
- **Readers of `logs.updated_at`:** the Map-tab delta watermark
  (`logs/session-logs-delta.service.ts:323,375`), and the sort key
  `COALESCE(end_time, updated_at)` (`repositories.controller.ts:606,1144`,
  `repositories.service.ts:1305`). For non-`artisyn` rows `end_time` is NULL, so their sort time
  is `updated_at`.

---

## 2. Data-loss scenarios

"Naive skip" means hook: skip a file whose size or hash matches the manifest; server: skip
ingest when the body hash matches the stored one.

| # | Scenario | What goes wrong with a naive skip | Required handling |
|---|---|---|---|
| S1 | **Server lost data**: restored from a backup, DB reset, data deleted by hand | The manifest says "sent"; the server has nothing or an older version. The file never changes again (finished session), so it is **never re-sent**. This already happens today with the size manifest. | A server-side check the hook can run without uploading: a batch verify request (§4.1, H6) answering `match` / `missing` / `different` / `gone` per `(sessionId, type, sha256)`. Run it on a server-identity change and periodically. A backup restore keeps the instance id, so only the periodic verify catches it. |
| S2 | User switches `serverUrl` / env / Log Hub instance | The manifest is not keyed by server (`readManifest` :192). The new server only gets files that change later. Today's behaviour. | Key the new manifest data (H2) by server origin **and** a server-provided `serverInstanceId`. A new key means all entries are unverified → verify or re-send, throttled. **Whether history should be re-sent at all is a user decision (Q1).** |
| S3 | Session soft-deleted on the server | Uploads are rejected (`deleted`, `logs.service.ts:297-308`) and the hook gets 2xx anyway. Skipping is harmless. | Verify must answer `gone`, and the hook must treat `gone` as "stop sending", never as "missing". |
| S4 | Session hard-deleted by retention / admin family delete / account deletion | Today an unchanged file is never re-sent, so the purge sticks. A changed file (resumed or appended transcript) **re-creates** the session with a fresh `created_at`, so it survives another 30 days. A "re-send when the server lacks it" rule would **resurrect every purged session**. | Verify must report purged ids as `gone` (`deleted_session_log.session_id` exists; whether every descendant gets its own row there must be checked). Whether a *changed* file of a purged session may re-create it is a user decision (Q2). |
| S5 | Upload got a 2xx but ingest failed later (`failed` row: parse > 10 % bad lines, a non-transient DB error, deadlock retries exhausted, staged file missing) | The hook manifests on 2xx and then sees only free-text `warnings`. It raises a recommendation but **never clears the manifest entry**. A finished file stays missing or stale forever unless an admin runs "reprocess failed". Already the case today. | Additive structured response field, e.g. `failedUploads: [{sessionId, type, sha256?}]` for the caller's `failed` rows. The hook drops those manifest entries, which causes a re-send. The server hash must be written **only in the same transaction that writes `body`**, so a failed ingest never leaves a matching hash. |
| S6 | Partial multi-chunk upload: run killed, `.claude-logs.pending` left behind | Not manifested (good). **But** resume matches on `totalSize` only (`upload-logs.js:885-891`): a changed same-length body is spliced onto the old chunks. | Store `sha256` of the full body in the pending record. Resume only on an exact hash match, otherwise restart with a new `uploadId`. Optionally send `contentSha256` on chunk 0 so the server can verify the reassembled body (an unknown query param is ignored by old servers, per `main.ts:96` `forbidNonWhitelisted:false` and hook-api-versioning § 2.31.0). |
| S7 | Partial upload expired on the server (24 h TTL) | The resume gets `400`, then restarts from chunk 0 (:924-927). No loss. | Keep as is. |
| S8 | Hook timeout after the server already staged the body | The hook sees a failure and re-sends the same content later. That costs a full re-ingest; no data is lost. | Server-side hash skip (V1) makes the duplicate cheap. |
| S9 | **Out-of-order ingest**: two workers, or a transient-error retry, or admin "reprocess failed" of an old row | The older body overwrites the newer one. Today it heals on the next upload, which never comes for a finished file. A hook-side skip makes it permanent; a server-side hash skip does not change it. | Monotonic guard (V3): store the `received_at` of the queue row that wrote `body`. An older row does not replace a newer body. **For `artisyn`, an older row still runs its add-only side steps** (harness / OKF snapshot store, code-inventory, `otel-status`). See S10. |
| S10 | Coalescing (FR-6) / superseding an older `artisyn` upload | Older `Stop` bodies carry lines a newer prompt-time or `SessionEnd` body lacks: full `harness-snapshot`, full `okf-snapshot`, `code-inventory`. The hook has already committed "known" or "reported" on the 2xx (:2498-2502). Dropping the older row loses them. Harness / OKF self-heal through `unknown…Id` on a later upload; **code-inventory does not**: it is lost for its 6 h window. | Coalesce only whole-file-state types (`claude`, `claude-subagent`, `tool-calls`): the newest pending row wins. Older rows are deleted only **after** the newest ingested successfully; if it fails, older rows are processed. Never coalesce `claude-otel` (fragments). For `artisyn`, a superseded row skips the body write and the extraction but runs the add-only side steps. |
| S11 | Extractor / parser change on the server | `tool_usage_version`, `otel_projection_version` and the OKF shell backfill are re-queued from stored bodies, independent of uploads, so a skip cannot block them. **But `session_stats`, file / cause stats, changed paths and OKF access have no version marker.** Today a re-upload heals them; with a hash skip it would not. | Put an `INGEST_VERSION` constant in the skip key, stored next to the hash. Bump it on any change to the parser, the null stripping, `extractClaudeStats` or the Step 3 writers. After a deploy the next upload of each live or backlog file re-processes it. Version bumps that rebuild from stored bodies keep running as today. |
| S12 | **Cross-log: hook edit records** (`artisyn` `PostToolUse.edit_result`) are an *input* to `claude` / `claude-subagent` stats (`logs.service.ts:473-483`, `change-surface/changed-paths.sql.ts:139-172`) | Within one `Stop` run the transcripts go **first** and `artisyn` **last**, so a transcript is extracted with the previous `artisyn` version. An `artisyn` upload never re-extracts the tree (no caller besides `upsert` and the recompute). Today a later identical re-upload of the transcript (for example the `SessionEnd` flush) picks up the new records. A hash skip on the transcript would **freeze the line counts without the last turn's edit records**. This matters most for workflow agents, where `edit_result` is the only source of `+`/`−`. | The server skip key must include the revision of the tree's `artisyn` log that was used at extraction (`stats_artisyn_rev`). Skip only if the body hash **and** that revision both match. Separate existing gap, recommended fix: an `artisyn` ingest that changes a node's edit-record set marks that node stats-stale, and a background job re-extracts it. |
| S13 | Cross-log: repo roots, repo links, OKF snapshot binding (file stats, OKF access, changed-path normalisation, cause-stats scopes) | They are healed from the `artisyn` side (:822, :838-845), which is not skipped while `artisyn` changes. A transcript that arrived before its `artisyn` is healed by the `artisyn` upload, not by re-uploading the transcript. | The same `stats_artisyn_rev` in the key covers the transcript side. Do not hash-skip `artisyn` in phase 1 (V4). |
| S14 | Subagent parameters change, body unchanged (`.meta.json` arrives later) | The wrong `parentSessionId` (main session instead of `agent-<id>`) and missing labels stay forever. A size skip already causes this today. | Hook: the skip key includes a hash of the upload params (H3). Server: always run Steps 0–1 (ownership, lock, `sessions` upsert with params) **before** the hash check; only the body write and the extraction are skipped. |
| S15 | `tool-calls` fingerprint collision | A changed call set is never re-sent. This exists today. | Fingerprint = sha256 over the sorted `(relative name, size, mtimeMs)` of the source files (no content read). |
| S16 | Torn line or partial last line at read time | The sent body lacks that line. The manifest records the stat size. The line is completed later, the size grows, it is re-sent. A truly torn mid-file line is lost by design (it is logged). | Record the **bytes actually read** (length + hash) and the hash of the **sent** body separately. Never record a fingerprint of bytes that were not read. |
| S17 | Zip import writes `body` (keep-longer) | A stored hash no longer describes `body`. A later hook upload equal to the old hash would be skipped wrongly. | Every body write path must set or clear the hash in the same statement. Robust version: a DB trigger `BEFORE UPDATE OF body` that sets `body_sha256 = NULL` unless the same UPDATE also sets it. This also covers an **older server build** running after a downgrade, because migrations are not rolled back. |
| S18 | OTEL chunk lost on the server | The hook deleted it after the 2xx, so it cannot be recovered from the hook. | Out of scope for a skip rule. Server-side it is content-keyed, so a re-send is idempotent. Whether to keep uploaded chunks for N days for recovery is Q4. |
| S19 | `claude` session where the transcript arrives before the OTEL chunks, or the other way round | OTEL classification depends on `session_request_ids` from the transcript (`enqueueOtelReclass`, :486). An unchanged transcript has unchanged request ids, so skipping is safe. A new OTEL chunk enqueues its own projection. | None beyond V1. |
| S20 | Two uploads of one session racing on the hook side (`Stop`, prompt-time, `SessionEnd`, `--run-job`, in-process fallback) | All take the shared `.upload.lock`, so they are serialised per telemetry dir. The manifest is read only inside `runUpload`. No race on the manifest. | New sidecar writes stay inside the same lock. Scoped paths that record fingerprints (H5) only do so while holding it. |
| S21 | Hook downgrade or upgrade (old and new hooks writing the same telemetry dir) | An old hook ignores a new sidecar. If the new hook stopped writing `.claude-logs.sent`, the old hook would re-send everything (safe, but heavy). Changing the line format of `.claude-logs.sent` is unsafe: `parseInt` of a hex string can yield a number (`readManifest` :200-203). | Keep `.claude-logs.sent` unchanged and still written. Put hashes in a new sidecar. An entry is trusted only when both agree on size (H2). |
| S22 | `updated_at` semantics | A skipped upload does not bump `updated_at`. The Map-tab delta then correctly sees no change. Sessions sorted by `COALESCE(end_time, updated_at)` no longer jump to the top on a duplicate upload. | Accept: this is more correct. Do not bump `updated_at` on a skip. If a "last seen" is wanted, use a separate column. |

---

## 3. Cross-log dependencies found

1. **`claude` / `claude-subagent` stats ← `artisyn` edit records** of the nearest ancestor that has
   an `artisyn` log (`changed-paths.sql.ts:139-172`, `selectEditResultRecordsForSession`
   `artisyn-extractor.ts:759`).
   - Not re-derived when `artisyn` changes. Existing gap (S12).
   - If the parent `sessions` row does not exist yet when a subagent uploads, the ancestor walk
     finds no `artisyn` at all.
2. **File stats, OKF access, changed paths ← repo roots** (`resolveSessionRepoRoots`) from the
   tree's `artisyn` log; healed by the `artisyn` upload (:822, :838-845).
3. **File-stats scopes and cause stats ← repo URLs / links** of the tree (`log_repositories`,
   written by `artisyn` Step 5) and team / user config. Config saves trigger their own recompute.
4. **OKF access ← OKF snapshot bound to the root session** (`storeAndBindOkfSnapshot`,
   `artisyn` Step 5d2). Healed through `okfBound` (:842).
5. **Tool usage ← all transcripts + `tool-calls` + repo links + monitor config** (tree-level).
   Each input marks the tree stale itself (:548-554, :624-626, `tool-monitor-config.service.ts:521`),
   so skipping an unchanged input is safe.
6. **OTEL classification / projection ← `session_request_ids` of the transcript**
   (`enqueueOtelReclass`). Safe to skip when the body is unchanged.
7. **Session costs ← call tokens + pricing.** Pricing changes go through
   `drainStaleSessionCosts`, independent of uploads.
8. **Harness inventory ← bound harness snapshot**; **hook-state repo columns ← the latest
   `hook-status`**. Both come only from `artisyn` bodies, and each upload path builds a different
   body (§1.2).
9. **Subagent `sessions.parent_session_id` / labels ← upload params, not body** (S14).
10. **Zip import** bypasses edit records and subagent stats entirely (:1167). Existing gap, noted
    only.

---

## 4. Recommended rules

### 4.1 Hook

- **H1. Never skip the current session's `artisyn`.** Its body differs every run, and the file
  itself gains `prompt_start` every turn. Keep sending it unconditionally, as today.
- **H2. New sidecar `.claude-logs.sent.v2`** (JSON, temp file + rename, written under the
  upload lock). Keep `.claude-logs.sent` exactly as it is, still written. Per manifest key store:
  - `size` and `mtimeMs` of the bytes **read** (not the stat-time size);
  - `srcSha256` of those bytes;
  - `sentSha256` of the exact uploaded (sanitised and prefixed) body;
  - `paramsSha256` of the upload params (namespace, sessionId, parentSessionId, workflowRunId,
    agentDescription, workflowPhase);
  - `server` = origin + `serverInstanceId` (when the server sends one);
  - `verifiedAt`.
- **H3. Skip rule (`claude`, `claude-subagent`, backlog `artisyn`).** Skip only if all of these
  hold:
  - (a) the v2 entry exists for the **current server key**;
  - (b) the old manifest agrees on `size`;
  - (c) the current `size` and `mtimeMs` equal the stored ones;
  - (d) `paramsSha256` equals the stored one.
  - If size matches but mtime differs: read and hash. Skip if `srcSha256` matches (then update
    `mtimeMs`), otherwise send.
  - Anything else: send.
  - This keeps the cheap stat-only skip for the ~3000-file backlog. Hashing on every run would
    read gigabytes of history.
  - It accepts one assumption: an in-place rewrite that keeps both size and mtime. A sync tool
    that preserves mtime would also need the same length. Q3 asks whether that is acceptable.
  - Hashing is cheap next to what the hook already does to every uploaded body: `sanitizeNdjson`
    `JSON.parse`s every line. SHA-256 of 5 MB is a few ms on a developer CPU.
- **H4. `tool-calls`:** replace the sum-of-sizes fingerprint with H2/H3 over the sorted
  `(name, size, mtimeMs)` of the source files (S15).
- **H5. Scoped paths** (prompt-time upload, `SessionEnd` flush) may record a v2 entry for
  `claude` only, and only when their body equals what a full run would have sent. The
  `SessionEnd` flush must sanitise first, or record only when nothing was dropped. This removes
  the redundant re-send of an ended session's transcript on the next `Stop`. Never record
  `artisyn` from these paths.
- **H6. Recovery: verify instead of a blind re-send.**
  - New additive route, e.g. `POST /api/v2/logs/verify` with `[{sessionId, type, sha256}]`
    (bounded batch). The answer per entry is one of:
    - `match`;
    - `present` (hash unknown: a legacy row from before the hash column);
    - `missing`;
    - `different`;
    - `gone` (soft-deleted, purged or foreign).
  - The hook re-sends `missing` / `different` (throttled per run, by MB), treats `match` /
    `present` / `gone` as done, and stops resending `gone`.
  - Triggers: a server-key change (origin or `serverInstanceId`), and a periodic sweep (e.g.
    once a day per telemetry dir, spread over runs). The sweep is the only thing that detects a
    backup restore (S1).
  - A `404` (old server) means "feature off": keep the H3 behaviour and never read it as "server
    lost everything".
- **H7. `failedUploads` feedback:** when a 2xx response lists the caller's `failed` rows in a
  structured way, drop those keys from both manifests so they are re-sent (S5).
- **H8. Chunk resume:** store `sha256` in `.claude-logs.pending` and resume only on an exact
  match. Send `contentSha256` on chunk 0 and on single uploads (S6).

### 4.2 Server

- **V1. Hash skip.**
  - Compute sha256 of the **raw staged body** (after gunzip and reassembly) **before parsing**.
    Parsing is the expensive part on the Pi.
  - Run the soft-delete check, ownership, the tree lock and the Step 1 `sessions` upsert (params)
    as today.
  - Then skip parse, the body write, the extraction and the stale marks only if **all** hold:
    - `logs.body_sha256` = the hash;
    - `logs.ingest_version` = `INGEST_VERSION`;
    - `logs.user_id` = the uploader;
    - for `claude` / `claude-subagent`, `stats_artisyn_rev` = the current revision of the tree's
      `artisyn` log (S12, S13).
  - Delete the queue row as success, record the measurement as "skipped", leave `updated_at`
    alone.
  - Apply V1 to `claude`, `claude-subagent` and `tool-calls`.
  - `claude-otel` is already content-keyed. It may skip the `otel_projection_version = NULL`
    reset only when the stored chunk body is identical; low value, optional.
- **V2. Hash integrity.**
  - Write `body_sha256`, `ingest_version` and a monotonically increasing `body_rev` in the
    **same** statement as `body`.
  - Add a DB trigger that clears `body_sha256` whenever `body` changes without it (S17, and
    server downgrades).
  - Zip import sets the hash to NULL.
  - FR-1 / FR-4 should key the compressed copy and the client refetch on `body_rev`, not on the
    raw-body hash. The compressed form is of `body::text`, not of the raw upload.
- **V3. Monotonic guard and coalescing (FR-6):**
  - store `body_received_at`;
  - a row older than it does not replace `body` (S9);
  - coalesce pending rows per `(session, type)` for whole-file types, deleting older rows only
    after the newest succeeded (S10);
  - check how `upload_queue.received_at` behaves for chunked uploads and for a retried chunk 0
    before relying on it.
- **V4. `artisyn` in phase 1: no hash skip.** It is rarely byte-identical (`hook-status` changes
  every run). Its side steps are add-only and context-dependent: a re-link after a repository is
  deleted, or a change in URL normalisation. The expensive tree-wide
  `renormaliseSessionChangedPaths` (:822) could be gated like the 5f heal (roots / links
  changed); that needs its own check, so it is not proposed here.
- **V5. Always bypass the skip:**
  - admin `recompute-all-sessions`;
  - every version-driven re-queue (tool usage, OTEL projection, OKF shell backfill, list flags);
  - the stale-cost drain;
  - `reprocess-failed` (the hash is never set on a failed row);
  - the FR-1 backfill.
  - None of these go through `upsert`'s new early exit; keep it that way.
- **V6. `serverInstanceId`:** a random UUID generated once and stored in the DB (like
  `server_secrets`), returned additively on `POST /api/v2/logs`. A DB reset gives a new id. A
  backup restore keeps the old id; only the H6 sweep catches that case.

---

## 5. Backward-compatibility matrix

| | Old server | New server |
|---|---|---|
| **Old hook** | As today. | V1 / V3 work, because the server checks the raw body itself. Additive response fields (`serverInstanceId`, `failedUploads`) are ignored. No verify, so S1 / S2 stay as today for these users. |
| **New hook** | Unknown query params (`contentSha256`) are ignored. No `serverInstanceId` → server key = origin only. `/verify` gives `404` → feature off, H3 only. `.claude-logs.sent` is still written, so a downgrade works. | Full: H1–H8 + V1–V6. |
| **Mixed over time** | A server downgraded and then upgraded: the trigger (V2) has cleared stale hashes, so no wrong skip. A hook downgraded and then upgraded: the v2 entry is trusted only when it agrees with `.claude-logs.sent` and the file stat (H3). | — |

---

## 6. Open questions for the user

1. **Server switch (S2):** when a user points the hook at a different Log Hub (new URL or a reset
   DB), should the hook re-send its whole local history (throttled) to the new server, or only
   sessions from now on?
2. **Purged sessions (S4):** if a retention-purged or user-deleted session's transcript later
   grows (resumed session), may the upload re-create it, as today, or should the server refuse it
   (`gone`)?
3. **H3 assumption:** is a stat-only skip on equal (size, mtime) acceptable for transcripts? The
   alternative is hashing every manifested file on every `Stop`, which reads the whole history
   each run.
4. **OTEL recovery (S18):** keep uploaded OTEL chunks for N days so a verify sweep can restore
   them after a server data loss, or accept that OTEL lost on the server is gone?
5. **Existing gap S12:** fix it now with a background re-extraction when `artisyn` edit records
   change? The alternative is to keep only the `stats_artisyn_rev` skip guard, which preserves
   today's behaviour but not more.
6. **Verify sweep cadence (H6):** how often, and how much backlog re-send per run is acceptable
   (MB per `Stop`)?
