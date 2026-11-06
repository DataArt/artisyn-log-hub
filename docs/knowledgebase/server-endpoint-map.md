---
type: "API Endpoint Map"
title: "Server HTTP API map"
description: "The server's HTTP API: guards legend, access-control rules, cross-cutting API behaviour (security headers, errors, body limits, hook-route compatibility), a one-line-per-controller index and the routes whose behaviour is not obvious from their code."
tags:
  - server
  - api
  - auth
timestamp: "2026-11-05T00:00:00+04:00"
---

# Server HTTP API map

This article holds what the controllers do not say on their own: guards, access rules,
cross-cutting conventions, hook-route compatibility and the routes with surprising behaviour. It
does **not** list every route — find routes with one grep (`@Get(` / `@Post(` / `@Put(` /
`@Patch(` / `@Delete(` under `server/src`, or the `ce` skill), starting from the
[controller index](#controller-index).

Request/response shapes live in the DTO / `*.types.ts` files and in the API contract registry
(`server/test/contract/registry/f<NN>-*.ts`, one family per area; the router meta-test fails
when a route has no row). Client twins of most response types live in
`client/src/models/<area>.ts`; the raw session logs payload is typed in `client/src/viewer/api.ts`.
Update this article when a guard, an access rule or a cross-cutting convention changes, when a
controller is added, or when a new route has behaviour a reader would not guess.

---

## Guards legend

Guard shorthands used below (class-level and method-level `@UseGuards` combined):

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
- **Owner-only data** — `GET .../sessions/:sessionId/logs` and its incremental twin
  `.../logs/delta` (raw conversation; one shared check, `resolveSessionLogsAccess`) are owner-only
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
    empty / `computed: false` payload for a session outside the scope instead of a 404 (the
    OKF agent trail is the exception: 404, since it names one agent of the tree);
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
  `LOGS_MAX_BODY_MB` (counted decompressed); the hook JSON POSTs listed in `HOOK_API_ROUTES` get
  `HOOK_API_BODY_LIMIT`; everything else `GLOBAL_BODY_LIMIT`. A new hook-called POST must be
  added to `HOOK_API_ROUTES`. Parsers are wrapped in `throwMiddlewareErrors()` so a 413/400 is not
  rewritten to 404 by serve-static. Details: [hook-api-versioning.md](hook-api-versioning.md) § "Per-route body limits".
- **Pagination / caps** — lists are mostly unpaginated. The explicit caps are constants:
  `CALLS_PAGE_SIZE_MAX` (tool-monitoring calls), `ACTIVE_SESSIONS_MAX_LIMIT`,
  `CHANGE_SURFACE_MAX_FILE_ROWS` (with a `truncated` flag), `OTEL_MAX_PERIOD_DAYS` /
  `OTEL_SESSIONS_LIMIT` (repo OTEL facts), `OTEL_REALTIME_MAX_LINES`.
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
  ([algorithms/password-policy.md](algorithms/password-policy.md)). `change-password` signs out every
  other session.
- `azure-oauth`: `GET /api/v1/auth/azure` → Microsoft → `GET /api/auth/callback` (outside
  `/api/v1` on purpose: it is the redirect URI registered in Azure). Failures redirect to
  `/#/login?oauthError=1`.
- All modes: `logout`, `me`, `delete-account`; the client pings `GET /api/v1/ping` every 60 s to
  renew the session.

---

## Controller index

Paths relative to `server/src/`. "Types" = where the request/response types live besides the
controller itself. Several controllers share the `api/v1/repositories` prefix — grep all of them.

| Controller | Prefix | Area | Types / contract family |
|---|---|---|---|
| `health/health.controller.ts` | `/health` | Terminus check, build info | `common/build-info.ts` · `f01` |
| `installer/installer.controller.ts` | `/static` | Hook installer tarball download | — · `f01` |
| `auth/ping.controller.ts` | `/api/v1/ping` | Session keep-alive (204) | — · `f02` |
| `auth/auth.controller.ts` | `/api/v1/auth` | Login, signup, identify, password flows, `me`, `config` | `auth/dto/`, client `models/auth.ts` · `f02`, `f03` |
| `auth/azure/azure-callback.controller.ts` | `/api/auth` | Azure OIDC callback | — · `f03` |
| `api-keys/api-keys.controller.ts` | `/api/v1/api-keys` | Own API keys CRUD | `api-keys/dto/` · `f04` |
| `user-settings/user-settings.controller.ts` | `/api/v1/user-settings` | Per-user key/value store | `user-settings/dto/`, client `models/user-settings.ts` · `f05` |
| `logs/model-pricing.controller.ts` | `/api/v1/model-pricing` | Public price table (hook-facing) | `PublicModelPricingEntry` in the controller · `f22` |
| `ai-tool-versions/ai-tool-versions.controller.ts` | `/api/v1/ai-tool-versions` | Tool release history | `ai-tool-versions.types.ts` · `f22` |
| `logs/logs.controller.ts` | `/api/v1` | `log-echo` (installer key check) | — · `f15` |
| `logs/logs-v2.controller.ts` | `/api/v2` | `POST logs` — the only upload route | in the controller; [upload-queue.md](upload-queue.md) · `f15` |
| `logs/post-turn-analysis/post-turn-analysis.controller.ts` | `/api/v2/post-turn-analysis` | Post-turn gate config (hook) | `post-turn-analysis-response.types.ts` · `f16` |
| `logs/turn-end-cost-advisor/turn-end-cost-advisor.controller.ts` | `/api/v2/turn-end-cost-advisor` | Advisor run submit (hook) | `…/dto/` · `f16` |
| `logs/session-attribution/session-attribution.controller.ts` | `/api/v2/session-attribution` | Attribute values submit (hook) | `…/dto/` · `f16` |
| `logs/okf/okf-facts.controller.ts` | `/api/v2/okf-usage` | KB-access facts for a local skill (hook key) | `logs/okf/okf-usage.types.ts` · `f16` |
| `logs/tool-monitoring/tool-monitoring-hook.controller.ts` | `/api/v2/tool-monitoring` | Monitored-tools config for the hook | `tool-monitoring.types.ts` · `f24` |
| `logs/otel/otel-realtime.controller.ts` | `/api/v2/otel-realtime` | Realtime OTEL batch from the receiver | `OtelRealtimeDto` in the controller · `f25` |
| `logs/repositories.controller.ts` | `/api/v1/repositories` | Repos, settings, hook state, sessions, session logs (+ delta), change surface, session OKF, timeline / work-time analytics | `logs/repositories.service.ts`, `logs/dto/`, client `models/repositories.ts` · `f14`, `f17`, `f19`, `f20` |
| `logs/analytics/usage-analytics.controller.ts` | `/api/v1/repositories` | `analytics/{tools,tokens,productivity,active-sessions,claude-versions}` | `usage-analytics.types.ts` · `f20` |
| `logs/reports/reports.controller.ts` | `/api/v1/repositories` | `reports/*` (incl. repo `okf-usage` and `okf-usage/article`) | `logs/reports/*.service.ts` · `f21` |
| `logs/otel/otel-facts.controller.ts` | `/api/v1/repositories` | Repo and session OTEL tabs | `logs/otel/otel-facts.types.ts` · `f25` |
| `logs/otel/otel-live.controller.ts` (`OtelLiveController`) | `/api/v1/otel/live` | OTEL Live view: `status` (header entry) and the live tree (`node`, `panel`, `tz`), user-wide | `logs/otel/otel-live.types.ts`, client `models/otel-live.ts` · `f25` |
| `logs/tool-monitoring/tool-monitoring.controller.ts` | `/api/v1/repositories` | Tools/MCP tab config, summary, calls | `tool-monitoring.types.ts` · `f24` |
| `logs/repository-export-import.controller.ts` | `/api/v1/repositories` | Export, import, bootstrap import (background jobs) | inline + `logs/export-import-zip.ts`, client `models/export-import.ts` · `f23` |
| `sessions/sessions.controller.ts` | `/api/v1/sessions` | Retention days, session delete | — · `f18` |
| `sessions/session-retention.controller.ts` | `/api/v1/admin/retention` | Retention window + age/size series | `RetentionResponse` in the controller · `f18` |
| `teams/teams.controller.ts` | `/api/v1/teams` | Teams, members, disclosure, team repos, invitations sent | `teams/dto/`, client `models/teams.ts` · `f10`–`f12` |
| `logs/otel/otel-team-facts.controller.ts` | `/api/v1/teams` | Team OTEL tab | `otel-facts.types.ts` · `f25` |
| `teams/invitations.controller.ts` | `/api/v1/invitations` | Invitations sent and received, respond | `teams/dto/` · `f13` |
| `admin/admin.controller.ts` | `/api/v1/users` | Role change, reset-password link | `admin/dto/` · `f06` |
| `admin/admin-panel.controller.ts` | `/api/v1/admin` | Users, auth settings, pending registrations, repos, teams, system info, error logs, upload queue | `admin/*.service.ts`, client `models/admin.ts` · `f06`–`f09` |
| `model-pricing/model-pricing-admin.controller.ts` | `/api/v1/admin/model-pricing` | Admin price table, overrides, fetch/import | `model-pricing/model-pricing.types.ts`, `dto/` · `f22` |
| `log-hub-release/log-hub-release.controller.ts` | `/api/v1/admin/log-hub-release` | `admin`: new Log Hub release badge state (read-only; GitHub fetch runs in the scheduler) | `log-hub-release/log-hub-release.types.ts`, client `models/admin.ts` · `f01` |

Feature articles own the semantics behind each area: [upload-queue.md](upload-queue.md),
[turn-end-cost-advisor.md](turn-end-cost-advisor.md), [okf-usage.md](okf-usage.md),
[tool-monitoring.md](tool-monitoring.md), [otel-tabs.md](otel-tabs.md),
[session-export-import.md](session-export-import.md), [data-retention.md](data-retention.md),
[system-info-and-cluster.md](system-info-and-cluster.md), [log-subsystem.md](log-subsystem.md),
[model-pricing-research.md](model-pricing-research.md), [claude-version-check.md](claude-version-check.md).

---

## Routes with non-obvious behaviour

Only routes whose behaviour a reader would not guess from the handler name. Everything else:
grep the controller.

**Infra and hook-facing**

- `GET /static/artisyn-hooks-installer.tgz` — excluded from `ServeStaticModule` so the controller
  serves it; a valid `?v=x.y.z` raises `public/static/latest-hook-version.json` (max-wins), which
  drives the hook "outdated" flag; a bad `?v` is ignored, never a 400.
- `GET /api/v1/model-pricing` — **public** so the hook can price sessions locally; hook-facing, so
  its shape only grows (optional `asOf=YYYY-MM-DD`).
- `POST /api/v1/log-echo` — the installer's API-key check; must keep answering 200.
- `POST /api/v2/logs` — only stages the raw body into `upload_queue`; parsing happens later in
  the scheduler, so a 200 does not mean the session is visible yet. Chunk / snapshot params and
  responses: [hook-api-versioning.md](hook-api-versioning.md), [upload-queue.md](upload-queue.md).
- `POST /api/v2/turn-end-cost-advisor` answers `applied:false` before the session is ingested;
  `POST /api/v2/session-attribution` applies only a newer `promptWatermark`.
- `POST /api/v2/otel-realtime` — 409 for a session of another user, `ignored:'deleted'` for a
  deleted one.

**Auth**

- `GET /api/auth/callback` sits outside `/api/v1` on purpose: it is the redirect URI registered
  in Azure. Failures redirect to `/#/login?oauthError=1`.
- `POST /api/v1/auth/delete-account` requires `{confirm:'delete'}` and 400s for the last admin.

**Repositories and sessions** (all `session`; access per the rules above)

- `GET …/sessions/:sessionId/logs` and `…/logs/delta` share one access chain
  (`logs/session-logs-access.ts`, owner-only rule). The delta route (Session Map poll) takes an
  opaque `cursor`: absent / invalid / oversized → full snapshot; next cursor `''` when too long;
  `workflows: null` means unchanged; `{reload:true}` when the stored logs no longer extend the
  cursor. Types: `logs/dto/session-logs-delta.dto.ts`.
- `GET …/sessions/export-scope` (statistics export) is repo owner or team owner and bypasses the
  team access mode.
- `PUT …/settings/team` is team owner only; both settings PUTs trigger a recompute, except when
  the stored and new config differ only in the `okf` thresholds section (read-time settings). An
  invalid `okf` → 400 `okf.<field> …`; every settings response carries `okfDefaults` and
  `okfFixedLimits`.
- `GET …/hook-state` answers 404 when the repo never reported hook state.
- `GET …/sessions/:sessionId/okf-usage/trail?agent=` (the session OKF tab's agent trail) resolves
  the same scope, 403 and team rules as `…/okf-usage` (`resolveChangeSurfaceSessionScope`), but
  answers **404**, not the empty payload, when the session has no visible row in the scope or
  `agent` is not a node of its tree; missing `agent` → 400. It reparses the node's stored
  transcript per request (like the facts route) and writes nothing ([okf-usage.md](okf-usage.md)).
- Each `reports/X` that mirrors an `analytics/X` returns a byte-identical body (same service).
- `GET …/reports/okf-usage` and `GET …/reports/okf-usage/article?path=` (the per-article
  drill-down) share the scope and the 403 of `harness-usage` (`resolveUsageScope`) and the OKF
  team filter. The article route answers 400 without `path`, and 200 with `found: false` (never
  404) for a `path` that is not a stored KB article in the scope. Both are read-only and resolve
  the OKF thresholds per section ([okf-usage.md](okf-usage.md)).
- Export/import: jobs answer `202 { jobId }` and are polled; uploads are `multipart/form-data`
  field `file`; 422 invalid archive, 409 `{ conflicts[] }`; the download leaves the job in place
  (no GET mutates). `bootstrap-import/*` has no target repo and is scoped by user.

**Teams**

- `PATCH /api/v1/teams/:teamId` → 409 when switching to `transparent` with members.
- `POST /api/v1/teams/:teamId/leave` is only `session`-guarded; an owner gets 400 (transfer first).
- `POST /api/v1/teams/:teamId/invitations` → 404 `user_not_registered` unless `force: true`;
  accepting (`PATCH /api/v1/invitations/:invId`) requires `acknowledgedAccessMode` = the live mode.
- `DELETE …/repositories/:repoId/link` unlinks only (config goes by FK cascade);
  `DELETE …/repositories/:repoId` also removes the repo row when no other team references it.
- `GET /api/v1/teams/:teamId/otel/facts` is only `session`-guarded; membership and
  `analyticsAllowed` are checked in the handler.

**OTEL Live** (`session`; [otel-tabs.md](otel-tabs.md) § "Live view")

- `GET /api/v1/otel/live/status` and `GET /api/v1/otel/live` take no repository or team id: they
  cover the caller's own (No team) sessions plus every team the caller belongs to. They
  **row-filter and never 403** — a team whose analytics the caller may not see is shown with only
  the caller's own sessions (`restricted: true`), and a well-formed `node` / `panel` key the caller
  cannot see, or one without data, answers 200 with `selected: 'home'`. Only a malformed key
  (or one over 320 chars) or an unknown `tz` is a 400. `status` is declared before `@Get()`.

**Admin** (rows are metadata only and link to no session data)

- `POST /api/v1/admin/users/:id/delete` is a POST because it carries a body (`confirmEmail`).
- `GET /api/v1/admin/retention` is `admin-or-team-owner`, not `admin`.
- Model pricing: model ids contain `/`, so `PUT …/model-pricing/price` and `…/override` carry the
  id in the body; `fetch-anthropic` never answers an HTTP error (`{ result }`), while
  `import-openrouter` answers 502 on a fetch failure; an override over a future row → 409.

## Removed routes

- `POST /api/v1/logs` — removed; answers 404 (hooks < 1.7.0). Use `POST /api/v2/logs`.
