---
type: "Schema Reference"
title: "Database Structure — current state"
description: "Core ER diagram and the cross-table rules the DDL cannot show: session trees, soft/hard delete and cascades, extracted log fields, OTEL rows, derived per-session tables, pricing, scoping. Columns, keys, indexes and per-table comments live in the generated db_state.sql."
tags:
  - database
  - schema
generated: { by: "ai:claude", at: "2026-11-25T18:00:00+04:00" }
---

# Database Structure — current state

**Current columns, keys, indexes and per-table comments: [`db_state.sql`](db_state.sql)** (generated
by `npm run db:state` after every migration from a freshly migrated database; every table and every
non-obvious column carries a `COMMENT ON`, rendered there as a `-- ` line). The Drizzle mirror is
`server/src/database/schema/index.ts` (57 tables); how it is wired and how to add a table:
[db-schema-code.md](db-schema-code.md).

- **Indexes** are declared next to each table in `server/src/database/schema/index.ts`, except the
  ones Drizzle cannot express or that predate the mirror (partial unique, GIN, several early
  performance indexes) — those exist only in the SQL migrations; `db_state.sql` shows all of them.
- **Migrations** are `server/drizzle/migrations/*.sql`, hand-written, immutable once committed — see
  [db-schema-code.md](db-schema-code.md) and the `migrations-data-integrity` skill
  (`.claude/skills/migrations-data-integrity/`).
- One live table is not in the schema: `auth_sessions`, created at runtime by `connect-pg-simple`
  (`app.module.ts`) and pruned by `auth-sessions.service.ts` with raw SQL.

This article keeps only what the DDL does not say: how tables relate in behaviour.

## Entity-Relationship Diagram (core)

```
 repositories ──CASCADE──► users ◄──RESTRICT(owner_id)── teams ◄──CASCADE── team_members ──CASCADE──► users
 (user_id, repo_url) U       ▲                             │ CASCADE
   │ CASCADE: repo_config,   │ CASCADE (user_id)           ▼
   │ repo_tool_monitor_config │                     team_repositories (team_id, repo_url) U
   │ harness_elements,       │                       │ CASCADE: team_repo_config, team_repo_tool_monitor_config,
   │ repo_code_inventory     │                       │          team_repo_recompute_queue
   │                         │
   └── log_repositories ──► logs (session_id, log_type) U
       (N:M, CASCADE)        │
                             │ session_id FK, NO cascade
                             ▼
                          sessions (session_id U; parent_session_id = string, no FK; deleted = soft delete)
                             │ CASCADE (session_id FK) to every per-session child:
                             ▼
   session_stats, session_costs, session_call_tokens, session_request_ids, session_tool_stats,
   session_harness_usage, session_changed_paths, session_file_stats*, session_cause_stats*,
   session_okf_access, session_okf_event, session_okf_pointer, session_tool_usage,
   session_attribution, session_attribution_runs, session_tags (root only),
   session_prompt_watermark, user_favorite_sessions, logs_otel, otel_api_calls,
   otel_calls, otel_spans, otel_cost_buckets, otel_session_state, otel_reclass_queue,
   otel_session_totals, otel_agent_totals

 U = unique key   * = scoped rows: nullable team_id / user_id FKs (CASCADE)
```

Tables keyed by a **string** session id with **no FK** (the session may not exist yet or may be
purged already): `upload_queue`, `upload_queue_measurements`, `turn_end_advisor_runs`,
`deleted_session_log`. Snapshot ids on `sessions` / `upload_queue` point at
`harness_snapshots` / `okf_snapshots` without an FK too.

## Sessions, ownership and deletion

### sessions

A deduplication table: the incoming session string is looked up or created here, and every other
table stores the integer `sessions.id`.

- `parent_session_id IS NULL` = a root session. Otherwise it is the **immediate** parent
  (agents spawn agents, 3+ levels; hook v1.5.0+), so "all sub-agents of X" needs the recursive
  `descendantSessionsCte` (`server/src/logs/session-tree.sql.ts`). Older uploads point straight at
  the root. The parent row may not exist yet; it is created when its own log arrives.
- Only root sessions carry an `artisyn` log, so a sub-agent's repository links, repo roots and
  OKF snapshot are resolved through its root.
- `workflow_run_id` mirrors `parent_session_id` for workflow-spawned agents (resolves
  `WorkflowRun.agentSessionIds`).
- `agent_description` / `workflow_phase` (`varchar(255)`, nullable, migration 0085) hold the
  sub-agent's `.meta.json` `description` / `workflowPhase`, sent by hook 2.31.0+ as the
  `agentDescription` / `workflowPhase` query params of `POST /api/v2/logs`. They are written
  **only for `claude-subagent` sessions** (root sessions stay `NULL`), sanitised by
  `sanitizeAgentMeta` (`server/src/logs/agent-meta-param.ts`: non-string → `NULL`, trimmed,
  empty → `NULL`, cut to 255 code points). `LogsService.upsert` never overwrites a stored value
  with an absent one — each column is set only when its new value is non-null, independently.
  Rows from older hooks stay `NULL`; there is no backfill. The client uses them as the sub-agent
  label (description first) and the Agents-table Phase column.
- `tool_usage_version` is the rebuild marker of `session_tool_usage` (see
  [tool-monitoring.md](tool-monitoring.md)); `initializeDatabase()` re-queues every value below the
  current extractor version on start.
- `okf_extract_version` (`smallint`, nullable) / `okf_events_truncated` (`boolean`, default
  `false`), migration 0091: the OKF extraction marker. The OKF writer sets `OKF_EXTRACT_VERSION`
  (5) on every node it rebuilds, even with zero rows, and the truncated flag when the extractor's
  per-node event / pointer cap was hit. `NULL` = no OKF analysis yet; a non-null version below the
  current one = rows of an older extractor, re-extracted only where that version's change
  applies. No tab reads it; its only reader is the background `ShellFiguresBackfillService`,
  which re-extracts (OKF rows and `session_stats` commit / PR counts) only the nodes below 5 that
  have a `session_tool_stats` row for `PowerShell` — see [okf-usage.md](okf-usage.md)
  § "Shell-figures backfill". Every other node is rebuilt only by `recompute-all-sessions`.
- Repos and sessions are **private to their owner**; the owner is the `user_id` of the session's
  logs. Team visibility comes from `team_repositories` (by URL) and `teams.access_mode`.

**Soft delete** (`deleted = true`, by the owner): `SessionsService.purgeSessionChildData` deletes
the OTEL facts (state row first, so a running writer finishes), `session_stats`,
`session_call_tokens`, `session_costs`, `user_favorite_sessions`, `session_file_stats`,
`session_okf_access`, `session_okf_event`, `session_okf_pointer`, `session_tool_usage`, `session_tags`
(explicitly — the kept `sessions` row means the FK cascade never fires), `logs` (cascading `log_repositories`),
queued `upload_queue` rows, then clears the snapshot ids (and
resets the OKF marker) and sweeps orphan `harness_snapshots` / `okf_snapshots`. The `sessions` row stays, so a re-upload of
a deleted session is rejected. Since 2026-11-23-session-logs-streaming (DD-28) the purge also
deletes the former **survivors** — `logs_otel`, `otel_api_calls`, `session_request_ids`,
`session_tool_stats`, `session_harness_usage`, `session_changed_paths`, `session_cause_stats`,
`session_attribution`, `session_attribution_runs`, `session_prompt_watermark`, and
`turn_end_advisor_runs` by the `session_id` string (no FK, so it never cascades). Only
`upload_queue_measurements` is kept. `SessionsService.markSessionTreeDeleted(tx, rootPk,
deletedByUserId)` marks the root and its live descendants deleted and writes their
`deleted_session_log` rows; `deleteSession` (under the tree's ingest lock) and the cleanup below
both call it, then `purgeSessionChildData`.

`DeletedSessionCleanupService` (`sessions/deleted-session-cleanup.service.ts`, governed by
`RebuildGovernor`, first pass on start, then every `DELETED_SESSION_CLEANUP_INTERVAL_MS`, default
60 000; `DELETED_SESSION_CLEANUP_BATCH` = 200 sessions per step) converges older data: (1) a live
sub-agent whose parent is a tombstone is deleted the same way (`deleted_by_user_id` NULL);
(2) a `deleted` session that still owns survivor rows (deleted before DD-28) is purged.
`descendantSessionsCte` / `getDescendantSessionIds` walk live descendants only (`deleted =
false`); the hard-delete paths (retention, admin repository removal) pass `includeDeleted`.

**Hard delete** (retention, admin family delete, account deletion): the same purge, then
`DELETE FROM sessions`, which cascades every remaining child. `logs.session_id` has **no**
cascade, which is why the purge deletes logs first. Root sessions older than
`SESSION_RETENTION_DAYS` are hard-deleted with all descendants by `SessionRetentionService`
([data-retention.md](data-retention.md)).

### deleted_session_log

One audit row per deleted session, ever, written before the purge (times, work time and the
tree cost captured while the data still exists). The unique `session_pk` doubles as the claim:
`hardPurgeExpiredSessions()` inserts with `ON CONFLICT DO NOTHING`, so overlapping retention
runs on several instances cannot purge one session twice. `deleted_by_user_id IS NULL` = the
retention purge.

Since migration 0096 the table is also the **tombstone** list: an upload, OTEL chunk or advisor
run for a session whose id (or an ancestor's) has a row here, or a `sessions.deleted = true` row,
is accepted and dropped (`SessionTombstoneService`). `repository_url` is the root's
`repositories.repo_url` (lowest `repo_id` linked to its `artisyn` log; a sub-agent root falls
back to its top ancestor's, then to its parent's tombstone row), copied to descendant rows.
`owner_user_id` is the tree owner, written by both `deleteSession` and the retention purge
(read from `logs` before the purge).

**Fresh start** (DD-29, `clearSessionTombstones` in `sessions/session-tombstone.service.ts`):
account deletion clears by `owner_user_id`, and admin `removeRepo` / team
`removeTeamRepository` by `repository_url` — it hard-deletes the `deleted` `sessions` rows of
those tombstones, then the tombstone rows, so a later upload of the same ids starts fresh. Rows
written before 0096 have no `repository_url` and are not cleared by a repository deletion
(accepted limitation). Indexes:
`idx_deleted_session_log_session_id`, `idx_deleted_session_log_owner`,
`idx_deleted_session_log_repo_url`.

### Other cascade rules

- Deleting a **user** cascades their API keys, tokens, settings, repositories (and everything
  under them), logs, snapshots, favorites, queue rows and jobs. `teams.owner_id` is `RESTRICT`:
  `AccountDeletionService` deals with owned teams first. `invitations.inviter_id/invitee_id` have
  no cascade either; account deletion removes those rows explicitly.
- Team configs belong to the **link**, not to a member: `team_repo_config`,
  `team_repo_tool_monitor_config` and `team_repo_recompute_queue` cascade with their
  `team_repositories` row on every unlink/remove/team-delete path and survive a member's
  repository or account deletion.
- `otel_cost_buckets.user_id` and `otel_session_state.user_id` are `SET NULL` (the facts stay with
  the session).

### repositories

One row per (user, canonical URL). `normalizeRepoUrl()` (`server/src/logs/repo-url-normalizer.ts`)
maps the SSH and HTTPS spellings of one remote to one `https://host/path` form (fixed point;
`git://` and unparsable values kept verbatim). At bootstrap `RepoBackfillService` merges each
user's duplicates into the lowest `id` (re-pointing `log_repositories`), and does the same for
`team_repositories`. A repository without a git remote stores `<owner email>/<path>`
([repo-identity.md](repo-identity.md)).

The `hook_*`, `harness_*` and `tool_wrap_status` columns are the hook's latest self-report for
that repository row ("last report wins", replaced wholesale) — see
[hook-system-overview.md](hook-system-overview.md) and [tool-monitoring.md](tool-monitoring.md).

## Logs

### logs

One row per `(session_id, log_type)`; a re-upload upserts `body`, `updated_at` and the extracted
fields. A hook upload **replaces** `body` every time (`excluded.body` in `logs.service.ts` `upsert()`;
the hook sends the whole file, and nothing guarantees the new body is longer). "Keep the longer
body" (by line count, `jsonb_array_length`) applies only to zip import (`importSession()`, see
[session-export-import.md](session-export-import.md)).

**Extracted fields:** for `log_type = 'artisyn'` the ingest parses `body` at write time into
`first_prompt`, `start_time`, `end_time`, `git_branch`, `git_repo_root` and `git_worktree_root`;
other log types leave them `NULL`. `git_repo_root` is the primary checkout (`--git-common-dir`)
even inside a linked worktree; `git_worktree_root` (`--show-toplevel`) is what keeps paths of a
worktree session from being classified out-of-repo.

**Session start and end ignore non-activity lines.** `extractTimestampRange()`
(`server/src/logs/artisyn-extractor.ts`) skips every line type in the `NON_ACTIVITY_LINE_TYPES` set
there (the list is in code; a new synthetic hook line type must be added to it): the hook prepends
or appends these events (status, harness / OKF snapshots and their `-ref` lines, code inventory,
OTEL status …), and their timestamps record when the hook reported, not when the session worked
(a `code-inventory` snapshot can predate the session by hours).

**`claude-otel` rows are not raw OTLP.** The session's `claude-otel` row holds a normalised result
derived from its raw chunks in `logs_otel`. No cost reader parses it (they read
`session_stats.telemetry_cost` / `session_costs`); it is kept for the OTEL UI-invisibility
guarantee, which actually comes from the transcript views' `log_type` allow-list
(`artisyn | claude | claude-subagent`). `tool-calls` logs carry the CLI tool wrapper records
([tool-monitoring.md](tool-monitoring.md)).

`artisyn` logs' `prompt_start.context` (sent by hooks before `3.4.0`) is stored verbatim and no
longer projected; the former `contexts` / `log_contexts` tables were dropped by migration 0099,
which moved their pairs to `session_tags` — see § "session_tags".

**Body revision, ingest hash and gzip copy (migration 0096).**

- `body_rev` is a per-body revision from the sequence `logs_body_rev_seq`. It has gaps, so it is
  compared only for equality or order. Rows written before 0096 keep `NULL` until the gzip
  builder (`LogBodyGzService`) assigns one; a part's revision is then `body_rev`, or
  `'u' + updated_at` micros while it is still `NULL`.
- **Trigger `logs_body_guard`** (`BEFORE INSERT OR UPDATE OF body … FOR EACH ROW`, function
  `logs_body_guard()`) — the repo's only plpgsql trigger, and `db_state.sql` does not dump
  triggers or functions, so it is documented here:
  - every body write sets `body_rev := nextval('logs_body_rev_seq')`;
  - an `UPDATE` that changes neither `body_sha256` nor `body_received_at` clears `body_sha256`.
    A writer that does not know the hash (zip import, an older server build) therefore never
    leaves a stale one, while the ingest upsert re-writing the same hash with a new
    `body_received_at` keeps it.
  - It fires on the `DO UPDATE` arm of `INSERT … ON CONFLICT` when `body` is in the `SET` list;
    an update that touches only `body_gz` / `body_gz_rev` / `body_rev` does not fire it.
- `body_sha256` + `ingest_version` (`INGEST_VERSION`) let the server skip an identical re-upload
  of `claude`, `claude-subagent` and `tool-calls` ([upload-queue.md](upload-queue.md)).
- `body_received_at` is the `upload_queue.received_at` of the upload that wrote the body
  (`now()` for zip import): the upsert's `DO UPDATE` lets an older upload never overwrite a newer
  one. `NULL` (legacy) is always overwritable.
- `body_gz` is the gzip (level 6) of `body::text`, with `STORAGE EXTERNAL` (already compressed,
  so Postgres does not try to compress it again). It is valid only when `body_rev IS NOT NULL AND
  body_gz_rev = body_rev`, and is kept only for `artisyn`, `claude` and `claude-subagent`. The
  partial index `idx_logs_body_gz_pending` is the gzip builder's queue (missing or stale copy).
- `edit_records_sha256` (`artisyn` rows) is the hash of the extracted edit-result records;
  `stats_edit_sha256` (`claude` / `claude-subagent` rows) is the tree's value the stats were
  extracted with (`''` = no edit records). A change of the `artisyn` value queues the tree root
  in `session_reextract_queue`.
- Never `SELECT` whole `logs` rows: besides `body`, a row now carries `body_gz`.

## Telemetry (OTEL)

### logs_otel

Raw chunks: one row per receiver file (one inbound OTLP request), `(session_id, chunk_key)`
unique because the uploader re-ships a file whose size changed — ingest must upsert or cost would
double-count. Costs are **integer micro-USD** so sums over thousands of chunks stay exact.
`ingestOtelChunk()` (`logs.service.ts`) re-aggregates the session's chunk cost after every write
into `session_stats.telemetry_cost` (`NULL` when the sum is 0) under a `FOR UPDATE` lock on the
session row, upserts one `otel_api_calls` row per `api_request` record in the same transaction,
and resets `otel_projection_version` to `NULL` so the projection drain re-projects the chunk.
Receiver: [otel-receiver.md](otel-receiver.md); cost maths: [llm-call-math.md](llm-call-math.md) §2.

`otel_api_calls` is the per-call view used to price **utility calls** (API calls no transcript
records): a call whose `request_id` is absent from the whole tree's `session_request_ids` is a
utility call; a tree with no `session_request_ids` rows (old transcripts) falls back to
`query_source` classification (`utilityCostsCte`, `otel-cost.sql.ts`).

### OTEL tab tables

`otel_calls`, `otel_spans`, `otel_cost_buckets`, `otel_session_state`, `otel_reclass_queue` hold
the projected facts behind the OTEL tabs, written by `server/src/logs/otel/otel-facts-writer.ts`
from two channels: the realtime route and the projection drain over `logs_otel`
(`OtelProjectionService`). Rules:

- Every row belongs to the **root** session (the OTEL `session.id` is always the root); sub-agent
  rows are told apart by `agent_id`.
- `otel_session_state` is the per-root cursor and the **lock row**: every OTEL writer locks it
  `FOR UPDATE` first. No row = the root has no OTEL data.
- `seq` on every fact row is the state's `seq` of the write that last changed it — the `since=`
  delta cursor. `source_mask` bit 2 = confirmed by an uploaded chunk.
- `otel_calls.call_key` is independent of `otel_api_calls.call_key` (different fallback).
- `otel_cost_buckets` is the source of every chart/KPI. It has no repository column
  (`log_repositories` is many-to-many and OTEL can arrive before the link); reads scope roots with
  `scopedTreeCtes`. A bucket key that disappears on reclassification is zeroed, never deleted;
  reads ignore zero rows.
- `otel_reclass_queue` gets a row after every transcript request-id rewrite; the drain claims
  rows with `DELETE … FOR UPDATE SKIP LOCKED … RETURNING`.
- Cost attribution (migration `0088`, task `2026-11-03-otel-cost-attribution`), all written by
  `applyOtelLines` (`otel-facts-writer.ts`) from both channels and filled for history by the
  projection version bump to 2:
  - `otel_calls`: `cache_write_5m_tokens`, `cache_write_1h_tokens` (bigint), `effort`, `speed`
    (varchar 64), `skill_name`, `plugin_name`, `agent_name`, `mcp_server_name`, `mcp_tool_name`
    (varchar 255) — all nullable; NULL = not reported (older Claude Code). Upserted with the call;
    a change in any of them is a call change. Partial index `idx_otel_calls_session_agent`
    `(session_id, agent_id) WHERE agent_id IS NOT NULL` served the FR-6 sub-agent OTEL cost sum
    (`subagentOtelCostSql`); migration `0090` replaced it with
    `idx_otel_calls_session_agent_event_time` `(session_id, agent_id, event_time) WHERE agent_id
    IS NOT NULL`, which serves that sum through its prefix and the Live view's per-sub-agent
    time-ordered / time-window reads (`otel-live-read.sql.ts`).
  - `otel_cost_buckets`: grain columns `skill`, `mcp_server` (varchar 255), `effort`, `speed`
    (varchar 64), `NOT NULL DEFAULT ''` (`''` = not reported) and part of `otel_cost_buckets_pk`
    (recreated over all 10 key columns).
  - `otel_session_state`: `plan`, `seat_type`, `provider` (varchar 64), `custom_base_url`
    (varchar 1024, sanitised: scheme + host + path), `account_event_at` (timestamptz) — nullable,
    latest-wins by `account_event_at`, a null never overwrites (`extractOtelAccount`).
- Stored live totals (migration `0089`, task `2026-11-04-otel-live-view`): `otel_session_totals`
  (one row per root, hidden calls included) and `otel_agent_totals` (PK `(session_id, agent_key)`,
  `agent_key` = `agent_id` or `main`; hidden calls have no row) are **derived** from `otel_calls`
  by `upsertOtelCalls` in the same writer transaction. While the session row is current
  (`seq >= MAX(otel_cost_buckets.seq)` of the root, or the root has no bucket row yet, so no call)
  the writer adds the call deltas; otherwise — a session older than the migration, buckets written
  by an older server process — it runs `rebuildOtelTotals` (also called after every reclassification). An agent with no calls
  left is zeroed, never deleted. Both are purged with the other OTEL tables on a soft delete.
  The same migration adds `idx_otel_session_state_last_at` on
  `GREATEST(rt_last_at, chunk_last_at)` and the time indexes
  `idx_otel_calls_session_event_time` / `idx_otel_spans_session_start_time`.

Design, lock order and cursor: [otel-tabs.md](otel-tabs.md).

## Derived per-session data

All `session_*` fact tables are derived from stored log bodies and can be rebuilt
(`POST :repoId/recompute-all-sessions` re-runs the extractors over every session of a repository).
Most are **delete-then-insert per session** (the set of tools/paths/elements can shrink on
re-extraction, so an upsert would leave stale rows), and most have no surrogate key: the unique
index is the key.

### session_stats

One row per session node. Mostly written by `upsertSessionStatsRow()`
(`session-stats-writer.ts`), but some columns have **exclusive owners** that the main upsert never
touches, so a transcript re-upload cannot reset them: `telemetry_cost`
(`upsertSessionTelemetryCost`), `claude_version_otel` (`upsertSessionClaudeVersionOtel`, only
raised), `otel_state/otel_reason/otel_status` (`upsertSessionOtelStatus`, newest event wins). A
`claude-otel` chunk for a session with no transcript creates the row with every transcript counter
at its default — row presence is **not** a "has transcript" signal.

- Invariants (test-enforced, not constraints): `cache_write_5m_tokens + cache_write_1h_tokens =
  cache_write_tokens`; `*_fast` columns are **subsets** of `input_tokens` / `output_tokens`, so
  cost adds a surcharge on the total rather than a separate fast term.
- `lines_changed` (lines written) and `lines_added` / `lines_removed` (diff-based) measure
  different things (~3x apart) and are never shown together; diff coverage is
  `diff_lines_covered_calls` of `diff_lines_total_calls`.
- `cs_*` change-surface counters are own-scope set sizes, so they are **not** summed over a tree
  (absent from `treeMetricsSumColumns()`); tree figures are recomputed from
  `session_changed_paths` ([change-surface.md](change-surface.md)).
- Session-list flags (`main_model`, `has_workflow`, `has_main_assistant`, `claude_line_count`,
  `list_flags_version`) are written for root transcripts only and back-filled at startup by
  `backfillSessionListFlags()` ([algorithms/session-list-flags.md](algorithms/session-list-flags.md)).
- `work_time_ms` comes from the transcript (`computeWorkTime()`), not from hook events.
- `workflows` / `workflows_version` (migration 0096) hold the workflow runs of the session's own
  `claude` transcript, written at ingest so session readers never parse the body;
  `workflows_version IS NULL` = not computed yet, and the partial index
  `idx_session_stats_workflows_pending` is the backfill's queue (`WorkflowsBackfillService`).

### session_reextract_queue

One row per session tree root (`session_pk`, cascades with the session) whose `claude` /
`claude-subagent` stats must be re-extracted because the tree's `artisyn` edit records changed.
Written (upsert, `requested_at = now()`) by `LogsService` on `artisyn` ingest and drained by
`SessionReextractService`. A row older than `DERIVED_LAG_MS` sets the parts manifest's
`derivedLagging` flag.

### Cost tables

- `session_request_ids` and `session_call_tokens` are rewritten next to every
  `upsertSessionStatsRow` call.
- `session_costs` is the stored cost every reader uses. Its only runtime writer is
  `recomputeSessionCosts`. A pricing write marks affected rows `stale`; the
  `SessionCostRecomputeService` sweeper recomputes them. A session with no row counts as
  unpriced.
- Details: [llm-call-math.md](llm-call-math.md) §2.

### session_cause_stats

Like `session_file_stats`, these rows are **scoped** (nullable `team_id` / `user_id`) because they
depend on a scoped `repo_config` field (`highCacheCreationThreshold`). Team and personal values can
coexist for one session, so they cannot live in the unscoped `session_stats` row. The partial
unique indexes `(session_id, team_id) WHERE team_id IS NOT NULL` /
`(session_id, user_id) WHERE user_id IS NOT NULL` are the upsert targets (SQL only).

- **Invariant:** the three `*_tokens` sum to `session_stats.cache_write_tokens`
  ([llm-call-math.md](llm-call-math.md) §8).
- **Write set:**
  - `session_cause_stats`: one row per team linking the session's URLs, plus the uploader's row.
  - `session_file_stats`: the same team rows, plus every user with a personal `repo_config` on
    those URLs. The uploader always gets a row.
- **Read scope:** team view reads `team_id = T`, personal view reads `user_id`. The two are never
  mixed.
- `session_file_stats` paths are made repo-relative with the tree's repo roots before category
  matching. The artisyn ingest heals rows written before the root was known
  (`rewriteSessionTreeFileStats`).

### session_harness_usage

There are two write patterns. Tool/MCP rows are rebuilt delete-then-insert from the transcript.
Skill/rule rows are upserted from the session's own artisyn inventory with `uses = 1`, which means
"loaded into context", not "invoked". `HarnessUsageService` counts from this table.
`harness_elements` is the repository's inventory of record, used only to add zero-usage rows. An
element is "removed" when its `last_seen` is older than
`repositories.harness_inventory_reported_at`. Built-in tool rows (`last_seen IS NULL`) are never
removed. See [harness-usage-tab.md](harness-usage-tab.md).

### Background-built tables

These tables are not written inline by ingest:

- `session_tool_usage` is rebuilt per session tree by `ToolUsageRebuildService` whenever
  `sessions.tool_usage_version IS NULL`. Its `aggregates`, `calls` and `outputs` columns are
  TOASTed separately, so the summary never detoasts the call lists.
- `session_okf_access` is rebuilt per node on ingest, import, heal and recompute;
  `sessions.okf_extract_version` records the extractor version it was built with
  ([okf-usage.md](okf-usage.md)).

### session_okf_access, session_okf_event, session_okf_pointer

```
 sessions (id) ──CASCADE──► session_okf_access   U(session_id, path_key, op, after_own_edit)
      │                      + ranged_calls, ranged_bytes, search_hits (0091, default 0)
      ├──CASCADE──► session_okf_event    U(session_id, ord, op, path)            (0091)
      │                      op ∈ read | search | write; range_from, range_to, pattern ≤ 200
      └──CASCADE──► session_okf_pointer  U(session_id, read_ord, article_path, pointer) (0091)
                             article_hash, is_new, followed, partial; pointer '' = partial read
```

- **`session_okf_event` and `session_okf_pointer` are no longer written or read since
  2026-11-21** (the OKF tabs were cut down to the summary line and four views). Rows written
  before stay; the session purge and the `sessions` cascade still delete them. A follow-up task
  drops both tables — do not build on them.
- `session_okf_access`: one row set per **tree node** (root or sub-agent), keyed by the node's
  own `sessions.id`; no team / user scope columns. The OKF tabs read `path_key`, `op`, `bytes`
  and `calls`; the other columns are written but not read.
- The unique keys lead with `session_id`, which serves the per-node delete and the scoped reads;
  there is no path index — the read side selects the in-scope node ids first.
- Extraction rules: [algorithms/okf-access-extraction.md](algorithms/okf-access-extraction.md);
  counting rules: [algorithms/okf-usage-counting.md](algorithms/okf-usage-counting.md).

## Snapshots

### harness_snapshots

`harness_snapshots` and `okf_snapshots` store hook-built bodies verbatim, one row per
(owner, `snapshot_id`). The insert is `ON CONFLICT DO NOTHING`. The same id can legitimately
exist under several owners (export/import: [session-export-import.md](session-export-import.md)).

- A session binds its id once (`WHERE … IS NULL`) and never overwrites it.
- `upload_queue.*_snapshot_id` marks an id as "in flight" before the ingest stores the row.
- Rows are deleted only by the orphan sweeps `deleteOrphanHarnessSnapshots` /
  `deleteOrphanOkfSnapshots`, which remove a row when no session of any owner references the id.
  The sweeps run on session purge and on team-repo deletion
  ([data-retention.md](data-retention.md)).
- The user cascade also deletes rows.
- Hash rules: [algorithms/harness-snapshot.md](algorithms/harness-snapshot.md) and
  [algorithms/okf-snapshot.md](algorithms/okf-snapshot.md).

## Configuration

`repo_config` holds the **personal** config of one user (one row per `repositories` row).
`team_repo_config` holds the team config of a link. Resolution:

- **Personal view:** personal → the caller's lowest-id team linking the URL → defaults.
- **Team view:** that team → defaults.

Personal config is found **by URL** (`findPersonalRepoConfig`, lowest `repo_id` wins).
`sessionAttribution` lives only in the team config. The `okf` section of the jsonb (the former
OKF thresholds) is **no longer read or written since 2026-11-21**: rows that have it keep it, a
settings save carries the stored section over unchanged whatever the request body holds, and
nothing resolves it; a follow-up task removes it ([okf-usage.md](okf-usage.md)). Adding a repository to a team seeds the link's
config from the owner's personal config and enqueues `team_repo_recompute_queue`, which
`TeamRepoRecomputeService` drains with `FOR UPDATE SKIP LOCKED`.

Monitored CLI tools live in separate tables (`repo_tool_monitor_config`,
`team_repo_tool_monitor_config`). The settings PUTs replace the whole `RepoConfigJson` blob, so
the tool list must stay outside it.

### user_settings

`user_settings` is a client-owned key/value store. The server never interprets names or values, so
a new setting needs no migration. The controller validates names against
`/^[A-Za-z0-9._-]{1,100}$/`. Known name: `dataCollectionNotice`
(`{"noticeHash","acceptedAt"}`, written by `DataCollectionConsentScreen.tsx`).

## Budgets

Migration `0093_budgets`: `budgets`, `budget_notices`, `budget_notice_recipients`,
`budget_events`.

### budgets

One spend budget per (scope, period). The scope is stored as columns, with **no FK** to
`repositories` / `team_repositories`, so a budget is keyed by repository URL:

| `scope_kind` | `user_id` | `team_id` | `repo_url` |
|---|---|---|---|
| `repo` (personal repository) | owner | NULL | URL |
| `team-repo` | NULL | team | URL |
| `team` | NULL | team | NULL |

- CHECK `budgets_scope_shape` enforces the table above. `period` is `day | week | month`.
  `amount_micros > 0` is in micro-USD. `thresholds smallint[]` holds percents, sorted ascending,
  default `{75,90,100}`. `time_zone` is the IANA zone of the period boundaries.
- The unique expression index `budgets_scope_period_uq` is on `(scope_kind, COALESCE(user_id,0),
  COALESCE(team_id,0), COALESCE(repo_url,''), period)`. It allows one budget per scope and period.
- `created_by` is `SET NULL` on user deletion.

### budget_notices, budget_notice_recipients

- `budget_notices` has one row per crossed `(budget_id, period_start, threshold)`. The unique key
  is the threshold job's claim: `INSERT … ON CONFLICT DO NOTHING RETURNING id`, and only the worker
  that got the id sends email. `superseded_by` NULL marks the notice shown to users. Otherwise it
  holds the higher threshold that replaced it in the same check.
- `budget_notice_recipients (notice_id, user_id, read_at)` exists only for shown notices.
  Recipients are the repository owner, or the team owner plus the team managers.
  `read_at` NULL means unread, with a partial index for the unread badge.

### budget_events

An append-only log of a scope's budgets. It records `created`, `edited`, `deleted`,
`threshold_crossed`, `threshold_superseded`, `email_sent`, `email_skipped` and `email_failed`
(CHECK). `details` is jsonb. `actor_user_id` / `actor_email` NULL means the threshold job.
`actor_user_id` is `SET NULL` on user deletion.

### Snapshot columns and cascade

- `budget_notices` and `budget_events` copy the budget's scope columns (`scope_kind`, `user_id`,
  `team_id`, `repo_url`) and `budget_label` (e.g. `Monthly $50.00`). Notices also copy `period`,
  `amount_micros` and `time_zone`. Both use the same scope-shape CHECK.
- Their `budget_id` is `ON DELETE SET NULL`, so they outlive a deleted budget.
- **Team deletion** cascades all three tables through `team_id`. **User deletion** cascades the
  `repo` kind through `user_id`. Recipients cascade with their notice and their user.
- **Repository removal and URL rewrites** have no FK to ride on. `BudgetsCleanup`
  (`deletePersonalRepo`, `deleteTeamRepo`, `rewritePersonalRepoUrl`, `rewriteTeamRepoUrl`) is
  called inside the existing transactions of admin / account / team repository deletion and of
  `RepoBackfillService`. On a URL merge where the target already has a budget of the same period,
  the target wins: the source budget is deleted, and its notices and events get the new
  `repo_url` with `budget_id` NULL.

## Pricing and versions

### model_pricing

One row per **price version**, PK `(model_id, effective_from)`. A future-dated row takes over by
itself on its day. Rules for every reader and writer (`pricingColumnsSql()` in
`server/src/logs/cost.sql.ts` emits the read shape):

- **Read** the row in effect: `effective_from <= CURRENT_DATE ORDER BY effective_from DESC`.
  Selecting by `model_id` alone can pick a future row and overcharge.
- **Join** on the normalised id `REGEXP_REPLACE(model, '-[0-9]{8}$', '')`. A raw dated id prices
  as `NULL`.
- **Insert** with `ON CONFLICT (model_id, effective_from)`. Runtime writers only write today's
  row. An unchanged price writes nothing.
- **Lock:** every price write takes `pg_advisory_xact_lock(MODEL_PRICING_LOCK_KEY)` and marks the
  model's `session_costs` rows `stale`.
- **Every new row sets `price_cache_w_5m`, `price_cache_w_1h`, `price_web_search` and `source`
  explicitly.** The defaults (`0`, `manual`) exist only for old migrations. A Claude row on the
  defaults prices 1h cache writes and web searches at zero. Convention:
  - 5m = 1.25 × `price_in`
  - 1h = 2 × `price_in`
  - web search = 0.01
- Fast mode has no stored rate (`FAST_MODE_MULTIPLIER` in `@loghub/pricing`).
- A model with **no** row prices as `NULL`, never $0; ingest registers it in
  `model_pricing_meta` and the admin tab lists it as "No price". An active override keeps the
  fetched base price in `model_pricing_meta.override_base_*`.

Sources and fetch: [model-pricing-research.md](model-pricing-research.md).

### ai_tool_version

`ai_tool_version` holds one row per tool. Its `last_attempt_at` is the cluster claim: a
conditional `UPDATE` matches only when the data is older than 24 h and the last attempt is older
than 1 h. `ai_tool_version_history` gets a row only when the `{stable, latest}` map changes. See
[claude-version-check.md](claude-version-check.md).

### log_hub_release_check

`log_hub_release_check` is a single-row cache (`id smallint PK DEFAULT 1 CHECK (id = 1)`) of the
latest published Log Hub GitHub release, for the admin "new release" badge (migration
`0086_log_hub_release_check`). All other columns are nullable:

- `latest_tag` (`varchar(64)`) — last *validated* tag, e.g. `v1.3.0`.
- `release_url` (`text`) — its validated `html_url` on `github.com/DataArt/artisyn-log-hub/releases/`.
- `fetched_at` (`timestamptz`) — last successful fetch.
- `last_attempt_at` (`timestamptz`) — the cluster claim: one attempt per 24 h whatever the outcome
  (no success clause, no 1 h retry, unlike `ai_tool_version`).

The row is inserted by the first eligible check; until then the table is empty, which reads as "no
newer release known". "Update available" is never stored — it is computed at read time against the
running version. See [system-info-and-cluster.md](system-info-and-cluster.md) (`log-hub-release` scheduler).

## Queues, jobs and run logs

### upload_queue

`upload_queue` stages async `/api/v2/logs` uploads.

- **Processing:** the worker deletes a row on success. A transient database error sends the row
  back to `pending` until `UPLOAD_QUEUE_MAX_ATTEMPTS`.
- **Expiry:** a `partially_uploaded` chunk set expires after `UPLOAD_QUEUE_PARTIAL_UPLOAD_TTL_MS`.
  No other status expires.
- **Foreign session:** a `rejected_foreign_session` warning is delivered to the hook once.
- **Agent meta:** `agent_description` / `workflow_phase` (`varchar(255)`, nullable) stage the
  sanitised sub-agent meta per plain upload or chunk (only for `claude-subagent`; `NULL`
  otherwise); the scheduler passes them to `LogsService.upsert`, which copies non-null values
  onto `sessions`.
- **Integrity and feedback (migration 0096):** `content_sha256` is the hash the hook declared
  (`contentSha256`, single upload or chunk 0); a mismatch with the staged body fails the row with
  `content-hash-mismatch`. `failure_delivered` flips to `true` once a `failed` row with
  `error_kind = 'server'` has been returned to the hook in `failedUploads`.

See [upload-queue.md](upload-queue.md).

### upload_queue_measurements

Append-only, one row per processing attempt, pruned after 7 days: a successful queue row is
deleted and each cluster worker has its own scheduler, so only this table can report throughput.
`finished_at` is deliberately its only index. `outcome` is `success | failure | skipped |
superseded`: `skipped` = the server hash skip found an identical body, `superseded` = a newer
pending upload of the same `(user, session, log_type)` replaced the row (one measurement per
dropped row). The admin stats filter on `success` / `failure`, so the two new outcomes do not
change throughput or failure figures.

### export_import_jobs

`export_import_jobs.id` is app-generated, so the staging endpoint can mint it before any row
exists; it doubles as the staged file name. The cleanup scheduler removes old terminal rows. See
[session-export-import.md](session-export-import.md).

### session_attribution

`session_attribution` is written only by one conditional upsert that replaces the whole row when
the new `prompt_watermark` is higher. `values` has a GIN index (`jsonb_path_ops`, SQL only) for
the `attr=` filter. `session_prompt_watermark` only ever rises. Evaluation is required when the
watermark exceeds the attribution's own watermark.

`session_attribution_runs` and `turn_end_advisor_runs` are append-only run logs with their own
cost columns. `turn_end_advisor_runs.session_id` is a raw string with no FK, because the hook may
report a run before the session is ingested. Reads match it by `user_id` = session owner, and an
orphan scheduler purges runs that never resolve. See
[turn-end-cost-advisor.md](turn-end-cost-advisor.md).

### session_tags

`session_tags` holds a root session's user tags, one row per distinct `(session_id, key, value,
source)`; `session_id` is always the **root** (sub-agents read their root's tags). `source =
'otel'` rows are written only by the OTEL projection writer (`applyOtelLines` →
`upsertOtelTags`, under the `otel_session_state` lock) from the resource attributes outside the
deny-list, capped at 500 `otel` rows per root, first written wins. History is backfilled by the projection drain's light
tag-only upgrade of v2 chunks (`upgradeTagsOnly`, no full re-projection; see `otel-tabs.md`). `source = 'config'` rows are the legacy hook `context` pairs migration 0099 copied
from `contexts` / `log_contexts` (walked up to the root; orphan pairs dropped) before dropping
those tables. Reads dedupe a pair stored under both sources (reported as `otel`); noise (> 10
values of one key in a session) is derived at read time, never stored. Soft delete and the team
cleanup delete the rows explicitly; hard delete cascades. Rules:
[algorithms/otel-facts.md](algorithms/otel-facts.md) rule 13.
