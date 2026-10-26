# 2026-10-26: SMTP Per Auth Mode — No Warm-Up Without It, Fail Fast in Mode 3

**Status:** todo
**Priority:** low
**Type:** bug
**Module(s):** server, client, release-template, docs
**Owner:** denis.tsyplakov
**Created:** 2026-10-26

## Description

On a fresh install with no SMTP configured (`AUTH_MODE=none` from the release installer,
`SMTP_HOST` unset) every cluster worker logs at startup
`WARN {MailService} SMTP connection warm-up failed (will retry lazily on first send): Error: connect ECONNREFUSED 127.0.0.1:587`
— 15 lines on a 15-worker host. Observed on the v1.0.1 GHCR image in an isolated install test.

Cause: `MailService.onModuleInit` (`server/src/mail/mail.service.ts`) always awaits
`transporter.verify()` regardless of auth mode; with `SMTP_HOST` unset nodemailer falls back to its
built-in default `localhost:587`.

SMTP per auth mode:

| Mode | SMTP | Startup |
|---|---|---|
| 1 `none`, 4 `azure-oauth` | never used | no check, no log line |
| 2 `password` | optional | set → warm-up; unset → no check, no log line, password reset unavailable |
| 3 `password-confirm` | required | must be set and reachable, else the app does not start |

SMTP settings are either absent or set explicitly; nothing in the code falls back to a default
host/port.

## Functional Requirements

- FR-1: Modes 1/4: `MailService` performs no SMTP check, opens no SMTP connection and logs nothing
  about SMTP, whether or not any `SMTP_*` variable is set.
- FR-2: Mode 2 without SMTP (`SMTP_HOST` unset/empty): same as FR-1 — no check, no connection, no
  log line.
- FR-3: Mode 2 with SMTP: the startup warm-up runs as today; a failed warm-up logs the existing
  warning and the app still starts. Reset and "password changed" emails are sent as today.
- FR-4: Mode 3 fails fast: the existing `validateMode3()` presence/format checks stay, and the
  startup `verify()` against the configured relay must succeed — a failure aborts startup with an
  error naming the relay (`host:port`) and the cause, instead of today's warning.
- FR-5: Mode 2 password reset depends on SMTP: `GET /api/v1/auth/config` gains a boolean
  `passwordResetAvailable` (Modes 2/3 only; true in Mode 3, in Mode 2 true iff SMTP is configured).
  When false, the login page shows "Forgot password?" disabled with the hint
  "SMTP server is not configured".
- FR-6: No code-level SMTP defaults: nodemailer's `localhost:587` fallback can never be reached (no
  transporter is built from unset values), and the `SMTP_HOST`/`SMTP_PORT`/`SMTP_FROM` defaults in
  `AdminService.getAuthConfig()` are removed. `SMTP_SECURE` stays optional (unset means `false`).
- FR-7: `MailService.isConfigured()` becomes the single per-mode signal: Mode 3 → true, Mode 2 →
  non-empty `SMTP_HOST`, Modes 1/4 → false. Every send path and the warm-up gate on it.
- FR-8: Setup docs describe SMTP per the mode table above (variables, required/optional per mode,
  Mode 2 reset availability, Mode 3 fail-fast, `SMTP_SECURE` optional = `false`):
  - `release-template/INSTALL.md` and `release-template/LOCAL-BUNDLE.md` — SMTP rows in the
    "Settings" table (today they have none);
  - `release-template/.env.example` — a commented-out `SMTP_*` block with the per-mode rule;
  - `server/.env.example` — the comments above `ADMIN_CONTACT_EMAIL` and the `SMTP_*` block
    rewritten (no more "fails silently"); values point to a local Mailpit (`localhost:1025`) so the
    Mode 3 dev default can start;
  - `client/public/help/security-hardening.md` §3.4 and the "Password change" bullet,
    `component-reference.md` (Mail row), `README.md` (auth modes table: Mode 2 SMTP optional, Mode 3
    fails fast without it).

## Acceptance Criteria

- [ ] `AUTH_MODE=none` or `azure-oauth`, with or without `SMTP_HOST`: no SMTP-related line in any
      worker's log at startup.
- [ ] `AUTH_MODE=password`, `SMTP_HOST` unset: no SMTP-related log line; the login page shows
      "Forgot password?" disabled with the hint "SMTP server is not configured";
      `/api/v1/auth/config` returns `passwordResetAvailable: false`.
- [ ] `AUTH_MODE=password`, SMTP set and reachable: no warning, "Forgot password?" is active, the
      reset email is delivered.
- [ ] `AUTH_MODE=password`, SMTP set but unreachable: one `SMTP connection warm-up failed` warning
      per worker; the app starts.
- [ ] `AUTH_MODE=password-confirm`, relay unreachable: the app does not start; the log names the
      relay and the connection error.
- [ ] `AUTH_MODE=password-confirm`, relay reachable (Mailpit, scenario mode B): the app starts, no
      SMTP warning, the signup confirmation email is delivered.
- [ ] Every file listed in FR-8 states the per-mode SMTP rule; none still says Mode 2 reset "fails
      silently" or "is best-effort".

## Steps to Reproduce

1. Install a release with the one-line installer on a clean Docker host (generated `.env` has
   `AUTH_MODE=none` and no `SMTP_*` settings).
2. `docker logs artisyn-log-hub`.

**Expected:** no SMTP-related log lines.
**Actual:** one `SMTP connection warm-up failed ... ECONNREFUSED 127.0.0.1:587` warning per
cluster worker.

## Common sense considerations

- Mode 2 with `SMTP_HOST` set requires `SMTP_PORT` and `SMTP_FROM` with the Mode 3 rules, failing
  fast in `validateMode2()`; with `SMTP_HOST` unset, other `SMTP_*` values are ignored.
- The Mode 3 reachability check lives in `MailService` startup, since `validateAuthStartupConfig()`
  runs synchronously before DI exists; a failing worker exits and the existing cluster crash budget
  stops the instance — no new retry logic.
- `SMTP_USER`/`SMTP_PASSWORD` stay optional (relays like Mailpit need no auth).
- `POST /api/v1/auth/forgot-password` in Mode 2 without SMTP issues no token and returns
  `email_delivery: 'failed'`; the `/forgot-password` page, opened directly, shows the same hint.
- `passwordResetAvailable` is an additive field; a client that does not know it keeps today's
  behaviour.
- Admin "Auth" tab shows the SMTP card in Mode 3, and in Mode 2 only when SMTP is configured.
- Tests: algorithm — new Mode 2 SMTP rows in `docs/knowledgebase/algorithms/auth-startup-config.md`;
  contract — update the `GET /api/v1/auth/config` row in
  `server/test/contract/registry/f01-infra.ts`; scenario — steps in existing `tests/scenarios/auth/`
  scenarios: mode C (no SMTP: disabled link + hint) and mode B (starts with Mailpit).
- KB: update `deployment-auth-mode.md`, `authorization-and-authentificaiton.md`,
  `algorithms/auth-startup-config.md`, `api-reference.md`, and the Mode 2 comments in
  `mail.service.ts` / `auth-startup-validation.ts`.

## Notes

<!-- Append timestamped notes here as work progresses -->

### 2026-10-26 — manual acceptance checks (startup log per mode)

Run against the server bundle built from the working tree (`tmp/scenarios/stand/index.js`, the
same build the scenario stand uses), `NODE_ENV=development`, a throwaway `manual_smtp_chk`
schema, the process env set explicitly. The host dev server (`npm run start:dev`) was not used
because `server/.env.local` is loaded with `override: true` and sets its own `AUTH_MODE`/`SMTP_*`,
so it cannot be driven from the shell without editing that local file.

| Case | Started | SMTP lines in the log |
|---|---|---|
| `AUTH_MODE=none`, no `SMTP_HOST` | yes | none |
| `AUTH_MODE=password`, no `SMTP_HOST` | yes | none |
| `AUTH_MODE=password`, `SMTP_HOST=localhost SMTP_PORT=1 SMTP_FROM=x@y.test` | yes | one: `WARN: {MailService} SMTP connection warm-up failed (will retry lazily on first send): AggregateError` |
| `AUTH_MODE=password-confirm`, same relay, `ADMIN_CONTACT_EMAIL=admin@y.test` | no, exit code 1 | `ERROR: {bootstrap} SMTP relay localhost:1 is unreachable; AUTH_MODE=password-confirm requires a working relay: AggregateError` |

Observation: for `localhost` the cause prints as a bare `AggregateError`. Node tries both `::1`
and `127.0.0.1`, both are refused, and the aggregate error has an empty message. The
`host:port` in the message still names the relay, but the per-address `ECONNREFUSED` detail is
not shown.
