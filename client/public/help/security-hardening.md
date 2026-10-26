# Artisyn Log Hub — Security Hardening & Configuration Guide

This guide describes the security-relevant configuration of an Artisyn Log Hub installation and
the recommended settings for running it beyond a single local user. It applies to the Docker
installation from the GitHub Release install kit (`docker-compose.yml` + `.env`). For the
component layout, see the **Component Reference**; for the installation procedure, see the
README.md of the GitHub Release install kit.

## 1. Security model in brief

- **Users** authenticate to the web client with a server-side session (`httpOnly` cookie,
  sessions stored in PostgreSQL). How a session is first established depends on `AUTH_MODE`.
- **Hooks** authenticate to the server with a per-user **API key** in the `x-api-key` header.
  Keys are shown to the user once and stored only as an Argon2id hash.
- **Authorization**: two roles (`admin`, `user`). Repositories and their sessions are private to
  their owner; sharing happens only through teams, governed by the team's access mode.
- **Data at rest** lives in PostgreSQL and in bind-mounted host directories under
  `$LOG_HUB_DATA_DIR`. The application does not encrypt data at rest itself — use host or
  volume encryption if your policy requires it.
- **Data in transit**: the application serves plain HTTP. TLS is terminated by a reverse proxy
  that you place in front of it (see §4).

## 2. Deployment checklist

Use this list before exposing an installation to anyone other than the local user.

| # | Item | Setting |
|---|---|---|
| 1 | Choose an authentication mode other than `none` | `AUTH_MODE=password`, `password-confirm` or `azure-oauth` |
| 2 | Use strong, unique secrets | `POSTGRES_PASSWORD`; `SESSION_SECRET` is generated and stored in the database when unset (§3.5) — if you set it, use ≥ 32 random bytes |
| 3 | Put a TLS-terminating reverse proxy in front of the app | `TRUST_PROXY=1` (or the proxy's IP) |
| 4 | Set the public URL used in emailed links (Modes 2/3) | `PUBLIC_BASE_URL=https://<your-host>` — required in production |
| 5 | Limit self-registration to your domains (Mode 3) | `ALLOWED_EMAIL_DOMAINS=example.org,example.net` |
| 6 | Make session cookies HTTPS-only | Automatic with `TRUST_PROXY`; otherwise `COOKIE_SECURE=true` |
| 7 | Bind the published port narrowly | `ports:` in `docker-compose.yml` — loopback or the proxy's interface only |
| 8 | Keep the database private | Do not publish the `db` service port |
| 9 | Enforce a password policy (Modes 2/3) | `PASSWORD_POLICY=long` (default) |
| 10 | Set data retention to your policy | `SESSION_RETENTION_DAYS` |
| 11 | Restrict filesystem access to `$LOG_HUB_DATA_DIR` | Host permissions; include in backups |
| 12 | Review admin accounts — the first registered user becomes admin | Admin panel → Users |
| 13 | Keep the image up to date | Re-run `install.sh` / `install.ps1` to pull the new release image; migrations run on startup |
| 14 | Read the accepted risks | §11 Known limitations and accepted risks |

## 3. Authentication

### 3.1 Authentication modes (`AUTH_MODE`)

| Value | Mode | Use for |
|---|---|---|
| `none` | No authentication. A caller types an email and is logged in as that user, without verification. Accepted **only from local callers** (localhost and, in a container, the container's default gateway). | A single user on their own machine. **Never** for a shared or network-reachable installation. |
| `password` | Email + password. | Small teams without SSO. |
| `password-confirm` | Email + password, account usable only after an emailed confirmation link. Requires SMTP (§3.4). | Teams without SSO that need verified email ownership. |
| `azure-oauth` | Azure Entra ID (OAuth 2.0 / OIDC). No local passwords. | **Recommended** for organisations using Microsoft Entra ID. |

- Unset `AUTH_MODE` defaults to `password`. An unrecognised value, or a mode whose required
  settings are missing, stops the server at startup.
- Routes belonging to a different mode return `404`.
- `users.email` is the identity across all modes, so switching modes requires no data migration.

> **Important.** The install kit ships with `AUTH_MODE=none` and publishes the app on
> `127.0.0.1:5003` only. That loopback-only port binding is the actual security boundary of
> Mode 1: with Docker's port forwarding every connection appears to come from the container
> gateway, which Mode 1 trusts. **Change `AUTH_MODE` in the same edit in which you widen the
> `ports:` mapping.**

### 3.2 Azure Entra ID (Mode 4)

Required settings: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
`AZURE_REDIRECT_URI`, and optionally `AZURE_SCOPES` and `AZURE_AUTHORITY`.

- **Single-tenant only.** `AZURE_TENANT_ID` must be your tenant's GUID. Multi-tenant values
  (`common`, `organizations`, `consumers`) and domain names are rejected and the server does not
  start. If you set `AZURE_AUTHORITY`, it must contain the same tenant GUID as a path segment.
- On sign-in, the server checks that the token's tenant (`tid`) equals `AZURE_TENANT_ID`. An
  account from any other tenant is refused, and the login page shows "Your organization is not
  allowed on this server".
- Register a single-tenant application in your Entra ID tenant.
- Set the redirect URI to `https://<your-host>/api/auth/callback`, matching
  `AZURE_REDIRECT_URI` exactly.
- Store `AZURE_CLIENT_SECRET` in `.env` (or your secret store) only; rotate it before expiry.
- Access control (who may sign in) is managed in Entra ID — e.g. by requiring user assignment for
  the enterprise application.

### 3.3 Passwords (Modes 2 and 3)

- Hashing: Argon2id.
- Strength policy `PASSWORD_POLICY`:

  | Value | Minimum length | Required character classes |
  |---|---|---|
  | `any` | 2 | none — development only |
  | `mid` | 10 | a digit |
  | `long` (default) | 14 | a digit, punctuation, an uppercase and a lowercase letter |

  Maximum length is 128. A policy change applies to passwords set afterwards; existing hashes
  are not invalidated.
- **Brute-force delay**: failed logins are counted per account and per source IP; from the second
  failure each attempt is delayed progressively (1 s, 2 s, 3 s, …) with `429 Retry-After`. The
  counter is in memory per worker process — it is a speed bump, not an account lockout. Behind a
  proxy, set `TRUST_PROXY` so the real client IP is used.
- **Password change** signs out all of the user's other sessions and sends a notification email
  when SMTP is configured — always in Mode 3, and in Mode 2 only when `SMTP_HOST` is set.
- **Password reset** tokens are valid for 1 hour; email confirmation tokens for 24 hours; both are
  single-use with a 60-second re-issue cooldown.
- **Rate limits on account endpoints**: sign-up, forgot-password, resend-confirmation and
  reset-password allow `AUTH_RATE_LIMIT_POINTS` requests (default `5`) per
  `AUTH_RATE_LIMIT_WINDOW_SEC` (default `900`, i.e. 15 minutes), counted per source IP and — for
  sign-up, forgot and resend — per email address.
  - Over the IP limit, the request is answered with `429` and `Retry-After`.
  - Over the per-email limit, sign-up returns `429`; forgot and resend return their normal success
    response but send no email, so the limit does not reveal whether the account exists.
  - `AUTH_RATE_LIMIT_POINTS=0` disables the limits (development only).
  - The counters are in memory per worker process, so with N workers the effective limit is about
    N × the configured value (§11).
- **Sign-up domain allow-list (Mode 3)**: `ALLOWED_EMAIL_DOMAINS` is a comma-separated list of
  domains (for example `example.org,example.net`). When set, sign-up is accepted only for emails
  whose domain matches an entry exactly — subdomains are not included. Unset or empty means no
  restriction. A malformed value (an entry with `@`, spaces or no dot) stops the server at
  startup. Existing accounts are not affected.

### 3.4 Email (SMTP)

Settings: `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE`,
`ADMIN_CONTACT_EMAIL`. The rule depends on the auth mode:

- **Modes 1 and 4** (`none`, `azure-oauth`) never use SMTP.
- **Mode 2** (`password`): SMTP is optional.
  - When `SMTP_HOST` is set, `SMTP_PORT` and `SMTP_FROM` are required (the server does not start
    without them). A relay that cannot be reached at startup only logs a warning; sending is retried
    on the first email.
  - When `SMTP_HOST` is unset, password reset is unavailable: the login page shows
    "Forgot password?" disabled with the hint "SMTP server is not configured", and no reset token is
    issued. Password-changed notifications are not sent.
  - `ADMIN_CONTACT_EMAIL` is optional.
- **Mode 3** (`password-confirm`): `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM` and `ADMIN_CONTACT_EMAIL`
  are required, and the relay must be reachable at startup — otherwise the server does not start.
- `SMTP_USER`/`SMTP_PASSWORD` are optional (anonymous relay); `SMTP_SECURE` is optional
  (unset = `false`).

Use `SMTP_SECURE=true` (implicit TLS, usually port 465) or a relay that enforces STARTTLS.

Links in emails (sign-up confirmation, resend, password reset, an admin's resend of a pending
registration) are built only from `PUBLIC_BASE_URL` — never from the request's `Host` header,
which a caller controls. Set it to the canonical HTTPS address users open, for example
`PUBLIC_BASE_URL=https://loghub.example.org`.

- In production (`NODE_ENV=production`, which the Docker image and install kit set), Modes 2
  and 3 refuse to start without an absolute `http(s)` `PUBLIC_BASE_URL`.
- Outside production it defaults to `http://localhost:5173` (the development client).
- If it is missing anyway, the email is not sent and the server logs
  `mail: PUBLIC_BASE_URL not set — email link not sent` once per process.

Links shown in the admin panel to a signed-in admin (an admin-generated reset link) still use
the address the admin is using.

### 3.5 Sessions and cookies

- Cookie `connect.sid`: `httpOnly`, `SameSite=Lax`, 1-hour lifetime, signed with
  `SESSION_SECRET`.
- `Secure` flag: follows `X-Forwarded-Proto` when `TRUST_PROXY` is enabled; otherwise it is set
  unless `COOKIE_SECURE=false`.
- **Where `SESSION_SECRET` comes from.** On startup the server uses, in this order:
  1. a non-empty `SESSION_SECRET` from the environment (`.env`);
  2. otherwise, the secret stored in the database table `server_secrets`;
  3. otherwise, it generates a random secret (48 bytes), stores it in `server_secrets` and uses it.

  So a fresh install needs no `SESSION_SECRET`, and sessions survive container re-creation. The
  stored secret is as sensitive as the database itself — protect database backups accordingly
  (§9). If the secret cannot be read or stored, the server does not start.
- Changing `SESSION_SECRET` (or deleting the `server_secrets` row when no env value is set)
  invalidates all active sessions. Keep your existing `.env` on upgrade — the install scripts
  generate a `.env` only when it is missing and never overwrite an existing one.
- Known insecure values (the old shipped default, `change-me`, the test secret) and well-known
  database passwords (`postgres`, `secret`, …) are reported at startup with
  `security: known insecure … in use — set a unique value`. The server still starts (§11).

### 3.6 API keys (hook authentication)

- Created by each user under **My API Keys**, with an optional expiry date. Shown once; stored as
  an Argon2id hash.
- A key can be revoked at any time; revoke keys of departing users, or delete the user (which
  removes their keys and data).
- The hook stores the key in `.artisyn/config/log-hub.local.json`. The installer makes sure the
  file is git-ignored, refuses to install if it is already tracked by git, and restricts it to
  the owner (`0600`) on Linux and macOS. The "Full Auto Install" one-liner puts the key into shell history — avoid it on
  shared machines.
- Recommendation: set an expiry on keys and rotate them periodically.

### 3.7 CSRF protection

Cross-site request forgery protection relies on the session cookie's attributes only:

- The `connect.sid` cookie is `httpOnly` and `SameSite=Lax`. A browser does not attach it to a
  cross-site `POST`, `PUT`, `PATCH` or `DELETE` request (form posts, `fetch` from another site),
  so such a request reaches the server unauthenticated and is rejected.
- There is **no** `Origin`/`Referer` check and **no** CSRF token.
- State-changing operations use non-`GET` methods. `SameSite=Lax` still sends the cookie on a
  top-level cross-site `GET` navigation, so a `GET` route must not change state.

**Token-authorised flows.** Email confirmation and password reset links open a page of the web
client; that page then `POST`s the one-time token from the link. Opening the link alone changes
nothing.

**Allowed exceptions** — `GET` routes with a side effect that was reviewed and accepted:

| Route | Side effect | Why it is accepted |
|---|---|---|
| Public hook installer download | Writes a cached version value only | No user data; older hooks call it with `GET` |
| Azure sign-in start and callback (Mode 4) | Starts or completes a login | Protected by the OAuth `state` and `nonce` |
| `GET /me` auto-identify (Mode 1 only) | Logs the local caller in | Accepted only from local callers; Mode 1 has no authentication model |
| Admin logs-archive download | Creates a temporary archive file | Admin only; no data is changed |

The repository export download no longer deletes the export file or job when it is fetched; a
scheduled cleanup removes them after `EXPORT_IMPORT_JOB_TTL_MS` (default 30 minutes).

**Residual risks** (see §11):

- `SameSite` treats every subdomain of the same registrable domain as *same-site*. A page on a
  sibling subdomain (for example an untrusted `blog.example.org` next to
  `loghub.example.org`) can send requests that carry the cookie. Host Log Hub on a domain whose
  sibling subdomains you trust, or on its own registrable domain.
- Old browsers that do not implement `SameSite` send the cookie on every cross-site request.
  Require a current browser for users of the web client.

## 4. Network exposure and TLS

### 4.1 Reverse proxy

Run the app behind a reverse proxy (nginx, Traefik, a cloud load balancer, …) that terminates
TLS, and:

- set `TRUST_PROXY` to the number of proxy hops (`1`) or to the proxy's IP/CIDR — this makes the
  session cookie `Secure` over HTTPS and gives the app the real client IP for the login delay;
- forward `X-Forwarded-Proto` and `X-Forwarded-For`;
- allow large request bodies on `/api/v2/logs` (the hook uploads in chunks of up to ~900 KB; the
  server-side cap is `LOGS_MAX_BODY_MB`, default 2500 MB) and, if admins use repository import,
  on `/api/v1/repositories/*/import/upload` and `/api/v1/repositories/bootstrap-import/upload`
  (capped by `IMPORT_MAX_UPLOAD_BYTES`, §6.4);
- add HSTS at the proxy.

The application limits request bodies itself: `POST /api/v2/logs` accepts up to
`LOGS_MAX_BODY_MB`; the hook's small JSON APIs (turn-end advisor, session attribution, log echo)
accept up to 1 MB; every other route accepts up to 500 KB. A larger body is answered with `413`.

`POST /api/v2/logs` is the only log upload route. The legacy synchronous `POST /api/v1/logs` was
removed and answers `404`, so a proxy rule only needs to cover `/api/v2/logs`. Hooks older than
1.7.0 still call the removed route and stop uploading until they are upgraded.

`TRUST_PROXY=true` trusts any upstream; prefer a hop count or an explicit address list.

### 4.2 Port publishing

The shipped mapping `127.0.0.1:5003:3000` makes the app reachable from the host only. When the
proxy runs on the same host, keep it that way. Otherwise bind to the specific interface the proxy
reaches (`"<ip>:5003:3000"`) and restrict that port with the host firewall.

The `db` service is not published at all; keep it that way.

### 4.3 HTTP security headers

Set by the application on every response:

- `Content-Security-Policy`: `default-src 'self'`; scripts only from self (no inline scripts);
  `object-src 'none'`; `frame-ancestors 'none'`; `form-action 'self'`; `base-uri 'self'`.
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and the other helmet defaults.
- `upgrade-insecure-requests` is intentionally not set, so plain-HTTP internal deployments keep
  working. Add HSTS at your TLS proxy.

The web client loads no external resources (fonts, CDNs, analytics).

### 4.4 Outbound connections from the server

| Destination | When | How to control |
|---|---|---|
| Azure Entra ID | `AUTH_MODE=azure-oauth` | Mode setting |
| SMTP relay | Mode 3 always (checked at startup); Mode 2 only when `SMTP_HOST` is set | SMTP settings (§3.4) |
| `registry.npmjs.org` (HTTPS) | Periodic AI tool version check | `AI_TOOL_VERSION_CHECK_ENABLED=false` disables it |
| `platform.claude.com` (HTTPS) | Daily model pricing fetch: reads Anthropic's public pricing page, at most once per 24 h cluster-wide | `MODEL_PRICING_FETCH_ENABLED=false` disables it |
| `openrouter.ai` (HTTPS) | Only when an admin clicks **Import from OpenRouter** on the Model Pricing tab | Not scheduled; don't click the button |

No telemetry is sent to the project maintainers or any other third party.

## 5. Authorization and data visibility

- **Roles**: `admin` (admin panel, user management, pricing, retention, system info) and `user`.
  The admin role grants no access to session data in the app; admins see sessions only through
  their own repositories or a team role (server operators can still reach the database and logs
  directly). Keep the number of admins small; the last admin cannot be deleted.
- **Ownership**: repositories and sessions are visible to their owner only, unless shared
  through a team.
- **Team access modes**:
  - `restricted` (default) — members see only their own sessions; the owner and ADLC trainers
    see members' sessions with prompts; managers see members' sessions and analytics without
    prompt text.
  - `transparent` — every member sees every member's sessions and prompts. A team cannot be
    switched to `transparent` once it has members other than the owner.
- A member becomes visible to the team only after acknowledging a disclosure that explains who
  can read their prompts.

## 6. Data protection and retention

### 6.1 What is stored

Prompts, assistant responses, tool calls and tool results from Claude Code transcripts, git
metadata (remote URL, branch, git user name), OpenTelemetry records and derived statistics.
**Transcripts can contain source code and, if the assistant handled them, secrets.** Treat the
database, upload queue and backups as confidential.

Users are informed of this by a data-collection notice they must accept on first login.

### 6.2 Retention

| Setting | Default | Effect |
|---|---|---|
| `SESSION_RETENTION_DAYS` | `30` | Sessions whose earliest log is older than this are permanently deleted. |
| `SESSION_RETENTION_CHECK_INTERVAL_MS` | `1800000` | Purge job interval. |
| `SESSION_RETENTION_PURGE_BATCH_SIZE` | `200` | Sessions purged per run. |

On developer machines the hook deletes local OTEL files older than `otelRetentionDays`
(default 7) in `log-hub.json`.

Deleting an account (by the user or by an admin) is a hard delete of the user and all of their
data; there is no recovery.

### 6.3 Reducing sensitive data at the source (hook side)

The hook only monitors and logs — it never blocks a tool call (its optional file-access guardrail
was removed in hook 2.19.0). To stop Claude Code from reading files that should never reach a
transcript, use Claude Code's own permission rules in `.claude/settings.json`:

```json
{
  "permissions": {
    "deny": ["Read(./.env)", "Read(./.env.local)", "Read(./secrets.json)"]
  }
}
```

The hook itself runs only as plain, readable Node.js scripts with no third-party dependencies,
and its OTEL receiver binds to `127.0.0.1` only.

### 6.4 Repository export and import

An export is a zip of a repository's sessions. It contains user email addresses and the
`sourceHost` of the exporting server — treat export files as confidential. An export file and
its job are deleted by a scheduled cleanup after `EXPORT_IMPORT_JOB_TTL_MS` (default 30 minutes),
not when it is downloaded.

Uploaded import files are checked before any data is read:

| Env var | Default | Limit |
|---|---|---|
| `IMPORT_MAX_UPLOAD_BYTES` | 5 GiB | Size of the uploaded zip file |
| `IMPORT_MAX_ENTRIES` | 20,000 | Number of files in the zip |
| `IMPORT_MAX_UNCOMPRESSED_BYTES` | 20 GiB | Total uncompressed size |
| `IMPORT_MAX_ENTRY_BYTES` | 400 MiB | Uncompressed size of one file |

The file must have a `.zip` extension and start with a zip signature. A rejected upload is
deleted and answered with `400`, for example
`Import rejected: entry count exceeded (25000 > 20000). Raise IMPORT_MAX_ENTRIES to allow larger imports.`
A value that is not a positive integer falls back to the default.

## 7. Host, container and database

- Restrict access to the installation directory: `.env` holds `POSTGRES_PASSWORD`,
  `SESSION_SECRET` and, for Mode 4, `AZURE_CLIENT_SECRET`. Recommended: `chmod 600 .env`.
- Restrict `$LOG_HUB_DATA_DIR` (database files, upload queue, logs) to the Docker/service
  account.
- Use a dedicated host or VM; keep Docker Engine and the host OS patched.
- Before an upgrade, verify that the database lives on the host bind mount (see `INSTALL.md`,
  "Update to the latest version").

## 8. Logging and monitoring

- Server logs: `$LOG_HUB_DATA_DIR/logs`, daily-rotated files; no automatic deletion — apply
  your own retention (e.g. logrotate or a scheduled cleanup).
- Security events are logged as structured `key=value` lines: login success/failure and applied
  delay, signup, email confirmation, password reset and change, account deletion. They contain
  email addresses and user IDs only — never passwords, hashes or tokens.
- Admin panel → **Error Logs** shows recent errors; → **System** shows build version, git commit
  and worker status; `GET /health` can be used by external monitoring.
- Admin panel → **Upload Queue** shows ingestion backlog and failures.

## 9. Backup and recovery

Back up, at minimum:

- the PostgreSQL database (`pg_dump` from the `db` container, or a file-level copy of
  `$LOG_HUB_DATA_DIR/pgdata` while the `db` container is stopped);
- the `.env` file (without it the database password is lost, and — when `SESSION_SECRET` is set
  there — sessions are invalidated; a generated `SESSION_SECRET` lives in the database and is
  covered by the database backup);
- optionally `$LOG_HUB_DATA_DIR/upload-queue` to preserve uploads not yet ingested.

Protect backups with the same controls as the live data (§6.1) and apply the same retention.

## 10. Configuration reference

| Variable | Default | Security relevance |
|---|---|---|
| `AUTH_MODE` | `password` (install kit ships `none`) | Authentication mode (§3.1). |
| `SESSION_SECRET` | generated per install; when unset, generated and stored in the database | Signs session cookies (§3.5). Optional. |
| `PUBLIC_BASE_URL` | unset (`http://localhost:5173` outside production) | Base of emailed links. Required in production for Modes 2/3 (§3.4). |
| `ALLOWED_EMAIL_DOMAINS` | unset (no restriction) | Mode 3 sign-up domain allow-list (§3.3). |
| `AUTH_RATE_LIMIT_POINTS` | `5` (`0` disables) | Requests per window on sign-up, forgot, resend and reset (§3.3). |
| `AUTH_RATE_LIMIT_WINDOW_SEC` | `900` | Rate-limit window (§3.3). |
| `NODE_ENV` | `production` in the image and install kit | Enables the production startup checks. |
| `POSTGRES_PASSWORD` | generated per install | Database password. Required. |
| `POSTGRES_USER`, `POSTGRES_DB` | `postgres`, `a-log` | Database identity. |
| `COOKIE_SECURE` | `false` in the install kit | `Secure` cookie flag when `TRUST_PROXY` is off. |
| `TRUST_PROXY` | `false` | Reverse-proxy trust (§4.1). |
| `PASSWORD_POLICY` | `long` | Password strength (§3.3). |
| `AZURE_*` | — | Mode 4 settings (§3.2). |
| `SMTP_*`, `ADMIN_CONTACT_EMAIL` | — | Email settings (§3.4): required in Mode 3, optional in Mode 2 (no password reset without `SMTP_HOST`), unused in Modes 1/4. |
| `SESSION_RETENTION_DAYS` | `30` | Data retention (§6.2). |
| `LOGS_MAX_BODY_MB` | `2500` | Maximum log upload request size (`POST /api/v2/logs`). |
| `IMPORT_MAX_UPLOAD_BYTES`, `IMPORT_MAX_ENTRIES`, `IMPORT_MAX_UNCOMPRESSED_BYTES`, `IMPORT_MAX_ENTRY_BYTES` | 5 GiB, 20,000, 20 GiB, 400 MiB | Repository import limits (§6.4). |
| `EXPORT_IMPORT_JOB_TTL_MS` | `1800000` | How long export files and import jobs are kept (§6.4). |
| `AI_TOOL_VERSION_CHECK_ENABLED` | on | Outbound call to `registry.npmjs.org`. |
| `MODEL_PRICING_FETCH_ENABLED` | on | Daily outbound call to `platform.claude.com` that keeps Anthropic model prices current. Only the value `false` turns it off. |
| `MODEL_PRICING_FETCH_INTERVAL_MS` | `3600000` | How often each server process checks whether the daily pricing fetch is due (the fetch itself still runs at most once per 24 h). |
| `LOG_HUB_DATA_DIR` | `./loghub-db` | Host directory for all persistent data. |

## 11. Known limitations and accepted risks

These are known gaps that this release accepts. Each entry gives the risk, when it applies and
what an administrator can do about it.

### 11.1 Server and authentication

| Risk | When it applies | What an admin can do |
|---|---|---|
| **Azure accounts are matched by email.** A user is identified by the token's `email` / `preferred_username` within your tenant. An Entra admin who sets another user's `mail` attribute, a guest account with an unverified email, or a re-used UPN can sign in as an existing Log Hub user. | Mode 4 | Restrict who may sign in (user assignment on the enterprise application); do not re-use UPNs; review guest accounts; restrict who can edit user attributes in Entra ID. |
| **The first registered user becomes admin.** | Modes 2 and 3 on a fresh database (and the first identify in Mode 1) | Register your own admin account before exposing the server; review **Admin panel → Users** afterwards. |
| **CSRF protection is `SameSite=Lax` only** (§3.7). A sibling subdomain, or a browser without `SameSite` support, can make cross-site requests that carry the session cookie. | All modes with a browser session | Host Log Hub where every sibling subdomain is trusted (or on its own domain); require current browsers. |
| **No rate limits on log ingestion and the hook API-key routes**; the auth rate limits (§3.3) and login delay are counted per worker process, so the effective limit is about N × the setting with N workers. | All modes; multi-worker servers | Rate-limit at the reverse proxy; revoke abused API keys; lower `AUTH_RATE_LIMIT_POINTS` to compensate for the worker count. |
| **Known insecure secrets only produce a warning.** The server starts with a well-known `SESSION_SECRET` or database password and logs `security: known insecure … in use`. | Modes 2, 3 and 4 | Check the startup log; set unique values (or leave `SESSION_SECRET` unset so one is generated). |
| **Account enumeration.** The responses of sign-up, forgot-password and resend-confirmation can reveal whether an email has an account. | Modes 2 and 3 | Keep the auth rate limits on; monitor the security log for bursts; prefer Mode 4 for public-facing servers. |
| **Account deletion needs no password.** A signed-in user deletes their account by typing the confirmation word `delete`; anyone with access to an unlocked session can do it. | All modes | Keep the session lifetime short; back up the database (§9) so a deleted account can be restored manually. |
| **Mode 1 trusts the container gateway.** With Docker port forwarding every connection appears local, so the port binding is the only boundary. | Mode 1 (`AUTH_MODE=none`) | Publish the port on `127.0.0.1` only (the shipped default); switch mode before widening `ports:` (§3.1). |
| **Outbound npm registry check.** The server periodically calls `registry.npmjs.org` to check AI tool versions. | All modes, by default | `AI_TOOL_VERSION_CHECK_ENABLED=false`. |
| **Security headers.** `X-Frame-Options` and `Content-Security-Policy` can be sent twice, the CSP allows `style-src 'unsafe-inline'`, and HSTS is not enabled by the application. | All modes | Add HSTS at the TLS proxy (§4.1); do not add conflicting headers at the proxy. |
| **Zip export contains personal data.** An export holds user email addresses and the exporting server's `sourceHost`. | Repository export | Treat export files as confidential; delete them after import (§6.4). |

### 11.2 Hook and installer (developer machines)

| Risk | When it applies | What an admin can do |
|---|---|---|
| **Plain `http://` is allowed to any host.** The hook sends transcripts and the API key unencrypted when `serverUrl` is `http://` and not local. | A non-local `http://` `serverUrl` | Serve Log Hub over HTTPS only and distribute an `https://` `serverUrl`. |
| **Telemetry files get default permissions.** Local telemetry and OTEL files are created with the user's default file mode. | Shared or multi-user machines | Use single-user machines; restrict the project directory; keep `otelRetentionDays` low. |
| **`--api-key` on the installer command line.** The key can end up in shell history or the process list. | Full Auto Install one-liner | Use the interactive install on shared machines; rotate the key afterwards. |
| **The model name is not validated.** The `turnEndCostAdvisorModel` / `sessionAttributionLlmModel` values from the hook config are passed as-is to the local `claude --model` call. | Post-turn analysis enabled | Review changes to `.artisyn/config/log-hub.json` in code review — it is a tracked file. |
| **`claude` is invoked through a shell** for post-turn analysis (so the `claude.cmd` shim resolves). Combined with an unvalidated model name, a malicious config value could run a command. | Post-turn analysis enabled, on Windows | Same as above; keep post-turn analysis off where it is not needed. |
| **`telemetryDir` is unrestricted.** The hook writes wherever the configured path points. | A modified `log-hub.json` | Review `log-hub.json` in code review — it is a tracked file. |
| **Data from outside the project folder is sent**: the parent folder name, the user's own skills, plugins and MCP configs, and the absolute `projectRoot`. | Every upload | Inform users (see the data-collection notice); keep secrets out of user-level Claude Code configuration. |
| **The installer is fetched via `npx` with no checksum or signature**, possibly over `http://`. | Installing the hook | Serve Log Hub over HTTPS; pin and review the installer version in your internal registry. |
| **The OTEL loopback receiver has no token.** Any local process of the same user can post OTEL records to it. Browsers cannot (it accepts only `application/json` and sends no CORS headers). | Developer machines with OTEL export enabled | Use single-user machines; disable OTEL export where not needed. |
