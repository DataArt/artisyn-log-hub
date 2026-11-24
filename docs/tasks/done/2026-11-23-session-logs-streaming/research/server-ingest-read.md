---
type: "Research"
title: "Server ingest and read path details for streaming and skip"
description: "Body writers, upload queue mechanics, workflows extraction, response byte layout of /logs, delta full-snapshot memory, migrations and hook API compatibility facts used by the plan."
---

# Server ingest and read path details (2026-11-23)

Read-only survey. Server paths relative to `server/src/`, hook paths to `hook/.claude/telemetry_tool/`.

- **Body writers (only three):** `logs/logs.service.ts:431` upsert (`ON CONFLICT … SET body = excluded.body, updated_at = now()`),
  `:1121` zip-import insert, `:1137` zip-import keep-longer update. No migration or backfill writes `body`.
- **`upload_queue`:** columns `id, file_name, size_bytes, received_at, session_id, log_type, user_id, parent_session_id,
  workflow_run_id, status (pending|processing|partially_uploaded|failed|rejected_foreign_session), error_message,
  updated_at, upload_id, chunks_received, total_chunks, warning_delivered, harness_snapshot_id, okf_snapshot_id,
  attempts, error_kind (server|file), agent_description, workflow_phase`; index `(session_id, received_at)`.
  `received_at` = first insert / chunk-0 time, never updated (survives chunk-0 retry, reassembly, transient retry).
  `processRow` reads the staged file as one string and parses all lines. `getPendingWarnings`
  (`logs/upload-queue.service.ts:418-454`) returns **all** failed rows every call (no delivered flag);
  only foreign-session rejections are delivered once (`warning_delivered`).
- **Workflows:** `extractWorkflows(events: unknown[]): WorkflowRun[]` (`logs/workflow-extractor.ts:126`), small output;
  `resolveWorkflowAgentLinkage(workflows, rows)` (`logs/workflow-linkage.ts:23`) needs only descendant metadata.
  Session-list flags pattern: computed in `extractClaudeStats` (`logs/claude-extractor.ts:1412`, null for sub-agents),
  written by `session-stats-writer.ts:57` with a version column; startup backfill `database-init.ts:190`.
- **Admin recompute** (`logs/repositories.service.ts:1356`) loads every body of the repo at once; the ingest block
  (`logs.service.ts:465-544`, with `loadSessionTreeEditRecords` :473-483) is the complete per-node extraction
  (also file stats, OKF access, cause stats).
- **Delta full snapshot** (`logs/session-logs-delta.service.ts:364-424`): with no cursor every tree row is "new" and
  `readSlices` returns `jsonb_agg(...)::text` of every whole body in one result set, then `JSON.parse`s each →
  unbounded. `readWorkflows` (:430-460) parses the whole root body.
- **`/logs` byte layout** (`logs/repositories.controller.ts:1780-1791, 2002, 2050-2052`): bodies are Postgres
  `body::text`; main = artisyn and claude texts spliced (`a.slice(0,-1)+','+c.slice(1)`, `[]` cases kept);
  subagents ordered by `sessions.session_id`, null bodies dropped, template
  `{"sessionId":…,"parentSessionId":…,"agentDescription":…,"workflowPhase":…,"logs":<body>}`; final
  `{"main":…,"subagents":[…],"subagentStats":…,"rootStats":…,"workflows":…,"turnEndAdvisor":…,"sessionAttribution":…,"harnessSnapshot":…}`.
- **Migrations:** hand-written `server/drizzle/migrations/NNNN_*.sql` (latest `0095`), journal
  `meta/_journal.json`, `npm run migrations:lock`; each file runs in a transaction. No `CREATE FUNCTION` /
  `CREATE TRIGGER` exists yet; `scripts/db-state.mjs` does not dump functions or triggers.
- **Hook API:** unknown query params ignored (`main.ts:95-97`); a new response field is gated on a request param
  only new hooks send (`hook-api-versioning.md:399-423`). The hook reads at most ~2000 bytes of the 201 body
  (`upload-logs.js:552-589`) and fails open on a parse error — a large new field would hide `unknownSnapshotId`.
- **Hook manifest:** `.claude-logs.sent` lines `<key> <int>`; skip when `manifest.get(key) === statSize`
  (`send-logs-hook.js:2188-2209`); `tool-calls` stores Σ(size+1). Pending `.claude-logs.pending`
  `{version:2, entries:{key:{uploadId,totalSize,totalChunks,nextChunkIndex,slices}}}`, resume on `totalSize ===`
  (`upload-logs.js:886`). Prompt-time upload and SessionEnd flush hold `.upload.lock` and never touch the manifest.
- **Env helper:** `readPositiveIntEnv` in `logs/tool-monitoring/tool-usage.constants.ts:23-26` is module-private.
  `server/.env.example`: comment + active line; `release-template/.env.example`: comment + commented default.
- **Cluster:** 3–15 workers (`common/instance-count.ts:9-11`), every scheduler in every worker; a per-worker
  in-process semaphore is the right scope for a memory cap.
