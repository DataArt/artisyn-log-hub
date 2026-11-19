# Implementation plan — 2026-11-05-auth-mode-admin-invite (Auth mode `strict-managed`)

## TL;DR

- New `AUTH_MODE=strict-managed`: startup validation branch, `MailService` treats it as an SMTP mode with fail-fast relay check, auth routes gated (login / forgot / reset / change-password on; signup / confirm-email / resend-confirmation 404).
- **Admin bootstrap inside `initializeDatabase()`** (new `server/src/database/bootstrap-strict-managed-admin.ts`), under the migration advisory lock, in one DB transaction: create admin (no password) + 24 h token + send email; **send failure rolls the insert back and aborts startup**. Existing account → promoted to admin, no email.
- New endpoints (strict-managed only, 404 elsewhere for every caller): `POST /api/v1/admin/users` and `POST /api/v1/admin/users/:id/password-link` in a new `AdminUserProvisioningController`; `POST /api/v1/users/:userId/reset-password-link` → 404 in strict-managed; `GET /api/v1/admin/users` gains `passwordSet` (all modes, additive).
- New services/modules: `EmailSendRateLimitService` (20 emails / IP / hour, in-memory, strict-managed only); `server/src/mail/smtp-transport.ts`, `server/src/mail/password-link-emails.ts`, `server/src/auth/password-link-ttl.ts`, `server/src/auth/password-link-url.ts`, `server/src/auth/client-ip.ts`; `PasswordResetTokensService.create` / `issueWithCooldown` take a TTL (1 h default, 24 h for admin-issued links); `UsersService.create` takes an optional transaction.
- Docs and site: user-docs (in-app help + site pages), the small-team decision diagram plus a new admin-provisioned onboarding diagram, site Q&A, release kit.
- DB changes: none (no migration — `password_reset_tokens.expires_at` is already per row).
- Behaviour change in strict-managed only: team force-invite no longer auto-provisions unknown emails.
- Test infra: new scenario stand **mode D** (`strict-managed`, production, Mailpit, restarts once to prove "second start sends no email"), new health check `scenarios-d`, new scenario `S-AUTH-11`; algorithm rows AS-108+; contract rows in F03 / F06.
- Client: login without signup link, "Set your password" variant of the reset page, admin Users tab Password column + Create user modal + Resend link; Admin Auth tab label; "Change password" in the user menu; force-invite offer hidden in strict-managed.
- Also in strict-managed: pending-registration admin routes 404; the first successful password set marks the email confirmed (keeps a later switch to `password-confirm` working).

## Reference

Requirements: [requirements.md](requirements.md) (answered Open Questions are authoritative; the planning-time answer "Forgot password? works for every account, password-less included" supersedes the earlier OQ line). Research trail: `research/findings-1.md`.

## Design Decisions

1. **Mode value** `strict-managed`; admin email is `ADMIN_CONTACT_EMAIL` (no new env var). UI label: "Strict managed (admin-provisioned users)"; the string "Mode 5" never appears in UI.
2. **Route gating** — add `'strict-managed'` to `@AllowedAuthModes` of login (`auth.controller.ts:144`), forgot-password (L216), reset-password (L230), change-password (L247). signup (L104), confirm-email, resend-confirmation stay as they are (404 in strict-managed). `GET /auth/config` returns `passwordResetAvailable: true` and `adminContactEmail` in strict-managed (same branch as `password-confirm`).
3. **Startup validation** — `validateModeStrictManaged()` in `server/src/auth/config/auth-startup-validation.ts`: (a) `PUBLIC_BASE_URL` required and absolute http(s) **regardless of `NODE_ENV`** (error: `PUBLIC_BASE_URL environment variable is required for AUTH_MODE=strict-managed (every way in is an emailed link)`); (b) `parseAllowedEmailDomains(ALLOWED_EMAIL_DOMAINS)`; (c) `ADMIN_CONTACT_EMAIL` required (`ADMIN_CONTACT_EMAIL environment variable is required for AUTH_MODE=strict-managed`) and `isEmail`; (d) `validateSmtpBlock()`. Same order as `validateMode3` (L151). `VALID_AUTH_MODES` gains `'strict-managed'` (error message lists it).
4. **Mail** — `SMTP_AUTH_MODES` (`mail.service.ts:11`) gains `'strict-managed'`; the `onModuleInit` fail-fast (L76) applies to `password-confirm` **and** `strict-managed` outside `NODE_ENV=test` (message names the active mode). Transport creation moves to `server/src/mail/smtp-transport.ts` → `createSmtpTransport(env: { host; port; secure; user?; password? }): nodemailer.Transporter` (same options incl. 5 s timeouts), used by `MailService` and the bootstrap.
5. **Email texts** — pure builders in `server/src/mail/password-link-emails.ts`, each returns `{ subject, text }`:
   - `bootstrapAdminEmail(url, baseUrl)` — subject `Set your Log Hub administrator password`; text: `You are the administrator of the Log Hub server at <baseUrl>.\n\nSet your password here (the link works once and is valid for 24 hours):\n<url>\n\nIf it expired, use "Forgot password?" on the login page.`
   - `setPasswordEmail(email, url)` — subject `Set your Log Hub password`; text: `An administrator created a Log Hub account for <email>.\n\nSet your password here (the link works once and is valid for 24 hours):\n<url>\n\nIf it expired, ask your administrator to send a new link, or use "Forgot password?" on the login page.`
   - The existing forgot-password email (`sendPasswordResetEmail`, 1 h) is unchanged.
   - `MailService.sendSetPasswordEmail(email, url): Promise<EmailDelivery>` uses `setPasswordEmail`.
6. **Link URL** — admin-issued links (bootstrap, create, resend) are the existing reset URL (`AuthService.buildResetUrl`, `#/reset-password?token=<t>` built from `getEmailLinkBaseUrl`) plus `&purpose=set`. The forgot link stays without `purpose`. Signature: `export function buildResetUrl(token: string, logger: { warn(message: string): void }, purpose?: 'set'): string | null` in `server/src/auth/password-link-url.ts` (logger type = `getEmailLinkBaseUrl`'s, `server/src/common/public-base-url.ts:44`). `null` (no base URL) → the caller sends nothing: create keeps the account and returns `email_delivery: 'failed'`, resend returns `'failed'`, bootstrap treats it as a send failure (DD 10 step 5).
7. **Token TTL** — constants in `server/src/auth/password-link-ttl.ts`: `RESET_LINK_TTL_MS = 3_600_000` (1 h, forgot) and `SET_PASSWORD_LINK_TTL_MS = 86_400_000` (24 h, bootstrap / create / resend). `PasswordResetTokensService.create(userId, ttlMs = RESET_LINK_TTL_MS)` and `issueWithCooldown(userId, ttlMs = RESET_LINK_TTL_MS)`; existing `TOKEN_TTL_MS` is replaced by the default. Export `generateResetToken(): string` (`randomBytes(32).toString('base64url')`) for the bootstrap. No migration.
8. **Single-use / retire** — unchanged: `consume` already retires every other token of the account on success; `issueWithCooldown` retires earlier tokens (resend makes the old link stop working). Create-user uses `issueWithCooldown(userId, SET_PASSWORD_LINK_TTL_MS)` (a fresh user has no token, so no cooldown; a resend within 60 s of create → 429).
9. **Forgot password for password-less accounts** — allowed (planning-time answer). `AuthService.forgotPassword` stays not gated on `passwordHash`; strict-managed only adds the email limiter (DD 11).
10. **Bootstrap** (`server/src/database/bootstrap-strict-managed-admin.ts`, `bootstrapStrictManagedAdmin(client: PoolClient, logger)`) — new step 5 of `initializeDatabase()`, inside the advisory-lock block after `resolveSessionSecret`, run only when `options.bootstrapAdmin === true` **and** `process.env.AUTH_MODE === 'strict-managed'`. `main.ts:56` passes `bootstrapAdmin: true`; `migrate.ts` and contract `global-setup.ts` do not (option defaults to false). Algorithm:
    1. read `ADMIN_CONTACT_EMAIL` (trim, lowercase), `PUBLIC_BASE_URL`, `SMTP_*`; missing → throw the same messages as DD 3 (bootstrap runs before `AppModule` validation).
    2. `BEGIN`; `SELECT id, role FROM users WHERE lower(email) = $1`.
    3. found: if role ≠ `admin` → `UPDATE users SET role = 'admin' WHERE id = $1` + log `Strict-managed bootstrap: granted admin role to <masked>`; `COMMIT`; return (no email).
    4. not found: `INSERT INTO users (email, password_hash, role) VALUES ($1, NULL, 'admin') RETURNING id`; insert token row (`generateResetToken()`, `expires_at = now() + interval '24 hours'`); build URL (DD 6); send `bootstrapAdminEmail` via `createSmtpTransport`.
    5. send ok → `COMMIT`, log `Strict-managed bootstrap: created admin <masked>, set-password link emailed`; send fails → `ROLLBACK` and throw `Error('Strict-managed bootstrap: the set-password email to <masked> could not be sent (<reason>); AUTH_MODE=strict-managed refuses to start. Fix SMTP and restart.')`.
    - `ALLOWED_EMAIL_DOMAINS` does not apply to the bootstrap address. The token and URL are never logged.
11. **Email rate limit** — `server/src/auth/email-send-rate-limit.service.ts`, `EmailSendRateLimitService` (provided and exported by `AuthModule`, one instance per worker): `RateLimiterMemory({ keyPrefix: 'email-send', points: 20, duration: 3600 })`, constant `EMAIL_SEND_LIMIT_PER_IP_PER_HOUR = 20`; `async consumeIp(ip: string): Promise<void>` → no-op unless `AUTH_MODE === 'strict-managed'`, otherwise throws `TooManyRequestsException(retryAfterSeconds)` on rejection. Call order per endpoint: existing `AuthRateLimitService` checks first (their 429s do not count), then DTO validation, then `consumeIp`, then any account lookup. Modes 1–4 are unaffected.
12. **Client IP** — move `clientIp(req)` from `auth.controller.ts:45` to `server/src/auth/client-ip.ts` (exported, same body) for reuse by the admin controller.
13. **"Password set"** — `passwordSet = password_hash IS NOT NULL AND password_hash <> '!placeholder-import-user'`, using the already exported `PLACEHOLDER_IMPORT_USER_PASSWORD_HASH` from `server/src/logs/logs.service.ts:104` (imported the same way as `teams.service.ts:33`); placeholder-imported users show "Not set" and can get a resend. Emails in logs are masked with `maskEmail` from `server/src/common/mask-email.ts`.
14. **Admin create user** — `POST /api/v1/admin/users`; body `CreateAdminUserDto { email: string (IsEmail); role: 'admin' | 'user' (IsIn, default 'user'); teamId?: number | null (IsInt, optional) }`. Order: guards → DTO 400 → domain check (DD 15) → `consumeIp` → `findByEmail` (409 `email_already_registered`, nothing sent) → team exists check (400 `team_not_found`) → `db.transaction(tx => …)`: `usersService.create(email, null, role, tx)` (new optional last param `tx` = drizzle transaction, default `this.db`, `users.service.ts:21`) + if `teamId` insert `team_members { teamId, userId, canInvite: false }` (disclosure left NULL, as `teams.service.ts:740–751`) — unique violation `23505` on users → 409 → `issueWithCooldown(id, SET_PASSWORD_LINK_TTL_MS)` → `sendSetPasswordEmail` → 201. Send failure keeps the account. Log line with masked email.
15. **Domain check** — `AuthService.assertEmailDomainAllowed` applies in `password-confirm` and `strict-managed`; make it public with a `context: 'signup' | 'admin-create'` param; message for admin-create: `This server only accepts these email domains: <list>`; error code stays `email_domain_not_allowed` (400). Signup message unchanged.
16. **Resend link** — `POST /api/v1/admin/users/:id/password-link` (ParseIntPipe): guards → `consumeIp` → user lookup (404 `user_not_found`) → `passwordSet` → 409 `password_already_set` → `issueWithCooldown(id, SET_PASSWORD_LINK_TTL_MS)` (cooldown → 429 + `Retry-After`) → `sendSetPasswordEmail` → 200 `{ email_delivery }`. Template: `admin.service.ts` `resendPendingRegistration` (~L188).
17. **Guard order for the new routes** — new controller `server/src/admin/admin-user-provisioning.controller.ts`, `@Controller('api/v1/admin/users')`, class `@UseGuards(AuthModeGuard, SessionAuthGuard, AdminGuard)`, each handler `@AllowedAuthModes('strict-managed')` → 404 for every caller (anon / user / admin) in other modes. It does not touch `admin-panel.controller.ts`.
18. **Legacy reset-link route** — `admin.controller.ts:53` gets `@AllowedAuthModes('none', 'password', 'password-confirm', 'azure-oauth')` + method `@UseGuards(AuthModeGuard)` (class guards run first: admins get 404 in strict-managed, non-admins keep 401/403).
19. **Team force-invite** — in strict-managed `TeamsService.sendInvitation` ignores `force` for an unknown email (throws the existing 404 `user_not_registered`), so only admins create accounts. The client hides the "invite anyway" offer in strict-managed (`TeamInvitationsTab.tsx:140`).
20. **API keys (FR11)** — no code change: a password-less account cannot log in (`auth.service.ts:96` early return), so it never gets a session and `ApiKeysController.create` (`SessionAuthGuard`) refuses it. Sessions and keys from Modes 1/4 that survive a switch keep working (accepted loophole, OQ6).
21. **Reset page** — `ResetPasswordPage` reads `purpose` from the hash query: `purpose=set` → title `Set your password`, submit `Set password`; otherwise unchanged. Invalid/expired text (both variants): `This link is invalid or has expired. Request a new one with "Forgot password?" on the login page.`
22. **Scenario stand mode D** — `MODES.d = { mode: 'd', authMode: 'strict-managed', nodeEnv: 'production', needsMailpit: true, restartOnce: true }`; env as mode B (SESSION_SECRET, SMTP via Mailpit, `PASSWORD_POLICY=long`) plus `ADMIN_CONTACT_EMAIL = admin-d-<runId>@arrakis.test` (per run, so Mailpit holds exactly one bootstrap mail for it). `startStand` for a `restartOnce` mode: wait for health → stop the child → spawn again on the same schema → wait for health. `run.mjs` passes `STAND_ADMIN_EMAIL` to Playwright. `ModeSpec.restartOnce?: boolean`; `StandMode` adds `'d'`; `AuthMode` (modes.ts) adds `'strict-managed'`.
    `startStand` returns only after the second health check, so the restart is finished before Playwright starts. Mode D reuses mode B's env path: `stand.mjs:219` generates `sessionSecret` for `b` and `d`, and `modes.ts` `standEnv` uses `if (input.mode === 'b' || input.mode === 'd')` for SESSION_SECRET / SMTP / `PASSWORD_POLICY` / `ADMIN_CONTACT_EMAIL`. Mode D keeps `SUITE_LIMITS_ENV` (`AUTH_RATE_LIMIT_POINTS=1000`, applied to every mode), so the 20/h email limit, not the forgot-password limiter, answers S-AUTH-11 step 8. `run.mjs` `modePasses` gives mode D one pass (no `@backoff` split; no mode-D scenario is tagged `@backoff`).
23. **`users` fixture in mode D** — no signup exists: insert `users (email, password_hash, role)` with NULL hash via the `db` pool, seed a token row (`INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, as `s-auth-04.spec.ts:29`), `POST /api/v1/auth/reset-password`, then `loginPastBackoff`. No email is sent, so the 20/h limit is untouched.
24. **Client details that need no change** — `client/src/viewer/pages/login/forgot-password-link.ts:20` already returns `'active'` when `passwordResetAvailable === true` (DD 2), so "Forgot password?" shows in strict-managed; the `PendingRegistrationsTable` block of `AdminAuthTab.tsx:124` stays `password-confirm` only (no signup in strict-managed).
25. **Site** — the site's doc pages are rendered from `user-docs/` by `npm run build:site`, so user-docs edits reach the site. Site-only material that must change too:
    - `site/diagrams/small-team-choose-env.mmd` + its ASCII "Text version" block in `user-docs/small-team-setup.md:108`: after "SMTP relay reachable? → yes" add the question `Should only the admin create accounts (no self sign-up)?` → yes → `strict-managed`, which joins the TLS question.
    - New diagram `site/diagrams/small-team-admin-provisioned.mmd` (sequenceDiagram: Admin → Log Hub "create user (email, role, team)"; Log Hub → SMTP "set-password email"; SMTP → Teammate "link = PUBLIC_BASE_URL/… (24 h, once)"; Teammate → Log Hub "open link, set password"; Teammate → Log Hub "sign in") with an ASCII block ` ```text diagram=small-team-admin-provisioned ` in `small-team-setup.md` §6 next to `small-team-signup`.
    - `small-team-setup.md`: a `### strict-managed, https://` `.env` example (as the Mode 3 one, `AUTH_MODE=strict-managed`, `ADMIN_CONTACT_EMAIL`, SMTP block, `PUBLIC_BASE_URL`), and in §6 "Become the admin": in strict-managed the first admin is `ADMIN_CONTACT_EMAIL`, who gets a set-password email on first start, then creates teammates in Admin Panel → Users.
    - `site/pages/questions.html` (Access): "Which sign-in methods are there?" adds `or accounts created only by the admin, who get an emailed set-password link`; "Is there an audit trail?" adds `admin-created accounts and set-password links`.
    - Verify with `npm run build:site` (output `tmp/site/`; the build fails on a broken link or bad nav description).
27. **Email confirmed on first password set** — admin-created and bootstrap accounts are inserted with `email_confirmed_at` NULL; in strict-managed, `AuthService.resetPassword` (~L229) sets `email_confirmed_at = now()` when it is NULL after a successful token consume (the link proves the mailbox). A later switch to `password-confirm` then does not lock these users out (`local.strategy.ts:63`). Other modes unchanged.
28. **Pending-registration routes** — `GET auth/pending-registrations`, `POST auth/pending-registrations/:id/resend`, `DELETE auth/pending-registrations/:id` (`admin-panel.controller.ts:175/180/186`) get method-level `@AllowedAuthModes('none', 'password', 'password-confirm', 'azure-oauth')` + `@UseGuards(AuthModeGuard)` → 404 in strict-managed only (they would otherwise send confirm-email links to password-less strict-managed users, bypassing the email limiter).
29. **Cluster** — every worker runs `initializeDatabase`; under the lock only the first creates and sends. If the send fails, each worker aborts the same way and the cluster primary's existing crash budget (`cluster-primary.ts`) stops re-forking; repeated error lines are expected. The manual check runs without `CLUSTER_MODE`.
26. **S-AUTH-11 email budget** — steps 1–7 send fewer than 10 emails from 127.0.0.1 (well under 20/h); step 8 uses two fresh `randomLoopbackAddress()` addresses X and Y (`tests/scenarios/helpers/loopback-client.ts`). Mailpit messages are always filtered by recipient (`listEmailsTo` from `tests/scenarios/helpers/mailpit.ts`), never by total count.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `server/src/auth/config/auth-startup-validation.ts` | mode + validation | DD 3 |
| `server/src/mail/smtp-transport.ts` (new) | shared transport factory | DD 4 |
| `server/src/mail/password-link-emails.ts` (new) | email text builders | DD 5 |
| `server/src/mail/mail.service.ts` | SMTP modes, fail-fast, `sendSetPasswordEmail` | DD 4/5 |
| `server/src/auth/password-link-ttl.ts` (new) | TTL constants | DD 7 |
| `server/src/auth/password-link-url.ts` (new) | `buildResetUrl(token, purpose?)` | DD 6 |
| `server/src/auth/password-reset-tokens.service.ts` | TTL param, `generateResetToken` | DD 7 |
| `server/src/auth/email-send-rate-limit.service.ts` (new) | 20/IP/h limiter | DD 11 |
| `server/src/auth/client-ip.ts` (new) | shared `clientIp` | DD 12 |
| `server/src/auth/auth.module.ts` | provide/export limiter | DD 11 |
| `server/src/database/bootstrap-strict-managed-admin.ts` (new) | bootstrap | DD 10 |
| `server/src/database/database-init.ts` | step 5 + `bootstrapAdmin` option | DD 10 |
| `server/src/main.ts` | pass `bootstrapAdmin: true` | DD 10 |
| `server/src/auth/auth.controller.ts` | gating, config, limiter on forgot | DD 2/11 |
| `server/src/auth/auth.service.ts` | URL helper, domain check public | DD 6/15 |
| `server/src/teams/teams.service.ts` | force-invite in strict-managed | DD 19 |
| `server/src/admin/dto/create-admin-user.dto.ts` (new) | DTO | DD 14 |
| `server/src/admin/admin-user-provisioning.controller.ts` (new) | new routes | DD 17 |
| `server/src/admin/admin.service.ts` | `createProvisionedUser`, `sendPasswordLink`, `passwordSet` | DD 13/14/16 |
| `server/src/admin/admin.controller.ts` | legacy reset-link guard | DD 18 |
| `server/src/admin/admin.module.ts` | register controller, import AuthModule/MailModule if missing | — |
| `client/src/models/auth.ts`, `client/src/models/admin.ts` | `AuthMode`, `AdminUser.passwordSet`, create types | twins of server shapes |
| `client/src/viewer/api.ts` | `createAdminUser`, `sendPasswordLink` | — |
| `client/src/viewer/pages/login/LoginPage.tsx` | strict-managed form, `showSignupLink` prop | — |
| `client/src/viewer/pages/signup/SignupPage.tsx` | redirect signup → login in strict-managed | — |
| `server/src/admin/admin-panel.controller.ts` | pending-registration routes 404 in strict-managed | DD 28 |
| `tests/scenarios/README.md` | mode D, `STAND_ADMIN_EMAIL`, Mailpit for B and D, `--mode a,b,c,d` | — |
| `client/src/viewer/pages/reset-password/ResetPasswordPage.tsx` | `purpose=set` variant | DD 21 |
| `client/src/viewer/components/top-nav/UserMenu.tsx` | change password in strict-managed | — |
| `client/src/viewer/pages/admin/tabs/AdminAuthTab.tsx` | label + fields | DD 1 |
| `client/src/viewer/pages/teams/tabs/TeamInvitationsTab.tsx` | hide force offer | DD 19 |
| `client/src/viewer/pages/admin/tabs/AdminUsersTab.tsx` | Password column, actions | Visual/UX |
| `client/src/viewer/pages/admin/tabs/CreateUserModal.tsx` (new) | create dialog | Visual/UX |
| `client/src/viewer/pages/admin/tabs/SendPasswordLinkButton.tsx` (new) | resend with countdown | Visual/UX |
| docs: `docs/knowledgebase/authorization-and-authentificaiton.md`, `user-account-flows.md`, `server-endpoint-map.md`, `deployment-auth-mode.md`, `test/scenarios.md`, `algorithms/auth-startup-config.md` | KB | — |
| `user-docs/authentication-modes.md`, `security-hardening.md`, `server-configuration.md`, `install-server.md`, `small-team-setup.md`, `responsibility-matrix.md`, `component-reference.md` | user docs (in-app help) | then `npm run build:help` |
| `release-template/.env.example`, `release-template/docker-compose.yml`, `release-template/INSTALL.md`, `server/.env.example` | release kit | mode list comments |
| `site/diagrams/small-team-choose-env.mmd`, `site/diagrams/small-team-admin-provisioned.mmd` (new), `site/pages/questions.html` | site | DD 25 |
| `server/src/users/users.service.ts` | `create(…, tx?)` | DD 14 |
| `tests/scenarios/modes.ts`, `scripts/scenarios/stand.mjs`, `scripts/scenarios/run.mjs`, `playwright.scenarios.config.ts`, `scripts/__tests__/scenarios-stand.test.js`, `tests/scenarios/fixtures/index.ts` | stand mode D | DD 22/23 |
| `.claude/repo_config/repo-health-checks.json`, `CLAUDE.md` | `scenarios-d` check | — |
| `docs/algorithm-examples/auth-startup-config.json` | rows AS-108+ | Test plan |
| `server/test/contract/registry/f03-auth-modes.ts`, `f06-admin-users.ts` | contract rows | Test plan |
| `tests/scenarios/auth/s-auth-07.spec.ts` | mode matrix + `@mode-d` | Test plan |
| `tests/scenarios/auth/s-auth-11.spec.ts` (new) | strict-managed scenario | Test plan |
| `docs/qaa-overview/scenarios/01-auth-access-admin.md` | S-AUTH-11 entry, mode D row | — |

## API changes

| Endpoint | Method | Request | Response | Errors |
|---|---|---|---|---|
| `/api/v1/admin/users` (new, strict-managed only, admin) | POST | `{ email: string; role?: 'admin' \| 'user'; teamId?: number \| null }` | 201 `{ id: number; email: string; role: 'admin' \| 'user'; teamId: number \| null; email_delivery: 'sent' \| 'failed' }` | 400 `validation` / `email_domain_not_allowed` / `team_not_found`; 401; 403; 404 other modes; 409 `email_already_registered`; 429 + `Retry-After` |
| `/api/v1/admin/users/:id/password-link` (new, strict-managed only, admin) | POST | — | 200 `{ email_delivery: 'sent' \| 'failed' }` | 401; 403; 404 `user_not_found` / other modes; 409 `password_already_set`; 429 + `Retry-After` |
| `/api/v1/users/:userId/reset-password-link` | POST | unchanged | unchanged | + 404 in strict-managed |
| `/api/v1/admin/users` | GET | unchanged | each row + `passwordSet: boolean` (all modes) | — |
| `/api/v1/auth/config` | GET | — | `mode: 'strict-managed'`, `passwordResetAvailable: true`, `adminContactEmail` | — |
| `/api/v1/auth/login`, `forgot-password`, `reset-password`, `change-password` | POST | unchanged | unchanged | forgot: + 429 from the email limiter in strict-managed |
| `/api/v1/auth/signup`, `confirm-email`, `resend-confirmation` | POST | — | — | 404 in strict-managed |
| `/api/v1/teams/:teamId/invitations` | POST | unchanged | unchanged | strict-managed: `force: true` for an unknown email → 404 `user_not_registered` |

Types: server `CreateAdminUserDto` (DD 14) and response interface `CreateAdminUserResponse` in `server/src/admin/admin.service.ts` next to `UserRow`; client twins `CreateAdminUserRequest`, `CreateAdminUserResponse`, `AdminUser.passwordSet` in `client/src/models/admin.ts`; `AuthMode` union in `client/src/models/auth.ts:22`.

## Test coverage plan

Under CLAUDE.md "Test policy" (only algorithm rows, contract rows, scenario steps):

- **Algorithm** — `docs/knowledgebase/algorithms/auth-startup-config.md` + rows `docs/algorithm-examples/auth-startup-config.json` (AS-108+), picked up by `server/src/auth/config/auth-startup-validation.algo.spec.ts`: strict-managed valid config ok; missing / invalid `ADMIN_CONTACT_EMAIL`; missing `SMTP_HOST` / `SMTP_FROM` / bad `SMTP_PORT`; missing `PUBLIC_BASE_URL` with `NODE_ENV` not production (still required); malformed `ALLOWED_EMAIL_DOMAINS`; the unknown-mode row whose error lists the modes updated.
- **API contract** — `server/test/contract/registry/f03-auth-modes.ts`, four cases expecting 404 in `password-confirm`: `F03-admin-create-user-404-anon` / `-admin` (`POST /api/v1/admin/users`, body `{ email: 'new-user@arrakis.test' }`) and `F03-admin-password-link-404-anon` / `-admin` (`POST /api/v1/admin/users/:id/password-link`, `params: { id: '@owner.id' }` as `f06-admin-users.ts:92`); `f06-admin-users.ts`: `F06-list` (strict) adds `passwordSet` to its SQL and fields. The legacy reset-link rows stay (route unchanged in password-confirm).
- **Scenario** — `tests/scenarios/auth/s-auth-07.spec.ts` (mode matrix) runs on mode D too with `EXISTS['strict-managed']`. New `tests/scenarios/auth/s-auth-11.spec.ts` `@S-AUTH-11 @mode-d` (new feature, no existing scenario covers a strict-managed stand) covers AC1, AC4–AC11. AC2/AC3 config errors are algorithm rows. An unreachable relay and a failed bootstrap send at startup cannot be staged on the scenario stand; they get a manual check in the last chunk.
- Build-script tests: `scripts/__tests__/scenarios-stand.test.js` pins the mode table (it already exists and is part of `test:scripts`).

### S-AUTH-11 steps (`tests/scenarios/auth/s-auth-11.spec.ts`, `@S-AUTH-11 … @mode-d`)

1. **Bootstrap (AC1, AC4)** — `listEmailsTo(stand.adminEmail)` holds exactly one mail (subject per DD 5) after the stand's restart; its link contains `purpose=set`; in the UI the page shows "Set your password"; the admin sets a password and logs in; `GET /auth/config` → `mode: 'strict-managed'`, `passwordResetAvailable: true`, `adminContactEmail`.
2. **No signup (AC5)** — the login page has no "Sign up" link and shows "Forgot password?"; `#/signup` lands on `#/login`; signup / confirm-email / resend-confirmation → 404.
3. **Create user (AC6)** — the admin opens Admin → Users → "+ Create user", enters an email, role User, a team; the success notice shows; the row shows `Not set` + "Resend link"; the mail arrives; the user follows the link, sets a password, logs in and is a member of the team; the row shows `Set` and no "Resend link".
4. **Resend and refusals (AC6)** — for a second created user: resend after 60 s (or `UPDATE password_reset_tokens SET created_at = created_at - interval '61 seconds'`) → 200, the old link → refused, the new one works; resend within 60 s → 429 + `Retry-After`; resend for a user with a password → 409 `password_already_set`; create with an existing email (other case) → 409, no mail; a plain user calling both routes → 403; `POST /api/v1/users/:id/reset-password-link` as admin → 404.
5. **Forgot (AC8)** — forgot for an existing user, an unknown email and a password-less created user: identical 200 bodies; mails only to the existing and the password-less users; the password-less user's link sets a password.
6. **Lifetimes (AC9)** — create-user link with `expires_at` shifted back 23 h → works; another with 24 h → refused with the DD 21 text in the UI and 410 from the API; a forgot link shifted back 1 h → refused; a used link → refused.
7. **No password, no key (AC7, AC11)** — login of a password-less user with any password → 401; `POST /api/v1/api-keys` without a session → 401; after the user sets a password and logs in, the key is created.
8. **Email limit (AC10)** — via `loopbackClient(stand.url, X)`: 20 forgot-password calls for unknown emails → 200; the 21st → 429 with `Retry-After` and no mail; `loopbackClient(stand.url, Y)` → 200 (DD 26).

## Visual/UX notes

- Login (strict-managed): the `PasswordLoginForm` of Modes 2/3 with "Forgot password?" and **no** "Don't have an account? Sign up" line; `#/signup` redirects to `#/login`.
- Admin → Users (strict-managed only): a "Password" column after Role showing a `Set` / `Not set` chip (Not set = amber outline chip, existing chip component); a "+ Create user" primary button above the table, right-aligned; the "Reset Password" action is hidden; rows with `Not set` show a "Resend link" action (60 s countdown after a click and on 429 `retryAfterSeconds`, as `PendingRegistrationsTable.tsx:42–88`).
- Create user dialog (pattern `RenameUserEmailModal.tsx`): Email field, Role select (User / Admin, default User), Team select (None + teams from `GET /api/v1/admin/teams`), buttons Cancel / "Create & send". Results: `sent` → success notice `Set-password link sent to <email>`; `failed` → amber notice `Account created, but the link was not sent — use Resend link`; 409 → inline field error `A user with this email already exists`; 400 domain → inline field error with the server message; 429 → `Too many requests, try again in <N>s`.
- Reset page with `purpose=set`: title "Set your password", button "Set password".
- `AdminUsersTab.tsx` is ~302 lines: the modal and the resend button live in their own files so the tab stays under the component-size threshold.

## Wireframes

The wireframes stay as reference. Where they differ, the plan wins (no SVG edits): resend is offered only to `Not set` users (no "Send reset link" for users with a password); the link lifetime depends on how the link was issued; the expired-link text is DD 21.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Server config, mail and token foundations | 7 | no dependencies |
| 2 | Admin bootstrap in DB init | 4 | uses chunk 1 transport, emails, token, URL |
| 3 | Auth API gating and email limiter use | 6 | uses chunk 1 |
| 4 | Admin API: create user, resend link, list | 7 | uses chunks 1, 3 |
| 5 | Client: auth pages and mode plumbing | 6 | API per API changes |
| 6 | Client: admin Users tab | 5 | API shapes per API changes |
| 7 | Scenario stand mode D | 7 | test infra; DD 22/23 |
| 8 | Tests: rows, contract, scenarios | 7 | needs chunks 1–7 |
| 9 | Knowledgebase and release kit | 6 | after behaviour is verified |
| 10 | User docs and site | 6 | after chunk 9 |

### Chunk 1 — Server config, mail and token foundations
- [x] In `server/src/auth/config/auth-startup-validation.ts` add `'strict-managed'` to `VALID_AUTH_MODES`, add `validateModeStrictManaged()` per Design Decision 3 and a `case 'strict-managed'` in `validateAuthStartupConfig`; reword the `validatePublicBaseUrl` production error to not claim "password and password-confirm only".
- [x] Create `server/src/mail/smtp-transport.ts` exporting `createSmtpTransport(env)` per Design Decision 4; make the `MailService` constructor use it.
- [x] In `server/src/mail/mail.service.ts` add `'strict-managed'` to `SMTP_AUTH_MODES`, extend the `onModuleInit` fail-fast to strict-managed (Design Decision 4), add `sendSetPasswordEmail(email, url)`; create `server/src/mail/password-link-emails.ts` with both builders per Design Decision 5.
- [x] Create `server/src/auth/password-link-ttl.ts` (Design Decision 7); in `password-reset-tokens.service.ts` add the `ttlMs` param to `create` and `issueWithCooldown`, export `generateResetToken()`, remove `TOKEN_TTL_MS`.
- [x] Create `server/src/auth/password-link-url.ts` with `buildResetUrl` per Design Decision 6; make `AuthService.buildResetUrl` (auth.service.ts:387) delegate to it.
- [x] Create `server/src/auth/client-ip.ts` with `clientIp(req)` moved from `auth.controller.ts:45` (Design Decision 12); import it in `auth.controller.ts`.
- [x] Create `server/src/auth/email-send-rate-limit.service.ts` (`EmailSendRateLimitService`, Design Decision 11); provide and export it from `server/src/auth/auth.module.ts`.

### Chunk 2 — Admin bootstrap in DB init
- [x] Create `server/src/database/bootstrap-strict-managed-admin.ts` exporting `bootstrapStrictManagedAdmin(client: PoolClient, logger)` with Design Decision 10 steps 1–3 (env read and checks, `BEGIN`, lookup, promote to admin, `COMMIT`), masked emails via `maskEmail`.
- [x] Add Design Decision 10 steps 4–5 to it (insert user + token, `buildResetUrl(token, logger, 'set')`, `bootstrapAdminEmail`, `createSmtpTransport` send, `COMMIT` or `ROLLBACK` + throw); never log the token or URL.
- [x] In `server/src/database/database-init.ts` add option `bootstrapAdmin?: boolean` (default false) and call `bootstrapStrictManagedAdmin` as step 5 after `resolveSessionSecret`, inside the lock, only when the option is true and `AUTH_MODE === 'strict-managed'`.
- [x] In `server/src/main.ts:56` pass `bootstrapAdmin: true` to `initializeDatabase`; leave `migrate.ts` and contract `global-setup.ts` unchanged. A bootstrap throw already ends the process through `bootstrap().catch` → `logFatalError` (main.ts:152) — no change there.

### Chunk 3 — Auth API gating and email limiter use
- [x] In `server/src/auth/auth.controller.ts` add `'strict-managed'` to `@AllowedAuthModes` of login, forgot-password, reset-password, change-password (Design Decision 2); leave signup, confirm-email and resend-confirmation unchanged.
- [x] In `AuthController.config()` (L60) return `passwordResetAvailable: true` and `adminContactEmail` for strict-managed, like `password-confirm`.
- [x] In the forgot-password handler call `EmailSendRateLimitService.consumeIp(clientIp(req))` after the existing `consumeIp` / `consumeEmail` checks and before `authService.forgotPassword` (Design Decision 11).
- [x] In `server/src/auth/auth.service.ts` make `assertEmailDomainAllowed(email, context)` public, applied in `password-confirm` and `strict-managed`, messages per Design Decision 15; signup passes `'signup'`.
- [x] In `AuthService.resetPassword` (~L229) set `email_confirmed_at = now()` when NULL after a successful consume, strict-managed only (Design Decision 27).
- [x] In `server/src/teams/teams.service.ts` `sendInvitation` (L675) treat `force` as false when `AUTH_MODE === 'strict-managed'` (Design Decision 19), via `ConfigService` (inject if missing).

### Chunk 4 — Admin API: create user, resend link, list
- [x] Create `server/src/admin/dto/create-admin-user.dto.ts` (`CreateAdminUserDto` per Design Decision 14, class-validator); add `tx?` (drizzle transaction, default `this.db`) as the last parameter of `UsersService.create` (`server/src/users/users.service.ts:21`).
- [x] In `server/src/admin/admin.service.ts` add `passwordSet` to `UserRow` (~L83) and to the `getUsers()` (~L481) select per Design Decision 13; add the `CreateAdminUserResponse` interface (API changes).
- [x] Add `AdminService.createProvisionedUser(dto, ip)` per Design Decision 14 (with `assertEmailDomainAllowed(email, 'admin-create')`, `EmailSendRateLimitService`, `UsersService.create(…, tx)`, `issueWithCooldown(id, SET_PASSWORD_LINK_TTL_MS)`, `buildResetUrl(token, logger, 'set')`, `sendSetPasswordEmail`).
- [x] Add `AdminService.sendPasswordLink(userId, ip)` returning `{ email_delivery }` per Design Decision 16.
- [x] Create `server/src/admin/admin-user-provisioning.controller.ts` with `POST /api/v1/admin/users` (201) and `POST /api/v1/admin/users/:id/password-link` (200), guards and metadata per Design Decision 17, IP via `clientIp`.
- [x] Register the controller in `server/src/admin/admin.module.ts`; import the modules exporting `AuthService`, `EmailSendRateLimitService`, `MailService`, `PasswordResetTokensService`, `UsersService` where not yet imported.
- [x] In `server/src/admin/admin.controller.ts:53` add `@AllowedAuthModes('none', 'password', 'password-confirm', 'azure-oauth')` and method `@UseGuards(AuthModeGuard)` (Design Decision 18); do the same on the three pending-registration routes of `admin-panel.controller.ts` (Design Decision 28).

### Chunk 5 — Client: auth pages and mode plumbing
- [x] In `client/src/models/auth.ts:22` add `'strict-managed'` to `AuthMode`; in `AdminAuthTab.tsx` add `MODE_LABELS` / `MODE_FIELD_NAMES` entries (label per Design Decision 1, fields as `password-confirm`); fill any other `Record<AuthMode, …>` client typecheck reports; leave L124 as is (Design Decision 24).
- [x] In `client/src/viewer/pages/login/LoginPage.tsx` render `PasswordLoginForm` for strict-managed (L311–316) and add a `showSignupLink` prop (L121, hides L260–268), false for strict-managed.
- [x] Redirect `#/signup` to `#/login` in `SignupPage.tsx` when `useAuthConfig` reports strict-managed.
- [x] In `client/src/viewer/pages/reset-password/ResetPasswordPage.tsx` implement the `purpose=set` variant and the invalid/expired text per Design Decision 21.
- [x] In `client/src/viewer/components/top-nav/UserMenu.tsx:38` allow "Change password" in strict-managed.
- [x] In `client/src/viewer/pages/teams/tabs/TeamInvitationsTab.tsx` hide the force-invite offer (L140 flow) in strict-managed (Design Decision 19).

### Chunk 6 — Client: admin Users tab
- [x] In `client/src/models/admin.ts` add `AdminUser.passwordSet: boolean`, `CreateAdminUserRequest`, `CreateAdminUserResponse` (shapes per API changes).
- [x] In `client/src/viewer/api.ts` add `createAdminUser(req)` (POST `/api/v1/admin/users`) and `sendPasswordLink(userId)` (POST `/api/v1/admin/users/:id/password-link`), following `resendPendingRegistration` (L2724) incl. `ApiError.retryAfterSeconds`.
- [x] Create `client/src/viewer/pages/admin/tabs/CreateUserModal.tsx` per Visual/UX notes (Dialog pattern of `RenameUserEmailModal.tsx`; teams via `fetchAdminTeams()` (`api.ts:2425`), query key `['admin-teams']`); on success invalidate `['admin-users']`.
- [x] Create `client/src/viewer/pages/admin/tabs/SendPasswordLinkButton.tsx` (Resend link, 60 s countdown, 429 handling as `PendingRegistrationsTable.tsx:42–88`).
- [x] In `AdminUsersTab.tsx`, strict-managed only (mode from `useAuthConfig`, `client/src/viewer/hooks/useAuthConfig.ts`): Password column, "+ Create user" button, Resend link for `passwordSet === false`, hide "Reset Password" (~L208); other modes unchanged; visual check per the `use-playwright` skill.

### Chunk 7 — Scenario stand mode D
- [x] In `tests/scenarios/modes.ts` add mode `d` per Design Decision 22 (`StandMode`, `AuthMode`, `ModeSpec.restartOnce`, `STAND_MODES`, `MODES`, `isStandMode`, `parseModes` error text, `standEnv` branch with per-run `adminContactEmail`).
- [x] In `scripts/scenarios/stand.mjs` `startStand`: `sessionSecret` for modes b and d (L219); for mode d generate `admin-d-<runId>@arrakis.test`, pass it to `standEnv`, return it as `adminEmail`; for `restartOnce` modes stop and respawn once on the same schema after the first health check (Design Decision 22).
- [x] In `scripts/scenarios/run.mjs` pass `STAND_ADMIN_EMAIL` to Playwright (env block ~L261) and update usage strings to `a,b,c,d`.
- [x] In `playwright.scenarios.config.ts` add `modeProject('d')` and widen its mode type.
- [x] In `tests/scenarios/fixtures/index.ts` expose `stand.adminEmail` from `STAND_ADMIN_EMAIL` and add the mode-D `openSession` path per Design Decision 23.
- [x] Update `scripts/__tests__/scenarios-stand.test.js` (L48–80) for the mode-d row, its env and `restartOnce`; update `tests/scenarios/README.md` (mode D, `STAND_ADMIN_EMAIL`, Mailpit for B and D, `--mode a,b,c,d`).
- [x] Add check `scenarios-d` (`npm run test:scenarios -- --mode d --only scenarios`, group `app`, 600 s, `finalOnly`, instructions as `scenarios-b`) to `.claude/repo_config/repo-health-checks.json`; list it in `CLAUDE.md` (fast vs full set list and the scenarios notes).

### Chunk 8 — Tests: rows, contract, scenarios
- [x] Add rows AS-108+ to `docs/algorithm-examples/auth-startup-config.json` per Test coverage plan (Algorithm); update the existing row pinning the mode list / `PUBLIC_BASE_URL` wording; run server `npm run test`.
- [x] Add the four F03 cases named in Test coverage plan (API contract) to `server/test/contract/registry/f03-auth-modes.ts` and `passwordSet` to `F06-list` SQL/fields in `f06-admin-users.ts`.
- [x] In `tests/scenarios/auth/s-auth-07.spec.ts` add `EXISTS['strict-managed'] = ['login', 'forgot-password', 'reset-password', 'change-password']`, tag `@mode-d`, and assert both new admin routes answer 404 in modes a–c.
- [x] Create `tests/scenarios/auth/s-auth-11.spec.ts` with steps 1–4 of Test coverage plan → "S-AUTH-11 steps", email budget per Design Decision 26.
- [x] Add steps 5–8 of "S-AUTH-11 steps" to `s-auth-11.spec.ts`.
- [x] Manual check: start the server with `AUTH_MODE=strict-managed`, valid config, a fresh `E2E_DB_SCHEMA`, `SMTP_PORT` at a closed port → startup aborts with the Design Decision 10 step 5 error and no `users` row for `ADMIN_CONTACT_EMAIL`; with the admin already present → aborts with the `MailService` relay error; no `CLUSTER_MODE`; drop the schema afterwards (`DROP SCHEMA <name> CASCADE`); report both.
- [x] Run `npm run test:scenarios -- --mode d --only scenarios,contract --grep "@S-AUTH-11|@S-AUTH-07"` and fix failures.

### Chunk 9 — Knowledgebase and release kit
- [x] `docs/knowledgebase/authorization-and-authentificaiton.md`: strict-managed in the mode table, startup validation, SMTP per mode, email limiter, bootstrap step, force-invite rule.
- [x] `docs/knowledgebase/user-account-flows.md`: set-password links (24 h, `purpose=set`), admin create / resend, bootstrap; `docs/knowledgebase/deployment-auth-mode.md`: five modes.
- [x] `docs/knowledgebase/server-endpoint-map.md`: new controller, both routes and guard order (Design Decision 17), legacy reset-link 404 in strict-managed.
- [x] `docs/knowledgebase/algorithms/auth-startup-config.md`: strict-managed branch and the `PUBLIC_BASE_URL` rule; `docs/knowledgebase/test/scenarios.md` modes table (D = `strict-managed`, production, Mailpit, restarts once).
- [x] `docs/qaa-overview/scenarios/01-auth-access-admin.md`: mode D row in the modes table and the S-AUTH-11 entry (purpose, steps, ACs covered).
- [x] Release kit: `release-template/.env.example` (L31–58), `release-template/docker-compose.yml:46` mode comment, `release-template/INSTALL.md`, `server/.env.example` — list `strict-managed` and its required vars, self-contained (offline first).

### Chunk 10 — User docs and site
- [x] `user-docs/authentication-modes.md`: five modes; strict-managed section (required vars, first admin via `ADMIN_CONTACT_EMAIL` email, admin creates users, 24 h / 1 h links, Forgot password works for everyone, 20 emails/IP/h).
- [x] `user-docs/security-hardening.md` (§3.3, §3.4, §11 rate limit), `server-configuration.md`, `install-server.md` ("Check that you are the admin" for strict-managed), `responsibility-matrix.md`, `component-reference.md`: mention strict-managed where modes are listed, linking to `authentication-modes.md` instead of repeating it.
- [x] `user-docs/small-team-setup.md`: decision-tree ASCII block + `site/diagrams/small-team-choose-env.mmd`, the strict-managed `.env` example and §6 text per Design Decision 25.
- [x] Create `site/diagrams/small-team-admin-provisioned.mmd` and its ASCII block in `small-team-setup.md` §6 per Design Decision 25.
- [x] `site/pages/questions.html` Access answers per Design Decision 25.
- [x] Run `npm run build:help` and `npm run build:site`; open `tmp/site/docs/small-team-setup.html` and `authentication-modes.html` and check both diagrams render (per the `use-playwright` skill).

### Chunk 11 — Review fixes (2026-11-19 security review + exploratory test on a Docker stand)

Findings S1–S10 (security) and U1–U16 (UX/logic) are listed in `notes.md` (2026-11-19). Fixes:

- [x] Migration `0094`: `password_reset_tokens.token` stores `sha256(token)` hex (existing rows hashed in place, so outstanding links keep working); new column `purpose` (`'reset'` | `'set'`, default `'reset'`); new table `email_send_counters` (shared fixed-window counter). `PasswordResetTokensService` hashes on write and lookup (S7).
- [x] `resetPassword`: check the token without consuming it, validate mismatch / policy, then consume (U1); on success revoke all the user's sessions (S8).
- [x] Token purposes: forgot-password issues `reset` tokens and retires only earlier `reset` tokens (an admin-issued `set` link survives, U4/S9); admin create / resend issues `set` tokens, cooldown counted against the last `set` token only.
- [x] `forgotPassword`: cooldown answers the same 200 as success, the email is sent without awaiting it (S5/U2); a password-less account gets the set-password wording (U15a); placeholder (import) accounts get nothing in strict-managed (S3).
- [x] Bootstrap: an existing non-admin account with `ADMIN_CONTACT_EMAIL` is promoted only after its password, confirmation and sessions are cleared and a set link is emailed — same rollback-and-refuse rule on send failure (S1).
- [x] strict-managed requires a verified mailbox: login and session deserialisation refuse accounts with `email_confirmed_at IS NULL` (403 `email_not_verified`; "Forgot password?" verifies it) (S2).
- [x] Rename email: retire outstanding reset / confirmation tokens in every mode; in strict-managed also apply the domain allow-list and clear `email_confirmed_at` (S4).
- [x] Email limiter: shared across cluster workers (DB counter); anonymous requests keyed by IP (20 / h), admin create / resend keyed by admin id (100 / h) (S6, U5). Resend link refuses placeholder accounts and malformed stored emails (S3). Docs recommend a hop count / CIDR for `TRUST_PROXY`.
- [x] Admin users list: `passwordLinkSentAt` (last `set` link) and `imported` flag; the Resend button counts down from it, so the cooldown survives a reload and starts at create (U6/U11); imported accounts show "Imported", no Resend.
- [x] Client: TeamMembersTab has the strict-managed refusal (U3); ForgotPasswordPage handles 429 (U7); set/reset success notice on the reset page (U8); login hint naming the administrator (U9); policy hint shown before submit (U10); confirm-email redirects to login (U12); readable create-user email error (U13); Auth tab label and required fields (U14); admin-facing invitation wording (U15b); team state reset on identity change (U16).
- [x] Tests: contract rows (forgot cooldown 200, reset with weak password keeps the token, rename retires tokens, list fields); S-AUTH-11 steps (weak password keeps the link, forgot keeps the admin link, members tab refusal, unverified login refused); docs and KB.
