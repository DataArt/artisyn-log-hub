---
type: "Schema Reference"
title: "Database Structure"
description: "Database schema, table relationships, extracted field patterns, indices, and migration history."
tags:
  - database
timestamp: "2026-10-29T00:00:00+04:00"
---

# Database Structure

## Entity-Relationship Diagram

```
┌─────────────┐        ┌───────────────┐
│    users    │        │   api_keys    │
│─────────────│        │───────────────│
│ id (PK)     │◄───────│ id (PK)       │
│ email       │  1:N   │ user_id (FK)  │
│ password_   │        │ name          │
│   hash      │        │ slug          │
│ role        │        │ key_hash      │
│ created_at  │        │ created_at    │
└──────┬──────┘        │ expires_at    │
       │               └───────────────┘
       │ 1:N
       │
       ├──────────────────────────────────────────────┐
       │                                              │
       ▼                                              ▼ 1:N (CASCADE)
┌──────────────────────┐                    ┌──────────────────┐
│         logs         │                    │  repositories    │
│──────────────────────│                    │──────────────────│
│ id (PK)              │                    │ id (PK)          │
│ session_id (FK)──────┼───┐                │ user_id (FK,     │
│ user_id (FK, CASCADE)│   │                │   NOT NULL,      │
│ log_type             │   ▼                │   CASCADE)       │
│ body (jsonb)         │ ┌─────────────────┐│ repo_url         │
│ first_prompt         │ │    sessions     │└──────────────────┘
│ start_time           │ │─────────────────│
│ end_time             │ │ id (PK)         │
│ git_branch           │ │ session_id      │
│ created_at           │ └─────────────────┘
│ updated_at           │
└──────────┬───────────┘
           │
           ├──────────────────────────────────────────────┐
           │                                              │
           ▼ N:M (via log_repositories)                  ▼ N:M (via log_contexts)
┌──────────────────┐                        ┌──────────────────┐
│  repositories    │                        │    contexts      │
│──────────────────│                        │──────────────────│
│ id (PK)          │                        │ id (PK)          │
│ user_id (FK,     │                        │ context_key      │
│   NOT NULL,      │                        │ context_value    │
│   CASCADE)       │                        └──────────────────┘
│ repo_url         │
└──────────────────┘

Junction tables:
  log_repositories      (log_id FK CASCADE, repo_id FK CASCADE)    — composite PK
  log_contexts          (log_id FK CASCADE, context_id FK)         — composite PK
  user_favorite_sessions (user_id FK CASCADE, session_id FK CASCADE) — composite PK
  user_settings (user_id FK CASCADE, setting_name) — composite PK

┌──────────┐   1:N    ┌──────────────────┐   N:M   ┌──────────────────┐
│  teams   │◄─────────│  team_members    │         │      users       │
│──────────│          │──────────────────│         └──────────────────┘
│ id (PK)  │          │ team_id (FK,     │
│ name     │          │   CASCADE)       │
│ owner_id │          │ user_id (FK,     │
│   (FK)   │          │   CASCADE)       │
│created_at│          │ can_invite       │
└────┬─────┘          │ joined_at        │
     │                └──────────────────┘
     │ 1:N
     ▼
┌──────────────────┐      ┌───────────────────┐
│ team_repositories│      │   invitations     │
│──────────────────│      │───────────────────│
│ id (PK)          │      │ id (PK)           │
│ team_id (FK,     │      │ team_id (FK,      │
│   CASCADE)       │      │   CASCADE)        │
│ repo_url         │      │ inviter_id (FK)   │
│ added_at         │      │ invitee_id (FK)   │
└──────────────────┘      │ status            │
                          │ created_at        │
                          └───────────────────┘

┌──────────┐  N:M  ┌───────────────────────────┐  N:M  ┌─────────────────┐
│  users   │◄──────│  user_favorite_sessions    │──────►│    sessions     │
│──────────│       │───────────────────────────│       │─────────────────│
│ id (PK)  │       │ user_id (FK, CASCADE) (PK) │       │ id (PK)         │
└──────────┘       │ session_id (FK, CASCADE)(PK)│      └─────────────────┘
                   └───────────────────────────┘
```

## Table Descriptions

### logs

The central table. Each row is one telemetry log record per `(session_id, log_type)` pair — that combination is unique.

| Column         | Type          | Nullable | Notes                                                       |
|----------------|---------------|----------|-------------------------------------------------------------|
| `id`           | serial        | NOT NULL | PK                                                          |
| `session_id`   | integer       | NOT NULL | FK → sessions.id                                            |
| `user_id`      | integer       | NOT NULL | FK → users.id, ON DELETE CASCADE                            |
| `log_type`     | varchar(50)   | NOT NULL | Discriminator — `artisyn` \| `claude` \| `claude-subagent` \| `claude-otel` (hook 2.4.0+, named per producer, since other agents can export OTLP too) |
| `body`         | jsonb         | NOT NULL | Raw array of event lines                                    |
| `first_prompt` | text          | nullable | First user prompt extracted from body; artisyn only         |
| `start_time`   | timestamptz   | nullable | Earliest activity timestamp in body (non-activity lines skipped, see below); artisyn only |
| `end_time`     | timestamptz   | nullable | Latest activity timestamp in body (non-activity lines skipped, see below); artisyn only |
| `git_branch`   | text          | nullable | Git branch extracted from body; artisyn only                |
| `git_repo_root` | text         | nullable | Repo root of the machine the session ran on, from the hook's `git.root` (`--git-common-dir`, i.e. the **primary** checkout even for a linked worktree); artisyn only (migration `0061`) |
| `git_worktree_root` | text     | nullable | `git rev-parse --show-toplevel` of the same session, from the hook's `git.worktreeRoot`; artisyn only. Without it every path in a session run inside a linked worktree would be classified out-of-repo (migration `0061`) |
| `created_at`   | timestamptz   | NOT NULL | Row creation time                                           |
| `updated_at`   | timestamptz   | NOT NULL | Last upsert time                                            |

**Extracted fields pattern:** when a log with `log_type = 'artisyn'` is written via `POST /api/v1/logs`, the service parses the `body` array and populates `first_prompt`, `start_time`, `end_time`, `git_branch` and `git_repo_root` / `git_worktree_root` at write time. For all other log types these columns are left `NULL`. On upsert (i.e. when a log for an existing `session_id + log_type` arrives), the extracted fields are overwritten along with `body` and `updated_at`.

**Session start and end ignore non-activity lines.** `extractTimestampRange()` (`server/src/logs/artisyn-extractor.ts`) skips every line whose `type` is in `NON_ACTIVITY_LINE_TYPES`: `hook-status`, `system-context`, `skill-definitions`, `agent-definitions`, `mcp-config` and `code-inventory`. The hook prepends these synthetic events to an upload, and their timestamps record when the hook reported, not when the session worked (a `code-inventory` snapshot can predate the session by up to its 6-hour throttle window). Counting them would stretch `start_time` / `end_time`.

**`claude-otel` rows are different:** the `claude-otel` row for a session holds the **normalized** result (currently just the session cost) derived from that session's raw chunks in `logs_otel` — not raw OTLP envelopes. Raw data stays in `logs_otel`, so analytics never walks OTLP JSON. This `body` is write-only redundant storage: no cost reader parses it anymore (they all read `session_stats.telemetry_cost`, see below). It is kept — not removed — solely for the OTEL UI-invisibility guarantee; that guarantee actually comes from the `log_type` allow-list (`artisyn | claude | claude-subagent`) excluding `claude-otel` from any transcript view, not from the body's shape or presence.

### logs_otel

Raw OTEL chunk storage (migration `0041`). The hook's receiver writes one file per inbound OTLP HTTP request, the uploader ships those files in time order, and each chunk lands here as exactly one row.

| Column            | Type        | Nullable | Notes                                                                 |
|-------------------|-------------|----------|-----------------------------------------------------------------------|
| `id`              | serial      | NOT NULL | PK                                                                    |
| `session_id`      | integer     | NOT NULL | FK → sessions.id                                                      |
| `user_id`         | integer     | NOT NULL | FK → users.id, ON DELETE CASCADE                                      |
| `chunk_key`       | varchar(255)| NOT NULL | Source filename; unique per session, so re-upload upserts             |
| `received_at`     | timestamptz | nullable | Arrival time carried in the chunk                                     |
| `body`            | jsonb       | NOT NULL | The chunk's raw OTLP records                                          |
| `cost_usd_micros` | bigint      | nullable | Cost computed at chunk-processing time; NULL when the chunk has no `api_request` records |
| `record_count`    | integer     | nullable | Records in the chunk                                                  |
| `processed_at`    | timestamptz | nullable | When cost was computed                                                |
| `created_at`      | timestamptz | NOT NULL | Row creation time                                                     |

**Why integer micros:** costs are summed as `bigint` micros and divided by 1e6 once at the end, so a report over thousands of chunks carries no floating-point drift.

**Why `(session_id, chunk_key)` is unique:** the uploader re-ships a file whose size changed, so ingest must upsert — otherwise cost double-counts on every re-upload.

**Cost read path:** `ingestOtelChunk()` (`logs.service.ts`) re-aggregates `SUM(cost_usd_micros)` for the session after every chunk write and denormalizes it into `session_stats.telemetry_cost` (`NULL` when the sum is exactly 0), in the same transaction, under a `SELECT ... FOR UPDATE` lock on the session row so two concurrent chunk uploads can't lose an update. No reader queries `logs_otel` or `logs.body` for cost anymore — see `llm-call-math.md` §2.

### otel_api_calls

One row per `claude_code.api_request` OTEL record (migration `0071`) — the per-call view of
`logs_otel`, used to price **utility calls** (API calls no transcript records). Written by
`ingestOtelChunk()` (`logs.service.ts`) from `summarizeOtelChunk(lines, chunkKey).calls`
(`otel-chunk.ts`), upserted in the same transaction as the `logs_otel` row. Read only by
`utilityCostsCte()` (`otel-cost.sql.ts`), which prices each row per call with the prompt-length
tier rule (`callTierRatesSql` / `tieredCallCostSql`). See `llm-call-math.md` § "Utility calls".

| Column                  | Type         | Nullable | Notes |
|-------------------------|--------------|----------|-------|
| `id`                    | serial       | NOT NULL | PK |
| `session_id`            | integer      | NOT NULL | FK → sessions.id, ON DELETE CASCADE. The **root** session the OTEL chunk was uploaded under |
| `call_key`              | varchar(255) | NOT NULL | `request_id`, or `<chunk_key>:<1-based line index>` when the record has none |
| `request_id`            | varchar(255) | nullable | OTLP `request_id` attribute |
| `query_source`          | varchar(255) | nullable | OTLP `query_source` (`repl_main_thread`, `sdk`, `agent:<name>`, `prompt_suggestion`, …) |
| `model`                 | varchar(255) | nullable | OTLP `model` |
| `input_tokens`, `output_tokens`, `cache_read_tokens` | bigint | NOT NULL | DEFAULT 0. From the same-named attributes |
| `cache_write_5m_tokens` | bigint       | NOT NULL | DEFAULT 0. OTLP `cache_creation_tokens` — telemetry has no TTL split, so all of it goes to the 5m bucket |
| `cache_write_1h_tokens`, `web_search_requests` | bigint | NOT NULL | DEFAULT 0, always 0 today. Present so the row matches `session_stats`' column names and `sessionCostSql` prices it unchanged |
| `input_tokens_fast`, `output_tokens_fast` | bigint | NOT NULL | DEFAULT 0. Equal to `input_tokens` / `output_tokens` when `speed='fast'`, else 0 |
| `cost_usd_micros`       | bigint       | nullable | `cost_usd_micros`, else `ROUND(cost_usd * 1e6)` (the `costMicrosOf` rule) |
| `created_at`            | timestamptz  | NOT NULL | DEFAULT now() |

- Unique `otel_api_calls_session_call_unique (session_id, call_key)` — re-ingesting a chunk upserts, never duplicates.
- Index `idx_otel_api_calls_session_request_id (session_id, request_id)` — the utility classification join.
- Token attributes are read from `intValue` / `doubleValue` / `stringValue` (the `attributesOf` envelope order); a missing value is 0.

### session_request_ids

The distinct Anthropic `requestId` of every `assistant` line in a session's transcript
(migration `0071`) — the transcript side of the utility classification. Rewritten
(delete-then-insert) by `replaceSessionRequestIds(tx, sessionRowId, ids)` in
`session-stats-writer.ts`, called right after each `upsertSessionStatsRow` (two sites in
`logs.service.ts`, one in the `repositories.service.ts` recompute). The ids come from
`extractClaudeStats().requestIds` (`claude-extractor.ts`).

| Column       | Type         | Nullable | Notes |
|--------------|--------------|----------|-------|
| `session_id` | integer      | NOT NULL | FK → sessions.id, ON DELETE CASCADE. The session whose transcript holds the line (root or sub-agent) |
| `request_id` | varchar(255) | NOT NULL | Transcript `requestId` |

- PK `session_request_ids_pk (session_id, request_id)`.
- Index `idx_session_request_ids_request_id (request_id)`.
- A tree with **no** rows here (old transcripts without `requestId`) makes `utilityCostsCte` fall back to `query_source` classification.

### session_call_tokens

Per-call token counts of a session's transcript (migration `0074`), the input of the per-call
(prompt-length tier) cost path — see `llm-call-math.md` § 2. One call is one deduplicated
assistant usage of `extractClaudeStats` (keyed by `message.id`, fallback `uuid`), so the per-call
sums equal the `session_stats` token totals. Rewritten by `replaceSessionCallTokens(tx,
sessionRowId, calls)` in `session-stats-writer.ts` next to each `upsertSessionStatsRow` call
(upload, import merge, recompute-all). Sessions ingested before `0074` have no row until they are
re-ingested or recomputed.

| Column       | Type        | Nullable | Notes |
|--------------|-------------|----------|-------|
| `session_id` | integer     | NOT NULL | PK, FK → sessions.id, ON DELETE CASCADE |
| `calls`      | jsonb       | NOT NULL | Columnar object: `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWrite5mTokens`, `cacheWrite1hTokens`, `inputTokensFast`, `outputTokensFast`, each a `number[]` in first-seen call order. A missing key reads as all zeros; the writer throws when array lengths differ; a session with no calls stores empty arrays. SQL-only CHECK `jsonb_typeof(calls) = 'object'` |
| `updated_at` | timestamptz | NOT NULL | DEFAULT now() |

- Purged with the other child data on a soft delete (`SessionsService.purgeSessionChildData`).

### session_costs

Each session's stored computed cost and its breakdown terms (migration `0074`). Every session-cost
reader reads it instead of re-pricing (`llm-call-math.md` § 2 "Stored session cost"). The only
runtime writer is `recomputeSessionCosts` (`logs/session-cost/session-cost-writer.ts`), called on
ingest and by the stale-row sweeper `SessionCostRecomputeService`; migration `0074` backfilled one
row per existing `session_stats` row at base rates.

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `session_id` | integer | NOT NULL | PK, FK → sessions.id, ON DELETE CASCADE |
| `model_id` | varchar | NULL | `session_stats.model` with any `-YYYYMMDD` suffix stripped |
| `price_date` | date | NOT NULL | The **top ancestor's** price date (`sessionPriceDateSql` of the session reached via `parent_session_id`, depth ≤ 50) |
| `pricing_effective_from`, `pricing_source` | date, varchar(16) | NULL | The resolved `model_pricing` row's `effective_from` / `source`; NULL when unpriced |
| `cost` | double precision | NULL | Total computed cost in USD; **NULL means unpriced** |
| `cost_input`, `cost_output`, `cost_cache_read`, `cost_cache_write_5m`, `cost_cache_write_1h`, `cost_web_search`, `cost_fast_surcharge` | double precision | NULL | Breakdown terms at the chosen (per-call) rates; they sum to `cost`. All NULL when unpriced |
| `cost_tier_delta` | double precision | NULL | `cost` − the same tokens at base rates; informational only, never a summand |
| `unavailable_reason` | varchar(32) | NULL | `'unknown-model'` or NULL |
| `stale` | boolean | NOT NULL | DEFAULT false. Set by a pricing write (`markModelSessionsStale`) or a changed ancestor price date; cleared by the sweeper |
| `computed_at` | timestamptz | NOT NULL | DEFAULT now() |

- Partial index `idx_session_costs_stale ON (session_id) WHERE stale`; index `idx_session_costs_model_date (model_id, price_date)`.
- A session with **no** row (e.g. an OTEL-only `session_stats` row created after `0074`) counts as unpriced.
- Purged with the other child data on a soft delete (`SessionsService.purgeSessionChildData`); the delete-time audit row reads `cost` before the purge.

### users

| Column          | Type                      | Nullable | Notes                         |
|-----------------|---------------------------|----------|-------------------------------|
| `id`            | serial                    | NOT NULL | PK                            |
| `email`         | varchar                   | NOT NULL | UNIQUE                        |
| `password_hash` | varchar                   | NOT NULL |                               |
| `role`          | enum (admin \| user)      | NOT NULL | DEFAULT 'user'                |
| `created_at`    | timestamptz               | NOT NULL |                               |

### api_keys

| Column       | Type        | Nullable | Notes                                    |
|--------------|-------------|----------|------------------------------------------|
| `id`         | serial      | NOT NULL | PK                                       |
| `user_id`    | integer     | NOT NULL | FK → users.id, ON DELETE CASCADE         |
| `name`       | varchar(1000)| NOT NULL | UNIQUE per user                         |
| `slug`       | varchar(6)  | NOT NULL | Short prefix for fast lookup             |
| `key_hash`   | varchar     | NOT NULL | Only the hash is stored, never plaintext |
| `created_at` | timestamptz | NOT NULL |                                          |
| `expires_at` | timestamptz | nullable |                                          |

### sessions

| Column              | Type         | Nullable | Notes                                                                          |
|---------------------|--------------|----------|--------------------------------------------------------------------------------|
| `id`                | serial       | NOT NULL | PK                                                                             |
| `session_id`        | varchar(255) | NOT NULL | UNIQUE                                                                         |
| `parent_session_id` | varchar(255) | nullable | The `session_id` string of the TRUE immediate parent session/agent. No FK constraint, no cycle check (weak ref). |
| `workflow_run_id`  | varchar(255) | nullable | The wf-id folder name (e.g. `wf_b4978a0b-2af`) of the `Workflow` tool run that spawned this sub-agent session, mirroring `parent_session_id` (no FK, no cycle check). Set only on workflow-subdir agent uploads (hook v1.6.0+, `workflowRunId` query param on `POST /api/v1/logs`). Used server-side to resolve `WorkflowRun.agentSessionIds`. Migration: `0025_workflow_run_id.sql`. |
| `deleted`           | boolean      | NOT NULL | DEFAULT false — soft-delete flag; deleted sessions are hidden from all queries |
| `harness_snapshot_id` | varchar(64) | nullable | The DD-2 id of the [`harness_snapshots`](#harness_snapshots) row this session is bound to. No FK — the row is looked up in application code by `(owning user_id, this id)`, and an orphan sweep (`deleteOrphanHarnessSnapshots`) can delete that row out from under this column by design (see [data-retention.md](data-retention.md) § "Orphan harness-snapshot and OKF-snapshot cleanup"). `NULL` until the first `artisyn` upload that carries a `harness-snapshot` or `harness-snapshot-ref` line binds it — COALESCE-bound (`WHERE harness_snapshot_id IS NULL`), so once set it is never overwritten by a later upload. Indexed (`sessions_harness_snapshot_id_idx`): the session-logs read path looks a session's snapshot up by this column on every request. Migration: `0073_harness_snapshots.sql`. |
| `okf_snapshot_id` | varchar(64) | nullable | The DD-14 id of the [`okf_snapshots`](#okf_snapshots) row this **root** session is bound to (sub-agents resolve their root). No FK, same rationale as `harness_snapshot_id` (the orphan sweep `deleteOrphanOkfSnapshots` may delete the row under it). `NULL` until the first root `artisyn` upload carrying an `okf-snapshot` or `okf-snapshot-ref` line binds it (`WHERE okf_snapshot_id IS NULL`, never overwritten); stays `NULL` for uploads from hooks older than 2.26.0. Indexed (`sessions_okf_snapshot_id_idx`) for the OKF read path and the orphan sweep. See [okf-usage.md](okf-usage.md). Migration: `0075_okf_usage.sql`. |
| `tool_usage_version` | smallint | nullable | Tools/MCP rebuild marker (DD-7). `NULL` = the node's [`session_tool_usage`](#session_tool_usage) rows are pending a rebuild by the background drain (`ToolUsageRebuildService`); otherwise the `TOOL_USAGE_EXTRACTOR_VERSION` they were built with. Set back to `NULL` on the uploaded node and its top ancestor (`markTreeStale` / `markTreesStale`) by a `claude` / `claude-subagent` / `tool-calls` ingest, an `artisyn` ingest that inserted a new `log_repositories` link, import, `recompute-all-sessions` and a newly monitored CLI tool; `initializeDatabase()` NULLs every value below the current extractor version on start. No default: every session that existed before `0076` starts `NULL`, which is the one-off backfill. Partial index `idx_sessions_tool_usage_pending` on `(id) WHERE tool_usage_version IS NULL AND NOT deleted` (the drain's claim) and, since `0077`, `idx_sessions_tool_usage_version` on `(tool_usage_version) WHERE tool_usage_version IS NOT NULL` (the startup re-queue). See [tool-monitoring.md](tool-monitoring.md). Migrations: `0076_tool_monitoring.sql`, `0077_tool_usage_indexes.sql`. |

Lightweight deduplication table. Arriving session strings are looked up or created here; the integer FK is stored on `logs` to keep that table lean.

- A row with `parent_session_id IS NULL` is a primary (top-level) session.
- A row with `parent_session_id` set is a sub-agent session. **This is the direct spawning
  session/agent, not always the root** — Claude Code can spawn agents that themselves spawn
  further agents (orchestrator → chunk-agent → research-agent, 3+ levels), and since hook
  v1.5.0+ each level's `parent_session_id` reflects its true immediate parent (derived from the
  sub-agent's `.meta.json` sidecar's `parentAgentId`), not always the root session. A grandchild
  row's `parent_session_id` therefore points at its parent agent's `session_id`
  (`agent-<parentAgentId>`), which in turn points further up the chain — finding "all sub-agents
  under session X" requires a recursive (any-depth) walk, not a single-level equality match (see
  `server/src/logs/session-tree.sql.ts`'s `descendantSessionsCte`, used by every API/cascade site
  that needs this). Older uploads (pre-v1.5.0 hook, or true depth-1 agents / missing
  `.meta.json`) still have `parent_session_id` set directly to the root, so the recursive lookup
  must stay correct for the zero-nesting case too.
- When a sub-agent log is ingested and the referenced parent session does not yet exist, the column is still written; the parent row will be created when its own log arrives.
- A row with `deleted = true` has been soft-deleted by its owner; it is excluded from session listings and analytics queries, and re-upload of logs for a deleted session is rejected.
- Root sessions (`parent_session_id IS NULL`) older than `SESSION_RETENTION_DAYS` (by earliest `logs.created_at`) are permanently hard-deleted, along with all descendants, by `SessionRetentionService`.

### harness_snapshots

One row per `(owner user_id, snapshot_id)`: the whole DD-1 harness snapshot body the hook built
and uploaded (skills, agents, MCP servers, system-context files), stored verbatim in `body`.
Migration: `0073_harness_snapshots.sql`. See `docs/knowledgebase/algorithms/harness-snapshot.md`
for the `snapshot_id` hash algorithm and the hook-side catalog build it covers.

| Column        | Type        | Nullable | Notes                                                                          |
|---------------|-------------|----------|---------------------------------------------------------------------------------|
| `id`          | serial      | NOT NULL | PK                                                                             |
| `user_id`     | integer     | NOT NULL | FK → users.id, ON DELETE CASCADE — the uploading user, i.e. the snapshot's owner |
| `snapshot_id` | varchar(64) | NOT NULL | The hook-computed DD-2 id (64 lowercase hex); format-validated server-side, never recomputed |
| `body`        | jsonb       | NOT NULL | The DD-1 snapshot object minus its `type` field; carries its own `snapshotId` |
| `created_at`  | timestamptz | NOT NULL | DEFAULT now()                                                                  |

Unique constraint `harness_snapshots_user_id_snapshot_id_key` on `(user_id, snapshot_id)` is the
`ON CONFLICT DO NOTHING` ingest-time upsert target: two uploads of the identical snapshot from the
same owner just no-op the second insert. Index `idx_harness_snapshots_snapshot_id` on
`snapshot_id` alone backs the cross-owner "is this id known anywhere" lookup used by the orphan
sweep (`deleteOrphanHarnessSnapshots`) — the same `snapshot_id` can legitimately exist in several
owners' rows (see [session-export-import.md](session-export-import.md) for the two-owner case),
so that sweep matches on the id only, never joined to a specific owner.

Referenced (without an FK) from `sessions.harness_snapshot_id` and `upload_queue.harness_snapshot_id`
below. Rows are deleted only by `deleteOrphanHarnessSnapshots(tx)` — when no session anywhere
still references their `snapshot_id` — called from session purge (soft/hard delete, admin family
delete, retention — see [data-retention.md](data-retention.md) § "Orphan harness-snapshot
cleanup") and from the team-repo deletion path. There is no other deletion path, and account
deletion is covered by the `ON DELETE CASCADE` on `user_id` above.

### okf_snapshots

One row per `(owner user_id, snapshot_id)`: the hook's OKF knowledge-base snapshot (bundles and
their `.md` files with size, sha256 and gitignored flag), stored verbatim in `body`. Migration:
`0075_okf_usage.sql`. Id and detection rules: [algorithms/okf-snapshot.md](algorithms/okf-snapshot.md);
feature: [okf-usage.md](okf-usage.md).

| Column        | Type        | Nullable | Notes |
|---------------|-------------|----------|-------|
| `id`          | serial      | NOT NULL | PK |
| `user_id`     | integer     | NOT NULL | FK → users.id, ON DELETE CASCADE — the uploading user (owner) |
| `snapshot_id` | varchar(64) | NOT NULL | The hook-computed `okfSnapshotId` (64 lowercase hex); format-validated, never recomputed |
| `body`        | jsonb       | NOT NULL | The `okf-snapshot` line minus its `type`: `{okfSnapshotId, schemaVersion, bundles[]}`; a body over `OKF_SNAPSHOT_MAX_BYTES` (10 MB) is never stored |
| `created_at`  | timestamptz | NOT NULL | DEFAULT now(); the repo OKF route's `snapshot.takenAt` |

Unique constraint `okf_snapshots_user_id_snapshot_id_key` on `(user_id, snapshot_id)` is the
`ON CONFLICT DO NOTHING` ingest target and serves the per-owner lookups. Referenced (no FK) from
`sessions.okf_snapshot_id` and `upload_queue.okf_snapshot_id`. Rows are deleted only by
`deleteOrphanOkfSnapshots(tx)` (no session references the `snapshot_id` any more, any owner),
called beside `deleteOrphanHarnessSnapshots` from session purge and the team-repo deletion path
(see [data-retention.md](data-retention.md)), and by the `user_id` cascade.

### repositories

| Column             | Type          | Nullable | Notes                                                                          |
|--------------------|---------------|----------|--------------------------------------------------------------------------------|
| `id`               | serial        | NOT NULL | PK                                                                             |
| `user_id`          | integer       | NOT NULL | FK → users.id, ON DELETE CASCADE                                               |
| `repo_url`         | varchar(4000) | NOT NULL | UNIQUE per user (`user_id, repo_url` UNIQUE)                                   |
| `max_upload_bytes` | bigint        | nullable | Largest single artisyn upload body (bytes). Updated on every artisyn re-upload via `GREATEST(COALESCE(max_upload_bytes, 0), bodyBytes)`. Null until first artisyn upload. Migration: `0021_repositories_max_upload_bytes`. |
| `hook_version` | varchar(50) | nullable | Installed hook version last reported via a `hook-status` synthetic event (see `docs/knowledgebase/hook-system-overview.md`). `NULL` until the repo's hook has sent at least one such event — this is the "Installed Hooks" list filter. Migration: `0024_repositories_hook_state`. |
| `hook_last_activity` | timestamptz | nullable | Timestamp of the most recent `hook-status` event. Migration: `0024_repositories_hook_state`. |
| `hook_log_tail` | jsonb | nullable | Array of strings — last 50 `hook.log` lines as of the most recent report. Replaced wholesale on each report. Migration: `0024_repositories_hook_state`. |
| `hook_non_uploadable_logs` | jsonb | nullable | Array of `{file, reason}` — most recent upload attempt's failures only (replaced wholesale each report, not accumulated). Migration: `0024_repositories_hook_state`. |
| `hook_recommendations` | jsonb | nullable | Array of `{rule, message, detectedAt}` — current recommendation set; one entry per `rule`, upserted in place hook-side (see `recommendations.js` in `docs/knowledgebase/hook-system-overview.md`). Migration: `0024_repositories_hook_state`. |
| `harness_inventory_reported_at` | timestamptz | nullable | Timestamp of the most recent artisyn upload that carried an inventory self-report (skill-definitions/mcp-config/system-context). `NULL` until the repo's hook has ever reported harness inventory — drives the Harness Usage report's `inventoryReported` empty state. "Last self-report wins" semantics, same as `hook_version`. Migration: `0052_harness_elements`. |
| `harness_mcp_per_tool_supported` | boolean | nullable | The most recent artisyn upload's `mcp-config.perToolDetailSupported` flag. `NULL` = never reported by a capable hook (old hook, or no report yet) — distinguishes that case from "capable hook, this server had 0 tools" (`false`/`true` are both real reports). Migration: `0052_harness_elements`. |
| `tool_wrap_status` | jsonb | nullable | `ToolWrapStatusJson` — the CLI tool wrapper's last reported status for this repository row (DD-20): `{ hookVersion, os, preflight: { ok, reason, shells? }, breaker: { global, tools[] }, reportedAt, tools: { [name]: { lastWrapperAt } } }`. Written only by the Tools/MCP tree rebuild (`tool-wrap-status.ts` `writeToolWrapStatus`, row locked for the read-merge-write) for the rows linked to the root's `artisyn` log, when the tree has a `tool-calls` log: the newest `reportedAt` wins, `lastWrapperAt` is the max over every rebuild. `NULL` = never reported (hook older than 2.27.0, or no wrapper data yet) — drives the panel hint `hook_too_old`. Migration: `0076_tool_monitoring.sql`. |

**`repo_url` is stored in canonical form.** Every repository URL is normalised at ingest by `normalizeRepoUrl()` (`server/src/logs/repo-url-normalizer.ts`), so the SSH and HTTPS spellings of one remote map to one row:

- SSH Azure DevOps (`git@ssh.dev.azure.com:v3/org/project/repo`) and legacy `vs-ssh.visualstudio.com` → `https://dev.azure.com/org/project/_git/repo`.
- Any other SSH remote `git@<host>:<path>[.git]` → `https://<host>/<path>`.
- `http` → `https`; embedded credentials, a trailing `.git` and trailing slashes are stripped; the host is lowercased.
- `git://` URLs and anything that fails URL parsing are kept verbatim.
- The result is a fixed point: normalising it again returns it unchanged. The function repeats the single pass until the value stops changing (bounded), because a bare local path such as a Windows drive path parses differently on the first and second pass.

`RepoBackfillService` (`server/src/logs/repo-backfill.service.ts`) applies the same function on application bootstrap: it groups each user's rows by canonical URL, keeps the lowest `id` as the survivor, re-points the duplicates' `log_repositories` links to it (dropping links the survivor already has), deletes the duplicates, and rewrites any non-canonical survivor URL. It does the same for `team_repositories`.

**Repositories without a git remote** store a per-user local identity, `<owner email>/<path>`
(e.g. `muaddib@arrakis.test/C:/work/project`), not a normalised path; `normalizeRepoUrl` returns such an
identity unchanged. The format, ingest detection and the `migrateLocalRepoIdentities()` bootstrap
phase that runs before the URL backfill are in [repo-identity.md](repo-identity.md).

### contexts

| Column          | Type          | Nullable | Notes                                      |
|-----------------|---------------|----------|--------------------------------------------|
| `id`            | serial        | NOT NULL | PK                                         |
| `context_key`   | varchar(255)  | NOT NULL | UNIQUE together with context_value         |
| `context_value` | varchar(4000) | NOT NULL |                                            |

### log_repositories (junction)

| Column   | Type    | Notes                                    |
|----------|---------|------------------------------------------|
| `log_id` | integer | FK → logs.id, ON DELETE CASCADE          |
| `repo_id`| integer | FK → repositories.id, ON DELETE CASCADE  |

Composite PK on `(log_id, repo_id)`.

### log_contexts (junction)

| Column       | Type    | Notes                           |
|--------------|---------|---------------------------------|
| `log_id`     | integer | FK → logs.id, ON DELETE CASCADE |
| `context_id` | integer | FK → contexts.id                |

Composite PK on `(log_id, context_id)`.

### teams

| Column      | Type        | Nullable | Notes                                        |
|-------------|-------------|----------|----------------------------------------------|
| `id`        | serial      | NOT NULL | PK                                           |
| `name`      | varchar     | NOT NULL | UNIQUE                                       |
| `owner_id`  | integer     | NOT NULL | FK → users.id, ON DELETE RESTRICT            |
| `created_at`| timestamptz | NOT NULL |                                              |
| `access_mode` | `team_access_mode` enum | NOT NULL | DEFAULT `'restricted'`; values `transparent` / `restricted`. Owner-only setting deciding who sees whose sessions on team-scoped routes (migration `0063`, replaces the dropped `allow_member_session_visibility`) |

### team_members (junction)

| Column       | Type        | Nullable | Notes                                       |
|--------------|-------------|----------|---------------------------------------------|
| `team_id`    | integer     | NOT NULL | FK → teams.id, ON DELETE CASCADE            |
| `user_id`    | integer     | NOT NULL | FK → users.id, ON DELETE CASCADE            |
| `can_invite` | boolean     | NOT NULL | DEFAULT false                               |
| `is_manager` | boolean     | NOT NULL | DEFAULT false; owner-granted role — full-team analytics/reports plus every member's sessions, but never their prompt text. Evaluated only when the team's `access_mode = 'restricted'` (migration `0063`) |
| `is_adlc_trainer` | boolean | NOT NULL | DEFAULT false; owner-granted role — every member's sessions *with* prompts, but no analytics or reports. Stacks with `is_manager`. Evaluated only when `access_mode = 'restricted'` (migration `0063`) |
| `disclosure_acknowledged_at` | timestamptz | NULL | When this member confirmed the access-mode disclosure. `NULL` ⇒ the member is absent from the team owner's and trainers' views and from the two owner-only export surfaces until they acknowledge. Backfilled to `joined_at` for every pre-existing member by `0063` |
| `joined_at`  | timestamptz | NOT NULL |                                             |

Composite PK on `(team_id, user_id)`.

### team_repositories

| Column     | Type          | Nullable | Notes                                           |
|------------|---------------|----------|-------------------------------------------------|
| `id`       | serial        | NOT NULL | PK                                              |
| `team_id`  | integer       | NOT NULL | FK → teams.id, ON DELETE CASCADE                |
| `repo_url` | varchar(4000) | NOT NULL | UNIQUE per team (`team_id, repo_url` UNIQUE)    |
| `added_at` | timestamptz   | NOT NULL |                                                 |

### invitations

| Column       | Type        | Nullable | Notes                                     |
|--------------|-------------|----------|-------------------------------------------|
| `id`         | serial      | NOT NULL | PK                                        |
| `team_id`    | integer     | NOT NULL | FK → teams.id, ON DELETE CASCADE          |
| `inviter_id` | integer     | NOT NULL | FK → users.id                             |
| `invitee_id` | integer     | NOT NULL | FK → users.id                             |
| `status`     | varchar(20) | NOT NULL | DEFAULT 'pending'                         |
| `created_at` | timestamptz | NOT NULL |                                           |

Partial unique index: `(team_id, invitee_id) WHERE status = 'pending'` — enforced via raw SQL migration (Drizzle ORM does not support conditional unique indexes declaratively).

## Indices

### Unique constraints (implicit unique indices)

| Table              | Columns                        | Notes                                          |
|--------------------|--------------------------------|------------------------------------------------|
| `users`            | `email`                        |                                                |
| `api_keys`         | `(user_id, name)`              |                                                |
| `sessions`         | `session_id`                   |                                                |
| `repositories`     | `(user_id, repo_url)`          |                                                |
| `contexts`         | `(context_key, context_value)` |                                                |
| `logs`             | `(session_id, log_type)`       |                                                |
| `teams`            | `name`                         |                                                |
| `team_repositories`| `(team_id, repo_url)`          |                                                |
| `invitations`      | `(team_id, invitee_id)`        | Partial — WHERE status = 'pending'             |

### Performance indices (non-unique)

Added in migration `0005_missing_indices` to support common query patterns:

| Index name                       | Table              | Column(s)    | Purpose                                             |
|----------------------------------|--------------------|--------------|-----------------------------------------------------|
| `idx_logs_user_id`               | `logs`             | `user_id`    | Fetch all logs for a user                           |
| `idx_log_repositories_repo_id_log_id` | `log_repositories` | `(repo_id, log_id)` | Reverse lookup: which logs reference a repository (composite, covering; replaced the single-column `idx_log_repositories_repo_id` in migration `0022_performance_indices`) |
| `idx_team_members_user_id`       | `team_members`     | `user_id`    | Find all teams a user belongs to                    |
| `idx_invitations_invitee_id`     | `invitations`      | `invitee_id` | Find invitations sent to a specific user            |
| `idx_invitations_inviter_id`     | `invitations`      | `inviter_id` | Find invitations sent by a specific user            |
| `idx_users_role`                 | `users`            | `role`       | Filter users by role (admin vs user)                |
| `sessions_parent_session_id_idx`              | `sessions`              | `parent_session_id` | Reverse lookup — find direct children of a session; also the join column driving the recursive `descendant_sessions` CTE (any-depth lookup) |
| `idx_user_favorite_sessions_session_id`       | `user_favorite_sessions`| `session_id`        | Reverse lookup — find all users who favorited a session   |
| `sessions_deleted_idx`                        | `sessions`              | `session_id`        | Partial index WHERE deleted = true — fast lookup of soft-deleted sessions |
| `sessions_workflow_run_id_idx`                | `sessions`              | `workflow_run_id`   | Lookup — find all sessions spawned by a given workflow run (drives `WorkflowRun.agentSessionIds` resolution) |

### Other non-unique indices

| Index name | Table      | Column | Purpose                           |
|------------|------------|--------|-----------------------------------|
| (unnamed)  | `api_keys` | `slug` | Fast API key lookup by slug prefix |

### model_pricing

Stores per-model token pricing used to compute session and turn costs, one row per **price
version**. Seeded by migrations and, since migration `0066`, also written at runtime by the daily
Anthropic pricing fetch, the admin OpenRouter import and the admin set-price / override actions
(`server/src/model-pricing/`, see [Model pricing research](model-pricing-research.md)).

| Column           | Type           | Nullable | Notes                                              |
|------------------|----------------|----------|----------------------------------------------------|
| `model_id`       | varchar        | NOT NULL | PK part 1 — matches the model string in log events |
| `price_in`       | numeric(10, 6) | NOT NULL | Input token price per 1 000 000 tokens (USD)       |
| `price_out`      | numeric(10, 6) | NOT NULL | Output token price per 1 000 000 tokens (USD)      |
| `price_cache_r`  | numeric(10, 6) | NOT NULL | Cache-read token price per 1 000 000 tokens (USD)  |
| `price_cache_w`  | numeric(10, 6) | NOT NULL | **Deprecated, no readers left.** Flat cache-write price per 1 000 000 tokens (USD); carries the 5m rate. Kept, not dropped — see below |
| `price_cache_w_5m` | numeric(10, 6) | NOT NULL | DEFAULT 0 — **5-minute-TTL** cache-write price per 1 000 000 tokens (USD); migration `0051` |
| `price_cache_w_1h` | numeric(10, 6) | NOT NULL | DEFAULT 0 — **1-hour-TTL** cache-write price per 1 000 000 tokens (USD) = `price_cache_w × 1.6`; migration `0051` |
| `price_web_search` | numeric(10, 6) | NOT NULL | DEFAULT 0 — USD **per web-search request**, not per million tokens. `0.010000` for every `claude%` row, `0.000000` for the third-party rows, which offer no server tools; migration `0051` |
| `currency`       | char(3)        | NOT NULL | DEFAULT 'USD'; CHECK (currency = 'USD')            |
| `effective_from` | date           | NOT NULL | PK part 2 — date this price takes effect           |
| `chars_per_token`| numeric(6, 3)  | NULL     | Estimation-only chars-per-token ratio for this model's tokenizer generation (not billing-accurate); NULL for third-party models whose tokenizer hasn't been researched |
| `context_length` | integer        | NULL     | Max context window in tokens for this model; NULL if unresearched |
| `source`         | varchar(16)    | NOT NULL | DEFAULT `'manual'`. Origin of this price version: `anthropic` (daily fetch), `openrouter` (admin import), `manual` (admin set price, or a migration/spec insert that did not set it) or `override` (admin override). CHECK `model_pricing_source_check` is SQL-only, not mirrored in Drizzle. Migration `0066` |
| `tiers`          | jsonb          | NULL     | Prompt-length pricing tiers, migration `0074`: an array of `{ aboveTokens, priceIn, priceOut, priceCacheR, priceCacheW5m, priceCacheW1h }` (USD/MTok), ascending by `aboveTokens`, at most 10; NULL (never `[]`) when the model has none. A tier prices a call whose prompt is strictly greater than `aboveTokens`; web search always uses the base rate. CHECK `model_pricing_tiers_array_chk` (array or NULL) is SQL-only. Written by the Anthropic fetch (from "for prompts over N tokens" rows) and admin set price / override; OpenRouter writes NULL |

**Primary key is `(model_id, effective_from)`** (widened from `model_id` alone in `0034`), so a model
carries one row per price change. A future-dated row can therefore be landed ahead of a known price
change and takes over by itself on the day — no scheduled manual `UPDATE`.

> **A future-dated row can outlive its real end date.** `0034` landed the `claude-sonnet-5`
> introductory rate ($2 / $10 / $0.20) with standard pricing ($3 / $15 / $0.30) future-dated to
> `2026-09-01`. But the introductory period actually ended sooner: OTEL's authoritative
> `api_request.cost_usd` shows standard rates already in force on `2026-08-07`, so every Sonnet 5
> session was being understated by ~43%. Fixed in `0042` (after `0040` overcorrected by deleting
> the introductory period outright). The true intro end date is still unknown — somewhere in
> `[2026-07-20, 2026-08-07]` — so sessions in that window may still be understated.
>
> Lesson: a scheduled price change is a *guess* until something confirms it. Diffing computed cost
> against OTEL's per-request `cost_usd` is what caught this, and is the basis for preferring OTEL cost (`llm-call-math.md` § Two cost sources).

**Cache-write pricing is split by TTL (migration `0051`).** `price_cache_w_5m` is the
5m/1.25× rate — numerically identical to the old flat `price_cache_w`, so no 5m figure moved —
and `price_cache_w_1h` is 2× base (`price_cache_w × 1.6`, confirmed against OTEL: a 1h-cache
session priced exactly at $6.00/Mtok on a $3 base). `price_cache_w = 1.25 × price_in` held for all
26 pre-`0051` rows, which is why `× 1.6` lands exactly on 2× base; the third-party rows sit at
`0.000000` and stay there. The *tokens* were already split
(`session_stats.cache_write_5m_tokens` / `cache_write_1h_tokens`), so `0051` only had to add the
rates — before it, every 1h cache write was under-charged by exactly 1.6×.

> **Every new `model_pricing` row must populate `price_cache_w_5m`, `price_cache_w_1h` and
> `price_web_search` explicitly.** The `DEFAULT 0` on all three exists only so `0051` could add the
> columns without rewriting the table; a new Claude row left on the defaults silently prices 1h
> cache writes and web searches at **zero**, which reads as a real cost, not as missing data. The
> conventional derivation is `5m = 1.25 × price_in`, `1h = 2 × price_in`, `price_web_search = 0.01`
> for a first-party model.

**Fast-mode rates are derived, not stored.** There is deliberately no `price_in_fast` /
`price_out_fast` column: fast mode bills at `FAST_MODE_MULTIPLIER = 2` × the standard rate, and two
stored rates could drift apart. The multiplier lives in `@loghub/pricing`
(`packages/pricing/src/cost.ts`, re-exported by `server/src/logs/cost.sql.ts` and
`client/src/viewer/lib/format.ts`; the hook keeps its own copy). Cache reads, cache writes and web-search requests have no
fast-mode surcharge at all. See `llm-call-math.md` § 2–§ 3.

> **Every read must resolve to the row in effect today:**
> `WHERE effective_from <= CURRENT_DATE ... ORDER BY effective_from DESC` (with `DISTINCT ON (model_id)`
> when selecting many models, `LIMIT 1` for one). Selecting by `model_id` alone can return a
> future-dated row and overcharge. Every server cost site builds its pricing lookup with
> `pricingColumnsSql()` from `server/src/logs/cost.sql.ts`, which emits exactly this shape;
> `model-pricing.controller.ts` is the one remaining hand-written lookup.
>
> **Join on the normalised model id**, not the raw one:
> `REGEXP_REPLACE(model, '-[0-9]{8}$', '')`, so a dated id like `claude-opus-5-20260714` resolves to
> its undated pricing row. `sessions.service.ts` must join on the normalised id; joining on the raw id silently prices
> every dated session at null.
>
> Inserts must use `ON CONFLICT (model_id, effective_from)`; the old `ON CONFLICT (model_id)` no longer
> matches a unique constraint and will error.

Initially seeded with three rows: `claude-sonnet-4-6` ($3/$15), `claude-opus-4-8` ($5/$25),
`claude-haiku-4-5` ($1/$5). Later migrations add rows for further Claude and third-party models
(see `0010`, `0014`, `0023`, `0033` in the migration table below) — query the table for the current set.

> **A model with no row here prices out as null cost**, silently: the API returns no entry, and the UI
> shows no cost estimate for every session that used it. When a new model starts appearing in
> `session_stats.model`, add a pricing row for it.
>
> Since migration `0066` such a model is no longer invisible. Ingest registers it in
> `model_pricing_meta` (below) and the admin Model Pricing tab lists it as **No price**. It still
> gets **no** `model_pricing` row until a price is set or fetched. That is what keeps its cost null
> instead of $0, and keeps it out of `GET /api/v1/model-pricing`.

**A model's current source** is the `source` of its effective row (the newest one with
`effective_from <= CURRENT_DATE`). Runtime writers never touch rows dated before today:
- A change inserts a row for `CURRENT_DATE` with `ON CONFLICT (model_id, effective_from) DO UPDATE`,
  so a second change on the same day overwrites today's row.
- An unchanged price writes nothing. "Unchanged" compares all six rates, `tiers` (deeply),
  `chars_per_token`, `context_length` and `source`, rounded to 6 decimals.
- A write that inserts or updates a model's row marks that model's affected `session_costs` rows
  `stale` (`markModelSessionsStale`, inside the same transaction).
- Every price-writing transaction first takes `pg_advisory_xact_lock(MODEL_PRICING_LOCK_KEY)`
  (`7_211_066`, `model-pricing.constants.ts`).

**New pricing migrations must set `source` explicitly.** A row left on the default reads as
`manual`. The next Anthropic fetch replaces a `manual` Claude row, so the damage is limited, but the
admin tab shows the wrong source until then.

### model_pricing_meta

Per-model facts that do not belong to a price version (migration `0066`). There is at most one row
per model, and only where needed. Written by `server/src/model-pricing/unpriced-model-registry.ts`
(ingest) and `model-pricing-store.ts` (override base).

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `model_id` | varchar(255) | NOT NULL | PK. Normalised id: trimmed, `-YYYYMMDD` suffix stripped |
| `first_seen_at` | timestamptz | NULL | Set when ingest auto-registers an unpriced model. Never cleared, so the "auto-added" history stays after it gets a price |
| `override_base_source` | varchar(16) | NULL | `anthropic` / `openrouter` (SQL-only CHECK). Origin of the price hidden under an active override |
| `override_base_price_in`, `override_base_price_out`, `override_base_price_cache_r`, `override_base_price_cache_w_5m`, `override_base_price_cache_w_1h`, `override_base_price_web_search` | numeric(10,6) | NULL | The fetched/imported base price while an override is active, NULL otherwise. The daily fetch and the import keep these current instead of replacing the override |
| `override_base_chars_per_token` | numeric(6,3) | NULL | |
| `override_base_context_length` | integer | NULL | |
| `override_base_tiers` | jsonb | NULL | The base price's tiers while an override is active (migration `0074`, SQL-only CHECK `model_pricing_meta_override_base_tiers_array_chk`). Refreshed by the fetch under an override; `clearOverride` restores them |
| `updated_at` | timestamptz | NOT NULL | DEFAULT now() |

- **Unpriced** means a meta row and **no** effective `model_pricing` row.
  - Registration is one `INSERT … WHERE NOT EXISTS (effective model_pricing row) ON CONFLICT (model_id) DO NOTHING`.
  - It is called from `upsertSessionStatsRow` (upload, import, recompute) and from
    `ingestOtelChunk` (the `model` attribute of `claude_code.api_request` events).
  - It takes no lock and runs in the caller's transaction. `''` and `<synthetic>` are dropped.
- **Override active** means the effective `model_pricing` row has `source = 'override'`; the base
  lives here. If the base is missing (data drift), readers fall back to the newest non-override
  `model_pricing` row.
- Writers upsert with `ON CONFLICT (model_id) DO UPDATE` and touch only the `override_base_*`
  columns and `updated_at`.

### model_pricing_fetch_state

One row per price source, `'anthropic'` and `'openrouter'`, both seeded by migration `0066`. It feeds
the admin tab's status line and is the cluster claim row for the daily Anthropic fetch.

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `source` | varchar(16) | NOT NULL | PK |
| `last_attempt_at` | timestamptz | NULL | Stamped by the claim `UPDATE … RETURNING` (Anthropic) or by the import |
| `last_success_at` | timestamptz | NULL | Set only on non-failed runs. The Anthropic claim succeeds only when this is NULL or older than 24 h |
| `last_result` | varchar(16) | NULL | `changed` / `unchanged` / `failed` (Anthropic); `imported` / `failed` (OpenRouter) |
| `last_counts` | jsonb | NULL | Anthropic: `{ changed }`. OpenRouter: the `OpenRouterImportResult` counts |
| `last_error` | text | NULL | Failure message, NULL on success |

### session_stats

Per-session pre-computed metrics. One row per session (1:1 with `sessions`, FK with CASCADE). Written by the server log ingestion pipeline when a `claude` log is processed — and also when a `claude-otel` chunk is ingested for a session with no prior `claude`/`claude-subagent` log, which creates the row with every transcript-derived counter at its schema default and only `telemetry_cost` populated. Consumers that treat row presence as a "has transcript" signal must instead check for a `claude`/`claude-subagent` log directly (see `telemetry_cost` below and `llm-call-math.md` §2).

> **Note:** `code_files`, `code_bytes`, `doc_files`, `doc_bytes` columns were removed in migration `0013_repo_config.sql`. File-read stats are now stored per-category in the `session_file_stats` table.

| Column                | Type        | Nullable | Notes                                                   |
|-----------------------|-------------|----------|---------------------------------------------------------|
| `session_id`          | integer     | NOT NULL | PK, FK → sessions.id ON DELETE CASCADE                 |
| `model`               | varchar     | nullable | Model string from the log (e.g. `claude-sonnet-4-6`)   |
| `input_tokens`        | bigint      | NOT NULL | DEFAULT 0                                               |
| `output_tokens`       | bigint      | NOT NULL | DEFAULT 0                                               |
| `cache_read_tokens`   | bigint      | NOT NULL | DEFAULT 0                                               |
| `cache_write_tokens`  | bigint      | NOT NULL | DEFAULT 0                                               |
| `cache_write_5m_tokens` | bigint    | NOT NULL | DEFAULT 0 — cache creation with the 5-minute TTL (migration `0049`) |
| `cache_write_1h_tokens` | bigint    | NOT NULL | DEFAULT 0 — cache creation with the 1-hour TTL (migration `0049`)  |
| `web_search_requests` | bigint      | NOT NULL | DEFAULT 0 — Σ `usage.server_tool_use.web_search_requests` over deduped assistant messages; priced **per request** at `model_pricing.price_web_search` (migration `0051`). `web_fetch_requests` is not billed and is not counted |
| `input_tokens_fast`   | bigint      | NOT NULL | DEFAULT 0 — **subset of** `input_tokens` where `usage.speed = 'fast'`, not extra tokens (migration `0051`) |
| `output_tokens_fast`  | bigint      | NOT NULL | DEFAULT 0 — **subset of** `output_tokens` where `usage.speed = 'fast'`, not extra tokens (migration `0051`) |
| `work_time_ms`        | bigint      | NOT NULL | DEFAULT 0 — active work time from the claude transcript; see "Work time" below |
| `files_edited_written`| integer     | NOT NULL | DEFAULT 0 — Edit + Write tool call count                |
| `lines_changed`       | integer     | NOT NULL | DEFAULT 0 — new_string lines (Edit) + content (Write)   |
| `image_count`         | integer     | NOT NULL | DEFAULT 0 — base64 images in tool_result messages       |
| `image_total_bytes`   | bigint      | NOT NULL | DEFAULT 0                                               |
| `mcp_calls_total`     | integer     | NOT NULL | DEFAULT 0 — total `mcp__*` tool_use calls across session |
| `mcp_calls_by_server` | jsonb       | NOT NULL | DEFAULT {} — map of server name → call count (e.g. `{"playwright":3,"ide":1}`) |
| `lines_added`         | integer     | NOT NULL | DEFAULT 0 — **diff-based** added lines (migration `0050`) |
| `lines_removed`       | integer     | NOT NULL | DEFAULT 0 — **diff-based** removed lines (migration `0050`) |
| `commit_count`        | integer     | NOT NULL | DEFAULT 0 — `git commit` invocations in Bash commands, per invocation |
| `pr_count`            | integer     | NOT NULL | DEFAULT 0 — `gh pr create` invocations in Bash commands, per invocation |
| `turn_count`          | integer     | NOT NULL | DEFAULT 0 — distinct `promptId`s, the same prompt set work time is computed over |
| `diff_lines_covered_calls` | integer | NOT NULL | DEFAULT 0 — Edit/Write calls that carried a usable diff payload |
| `diff_lines_total_calls`   | integer | NOT NULL | DEFAULT 0 — Edit/Write calls made, the denominator of "over N of M calls" |
| `token_by_service_tier` | jsonb     | NOT NULL | DEFAULT {} — `{"<tier>":{input,output,cacheRead,cacheCreation,cacheWrite5m,cacheWrite1h}}`; messages with no `service_tier` key on `unknown` |
| `telemetry_cost`     | bigint      | nullable | Denormalized OTEL cost, micro-USD — same unit as `logs_otel.cost_usd_micros` (migration `0054`). `NULL` = no telemetry signal (no `claude-otel` chunk ever ingested, or the recomputed `SUM(logs_otel.cost_usd_micros)` is exactly 0); any other value is the confirmed total. Readers test `IS NOT NULL` instead of a `<> 0` guard. A cross-check only: it feeds the discrepancy warning and the mismatch flag, never the shown cost. Owned exclusively by `upsertSessionTelemetryCost()` (`session-stats-writer.ts`) — `upsertSessionStatsRow()` never writes it, so a `claude` transcript re-upload or `recompute-all-sessions` cannot reset it |
| `cs_changed_files` | integer   | nullable | Change surface (migration `0061`): distinct **own-scope** in-repo changed paths. `NULL` = never recomputed (the `telemetry_cost` precedent), never `0` |
| `cs_folders_touched` | integer | nullable | Distinct own-scope in-repo folders touched. `NULL` = never recomputed |
| `cs_outside_repo_files` | integer | nullable | Own-scope changed paths that could not be normalised into the repo. `NULL` = never recomputed |
| `cs_computed_at`   | timestamptz | nullable | "The extractor ran for this session" marker. Written **even when it found zero changed paths** (the three counters are then `0`, not `NULL`), which is what separates a genuine zero-change session from a never-recomputed one. Stays `NULL` only when no repo root was ever learned |
| `claude_version`   | varchar(64) | nullable | Claude Code version check (migration `0065`): the highest valid SemVer among the `version` fields of **this** log's transcript lines (every line type, sidechain lines included; a sub-agent log gets its own value). Written by `upsertSessionStatsRow()`. `NULL` = unknown (no line carried a parseable version, or the session was not recomputed since `0065`) |
| `claude_version_otel` | varchar(64) | nullable | OTEL fallback (migration `0065`): the highest `resource['service.version']` seen on the session's `claude-otel` chunks (lines whose `service.name` is absent or `claude-code`). Owned exclusively by `upsertSessionClaudeVersionOtel()` (`session-stats-writer.ts`), called from `ingestOtelChunk()` under the session row lock; only ever raised, never lowered. Readers use `COALESCE(claude_version, claude_version_otel)` — the transcript value wins |
| `updated_at`          | timestamptz | NOT NULL | DEFAULT now()                                           |

The `mcp_calls_by_server` JSONB object uses the server name extracted from `mcp__<server>__<tool>` tool names.

**Work time (`work_time_ms`)** is computed from the claude transcript, not from hook events
(`computeWorkTime()`, `server/src/logs/claude-extractor.ts`). For each user prompt it takes the last assistant
timestamp after that prompt and no later than the next prompt, minus the prompt's timestamp, and sums these over
all prompts. A prompt with no assistant reply contributes `0`, and idle time between a reply and the next prompt
is not counted. Hook-side prompt start/stop events are not used, because the hook writes no stop event for the
last prompt of a normally ended session, which would drop that turn.

**Invariant (test-enforced, not a DB constraint):**
`cache_write_5m_tokens + cache_write_1h_tokens = cache_write_tokens` for **every** row. Migration
`0049` only adds the columns with a `0` default — the values are backfilled by
`POST :repoId/recompute-all-sessions`, which re-runs `extractClaudeStats()` over the stored log
bodies. Without that backfill, sessions ingested before `0049` read as "100 % 5m TTL, 0 tokens total" and the
report's TTL rows are blank for historical ranges. See `llm-call-math.md` § 1 for the bucketing
rule that keeps the invariant true at turn, session and aggregate level.

**The fast-mode columns are subsets, not additions.** `input_tokens` / `output_tokens` keep
their existing "grand total" semantics, so:

```
input_tokens_fast  <= input_tokens
output_tokens_fast <= output_tokens
```

and `fast + standard` is today's per-category total by construction — no existing consumer of
`input_tokens` / `output_tokens` shifts. That is why cost is written as a *surcharge* on the grand
total, `(total + fast × (M − 1)) × rate`, rather than as separate standard and fast terms: adding
`fast × M × rate` on top of a full-total term would double-bill every fast token. Only input and
output are speed-split — there is no fast-mode cache rate. `usage.speed` absent or `'standard'`
contributes 0. Unlike the `0049`/`0050` columns, all three `0051` columns **are** backfilled by the
migration itself (a single `UPDATE … FROM (SELECT … jsonb_array_elements(l.body) …)` mirroring
`extractClaudeStats`), so no `recompute-all-sessions` pass is needed for historical rows.

**`lines_added` / `lines_removed` are NOT a redefinition of `lines_changed`.** They measure
different things and coexist deliberately:

- `lines_changed` counts lines **written** — every line present in an Edit `new_string` or a Write
  `content`. No delta, no removals. Its value, formula and consumers (`costPerLine`,
  `linesPerHour`, Branch Summary, Productivity and Executive Summary reports) are unchanged; only its *label* is "Lines changed (written)".
- `lines_added` / `lines_removed` are parsed from each Edit/Write result's
  `toolUseResult.structuredPatch`, so they carry a real add/remove split. Measured on live data,
  written-lines is ~3.1× diff-based added, and the removals have no counterpart in `lines_changed`
  at all — which is why no view, report page or PDF may show both measures at once.

`diff_lines_covered_calls` / `diff_lines_total_calls` exist because the diff payload is often
absent: sub-agent transcripts omit `toolUseResult` on most of their Edit/Write calls. Every surface
states "over N of M Edit/Write calls" rather than implying the figure is complete.

Like the cache-TTL columns, all eight are backfilled by `POST :repoId/recompute-all-sessions` (migration
`0050` only adds them with a `0`/`{}` default) — no re-upload is needed.

**The four `cs_*` columns are own-scope only, and concentration is deliberately not among them
.** They are set cardinalities, not counters: summing them over a session tree would
double-count every file two nodes touched, so they are **absent from `treeMetricsSumColumns()`**
(`session-tree-metrics.sql.ts`) and every tree/report/chart figure is recomputed from
`session_changed_paths` at read time instead. Concentration has no composable per-node value at
all — storing it would create a second source that disagrees with every rendered one. See
[`change-surface.md`](change-surface.md) and `session-metrics-scope.md` §2b.

### session_tool_stats

Per-session, per-tool call statistics (migration `0050`). One row per `(session_id,
tool_name)`, enforced by the unique index `session_tool_stats_session_tool_unique`.

**Unscoped** — no `team_id` / `user_id` — because, exactly like `session_stats` and unlike
`session_file_stats` / `session_cause_stats`, nothing about these figures depends on a scoped
`repo_config` field. A real table rather than a jsonb column on `session_stats` so that
repository-scope aggregation is a plain indexed `GROUP BY tool_name`, which is what the usage-analytics
"no `logs.body` parsing at request time" NFR requires.

| Column                   | Type         | Nullable | Notes |
|--------------------------|--------------|----------|-------|
| `session_id`             | integer      | NOT NULL | FK → sessions.id ON DELETE CASCADE |
| `tool_name`              | varchar(128) | NOT NULL | Full tool name, e.g. `Bash` or `mcp__postgres__query` |
| `calls`                  | integer      | NOT NULL | DEFAULT 0 |
| `failures`               | integer      | NOT NULL | DEFAULT 0 — only when the matching `tool_result` has `is_error === true` |
| `unresolved`             | integer      | NOT NULL | DEFAULT 0 — no result at all, or rejected / permission-denied / interrupted |
| `duration_covered_calls` | integer      | NOT NULL | DEFAULT 0 — calls with a derivable duration |
| `duration_ms_total`      | bigint       | NOT NULL | DEFAULT 0 — for the exact *mean* only; see the warning below |
| `duration_ms_max`        | bigint       | NOT NULL | DEFAULT 0 |
| `duration_ms_histogram`  | jsonb        | NOT NULL | DEFAULT `[]` — counts in the 11 fixed buckets of `tool-stats.ts` |
| `duration_by_source`     | jsonb        | NOT NULL | DEFAULT `{}` — `{toolUseResult,taskTotal,timestampDelta}` counts |
| `parallel_batch_calls`   | integer      | NOT NULL | DEFAULT 0 — calls issued in a wall-clock-overlapping batch |

Indexes: `idx_session_tool_stats_session_id`, plus the unique index above. The writer
(`session-tool-stats-writer.ts`) deletes then re-inserts a session's rows, because the set of tools
a session used can *shrink* when a log is re-extracted; an upsert would leave stale rows.

> **Never surface `duration_ms_total` as a "total tool time".** One assistant message can issue
> several `tool_use` blocks that run concurrently, so their durations overlap in wall clock and
> summing them overstates elapsed time. `parallel_batch_calls` records how many of a tool's calls
> were in such a batch, and the UI badges those rows instead.

`duration_ms_histogram`'s bucket bounds (`DURATION_BUCKET_LOWER_BOUNDS_MS` in
`server/src/logs/tool-stats.ts`) are **append-only**: changing one invalidates every stored
histogram. They exist because per-session medians cannot be averaged — repository scope interpolates
its p50 from the summed histogram and flags it approximate, while session scope computes an exact
median client-side from the raw `/logs` payload.

### harness_elements

The Harness Elements Usage report's inventory of record (migration `0052`). One row per
`(repo_id, kind, name)`, upserted from each repo's inventory self-report events
(`skill-definitions`, `mcp-config`, `.claude/rules/*` files inside `system-context`) — never
derived from usage. `first_seen` is set on first insert and never changed again; `last_seen` is
bumped on every re-report but is never cleared when an element stops being reported, so
removed/renamed elements persist in the inventory (see the `removed` rule below).

| Column               | Type          | Nullable | Notes                                                                          |
|-----------------------|---------------|----------|--------------------------------------------------------------------------------|
| `id`                  | serial        | NOT NULL | PK                                                                             |
| `repo_id`             | integer       | NOT NULL | FK → repositories.id, ON DELETE CASCADE                                       |
| `kind`                | varchar(16)   | NOT NULL | `'skill'` \| `'rule'` \| `'mcp'` \| `'tool'`                                   |
| `name`                | varchar(255)  | NOT NULL | For an MCP-sourced `tool`-kind row: `mcp__<server>__<tool>` — same convention as `session_tool_stats.tool_name`, so no separate join key is needed for usage matching |
| `mcp_server`          | varchar(128)  | nullable | Non-null only for `tool`-kind rows sourced from an MCP server                  |
| `mcp_connected`       | boolean       | nullable | Meaningful only for `kind='mcp'`; `NULL` = never reported                      |
| `schema_size_tokens`  | integer       | nullable | Meaningful only for `tool`-kind MCP-sourced rows; static `÷4` estimate from the hook's `tools/list` probe (see `hook-system-overview.md`) |
| `first_seen`          | timestamptz   | nullable | `NULL` for built-in tool rows — always-present, never "added" by a specific repo |
| `last_seen`           | timestamptz   | nullable | Bumped on every re-report; compared against `repositories.harness_inventory_reported_at` to derive `removed` |
| `source`              | varchar(16)   | nullable | Meaningful only for `kind='skill'`: `'project'` (`.claude/skills/`) \| `'plugin'` (`~/.claude/plugins/`) \| `NULL` (older hook never reported it). Migration `0053_harness_element_skill_source` — powers the report's "project skills only" filter |
| `created_at`          | timestamptz   | NOT NULL | DEFAULT now()                                                                  |

Unique index `harness_elements_repo_kind_name_unique` on `(repo_id, kind, name)` is the
`ON CONFLICT` upsert target (`harness-elements-writer.ts`, mirrors `session-tool-stats-writer.ts`
style). Index `idx_harness_elements_repo_id` on `repo_id`.

**Built-in `tool`-kind rows are seeded once, read-only**, from a static list in
`server/src/logs/builtin-tools.ts` (`BUILTIN_TOOL_NAMES`). It was originally a mirror of the
client's `viewer/lib/tools/registry.ts` `TOOLS` array, but that client registry was removed as
dead code (2026-10-13 open-source readiness), so the server list is now the only copy (the
checked-in `tests/fixtures/builtin-tool-names.json` mirrors it — update both together). Built-in rows have
`first_seen`/`last_seen` both `NULL` and are never `removed`.

**`removed` is computed at read time, not stored**: an element is `removed` iff its `last_seen`
is older than the repo's `harness_inventory_reported_at` (the latest self-report the repo has
ever sent) — i.e. the most recent self-report was received and this element was not part of it.
A built-in tool row (`last_seen IS NULL`) is never `removed`.

### session_harness_usage

Per-session harness usage facts (migration `0052`) — one row per `(session_id, kind,
name)`. Always computed from the `claude`/`claude-subagent` transcript at ingest time (tool/MCP
rows) or from that session's own artisyn inventory self-report (skill/rule rows — "used" means
"loaded into this session's context", not "explicitly invoked"); never from `harness_elements`.
`HarnessUsageService` aggregates from this table for count/token figures — `harness_elements`
only supplies the zero-usage rows a group/period didn't touch.

| Column          | Type    | Nullable | Notes                                                                     |
|-----------------|---------|----------|-----------------------------------------------------------------------------|
| `session_id`    | integer | NOT NULL | FK → sessions.id, ON DELETE CASCADE                                        |
| `kind`          | varchar(16) | NOT NULL | `'skill'` \| `'rule'` \| `'mcp'` \| `'tool'`                            |
| `name`          | varchar(255) | NOT NULL | Bare or `mcp__<server>__<tool>`-prefixed, matching `harness_elements.name` |
| `mcp_server`    | varchar(128) | nullable | Non-null only for MCP-sourced `tool`-kind rows                          |
| `uses`          | integer | NOT NULL | DEFAULT 0                                                                  |
| `input_tokens`  | bigint  | NOT NULL | DEFAULT 0                                                                  |
| `output_tokens` | bigint  | NOT NULL | DEFAULT 0                                                                  |
| `is_initial`    | boolean | nullable | `kind='tool'` only; `NULL` for skill/rule/mcp. Whether the tool was present from session start vs. added later via a `deferred_tools_delta` attachment (session-scoped, not stored on `harness_elements`) |

Unique index `session_harness_usage_session_kind_name_unique` on `(session_id, kind, name)`.
Index `idx_session_harness_usage_session_id` on `session_id`.

**Two different write patterns share this table**, both writing before the other's rows exist for
that session:

- Tool/MCP rows (claude-branch of `logs.service.ts`, `session-harness-usage-writer.ts`):
  **delete-then-reinsert** per session, mirroring `session_tool_stats` — the element set a
  session touches can shrink on re-extraction, so an upsert alone would leave stale rows.
- Skill/rule rows (artisyn-branch): `ON CONFLICT (session_id, kind, name) DO UPDATE SET uses = 1`
  — idempotent re-upload (`uses` is always exactly `0` or `1` for these two kinds), not additive.

**Character-proportional token attribution (skill/rule rows):** a skill/rule's token share is
attributed only against the session's first assistant message (the one turn the injected content
is freshly billed, before caching takes over), split proportionally by each context-injected
element's own byte size versus the first user prompt's character count. See
`splitTokensByCharacterShare()` in `claude-extractor.ts` and `llm-call-math.md` if a cache-attribution
question comes up elsewhere.

### repo_config

Stores the **personal** per-repository analysis configuration of one user (team configs live in
`team_repo_config` since migration `0072`, which dropped `team_id` and made `user_id` NOT
NULL). What lives in the `config` blob (`RepoConfigJson`): the **file categories** used to
classify Read tool calls when computing `session_file_stats`, the **high-cache-creation
threshold** used to compute `session_cause_stats`, and `turnEndCostAdvisor`
(`sessionAttribution` is team-only and never stored here).

| Column       | Type        | Nullable | Notes                                                                     |
|--------------|-------------|----------|---------------------------------------------------------------------------|
| `repo_id`    | integer     | NOT NULL | FK → repositories.id, ON DELETE CASCADE                                   |
| `user_id`    | integer     | NOT NULL | FK → users.id, ON DELETE CASCADE                                          |
| `config`     | jsonb       | NOT NULL | `RepoConfigJson` — `{ fileCategories: [{ name, patterns[] }], highCacheCreationThreshold?: number, … }` |
| `updated_at` | timestamptz | NOT NULL | DEFAULT now()                                                             |

Partial unique index `(repo_id, user_id) WHERE user_id IS NOT NULL` (SQL only) is the
`ON CONFLICT` target of `saveUserConfig`. Readers look a user's personal config up **by URL**
(`findPersonalRepoConfig(userId, repoUrl)` in `server/src/logs/team-repo-config.ts`, lowest
`repo_id` wins), not by one `repositories` row.

**Resolution order** (`RepositoriesService.resolveEffectiveConfig` / `getRepoSettings` /
`getEffectiveCacheThreshold`):

| View | Order |
|---|---|
| Personal (no `teamId`) | personal `repo_config` → `team_repo_config` of the caller's lowest-id team linking the URL → default |
| Team (`teamId` = T) | `team_repo_config` of T → default (the personal config is ignored) |

The default is `DEFAULT_TEAM_VIEW_CONFIG` = `{ fileCategories: DEFAULT_FILE_CATEGORIES }` and,
for the threshold, `DEFAULT_HIGH_CACHE_CREATION_THRESHOLD`. Requests without `teamId` (old
clients, the hook's `GET /api/v2/post-turn-analysis/config`, the turn-end cost advisor) use the
lowest team id among the user's teams (member or owner) linking the URL
(`resolveUserTeamForUrl`).

**`highCacheCreationThreshold`** (no schema change — `config` is a jsonb blob) is the per-turn
cache-creation token count at or above which a turn is large enough to be attributed to a cause.
There is deliberately **no DB default**: a missing field means the TS constant
`DEFAULT_HIGH_CACHE_CREATION_THRESHOLD` (25 000) in `server/src/logs/cache-ratio.sql.ts`, mirrored
client-side in `client/src/viewer/lib/cache-ratio-ui.ts`. `validateConfig` rejects a non-integer or
a value outside `CACHE_CREATION_THRESHOLD_MIN` (1 000) … `CACHE_CREATION_THRESHOLD_MAX`
(10 000 000) with a `400`. Because a team value and a personal override can be in force for the
same session *simultaneously*, the figures it drives cannot live in the unscoped `session_stats`
row — hence `session_cause_stats` below. Saving a threshold via the existing
`PUT :repoId/settings/team` / `settings/user` routes triggers `recomputeTeamScope()` /
`recomputeForRepo()`, which re-buckets that scope's cause rows and leaves the other scope's
rows untouched.

### team_repo_config

The single team config of one (team, repoUrl) pair (migration `0072`). It belongs to the
`team_repositories` link, not to any member's `repositories` row, so it survives a member's
repository or account deletion and is removed by the FK cascade on every link-delete path
(`unlinkTeamRepository`, `removeTeamRepository`, `deleteTeam`, `AdminService.removeRepo`,
`AccountDeletionService`). `migrateLocalRepoIdentities` rewrites `team_repositories.repo_url` in
place, so the config follows its link. No row means `teamConfig = null` (team view then shows
the defaults).

| Column               | Type        | Nullable | Notes                                                      |
|----------------------|-------------|----------|------------------------------------------------------------|
| `team_repository_id` | integer     | NOT NULL | PK; FK → team_repositories.id, ON DELETE CASCADE           |
| `config`             | jsonb       | NOT NULL | `RepoConfigJson` (all fields, `sessionAttribution` included) |
| `updated_at`         | timestamptz | NOT NULL | DEFAULT now()                                              |

All reads and writes go through `server/src/logs/team-repo-config.ts`. Seeding:
`TeamsService.addTeamRepository` seeds a **new** link with the team owner's personal config for
the URL, else `TEAM_CREATION_DEFAULT_CONFIG` (`ON CONFLICT DO NOTHING`) — even when nobody
has uploaded the URL yet — then runs `recomputeTeamScope`. Re-adding an already linked URL
neither seeds nor recomputes. Writes: `saveTeamConfig` (team owner only; with `teamId` exactly
that team, without it the caller's lowest-id owned team linking the URL); `null` deletes the
row.

### repo_tool_monitor_config

The **personal** monitored-CLI-tools list of one repository row (Tools/MCP tab, DD-1; migration
`0076`). A `repositories` row is already per user, so `repo_id` alone is the key. Kept apart from
`repo_config` on purpose: the settings PUTs replace the whole `RepoConfigJson` blob and run the
file-stats recompute, which must never drop the tool list or be triggered by it. No row = the
empty config. Reads and writes: `ToolMonitorConfigService`
(`server/src/logs/tool-monitoring/tool-monitor-config.service.ts`).

| Column       | Type        | Nullable | Notes |
|--------------|-------------|----------|-------|
| `repo_id`    | integer     | NOT NULL | PK; FK → repositories.id, ON DELETE CASCADE |
| `config`     | jsonb       | NOT NULL | `ToolMonitorConfigJson` = `{ paused: boolean, tools: [{ name, enabled, capture: 'full' / 'meta' }] }`; at most 100 tools, names unique case-insensitively and valid per `validateToolName` (`@loghub/tool-monitor`). Read tolerantly: malformed entries are dropped |
| `updated_at` | timestamptz | NOT NULL | DEFAULT now() |

### team_repo_tool_monitor_config

The **team** monitored-CLI-tools list of a (team, repoUrl) link (migration `0076`), the
counterpart of `team_repo_config`: owned by the `team_repositories` link and removed by its FK
cascade. Edited by the team owner only. The hook and the rebuild use the merge of the owner's
personal row and every team row whose team links the URL and has the owner as a member
(`resolveMonitoredTools`, DD-2: union of the enabled tools, `full` capture wins, any `paused`
pauses).

| Column               | Type        | Nullable | Notes |
|----------------------|-------------|----------|-------|
| `team_repository_id` | integer     | NOT NULL | PK; FK → team_repositories.id, ON DELETE CASCADE |
| `config`             | jsonb       | NOT NULL | `ToolMonitorConfigJson` (as above) |
| `updated_at`         | timestamptz | NOT NULL | DEFAULT now() |

### session_cause_stats

Per-session decomposition of cache-creation tokens by **cause**, written during `claude` log ingestion (migration `0049`). Shape mirrors `session_file_stats`: nullable `team_id` / `user_id`, one row per (session, config scope).

Why scoped: the decomposition depends on `highCacheCreationThreshold`, which can differ per team and per user at the same time, and `session_stats` has no scoping column. `threshold` records the value the stored totals were computed with, so a reader can detect a stale row (the report counts those as `staleSessionCount`).

| Column                | Type    | Nullable | Notes                                                        |
|-----------------------|---------|----------|--------------------------------------------------------------|
| `session_id`          | integer | NOT NULL | FK → sessions.id, ON DELETE CASCADE                          |
| `team_id`             | integer | nullable | FK → teams.id, ON DELETE CASCADE; set for team-scoped rows   |
| `user_id`             | integer | nullable | FK → users.id, ON DELETE CASCADE; set for user-scoped rows   |
| `threshold`           | integer | NOT NULL | The threshold these totals were computed with                |
| `compaction_tokens`   | bigint  | NOT NULL | DEFAULT 0                                                    |
| `file_reread_tokens`  | bigint  | NOT NULL | DEFAULT 0                                                    |
| `unattributed_tokens` | bigint  | NOT NULL | DEFAULT 0                                                    |
| `compaction_turns`    | integer | NOT NULL | DEFAULT 0                                                    |
| `file_reread_turns`   | integer | NOT NULL | DEFAULT 0                                                    |
| `unattributed_turns`  | integer | NOT NULL | DEFAULT 0                                                    |

Indexes: `idx_session_cause_stats_session_id` on `(session_id)`; partial unique
`idx_session_cause_stats_session_team` on `(session_id, team_id) WHERE team_id IS NOT NULL`;
partial unique `idx_session_cause_stats_session_user` on `(session_id, user_id) WHERE user_id IS
NOT NULL`. The two partial unique indexes are the `ON CONFLICT` targets of the scoped upsert
(`session-cause-stats-writer.ts`) and exist **in SQL only** — Drizzle cannot express a partial
unique index declaratively, exactly as with `repo_config`.

**Invariant (test-enforced, not a DB constraint):**
`compaction_tokens + file_reread_tokens + unattributed_tokens = session_stats.cache_write_tokens`
for the same session. Every cache-creation token lands in exactly one bucket; sub-threshold turns
and tokens on assistant events belonging to no turn go to `unattributed`. Cause rules and the turn
walk are documented in `llm-call-math.md` § 8.

Write-time scope: one row per team linking the session's own linked repo URLs (`getSessionRepoUrls()`, teams from `listTeamScopesForUrls`) — its `team_repo_config` threshold, else the default — plus **always** the uploader's user-scoped row (personal threshold, else the default). Unlike `session_file_stats`, other users' personal configs on the same repo URL get no row. Read-time scope (`RepositoriesService.resolveCauseStatsScope(userId, teamId?)`): team view → `team_id = T`, personal view → `user_id`. Existing sessions get their rows from `recomputeTeamScope()` / `recomputeForRepo()`, not from the migration — a session with no row for the resolved scope is reported as `sessionsWithoutCauseData` rather than silently dropped.

### session_file_stats

Per-session, per-category file-read statistics, one row per (session, category, scope). Every
write goes through `server/src/logs/session-file-stats-writer.ts` — ingest, import, the
claude-before-artisyn heal and the settings-save recompute share one writer.

- **Path normalisation.** Each Read path is made repo-relative by `normaliseReadPath()`
  (`claude-extractor.ts`) before category patterns are matched. The repo roots are
  `[git_repo_root, git_worktree_root]` of the node's own `artisyn` log, else its nearest
  ancestor's (`resolveSessionRepoRoots()`; only tree-root sessions carry an `artisyn` log, so a
  sub-agent uses its root's). A path under a root is stripped with
  `stripRepoRootPreservingCase()` — longest root wins, case-insensitive on a `/` boundary,
  original case kept. A path under **no** root stays absolute (backslashes → `/`, nothing
  stripped), so a pattern like `^docs/` cannot match an unrelated `/home/u/other/docs/x.md`. Only when the
  session has no known root at all does it fall back to `normaliseFilePath()`'s
  `KNOWN_TOP_LEVEL_DIRS` heuristic.
- **Write set.** `resolveFileStatsScopes()` takes the repo URLs linked to the nearest linked node
  of the session tree (`resolveSessionTreeRepoUrls()`, so sub-agents inherit them). It writes one
  row set per team linking those URLs (`listTeamScopesForUrls`: its `team_repo_config`
  categories, else `DEFAULT_FILE_CATEGORIES`) and one per user with a personal `repo_config`
  row on those URLs, across owners (first per user wins), not only the uploader's. The uploader
  always gets a user-scoped row set — their personal categories, else `DEFAULT_FILE_CATEGORIES`.
  No linked repo → only the uploader's default rows.
- **Read scope.** The analytics timeline reads `team_id = T` in team view and `user_id` = the
  caller in personal view — never mixed.
- **Delete per scope.** `writeSessionFileStats()` handles each scope independently: `DELETE`
  that scope's rows for the node, then insert the categories with a non-zero file or byte count
  (`ON CONFLICT … DO UPDATE` on the partial unique indexes guards concurrent writers). Scopes
  not in the list are never touched.
- **Heal.** The `claude` log may arrive before the `artisyn` log that supplies the root and the
  repo link. The artisyn ingest branch calls `rewriteSessionTreeFileStats()` right after
  `renormaliseSessionChangedPaths()`, in the same transaction, and only when the artisyn log was
  newly inserted, a repo link was actually inserted, or `git_repo_root` / `git_worktree_root`
  changed. It reparses the stored `claude` / `claude-subagent` bodies of the whole tree with the
  resolved roots and scopes. Repeated artisyn chunks that change nothing do not trigger it.
- **Recompute.** `recomputeForRepo()` / `recomputeTeamScope()` (settings save, link add,
  `POST recompute-all-sessions`) rewrite the saved scope's rows for every session tree linked to
  any `repositories` row with the same `repo_url` (all owners, descendants included). Deleting a
  **personal** config (`PUT …/settings/user` with `null`) rewrites that user's rows with
  `DEFAULT_FILE_CATEGORIES` instead of deleting them; deleting a team config likewise rewrites
  that team's rows with the defaults. Sessions imported via
  export/import keep the fallback until such a recompute (import gets no heal).

| Column          | Type         | Nullable | Notes                                                                  |
|-----------------|--------------|----------|------------------------------------------------------------------------|
| `session_id`    | integer      | NOT NULL | FK → sessions.id, ON DELETE CASCADE                                    |
| `category_name` | varchar(64)  | NOT NULL | Category name from the matching `repo_config` (e.g. `"code"`, `"docs"`) |
| `file_count`    | integer      | NOT NULL | DEFAULT 0 — number of Read tool calls matched to this category         |
| `byte_count`    | bigint       | NOT NULL | DEFAULT 0 — total size of the text the matched Read calls returned into the context: `String.length` (UTF-16 code units, not UTF-8 bytes), line-number prefixes included, failed and repeated Reads included — by design, not the file size on disk |
| `team_id`       | integer      | nullable | FK → teams.id, ON DELETE CASCADE; set when ingested under a team scope |
| `user_id`       | integer      | nullable | FK → users.id, ON DELETE CASCADE; set when ingested under a user scope |

Query-time resolution: the analytics timeline endpoint joins `session_file_stats` filtered by the caller's effective scope (team or user) to build `fileStatsByCategory` on each `TimelineSession`.

### session_okf_access

Per tree node (`sessions` row = the root agent or one sub-agent), which repo paths the node's
transcript read, searched, listed or wrote — the data of the OKF tabs. Derived data: rebuilt
delete-then-insert per node by `server/src/logs/okf/okf-access-writer.ts` on ingest, import,
the file-stats heal and `recompute-all-sessions` (the only backfill for older sessions).
Extraction rules: [algorithms/okf-access-extraction.md](algorithms/okf-access-extraction.md);
feature: [okf-usage.md](okf-usage.md). Migration: `0075_okf_usage.sql`.

| Column           | Type          | Nullable | Notes |
|------------------|---------------|----------|-------|
| `id`             | serial        | NOT NULL | PK |
| `session_id`     | integer       | NOT NULL | FK → sessions.id, ON DELETE CASCADE (the node) |
| `path_key`       | varchar(1024) | NOT NULL | Repo-relative `.md` file path (original case), or a folder path ending `/` (repo root = `/`) |
| `op`             | varchar(8)    | NOT NULL | CHECK `read` | `grep` | `list` | `write` |
| `after_own_edit` | boolean       | NOT NULL | DEFAULT false — a `read` / `grep` of a path this node had already written |
| `bytes`          | bigint        | NOT NULL | DEFAULT 0 — UTF-8 bytes of the tool results (a multi-path Bash call split evenly); 0 for `write` |
| `calls`          | integer       | NOT NULL | DEFAULT 0 — tool calls |
| `seq`            | integer       | NOT NULL | 1-based rank of the path's first access within the node (all rows of a path share it) |

Unique constraint `session_okf_access_session_path_op_edit_key` on
`(session_id, path_key, op, after_own_edit)`; its leading `session_id` serves the per-node delete
and the tree read, so there is no separate index. Session purge deletes the rows explicitly (step
c2 — a soft delete keeps the `sessions` row, so the cascade would not run).

### session_tool_usage

Per tree node (`sessions` row = the root agent or one sub-agent), the MCP and CLI tool calls of
the Tools/MCP tab — one row per `(session_id, channel, tool)`. Derived data: rebuilt
delete-then-insert per **session tree** by the background drain `ToolUsageRebuildService`
(`tool-usage-writer.ts` `rewriteTreeToolUsage`) whenever `sessions.tool_usage_version` is `NULL`;
ingest never writes it inline. A call belongs to the node whose transcript holds it; an unmatched
(`indirect`) wrapper record belongs to the root. Feature: [tool-monitoring.md](tool-monitoring.md).
Migration: `0076_tool_monitoring.sql`.

| Column             | Type        | Nullable | Notes |
|--------------------|-------------|----------|-------|
| `id`               | serial      | NOT NULL | PK; the `usageId` of the call-detail route |
| `session_id`       | integer     | NOT NULL | FK → sessions.id, ON DELETE CASCADE (the node) |
| `channel`          | varchar(8)  | NOT NULL | CHECK `mcp` / `cli` (SQL only) |
| `tool`             | text        | NOT NULL | MCP server name (segment 1 of `mcp__<server>__…`) or the CLI tool name |
| `call_count`       | integer     | NOT NULL | DEFAULT 0 |
| `first_call_at`    | timestamptz | nullable | Earliest call start in the row |
| `last_call_at`     | timestamptz | nullable | Latest call start; the date-range reads filter on it after reaching the scoped tree's rows by `session_id`, so it is not indexed (`idx_session_tool_usage_last_call_at` from `0076` was dropped by `0077`) |
| `has_wrapper_data` | boolean     | NOT NULL | DEFAULT false — at least one call of the row came from a wrapper record |
| `aggregates`       | jsonb       | NOT NULL | `ToolUsageAggregates` = `{ operations: { [op]: { calls, errors, killed, noResult, empty, retried, openedFile, durationMsSum, durationCount, inBytesSum, outBytesSum, lastTs } } }` (DD-11). The summary route reads only this column |
| `calls`            | jsonb       | NOT NULL | `ToolCallRecord[]` — per-call metadata, no output text, at most a 300-character `inputPreview` (DD-10) |
| `outputs`          | jsonb       | nullable | `{ [callId]: { input?, stdin?, stdout?, stderr?, agentSaw?, encoding } }` — captured text, each part capped at 100 KB (DD-9). Read only by the call-detail route and the search |

The three jsonb columns are TOASTed separately, so a query that names only `aggregates` never
detoasts the call lists or the outputs. Unique constraint
`session_tool_usage_session_channel_tool_key` on `(session_id, channel, tool)`; its leading
`session_id` serves the per-node delete and the tree read, so there is no separate index. Session
purge deletes the rows explicitly (`sessions.service.ts` step c3 — a soft delete keeps the
`sessions` row, so the cascade would not run).

### session_changed_paths

Change surface (migration `0061`) — per-session changed-path facts, one row per **logical**
changed path. Written during `claude` / `claude-subagent` ingestion from the transcript's
Edit/Write/MultiEdit calls plus the hook's `edit_result` records, and rewritten in place by
`renormaliseSessionChangedPaths()` once the session's `artisyn` log supplies a repo root.

No surrogate PK (matching `session_tool_stats` / `session_harness_usage` / `session_file_stats`):
the unique index **is** the key. The FK cascades on session delete, so retention purge, repo/session
delete and e2e cleanup keep working unchanged.

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `session_id` | integer | NOT NULL | FK → sessions.id, ON DELETE CASCADE |
| `path_key` | varchar(1024) | NOT NULL | **Row identity**: the case-folded repo-relative path, else the slash-normalised, case-folded, root-less raw path. The writer aggregates per-call facts by this key *before* inserting, so two spellings of one file are one row |
| `raw_path` | varchar(1024) | NOT NULL | First raw spelling seen; always stored verbatim so renormalisation never re-parses the transcript |
| `rel_path` | text | nullable | Repo-relative, **original case** (display). `NULL` when out-of-repo or the root was never learned |
| `rel_path_key` | text | nullable | Case-folded `rel_path` — the distinctness key of every union |
| `folder` | text | nullable | Display folder; `.` for a repo-root file |
| `folder_key` | text | nullable | Case-folded `folder` — the `GROUP BY` key |
| `top_module_key` | text | nullable | Case-folded first segment; `.` for a repo-root file |
| `depth` | integer | nullable | Segment count of `folder` (`0` for `.`) |
| `file_kind` | varchar(16) | nullable | Fixed cross-repo taxonomy: `source` \| `test` \| `config` \| `docs` \| `other` (**not** the per-repo `repo_config` categories) |
| `extension` | varchar(32) | nullable | Lowercased, no dot; `''` when the file has none |
| `outside_repo` | boolean | NOT NULL | DEFAULT false. Distinguishes "outside the repo" from "repo root never learned" (which leaves every normalised column `NULL` with `outside_repo = false`) |
| `change_kind` | varchar(16) | NOT NULL | `added` \| `modified`. `deleted` is reserved and never written — deletions go through `Bash rm`, not the edit/write tools |
| `edit_calls` | integer | NOT NULL | DEFAULT 0 |
| `diff_covered_calls` | integer | NOT NULL | DEFAULT 0 — calls whose `+`/`−` come from a real diff. Never conflate with `change_kind` |
| `lines_added` | integer | NOT NULL | DEFAULT 0 |
| `lines_removed` | integer | NOT NULL | DEFAULT 0 |

Indexes: unique `session_changed_paths_session_path_key_unique` on `(session_id, path_key)`;
`idx_session_changed_paths_session_id`; `idx_session_changed_paths_session_folder` on
`(session_id, folder_key)`. `path_key` / `raw_path` are truncated to 1024 chars at write time so a
unique-index row can never exceed Postgres' 2704-byte limit.

### repo_code_inventory

Change surface (migration `0061`) — repository code-size snapshots, the **denominator** for
the report's "share of the codebase touched" indicators. Written from the hook's independently
throttled `code-inventory` NDJSON event.

A **history**, not one current row per repo: a report divides by the newest snapshot at or before
its own period end, not by today's. Growth is bounded by the writer, which prunes to the newest
`REPO_CODE_INVENTORY_KEEP` (500) rows per repo after each insert.

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | serial | NOT NULL | PK |
| `repo_id` | integer | NOT NULL | FK → repositories.id, ON DELETE CASCADE |
| `captured_at` | timestamptz | NOT NULL | When the hook measured it |
| `branch` | varchar(255) | NOT NULL | DEFAULT `''`. Deliberately not nullable: Postgres treats NULLs as distinct in a unique index, so a nullable branch would make a re-uploaded snapshot insert a duplicate instead of being idempotent |
| `commit_sha` | varchar(40) | nullable | `git rev-parse HEAD` at capture time |
| `tracked_files` | integer | NOT NULL | Row count of `git diff --numstat <empty-tree> HEAD` |
| `tracked_lines` | bigint | NOT NULL | Sum of the numstat "added" column over non-`-` rows |
| `tracked_binary_files` | integer | NOT NULL | DEFAULT 0 — count of `-` numstat rows |
| `created_at` | timestamptz | NOT NULL | DEFAULT now() |

Indexes: unique `repo_code_inventory_repo_captured_branch_unique` on
`(repo_id, captured_at, branch)`; `idx_repo_code_inventory_repo_captured_at` on
`(repo_id, captured_at)`. No snapshot → the report renders `n/a · denominator unavailable`, never
`0%`.

### deleted_session_log

Audit log written whenever a session is soft-deleted. One row per deletion event. No FKs to `sessions` (the session row may be retained with `deleted = true`); references are stored as plain integer/varchar columns.

| Column              | Type           | Nullable | Notes                                                         |
|---------------------|----------------|----------|---------------------------------------------------------------|
| `id`                | serial         | NOT NULL | PK                                                            |
| `session_id`        | varchar(255)   | NOT NULL | The session_id string of the deleted session                  |
| `session_pk`        | integer        | NOT NULL | The integer PK of the sessions row; UNIQUE (migration `0031`) — one audit row per session, ever, and the claim primitive `SessionsService.hardPurgeExpiredSessions()` uses (`INSERT ... ON CONFLICT DO NOTHING`) to stay idempotent when multiple prod instances race to purge the same session |
| `owner_user_id`     | integer        | nullable | User who owns the session (may differ from deleter)           |
| `deleted_by_user_id`| integer        | nullable | User who performed the deletion; `NULL` = automated retention purge (`SessionRetentionService`, migration `0030`), not a user-triggered deletion |
| `deleted_at`        | timestamptz    | NOT NULL | DEFAULT now()                                                 |
| `start_time`        | timestamptz    | nullable | Session start time (copied from session_stats at deletion)    |
| `end_time`          | timestamptz    | nullable | Session end time (copied from session_stats at deletion)      |
| `work_time_ms`      | bigint         | nullable | Total work time in ms (copied from session_stats at deletion) |
| `total_cost`        | numeric(14, 8) | nullable | Computed session cost in USD at deletion time                 |

Indexes: `deleted_session_log_deleted_by_idx` on `deleted_by_user_id`; `deleted_session_log_deleted_at_idx` on `deleted_at`; unique `deleted_session_log_session_pk_unique` on `session_pk`.

### user_favorite_sessions (junction)

Per-user set of favorited sessions. Each row records that a user has favorited a specific session. The composite primary key ensures uniqueness; both FKs use ON DELETE CASCADE so rows are removed automatically when the referenced user or session is deleted.

| Column       | Type    | Notes                                    |
|--------------|---------|------------------------------------------|
| `user_id`    | integer | FK → users.id, ON DELETE CASCADE, PK    |
| `session_id` | integer | FK → sessions.id, ON DELETE CASCADE, PK |

Composite PK on `(user_id, session_id)`.

A secondary index `idx_user_favorite_sessions_session_id` on `session_id` was added via migration `0016` (in its own file) to support reverse lookups: "which users have favorited this session?"

### user_settings

Generic per-user key/value store. Deliberately domain-agnostic: the server neither interprets `setting_name` nor parses `setting_value` — the client owns the meaning of both, and any structure inside a value (JSON, say) is the client's business. Adding a new per-user setting therefore needs no migration, just a new `setting_name`.

| Column          | Type         | Nullable | Notes                                              |
|-----------------|--------------|----------|----------------------------------------------------|
| `user_id`       | integer      | no       | FK → users.id, ON DELETE CASCADE, PK               |
| `setting_name`  | varchar(100) | no       | PK; validated against `/^[A-Za-z0-9._-]{1,100}$/` by the controller |
| `setting_value` | text         | yes      | Opaque to the server; capped at 64 KB by the DTO   |

Composite PK on `(user_id, setting_name)`. No secondary index: the PK already serves both access patterns (`WHERE user_id = $1` and `WHERE user_id = $1 AND setting_name = $2`), and `ON DELETE CASCADE` covers user deletion.

Known setting names (all client-owned):

| `setting_name` | Written by | Value shape |
|---|---|---|
| `dataCollectionNotice` | `client/src/viewer/components/DataCollectionConsentScreen.tsx` | `{"noticeHash":"<8 hex>","acceptedAt":"<ISO 8601>"}` — the hash of the notice text the user accepted, so editing `user-docs/data-collection-notice.md` re-asks everyone once |

### upload_queue

Staging table for the async `/api/v2/logs` upload path: the raw NDJSON body is written to disk and a row inserted here; a background scheduler (`UploadQueueSchedulerService`) parses and upserts it off the request path. Also carries chunked-upload columns for hook-split uploads over the hook's chunk-size
threshold (`CHUNK_SIZE_BYTES` in `upload-logs.js` — 900KB as of hook `2.6.1`, see
`hook-api-versioning.md`'s "Known limitation" section for why).

| Column            | Type         | Nullable | Notes                                                                 |
|-------------------|--------------|----------|-------------------------------------------------------------------------|
| `id`              | serial       | NOT NULL | PK                                                                    |
| `file_name`       | varchar(255) | NOT NULL | Staged file name on disk                                              |
| `size_bytes`      | bigint       | NOT NULL | Size of the staged (or, for chunked uploads, reassembled) file        |
| `received_at`     | timestamptz  | NOT NULL | DEFAULT now()                                                          |
| `session_id`      | varchar(255) | NOT NULL | Same `sessionId` query param the hook sent                            |
| `log_type`        | varchar(50)  | NOT NULL | `artisyn` \| `claude` \| `claude-subagent` \| `claude-otel` (hook 2.4.0+) |
| `user_id`         | integer      | NOT NULL | FK → users.id, ON DELETE CASCADE                                      |
| `parent_session_id` | varchar(255) | nullable | Set only for `claude-subagent` uploads                              |
| `workflow_run_id` | varchar(255) | nullable | Set only for workflow-subdir agent uploads (hook 1.6.0+)               |
| `status`          | `upload_queue_status` enum | NOT NULL | DEFAULT `'pending'` — `pending`\|`processing`\|`partially_uploaded`\|`failed`\|`rejected_foreign_session` (`partially_uploaded` added migration `0032`, `rejected_foreign_session` added migration `0068` — the worker refused the upload because the session belongs to another user) |
| `error_message`   | text         | nullable | Set when `status='failed'` or `'rejected_foreign_session'` (the foreign-session warning text) |
| `updated_at`      | timestamptz  | NOT NULL | DEFAULT now()                                                          |
| `upload_id`       | varchar(255) | nullable | hook-generated UUID grouping a chunk set; NULL for single-request uploads |
| `chunks_received` | integer      | nullable | chunks staged so far; NULL unless chunked                      |
| `total_chunks`    | integer      | nullable | total expected chunks; NULL unless chunked                     |
| `warning_delivered` | boolean    | NOT NULL | DEFAULT false (migration `0068`). Set true when a `rejected_foreign_session` row's warning is returned to the hook (`getPendingWarnings` uses `UPDATE … SET warning_delivered=true … RETURNING`), so each rejection is reported once |
| `harness_snapshot_id` | varchar(64) | nullable | Set only when the upload's `snapshotFull='1'` query param held and `snapshotId` passed format validation — i.e. this upload's body carries the full `harness-snapshot` line, not just a ref. `NULL` for a ref-only upload. Set on insert (single upload, and chunk 0 of a chunked upload). Backs the DD-8 "known" check: while a row with this status (`pending`/`processing`/`partially_uploaded`) and this id exists, `POST /api/v2/logs` treats that id as already known and does not ask the hook to resend it (see [upload-queue.md](upload-queue.md) § "Harness snapshot known-check"). Migration: `0073_harness_snapshots.sql`. No FK, same rationale as `sessions.harness_snapshot_id`. |
| `okf_snapshot_id` | varchar(64) | nullable | OKF counterpart of `harness_snapshot_id`: set only when the upload's `okfSnapshotFull='1'` held and `okfSnapshotId` passed format validation (the body carries the full `okf-snapshot` line). Backs `isOkfSnapshotKnown`: a `pending`/`processing`/`partially_uploaded` row with this id makes `POST /api/v2/logs` treat the id as known (no `unknownOkfSnapshotId`). No index, no FK. Migration: `0075_okf_usage.sql`. |

Indexes: `idx_upload_queue_status_received_at` (status, received_at), `idx_upload_queue_user_id`, `idx_upload_queue_user_id_status`, `idx_upload_queue_session_id_received_at`, and a partial unique index `idx_upload_queue_upload_id` on `upload_id` `WHERE upload_id IS NOT NULL` (migration `0032`).

Expiry: `UploadQueueSchedulerService.expireStalePartialUploads()` deletes `partially_uploaded` rows whose `updated_at` (bumped by every chunk) is older than `UPLOAD_QUEUE_PARTIAL_UPLOAD_TTL_MS` (default 24h), plus their `${upload_id}.chunk*` part-files — throttled to once per `UPLOAD_QUEUE_PARTIAL_UPLOAD_SWEEP_INTERVAL_MS` (default 10 min) per process. A late chunk for an expired `upload_id` gets the usual unknown-`uploadId` `400`. No other status expires automatically.

### upload_queue_measurements

Append-only worker measurements backing the admin Upload Queue tab's stats block (migration `0059`): one row per *completed processing attempt* — success **and** failure — written by `UploadQueueSchedulerService.recordMeasurement()`.

The table exists because neither `upload_queue` nor in-process counters can report worker throughput: a successfully processed queue row is **deleted**, and each of the 3–15 cluster workers runs its own scheduler, so a per-process counter under-reports by the instance count.

Both durations are denormalised at write time so the stats aggregate is a plain `SUM`/`AVG`/`percentile_cont` over indexed integer columns instead of a per-row timestamp subtraction. Both are clamped at 0 on write, because `received_at` comes from the database clock while `started_at`/`finished_at` come from the app process's clock.

| Column             | Type         | Nullable | Notes                                                                 |
|--------------------|--------------|----------|-------------------------------------------------------------------------|
| `id`               | serial       | NOT NULL | PK                                                                    |
| `session_id`       | varchar(255) | NOT NULL | Raw session id, **no FK** into `sessions(id)` — same precedent as `turn_end_advisor_runs`: the parent may never have been ingested (a failed attempt) or may already have been purged by retention while the measurement is still in-window |
| `log_type`         | varchar(50)  | NOT NULL | Copied from the queue row, for diagnostics                             |
| `started_at`       | timestamptz  | NOT NULL | When the active work (the file read onwards) began                     |
| `finished_at`      | timestamptz  | NOT NULL | When the attempt ended — the stats-window and retention-prune key      |
| `duration_ms`      | integer      | NOT NULL | Active parse time; summed to give worker utilisation and throughput    |
| `queue_latency_ms` | bigint       | NOT NULL | `finished_at − received_at` — the end-to-end wait the uploader feels   |
| `size_bytes`       | bigint       | NOT NULL | The queue row's size, copied verbatim on both outcomes (a failure may have parsed none of it); only `outcome='success'` rows feed the throughput sums |
| `outcome`          | varchar(20)  | NOT NULL | `'success'` \| `'failure'` — plain varchar, not an enum, matching `turn_end_advisor_runs` |

Indexes: `idx_upload_queue_measurements_finished_at` (serves the 15-minute stats window, the 7-day average-speed window and the retention prune) — and deliberately nothing else. An index on `session_id` was created by `0059` and dropped again by `0060`: no production query filters by that column, the only one that does is the e2e cleanup helper (a seq scan at realistic sizes anyway, and `pg_stat_user_indexes` confirmed `idx_scan = 0`), while the index cost page splits on every insert on the upload hot path because the key is a random UUID.

Query shapes that touch this table, and their plans: the `INSERT` per attempt (no scan); the 15-minute `win` CTE and the retention prune `DELETE` (both **Index Scan** on `finished_at`); and the 7-day `week` CTE, which is a deliberate **Seq Scan** — its predicate is `finished_at >= now() - retention` and retention *is* the 7-day window, so it selects 100% of the retained rows and no index can help. That is accepted: the query only runs while an admin has the Upload Queue tab open (5 s poll), and at ~204 bytes/row it is 19 MB at 100k rows. It degrades linearly with no cliff, so if this table ever reaches ~1M rows (≈1.7 uploads/sec sustained for a week) the fix is to memoize the `week` aggregate server-side for ~60 s — it is a 7-day average, so staleness is meaningless.

Retention: the scheduler deletes rows older than `UPLOAD_QUEUE_MEASUREMENT_RETENTION_MS` (default 7 days), throttled to at most once per `UPLOAD_QUEUE_MEASUREMENT_PRUNE_INTERVAL_MS` (default 5 minutes) **per process**. At a theoretical ceiling of 1 measurement/sec/instance × 15 instances × 7 days the table tops out around 9.1M rows; real load is far below that.

### export_import_jobs

Backs the repository session export/import feature: one row per background export job, import job, or in-progress staged upload awaiting confirmation. `id` is app-generated (`randomUUID()`, or `randomUUID() + '.zip'` for `staged_upload` rows, since it doubles as the staged file's on-disk name) — not a serial PK, so the id can be minted before any row exists.

| Column             | Type          | Nullable | Notes                                                                 |
|--------------------|---------------|----------|-------------------------------------------------------------------------|
| `id`               | varchar(64)   | NOT NULL | PK; app-generated, up to 40 chars for `staged_upload` rows (migration `0036` widened this from the original 36-char bare-UUID length) |
| `kind`             | `export_import_job_kind` enum | NOT NULL | `export`\|`import`\|`staged_upload`                        |
| `status`           | `export_import_job_status` enum | NOT NULL | `staged`\|`running`\|`done`\|`error`                      |
| `processed`        | integer       | NOT NULL | DEFAULT 0 — sessions processed so far                                 |
| `total`            | integer       | NOT NULL | DEFAULT 0 — total sessions in scope                                   |
| `error_message`    | text          | nullable | Set only on `status='error'`                                           |
| `result_file_path` | varchar       | nullable | Path to the finished export zip / staged import zip on disk           |
| `result_file_name` | varchar       | nullable | Download filename for a finished export                               |
| `repo_id`          | integer       | nullable | FK → repositories.id, ON DELETE CASCADE; NULL for a bootstrap-import `staged_upload` row until confirm |
| `user_id`          | integer       | nullable | FK → users.id, ON DELETE CASCADE                                      |
| `created_at`       | timestamptz   | NOT NULL | DEFAULT now()                                                          |
| `updated_at`       | timestamptz   | NOT NULL | DEFAULT now()                                                          |

Index: `idx_export_import_jobs_status_updated_at` (status, updated_at) — used by `ExportImportJobCleanupScheduler` to find terminal (`done`/`error`/`staged`) rows older than its sweep threshold.

### turn_end_advisor_runs

Turn-End Cost Advisor run log — migration `0055`, `session_id` converted to a raw
varchar in `0058`. Append-only: one row per actual evaluation attempt (`outcome ∈
{'submitted','failed'}`; a below-$-threshold or feature-off turn never writes a row at all).
`session_id` is the invoking session's raw `sessions.session_id` UUID string, stored with **no FK**
and no requirement that a matching `sessions` row exist yet — the hook may submit a run for a
session the server hasn't ingested yet (e.g. the very first turn, before `POST /api/v2/logs` has
been processed out of `upload_queue`); the row is written regardless, and once
the session is later ingested it resolves and displays exactly as if it had existed all along.
`TurnEndAdvisorOrphanCleanupScheduler` periodically purges rows whose `session_id` still has no
matching `sessions` row after a retention window (see
`TURN_END_ADVISOR_ORPHAN_CLEANUP_INTERVAL_MS`/`TURN_END_ADVISOR_ORPHAN_RETENTION_MS` in
`server/.env.example`). `session_id` also doubles as display persistence: the Advisor tab reads
the latest `outcome='submitted'` row for a session (joined by `sessions.session_id = session_id`),
and the Executive Summary's "Advisor Spend" section (`GET .../reports/executive-summary`) joins
straight through it to `sessions`/`logs` the same way, with no `hook_service` marker scan needed.
Part B's `session_attribution_runs` (below) is keyed similarly — `session_id` is also its invoking
session directly — but it still has an FK to `sessions.id` (unlike this table post-`0058`), and its
own Executive Summary counterpart still scans the `hook_service` marker rather than joining
through the run table, because that section's scope comes from the marker events the spawned
(`--no-session-persistence`) eval sessions upload, not from the run log itself.
Overlapping runs on rapid consecutive turns are permitted, not locked — two concurrent runs just
produce two rows.

| Column               | Type          | Nullable | Notes                                                                     |
|----------------------|---------------|----------|-----------------------------------------------------------------------------|
| `id`                 | serial        | NOT NULL | PK                                                                        |
| `session_id`         | varchar(255)  | NOT NULL | Raw `sessions.session_id` UUID string, no FK (migration `0058`) — may reference a session not yet ingested |
| `user_id`            | integer       | nullable | FK → users.id, ON DELETE CASCADE (migration `0067`). The user whose API key recorded the run. Every read filters `user_id = <session owner>` (`logs.user_id` of the session's `artisyn` log) before `ORDER BY started_at DESC LIMIT 1`; NULL rows (pre-`0067` runs whose session had no `artisyn` log to backfill from) never match |
| `eval_session_id`    | varchar(255)  | nullable | Spawned `claude -p` session id, cross-ref only                            |
| `started_at`         | timestamptz   | NOT NULL |                                                                            |
| `finished_at`        | timestamptz   | NOT NULL |                                                                            |
| `outcome`             | varchar(20)   | NOT NULL | `'submitted'` \| `'failed'`                                                |
| `summary_general`    | text          | nullable | Set only on `'submitted'`                                                 |
| `cost_factors`       | jsonb         | nullable | `string[]`; set only on `'submitted'`                                     |
| `harness_advice`     | jsonb         | nullable | `string[]`; set only on `'submitted'`                                     |
| `failure_reason`     | text          | nullable | Set only on `'failed'`                                                    |
| `model`              | varchar(64)   | nullable |                                                                            |
| `cost_usd`           | numeric(12,6) | nullable |                                                                            |
| `input_tokens` / `output_tokens` / `cache_read_tokens` / `cache_write_tokens` | bigint | NOT NULL | DEFAULT 0 each |
| `created_at`         | timestamptz   | NOT NULL | DEFAULT now()                                                              |

Index `turn_end_advisor_runs_session_user_idx` on `(session_id, user_id, started_at DESC)`
(migration `0067`) serves the owner-filtered "latest submitted result for this session" lookup
(`ORDER BY started_at DESC LIMIT 1`), and via its leading `session_id` every session_id-only
lookup (the run-log scan, the executive-summary join). The older single-column
`idx_turn_end_advisor_runs_session_id` (`0055`, retargeted by `0058`) was a redundant prefix and
was dropped by `0070`. Index `idx_turn_end_advisor_runs_user_id` (`0070`) backs the `user_id` FK's
`ON DELETE CASCADE`.

### session_attribution

AI Session Attribution current values — migration `0056`. One row per (invoking)
session — `session_id` is a plain PK (not a surrogate id column), the same convention every
other `session_*` 1:1 table in this file uses. Written only by `POST /api/v2/session-attribution`'s
single conditional upsert: `INSERT ... ON CONFLICT (session_id) DO UPDATE
... WHERE excluded.prompt_watermark > session_attribution.prompt_watermark`, so a submission
racing in with a lower-or-equal watermark than what's already stored is silently discarded —
never partially patched, always the whole `values` object at once.

| Column             | Type        | Nullable | Notes                                                          |
|--------------------|-------------|----------|-----------------------------------------------------------------|
| `session_id`       | integer     | NOT NULL | PK, FK → sessions.id, ON DELETE CASCADE                         |
| `prompt_watermark` | integer     | NOT NULL | The user-prompt count this row's `values` were evaluated as of |
| `values`           | jsonb       | NOT NULL | Keyed by attribute `key`; typed per the resolved definitions at evaluation time |
| `updated_at`       | timestamptz | NOT NULL | DEFAULT now()                                                   |

Index `idx_session_attribution_values_gin ON session_attribution USING GIN (values jsonb_path_ops)`
— this codebase's first GIN index; backs the `attr=` filter's containment
operators (`eq`, `is`, `any`) built by `server/src/logs/attribute-filter.sql.ts`.

### session_attribution_runs

AI Session Attribution run log — migration `0056`. Append-only, one row per
evaluation attempt, mirroring `turn_end_advisor_runs`'s shape: `session_id` is the invoking
session directly (resolved from the POST body's `sessionId` the same way `session_attribution`'s
own PK is), never a spawned evaluation session — the spawned `claude -p` call runs with
`--no-session-persistence`, so it has no transcript and never gets a real `sessions` row of its
own from a transcript upload. `invoking_session_id` is a separate, unresolved `varchar` copy of
the same session's string id, stored purely so the Executive Summary's "Attribute Extraction
Spend" section (`executive-summary.service.ts`'s `computeAttributionSpend()`) can
join straight through it to `sessions.session_id` → `logs`/`log_repositories`/`users` for
repo/branch/user/date scope, the same string the `hook_service` marker events uploaded separately
(tagged `hook_service_type: 'session-attribution'`) also carry — without that section needing to
re-scan `logs.body` for the marker on every report load. A row whose `invoking_session_id` is
`NULL` (a marker written before the field existed, or one that never resolved to a real session)
is excluded from that section rather than guessed at.

| Column               | Type          | Nullable | Notes                                                                     |
|----------------------|---------------|----------|-----------------------------------------------------------------------------|
| `id`                 | serial        | NOT NULL | PK                                                                        |
| `session_id`         | integer       | NOT NULL | FK → sessions.id, ON DELETE CASCADE — the invoking session directly       |
| `prompt_watermark`   | integer       | NOT NULL |                                                                            |
| `eval_session_id`    | varchar(255)  | nullable | Spawned `claude -p` session id (from its own `--output-format json` envelope), cross-ref only |
| `invoking_session_id`| varchar(255)  | nullable | Same session as `session_id`, unresolved string — see above              |
| `started_at`         | timestamptz   | NOT NULL |                                                                            |
| `finished_at`        | timestamptz   | NOT NULL |                                                                            |
| `outcome`            | varchar(20)   | NOT NULL | `'applied'` \| `'ignored_stale'` \| `'failed'`                            |
| `failure_reason`     | text          | nullable | Migration `0057` — set only on `outcome='failed'`, mirrors `turn_end_advisor_runs.failure_reason`; surfaced by `getRepositorySessions()`'s `lastRun.failureReason` |
| `model`              | varchar(64)   | nullable |                                                                            |
| `cost_usd`           | numeric(12,6) | nullable |                                                                            |
| `input_tokens` / `output_tokens` / `cache_read_tokens` / `cache_write_tokens` | bigint | NOT NULL | DEFAULT 0 each — own cost columns, never joined via `session_stats` (the spawned eval never has one) |

Index `idx_session_attribution_runs_session_id` on `session_id`.

### session_prompt_watermark

AI Session Attribution per-session prompt watermark — migration `0056`. One row
per session, written only as a side effect of the combined `GET /api/v2/post-turn-analysis/config`
(never derived server-side otherwise), monotonically (`GREATEST`) — a request reporting a lower
watermark than already stored never regresses it. This is what `evaluationRequired`
compares the attribution branch's own `evaluatedWatermark`
(`session_attribution.prompt_watermark`) against: `enabled && promptWatermark >
(evaluatedWatermark ?? -1)`.

| Column             | Type        | Nullable | Notes                                    |
|--------------------|-------------|----------|--------------------------------------------|
| `session_id`       | integer     | NOT NULL | PK, FK → sessions.id, ON DELETE CASCADE     |
| `prompt_watermark` | integer     | NOT NULL |                                             |
| `updated_at`       | timestamptz | NOT NULL | DEFAULT now()                               |

### ai_tool_version

Claude Code version check — migration `0065`. One row per AI tool (today only `claude-code`),
holding the latest npm dist-tags fetched from the registry plus the cluster fetch claim. Owned by
`AiToolVersionsService` (`server/src/ai-tool-versions/`). The row is seeded with
`INSERT … ON CONFLICT (tool_name) DO NOTHING`; a worker then claims a fetch with a conditional
`UPDATE … SET last_attempt_at = now()` that only matches when `fetched_at` is missing or older than
24 h **and** `last_attempt_at` is missing or older than 1 h, so only one cluster instance calls npm
per window. A failed fetch leaves `last_attempt_at` set and nothing else changed.

| Column            | Type        | Nullable | Notes                                                              |
|-------------------|-------------|----------|--------------------------------------------------------------------|
| `tool_name`       | varchar(64) | NOT NULL | PK — the `ON CONFLICT` target                                      |
| `version_map`     | jsonb       | nullable | `{ "stable": "x.y.z", "latest": "x.y.z" }` — only these two dist-tags are kept. `NULL` until the first successful fetch |
| `fetched_at`      | timestamptz | nullable | Time of the last successful fetch                                  |
| `last_attempt_at` | timestamptz | nullable | Time of the last claimed fetch attempt (successful or not)         |

### ai_tool_version_history

Append-only history of distinct `{ stable, latest }` maps per tool — migration `0065`. A row is
inserted, in the same transaction as the `ai_tool_version` update, only when a successful fetch
sees a map whose `stable` or `latest` differs from the tool's newest history row
(`ORDER BY effective_from DESC, id DESC`); its `effective_from` equals that fetch's `fetched_at`.
Read in `effective_from ASC, id ASC` order to find which releases were current when a session
started (session Summary detector, Claude Code Version Usage report).

| Column           | Type        | Nullable | Notes                                    |
|------------------|-------------|----------|------------------------------------------|
| `id`             | serial      | NOT NULL | PK                                       |
| `tool_name`      | varchar(64) | NOT NULL | No FK to `ai_tool_version`               |
| `version_map`    | jsonb       | NOT NULL | `{ "stable": "x.y.z", "latest": "x.y.z" }` |
| `effective_from` | timestamptz | NOT NULL | When this map was first observed         |

Index `ai_tool_version_history_tool_effective_idx` on `(tool_name, effective_from)`.

### server_secrets

Server-generated secrets — migration `0069`. One row per named secret; today only
`session_secret`. At startup `resolveSessionSecret()` (end of `initializeDatabase()`, inside the
migration advisory lock) uses a non-empty `SESSION_SECRET` env var if set; otherwise it reads this
row, and if missing inserts 48 random bytes (base64url) with `INSERT … ON CONFLICT DO NOTHING` and
re-reads, so every cluster worker and every restart share one value.

| Column       | Type        | Nullable | Notes                         |
|--------------|-------------|----------|-------------------------------|
| `name`       | varchar(64) | NOT NULL | PK — e.g. `session_secret`    |
| `value`      | text        | NOT NULL | The secret                    |
| `created_at` | timestamptz | NOT NULL | DEFAULT now()                 |

## Migration History

| File                             | Description                                                       |
|----------------------------------|-------------------------------------------------------------------|
| `0000_opposite_firedrake.sql`    | Initial `logs` table (session as varchar, no user FK)             |
| `0001_repo_session_context.sql`  | Add `sessions`, `repositories`, `contexts`; normalise session FK  |
| `0002_auth.sql`                  | Add `users`, `api_keys`; add `user_id` FK on `logs`               |
| `0003_access_management.sql`     | Add `role` to users; add `teams`, `team_members`, `team_repositories`, `invitations` |
| `0004_fix_repository_integrity.sql` | Make `user_id` NOT NULL + CASCADE on `logs` and `repositories`; fix FK cascade on `log_repositories` |
| `0005_missing_indices.sql`       | Add six performance indices (see table above)                     |
| `0006_log_extracted_fields.sql`  | Add `first_prompt`, `start_time`, `end_time`, `git_branch` to `logs` |
| `0007_parent_session_id.sql`     | Add parent session ID support                                         |
| `0008_model_pricing.sql`         | Create `model_pricing` table; seed three Claude model rows            |
| `0009_session_stats.sql`         | Create `session_stats` table with token, work-time, file, and vision metrics |
| `0010_add_fable5_pricing.sql`    | Add pricing row for `claude-fable-5`                              |
| `0011_subagent_stats_backfill.sql` | Backfill sub-agent stats                                        |
| `0012_mcp_stats.sql`             | Add `mcp_calls_total` (integer) and `mcp_calls_by_server` (jsonb) to `session_stats` |
| `0013_repo_config.sql`           | Create `repo_config` table; create `session_file_stats` table; remove `code_files`, `code_bytes`, `doc_files`, `doc_bytes` from `session_stats` |
| `0014_add_model_pricing.sql`     | Seed additional OpenRouter model pricing rows                                                     |
| `0015_user_favorite_sessions.sql`| Create `user_favorite_sessions` junction table (user_id + session_id composite PK, both FKs CASCADE) |
| `0016_user_favorite_sessions_idx.sql` | Add `idx_user_favorite_sessions_session_id` index using CONCURRENTLY (separate file — cannot run inside a transaction) |
| `0017_log_repositories_repo_id_idx.sql` | Add index on `log_repositories.repo_id` for reverse lookup performance |
| `0018_missing_fk_indexes.sql`           | Add missing FK indexes for referential integrity queries              |
| `0019_session_soft_delete.sql`          | Add `deleted` boolean column to `sessions`; add partial index `sessions_deleted_idx` |
| `0020_deleted_session_log.sql`          | Create `deleted_session_log` audit table; add `deleted_by_idx` and `deleted_at_idx` indexes |
| `0021_repositories_max_upload_bytes.sql`| Add `max_upload_bytes` bigint column to `repositories`                                |
| `0022_performance_indices.sql`          | Add `idx_repositories_repo_url`, `idx_logs_user_id_log_type_start_time`, `idx_logs_artisyn_with_prompt`, `idx_team_repositories_repo_url`; drop `idx_log_repositories_repo_id` and replace with composite `idx_log_repositories_repo_id_log_id` |
| `0023_add_missing_model_pricing.sql`    | Seed additional model pricing rows (Sonnet 5, Opus 4.5/4.6/4.7/4.1/4.0 aliases, dated Haiku 4.5, Haiku 3.5, third-party models) |
| `0024_repositories_hook_state.sql`      | Add 5 nullable columns to `repositories`: `hook_version` (varchar 50), `hook_last_activity` (timestamptz), `hook_log_tail` (jsonb), `hook_non_uploadable_logs` (jsonb), `hook_recommendations` (jsonb) — Hook State Panel |
| `0025_workflow_run_id.sql`              | Add `workflow_run_id` varchar(255) column to `sessions`; add `sessions_workflow_run_id_idx` index — Workflow Sub-Agent Visibility |
| `0026_upload_queue.sql`                 | Create `upload_queue` table |
| `0027_upload_queue_composite_indexes.sql` | Add composite indexes to `upload_queue` |
| `0028_fix_invalid_docs_glob_pattern.sql` | Fix invalid glob pattern for the "docs" file category |
| `0029_team_session_visibility_setting.sql` | Add `allow_member_session_visibility` boolean (NOT NULL DEFAULT false) column to `teams` — Team-Wide Session Visibility Setting. `0063` drops this column; team visibility is the three-state `teams.access_mode` |
| `0030_deleted_session_log_nullable_deleted_by.sql` | Drop `NOT NULL` on `deleted_session_log.deleted_by_user_id` — `NULL` now means an automated `SessionRetentionService` purge rather than a user-triggered deletion |
| `0031_deleted_session_log_unique_session_pk.sql` | Dedupe any existing rows then add a unique index on `deleted_session_log.session_pk` — the claim primitive `hardPurgeExpiredSessions()` uses so overlapping purge runs across prod instances stay idempotent without a DB-level lock |
| `0032_upload_queue_chunking.sql`        | Add `partially_uploaded` value to the `upload_queue_status` enum; add `upload_id`/`chunks_received`/`total_chunks` columns to `upload_queue`; add partial unique index `idx_upload_queue_upload_id` — Chunked Log Uploads |
| `0033_add_opus5_pricing.sql`            | Add pricing row for `claude-opus-5` ($5/$25) — the model was already logging to `session_stats` but had no pricing row, so every Opus 5 session showed no cost estimate |
| `0034_sonnet5_standard_pricing.sql`     | Widen `model_pricing` PK to `(model_id, effective_from)` so a model can hold several dated price rows; add the future-dated `claude-sonnet-5` standard-pricing row ($3/$15, effective 2026-09-01) that supersedes its introductory $2/$10 rate automatically |
| `0035_export_import_jobs.sql`           | Create `export_import_jobs` table plus `export_import_job_kind`/`export_import_job_status` enums and `idx_export_import_jobs_status_updated_at` index — Repository Session Export/Import |
| `0036_export_import_jobs_id_length.sql` | Widen `export_import_jobs.id` from 36 to 64 chars — `staged_upload` rows key it by the staged file's generated name (`randomUUID() + '.zip'`, 40 chars), not a bare UUID |
| `0040_model_pricing_sonnet5_date_fix.sql` | Sets the active `claude-sonnet-5` row to standard pricing and drops the future-dated row. `0042` restores the introductory rate and the correct effective dates, so the resulting `claude-sonnet-5` rows are `0042`'s |
| `0041_logs_otel_chunks.sql`           | Create `logs_otel` (one row per uploaded OTEL chunk, integer `cost_usd_micros`, unique `(session_id, chunk_key)`) plus its three indices; delete pre-chunk `logs` rows with `log_type=otel` |
| `0042_model_pricing_sonnet5_intro_end.sql` | Correct `0040`: restore the introductory `claude-sonnet-5` rate on `2026-07-20` and start standard pricing at `2026-08-07`, the earliest date OTEL proves it was in force |
| `0046_model_pricing_chars_per_token.sql` | Add nullable `chars_per_token NUMERIC(6,3)` to `model_pricing`; backfill 3.5 (old tokenizer) / 2.7 (new tokenizer, Opus 4.7+) per model; seed a new `claude-mythos-5` row reusing Fable 5's pricing and 2.7 ratio |
| `0047_model_pricing_context_length.sql`  | Add nullable `context_length INTEGER` to `model_pricing`; backfill 200,000 for all first-party Claude models and researched values for third-party `deepseek/*`, `moonshotai/*`, `qwen/*` models. `0048` then sets the Opus 4.6+/Sonnet 4.6+/Fable 5/Mythos 5 rows to their real 1M-token window |
| `0048_model_pricing_context_length_fix.sql` | Corrects `0047`: sets `context_length = 1000000` for `claude-opus-4-6/4-7/4-8/5`, `claude-sonnet-4-6/5`, `claude-fable-5`, `claude-mythos-5` — Claude 4.6+ models ship the full 1M-token window at standard pricing per Anthropic's docs |
| `0049_cache_ratio_stats.sql` | Add `cache_write_5m_tokens`/`cache_write_1h_tokens` (bigint NOT NULL DEFAULT 0) to `session_stats`; create `session_cause_stats` plus its `session_id` index and two partial unique indexes (`(session_id, team_id) WHERE team_id IS NOT NULL`, `(session_id, user_id) WHERE user_id IS NOT NULL`) — Cache Read Ratio Metric. Structure only: both the TTL columns and the cause rows are backfilled via `POST :repoId/recompute-all-sessions` + `recomputeForRepo()`, never by data-rewriting SQL in the migration |
| `0051_cache_write_ttl_pricing.sql` | Add `price_cache_w_5m`/`price_cache_w_1h`/`price_web_search` (numeric(10,6) NOT NULL DEFAULT 0) to `model_pricing` and set them (`5m = price_cache_w`, `1h = price_cache_w * 1.6`, web search `0.01` for `claude%` / `0` otherwise); add `web_search_requests`/`input_tokens_fast`/`output_tokens_fast` (bigint NOT NULL DEFAULT 0) to `session_stats` — Cache-Write TTL Pricing. **Non-destructive**: `price_cache_w` is deliberately kept (deprecated, carries the 5m rate) rather than dropped; nothing is renamed or retyped, and every statement is `IF NOT EXISTS` / an idempotent `UPDATE` over pre-existing columns, so the file is re-runnable. Unlike `0049`/`0050` this migration **does** backfill its own `session_stats` columns, in one unbatched `UPDATE … FROM (SELECT … CROSS JOIN LATERAL jsonb_array_elements(l.body) …)` over the whole corpus (shape precedent: `0011`) that mirrors `extractClaudeStats` exactly — `type = 'assistant'` only, `isSidechain` skipped for `log_type='claude'` but never for `'claude-subagent'`, usage deduped on `COALESCE(message.id, uuid)`. Where the re-aggregated `5m + 1h` disagrees with the stored `cache_write_tokens` it does **not** change the total: it falls back to `5m = cache_write_tokens, 1h = 0` and reports those session ids via `RAISE NOTICE` |
| `0052_harness_elements.sql` | Create `harness_elements` (inventory of record, one row per `(repo_id, kind, name)`, unique index + `repo_id` index) and `session_harness_usage` (per-session usage facts, one row per `(session_id, kind, name)`, unique index + `session_id` index); add nullable `harness_inventory_reported_at`/`harness_mcp_per_tool_supported` columns to `repositories` — Harness Elements Usage Report. Purely additive, no DEFAULT on the two new `repositories` columns (catalog-only `ALTER`, no table rewrite). No backfill: `harness_elements` and the two `repositories` flags populate from each repo's next artisyn upload; `session_harness_usage` populates the next time a session's `claude` log is (re-)ingested (e.g. via `POST :repoId/recompute-all-sessions`) |
| `0054_session_stats_telemetry_cost.sql` | Add nullable `telemetry_cost BIGINT` (no default) to `session_stats` — session_stats As The Cost Source Of Truth. Backfills every session from `SUM(logs_otel.cost_usd_micros)`, falling back to the `otel-summary` JSONB body only for a `claude-otel` log with zero `logs_otel` rows; `NULL` when neither source has data or the sum is exactly 0. Creates missing `session_stats` rows for historical OTEL-only sessions. Re-runnable: `ADD COLUMN IF NOT EXISTS` + `INSERT ... ON CONFLICT DO UPDATE` that always recomputes from source, so a re-run can never regress a live-ingest value. No table rewrite (no DEFAULT on the new column) |
| `0055_turn_end_advisor_runs.sql` | Create `turn_end_advisor_runs` (append-only run log, `session_id` FK CASCADE, `idx_turn_end_advisor_runs_session_id` index) — Turn-End Cost Advisor. Purely additive, new table only |
| `0056_session_attribution.sql` | Create `session_attribution` (current values, `session_id` PK/FK CASCADE, `idx_session_attribution_values_gin` — this codebase's first `GIN (jsonb_path_ops)` index), `session_attribution_runs` (append-only run log, `session_id` FK CASCADE, `idx_session_attribution_runs_session_id` index) and `session_prompt_watermark` (`session_id` PK/FK CASCADE) — AI Session Attribution. Purely additive, three new tables only, no backfill |
| `0057_session_attribution_runs_failure_reason.sql` | Add nullable `failure_reason TEXT` to `session_attribution_runs` — a Chunk 8 gap fix: the API changes spec always required `lastRun.failureReason` on `GET :repoId/sessions`, but `0056` never gave the runs table a column to store it in. Purely additive, no default, no rewrite |
| `0058_turn_end_advisor_runs_session_id_varchar.sql` | Convert `turn_end_advisor_runs.session_id` from `INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE` to `VARCHAR(255) NOT NULL` (no FK), via add-column/backfill/`SET NOT NULL`/drop/rename/reindex, so a turn-end advisor run can be recorded for a session the server has not ingested yet |
| `0059_upload_queue_measurements.sql` | Add the `upload_queue_measurements` table plus `idx_upload_queue_measurements_finished_at` and `idx_upload_queue_measurements_session_id` — append-only per-attempt worker measurements backing the admin Upload Queue stats block. Purely additive: one new table, no existing table touched, no backfill. (The `session_id` index is dropped again by `0060`.) |
| `0060_drop_upload_queue_measurements_session_id_idx.sql` | `DROP INDEX IF EXISTS idx_upload_queue_measurements_session_id`. Index-only: no table/column/constraint/row touched, no data risk, reversible by recreating the index. No production query filters that table by `session_id` (`pg_stat_user_indexes` showed `idx_scan = 0`), so the index was pure write overhead on the upload hot path with a random-UUID key. Not `CONCURRENTLY` — Drizzle wraps migrations in a transaction |
| `0062_user_settings.sql` | Create `user_settings` (`user_id` FK CASCADE + `setting_name` composite PK, `setting_value` TEXT) — a generic per-user key/value store. Purely additive, one new empty table, no backfill, no secondary index |
| `0061_change_surface.sql` | Create `session_changed_paths` (per-session changed-path facts, unique `(session_id, path_key)` + two indexes) and `repo_code_inventory` (code-size snapshot history, unique `(repo_id, captured_at, branch)` + one index); add `git_repo_root` / `git_worktree_root` to `logs`; add `cs_changed_files` / `cs_folders_touched` / `cs_outside_repo_files` / `cs_computed_at` to `session_stats` — Change Surface. Purely additive and re-runnable (`IF NOT EXISTS` throughout); all six `ADD COLUMN`s are nullable with **no** DEFAULT, so they are catalog-only and never rewrite `logs`. **No backfill**: historical values come from `POST :repoId/recompute-all-sessions`, and `repo_code_inventory` fills from each repo's next hook upload. No `CONCURRENTLY` index — the two indexed tables are created empty in the same transaction |
| `0063_team_access_mode.sql` | Create the `team_access_mode` enum (`transparent` / `restricted`); add `teams.access_mode` (NOT NULL DEFAULT `'restricted'`), `team_members.is_manager` / `is_adlc_trainer` (boolean NOT NULL DEFAULT false) and `team_members.disclosure_acknowledged_at` (timestamptz, nullable); **drop** `teams.allow_member_session_visibility` — Team Access Modes. Moving every existing team to `restricted` is done by the `ADD COLUMN` DEFAULT alone (every existing team lands on `restricted`, including ones that had the old flag on) — there is deliberately no unconditional `UPDATE`, which on a manual re-run would revert a team the owner had since set to `transparent`. One data statement: `disclosure_acknowledged_at = joined_at` for every pre-existing member, without which migrating all teams to `restricted` would hide every existing member from their own team owner. Re-runnable (`IF NOT EXISTS` / `IF EXISTS` throughout, `CREATE TYPE` guarded by a `duplicate_object` handler). `CREATE TYPE` rather than `ALTER TYPE … ADD VALUE` so the enum and the statements using its values stay in one transaction. No new index — every lookup is keyed on `team_members`' `(team_id, user_id)` PK or its `team_id` prefix |
| `0065_ai_tool_versions.sql` | Create `ai_tool_version` (`tool_name` PK, nullable `version_map` jsonb / `fetched_at` / `last_attempt_at`) and `ai_tool_version_history` (serial PK, `ai_tool_version_history_tool_effective_idx` on `(tool_name, effective_from)`); add nullable `claude_version` / `claude_version_otel` varchar(64) to `session_stats` — Claude Code version check. Purely additive and re-runnable (`IF NOT EXISTS` throughout); both `ADD COLUMN`s are nullable with **no** DEFAULT, so catalog-only (no rewrite). **No backfill**: the tables fill from the hourly npm dist-tags check, `claude_version` from the next (re)computation of a session and `claude_version_otel` from the next OTEL chunk. No `CONCURRENTLY` index |
| `0066_model_pricing_source.sql` | Add `model_pricing.source` (varchar(16) NOT NULL DEFAULT `'manual'`, CHECK `anthropic`/`openrouter`/`manual`/`override`; the constant default makes it metadata-only) and backfill it (`claude-%` → `anthropic`, `%/%` → `openrouter`, else `manual`). Create `model_pricing_meta` and `model_pricing_fetch_state`. Register every distinct normalised `session_stats.model` with no effective price as an unpriced `model_pricing_meta` row, and seed both fetch-state rows. Additive and re-runnable (`IF NOT EXISTS` / `ON CONFLICT DO NOTHING`); no price value is rewritten — Model Pricing Fetch and Admin Overrides |
| `0067_turn_end_advisor_runs_user_id.sql` | Add nullable `turn_end_advisor_runs.user_id` (catalog-only, no default), backfill it from the session owner (`logs.user_id` of the session's `artisyn` log, joined through `sessions.session_id`; unmatched rows stay NULL), add FK `turn_end_advisor_runs_user_id_fk` → `users(id) ON DELETE CASCADE` as `NOT VALID` then `VALIDATE CONSTRAINT`, and create `turn_end_advisor_runs_session_user_idx` on `(session_id, user_id, started_at DESC)` — advisor run ownership (open-source readiness). Re-runnable (`IF NOT EXISTS` / `pg_constraint` guard; backfill only touches NULL rows). No `CONCURRENTLY` index |
| `0068_upload_queue_rejected_foreign_session.sql` | `ALTER TYPE upload_queue_status ADD VALUE IF NOT EXISTS 'rejected_foreign_session'` (the value is not used in the same transaction) and add `upload_queue.warning_delivered` boolean NOT NULL DEFAULT false (constant default — metadata-only) — foreign-session upload rejection (open-source readiness). Additive, re-runnable |
| `0069_server_secrets.sql` | Create `server_secrets` (`name` varchar(64) PK, `value` text NOT NULL, `created_at` timestamptz NOT NULL DEFAULT now()) — holds the generated `session_secret` when `SESSION_SECRET` is unset (open-source readiness). One new empty table, no backfill |
| `0070_turn_end_advisor_runs_index_cleanup.sql` | Drop `idx_turn_end_advisor_runs_session_id` (a redundant prefix of `0067`'s `turn_end_advisor_runs_session_user_idx`) and create `idx_turn_end_advisor_runs_user_id` on `(user_id)` to back the FK's `ON DELETE CASCADE`. Index-only, no data touched; re-runnable (`IF EXISTS` / `IF NOT EXISTS`). No `CONCURRENTLY` index |
| `0071_otel_api_calls_request_ids.sql` | Create `otel_api_calls` (unique `(session_id, call_key)`, index `(session_id, request_id)`) and `session_request_ids` (PK `(session_id, request_id)`, index `(request_id)`) — utility-call pricing. Backfills both in the same file: `otel_api_calls` from `logs_otel.body` `claude_code.api_request` records (`jsonb_array_elements … WITH ORDINALITY`, 1-based, matching ingest's `call_key`), and `session_request_ids` from the distinct `requestId` of `assistant` events in `claude` / `claude-subagent` logs. Additive and re-runnable (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`). No `CONCURRENTLY` index |
| `0072_team_repo_config.sql` | Create `team_repo_config` (PK = FK → `team_repositories.id`, ON DELETE CASCADE). Moves every team-scoped `repo_config` row to its link (matched by `(team_id, repo_url)`; newest `updated_at` wins, ties → lowest `repo_id`; rows with no link are dropped and counted in a `RAISE NOTICE`), then drops `repo_config_scope_check` and `repo_config.team_id` (with its partial unique index) and sets `repo_config.user_id` NOT NULL. Guarded by `information_schema.columns` in `current_schema()`; irreversible |
| `0073_harness_snapshots.sql` | Create `harness_snapshots` (serial PK, `user_id` FK → `users.id` ON DELETE CASCADE, `snapshot_id` varchar(64), `body` jsonb, `created_at`; unique `(user_id, snapshot_id)`; index on `snapshot_id` alone) — the hook's DD-1 harness snapshot (skills/agents/MCP/system-context), replacing the old `skill-definitions`/`agent-definitions`/`mcp-config`/`system-context` event parsing. Add nullable `sessions.harness_snapshot_id` varchar(64) with its own index, and nullable `upload_queue.harness_snapshot_id` varchar(64) (no index — looked up only alongside `user_id`/`status` via the existing queue indexes). All three `ADD COLUMN`s are nullable with no DEFAULT, so catalog-only. Purely additive, no backfill, no `CONCURRENTLY` index (new table created empty in the same transaction) |
| `0075_okf_usage.sql` | Create `okf_snapshots` (serial PK, `user_id` FK → `users.id` ON DELETE CASCADE, `snapshot_id` varchar(64), `body` jsonb, `created_at`; unique `(user_id, snapshot_id)`) and `session_okf_access` (serial PK, `session_id` FK → `sessions.id` ON DELETE CASCADE, `path_key` varchar(1024), `op` varchar(8) CHECK `read`/`grep`/`list`/`write`, `after_own_edit`, `bytes`, `calls`, `seq`; unique `(session_id, path_key, op, after_own_edit)`) — OKF usage tabs. Add nullable `sessions.okf_snapshot_id` varchar(64) with index `sessions_okf_snapshot_id_idx` and nullable `upload_queue.okf_snapshot_id` varchar(64). Additive and re-runnable (`IF NOT EXISTS` throughout), catalog-only `ADD COLUMN`s, no backfill (history via `POST recompute-all-sessions`), no `CONCURRENTLY` index |
| `0076_tool_monitoring.sql` | Create `repo_tool_monitor_config` (PK = FK → `repositories.id`) and `team_repo_tool_monitor_config` (PK = FK → `team_repositories.id`), both ON DELETE CASCADE with `config` jsonb + `updated_at`, and `session_tool_usage` (serial PK, `session_id` FK → `sessions.id` ON DELETE CASCADE, `channel` varchar(8) CHECK `mcp`/`cli`, `tool` text, `call_count`, `first_call_at`, `last_call_at`, `has_wrapper_data`, jsonb `aggregates` / `calls` / `outputs`; unique `(session_id, channel, tool)`, index `idx_session_tool_usage_last_call_at`) — Tools/MCP tab. Add nullable `sessions.tool_usage_version` smallint with the partial index `idx_sessions_tool_usage_pending` (`WHERE tool_usage_version IS NULL AND NOT deleted`) and nullable `repositories.tool_wrap_status` jsonb. Additive and re-runnable (`IF NOT EXISTS` throughout), catalog-only `ADD COLUMN`s (no default), no `CONCURRENTLY` index. **Implicit backfill**: every existing session starts with `tool_usage_version` `NULL`, so after deploy the background drain rebuilds every non-deleted tree in batches (`TOOL_USAGE_REBUILD_BATCH` per `TOOL_USAGE_REBUILD_INTERVAL_MS`, `SKIP LOCKED`); the file itself rewrites no data |
| `0077_tool_usage_indexes.sql` | Drop `idx_session_tool_usage_last_call_at` (never read: the Tools/MCP reads reach `session_tool_usage` by `session_id` and filter `last_call_at` as a residual) and create the partial `idx_sessions_tool_usage_version` on `sessions (tool_usage_version) WHERE tool_usage_version IS NOT NULL` for the startup re-queue `UPDATE … WHERE tool_usage_version < $1`. Index-only, re-runnable (`IF EXISTS` / `IF NOT EXISTS`), no data rewritten; older builds need neither index, so a rollback is safe |
