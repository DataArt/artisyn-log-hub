# Scenario 05: "API <-> real DB" contract tests (Group 1)

Date: 2026-10-13, branch `dev`. This is a design document; nothing was implemented or run. Sources: the code of `server/src/**/*controller.ts`, `server/src/database/schema/index.ts`, `server/test/setup/global-setup.ts`, `server/test/helpers/*`, `docs/knowledgebase/server-endpoint-map.md`. Everything I inferred rather than read directly in the code is marked **(inference)**.

## 0. The gist in three lines

- EVERY HTTP endpoint (127 of them) has a row in the registry (a data file): "who calls -> on which golden fixture -> which independent SQL to run -> how a response field maps to a column".
- The test calls the endpoint and, with a separate `pg` client (raw SQL, not drizzle, not application code), reads the same data from the same DB schema, then compares. For writes: a snapshot of the affected tables before/after, and the delta is compared with the expected one.
- A meta-test fails if a route exists in the NestJS router but not in the registry (and the other way round). A new endpoint cannot be added without a contract row.

---

## 1. Endpoint inventory

In total there are **127** HTTP routes in 24 controllers (`grep @Get|@Post|@Put|@Patch|@Delete` over `server/src`, checked against `server-endpoint-map.md`; the sets match). Routes outside controllers (ServeStatic for the SPA, `express.static` for `public`) are not counted, see section 6.

Count per controller: repositories 23, admin-panel 19, teams 18, auth 13, reports 11, export-import 10, usage-analytics 5, api-keys 4, user-settings 4, admin 2, health 2, invitations 2, sessions 2, logs 2, and one each: ai-tool-versions, azure-callback, ping, installer, logs-v2, model-pricing, post-turn-analysis, session-attribution, turn-end-cost-advisor, session-retention. (The three release-download routes, the public signed download and the two admin ones, were removed by 2026-10-20-github-release-pipeline.)

Auth legend:
- **S** = `SessionAuthGuard` (cookie session, any logged-in user);
- **A** = `SessionAuthGuard + AdminGuard` (role `admin`);
- **K** = `ApiKeyAuthGuard` (header `X-API-Key`, key from `api_keys`, argon2 check by `slug`);
- **P** = public;
- **TA** = `TeamAccessGuard` (404 if the team does not exist; a row in `team_members` is needed — no admin bypass; otherwise 403);
- **TO** = `TeamOwnerGuard` (owner, WITHOUT an admin bypass); **TOA** = the former `TeamOwnerOrAdminGuard`, deleted by 2026-10-21-private-repo-visibility — its routes are TO now;
- **AM(...)** = `AuthModeGuard`: in an inactive mode the route returns 404.
- "scope" (for repositories) = `assertRepoAccess`: the repository owner, or a log author, or a team member with `?teamId=` subject to the team's `access_mode` **(inference from reading `repositories.service.ts`; the details of the access rules are in the access-management test)**.

DB tables are given as R (reads), W (writes). The "SQL check" column describes how we prove the response independently.

### F01. Non-DB and infrastructure (11 endpoints, contract "nothing changes in the DB")

Controllers: `HealthController`, `PingController`, `AuthController.config`, `InstallerController`, `LogsController.logEcho`, `AdminPanelController` (system, error-logs, logs-archive, auth), `SessionsController.retention-days`.

| Method+path | Auth | DB | Response fields -> source | SQL check / notes |
|---|---|---|---|---|
| GET /health | P | R: `SELECT 1` | `info.database.status = 'up'` | the only endpoint where "does it hit the DB" is checked through the SQL log (section 2.8): we expect exactly one `SELECT 1`. The rest: status 200 |
| GET /health/version | P | none | `BuildInfo` from the build file | DB untouched; compared with `readBuildInfo()` outside the DB |
| GET /api/v1/ping | S | R: `users`, `auth_sessions` (session deserialization) | 204 | 401 without a cookie; no effect on the DB |
| GET /api/v1/auth/config | P | none | `mode`, `adminContactEmail` from env | `mode='password-confirm'` in the harness; no secrets |
| GET /static/artisyn-hooks-installer.tgz | P | none (writes `latest-hook-version.json` to disk on `?v=`) | tgz bytes | non-DB; we only check that nothing is written to the DB |
| POST /api/v1/log-echo | K | R: `api_keys` (authentication) | echo of the body | does not write to the DB; checked with a "nothing changed" snapshot |
| GET /api/v1/admin/system | A | R: DB ping, `pool` counters | `db.connected`, workers, CPU | DB part: `connected=true`. The rest is non-deterministic and not compared |
| GET /api/v1/admin/error-logs | A | none (reads `logs/app-*.log`) | log lines | non-DB |
| GET /api/v1/admin/logs-archive | A | none (zip of the `logs/` directory) | zip | non-DB, large |
| GET /api/v1/admin/auth | A | none (env) | `mode`, `smtp`, `azure` | non-DB |
| GET /api/v1/sessions/retention-days | S | none (env `SESSION_RETENTION_DAYS`) | `retentionDays` | non-DB |

The family contract: a 2xx response and **a full schema snapshot before == after** (checksum `count(*)` + `md5(string_agg(row))` over all tables). It is cheap and catches accidental writes.

### F02. Account and session, Mode 3 `password-confirm` (10 endpoints)

Controller: `AuthController`.

| Method+path | Auth | DB | Fields -> columns | SQL check / notes |
|---|---|---|---|---|
| POST /api/v1/auth/signup | AM(password, password-confirm) | W: `users` (INSERT), `email_confirmation_tokens` (INSERT, mode 3) | `id`, `email`, `role`, `email_confirmed_at` -> `users.*` | after the call: `SELECT ... FROM users WHERE email=$1` matches the response; `role='user'` (the harness has a baseline user); the password in the DB is an argon2 hash (`password_hash LIKE '$argon2id$%'`); the response has no password/hash |
| POST /api/v1/auth/confirm-email | AM(password-confirm) | R/W: `email_confirmation_tokens` (DELETE/consume), W: `users.email_confirmed_at` | profile | before: `email_confirmed_at IS NULL`, after: NOT NULL and the token is deleted |
| POST /api/v1/auth/resend-confirmation | AM(password-confirm) | R/W: `email_confirmation_tokens` | `email_delivery` | a new token is inserted; 429 during the 60 s cooldown, a repeated call does not change the DB |
| POST /api/v1/auth/login | AM + LocalAuth | R: `users`; W: `auth_sessions` (connect-pg-simple) | profile | after: exactly +1 row in `auth_sessions`, `sess` contains `passport.user = users.id` |
| POST /api/v1/auth/logout | S | W: `auth_sessions` (DELETE) | 204 | after: the session row is deleted |
| GET /api/v1/auth/me | AutoIdentify + S | R: `users` | `id,email,role,...` | matches a `SELECT` by `users.id` (without `password_hash`) |
| POST /api/v1/auth/forgot-password | AM | W: `password_reset_tokens` | `email_delivery` | a token is inserted; for an unknown email the response is the same and the DB does not change (enumeration-safe) |
| POST /api/v1/auth/reset-password | AM | R/W: `password_reset_tokens`, W: `users.password_hash` | 200 | the hash changed, the token is consumed |
| POST /api/v1/auth/change-password | AM + S | W: `users.password_hash` | profile + `email_delivery` | `password_hash` before != after; the new one is checked with `argon2.verify` outside the application code (the test may use `argon2` directly) |
| POST /api/v1/auth/delete-account | S | W: cascade over `users` and everything it owns (`api_keys`, `logs`, `repositories`, `teams` and so on) | 204 | after: `SELECT count(*)` over all dependent tables for this `user_id` = 0 |

No separate registry rows per role are needed; the differences come from the input data. The fixture password is fixed; in `login` the backoff is disabled under `NODE_ENV=test`.

### F03. Mode-dependent auth (3 endpoints, they return 404 in the harness)

| Method+path | Auth | What goes in the registry |
|---|---|---|
| POST /api/v1/auth/identify | AM(none) | in Mode 3 we expect 404 and an unchanged DB snapshot. The positive case (creating/finding a user by email, localhost only) needs a second run with `AUTH_MODE=none`, see open question 3 |
| GET /api/v1/auth/azure | AM(azure-oauth) | 404 in Mode 3. The positive case is a 302 to Microsoft: an external service, it writes nothing to the DB (it writes `req.session`) |
| GET /api/auth/callback | AM(azure-oauth) | 404 in Mode 3. The positive case needs a real Azure, **excluded from Group 1**, recorded as "no contract check by definition" |

### F04. API keys (4)

Controller: `ApiKeysController`. Table `api_keys`.

| Method+path | Auth | DB | Fields -> columns | SQL check |
|---|---|---|---|---|
| GET /api/v1/api-keys | S | R `api_keys` WHERE `user_id = me` | `id,name,slug,createdAt,expiresAt` | the array == `SELECT id,name,slug,created_at,expires_at FROM api_keys WHERE user_id=$1 ORDER BY ...`; other users' keys are NOT visible; the response has no `key_hash` |
| POST /api/v1/api-keys | S | W `api_keys` INSERT | `id,name,key,slug` | +1 row; `slug = left(key,6)`; `key_hash` is argon2 of `key` (checked with `argon2.verify`); the plain key is not stored anywhere in the DB (`SELECT count(*) FROM api_keys WHERE key_hash = <key>` = 0) |
| PATCH /api/v1/api-keys/:id | S (owner) | W `api_keys` UPDATE | the updated field | only the given column changed; someone else's key gives 404/403, the DB is unchanged |
| DELETE /api/v1/api-keys/:id | S (owner) | W DELETE | 204 | the row is gone, other rows are in place |

### F05. User settings (4)

Controller: `UserSettingsController`. Table `user_settings` (PK `user_id, setting_name`).

| Method+path | DB | SQL check |
|---|---|---|
| GET /api/v1/user-settings | R | the `name -> value` dictionary == `SELECT setting_name, setting_value WHERE user_id=$me`; other users' settings are not visible |
| GET /api/v1/user-settings/:name | R | the value == the `setting_value` column; missing -> 404 |
| PUT /api/v1/user-settings/:name | W UPSERT | the row (me, name) has exactly the given value, the user's row count is +1 or the same; other rows are untouched |
| DELETE /api/v1/user-settings/:name | W | the row is deleted, the others are in place |

### F06. Admin panel: users (6)

Controllers: `AdminController` (`api/v1/users`), `AdminPanelController` (`api/v1/admin/users`). Auth: A. Table `users` (+ `team_members`, `logs` for the aggregates).

| Method+path | DB | Fields -> columns / SQL |
|---|---|---|
| GET /api/v1/admin/users | R `users` LEFT JOIN `team_members`, `logs` | `id,email,role,createdAt` from `users`; **`teamCount` = `COUNT(DISTINCT team_members.team_id)`**; **`lastActivity` = `MAX(logs.end_time)`** per user. The expected values are computed with separate subqueries (`SELECT count(*) FROM team_members WHERE user_id=u.id`), not by repeating the same JOIN. Order `ORDER BY email` |
| PATCH /api/v1/admin/users/:id/role | W `users.role` | the role changed; you cannot change your own (400) or remove the last admin (400), the DB does not change |
| PATCH /api/v1/users/:userId/role | W `users.role` | the same for the second controller (a duplicate route, **inference**: check whether it is needed; a separate row in the registry) |
| PATCH /api/v1/admin/users/:id/email | W `users.email` (lowercase) | `SELECT email` == `lower(body.email)`; 409 on a duplicate, with no write |
| POST /api/v1/admin/users/:id/delete | W cascade over `users` | like `delete-account` (see F02), plus 400 on a wrong `confirmEmail` with no write |
| POST /api/v1/users/:userId/reset-password-link | W `password_reset_tokens` | +1 token for the user; the link in the response contains exactly this token (checked against `SELECT token`) |

Roles: one row for `admin` (success) and one for `user` (403, unchanged DB snapshot) per endpoint of the family, 12 rows; most of them are generated by the matrix (section 2.6).

### F07. Admin panel: incomplete registration (3)

Auth: A. Tables `users` (where `email_confirmed_at IS NULL`), `email_confirmation_tokens`.

| Method+path | DB | SQL check |
|---|---|---|
| GET /api/v1/admin/auth/pending-registrations | R | `{id,email,registeredAt,tokenExpiresAt}[]` == `users` LEFT JOIN tokens WHERE `email_confirmed_at IS NULL ORDER BY created_at`; confirmed users are not included |
| POST /api/v1/admin/auth/pending-registrations/:id/resend | W token | a new token; 404/409 for a non-existent/confirmed user with no write |
| DELETE /api/v1/admin/auth/pending-registrations/:id | W `users` + token cascade | 204; the row and the token are deleted; a confirmed user is not deleted (409) |

### F08. Admin panel: repositories and teams (3)

| Method+path | DB | Fields -> columns / SQL |
|---|---|---|
| GET /api/v1/admin/repos | R `repositories`, `users`, `logs`, `log_repositories`, `sessions` | `id,repoUrl,ownerEmail`; **`rawUploadCount` = `COUNT(DISTINCT logs.session_id)`**; **`sessionCount`** = the number of sessions that have an artisyn log with `first_prompt IS NOT NULL`, `sessions.deleted=false` and a claude log; **`logSize` = `SUM(pg_column_size(logs.body))`** (the test compares with the same `pg_column_size`, but in raw SQL); `maxUploadBytes`, `lastSession = max(end_time)`, `firstSeen = min(start_time)` |
| GET /api/v1/admin/teams | R `teams`, `users`, `team_members`, `team_repositories` | `memberCount = COUNT(DISTINCT team_members.user_id)`, `repoCount = COUNT(DISTINCT team_repositories.id)`; computed with separate `count(*)` subqueries to catch the Cartesian product of two LEFT JOINs |
| DELETE /api/v1/admin/repos/:id | W `repositories` + cascade over `log_repositories`; (inference) possibly a cleanup of orphaned logs | before/after snapshot: the repository row and its links are gone; others are untouched |

An important design point: both aggregates (`getUsers`, `getTeams`) build several LEFT JOINs in one query, where the failure mode is inflated counters from multiplied rows. The fixture must contain a user with 2 teams and 3 logs so that the 2x3 product shows up.

### F09. Admin panel: upload queue (5)

Auth: A. Tables `upload_queue`, `upload_queue_measurements`, files of the staging directory.

| Method+path | DB | SQL check |
|---|---|---|
| GET /api/v1/admin/upload-queue | R `upload_queue` | the list `id,fileName,sizeBytes,receivedAt,status,...` == `SELECT ... ORDER BY session_id, received_at` |
| GET /api/v1/admin/upload-queue/stats | R a CTE over `upload_queue_measurements` | 15-minute windows: throughput/utilization/latency. The fixture inserts measurements with fixed `now()-interval`; the expected values are computed with our own SQL (`count`, `avg`, `percentile`) |
| DELETE /api/v1/admin/upload-queue/failed | W DELETE `status='failed'` | only `pending/processing` remain; the number deleted == `count` before |
| POST /api/v1/admin/upload-queue/reprocess-failed | W UPDATE `failed -> pending`, `error_message=NULL` | delta: exactly the failed rows changed status |
| GET /api/v1/admin/upload-queue/:id/file | R `upload_queue` + a file on disk | 200 and the bytes == the content of the staged file; 404 if there is no row or file. It reads a FILE, not only the DB. Debugging data, outside the privacy boundary of the access model |

The background worker (`UploadQueueSchedulerService`, interval 50 ms in the harness) competes with the fixture: `pending` rows will be consumed. The fixture inserts only `failed`/`partially_uploaded`, or the test pauses the worker first (open question 6).

### F10. Teams: core (9)

Controller: `TeamsController`. Tables `teams`, `team_members`, `users`, `invitations`.

| Method+path | Auth | DB | SQL check |
|---|---|---|---|
| POST /api/v1/teams | S | W `teams`, `team_members` (the creator as a member) | `+1` row in `teams` with `owner_id=me`, `+1` in `team_members` for the owner; response == the row |
| GET /api/v1/teams | S | R `teams`, `team_members` | the list == the teams where I am the owner/a member; `ORDER`, role flags from `team_members` |
| GET /api/v1/teams/pending-disclosures | S | R `team_members.disclosure_acknowledged_at IS NULL` | matches the SQL |
| GET /api/v1/teams/:teamId | TA | R `teams` (+ owner) | fields == the row |
| PATCH /api/v1/teams/:teamId | TO | W `teams.name`/`access_mode` | only the given columns changed; 400 on an empty body |
| DELETE /api/v1/teams/:teamId | TO | W cascade over `teams`, `team_members`, `team_repositories`, `invitations` | all of the team's rows are deleted |
| POST /api/v1/teams/:teamId/acknowledge-disclosure | TA | W `team_members.disclosure_acknowledged_at` | NULL -> now; 400 on a mismatched `acknowledgedAccessMode` with no write |
| POST /api/v1/teams/:teamId/leave | S | W DELETE `team_members` | the row is gone; the owner cannot (400) |
| POST /api/v1/teams/:teamId/transfer | TO | W `teams.owner_id`, `team_members` | `owner_id` is the new one, the old owner stays a member |

Roles (access differences): `owner`, `member`, `outsider`, `admin`. For TA endpoints the rows are: member -> 200, outsider -> 403, admin -> 200. For TO: owner -> 200, member -> 403, admin -> 403 (**inference**: per the KB admin has no bypass on TO; check against the `TeamOwnerGuard` code in the test).

### F11. Teams: members (3)

| Method+path | Auth | DB | SQL check |
|---|---|---|---|
| GET /api/v1/teams/:teamId/members | TA | R `team_members` JOIN `users` | `isManager,isAdlcTrainer,canInvite,disclosureAcknowledgedAt`; **`disclosureAcknowledgedAt` is visible only to the owner and admin, everyone else gets `null` everywhere**: two registry rows for the same request with different actors |
| PATCH /api/v1/teams/:teamId/members/:userId | TO | W `team_members` flags | only the given flags changed |
| DELETE /api/v1/teams/:teamId/members/:userId | TOA | W DELETE | the row is deleted |

### F12. Teams: repositories (4)

| Method+path | Auth | DB | SQL check |
|---|---|---|---|
| GET /api/v1/teams/:teamId/repositories | TA | R `team_repositories` | the list `repoUrl`, `addedAt` == SQL |
| POST /api/v1/teams/:teamId/repositories | TO | W `team_repositories` (+ possibly `repositories` for the owner, **inference**) | +1 row, `repo_url` normalized |
| DELETE /api/v1/teams/:teamId/repositories/:repoId/link | TOA | W DELETE `team_repositories` | only the link is deleted, `repositories` stays |
| DELETE /api/v1/teams/:teamId/repositories/:repoId | TOA | W DELETE of the link and the data (**inference**: wider than `/link`) | before/after snapshot over `repositories`, `log_repositories`, `team_repositories` |

### F13. Invitations (4)

Controllers: `TeamsController` (create/cancel), `InvitationsController`. Tables `invitations`, `team_members`, `users`.

| Method+path | Auth | DB | SQL check |
|---|---|---|---|
| POST /api/v1/teams/:teamId/invitations | TA (+ `can_invite`) | W `invitations` (`status='pending'`), with `force` W `team_members` | +1 row; 404 `user_not_registered` without `force` and with no write |
| DELETE /api/v1/teams/:teamId/invitations/:invId | TA | W DELETE/UPDATE | the row is gone or `status` changed (check against the code, **inference**) |
| GET /api/v1/invitations | S | R `invitations` in both directions | received + sent by me == SQL with `OR` |
| PATCH /api/v1/invitations/:invId | S (invitee) | W `invitations.status`, `team_members` on accept | accept: status and +1 member; decline: status, no member; `acknowledgedAccessMode` is required on accept |

### F14. Repositories: list, card, settings, hooks (9)

Controllers: `RepositoriesController`. Tables `repositories`, `log_repositories`, `logs`, `repo_config` (personal configs), `team_repo_config` (the single team config of a link), `team_*`, `contexts`.

| Method+path | Auth | DB | Fields -> columns / SQL |
|---|---|---|---|
| GET /api/v1/repositories | S | R `repositories` LEFT JOIN `log_repositories`,`logs` | `[{id,repoUrl}]` DISTINCT, `WHERE repositories.user_id=me OR logs.user_id=me ORDER BY repo_url`. A row for a repository without logs (owner) is required in the fixture |
| GET /api/v1/repositories/hooks | S | R `repositories` (hook_* columns) | `HookRepositorySummary[]`: `hookVersion`, `hookLastActivity` from `repositories.hook_*` |
| GET /api/v1/repositories/:repoId | scope | R `repositories`, `repo_config`, `team_repo_config` | `repoUrl`, `repoConfig` = **the effective config** (personal view: user layer → team layer → default; with `?teamId`: only team layer → default): the test computes the expected value by the documented priority rule **(inference: the rule is in `resolveEffectiveConfig`; record it in the registry as golden JSON)** |
| GET /api/v1/repositories/:repoId/hook-state | scope | R `repositories` | `hookLogTail`, `hookNonUploadableLogs`, `hookRecommendations` (jsonb) == the columns |
| GET /api/v1/repositories/:repoId/settings | scope (with `?teamId`, team membership) | R `repo_config`, `team_repo_config` | `teamConfig` == `team_repo_config.config` of the link, `userConfig` == the caller's personal `repo_config` by (URL, user); `?teamId`: a member team gives 200 (`F14-settings-team`), a foreign one 403, `teamId=0` 400 |
| PUT /api/v1/repositories/:repoId/settings/team | scope + team owner | W `team_repo_config` UPSERT by link | the jsonb in the DB == body; `config:null` deletes the row; with `?teamId=T1` it writes exactly the T1 link (`F14-put-team-settings-team`), a non-owner of T1 → 403 |
| PUT /api/v1/repositories/:repoId/settings/user | scope | W `repo_config` UPSERT | the same; does not touch `team_repo_config` |
| GET /api/v1/repositories/:repoId/summary | scope | R `sessions`,`logs`,`log_repositories` | `sessionCount = COUNT(DISTINCT sessions.session_id)`, `userCount = COUNT(DISTINCT logs.user_id)` with `log_type='artisyn'`. Note: it does not filter `deleted` (**inference from the code above**, so the fixture must have a deleted session that pins the current behaviour) |
| GET /api/v1/repositories/:repoId/contexts | scope | R `contexts`,`log_contexts` | the list of `contextKey/contextValue` pairs == SQL DISTINCT |

Roles: owner (200), author-only (200), outsider (404/403 per the `assertRepoAccess` code), admin (**inference**: per the scope rules, to check). Plus `?teamId=` with `access_mode` `transparent`/`restricted` (two rows).

### F15. Log ingest: writes (2)

Controllers: `LogsController.postLogs` (v1, synchronous), `LogsV2Controller.postLogs` (v2, asynchronous through `upload_queue`). Auth: K.

| Method+path | DB | SQL check |
|---|---|---|
| POST /api/v1/logs | W `sessions`, `logs`, `logs_otel`, `repositories`, `log_repositories`, `contexts`, `log_contexts`, `session_stats`, `session_tool_stats`, `session_file_stats`, `session_harness_usage`, `harness_elements`, `session_cause_stats`, `repo_config`... | **input: a fixed NDJSON golden** (small: 1 artisyn + 1 claude log with 2 assistant lines). Expected: `sessions` +1 with the right `session_id`/`parent_session_id`, the `logs.body` jsonb equals the input line by line (`body = '[...]'::jsonb`), `first_prompt/start_time/end_time/git_branch` extracted from the input, `session_stats.input_tokens = sum(usage.input_tokens)` over `DISTINCT message.id`. The expectation is recorded as **a golden number in the registry**, not computed by application code |
| POST /api/v2/logs | W `upload_queue` (pending), then the worker -> the same write as v1 | first `upload_queue` +1 `pending` and a staged file (size check); then we wait for the drain (helper `waitForQueueDrained`) and compare the resulting rows with the v1 golden (an identical result from v1 and v2 is a strong check). Chunks (`uploadId/chunkIndex`) are a separate row. `warnings[]` == the key's `failed` rows |

### F16. Post-turn analysis (3)

Auth: K. Tables `sessions`, `turn_end_advisor_runs`, `session_attribution`, `session_attribution_runs`, `session_prompt_watermark`, `repo_config`.

| Method+path | DB | SQL check |
|---|---|---|
| GET /api/v2/post-turn-analysis/config | R | the `advisor`/`attribution` gates == computed from `repo_config` / `team_repo_config` (the team with the lowest id) + watermark. The registry holds golden JSON for several fixtures (no repo; no session; both present) |
| POST /api/v2/turn-end-cost-advisor | W `turn_end_advisor_runs` | +1 row per call (append-only), `outcome`, `summary` jsonb, `cost_*`; session not found -> `applied:false` and 0 rows; someone else's -> 404 with no write |
| POST /api/v2/session-attribution | W `session_attribution` UPSERT + `session_attribution_runs` | `applied` (+1 run, upsert), `ignored_stale` (watermark <= the stored one: `session_attribution` unchanged, the run is recorded), `failed` (a run with `failure_reason`, the main table untouched): three registry rows |

### F17. Sessions: lists and subsets (8)

Controller: `RepositoriesController`. Auth: S + scope. The family with the highest risk: a big SQL with CTEs.

| Method+path | DB | Fields -> columns / expected |
|---|---|---|
| GET /api/v1/repositories/:repoId/sessions | R `sessions`,`logs`,`log_repositories`,`users`,`session_stats`,`model_pricing`,`user_favorite_sessions`,`session_attribution`,`session_attribution_runs`,`turn_end_advisor_runs` | one row per root session: `sessionId=sessions.session_id`; `firstPrompt=logs.first_prompt` (the artisyn log); `startTime/endTime` ISO from `logs`, otherwise `updated_at`; `gitBranch`, `userEmail`; **`totalCost`/`computedCost`**: on a fixture with round numbers we expect a golden value (the formula `(in/1e6)*price_in + (out/1e6)*price_out + cache...` over the tokens, **a constant computed by hand** + an independent SQL rendering of the formula over `session_stats` and `model_pricing`; tolerance 1e-8); `isFavorite` = a row exists in `user_favorite_sessions`; `isHookService` = `body @> '[{"event":"hook_service"}]'`; `hasWorkflow`; `claudeVersion = COALESCE(claude_version, claude_version_otel)`; `costUnavailableReason='unknown-model'` when there is no `model_pricing`; sort `COALESCE(end_time, updated_at) DESC`. Excluded: `deleted=true`, no claude log, no `first_prompt`. `firstPrompt` is masked (`null`) for a manager in other people's sessions |
| GET .../sessions/ids | R | `string[]` == SQL with the same conditions, without cost (cheap) |
| GET .../sessions/branches | R | `gitBranch -> aggregates` (`count`, `totalLinesChange`, cost): computed with `GROUP BY git_branch` |
| GET .../session-attribution/values | R `session_attribution` | the list of a key's values == a `jsonb` selection |
| GET .../sessions/:sessionId/contexts | R `contexts`,`log_contexts` | pairs == SQL |
| GET .../sessions/:sessionId/logs | R `logs` (+ `session_stats`, `turn_end_advisor_runs`) | the response contains the `body` of each log == `logs.body` (jsonb equality), `subagentStats`, `turnEndAdvisor` from the last `submitted` run. It actually returns raw JSON (`@Res`), possibly gzip/large |
| GET .../sessions/export-scope | R | `sessionCount`, `totalBytes` == `count(*)`, `sum(pg_column_size(body))` |
| POST .../sessions/:sessionId/favorite | W `user_favorite_sessions` | `{isFavorite:true}` and the row (me, session) exists; a repeat with `false` deletes it |

Roles (section 2.6): the owner sees everything; a manager in a `transparent`/`restricted` team (`firstPrompt` masking); a member of another team (empty); an outsider (404/403).

### F18. Session deletion and retention (2)

| Method+path | Auth | DB | SQL check |
|---|---|---|---|
| DELETE /api/v1/sessions/:sessionId | S (owner or admin) | W: `logs`, `session_stats`, `session_file_stats`, `user_favorite_sessions`, orphaned `contexts`, `sessions.deleted=true`, `deleted_session_log` (audit) + descendants | snapshot: for each of the ~8 tables the `count` for session_pk = 0; `sessions.deleted=true` on the root and the children; an audit record with `deleted_by_user_id`; other data untouched; a non-owner gets 403 |
| GET /api/v1/admin/retention | S + AdminOrTeamOwner | R `sessions`,`logs` | `oldestSessionAt`, `youngestSessionAt`, `totalSessionCount`, `dailySeries[{day,sessionCount,totalSizeBytes}]` == `date_trunc('day', ...)` in UTC with gaps filled. A fixture with known dates. Roles: admin 200, team owner 200, a plain user 403 |

### F19. Change surface (4)

Tables: `session_changed_paths`, `session_stats.cs_*`, `repo_code_inventory`, `sessions`.

| Method+path | DB | SQL check |
|---|---|---|
| GET .../sessions/:sessionId/change-surface | R | `cs_changed_files`, `cs_folders_touched`, `cs_outside_repo_files` over the session tree == the `session_stats`/`session_changed_paths` aggregate over the tree's `sessions` (recursive by `parent_session_id`, an independent `WITH RECURSIVE`) |
| GET .../sessions/:sessionId/change-surface/files | R | rows per path == `SELECT ... FROM session_changed_paths` |
| GET .../analytics/change-surface | R | a timeline by day: `startDate`,`endDate` are required; expectation `GROUP BY date` |
| GET .../reports/change-surface | R | the report aggregate for a period |

### F20. Analytics: timeline, work-time, usage (7)

| Method+path | DB | SQL check |
|---|---|---|
| GET .../analytics/timeline | R `sessions`,`logs`,`session_stats`,`model_pricing` | sessions for the period by day, cost/tokens, filters `teamId,branches,users,attr` |
| GET .../analytics/work-time | R `session_stats.work_time_ms` | the sum and the breakdown (`groupBy`) == `SUM(work_time_ms)`/`GROUP BY` |
| GET .../analytics/tools | R `session_tool_stats` | tool counters == `SUM(count) GROUP BY tool_name` |
| GET .../analytics/tokens | R `session_stats` | token sums by model |
| GET .../analytics/productivity | R `session_stats` | sums of `files_edited_written, lines_added/removed, commit_count, pr_count, turn_count` |
| GET .../analytics/active-sessions | R | top N (`limit`) by activity |
| GET .../analytics/claude-versions | R `session_stats.claude_version*` | a `COALESCE(...)` breakdown |

### F21. Reports (10)

Controller: `ReportsController`. Some of them are "twins" of analytics (`tool-analytics`, `token-usage`, `productivity-counters`, `active-sessions`, `claude-versions`) on the same services: in the registry the twins' `sameExpectedAs` points at the analytics row, and **the expected SQL is not duplicated**.

| Method+path | DB | Notes |
|---|---|---|
| GET .../reports/executive-summary | R `session_stats`,`model_pricing`,`sessions`,`logs`,`repositories` | `totalCost`, `sessionCount`, `topSessions[]`, `excludedSessionCount/excludedModels`, comparison of two periods; computed with a separate SQL over the golden fixture |
| GET .../reports/cache-read-ratio | R `session_stats`, `model_pricing` | `cacheReadRatio = cache_read / (cache_read + input + cache_write)`; `cacheWriteCost = 5m*price5m + 1h*price1h` |
| GET .../reports/harness-usage | R `session_harness_usage`,`harness_elements` | counters per element |
| GET .../reports/attribution-breakdown | R `session_attribution` | a breakdown by attribute value |
| GET .../reports/attribution-usage | R `session_attribution` + usage | the same, `outcome` is repeatable |
| GET .../reports/tool-analytics, token-usage, productivity-counters, active-sessions, claude-versions | as F20 | twins, 5 of them |

### F22. Pricing and tool versions (2)

| Method+path | Auth | DB | SQL check |
|---|---|---|---|
| GET /api/v1/model-pricing | P | R `model_pricing` | `{modelId: {priceIn,...}}`: **for each model the row with the greatest `effective_from <= CURRENT_DATE` is taken** (DISTINCT ON); numbers `numeric -> float`; in the fixture: a future price (must not be picked), two versions (the newer one is taken), a model with `chars_per_token` NULL |
| GET /api/v1/ai-tool-versions/:toolName | S | R `ai_tool_version`, `ai_tool_version_history` | `fetchedAt` (ISO or null), `history[]`; an unknown tool gives 404 |

### F23. Export/import and recompute (11)

Controller: `RepositoryExportImportController`, plus `recompute-all-sessions`. Asynchronous jobs (202 + polling), files on disk. Table `export_import_jobs`, plus all the session content.

| Method+path | DB | Notes |
|---|---|---|
| GET /repositories/:repoId/export-import/scope | R | numbers == `count`/`sum` |
| POST /repositories/:repoId/export (202) | W `export_import_jobs` | the job row, status; then /status |
| GET /repositories/:repoId/export/:jobId/status | R `export_import_jobs` | `status/progress` == the row |
| GET /repositories/:repoId/export/:jobId/download | file | zip: the content is checked against the DB (the number of sessions and logs in the zip == in the DB) |
| POST /repositories/:repoId/import/upload | file + job | zip validation |
| POST /repositories/:repoId/import/:uploadToken/confirm (202) | W `sessions`,`logs`,... | after the drain: the number of sessions/logs in the DB == in the zip; idempotency (a repeated import does not duplicate) |
| GET /repositories/:repoId/import/:jobId/status | R job | |
| POST /repositories/bootstrap-import/upload, /:uploadToken/confirm, GET /:jobId/status | as above without `:repoId` (creates a repository/team) | |
| POST /repositories/:repoId/recompute-all-sessions | W `session_stats` and derived data | after the call: `session_stats` == the result of recomputing from `logs.body`; the metrics return to golden after the fixture deliberately corrupts columns (a good test of "the server really reads the logs") |

**Total**: 11 + 10 + 3 + 4 + 4 + 6 + 3 + 3 + 5 + 9 + 3 + 4 + 4 + 9 + 2 + 3 + 8 + 2 + 4 + 7 + 10 + 2 + 11 = 127. **23 families.**

---

## 2. Harness design

### 2.1. What already exists and is reused

- `server/test/setup/global-setup.ts`: boots the real `AppModule` (`Test.createTestingModule`), once per run, on an isolated schema `test_e2e_<uuid>`; `initializeDatabase()` applies the drizzle migrations to this schema; `E2E_DB_SCHEMA` sets the `search_path` both for the application (`DatabaseModule` through `resolveSearchPathOption()`) and for the test pool. Background jobs are sped up with env variables (queue 50 ms, retention 50 ms), `AI_TOOL_VERSION_CHECK_ENABLED=false`, `AUTH_MODE=password-confirm`. We keep all of this.
- `test/helpers/db-client.helper.ts`: `getTestDb()` gives a drizzle pool on the same schema. For the contract layer **do not use drizzle as the oracle**; a raw `pg.Pool` is needed (see 2.2).
- `auth.helper.ts` (`TestAuthSession`): registration, confirmation with a token from the DB, login, API key. It does not fit the contract layer as the main way in (the test would create users on the fly through the same API it checks), see 2.3.
- `db-cleanup.helper.ts`, `wait-for-queue-drain.helper.ts` (`waitForQueueDrained`), `create-app.helper.ts`, `e2e-app.helper.ts` (`getBaseUrl()`).

### 2.2. An independent SQL oracle

- A new helper `test/contract/oracle.ts`: `const oracle = new pg.Pool({connectionString: process.env.DATABASE_URL, options: '-c search_path=<E2E_DB_SCHEMA>'})` and a function `q(sql, args)` returning `rows`. The principle: **no drizzle and no imports from `src/**`** in the registry and oracle files (except types). This way the ORM schema mapping and the business logic cannot "make the same mistake" as the test.
- The SQL is written by hand in the registry, **differently from the application code**: simple `count(*)` subqueries, a separate `SELECT` per metric instead of repeating the same JOINs. Complex formulas (cost) use a pair: (1) a golden constant computed by hand on round numbers, (2) an SQL formula over tokens/prices. The test fails if any two of the three (response, golden, SQL) differ.
- The oracle reads the same schema, not a copy: the application commits each operation at once (a pool without long transactions), so visibility after the response is guaranteed. The exception is asynchronous writes (the v2 queue, export/import); for them `waitFor(cond)` on an SQL condition, not `sleep`.

### 2.3. Deterministic "golden" data

Package `test/contract/fixtures/`:
- `world-v1.sql.ts` (or `.sql`): **one "world" is inserted with raw SQL** (not through the API) with explicit `id`s and fixed dates (`'2026-01-10T10:00:00Z'`), followed by `setval` on the sequences. Contents (minimal, but covering every family):
  - users: `admin`, `owner`, `member`, `outsider`, `author-only`, `pending` (not confirmed); passwords = one precomputed argon2 hash (a constant, the password is known); `owner` and `member` get `api_keys` with a known key (`slug = the first 6 characters`, `key_hash` = an argon2 constant);
  - teams: `T1` (transparent, owner + member with flags) and `T2` (restricted, manager);
  - repositories: `R1` (owned by owner, team T1, 4 root sessions: a regular one, a child, a favorite, a deleted one; artisyn+claude logs with real jsonb bodies, 2-3 assistant lines with `usage`), `R2` (no logs), `R3` (someone else's);
  - `session_stats`, `session_tool_stats`, `session_changed_paths`, `session_harness_usage`, `session_attribution(+runs)`, `turn_end_advisor_runs`, `repo_config` (owner's personal layer), `team_repo_config` (T1's config on link 1), `model_pricing` (round prices `1/2/0.5/...` USD per 1M, three models, one without a price, one with a future `effective_from`), `upload_queue` (only failed/partially_uploaded), `ai_tool_version(+history)`, `invitations`, `team_repositories`.
  - The numbers are chosen so that the aggregates are "readable": for example, a total `input_tokens = 1_000_000` gives a cost of exactly `price_in`.
- Test login: cookies are obtained with a **real** `POST /auth/login` once per actor (cached in `beforeAll`), not injected into `auth_sessions`: this is also a check of F02.
- Isolation: the file with the read-only families loads the world once (`beforeAll`). The write families run `TRUNCATE ... RESTART IDENTITY CASCADE` over the world's tables before each row plus a re-insert (~100 rows, milliseconds) in a transaction, or they load the world into a separate schema per file (**inference**: a separate schema per file avoids conflicts with parallel jest workers, but a repeated `initializeDatabase()` per schema costs ~seconds; use one worker, `--runInBand`, as `npm run test` does now).
- For F15/F23 the input (NDJSON, zip) lies as files in `fixtures/inputs/` (small, readable, in git).

### 2.4. Comparison

How a field mapping is described in the registry (`FieldMap`), with uniform rules:

| Type | Rule |
|---|---|
| id, int | equality; `bigint`/`count` arrive from pg as a string, converted with `Number()` (the fixture values are < 2^53) |
| `numeric` (prices, `total_cost`) | the response has a `number` (`parseFloat`): compared as `Math.abs(a-b) <= tol`, `tol` defaults to 1e-8 (column `numeric(14,8)`) |
| timestamp | an ISO string with `Z` and milliseconds: `new Date(sqlValue).toISOString()` against the response; compared as a string |
| jsonb | deep equality (`toEqual`), key order ignored |
| NULL | `null` in the response == SQL `NULL`; a key missing from the response (`undefined`) equals `null` only if the mapping says so (`gitBranch: undefined` in the code!) |
| arrays | if the endpoint has an `ORDER BY` in the code, the expected SQL has the same order and the comparison is ordered; otherwise both sides are sorted by the `key` field |
| pagination | **list endpoints have none** (the only `limit` in the code is `active-sessions`); `limit=N` is checked as a separate row |
| extra fields | `strict` mode: the set of response keys must equal the mapping's set (catches a `password_hash`/`key_hash` leak); an `ignore` list for non-deterministic fields (`pingMs`, `uptime`) |

Two auxiliary checks for every read: (a) "the response is not empty" (protection against a test that compares `[]` with `[]`): the registry requires `minRows`; (b) a negative control: after the test, mutate a value in the DB and make sure the response changed (done selectively, on 3-4 endpoints: it proves there is no cache/constant).

### 2.5. Checking writes

For every write row the registry holds `watch: ['api_keys', ...]` and `expectDelta`:
1. `before = snapshot(watch)`: for each table `SELECT * ORDER BY pk` (the fixture tables are small);
2. the endpoint call;
3. `after = snapshot(watch)`;
4. compare `diff(before, after)` with `expectDelta`: `{ inserted: [{table, where, columns}], updated: [{table, pk, changed: {col: value}}], deleted: [{table, pk}] }` and **`unchanged: all the other tables of the schema`** (a snapshot of the whole schema is cheap on the golden database); this is the protection against side writes;
5. password/key hashes are checked by properties, not values (`$argon2id$`, `argon2.verify`).

Negative rows (400/403/404/409): `expectDelta: none`, that is, snapshot before == after.

### 2.6. Roles and the access matrix

A registry row has an `actor` field. Rows per role are added **only where the access or the data differ** (per the tables in section 1). In addition, a "guard test" matrix is **generated** (not written by hand): for every route with auth ≠ P, the `auth` field is taken from the registry metadata and the test checks (a) without a cookie/key -> 401, (b) with a role the guard does not let in -> 403/404, (c) the DB snapshot did not change. That is ~110 generated rows at zero maintenance cost. Roles: `admin`, `owner`, `member`, `outsider`, `apiKeyUser`, `anon`. The Mode-3 flows (`login`/`signup`) are not part of actor.

### 2.7. The registry (format, example)

`test/contract/registry/<family>.ts` exports an array, `registry.ts` assembles them.

```ts
export const apiKeysCases: ContractCase[] = [
  {
    id: 'F04-list',
    route: 'GET /api/v1/api-keys',            // key for the meta-test: METHOD + path as in the router
    actor: 'owner',
    fixture: 'world-v1',
    expect: { status: 200, minRows: 2 },
    read: {
      sql: `SELECT id, name, slug, created_at, expires_at
            FROM api_keys WHERE user_id = $1 ORDER BY id`,
      args: ['@owner.id'],
      shape: 'array',
      fields: {
        id: 'id', name: 'name', slug: 'slug',
        createdAt: { col: 'created_at', as: 'iso' },
        expiresAt: { col: 'expires_at', as: 'iso?' },
      },
      strict: true,                           // no keys beyond these (no keyHash)
    },
  },
  {
    id: 'F04-create',
    route: 'POST /api/v1/api-keys',
    actor: 'owner',
    body: { name: 'upload-key' },
    expect: { status: 201 },
    write: {
      watch: ['api_keys'],
      delta: { inserted: [{ table: 'api_keys',
        where: `user_id=@owner.id AND name='upload-key'`,
        check: ['slug = left($key,6)', 'argon2verify(key_hash, $key)'] }] },
      unchangedElse: true,
    },
  },
];
```

The principle: the registry is data + short SQL strings, and there is one comparison code for all families (`runCase(case)`). A test per family:

```ts
describe.each(families)('contract: %s', (family) => {
  it.each(casesOf(family))('$id', async (c) => runCase(c));
});
```

One human-readable `it.each` per family; a failure shows the row `id`, the route and the "response vs SQL" diff.

### 2.8. Optional: SQL interception (N+1 / extra queries)

The application already logs every query in `logSqlQuery(sql, durationMs)` with `requestContextStorage` (`endpoint`, `callUuid`) and writes to `logs/sql-*.log`. A cheap option:
- In the contract suite file, boot **its own application instance** (not the shared one from `global-setup`; see 2.9), get `app.get(PG_POOL)` and wrap `pool.query` with a counter (`requestContextStorage.getStore()?.endpoint`). Then the test sees, in-process, the number of queries and the list of touched tables per call (parsing `FROM|JOIN|INTO|UPDATE <table>` with a regex over the text).
- The registry gets an optional `queries: { maxCount: 12, tables: ['api_keys'] }`. The assertion "tables ⊆ expected" catches reading extra data; `maxCount` catches N+1 (for example, `sessions` issues ~10 queries regardless of the number of sessions: the assertion runs on two fixtures with 3 and 30 sessions, and the query count is the same).
- **Limitation (inference)**: Drizzle goes through the same `pool.query` (this is how `DatabaseModule` is built), so the interception sees it; queries through `pool.connect()` + `client.query` (health, session store) are not seen. For the shared application from `global-setup` interception is impossible (the tests run in other processes), so only in the 2.9 variant. I consider it a "nice bonus", not required.

### 2.9. What to change so it works on a clean clone

Right now the suite does not start on a clean clone without manual preparation (per the QAA README of the time, runs went against a "local Postgres in Docker"; `server/.env` is not in git):
1. **Postgres**: add `docker-compose.test.yml` (postgres:16, `tmpfs` for the data, port 55432) and `npm run test:db:up`. Right now `docker-compose.yml` has no DB (only the application image, **inference**: the DB is external).
2. **env without `.env`**: `server/.env.test` (in git, no secrets): `DATABASE_URL=postgresql://postgres:test@localhost:55432/artisyn_test`, `DB_USER`, `DB_PASSWORD`, `SESSION_SECRET=test-secret-for-e2e`. `global-setup.ts` reads it before importing `AppModule` if `DATABASE_URL` is not set. Important: `app.module.ts` calls `dotenvConfig()` and overrides with `.env.local` (`override:true`); on a developer machine a `.env.local` with Mode 1 is already worked around by the line `process.env.AUTH_MODE = ...` in setup, and this trick is kept.
3. **A separate jest project for the contract**: `jest.contract.config.js` with `testRegex: test/contract/.*\.contract-spec\.ts` and **its own** `globalSetup` (or a boot inside the file). The reason: right now `package.json -> jest` applies `globalSetup` (booting the DB and the application) to ALL `*.spec.ts`, including the pure unit tests in `src/`, so every unit run needs Postgres **(inference from the config)**.
4. **Extract** a function `bootTestApp({schema})` from `global-setup.ts` into `test/helpers/boot-test-app.ts`; `global-setup.ts` calls it, and the contract suite calls the same function in `beforeAll` and gets the application instance (needed for 2.8) and `PG_POOL`.
5. **A new command** in the CLAUDE.md table and `repo-health-checks.json`: `npm run test:contract` (from `server/`). CLAUDE.md currently forbids unapproved variants, so the addition must be agreed with the owner.
6. The baseline user `e2e-baseline-user@example.com` inserted by `global-setup` is not needed in the contract world (the world defines all users; "the first user becomes admin" is worked around with an explicit `role` in the fixture).
7. `ServeStaticModule` expects `dist/public`; the harness has no such directory, so SPA routes give 404 (the tests already account for this in `security-headers.e2e-spec.ts`, **inference**). It does not get in the way.
8. SMTP: `MailService` tries to connect to `localhost:1025`; mail in F02/F07 must not break the response (contract `email_delivery: 'sent'|'failed'`); the test accepts both values and checks only the DB effect.

---

## 3. Route meta-test

Goal: `routes(app) == registry.routes`, strictly.

How to list the routes at runtime (two independent sources, compared with each other and with the registry):
1. **Through Nest metadata** (primary): `DiscoveryService.getControllers()` + `MetadataScanner`; for each method read `Reflect.getMetadata(PATH_METADATA, handler)` and `METHOD_METADATA` (`RequestMethod`), and the class prefix from the controller's `PATH_METADATA`. Normalization: join the prefix and the path, strip extra `/`, keep `:param` as is. The result is a set of keys like `"GET /api/v1/teams/:teamId"`. Handle `@Sse`/`@All` in a separate branch (there are none in the code now, but if one appears, the meta-test must fail and demand an explicit decision).
2. **Through Express** (control): in Express 5 (Nest 11, `@nestjs/platform-express`) `app.getHttpAdapter().getInstance().router.stack` holds layers with `layer.route.path` and `layer.route.methods`. Take all routes **except** the `ServeStatic` catch-alls (an allow-list in the meta-test itself, with a comment). This set must match (1); a difference means a route registered outside the controllers (middleware, `app.get(...)`).
   - **(inference)**: the structure of `router.stack` in Express 5 differs from Express 4 (`_router`); before implementing, check it on our version with one `console.log` line. If it is awkward, source (1) is enough; it is stable and public.

The test itself (two checks, 3 lines each):
```ts
it('every router route is in the registry', () => {
  const missing = [...liveRoutes].filter(r => !registryRoutes.has(r));
  expect(missing).toEqual([]);              // message: "add a row to test/contract/registry/*"
});
it('every registry row points to an existing route', () => {
  const dead = [...registryRoutes].filter(r => !liveRoutes.has(r));
  expect(dead).toEqual([]);                 // endpoint renamed/removed: update the registry
});
it('every route has at least one read/write/noDb row and a role', ...)
```
(The test names above read: "every router route is in the registry", "every registry row points at an existing route", "every route has at least one read/write/noDb row and a role"; the comments: "message: add a row to test/contract/registry/*" and "an endpoint was renamed/deleted, update the registry".)

Plus a check against the documentation: `docs/knowledgebase/server-endpoint-map.md` is parsed with a regex over its tables and compared with `liveRoutes` (optional): it catches an outdated KB, which covers the CLAUDE.md requirement "after changing an endpoint, update the KB".

Exclusions are written as an explicit `route: 'GET /x', kind: 'excluded', reason: '...'` in the registry (for example, `GET /api/auth/callback`, which needs a real Azure), not silently skipped.

---

## 4. Counts, effort, what gets replaced

### 4.1. Numbers

| Indicator | Value |
|---|---|
| Endpoints | **127** (127 unique `METHOD path`) |
| Families (one `it.each` per family) | **23** (F01-F23) |
| Registry rows written by hand (happy path + differing roles + key negatives + extra fixtures for aggregates) | **~230-260** (127 baseline + ~55 role rows + ~35 negative/write rows + ~20 extra aggregate/filter variants) |
| Generated auth-matrix rows (401/403 by `auth` in the registry) | **~110** (no manual cost) |
| Meta-tests | 3 |
| "Tests" in jest terms (`it`) | 23 + 3 + 1 (matrix) = **~27**, but **~370 check rows** |

If the owner prefers the wording "100-200 items": **the minimal profile** = only the baseline for each endpoint + only the roles that change the data (not just the status): ~170 rows, which is exactly "Group 1 in 100-200 items". The extended profile (with negatives) is ~260 rows.

### 4.2. Effort (estimate, **inference**; person-days)

| Work | Days |
|---|---|
| Harness: `bootTestApp`, oracle, runCase, snapshot diff, meta-test, jest project, docker-compose.test | 3-4 |
| The `world-v1` world fixture (SQL, claude/artisyn jsonb bodies, statistics, pricing) + agreeing on the golden numbers | 3-4 |
| Registries of the simple families F01-F13, F16, F18, F22 (CRUD/read, ~100 rows) | 4-5 |
| The complex families F14, F15, F17, F19-F21, F23 (CTE, cost, asynchrony, zip), ~110 rows | 6-8 |
| Optional SQL interception (2.8) | 1 |
| Debugging discrepancies (in practice such tests find real bugs, and they must be analysed) | 2-3 |
| **Total** | **~19-25 person-days** (can be cut: first the harness + F04/F05/F10-F13 as a pilot in 5-6 days) |

### 4.3. Which existing files are reused/replaced

Reused: `server/test/setup/global-setup.ts` (refactored into `bootTestApp`), `helpers/db-client.helper.ts`, `create-app.helper.ts`, `e2e-app.helper.ts`, `wait-for-queue-drain.helper.ts`; `db-cleanup.helper.ts` and `auth.helper.ts` stay for the old tests, and the contract layer does NOT use them (isolation from the code under test).

Replaced entirely or mostly (where the file is "call and check the response/DB"), by the number of `it` (grep; the number is understated for `it.each`): `api-keys` 21, `user-settings` 17, `model-pricing` 9, `ai-tool-versions.e2e` 12, `session-retention.e2e` 10 (partly, the background job stays), `hook-state` 11, `repo-settings` 11, `repositories` 10, `repo-details` 21, `team-repositories` 10, `team-invitations` 9, `team-repo-config` 1, `users-auto-provision` 4, `usage-analytics` 28, `repositories-analytics` 30, `cache-read-ratio-report` 16, `harness-usage-report` 10, `change-surface-report` 15, `change-surface-analytics` 20, `executive-summary-report-filters` 4, `executive-summary-spend-sections` 4, `session-stats-export` 16. Sum **~290 tests**.

Partly replaced (the data contract moves into the registry; guard/validation/edge cases stay): `admin-panel` 30, `sessions` 44, `team-access-mode` 46, `team-cross-member-sessions` 16, `access-management` 48, `account-deletion` 11, `session-delete` 11, `auth*`/`password-reset` ~58, `logs`/`logs-otel`/`logs-gzip`/`logs-hook-status` ~64, `upload-queue` 36, `attribute-filter-threading` 13, `change-surface` 24, `session-workflow` 11, `session-tree-metrics` 15, `session-cost-consistency` 5. Estimate: ~35-40% of their tests (~140-170) become redundant.

Unchanged (not about the DB contract): `installer` 7, `system-info` 11, `security-headers` 4, `app.e2e-spec` 1, the `*.spec.ts` unit tests (`semver`, `claude-extractor`, `artisyn-extractor`, `claude-version-usage`, `db`, `repo-backfill`, `repository-export-import`, `ai-tool-versions*`).

**In total about 430-460 of the 882 server API tests become redundant** (**inference**, estimated from the file names, without a line-by-line analysis). An honest caveat: the contract layer proves "response == DB" and the write delta, but it does NOT replace the business-rule tests (config merge priority, access formulas by `access_mode`, the extractor parsers). Part of them stays as "Group 2".

---

## 5. Risks and open questions

1. **External services**: Azure OAuth (`/auth/azure`, `/api/auth/callback`) needs a real Microsoft, so it is excluded (explicit `excluded`). SMTP (`MailService`) in F02/F07: mail is not checked (contract `email_delivery`), Mailpit is not required. The NPM registry is disabled with a flag.
2. **File endpoints**: `upload-queue/:id/file`, `logs-archive`, `error-logs`, `static installer`, export/download read the file system, not the DB; for them the DB oracle gives only "no side writes" and a metadata check. They depend on the `upload-queue/`, `export-import/`, `logs/` directories in `server/` (shared with the dev server, which runs in parallel! **inference**: the staging directories must be separated with env variables).
3. **Auth modes**: the contract runs in Mode 3; `identify` (Mode 1) and the Azure branches are checked only as 404. A positive Mode 1 needs a second boot with `AUTH_MODE=none` (a cheap second `describe` group of 3-4 rows, but it doubles the migrations, ~seconds). The owner's decision.
4. **SSE/streams**: the code has no `@Sse`; `getSessionLogs` returns the response through `@Res` (possibly streamed/gzip) **(inference)**; supertest reads the whole buffer, but very large `body` values must not be used in the fixture.
5. **PDF**: I found no endpoints with PDF (`grep` over the controllers). Reports return JSON; PDF/Excel is the client **(inference)**.
6. **Background jobs versus the fixture**: the queue worker (50 ms), retention (50 ms, but a 30-day threshold) and schedulers can "eat" or change the world's rows. Either insert only states they will not pick up, or provide a test way to pause the worker (`SchedulerRegistry` is already used by retention to stop intervals, **inference**).
7. **Non-deterministic fields**: `admin/system` (CPU, memory, `pingMs`), `uptime`, `now()` in responses, `CURRENT_DATE` in the `model_pricing` selection (the UTC midnight edge; the fixture uses dates with a ±1 day margin).
8. **Cost**: the SQL formula is non-trivial (DISTINCT ON by `message.id`, `REGEXP_REPLACE` of the date suffix in the model name, 5m/1h cache, fast mode, OTEL priority versus computed, summing sub-agents). The "independent SQL" for it must not copy the CTE: we rely on round golden numbers; the full proof stays with the `cost.sql` unit tests.
9. **Duplicate routes**: the user role is changed by two controllers (`PATCH /users/:userId/role` and `PATCH /admin/users/:id/role`); a question for the owner whether to delete the old one.
10. **Route order**: comments in the code (`hooks` before `:repoId`) point to fragility; the meta-test does not catch shadowing. Add registry rows for the literal paths (`/repositories/hooks`, `/teams/pending-disclosures`, `/upload-queue/stats`), as done in F14/F10/F09.
11. **A parallel dev server and the shared DB**: the harness is isolated by the `test_e2e_*` schema; it must not run together with the server tests and e2e (the CLAUDE.md rule about the shared DB). The contract suite must run sequentially (`--runInBand`).
12. **Effect on CLAUDE.md**: the new `test:contract` command needs a change to the command table and `repo-health-checks.json` (the source of truth). I did not do it; it is outside my area.
13. **What counts as "independent"**: a design assumption: a person writes the oracle by hand, without generating SQL from the application code. If a developer copies the SQL from a service, the test becomes a tautology; a review checklist is needed (in the registry header).
14. **Dead/duplicate routes**: `POST /api/v1/log-echo` (a debug echo) may be a candidate for deletion; in the registry it is marked `noDb`.

---

## 6. Out of route scope

Routes not served by a controller: the SPA static files (`ServeStaticModule`, `createPrecompressedStaticMiddleware`), `/help/*.md`, `/favicon.svg`. They do not read the DB; the meta-test ignores them through an explicit allow-list (source 2 of section 3), and the header check stays in `security-headers.e2e-spec.ts`.
