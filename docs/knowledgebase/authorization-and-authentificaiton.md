---
type: "Overview"
title: "Authorization and Authentication"
description: "The four configurable auth modes, their env vars, per-mode route gating, the auth security hardening (TRUST_PROXY, brute-force login delay, self-service password change and account deletion), how Mode 1's localhost gate works inside a container, and the per-team access modes that decide whose sessions and prompts a caller may read."
tags:
  - auth
timestamp: "2026-08-06T22:00:00+04:00"
---

# Authorization and Authentication

Authentication is server-side session-based (`express-session` + `connect-pg-simple`, `auth_sessions`
table), unchanged across all four modes — `SessionAuthGuard`/`SessionSerializer` don't vary by mode. What varies is
**how a session gets established in the first place**, controlled by a single env var:

## `AUTH_MODE` — one of four mutually exclusive modes

| Value              | Mode                                     | How a session is established                                                                               |
|--------------------|------------------------------------------|------------------------------------------------------------------------------------------------------------|
| `none`             | Mode 1 — no auth                         | `POST /api/v1/auth/identify { email }`, localhost-only (`127.0.0.1`/`::1`, plus the container's own private default gateway when containerized — see [Mode 1 inside a container](#mode-1-inside-a-container)), auto-provisions on first sight |
| `password`         | Mode 2 — email + password                | Today's signup/login, no email confirmation step                                                           |
| `password-confirm` | Mode 3 — email + password + confirmation | Like Mode 2, but the account is unusable until the emailed confirmation link is clicked                    |
| `azure-oauth`      | Mode 4 — Azure Entra ID (OAuth/OIDC)     | `GET /api/v1/auth/azure` → Microsoft → `GET /api/auth/callback`, via `@azure/msal-node`                    |

Validated fail-fast at startup (`server/src/auth/config/auth-startup-validation.ts`, called from
`app.module.ts`) — the server refuses to start with an unrecognized `AUTH_MODE`, or with the active mode's own required
config missing (e.g. `AZURE_CLIENT_SECRET` for Mode 4,
`ADMIN_CONTACT_EMAIL`/`SMTP_HOST`/`SMTP_PORT`/`SMTP_FROM` for Mode 3). Further startup rules:

- **Modes 2 and 3 in production** (`isProduction()` = `NODE_ENV === 'production'`, `server/src/common/runtime-env.ts`;
  set by the Dockerfile runtime stage and the release bundle `.env`, never by dev/e2e) require `PUBLIC_BASE_URL` to be
  an absolute `http(s)` URL (`validateMode2` / `validateMode3`). Outside production it is optional.
- **Mode 3** also validates `ALLOWED_EMAIL_DOMAINS` (see the allow-list section below).
- **Mode 4** requires `AZURE_TENANT_ID` to be a tenant GUID (see the Azure tenant section below). **Mode 1 requires no config at all** — no
fixed/env-configured identity exists in this mode; Modes 1 and 4 never use SMTP (no transporter, no connection).

**SMTP per mode.** The `SMTP_*` block (`SMTP_HOST`/`SMTP_PORT`/`SMTP_FROM`, port an integer 1–65535) is checked by one
shared `validateSmtpBlock()` in `auth-startup-validation.ts`:

- **Mode 2 (`password`) — SMTP is optional.** `validateMode2()` calls `validateSmtpBlock()` only when `SMTP_HOST`
  (trimmed) is non-empty; when it is unset (or whitespace) every other `SMTP_*` value is ignored. With SMTP set, a relay
  that cannot be reached at startup only logs the warning
  `SMTP connection warm-up failed (will retry lazily on first send): <err>`. Without SMTP, password reset is
  unavailable: `GET /api/v1/auth/config` returns `passwordResetAvailable: false`, the login page shows "Forgot
  password?" disabled with the hint "SMTP server is not configured", and `POST /api/v1/auth/forgot-password` answers
  `{ email_delivery: 'failed' }` without issuing a token. `ADMIN_CONTACT_EMAIL` stays optional.
- **Mode 3 (`password-confirm`) — SMTP is required and must be reachable.** `validateMode3()` always calls
  `validateSmtpBlock()`, and `MailService.onModuleInit()` verifies the relay: a failed `verify()` throws
  `SMTP relay <host>:<port> is unreachable; AUTH_MODE=password-confirm requires a working relay: <err>`, so the app
  does not start (`main.ts` → `logFatalError` → exit 1; the cluster crash budget then stops the instance). The
  account is unusable until the confirmation email is delivered, so the mode cannot run without a relay. Under
  `NODE_ENV=test` (the contract suite runs Mode 3 with no relay) the failure stays a warning, like Mode 2.
- `SMTP_USER`/`SMTP_PASSWORD` are optional in both modes; `SMTP_SECURE` is optional (unset = `false`).

**`AUTH_MODE` unset or empty defaults to Mode 2 (`password`)**, rather than failing fast — legacy compatibility for
every install that predates `AUTH_MODE`, which all ran what is now called Mode 2 with no such env var existing at
all. An explicitly-set-but-unrecognized value (e.g. a typo)
still throws at startup — only "not set at all" is treated as "assume Mode 2".

A second env var, `PASSWORD_POLICY` (`any` | `mid` | `long`, default `long`), controls the strength rule applied to every
password set under Mode 2/3 (`applyPasswordPolicy()`, `server/src/auth/utils/password-policy.ts`)
— read directly from `process.env` rather than validated per-call, since the startup validator already guarantees a
valid value. See [Password Requirements](password-requirements.md) for the exact per-level thresholds.

### Signup and the session

`POST /api/v1/auth/signup` (`AuthController.signup()`, `server/src/auth/auth.controller.ts`) opens a session
**only in Mode 2 (`password`)**: it calls `req.logIn` with the new user and the client goes straight to `/main`.
In **Mode 3 (`password-confirm`)** signup creates the unconfirmed account, sends the confirmation email and returns
`{ ...profile, email_delivery }`, but opens **no** session (no `validateUser`, no `req.logIn`; `GET /api/v1/auth/me`
stays `401`). The user confirms the email and then logs in. `SignupPage.tsx` shows the "check your email" screen
whenever the response carries `email_delivery`. Covered by the mode-B auth scenarios (`tests/scenarios/auth/`).

## `TRUST_PROXY` — running behind a reverse proxy

`TRUST_PROXY` takes Express's own `trust proxy` values — unset/`false` (off, the default), `true`, a hop count (`1`), or
a comma-separated IP/CIDR list — parsed by
`server/src/common/trust-proxy.ts` (`parseTrustProxy`) and applied in two places:

- `main.ts` — `app.set('trust proxy', <parsed>)`, but only when the parsed value is not `false`.
- `app.module.ts` — when enabled, the session middleware switches to `cookie.secure: 'auto'` +
  `proxy: true`, so the cookie's secure flag is derived per request from `X-Forwarded-Proto`.

**When enabled, `TRUST_PROXY` overrides `COOKIE_SECURE`.** That is deliberate: `release-template/.env.example`
ships `COOKIE_SECURE=false`, so letting an explicit `COOKIE_SECURE` win would make the new flag a no-op for exactly the
TLS-terminating-proxy deployments it exists for. Off (the default), the secure expression stays byte-for-byte what it
always was, so no existing install changes behaviour.

The same flag is what makes `req.ip` report the real client instead of the proxy's socket peer — which is what the
per-IP dimension of the login backoff below depends on.

## Brute-force login delay

`LoginBackoffService` (`server/src/auth/login-backoff.service.ts`) is called from
`LocalStrategy.validate()` — which passes `passReqToCallback: true` so it can read
`req.ip ?? req.socket.remoteAddress`. Two dimensions are counted independently, the account (lowercased email) and the
source IP, and the applied delay is `max(account, ip)`:

- 1st failure is free; the 2nd blocks for 1s, the 3rd for 2s, the 4th for 3s, … (`consumedPoints - 1`).
- A blocked attempt returns `429` with `Retry-After` (via `TooManyRequestsException`) **without**
  touching the counters — a rejected request must not extend its own penalty.
- A correct password clears the *account* counter, and does so **before** the Mode 3
  `email_not_confirmed` check: the credential itself was valid, so it is not a failed password attempt.
- A success never clears the *IP* counter — one good login must not wipe the history of an IP that is walking through
  other accounts.

State lives in two `rate-limiter-flexible` `RateLimiterMemory` instances (used purely as a counter + TTL store with a
huge points budget, never as a rejecter, so the schedule stays exactly as specified). It is therefore **per process and
in-memory**: a restart forgives everyone and a multi-worker deployment sees a fraction of the attempts per worker. That
is the accepted trade-off — this is a speed bump, not a lockout. Disabled entirely under `NODE_ENV=test` (the whole e2e
suite shares one app process and one source IP, so the per-IP dimension would otherwise 429 unrelated specs).

## Rate limits on signup / forgot / resend / reset

`AuthRateLimitService` (`server/src/auth/auth-rate-limit.service.ts`) — separate from the login backoff above — limits
the unauthenticated routes that send email or accept a token. It is a plain `RateLimiterMemory` rejecter:

- `AUTH_RATE_LIMIT_POINTS` (default `5`; `0` disables limiting) requests per `AUTH_RATE_LIMIT_WINDOW_SEC`
  (default `900`) per key. Both are read once in the service constructor, so each app instance gets its own limiter;
  a spec overrides them by setting `process.env` before `createTestApp()` (`server/test/helpers/create-app.helper.ts`); the jest global setup sets `AUTH_RATE_LIMIT_POINTS=1000`.
- Keys: `<route>:i:<ip>` and `<route>:a:<lowercased email>`, routes `signup` | `forgot` | `resend` | `reset`
  (`AUTH_RATE_LIMIT_ROUTES`).
- `consumeIp()` throws `TooManyRequestsException` (429 + `Retry-After`); `consumeEmail()` returns `false` and never
  throws.
- **signup**: over either the IP or the email limit → 429. **forgot / resend**: over the IP limit → 429; over the email
  limit → the normal success response with no email sent (no enumeration signal). **reset**: IP limit only.
- Per process, in memory: with N cluster workers the effective limit is about N × the setting (documented as an accepted
  risk in `client/public/help/security-hardening.md` §11).
- Unlike the login backoff it is **not** disabled under `NODE_ENV=test`; the contract suite's global setup
  (`server/test/contract/setup/global-setup.ts`) and the scenario stand set `AUTH_RATE_LIMIT_POINTS=1000`, and the dev server used by e2e runs
  with `AUTH_RATE_LIMIT_POINTS=0`.

## Mode 3 email-domain allow-list

`ALLOWED_EMAIL_DOMAINS` (comma-separated) is parsed by `parseAllowedEmailDomains()`
(`server/src/auth/config/allowed-email-domains.ts`): split on `,`, trim + lowercase each element; an empty element, one
containing `@` or internal whitespace, or one not matching `/^[a-z0-9-]+(.[a-z0-9-]+)+$/` throws. `validateMode3`
calls it, so a malformed value stops the server at startup. Unset/empty → `[]` = no restriction.

`AuthService.signup()` checks it in **Mode 3 only**, before the duplicate-email 409, by exact domain match
(subdomains are not implied). A rejection is `400 { error: 'email_domain_not_allowed', message: 'Sign-up is limited to
these email domains: a, b' }`; `SignupPage.tsx` shows `message` in its existing error line. Existing accounts and
logins are unaffected.

## Self-service password change

`POST /api/v1/auth/change-password` (Mode 2/3, `SessionAuthGuard`) — `AuthService.changePassword()`
verifies the current password, applies `applyPasswordPolicy`, then:

- **Signs every other device out.** `AuthSessionsService.deleteOtherSessionsForUser(userId, req.sessionID)`
  deletes the user's `auth_sessions` rows except the caller's own. That table is created by
  `connect-pg-simple`, so it has no Drizzle schema entry and is reached through raw `sql`; the user id is compared **as
  text** (`sess -> 'passport' ->> 'user'`) because `SessionSerializer` stores the bare numeric id and a JS number on the
  right-hand side would raise `operator does not exist: text = integer`. Every method there swallows its errors — by the
  time they run the password change has already committed, so a pruning failure must not turn a successful request into
  a 500.
- **Sends a best-effort notification** (`MailService.sendPasswordChangedEmail`), reported as
  `email_delivery: 'sent' | 'failed' | 'skipped'`. `'skipped'` means `MailService.isConfigured()` was false, so
  nothing was even attempted. `isConfigured()` is per mode: true iff `AUTH_MODE` is `password` or
  `password-confirm` **and** `SMTP_HOST` (trimmed) is non-empty — so in practice Mode 2 without SMTP (Mode 3 always
  has a host outside `NODE_ENV=test`). None of the three outcomes fails the change.

A wrong current password returns **403**, not 401: the client's `apiFetch()` force-navigates to the login page on any
401, which would eject the user from the dialog mid-change.

## Account deletion

Two routes, one service — `AccountDeletionService.hardDeleteUser(userId, actor)`
(`server/src/users/account-deletion.service.ts`):

- `POST /api/v1/auth/delete-account` — self-service, body `{ confirm: 'delete' }`, then destroys the session and clears
  `connect.sid`.
- `POST /api/v1/admin/users/:id/delete` — admin, body `{ confirmEmail }` which must case-insensitively match the
  **target's** email. An admin cannot delete their own account here (that would leave a live session bound to a deleted
  row) — 400, use the self-service route.

The delete is a single transaction. It takes a `FOR UPDATE` lock on the target row and refuses the **last remaining
admin** (400) inside that transaction, so a concurrent role change cannot slip past the guard. It then removes what the
FK cascades cannot reach — `invitations` (both FKs are `NO ACTION`), teams the user owns (`teams.owner_id` is
`ON DELETE RESTRICT`), and `team_repositories` rows for repo urls no other user still claims — deletes the `users` row
(cascading `api_keys`, tokens, `repositories`,
`logs`, `logs_otel`, `team_members`, `upload_queue`, `export_import_jobs`, `repo_config`,
`session_file_stats`, `session_cause_stats`, `user_favorite_sessions`), and finally drops `sessions`
rows left with no `logs` row at all (ids captured before the delete, inside the transaction).
`auth_sessions` pruning runs after the commit, outside the transaction.

There is **no soft-delete and no recovery** — this is a deliberate product decision: all of the user's data goes,
logs included.

## Security event logging

Login success/failure/delay-applied lines come from `LocalStrategy`; signup, email confirmation, forgot-password (token
issued vs. cooldown), reset-password and change-password lines from
`AuthService`; account deletion (deleted id + email, acting user id, `self-service` vs. `admin`) from
`AccountDeletionService`. All of them are structured as `key=value` pairs and carry **emails and user ids only** — never
a password, a password hash, or a reset/confirmation token. Logs land in
`server/logs/app-YYYY-MM-DD.log` (see `.claude/rules/server.md`).

## Per-mode route gating

Every mode-specific route is decorated `@AllowedAuthModes(...modes)` + `@UseGuards(AuthModeGuard, ...)`
(`server/src/auth/guards/auth-mode.guard.ts`) — the guard 404s the route (not 403, to avoid confirming it exists) when
the active `AUTH_MODE` isn't in its allow-list, checked before any credential/session guard runs. Routes with no
`@AllowedAuthModes` (`logout`, `me`, `GET config`) are active in every mode. See `server-endpoint-map.md`'s
`/api/v1/auth`/`/api/auth` sections for the full per-route matrix.

`GET me` has one further mode-conditional wrinkle even though it carries no `@AllowedAuthModes`:
`AutoIdentifyGuard` (`server/src/auth/guards/auto-identify.guard.ts`) runs ahead of `SessionAuthGuard`
and, in Mode 1 (`none`) only, silently logs an unauthenticated local caller in — picking whichever user is the sole
row in `users`, or `id=1` when there is more than one — instead of letting it 401 (`AuthService.autoIdentifyMode1()`).
"Local" is whatever `isLocalhostRequest()` accepts: `127.0.0.1`/`::1`, plus the container's own private default gateway
when the server runs inside a container (see below). This exists so a local Mode 1 install never needs its session
cookie to survive: identity is re-derived from `users` on every `GET me` rather than remembered. It is a no-op for every
other mode, for non-local requests, and for already-authenticated requests, so it does not widen Mode 1's existing
security model beyond that one address.

## Mode 1 inside a container

Mode 1's only security control is the TCP peer address check in
`server/src/auth/utils/localhost.util.ts` (`isLocalhostRequest()`), used by both
`POST /api/v1/auth/identify` (403 otherwise) and `AutoIdentifyGuard` (no-op otherwise, so `GET me` 401s).
It reads `req.socket.remoteAddress` only and **deliberately ignores `X-Forwarded-For`** — `TRUST_PROXY` makes
Express honour `X-Forwarded-*` for `req.ip`/`req.protocol`, but as a security signal that header stays trivially
spoofable, so this gate never consults it.

Inside a container that check could never pass, which made the released image unusable in its own shipped default mode:
a host connection to a published port (`ports: "127.0.0.1:5003:3000"`) arrives **from the container's default gateway**
(verified `::ffff:172.17.0.1` on a Docker bridge), never from loopback, and port publishing is NAT/userland forwarding,
so no `X-Forwarded-*` header exists to recover the real client from. When the server detects it is
containerized it additionally trusts **exactly one** extra address: its own default gateway — never a subnet, never a
CIDR.

`server/src/auth/utils/container-gateway.util.ts` implements it, as pure functions over an injected `FsProbe`
(so the spec covers cgroup v1 *and* v2, podman, k8s and bare-host inputs without a container):

- **Detection** (`isContainerized()`) — layered, cheapest-first, any single signal is enough:
  - *Tier 1, marker files:* `/.dockerenv`, `/run/.containerenv`, `/run/.toolboxenv`, `/.dockerinit`.
  - *Tier 2, platform env vars:* `KUBERNETES_SERVICE_HOST`, `ECS_CONTAINER_METADATA_URI(_V4)`, `FLY_ALLOC_ID`, `DYNO`,
    `RENDER`, `CODESPACES`, `REMOTE_CONTAINERS`, `DEVCONTAINER`, or `container` ∈ {docker, podman, oci, lxc, crio,
    containerd, systemd-nspawn}.
  - *Tier 3, kernel/namespace introspection:* a runtime name in `/proc/1/cgroup` (**cgroup v1 only** — inside our image
    that file is exactly `0::/`, so this is a fallback, never the primary signal); an `overlay` rootfs in
    `/proc/self/mountinfo`, or an `/etc/hostname`/`/etc/resolv.conf` bind whose source contains `docker/containers`,
    `containerd`, `kubelet/pods` or `containers/storage` (the strong signal for our image); `/proc/1/comm` not being a
    known host init; and `process.pid === 1` last — which is **false in our own image**, since `Dockerfile` starts the app
    with `CLUSTER_MODE=primary`, so PID 1 is the cluster primary and the HTTP workers are its forked children.
  - `/proc/version` is never used for a WSL exclusion: inside a Docker Desktop container the kernel string still reads
    `microsoft-standard-WSL2` (shared WSL kernel), so keying off it would break the primary case.
- **Gateway resolution** (`parseDefaultGatewayIpv4()`) — the `/proc/net/route` row with `Destination == 00000000`,
  its `Gateway` field decoded from little-endian hex (`010011AC` → `172.17.0.1`); lowest `Metric` wins, an on-link
  `00000000` gateway and malformed rows are skipped. IPv6 is out of scope (Docker bridges are IPv4-only by default and
  the peer arrives IPv4-mapped, which the existing `::ffff:` normalization already reduces).
- **Private-range guard** (`isTrustablePrivateIpv4()`) — the resolved gateway is trusted only in `10/8`, `172.16/12`,
  `192.168/16`, `169.254/16`. This is what bounds every possible detection false positive: a bare host wrongly detected
  as containerized but behind a public-IP gateway trusts nothing extra.
- **Memoized** (`getTrustedGateway()`), negative result included — no filesystem access on the request path. It never
  throws: missing/unreadable/malformed `/proc/*` or a non-Linux host degrade to "no gateway trusted", i.e. exactly the
  loopback-only behaviour. Outside a container behaviour is the same, and all other auth modes are unaffected (the util is
  only reachable from Mode 1 code paths).
- **Visible at startup:** under `AUTH_MODE=none` only, and only when a gateway is trusted, `main.ts` logs
  `AUTH_MODE=none: container detected, also trusting default gateway <ip> as a local caller`. Cluster mode prints it
  once per worker, same as the neighbouring `trust proxy enabled` line.

Two caveats to know before relying on this:

- **Port republishing dissolves the boundary.** With Docker's userland `docker-proxy` (the default on Docker Desktop)
  *every* inbound connection appears to come from the gateway. So the `127.0.0.1`-bound publish in
  `docker-compose.yml` — not this check — is the real security boundary in a container: changing `ports:` from
  `127.0.0.1:5003:3000` to `5003:3000` effectively extends Mode 1 to every client that can reach the port. Switch
  `AUTH_MODE` away from `none` before exposing it (as `release-template/INSTALL.md` and `.env.example` warn).
- **`network_mode: host`** detects as containerized and resolves the *LAN router* as the default gateway, so that one
  address becomes trusted. Accepted rather than special-cased: under host networking Mode 1 is already reachable from
  the LAN and loopback works natively, so the delta is one extra trusted address.

## Azure tenant (Mode 4 is single-tenant only)

- `validateMode4` requires `AZURE_TENANT_ID` to match
  `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`; otherwise it throws
  `AZURE_TENANT_ID must be a tenant GUID; multi-tenant values (common/organizations/consumers/domain) are not supported`.
  When `AZURE_AUTHORITY` is set it must contain that GUID as a path segment (case-insensitive), else
  `AZURE_AUTHORITY must point at tenant <guid>`.
- `resolveAzureAuthority()` (`server/src/auth/azure/azure-authority.ts`) is the single source for the authority URL,
  shared by the MSAL client (`AzureAuthService`) and the public `GET /api/v1/auth/config` response — explicit
  `AZURE_AUTHORITY`, else `https://login.microsoftonline.com/<tenant>/v2.0`.
- The callback (`azure-callback.controller.ts`) rejects an ID token whose `tid` claim is missing or differs from
  `AZURE_TENANT_ID` (case-insensitive) via `fail(detail, 'tenant')`, which redirects to
  `/#/login?oauthError=tenant`; every other failure keeps `oauthError=1`. `LoginPage.tsx` shows "Your organization is
  not allowed on this server" for `tenant`.
- Users are still matched by `email`/`preferred_username` within the tenant — an accepted risk listed in
  `security-hardening.md` §11.

## Email flows (Mode 3 + password-reset)

- `email_confirmation_tokens` (24h TTL) and `password_reset_tokens` (1h TTL)
  back the two token-based flows. Both use an atomic lookup-then-consume pattern (`EmailConfirmationTokensService`/
  `PasswordResetTokensService` — not a shared generic class, since the two tables diverge in column naming:
  `consumed_at` vs. the older `used_at`) and a shared 60s resend/reissue cooldown, so two concurrent requests for the
  same account can't both succeed.
- `MailService` (`server/src/mail/mail.service.ts`) sends both email types via `nodemailer`, driven entirely by
  `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE`/`SMTP_USER`/`SMTP_PASSWORD`/`SMTP_FROM` — no code-level defaults. The
  transporter (`nodemailer.Transporter | null`) is built only when `isConfigured()` is true; otherwise it stays
  `null`, so nodemailer's `localhost:587` fallback is never reached, the startup warm-up returns silently and
  `send()` returns `'failed'` without logging (a defensive path — every caller gates on `isConfigured()`). Send failures
  are caught and reported as `email_delivery: 'failed'` in the response body (never thrown) — the account/token action
  itself still succeeds.
- Emailed confirmation/reset links (signup confirm, resend, forgot-password, and the admin pending-registration
  resend in `admin-panel.controller.ts` + its duplicate in `admin.service.ts`) are built **only** from
  `PUBLIC_BASE_URL` via `getEmailLinkBaseUrl()` (`server/src/common/public-base-url.ts`) — never from the request's
  `Host` header, which the caller controls (host-header injection into a reset link). `getPublicBaseUrl()` returns
  the env value with trailing `/` stripped; outside production it falls back to `http://localhost:5173`; in
  production with no value it returns `null`, the email is **skipped** and
  `mail: PUBLIC_BASE_URL not set — email link not sent` is logged once per process. Links are hash-prefixed
  (`${baseUrl}/#/confirm-email?token=...`) because the client mounts `createHashRouter`.
- Links returned **in a response body to an authenticated admin** (the admin-generated reset link in
  `admin.controller.ts`, the release download link in `admin-panel.controller.ts`) still use
  `getRequestBaseUrl(req)` (`server/src/common/request-base-url.ts`) — the admin sees the link in their own browser,
  so the request origin is correct there and no email leaves the request context.
- Email addresses written to the server log are masked (`server/src/common/mask-email.ts`).
- **Local dev/testing:** point `SMTP_HOST`/`SMTP_PORT` at a local Mailpit container
  (`docker run -d --name mailpit -p 1025:1025 -p 8025:8025 axllent/mailpit`, web UI at
  `http://localhost:8025`) instead of the real SMTP relay — useful when the relay rejects test sends (e.g. a
  corporate relay answering `550 Administrative prohibition` to sends from a developer machine).

## Admin Panel — Auth tab

`GET /api/v1/admin/auth` shows the active mode's non-secret config; `GET
/api/v1/admin/auth/pending-registrations` (Mode 3 only) lists unconfirmed signups with per-row Resend/Revoke actions,
sharing the same cooldown as the user-facing resend endpoint.

## Cross-mode account identity

`users.email` (unique) is the stable identity key across all four modes — switching `AUTH_MODE` never requires a data
migration. `users.password_hash` is nullable (`NULL` = no local credentials, used by Mode 1/4 auto-provisioned
accounts); `AuthService.validateUser()` short-circuits on a null hash rather than crashing. An account created under
Mode 2/3 logs in via Mode 4 OAuth by matching email (case-insensitive); switching back from Mode 4 to Mode 2/3, the
account can regain password access via
`forgot-password`/`reset-password` (not gated on `password_hash` being non-null).

## Team access modes — who may read whose sessions

Everything above decides **who you are**. This section decides **whose data you may read** once you
are authenticated. The two are independent: an app-level `admin` is an *authentication/role* concept,
a team access mode is a *per-team data-sharing contract*, and neither overrides the other.

Each team carries `teams.access_mode` (`transparent` \| `restricted`, Postgres enum `team_access_mode`,
default `restricted` on every creation path). It replaced the old two-state
`teams.allow_member_session_visibility` boolean in migration `0063`. On top of it, `team_members`
carries two independent, stacking role flags granted by the team owner: `is_manager` and
`is_adlc_trainer`.

**Role flags are evaluated only while the mode is `restricted`.** In a `transparent` team every member
resolves to full team-wide visibility with prompts — bit-identical to the old flag being on — so no
role grant can change what a transparent team exposes.

| caller, in a `restricted` team | sees whose sessions | prompt text | analytics & reports |
|---|---|---|---|
| team owner | every acknowledged member | yes | yes |
| ADLC trainer **+** manager | every acknowledged member | yes | yes |
| ADLC trainer only | every acknowledged member | yes | **no** (403) |
| manager only | every acknowledged member | **no** (masked to `null`) | yes |
| plain member | own sessions only | own only | **no** (403) |
| non-member reaching in with a `?teamId` | own sessions only | own only | **no** (403) |

In a `transparent` team every caller sees every member with prompts and full analytics — raw session
logs (`GET :repoId/sessions/:sessionId/logs?teamId=`) and the Raw Logs tab included; the
"raw logs owner-only" rule survives only in the personal view and, by role, in `restricted` teams. With no
`teamId` at all (the personal view) a caller sees only their own sessions, with analytics allowed.

Resolution is centralised in `RepositoriesService.resolveTeamScope(user, teamId)`, which returns the
`TeamScope` object defined in `server/src/logs/team-scope.ts`; `server-endpoint-map.md`'s **Team
access-mode gate** note documents how each route consumes it.

### The disclosure acknowledgement

A member is only visible team-wide once `team_members.disclosure_acknowledged_at` is set — they must
have been shown, and ticked, the modal spelling out who can read their prompts. Until then their
sessions are invisible **even to the team owner and to ADLC trainers**, and they are excluded from the
two owner-only export surfaces (`GET :repoId/sessions/export-scope` and the `POST :repoId/export` ZIP).
Accepting an invitation is itself an acknowledgement; the two membership paths with no Accept step
(the `force: true` invite branch and `addMemberIfRealUser()` during an import) leave it `NULL` and are
drained at login via `GET /api/v1/teams/pending-disclosures` +
`POST /api/v1/teams/:teamId/acknowledge-disclosure`. Migration `0063` backfilled every pre-existing
member to their `joined_at`, so moving the whole install to `restricted` did not hide existing members
from their own team owner.

### The transparent lock

`PATCH /api/v1/teams/:teamId` refuses with a **409** when `accessMode: 'transparent'` is set on a team
that has any member besides the owner: those members joined under the restricted privacy promise and
it cannot be revoked afterwards. The reverse direction (`transparent → restricted`) only ever reduces
exposure and is never blocked — which is also why an acknowledgement is recorded once and never
re-asked (no copy-version hash, unlike the consent notice).

### The admin role grants no data access

Since `2026-10-21-private-repo-visibility` the app-level `admin` role only *administers* (users,
retention, system settings, pricing, server operation) and never widens what session data a caller
can read. No access check special-cases `user.role === 'admin'`:

- **Personal route (no `teamId`)** — `RepositoriesService.assertRepoAccess()` admits only the
  `repositories` row owner, whatever their role, even when a team links the same repo URL.
- **Team route (`teamId`)** — team membership plus the team policy (`resolveTeamScope()`), nothing
  else. `TeamAccessGuard` is membership-only; the former `TeamOwnerOrAdminGuard` was deleted and its
  routes (remove member, unlink / remove team repo) use `TeamOwnerGuard`.
- `assertRepoOwnerOrTeamOwner()` (export/import), the session-logs route, `sessions/export-scope` and
  `recompute-all-sessions` have no admin clause; `DELETE /api/v1/sessions/:sessionId` is owner-only.
- `GET /api/v1/teams` returns only the caller's own teams, admins included; `getMembers()` returns
  `disclosureAcknowledgedAt` to the team owner only; invitations are owner (or `canInvite` member)
  only.
- An admin who is a team member gets exactly the rights of their team role.

What the admin keeps: the admin panel (aggregates only — counts, tokens, cost), retention routes under
`AdminOrTeamOwnerGuard`, the password-reset link, `DELETE /admin/repos/:id`, and three team-admin
routes that read no session data — `GET /admin/teams/:teamId/members` (identity only),
`POST /admin/teams/:teamId/owner` ("Set new owner", the new owner must be a member) and
`DELETE /admin/team-repos/:teamRepoId` (orphan team link only).

**Privacy boundary.** These rules cover the application's session-data views (UI + API). Debugging
data stays outside them: `GET /admin/upload-queue/:id/file` still returns the staged raw payload and
server / error logs are not scrubbed. The Data Collection Notice discloses both, and that anyone with
direct database access can read everything.

For a raw conversation this means: the session's uploader, a team owner or ADLC trainer for an
acknowledged member's session, and every member of a `transparent` team can read it; a `manager`
cannot (they resolve to "team, no prompts").

## Team visibility and restricted access

The access-mode table above is enforced by one resolved object and three query-side rules. Every
team-scoped read path goes through them; none re-derives visibility on its own.

### The three-state scope

`RepositoriesService.resolveTeamScope(user, teamId)` (`server/src/logs/repositories.service.ts`)
returns a `TeamScope` (`server/src/logs/team-scope.ts`) whose `visibility` is one of three states:

| `visibility` | who resolves to it | `visibleUserIds` | `analyticsAllowed` |
|---|---|---|---|
| `own-only` | plain member or non-member in a `restricted` team; every caller in the personal (no `teamId`) view | `[caller]` | `false` in a team, `true` in the personal view |
| `team-no-prompts` | `manager` (without the trainer flag) in a `restricted` team | acknowledged members + caller | `true` |
| `team-with-prompts` | team owner or ADLC trainer in a `restricted` team; everyone in a `transparent` team | acknowledged members + caller (`restricted`); `null` (`transparent`) | owner/manager: `true`; trainer only: `false`; `transparent`: `true` |

- `visibleUserIds: null` means "emit no user predicate at all", so a `transparent` team runs the same
  SQL as an unrestricted query.
- The caller's own id is always in `visibleUserIds`: a caller never loses sight of their own
  sessions, acknowledged or not.
- A missing team row resolves to the restrictive default instead of throwing; authorization itself is
  `assertRepoAccess()` / `TeamAccessGuard`'s job, not the resolver's.
- The two owner-only export surfaces use `resolveExportVisibleUserIds(teamId)` instead, which is
  caller-independent (the routes' own `assertRepoOwnerOrTeamOwner()` / team-owner gate already
  restricts the caller) but still applies the disclosure gate: acknowledged members plus the team owner, or `null` for a `transparent` team.

### Repository matching by URL in team context

`repositories` has one row per `(user_id, repo_url)`, so the same Git repository is a different
`repositories.id` for every member who uploaded to it. In team context a repository is therefore
matched by URL, not by id: `resolveRepoIds(repoId, repoUrl, teamId)` expands the requested repository to
every `repositories` row with the same `repo_url` owned by a member of that team (falling back to the
requested id alone when none are found). `buildSessionListConditions()` combines that repo condition
with the row filter `logs.user_id IN (visibleUserIds)`, which it adds only when a `teamId` is present
and `visibleUserIds` is not `null`.

Without a `teamId` only the requested row is used. The row filter is not applied there either: the
personal view is owner-only (`assertRepoAccess()` admits only the `repositories` row owner), so that
gate is the whole rule.

### Prompt masking and single-session reads

- **Masking happens in the projection, never in a SQL `WHERE`.** `maskFirstPrompt()` nulls
  `first_prompt` on rows the caller does not own when the scope is `team-no-prompts`. A row whose owner
  cannot be determined is masked rather than leaked. `first_prompt IS NOT NULL` is the root-session
  discriminator in many queries, so filtering on it would delete whole sessions from a manager's lists
  instead of hiding their text.
- **List and aggregate routes filter rows; single-session routes 403.** "You see only your own
  sessions" is a filtered list, but a request that names one session has no filtered form.
  `assertSessionVisible(user, scope, sessionRowId)` throws `ForbiddenException` unless the session's
  uploader is the caller or is in `visibleUserIds`, which also stops an owner or trainer from opening a
  session of a member who has not acknowledged the disclosure.
- **Raw session logs stay owner-only outside the team grants.** The Raw Logs tab and
  `GET .../sessions/:sessionId/logs` answer 403 to everyone except the session's owner and the
  team-wide-with-prompts roles described above (no app-admin exception).
