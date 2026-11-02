---
type: "API Endpoint Map"
title: "Server HTTP API map"
description: "Every HTTP route of the server: controller and handler, guard, one-line purpose and where its request/response types live; plus the guards legend, access-control rules and cross-cutting API behaviour (security headers, errors, body limits, hook-route compatibility)."
tags:
  - server
  - api
  - auth
timestamp: "2026-11-03T00:00:00+04:00"
---

# Server HTTP API map

One table per route prefix: method, full path, controller + handler, guard, purpose, types.
The controllers, the DTO/`*.types.ts` files and the API contract registry
(`server/test/contract/registry/f<NN>-*.ts`, one family per area; the router meta-test fails
when a route has no row) are the source of truth for request/response shapes — this article
only says where to look. Update it when a route is added, removed or renamed, or its guard
changes.

Paths in the Types column are relative to `server/src/` unless they start with `client/`.
Client twins of most response types live in `client/src/models/<area>.ts`; the raw session
logs payload is typed in `client/src/viewer/api.ts`.

---

## Guards legend

Guard column shorthands (class-level and method-level `@UseGuards` combined):

| Shorthand | Guards | Meaning |
|---|---|---|
| `public` | none | No authentication. |
| `session` | `SessionAuthGuard` | Cookie session (`connect.sid`, `sameSite: lax`, 1 h rolling). 401 otherwise. |
| `api-key` | `ApiKeyAuthGuard` (`api-keys/api-key-auth.guard.ts`) | `X-API-Key` header; `req.user` = the key's owner. Used by the hook. |
| `admin` | `SessionAuthGuard` + `AdminGuard` | Site admin role. |
| `admin-or-team-owner` | `SessionAuthGuard` + `AdminOrTeamOwnerGuard` | Site admin, or owner of *any* team (no `:teamId` involved). |
| `team-member` | `SessionAuthGuard` + `TeamAccessGuard` | Member of `:teamId` (404 unknown team, 403 non-member). |
| `team-owner` | `SessionAuthGuard` + `TeamOwnerGuard` | Owner of `:teamId`. |
| `mode:<m…>` | `AuthModeGuard` + `@AllowedAuthModes(...)` | Route exists only in the listed `AUTH_MODE`s; any other mode → **404** (not 403), checked before any credential guard. |
| `local` | `LocalAuthGuard` | Passport email/password check (login only). |
| `auto-identify` | `AutoIdentifyGuard` | Mode `none` only: silently logs in a local caller with no session (see Auth flows). |

Guards live in `server/src/common/guards/` (`admin`, `admin-or-team-owner`, `team-access`,
`team-owner`) and `server/src/auth/guards/` (`session-auth`, `auth-mode`, `auto-identify`,
`local-auth`). **No team guard and no repository access check has an admin bypass** — the
admin role grants no session-data access (see [Access-control rules](#access-control-rules)).

---

## Access-control rules

Most repository routes are only `session`-guarded; the real check is in the handler/service.

- **Repository access** — `RepositoriesService.assertRepoAccess(user, repoId, teamId?)`:
  without `teamId` the caller must own the repo (personal view); with `?teamId` the caller must
  be a member of that team and the team must link the repo's URL (team view). A non-positive
  `teamId` → 400. Repos are private to their owner even for an admin.
- **Stricter: owner or team owner** — `assertRepoOwnerOrTeamOwner` for every export/import
  route, `sessions/export-scope` and `recompute-all-sessions`: personal owner, or the **owner**
  of `teamId` (a plain member → 403). `teamId` is a query param on GETs and a body field on
  POSTs; forgetting it on a team call wrongly 403s a team owner.
- **Owner-only data** — `GET .../sessions/:sessionId/logs` (raw conversation) is owner-only
  (owner = `userId` of the session's artisyn log); exceptions only with `?teamId`: the team
  owner, or a `team-with-prompts` caller in a restricted team, and only for members who have
  acknowledged the disclosure. `GET .../contexts` stays owner-only. `DELETE
  /api/v1/sessions/:sessionId` is owner-only, admins included.
- **Team access-mode gate** — every team-scoped read (`?teamId`) resolves one `TeamScope`
  (`RepositoriesService.resolveTeamScope`, type in `logs/team-scope.ts`): `accessMode`
  (`transparent` | `restricted`), `visibility` (`own-only` | `team-no-prompts` |
  `team-with-prompts`), `visibleUserIds`, `analyticsAllowed`. Role flags (manager, ADLC
  trainer) count only in `restricted` teams; members who have not acknowledged the disclosure
  are invisible to everyone. Consequences per route kind:
  - list/aggregate routes **row-filter** (a plain member sees only own rows, not a 403);
  - per-session `:sessionId` routes **403** when the owner is not visible
    (`assertSessionVisible`); the change-surface, OKF and OTEL session routes answer an
    empty / `computed: false` payload for a session outside the scope instead of a 404;
  - `analytics/*`, `reports/*`, `otel/facts` and team OTEL **403** when `analyticsAllowed` is
    false; the session-list support routes (`sessions/branches`, `session-attribution/values`,
    `sessions/:sessionId/contexts`) are deliberately not analytics-gated;
  - prompt masking is a projection, not a `WHERE`: a `null` `firstPrompt` in a team payload
    means "hidden", never "absent".

  Full matrix and rationale: [authorization-and-authentificaiton.md](authorization-and-authentificaiton.md)
  § "Team access modes" and § "Team visibility and restricted access".
- **Hook (`api-key`) routes** act on the key owner's data only: a session owned by another user
  answers 404 (post-turn submissions, OKF facts) or 409 (OTEL realtime), never confirming it
  exists. See [hook-api-versioning.md](hook-api-versioning.md) § "Uploads into another user's session".
- **Localhost-only identify** — `POST /api/v1/auth/identify` and the `auto-identify` guard on
  `GET /api/v1/auth/me` accept only `127.0.0.1`/`::1` by `req.socket.remoteAddress` (never
  `X-Forwarded-For`), plus the container's own default gateway when containerized. 403 otherwise.
- **Route order** — literal segments must be declared before parametric siblings in the
  controller (`repositories/hooks` before `:repoId`, `teams/pending-disclosures` before
  `:teamId`): Nest matches in declaration order and the `ParseIntPipe` would 400.

---

## Cross-cutting behaviour

- **Security headers** on every response (API, SPA, static): `Content-Security-Policy`
  (same-origin, `frame-ancestors 'none'`, `'unsafe-inline'` for styles only, no
  `upgrade-insecure-requests` so plain-HTTP internal deployments work), `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`. Set by `common/security-headers.ts` in
  `AppModule.configure()` (helmet) before session/passport/body parsers; `main.ts` also
  registers an earlier `X-Frame-Options` / `frame-ancestors` middleware.
- **Validation** — global `ValidationPipe({ whitelist: true })`: DTO-decorated bodies are
  validated (400) and unknown fields are stripped, not rejected.
- **Error body** — `common/http-exception.filter.ts` (global) always answers
  `{ statusCode, message, error?, conflicts?, field?, code? }`; validation-pipe arrays are joined
  into one `message`; `retryAfterSeconds` becomes a `Retry-After` header (429s). Machine-readable
  reasons travel in `error` (e.g. `password_mismatch`, `weak_password`,
  `invalid_current_password`, `email_not_confirmed`, `user_not_registered`); `field` + `code` on
  tool-monitoring config 400s; `conflicts[]` on import 409s.
- **Status conventions** — 404 (not 403) for a route inactive in the current auth mode and for
  resources the caller may not know exist; `invalid_current_password` is a 403, never 401,
  because the client force-logs-out on any 401. Unauthenticated email flows (forgot, resend) are
  enumeration-safe: always 200. Login has a progressive 429 backoff; signup/forgot/resend/reset
  are rate-limited per IP/email — see [authorization-and-authentificaiton.md](authorization-and-authentificaiton.md).
- **No GET mutates state** under a cookie session (e.g. export download leaves the job in
  place) — checked by the `security-check` skill.
- **Body limits** (`common/body-limits.ts`; oversize → 413): `POST /api/v2/logs` uses
  `LOGS_MAX_BODY_MB` (default 2500 MB, counted decompressed); the hook JSON POSTs in
  `HOOK_API_ROUTES` (`turn-end-cost-advisor`, `session-attribution`, `log-echo`,
  `otel-realtime`) get 1 MiB; everything else 500 KB. A new hook-called POST must be added to
  `HOOK_API_ROUTES`. Parsers are wrapped in `throwMiddlewareErrors()` so a 413/400 is not
  rewritten to 404 by serve-static. Details: [hook-api-versioning.md](hook-api-versioning.md) § "Per-route body limits".
- **Pagination / caps** — lists are mostly unpaginated. Explicit caps: tool-monitoring `calls`
  `page`/`pageSize` ≤ 200; `analytics|reports/active-sessions` `limit` (default 100, max 500);
  change-surface files 5,000 rows (`truncated` flag); `session-attribution/values` 50 per
  attribute; repo OTEL facts range ≤ 93 days and ≤ 200 sessions; OTEL realtime ≤ 5,000 lines.
- **Common analytics/report params** — `startDate`/`endDate` (required on analytics and
  reports), `teamId`, `branches`, `users`, repeatable `attr=<key>:<op>:<value>`, and on some
  routes `groupBy` (`none`|`branch`|`user`|`attr:<key>`). Parsed by
  `logs/analytics/analytics-query.ts` and `logs/attribute-filter.sql.ts`; unknown key or
  type mismatch → 400. Each `reports/X` twin returns a body byte-identical to its `analytics/X`
  route (same service).
- **Costs** shown by any route are Log Hub's own computed tree cost, never the OTEL total; see
  [algorithms/otel-cost-selection.md](algorithms/otel-cost-selection.md) and
  [session-metrics-scope.md](session-metrics-scope.md).
- **SPA and static files** are served by `ServeStaticModule` + a precompressed-static middleware;
  see [static-asset-serving.md](static-asset-serving.md).

### Backward compatibility of hook-facing routes

Installed hooks are upgraded late, so every route a hook calls (`api-key` routes, `GET
/api/v1/model-pricing`, the installer download) is an external contract:

- Only additive changes: new optional query params/fields; an invalid optional param is
  ignored, never a 400 (e.g. `snapshotId`, `okfSnapshotId`). Response shapes for callers that
  omit new params stay unchanged (e.g. un-chunked uploads still get `{ warnings }`).
- A missing route on an older server answers 404, and the hook treats that as "feature off"
  (tool-monitoring config, OTEL realtime) — keep that behaviour when adding hook features.
- A non-validation 400 on `/api/v2/logs` makes the hook stop gzip-compressing, so size errors
  must stay 413 and gzip errors `400 Malformed gzip request body`.
- `POST /api/v1/logs` was removed: hooks older than 1.7.0 get 404 and must be upgraded.

Compatibility matrix and per-feature history: [hook-api-versioning.md](hook-api-versioning.md).

### Auth flows (summary)

`AUTH_MODE` = `none` | `password` | `password-confirm` | `azure-oauth`
([authorization-and-authentificaiton.md](authorization-and-authentificaiton.md),
[deployment-auth-mode.md](deployment-auth-mode.md), [user-account-flows.md](user-account-flows.md)).
The client reads `GET /api/v1/auth/config` first and renders the matching login UI.

- `none`: `POST identify` (email only, localhost-only); `GET me` auto-identifies a local caller
  (one user → that user; several → id 1; none → 401).
- `password` / `password-confirm`: `signup` (first user becomes admin), `login`, `forgot-password`
  → `reset-password`; `password-confirm` adds `confirm-email` / `resend-confirmation` (60 s
  cooldown shared with the admin "Resend"). Password strength is `PASSWORD_POLICY`
  ([password-requirements.md](password-requirements.md)). `change-password` signs out every
  other session.
- `azure-oauth`: `GET /api/v1/auth/azure` → Microsoft → `GET /api/auth/callback` (outside
  `/api/v1` on purpose: it is the redirect URI registered in Azure). Failures redirect to
  `/#/login?oauthError=1`.
- All modes: `logout`, `me`, `delete-account`; the client pings `GET /api/v1/ping` every 60 s to
  renew the session.

---

## `/health`

`health/health.controller.ts` · contract `f01-infra`

| Method | Path | Handler | Guard | Purpose | Types |
|---|---|---|---|---|---|
| GET | `/health` | `HealthController.check` | public | Terminus check incl. DB ping | inline |
| GET | `/health/version` | `getVersion` | public | Build info (`version`, `gitCommit`) | `common/build-info.ts` `BuildInfo` |

## `/static/artisyn-hooks-installer.tgz`

`installer/installer.controller.ts` · contract `f01-infra`

| Method | Path | Handler | Guard | Purpose | Types |
|---|---|---|---|---|---|
| GET | `/static/artisyn-hooks-installer.tgz` | `InstallerController.downloadInstaller` | public | Hook installer download; a valid `?v=x.y.z` raises `public/static/latest-hook-version.json` (max-wins), used for the hook "outdated" flag; a bad `?v` is ignored | — |

Excluded from `ServeStaticModule` so this controller serves it.

## `/api/v1/ping`

`auth/ping.controller.ts` · contract `f02-account`

| Method | Path | Handler | Guard | Purpose | Types |
|---|---|---|---|---|---|
| GET | `/api/v1/ping` | `PingController.ping` | session | 204 keep-alive; renews the session expiry | — |

## `/api/v1/auth`

`auth/auth.controller.ts` (+ `auth/azure/azure-callback.controller.ts`) · DTOs `auth/dto/*.dto.ts` ·
client `client/src/models/auth.ts` (`UserProfile`, `AuthConfig`) · contract `f02-account`, `f03-auth-modes`

| Method | Path | Handler | Guard | Purpose | Types |
|---|---|---|---|---|---|
| GET | `/api/v1/auth/config` | `AuthController.config` | public | Active mode + public login settings (`azure`, `adminContactEmail`, `passwordResetAvailable`); never a secret | `AuthConfig` (client) |
| POST | `/api/v1/auth/identify` | `identify` | mode:none | Log in / auto-provision by email, localhost only | `identify.dto.ts` |
| POST | `/api/v1/auth/signup` | `signup` | mode:password,password-confirm | Create account (first = admin); Mode 3 sends confirmation | `signup.dto.ts` |
| POST | `/api/v1/auth/login` | `login` | mode:password,password-confirm + local | Password login; 403 `email_not_confirmed`, 429 backoff | `login.dto.ts` |
| GET | `/api/v1/auth/azure` | `azure` | mode:azure-oauth | 302 to Microsoft authorize (state/nonce in session) | — |
| POST | `/api/v1/auth/logout` | `logout` | session | Destroy session | — |
| POST | `/api/v1/auth/confirm-email` | `confirmEmail` | mode:password-confirm | Consume confirmation token (400/409/410) | `confirm-email.dto.ts` |
| POST | `/api/v1/auth/resend-confirmation` | `resendConfirmation` | mode:password-confirm | Resend confirmation (always 200, 429 cooldown) | `resend-confirmation.dto.ts` |
| POST | `/api/v1/auth/forgot-password` | `forgotPassword` | mode:password,password-confirm | Send reset email (always 200; `failed` without SMTP) | `forgot-password.dto.ts` |
| POST | `/api/v1/auth/reset-password` | `resetPassword` | mode:password,password-confirm | Consume reset token, set password | `reset-password.dto.ts` |
| POST | `/api/v1/auth/change-password` | `changePassword` | mode:password,password-confirm + session | Change own password; other sessions signed out | `change-password.dto.ts` |
| POST | `/api/v1/auth/delete-account` | `deleteAccount` | session | Hard-delete own account (`{confirm:'delete'}`), 400 for last admin | `delete-account.dto.ts` |
| GET | `/api/v1/auth/me` | `me` | auto-identify + session | Current user profile | `UserProfile` (client) |

## `/api/auth`

`auth/azure/azure-callback.controller.ts` · contract `f03-auth-modes`

| Method | Path | Handler | Guard | Purpose | Types |
|---|---|---|---|---|---|
| GET | `/api/auth/callback` | `AzureCallbackController.callback` | mode:azure-oauth | OIDC callback: validate state/nonce, match/provision user by email, log in, 302 `/` | — |

## `/api/v1/api-keys`

`api-keys/api-keys.controller.ts` · DTOs `api-keys/dto/` · contract `f04-api-keys`

| Method | Path | Handler | Guard | Purpose | Types |
|---|---|---|---|---|---|
| GET | `/api/v1/api-keys` | `ApiKeysController.list` | session | Own API keys | inline |
| POST | `/api/v1/api-keys` | `create` | session | Create key (`name`, `expires_at`) | `create-api-key.dto.ts` |
| PATCH | `/api/v1/api-keys/:id` | `update` | session | Change `name` / `expires_at` of own key | `update-api-key.dto.ts` |
| DELETE | `/api/v1/api-keys/:id` | `delete` | session | Revoke own key | — |

## `/api/v1/user-settings`

`user-settings/user-settings.controller.ts` · client `client/src/models/user-settings.ts` · contract `f05-user-settings`

Generic per-user key/value store; the user always comes from the session. `:name` matches
`/^[A-Za-z0-9._-]{1,100}$/`, value ≤ 64 KB (400 otherwise).

| Method | Path | Handler | Guard | Purpose | Types |
|---|---|---|---|---|---|
| GET | `/api/v1/user-settings` | `UserSettingsController.list` | session | All own settings | `user-settings/user-settings.service.ts` |
| GET | `/api/v1/user-settings/:name` | `get` | session | One setting | same |
| PUT | `/api/v1/user-settings/:name` | `set` | session | Upsert | `user-settings/dto/set-user-setting.dto.ts` |
| DELETE | `/api/v1/user-settings/:name` | `remove` | session | Delete | — |

## `/api/v1/model-pricing`

`logs/model-pricing.controller.ts` · client `client/src/models/pricing.ts` (`ModelPricingEntry`) · contract `f22-pricing-tool-versions`

| Method | Path | Handler | Guard | Purpose | Types |
|---|---|---|---|---|---|
| GET | `/api/v1/model-pricing` | `ModelPricingController.getModelPricing` | public | Current rates per model (optional `asOf=YYYY-MM-DD`); public so the hook can price sessions. Hook-facing: shape only grows (`priceCacheW5m`/`priceCacheW1h`, `priceWebSearch`, tiers) | `PublicModelPricingEntry` in the controller |

Semantics: [model-pricing-research.md](model-pricing-research.md), [llm-call-math.md](llm-call-math.md).

## `/api/v1/ai-tool-versions`

`ai-tool-versions/ai-tool-versions.controller.ts` · contract `f22-pricing-tool-versions`

| Method | Path | Handler | Guard | Purpose | Types |
|---|---|---|---|---|---|
| GET | `/api/v1/ai-tool-versions/:toolName` | `AiToolVersionsController.getHistory` | session | Release history of a known tool (`claude-code`; else 404), filled by the hourly scheduler | `ai-tool-versions/ai-tool-versions.types.ts` |

See [claude-version-check.md](claude-version-check.md).

---

## Hook API (`api-key`)

Called by the installed hook / installer. Backward-compatibility rules above apply to every row.
Contract `f15-ingest`, `f16-post-turn`, `f24-tool-monitoring`, `f25-otel`.

| Method | Path | Handler (file) | Guard | Purpose | Types |
|---|---|---|---|---|---|
| POST | `/api/v1/log-echo` | `LogsController.logEcho` (`logs/logs.controller.ts`) | api-key | Installer's key check; 200 | — |
| POST | `/api/v2/logs` | `LogsV2Controller.postLogs` (`logs/logs-v2.controller.ts`) | api-key | The only log upload route: stages the raw NDJSON body into `upload_queue`, parsed later by the scheduler; optional chunking, gzip, snapshot ids | query/response shapes in the controller; [upload-queue.md](upload-queue.md) |
| GET | `/api/v2/post-turn-analysis/config` | `PostTurnAnalysisController.getConfig` (`logs/post-turn-analysis/`) | api-key | Combined gate for both post-turn branches (advisor + attribution); `repoUrl`, `sessionId`, `promptWatermark` | `logs/post-turn-analysis/post-turn-analysis-response.types.ts` |
| POST | `/api/v2/turn-end-cost-advisor` | `TurnEndCostAdvisorController.submitRun` (`logs/turn-end-cost-advisor/`) | api-key | Submit an advisor run; `{ applied }`, `applied:false` before the session is ingested | `…/dto/submit-turn-end-advisor-run.dto.ts` |
| POST | `/api/v2/session-attribution` | `SessionAttributionController.submitRun` (`logs/session-attribution/`) | api-key | Submit attribute values; applied only when `promptWatermark` is newer | `…/dto/submit-session-attribution.dto.ts` |
| GET | `/api/v2/okf-usage/facts` | `OkfFactsController.getFacts` (`logs/okf/okf-facts.controller.ts`) | api-key | KB-access facts of one own session tree for a local skill | `logs/okf/okf-usage.types.ts` `OkfFactsResponse` |
| GET | `/api/v2/tool-monitoring/config` | `ToolMonitoringHookController.getConfig` (`logs/tool-monitoring/tool-monitoring-hook.controller.ts`) | api-key | Monitored CLI tools for `repoUrl` (personal ∪ team lists) | `logs/tool-monitoring/tool-monitoring.types.ts` |
| POST | `/api/v2/otel-realtime` | `OtelRealtimeController.ingest` (`logs/otel/otel-realtime.controller.ts`) | api-key | Realtime OTEL batch from the hook receiver; 409 foreign session, `ignored:'deleted'` for a deleted one | `OtelRealtimeDto` in the controller; `logs/otel/otel-facts.types.ts` |

`/api/v2/logs` details (chunk params `uploadId`/`chunkIndex`/`totalChunks`/`totalSize`,
`sessionId`/`type`/`parentSessionId`/`workflowRunId`, `snapshotId`/`snapshotFull`,
`okfSnapshotId`/`okfSnapshotFull`, `{ warnings, unknownSnapshotId?, unknownOkfSnapshotId? }` /
`{ complete }`, gzip sniffing): [hook-api-versioning.md](hook-api-versioning.md),
[upload-queue.md](upload-queue.md). Post-turn features:
[turn-end-cost-advisor.md](turn-end-cost-advisor.md); OKF: [okf-usage.md](okf-usage.md);
tools: [tool-monitoring.md](tool-monitoring.md); OTEL: [otel-tabs.md](otel-tabs.md),
[otel-receiver.md](otel-receiver.md).

---

## `/api/v1/repositories`

All `session`. Access per [Access-control rules](#access-control-rules); "team" = accepts
optional `?teamId`. Controllers: `logs/repositories.controller.ts` (`Repo`),
`logs/analytics/usage-analytics.controller.ts` (`Usage`), `logs/reports/reports.controller.ts`
(`Reports`), `logs/otel/otel-facts.controller.ts` (`OtelFacts`),
`logs/tool-monitoring/tool-monitoring.controller.ts` (`Tools`). Client twins:
`client/src/models/repositories.ts` (also `harness-usage.ts`, `hook-state.ts`,
`tool-monitoring.ts`). Contract `f14-repositories`, `f17-sessions`, `f19-change-surface`,
`f20-analytics`, `f21-reports`, `f24-tool-monitoring`, `f25-otel`.

### Repository, settings, hook state

| Method | Path | Handler | Purpose | Types |
|---|---|---|---|---|
| GET | `/api/v1/repositories` | `Repo.listMyRepositories` | Repos the caller owns or authored logs in | inline |
| GET | `/api/v1/repositories/hooks` | `Repo.listHookRepositories` | Own hook-reporting repos with version/outdated/issue count | `logs/hook-state.service.ts` `HookRepositorySummary` |
| GET | `/api/v1/repositories/:repoId` | `Repo.getRepository` | Repo detail (team) | client `RepositoryDetail` |
| GET | `/api/v1/repositories/:repoId/hook-state` | `Repo.getRepositoryHookState` | Hook state panel (log tail, recommendations); 404 if never reported (team) | `logs/hook-state.service.ts` `HookStateDetail` |
| GET | `/api/v1/repositories/:repoId/summary` | `Repo.getRepositorySummary` | Repo counters; with `teamId` all members' rows of the URL | client `RepositorySummary` |
| GET | `/api/v1/repositories/:repoId/settings` | `Repo.getRepoSettings` | Effective/team/user file-category config (team) | `logs/repositories.service.ts` `RepoSettingsResponse` |
| PUT | `/api/v1/repositories/:repoId/settings/team` | `Repo.saveTeamConfig` | Save team config (team owner only, 403 otherwise); triggers recompute | body `RepoConfigJson` (`database/schema/index.ts`) |
| PUT | `/api/v1/repositories/:repoId/settings/user` | `Repo.saveUserConfig` | Save own config; triggers recompute | same |
| POST | `/api/v1/repositories/:repoId/recompute-all-sessions` | `Repo.recomputeAllSessions` | Recompute file/cause/session stats (repo owner or team owner) | inline `{ recomputed }` |

### Sessions

| Method | Path | Handler | Purpose | Types |
|---|---|---|---|---|
| GET | `/api/v1/repositories/:repoId/sessions` | `Repo.getRepositorySessions` | Session list with cost, flags, attribution; filters `branch`, `attr`, `otelReason` (team, row-filtered) | client `RepositorySession` |
| GET | `/api/v1/repositories/:repoId/sessions/ids` | `Repo.getRepositorySessionIds` | Bare id list for badge polling | `string[]` |
| GET | `/api/v1/repositories/:repoId/sessions/branches` | `Repo.getRepositorySessionBranches` | Per-branch tree aggregates (Cost by Branch, Branch Summary); optional date pair | client `BranchSummary` |
| GET | `/api/v1/repositories/:repoId/session-attribution/values` | `Repo.getSessionAttributionValues` | Value buckets for the attribute filter popover | `AttributeValueBucket` in the controller |
| GET | `/api/v1/repositories/:repoId/sessions/export-scope` | `Repo.getSessionsExportScope` | Session statistics export list (`from`/`to`, `userId`); repo owner or team owner, bypasses access mode | `logs/repositories.service.ts` `ExportSessionRow` |
| GET | `/api/v1/repositories/:repoId/contexts` | `Repo.getRepositoryContexts` | Repo contexts (owner only) | client `RepositoryContext` |
| GET | `/api/v1/repositories/:repoId/sessions/:sessionId/contexts` | `Repo.getSessionContexts` | One session's contexts (403 if not visible) | same |
| GET | `/api/v1/repositories/:repoId/sessions/:sessionId/logs` | `Repo.getSessionLogs` | Raw logs + sub-agents, workflows, advisor, attribution (owner-only rule) | `client/src/viewer/api.ts` |
| POST | `/api/v1/repositories/:repoId/sessions/:sessionId/favorite` | `Repo.setSessionFavorite` | Set/clear own favourite | `logs/dto/set-session-favorite.dto.ts` |
| GET | `/api/v1/repositories/:repoId/sessions/:sessionId/change-surface` | `Repo.getSessionChangeSurface` | Session-tree change-surface aggregate (`computed:false` if unavailable) | `logs/change-surface/change-surface.types.ts` |
| GET | `/api/v1/repositories/:repoId/sessions/:sessionId/change-surface/files` | `Repo.getSessionChangeSurfaceFiles` | Per-path rows, cap 5,000 | same |
| GET | `/api/v1/repositories/:repoId/sessions/:sessionId/okf-usage` | `Repo.getSessionOkfUsage` | Session OKF tab | `logs/okf/okf-usage.types.ts` `SessionOkfUsageResponse` |
| GET | `/api/v1/repositories/:repoId/sessions/:sessionId/otel` | `OtelFacts.getSessionOtel` | Session OTEL tab; `since=<cursor>` delta | `logs/otel/otel-facts.types.ts` `SessionOtelResponse` |

### Analytics (row-filtered, 403 when `analyticsAllowed` is false)

| Method | Path | Handler | Purpose | Types |
|---|---|---|---|---|
| GET | `/api/v1/repositories/:repoId/analytics/timeline` | `Repo.getAnalyticsTimeline` | Per-session timeline (cost, cache, lines); `groupBy` | client `TimelineSession` (controller) |
| GET | `/api/v1/repositories/:repoId/analytics/work-time` | `Repo.getAnalyticsWorkTime` | Work-time buckets; `groupBy` | client `WorkTimeBucket` (controller) |
| GET | `/api/v1/repositories/:repoId/analytics/change-surface` | `Repo.getAnalyticsChangeSurface` | Change-surface timeline; `bucket=hour\|day\|week` | `logs/change-surface/change-surface.types.ts` |
| GET | `/api/v1/repositories/:repoId/analytics/tools` | `Usage.getToolAnalytics` | Tool usage | `logs/analytics/usage-analytics.types.ts` |
| GET | `/api/v1/repositories/:repoId/analytics/tokens` | `Usage.getTokenAnalytics` | Token usage | same |
| GET | `/api/v1/repositories/:repoId/analytics/productivity` | `Usage.getProductivityAnalytics` | Productivity counters | same |
| GET | `/api/v1/repositories/:repoId/analytics/active-sessions` | `Usage.getActiveSessions` | Active sessions, `limit` ≤ 500 | same |
| GET | `/api/v1/repositories/:repoId/analytics/claude-versions` | `Usage.getClaudeVersionUsage` | Claude Code version usage | same |
| GET | `/api/v1/repositories/:repoId/otel/facts` | `OtelFacts.getRepoOtelFacts` | Repo OTEL tab (`from`/`to` ≤ 93 days) | `logs/otel/otel-facts.types.ts` `RepoOtelFactsResponse` |

### Reports (same params and gate as analytics)

| Method | Path | Handler | Purpose | Types |
|---|---|---|---|---|
| GET | `/api/v1/repositories/:repoId/reports/executive-summary` | `Reports.getExecutiveSummary` | Executive Summary ([executive-summary-report.md](executive-summary-report.md)) | `logs/reports/executive-summary.service.ts` |
| GET | `/api/v1/repositories/:repoId/reports/cache-read-ratio` | `Reports.getCacheReadRatio` | Cache Read Ratio (with causes) | `logs/reports/cache-read-ratio.service.ts` |
| GET | `/api/v1/repositories/:repoId/reports/harness-usage` | `Reports.getHarnessUsageReport` | Harness Usage ([harness-usage-tab.md](harness-usage-tab.md)) | `logs/reports/harness-usage.service.ts` |
| GET | `/api/v1/repositories/:repoId/reports/okf-usage` | `Reports.getOkfUsageReport` | Repo OKF tab; optional `bundle` | `logs/okf/okf-usage.types.ts` |
| GET | `/api/v1/repositories/:repoId/reports/change-surface` | `Reports.getChangeSurfaceReport` | Change Surface report ([change-surface.md](change-surface.md)) | `logs/change-surface/change-surface.types.ts` |
| GET | `/api/v1/repositories/:repoId/reports/attribution-breakdown` | `Reports.getAttributionBreakdownReport` | Attribute Breakdown | `logs/reports/attribution-breakdown.service.ts` |
| GET | `/api/v1/repositories/:repoId/reports/attribution-usage` | `Reports.getAttributionUsageReport` | Attribute Extraction Usage; `outcome=`, no `attr` | `logs/reports/attribution-usage.service.ts` |
| GET | `/api/v1/repositories/:repoId/reports/tool-analytics` | `Reports.getToolAnalyticsReport` | = `analytics/tools` | `logs/analytics/usage-analytics.types.ts` |
| GET | `/api/v1/repositories/:repoId/reports/token-usage` | `Reports.getTokenUsageReport` | = `analytics/tokens` | same |
| GET | `/api/v1/repositories/:repoId/reports/productivity-counters` | `Reports.getProductivityCountersReport` | = `analytics/productivity` | same |
| GET | `/api/v1/repositories/:repoId/reports/active-sessions` | `Reports.getActiveSessionsReport` | = `analytics/active-sessions` | same |
| GET | `/api/v1/repositories/:repoId/reports/claude-versions` | `Reports.getClaudeVersionUsageReport` | = `analytics/claude-versions` | same |

### Tool monitoring

See [tool-monitoring.md](tool-monitoring.md). Types: `logs/tool-monitoring/tool-monitoring.types.ts`.

| Method | Path | Handler | Purpose | Types |
|---|---|---|---|---|
| GET | `/api/v1/repositories/:repoId/tool-monitoring/config` | `Tools.getConfig` | Personal (no `teamId`) or team monitored-tools config | `ToolMonitorConfigView` |
| PUT | `/api/v1/repositories/:repoId/tool-monitoring/config` | `Tools.putConfig` | Save config (team level: team owner); 400 `{ field, code }` | same |
| GET | `/api/v1/repositories/:repoId/tool-monitoring/summary` | `Tools.getSummary` | Tools tree aggregates; optional `sessionId`, `from`/`to` | `ToolUsageSummaryResponse` |
| GET | `/api/v1/repositories/:repoId/tool-monitoring/calls` | `Tools.getCalls` | Paged calls, `pageSize` ≤ 200 | `ToolCallsPageResponse` |
| GET | `/api/v1/repositories/:repoId/tool-monitoring/calls/:usageId/:callId` | `Tools.getCallDetail` | One call with captured text; 404 if not visible | `ToolCallDetailResponse` |

## `/api/v1/repositories` — export/import

`logs/repository-export-import.controller.ts` (`RepositoryExportImportController`) · all
`session` · client `client/src/models/export-import.ts` · `JobStatusResponse`/`ExportRequestBody`
inline in the controller, `meta.json` in `logs/export-import-zip.ts` · contract `f23-export-import`.
Format, jobs, validation, ownership conflicts and bootstrap import:
[session-export-import.md](session-export-import.md).

Per-repo routes require repo owner or **team owner** (`assertRepoOwnerOrTeamOwner`); export and
import run as background jobs (`202 { jobId }`) that are polled. Uploads are `multipart/form-data`
field `file`; 422 for an invalid archive, 409 `{ conflicts[] }` for ownership conflicts.

| Method | Path | Handler | Purpose |
|---|---|---|---|
| GET | `/api/v1/repositories/:repoId/export-import/scope` | `getScopeSummary` | Session count + approximate size for a scope (`all`\|`dateRange`\|`sessionIds`) |
| POST | `/api/v1/repositories/:repoId/export` | `startExport` | Start export job |
| GET | `/api/v1/repositories/:repoId/export/:jobId/status` | `getExportStatus` | Poll export job |
| GET | `/api/v1/repositories/:repoId/export/:jobId/download` | `downloadExport` | Download finished zip (409 if not done; leaves job in place) |
| POST | `/api/v1/repositories/:repoId/import/upload` | `uploadImportZip` | Stage zip, validate, preview → `uploadToken` |
| POST | `/api/v1/repositories/:repoId/import/:uploadToken/confirm` | `confirmImport` | Start import job from staged upload |
| GET | `/api/v1/repositories/:repoId/import/:jobId/status` | `getImportStatus` | Poll import job |
| POST | `/api/v1/repositories/bootstrap-import/upload` | `uploadBootstrapImportZip` | Stage zip with no target repo (scoped by user) |
| POST | `/api/v1/repositories/bootstrap-import/:uploadToken/confirm` | `confirmBootstrapImport` | Create/resolve personal repo + import team, start import; returns `repoId` |
| GET | `/api/v1/repositories/bootstrap-import/:jobId/status` | `getBootstrapImportStatus` | Poll bootstrap import |

## `/api/v1/sessions`

`sessions/sessions.controller.ts` · contract `f18-session-delete-retention`

| Method | Path | Handler | Guard | Purpose | Types |
|---|---|---|---|---|---|
| GET | `/api/v1/sessions/retention-days` | `SessionsController.getRetentionDays` | session | Effective retention window for any user | inline `{ retentionDays }` |
| DELETE | `/api/v1/sessions/:sessionId` | `deleteSession` | session | Owner-only purge + soft delete of the session tree (`:sessionId` = public id); 204 / 404 | — |

See [data-retention.md](data-retention.md), [session-id-vs-sessionid.md](session-id-vs-sessionid.md).

## `/api/v1/teams`

`teams/teams.controller.ts` (+ `logs/otel/otel-team-facts.controller.ts`) · DTOs `teams/dto/` ·
client `client/src/models/teams.ts` · contract `f10-teams-core`, `f11-team-members`,
`f12-team-repos`, `f25-otel`

| Method | Path | Handler | Guard | Purpose | Types |
|---|---|---|---|---|---|
| POST | `/api/v1/teams` | `TeamsController.createTeam` | session | Create team (caller = owner, `restricted`) | `create-team.dto.ts` |
| GET | `/api/v1/teams` | `listTeams` | session | Own teams with caller's role flags | client `Team` |
| GET | `/api/v1/teams/pending-disclosures` | `listPendingDisclosures` | session | Teams whose access-mode disclosure the caller has not acknowledged | client `PendingDisclosure` |
| GET | `/api/v1/teams/:teamId` | `getTeam` | team-member | Team detail | client `Team` |
| PATCH | `/api/v1/teams/:teamId` | `updateTeam` | team-owner | Rename / set `accessMode`; 409 switching to `transparent` with members | `update-team.dto.ts` |
| DELETE | `/api/v1/teams/:teamId` | `deleteTeam` | team-owner | Delete team | — |
| GET | `/api/v1/teams/:teamId/members` | `getMembers` | team-member | Members with role flags; `disclosureAcknowledgedAt` only for the owner | client `TeamMember` |
| PATCH | `/api/v1/teams/:teamId/members/:userId` | `updateMember` | team-owner | Set `canInvite` / `isManager` / `isAdlcTrainer` | `update-member.dto.ts` |
| DELETE | `/api/v1/teams/:teamId/members/:userId` | `removeMember` | team-owner | Remove member | — |
| POST | `/api/v1/teams/:teamId/acknowledge-disclosure` | `acknowledgeDisclosure` | team-member | Acknowledge the live access mode (400 on mismatch) | `acknowledge-disclosure.dto.ts` |
| POST | `/api/v1/teams/:teamId/leave` | `leaveTeam` | session | Leave a team (owner → 400: transfer first) | — |
| POST | `/api/v1/teams/:teamId/transfer` | `transferOwnership` | team-owner | Transfer ownership to a member | `transfer-ownership.dto.ts` |
| GET | `/api/v1/teams/:teamId/repositories` | `getTeamRepositories` | team-member | Linked repo URLs incl. ones with no sessions; `recomputePending` | client `TeamRepository` |
| POST | `/api/v1/teams/:teamId/repositories` | `addTeamRepository` | team-owner | Link a URL; seeds `team_repo_config`, queues recompute | `add-repo.dto.ts` |
| DELETE | `/api/v1/teams/:teamId/repositories/:repoId/link` | `unlinkTeamRepository` | team-owner | Unlink a URL (config goes by FK cascade) | — |
| DELETE | `/api/v1/teams/:teamId/repositories/:repoId` | `removeTeamRepository` | team-owner | Remove team repo (and the repo row when no other team references it) | — |
| POST | `/api/v1/teams/:teamId/invitations` | `sendInvitation` | team-member | Invite by email; 404 `user_not_registered` unless `force: true` | `invite-member.dto.ts` |
| DELETE | `/api/v1/teams/:teamId/invitations/:invId` | `cancelInvitation` | team-member | Cancel an invitation | — |
| GET | `/api/v1/teams/:teamId/otel/facts` | `OtelTeamFactsController.getTeamOtelFacts` | session (membership + `analyticsAllowed` in handler) | Team OTEL tab | `logs/otel/otel-facts.types.ts` `TeamOtelFactsResponse` |

## `/api/v1/invitations`

`teams/invitations.controller.ts` · client `Invitation` in `client/src/models/teams.ts` · contract `f13-invitations`

| Method | Path | Handler | Guard | Purpose | Types |
|---|---|---|---|---|---|
| GET | `/api/v1/invitations` | `InvitationsController.listInvitations` | session | Invitations sent **and** received (filter on `inviteeId`/`inviterId`), with team name and access mode | client `Invitation` |
| PATCH | `/api/v1/invitations/:invId` | `respondToInvitation` | session | Accept/decline own invitation; accept requires `acknowledgedAccessMode` = live mode | `teams/dto/update-invitation.dto.ts` |

## `/api/v1/users`

`admin/admin.controller.ts` · contract `f06-admin-users`

| Method | Path | Handler | Guard | Purpose | Types |
|---|---|---|---|---|---|
| PATCH | `/api/v1/users/:userId/role` | `AdminController.updateUserRole` | admin | Change role (not own; keeps ≥ 1 admin) | `admin/dto/update-user-role.dto.ts` |
| POST | `/api/v1/users/:userId/reset-password-link` | `generateResetPasswordLink` | admin | Generate a reset URL for a user | inline `{ resetUrl }` |

## `/api/v1/admin`

`admin/admin-panel.controller.ts` (`AdminPanelController`), plus
`sessions/session-retention.controller.ts` and `model-pricing/model-pricing-admin.controller.ts` ·
client `client/src/models/admin.ts`, `pricing.ts` · contract `f06`–`f09`, `f18`, `f22`.
Admin rows are metadata only and link to no session data.

| Method | Path | Handler | Guard | Purpose | Types |
|---|---|---|---|---|---|
| GET | `/api/v1/admin/users` | `getUsers` | admin | All users | client `AdminUser` |
| PATCH | `/api/v1/admin/users/:id/role` | `updateUserRole` | admin | Change role | `admin/dto/update-user-role.dto.ts` |
| PATCH | `/api/v1/admin/users/:id/email` | `renameUserEmail` | admin | Rename email (409 taken) | `admin/dto/rename-user-email.dto.ts` |
| POST | `/api/v1/admin/users/:id/delete` | `deleteUser` | admin | Hard-delete another user (`confirmEmail`; not self, not last admin) — POST because of the body | `admin/dto/delete-user.dto.ts` |
| GET | `/api/v1/admin/auth` | `getAuthConfig` | admin | Active mode + SMTP/Azure settings, no secrets | client `AdminAuthConfig` |
| GET | `/api/v1/admin/auth/pending-registrations` | `getPendingRegistrations` | admin | Unconfirmed Mode 3 accounts | client `PendingRegistration` |
| POST | `/api/v1/admin/auth/pending-registrations/:id/resend` | `resendPendingRegistration` | admin | Resend confirmation (shared 60 s cooldown) | — |
| DELETE | `/api/v1/admin/auth/pending-registrations/:id` | `revokePendingRegistration` | admin | Delete an unconfirmed account | — |
| GET | `/api/v1/admin/repos` | `getRepos` | admin | All repos + orphan team links, sizes, team names | `admin/admin.service.ts`; client `AdminRepo` |
| DELETE | `/api/v1/admin/repos/:id` | `removeRepo` | admin | Remove every repository row of that URL with its logs and sessions | — |
| DELETE | `/api/v1/admin/team-repos/:teamRepoId` | `removeOrphanTeamRepo` | admin | Remove an orphan team link only (404 otherwise) | — |
| GET | `/api/v1/admin/teams` | `getTeams` | admin | All teams | client `AdminTeam` |
| GET | `/api/v1/admin/teams/:teamId/members` | `getTeamMembers` | admin | Member identities only | client `AdminTeamMember` |
| POST | `/api/v1/admin/teams/:teamId/owner` | `setTeamOwner` | admin | Set a member as new owner | `teams/dto/transfer-ownership.dto.ts` |
| GET | `/api/v1/admin/system` | `getSystemInfo` | admin | Cluster/CPU/memory/DB/disk/build info ([system-info-and-cluster.md](system-info-and-cluster.md)) | `system-info/system-info.types.ts` |
| GET | `/api/v1/admin/error-logs` | `getErrorLogs` | admin | Latest 30 `ERROR` lines from `server/logs/` ([log-subsystem.md](log-subsystem.md)) | `error-logs/error-logs.types.ts` |
| GET | `/api/v1/admin/logs-archive` | `downloadLogsArchive` | admin | Zip of the logs directory | — |
| GET | `/api/v1/admin/upload-queue` | `getUploadQueue` | admin | Queue rows ([upload-queue.md](upload-queue.md)) | `admin/upload-queue-admin.service.ts` |
| GET | `/api/v1/admin/upload-queue/stats` | `getUploadQueueStats` | admin | Throughput / latency / drain ETA | `admin/upload-queue-stats.service.ts` |
| GET | `/api/v1/admin/upload-queue/:id/file` | `downloadUploadQueueFile` | admin | Download a staged file | — |
| DELETE | `/api/v1/admin/upload-queue/failed` | `clearFailedUploadQueue` | admin | Delete failed rows + files | inline `{ deletedCount }` |
| POST | `/api/v1/admin/upload-queue/reprocess-failed` | `reprocessFailedUploadQueue` | admin | Reset failed rows to pending | inline `{ updatedCount }` |
| GET | `/api/v1/admin/retention` | `SessionRetentionController.getRetention` | admin-or-team-owner | Retention window + server-wide session age/size series ([data-retention.md](data-retention.md)) | `RetentionResponse` in the controller |
| GET | `/api/v1/admin/model-pricing` | `ModelPricingAdminController.list` | admin | Price table with source/state | `model-pricing/model-pricing.types.ts` |
| PUT | `/api/v1/admin/model-pricing/price` | `setPrice` | admin | Price an `unpriced`/`manual` model (id in body: ids contain `/`) | `model-pricing/dto/model-price-input.dto.ts` |
| PUT | `/api/v1/admin/model-pricing/override` | `setOverride` | admin | Override a fetched price (409 on future row) | same |
| POST | `/api/v1/admin/model-pricing/override/clear` | `clearOverride` | admin | Remove an override | `model-pricing/dto/model-id.dto.ts` |
| POST | `/api/v1/admin/model-pricing/fetch-anthropic` | `fetchAnthropic` | admin | Fetch Anthropic prices now (`{ result }`, never an HTTP error) | `model-pricing/model-pricing.types.ts` |
| POST | `/api/v1/admin/model-pricing/import-openrouter` | `importOpenRouter` | admin | Import OpenRouter prices (502 on fetch failure) | same |

Model pricing states and rules: [model-pricing-research.md](model-pricing-research.md).
Account deletion cascade: [authorization-and-authentificaiton.md](authorization-and-authentificaiton.md) § "Account deletion".

---

## Removed routes

- `POST /api/v1/logs` — removed; answers 404 (hooks < 1.7.0). Use `POST /api/v2/logs`.
