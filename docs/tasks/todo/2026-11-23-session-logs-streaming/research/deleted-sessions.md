---
type: "Research"
title: "FR-7a: deleted sessions on every ingest and read path"
description: "Audit of how soft-deleted and retention-purged sessions are handled on ingest, which child data survives a delete and who reads it, and what an account/repo fresh start needs."
---

# FR-7a: deleted sessions on every ingest and read path (2026-11-23)

Read-only audit for the plan. Server paths relative to `server/src/`.

## Keys

- `sessions.session_id` is **globally unique** (`sessions_session_id_unique`); `parent_session_id` is the
  immediate parent's `session_id` text (no FK, NULL = root); `deleted bool`. No `user_id`: the owner is
  the `user_id` of the session's `logs` / `logs_otel` rows, else `otel_session_state.user_id`
  (`logs/logs.service.ts:124-156`).
- `deleted_session_log`: `id`, `session_id`, `session_pk` (UNIQUE, = `sessions.id`), `owner_user_id`,
  `deleted_by_user_id` (NULL = retention), `deleted_at`, `start_time`, `end_time`, `work_time_ms`,
  `total_cost`. No repository column. Indexes: `deleted_at`, `deleted_by`, unique `session_pk` —
  **nothing serves a lookup by `session_id`**. Nothing reads the table today (audit trail only).

## Writers of `deleted_session_log`

| Path | Row? | Descendants? | owner_user_id |
|---|---|---|---|
| Soft delete `sessions/sessions.service.ts:85-177` (insert :152) | yes | root + every non-deleted descendant (:128-147) | owner |
| Retention `hardPurgeExpiredSessions` :388-534 (insert :477, `ON CONFLICT(session_pk) DO NOTHING`) | yes | active descendants | **NULL** (:482) |
| Admin repo removal `admin/admin.service.ts:613-678` | no | | |
| Account deletion `users/account-deletion.service.ts:105-225` | no | | |
| Team repo removal `teams/teams.service.ts:568-675` | no | | |

## Fresh start (account / repository deleted and added again)

- Account deletion collects sessions via `logs.user_id` + OTEL-only roots (:134-155). A soft-deleted
  session has neither, so its `sessions` row (`deleted=true`) **survives** and keeps rejecting uploads.
- Admin repo removal finds sessions via `log_repositories` (artisyn logs only, :625-664); soft-deleted
  sessions have no artisyn log left → they survive. Team repo removal has the same blind spot.
- Needed: hard-delete the soft-deleted `sessions` rows of that account / repository and delete their
  `deleted_session_log` rows. That needs `owner_user_id` on retention rows (resolvable from `logs`
  before the purge) and a repository column on `deleted_session_log` (root's repo URL, resolved at
  delete time through the root artisyn log's `log_repositories` link, copied to descendant rows).
  Rows written before the migration cannot be matched to a repository (accepted).

## Ingest paths

| Path | Own soft-deleted | `deleted_session_log` | Deleted ancestor | Creates `sessions` row |
|---|---|---|---|---|
| `POST /api/v2/logs` controller (`logs/logs-v2.controller.ts:43-307`) | no (stages, 201) | no | no | no |
| Queue → `LogsService.upsert` (`logs/upload-queue-scheduler.service.ts:406-429`; `logs.service.ts:284-308`): claude, claude-subagent, artisyn (+ harness/OKF snapshots), tool-calls | yes, but **outside the tx and lock** (:298); `deleteSession` takes no lock → race | no (purged id re-created) | **no** (late subagent of a deleted root is created live) | yes (:350) |
| Queue → `ingestOtelChunk` (`logs.service.ts:1264`, called :425-428) | root via `lockOtelState` (`otel-facts-writer.ts:217-222`) | no | via stored chain | |
| Zip import `importSession` (`logs.service.ts:967-1029`) | yes, under lock (:979-991) | no | no | yes (:1006) |
| `POST /api/v2/otel-realtime` (`logs/otel/otel-realtime.service.ts:79-190`) | yes via top ancestor; answers `ignored:'deleted'` | no (purged root re-created as OTEL-only root) | partly | yes (rolled back if deleted) |
| `POST /api/v2/session-attribution` | effectively yes (needs artisyn log row, purged on delete) | effectively yes | n/a | no |
| `POST /api/v2/turn-end-cost-advisor` (`turn-end-cost-advisor.service.ts:233-240, 522`) | **no** — inserts into `turn_end_advisor_runs`; orphan sweep never removes it (anti-joins `sessions`) | no | no | no |

Out of scope (not ingest): `POST /api/v1/sessions/:id/favorite` writes `user_favorite_sessions` for
any `session_id` without a deleted check (`logs/repositories.service.ts:1598-1615`).

## Soft-delete survivors (not removed by `purgeSessionChildData`, `sessions.service.ts:189-295`)

No reader intentionally relies on them after a delete (every cost reader filters `s.deleted=false`;
the cost at deletion is frozen in `deleted_session_log.total_cost`). Common hole: `descendantSessionsCte`
(`logs/session-tree.sql.ts:36-46`) has **no `deleted` filter**, so a soft-deleted sub-agent of a live
root (API accepts a sub-agent id on `DELETE /api/v1/sessions/:id`) still counts in per-tree reads.

| Table | Unfiltered readers | Decision |
|---|---|---|
| `logs_otel` | ownership reads `findSessionOwnerId` / `findForeignSessionIds` rely on it (`logs.service.ts:140-143,192-202`; import parent check `includeDeleted:true`, `repository-export-import.service.ts:345-349`) | purge; ownership of a deleted session falls back to `deleted_session_log.owner_user_id` |
| `otel_api_calls` | tree cost CTEs (`otel-cost.sql.ts:344-404`) | purge |
| `session_request_ids` | utility classification (`otel-cost.sql.ts:404`, `otel/otel-classify.ts`) | purge |
| `session_tool_stats` | `analytics/tool-analytics.service.ts:105-131`, `analytics/active-sessions.service.ts:149`, `reports/harness-usage.service.ts`, advisor aggregate `turn-end-cost-advisor.service.ts:332` (descendants unfiltered) | purge |
| `session_harness_usage` | `reports/harness-usage.service.ts:609` | purge |
| `session_changed_paths` | `change-surface/changed-paths.sql.ts:312-330` | purge |
| `session_cause_stats` | filtered | purge |
| `session_attribution`, `session_attribution_runs`, `session_prompt_watermark` | filtered | purge |
| `turn_end_advisor_runs` (string key) | effectively filtered | purge by `session_id` text; stop inserting for deleted sessions |
| `upload_queue_measurements` | admin stats only | keep |

## Other holes

1. Late sub-agent of a deleted root: never listed, but never purged by retention, invisible to repo
   removal, counted by `getRetentionStats` (`sessions.service.ts:556-565`), served by
   `GET /api/v2/okf-usage/facts?sessionId=<agent>` (`okf/okf-facts.service.ts:295-305`).
2. Retention-purged root re-uploaded → recreated and listed again.
3. Delete/ingest race (above).

## Conclusions used by the plan

- One tombstone check (own soft delete, `deleted_session_log` by `session_id`, any ancestor via the
  stored parent chain plus the upload's `parentSessionId`), run inside the ingest transaction after
  the tree lock; `deleteSession` takes the same tree lock.
- Purge every survivor on soft delete except `upload_queue_measurements`; a one-time startup cleanup
  purges survivors of already soft-deleted sessions and soft-deletes live descendants of deleted
  ancestors.
- `descendantSessionsCte` gets `deleted = false`.
- New `deleted_session_log` columns/indexes: `repository_url`, index on `session_id`, on
  `owner_user_id`, on `repository_url`; retention writes `owner_user_id`.
