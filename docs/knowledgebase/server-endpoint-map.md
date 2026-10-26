---
type: "API Endpoint Map"
title: "Server API Endpoint to Controller Map"
description: "Maps every HTTP route to its controller and auth guard, with a guards legend and access control notes."
tags:
  - server
  - api
timestamp: "2026-07-20T22:24:25+04:00"
---

# Server API Endpoint → Controller Map

Read this file before adding, changing, or moving any server endpoint.  
After any endpoint change, update this file to stay in sync.

---

## Guards Legend

| Guard | Meaning |
|---|---|
| `SessionAuthGuard` | Cookie-session authenticated user |
| `ApiKeyAuthGuard` | API key in request header |
| `LocalAuthGuard` | Username/password (Passport local strategy) |
| `AdminGuard` | Authenticated + admin role |
| `TeamAccessGuard` | Authenticated + team member |
| `TeamOwnerGuard` | Authenticated + team owner |
| `AdminOrTeamOwnerGuard` | Authenticated + site admin or owner of *any* team (no `:teamId` param involved) |
| `AuthModeGuard` | Paired with `@AllowedAuthModes(...modes)` — 404s the route unless the active `AUTH_MODE` is in its allow-list. Always listed first in `@UseGuards(...)` so an inactive-mode request 404s before any credential/session check runs. |

---

## `/health`

**File:** `server/src/health/health.controller.ts`

| Method | Path | Handler | Auth |
|---|---|---|---|
| GET | `/health` | `check()` | none |
| GET | `/health/version` | `getVersion()` | none (public) |

---

## `/api/v1/ping`

**File:** `server/src/auth/ping.controller.ts`

| Method | Path | Handler | Auth |
|---|---|---|---|
| GET | `/api/v1/ping` | `ping()` | SessionAuthGuard |

---

## `/api/v1/auth`

**File:** `server/src/auth/auth.controller.ts`

| Method | Path | Handler | Auth |
|---|---|---|---|
| GET | `/api/v1/auth/config` | `config()` | none (always active — public, unauthenticated) |
| POST | `/api/v1/auth/identify` | `identify()` | `AuthModeGuard`(`none`) — Mode 1 only |
| POST | `/api/v1/auth/signup` | `signup()` | `AuthModeGuard`(`password`, `password-confirm`) |
| POST | `/api/v1/auth/login` | `login()` | `AuthModeGuard`(`password`, `password-confirm`) + LocalAuthGuard |
| POST | `/api/v1/auth/logout` | `logout()` | SessionAuthGuard |
| POST | `/api/v1/auth/confirm-email` | `confirmEmail()` | `AuthModeGuard`(`password-confirm`) |
| POST | `/api/v1/auth/resend-confirmation` | `resendConfirmation()` | `AuthModeGuard`(`password-confirm`) |
| POST | `/api/v1/auth/forgot-password` | `forgotPassword()` | `AuthModeGuard`(`password`, `password-confirm`) |
| POST | `/api/v1/auth/reset-password` | `resetPassword()` | `AuthModeGuard`(`password`, `password-confirm`) |
| POST | `/api/v1/auth/change-password` | `changePassword()` | `AuthModeGuard`(`password`, `password-confirm`) + SessionAuthGuard |
| POST | `/api/v1/auth/delete-account` | `deleteAccount()` | SessionAuthGuard |
| GET | `/api/v1/auth/azure` | `azure()` | `AuthModeGuard`(`azure-oauth`) — 302 redirect to Microsoft |
| GET | `/api/v1/auth/me` | `me()` | `AutoIdentifyGuard` + SessionAuthGuard |

**Notes (configurable auth modes):**
- `GET config` — the only always-public route on this controller; returns `{ mode, azure?: { authority, clientId, redirectUri }, adminContactEmail?, passwordResetAvailable? }`. `azure` only when `mode === 'azure-oauth'`; `adminContactEmail` and `passwordResetAvailable` only when `mode` is `password`/`password-confirm` (`passwordResetAvailable` = `MailService.isConfigured()`: `false` in Mode 2 without `SMTP_HOST`). Never includes a secret field.
- `POST identify` — Mode 1 (`none`). No password, ever. Rejects with `403` unless the request originates from `127.0.0.1`/`::1` (`req.socket.remoteAddress`, never `X-Forwarded-For`) — or, when the server runs containerized, from the container's own private default gateway (see `authorization-and-authentificaiton.md`). Looks up/auto-provisions the user by (lowercased) email and `req.logIn()`s — same success shape as `login`/`confirm-email`.
- `GET me` — `AutoIdentifyGuard` runs before `SessionAuthGuard` and is a no-op except in Mode 1 (`none`): for an unauthenticated local request with no session (`isLocalhostRequest()` — `127.0.0.1`/`::1`, plus the container's own private default gateway when containerized), it silently `req.logIn()`s a user picked by `AuthService.autoIdentifyMode1()` (exactly one user in `users` → that user; more than one, e.g. leftover e2e accounts → `id=1`; zero users → falls through unchanged, so the client still shows the manual identify form) instead of 401ing. This means Mode 1 never really needs the session cookie to "remember" anyone across restarts/expiry — every `GET me` re-derives the identity from the `users` table. Every other mode is unaffected (`req.isAuthenticated()`/mode/localhost checks all short-circuit to the original 401 behavior).
- `POST confirm-email` — `{ token }` → `200 <public profile>` / `400` invalid / `410` expired / `409` already-confirmed. Atomic consume (`EmailConfirmationTokensService.consume`).
- `POST resend-confirmation` — `{ email }` → `200 { email_delivery: 'sent' | 'failed' }` always (enumeration-safe — no account, or already-confirmed, both report `'sent'` with no email sent) / `429` with a `Retry-After` header on the 60s per-account cooldown.
- `POST forgot-password` / `POST reset-password` — same `email_delivery`/cooldown contract as resend-confirmation (body changed from the old `{ message }` shape); `reset-password` returns `{ error: 'password_mismatch' | 'weak_password' }` (400) distinct from an invalid-token 400.
- `GET azure` — generates `state`/`nonce`, stores both in `req.session`, redirects to the MSAL-built Microsoft authorize URL. See `/api/auth` below for the callback (different prefix on purpose).
- Password strength for `signup`/`reset-password`/`change-password` is policy-driven (`PASSWORD_POLICY` env var: `any`/`mid`/`long`, via `applyPasswordPolicy()`), not a static `@MinLength`.

**Notes (auth security hardening):**
- `POST login` can now also return **`429` + `Retry-After`** — the progressive brute-force delay (`LoginBackoffService`, per lowercased email *and* per `req.ip`, `max()` of the two; 1st failure free, then `1s/2s/3s…`). In-memory and per-process; disabled under `NODE_ENV=test`.
- `POST change-password` — `ChangePasswordDto { currentPassword, password, passwordConfirm }` → `200 { ...public profile, email_delivery: 'sent' | 'failed' | 'skipped' }`. `403 { error: 'invalid_current_password' }` (deliberately **not** 401 — the client's `apiFetch()` force-logs-out on any 401), `400 { error: 'password_mismatch' | 'weak_password' | 'no_local_password' }`. On success every **other** `auth_sessions` row for the user is deleted (`AuthSessionsService.deleteOtherSessionsForUser(userId, req.sessionID)`), so all other devices are signed out; the caller's own session survives. The notification email is best-effort — `'skipped'` when `SMTP_HOST` is unset, `'failed'` when the relay refuses; neither fails the change.
- `POST delete-account` — `DeleteAccountDto { confirm: 'delete' }` (exact string) → `204`. Hard-deletes the account and everything it owns via `AccountDeletionService.hardDeleteUser` (see the admin route's notes below), then destroys the session and clears `connect.sid`. A `session.destroy()` error is swallowed on purpose: `hardDeleteUser` has already removed the caller's own `auth_sessions` row, so the store destroys a row that is already gone. `400` when the caller is the last remaining admin.

---

## `/api/auth` (Azure OAuth callback, own controller/prefix)

**File:** `server/src/auth/azure/azure-callback.controller.ts`

| Method | Path | Handler | Auth |
|---|---|---|---|
| GET | `/api/auth/callback` | `callback()` | `AuthModeGuard`(`azure-oauth`) |

**Notes:**
- Deliberately outside the `api/v1/auth` prefix: `/api/auth/callback` is the exact redirect URI already registered on the Azure App Registration of the deployment (see [Local SSO reference folder](deployment-auth-mode.md#local-sso-reference-folder)) — a versioned-prefix path would need a new Azure Portal registration.
- Validates `state`/`nonce` against `req.session` (set by `GET /api/v1/auth/azure`), exchanges the code via `@azure/msal-node`, extracts the `email` claim (falling back to `preferred_username`), auto-provisions/matches the local user (case-insensitive, same helper Mode 1 uses), `req.logIn()`s, redirects to `/`. Any failure (provider error, state/nonce mismatch, missing email) logs server-side only and redirects to `/#/login?oauthError=1` — no provider detail leaked to the client.
- Verified live 2026-08-06 against the real dev Azure App Registration: full interactive Microsoft sign-in correctly matched and logged into a pre-existing local account by email (no duplicate created).

---

## `/api/v1/log-echo` (and the removed `/api/v1/logs`)

**File:** `server/src/logs/logs.controller.ts`

| Method | Path | Handler | Auth |
|---|---|---|---|
| POST | `/api/v1/log-echo` | `logEcho()` | ApiKeyAuthGuard |

**Notes:**
- `POST /api/v1/log-echo` returns `200 OK` for a valid API key; the hooks installer (`artisyn-hooks-installer/src/install.ts`) calls it to check a key.
- **`POST /api/v1/logs` was removed** (open-source readiness): `postLogs()` and its private `stripNullChars` copy were deleted and `api/v1/logs` was dropped from `LOG_INGEST_ROUTES`. The path now returns Nest's default `404`, so hooks older than `1.7.0` (which had it hardcoded) stop uploading until upgraded. `POST /api/v2/logs` below is the only upload route. See `docs/knowledgebase/hook-api-versioning.md`.

---

## `/api/v2/logs`

**File:** `server/src/logs/logs-v2.controller.ts`

| Method | Path | Handler | Auth |
|---|---|---|---|
| POST | `/api/v2/logs` | `postLogs()` | ApiKeyAuthGuard — middleware: `inflateSniffedGzip` |

**Notes:**
- **`inflateSniffedGzip`** — `server/src/logs/gzip-sniff.middleware.ts`, registered in `AppModule.configure()` (not `LogsModule`: the root module's `express.text({type:'application/x-ndjson'})` on `forRoutes('*')` is what actually consumes the hook's body, so a sniffer registered in `LogsModule` would run after the bytes were already utf8-decoded) for `LOG_INGEST_ROUTES` (`POST api/v2/logs`). It returns immediately when `Content-Encoding` is already set (body-parser inflates those itself) or the request has no body; otherwise it peeks the first 2 bytes and unshifts them, leaving a plain request byte-identical. Only a `1f 8b` prefix makes it take over: it consumes the stream (`413` above `getLogsBodyLimitBytes()`), `gunzipSync`es with `maxOutputLength` at the same limit, and sets `req.body` plus `content-length` so the controllers still receive the string they require. `ERR_BUFFER_TOO_LARGE` → `413`; any other inflate error → `400 Malformed gzip request body`. That split matters: the hook classifies a non-validation `400` as "peer does not accept gzip" and permanently downgrades, so routing the size error there would disable compression for that hook process.
- Chunk query params are unaffected by the gzip sniffer, and `totalSize` stays the **uncompressed** total so reassembly and `upload_queue.size_bytes` keep their meaning.
- An optional `?workflowRunId=<wf-id>` query param (hook v1.6.0+) is sent only for workflow-subdir agent uploads alongside `?parentSessionId`. It sets `sessions.workflow_run_id` at upsert time, independently of `parentSessionId` — both can be set on the same row.
- The only log upload route (async, hook `1.7.0`+). `sessionId`/`type`/`parentSessionId`/`workflowRunId` query params and three structural `400` checks (missing `sessionId`, missing `type`, empty/non-string body), but does **no** NDJSON parsing on the request path: the raw body is staged to disk (`UploadQueueService.saveRawUpload()`) and a `pending` `upload_queue` row is inserted; a background scheduler (`UploadQueueSchedulerService`, ticking every `UPLOAD_QUEUE_INTERVAL_MS`, default 1s) parses the file and calls `LogsService.upsert()` off the request path. Parsing is tolerant (`parseNdjsonLinesTolerant()`): up to `MAX_DROPPED_LINE_RATIO` (10%) of non-blank lines may be malformed — torn records from pre-`2.15.0` hooks on non-atomic-append filesystems — and are dropped with a `warn` log line naming the row and line numbers; above that share the row fails with the strict parser's first-bad-line message. Abandoned chunked uploads (`partially_uploaded`, no chunk for `UPLOAD_QUEUE_PARTIAL_UPLOAD_TTL_MS`, default 24h) are expired with their part-files by the same scheduler.
- Response body: `201 { warnings: string[] }` — one message per `status='failed'` `upload_queue` row currently on file for the calling API key's `userId` (from a *previous* upload's parse/upsert failure), formatted as `` `Hook uploaded broken file: ${fileName} — ${errorMessage}` ``. Empty array when there are no outstanding failures. A malformed NDJSON body no longer produces a synchronous `400` on this route — it becomes a `failed` queue row surfaced via this `warnings` array on a later call instead.
- A staging-directory write failure (disk full, permissions, etc.) propagates as a `500` and creates no queue row.
- **Chunked upload path (hook `1.8.0`+)**: four new optional query params, present only when the hook splits a body over `CHUNK_SIZE_BYTES` (10MB originally, 900KB since hook `2.6.1`, and the *on-the-wire* budget since `2.8.0`) into chunks — `uploadId` (hook-generated UUID, distinct from `sessionId`), `chunkIndex` (0-based integer), `totalChunks` (integer ≥1), `totalSize` (decimal string, total un-chunked byte length, required and read only on the `chunkIndex===0` request). All three of `uploadId`/`chunkIndex`/`totalChunks` must be present together or none at all — an incomplete subset, an out-of-range/non-integer `chunkIndex`/`totalChunks`, a `chunkIndex>0` referencing an unknown `uploadId`, or a `totalChunks` mismatch against the `uploadId`'s previously recorded value all `400`. Each chunk is staged as its own file (`${uploadId}.chunk${chunkIndex}`) and reassembled into one `${uploadId}.raw` file on the chunk that completes the set; the row is `partially_uploaded` until then. Response body on this path replaces the plain `{warnings}` shape: `201 { complete: false }` for every non-final chunk, `201 { complete: true, warnings: string[] }` for the final chunk. Files at or under `CHUNK_SIZE_BYTES` uncompressed, or any caller that omits all four new params, keep using the original single-request path and response shape unchanged — this is what preserves old-hook (pre-`1.8.0`) compatibility.
- See `docs/knowledgebase/hook-api-versioning.md` for the v1/v2 history, the v1 removal and the compatibility matrix.

---

## `/api/v2/post-turn-analysis`

**File:** `server/src/logs/post-turn-analysis/post-turn-analysis.controller.ts`

| Method | Path | Handler | Auth |
|---|---|---|---|
| GET | `/api/v2/post-turn-analysis/config` | `getConfig()` | ApiKeyAuthGuard |

**Notes:**
- Combined post-turn-analysis config — the one gate-info
  `GET` both hook branches (Turn-End Cost Advisor's advisor branch, AI Session Attribution's
  attribution branch) read before deciding whether to evaluate at all. **Replaces** the two
  feature-specific `GET` routes from the pre-unification design; each feature's own `POST`
  result-submission endpoint below is untouched and still separate.
- Query: `repoUrl` (url-encoded, normalized via `normalizeRepoUrl()` before either service is
  called), `sessionId`, `promptWatermark` (integer; used by the attribution branch only).
  Missing `repoUrl`/`sessionId` → `400`.
- A thin composition layer only (no merged resolution logic): injects
  `TurnEndCostAdvisorService` and `SessionAttributionService`, `Promise.all`s their own
  `resolveGate()` calls, and merges the two independent results into
  `{ advisor: TurnEndAdvisorGate, attribution: SessionAttributionGate }`. See
  `api-reference.md`'s "Combined Post-Turn Analysis Config" section for the full response
  shape and the unknown-`repoUrl`/unknown-`sessionId` non-error paths.
- `server/src/logs/post-turn-analysis/post-turn-analysis.module.ts` imports both
  `TurnEndCostAdvisorModule` and `SessionAttributionModule` — this is what registers both
  feature-specific `POST` controllers below in the app for the first time; it is the only new
  module registered directly in `AppModule`.

---

## `/api/v2/turn-end-cost-advisor`

**File:** `server/src/logs/turn-end-cost-advisor/turn-end-cost-advisor.controller.ts`

| Method | Path | Handler | Auth |
|---|---|---|---|
| POST | `/api/v2/turn-end-cost-advisor` | `submitRun()` | ApiKeyAuthGuard |

**Notes:**
- Turn-End Cost Advisor — the hook's advisor-branch result submission endpoint.
  The combined gate-info `GET` the hook reads before deciding whether to evaluate at all is
  `GET /api/v2/post-turn-analysis/config` (see above).
- Body: `{ sessionId, startedAt, finishedAt, outcome: 'submitted' | 'failed', evalSessionId?, summary?: { general, costFactors: string[], harnessAdvice: string[] }, failureReason?, cost?: { model, costUsd, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } }`.
- Response `200 { applied: boolean }`. Ownership-checked via the artisyn log's `userId` for the
  resolved `sessions` row (same convention `getSessionLogs()`'s owner-only guard uses) — a
  session owned by a different API-key user answers `404`, never confirming its existence.
- Not-yet-ingested (`sessions` row doesn't exist yet — `POST /api/v2/logs` only staged the body
  into `upload_queue`) answers `2xx { applied: false }`, no run row written (its FK would have no
  target).
- Writes exactly one append-only row to `turn_end_advisor_runs` per actual evaluation attempt
  (`outcome ∈ {'submitted','failed'}`) — overlapping runs on rapid consecutive turns are
  permitted, not locked.
- `server/src/logs/turn-end-cost-advisor/turn-end-cost-advisor.module.ts` exports
  `TurnEndCostAdvisorService` for the combined `post-turn-analysis` module to import; it is not
  registered in `AppModule` directly — it is imported (and thereby registered, including this
  `POST` controller) by `PostTurnAnalysisModule`.

---

## `/api/v2/session-attribution`

**File:** `server/src/logs/session-attribution/session-attribution.controller.ts`

| Method | Path | Handler | Auth |
|---|---|---|---|
| POST | `/api/v2/session-attribution` | `submitRun()` | ApiKeyAuthGuard |

**Notes:**
- AI Session Attribution — the hook's attribution-branch result submission
  endpoint. The combined gate-info `GET` the hook reads before deciding whether to evaluate at
  all is `GET /api/v2/post-turn-analysis/config` (see above).
- Body: `{ sessionId, promptWatermark, startedAt, finishedAt, invokingSessionId, outcome: 'submitted' | 'failed', values?: Record<string, string | string[] | boolean | number | null>, evalSessionId?, failureReason?, cost?: { model, costUsd, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } }`.
- `sessionId` is the Claude UUID; the row key for both `session_attribution` and
  `session_attribution_runs` is the surrogate `sessions.id`, resolved as `sessions.session_id =
  :sessionId`. Ownership-checked via the artisyn log's `userId` for that resolved session (same
  convention the advisor endpoint and `getSessionLogs()`'s owner-only guard use) — a session
  owned by a different API-key user answers `404`, never confirming its existence.
  `invokingSessionId` is stored as a separate, unresolved raw string on the run row only — it
  plays no part in the ownership check or either table's FK (see `db-tables.md`'s
  `session_attribution_runs` entry).
- Not-yet-ingested (`sessions` row doesn't exist yet) answers `2xx { applied: false }`, no run row
  written (its FK would have no target) and `session_attribution` untouched.
- The apply is a **single conditional statement**:
  `INSERT ... ON CONFLICT (session_id) DO UPDATE ... WHERE excluded.prompt_watermark >
  session_attribution.prompt_watermark`, so two concurrent submissions cannot interleave and a
  submission whose `promptWatermark` is lower-or-equal to the stored one is silently discarded
  (no error, no state change).
- `outcome: 'failed'` in the body passes straight through to the run row's own `outcome='failed'`
  and never touches `session_attribution` at all. `outcome: 'submitted'` is server-derived into
  `'applied'` (the upsert's `WHERE` matched — a fresh insert always matches) or `'ignored_stale'`
  (it didn't). Response `{ applied: boolean }` mirrors that: `true` only when the run's own
  outcome is `'applied'`.
- Writes exactly one append-only row to `session_attribution_runs` per actual evaluation attempt
  (`outcome ∈ {'applied','ignored_stale','failed'}`) — every submission is recorded, whichever
  way it resolved. `outcome='failed'` also persists the body's `failureReason` into the run row's
  own `failure_reason` column (migration `0057`, a Chunk 8 gap fix — `0056` never gave this table
  a column to store it in even though the API changes spec always required
  `lastRun.failureReason` downstream).
- `server/src/logs/session-attribution/session-attribution.module.ts` exports
  `SessionAttributionService` for the combined `post-turn-analysis` module to import; it is not
  registered in `AppModule` directly — it is imported (and thereby registered, including this
  `POST` controller) by `PostTurnAnalysisModule`.

---

## `/api/v1/model-pricing`

**File:** `server/src/logs/model-pricing.controller.ts`

| Method | Path | Handler | Auth |
|---|---|---|---|
| GET | `/api/v1/model-pricing` | `getModelPricing()` | None (no `SessionAuthGuard`; public so the hook can fetch pricing for its local session-cost derivation without a session cookie). **Response shape (no compatibility shim)**: there is no single `priceCacheW`; the cache-write rate is split into `priceCacheW5m` + `priceCacheW1h`, plus `priceWebSearch` (USD **per request**). Client twin: `ModelPricingEntry` in `client/src/models/pricing.ts` |

The shape is unchanged by the model-pricing fetch work (migration `0066`). Unpriced models have
no `model_pricing` row, so they are omitted automatically. The admin read/write API for the same
data is `/api/v1/admin/model-pricing` below.

---

## `/api/v1/repositories`

**File:** `server/src/logs/repositories.controller.ts`

| Method | Path | Handler | Auth |
|---|---|---|---|
| GET | `/api/v1/repositories` | `listMyRepositories()` | SessionAuthGuard |
| GET | `/api/v1/repositories/hooks` | `listHookRepositories()` | SessionAuthGuard |
| GET | `/api/v1/repositories/:repoId` | `getRepository()` | SessionAuthGuard |
| GET | `/api/v1/repositories/:repoId/hook-state` | `getRepositoryHookState()` | SessionAuthGuard |
| GET | `/api/v1/repositories/:repoId/settings` | `getRepoSettings()` | SessionAuthGuard — optional `?teamId` (team view, see Notes) |
| PUT | `/api/v1/repositories/:repoId/settings/team` | `saveTeamConfig()` | SessionAuthGuard — optional `?teamId` (team view, see Notes) |
| PUT | `/api/v1/repositories/:repoId/settings/user` | `saveUserConfig()` | SessionAuthGuard |
| GET | `/api/v1/repositories/:repoId/sessions` | `getRepositorySessions()` | SessionAuthGuard — each row gains `costUnavailableReason: 'unknown-model' \| null`. The session detail header and the session log view both consume this row, so there is deliberately no separate session-detail cost endpoint. repeatable `attr=<key>:<op>:<value>` filtering, plus each row gains `attribution`/`lastRun` (see Notes below) |
| GET | `/api/v1/repositories/:repoId/sessions/ids` | `getRepositorySessionIds()` | SessionAuthGuard — lightweight bare `string[]` of session ids for badge-poll callers; `hideHookSessions`/`filterByUserEmail` filtering applied server-side; skips firstPrompt/cost/favorite/hasWorkflow enrichment |
| GET | `/api/v1/repositories/:repoId/sessions/branches` | `getRepositorySessionBranches()` | SessionAuthGuard — accepts `attr=` (feeds both "Cost by Branch" and "Branch Summary" reports, per the Notes below); `totalLinesChanged` is now TREE-scoped (the branch's sessions plus every sub-agent below them, via `session-tree-metrics.sql.ts` → `loadTreeMetricsByRoot`), with the old root-only figure kept additively as `totalLinesChangedOwn`; `totalWorkTimeMs` deliberately unchanged (temporal — the root span already contains its children) |
| GET | `/api/v1/repositories/:repoId/session-attribution/values` | `getSessionAttributionValues()` | SessionAuthGuard — Modeled on `sessions/branches` above |
| GET | `/api/v1/repositories/:repoId/contexts` | `getRepositoryContexts()` | SessionAuthGuard |
| GET | `/api/v1/repositories/:repoId/sessions/:sessionId/contexts` | `getSessionContexts()` | SessionAuthGuard |
| GET | `/api/v1/repositories/:repoId/sessions/:sessionId/change-surface` | `getSessionChangeSurface()` | SessionAuthGuard — One session **tree**'s change-surface aggregate (fetched on every session open, for the Summary tile and the three CS detectors). Optional `teamId`. Access resolution is identical to `sessions/:sessionId/contexts` (`assertRepoAccess` + `resolveRepoIds` + the team-visibility owner condition). An inaccessible or never-recomputed session returns a `computed: false` aggregate, never a 404 and never a zeroed one. Uncapped by design |
| GET | `/api/v1/repositories/:repoId/sessions/:sessionId/change-surface/files` | `getSessionChangeSurfaceFiles()` | SessionAuthGuard — The per-path rows behind the Change surface tab's file tree, fetched only when that tab is opened. Optional `teamId`. Capped at `CHANGE_SURFACE_MAX_FILE_ROWS` (5,000) with `total` / `truncated` reported alongside, so the tab says "showing the first N of M paths" instead of silently cutting the tree |
| POST | `/api/v1/repositories/:repoId/sessions/:sessionId/favorite` | `setSessionFavorite()` | SessionAuthGuard |
| GET | `/api/v1/repositories/:repoId/summary` | `getRepositorySummary()` | SessionAuthGuard — with `?teamId` counts every team member's row of the URL (`resolveRepoIds`), not access-mode scoped |
| GET | `/api/v1/repositories/:repoId/sessions/:sessionId/logs` | `getSessionLogs()` | SessionAuthGuard — each `subagentStats` entry gains `webSearchRequests` / `inputTokensFast` / `outputTokensFast`; response gains `turnEndAdvisor: { generatedAt, summaryGeneral, costFactors, harnessAdvice } \| null`; `turnEndAdvisor` gains `model`, `costUsd`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`; response gains `sessionAttribution` (see Notes below); each `subagentStats` entry gains `linesChanged` / `filesEditedWritten` / `linesAdded` / `linesRemoved` / `diffLinesCoveredCalls` / `diffLinesTotalCalls` (per-node, that child's own transcript only), and the `subagentStats` select carries the OTEL-only `EXISTS` guard so it cannot disagree with the server-side tree rollup |
| GET | `/api/v1/repositories/:repoId/sessions/export-scope` | `getSessionsExportScope()` | SessionAuthGuard |
| POST | `/api/v1/repositories/:repoId/recompute-all-sessions` | `recomputeAllSessions()` | SessionAuthGuard |
| GET | `/api/v1/repositories/:repoId/analytics/timeline` | `getAnalyticsTimeline()` | SessionAuthGuard — each session row gains `costUnavailableReason` plus `webSearchRequests` / `inputTokensFast` / `outputTokensFast`. accepts `attr=` + `groupBy=attr:<key>` (see Notes below); `linesChanged` / `filesEditedWritten` are now TREE-scoped (`treeMetricsCte()` joined on `root_id`), with the old root-only figures kept additively as `linesChangedOwn` / `filesEditedWrittenOwn`; the raw-JSONB fallback CTE now also counts `MultiEdit` |
| GET | `/api/v1/repositories/:repoId/analytics/work-time` | `getAnalyticsWorkTime()` | SessionAuthGuard — accepts `attr=` + `groupBy=attr:<key>` (see Notes below) |
| GET | `/api/v1/repositories/:repoId/analytics/change-surface` | `getAnalyticsChangeSurface()` | SessionAuthGuard — The change-surface timeline. Parameter parsing mirrors `analytics/timeline` (required `startDate`/`endDate`, single-day UTC widening, `branch`/`user`/`attr:<key>` grouping and the same "cannot combine `groupBy=branch` with a `branches` filter" guard), plus `bucket=hour|day|week` which overrides the range-derived default (`CHANGE_SURFACE_BUCKET_THRESHOLDS`) and 400s on anything else. Delegates to the **same** `ChangeSurfaceAggregateService.build()` call as the report below |
| GET | `/api/v1/repositories/:repoId/reports/executive-summary` | `ReportsController.getExecutiveSummary()` | SessionAuthGuard — each `topSessions` row gains `costUnavailableReason`; report-level `excludedSessionCount` / `excludedModels` keep their current meaning. accepts `attr=` (Phase A only, both windows). response shape unchanged, values change — `totalLinesChanged` / `avgLinesPerHour` rise and `avgCostPerLine` / per-engineer `costPerLine` fall, because Phase B now rolls up each session's sub-agent lines (`treeMetricsCte()` + `withOwnFallback`), making both sides of every ratio tree-scoped |
| GET | `/api/v1/repositories/:repoId/reports/cache-read-ratio` | `ReportsController.getCacheReadRatio()` | SessionAuthGuard — `cacheWriteCost` is now the sum of the two TTL terms (5m and 1h priced separately), so 1h-heavy ranges report a higher figure than before. accepts `attr=` + `groupBy=attr:<key>` (see Notes below) |
| GET | `/api/v1/repositories/:repoId/reports/harness-usage` | `ReportsController.getHarnessUsageReport()` | SessionAuthGuard — accepts `attr=` + `groupBy=attr:<key>` (see Notes below) |
| GET | `/api/v1/repositories/:repoId/reports/change-surface` | `ReportsController.getChangeSurfaceReport()` | SessionAuthGuard — Backs the Reports tab's "Change Surface" document. Same `teamId`/`startDate`/`endDate`/`branches`/`users`/`attr` params and the same fixed-vs-`attr:` `groupBy` split as `harness-usage` (`CHANGE_SURFACE_GROUP_BY_VALUES`). Computes nothing itself: it calls `ChangeSurfaceAggregateService.build()` pinned to `bucket: 'week'`, which is what makes the report and the analytics chart structurally incapable of disagreeing |
| GET | `/api/v1/repositories/:repoId/reports/attribution-breakdown` | `ReportsController.getAttributionBreakdownReport()` | SessionAuthGuard — `supportsAttributeFilter: true`, no `groupBy` (see Notes below) |
| GET | `/api/v1/repositories/:repoId/reports/attribution-usage` | `ReportsController.getAttributionUsageReport()` | SessionAuthGuard — `supportsAttributeFilter: false`; repeatable `outcome=` (see Notes below) |
| GET | `/api/v1/repositories/:repoId/analytics/tools` | `UsageAnalyticsController.getToolAnalytics()` | SessionAuthGuard — accepts `attr=` (see Notes below) |
| GET | `/api/v1/repositories/:repoId/analytics/tokens` | `UsageAnalyticsController.getTokenAnalytics()` | SessionAuthGuard — accepts `attr=` (see Notes below) |
| GET | `/api/v1/repositories/:repoId/analytics/productivity` | `UsageAnalyticsController.getProductivityAnalytics()` | SessionAuthGuard — accepts `attr=` (see Notes below) |
| GET | `/api/v1/repositories/:repoId/analytics/active-sessions` | `UsageAnalyticsController.getActiveSessions()` | SessionAuthGuard — accepts `attr=` (see Notes below) |
| GET | `/api/v1/repositories/:repoId/reports/tool-analytics` | `ReportsController.getToolAnalyticsReport()` | SessionAuthGuard — accepts `attr=` (see Notes below) |
| GET | `/api/v1/repositories/:repoId/reports/token-usage` | `ReportsController.getTokenUsageReport()` | SessionAuthGuard — accepts `attr=` (see Notes below) |
| GET | `/api/v1/repositories/:repoId/reports/productivity-counters` | `ReportsController.getProductivityCountersReport()` | SessionAuthGuard — accepts `attr=` (see Notes below) |
| GET | `/api/v1/repositories/:repoId/reports/active-sessions` | `ReportsController.getActiveSessionsReport()` | SessionAuthGuard — accepts `attr=` (see Notes below) |
| GET | `/api/v1/repositories/:repoId/analytics/claude-versions` | `UsageAnalyticsController.getClaudeVersionUsage()` (`server/src/logs/analytics/usage-analytics.controller.ts`) | SessionAuthGuard — 2026-09-23 Claude version check, new. Standard `teamId`/`startDate`/`endDate`/`branches`/`users`/`attr` params via `parseAnalyticsQuery` + `resolveScope`. Delegates to `ClaudeVersionUsageService.build()` (`server/src/logs/analytics/claude-version-usage.service.ts`), which reads `loadScopedRootSessions` (now selecting `COALESCE(ss.claude_version, ss.claude_version_otel)`) plus `AiToolVersionsService.loadHistory('claude-code')` and runs the pure `buildClaudeVersionUsageRows`. Returns `{ rows: ClaudeVersionUsageRow[] }` |
| GET | `/api/v1/repositories/:repoId/reports/claude-versions` | `ReportsController.getClaudeVersionUsageReport()` (`server/src/logs/reports/reports.controller.ts`) | SessionAuthGuard — twin of `analytics/claude-versions` (same service, same params via `resolveUsageScope`, byte-identical body). Backs the Reports tab's "Claude Code Version Usage" document |

**Notes:**
- `POST .../sessions/:sessionId/favorite` — `:sessionId` is the public `sessions.session_id` string; body `{ favorite: boolean }`; response `{ isFavorite: boolean }`. Optional `?teamId` query param for team-route access checks.
- `GET .../sessions` response now includes `isFavorite: boolean` per session (true when the authenticated user has favorited the session).
- `GET .../sessions` response now includes `isHookService: boolean` (true when the artisyn log contains a hook_service event).
- `GET .../sessions` response now includes `claudeVersion: string | null` (2026-09-23) — `COALESCE(session_stats.claude_version, session_stats.claude_version_otel)`, fetched by one batched per-page query keyed on the same session-id array as the other enrichments. Only this endpoint carries it; `sessions/ids`, badge-poll and export siblings do not.
- `GET .../sessions` response now includes `hasWorkflow: boolean` (true when the claude log body contains a `"name": "Workflow"` tool_use; computed via a separate query using a fast LIKE text scan — pattern is `'%"name": "Workflow"%'` with a space after the colon, same pattern as `costMap`).
- `GET .../sessions` response now includes `hasAdvisorAdvice: boolean` (true when the session's LATEST `outcome='submitted'` `turn_end_advisor_runs` row has a non-empty `harness_advice` array; batched via a `LATERAL` join keyed on `sessions.session_id = turn_end_advisor_runs.session_id`, same `sessionDbIds` array already used for `hasWorkflowSet`/`ownerMap`). Drives the session-list row's top-right corner bulb icon (`session-list-helpers.tsx`'s `SessionItem`).
- `GET .../sessions` accepts repeatable `attr=<key>:<op>:<value>` query
  params, parsed/validated by `parseAttributeFilters()` +
  `validateAttributeFilterTypes()` and spliced into the session-selection `and(...)` via
  `attributeFilterSql()` (all three in `server/src/logs/attribute-filter.sql.ts`) — an unknown
  key or an operator/type mismatch against this repo's resolved attribute definitions (via
  `SessionAttributionService.resolveDefinitions()`, team-only) `400`s. Each response row also
  gains `attribution: { values, promptWatermark, updatedAt } | null` and
  `lastRun: { outcome, finishedAt, failureReason } | null`, fetched in one batched query per
  page (a `LEFT JOIN` against `session_attribution` plus a `LATERAL` join against
  `session_attribution_runs` keyed by the same `session.id` array already used for
  `ownerMap`/`hasWorkflowSet` — no per-row lookup). `attribution.values` has any orphaned entry
  (`isOrphanedValue()`) stripped before the response is built; a session
  with no `session_attribution` row at all answers `attribution: null` (never an empty-object
  placeholder).
- **`attr=` threading + `groupBy=attr:<key>` widening.** The
  `attr=<key>:<op>:<value>` filter is now also accepted on the 13 routes
  above beyond `GET .../sessions`, via the 5 sites `attributeFilterSql()` covers:
  `loadScopedRootSessions()` (`analytics/tools`, `analytics/tokens`, `analytics/productivity`,
  `analytics/active-sessions`, `reports/harness-usage`, plus their `reports/tool-analytics` /
  `reports/token-usage` / `reports/productivity-counters` / `reports/active-sessions`
  counterparts — all share one `AnalyticsScope`, now carrying `attributeFilters?`);
  `executive-summary.service.ts`'s own Phase A (both the current and comparison windows);
  `cache-read-ratio.service.ts`'s own Phase A; and the hand-built drizzle/raw-SQL queries in
  `getAnalyticsTimeline()`, `getAnalyticsWorkTime()`, and `getRepositorySessionBranches()`
  (feeding both the "Cost by Branch" and "Branch Summary" reports — one route, two report
  names). Every route resolves this repo's attribute
  definitions unconditionally (even with no `attr=` present) via
  `SessionAttributionService.resolveDefinitions()`, so an unknown key or an operator/type
  mismatch always `400`s the same way `GET .../sessions` already does.
  `groupBy=attr:<key>` is additionally accepted on the 6 `supportsGroupBy: true` route shapes:
  `analytics/timeline`, `analytics/work-time`, `reports/cache-read-ratio`,
  `reports/harness-usage`, `analytics/change-surface`/`reports/change-surface` (shared
  `ChangeSurfaceAggregateService`), and (transitively, since the client's "Cost by User" report
  is just `analytics/timeline` with `groupBy=user`) `analytics/timeline` again for cost-by-user.
  A key absent from the resolved definitions `400`s (`assertKnownGroupByAttrKey()`); combining
  `groupBy=attr:<key>` with an `attr=<key>:...` filter on that same key `400`s too
  (`assertNoGroupByAttrFilterConflict()`, extending the existing
  `groupBy=branch`+`branches=`/`groupBy=user`+`users=` guard).
- **`groupBy=attr:<key>` FANS OUT instead of folding.** A deleted/retyped attribute's
  now-orphaned stored value, and a session with no attribution row at all, still bucket as a
  single `'Not determined'`/`'Unattributed'` label each, but a **resolved**
  `string[]`-typed value with N literal elements now produces N separate bucket labels — the
  full session/row counted in every one of them — where it used to fold into one comma-joined
  bucket. The shared primitive is `attributeGroupLabels()` in `attribute-filter.sql.ts` (renamed
  from the singular `attributeGroupLabel()`, return type widened `string` → `string[]`), used by
  every consumer directly except two SQL-only paths that fan out via their own set-returning SQL
  form instead of a TS loop: `analytics/work-time`'s day-bucketed query (`attrGroupKeysSql()`,
  a `CROSS JOIN LATERAL` unnest — its whole aggregation happens in SQL with no per-row TS pass to
  hook into) and `change-surface`'s fact tagging (`changed-paths.sql.ts`'s `loadScopedChangedPaths()`,
  which flattens the resolved `Map<rootId, string[]>` into one `(root_id, key)` tuple per value
  before the `LEFT JOIN (VALUES ...)` that tags each fact row — a root with 2 values produces 2
  joined copies of every one of its fact rows). `cache-read-ratio.service.ts`'s and
  `harness-usage.service.ts`'s TS-side `buildGroups()` call `attributeGroupLabels()` directly and
  push each row/fact into every returned label. Scalar (`string`/`number`/`boolean`) attributes
  are unaffected — `attributeGroupLabels()` always returns their one label unchanged.
- `GET .../reports/attribution-breakdown` (`reports.controller.ts` +
  `reports/attribution-breakdown.service.ts`) — backs the Reports tab's "Attribute Breakdown"
  document. Required `startDate`/`endDate`, optional `teamId`, `branches`, `users`, repeatable
  `attr=<key>:<op>:<value>` (resolved/validated the same way every other
  report does via `ReportsController.resolveAttributeFilters()`). Copies
  `cache-read-ratio.service.ts`'s two-phase shape: Phase A is a cheap scan
  of each in-scope session's own cost plus its whole `session_attribution.values` object; Phase B
  is the complete computed tree cost (`loadTreeCostRows()` + `readTreeCost()` in
  `session-tree-cost.sql.ts`: own + sub-agents + utility calls; an unpriced session adds 0)
  keyed on Phase A's `session_row_id`s, the same cost every other surface shows. One section per this repo's resolved attribute
  definition (`SessionAttributionService.resolveDefinitions()`), each fixed by declared type:
  `boolean` -> exactly 4 rows (`true`, `false`, `"Not determined"`,
  `"Unattributed"`), no ranking; `string`/`number` -> a ranked table, top 15 by session count
  (ties ordered by value),
  the tail collapsed into one `"Other"` row; `string[]` -> the same ranked-table shape but each
  session's deduplicated array elements each contribute to their own value's bucket, so that
  section's `fanOut: true` and its shares can legitimately sum above 100%. `"Not determined"`
  (row exists, key `null`/absent/orphaned) and `"Unattributed"` (no `session_attribution` row at
  all) are always their own rows in every layout, never folded into `"Other"`. Every row's
  `share` is against the report's `totalSessionCount`, never a per-section total. Response also
  carries a report-level `orphanedSessionCount` — sessions with at least one orphaned attribute
  value (`isOrphanedValue()`), disclosed once independent of the per-section
  folds. No `groupBy` support (only 5 reports get one;
  `attribution-breakdown` already breaks every attribute into its own section).
- `GET .../reports/attribution-usage` (`reports.controller.ts` +
  `reports/attribution-usage.service.ts`) — backs the Reports tab's "Attribute Extraction Usage"
  document, over `session_attribution_runs` (every evaluation attempt, including `failed`
  ones) rather than over sessions carrying resolved `values` — hence
  `supportsAttributeFilter: false`: a `failed` run has no `values` to
  filter on. Required `startDate`/`endDate`, optional `teamId`, `branches`, `users`, repeatable
  `outcome=applied|ignored_stale|failed` (400 on any other value). Single-query scan — the
  runs table carries its own cost/token columns, never joined via `session_stats` (same shape
  as `turn_end_advisor_runs`), and `sessionAttributionRuns.sessionId` is already the invoking
  session's own row id, so one join straight to `sessions`/`logs`/`log_repositories`/`users`
  gets both the transcript id (for the top-sessions list) and the repo/branch/user scope.
  Date scope is applied against the run's own `started_at`, not the invoking session's
  `start_time` — population here is evaluation events, which can span many days for one
  repeatedly-re-evaluated session. Response: `evaluationCount` (every run in scope) and
  `distinctSessionCount` (unique invoking sessions among those runs) are named and documented
  explicitly so `evaluationCount >= distinctSessionCount` reads as expected, not a
  data-quality signal — a session is re-evaluated at each new prompt watermark, so it
  contributes one run per evaluation, not one run total; plus `totalCostUsd`/`avgCostUsd`, an
  always-3-row `outcomeBreakdown` (count/cost per fixed outcome, `0` when absent), an
  ascending UTC `byDay` series (no gap-filling — only days with at least one run appear), and
  `topReevaluatedSessions` (top 10 invoking sessions by evaluation count, cost desc tie-break).
- `GET .../session-attribution/values` — feeds the session-list
  attribute-filter popover. Query: optional `teamId`, `startDate`, `endDate` (same
  together-or-neither rule as `sessions/branches`). Response:
  `{ [attributeKey: string]: { value: string | boolean | number, sessionCount: number }[] }`,
  each attribute's list capped at 50 entries ordered by `sessionCount` desc. Reads
  `session_attribution.values` directly via `jsonb_each()` (own query, independent of the
  possibly-`attr=`-filtered session list) — a `string[]`-typed attribute fans out, each array
  element becoming its own bucket (matching the `any` operator's element-match semantics),
  deduplicated per session. Explicit `null` ("not determined") and any orphaned value
  (`isOrphanedValue()`) are excluded; an attribute with zero attributed sessions in scope simply
  has no key in the response.
- **Session cost = Log Hub's computed cost (2026-10-26; replaces the earlier "OTEL-preferred" rule and its 50% amendment).** `totalCost` in `getRepositorySessions()`, `getAnalyticsTimeline()`, `ReportsController.getExecutiveSummary()` (and the attribution breakdown, the turn-end advisor's `sessionCostUsd` and `captureAuditRows()`'s archived cost) is the complete computed tree cost — root + every sub-agent with a transcript + utility calls (`otel_api_calls` no transcript records, priced per call with prompt-length tiers), all at Log Hub's own prices — loaded through `session-tree-cost.sql.ts` (`treeCostCtes()` / `loadTreeCostRows()` + `readTreeCost()`) and resolved by `resolveSessionTotalCost(parts)` in `otel-cost.sql.ts`: `null` as soon as any part is unpriced (`costUnavailableReason: 'unknown-model'`, model ids in `costBreakdown.unpricedModels` / the timeline's and top sessions' `unpricedModels`). The OTEL total is never used as the shown cost: Claude Code priced `claude-haiku-5-5` (a model it does not know) at Opus 5.5 rates, $2.85 instead of $0.19, and OTEL carries such a number with no marker. It stays a cross-check: `hasCostDiscrepancy` (`otelComputedDiscrepancy()`, 33%+) and `costBreakdown.mismatch` (`costMismatch()`). `getRepositorySessions()` returns `computedCost` = `totalCost`. Unit-tested in `otel-cost.sql.algo.spec.ts` (rows in `algorithms/otel-cost-selection.md`).
- `GET .../sessions/:sessionId/logs` response now includes `workflows: WorkflowRun[]` — workflow runs extracted server-side from the claude log events using `extractWorkflows()` from `server/src/logs/workflow-extractor.ts`. Each entry also carries `wfId: string | null` (extracted from the completion notification's `<diagnostics>` tag) and `agentSessionIds: string[]` (full multi-level agent linkage — the workflow's direct agents, matched via `sessions.workflow_run_id === wfId`, plus their own regular Task-tool sub-agents at any depth) — resolved in `getSessionLogs()` via a `wfId → directAgentIds[]` map and a BFS over the same owner-scoped `descendantIds` already computed for `subagents`, so no new access-control path is introduced. Empty array when `wfId` is null (running workflow) or unresolvable (legacy/pre-migration session).
- `GET .../sessions/:sessionId/logs` — Owner-only, with a team-owner exception: non-owner callers receive 403 Forbidden (the app admin role grants no exception), **unless** the request includes `?teamId` and the caller is the owner of that team (`RepositoriesService.isTeamOwner(userId, teamId)`) — that caller may fetch any team member's session logs. The owner is determined by the `userId` on the session's artisyn log row.
- `GET .../sessions/:sessionId/logs` — response gains `turnEndAdvisor: { generatedAt, summaryGeneral, costFactors, harnessAdvice } | null`, the latest `outcome='submitted'` row from `turn_end_advisor_runs` for this session (`null` when never successfully evaluated). This is deliberately the only session-detail surface for the advisor result; there is no separate route. `turnEndAdvisor` additionally gains `model: string | null`, `costUsd: number | null` (`Number()`-converted from the numeric-string column), and `inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens: number` (default `0`, matching the column defaults) — sourced straight from the same `turn_end_advisor_runs` row.
- `GET .../sessions/:sessionId/logs` — response gains `sessionAttribution`,
  everything the session detail attribution row needs to derive its state (feature off -> failed
  -> unevaluated -> stale -> evaluated, in that priority order) with no extra fetch:
  `{ enabled, attributes, values, evaluatedWatermark, currentWatermark, lastRun }`. `attributes`
  is this repo's resolved definitions (`SessionAttributionService.resolveDefinitions()`, so chips
  can render before any evaluation has run); `values` is the current `session_attribution.values`
  with orphaned entries stripped, `null` if never evaluated;
  `evaluatedWatermark` is `session_attribution.prompt_watermark` (`null` if `values` is `null`);
  `currentWatermark` is `session_prompt_watermark.prompt_watermark` (`null` if the combined
  `post-turn-analysis/config` GET has never run for this session) — `currentWatermark >
  evaluatedWatermark` is the "stale" signal; `lastRun` is the most recent
  `session_attribution_runs` row (`{ outcome, finishedAt, failureReason }`, `null` if no
  evaluation attempt has ever been recorded), independent of whether it actually changed `values`.
- `GET .../sessions/export-scope` — lists sessions in scope for the "Session Statistics Export" feature (Settings tab). Required `from`/`to` (ISO 8601 date-time query params, inclusive bounds on `logs.startTime`), optional `teamId`, optional `userId` filter. Privileged: personal view requires `assertRepoAccess`'s owner check; team view additionally requires the caller be that team's owner (`ForbiddenException` otherwise; no admin bypass) — this is deliberately stricter than the plain `getRepositorySessions` listing, because the result **bypasses** the team access mode (returns every matching member's sessions, prompts intact, even in a `restricted` team). Its one concession to the access-mode work: members whose `disclosure_acknowledged_at IS NULL` are excluded from the result set, the same `visibleUserIds` predicate the listing uses. Authorization is unchanged, so no `manager` or plain member ever reaches it. Delegates to `RepositoriesService.getSessionsForExport()`. Response: `ExportSessionRow[]` — `{ sessionId, firstPrompt, startTime, endTime, userId, userEmail }[]`.
- `POST .../recompute-all-sessions` — "Recompute all sessions" maintenance action. Optional `?teamId` query param; same authorization shape as `export-scope` above (team owner in team view, repo owner in personal view via `assertRepoAccess`; no admin bypass). Calls the existing `recomputeForRepo(repoId, { teamId } | { userId })` (recomputes `session_file_stats`/`session_cause_stats`, scoped; the team branch is `recomputeTeamScope(teamId, repoUrl)` — every session tree on the repo's `repo_url`, with the team's `team_repo_config` or, when it has none, the default categories and threshold, so rows are rewritten rather than deleted) followed by the new `recomputeAllSessionStats(repoId)` (recomputes `session_stats` for every session linked to the repo, unscoped — that table has no team/user column). Response: `{ recomputed: number }`.
- `GET .../analytics/timeline` response now includes `isFavorite: boolean` per session (true when the authenticated user has favorited the session).
- `GET .../analytics/timeline` also returns four always-present, default-`0` cache fields per session: `cacheReadTokens`/`cacheWriteTokens` (the root's own `session_stats`, falling back to the session-events aggregate) and `descendantCacheReadTokens`/`descendantCacheWriteTokens`, summed by a `subagent_cache` CTE over `descendant_sessions WHERE depth > 0` (the same recursive pattern as `subagent_costs`) and `LEFT JOIN`ed on `root_id`. Tokens only — the client computes the ratio itself, as ratio-of-sums, for the "Cache Read Ratio" analytics view.
- **Team access-mode gate** — every team-scoped read path (`?teamId` present) resolves one shared
  scope object instead of the old `allow_member_session_visibility` boolean:
  `RepositoriesService.resolveTeamScope(user, teamId)` → `TeamScope`
  (`server/src/logs/team-scope.ts`). It carries `accessMode`
  (`transparent`\|`restricted`, from `teams.access_mode`), a three-state `visibility`
  (`own-only` \| `team-no-prompts` \| `team-with-prompts`), `visibleUserIds` (the row filter on
  `logs.user_id`; `null` = emit no user predicate at all), `analyticsAllowed`, and the caller's
  `isTeamOwner`/`isManager`/`isAdlcTrainer` flags. One query joins `teams` to the caller's
  `team_members` row; a second resolves `visibleUserIds` only for a team-wide `restricted` scope.

  | caller | `visibility` | `analyticsAllowed` |
  |---|---|---|
  | `teamId` absent (personal view) | `own-only` | `true` |
  | mode `transparent`, any caller | `team-with-prompts` (`visibleUserIds: null`) | `true` |
  | `restricted` — team owner | `team-with-prompts` | `true` |
  | `restricted` — ADLC trainer **+** manager | `team-with-prompts` | `true` |
  | `restricted` — ADLC trainer only | `team-with-prompts` | `false` |
  | `restricted` — manager only | `team-no-prompts` | `true` |
  | `restricted` — plain member, or a non-member reaching in | `own-only` | `false` |

  Role flags are consulted **only** while the mode is `restricted` — a `transparent` team is
  bit-identical to yesterday's `allow_member_session_visibility = true`, so no role grant can
  alter it. For a team-wide `restricted` scope `visibleUserIds` is the caller's own id unioned
  with every `team_members.user_id` in that team whose `disclosure_acknowledged_at IS NOT NULL`:
  a member who has not acknowledged the access-mode disclosure is invisible even to the team
  owner and to trainers.

  Three consequences for route behaviour:
  - **List/aggregate routes row-filter** (`getRepositorySessions()`,
    `getRepositorySessionBranches()`, `getSessionContexts()`, `getAnalyticsTimeline()`,
    `getAnalyticsWorkTime()`, the reports) — a plain member sees a filtered list, not a 403.
  - **The per-session `:sessionId` routes 403** (`assertSessionVisible()`) when the
    session's owning `logs.user_id` is neither the caller's own nor in `visibleUserIds`. This
    flipped `.../sessions/:sessionId/contexts` from "empty payload" to a real 403. A `null`
    `visibleUserIds` (transparent) skips the check entirely.
  - **Analytics and report routes 403 when `analyticsAllowed` is false and `teamId` is present**
    — i.e. for a plain member and for a trainer without the manager role. The gate is applied
    once per controller at scope resolution (`usage-analytics.controller.ts`'s `resolveScope`,
    `reports.controller.ts`'s `resolveReportScope`, and inline on `analytics/timeline`,
    `analytics/change-surface`, `analytics/work-time`). The session-list support routes
    (`sessions/branches`, `session-attribution/values`, `sessions/:sessionId/contexts`) are
    deliberately **not** analytics-gated — a plain member needs them for their own sessions;
    they still row-filter (and, where they name one session, still run the visibility check
    above).

  **Prompt masking is a projection concern, never a `WHERE` clause.** `maskFirstPrompt(scope,
  requesterId, rowUserId, value)` returns `null` when `visibility === 'team-no-prompts'` and the
  row belongs to someone else; it is applied in each `.map()` that builds a response row.
  `l.first_prompt IS NOT NULL` is the root-session discriminator at 20+ sites, so masking it in
  SQL would delete whole sessions from a manager's lists instead of hiding their text. A `null`
  `firstPrompt` on a team-scoped payload therefore means "hidden", never "absent".

  `getSessionLogs()` (raw logs) gains one clause: in a `restricted` team a `team-with-prompts`
  caller whose `visibleUserIds` contains the session owner may read the conversation, and the
  pre-existing team-owner exception now also requires that membership to be acknowledged. A
  `manager` resolves to `team-no-prompts` and still 403s. `getRepositoryContexts()` stays
  owner-only regardless. None of these routes has an app-admin bypass (removed by
  `2026-10-21-private-repo-visibility`).
- `GET .../sessions/branches` — gained optional `startDate`/`endDate` query params (ISO 8601;
  both must be provided together or the request 400s). When present, the branch aggregation is
  filtered by `logs.start_time`; when omitted, behaviour is unchanged (all-time aggregates) — existing
  callers (`useNewSessionPoll.ts`, `SessionListPanel.tsx`) keep working unmodified.
- `GET .../reports/executive-summary` (`server/src/logs/reports/reports.controller.ts` +
  `executive-summary.service.ts`) — backs the Reports tab's "Executive Summary"
  document. Required `startDate`/`endDate` (ISO 8601), optional `teamId`, `branches`
  (comma-separated), `users` (comma-separated, emails). Cost is a two-phase rollup: each session's own
  `session_stats` tokens (Phase A) plus the summed cost of every descendant sub-agent session under it
  (Phase B, `descendantSessionsCte`/`subagent_costs`, same CTE pattern as
  `repositories.controller.ts`) — `total_cost` is redefined once as `(ownCost ?? 0) + subagentCost`
  before any aggregate is built, so `totalCost`/`weeklyBuckets`/`modelMix`/`topSessions`/
  `engineerBreakdown` all read that single rolled-up value
  (`sum(engineerBreakdown[].totalCost) === totalCost`, same for `weeklyBuckets`).
  `excludedSessionCount`/`excludedModels` are computed from the pre-rollup own-pricing check only
  (whether the session's own model matched `model_pricing`), independent of the rollup.
  `ExecutiveSummaryService.build()` extracts the Phase A+B query pair into a private
  `computePeriodAggregates()` method, called twice per request — once for the requested range, once
  for the immediately preceding window of equal length (`previousPeriod`) — keeping the endpoint at a
  fixed number of round trips regardless of session count. Response:
  `{ totalCost, totalSessions, activeUsers, teamSize: number | null, avgCostPerSession,
  totalLinesChanged, avgCostPerLine, avgLinesPerHour, avgSessionLengthMs, excludedSessionCount,
  excludedModels: string[], previousPeriod: { totalCost, totalSessions, activeUsers,
  avgCostPerSession } | null,
  weeklyBuckets: { weekStart, sessionCount, totalCost }[],
  modelMix: { model, sessionCount, share, cost, costShare }[],
  topSessions: { startTime, userEmail, branch, workTimeMs, cost, model, inputTokens, outputTokens,
  cacheReadTokens, cacheWriteTokens }[],
  engineerBreakdown: { userEmail, sessionCount, share, totalCost, avgCostPerSession,
  avgSessionLengthMs, costPerLine, linesPerHour, subAgentsPerSession }[],
  advisorSpend: { evaluationCount, distinctInvokingSessions, costUsd },
  attributionSpend: { evaluationCount, distinctInvokingSessions, costUsd } }`.
  `advisorSpend` is a sibling KPI section, not part of the
  `totalCost` rollup above — a straight join of `turn_end_advisor_runs` to `sessions`/`logs` scoped
  by the SAME repo/date/branch/user/owner filters `computePeriodAggregates()` applies (its own
  private `computeAdvisorSpend()` method, called once per request, not per previous-period window).
  `evaluationCount` counts every run row in scope regardless of `outcome` (a `'failed'` attempt's
  incurred cost still counts); `distinctInvokingSessions` is `COUNT(DISTINCT session_id)`;
  `costUsd` sums `turn_end_advisor_runs.cost_usd` directly (own cost columns, never joined via
  `session_stats`). No `hook_service` marker scan needed, unlike Part B's analogous
  `attributionSpend` section — `turn_end_advisor_runs.session_id` already is the invoking session.
  `attributionSpend` is `advisorSpend`'s sibling
  KPI tile — same shape, same "sits alongside, never merges into, `totalCost`" rule, its own
  private `computeAttributionSpend()` method. Joins `session_attribution_runs` through its own
  `invoking_session_id` column (a plain string, NOT the run row's `session_id` FK) to
  `sessions`/`logs` for repo/branch/user/date scope, because that column exists specifically so
  this section can resolve the invoking session's context the same way the `hook_service` marker's
  own `invoking_session_id` field would — without re-scanning `logs.body` on every report load (see
  `db-tables.md`'s `session_attribution_runs` entry). A run row with `invoking_session_id IS NULL`
  (a marker written before the field existed, or one that never resolved) is excluded rather than
  guessed at. `costUsd` sums `session_attribution_runs.cost_usd` directly (own cost columns); no
  extra `hook_service_type` discriminator is needed in the query since the run table's population
  is exclusively `session-attribution` evaluation attempts already (Part A's advisor never writes
  to it).
  `weeklyBuckets` are ISO weeks (Monday–Sunday, UTC); the first/last bucket is shortened to the
  selected date range instead of overflowing into adjacent weeks. `teamSize` is `null` when no
  `teamId` is supplied (personal repo view). `topSessions` is the top 5 sessions by cost descending —
  date/engineer/branch/duration/cost/model/tokens/cache-tokens only, no prompt text (the "Top 5 Sessions by Cost"
  table). `engineerBreakdown` groups the
  same session rows by `user_email` (no display-name lookup available), sorted by `totalCost` desc; `share` is this user's
  share of report `totalCost` (cost-based, not session-count-based); `costPerLine`/`linesPerHour` use
  the exact same formulas as the report-level `avgCostPerLine`/`avgLinesPerHour`, scoped per user;
  `subAgentsPerSession` is `sum(descendant-session count across this user's root sessions) /
  sessionCount`. `modelMix[].cost`/`costShare` attribute a root session's whole rolled-up total to its
  own (first-observed) model, same basis as `share`/`sessionCount`. `previousPeriod` is `null` exactly
  when the preceding window has 0 sessions, which the client uses to suppress all KPI-tile deltas at
  once.
- `GET .../reports/cache-read-ratio` (`reports.controller.ts` +
  `reports/cache-read-ratio.service.ts`) — backs the Reports tab's "Cache Read Ratio" document.
- **`GET .../reports/harness-usage` (`reports.controller.ts` +
  `reports/harness-usage.service.ts`)** — backs the Reports tab's "Harness Usage" document.
  Cache-read-ratio-shaped: same `teamId`/`startDate`/`endDate`/`branches`/`users` query params,
  own `groupBy` whitelist (`HARNESS_USAGE_GROUP_BY_VALUES` — `none`|`branch`|`user`, any other
  value 400s). One row per harness element (skill/rule/MCP server/tool) the repo(s) have ever
  self-reported (`harness_elements`), merged with real per-session usage/token facts
  (`session_harness_usage`, summed over each root session's recursive descendant tree via
  `descendantSessionsCte()`, same Phase A/Phase B split as `cache-read-ratio` and the usage analytics). Team-linked
  repos each hold their own `harness_elements` copy of the same inventory; `loadInventory()`
  dedupes across every repo id in scope, taking the freshest report's `mcp_connected`/
  `schema_size_tokens` (last-self-report-wins) while widening `first_seen`/`last_seen` bounds
  across all of them. `inventoryReported` is `harness_inventory_reported_at IS NOT NULL` OR'd
  across every repo id in scope — `false` drives the report's empty state (no fallback to
  usage-only rows, since without an inventory "0 uses" can't be told apart from "not tracked").
  `mcp`-kind rows are never stored with their own usage — their `uses`/tokens are a rollup of
  their `tool`-kind children sharing the same `mcpServer` name, computed in
  `mergeInventory()`/`buildGroups()`, not persisted redundantly.
- **Change surface — four endpoints, three services, one metric.** All four resolve access
  exactly as `sessions/:sessionId/contexts` does, and none of them computes a metric of its own:
  every number comes out of the single `computeChangeSurface()` fold in
  `server/src/logs/change-surface/change-surface-metrics.ts`. The two session routes go through
  `ChangeSurfaceService`; `analytics/change-surface` and `reports/change-surface` both go through
  `ChangeSurfaceAggregateService.build()` (the report just pins `bucket: 'week'`), and the report
  layers `ChangeSurfaceReportService` on top for its medians and its two
  `repo_code_inventory` percentage denominators. Every scope — a session tree, a report period,
  a chart bucket, a `groupBy` group — is a **union recomputation** over distinct changed paths,
  never a `SUM`, which is why grouped rows legitimately do not add up to the repo row. Absent
  data is always `computed: false` / `null`, never `0`. See
  [`change-surface.md`](change-surface.md).
- **Usage analytics — eight endpoints, four services, two controllers.** The four
  `analytics/*` routes live in a NEW controller `server/src/logs/analytics/usage-analytics.controller.ts`
  (added because `repositories.controller.ts` is already ~2,050 lines); the four `reports/*` routes
  are on the existing `ReportsController`. **Each `reports/*` route delegates to the same service as
  its `analytics/*` counterpart and returns a byte-identical DTO** — an e2e test asserts the two
  responses are `toEqual`, so a report document can never disagree with its analytics view.
  - Services: `analytics/tool-analytics.service.ts`, `token-analytics.service.ts`,
    `productivity-analytics.service.ts`, `active-sessions.service.ts`.
  - Shared query parsing: `analytics/analytics-query.ts` (`parseAnalyticsQuery`,
    `parseActiveSessionsLimit`) — the same `teamId`/`startDate`/`endDate`/`branches`/`users`
    validation the executive-summary and cache-read-ratio routes do, extracted so the eight new
    routes cannot drift from each other. `startDate`/`endDate` are **required** (400 otherwise).
  - Shared session selection: `analytics/scoped-sessions.sql.ts` — Phase A selects the filtered
    *root* sessions under the same guard, ownership assertion and team access-mode scope
    (`AnalyticsScope.scope: TeamScope`, replacing the old `teamVisibilityEnabled` boolean) as the
    existing analytics endpoints — its projection also selects `logs.user_id` so services can
    mask prompts per row; each service then runs its own Phase B rolling up
    `descendantSessionsCte()` (the recursive sub-agent tree) keyed on those root ids. Sub-agents
    hold ~62% of all `tool_use` blocks on live data, so a root-only figure would report near-zero
    tools for any agent-driven session. Each root's tree is counted exactly once: a sub-agent
    uploaded standalone can never be a Phase A root, because Phase A requires an `artisyn` log row.
  - **No route in this module parses `logs.body`** — every figure reads the pre-computed
    `session_stats` / `session_tool_stats` columns (no request-time `logs.body` parsing). Histograms and `duration_by_source`
    are summed inside Postgres rather than shipping one row per `(session, tool)`.
  - `analytics/active-sessions` and `reports/active-sessions` additionally accept `limit`
    (default 100, max 500; out-of-range → 400) and return `{ sessions, limit, truncated }`.
  Required `startDate`/`endDate` (ISO 8601), optional `teamId`, `groupBy` (`none`|`branch`|`user`,
  whitelisted in the controller — any other value 400s), `branches`, `users`. Validation, access
  and team-visibility resolution copy `getExecutiveSummary()` verbatim.
  Two extra controller-side resolutions run before the service is called, both on
  `RepositoriesService`: `getEffectiveCacheThreshold(userId, repoUrl, teamId?)` →
  `{ threshold, source: 'user'|'team'|'default' }` (team view: team T's `team_repo_config` →
  the `DEFAULT_HIGH_CACHE_CREATION_THRESHOLD` constant; personal view: personal `repo_config` →
  the lowest-id team's `team_repo_config` → the constant), and
  `resolveCauseStatsScope(userId, teamId?)` → which `session_cause_stats` rows to read
  (`{ teamId }` in team view, `{ userId }` in personal view — ingest writes a team row set for
  every team linking the URL and always the uploader's personal row set).
  The service is three phases: Phase A one per-session query (root cache/TTL columns + the
  `LATERAL` `model_pricing` join with `REGEXP_REPLACE(model, '-[0-9]{8}$', '')`), Phase A2 a
  `LEFT JOIN session_cause_stats` restricted to the resolved scope (non-matching sessions counted
  as `sessionsWithoutCauseData`, not dropped), Phase B a descendant cache/TTL rollup via
  `descendantSessionsCte` with `depth > 0`. Day bucketing and every aggregate happen in TypeScript
  (`aggregateScope`/`bucketByDay`, exported for unit tests), matching
  `executive-summary.service.ts` — buckets are fixed UTC days regardless of `groupBy`.
  Response: `{ root, withDescendants, buckets[], groups?, causes }` — see `api-reference.md` for
  the full shape. Every ratio is ratio-of-sums and is `null` (never `0`) at a zero denominator;
  `causes` is root-only by design and echoes the requester's `thresholdTokens`/`thresholdSource`,
  so two callers with different thresholds get different splits from identical parameters.
- **One tree rollup for every `session_stats` counter.** `server/src/logs/session-tree-metrics.sql.ts`
  is the single definition of the additive `session_stats` rollup over a session tree, and the
  only place a new tree-scoped counter is added. Two entry points, one SQL body: `treeMetricsCte()`
  (CTE named `SESSION_TREE_METRICS_CTE`, for a caller that already builds `descendant_sessions` —
  `getAnalyticsTimeline()`, `executive-summary.service.ts` Phase B, and
  `productivity-analytics.service.ts`'s `loadTreeCounters()`, whose hand-written twin was
  refactored onto it) and `loadTreeMetricsByRoot(db, rootIds)` (one batched query for a caller
  with no such CTE — `getRepositorySessionBranches()`: the per-branch
  aggregate also `ARRAY_AGG`s its session ids, which are flattened into one call and folded back
  in TS, so no N+1).
  - It carries **no `depth` predicate**, so its totals already include the root. Combining a tree
    total with a root-own value goes through `withOwnFallback(tree, own)`, which adds the own
    value only when `root_counted` is false (root with no `session_stats` row, or one the
    OTEL-only `EXISTS` guard excluded) — anything else double counts.
  - `session_stats` writes are untouched: no schema change, no migration, no ingest change. Every
    tree figure is computed at read time (`docs/knowledgebase/session-metrics-scope.md` § 4).
  - Temporal columns are deliberately absent from the rollup: `work_time_ms` /
    `total_work_time_ms` stay root-only because sub-agents run inside the root's wall-clock span.
  - `image_count` / `mcp_calls_total` are returned by the rollup but no endpoint consumes them
    yet — those two counters are still root-only on the wire (follow-up).
  - `server/src/logs/edit-tools.ts` exports `EDIT_WRITE_TOOL_NAMES` (`Edit`, `Write`, `MultiEdit`),
    now the only list `claude-extractor.ts` and the timeline's raw-JSONB fallback CTE use — the
    fallback was missing `MultiEdit`, which is why a root's own lines could differ from the
    ingested value.
- `PUT .../settings/team` / `PUT .../settings/user` — `RepoConfigJson` gained optional
  `highCacheCreationThreshold`; `validateConfig` rejects a non-integer or an out-of-bounds value
  (`CACHE_CREATION_THRESHOLD_MIN`…`_MAX` from `server/src/logs/cache-ratio.sql.ts`) with a `400`.
  No new route: both PUTs already carry the whole config blob. `settings/user` calls
  `recomputeForRepo()`, `settings/team` calls `recomputeTeamScope(teamId, repoUrl)`; both re-run
  `walkTurns` + `classifyTurnCauses` and upsert that scope's `session_cause_stats` rows. A
  deleted **team** config rewrites that team's rows with the defaults for every session tree on
  the repo's `repo_url` (descendants included); a deleted **personal** config rewrites that
  user's `session_file_stats` rows with `DEFAULT_FILE_CATEGORIES` and deletes their cause rows.
- **Team vs personal config (2026-10-16).** Personal configs live in `repo_config` (looked up by
  `(repoUrl, userId)`), the single team config of a (team, URL) pair in `team_repo_config`
  (`server/src/logs/team-repo-config.ts`). `GET :repoId`, `GET :repoId/settings` and
  `PUT :repoId/settings/team` accept an optional `?teamId` (positive int, else 400). With it,
  access is `assertRepoAccess(user, repoId, teamId)` (membership + link, no admin bypass) and
  the config is team T → default (personal ignored); `PUT settings/team?teamId=T` writes exactly
  T's config and only for T's owner (403 `'Only the team owner can edit team config'`, no admin
  bypass). Without it, access is personal ownership and the fallback is personal → the caller's
  lowest-id team linking the URL → default; `PUT settings/team` writes the caller's lowest-id
  owned team. `userConfig` is always the caller's own. The analytics timeline reads
  `sfs.team_id = T` in team view and `sfs.user_id` = caller in personal view.
  `resolveDefinitions(userId, repoUrl, teamId?)` (session attribution) gets `teamId` from every
  controller that has it.
- `GET /api/v1/repositories` — lists repos the caller either **owns** (`repositories.userId`) or **authored logs for** (`logs.userId`) — left-joined and OR'd together, so a repo you own with zero logs still appears (e.g. right after a fresh import), and a repo you don't own but personally uploaded sessions to also appears. These two can diverge: `repository-export-import.service.ts`'s `importOneSession()` sets the importing user as the repo owner while preserving the original author's identity (resolved from the archive's `userEmail`) on the imported `logs` rows, so an imported repo's owner and its logs' author are legitimately different people.
- `GET /api/v1/repositories/hooks` — **declared before** `@Get(':repoId')` in the controller (Nest/Express match routes in declaration order; a `'hooks'` handler declared after `:repoId` would be swallowed by it and 400 via `ParseIntPipe`). No params — lists the caller's own hook-reporting repos via `req.user`. Response: `{ id, repoUrl, hookVersion, outdated, issueCount }[]`, filtered to `hookVersion IS NOT NULL`, ordered by `repoUrl`. Delegates to `HookStateService.listHookRepositories()`.
- `GET .../:repoId/hook-state` — same `assertRepoAccess(user, repoId, teamId?)` guard as sibling `:repoId` endpoints (optional `?teamId`). Delegates to `HookStateService.getHookState()`; 404s (`NotFoundException`) when the repo has never reported a `hook-status` event (`hookVersion IS NULL`). Response: `{ repoUrl, hookVersion, latestVersion, outdated, lastActivity, logTail: string[], nonUploadableLogs: {file,reason}[], recommendations: {rule,message,detectedAt}[], errors: string[] }`.

---

## `/api/v1/repositories` (export/import)

**File:** `server/src/logs/repository-export-import.controller.ts`

New sibling controller to `RepositoriesController` — not more methods on it.

| Method | Path | Handler | Auth |
|---|---|---|---|
| GET | `/api/v1/repositories/:repoId/export-import/scope` | `getScopeSummary()` | SessionAuthGuard |
| POST | `/api/v1/repositories/:repoId/export` | `startExport()` | SessionAuthGuard |
| GET | `/api/v1/repositories/:repoId/export/:jobId/status` | `getExportStatus()` | SessionAuthGuard |
| GET | `/api/v1/repositories/:repoId/export/:jobId/download` | `downloadExport()` | SessionAuthGuard |
| POST | `/api/v1/repositories/:repoId/import/upload` | `uploadImportZip()` | SessionAuthGuard |
| POST | `/api/v1/repositories/:repoId/import/:uploadToken/confirm` | `confirmImport()` | SessionAuthGuard |
| GET | `/api/v1/repositories/:repoId/import/:jobId/status` | `getImportStatus()` | SessionAuthGuard |
| POST | `/api/v1/repositories/bootstrap-import/upload` | `uploadBootstrapImportZip()` | SessionAuthGuard |
| POST | `/api/v1/repositories/bootstrap-import/:uploadToken/confirm` | `confirmBootstrapImport()` | SessionAuthGuard |
| GET | `/api/v1/repositories/bootstrap-import/:jobId/status` | `getBootstrapImportStatus()` | SessionAuthGuard |

**Notes:**
- **Team-owner-only access rule**: every handler here calls `RepositoriesService.assertRepoOwnerOrTeamOwner(user, repoId, teamId?)` first — a *stricter* gate than the plain `assertRepoAccess` used by the rest of `/api/v1/repositories`. Without `teamId`, the caller must personally own the repo (same as `assertRepoAccess`). With `teamId`, the caller must be that team's **owner** (no admin bypass) — a regular team member who merely has session-visibility access is 403'd. `teamId` is threaded through every route (query param on GETs, body field on POSTs); omitting it on a team repo call falls through to the personal-owner branch and would wrongly 403 a legitimate team owner.
- `GET .../export-import/scope` — session-count + approximate-uncompressed-size preview for one export/import scope, computed synchronously (no job row). Query: `teamId?`, `scope` (`all`\|`dateRange`\|`sessionIds`), `from?`/`to?` (ISO, required when `scope=dateRange`), `sessionIds?` (comma-separated, required when `scope=sessionIds`). Response: `{ sessionCount: number, approxUncompressedBytes: number }`. `approxUncompressedBytes` is a `SUM(octet_length(logs.body::text))` approximation, not a byte-exact re-serialized size.
- `POST .../export` — creates an `exportImportJobs` row (`kind: 'export'`, `status: 'running'`) then fires `RepositoryExportImportService.runExportJob()` **without awaiting** it, responding `202 { jobId }` immediately. Body: `{ teamId?, scope, from?, to?, sessionIds?, description? }`. The background job batches sessions (`EXPORT_IMPORT_CHUNK_SIZE = 25`), yielding the event loop between batches, and zips `meta.json` + one `sessions/<sessionId>/{session.json,claude.jsonl,artisyn.jsonl}` per session via `archiver`.
- `GET .../export/:jobId/status` / `GET .../import/:jobId/status` — poll the `exportImportJobs` row. Response: `{ status: 'staged'|'running'|'done'|'error', processed: number, total: number, errorMessage?: string }`. 404 if the job doesn't exist, doesn't belong to `:repoId`, or is the wrong `kind` — the export route only resolves `kind: 'export'` rows, the import route only resolves `kind: 'import'` rows (a still-`staged_upload` row, not yet confirmed, 404s on the import status route too).
- `GET .../export/:jobId/download` — streams the finished zip via `res.download()` (mirrors `admin-panel.controller.ts`'s `downloadLogsArchive()`). 409 (`ConflictException`) if the job isn't `status: 'done'` yet. A GET must not change state (open-source readiness): the zip and its job row are left in place — a repeated download returns the same zip — and both are reaped by `ExportImportJobCleanupScheduler` after the job TTL. A stream failure is only logged.
- `POST .../import/upload` — `multipart/form-data`, field `file`. Uses `FileInterceptor('file', { storage: diskStorage(...) })` staging straight to `resolveExportImportStagingDir()`; the disk-generated filename (`<randomUUID()>.zip`) doubles as the `uploadToken` (no separate token→path table). Immediately inserts a `kind: 'staged_upload'`, `status: 'staged'` `exportImportJobs` row keyed by that token, then streams just `meta.json` out of the zip (`yauzl`, no full-archive buffering) to validate `formatVersion` and compute the preview. Response: `{ uploadToken, sessionCount, approxUncompressedBytes, meta }`. 422 (`UnprocessableEntityException`) on a malformed zip, missing `meta.json`, or an unsupported `formatVersion` — the staged row is marked `status: 'error'` in that case (still swept after 30 min like any other terminal row). After the `meta.json` parse, the private guard `assertNoImportConflicts(uploadToken, filePath, user)` calls `RepositoryExportImportService.findImportConflicts()`, which reads every `sessions/<id>/session.json` (lazy `yauzl`, same zip-slip guard and entry limits as the job): any error it throws (`ImportArchiveInvalidError` for an invalid `session.json` or a duplicate `sessionId`, an unsafe path, an import limit) → `fail()` + **422**; any ownership conflict (`foreign-session`, `foreign-author`, `foreign-parent`, see [session-export-import.md](session-export-import.md#ownership-conflicts)) → `fail()` + **409** `{ statusCode, error: 'Conflict', message, conflicts: [{ sessionId, reason }] }` (`HttpExceptionFilter` passes `conflicts` through). The importer is `req.user.id` — no admin bypass. Under `AUTH_MODE=none` the validation (422) still runs but no conflict query and never a 409.
- `POST .../import/:uploadToken/confirm` — looks up the `staged_upload` row by `uploadToken` (404 — "uploadToken has expired or was never staged" — if missing, wrong `repoId`, or wrong kind; 404 with the row's stored `errorMessage` if it is no longer `status: 'staged'`, e.g. an upload already blocked by a 409/422, so a second confirm repeats the same text), re-validates `meta.json` (defensive re-check against a stale/corrupted staged file), re-runs `assertNoImportConflicts` against the confirmer (409/422 as on upload), updates the row **in place** to `kind: 'import'`, `status: 'running'` (same row id, now the `jobId`), then fires `RepositoryExportImportService.runImportJob()` without awaiting, responding `202 { jobId }`. Body: `{ teamId? }`. The background job extracts each session's files from the zip (zip-slip-guarded — any entry path starting with `..` or absolute aborts the whole job with an error status), resolves each log's original owner by **email** (`meta.logs.<type>.userEmail`) via `LogsService.resolveOrCreatePlaceholderUserByEmail()` — an unknown email gets an unauthenticatable placeholder `users` row; an existing own session skips author resolution and keeps the importer as owner — and writes via `LogsService.importSession()` (one transaction per session: `session-owner:` advisory lock, deleted check, owner guard), applying the keep-longer merge for a `(sessionId, logType)` that already exists locally (overwrites only when the incoming array is strictly longer). A `foreign-session` result from the in-transaction guard (a race after confirm) fails the job with `importConflictRaceMessage()`; sessions written before it stay. Under `AUTH_MODE=none` no author is resolved, no placeholder is created and every log of each imported session (`logs` + `logs_otel`) is reassigned to the importer.
- Staged uploads, in-progress export zips, and finished export zips not yet downloaded are all swept by `ExportImportJobCleanupScheduler` (`@Interval`, every 5 min by default) once their row is 30+ minutes old (`done`/`error`/`staged` only — an in-flight `running` row is never swept). The same tick also unlinks orphaned files: zips in the staging dir (`EXPORT_IMPORT_DIR`, dev fallback `server/export-import/`) that no row references and whose mtime is older than the TTL — rows vanish without their file when a user or repo is deleted (`ON DELETE CASCADE`).
- **"Bootstrap import"** (`bootstrap-import/...`) — the three routes above with no existing target `repoId`: unlike every other handler on this controller, they don't call `assertRepoOwnerOrTeamOwner` (there's nothing to check access on yet). `uploadBootstrapImportZip()`/`getBootstrapImportStatus()` mirror the per-repo `uploadImportZip()`/`getImportStatus()` exactly, scoped by `userId` instead of `repoId` (the `staged_upload`/`import` job row is created with `repoId` left `null` until confirm). `confirmBootstrapImport()` applies the same non-`staged` 404 and re-parses `meta.json` to read `meta.sourceRepoUrl`; both bootstrap upload and confirm run `assertNoImportConflicts` (409/422) — on confirm **before** any repository or team is resolved or created, so a blocked bootstrap creates neither. It then resolves-or-creates a **personal** repository row for the current user via `RepositoriesService.resolveOrCreatePersonalRepo(userId, repoUrl)` (same `onConflictDoNothing` + re-select pattern as `LogsService.importSession()`'s repo-link step), writes that `repoId` onto the job row (`ExportImportJobsService.startImportFromStagedUpload()`'s new optional `repoId` param), then runs the same `runImportJob()` unchanged. Response adds `repoId` (the resolved/created target repo) alongside `jobId`/`status` so the client can navigate there once the job finishes. Lets a previously exported zip be imported onto an empty server (no existing repos at all) or reattached under a new personal repo, named after the export's own source repo. It also resolves-or-creates an owning `teams` row for the importer via `TeamsService.resolveOrCreateImportTeam(userId, repoUrl)` (reused on a repeat import of the same `repoUrl` by the same owner, named `Imported: <repoUrl>` with a `(2)`/`(3)`/... suffix on a name collision), links `repoUrl` to that team via `addTeamRepository()`, and — as each session in the zip is imported — adds its resolved author as a `teamMembers` row via `TeamsService.addMemberIfRealUser()`, but only for real (non-placeholder) users, so imported sessions from unknown emails don't spawn unauthenticatable team members.

---

## `/api/v1/sessions`

**File:** `server/src/sessions/sessions.controller.ts`

| Method | Path | Handler | Auth |
|---|---|---|---|
| DELETE | `/api/v1/sessions/:sessionId` | `deleteSession()` | SessionAuthGuard |

**Notes:**
- `:sessionId` is the public `sessions.session_id` string (not the numeric PK).
- Owner only — every other caller receives 403, admins included.
- Returns 204 on success; 404 if session not found or already deleted.
- Purges all session data (logs, stats, favorites, file_stats, orphan contexts) and soft-deletes the session row (`deleted = true`). Child sessions are also purged and soft-deleted.

---

## `/api/v1/admin/retention`

**File:** `server/src/sessions/session-retention.controller.ts`

| Method | Path | Handler | Auth |
|---|---|---|---|
| GET | `/api/v1/admin/retention` | `getRetention()` | SessionAuthGuard + AdminOrTeamOwnerGuard |

**Notes:**
- Reachable by site admins *and* any user who owns at least one team (not just admins), unlike the `/api/v1/admin` block below.
- Response: `{ retentionDays, oldestSessionAt, youngestSessionAt, totalSessionCount, dailySeries: { day, sessionCount, totalSizeBytes }[] }` — UTC-day-bucketed, gap-filled session age/size stats across all non-deleted sessions (not scoped to the caller's own sessions/team).

---

## `/api/v1/user-settings`

**File:** `server/src/user-settings/user-settings.controller.ts`

Generic per-user key/value CRUD. The owning user always comes from the session — no route parameter or body field can target another user. `:name` must match `/^[A-Za-z0-9._-]{1,100}$/` (400 otherwise); `value` is opaque text capped at 64 KB by the DTO (400 otherwise).

| Method | Path | Handler | Auth |
|---|---|---|---|
| GET | `/api/v1/user-settings` | `list()` | SessionAuthGuard |
| GET | `/api/v1/user-settings/:name` | `get()` | SessionAuthGuard |
| PUT | `/api/v1/user-settings/:name` | `set()` | SessionAuthGuard |
| DELETE | `/api/v1/user-settings/:name` | `remove()` | SessionAuthGuard |

---

## `/api/v1/ai-tool-versions`

**File:** `server/src/ai-tool-versions/ai-tool-versions.controller.ts` (module `AiToolVersionsModule`, registered in `app.module.ts` and imported by `LogsModule`)

| Method | Path | Handler | Auth |
|---|---|---|---|
| GET | `/api/v1/ai-tool-versions/:toolName` | `AiToolVersionsController.getHistory()` | SessionAuthGuard — 2026-09-23, new. `:toolName` must be a key of `AI_TOOLS` (`ai-tool-versions.constants.ts`; today only `claude-code`), 404 otherwise. Returns `AiToolVersionsService.getHistory()` → `{ toolName, fetchedAt, history }`. The data is filled by the hourly `ai-tool-version-check` scheduler — see [`system-info-and-cluster.md`](system-info-and-cluster.md) |

---

## `/api/v1/api-keys`

**File:** `server/src/api-keys/api-keys.controller.ts`

| Method | Path | Handler | Auth |
|---|---|---|---|
| GET | `/api/v1/api-keys` | `list()` | SessionAuthGuard |
| POST | `/api/v1/api-keys` | `create()` | SessionAuthGuard |
| PATCH | `/api/v1/api-keys/:id` | `update()` | SessionAuthGuard |
| DELETE | `/api/v1/api-keys/:id` | `delete()` | SessionAuthGuard |

---

## `/api/v1/teams`

**File:** `server/src/teams/teams.controller.ts`

| Method | Path | Handler | Auth |
|---|---|---|---|
| POST | `/api/v1/teams` | `createTeam()` | SessionAuthGuard |
| GET | `/api/v1/teams` | `listTeams()` | SessionAuthGuard |
| GET | `/api/v1/teams/pending-disclosures` | `listPendingDisclosures()` | SessionAuthGuard |
| GET | `/api/v1/teams/:teamId` | `getTeam()` | SessionAuthGuard + TeamAccessGuard |
| PATCH | `/api/v1/teams/:teamId` | `updateTeam()` | SessionAuthGuard + TeamOwnerGuard |
| DELETE | `/api/v1/teams/:teamId` | `deleteTeam()` | SessionAuthGuard + TeamOwnerGuard |
| GET | `/api/v1/teams/:teamId/members` | `getMembers()` | SessionAuthGuard + TeamAccessGuard |
| PATCH | `/api/v1/teams/:teamId/members/:userId` | `updateMember()` | SessionAuthGuard + TeamOwnerGuard |
| DELETE | `/api/v1/teams/:teamId/members/:userId` | `removeMember()` | SessionAuthGuard + TeamOwnerGuard |
| POST | `/api/v1/teams/:teamId/acknowledge-disclosure` | `acknowledgeDisclosure()` | SessionAuthGuard + TeamAccessGuard |
| POST | `/api/v1/teams/:teamId/leave` | `leaveTeam()` | SessionAuthGuard |
| POST | `/api/v1/teams/:teamId/transfer` | `transferOwnership()` | SessionAuthGuard + TeamOwnerGuard |
| GET | `/api/v1/teams/:teamId/repositories` | `getTeamRepositories()` | SessionAuthGuard + TeamAccessGuard |
| POST | `/api/v1/teams/:teamId/repositories` | `addTeamRepository()` | SessionAuthGuard + TeamOwnerGuard — a new link seeds its `team_repo_config` (owner's personal config for the URL, else `TEAM_CREATION_DEFAULT_CONFIG`) and runs `recomputeTeamScope`; re-adding a linked URL does neither |
| DELETE | `/api/v1/teams/:teamId/repositories/:repoId/link` | `unlinkTeamRepository()` | SessionAuthGuard + TeamOwnerGuard — the link's `team_repo_config` goes by FK cascade (also on remove, team delete, admin repo removal, account deletion) |
| DELETE | `/api/v1/teams/:teamId/repositories/:repoId` | `removeTeamRepository()` | SessionAuthGuard + TeamOwnerGuard |
| POST | `/api/v1/teams/:teamId/invitations` | `sendInvitation()` | SessionAuthGuard + TeamAccessGuard |
| DELETE | `/api/v1/teams/:teamId/invitations/:invId` | `cancelInvitation()` | SessionAuthGuard + TeamAccessGuard |

**Notes:**
- `PATCH /api/v1/teams/:teamId` — body accepts an optional `accessMode: 'transparent' \| 'restricted'` alongside the optional `name` (it replaced `allowMemberSessionVisibility`); at least one field must be present or the request 400s (`No fields to update`). This is the owner-only setting that decides who sees whose sessions/contexts/analytics on team-scoped repository routes (see the **Team access-mode gate** note under `/api/v1/repositories`). Switching **to** `transparent` while the team has any member besides the owner is refused with a **409** (`Cannot switch to transparent: the team has members besides the owner`) — those members joined under the restricted privacy promise and it cannot be revoked; `transparent → restricted` only reduces exposure and is never blocked. The client derives the same lock from its member list and disables the Transparent card, so the 409 is a backstop.
- `PATCH /api/v1/teams/:teamId/members/:userId` — body is now `{ canInvite?, isManager?, isAdlcTrainer? }`, all three optional (`canInvite` used to be required); an empty body 400s. `TeamOwnerGuard` with **no** admin bypass, deliberately: role grants are the team owner's alone. The two role flags stack and are only consulted while the team is `restricted`.
- `GET /api/v1/teams/:teamId/members` — rows carry `isManager`, `isAdlcTrainer` and `disclosureAcknowledgedAt`. The timestamp is returned verbatim only to the team owner; every other caller sees `null` on every row, so one member cannot read another's acknowledgement state.
- `GET /api/v1/teams/pending-disclosures` — teams the caller belongs to with `disclosure_acknowledged_at IS NULL`, i.e. the two membership paths that have no Accept step (the `force: true` invite branch below, and `addMemberIfRealUser()` during a repository import). Returns `{ teamId, teamName, accessMode, hasTrainer }[]`. **Must stay declared before `@Get(':teamId')`** in `teams.controller.ts` — Nest matches in declaration order, so a later literal would be swallowed by the parametric route and rejected by its `ParseIntPipe` with a 400.
- `POST /api/v1/teams/:teamId/acknowledge-disclosure` — body `{ acknowledgedAccessMode }`, validated against the team's live `access_mode` (400 on mismatch) so a stale modal cannot consent to a contract that no longer applies. Stamps `disclosure_acknowledged_at = now()` on the caller's own membership row and returns `{ acknowledged: true }`. 404 when the caller has no membership row (only possible if the membership vanished after `TeamAccessGuard`, which admits members only).
- `POST /api/v1/teams/:teamId/invitations` — body now also accepts an optional `force?: boolean` (default `false`). When the invitee email has no registered user, the request 404s with `{ error: 'user_not_registered' }` unless `force: true` is sent, in which case an auto-provisioned user is created for that email and the invitation proceeds. On the `force: true` path, `team_members` is inserted immediately but the invitation itself is created with `status: 'pending'` — it flips to `'accepted'` automatically on the invitee's first login (`UsersService.acceptGrantedInvitations()`, called from `AuthService.identify()`/`autoIdentifyMode1()` and `AzureCallbackController`), not via the normal `PATCH /api/v1/invitations/:invId` accept step.

---

## `/api/v1/invitations`

**File:** `server/src/teams/invitations.controller.ts`

| Method | Path | Handler | Auth |
|---|---|---|---|
| GET | `/api/v1/invitations` | `listInvitations()` | SessionAuthGuard |
| PATCH | `/api/v1/invitations/:invId` | `respondToInvitation()` | SessionAuthGuard |

- `GET /api/v1/invitations` returns invitations in **both** directions — ones the caller received and ones the caller sent — because a team's Invitations tab needs the sent ones while `NotificationBell` needs the received ones. Each row is enriched with `inviteeEmail` (joined `users`) and `teamName` (joined `teams`, so an invitee who is not yet a member can still see which team invited them). A consumer that wants one direction must filter on `inviteeId`/`inviterId` itself: `respondToInvitation()` 403s with "Not your invitation" for anything the caller did not receive. Rows also carry the team's `accessMode` and a `hasTrainer` boolean, so the invitee can be shown the pre-accept access-mode disclosure without yet being able to read the team itself.
- `PATCH /api/v1/invitations/:invId` — body gained `acknowledgedAccessMode?: 'transparent' \| 'restricted'`: the mode the invitee was actually shown in the disclosure modal. It is **required** on `action: 'accept'` (400 when absent) and must still equal the team's live `access_mode` (400 otherwise), so a card rendered before the owner flipped the mode cannot consent to the wrong contract. Accepting **is** the acknowledgement — the inserted `team_members` row is stamped with `disclosure_acknowledged_at`, so this member never sees the login-time disclosure gate for this team. Ignored on `decline`.

---

## `/api/v1/users` (admin)

**File:** `server/src/admin/admin.controller.ts`

| Method | Path | Handler | Auth |
|---|---|---|---|
| PATCH | `/api/v1/users/:userId/role` | `updateUserRole()` | SessionAuthGuard + AdminGuard |
| POST | `/api/v1/users/:userId/reset-password-link` | `generateResetPasswordLink()` | SessionAuthGuard + AdminGuard |

---

## `/api/v1/admin/model-pricing`

**File:** `server/src/model-pricing/model-pricing-admin.controller.ts` (module `ModelPricingModule`,
registered in `app.module.ts` after `AiToolVersionsModule`)

| Method | Path | Handler | Auth |
|---|---|---|---|
| GET | `/api/v1/admin/model-pricing` | `list()` | SessionAuthGuard + AdminGuard |
| PUT | `/api/v1/admin/model-pricing/price` | `setPrice()` | SessionAuthGuard + AdminGuard |
| PUT | `/api/v1/admin/model-pricing/override` | `setOverride()` | SessionAuthGuard + AdminGuard |
| POST | `/api/v1/admin/model-pricing/override/clear` | `clearOverride()` | SessionAuthGuard + AdminGuard |
| POST | `/api/v1/admin/model-pricing/fetch-anthropic` | `fetchAnthropic()` | SessionAuthGuard + AdminGuard |
| POST | `/api/v1/admin/model-pricing/import-openrouter` | `importOpenRouter()` | SessionAuthGuard + AdminGuard |

**Notes:**
- `list`, `setPrice`, `setOverride` and `clearOverride` delegate to `ModelPricingAdminService`.
  `importOpenRouter` delegates to `OpenRouterImportService.runImport()`, `fetchAnthropic` to
  `AnthropicPricingFetchService.runFetch(undefined, { force: true })`. All POST routes use
  `@HttpCode(200)`.
- The model id travels **in the body** (`ModelPriceInputDto.modelId` / `ModelIdDto.modelId`),
  never the path, because ids can contain `/`.
- `PUT price` is allowed only for `unpriced` / `manual` models. `PUT override` is allowed only for
  `anthropic` / `openrouter` models, and returns 409 when the model has a future-dated row.
  `POST override/clear` needs an active override. Any other state returns 409, and an unknown id
  returns 404.
- `POST import-openrouter` is synchronous: one outbound call to `openrouter.ai`. It returns 502
  `{ message }` on a fetch or parse failure, and writes no price in that case.
- `POST fetch-anthropic` is synchronous too: it skips the daily stale/retry window and returns
  `{ result: 'changed' | 'unchanged' | 'failed' | 'skipped' }` (never an HTTP error for a failed
  fetch); `skipped` when another attempt started < `MANUAL_FETCH_MIN_GAP_SECONDS` (30) ago.
  `GET` adds `anthropic.nextCheckAt` (`nextAnthropicCheck()` in `model-pricing-admin.service.ts`).
- Contract and types: [api-reference.md](api-reference.md) § Model Pricing. Semantics:
  [model-pricing-research.md](model-pricing-research.md).

---

## `/api/v1/admin`

**File:** `server/src/admin/admin-panel.controller.ts`

| Method | Path | Handler | Auth |
|---|---|---|---|
| GET | `/api/v1/admin/repos` | `getRepos()` | SessionAuthGuard + AdminGuard |
| GET | `/api/v1/admin/teams` | `getTeams()` | SessionAuthGuard + AdminGuard |
| GET | `/api/v1/admin/teams/:teamId/members` | `getTeamMembers()` | SessionAuthGuard + AdminGuard |
| POST | `/api/v1/admin/teams/:teamId/owner` | `setTeamOwner()` | SessionAuthGuard + AdminGuard |
| DELETE | `/api/v1/admin/team-repos/:teamRepoId` | `removeOrphanTeamRepo()` | SessionAuthGuard + AdminGuard |
| GET | `/api/v1/admin/users` | `getUsers()` | SessionAuthGuard + AdminGuard |
| PATCH | `/api/v1/admin/users/:id/role` | `updateUserRole()` | SessionAuthGuard + AdminGuard |
| PATCH | `/api/v1/admin/users/:id/email` | `renameUserEmail()` | SessionAuthGuard + AdminGuard |
| POST | `/api/v1/admin/users/:id/delete` | `deleteUser()` | SessionAuthGuard + AdminGuard |
| DELETE | `/api/v1/admin/repos/:id` | `removeRepo()` | SessionAuthGuard + AdminGuard |
| GET | `/api/v1/admin/system` | `getSystemInfo()` | SessionAuthGuard + AdminGuard |
| GET | `/api/v1/admin/error-logs` | `getErrorLogs()` | SessionAuthGuard + AdminGuard |
| GET | `/api/v1/admin/logs-archive` | `downloadLogsArchive()` | SessionAuthGuard + AdminGuard |
| GET | `/api/v1/admin/upload-queue` | `getUploadQueue()` | SessionAuthGuard + AdminGuard |
| DELETE | `/api/v1/admin/upload-queue/failed` | `clearFailedUploadQueue()` | SessionAuthGuard + AdminGuard |
| POST | `/api/v1/admin/upload-queue/reprocess-failed` | `reprocessFailedUploadQueue()` | SessionAuthGuard + AdminGuard |
| GET | `/api/v1/admin/upload-queue/:id/file` | `downloadUploadQueueFile()` | SessionAuthGuard + AdminGuard |
| GET | `/api/v1/admin/upload-queue/stats` | `getUploadQueueStats()` | SessionAuthGuard + AdminGuard |
| GET | `/api/v1/admin/auth` | `getAuthConfig()` | SessionAuthGuard + AdminGuard |
| GET | `/api/v1/admin/auth/pending-registrations` | `getPendingRegistrations()` | SessionAuthGuard + AdminGuard |
| POST | `/api/v1/admin/auth/pending-registrations/:id/resend` | `resendPendingRegistration()` | SessionAuthGuard + AdminGuard |
| DELETE | `/api/v1/admin/auth/pending-registrations/:id` | `revokePendingRegistration()` | SessionAuthGuard + AdminGuard |

**Notes:**
- **Auth tab:** `GET auth` → `{ mode, smtp?: { host, port, from }, azure?: { tenantId, clientId, redirectUri, authority } }` — the field group present matches the active mode (Mode 1 has none); never a secret field. Verified live: `{"mode":"password-confirm","smtp":{"host":"localhost","port":1025,"from":"no-reply@example.com"}}`.
- `GET auth/pending-registrations` — Mode-3-only concept (empty `[]` in every other mode, not hidden server-side — the client hides the table). `{ id, email, registeredAt, tokenExpiresAt }[]`, oldest-registered-first, unpaginated. `:id`/`id` is `users.id`.
- `POST .../:id/resend` — same `EmailConfirmationTokensService.issueWithCooldown` + 60s cooldown as the user-facing `resend-confirmation` (shared underlying cooldown — triggering one 429s the other). `404` if the `users.id` row no longer exists; `409` if already confirmed; `429` with `Retry-After` on cooldown. Verified live (429 + `Retry-After: 60` header confirmed).
- `DELETE .../:id` — atomic revoke (`UsersService.deleteIfUnconfirmed`, `WHERE id = :id AND email_confirmed_at IS NULL`); same `404`-vs-`409` guard as resend. `email_confirmation_tokens` row cascade-deletes via its FK. `204` on success.
- **Delete user:** `POST users/:id/delete` (`DeleteUserDto { confirmEmail }`) — `POST`, not `DELETE`, because the confirmation body is re-validated server-side and `DELETE`-with-a-body is awkward through `fetch`/Nest pipes. `400` when `:id` is the caller's own id ("Cannot delete your own account here" — self-deletion must go through `POST /api/v1/auth/delete-account`, which also signs the caller out), `404` when `:id` doesn't exist, `400` when `confirmEmail` doesn't case-insensitively match the target's email, `400` when the target is the last remaining admin. `204` on success. Delegates to `AccountDeletionService.hardDeleteUser(userId, { actingUserId, via: 'admin' })` (`server/src/users/account-deletion.service.ts`): one transaction that deletes `invitations` referencing the user (both FKs are `NO ACTION`), teams they own (`teams.owner_id` is `ON DELETE RESTRICT`), `team_repositories` rows for repo urls no other user still claims, then the `users` row itself — letting the existing cascades take `api_keys`, `password_reset_tokens`, `email_confirmation_tokens`, `repositories`, `logs`, `logs_otel`, `team_members`, `upload_queue`, `export_import_jobs`, `repo_config`, `session_file_stats`, `session_cause_stats` and `user_favorite_sessions` (the deleted `team_repositories` rows take their `team_repo_config` rows) — and finally removes `sessions` rows left with no `logs` row at all. `auth_sessions` pruning runs after the commit (that table is owned by `connect-pg-simple`, outside the transaction).
- **Rename user email:** `PATCH users/:id/email` (`RenameUserEmailDto { email }`) — same-row `UPDATE users SET email` (lowercased) via `UsersService.renameEmail`; no `emailConfirmedAt`/email-sending side effects. `409 ConflictException` if `email` already belongs to a different user; `404 NotFoundException` if `:id` doesn't exist. No self-rename restriction. All FK-owned records (repos, teams, memberships, API keys) follow automatically since they reference `userId`, not the email.
- `GET /api/v1/admin/repos` response shape includes `maxUploadBytes: number | null` per repo — the largest single artisyn upload body in bytes; `null` until the first artisyn upload for that repo.
- `GET /api/v1/admin/repos` — real rows (`id !== null`) carry `teamName: string | null`: every team linking the URL (`string_agg` of `teams.name` over `team_repositories` by `repo_url`, ordered by name), `null` when none. Orphan rows (`id === null`, a `team_repositories` link with no `repositories` row) keep `teamId` / `teamRepoId` / `teamName`. Rows are metadata/aggregates only and link nowhere — the admin role grants no session-data access.
- `GET /api/v1/admin/teams/:teamId/members` — `AdminTeamMember[]` = `{ userId, email, isOwner }[]` ordered by email; identity only, no session data. 404 unknown team.
- `POST /api/v1/admin/teams/:teamId/owner` — `@HttpCode(200)`, body `TransferOwnershipDto { userId }`. FR-8 "Set new owner": the one team action an admin has without being a member. Delegates to `TeamsService.transferOwnership()` — 400 "New owner must be a current team member" for a non-member, 404 unknown team; returns the updated team row. The previous owner stays a member.
- `DELETE /api/v1/admin/team-repos/:teamRepoId` — `@HttpCode(204)`. Deletes an **orphan** team link only (no `repositories` row has its `repo_url`); its `team_repo_config` goes by FK cascade. 404 when the link is missing or not an orphan — a linked repo with data is removed only via `DELETE /admin/repos/:id`. Backs the Admin → Repos "Remove" action on orphan rows (the team route is owner-only).
- `GET /api/v1/admin/system` — delegates to `SystemInfoService.getSystemInfo()` (`server/src/system-info/system-info.service.ts`). Response (`SystemInfoResponse`): cluster worker counts (`expected`/`actual`), CPU counts, load average, memory, process/container uptime, DB connectivity + pool stats, DB space usage (`available: false` omits the numeric fields when the DB role lacks size-inspection rights), build info (`version`/`gitCommit`, `dev`/`unknown` outside Docker), Node version/env, event-loop lag (this instance), request rate/active count (this instance), disk usage of the logs directory, and a `supervisor` object — `{ clustered, processes }` with one `WorkerProcessSummary` per worker slot (`instance`, `pid`, `memoryBytes`, `restarts`, `lastRestartAt`, `status`; **no** `cpuPercent`), sourced from the cluster primary's last broadcast snapshot with no request-time IPC round trip. Falls back to `clustered: false` plus a single synthetic entry for the current process (`instance: null`, `status: 'online (single process)'`) when no snapshot has ever arrived, i.e. outside cluster mode.
- `GET /api/v1/admin/error-logs` — delegates to `ErrorLogsService.getErrorLogs()` (`server/src/error-logs/error-logs.service.ts`). Scans up to the 30 most recent `server/logs/app-*.log` files (`MAX_FILES_TO_SCAN`) for lines whose level trims to `ERROR`, merges and sorts them newest-first, and returns `{ entries: ErrorLogEntry[] }` capped to the 30 most recent entries (`MAX_ENTRIES`). Returns `{ entries: [] }` (not an error) if the logs directory doesn't exist yet.
- `GET /api/v1/admin/logs-archive` — `SystemInfoService.createLogsArchive()` zips the entire `logs/` directory (via `archiver`) into a temp file in `os.tmpdir()`, awaiting full completion before the controller responds (per "synchronous archive" requirement — no partial download can start mid-zip). The controller (`@Res()`-based, `res.download()`) streams the finished file back with a `Content-Disposition: attachment; filename="logs-<ISO timestamp>.zip"` header, then deletes the temp file in the download callback regardless of success/failure.
- `GET /api/v1/admin/upload-queue` — delegates to `UploadQueueAdminService.listQueue()`. Flat list (client groups by session for display), ordered by `sessionId` then `receivedAt`: `{ id, fileName, sizeBytes, receivedAt, sessionId, logType, userId, repoUrl: string | null, status: 'pending'|'processing'|'failed'|'partially_uploaded', errorMessage: string | null, uploadId: string | null, chunksReceived: number | null, totalChunks: number | null }[]`. `repoUrl` resolved via `sessions` → `logs` → `log_repositories` → `repositories`; `null` until the session/link exists; most-recently-`updatedAt` `logs` row wins if more than one repo is linked. `uploadId`/`chunksReceived`/`totalChunks` are only populated for rows created via the `/api/v2/logs` chunked path — `null` for single-request uploads. `status='partially_uploaded'` means the chunked upload is still in progress (`chunksReceived < totalChunks`); it is never claimed by the scheduler's pending-row query and flips to `pending` the instant the final chunk reassembles the file.
- `DELETE /api/v1/admin/upload-queue/failed` — delegates to `UploadQueueAdminService.clearFailed()`. Deletes all `status='failed'` rows plus their staged files (best-effort unlink), leaving `pending`/`processing` rows untouched. Response: `{ deletedCount: number }`. Both new endpoints inherit the controller's class-level `SessionAuthGuard`+`AdminGuard` — no per-method guard added.
- `POST /api/v1/admin/upload-queue/reprocess-failed` — delegates to `UploadQueueAdminService.reprocessFailed()`. Resets all `status='failed'` rows back to `pending` (clearing `errorMessage`), leaving `pending`/`processing` rows untouched and the staged file in place (unlike `DELETE .../failed`, no file I/O). The scheduler's next tick reclaims and reprocesses each reset row on its normal ordering (`received_at ASC`). Response: `{ updatedCount: number }`. Use after fixing a root cause that made a batch of uploads fail identically (e.g. an invalid file-category regex pattern) — this lets those specific uploads retry without needing new hook activity to re-upload them.
- `GET /api/v1/admin/upload-queue/:id/file` — delegates to `UploadQueueAdminService.resolveStagedFile(id)` (staging dir + `path.basename(row.fileName)`, so it cannot escape the staging dir), then `res.download()`s it. 404 when the row is missing or the file is gone. Backs the "Download file" button in the admin Upload Queue entry details modal. Failed rows' `errorMessage` from the NDJSON parser now reads `Malformed NDJSON: invalid JSON line N of M (L chars): <JSON.parse reason>` (the v1 prefix is kept; hooks only display it).
- `GET /api/v1/admin/upload-queue/stats` — delegates to `UploadQueueStatsService.getStats()` (`server/src/admin/upload-queue-stats.service.ts`). Backs the stats block above the Upload Queue list. One `db.execute` with three CTEs: the `GROUP BY status` queue aggregate, a `UPLOAD_QUEUE_STATS_WINDOW_MS` (default 15 min) window over `upload_queue_measurements`, and a `UPLOAD_QUEUE_MEASUREMENT_RETENTION_MS` (default 7 days) window over the same table. Response: `{ windowMs, retentionWindowMs, byStatus: { status, files, bytes }[], total: { files, bytes }, processingNow, worker: { instanceCount, activeMs, utilizationPercent, filesPerSec, bytesPerSec, successCount, failureCount }, worker7d: { filesPerSec, bytesPerSec, successCount }, latency: { avgMs, p95Ms, minMs, maxMs }, drainEtaMs }`. Notes: `byStatus` is always all four statuses, zero-filled server-side in a fixed order. Throughput is denominated by *summed active duration*, not wall-clock, so an idle worker's reported rate does not decay while the window still holds its measurements. `utilizationPercent` is `activeMs / (windowMs × instanceCount)`, clamped to 0–100 (a parse that began before the window opened contributes its whole `duration_ms`); `instanceCount` comes from `computeInstanceCount(os.availableParallelism())`, not from `SystemInfoService` (whose full snapshot assembly — DB pings, DB-size queries, a recursive logs-directory walk — is far too heavy for a 5-second poll). Latency is over *successful* attempts only and uses `percentile_cont(0.95)` — the only use of an ordered-set aggregate in the repo. `drainEtaMs` covers `status='pending'` only and is the **max** of the file- and byte-constrained estimates. Every rate/latency field and `drainEtaMs` are `number | null`, and are `null` — never `0`, `Infinity` or `NaN` — when the window holds no successful attempt or the backlog is empty. Inherits the controller's class-level `SessionAuthGuard`+`AdminGuard`; `upload-queue` and `upload-queue/stats` are distinct static paths, so there is no route-order conflict with `GET upload-queue`.

---

## `/static/artisyn-hooks-installer.tgz`

**File:** `server/src/installer/installer.controller.ts` (`InstallerModule`)

| Method | Path | Handler | Auth |
|---|---|---|---|
| GET | `/static/artisyn-hooks-installer.tgz` | `downloadInstaller()` | none (public, unauthenticated download) |

**Notes:**
- Excluded from `ServeStaticModule`'s static file handler in `app.module.ts` (`exclude: [...]`) so this dedicated controller — not the generic static middleware — serves the path.
- New `?v=` query-param capture: if present and it matches strict `x.y.z` shape (`isValidSemver()` from `server/src/common/semver.ts`), upserts `server/src/public/static/latest-hook-version.json` (`{ version, recordedAt }`), keeping the higher of the existing and new version (`compareSemver()`, max-wins — never regresses). A malformed or absent `?v=` is ignored (logged via `Logger.warn`, never thrown) — the tgz download itself always succeeds regardless of the query string. This file is read by `HookStateService.readLatestHookVersion()` as the "latest known hook version" baseline for the Hook State Panel's `outdated` computation.
