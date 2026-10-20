**Requirements summary**

T-77 adds GitHub Copilot CLI session upload to the existing log-hub pipeline. When a Copilot session ends, a new hook script (`copilot-send-logs-hook.js`) fires on the `Stop` event, reads `transcript_path` from the stdin payload, and POSTs the raw `events.jsonl` body to a new `type=copilot` variant of the existing `POST /api/v2/logs` endpoint. Server-side, a new Copilot parser extracts session metadata and cost from the NDJSON events and upserts a `logs` row with `log_type = 'copilot'` and a new `provider = 'copilot'` column. Two new nullable columns (`provider`, `cost_usd`) are added to the `logs` table via SQL migration. The `getRepositorySessions` controller query is widened to return both `artisyn` and `copilot` rows, and the client-side `SessionItem` component gains a provider badge and can show a `—` cost for incomplete uploads.

**Wireframes**

None referenced.

---

**Knowledgebase**

- `docs/knowledgebase/hook-system-overview.md` — Hook source lives at `hook/.claude/telemetry_tool/`. Plugin layout installs to `.artisyn/marketplace/plugins/log-hub-hooks/scripts/`. Scripts use only Node.js built-ins; `loadConfig(cwd)` from `env-context.js`; `hookLog(hookFile, sessionId, event, message, cwd)` from `hook-log.js`; fail-open (`process.exit(0)` on all error paths). POST to `/api/v2/logs`, `Content-Type: application/x-ndjson`, `X-API-Key` header, `type` + `sessionId` query params. Hook files changed under `hook/.claude/telemetry_tool/` require version bump in `version.json` + `.claude/telemetry_tool/version.json` (mirror) and running `update-install-instructions` skill.

- `docs/knowledgebase/hook-installation.md` — Hook config (`log-hub.json` / `log-hub.local.json`) is loaded via `loadConfig(cwd)` anchored at git repo root, not `${CLAUDE_PLUGIN_ROOT}`. `sendLogsTimeoutMs` key (default `10000`) is the HTTP timeout to honor. `serverUrl` and `apiKey` are the required keys; silent exit when either is absent.

- `docs/knowledgebase/hook-api-versioning.md` — Use `/api/v2/logs` (not v1). `LogsV2Controller` accepts `type`, `sessionId`, `parentSessionId`, `workflowRunId`, chunk params. No NDJSON parsing on the request path; body staged to disk and queued. Response is `{ warnings: string[] }` on success. `ApiKeyAuthGuard` + `express.text()` middleware already registered for the route.

- `docs/knowledgebase/db-schema-code.md` — Schema source of truth: `server/src/database/schema/index.ts`. **Never run `drizzle-kit generate`** — hand-write SQL migrations in `server/drizzle/migrations/NNNN_<slug>.sql` and register in `meta/_journal.json`. Update `db-tables.md` after every schema change. After changes, run `npm run migrate` from `server/`.

- `docs/knowledgebase/db-tables.md` — `logs` table columns: `id`, `session_id` (FK → sessions), `user_id`, `log_type`, `body` (jsonb NOT NULL), `first_prompt`, `start_time`, `end_time`, `git_branch`, `created_at`, `updated_at`. Unique on `(session_id, log_type)`. Two new columns needed: `provider TEXT NOT NULL DEFAULT 'claude'` and `cost_usd NUMERIC(14,8)` nullable.

- `docs/knowledgebase/client-component-map.md` — `RepositorySession` type: `client/src/models/repositories.ts`. Session row renderer: `client/src/viewer/pages/repository/session-list/session-list-helpers.tsx` → `SessionItem`. Provider badge should follow the pattern of `isHookService` / `hasWorkflow` badges (pill `span` in the third `<p>` row). Update the component map after adding/renaming any component.

---

**Existing patterns**

- `hook/.claude/telemetry_tool/send-logs-hook.js:436–476` — Canonical hook entry point pattern: read stdin → parse JSON → check `hook_event_name` → call `loadConfig(cwd)` → check `serverUrl`/`apiKey` → do work → `process.exit(0)`. Copilot hook reuses this skeleton.

- `hook/.claude/telemetry_tool/upload-logs.js:52–185` — `uploadFile(serverUrl, apiKey, namespace, sessionId, body, timeoutMs, ...)` — POST to `/api/v2/logs?type=...&sessionId=...` with `Content-Type: application/x-ndjson` + `X-API-Key`. Copilot hook can `require('./upload-logs')` and call `uploadFile` directly (no chunking needed for typical `events.jsonl` size).

- `hook/.claude/telemetry_tool/env-context.js:232–262` — `loadConfig(cwd)` resolves config from `<gitRoot>/.artisyn/config/log-hub.json` + `log-hub.local.json`. Returns `config.serverUrl`, `config.apiKey`, `config.sendLogsTimeoutMs` (default 10000). Copilot hook `require`s this directly.

- `hook/.claude/telemetry_tool/hook-log.js:59–73` — `hookLog(hookFile, sessionId, event, message, cwd)` — appends to `.artisyn/ai_work_dir/hook.log`. Use `hookFile = 'copilot-send-logs-hook.js'`, event `'Stop'`. Exact pattern from all other hook scripts.

- `server/src/logs/logs-v2.controller.ts:34–91` — `LogsV2Controller.postLogs()` — accepts `type` + `sessionId` query params + raw NDJSON body → calls `uploadQueueService.saveRawUpload()`. `type=copilot` will flow through unchanged since no type-validation is done here.

- `server/src/logs/upload-queue-scheduler.service.ts:161–178` — `processRow()` — calls `logsService.upsert(session_id, log_type, lines, user_id, bodyBytes)`. `log_type = 'copilot'` arrives here; the Copilot parser is invoked from `upsert()` when `logType === 'copilot'`.

- `server/src/logs/logs.service.ts:97–147` — `upsert()` transaction: Step 1 session upsert → Step 2 log upsert with extracted fields → Step 3 `session_stats` upsert (only for `claude`/`claude-subagent`) → Step 4 early-exit for non-`artisyn` types → Step 5 repo link. Copilot needs: Step 2 with Copilot-extracted fields, a new Step 3b for `session_stats` (inputTokens/outputTokens), a new Step 5 for repo link (via `gitRoot` from `session.start.data.context.gitRoot`), and a different early-exit guard (skip Steps 5-6 after repo link).

- `server/src/logs/logs.service.ts:245–265` — log upsert `.onConflictDoUpdate` sets `body`, `updatedAt`, `firstPrompt`, `startTime`, `endTime`, `gitBranch` via `excluded.*`. The same upsert block needs to also update `cost_usd` and `provider` for Copilot rows (unconditional overwrite, per FR-4's re-upload semantics).

- `server/src/logs/session-stats-writer.ts:12–55` — `upsertSessionStatsRow(db, sessionRowId, stats)` — upserts `session_stats` via `onConflictDoUpdate`. Copilot parser calls this with `inputTokens` + `outputTokens` from `session.shutdown.data.modelMetrics`, all other stat fields defaulting to `0`, `model` from first `assistant.message`.

- `server/src/logs/repositories.controller.ts:222–428` — `getRepositorySessions()` — main query at line 249 filters `eq(logs.logType, 'artisyn')` + EXISTS(`log_type = 'claude'`). For Copilot: change to `OR (log_type = 'copilot')` per the requirements' revised filter. The cost query at lines 282–363 computes cost via token × pricing SQL — Copilot sessions return `cost_usd` directly from `logs.cost_usd` instead; the two paths must be combined in the response.

- `server/src/database/schema/index.ts:156–183` — `logs` pgTable definition. Add `provider: text('provider').notNull().default('claude')` and `costUsd: numeric('cost_usd', { precision: 14, scale: 8 })` (nullable) to the table definition.

- `client/src/models/repositories.ts:20–32` — `RepositorySession` interface. Add `provider?: 'claude' | 'copilot'` and `costUsd?: number | null` fields.

- `client/src/viewer/pages/repository/session-list/session-list-helpers.tsx:123–137` — `SessionItem`'s badge row already has `isHookService` (amber) and `hasWorkflow` (purple) badges. Provider badge follows the same `inline-block rounded px-1.5 py-0.5 font-mono text-xs` pill pattern, e.g. blue for `copilot`.

- `.github/hooks/session-log.json:1–40` — Existing Copilot hook config file using old `command`/`args` format (wrong — `args` is silently ignored by Copilot CLI). The new `copilot-upload.json` must use single-string `command: "node .artisyn/marketplace/plugins/log-hub-hooks/scripts/copilot-send-logs-hook.js"` only.

- `server/drizzle/migrations/0038_password_reset_tokens.sql` — Latest migration is `0038`; next migration(s) use prefix `0039`.

- `hook/.claude/telemetry_tool/version.json` — Current hook version is `2.2.1`; bump required when adding `copilot-send-logs-hook.js`.

---

**Open gaps**

1. **Copilot parser as a new file** — No existing `copilot-parser.ts` pattern to copy; must be created from scratch. Closest analogue is `artisyn-extractor.ts` (line-by-line scan of NDJSON events) but the event schema is entirely different (Copilot-specific event types).

2. **`getRepositorySessions` cost column merge** — The existing cost query computes cost via token×pricing SQL for Claude sessions; Copilot cost comes from `logs.cost_usd` directly. The plan must decide how to combine both into one `totalCost` per row — either two separate queries merged client-side, or a SQL UNION/CASE that reads `cost_usd` for `log_type='copilot'` and the existing token calculation for `log_type='artisyn'`.

3. **`getRepositorySessionIds` lightweight sibling** (`repositories.controller.ts:433`) — Also filters by `log_type='artisyn'` + EXISTS(claude). Must be widened in parallel with `getRepositorySessions`; no separate note in requirements but will break Copilot-session badge polling if not updated.

4. **Analytics / timeline queries** — `repositories.service.ts:733` also filters `eq(logs.logType, 'artisyn')` for date-scoped session exports. Copilot sessions may not appear in analytics/timeline views without widening those queries — requirements only specify the session list (FR-6); deferring analytics is an open decision.

5. **`session.shutdown` absent path** — If `session.shutdown` is absent, `cost_usd` is null and `end_time` is null. The upsert `.onConflictDoUpdate` must NOT use `COALESCE` for `cost_usd`/`end_time` (re-upload overwrites unconditionally).

6. **`log_repositories` link for Copilot** — `gitRoot` from Copilot payload is a local filesystem path, while `repositories.repoUrl` stores a git remote URL (e.g. `git@github.com:org/repo.git`). This impedance mismatch between the two URL formats is unresolved in the requirements.
