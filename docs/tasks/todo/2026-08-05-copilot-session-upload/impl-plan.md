# T-77 Implementation Plan — Copilot Session Upload

## TL;DR

- **New hook script** `hook/.claude/telemetry_tool/copilot-send-logs-hook.js`: fires on Copilot `Stop`, reads `transcript_path`, prepends a `__copilot_meta` line (git remote URL), and POSTs NDJSON to `/api/v2/logs?type=copilot`.
- **Installer Copilot target**: `--target <claude|copilot|both>` flag added to `install`; autodetects by `.claude/` / `.github/hooks/` dir presence; writes `.github/hooks/copilot-upload.json` when Copilot target is active.
- **DB migration `0039`**: adds `provider TEXT NOT NULL DEFAULT 'claude'` and `cost_usd NUMERIC(14,8)` to `logs`; Drizzle schema updated.
- **New `copilot-extractor.ts`**: parses Copilot NDJSON events; extracts `firstPrompt`, `startTime`, `endTime`, `costUsd`, tokens, `gitRemoteUrl` (from meta line).
- **`logs.service.ts` extended**: Copilot `upsert()` path writes `provider = 'copilot'`, `cost_usd`, session_stats, and repo link via `gitRemoteUrl`.
- **`repositories.controller.ts` widened**: `getRepositorySessions` and `getRepositorySessionIds` include `log_type = 'copilot'` rows; Copilot cost sourced from `logs.cost_usd` (separate query, merged into shared `costMap`).
- **`SessionItem` badge**: Copilot sessions get a `(copilot)` blue pill badge; Claude sessions unchanged.

## Reference

→ [requirements.md](./requirements.md)

---

## Design Decisions

**DD-1 — Installer autodetect** `detectTargets(cwd)` returns `{ claude, copilot }` booleans: `claude = fs.existsSync('.claude/')`, `copilot = fs.existsSync('.github/hooks/')`. When no `--target` flag is given, use autodetect; if neither directory exists, default to `claude`. `--target claude|copilot|both` always overrides. `upgrade` re-detects by checking whether `.github/hooks/copilot-upload.json` already exists.

**DD-2 — `copilot-upload.json` command string** The file uses `"command": "node .artisyn/marketplace/plugins/log-hub-hooks/scripts/copilot-send-logs-hook.js"` (single-string, no `args` field — confirmed Copilot CLI requirement). Path is relative to project root, matching the hook's working directory when Copilot fires it.

**DD-3 — Copilot meta line for repo URL** `gitRoot` in events.jsonl is a local filesystem path; `repositories.repoUrl` stores git remote URLs — these never match. To bridge the gap: the hook prepends one NDJSON line `{"__copilot_meta":{"gitRemoteUrl":"<url>"}}` to the body before POST (extracted via `git-context.js` in the CWD). The parser reads this as the first line to get the normalized remote URL for repo linking. No `upload_queue` schema change required.

**DD-4 — Cost dual-source** After `getRepositorySessions` fetches both artisyn and Copilot rows, costs are fetched separately by type. Artisyn: existing complex CTE (unchanged, filtered to artisyn session IDs). Copilot: simple `SELECT session_id, cost_usd FROM logs WHERE log_type = 'copilot' AND session_id = ANY(ids)`. Both results are merged into the shared `costMap`.

**DD-5 — Re-upload `firstPrompt` on conflict** For `logType === 'copilot'` use `sql\`excluded.first_prompt\`` (unconditional overwrite — events.jsonl is always the complete file). For all other types keep existing `sql\`COALESCE(excluded.first_prompt, ${logs.firstPrompt})\``.

**DD-6 — Session list filter** New condition replaces `eq(logs.logType, 'artisyn') + exists(claude)`:
```
or(
  and(eq(logType,'artisyn'), isNotNull(firstPrompt), exists(claudeLog)),
  and(eq(logType,'copilot'), isNotNull(firstPrompt)),
)
```
`repoCondition`, `sessions.deleted`, `branchCondition`, and `ownerCondition` remain outer AND conditions, applying to both types.

**DD-7 — Provider badge** Only Copilot sessions get a new badge to avoid adding visual noise to existing Claude rows. Badge: same `inline-block rounded px-1.5 py-0.5 font-mono text-xs` pill class as `isHookService`/`hasWorkflow` badges; blue background; text `copilot`. Claude sessions: no badge change.

**DD-8 — Hook version** `2.2.1` → `2.3.0` (MINOR: new `copilot-send-logs-hook.js` script, backwards-compatible). Installer package version auto-bumped by build script.

**DD-11 — `CopilotFields` extraction mapping**

| Field | Source path in events.jsonl | Null/zero condition |
|-------|------------------------------|---------------------|
| `gitRemoteUrl` | `__copilot_meta.gitRemoteUrl` (prepended line) | absent → null |
| `firstPrompt` | first `user.message.data.content` | no `user.message` → null |
| `startTime` | `session.start.data.startTime` | `session.start` absent → null |
| `endTime` | top-level `timestamp` on `session.shutdown` line | `session.shutdown` absent → null |
| `costUsd` | sum `session.shutdown.data.modelMetrics.<m>.requests.cost × 0.01` | absent `session.shutdown` → null; absent per-model key → 0 contribution |
| `inputTokens` | sum `session.shutdown.data.modelMetrics.<m>.usage.inputTokens` | `session.shutdown` absent → 0 |
| `outputTokens` | sum `session.shutdown.data.modelMetrics.<m>.usage.outputTokens` | `session.shutdown` absent → 0 |
| `gitBranch` | `session.start.data.context.branch` | non-git dirs → null |
| `model` | first `assistant.message.data.model` | no assistant events → null |

**DD-9 — Analytics / timeline** `repositories.service.ts:733` filters `log_type = 'artisyn'` for date-scoped exports. Copilot sessions will not appear in analytics/timeline views — deferred out of scope.

**DD-10 — Copilot `--target` on `upgrade` / `uninstall`** `upgrade` takes no `--target` flag (INSTALL_HOOK.md convention). It re-applies Copilot config automatically if `.github/hooks/copilot-upload.json` already exists. `uninstall` also removes `copilot-upload.json` if present.

---

## Files to Create / Modify

| File | Action | Notes |
|------|---------|-------|
| `server/drizzle/migrations/0039_copilot_logs_columns.sql` | Create | Adds `provider`, `cost_usd` to `logs` |
| `server/drizzle/migrations/meta/_journal.json` | Modify | Register idx=39 entry |
| `server/src/database/schema/index.ts` | Modify | Add `provider`, `costUsd` to `logs` table |
| `docs/knowledgebase/db-tables.md` | Modify | Document new columns |
| `hook/.claude/telemetry_tool/copilot-send-logs-hook.js` | Create | New Copilot hook script |
| `hook/.claude/telemetry_tool/version.json` | Modify | `2.2.1` → `2.3.0` |
| `.claude/telemetry_tool/version.json` | Modify | Mirror version bump |
| `scripts/build-hooks-installer.js` | Modify | Add `copilot-send-logs-hook.js` to `HOOK_JS_FILES` |
| `artisyn-hooks-installer/src/install.ts` | Modify | `CliFlags.target`, `detectTargets`, `installCopilotHooks`, `uninstallCopilotHooks`, updated run* functions |
| `artisyn-hooks-installer/src/index.ts` | Modify | Parse `--target` flag; update help text |
| `artisyn-hooks-installer/package.json` | Modify | Bump patch version |
| `hook/INSTALL_HOOK.md` | Modify | Document `--target` flag (via `update-install-instructions` skill) |
| `server/src/logs/copilot-extractor.ts` | Create | `extractCopilotFields()` |
| `server/src/logs/logs.service.ts` | Modify | Copilot upsert path (Steps 2–5) |
| `server/src/logs/repositories.controller.ts` | Modify | Widen session list + cost fetch |
| `client/src/models/repositories.ts` | Modify | Add `provider` to `RepositorySession` |
| `client/src/viewer/pages/repository/session-list/session-list-helpers.tsx` | Modify | Provider badge in `SessionItem` |
| `docs/knowledgebase/client-component-map.md` | Modify | Document badge addition |
| `docs/knowledgebase/server-endpoint-map.md` | Modify | Note `repoUrl` not added (meta-line approach) |
| `docs/knowledgebase/api-reference.md` | Modify | Document `provider` in session list response |
| `server/src/logs/copilot-extractor.spec.ts` | Create | Unit tests for `extractCopilotFields` |
| `server/src/logs/logs.service.spec.ts` (or `.e2e-spec.ts`) | Modify | Add Copilot upsert integration test path |
| `server/src/logs/repositories.controller.spec.ts` (or `.e2e-spec.ts`) | Modify | Add Copilot session list integration test |
| `hook/.claude/telemetry_tool/__tests__/copilot-send-logs-hook.test.js` | Create | Hook tests |
| `artisyn-hooks-installer/src/__tests__/copilot-install.test.ts` | Create | Installer tests |
| `tests/e2e/copilot-session.spec.ts` | Create | E2E: Copilot upload + sessions list `@core` test |

---

## API Changes

**`GET /api/v1/repositories/:repoId/sessions`** (existing `getRepositorySessions`)

New field in each response item:
```typescript
{ provider: 'claude' | 'copilot' }
```
`totalCost` now populated from `logs.cost_usd` for Copilot rows (previously only from token×pricing CTE).

No new endpoints.

---

## Database Changes

**Migration `0039_copilot_logs_columns.sql`**

```sql
ALTER TABLE logs ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';
ALTER TABLE logs ADD COLUMN cost_usd NUMERIC(14,8);
```

Both operations use PostgreSQL 11+ fast-default (no table rewrite; constant default stored in catalog). `cost_usd` is nullable — no NOT NULL constraint issue.

Drizzle schema `logs` pgTable (`server/src/database/schema/index.ts`):
```typescript
provider: text('provider').notNull().default('claude'),
costUsd: numeric('cost_usd', { precision: 14, scale: 8 }),
```

No `(user_id, provider)` index — deferred per requirements until the session-list query's filter columns are finalized.

---

## Test Coverage Plan

- **`copilot-extractor.spec.ts`**: `extractCopilotFields` covers: `session.start` fields (sessionId, startTime, gitBranch), `session.shutdown` cost (`requests.cost × 0.01` across models), absent `session.shutdown` → null costUsd/endTime, `__copilot_meta` line gitRemoteUrl extraction, first `user.message` → firstPrompt, no `user.message` → null firstPrompt, multiple models summed for tokens.
- **`copilot-send-logs-hook.test.js`**: main flow (reads file, POSTs with meta line); missing/unreadable `transcript_path` → exits 0; missing `serverUrl`/`apiKey` → exits 0 silently; network error → exits 0 after hook-log entry.
- **`copilot-install.test.ts`**: `detectTargets` — `.claude/` only → `{claude:true,copilot:false}`; `.github/hooks/` only → `{claude:false,copilot:true}`; both → both; neither → `{claude:true,copilot:false}`; `installCopilotHooks` writes correct JSON; `--target` CLI parsing; uninstall removes `copilot-upload.json`.
- **`logs.service.ts` / `repositories.controller.ts` integration tests**: add Copilot upsert test with full `session.start` + `session.shutdown` events; verify `provider = 'copilot'`, `cost_usd` populated; Copilot session appears in `getRepositorySessions` response with `provider: 'copilot'` and correct `totalCost`.
- **E2E `@core`**: add test: POST NDJSON to `/api/v2/logs?type=copilot&sessionId=<uuid>`, assert session appears in repository sessions list with `provider: 'copilot'`.

---

## Visual / UX Notes

**Copilot provider badge** (inside `SessionItem`'s existing badge row):
- Pill: `inline-block rounded px-1.5 py-0.5 font-mono text-xs` (matches existing badges)
- Color: blue (e.g., `bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200`)
- Text: `copilot`
- Only rendered when `provider === 'copilot'`; Claude rows get no new badge

**Cost display**: no change needed — `totalCost` is already rendered; for Copilot rows, it now comes from `logs.cost_usd` (same numeric value, same display path).

---

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | DB Schema — logs columns | 5 | No dependencies; run migration before server code changes |
| 2 | Hook Script + Build | 6 | Depends on nothing; triggers `update-install-instructions` |
| 3 | Installer — helpers | 4 | Depends on hook script path (DD-2) |
| 4 | Installer — integration | 6 | Depends on Chunk 3 |
| 5 | Server — Copilot extractor + logs.service | 6 | Depends on Chunk 1 (schema) |
| 6 | Server — repositories.controller | 6 | Depends on Chunk 5 |
| 7 | Client — types + UI | 4 | Depends on Chunk 6 (provider field in API) |
| 8 | Tests | 6 | Depends on all prior chunks |

### Chunk 1 — DB Schema: logs columns

- [ ] Create `server/drizzle/migrations/0039_copilot_logs_columns.sql`: `ALTER TABLE logs ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'; ALTER TABLE logs ADD COLUMN cost_usd NUMERIC(14,8);`
- [ ] Register idx=39 entry in `server/drizzle/migrations/meta/_journal.json` with tag `0039_copilot_logs_columns`
- [ ] Add `provider: text('provider').notNull().default('claude')` and `costUsd: numeric('cost_usd', { precision: 14, scale: 8 })` to `logs` pgTable in `server/src/database/schema/index.ts:156`
- [ ] Update `docs/knowledgebase/db-tables.md`: add `provider` (TEXT NOT NULL DEFAULT 'claude') and `cost_usd` (NUMERIC(14,8) nullable) to the `logs` table entry
- [ ] Run `npm run migrate` from `server/`; confirm no errors

### Chunk 2 — Hook Script + Build

- [ ] Create `hook/.claude/telemetry_tool/copilot-send-logs-hook.js` — fires on `Stop` only; reads `transcript_path`, `cwd`, and `session_id` from stdin; calls `loadConfig(cwd)` from `env-context.js`; exits 0 silently if `serverUrl`/`apiKey` absent; reads events.jsonl from `transcript_path`; prepends `__copilot_meta` NDJSON line per DD-3 using `getGitContext(cwd).remote` from `git-context.js` (no change to that file — `.remote` already returned by exported `getGitContext`)
- [ ] In the same file: call `uploadFile(serverUrl, apiKey, 'copilot', input.session_id, body, timeoutMs, input.session_id, cwd)` — `namespace='copilot'` (third positional arg) maps to `?type=copilot` URL param per `upload-logs.js:54`; no change to `upload-logs.js` needed; fail open via `hookLog` + `process.exit(0)` on all errors
- [ ] Bump `hook/.claude/telemetry_tool/version.json` from `2.2.1` to `2.3.0`
- [ ] Mirror version bump to `.claude/telemetry_tool/version.json`
- [ ] Add `'copilot-send-logs-hook.js'` to `HOOK_JS_FILES` array in `scripts/build-hooks-installer.js:60`
- [ ] Run `update-install-instructions` skill to regenerate `hook/INSTALL_HOOK.md`

### Chunk 3 — Installer: helpers

- [ ] Add `target?: 'claude' | 'copilot' | 'both'` to `CliFlags` type in `artisyn-hooks-installer/src/install.ts`
- [ ] Add `detectTargets(cwd): { claude: boolean; copilot: boolean }` function: checks `fs.existsSync(path.join(cwd, '.claude'))` and `fs.existsSync(path.join(cwd, '.github', 'hooks'))`; if neither, returns `{claude:true, copilot:false}` per DD-1
- [ ] Add `installCopilotHooks(cwd)` function: creates `.github/hooks/` dir (if absent); atomically writes `.github/hooks/copilot-upload.json` with content `{"hooks":{"Stop":[{"command":"node .artisyn/marketplace/plugins/log-hub-hooks/scripts/copilot-send-logs-hook.js"}]}}` per DD-2
- [ ] Add `uninstallCopilotHooks(cwd)` function: removes `.github/hooks/copilot-upload.json` if it exists; does NOT remove `.github/hooks/` dir (may have other hooks)

### Chunk 4 — Installer: integration

- [ ] Add `skipPluginActivation?: boolean` opt param to `applyHooksUpdate` in `install.ts`; when `true`, skip the `mergeSettings(claudeDir)` call and `runClaudePluginActivation(cwd)` call; all other steps (tar extract, config write) still execute
- [ ] Update `runInstall(flags)`: resolve effective targets from `flags.target ?? detectTargets(cwd)`; skip `.claude/` create/check when copilot-only; call `applyHooksUpdate(..., { skipPluginActivation: !targets.claude })` for all targets; call `installCopilotHooks(cwd)` when `targets.copilot`; include both in success message
- [ ] Update `runUpgrade()` in `install.ts`: after `applyHooksUpdate`, check if `.github/hooks/copilot-upload.json` exists; if so, re-call `installCopilotHooks(cwd)` to refresh per DD-10
- [ ] Update `runUninstall()` in `install.ts`: call `uninstallCopilotHooks(cwd)` before returning; include in success message
- [ ] Add `--target <claude|copilot|both>` parsing to `artisyn-hooks-installer/src/index.ts`; reject unknown values; update `printUsageAndExit` help text
- [ ] Bump patch version in `artisyn-hooks-installer/package.json`

### Chunk 5 — Server: Copilot extractor + logs.service

- [ ] Create `server/src/logs/copilot-extractor.ts`: export `CopilotFields` interface and `extractCopilotFields(lines: object[]): CopilotFields`; declare `const COPILOT_COST_CENTS_TO_USD = 0.01`; implement all field extractions per DD-11 field mapping table; `costUsd` null only when `session.shutdown` entirely absent; absent per-model `requests.cost` key counts as 0
- [ ] In `logs.service.ts` Step 2 (`~line 97`): add `const copilotFields = logType === 'copilot' ? extractCopilotFields(lines) : null;`; derive `firstPrompt`, `startTime`, `endTime`, `gitBranch` from `copilotFields` when Copilot; add `provider: logType === 'copilot' ? 'copilot' : 'claude'` and `costUsd: copilotFields?.costUsd ?? null` to the `.values({...})` insert call
- [ ] In `logs.service.ts` `onConflictDoUpdate` set: use `sql\`excluded.first_prompt\`` for copilot (unconditional) vs `sql\`COALESCE(excluded.first_prompt, ${logs.firstPrompt})\`` for others per DD-5; add `costUsd: sql\`excluded.cost_usd\`` and `provider: sql\`excluded.provider\`` to the conflict set (both unconditional)
- [ ] In `logs.service.ts` Step 3 (`~line 133`): add `if (logType === 'copilot' && copilotFields)` block calling `upsertSessionStatsRow(tx, sessionRowId, { inputTokens: copilotFields.inputTokens, outputTokens: copilotFields.outputTokens, model: copilotFields.model, /* all other stats: 0 */ })`
- [ ] In `logs.service.ts` Step 4 (`~line 147`): change guard from `logType !== 'artisyn'` to `logType !== 'artisyn' && logType !== 'copilot'`
- [ ] In `logs.service.ts` Step 5 (`~line 149`): add Copilot branch after the artisyn repo-link block: when `logType === 'copilot'` and `copilotFields.gitRemoteUrl`, call `normalizeRepoUrl()`, look up `repositories` row by `(userId, repoUrl)`, if found insert `log_repositories` row via `onConflictDoNothing` (same pattern as artisyn)

### Chunk 6 — Server: repositories.controller widening

- [ ] Replace main query `where()` condition in `getRepositorySessions()` (`~line 246`): use Drizzle `or()` per DD-6 — `(log_type='artisyn' AND firstPrompt IS NOT NULL AND EXISTS(claude))` OR `(log_type='copilot' AND firstPrompt IS NOT NULL)`; keep `repoCondition`, `sessions.deleted`, `branchCondition`, `ownerCondition` as outer `and()` conditions
- [ ] Add `provider: schema.logs.provider` to `selectDistinct` at `~line 223`; return type is inferred from the `.map()` at `~line 415` — no separate DTO file; just ensure `provider` is included in that mapping
- [ ] Add Copilot cost fetch after existing `costMap` block: filter `filtered` by `r.provider === 'copilot'`; query `SELECT session_id, cost_usd FROM logs WHERE log_type='copilot' AND session_id=ANY(copilotIds)`; populate `costMap` for those IDs per DD-4; pass only artisyn IDs to the existing CTE
- [ ] Update `ownerMap` raw SQL query (`~line 386`): change `AND log_type = 'artisyn'` to `AND log_type IN ('artisyn', 'copilot')`
- [ ] Include `provider: r.provider ?? 'claude'` in the return mapping object (`~line 415`)
- [ ] Apply the same `or()` widening to `getRepositorySessionIds()` (`~line 479`) per DD-6 to prevent badge-poll breakage

### Chunk 7 — Client: types + UI

- [ ] Add `provider?: 'claude' | 'copilot'` to `RepositorySession` interface in `client/src/models/repositories.ts:20`
- [ ] Confirm no transform layer exists between API response and `RepositorySession`: `client/src/viewer/api.ts:266` uses bare `res.json() as Promise<RepositorySession[]>` — `provider` passes through automatically; no mapping code to change
- [ ] In `SessionItem` (`session-list-helpers.tsx:123`): render a Copilot provider badge when `session.provider === 'copilot'` — add `<span>` with blue pill classes and text `copilot` alongside the existing `isHookService` and `hasWorkflow` badges per DD-7
- [ ] Update `docs/knowledgebase/client-component-map.md`: note `SessionItem` now renders a `provider` badge; update `docs/knowledgebase/api-reference.md` to show `provider` field in session list response; update `docs/knowledgebase/server-endpoint-map.md` to note `GET /api/v1/repositories/:repoId/sessions` now returns `provider` and that no `repoUrl` query param was added (meta-line approach used instead)

### Chunk 8 — Tests

- [ ] Create `server/src/logs/copilot-extractor.spec.ts`: unit tests for `extractCopilotFields` covering `session.start` extraction, `session.shutdown` multi-model cost sum (`requests.cost × 0.01`), absent `session.shutdown` → null costUsd/endTime, `__copilot_meta` gitRemoteUrl, first `user.message` firstPrompt, null firstPrompt when no `user.message`
- [ ] Create `hook/.claude/telemetry_tool/__tests__/copilot-send-logs-hook.test.js`: test main flow (reads file, prepends meta line, calls upload); missing `transcript_path` → exits 0; missing config → exits 0 silently; POST error → exits 0 with hook-log entry
- [ ] Create `artisyn-hooks-installer/src/__tests__/copilot-install.test.ts`: tests for `detectTargets` (all four dir combinations), `installCopilotHooks` (correct JSON content written to `.github/hooks/copilot-upload.json`), `--target` CLI flag parsing, `uninstallCopilotHooks` removes file
- [ ] Add Copilot path to `server/src/logs/logs.service` integration tests (spec file found via grep for `logs.service.spec.ts`): POST NDJSON with `type=copilot`; assert `logs` row has `provider='copilot'`, `cost_usd` from `session.shutdown`; assert `session_stats` row created with token counts; re-upload overwrites all fields unconditionally
- [ ] Add `getRepositorySessions` integration test for Copilot (repositories controller spec): create a Copilot `logs` row linked to a repo; assert it appears in response with `provider: 'copilot'` and `totalCost` matching `cost_usd`; assert existing artisyn session unaffected
- [ ] Create `tests/e2e/copilot-session.spec.ts` (`@core`): seed a repo + API key; POST events.jsonl body to `/api/v2/logs?type=copilot&sessionId=<uuid>`; assert session appears in `/api/v1/repositories/:id/sessions` with `provider: 'copilot'` and numeric `totalCost`
