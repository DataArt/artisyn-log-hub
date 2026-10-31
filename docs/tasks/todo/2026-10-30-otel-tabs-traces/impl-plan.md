# Implementation plan — 2026-10-30-otel-tabs-traces (GH-66)

## TL;DR

- **Two channels feed one OTEL read model.**
  - **Realtime:** the hook's OTEL receiver POSTs at most one batch per session every
    `otelRealtimeIntervalMs` (default and minimum 5000 ms). The server can raise that interval
    through `minIntervalMs` in its response. Batches go to a new hook route
    `POST /api/v2/otel-realtime` and are written synchronously into new OTEL-tab tables. The
    channel is best-effort and uses a memory buffer only.
  - **Durable:** the existing `claude-otel` chunk upload, unchanged. A background projection
    drain copies every `logs_otel` chunk into the same tables with idempotent upserts. That fills
    any realtime gap, for example a 2-hour outage, once the chunks arrive, and also backfills all
    history.
- **Existing paths change only by small additive edits:**
  - an `otel_reclass_queue` insert after each `replaceSessionRequestIds`;
  - a projection-marker reset in the `logs_otel` upsert;
  - `export` of three `otel-chunk.ts` helpers and of `scopedTreeCtes`;
  - an `otel_session_state.user_id` fallback in `findSessionOwnerId`;
  - OTEL-only sessions in account deletion and in the retention job;
  - deletion of the new tables in `purgeSessionChildData`;
  - a re-mark step in `database-init.ts`;
  - one new entry in `HOOK_API_ROUTES`.

  Not touched: `ingestOtelChunk`'s logic, its `telemetry_cost` SUM, `otel_api_calls`,
  `utilityCostsCte` and the upload queue.
- **DB (migration `0078_otel_tabs_traces.sql`, additive only):**
  - New tables:
    - `otel_calls`, `otel_spans`, `otel_cost_buckets`;
    - `otel_session_state` — seq, transcript watermark, realtime/chunk times, gap, hook
      version, owner;
    - `otel_reclass_queue`.
  - New column `logs_otel.otel_projection_version`, with a partial index on NULL.
- **New server code in `server/src/logs/otel/`:**
  - free functions in `otel-facts-writer.ts`: `lockOtelState`, `upsertOtelCalls`,
    `upsertOtelSpans`, `recomputeSpanRollups`, `applyOtelLines`, `rebuildOtelBuckets`,
    `reclassifyOtelSession`, `enqueueOtelReclass`;
  - `OtelRealtimeController` + `OtelRealtimeService` (API key);
  - `OtelProjectionService` (drain);
  - `OtelFactsReader` + `OtelFactsController` (session cookie);
  - pure functions in `otel-records.ts` and `otel-classify.ts`.
- **Routes:**
  - hook route `POST /api/v2/otel-realtime`, sharing the hook parser with
    `HOOK_API_BODY_LIMIT` (1 MiB);
  - UI routes (GET) `/api/v1/repositories/:repoId/otel/facts` and
    `/api/v1/repositories/:repoId/sessions/:sessionId/otel` (snapshot or `since=` delta), and the
    team route `/api/v1/teams/:teamId/otel/facts` (DD-29);
  - no existing route or upload contract changes.
- **Hook 2.29.0:**
  - `/v1/traces`, `signal:"spans"` chunk lines and a `hookVersion` field on each line;
  - the realtime sender (DD-13);
  - config keys `otelRealtime`, `otelRealtimeIntervalMs` and `otelTraces`;
  - the installer asks about the trace keys (`[Y/n]`, `--otel-traces`);
  - 2.28.0 is frozen as a legacy fixture first.
- **Client:**
  - an OTEL tab on the repository view (between OKF and Settings) and on the session view
    (rightmost);
  - a stacked Recharts chart and a custom waterfall;
  - a live poll with delta merge and highlighting;
  - a permanent **"Realtime data"** badge with unconfirmed / delayed / gap / filled notices;
  - FR-24…FR-31 (DD-28; FR-30/FR-31 in DD-12): KPI sparklines and the change vs the previous period, tokens by type,
    cache read ratio, per-user cost, a "Cost flow" Sankey (model → user → session branch in a team
    view, model → branch in a private repository), a sorted
    chart tooltip, a Pause button, turn ordering and a per-turn time split;
  - FR-33/FR-34 (DD-29): an OTEL tab on the team page over all of the team's repositories and
    people, with the team visibility rules.
- **Former deviations, now written into requirements.md (2026-10-30):**
  - FR-14: per-call columns on a new `otel_calls`, not on `otel_api_calls`.
  - FR-13/FR-21: the realtime channel instead of faster chunk shipping.
  - FR-15: the existing ingest and the `telemetry_cost` SUM stay; a projection drain feeds the
    OTEL tables.
  - FR-6a: reclassification is queued and runs on the next projection tick.
  - FR-22: slow-banner texts per reason; FR-32: the realtime badge and notices.
  - NFR: the bucket table has no repository column (DD-6); FR-16: `metric` is applied
    client-side.
  - The session facts and traces share one route (FR-16 allows it).
- **Tests:**
  - four new algorithm docs;
  - contract file `f25` with world-v1 OTEL rows;
  - new scenario `s-otel-01`;
  - steps in `s-compat-01`, `s-hook-01`, `s-hook-07`, `s-inst-01`, `s-inst-04`,
    `s-slife-08` and the tours registry;
  - perf cases as a measurement only.

## Reference

- Requirements: [requirements.md](requirements.md)
- PoC: `docs/pocs/2026-10-30-1407-otel-traces-session-view/` (`template.html` UI prototype,
  `otlp.js` span flattening + cost join, `facts.sql` — its hidden rule is NOT tree-scoped, do not copy)
- Wireframes: `wireframes/repo-otel-tab.svg`, `wireframes/session-otel-tab.svg`,
  `wireframes/session-otel-live-update.svg`, `wireframes/otel-empty-states.svg`,
  `wireframes/team-otel-tab.svg` (all people, emails and accounts in them are fictitious)
- Research archive: `research/findings-1.md`

## Design Decisions

**DD-1 — Root session is the OTEL key.** Every new table row belongs to the root session. The OTEL
`session.id` is always the root id, so sub-agent spans and calls attach to the root and are told
apart by `agent_id`.

**DD-2 — Ingest-order cursor (`since=`), lock order and isolation.**
- `otel_session_state.seq` is a per-root-session counter.
- **Global lock order**, the same for every OTEL writer (realtime, projection, reclassification,
  cleanup):
  1. (realtime only) the existing advisory lock `session-owner:<sessionId>`;
  2. `otel_session_state` `FOR UPDATE`: `lockOtelState(tx, rootId, { create })` creates the
     row first with `INSERT … ON CONFLICT DO NOTHING` only when `create` is true, which only
     realtime and projection pass;
  3. a plain, unlocked read of `sessions.deleted`. If it is true, the transaction is rolled back.
  OTEL writers never take `FOR UPDATE` on `sessions` or `logs_otel` rows. The realtime path's
  only `sessions` write is DD-17's insert-if-missing (`INSERT … ON CONFLICT DO NOTHING`), taken
  after the advisory lock and before the state row — the same order as the upload path.
- The existing upload path takes the advisory lock, then `sessions` `FOR UPDATE`, then
  `logs_otel`, and never touches the state row, so no cycle exists.
- `purgeSessionChildData` deletes `otel_session_state` first. It therefore waits for any writer
  holding the lock, and a later writer sees `deleted = true` and rolls back.
- Each write sets `seq = seq + 1` and stamps that value on every row it inserts or changes.
- Writers of one session are serialized, so commit order equals seq order.
- **Reader rule:** the session route runs in one `REPEATABLE READ READ ONLY` transaction. It reads
  `state.seq` = S first, then the rows with `since < seq <= S`, and returns `cursor = v1.S`.
- An unknown cursor version, or a value above the stored seq, gets a full snapshot
  (`full: true`).
- No existing transaction takes the state lock. Transcript ingest only inserts into
  `otel_reclass_queue` (DD-5).

**DD-3 — Change kind and what the client highlights.**

Each changed span, call or bucket row stores `change_kind`:

| Kind | Meaning |
|---|---|
| `new` | first insert by realtime, or by a chunk while the session has no realtime data |
| `update` | a value changed: cost, end time or rollup |
| `confirm` | a chunk confirmed a realtime row; only `source_mask` changed |
| `fill` | first insert by a chunk while the session already has realtime data (a filled gap) |
| `reclass` | changed only by reclassification |

`otel_calls` and `otel_spans` also keep `first_seq`, set on insert and never changed.

Client rule in `mergeOtelDelta` (algorithm doc `otel-delta-merge.md`):

| Row | Client action |
|---|---|
| key not yet in client state, kind `new` / `update` / `confirm` | highlighted as new |
| key not yet in client state, kind `fill` | counted in the "filled" notice, not highlighted |
| known key, kind `update` | highlighted |
| known key, kind `confirm` / `reclass` / `fill` | updated silently |

A row that arrives by realtime and is confirmed by a chunk within one poll is still highlighted.

**DD-4 — Call structure (`classifyOtelCall`, pure TS, algorithm doc `otel-facts.md`).**

Inputs:
- `inTree`: request_id ∈ the tree's `session_request_ids`;
- `inSubagentTranscript`;
- `querySource`;
- `treeHasRequestIds`;
- `provisional`: the call's `first_seq` > `otel_session_state.transcript_seq`, or
  `transcript_seq` is NULL. It uses `first_seq`, so a later `confirm` or `update` never makes
  a call provisional again.

The rule:
1. If `inTree`: `subagent` when `inSubagentTranscript` or `querySource` starts with `agent:`,
   else `main`.
2. Else if `!treeHasRequestIds` or `provisional`: use the `utilityCostsCte` fallback.
   `TRANSCRIPT_QUERY_SOURCES` (`otel-cost.sql.ts:162`) or the `agent:` prefix counts as visible,
   with step 1's subagent/main split; anything else is `hidden`.
3. Else `hidden`.

- `provisional` is stored per call. `otel_session_state.has_provisional` is true while any call
  of the root is provisional.
- **AC-3 at rest:** once no call is provisional, the set of `otel_calls` classified `hidden`
  equals the set `utilityCostsCte` classifies as utility, matched by request_id. AC-3 compares the
  OTEL `cost_usd` sum over that set: `SUM(otel_api_calls.cost_usd_micros)` of the utility calls
  against `SUM(otel_calls.cost_usd_micros)` of the hidden calls. It never compares against the
  priced cost `utilityCostsCte` returns.

**DD-5 — Reclassification is queued, not inline.**
- **Enqueue.** `enqueueOtelReclass(tx, sessionRowId)` runs `INSERT INTO otel_reclass_queue
  (session_id) VALUES ($1) ON CONFLICT DO NOTHING` right after `replaceSessionRequestIds` at
  `logs.service.ts:432`, `logs.service.ts:1084` and `repositories.service.ts:1438`. It
  takes no other lock.
- **Claim.** One queue row per transaction:
  `DELETE FROM otel_reclass_queue WHERE session_id = (SELECT session_id FROM otel_reclass_queue
  ORDER BY queued_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING session_id`.
  - The delete is at the start of the transaction that does the work.
  - A transcript transaction committing meanwhile inserts a fresh row once the delete commits, so
    the root is reclassified again on the next tick. No update is lost.
- **Per claimed id, in that transaction:**
  1. resolve the root (`topAncestorIdsSql`);
  2. `lockOtelState(tx, root, { create: false })`. No state row means the root has no OTEL
     data: stop and commit only the dequeue. No state row is created, so sessions without OTEL
     keep `hasOtel=false`;
  3. load the root's `otel_calls` and the tree's request-id membership;
  4. recompute `structure` and `provisional` in TS;
  5. update the changed rows (`reclass`);
  6. `rebuildOtelBuckets`;
  7. set `transcript_seq = seq` and `has_provisional`.
- **Finalising idle roots.** Each projection tick also enqueues roots where all of these hold:
  - `has_provisional = true`;
  - `GREATEST(rt_last_at, chunk_last_at) < now() - OTEL_SESSION_ENDED_MS`;
  - the tree has `session_request_ids`.

  This is the case for backfilled history and for a chunk projected after the final transcript,
  so no session stays provisional forever.

**DD-6 — Repository scope.**
- Buckets carry `session_id` (root) and `user_id`, with no repository column:
  `log_repositories` is many-to-many, and OTEL can arrive before the link.
- The repository and session routes resolve scope with `scopedTreeCtes` (the team route per
  repository of the team, DD-29)
  (`server/src/logs/tool-monitoring/tool-usage-read.sql.ts:147-160`), now exported unchanged.
  It requires the root's `artisyn` log, linked to the repo. The hook uploads that log on every
  prompt through `prompt-upload-hook.js`, so a new session becomes visible seconds after its
  first prompt; realtime rows written before then show up as soon as it is.
- The repository read aggregates `otel_cost_buckets` for the scoped roots within `[from, to)`,
  through the primary key's leading `(session_id, bucket_start)`.
- `OtelFactsController` has its own private `resolveReadScope`, a copy of
  `tool-monitoring.controller.ts:193-212` calling the same three `RepositoriesService`
  methods. The tools controller is not touched.
- Reads exclude `sessions.deleted = true`.
- **Team context.** The repository and session routes take an optional `teamId` query parameter,
  exactly as the tools routes do (the team route has it in its path). With
  it the tab is in a team context (several people possible); without it the repository is the
  caller's private one (always one person). DD-28 uses this to show or hide the Sankey user column.
- **Access in a team context (FR-34, owner's decision).** The repository facts route with a
  `teamId` refuses with 403 when `teamScope.analyticsAllowed` is false — the same gate as
  `usage-analytics.controller.ts:222` — so in a `restricted` team only the owner and managers get
  it. On the client the tab is already hidden for those roles by `canSeeTeamWideTabs` (DD-26,
  the same rule as OKF); a direct link to it shows "No access". Without `teamId` (personal view)
  there is no gate. The session
  OTEL route has no analytics gate: it follows the session's usual visibility like the other
  session tabs.

**DD-7 — Bucket maintenance.**
- Grain: `(session_id, bucket_start, structure, query_source, model, cc_version)`, where
  `bucket_start` is the 5-minute UTC floor of `event_time` and NULL dimensions are stored as `''`.
- **Call upsert:** reads the old row `FOR UPDATE`, subtracts its contribution from the old key and
  adds the new contribution to the new key. Identical values mean a zero difference, so the bucket
  gets no seq bump.
- **Rebuild:** used by reclassification. It recomputes a `GROUP BY` over the session's
  `otel_calls` and upserts only the changed rows with a seq bump. A key that no longer exists is
  set to zero, not deleted. Reads ignore zero rows.

**DD-8 — Call extraction (`extractOtelCalls(lines)`, pure TS in `server/src/logs/otel/otel-records.ts`).**
- Reads the `signal === 'logs'` `api_request` records with the existing helpers `attributesOf`,
  `stringAttrOf` (cap 255) and `costMicrosOf`, exported from `otel-chunk.ts` without changing them.
- `event_time` = the `event.timestamp` attribute → the record's `timeUnixNano` → the line's
  `receivedAt` (`resolveOtelEventTime`).
- `claude_code_version` = resource `service.version` (cap 64).
- Also extracts `prompt_id`, `agent_id`, `query_source`, `model`, the token counts and the cost.

**DD-9 — Stable call key (`otelCallKey`).** It is `request_id` when present, else
`rec:` + sha1 of the canonical JSON of `{ record.timeUnixNano, record.attributes }` with sorted
keys. Realtime and chunk lines are the same objects written by the receiver, so both channels
produce the same key and the projection merges instead of duplicating. The key is independent of
the chunk's content hash, unlike `otel_api_calls.call_key`.

**DD-10 — Spans (`extractOtelSpans(lines)`, pure TS in `otel-records.ts`).** It reads
`signal === 'spans'` lines:

| Row field | Source |
|---|---|
| `traceId`, `spanId`, `parentSpanId` | the OTLP span ids (an empty parent becomes NULL) |
| `name` | the span name |
| `startTime` / `endTime` | from the nanosecond timestamps |
| `requestId` | the `request_id` attribute |
| `agentId` | the `agent_id` attribute |
| `querySource` | `query_source_safe`, else `query_source` |
| `context` | `llm_request.context` |
| `attributes` | the raw attributes, flattened |

Rules:
- Caps: `traceId` 64 and `spanId` / `parentSpanId` 32, where an over-long id skips the span with
  a counter. `name`, `requestId`, `agentId` and `querySource` are cut to 255 and `context` to 32.
- `attributes` larger than `OTEL_SPAN_ATTRIBUTES_MAX_BYTES` = 65536 when serialized are replaced
  by `{ "_truncated": true, "_bytes": n }`.
- An unknown name or attribute never fails ingest.
- Span-name constants (`otel-span-names.ts`): `claude_code.interaction`,
  `claude_code.llm_request`, `claude_code.tool`, `claude_code.tool.blocked_on_user` and
  `claude_code.tool.execution`.

**DD-11 — Span cost and rollup.**
- An `llm_request` span's `cost_usd_micros` comes from `otel_calls` by `(session_id, request_id)`,
  in both arrival orders.
- After each batch, the touched traces get `rollup = own + Σ child rollups` recomputed with one
  recursive CTE over the touched trace ids. Only rows whose rollup changed get a seq bump.
- An orphan is rolled up as a root until its parent arrives (AC-19).

**DD-12 — Client trace assembly (`assembleOtelTraces`, client algorithm doc `otel-trace-assembly.md`).**
- Groups spans by trace.
- Places orphans under a provisional "turn in progress" row of their trace.
- Attaches a `standalone` root `llm_request` trace to the interaction trace whose `[start, end]`
  contains it, else the latest one that started before it, as a separate root row.
- Computes the turn header: start, duration, cost, hidden, LLM calls, depth, spans, waiting
  (the union of the turn's `blocked_on_user` intervals, the same value as the time split's
  "waiting") and output tokens.
- The interaction rollup excludes attached standalone rows.
- Computes the turn time split (FR-31, `splitOtelTurnTime`): the union of the turn's
  `blocked_on_user`, `llm_request` and `tool.execution` intervals, clipped to the turn, assigned in
  priority order waiting → model → tool so that each instant counts once; `other` = duration minus
  the three. A running turn ends at its latest span end. Standalone rows attached to the turn are
  included (they are LLM time).
- Orders turns for the navigator (FR-30): `start` (default), `cost` (rollup, descending) or
  `slowest` (duration, descending); ties by start.

**DD-13 — Realtime channel (hook side, `otel-receiver.js`).**
- **Queue.** After writing a chunk exactly as today, the receiver appends the same `logs` and
  `spans` lines, never `metrics`, to an in-memory per-session queue.
- **Sending.** A per-session timer sends at most one POST every
  `max(otelRealtimeIntervalMs, serverMinIntervalMs)`:
  - `otelRealtimeIntervalMs` defaults to 5000 and is clamped to at least
    `RT_MIN_INTERVAL_MS` = 5000;
  - `serverMinIntervalMs` is the latest `minIntervalMs` from the server's response;
  - Claude Code already exports every 5 s, so this makes about one POST per 5 s per running
    session, carrying logs and spans together;
  - body: `{ sessionId, hookVersion, receiverId, batchSeq, droppedLines, lines }`, gzipped when
    over 8 KiB. `receiverId` is a random id made at receiver start; `batchSeq` increases per
    session.
- **Limits.**
  - At most one request is in flight per receiver; each times out after
    `RT_REQUEST_TIMEOUT_MS` = 5000.
  - A batch holds at most `RT_MAX_BATCH_BYTES` = 786432 uncompressed bytes, under the shared
    1 MiB hook limit. The rest waits for the next send.
  - A single line over `RT_MAX_LINE_BYTES` = 262144 is never sent in realtime; it is counted in
    `droppedLines` and still arrives by chunk.
- **Retry.** A failed or timed-out batch goes back to the front of the queue with the same
  `batchSeq`. The server treats a `batchSeq` it already saw as a replay, with idempotent
  upserts and no gap.
- **Queue cap.** `RT_BUFFER_MAX_LINES` = 2000 per receiver. On overflow the oldest lines are
  dropped and counted in `droppedLines`; they are still in the chunk files.
- **Backoff** (pure `nextRealtimeDelay(failures)`): `min(5000·2^failures, 60000)`. It applies
  after a 5xx, a timeout or a network error; a success resets it.
- **Auto-disable:**
  - 404 (old server), 401 or 403: realtime stops for `RT_DISABLE_MS` = 3600000, with one
    `receiver.log` line. A change in a config file's mtime ends the disable early.
  - 409 (foreign session): stops realtime for that session.
  - 413: halves the batch once, then counts its lines as dropped.
- **Shutdown.** On idle exit the receiver tries one final send, bounded by
  `RT_SHUTDOWN_FLUSH_MS` = 2000. A restart starts a new `receiverId` with an empty buffer; the
  chunks cover anything unsent. The gap notice cannot see this case, and that is documented.
- **Target.** `readRealtimeTarget(runtime.owner.gitRoot)` uses the git root, never `cwd`,
  because the receiver `chdir`s to `os.tmpdir()` at `otel-receiver.js:41-43`.
  - It shallow-merges `.artisyn/config/log-hub.json` and `log-hub.local.json` with `fs`; local
    wins, as at `env-context.js:326-339`.
  - It returns `{ serverUrl, apiKey, enabled: otelRealtime !== false, intervalMs }` and re-reads
    on an mtime change.
  - Built-ins only (`http`/`https`/`zlib`), no `require` of hook modules.
- **Unchanged:** chunk writing, the 60 s sweep, `Stop` and the upload lock. A realtime failure
  never touches chunk files.

**DD-14 — Realtime notice and data states (FR-32).** All timestamps are server clock.

**State fields** in `otel_session_state`:
- `rt_last_at` = `now()` at a realtime ingest.
- `chunk_last_at` = `logs_otel.created_at` of the newest projected chunk. That is server upload
  time, so backfilled history is never "live".
- `rt_receiver_id` and `rt_batch_seq`.
- `rt_gap_at` = `now()` when a batch arrives with either:
  - `batchSeq > rt_batch_seq + 1` for the same receiver;
  - `droppedLines > 0`.

  A lower or equal `batchSeq` is a replay and sets no gap.
- A row's `source_mask` bit 1 means realtime and bit 2 means chunk. A row without bit 2 is
  "unconfirmed".
- The projection clears `rt_gap_at` once two conditions hold:
  - the session has no pending `logs_otel` rows;
  - `chunk_last_at >= rt_gap_at`.

  This is best-effort: chunks still on the user's disk are invisible to the server, and that is
  documented.

**Status fields.**
- Session status:
  - `realtime`: `rt_last_at` within `OTEL_SESSION_ENDED_MS`;
  - `unconfirmedCalls` and `unconfirmedSpans`;
  - `chunkDelayed`: `rt_last_at - chunk_last_at > OTEL_CHUNK_DELAY_MS` = 600000, or
    `chunk_last_at` is NULL and `rt_last_at` is older than that;
  - `gap`.
- Repository and team facts: `unconfirmedCalls`, `realtimeSessions`, `chunkDelayedSessions` and
  `gapSessions` (counts of scoped roots whose session status has `chunkDelayed` / `gap`). The
  "Filled" notice exists on the session tab only, which receives `fill` rows in deltas (FR-32).

**UI.** A **"Realtime data"** badge with a tooltip explaining both channels is always shown next
to the tab title. Notices:

| State | Notice |
|---|---|
| unconfirmed > 0 | "Includes N calls received in realtime and not yet confirmed by the hook's regular upload — totals may still change." |
| `chunkDelayed` | "The regular upload is delayed (last at HH:MM); gaps are filled when it arrives." |
| `gap` | "Some realtime data was missed (connection problems); it will be filled from the regular upload." |
| after a delta with `fill` rows | "Filled N calls / M spans from the regular upload." (transient) |

**DD-15 — Slow updates and hook version.**
- `otel_hook_version` is the highest `hookVersion` seen on realtime batches or chunk lines.
- A session is "slow" when it has OTEL data but `rt_last_at` is NULL:
  - reason `old-hook` when `otel_hook_version` is NULL or below `OTEL_LIVE_HOOK_MIN_VERSION` =
    `'2.29.0'`;
  - reason `realtime-off` otherwise (realtime disabled or unreachable).
- The repository is slow when the highest `repositories.hook_version` over the `resolveRepoIds`
  rows is below 2.29.0.
- Banner text (FR-22), linking to the matching section of `user-docs/otel-tab.md`:
  - `old-hook` (and a slow repository) → "Data updates slowly — update the hook";
  - `realtime-off` → "Data updates slowly — the hook's realtime channel is off or cannot reach
    the server".
- No-traces message:
  - hook ≥ 2.29.0 → "traces are off for this session";
  - otherwise → "no traces — upgrade the hook".

**DD-16 — Projection drain (`OtelProjectionService`).** It ticks every
`OTEL_PROJECTION_INTERVAL_MS` = 5000.

1. **Claim (short transaction, committed).** Following `ToolUsageRebuildService.claimTrees`
   (`tool-usage-rebuild.service.ts:137-176`):
   `UPDATE logs_otel SET otel_projection_version = $current WHERE id IN (SELECT id FROM logs_otel
   WHERE otel_projection_version IS NULL ORDER BY id LIMIT OTEL_PROJECTION_BATCH FOR UPDATE
   SKIP LOCKED) RETURNING id, session_id`, with `OTEL_PROJECTION_BATCH` = 50 and
   `OTEL_PROJECTION_VERSION` = 1.
   - Rows are stamped before any work, so a chunk that keeps failing, or one of a deleted
     session, never blocks the queue.
   - The claim uses the partial index on `IS NULL`.
2. **Per session (own transaction).**
   - `lockOtelState(…, { create: true })` and the deleted check (DD-2); a deleted session's
     claimed rows are simply skipped.
   - Reads the claimed bodies without row locks and runs `applyOtelLines(…, source: 'chunk')`.
   - Sets `chunk_last_at` and applies the gap rule (DD-14).
   - On failure it logs, then sets the claimed rows' version to `-1`; the startup re-mark
     (< current) retries them after a restart.
3. **Reclassification queue** (DD-5), up to `OTEL_RECLASS_BATCH` = 50 roots per tick.
4. **Idle-root finalising** (DD-5).
5. **Deleted-session cleanup.** Deletes the OTEL rows of up to `OTEL_CLEANUP_BATCH` = 50 roots
   whose `sessions.deleted = true`, found through `otel_session_state`. This covers sessions
   soft-deleted while an old server build that does not know the new tables was running.

- **Backfill:** every existing `logs_otel` row starts NULL, so the same loop projects all history
  after deploy (AC-12, AC-13 upgrade half).
- `database-init.ts` sets `otel_projection_version = NULL` where it is below the current
  version (this includes `-1`).
- The existing `ingestOtelChunk` upsert's `onConflictDoUpdate.set` gains
  `otelProjectionVersion: null`.

**DD-17 — Realtime ingest (server, `OtelRealtimeService.ingest`).** One transaction:

1. Ownership: the existing advisory lock `session-owner:<sessionId>` (as at
   `logs.service.ts:290-292`), then `findSessionOwnerId`. A different owner gets 409.
2. Insert the `sessions` row if missing (`INSERT … ON CONFLICT DO NOTHING`, by `sessionId` only;
   DD-2 lock order).
3. Resolve the root, then run `lockOtelState(…, { create: true })` with `user_id` set on create,
   and the deleted check. A deleted session gets
   `200 { accepted: { calls: 0, spans: 0 }, ignored: 'deleted' }`.
4. Gap/replay check (DD-14), then `applyOtelLines(…, source: 'realtime')` and the `rt_*`
   fields.
5. Respond `{ accepted, cursor, minIntervalMs }`, where `minIntervalMs` comes from env
   `OTEL_REALTIME_MIN_INTERVAL_MS` (default 5000; values below 5000 count as 5000).

Ownership of realtime-only sessions:
- `findSessionOwnerId` (`logs.service.ts:119-142`) falls back to `otel_session_state.user_id`
  when `logs` and `logs_otel` know no owner. This additive branch lets the upload path also
  reject a second user writing into a realtime-only session.
- The route is synchronous, with no upload queue. It shares the hook parser and its
  `HOOK_API_BODY_LIMIT` = 1 MiB (`server/src/common/body-limits.ts:20`).

**DD-18 — Intervals and timezone (`pickOtelInterval`, pure TS).**
- Repository: ≤ 24 h → `5m`, ≤ 14 d → `1h`, else `1d`.
- Session: ≤ 24 h → `5m`, else `1h`.
- `tz` is an IANA name validated with `new Intl.DateTimeFormat('en', { timeZone })` (400 if
  invalid); the default is `UTC`.
- SQL rolls up with `date_trunc(unit, bucket_start, $tz)`. 5-minute UTC buckets roll up exactly
  into every current offset, since all are multiples of 15 min.

**DD-19 — Server-rolled buckets.**
- All three UI routes take `interval` / `stackBy` / `tz` and return rolled buckets.
- A session delta maps 5-minute rows with `seq > since` to their rolled starts and returns the
  full values of only those buckets.
- A change of `interval`, `stackBy`, `tz` or any filter refetches a snapshot.

**DD-20 — Polling.**

| Tab | Interval | Polls while |
|---|---|---|
| Session | `OTEL_SESSION_POLL_MS` = 5000 | the page is visible, there was input within `OTEL_IDLE_STOP_MS` = 600000, and `status.live` is true (any `rt_last_at` / `chunk_last_at` within `OTEL_SESSION_ENDED_MS` = 600000) |
| Repository, team | `OTEL_REPO_POLL_MS` = 30000 | the period end ≥ now, plus the same visibility and idle rules |

- Every tab also stops while the user's Pause is on (FR-28); Resume and the return from a hidden
  tab send one catch-up request.
- On return the session tab sends one `since=` catch-up.
- The repository and team tabs re-read their snapshot (no `since=`). Each bucket carries
  `changeKind` = the `change_kind` of its newest (max-`seq`) underlying row; a bucket is
  highlighted only when its value grew since the previous snapshot **and** that kind is `new` or
  `update`. `confirm`, `fill` and `reclass` changes are applied silently (FR-6a, FR-32).
- The client constants live in `client/src/viewer/pages/repository/otel/otel.constants.ts`.

**DD-21 — `query_source` dictionary.** A code constant in
`server/src/logs/otel/otel-query-source-dictionary.ts`, `{ name, description, hidden }[]`. Its
visible names must equal `TRANSCRIPT_QUERY_SOURCES`, asserted by an `otel-facts.md` row. An
unseen name gives `known: false`, and the UI shows a "new" chip.

**DD-22 — Privacy and masking.**
- Span `attributes` are stored raw, as `logs_otel.body` already is.
- For a `team-no-prompts` caller viewing another member's session, `attributes` are dropped
  (`attributesMasked: true`) and `firstPrompt` is masked with `maskFirstPrompt`
  (`server/src/logs/team-scope.ts:60`), as `okf-usage.service.ts:451` does.

**DD-23 — Trace opt-in (FR-11, FR-23).**
- `install`: `--otel-traces=yes|no` if given; else a TTY `[Y/n]` prompt; else yes.
- `upgrade`: the stored `otelTraces` in `log-hub.json` if present, without asking; else a TTY
  prompt; else yes.
- The answer is stored as `otelTraces: boolean` in `log-hub.json`.
- `yes` merges `OTEL_TRACE_ENV_KEYS(port)` via `mergeOtelEnv` (`install.ts:2043`). `no` and
  uninstall strip only owned trace keys via `stripOwnedOtelEnvKeys` (`:2132`).
- `OTEL_ENV_KEYS` stays unchanged, so `docker-dev/provision.mjs` is unaffected.

**DD-24 — Trace keys and their ownership.**

| Key | Value | Owned when |
|---|---|---|
| `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` | `1` | value is `1` |
| `OTEL_TRACES_EXPORTER` | `otlp` | value is `otlp` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | `http://127.0.0.1:<port>/v1/traces` | matches `OTEL_LOOPBACK_ENDPOINT_RE`, extended to traces |

Code changes:
- `install.ts`:
  - `isOtelEndpointKey` (`:1583`) also accepts the traces endpoint;
  - `isArtisynOwnedOtelValue` (`:1594`) looks up the expected value in
    `{ ...OTEL_ENV_KEYS(0), ...OTEL_TRACE_ENV_KEYS(0) }`;
  - the "every endpoint key in the same env is ours" rule includes the traces endpoint when present.
- `env-context.js`: a traces regex at `:381`, and traces added to the port-mismatch check at
  `:443-458`.
- `otel-endpoint-check.js`: checks traces only when `otelTraces === true`.

**DD-25 — Lifecycle and data retention.**
- **Cascade and purge.**
  - All five new tables cascade on a hard delete of `sessions`; `logs_otel` already does
    (`0045`).
  - `purgeSessionChildData` (`sessions.service.ts:175`), shared by soft delete, hard delete,
    admin family delete and retention, deletes `otel_session_state` first (DD-2), then
    `otel_calls`, `otel_spans`, `otel_cost_buckets` and `otel_reclass_queue`.
- **Retention eligibility.**
  - `hardPurgeExpiredSessions` (`sessions.service.ts:339-366`) picks only roots that have
    `logs` rows, by `min(logs.created_at)`.
  - A second, additive query selects roots with `deleted = false`, `parent_session_id IS NULL`,
    no `logs` rows (`NOT EXISTS`) and `otel_session_state.created_at < cutoff`, oldest first.
    It fills the rest of `batchSize`.
  - Those roots go through the existing per-root purge loop. The existing query is unchanged.
- **Retention stats.** `getRetentionStats` adds an `otelOnlySessions` count. The field is
  additive, and the admin Data Retention tab shows it.
- **Account deletion.** `account-deletion.service.ts:136-193` collects a user's sessions from
  `logs`. It additionally collects roots whose `otel_session_state.user_id` is the user and
  that have no `logs` rows.
- **Repository removal.** `AdminService.removeRepo` (`admin.service.ts:316-332`) needs no
  change: a realtime-only session has no repository link, and it ages out by retention or account
  deletion.
- **Soft-deleted sessions.** Writers check `deleted` inside the transaction after the state lock
  (DD-2), so a deleted session never regrows OTEL rows. Sessions deleted while an old server build
  ran are cleaned by DD-16 step 5.
- **Export/import** carries no OTEL; imported sessions show the "no OTEL" empty state, which is
  documented.
- **Hook.** Only today's chunk files, pruned by `otelRetentionDays`. The realtime buffer is
  memory only.
- **Data volume.** `summarizeOtelChunk` counts every line in `recordCount` (`otel-chunk.ts:227`),
  so `spans` lines raise `logs_otel.record_count` and the chunk volume on old and new servers.
  This is accepted and documented in `otel-tabs.md`.

**DD-26 — Tab placement.**
- Repository tabs: Sessions | Analytics | Reports | Tools/MCP | OKF | **OTEL** | Settings, with
  the same `canSeeTeamWideTabs` rule as OKF.
- Session tabs: OTEL is rightmost, and the `tab-ids.ts:35` comment is updated.

**DD-27 — Compatibility matrix: code path and checking step.**

| Hook × Server | Code path | Scenario step |
|---|---|---|
| old, no OTEL × new | no state row → `hasOtel=false` → empty state A | `s-otel-01` "no-OTEL session"; `s-compat-01` "1.6.2 session: OTEL tab empty, other tabs unchanged" |
| old, OTEL logs × new | chunk upload unchanged → projection drain → charts; no spans; `rt_last_at` NULL → slow `old-hook` banner + no-traces state B | `s-compat-01` "frozen 2.28.0 hook session" |
| new × old | realtime POST → 404 → disabled for 1 h; chunks as today, spans lines and `hookVersion` ignored by `summarizeOtelChunk` | `s-hook-01` "fake old hub: realtime 404 once, uploads succeed, no retries" |
| new × old → upgrade | spans are in `logs_otel.body`; the new column is NULL → the projection extracts them | `s-otel-01` "logs_otel rows with span lines, as stored by an old server → waterfall after the drain" |
| new × new, server unreachable for a while | realtime backoff + cap; chunks stay on disk; later upload → projection `fill` → notice | `s-otel-01` "gap then fill" |
| new × new | full path | `s-otel-01` live steps; `s-hook-07` `/v1/traces` + realtime |

**DD-28 — Tiles, previous period, cost flow (FR-24…FR-29).** No new table, column or hook change.
- **Token sums.** The repository `kpis` gain `inputTokens`, `outputTokens`, `cacheReadTokens` and
  `cacheWriteTokens` (Σ over the filtered buckets) and `perUserCostUsdMicros` (total / `users`,
  NULL when `users` = 0). Cache read ratio (FR-25) is computed on the client from them; NULL
  denominator → `n/a`. The session tab sums its `calls` on the client (FR-29), so the session
  route is unchanged.
- **Previous period (FR-24).** The facts route runs the same KPI aggregate over
  `[from − (to − from), from)` with the same filters and returns it as `kpisPrev` (NULL when that
  window has no buckets). The client computes the change: relative for amounts and counts,
  percentage points for `hiddenShare`; none when `kpisPrev` is NULL or the previous value is 0.
  Sparklines are drawn on the client from `buckets` (summed per bucket start), so they need no
  field; only the total-cost, per-day, API-calls and hidden-cost tiles have one (buckets carry no
  distinct-session count). `kpisPrev` is not part of the `since=` delta: the repository tab re-reads the snapshot
  every 30 s (DD-20).
- **Cost flow (FR-26).** `flows: OtelFlowRow[]` = `{ model|null, userEmail|null, branch|null,
  repository|null, other, costUsdMicros, calls, sessions }` (`repository` is filled by the team
  route only, DD-29), one row per `(model, user, branch)`:
  `otel_cost_buckets` of the scoped roots in `[from, to)` with the chart's filters,
  `GROUP BY model, user_id, branch`, where `branch` = `logs.git_branch` of the root session's
  `artisyn` log (DD-6 scope already requires that log, so `branch` is NULL only when the log
  carries no `git_branch`, e.g. a session outside a git checkout). Per session, not per call
  (owner's decision, worktrees). Capped at `OTEL_FLOWS_LIMIT` = 500 rows by cost; the rest is
  folded into one row with `other: true` (its model / user / branch are NULL and mean "other"). The client folds a `null` branch into "(unknown)" and builds the columns: model → user →
  branch in a team context (`teamId` set, DD-6), model → branch in a private repository (one person,
  the user column is dropped and its rows merged). The route returns the same `flows` shape in both.
- **Sankey drawing.** A custom SVG component (`OtelCostFlow.tsx`, no new dependency: the client
  has `d3@7`, which has no sankey module, and only three fixed columns are needed). Layout: nodes
  sorted by cost descending per column, height ∝ cost on one scale for all columns, a 12 px gap,
  bands ≥ 1 px, a band coloured by its source node. Hovering a band shows its row's cost, share,
  calls and sessions; hovering a node shows cost, share and calls only (summing `sessions` over
  rows would count a session with two models twice); no click action.
- **Tooltip and Pause (FR-27, FR-28).** The chart tooltip sorts the series by value; Pause is a
  `paused` flag in `useOtelLivePoll` that stops the timer, and Resume runs one catch-up poll
  exactly like the return from a hidden tab (DD-20).

**DD-29 — Team OTEL tab (FR-33, FR-34).**
- **Route.** `GET /api/v1/teams/:teamId/otel/facts` in a new `otel-team-facts.controller.ts`
  (`@Controller('api/v1/teams')`, `SessionAuthGuard`). Parameters = the repository facts' plus
  `repoId[]` and `userId[]` filters and `stackBy=person|repository|structure|model|querySource`.
- **Scope.** The team's repositories (`team_repositories`), each resolved through the same
  `scopedTreeCtes` as DD-6 with the caller's team scope (`visibleUserIds` from
  `RepositoriesService.resolveTeamScope()`, `server/src/logs/team-scope.ts`), then `DISTINCT`
  root ids. Access is the analytics gate (FR-34, DD-6): 403 when `teamScope.analyticsAllowed`
  is false, as in `usage-analytics.controller.ts:222`, so in a `restricted` team only the owner and
  managers get data (the acknowledged members) and a plain member or an ADLC trainer without the
  manager flag gets 403; a `transparent` team shows everyone to everyone. Non-members get 403.
  On the client the team OTEL tab is hidden for those roles (the `canSeeTeamWideTabs` rule of
  DD-26 applied to `TeamDetailPage`), and a direct link shows "No access".
- **Counting.** Totals, KPIs, buckets, `people` and `flows` aggregate the distinct roots, so a
  session linked to two team repositories counts once. Only the `repositories` rows count a session
  in each repository it is linked to; the table footer says so.
- **Response** = `RepoOtelFactsResponse` (DD-28 fields included) with:
  - `buckets.key` per `stackBy`; `person` keys are user ids, `repository` keys repository ids;
  - `flows` rows filled with `repository` (`(model, user, repository, branch)`), the client
    shows model → person → repository or model → person → repository · branch;
  - `people: { userId, email, sessions, costUsdMicros, hiddenCostUsdMicros, cacheReadTokens,
    inputTokens, cacheWriteTokens, models[], repositories, live, trend: number[] }[]`
    (`repositories` = how many of the team's repositories the person has sessions in; trend =
    per-bucket cost);
  - `repositories: { repoId, repoUrl, people, sessions, costUsdMicros, hiddenCostUsdMicros,
    liveSessions }[]`;
  - `sessions` is omitted (the People / Repositories tables replace it);
  - `kpis.perActivePersonCostUsdMicros` and `kpis.repositories` / `kpis.repositoriesLive`.
- **People folding.** The client shows the top `OTEL_TEAM_TOP_PEOPLE` = 5 people by cost in the
  chart legend and the Sankey and folds the rest into "others (N)"; the People table lists every
  person.
- **Filter options.** `filterOptions` gains `people: { userId, email }[]` and
  `repositories: { repoId, repoUrl }[]`, built from the caller's visible scope **without** the
  person / repository filters, so the pickers keep every choice after a People-row click.
- **Other rules.** Interval options are the repository tab's (auto / 5 min / 1 h / 1 d, DD-18).
  The slow banner uses the highest `repositories.hook_version` over the team's repositories
  (DD-15). With no OTEL data the tab shows empty state A, and with none in the period state C, in
  team wording. The FR-25 "per user" tile is not repeated (it equals "per active person").
- **Client.** `TeamDetailPage` gains an "OTEL" tab (its tab state stays local `useState`, as
  today). `client/src/viewer/pages/teams/otel/TeamOtelTab.tsx` composes the shared
  `OtelFilterStrip` (with repository / people pickers), `OtelCostChart`, `OtelKpiTiles`,
  `OtelCostFlow`, `OtelRealtimeNotice`, `OtelLiveIndicator`, plus `OtelPeopleTable.tsx` and
  `OtelRepositoriesTable.tsx`; a Repositories row navigates with `routes.teamRepo(teamId, repoId)`
  and `tab=otel`. Same 30 s snapshot polling and highlight rule as the repository tab (DD-20).

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `server/drizzle/migrations/0078_otel_tabs_traces.sql` | new tables, `logs_otel` column, indexes | per Database changes |
| `server/drizzle/migrations/meta/_journal.json` | entry 0078 | then `npm run migrations:lock` |
| `server/src/database/schema/index.ts` | `otelCalls`, `otelSpans`, `otelCostBuckets`, `otelSessionState`, `otelReclassQueue`, `logsOtel.otelProjectionVersion` | near `:341`, `:386` |
| `server/src/database/database-init.ts` | re-mark `otel_projection_version` below the current version | like the tool-usage step `:149` |
| `server/src/common/body-limits.ts` | add `api/v2/otel-realtime` POST to `HOOK_API_ROUTES` + doc comment | shares `HOOK_API_BODY_LIMIT` |
| `server/src/logs/otel-chunk.ts` | `export` `attributesOf`, `stringAttrOf`, `costMicrosOf` (no logic change) | DD-8 |
| `server/src/logs/logs.service.ts` | `otelProjectionVersion: null` in the `logs_otel` conflict set (`:1212`); queue insert after `:432`, `:1084` | DD-5, DD-16 |
| `server/src/logs/repositories.service.ts` | queue insert after `:1438` | DD-5 |
| `server/src/sessions/sessions.service.ts` | purge new tables (`:175`); OTEL-only eligibility in `hardPurgeExpiredSessions` (`:339-366`); `otelOnlySessions` in `getRetentionStats` | DD-25 |
| `server/src/users/account-deletion.service.ts` | also collect OTEL-only roots of the user (`:136-193`) | DD-25 |
| `server/src/logs/logs.service.ts` (`findSessionOwnerId`, `:119-142`) | fallback to `otel_session_state.user_id` | DD-17 |
| `server/src/logs/tool-monitoring/tool-usage-read.sql.ts` | `export` `scopedTreeCtes` (`:147`), no logic change | DD-6 |
| `client/src/viewer/pages/admin/tabs/AdminDataRetentionTab.tsx`, `client/src/models/admin.ts` | show `otelOnlySessions` | DD-25 |
| `tests/scenarios/helpers/time-shift.ts` | `shiftSessionTree` (`:104`) also shifts `otel_session_state.created_at` and `logs_otel.created_at` | retention steps |
| `tests/scenarios/sessions/s-slife-08.spec.ts` | retention steps | DD-25 |
| `docs/knowledgebase/data-retention.md` | OTEL tables in purge list; OTEL-only root eligibility | DD-25 |
| `server/src/logs/otel/otel-facts.constants.ts` | server constants | Chunk 1 |
| `server/src/logs/otel/otel-span-names.ts` | span names | DD-10 |
| `server/src/logs/otel/otel-records.ts` | `resolveOtelEventTime`, `otelCallKey`, `extractOtelCalls`, `extractOtelSpans` | pure |
| `server/src/logs/otel/otel-classify.ts` | `classifyOtelCall`, `bucketStart5m`, `pickOtelInterval` | pure |
| `server/src/logs/otel/otel-query-source-dictionary.ts` | dictionary + `lookupQuerySource` | DD-21 |
| `server/src/logs/otel/otel-facts.types.ts` | realtime request/response + UI response types | API changes |
| `server/src/logs/otel/otel-facts-writer.ts` | `lockOtelState`, `enqueueOtelReclass`, `upsertOtelCalls`, `upsertOtelSpans`, `recomputeSpanRollups`, `applyOtelLines`, `reclassifyOtelSession`, `rebuildOtelBuckets` | DD-2…DD-11 |
| `server/src/logs/otel/otel-realtime.service.ts`, `otel-realtime.controller.ts` | hook route | DD-17; pattern `server/src/logs/session-attribution/session-attribution.controller.ts:25` (`ApiKeyAuthGuard`) |
| `server/src/logs/otel/otel-projection.service.ts` | drain | DD-16 |
| `server/src/logs/otel/otel-facts-read.sql.ts`, `otel-facts.reader.ts`, `otel-facts.controller.ts` | UI routes | DD-6, DD-19 |
| `server/src/logs/otel/otel-team-facts.controller.ts` | team route | DD-29 |
| `server/src/logs/logs.module.ts` | register controllers and services | `:78` |
| `server/src/logs/otel/otel-facts.algo.spec.ts` | table test | |
| `server/test/contract/registry/f25-otel.ts`, `registry/index.ts`, `server/test/contract/f25.contract-spec.ts` | contract rows + spec | pattern `f24` |
| `server/test/contract/fixtures/world-v1.sql.ts` | OTEL rows for an owner session and a team-repo session | |
| `server/perf-tests/scenarios.ts` | perf cases (measurement, not a test) | |
| `hook/.claude/telemetry_tool/otel-receiver.js` | `/v1/traces`, `walkSpans`, `hookVersion` line field, realtime sender, `readRealtimeTarget`, exported `nextRealtimeDelay` | DD-13 |
| `hook/.claude/telemetry_tool/env-context.js` | traces regex, port check, `otelRealtime` + `otelTraces` defaults and the table comment | DD-24 |
| `hook/.claude/telemetry_tool/otel-endpoint-check.js` | optional traces key | DD-24 |
| `hook/.claude/telemetry_tool/version.json` | 2.29.0 | |
| `hook/.claude/telemetry_tool/__tests__/otel-realtime.algo.test.js` | table test for `nextRealtimeDelay` | |
| `hook/README.md` | "Other channels → OTEL export": traces, realtime channel, how to turn off | shipped, offline |
| `artisyn-hooks-installer/src/otel-env.ts` | `OTEL_TRACE_ENV_KEYS`, `OTEL_TRACE_ENDPOINT_KEY` | DD-23 |
| `artisyn-hooks-installer/src/install.ts` | ownership, prompt, merge/strip, config type | DD-23, DD-24 |
| `artisyn-hooks-installer/src/index.ts` | `--otel-traces` for `install` | |
| `.artisyn/marketplace/plugins/log-hub-hooks/scripts/*`, `.claude-plugin/plugin.json` | dogfood refresh | `.claude/rules/hook.md` |
| `INSTALL_HOOK.md` | via the `update-install-instructions` skill | |
| `tests/fixtures/legacy-hooks/2.28.0/`, `tests/fixtures/legacy-hooks/README.md` | frozen hook + row | `--commit b61f344 --label 2.28.0` |
| `tests/scenarios/helpers/hook-process.ts` | blank `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` in `fakeHomeEnv` (`:180`) | |
| `client/src/models/repositories.ts` | UI types + `fetchRepoOtelFacts`, `fetchSessionOtel` | |
| `client/src/models/teams.ts` | team response types + `fetchTeamOtelFacts` | DD-29 |
| `client/src/viewer/pages/teams/TeamDetailPage.tsx`, `client/src/viewer/pages/teams/otel/` (`TeamOtelTab.tsx`, `OtelPeopleTable.tsx`, `OtelRepositoriesTable.tsx`) | team OTEL tab | DD-29 |
| `client/src/viewer/tab-ids.ts`, `SessionTabBar.tsx`, `SessionDetailPane.tsx`, `RepositoryView.tsx`, `useRepositoryViewState.ts` | tab wiring | DD-26 |
| `client/src/viewer/pages/repository/otel/` | `otel.constants.ts`, `otel-url-state.ts`, `otel-merge.ts`, `otel-format.ts`, `useOtelLivePoll.ts`, `OtelCostChart.tsx`, `OtelChartControls.tsx`, `OtelFilterStrip.tsx`, `OtelKpiTiles.tsx`, `OtelStructureSection.tsx`, `OtelQuerySourceTable.tsx`, `OtelSessionsTable.tsx`, `OtelEmptyState.tsx`, `OtelSlowUpdatesBanner.tsx`, `OtelRealtimeNotice.tsx`, `OtelLiveIndicator.tsx`, `OtelCostFlow.tsx`, `otel-cost-flow-layout.ts`, `RepoOtelTab.tsx`, `otel-merge.algo.test.ts` | DD-28 for the cost flow |
| `client/src/viewer/pages/repository/session-log/otel/` | `otel-trace-assembly.ts`, `TraceNavigator.tsx`, `TraceMinimap.tsx`, `TraceWaterfall.tsx`, `SpanDetailsPanel.tsx`, `SessionOtelTab.tsx`, `otel-trace-assembly.algo.test.ts` | |
| `docs/knowledgebase/algorithms/otel-facts.md`, `otel-trace-assembly.md`, `otel-delta-merge.md`, `otel-realtime-backoff.md`, `algorithms/README.md` | algorithm docs | |
| `docs/knowledgebase/otel-tabs.md`, `index.md`, `otel-receiver.md`, `hook-api-versioning.md`, `hook-installation.md`, `db-tables.md`, `llm-call-math.md`, `api-reference.md`, `server-endpoint-map.md` | KB | |
| `user-docs/otel-tab.md`, `user-docs/nav.json`, `user-docs/connect-repository.md` | offline help | |
| `tests/scenarios/fixtures/otel/` | synthetic OTEL logs/spans lines (no real data) | |
| `tests/scenarios/view/s-otel-01.spec.ts` | new scenario | |
| `tests/scenarios/hook/s-compat-01.spec.ts`, `s-hook-01.spec.ts`, `s-hook-07.spec.ts`, `installer/s-inst-01.spec.ts`, `installer/s-inst-04.spec.ts`, `tours/screen-registry.ts` | new steps | |

## API changes

**Hook route `POST /api/v2/otel-realtime`**

Added to `HOOK_API_ROUTES` (`server/src/common/body-limits.ts`, plus its doc comment). It uses
`ApiKeyAuthGuard`, the shared `HOOK_API_BODY_LIMIT`, and accepts gzip like the other hook routes.
```ts
// request
{ sessionId: string; hookVersion: string; receiverId: string; batchSeq: number;
  droppedLines: number; lines: object[] }   // the exact chunk-line objects {signal, receivedAt, resource, scope, record, hookVersion}
// response 200
{ accepted: { calls: number; spans: number }; cursor: string; minIntervalMs: number;
  ignored?: 'deleted' }
```
- 400: malformed body, or `lines` over `OTEL_REALTIME_MAX_LINES` = 5000.
- 401: bad key.
- 409: foreign session.
- 413: over the limit.

The hook treats 404 as "old server" (DD-13).

The repository and session UI routes are under `@Controller('api/v1/repositories')` +
`SessionAuthGuard`, with the DD-6 private `resolveReadScope` and an optional `teamId`; the team
route (below) is under `api/v1/teams`.
- `:sessionId` is the Claude session UUID string (as in `okf-usage`), resolved to its root
  (DD-1).
- `calls=transcript` means `structure IN ('main','subagent')`; `calls=hidden` means `'hidden'`.

**`GET /api/v1/repositories/:repoId/otel/facts`**

Query parameters:

| Parameter | Type | Rules |
|---|---|---|
| `from`, `to` | ISO | required; `to > from`; span ≤ `OTEL_MAX_PERIOD_DAYS` = 93 |
| `model[]`, `ccVersion[]` | string[] | |
| `calls` | `all` \| `hidden` \| `transcript` | |
| `interval` | `auto` \| `5m` \| `1h` \| `1d` | |
| `stackBy` | `structure` \| `querySource` \| `model` \| `ccVersion` | |
| `tz` | IANA name | |

```ts
RepoOtelFactsResponse {
  interval: '5m'|'1h'|'1d'; tz: string; generatedAt: string;
  hasOtel: boolean; hasOtelInPeriod: boolean;            // false/… → empty state A; true/false → C
  slowUpdates: boolean; hookVersion: string | null;      // DD-15
  realtime: { unconfirmedCalls: number; realtimeSessions: number;
              chunkDelayedSessions: number; gapSessions: number };          // DD-14
  buckets: OtelBucket[];        // { start, key, calls, costUsdMicros: string, tokens: string, changeKind: OtelChangeKind }
                                //   changeKind = kind of the newest (max-seq) underlying row, DD-20
  kpis: { totalCostUsdMicros, activeDays, perDayCostUsdMicros, perSessionCostUsdMicros,
          medianSessionCostUsdMicros, apiCalls, modelCount, hiddenCostUsdMicros, hiddenCalls,
          hiddenShare, sessions, users, perUserCostUsdMicros,
          inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };   // DD-28
  kpisPrev: RepoOtelFactsResponse['kpis'] | null;                         // previous period, DD-28
  flows: OtelFlowRow[];         // { model|null, userEmail|null, branch|null, repository|null (team route only),
                                //   other: boolean, costUsdMicros, calls, sessions }, DD-28 / DD-29
  querySources: OtelQuerySourceRow[]; // { querySource, description|null, known, hidden, calls, sessions,
                                      //   costUsdMicros, share, hiddenShare, contextToOutput|null, models[] }
  filterOptions: { models: string[]; ccVersions: string[] };
  sessions: OtelSessionRow[];   // ≤ OTEL_SESSIONS_LIMIT=200, newest first: { sessionId, startedAt, firstPrompt|null,
                                //   userEmail|null, ccVersion|null, calls, costUsdMicros, hiddenCostUsdMicros,
                                //   hasTraces, live, unconfirmedCalls }
}
```
- `firstPrompt` is the root `claude` log's `logs.first_prompt`, masked per DD-22.
- `userEmail` is `users.email` via `sessions.user_id`.
- `tokens` = input + output + cache read + cache write.
- `OtelChangeKind` = `'new'|'update'|'confirm'|'fill'|'reclass'`.

**`GET /api/v1/repositories/:repoId/sessions/:sessionId/otel`** (`interval=auto|5m|1h`,
`stackBy=structure|querySource|model`, `tz`, `since`)
```ts
SessionOtelResponse {
  cursor: string; full: boolean; interval: '5m'|'1h';
  status: { hasOtel: boolean; hasSpans: boolean; live: boolean; slowUpdates: boolean;
            slowReason: 'old-hook'|'realtime-off'|null; otelHookVersion: string|null;
            attributesMasked: boolean;
            realtime: { active: boolean; unconfirmedCalls: number; unconfirmedSpans: number;
                        lastRealtimeAt: string|null; lastChunkAt: string|null;
                        chunkDelayed: boolean; gap: boolean } };
  buckets: OtelBucket[];
  calls: OtelCallRow[];   // { callKey, requestId|null, querySource|null, model|null, eventTime, structure, provisional,
                          //   confirmed, costUsdMicros|null, inputTokens, outputTokens, cacheReadTokens,
                          //   cacheWriteTokens, agentId|null, promptId|null, changeKind }
  spans: OtelSpanRow[];   // { traceId, spanId, parentSpanId|null, name, startTime, endTime|null, requestId|null,
                          //   agentId|null, querySource|null, context|null, costUsdMicros|null,
                          //   rollupCostUsdMicros|null, hidden: boolean|null, confirmed,
                          //   attributes: object|null, changeKind }
  kpis: { totalCostUsdMicros, hiddenCostUsdMicros, hiddenCalls, apiCalls,
          subagentCostUsdMicros, subagentShare } | null;   // null in an empty delta
  querySources: OtelQuerySourceRow[] | null;
}
```
- **Empty-delta fast path:** when `since` equals the state's seq, one primary-key read answers
  with empty arrays and `kpis: null`.
- A session outside the scope answers with an empty response and `hasOtel: false`, never 404.

**`GET /api/v1/teams/:teamId/otel/facts`** (team route, `@Controller('api/v1/teams')` +
`SessionAuthGuard`, DD-29). Parameters = the repository facts' (`from`, `to`, `model[]`,
`ccVersion[]`, `calls`, `interval`, `tz`) plus `repoId[]`, `userId[]` and
`stackBy=person|repository|structure|model|querySource`. 403 for a non-member and when
`analyticsAllowed` is false (FR-34); 400 as the repository route, and for an unknown `stackBy`.
```ts
TeamOtelFactsResponse = Omit<RepoOtelFactsResponse, 'sessions' | 'filterOptions'> & {
  kpis: RepoOtelFactsResponse['kpis'] & { perActivePersonCostUsdMicros: string;
                                          repositories: number; repositoriesLive: number };
  // flows rows carry `repository` (repo URL); buckets.key = user id / repository id for person / repository
  filterOptions: { models: string[]; ccVersions: string[];
                   people: { userId: number; email: string }[];          // scope without person/repo filters
                   repositories: { repoId: number; repoUrl: string }[] };
  people: { userId, email, sessions, costUsdMicros, hiddenCostUsdMicros, inputTokens, cacheReadTokens,
            cacheWriteTokens, models: string[], repositories: number, live: boolean, trend: number[] }[];
  repositories: { repoId, repoUrl, people, sessions, costUsdMicros, hiddenCostUsdMicros, liveSessions }[];
}
```

No existing route, parameter, upload kind or chunk line type changes (FR-18).

## Database changes

Migration `server/drizzle/migrations/0078_otel_tabs_traces.sql`:
- hand-written, with every statement guarded (`IF NOT EXISTS`) and no `CONCURRENTLY`;
- a `0076`-style header: purpose, additive-only, lock/rewrite profile, implicit backfill;
- a `_journal.json` entry, then `npm run migrations:lock`;
- follows the `migrations-data-integrity` skill.

**`logs_otel`:**
- `ADD COLUMN IF NOT EXISTS otel_projection_version smallint`. It is nullable with no default, so
  there is no table rewrite. Every existing row starts pending, which is the implicit backfill.
- Partial index `idx_logs_otel_projection_pending (id) WHERE otel_projection_version IS NULL`.
- Value semantics: NULL = pending, `-1` = failed (retried after the startup re-mark), `N` = projected
  with version N.

**`otel_calls`:**

| Column | Type |
|---|---|
| `session_id` | int NOT NULL, FK → `sessions` ON DELETE CASCADE |
| `call_key` | varchar(300) NOT NULL |
| `request_id` | varchar(255) |
| `query_source` | varchar(255) |
| `model` | varchar(255) |
| `claude_code_version` | varchar(64) |
| `prompt_id` | varchar(255) |
| `agent_id` | varchar(255) |
| `event_time` | timestamptz NOT NULL |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` | bigint NOT NULL DEFAULT 0 |
| `cost_usd_micros` | bigint |
| `structure` | varchar(16) NOT NULL, `CHECK IN ('main','subagent','hidden')` |
| `provisional` | boolean NOT NULL |
| `source_mask` | smallint NOT NULL |
| `first_seq` | bigint NOT NULL |
| `seq` | bigint NOT NULL |
| `change_kind` | varchar(8) NOT NULL |

Indexes:
- PK `(session_id, call_key)`
- `(session_id, seq)`
- `(session_id, request_id) WHERE request_id IS NOT NULL`

**`otel_spans`:**

| Column | Type |
|---|---|
| `session_id` | int NOT NULL, FK → `sessions` ON DELETE CASCADE |
| `trace_id` | varchar(64) NOT NULL |
| `span_id` | varchar(32) NOT NULL |
| `parent_span_id` | varchar(32) |
| `name` | varchar(255) NOT NULL |
| `start_time` | timestamptz NOT NULL |
| `end_time` | timestamptz |
| `request_id` | varchar(255) |
| `agent_id` | varchar(255) |
| `query_source` | varchar(255) |
| `context` | varchar(32) |
| `attributes` | jsonb NOT NULL DEFAULT '{}' |
| `cost_usd_micros` | bigint |
| `rollup_cost_usd_micros` | bigint |
| `source_mask` | smallint NOT NULL |
| `first_seq` | bigint NOT NULL |
| `seq` | bigint NOT NULL |
| `change_kind` | varchar(8) NOT NULL |

Indexes:
- PK `(session_id, trace_id, span_id)`
- `(session_id, seq)`
- `(session_id, request_id) WHERE request_id IS NOT NULL`

**`otel_cost_buckets`:**

| Column | Type |
|---|---|
| `session_id` | int NOT NULL, FK → `sessions` ON DELETE CASCADE |
| `user_id` | int, FK → `users` ON DELETE SET NULL |
| `bucket_start` | timestamptz NOT NULL |
| `structure` | varchar(16) NOT NULL |
| `query_source`, `model` | varchar(255) NOT NULL DEFAULT '' |
| `cc_version` | varchar(64) NOT NULL DEFAULT '' |
| `calls` | int NOT NULL DEFAULT 0 |
| `cost_usd_micros`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` | bigint NOT NULL DEFAULT 0 |
| `seq` | bigint NOT NULL |
| `change_kind` | varchar(8) NOT NULL |

Indexes:
- PK `(session_id, bucket_start, structure, query_source, model, cc_version)`
- `(session_id, seq)`
- `(user_id)`

**`otel_session_state`:**

| Column | Type |
|---|---|
| `session_id` | int PK, FK → `sessions` ON DELETE CASCADE |
| `user_id` | int, FK → `users` ON DELETE SET NULL |
| `seq` | bigint NOT NULL DEFAULT 0 |
| `transcript_seq` | bigint |
| `otel_hook_version` | varchar(32) |
| `has_spans` | boolean NOT NULL DEFAULT false |
| `has_provisional` | boolean NOT NULL DEFAULT false |
| `rt_last_at`, `chunk_last_at`, `rt_gap_at` | timestamptz |
| `rt_receiver_id` | varchar(64) |
| `rt_batch_seq` | bigint |
| `created_at` | timestamptz NOT NULL DEFAULT now() |

Indexes:
- `(user_id)`
- `(created_at)`, for the retention eligibility query (DD-25)

**`otel_reclass_queue`:**

| Column | Type |
|---|---|
| `session_id` | int PK, FK → `sessions` ON DELETE CASCADE |
| `queued_at` | timestamptz NOT NULL DEFAULT now() |

## Test coverage plan

Only the three kinds the policy allows:

- **Algorithm:**
  - `docs/knowledgebase/algorithms/otel-facts.md` → `server/src/logs/otel/otel-facts.algo.spec.ts`.
    Row kinds:
    - `classify`: DD-4, including the AC-18 provisional cases and equality at rest.
    - `eventTime`: DD-8.
    - `callKey`: DD-9 — realtime and chunk give the same key; no-request-id records.
    - `bucket5m`: AC-2.
    - `interval`: DD-18.
    - `spans`: DD-10 caps, unknown attributes, missing ids.
    - `dictionary`: DD-21.
  - `otel-trace-assembly.md` → client `otel-trace-assembly.algo.test.ts`: orphan → re-parent,
    standalone attachment, turn header, AC-19, the time split (AC-24: overlapping sub-agent LLM
    call and main-thread tool, running turn, waiting inside a tool) and turn ordering (FR-30).
  - `otel-delta-merge.md` → client `otel-merge.algo.test.ts`: merge by key; the DD-3 client table, including realtime + confirm within one poll; empty delta.
  - `otel-realtime-backoff.md` → hook `__tests__/otel-realtime.algo.test.js`: `nextRealtimeDelay`.
- **API contract:** `server/test/contract/registry/f25-otel.ts`, backed by world-v1 OTEL rows.
  - Realtime POST:
    - 200 accepted with `minIntervalMs`;
    - 200 `ignored: 'deleted'`;
    - 400 when `lines` is over `OTEL_REALTIME_MAX_LINES`;
    - 200 replay of the same batch gives the same totals;
    - 401 without a key;
    - 409 foreign session;
    - 413 oversize.
  - Repository facts:
    - 200;
    - 400 bad `tz`;
    - 403 foreign repository;
    - team masking.
  - Session OTEL:
    - 200 snapshot;
    - 200 empty delta;
    - 200 non-empty delta;
    - 200 `full: true` for an unknown cursor;
    - empty answer for a session outside the scope;
    - 403 for a foreign repository.
  - Repository facts also: 400 for a period over 93 days; the 200 row checks `kpisPrev`, the
    token sums and `flows` (a world-v1 session with a git branch and one without → "(unknown)").
  - Team facts (DD-29): 200 for a manager (all acknowledged members, a session linked to two team
    repositories counted once in totals and in both `repositories` rows); 403 for a plain member
    of a restricted team and for an ADLC trainer without the manager flag; 403 for a
    non-member; repository facts with `teamId` give the same 403 to those two roles and 200
    without `teamId`; 400 for an unknown `stackBy`; `filterOptions.people` unchanged by a
    `userId[]` filter.
  - The existing F15 ingest rows stay unchanged (AC-14).
- **Scenario:** a new `tests/scenarios/view/s-otel-01.spec.ts` (new feature), using the synthetic
  lines from `tests/scenarios/fixtures/otel/`. Steps:
  - AC-1–AC-5, AC-9, AC-12, AC-18 and AC-19;
  - AC-21–AC-23 and AC-25: change chip vs the previous period, cache read ratio, Sankey column
    totals and "(unknown)", the user column in a team context and none in the private repository,
    Pause stops polling and Resume sends one catch-up request;
  - AC-6, AC-16 and AC-17: realtime POSTs during an open tab;
  - AC-8 and AC-26: the same realtime batch, then the same lines as a chunk, give no duplicates;
    the badge and the unconfirmed notice show before the chunk, the rows turn confirmed without a
    highlight after it; the same chunk uploaded again changes nothing;
  - "gap then fill" (AC-26): skip `batchSeq` 3 → gap notice; upload chunks → `fill` notice,
    totals equal `telemetry_cost`, waterfall complete;
  - AC-13 upgrade half;
  - the no-OTEL empty state;
  - visual checks without their own AC: the four sparklines (FR-24), the sorted tooltip with share
    bars (FR-27), the "realtime off" slow banner for a 2.29.0 session without realtime data
    (FR-22), the repository banner from `hook_version`, and the indicator pausing after
    `OTEL_IDLE_STOP_MS` of no input with a mocked clock (FR-10b);
  - AC-27 and AC-28: the team tab of a team with two repositories and three people (one session
    linked to both repositories) reconciles with the two repository tabs; a plain member and an
    ADLC-trainer-only caller do not see the OTEL tab on the team page or on the team repository,
    a direct link shows "No access", and the plain member sees their own data in the personal
    repository view; a Repositories row opens the
    repository OTEL tab in the team context; a People row filters the tab and the picker keeps all
    people; the Repository / Branch switch; with seven people the legend and Sankey show five plus
    "others (2)" while the People table lists seven; the team realtime notice and slow banner.
- **Steps in existing scenarios:**
  - `s-compat-01`: AC-10 (2.28.0) and AC-11 (1.6.2).
  - `s-hook-01`: AC-13 old-server half; realtime 404 then silence.
  - `s-hook-07`: `/v1/traces` accepted; realtime POST reaches a fake hub; the unknown-path probe
    `:277` becomes `/v1/unknown`.
  - `s-inst-01` / `s-inst-04`: AC-7 and AC-15; in `s-inst-01` also the "no" answer
    (`--otel-traces=no`) writing none of the three trace keys (FR-11).
  - `s-slife-08`: retention purges OTEL rows with their root; old OTEL-only roots expire; young
    ones stay; realtime to a soft-deleted session is ignored (DD-25).
  - tours registry: `repo.otel`, `session.otel`, `team.otel`.
- **Not a test:** perf cases in `server/perf-tests/scenarios.ts`, a measurement for the NFR. The
  results go into `otel-tabs.md`.

## Visual/UX notes

- Follow the `ui-components` skill and `docs/knowledgebase/ui-principles.md` (light-only, tooltips
  clamped to the viewport, uniform stat-tile hints).
- Every OTEL tab states the cost source next to the chart title: "Claude Code per-call estimate
  (cost_usd)" (NFR Cost).
- **Repository tab, top to bottom** (`repo-otel-tab.svg`):
  1. Title row with the **"Realtime data"** badge and its tooltip (DD-14).
  2. Realtime / slow notices.
  3. Filter strip with the live indicator.
  4. Chart controls.
  5. Chart (legend toggle; tooltip with the parts, the total and the cumulative value).
  6. Six KPI tiles, each with a grey "▲ / ▼ vs previous period" chip; total cost, per day, API
     calls and hidden cost also get a sparkline (not per session or sessions); a second row with
     tokens by type, cache read ratio (fixed 0–100 % bar, `n/a` rule) and per user (DD-28).
  7. Share bars, top 8 + "other (N)"; clicking a row isolates it.
  8. Hidden-call bars.
  9. "Cost flow" Sankey: model → user → branch (of the session) in a team view, model → branch in a
     private repository; hover tooltip.
  10. query_source table.
  11. Sessions table, with an "unconfirmed" chip and "open ›".
  - The live indicator has a Pause / Resume button; the chart tooltip is sorted with share bars.
- **Session tab** (`session-otel-tab.svg`):
  - Header "Cost: Claude Code estimate (cost_usd) · hook X · traces on|off" plus the realtime badge.
  - Notices.
  - Chart: no 1d option.
  - KPIs: OTEL cost, Hidden, API calls, Turns (running), Sub-agents, Waiting for you — turns,
    running turns, sub-agent count, model count and waiting are computed on the client from
    `spans` / `calls`, the rest come from session `kpis`; a third row
    with tokens by type and cache read ratio.
  - Cost by source.
  - Navigator (with the Start / Cost / Slowest order switch), the turn "Time" bar, and minimap.
  - Live indicator with Pause / Resume.
  - Waterfall: unconfirmed rows get a dotted left border; a tooltip says "realtime, not yet
    confirmed".
  - Details panel.
- **Live highlight** (`session-otel-live-update.svg`): `new` and `update` only, by CSS classes
  with no re-mount, faded out after `OTEL_HIGHLIGHT_MS` = 2000. Rows are keyed by `spanId`, and
  expand/selection state lives outside the data.
  - amber outline + delta chip on a changed KPI;
  - outline on the added bar segment;
  - amber "NEW" rows;
  - flash on ancestor Σ values;
  - "↓ N new spans below" pill.
- `fill` rows are not highlighted. They trigger the transient "Filled N calls / M spans" notice.
- Recharts: `isAnimationActive={false}`; the highlight is a custom bar `shape`.
- **Team tab** (`team-otel-tab.svg`, DD-29): title row with members / repositories / access mode /
  the caller's role; filter strip (period, repository, people, model, calls) with live indicator and
  Pause; badge + notice row; chart stacked by person by default; two KPI rows (per active person,
  repositories tile); "Cost flow" model → person → repository with the Repository / Branch switch;
  People table (click filters the tab to that person); Repositories table ("open OTEL ›" opens
  `#/teams/:teamId/repos/:repoId` on the OTEL tab).
- **Empty states** (`otel-empty-states.svg`):
  - A: no OTEL;
  - B: no traces, with the slow banner;
  - C: nothing in the period, offering "Show 1 month" — without the session counts the drawing
    shows (the response has no such counts).
  - Banner and indicator texts come from FR-22 / DD-15 / FR-10b, not from the older wording in
    `otel-empty-states.svg` and `session-otel-live-update.svg` ("Slow updates · data at turn end",
    "Session ended · Stop received"); the indicator also has "Paused · by you" and
    "Slow updates · realtime off".
- Respect `post-impl-check-client-component-size`.

## Wireframes

`team-otel-tab.svg` (new) draws the team tab (FR-33) including the "Realtime data" badge and the
notice row; the repository and session tabs use the same row.

Not drawn on the repository / session wireframes: the "Realtime data" badge and the FR-32 / FR-22
notice row. On both tabs the row sits above the filter strip (repository) or the chart (session) and
uses the banner style of `otel-empty-states.svg`; the "unconfirmed" chip and dotted rows are
described in Visual/UX notes.

`repo-otel-tab.svg` and `session-otel-tab.svg` were updated for FR-24…FR-31 and show the
repository opened from a team ("LogHubLocal · team view", three users): repo markers 4–6 (tile
sparklines and change chips, the token / cache / per-user row, the "Cost flow" card) plus the
sorted tooltip and the Pause button; session markers 5–6 (turn order switch, turn "Time" bar) plus
the token / cache row and the Pause button.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Schema + legacy fixture | 6 | freeze 2.28.0 hook before any hook edit |
| 2 | Pure server functions | 6 | needs 1 |
| 3 | Facts writer | 7 | needs 2 |
| 4 | Realtime ingest route | 6 | needs 3 |
| 5 | Projection drain + existing-path hooks | 8 | needs 3 |
| 6 | UI read SQL + routes | 8 | needs 3 |
| 7 | Hook receiver: traces + realtime | 7 | after 1; server-independent |
| 8 | Installer + hook release | 7 | needs 7 |
| 9 | Client data layer + tab wiring | 7 | needs 6 |
| 10 | Repository OTEL tab UI | 10 | needs 9 |
| 11 | Session OTEL tab UI | 7 | needs 9, 10 |
| 12 | Team OTEL tab | 7 | needs 6, 10 |
| 13 | Docs + help | 7 | needs 4–12 |
| 14 | Algorithm + contract tests | 7 | needs 2, 4, 6, 7, 9, 11, 12 |
| 15 | Scenarios | 8 | needs everything |

### Chunk 1 — Schema + legacy fixture
- [ ] Run `node scripts/scenarios/freeze-legacy-hook.mjs --commit b61f344 --label 2.28.0` before any hook edit, and add a `2.28.0` row ("last hook without traces / realtime") to `tests/fixtures/legacy-hooks/README.md`.
- [ ] Write `server/drizzle/migrations/0078_otel_tabs_traces.sql` per Database changes, with the 0076-style header.
- [ ] Add the 0078 entry to `server/drizzle/migrations/meta/_journal.json` and run `npm run migrations:lock` from `server/`.
- [ ] Add Drizzle definitions `otelCalls`, `otelSpans`, `otelCostBuckets`, `otelSessionState`, `otelReclassQueue` and `logsOtel.otelProjectionVersion` to `server/src/database/schema/index.ts`, per Database changes.
- [ ] Create `server/src/logs/otel/otel-facts.constants.ts` with `OTEL_LIVE_HOOK_MIN_VERSION`, `OTEL_SESSION_ENDED_MS`, `OTEL_CHUNK_DELAY_MS`, `OTEL_PROJECTION_INTERVAL_MS`, `OTEL_PROJECTION_BATCH`, `OTEL_PROJECTION_VERSION`, `OTEL_RECLASS_BATCH`, `OTEL_CLEANUP_BATCH`, `OTEL_REALTIME_MAX_LINES`, `OTEL_REALTIME_MIN_INTERVAL_MS` (env default), `OTEL_MAX_PERIOD_DAYS`, `OTEL_SESSIONS_LIMIT`, `OTEL_FLOWS_LIMIT`, `OTEL_SPAN_ATTRIBUTES_MAX_BYTES` and cursor prefix `v1.`, with values from Design Decisions and API changes.
- [ ] Add a step to `initializeDatabase()` (`server/src/database/database-init.ts`, next to `:149`) that runs `UPDATE logs_otel SET otel_projection_version = NULL WHERE otel_projection_version < $1`.

### Chunk 2 — Pure server functions
- [ ] Create `server/src/logs/otel/otel-span-names.ts` per DD-10, and export `attributesOf`, `stringAttrOf` and `costMicrosOf` from `server/src/logs/otel-chunk.ts` without changing their logic.
- [ ] Create `server/src/logs/otel/otel-records.ts` with `resolveOtelEventTime` (DD-8) and `otelCallKey` (DD-9).
- [ ] Add `extractOtelCalls(lines)` (DD-8) and `extractOtelSpans(lines)` → `{spans, skipped}` (DD-10, caps included) to `otel-records.ts`, plus `maxHookVersion(lines)`.
- [ ] Create `server/src/logs/otel/otel-classify.ts` with `classifyOtelCall` (DD-4), `bucketStart5m` (5-min UTC floor) and `pickOtelInterval(from, to, scope)` (DD-18).
- [ ] Create `server/src/logs/otel/otel-query-source-dictionary.ts` with `lookupQuerySource(name)` → `{description, hidden, known}`, per DD-21.
- [ ] Create `server/src/logs/otel/otel-facts.types.ts` with every request and response type in API changes, including `OtelChangeKind`.

### Chunk 3 — Facts writer
- [ ] Create `server/src/logs/otel/otel-facts-writer.ts` with `lockOtelState(tx, rootId, { create, userId })`, which returns `null` (no row) or `{ nextSeq(), state }` and rolls back on `deleted`, per DD-2.
- [ ] Add `upsertOtelCalls(tx, rootId, calls, source, seq)` to the writer: old rows `FOR UPDATE`, `source_mask` OR, `first_seq` on insert, `change_kind` per DD-3, structure via `classifyOtelCall`, and bucket add/subtract per DD-7.
- [ ] Add `upsertOtelSpans(tx, rootId, spans, source, seq)` to the writer: span cost from `otel_calls`, plus cost updates of existing spans for the batch's calls (DD-11), with `change_kind` per DD-3.
- [ ] Add `recomputeSpanRollups(tx, rootId, traceIds, seq)` to the writer: a recursive CTE per DD-11 that bumps seq only where the rollup changed.
- [ ] Add `applyOtelLines(tx, rootId, userId, lines, source)` to the writer: extract, upsert calls and spans, roll up, then update `has_spans`, `otel_hook_version` (max via `compareSemver`) and, for `source: 'realtime'`, `rt_last_at` (`chunk_last_at` is set by the drain from `logs_otel.created_at`, DD-14 / DD-16).
- [ ] Add `rebuildOtelBuckets(tx, rootId, seq, changeKind)` to the writer per DD-7.
- [ ] Add `reclassifyOtelSession(tx, sessionRowId)` (DD-5 per-id steps 1–7, `has_provisional`) and `enqueueOtelReclass(tx, sessionRowId)` to the writer.

### Chunk 4 — Realtime ingest route
- [ ] Add `{ path: 'api/v2/otel-realtime', method: RequestMethod.POST }` to `HOOK_API_ROUTES` in `server/src/common/body-limits.ts` and to its doc comment. It shares `HOOK_API_BODY_LIMIT`.
- [ ] Create `server/src/logs/otel/otel-realtime.service.ts` with `ingest(userId, body)` per DD-17 steps 1–5, including the deleted check, the replay/gap rule (DD-14) and `minIntervalMs`.
- [ ] Create `server/src/logs/otel/otel-realtime.controller.ts`: `@Controller('api/v2/otel-realtime')`, `@UseGuards(ApiKeyAuthGuard)`, body validation per API changes, 409 on a foreign session.
- [ ] Register the realtime controller and service in `server/src/logs/logs.module.ts` (`:78`).
- [ ] Add the `otel_session_state.user_id` fallback to `findSessionOwnerId` (`server/src/logs/logs.service.ts:119-142`) per DD-17.
- [ ] Add the realtime route to `docs/knowledgebase/hook-api-versioning.md` (≥ 2.29.0 row, 404 handling) and `docs/knowledgebase/server-endpoint-map.md`.

### Chunk 5 — Projection drain + existing-path hooks
- [ ] Create `server/src/logs/otel/otel-projection.service.ts`, modelled on `server/src/logs/tool-monitoring/tool-usage-rebuild.service.ts`, with DD-16 steps 1–2: stamp-at-claim, per-session projection, the `-1` failure mark.
- [ ] Add DD-16 steps 3–5 to `OtelProjectionService`: queue claim by `DELETE … RETURNING` per DD-5, idle-root finalising, and deleted-session cleanup.
- [ ] Add the gap-close rule (DD-14) and one summary log line per tick (chunks, sessions, fills, duration) to `OtelProjectionService`.
- [ ] Register `OtelProjectionService` in `server/src/logs/logs.module.ts`.
- [ ] Add `otelProjectionVersion: null` to the `logs_otel` `onConflictDoUpdate.set` in `logs.service.ts` `ingestOtelChunk` (`:1212`). Change nothing else in that method.
- [ ] Call `enqueueOtelReclass(tx, sessionRowId)` right after `replaceSessionRequestIds` at `logs.service.ts:432`, `logs.service.ts:1084` and `repositories.service.ts:1438`.
- [ ] In `purgeSessionChildData` (`server/src/sessions/sessions.service.ts:175`), delete `otel_session_state` first, then `otel_calls`, `otel_spans`, `otel_cost_buckets` and `otel_reclass_queue` (DD-25).
- [ ] In `sessions.service.ts`, add the OTEL-only eligibility query to `hardPurgeExpiredSessions` (`:339-366`) and `otelOnlySessions` to `getRetentionStats`. In `account-deletion.service.ts` (`:136-193`), also collect OTEL-only roots (DD-25).

### Chunk 6 — UI read SQL + routes
- [ ] Export `scopedTreeCtes` from `server/src/logs/tool-monitoring/tool-usage-read.sql.ts:147` unchanged, and create `server/src/logs/otel/otel-facts-read.sql.ts` using it for the scoped roots, excluding deleted sessions (DD-6).
- [ ] Add rolled-bucket SQL (snapshot and `seq > since` delta) with `tz`, `stackBy` and the `calls`/model/ccVersion filters per DD-19 to `otel-facts-read.sql.ts`.
- [ ] Add KPI, query-source, filter-option, sessions-row and realtime-status SQL (per API changes and DD-14/DD-15) to `otel-facts-read.sql.ts`.
- [ ] Add the DD-28 SQL to `otel-facts-read.sql.ts`: token sums and per-user cost in the KPI query, the same KPI query over the previous window for `kpisPrev`, and the `flows` aggregate (buckets × `users.email` × the root session's `artisyn` `logs.git_branch`, capped at `OTEL_FLOWS_LIMIT`).
- [ ] Create `server/src/logs/otel/otel-facts.reader.ts` with `getRepoOtelFacts` and `getSessionOtel`: the DD-2 reader rule (REPEATABLE READ, S first), the empty-delta fast path, `status`, masking (DD-22) and span `hidden`/`confirmed`.
- [ ] Create `server/src/logs/otel/otel-facts.controller.ts` with both GET routes, validation (enums, ISO dates, period limit, IANA `tz`), its private `resolveReadScope` copy and the team-context analytics gate on the repository facts route (DD-6).
- [ ] Register `OtelFactsController` and the reader in `server/src/logs/logs.module.ts`.
- [ ] Add perf cases to `server/perf-tests/scenarios.ts`: a realtime POST of 50 lines, a repository 1-week snapshot, a session snapshot and an empty delta.

### Chunk 7 — Hook receiver: traces + realtime
- [ ] In `otel-receiver.js`, add `OTLP_TRACES_PATH = '/v1/traces'` to `KNOWN_PATHS` (`:101-105`) and a `walkSpans` shaped like `walkLogs` (`:328`), demuxing by the span's `session.id` and writing `signal:"spans"` lines.
- [ ] In `otel-receiver.js`, read `version.json` once with `fs` and add `hookVersion` to every chunk line written.
- [ ] In `otel-receiver.js`, add `readRealtimeTarget(runtime.owner.gitRoot)` per DD-13, re-reading on an mtime change, which also ends an auto-disable.
- [ ] In `otel-receiver.js`, add the realtime queue per DD-13: append after each chunk write, a per-session interval timer (`max(otelRealtimeIntervalMs, serverMinIntervalMs)`), `RT_MAX_BATCH_BYTES`/`RT_MAX_LINE_BYTES`, `RT_BUFFER_MAX_LINES` with `droppedLines`, and `batchSeq`/`receiverId`.
- [ ] In `otel-receiver.js`, add the realtime sender per DD-13: one request in flight, gzip over 8 KiB, timeout, requeue with the same `batchSeq`, status handling and auto-disable, and the `RT_SHUTDOWN_FLUSH_MS` final send. Export `nextRealtimeDelay` and the `RT_*` constants.
- [ ] In `env-context.js`, add the traces regex (`:381`) and the port-mismatch inclusion (`:443-458`), plus `otelRealtime: true`, `otelRealtimeIntervalMs: 5000` and `otelTraces` (default undefined) to `CONFIG_DEFAULTS`, the types and the table comment.
- [ ] In `otel-endpoint-check.js`, check `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` only when `otelTraces === true` (DD-24).

### Chunk 8 — Installer + hook release
- [ ] In `artisyn-hooks-installer/src/otel-env.ts`, export `OTEL_TRACE_ENV_KEYS(port)` and `OTEL_TRACE_ENDPOINT_KEY` per DD-24, leaving `OTEL_ENV_KEYS` unchanged.
- [ ] In `install.ts`, extend `OTEL_LOOPBACK_ENDPOINT_RE` (`:1559`), `isOtelEndpointKey` (`:1583`) and `isArtisynOwnedOtelValue` (`:1594`) per DD-24, and add `otelTraces?: boolean`, `otelRealtime?: boolean` and `otelRealtimeIntervalMs?: number` to `LogHubConfig`.
- [ ] Add `resolveOtelTracesAnswer` to `install.ts` per DD-23, using `prompt()` (`:1136`) and the TTY `[Y/n]` pattern (`:841`), and persist `otelTraces` in `log-hub.json`.
- [ ] In `install.ts`, merge `OTEL_TRACE_ENV_KEYS` via `mergeOtelEnv` (`:2043`) when the answer is yes; strip owned trace keys via `stripOwnedOtelEnvKeys` (`:2132`) when it is no and on uninstall.
- [ ] In `artisyn-hooks-installer/src/index.ts`, accept `--otel-traces=yes|no` for `install` only and add it to the usage text.
- [ ] Bump `hook/.claude/telemetry_tool/version.json` to 2.29.0 and run `npm run build:hooks-installer`.
- [ ] Copy the changed hook files and `version.json` into `.artisyn/marketplace/plugins/log-hub-hooks/scripts/`, set `plugin.json` to 2.29.0, and run the `update-install-instructions` skill for `INSTALL_HOOK.md`.

### Chunk 9 — Client data layer + tab wiring
- [ ] Add the UI response types (mirroring `otel-facts.types.ts`), `fetchRepoOtelFacts(params)` and `fetchSessionOtel(params)` to `client/src/models/repositories.ts`.
- [ ] Add `'otel'` to `SESSION_TABS` (last) and `REPO_MAIN_TABS` (after OKF) in `client/src/viewer/tab-ids.ts`, and update the `:35` comment.
- [ ] Create `otel/otel.constants.ts` (DD-20 constants, `OTEL_HIGHLIGHT_MS`) and `otel/otel-url-state.ts` for the `otel*` URL params (period, model, ccVersion, calls, metric, interval, stackBy, view, cumulative); drop those params in `setMainTab` (`useRepositoryViewState.ts:123-150`).
- [ ] Create `otel/otel-merge.ts` with `mergeOtelDelta(state, delta)` → `{state, newKeys, filled: {calls, spans}}`, keyed by `spanId`, `callKey` and `start|key`, applying the DD-3 client table.
- [ ] Create `otel/useOtelLivePoll.ts` per DD-20, returning the merged state, `newKeys` (cleared after `OTEL_HIGHLIGHT_MS`), `filled` and the indicator state.
- [ ] Create `session-log/otel/otel-trace-assembly.ts` with `assembleOtelTraces(spans, calls)` per DD-12.
- [ ] Wire the lazy `RepoOtelTab` into `RepositoryView.tsx` (`:43,62,433,472`, `canSeeTeamWideTabs`), the tab entry into `SessionTabBar.tsx` (`:44-100`), and `SessionOtelTab` into `SessionDetailPane.tsx` (`:418`).

### Chunk 10 — Repository OTEL tab UI
- [ ] Create `otel/otel-format.ts` (micros → USD, share, context:output ratio) and `otel/OtelLiveIndicator.tsx` (Live / Paused · tab hidden / Paused · idle — resume / Paused · by you / Session ended / Slow updates · hook X / Slow updates · realtime off).
- [ ] Create `otel/OtelRealtimeNotice.tsx`: the "Realtime data" badge + tooltip, and the four notices per DD-14, driven by `status.realtime` (or the repository `realtime`) and `filled`.
- [ ] Create `otel/OtelCostChart.tsx` per Visual/UX notes (`ComposedChart`, stacked `Bar` with `stackId`, 100 % view, cumulative `Line` on a right `YAxis`, custom tooltip, legend toggle, `newKeys` outline shape) inside `ChartResponsiveContainer`.
- [ ] Create `otel/OtelChartControls.tsx` and `otel/OtelFilterStrip.tsx`, bound to `otel-url-state.ts`.
- [ ] Create `otel/OtelKpiTiles.tsx` (repository and session tile sets, delta chips, sparklines from `buckets`, the change vs `kpisPrev`, the tokens-by-type / cache read ratio / per-user row per DD-28; reuse `CACHE_RATIO_SCOPE_COLORS.undefinedRatio` for `n/a`).
- [ ] Create `otel/OtelCostFlow.tsx` and its pure layout helper `otel/otel-cost-flow-layout.ts`: the DD-28 Sankey, three columns in a team context and two in a private repository, hover tooltip clamped to the viewport.
- [ ] Sort the series in the `OtelCostChart.tsx` tooltip and add share bars (FR-27); add `paused` + Pause/Resume to `useOtelLivePoll.ts` and `OtelLiveIndicator.tsx` (FR-28).
- [ ] Create `otel/OtelStructureSection.tsx` (share bars top 8 + "other (N)", click isolates, hidden bars), `otel/OtelQuerySourceTable.tsx` ("new" chip) and `otel/OtelSessionsTable.tsx` ("unconfirmed" chip, opens the session OTEL tab).
- [ ] Create `user-docs/otel-tab.md` (sections per Chunk 13 item 1) with its `user-docs/nav.json` entry, then `otel/OtelEmptyState.tsx` (A/B/C) and `otel/OtelSlowUpdatesBanner.tsx` linking to its anchors.
- [ ] Create `otel/RepoOtelTab.tsx`, composing the above with `fetchRepoOtelFacts` and the 30 s poll (DD-20), with test id `repo-otel-tab`.

### Chunk 11 — Session OTEL tab UI
- [ ] Create `session-log/otel/TraceNavigator.tsx` (‹ Turn n of N ›, the Start / Cost / Slowest order switch, Expand / Collapse, the turn header and the "Time" bar per DD-12), with `splitOtelTurnTime` and the turn ordering added to `otel-trace-assembly.ts`.
- [ ] Create `session-log/otel/TraceMinimap.tsx`: the turn's spans as thin bars, with a viewport window that drives the waterfall's visible range.
- [ ] Create `session-log/otel/TraceWaterfall.tsx` with rows keyed by `spanId`, an indented tree, duration bars, Σ rollups, `agent <id>` labels, hidden rows in red, provisional "turn in progress" rows, dotted unconfirmed rows, and expand/selection state outside the data.
- [ ] Add the live highlight to `TraceWaterfall.tsx`: NEW tag, amber row, ancestor Σ flash and the "↓ N new spans below" pill, from `newKeys` via CSS classes only, with no scroll jump.
- [ ] Create `session-log/otel/SpanDetailsPanel.tsx` (request_id, query_source, agent_id, model + ttft, tokens, cache, cost source, context, confirmed/realtime, "show all raw (N)" or "hidden for your role").
- [ ] Create `session-log/otel/SessionOtelTab.tsx` (header, `OtelRealtimeNotice`, chart, KPIs, cost by source, navigator, minimap, waterfall, details, slow banner, empty states) using `useOtelLivePoll`, with test id `session-otel-tab`.
- [ ] Run the `post-impl-check-client-component-size` check over the new OTEL components and split any file above its threshold.

### Chunk 12 — Team OTEL tab
- [ ] Add `server/src/logs/otel/otel-team-facts.controller.ts` (`GET /api/v1/teams/:teamId/otel/facts`, validation as the repository route plus `repoId[]`, `userId[]`, `stackBy=person|repository|…`) and register it in `logs.module.ts` (DD-29).
- [ ] Add the team read SQL to `otel-facts-read.sql.ts`: distinct scoped roots over the team's repositories with `resolveTeamScope` visibility, `person` / `repository` bucket keys, `people`, `repositories`, `flows` with `repository`, and the team KPIs (DD-29).
- [ ] Add `getTeamOtelFacts` to `otel-facts.reader.ts`, reusing the repository facts code for buckets, KPIs, `kpisPrev`, realtime counts and `flows`.
- [ ] Add the team response types and `fetchTeamOtelFacts(params)` to `client/src/models/teams.ts`.
- [ ] Create `client/src/viewer/pages/teams/otel/TeamOtelTab.tsx`, `OtelPeopleTable.tsx` and `OtelRepositoriesTable.tsx` per DD-29 (top-5 folding, People row filters the tab, Repositories row opens `routes.teamRepo` with `tab=otel`), with test id `team-otel-tab`.
- [ ] Extend `otel/OtelFilterStrip.tsx` with optional repository / people pickers, and add `OTEL_TEAM_TOP_PEOPLE` to `otel/otel.constants.ts`; the team page keeps its filter state locally (no `otel-url-state.ts`), as `TeamDetailPage` keeps its tab state.
- [ ] Add the "OTEL" tab to `client/src/viewer/pages/teams/TeamDetailPage.tsx` after Invitations, shown only when the caller passes the analytics rule (owner / manager in a `restricted` team, everyone in a `transparent` one); a direct link otherwise shows "No access".

### Chunk 13 — Docs + help
- [ ] Complete `user-docs/otel-tab.md`: the repository, session and team tabs (including who sees what on the team tab), hidden calls, the realtime channel and what "unconfirmed / delayed / gap / filled" mean, "Enable OTEL and traces", "Upgrade the hook for live updates", and that imported sessions have no OTEL. Then run `npm run build:help`.
- [ ] Update `user-docs/connect-repository.md` "Upgrading and uninstalling" (trace question, `--otel-traces`, `otelRealtime: false`) and `hook/README.md` "Other channels → OTEL export" (traces, realtime channel, how to turn each off).
- [ ] Create `docs/knowledgebase/otel-tabs.md` (two channels, read model, DD-2 cursor, DD-4/DD-5 classification, DD-27 matrix, measured per-request cost) and add it to `docs/knowledgebase/index.md`.
- [ ] Update `docs/knowledgebase/otel-receiver.md` (traces path, spans lines, `hookVersion`, realtime sender).
- [ ] Update `docs/knowledgebase/hook-installation.md` (twelve keys, `otelTraces`, `otelRealtime`), `db-tables.md` (new tables and column) and `llm-call-math.md` (pointer to the OTEL structure rule).
- [ ] Update `docs/knowledgebase/api-reference.md` and `server-endpoint-map.md` with the three UI routes (repository facts, session, team facts) and the hook route.
- [ ] Update `docs/knowledgebase/data-retention.md` per DD-25 (purge list, OTEL-only eligibility, `otelOnlySessions`, account deletion, deleted-session cleanup), and show `otelOnlySessions` in the admin Data Retention tab.

### Chunk 14 — Algorithm + contract tests
- [ ] Write `docs/knowledgebase/algorithms/otel-facts.md` with an examples block covering the row kinds in the Test coverage plan.
- [ ] Create `server/src/logs/otel/otel-facts.algo.spec.ts` that loads the `otel-facts` examples via `load-examples.cjs`, in the `otel-cost.sql.algo.spec.ts` style.
- [ ] Write `docs/knowledgebase/algorithms/otel-trace-assembly.md` and `otel-delta-merge.md`, and create the client `otel-trace-assembly.algo.test.ts` and `otel-merge.algo.test.ts`, each reading its own doc's examples.
- [ ] Write `docs/knowledgebase/algorithms/otel-realtime-backoff.md` and create `hook/.claude/telemetry_tool/__tests__/otel-realtime.algo.test.js`.
- [ ] Add OTEL rows (state, calls, spans, buckets) for one owner session and one team-repo session to `server/test/contract/fixtures/world-v1.sql.ts`, plus a second team repository sharing one session, and team roles (manager, plain member, ADLC trainer only) for the DD-29 rows.
- [ ] Create `server/test/contract/registry/f25-otel.ts` with the rows listed in the Test coverage plan, register it in `registry/index.ts`, and add `f25.contract-spec.ts` following `f24.contract-spec.ts`.
- [ ] Add the four new algorithm docs to the list in `docs/knowledgebase/algorithms/README.md`.

### Chunk 15 — Scenarios
- [ ] Create synthetic lines in `tests/scenarios/fixtures/otel/`: `api_request` logs (with and without request ids), spans in order and out of order, an unknown `query_source`, a standalone `prompt_suggestion`, and matching transcript request ids. No real data.
- [ ] Create `tests/scenarios/view/s-otel-01.spec.ts` with steps for AC-1–AC-5, AC-9, AC-12, AC-18, AC-19 and the no-OTEL empty state.
- [ ] Add live steps to `s-otel-01`: AC-6/AC-16/AC-17 via realtime POSTs during an open tab, and AC-8 (the same lines via realtime then chunk give no duplicates and become confirmed).
- [ ] Add steps to `s-otel-01` for "gap then fill", the AC-13 upgrade half, AC-21–AC-23, AC-25, AC-26, AC-27, AC-28 and the visual checks, per the Test coverage plan.
- [ ] Add AC-10 (2.28.0) and AC-11 (1.6.2) steps to `tests/scenarios/hook/s-compat-01.spec.ts`, and an AC-13 old-server step ("realtime 404 once, then silence; uploads unchanged") to `s-hook-01.spec.ts`.
- [ ] Extend `shiftSessionTree` (`tests/scenarios/helpers/time-shift.ts:104`) to `otel_session_state.created_at` and `logs_otel.created_at`. Then add `s-slife-08` steps: an old root purged with its OTEL rows, an old OTEL-only root purged, a young one kept, and realtime to a soft-deleted session ignored.
- [ ] Blank `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` in `fakeHomeEnv` (`tests/scenarios/helpers/hook-process.ts:180`); in `s-hook-07.spec.ts`, change the unknown-path probe (`:277`) to `/v1/unknown` and add steps for `/v1/traces` → `signal:"spans"` and a realtime POST reaching a fake hub at the 5 s interval.
- [ ] Extend `s-inst-01.spec.ts` (`:209,252`) and `s-inst-04.spec.ts` (`:125,184`) for AC-7/AC-15 and the FR-11 "no" answer, add `repo.otel`/`session.otel`/`team.otel` rows with `docRef` → `user-docs/otel-tab.md` to `tours/screen-registry.ts`, and run the touched scenarios with `--grep`.
