# T-77: Copilot Session Upload

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** hook, server, client
**Owner:** denis.tsyplakov
**Created:** 2026-08-05

## Description

When a GitHub Copilot CLI session ends, a hook reads the session's `events.jsonl` file (path
delivered by the `Stop` event via `transcript_path`) and uploads it to the server. The server
parses the file, extracts session metadata and cost, and stores the session. The UI shows Copilot
sessions in the existing session list alongside Claude sessions, with the total session cost
displayed per row.

Goal: a developer who uses both Claude Code and Copilot CLI sees all their sessions in one list,
each with a cost figure.

## Context: confirmed hook behaviour

- Hook config location: `.github/hooks/<name>.json` — Copilot CLI reads all `.json` files there.
- **`args` field is silently ignored** — the full command must be a single string in `command`:
  `"command": "node .github/copilot-hooks/copilot-send-logs-hook.js"`.
- Hook payload is delivered via stdin in **Claude Code snake_case format** (identical field names):
  `hook_event_name`, `session_id`, `cwd`, `timestamp` (ISO string), `prompt`, `transcript_path`,
  `stop_reason`.
- `transcript_path` on `Stop` is the direct absolute path to
  `~/.copilot/session-state/<uuid>/events.jsonl` — no path construction needed.
- Working directory when the hook runs = project root (cwd from input payload).

## Context: Copilot events.jsonl structure

Key events (extracted from real sessions):

| Event type | Key fields |
|---|---|
| `session.start` | `data.sessionId`, `data.startTime`, `data.copilotVersion`, `data.context.cwd`, `data.context.gitRoot` (absent for non-git dirs), `data.context.branch` (absent for non-git dirs) |
| `session.auto_mode_resolved` | `data.chosenModel` — the actual model used; `data.selectedModel` does NOT exist on `session.start` |
| `user.message` | `data.content` (raw user input) |
| `assistant.message` | `data.model`, `data.outputTokens` |
| `session.shutdown` | top-level `timestamp` = `end_time`; `data.totalPremiumRequests`, `data.modelMetrics.<model>.usage.inputTokens` / `.outputTokens` (total per model including cached), `data.modelMetrics.<model>.requests.cost` (0 for non-premium; ×$0.01 = USD for premium credits), `data.currentModel` |

## Functional Requirements

### FR-1: Hook script (`copilot-send-logs-hook.js`)

- Fires on `Stop` (registered in `.github/hooks/copilot-upload.json`).
- Reads `transcript_path` from the stdin payload; reads `cwd` for config lookup.
- Loads server URL and API key from `.artisyn/config/log-hub.json` / `log-hub.local.json`
  (same config files the Claude hook already uses — no new config format).
- If either is missing, exits 0 silently (no server configured).
- Reads the events.jsonl at `transcript_path` and POSTs it to
  `POST /api/v2/logs?type=copilot&sessionId=<session_id>`.
- Uses `Content-Type: application/x-ndjson` and `X-API-Key` header — same as the Claude hook.
- Fail-open: any error (missing file, network failure, bad config) exits 0 after writing to
  `.artisyn/ai_work_dir/hook.log`.
- No external npm dependencies — only Node.js built-ins (`fs`, `path`, `http`, `https`).
- Can share `env-context.js`, `hook-log.js`, `git-context.js` from the existing plugin scripts.

### FR-2: Hook config

- Add `.github/hooks/copilot-upload.json` to the repository.
- Wires `Stop` → `copilot-send-logs-hook.js`.
- Uses single-string `command` format (no `args` field — confirmed Copilot CLI requirement).

### FR-3: Server — ingest endpoint

- `POST /api/v2/logs?type=copilot&sessionId=<uuid>` accepts the events.jsonl body.
- Reuses the existing `LogsV2Controller` / upload-queue infrastructure (`type=copilot` is a new
  value for the `type` query param alongside `artisyn`, `claude`, `claude-subagent`).
- Existing `ApiKeyAuthGuard` and 50 MB body limit apply unchanged.
- Queues the body for async parsing (same pattern as `claude` namespace uploads).

### FR-4: Server — Copilot parser

- New parser (`copilot-parser.ts` or equivalent) processes queued `type=copilot` bodies.
- Extracts from events.jsonl:
  - `session_id` — from `session.start.data.sessionId`
  - `start_time` — from `session.start.data.startTime`
  - `end_time` — top-level `timestamp` field on the `session.shutdown` line (not under `data`);
    absent = null
  - `git_branch` — from `session.start.data.context.branch` (null for non-git directories)
  - `first_prompt` — `data.content` of the first `user.message` event (not `transformedContent`);
    null when no `user.message` events are present
  - `cost_usd` — sum of `session.shutdown.data.modelMetrics.<model>.requests.cost` × 0.01
    across all model keys (absent or 0 per model = 0 contribution; null only when
    `session.shutdown` is entirely absent)
  - `input_tokens`, `output_tokens` — summed across all model keys from
    `session.shutdown.data.modelMetrics.<model>.usage.inputTokens` / `.outputTokens`
- Upserts into the `logs` table with `log_type = 'copilot'` and a new `provider = 'copilot'`
  column (see FR-5).
- If `session.shutdown` is absent, stores what is available and marks `end_time` / cost as null.
- A re-upload of the same `session_id` overwrites all stored fields unconditionally.

### FR-5: DB — `provider` column on `logs`

- Add `provider TEXT NOT NULL DEFAULT 'claude'` to the `logs` table via a SQL migration.
- Copilot rows: `provider = 'copilot'`, `log_type = 'copilot'`.
- Existing Claude rows remain `provider = 'claude'` (default, no backfill needed).
- Index on `(user_id, provider)` if session-list queries filter by provider.

### FR-6: UI — session list

- Copilot sessions appear in the existing Logs tab session list alongside Claude sessions.
- Each Copilot row shows:
  - A small colored provider badge: `(claude)` for Claude sessions, `(copilot)` for Copilot
    sessions — same pill style, different label text and color.
  - Session start time (from `start_time`).
  - Total cost in USD (`cost_usd`), formatted the same way as Claude session costs; shown as "—"
    when `session.shutdown` data is absent.
  - First prompt text (truncated, same as Claude rows).
- No new tab or separate view — Copilot sessions appear inline in the existing list.

## Acceptance Criteria

- [ ] Running a Copilot CLI session in a repo with `.github/hooks/copilot-upload.json` triggers the
      upload hook on session end.
- [ ] The hook reads `transcript_path` from the Stop payload and uploads the events.jsonl without
      error when server config is present.
- [ ] `POST /api/v2/logs?type=copilot` is accepted by the server and queued for processing.
- [ ] A Copilot session with a `session.shutdown` event results in a `logs` row with `provider =
      'copilot'`, correct `start_time`, `end_time`, and non-null `cost_usd`.
- [ ] A Copilot session without `session.shutdown` results in a partial row; re-uploading after
      shutdown overwrites the row with complete data including `cost_usd` and `end_time`.
- [ ] The existing session list in the UI shows Copilot sessions with a provider badge and cost.
- [ ] Claude sessions are unaffected (no regression in display, cost calculation, or upload).
- [ ] Hook exits 0 on all error paths (missing config, missing file, network failure).
- [ ] A Copilot session with no `session.shutdown` event shows "—" in the cost column (`cost_usd` is null).

## Open Questions

## Common sense considerations

- `session.shutdown` timing: for `copilot -p` (non-interactive) sessions, `session.shutdown` is always written to events.jsonl synchronously before the process exits and the Stop hook fires; the server must still handle `session.shutdown` absent for sessions that were force-quit.
- `requests.cost` is always present in `modelMetrics` (confirmed from real data), even when 0 for non-premium sessions; treat any absent key as 0 for safety; `cost_usd` is null only when `session.shutdown` is entirely absent.
- Primary model when multiple models are used: use the model from the first `assistant.message` event in events.jsonl.
- `logs.body` for Copilot rows: store the parsed events.jsonl lines array (same pattern as all other log types; required by the NOT NULL constraint).
- The Drizzle schema (`server/src/database/schema/index.ts`) must be updated alongside every SQL migration — this is standard project practice.
- The Copilot hook must honour the `sendLogsTimeoutMs` config key (same as the Claude hook).
- Hook log calls use `hookFile = 'copilot-send-logs-hook.js'` and `event = 'Stop'`, matching the existing hook pattern.
- Copilot hook script installation: place at `.artisyn/marketplace/plugins/log-hub-hooks/scripts/copilot-send-logs-hook.js` (same directory as the Claude hook scripts); `.github/hooks/copilot-upload.json` `command` references that installed path, giving the script direct `require()` access to `env-context.js`, `hook-log.js`, and `git-context.js` in the same directory.
- `cost_usd` storage: add `cost_usd NUMERIC(14,8) NULLABLE` to the `logs` table via a new SQL migration alongside the `provider` column migration.
- `input_tokens` / `output_tokens` storage: the Copilot parser creates a `session_stats` row using the existing `inputTokens` and `outputTokens` columns; all other stat columns (workTimeMs, filesEditedWritten, etc.) default to 0.
- `sessions` row prerequisite: the Copilot parser must upsert a `sessions` row (keyed on the UUID from `session.start.data.sessionId`) before creating the `logs` row to satisfy the FK constraint.
- `(user_id, provider)` index: defer until the revised session-list query is designed; add the index once the new query's filter columns are known.
- Re-upload override: a second upload of the same `session_id` overwrites all stored fields unconditionally; there is no null→non-null merge.
- API response for cost and provider: `getRepositorySessions` must return `costUsd` (from `logs.cost_usd`) and `provider` (from `logs.provider`) per row so the session list can display cost and the provider badge.
- `getRepositorySessions` revised query: change the main log-type filter from `log_type = 'artisyn'` to `log_type IN ('artisyn', 'copilot')`; make the `EXISTS (log_type = 'claude')` sub-condition apply only to artisyn rows — `(log_type = 'artisyn' AND EXISTS(claude)) OR log_type = 'copilot'`.
- `log_repositories` link: the Copilot parser looks up a `repositories` row whose `url` matches `session.start.data.context.gitRoot`; if found, inserts a `log_repositories` row at the end of the parse step; if no match, the session is stored but not visible in the session list until the repo is registered (same behaviour as any unlinked session).
- `first_prompt` when no `user.message` events: store null (consistent with the nullable column).
- Re-upload completeness: events.jsonl is the complete session file written from start to finish; a re-upload on the same `session_id` is always the full file, so overwriting `body` via upsert is safe.
- `end_time` path (confirmed): top-level `timestamp` field on the `session.shutdown` line — not under `data`; `data.sessionStartTime` is epoch-milliseconds and is a cross-check only.

## Notes

- 2026-08-05: Investigation artifacts (reference hook implementation path, session traces examined) — see `notes.md`.
