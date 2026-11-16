# Research findings 1 — 2026-11-16

Note: `ce` was not on PATH in the research session; structural research was done with grep.

## Requirements summary
New fifth `AUTH_MODE=strict-managed`: no self-service signup (signup / confirm-email / resend-confirmation 404), login + forgot-password + reset-password + change-password allowed; `/auth/config` returns `passwordResetAvailable: true` + `adminContactEmail`. Startup refuses without `SMTP_HOST/PORT/FROM`, reachable relay, `PUBLIC_BASE_URL`, `ADMIN_CONTACT_EMAIL`. During DB init under the migration advisory lock, server creates the admin account (no password) and only the inserting process emails a 24 h set-password link; failed send ⇒ refuse to start; existing account ⇒ promote to admin if needed, no email. Admin creates users (email + role + team; `ALLOWED_EMAIL_DOMAINS` applies) via `POST /api/v1/admin/users`, resends to password-less users via `POST /api/v1/admin/users/:id/password-link` (both Mode-5-only, 24 h links); users list marks "password not set"; `POST /api/v1/users/:userId/reset-password-link` → 404 in this mode, UI action hidden. Forgot-password links 1 h, only for accounts that already have a password (OQ). Single-use; setting a password retires all other links. Password-less accounts cannot log in / get API keys (but pre-existing keys keep working — accepted loophole). Per-IP email limiter 20/h, in-memory per worker, shared by forgot / create / resend, counts every accepted request before account lookup, on top of `AuthRateLimitService`. Existing self-registered accounts keep working.

## Requirements conflicts
1. FR1/AC1 "Mode 5 value" → `strict-managed` (OQ1); admin email env = `ADMIN_CONTACT_EMAIL` (OQ1), which also fills FR3's unnamed var.
2. FR4 only says "if no account exists, create"; OQ2 adds: existing account without admin role → granted admin at startup.
3. FR4/NFR silent on send failure; OQ2: fail fast, refuse to start. Trap: if insert commits and send fails, next start sees account ⇒ sends nothing ⇒ admin stuck without password and (conflict 4) no self-service way in. Plan must either roll back the insert on send failure or treat "admin exists, no password, no live token" as needing a new bootstrap link.
4. FR8 / AC8 / AC9 vs OQ ("password-less users cannot use Forgot password") — direct contradiction. FR8: first admin whose bootstrap email got lost gets a new link through "Forgot password?"; AC8 tests exactly that; AC9 "forgot-password link refused after 1 h, also for an account that has no password yet". Under the OQ, AC8 last sentence and part of AC9 are void and a bootstrap admin who loses the email has no way in. Current server explicitly allows forgot for null-hash accounts (`auth.service.ts` ~L183, comment about Mode-4 switch). Must stay enumeration-safe (same 200, no email for password-less).
5. FR6 body `{ email }` vs OQ4 (form also sets role and team) → body needs role + team; 201 should echo team.
6. FR6 lists 400 only for malformed email; OQ5 ⇒ also a domain rejection (e.g. 400 `email_domain_not_allowed`).
7. FR11/AC11 "no API key without a password" vs OQ6 "keys already issued to Mode 1/4 accounts keep working".
8. Wireframes vs FR6/FR9/OQ — see Wireframes.

## Wireframes
`wireframes/` (pre-OQ proposals):
- `login-mode5.svg` — reuses `PasswordLoginForm` minus the "Don't have an account? Sign up" line; reuses `ForgotPasswordPage` unchanged; 429 text "Too many requests / Please try again later." Note "first admin uses Forgot password if the email was lost" conflicts with OQ.
- `admin-users-mode5.svg` — new "Password" column (Set / Not set), "+ Create user" button + modal (Email, then role/team selectors — now confirmed by OQ; Cancel / "Create & send"); success notice "Set-password link sent to …"; failed send → amber "Link not sent — use Resend link"; 429 → "Too many requests, try again in Ns". Conflict: users with a password get a "Send reset link" action, but FR6 says resend only for password-less users and the existing reset-link endpoint is 404 in this mode. Legend still says "see Open Questions".
- `set-password-mode5.svg` — reuses `ResetPasswordPage`; title "Set your password" for a password-less account (page would need account state; no endpoint today). Expired-link text "Request a new one with Forgot password?" and email body "If it expired, use Forgot password?" conflict with OQ for password-less accounts. Lifetime note "24 h for no-password accounts" conflicts with FR9 (lifetime by issuing path). Email variants: bootstrap ("You are the administrator…"), created-user/resend, existing forgot. All link `PUBLIC_BASE_URL/#/reset-password?token=…`.

## Knowledgebase
- `docs/knowledgebase/authorization-and-authentificaiton.md` — main article: mode table ("four modes"), startup validation, SMTP per mode, `AuthModeGuard` → 404, `AuthRateLimitService` pattern (in-memory, rejecter, `consumeIp` throws 429), login backoff (off under `NODE_ENV=test`), links only from `PUBLIC_BASE_URL` via `getEmailLinkBaseUrl`, masked emails in logs, no tokens in logs, null `password_hash`, "Cross-mode account identity" rule (forgot not gated on hash).
- `docs/knowledgebase/user-account-flows.md` — reset tokens (1 h, single use, 60 s cooldown retiring earlier tokens; consume 400/410/409), admin-generated reset link (built from request origin), force-invite auto-provision.
- `docs/knowledgebase/algorithms/auth-startup-config.md` + `docs/algorithm-examples/auth-startup-config.json` — table test `server/src/auth/config/auth-startup-validation.algo.spec.ts`; 107 rows AS-01..AS-107 → new rows start AS-108. Rules 1/2 need a `strict-managed` branch; `PUBLIC_BASE_URL` rule text ("password and password-confirm only") changes; a row at json ~L240 pins that note. Skipped under `NODE_ENV=test`.
- `docs/knowledgebase/server-endpoint-map.md` — guards legend (L42: mode guard "checked before any credential guard"), error body + `Retry-After` conventions (L124–135), Auth flows summary (L179). Update with new routes.
- `docs/knowledgebase/twins-and-cross-cutting-rules.md` — new env var needs commented line in `release-template/.env.example` (none added here, but mode-list comments change); response types are twins in `server/*.types` and `client/src/models/*.ts`.
- `docs/knowledgebase/test/scenarios.md` — modes table (A `none`/test, B `password-confirm`/production + Mailpit, C `password`/test); `users` fixture (per-mode creation; first user of a schema is admin); `helpers/mailpit.ts`; `helpers/loopback-client.ts` (separate 127.x source address); `@backoff` tag.
- `docs/knowledgebase/test/contract-tests.md` — contract suite runs in `password-confirm`; router meta-test requires a registry row per route.
- `docs/knowledgebase/db-schema-code.md`, `db_state.sql` — hand-written migrations + `COMMENT ON` + `npm run db:state`. `users.password_hash` comment (L1408): imported placeholder users hold a sentinel hash. `password_reset_tokens` (L725): no TTL/kind column; `expires_at` per row.
- `docs/knowledgebase/deployment-auth-mode.md` — compose `environment:` overrides `.env`; says "four `AUTH_MODE` values" (L124).
- `docs/knowledgebase/user-docs-and-site.md` — rules for `user-docs/`, `nav.json`, `npm run build:help`.

## Existing patterns
Server
- `server/src/auth/config/auth-startup-validation.ts:14` `VALID_AUTH_MODES`; `validateMode3` (L151) — admin-email, domain-list, SMTP-block order to copy; `validatePublicBaseUrl` (L46) only requires in production — FR2 wants always.
- `server/src/app.module.ts:63` — validator runs only when `NODE_ENV !== 'test'`.
- `server/src/mail/mail.service.ts:11` `SMTP_AUTH_MODES` (add mode); L76 fail-fast hard-coded to `password-confirm` — include new mode; L114 `sendPasswordResetEmail` hard-codes "valid for 1 hour" — set-password + bootstrap templates needed. Adding mode to `SMTP_AUTH_MODES` also enables budget + password-changed emails.
- `server/src/auth/auth.controller.ts:60` `config()` returns `adminContactEmail` / `passwordResetAvailable` for password / password-confirm; `@AllowedAuthModes` at L104 signup (leave), L144 login, L216 forgot, L230 reset, L247 change-password; `clientIp()` L45; forgot flow L214: `consumeIp` → `consumeEmail` → silent success.
- `server/src/auth/auth.service.ts` — `forgotPassword` (~L176: `isConfigured` gate, enumeration-safe, `issueWithCooldown`, 429 on cooldown, `buildResetUrl`); `adminGenerateResetLink` (~L214, `create()`, does not retire earlier tokens); `resetPassword` (~L229, consumes token before password check; no other-session sign-out); `assertEmailDomainAllowed` (L366, Mode 3 only, message "Sign-up is limited…"); `signup` first user admin (L63); `validateUser` early return on null hash (L96).
- `server/src/auth/password-reset-tokens.service.ts:8` `TOKEN_TTL_MS` const 1 h; `issueWithCooldown(userId)` (L40) locks user row, 60 s cooldown, retires earlier tokens, inserts; `consume` (L104) retires every other token on success, expired iff `expires_at < now`. Both need a TTL param: 24 h = 86 400 000 ms, 1 h = 3 600 000 ms, 23 h = 82 800 000 ms.
- `server/src/auth/auth-rate-limit.service.ts` — `RateLimiterMemory` pattern, keys `<route>:i:<ip>`, `consumeIp` throws `TooManyRequestsException`. New email limiter: `points: 20, duration: 3600`, IP only, separate instance/service.
- `server/src/auth/exceptions/too-many-requests.exception.ts` → 429 + `Retry-After` via `http-exception.filter.ts`.
- `server/src/auth/guards/auth-mode.guard.ts:17` `AllowedAuthModes`. Admin controllers have class-level `@UseGuards(SessionAuthGuard, AdminGuard)` (`admin-panel.controller.ts:38`, `admin.controller.ts:24`) — class guards run before method guards, so a method-level `AuthModeGuard` there yields 401/403 before 404 in other modes.
- `server/src/auth/local.strategy.ts:63` `email_not_confirmed` check Mode 3 only; brute-force via `LoginBackoffService`.
- `server/src/admin/admin-panel.controller.ts:192` `GET admin/users`; rename (L230) lowercase-then-409 pattern; pending-registration resend (L180) → `admin.service.ts` `resendPendingRegistration` (~L188): 404/409 → `issueWithCooldown` → 429 → `{ email_delivery }` — exact template for password-link endpoint.
- `server/src/admin/admin.service.ts` `UserRow` (~L83), `getUsers()` (~L481) — add `passwordSet`.
- `server/src/admin/admin.controller.ts:53` `POST api/v1/users/:userId/reset-password-link` — needs `AuthModeGuard` with every mode except `strict-managed`.
- `server/src/users/users.service.ts:21` `create(email, hash|null, role)` lowercases; `findOrCreateAutoProvisioned` (L40) unique-violation (`23505`) handling; `findByEmail` lowercases; `updateRole`, `countAdmins` exist.
- `server/src/teams/teams.service.ts:675` `sendInvitation` force branch auto-provisions password-less account (even non-admin team owner); membership inserts L740–751 (`canInvite: false`, disclosure NULL) reusable for team picker.
- `server/src/logs/logs.service.ts:104` `PLACEHOLDER_IMPORT_USER_PASSWORD_HASH = '!placeholder-import-user'` — "password set" = hash not null and not placeholder (same test as `teams.service.ts:524`).
- `server/src/database/database-init.ts:116–189` advisory lock `MIGRATION_LOCK_KEY`, steps 3b–4 inside (`resolveSessionSecret` nearest precedent). Runs before Nest (no `MailService`/`ConfigService`). Called by `server/src/database/migrate.ts` (CLI), `main.ts:56` (every cluster worker), `server/test/contract/setup/global-setup.ts:141`.
- `server/src/api-keys/api-keys.controller.ts:36` — only key-issuing path, `SessionAuthGuard` only; FR11 holds as long as password-less users have no session.
- `server/src/common/public-base-url.ts` (`getEmailLinkBaseUrl`), `server/src/common/mask-email.ts`.

Client
- `client/src/models/auth.ts:22` `AuthMode` union.
- `client/src/viewer/pages/login/LoginPage.tsx` L311–316 per-mode render; L121 `PasswordLoginForm` takes only `forgotPassword`; signup link hard-coded L260–268 → needs prop.
- `client/src/viewer/pages/login/forgot-password-link.ts`.
- `client/src/viewer/pages/signup/SignupPage.tsx` — route always mounted (`client/src/main.tsx:262`, `client/src/app-routes.ts:10`).
- `client/src/viewer/pages/reset-password/ResetPasswordPage.tsx` — title "Reset password"; error fallback "Reset link is invalid or has expired.".
- `client/src/viewer/pages/forgot-password/ForgotPasswordPage.tsx`.
- `client/src/viewer/components/top-nav/UserMenu.tsx:38` `canChangePassword`.
- `client/src/viewer/pages/admin/tabs/AdminAuthTab.tsx:9–20,124` `MODE_LABELS` / `MODE_FIELD_NAMES` records keyed by mode.
- `client/src/viewer/pages/admin/tabs/AdminUsersTab.tsx` (302 lines — component-size check) columns L156; "Reset Password" action ~L208 → `ResetPasswordLinkModal`; `RenameUserEmailModal.tsx` Dialog pattern.
- `client/src/viewer/pages/admin/tabs/PendingRegistrationsTable.tsx:42–88` resend button, 60 s countdown, 429 `retryAfterSeconds`.
- `client/src/viewer/api.ts` `ApiError.retryAfterSeconds` (L141), `fetchAdminUsers` (L2455), reset-link call (L2700), `resendPendingRegistration` (L2724).
- `client/src/models/admin.ts:37` `AdminUser`.

Tests
- Algorithm: extend `docs/algorithm-examples/auth-startup-config.json` (AS-108+) + doc.
- Contract: `server/test/contract/registry/f03-auth-modes.ts` ("routes that exist only in another mode, 404 in password-confirm") — add both new routes (admin actors if guard order stays); `f06-admin-users.ts` — `F06-list` `strict: true` → add `passwordSet` to SQL + fields; reset-link rows (L241, L264); `f07-admin-registrations.ts` resend pattern; `server/test/contract/setup/global-setup.ts:114` `AUTH_MODE=password-confirm`.
- Scenarios `tests/scenarios/auth/`: `s-auth-07.spec.ts` (mode-matrix `EXISTS` map L42, secret-leak checks — natural home for new mode 404 matrix); `s-auth-04.spec.ts` (forgot/reset via Mailpit; `seedResetToken` writes `expires_at` directly — 23 h/24 h/1 h boundaries); `s-adm-02.spec.ts` (admin users, reset-link step 4 + step 10 guards); `s-auth-01.spec.ts` (Mailpit signup); `s-auth-06.spec.ts` (`@backoff`); `s-key-01.spec.ts` (API keys).
- Stand: `tests/scenarios/modes.ts` (`StandMode = 'a'|'b'|'c'`, `MODES`, `standEnv`; mode B SMTP / `ADMIN_CONTACT_EMAIL` / `NODE_ENV=production`), `tests/scenarios/fixtures/index.ts:120–229` (per-mode user creation, first-user-is-admin `UPDATE`), `scripts/scenarios/run.mjs:49,100`, `scripts/scenarios/stand.mjs:52,190,219`, `scripts/scenarios/preflight.mjs:103`, `scripts/__tests__/scenarios-stand.test.js:48–80` (pins a/b/c rows), `.claude/repo_config/repo-health-checks.json:41–61` (`scenarios-a/b/c`), `playwright.scenarios.config.ts:45` (projects).

Docs to update
- `user-docs/authentication-modes.md` ("four modes" table, "first user becomes admin"), `security-hardening.md` (§3.3, §3.4, §11 rate limits), `server-configuration.md`, `install-server.md` ("Check that you are the admin"), `small-team-setup.md`, `responsibility-matrix.md`, `component-reference.md`.
- Release kit: `release-template/.env.example` (L31–58), `release-template/docker-compose.yml:46` (mode list comment; links only to GitHub — existing offline-first issue), `release-template/INSTALL.md`, `release-template/LOCAL-BUNDLE.md`, `server/.env.example`.
- Hook / installer: no auth-mode references → older hooks unaffected.

## Open gaps
1. Bootstrap mechanics: `initializeDatabase` runs pre-DI and is shared with `migrate.ts` and contract global-setup — how to send mail inside the lock (standalone nodemailer vs. return "created + token" and send after Nest boots); whether CLI migrate / contract suite skip it; how "refuse to start on failed send" fits "only the inserting process sends" (conflict 3).
2. Bootstrap edge cases: `ADMIN_CONTACT_EMAIL` belongs to an existing password-less account (auto-provisioned Mode 1/4 user) → can't get in without another admin; does `ALLOWED_EMAIL_DOMAINS` apply to bootstrap email; case-insensitive compare.
3. Guard ordering for new admin routes: need own controller or method guards ordered `AuthModeGuard → SessionAuthGuard → AdminGuard` to get 404 for every caller in other modes; same for refusing legacy reset-link in this mode.
4. Token TTL storage: pass TTL into `create`/`issueWithCooldown` (no migration, `expires_at` per row) or add a kind column; cooldown on first link after create (new user has no tokens → fine); resend within 60 s of create → 429 (per FR6 yes).
5. "Password set" definition: null hash vs import placeholder sentinel; do placeholder import users show "Not set" + resend.
6. Team in create-user: which picker (all teams), member flags, `disclosure_acknowledged_at` NULL as in force-invite; non-admin team owner force-invite (`teams.service.ts:675`) creates accounts no admin created in this mode.
7. Forgot-password for password-less accounts: defined enumeration-safe server behaviour; rewrite wireframe texts ("use Forgot password?").
8. Set-password page title: "Set your password" vs "Reset password" — token-info lookup (new public route + contract row) or one neutral title.
9. Order of new email limiter vs `AuthRateLimitService` (does a forgot request rejected by `AuthRateLimitService` count toward the 20); AC10 from one IP relies on stand `AUTH_RATE_LIMIT_POINTS=1000`.
10. Sessions surviving a mode switch: an `auth_sessions` row from Mode 1/4 for a password-less user still passes `SessionAuthGuard` → can create API keys after switch; does FR11 need a check in `ApiKeysController.create`.
11. Scenario infrastructure: no stand mode for `strict-managed` — new mode D in `modes.ts`, `run.mjs`, `stand.mjs`, preflight (Mailpit), `scenarios-stand.test.js`, `repo-health-checks.json` (`scenarios-d`), CLAUDE.md table, scenarios KB; `users` fixture support (bootstrap admin via Mailpit → admin create-user → Mailpit link → reset → login); fixed 20 emails/IP/h (no env override) → mode-D scenarios must create few users or route admin calls through `loopback-client` addresses; AC4 "second start sends no email" needs stand restart on same schema (`stand.mjs` lacks it); fail-fast (unreachable relay, failed bootstrap send) not covered by algorithm rows and no scenario precedent; per-run bootstrap email so Mailpit "exactly one email" check isn't polluted by mode B's `admin@arrakis.test`.
12. `PUBLIC_BASE_URL` outside production: FR2 says required; current rule allows unset outside production with `localhost:5173` fallback.
13. Domain rejection message currently "Sign-up is limited…" — wrong wording for admin create.
14. Admin Auth tab labels/field lists for the new mode; whether "Mode 5" appears in UI strings.
