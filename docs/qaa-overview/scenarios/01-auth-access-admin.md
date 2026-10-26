# Scenarios: AUTH and ACCESS (authentication, keys, teams, admin panel)

Date: 2026-10-13, branch `dev`. Design only; no tests were run or written. Sources: `docs/knowledgebase/*` (authorization-and-authentificaiton, server-endpoint-map, client-routing-and-layout, password-requirements), the catalogue of meaningful tests (F-AUTH, F-API-KEYS, F-TEAMS, F-ADMIN, F-RELEASE) and the cleanup inventory (F.1, F.2, G) from the deleted test audit (current state: [KB test](../../knowledgebase/test/index.md)), the screen sources `client/src/viewer/pages/*` and the existing tests (`tests/e2e`, `server/test`, `server/src`, `client/src/viewer/__tests__/components`).

## 0. Group scope

The group covers: sign-up, login, logout, the session, the auth modes (`none` / `password` / `password-confirm` / `azure-oauth`), e-mail confirmation, password reset and change, account deletion, the password policy, the brute-force delay, API keys, teams (creation, members, invitations, access modes `restricted` / `transparent`, disclosure, roles), privacy of other people's sessions and raw logs, the admin panel (9 tabs: System Info, Repos, Teams, Users, Error Logs, Upload Queue, Data Retention, Auth, Model Pricing), the logs archive, the data-collection consent screen, and "notifications".

What I found about "notifications": there is no separate feature. The bell in the top bar (`NotificationBell`) shows only incoming team invitations (`GET /api/v1/invitations`). The server has no `/api/v1/notifications` route (the mention in a comment in `api-keys.spec.ts` is stale). The bell is covered by scenario S-TEAM-01. The Model Pricing tab belongs to the cost group; here only its presence is checked.

### Run modes (what the stand must provide)

Today Playwright runs against the dev server in `none` mode (see `tests/e2e/helpers/auth-mode.ts`), and the server API tests run in `password-confirm` with `NODE_ENV=test` (where backoff and the config validator are off). The scenarios need three "runs":

| Run | Server | What is enabled | Which scenarios |
|---|---|---|---|
| **A** (main, dev) | `AUTH_MODE=none` | sessions via `POST /api/v1/auth/identify` from localhost | every scenario marked "any mode" (teams, admin, keys, access, consent), plus S-AUTH-07, S-AUTH-08 |
| **B** | `AUTH_MODE=password-confirm`, `PASSWORD_POLICY=long`, Mailpit on `:8025`, `NODE_ENV` not `test` | real e-mails, real policy, real backoff | S-AUTH-01, 03, 04, 05, 06, 07, 09 (part), S-ADM-03 |
| **C** (optional) | `AUTH_MODE=azure-oauth` | needs a real Azure | no scenario, see the "Not covered" section |

All "any mode" scenarios create users through the shared helper `establishSession` (identify in `none`, signup+confirm through the DB in `password*`), so the same test code works in A and B. Users and repositories are unique per run (prefix `e2e-<runId>`), cleaned up in `afterAll`.

Shared personas: ADMIN (the first registered user, role `admin`), OWNER, M1, M2, M3 (regular users). Data is uploaded with an API key: `POST /api/v1/logs` with the `X-API-Key` header (sessions with known `firstPrompt` values).

## 1. Scenario list

| ID | Title | Layer | Priority | Replaces (≈ old tests) |
|---|---|---|---|---|
| S-AUTH-01 | A new person signs up, confirms the e-mail from the message and logs in | UI+API | P0 | 37 |
| S-AUTH-02 | First login: the data-collection consent screen cannot be bypassed | UI+API | P0 | 13 |
| S-AUTH-03 | Login, logout, live and dead session, form errors, password policy | UI+API | P0 | 38 |
| S-AUTH-04 | Forgot password: e-mail, new password, repeated and expired links | UI+API | P0 | 16 |
| S-AUTH-05 | Changing the password in one browser logs out the other | UI+API | P0 | 17 |
| S-AUTH-06 | Password guessing hits a growing delay | API | P0 | 14 |
| S-AUTH-07 | Mode matrix: what exists in this mode and what answers 404 | API | P0 | 12 |
| S-AUTH-08 | Passwordless mode: local login, auto-provisioning, the first user becomes admin | UI+API | P1 | 12 |
| S-AUTH-09 | A person deletes their account: all of theirs goes, other people's data stays | UI+API | P0 | 20 |
| S-KEY-01 | API key life: create, see once, upload logs, revoke, expired | UI+API | P0 | 28 |
| S-KEY-02 | Newcomer without keys: install, "Give Me String", left menu | UI | P1 | 27 |
| S-TEAM-01 | The owner creates a team and invites a colleague, the colleague accepts through the bell | UI+API | P0 | 50 |
| S-TEAM-02 | `restricted` team: who sees what (member, owner, trainer, manager) | UI+API | P0 | 70 |
| S-TEAM-03 | `transparent` team: everyone sees everyone, raw logs stay closed, the switch lock | UI+API | P0 | 45 |
| S-TEAM-04 | Inviting an unregistered e-mail and the disclosure gate at first login | UI+API | P0 | 17 |
| S-TEAM-05 | Roles, delegated invitation, leaving, ownership transfer, team deletion | UI+API | P1 | 15 |
| S-TEAM-06 | Team repositories: add, duplicate, remove, a shared URL is not lost | UI+API | P1 | 11 |
| S-TEAM-07 | The app admin and someone else's team: what they can and cannot do | UI+API | P1 | 8 |
| S-ACC-01 | Someone else's personal repository is closed, and route guards do not depend on the credential type | API | P0 | 12 |
| S-ADM-01 | The admin panel is visible only to the admin, tabs and deep links work | UI+API | P0 | 26 |
| S-ADM-02 | The admin manages users: role, reset link, e-mail change, deletion | UI+API | P0 | 32 |
| S-ADM-03 | Unconfirmed registrations and the Auth tab (password-confirm mode) | UI+API | P1 | 9 |
| S-ADM-04 | Repos and Teams tabs: numbers, filter, sorting, repository deletion | UI+API | P1 | 11 |
| S-ADM-05 | System Info, logs archive and error log | UI+API | P1 | 45 |
| S-ADM-06 | Data Retention: the retention period matches the consent text, a chart with an empty day | UI+API | P1 | 6 |
| S-ADM-07 | Upload queue: broken file, Reprocess, Clear, counters | UI+API | P1 | 62 |

Total 26 scenarios: P0 = 16, P1 = 10, P2 = 0 (S-ADM-08, releases, was dropped: the release download feature was removed by 2026-10-20-github-release-pipeline). They replace ≈ 650-700 existing tests (counted by whole files; some unit tests are only partly replaced, which the "Replaces" lines note; `team-access-mode` and `repository-view` may be double-counted).

Convention for the text below: a "UI step" is what a person clicks by hand; an "API step" is the Playwright `request` fixture with the right user's cookie (or `X-API-Key`).

---

## 2. AUTH

### S-AUTH-01. A new person signs up, confirms the e-mail from the message and logs in
- **Layer:** UI+API (run B, needs Mailpit)
- **Priority:** P0
- **Data/roles:** an empty DB is not needed. New e-mail `e2e-<runId>-new@example.com`, a password that passes the `long` policy (for example `Str0ng!Passw0rd#1`, 16 characters). ADMIN exists. Mailpit is cleared of messages for this address.
- **Steps:**
  1. UI: open `/#/signup`, enter the e-mail, the password and "Confirm password" (with a typo in the confirmation), press "Sign up".
  2. UI: fix the confirmation, press "Sign up".
  3. UI: the page shows "Check your email to confirm your account.".
  4. API: `POST /auth/login` with this e-mail and the correct password.
  5. API: `POST /auth/resend-confirmation { email }` twice in a row.
  6. Mailpit API: find the latest message `to:<email>`, extract the link `/#/confirm-email?token=...`, check that the link host equals the stand origin (not a hard-coded `localhost:5173`) and that the link contains `#/`.
  7. UI: open the link, wait for "Confirming your email…", then success.
  8. UI: open the same link a second time.
  9. UI: open `/#/confirm-email?token=garbage` and `/#/confirm-email` (no token).
  10. UI: `/#/login`, log in with this e-mail and password.
  11. API: `POST /auth/signup` with the same e-mail in a different case (`E2E-...-NEW@Example.com`).
- **Checks:**
  - Step 1: the error "Passwords do not match.", no request reached the server (the user count in the DB did not grow).
  - Step 4: HTTP 403 with the body `{ error: 'email_not_confirmed' }` (the account is unusable until confirmed).
  - Step 5: the first resend is 200 `{ email_delivery: 'sent' }`, the second is 429 with a `Retry-After` header in the range 1-60; Mailpit holds exactly 2 messages (sign-up and the first resend); after the resend the link from the first message no longer works (the token is invalidated), the link from the second one works. A resend for a non-existent e-mail also answers 200 `sent` without a message (no account-existence leak).
  - Step 7: the confirmation page shows success, `email_confirmed_at` in the DB is not `NULL`.
  - Step 8: the message "This email address has already been confirmed." (API 409).
  - Step 9: a garbage token gives a clear error (API 400), so does a missing token, and the page layout does not break.
  - Step 10: after login the URL leaves `/login`, and the top bar shows the user's e-mail.
  - Step 11: 409 (case-insensitive duplicate).
  - In addition (API, by shifting `expires_at` in the DB): an expired confirmation token gives 410 and the text "This confirmation link has expired. Please request a new one.".
  - **Decided by the owner (2026-10-13):** in mode 3 (`password-confirm`) the user must not get a login until they confirm the e-mail: after sign-up they only see the "Check your email" page. Step 4 must check this explicitly: right after `POST /auth/signup`, in a clean context `GET /auth/me` gives 401, no session cookie is issued, and reloading the app and going to `/#/main` lead back to the login page or to "check your e-mail". **This step is red today: a server defect was found** (see below). In mode 2 (`password`) it is the opposite: a session is issued after signup, by design (closed networks).
- **Replaces:** `tests/e2e/email-confirmation-mailpit.spec.ts` (1); `server/test/auth-email-confirmation.e2e-spec.ts` (12: an unconfirmed user cannot log in, 400/410/409, a race of two confirms, resend invalidates, cooldown, no existence leak); `client/.../components/confirm-email-page.test.tsx` (5); `signup-page.test.tsx` (7, except "the client does not enforce minLength"); from `server/test/auth.e2e-spec.ts` the signup block (success, case-insensitive duplicate, mismatch, too long, empty fields, already-auth) ≈ 8; the `auth-email` part of `admin-auth` is not here (see S-ADM-03).
- **What we lose:** the race of two simultaneous confirms (exactly one 200) and a repeat within 60 s at the level of concurrent requests: a person cannot reproduce this, it is double-click protection; if the owner wants, keep one unit/API test for the atomicity of `consume`. Details such as "a 129-character password is too long" moved to S-AUTH-03.

### S-AUTH-02. First login: the data-collection consent screen cannot be bypassed
- **Layer:** UI+API (any mode)
- **Priority:** P0
- **Data/roles:** a new user N without a `user_settings.dataCollectionNotice` record (unlike the five roles from `global.setup.ts`, where it is set). The configured retention period `SESSION_RETENTION_DAYS` is known to the stand (read through `GET /admin/retention` as ADMIN).
- **Steps:**
  1. UI: log in as N (the `establishSession` helper, without the consent record), open `/#/main`.
  2. UI: go through `/#/api-keys`, `/#/teams`, `/#/admin`, `/#/repos/1`.
  3. UI: read the notice text.
  4. API: while consent is not accepted, N uploads logs with their key (`POST /api/v1/logs`) and reads `GET /api/v1/user-settings`.
  5. UI: press "I understand and accept".
  6. UI: reload the page (`page.reload()`), then open a new tab.
  7. API: replace the stored setting value with "someone else's hash" (`PUT /user-settings/dataCollectionNotice` with garbage) and refresh the page.
  8. API: ADMIN reads `GET /admin/retention` and compares `retentionDays` with the number from the text.
- **Checks:**
  - Steps 1-2: every route shows `data-testid=data-collection-consent-screen`, the "I understand and accept" button, and **no** Install tab, Help button or left menu (the screen replaces the shell rather than overlaying it).
  - Step 3: there is an "If the assistant handles secrets" paragraph and the text "Stored session data is purged after N days" with an integer N equal to `retentionDays` from step 8; the string `{{RETENTION_DAYS}}` is not on screen. There is no "Decline" button, and Escape does not close the screen.
  - Step 4: the API key and log ingest itself work regardless of consent (consent is only a UI gate; we record the fact so nobody mistakes it for API protection). `user-settings` answers 200.
  - Steps 5-6: after Accept the screen disappears, the shell appears, and a user without repositories or teams is redirected to `/#/api-keys` (exactly once per browser session); after a reload and in a new tab the screen does not return.
  - Step 7: a broken value brings the gate back (the screen is visible again), i.e. the gate decides by the hash of the text, not by "some value exists".
- **Replaces:** `tests/e2e/data-collection-consent.spec.ts` (3); `client/.../components/data-collection-consent-screen.test.tsx` (10, of which the meaning of "a text change brings the gate back" and "Escape does not close" are kept as steps 7 and 3).
- **What we lose:** the unit for "the gate holds while a new user's settings load" (a first-render race, reproducible in a browser only by artificially slowing the network) and for the hash changing when `data-collection-notice.md` is edited (step 7 checks only "someone else's hash", not the file itself). Acceptable.

### S-AUTH-03. Login, logout, live and dead session, form errors, password policy
- **Layer:** UI+API (run B; the 401/403 steps work in any mode)
- **Priority:** P0
- **Data/roles:** a confirmed user P (`password-confirm` through the DB helper), a second one P2. Policy `long` (14+ characters, a digit, a symbol, an upper-case and a lower-case letter).
- **Steps:**
  1. UI: `/#/login`, enter a wrong password, "Log in".
  2. UI: enter a non-existent e-mail.
  3. UI: log in correctly. Then `GET /auth/me`.
  4. UI: open the menu under the e-mail in the top right corner: check the items, press "Log out".
  5. API: `GET /auth/me` and `POST /auth/logout` without a cookie.
  6. UI: after logout press the browser "Back" and open `/#/teams`.
  7. UI: open `/#/admin` as the regular P (not an admin).
  8. API: a repeated `POST /auth/login` from an already logged-in context, and a repeated `POST /auth/signup`.
  9. API: `POST /auth/signup` with the passwords: `short1234` (weak), 129 characters, empty, without an e-mail; `POST /auth/signup` with `password != passwordConfirm`.
  10. UI: log in as P in two tabs; in the second tab `POST /auth/logout` through the UI; in the first click "Teams".
  11. UI: as P open the page of a repository without access (`/#/repos/<someone else's id>`), make sure the logged-in user stays logged in (403 does not log out).
- **Checks:**
  - Steps 1-2: the banner reads exactly "Invalid email or password." in both cases ("no such user" cannot be told apart from "wrong password"), statuses 401.
  - Step 3: the URL left `/login`, `GET /auth/me` = 200, the response contains `email`, `role: 'user'`, `env_name` (a string), and **does not contain** `passwordHash`/`password_hash`.
  - Step 4: menu items: "Change password", "Delete account", "Log out" (in `azure-oauth` mode there is no "Change password"; in `none` the menu is different, see S-AUTH-08). After "Log out" the URL is `/#/login`.
  - Step 5: `me` 401, `logout` 401.
  - Step 6: every protected route leads back to `/#/login` (`AuthGuard`), the `connect.sid` cookie is invalid.
  - Step 7: redirect to `/#/main`, no Admin Panel link in the left menu.
  - Step 8: both 400 (already authenticated).
  - Step 9: weak password 400 `{ error: 'weak_password' }`; 129 characters 400; mismatch 400 `{ error: 'password_mismatch' }`; empty fields 400. Separately for the `mid` policy: `short1234` is rejected, 10 characters with a digit are accepted; for `long`: 15 characters without a symbol are rejected, `Str0ng!Passw0rd#1` is accepted (chosen by the stand's `PASSWORD_POLICY`; the other levels are not checked, see "What we lose").
  - Step 10: after logout in the second tab, the first one ends up on `/#/login` at the next action (a 401 from the API leads to login) instead of showing an empty page.
  - Step 11: stays on the page with a no-access message, `GET /auth/me` is still 200 (403 does not throw the user to login; the only non-mocked variant of this check).
- **Replaces:** `server/test/auth.e2e-spec.ts` (25: signup/login/logout/me/ping, `Full session flow`, `password_hash IS NULL` moved to S-AUTH-08) ≈ 17; `tests/e2e/auth-guard.spec.ts` (2, with mocked responses) is replaced by the live steps 10-11; `client/.../components/login-page.test.tsx` (11); `MainNav.test.tsx` (10, menu items per mode; the build label is not here); `server/src/auth/utils/password-policy.spec.ts` (12) partly: the scenario checks the boundaries of the active level only.
- **What we lose:** the boundaries of all three policy levels at once (`any` / `mid` / `long` at 14/10/2 characters): the scenario sees only the stand's level. Either keep `password-policy.spec.ts` as it is (a pure function, 12 units, cheap and not distrusted), or run the scenario three times. I suggest keeping the unit: see "Not covered". We also lose the login-form look per mode (email-only / email+password / Microsoft button): partly in S-AUTH-07/08.

### S-AUTH-04. Forgot password: e-mail, new password, repeated and expired links
- **Layer:** UI+API (run B, Mailpit)
- **Priority:** P0
- **Data/roles:** a confirmed user R with the password `Old!Passw0rd#1234`; a user R2 for checking unknown addresses.
- **Steps:**
  1. UI: `/#/login`, "Forgot password?", enter R's e-mail, submit.
  2. UI: submit again right away.
  3. API: request a reset for `nobody-<runId>@example.com`.
  4. Mailpit: find R's message, extract `/#/reset-password?token=<T1>`.
  5. UI: open the link, enter the new password `New!Passw0rd#5678` with a wrong confirmation, then a correct one.
  6. UI: log in with the old password, then with the new one.
  7. API: reuse `T1` in `POST /auth/reset-password`.
  8. API: `POST /auth/reset-password` with an unknown token; with a weak password and a valid fresh token; with a mismatched confirmation.
  9. DB helper: issue a token and shift `expires_at` into the past, use it.
  10. API: two simultaneous `reset-password` calls with the same fresh token (`Promise.all`).
- **Checks:**
  - Step 1: the page says "If that email is registered, a reset link has been sent." (the same for registered and unregistered). Mailpit holds exactly one message for R.
  - Step 2: a second request within 60 s gives 429 with `Retry-After`, no second message.
  - Step 3: the same 200 response and the same message, no e-mail (the address is not revealed).
  - Step 4: the link is built from the stand origin and contains `#/reset-password?token=`.
  - Step 5: "Passwords do not match." on a mismatch; success redirects to login.
  - Step 6: the old password gives 401 "Invalid email or password.", the new one 200.
  - Step 7: 409 (token used). Step 8: unknown token 400 (text "Reset link is invalid or has expired."), weak password 400 `weak_password`, mismatch 400 `password_mismatch`; in the last two the token is **not burned**.
  - Step 9: 410 (expired).
  - Step 10: exactly one 200 response and one 409.
  - The admin reset link from S-ADM-02 uses the same mechanism and is checked there.
- **Replaces:** `tests/e2e/password-reset.spec.ts` (1), `password-reset-mailpit.spec.ts` (1), `server/test/password-reset.e2e-spec.ts` (14).
- **What we lose:** nothing significant. The unit detail "the token is stored as a hash", if it existed (not visible in e2e), stays alongside: spot-check it during implementation.

### S-AUTH-05. Changing the password in one browser logs out the other
- **Layer:** UI+API (run B)
- **Priority:** P0
- **Data/roles:** a user C with the password `Old!Passw0rd#1234`. Two independent browser contexts A and B (two cookies).
- **Steps:**
  1. Log in as C in context A and in context B.
  2. UI in A: the e-mail menu, "Change password". Enter the current password wrongly.
  3. UI in A: the current one correct, the new password weak (`short1234`).
  4. UI in A: the new one and the confirmation do not match.
  5. UI in A: correct values, `New!Passw0rd#5678`.
  6. UI in B: click any page (for example "Teams").
  7. API: log in with the old password, then with the new one.
  8. Mailpit: the password-change message.
- **Checks:**
  - Step 2: the message "Current password is incorrect." (HTTP 403, not 401: otherwise the front end would throw the person out of the dialog). User A stays logged in.
  - Step 3: a weak-password error from the server. Step 4: the button is disabled or "Passwords do not match.", no request is sent.
  - Step 5: success; the dialog shows "Sent to <e-mail>" only if the message was really sent.
  - Step 6: B ends up on `/#/login` (all **other** sessions are deleted, while session A is alive: in A the next click works).
  - Step 7: old password 401, new one 200.
  - Step 8: Mailpit has the "password changed" message (in a mode without SMTP `email_delivery` = `'skipped'`, the password change still succeeds: a separate API step with `SMTP_HOST=''`, if the stand allows it).
- **Replaces:** `server/test/auth-change-password.e2e-spec.ts` (7), `client/.../components/change-password-modal.test.tsx` (10).
- **What we lose:** the "account without a local password" variant (`no_local_password` 400): it goes to S-AUTH-08 as one check. The `sent / failed / skipped` distinction case by case (we check only `sent`).

### S-AUTH-06. Password guessing hits a growing delay
- **Layer:** API (run B, `NODE_ENV` not `test`, a fresh server or counters reset by a restart; **run last and in isolation**, the per-IP counter is shared by everyone)
- **Priority:** P0
- **Data/roles:** a confirmed user V (`victim-<runId>@example.com`), a second confirmed user W. Requests come from one IP (127.0.0.1).
- **Steps:**
  1. `POST /auth/login` for V with a wrong password (1st failure).
  2. Wrong again (2nd failure).
  3. Immediately log in as V with the **correct** password.
  4. Immediately log in as V with the e-mail in a different case and with spaces (` V@Example.COM `) and a wrong password.
  5. Wait for `Retry-After`, enter a wrong password (3rd failure), then again right away.
  6. Wait, enter the correct password.
  7. Right after step 6 log in as W (another account, the same IP) with the correct password.
  8. Wait for the per-IP delay to end and repeat the correct login of W.
  9. UI: on `/#/login` enter three wrong passwords in a row.
- **Checks:**
  - Steps 1-2: 401 responses; the 1st failure creates no delay, the 2nd creates a delay of exactly 1 s.
  - Step 3: **429** with the header `Retry-After: 1` (the delay is checked before the password, so the correct password is blocked too), the body contains `retryAfterSeconds`.
  - Step 4: also 429 (case and spaces do not bypass the account counter); a blocked request does not extend its own delay (a second attempt right after the first 429 shows the same or a smaller `Retry-After`, never a larger one).
  - Step 5: after the 3rd failure the delay is 2 s.
  - Step 6: success 200, V's account counter is reset (the next wrong passwords are "free" again right away: the 1st failure is again 401 without 429).
  - Step 7: the per-IP counter is **not** reset by V's success: W's login right after the accumulated failures may get 429 by IP (we check that the per-IP delay lives independently of the account), and after waiting step 8 passes with 200.
  - Step 9: on the login page after a 429 the "Log in" button is disabled for `Retry-After` seconds with a banner and a countdown, then becomes available again.
  - Side effect: after the scenario the IP counter stays for ≤ 15 minutes (`COUNTER_DURATION_SECONDS=900`), so the scenario runs last in run B.
- **Replaces:** `server/src/auth/login-backoff.service.spec.ts` (14: the 1/2/3 schedule, max per account and per IP, case and spaces, success resets the account but not the IP); the part of `login-page.test.tsx` about 429 (≈ 3 tests, the rest are replaced by S-AUTH-03).
- **What we lose:** precision about "TTL 900 s", "process memory", `req.ip` behind a proxy (`TRUST_PROXY`), and multi-process mode. None of this is reproducible in reasonable time. I suggest keeping the unit `login-backoff.service.spec.ts` as it is **or** accepting the scenario as the only protection (owner's decision). It is the only brute-force protection and it is off with `NODE_ENV=test`, so the scenario must run on a server without `NODE_ENV=test`.

### S-AUTH-07. Mode matrix: what exists in this mode and what answers 404
- **Layer:** API (runs in **every** run: A, B, C)
- **Priority:** P0
- **Data/roles:** any user; reading the values of `SMTP_PASSWORD` and `AZURE_CLIENT_SECRET` from the stand environment (if set) for comparison.
- **Steps:**
  1. Without a cookie: `GET /api/v1/auth/config`.
  2. For the mode from step 1: list every mode-specific route and call each one without and with a login: `identify`, `signup`, `login`, `confirm-email`, `resend-confirmation`, `forgot-password`, `reset-password`, `change-password`, `GET azure`, `GET /api/auth/callback`.
  3. ADMIN: `GET /api/v1/admin/auth`.
  4. Compare the response bodies of steps 1 and 3 against substrings of the secret values.
  4a. Mode `password` only (run C, no `SMTP_HOST`): without a cookie, `POST /api/v1/auth/forgot-password` with an existing user's e-mail.
  5. Without a cookie: `GET /health`, `GET /health/version`, `GET /api/v1/model-pricing`, `GET /static/artisyn-hooks-installer.tgz`; with a regular user's cookie: `GET /api/v1/ping`.
- **Checks:**
  - Step 1: a 200 response without a login, contains `mode`; `azure` only in azure-oauth mode (only `authority`, `clientId`, `redirectUri`); `adminContactEmail` only in password*; `passwordResetAvailable` absent in `none`, `true` in run B (`password-confirm` with Mailpit as the relay), `false` in run C (`password` without `SMTP_HOST`); **no field holds a secret value**.
  - Step 2: in `password` and `password-confirm`, `identify` and `GET azure` give **404** (not 403); in `none`, `signup`, `login`, `forgot-password`, `reset-password`, `change-password`, `confirm-email` give 404, while `identify` from localhost gives 200; in `password` (without confirmation) `confirm-email` and `resend-confirmation` give 404; in `azure-oauth` everything local and password-based is 404, while `GET azure` answers 302 to `login.microsoftonline.com` with `state` and `nonce`. Routes without `@AllowedAuthModes` (`logout`, `me`, `config`) are alive in every mode.
  - Step 3: `admin/auth` returns `mode` and only non-secret fields (`smtp.host`, `smtp.port`, `smtp.from` or `azure.tenantId/clientId/redirectUri/authority`), and **no secret value from the environment appears in the body** (compared against the real values, not the key names). `smtp` is present only when a relay is configured: in run B it has exactly `from`, `host`, `port`; in runs A and C it is absent.
  - Step 4a: 200 with `{ email_delivery: 'failed' }` (the same answer for any e-mail, so enumeration-safe), and no `password_reset_tokens` row exists for that user.
  - Step 5: public resources are available without a login; `ping` without a cookie is 401.
- **Replaces:** `server/src/auth/guards/auth-mode.guard.spec.ts` (3), `auth.controller.spec.ts` (5, `GET config` without secrets), `auth.service.spec.ts` (4, partly), the `server/test/admin-auth.e2e-spec.ts` block "returns the config without secrets" (2), and closes the gaps F.1 #2 (identify/azure = 404) and #10 (comparison against the real secrets).
- **What we lose:** the row-by-row "route x mode" matrix written by hand in `auth-mode.guard.spec` (it knows every route and catches a forgotten `@AllowedAuthModes`); the scenario checks it only for the routes in step 2 and only for the run's mode. I suggest keeping a compact unit with the matrix (≈3 tests) as a "cheap guard", or accepting that three runs give the full coverage.

### S-AUTH-08. Passwordless mode: local login, auto-provisioning, the first user becomes admin
- **Layer:** UI+API (run A, `AUTH_MODE=none`)
- **Priority:** P1
- **Data/roles:** a DB with existing users (always the case on dev); a new e-mail `e2e-<runId>-local@example.com`.
- **Steps:**
  1. API: `POST /auth/identify { email: "<new>" }` (a context without a cookie).
  2. API: the same e-mail in a different case (`E2E-...@Example.com`).
  3. API: two simultaneous `identify` calls for **one more** new e-mail (`Promise.all`).
  4. API: a clean context without a cookie: `GET /auth/me`.
  5. UI: open `/#/login` in a clean context.
  6. UI: open the e-mail menu in the bar.
  7. API: `POST /auth/login` and `POST /auth/signup`.
  8. API: an account without a password (`password_hash IS NULL`) calls `POST /auth/change-password`.
  9. API: `POST /auth/identify` with the header `X-Forwarded-For: 8.8.8.8` from localhost.
- **Checks:**
  - Step 1: 200, the new user's profile has `role: 'user'` (only the very first DB user gets the `admin` role, which can no longer be reproduced on dev, so it is checked in a unit or in a separate clean run, see "What we lose").
  - Step 2: the same `id` (case-insensitive lookup), one row in `users`.
  - Step 3: exactly one DB row for the e-mail from step 3 (the race does not create a duplicate).
  - Step 4: **200**, not 401: `AutoIdentifyGuard` logs a local caller in as the only user or as `id=1` (on dev with several users it is the user with `id=1`; we record this explicitly so nobody is surprised that "logging out" is impossible).
  - Step 5: the "Log in" form in this mode asks only for the e-mail (no Password field), without "Forgot password?" and without "Sign up".
  - Step 6: the e-mail menu has no "Change password"; "Edit email" is present, and this is not the password-mode menu from S-AUTH-03.
  - Step 7: both 404 (`AuthModeGuard`).
  - Step 8: 404 (`none` mode does not know `change-password`).
  - Step 9: `X-Forwarded-For` does not affect the decision (locality is determined by the TCP address `req.socket.remoteAddress`); it stays 200, but "a foreign address does not get a login" cannot be checked from localhost; the unit decides that.
- **Replaces:** `server/test/users-auto-provision.e2e-spec.ts` (4: through the service), `auto-identify.guard.spec.ts` (6, partly: the behaviour on localhost); it does NOT replace `localhost.util.spec.ts` and `container-gateway.util.spec.ts` (they stay as units, pure logic for detecting the address and the container gateway, see "Not covered"); `client/.../MainNav.test.tsx` (the `none` menu) 2.
- **What we lose:** most importantly, "a foreign address does not get a login", "a forged XFF from a foreign address", container detection (cgroup v1/v2, podman, k8s). These cannot be reproduced from localhost tests; we keep the units `localhost.util`, `container-gateway.util` (in effect the protection of `none` mode). The first user becoming admin is reproducible only on an empty DB; I suggest one separate API test in a clean run.

### S-AUTH-09. A person deletes their account: all of theirs goes, other people's data stays
- **Layer:** UI+API (runs A and B; in B the session check after deletion)
- **Priority:** P0
- **Data/roles:** ADMIN (the last admin cannot be deleted, so a second admin is needed), user D (to be deleted), user K (a neighbour, stays). D has: a personal repository R1 with 2 sessions; a repository R2 with a URL that K also uploads to (a shared URL, K has their own record); a team T that D owns, with K as a member; a team invitation sent by D, and an invitation of D to someone else's team T2 (owner K); D's API key.
- **Steps:**
  1. UI (D): the e-mail menu, "Delete account", in the dialog type `Delete`, then `delete ` (with a space), then `delet`.
  2. UI: type exactly `delete`, press "Delete".
  3. UI: end up on `/#/login`. API: log in as D.
  4. API: upload logs with D's key.
  5. API (ADMIN): `GET /admin/users`, `GET /admin/repos`, `GET /admin/teams`.
  6. API (K): the R2 session list and the team list; K's invitations.
  7. API (ADMIN, the only admin): `POST /auth/delete-account { confirm: 'delete' }`.
  8. API (ADMIN2 as the caller): `POST /admin/users/<ADMIN id>/delete` for the last admin.
  9. API (before D is deleted, as a separate user D2): `POST /auth/delete-account` with the body `{ confirm: 'Delete' }`.
- **Checks:**
  - Step 1: the "Delete" button is disabled for `Delete`, `delete `, `delet` and enabled only for `delete` (case, substrings and spaces do not pass).
  - Steps 2-3: after success D's login is 401; the cookie no longer works (`GET /auth/me` 401).
  - Step 4: D's key returns 401 (keys deleted).
  - Step 5: D is not in the user list; repository R1 and its sessions are gone; team T is gone; R2 as D's record is gone.
  - Step 6: K's R2 sessions (their own) are in place, team T is gone for K (no owner), the invitations sent by D are gone; K's invitation to T2 stays.
  - Step 7: 400 (the last admin cannot be deleted), the account is intact.
  - Step 8: 400 (the last admin and oneself cannot be deleted through the admin route).
  - Step 9: 400 for an inexact `confirm`; the account is intact.
  - DB data (through the DB helper): no `logs`, `logs_otel`, `repo_config`, `upload_queue`, `user_favorite_sessions` rows for D's id, and no "orphaned" `sessions` without `logs`; the sessions that K's logs reference remain.
- **Replaces:** `server/test/account-deletion.e2e-spec.ts` (11), `client/.../components/delete-account-dialog.test.tsx` (9, exact input, an error keeps the dialog), the `MainNav.test.tsx` "Delete account" item (1).
- **What we lose:** "a server error keeps the dialog open" (needs a faked response, not reproducible on a live server); atomicity and `FOR UPDATE` against a race of two deletions/role changes (unit/race, invisible to a person). The rest is covered.

---

## 3. API KEYS

### S-KEY-01. API key life: create, see once, upload logs, revoke, expired
- **Layer:** UI+API (any mode)
- **Priority:** P0
- **Data/roles:** user U (regular), user V (a stranger). Repository URL `https://git.example.com/e2e/<runId>/keys`. A ready NDJSON with at least one session record (the `seed` helper).
- **Steps:**
  1. UI (U): `/#/api-keys`, the "API Keys" tab. Field "Key name" `upload key`, leave "Expires (optional)" empty, "Generate".
  2. UI: read the "Save this key — it won't be shown again." banner with the key, "Dismiss", refresh the page.
  3. API: `POST /api/v1/logs?sessionId=<s1>` with `X-API-Key: <key>` and valid NDJSON.
  4. UI: create a second key with the same name `upload key`.
  5. UI: create a key `short-lived` with a future expiry, then change the expiry through the pencil icon to a past date.
  6. API: upload logs with the `short-lived` key.
  7. API: PATCH the expiry to `null` (remove the expiry) and upload again.
  8. UI: press the bin ("Revoke") next to `upload key`, confirm.
  9. API: upload logs with the revoked key. A regular session cookie for `POST /api/v1/logs`.
  10. API: send U's valid key to the session endpoints `GET /api/v1/teams` and `GET /api/v1/repositories`.
  11. API (V): `PATCH /api-keys/<U's id>`, `DELETE /api-keys/<U's id>`; a call with a non-existent id.
  12. API: create a key with an empty name and with `expires_at: "2030-01-01"` (a date without a time).
- **Checks:**
  - Steps 1-2: the banner shows the plaintext key in the format `xxxxxx-xxxxxxx...`, the key table has a row with the name and the **prefix** (`slug…`), the key itself is not visible anywhere; after the page refresh the key is neither in the UI nor in `GET /api-keys` (no `key` and `key_hash` fields).
  - Step 3: 201 (success), the session is visible in the repository UI.
  - Step 4: the error "…" from the server (409 duplicate name for the same user), the second key is not created.
  - Steps 5-6: a key with an expired `expires_at` gives 401 on upload.
  - Step 7: after removing the expiry, 201.
  - Steps 8-9: the revoked key gives **401**; logs uploaded before revocation remain; a cookie instead of a key on `POST /api/v1/logs` gives 401. This is exactly what closes gap F.1 #1.
  - Step 10: the key on team/repository endpoints gives **401** (a real valid key, not `'invalid-key'`, closes F.1 #11).
  - Step 11: someone else's key 403, non-existent 404; step 12: 400 for an empty name and 400 for a date without a time.
- **Replaces:** `server/test/api-keys.e2e-spec.ts` (21), the part of `server/test/logs.e2e-spec.ts` about keys (3: no key 401, wrong 401, expired 401), `tests/e2e/api-keys.spec.ts` (4 of 10: the Keys tab and `@core` key creation; the other 6 in S-KEY-02).
- **What we lose:** renaming a key through PATCH `name` (not in the UI, only the expiry) and the "PATCH both fields" combinations; one API call remains in step 7, the rest we consider insignificant.

### S-KEY-02. Newcomer without keys: install, "Give Me String", left menu
- **Layer:** UI (any mode)
- **Priority:** P1
- **Data/roles:** a fresh user N without keys or repositories (with consent accepted).
- **Steps:**
  1. UI: open `/#/main` (or accept consent, S-AUTH-02): a redirect to `/#/api-keys` is expected.
  2. UI: the left menu has no "Installed Hooks" section.
  3. UI: the "Install" tab is active by default; the "Full Auto Install" block sits above the "Run the installer" block; a warning about "terminal history".
  4. UI: press "Give Me String".
  5. UI: read the one-liner and copy it with the Copy icon (the clipboard is replaced by an init script).
  6. UI: the "API Keys" tab: the new key is in the table.
  7. API: upload logs with this key to the URL `https://git.example.com/e2e/<runId>/new`.
  8. UI: refresh the page and open the left menu.
- **Checks:**
  - Step 1: after consent is accepted, a newcomer with zero repositories and teams ends up on `/#/api-keys` once per session.
  - Step 2: there is no "Installed Hooks" section.
  - Step 3: the npx command block shows the stand's **own** origin (`BASE_URL` from the environment, not a hard-coded `localhost:5173`) and `artisyn-hooks-installer.tgz`; the upgrade command contains the same origin.
  - Steps 4-5: the one-liner contains `--server-url <origin>` and `--api-key <the key just created>`; Copy changes the icon to a check mark (confirming the text went to the clipboard).
  - Step 6: exactly one key is created (a repeated click does not create duplicates: see the 409 duplicate names).
  - Steps 7-8: after the first upload the left menu shows "Installed Hooks" with the repository and an OK/"N issue(s)" mark.
- **Replaces:** `tests/e2e/api-keys.spec.ts` (6 of 10: Install by default, the command, Copy, Generate Key NOW, Full Auto, card order, Give Me String, the warning), `client/.../components/InstallTab.test.tsx` (14, snippets and the upgrade command), `AppLeftNav.test.tsx` (1 about "Installed Hooks" without keys; the other 6 navigation tests are not here).
- **What we lose:** the exact text of the `apiKey`/`serverUrl` JSON snippets for every agent variant (what 14 units pin line by line). The origin and flag checks remain, and that is enough: any error in a snippet is caught by a real hook install, not by a unit.

---

## 4. TEAMS

### S-TEAM-01. The owner creates a team and invites a colleague, the colleague accepts through the bell
- **Layer:** UI+API (any mode)
- **Priority:** P0
- **Data/roles:** OWNER, M1 (registered), M2 (registered, will decline). OWNER's repository `https://git.example.com/e2e/<runId>/team1` with 1 session (`firstPrompt` "owner prompt"). M1 has accepted consent.
- **Steps:**
  1. UI (OWNER): left menu "Add Team", name `Alpha-<runId>`, create.
  2. UI: open the team page `/#/teams/<id>`: tabs Members, Repositories, Invitations; OWNER is alone in Members.
  3. API (OWNER): `POST /teams` with the same name.
  4. UI (OWNER): the Repositories tab, add a repository from "My Repos".
  5. UI (OWNER): Members, "Invite member", enter M1's e-mail, "Invite". Repeat for the same e-mail.
  6. UI (OWNER): invite M2.
  7. UI (M1): on any page the bell (aria-label "Notifications") shows the badge "1" (only invitations addressed to M1 count); open it, read "Team invitations".
  8. UI (M1): "Accept" next to `Alpha-<runId>`: the disclosure dialog, untick/tick the check box, confirm.
  9. UI (M2): the bell, "Decline".
  10. UI (OWNER): Members and Invitations; then invite M2 again.
  11. UI (M1): the left menu, expand the team, open the team repository.
- **Checks:**
  - Steps 1-2: the team is in the `/#/teams` list with the label "Owner"; the default access mode is `restricted` (the "Restricted" badge on team routes; `GET /teams/<id>`.`accessMode = 'restricted'`).
  - Step 3: 409 (duplicate name).
  - Step 4: the repository is in the team list, `sessionCount = 1`.
  - Step 5: the invitation is created (status pending on the Invitations tab), the repeat gives the error 409 "duplicate pending invitation".
  - Step 7: M1's bell shows the badge "1" (invitations sent by M1 themselves and other people's do not count), the panel has a row with the team name and the "Restricted" badge. OWNER has no badge (they are the author).
  - Step 8: **Accept** opens the disclosure dialog listing who reads prompts (five restricted items: the owner reads everything; a trainer reads everything; a manager without text; the others see nothing; application administrators get no access through their admin role); the "Accept invitation" button is unavailable without the check box "I have read and understood who can see my prompts in this team"; after confirmation the request goes out with `acknowledgedAccessMode: 'restricted'`, the badge disappears, M1 appears in Members with labels.
  - Step 9: "Decline" does not open the consent dialog, M2 is not a member, the badge disappeared.
  - Step 10: after Decline M2 is not in Members; the invitation can be sent again (re-invite 201).
  - Step 11: the team and the repository are visible to M1; the "owner prompt" session is **not** visible to M1 (restricted, S-TEAM-02).
  - API checks: `PATCH /invitations/<id>` with `accept` without `acknowledgedAccessMode` gives 400 and no membership is created; with a wrong mode 400; someone else's invitation (`Not your invitation`) 403; `GET /invitations` for OWNER returns both sent and received ones.
- **Replaces:** the `server/test/team-invitations.e2e-spec.ts` blocks without force (≈4: AC-15 accept without/with a wrong mode/with the right one), the `access-management.e2e-spec.ts` blocks "Team CRUD / membership / GET invitations" (≈14), `client/.../components/NotificationBell.test.tsx` (15), `team-disclosure-modal.test.tsx` (18), `TeamInvitationsTab.test.tsx` (2 of them, inviting an unregistered e-mail, in S-TEAM-04).
- **What we lose:** specific text branches of the disclosure dialog (the transparent variant and "with a trainer / without a trainer" are checked in S-TEAM-03/05); "reopening resets the check box" and "it cannot be closed at the login gate" (a unit on UI state; the second is partly in S-TEAM-04). Acceptable.

### S-TEAM-02. `restricted` team: who sees what (member, owner, trainer, manager)
- **Layer:** UI+API (any mode)
- **Priority:** P0
- **Data/roles:** team `Restricted-<runId>` (the default mode). Roles: OWNER; M1 (regular member); M2 (regular member); TR (ADLC trainer); MG (manager); TM (trainer + manager); X (not a team member, but knows the `teamId`). Everyone has accepted the disclosure (accept through the API). Each of M1, M2, TR, MG, OWNER has uploaded one session with the prompts `prompt-owner`, `prompt-m1`, `prompt-m2`, `prompt-tr`, `prompt-mg` to the shared URL of the repository linked to the team. Once (step 9) the trainer role is granted **after** the upload.
- **Steps:**
  1. API (M1): `GET /repositories/:id/sessions?teamId=<T>`.
  2. UI (M1): open `/#/teams/<T>/repos/<R>`.
  3. API (M1): raw logs and contexts of someone else's session (`/sessions/<m2>/logs`, `/contexts`, `/change-surface`, `/change-surface/files`); their own session; analytics and reports (`analytics/timeline`, `analytics/active-sessions`, `reports/active-sessions`, `reports/executive-summary`).
  4. UI+API (OWNER): the same pages and requests.
  5. UI+API (MG): the list, analytics, raw logs of someone else's session.
  6. UI+API (TR): the list, raw logs, analytics, reports.
  7. API (TM): everything from steps 3, 5, 6.
  8. API (X): `GET .../sessions?teamId=<T>` and analytics.
  9. API (OWNER): grant M1 the trainer role **after** the upload (PATCH member `isAdlcTrainer: true`), M1 reads M2's logs.
  10. API (OWNER): the personal view without `teamId`.
  11. UI (OWNER): the team page, Members: the badge tooltip.
  12. API (ADMIN, not a member): `GET /teams`; team detail, members, repositories, the session list and logs by `teamId`, analytics; invite, remove a member, unlink a team repository.
  13. UI (ADMIN, not a member): `/#/teams` and `/#/teams/<T>`.
  14. API (ADMIN invited and accepted as a plain member): the session list, other members' logs/contexts/change-surface, analytics; `GET /teams/<T>/members`.
- **Checks:**
  - Steps 1-2: M1 sees **only their own** session `prompt-m1`; the team repository page keeps the Sessions tab and the notice "Restricted team — you see only your own sessions"; there are no Analytics and Reports tabs; a manual `?tab=analytics` falls back to Sessions; the "Restricted" badge on the team route.
  - Step 3: other people's logs/contexts/change-surface/change-surface/files = **403**; own ones 200; analytics and reports = **403**.
  - Step 4: OWNER sees all five sessions with `firstPrompt`, reads M2's raw logs (200), analytics is available, sees the prompts in `analytics/timeline`.
  - Step 5: MG sees all five rows with statistics, but `firstPrompt = null` (in the UI "Prompt hidden"), analytics 200, raw logs of someone else's session **403** (the conversation is never given to a manager).
  - Step 6: TR sees all five with prompts, reads raw logs (200), analytics and reports **403**.
  - Step 7: TM: analytics 200, prompts visible, raw logs 200.
  - Step 8: X sees only their own (zero in the team) and analytics 403.
  - Step 9: the trainer role granted after the upload immediately gives access to the already existing sessions (retroactively).
  - Step 10: without `teamId` everyone sees only their own sessions, analytics is available.
  - Step 11: the badge tooltip names the owner and the trainers, does not name the managers and members (text "Analytics and reports: owner and managers only").
  - Step 12: the team is absent from the admin's `GET /teams`; every read is **403** without prompt text; invite, remove member and unlink are **403** and change nothing (the admin role grants no data access — 2026-10-21-private-repo-visibility).
  - Step 13: no "Teams as Admin", "View as Admin" or "Viewing as Admin"; the team page shows no member.
  - Step 14: the admin sees exactly what a plain member sees — only their own rows (none), other members' logs and analytics 403; `disclosureAcknowledgedAt` is `null` on every member row (only the team owner sees it).
- **Replaces:** `server/test/team-access-mode.e2e-spec.ts` (46 → ≈ 32: AC-1/2/4/5/6/7/8/9/9a/9b/19 and the general list), the restricted group of `client/.../components/repository-view.test.tsx` (≈ 15 of 52), `access-mode-badge.test.tsx` (13).
- **What we lose:** `AC-2` itself (writing a team row directly into the DB gives `restricted` by the column DEFAULT) and each analytics route separately (the old tests checked 403 on all ~20 routes; the scenario takes 4 representatives). I suggest one parameterised "guard test" over the route list (owner's decision G-21), or accepting the loss of route coverage: every route goes through the single `resolveTeamScope`.

### S-TEAM-03. `transparent` team: everyone sees everyone, raw logs stay closed, the switch lock
- **Layer:** UI+API (any mode)
- **Priority:** P0
- **Data/roles:** OWNER, M1, M2. Two teams: `Open-<runId>` (no members yet, will be transparent) and `Locked-<runId>` (restricted with member M1). Sessions with prompts from OWNER, M1, M2 in the `Open` repository.
- **Steps:**
  1. UI (OWNER): the `Open` page, Members: the access-mode picker with two cards "Restricted" (default) and "Transparent". Choose "Transparent" (OWNER is the only one in the team).
  2. UI (OWNER): invite M1 and M2; M1 accepts the invitation through the bell.
  3. UI (M1): the disclosure dialog.
  4. API/UI (M1): the session list of the team repository, branches, contexts, timeline, work-time of other people's sessions.
  5. API (M1): `GET .../sessions/<owner>/logs` and `.../<m2>/logs`.
  6. API (OWNER): the same.
  7. UI (OWNER, team `Locked`): Members: the "Transparent" card is disabled, a permanent amber block is visible: "This team has 1 member besides you. They joined under the restricted privacy promise and it cannot be revoked."
  8. API (OWNER): `PATCH /teams/<Locked> { accessMode: 'transparent' }`.
  9. UI (OWNER): in `Open` switch back to "Restricted".
  10. UI+API (M1): the session list and the repository page.
  11. API (non-owner M1): `PATCH /teams/<Open> { accessMode: 'restricted' }`; a PATCH without fields.
- **Checks:**
  - Step 1: switching is allowed while there are no other members (200), the card is selected.
  - Step 3: the disclosure dialog shows the **transparent text**: "Every member of this team can read all of your sessions, including your prompts." and "You can read every other member’s sessions and prompts on the same terms.", the check box "I have read and understood this.".
  - Step 4: M1 sees the sessions of OWNER and M2 in the list with prompts; branches, contexts, timeline, work-time for the team include everyone's sessions; the Analytics/Reports tabs are available; the "Transparent" badge (blue).
  - Step 5: other people's **raw logs are 403** for M1 even in transparent (a transparent list does not equal access to the conversation); OWNER gets 200.
  - Step 7: the card is disabled, the explanation is visible **in advance**, not after an error.
  - Step 8: **409** `Cannot switch to transparent: the team has members besides the owner`.
  - Step 9: switching back is always allowed.
  - Step 10: after the return to `restricted` M1 sees only their own sessions and the notice "Restricted team — you see only your own sessions".
  - Step 11: 403 for a non-owner; 400 "No fields to update".
  - In transparent the manager/trainer roles do not change the result (grant TR and check that visibility is the same, and that analytics is already visible to everyone too).
- **Replaces:** `server/test/team-cross-member-sessions.e2e-spec.ts` (16), `access-management.e2e-spec.ts` AC-11/AC-12/"non-owner cannot change accessMode"/"PATCH with no fields" (4), `client/.../components/TeamMembersTab.test.tsx` (24, modes/lock/awaiting label), `repository-view.test.tsx` (the transparent group and the personal route, ≈ 6).
- **What we lose:** the exact hint texts for 0, 1 and N members (`transparentLockNote(n)`; we check n=1) and minor button-placement details. Acceptable.

### S-TEAM-04. Inviting an unregistered e-mail and the disclosure gate at first login
- **Layer:** UI+API (any mode; in B sign-up and confirmation for the invitee)
- **Priority:** P0
- **Data/roles:** OWNER, team `Force-<runId>` (restricted) with a repository and one OWNER session. The invited e-mail `late-<runId>@example.com`, no account. TR (trainer) and M-reg (regular, accepted). The invitee's session (after login) will be uploaded with a key.
- **Steps:**
  1. UI (OWNER): Members, "Invite member", enter `late-...`, "Invite".
  2. UI: in the "Not registered yet" dialog press "Add anyway".
  3. API: check `GET /teams/<id>/members` and `GET /invitations`; a second team `Force2` with the same e-mail.
  4. API (invitee): after the first login (identify or signup+confirm) `GET /teams/pending-disclosures`.
  5. UI (invitee): open any page right after login.
  6. UI (invitee): in the "You were added to Force-..." dialog tick the check box and accept.
  7. API: before step 6 (in the pause) the invitee uploads logs; OWNER and TR look at the session list and `sessions/export-scope`, read the raw logs of this session.
  8. API: after step 6 the same requests. Through the API: `POST .../acknowledge-disclosure` with a wrong `acknowledgedAccessMode`; as a non-member.
  9. API (a member without `canInvite`): invite with and without `force`.
- **Checks:**
  - Steps 1-2: first a 404 `user_not_registered` response, then after "Add anyway" 201; the `late-...` row appears in Members at once, with the label "awaiting disclosure" (for the owner only), the invitation is `pending`.
  - Step 3: the same placeholder user (one `id`) is used in the second team; for a registered e-mail the `force` flag is ignored (a normal pending invitation).
  - Steps 4-5: the invitee lands in the team at once without Accept, sees the disclosure gate "You were added to <team name>" over the app, and the dialog cannot be closed until accepted; the invitation is auto-accepted at the first login.
  - Step 7: before acceptance the invitee's session is **invisible** to OWNER and TR in the list and in `export-scope`, and the raw logs give **403** even to the owner.
  - Step 8: after acceptance the session appears in the list and the export and can be read (200); the POST with a wrong mode 400; a non-member 403; the "awaiting disclosure" label disappeared.
  - Step 9: a member without `canInvite` gets 403 on both invite variants.
- **Replaces:** `server/test/team-invitations.e2e-spec.ts` (5: the force branch, placeholder, reuse, `canInvite`, auto-accept), `server/test/team-access-mode.e2e-spec.ts` AC-20 and `GET /teams/pending-disclosures`/`acknowledge-disclosure` (≈ 11), `client/.../TeamInvitationsTab.test.tsx` (2), the `PendingDisclosureGate` UI behaviour.
- **What we lose:** the second path without Accept (`addMemberIfRealUser()` on repository import): outside this scenario, it needs to be checked in the export/import group (to be agreed with the owner of the F-REPOS group); the overlap with `users-auto-provision` (in S-AUTH-08).

### S-TEAM-05. Roles, delegated invitation, leaving, ownership transfer, team deletion
- **Layer:** UI+API (any mode)
- **Priority:** P1
- **Data/roles:** team `Roles-<runId>`: OWNER, M1 (`canInvite`), M2 (regular), M3, ADMIN (not a member). A team repository with 1 session.
- **Steps:**
  1. UI (OWNER): Members, for M2 turn on the columns "Can invite", "Manager", "ADLC trainer" one after another (toggles with `aria-label "<column> — <e-mail>"`).
  2. API (M2): `PATCH /teams/:id/members/<M3>` (grant a role); API (ADMIN): the same; an empty PATCH.
  3. API (M1 with `canInvite`): invite a new user.
  4. UI (OWNER): "Remove" M3, confirm.
  5. UI (M2): "Leave team", confirm. API (OWNER): `POST /teams/:id/leave`.
  6. UI (OWNER): "Transfer ownership": choose M1, "Transfer".
  7. UI (M1, the new owner) and API (the former OWNER): an attempt to PATCH the mode and the roles.
  8. API (ADMIN): remove a member from a team they are neither a member nor the owner of.
  9. UI (M1): "Delete team", confirm.
  10. UI+API: `GET /teams/<id>`, everyone's team list, the left menu, the team repository.
- **Checks:**
  - Step 1: the role toggles are visible only to the owner; after `ADLC trainer` M2 is labelled in Members with "Can invite", "Manager", "ADLC trainer" as they are granted.
  - Step 2: **only the owner** grants roles: M2 and ADMIN (even the app admin) get 403 (AC-10); an empty body 400.
  - Step 3: the delegated invitation is 201.
  - Step 4: after a member is removed, their **pending invitations** are cleared too (re-inviting the same e-mail works).
  - Step 5: a member leaves (200), the owner gets 400 through `POST /leave`.
  - Step 6: "Transfer ownership? You will become a regular member."; after confirmation M1 is the owner and the former OWNER a regular member.
  - Step 7: the former owner gets 403 on changing the mode and the roles.
  - Step 8: the app admin can remove a member from someone else's team (200).
  - Steps 9-10: after the team is deleted `GET /teams/<id>` = 404/403, the team is gone for everyone in `GET /teams` and in the left menu; the team's `team_members` and `invitations` records are gone; the owner's personal repository stays.
- **Replaces:** the `server/test/access-management.e2e-spec.ts` blocks "Team membership" (invite, accept/decline, re-invite, leave, remove, transfer, delegated invite, AC-10, admin remove ≈ 13) and "delete team cascades" (1) + "duplicate team name" (in S-TEAM-01).
- **What we lose:** nothing significant: what remains in these blocks overlaps with S-TEAM-01 (invite/accept/decline). Closes F.2 #22 ("after a team is deleted it is not in the lists").

### S-TEAM-06. Team repositories: add, duplicate, remove, a shared URL is not lost
- **Layer:** UI+API (any mode)
- **Priority:** P1
- **Data/roles:** OWNER; teams `Repos-A-<runId>` and `Repos-B-<runId>`; URL `https://git.example.com/e2e/<runId>/shared` (OWNER has 2 sessions, uploaded), URL `.../empty` (no logs).
- **Steps:**
  1. UI (OWNER): team A, the Repositories tab, add the URL `shared` (from "My Repos") and the URL `empty` (typed in by hand).
  2. API: add the same URL to A again.
  3. API: `GET /teams/<A>/repositories`.
  4. UI: open the team repository, the Settings tab: file categories.
  5. UI (OWNER): add `shared` to team B as well.
  6. UI: in A press "Unlink" for `shared`, then "Remove" for `empty` (confirmations: "Unlink repository?" and "Remove repository?").
  7. API: after step 6 check the owner's `GET /repositories` and `GET /teams/<B>/repositories`.
  8. UI+API (M1, not the owner): add a repository to the team.
- **Checks:**
  - Steps 1-3: `shared` shows `sessionCount = 2`, `empty` shows `repositoryId = null` (a URL without logs); re-adding is idempotent 200, without a duplicate row.
  - Step 4: the team repository has a team file-category configuration (`GET .../settings` returns the default categories; it is created when the repository is added).
  - Step 6: "Unlink" removes the repository from the team, **the sessions remain** ("Session data is preserved and the repo can be re-added"), the owner's `shared` repository is in place; "Remove" for `empty` deletes the row permanently ("It has no uploaded sessions and will be permanently deleted").
  - Step 7: `shared` is still in team B (a shared URL is not lost when removed from A), the owner sees both sessions.
  - Step 8: 403 (only the team owner adds).
- **Replaces:** `server/test/team-repositories.e2e-spec.ts` (10), `server/test/team-repo-config.e2e-spec.ts` (1, which checked through the DB rather than the API).
- **What we lose:** the "Remove" versus "Unlink" mechanism as two different HTTP routes is checked indirectly (through two buttons). We lose the direct check of the `team_repositories` record.

### S-TEAM-07. The app admin and someone else's team: what they can and cannot do
- **Layer:** UI+API (any mode)
- **Priority:** P1
- **Status:** covered by S-TEAM-02 steps 12-14 and S-ADM-01 step 10 (the admin role grants no data access — 2026-10-21-private-repo-visibility); no separate scenario file.
- **Data/roles:** ADMIN (not a team member), OWNER, M1; team `Admin-<runId>` restricted with sessions of OWNER and M1 (prompts `prompt-owner`, `prompt-m1`), a team repository.
- **Steps:**
  1. UI (ADMIN): `/#/teams` and the team page.
  2. API (ADMIN): `GET /teams`; team detail, members, repositories; `GET .../sessions/<m1>/logs?teamId=<T>`; `GET .../sessions?teamId=<T>` and analytics.
  3. API (ADMIN): PATCH a member's role; PATCH the access mode; remove a member; unlink a team repository; invitations.
  4. UI (ADMIN): Admin → Teams → "Set new owner".
- **Checks:**
  - Step 1: no "Teams as Admin", "View as Admin" or "Viewing as Admin"; the team is not listed and its page shows nothing.
  - Step 2: the team is absent from `GET /teams`; every team route and every team-scoped session/analytics read is **403** (a non-member admin is an outsider).
  - Step 3: all **403** (`TeamOwnerGuard` / `TeamAccessGuard`, no admin bypass).
  - Step 4: the one team action an admin has without membership: any current member can be made the owner (`POST /admin/teams/:teamId/owner`); a non-member is refused (400).
- **Replaces:** `server/test/access-management.e2e-spec.ts` AC-17 (3), "admin sees all teams", "admin can view teams they do not belong to", "admin can remove member" (≈ 4) and `team-access-mode` AC-10 for the admin.
- **What we lose:** the `recompute-all-sessions` check for the admin (not about privacy; in the repositories group).

---

## 5. DATA ACCESS

### S-ACC-01. Someone else's personal repository is closed, and route guards do not depend on the credential type
- **Layer:** API (any mode)
- **Priority:** P0
- **Data/roles:** OWNER (repository `https://git.example.com/e2e/<runId>/private` with 2 sessions and key K1), STRANGER (a regular user), ADMIN. An anonymous context without a cookie.
- **Steps:**
  1. OWNER: `GET /repositories/:id`, `.../sessions`, `.../sessions/<s>/logs`, `.../summary`, `.../contexts`.
  2. STRANGER: the same requests + `GET /repositories` (their own list).
  3. STRANGER: `PUT /repositories/:id/settings/team` and `.../settings/user`; `POST .../recompute-all-sessions`; `GET .../sessions/export-scope`.
  4. ADMIN: every read of step 1, `POST .../recompute-all-sessions`, `GET .../sessions/export-scope`, `GET /repositories` (their own list).
  5. Anonymous: each of the families: `GET /repositories`, `GET /teams`, `GET /api-keys`, `GET /admin/repos`, `GET /user-settings`, `GET /api/v1/ai-tool-versions/claude-code`, `POST /api/v1/logs`.
  6. Key K1 (`X-API-Key`) instead of a cookie on the same session routes; a cookie instead of a key on `POST /api/v1/logs`, `/api/v2/logs`, `GET /api/v2/post-turn-analysis/config`.
  7. OWNER and STRANGER: `PUT /user-settings/theme` with different values, a `PUT` with `userId` in the body; a value larger than 64 KB; a name outside `[A-Za-z0-9._-]`.
  8. STRANGER: `POST /api/v2/session-attribution` and `POST /api/v2/turn-end-cost-advisor` for OWNER's `sessionId` with STRANGER's key.
- **Checks:**
  - Step 1: all 200.
  - Step 2: someone else's repository, sessions, `summary`, `contexts` = **403**; raw logs 403; OWNER's repository is absent from STRANGER's `GET /repositories`.
  - Step 3: editing the team configuration as a non-owner is **403** (F.1 #8), someone else's `export-scope` and `recompute` 403.
  - Step 4: the app admin gets **403** on every read, recompute and export-scope, and no response carries the prompt text; the repository is absent from the admin's own list (the admin role grants no data access — 2026-10-21-private-repo-visibility).
  - Step 5: **401** everywhere.
  - Step 6: a key on session routes gives **401**, a cookie on key routes gives **401** (the two "doors" do not mix).
  - Step 7: user settings are isolated (STRANGER reads their own `theme`, not OWNER's), `userId` in the body is ignored, 64 KB+ gives 400, a bad name 400.
  - Step 8: someone else's session 404 (not 403, so as not to confirm existence), an unknown session 404/`applied:false`; the owner 200 (closes F.1 #7 if the endpoints are available on the stand; otherwise the step is skipped and recorded as a gap).
  - In addition: security headers (`X-Frame-Options`, `nosniff`, CSP) are present on 200, 401 and 404 (one check from `security-headers.e2e-spec`, the rest in the platform group).
- **Replaces:** `tests/e2e/raw-logs-owner-api.spec.ts` (2), `server/test/access-management.e2e-spec.ts` "Auth guard enforcement" (2), `server/test/user-settings.e2e-spec.ts` isolation and limits (≈ 5 of 17), and closes F.1 #8, #9, #11.
- **What we lose:** the row-by-row list of all ≈ 60 routes with 401/403 (half of the "guard tests" in the old files repeat the codes on every endpoint). I suggest G-21: accept one parameterised "guard test" per route family instead of a scenario walking everything. Only representatives here.

---

## 6. ADMIN PANEL

### S-ADM-01. The admin panel is visible only to the admin, tabs and deep links work
- **Layer:** UI+API (any mode)
- **Priority:** P0
- **Data/roles:** ADMIN, REGULAR, TEAMOWNER (a regular user who owns a team), an anonymous context.
- **Steps:**
  1. UI (REGULAR): `/#/main`: the left menu has no "Admin Panel" link. Open `/#/admin`.
  2. API (REGULAR): `GET /admin/repos`, `/admin/teams`, `/admin/users`, `/admin/system`, `/admin/error-logs`, `/admin/logs-archive`, `/admin/upload-queue`, `/admin/upload-queue/stats`, `/admin/auth`, `PATCH /admin/users/<id>/role`, `POST /admin/users/<id>/delete`; the same anonymously.
  3. API (TEAMOWNER, not an admin): `GET /admin/retention`; REGULAR: the same call.
  4. UI (ADMIN): `/#/main`, press "Admin Panel".
  5. UI: go through all 9 tabs: System Info, Repos, Teams, Users, Error Logs, Upload Queue, Data Retention, Auth, Model Pricing.
  6. UI: click Teams, then go back to System Info.
  7. UI: open `/#/admin?tab=all-teams` and `/#/admin?tab=bogus`.
  8. UI: press "Back" after switching tabs.
  9. UI: TEAMOWNER links a never-uploaded URL to their team; Admin → Repos, filter by the URL, "Remove".
  10. UI: TEAMOWNER invites REGULAR; Admin → Teams, "Set new owner" → REGULAR; API: set a non-member as owner.
- **Checks:**
  - Step 1: no link, the URL immediately becomes `#/main` (the `AdminGuard` redirect).
  - Step 2: **403** for REGULAR and **401** for the anonymous context on every listed route.
  - Step 3: TEAMOWNER 200 with the fields `retentionDays`, `dailySeries`, REGULAR (without a team) 403.
  - Step 4: the URL equals `#/admin`, the "System Info" tab is active (the default, a hash without `tab=`).
  - Step 5: every tab activates (`data-state=active`), the page has no "NaN", "undefined" or the word `null`; no JS errors (a global `pageerror` fixture instead of local `jsErrors`).
  - Step 6: Teams puts `tab=all-teams` into the hash; going back to System Info **removes** the `tab` parameter from the hash.
  - Step 7: `?tab=all-teams` opens Teams, a garbage value opens System Info and the hash is not rewritten.
  - Step 8: "Back" returns to the previous tab (the tab state lives in the URL).
  - Step 9: the orphan link is one Repos row with the team name and no link into any content; "Remove" deletes it (`DELETE /admin/team-repos/:teamRepoId`), the team has no repository left.
  - Step 10: the dialog shows "Current owner: <TEAMOWNER>"; after "Set owner" the Teams row shows REGULAR as owner and `GET /teams/<T>`.`ownerId` is REGULAR; a non-member gives **400**.
- **Replaces:** `tests/e2e/admin-panel.spec.ts` (≈ 9 of 17: the link, the redirect, 4 tabs, deep-link ×3, no-tab, the Data Retention tab, nav click, no-console-errors, guard-regular ×2), the `server/test/admin-panel.e2e-spec.ts` 403/401 blocks (≈ 9), `client/.../use-admin-tab-state.test.ts` (2 of 8: the other 6 are about the hook internals).
- **What we lose:** sorting by clicking a column and the filter (moved to S-ADM-04), the specific column headers.

### S-ADM-02. The admin manages users: role, reset link, e-mail change, deletion
- **Layer:** UI+API (any mode; the reset link requires a password mode)
- **Priority:** P0
- **Data/roles:** ADMIN (A1), a second admin A2, regular U1 (owner of team `OwnedBy-U1`, a key), U2, U3. A user U4 with an e-mail that is needed for a collision.
- **Steps:**
  1. UI (A1): Users. In A1's row the "Make Admin / Revoke Admin" and "Delete" buttons are disabled (tooltips "Cannot revoke your own admin role" and "Cannot delete your own account here — use the account menu").
  2. UI: "Make Admin" next to U1, confirm in the "Grant admin role?" dialog; then "Revoke Admin".
  3. API: A1 tries to change their own role and the role of the "last admin" (when one admin is left); an unknown `id`.
  4. UI: "Reset Password" for U2. Read the link in the "Password Reset Link" modal, compare the token with the DB; close.
  5. UI/API (U2): set a new password through the link, log in with it.
  6. UI: "Rename Email" for U1: new e-mail `renamed-<runId>@example.com`; then an attempt to take U4's e-mail.
  7. API: U1 logs in with the old e-mail and with the new one; team `OwnedBy-U1` still belongs to U1.
  8. UI: "Delete" for U3: in the dialog type someone else's e-mail, then U3's e-mail (in a different case).
  9. API: U3 tries to log in, U3's key in `POST /logs`, A1 `GET /admin/users`.
  10. API (REGULAR): `PATCH /admin/users/<id>/role`, `POST /admin/users/<id>/delete`, `POST /users/<id>/reset-password-link`; anonymously.
  11. UI: the "Filter by email…" field: type part of U2's e-mail.
- **Checks:**
  - Step 1: both buttons in the administrator's own row are disabled with the tooltips above.
  - Step 2: after confirmation U1's role is `admin` (in the Role column), after Revoke `user` again; the dialogs have the texts "Grant admin access to <e-mail>?" and "…They will lose all admin privileges.".
  - Step 3: one's own role cannot be changed (400), the last admin cannot be demoted (400, "cannot demote the last admin"), an unknown user 404.
  - Step 4: a link of the form `<origin>/#/reset-password?token=<T>`, the token equals the latest DB token for this e-mail; the link is built from the stand origin.
  - Step 5: the new password works, the old one does not, the link is single-use (a repeat gives 409).
  - Step 6: the response carries the new e-mail and does **not** contain `passwordHash`; a taken e-mail 409; the same DB row changes (the id does not change).
  - Step 7: the old e-mail stops logging in (401), the new one passes, the team owner is unchanged (the team did not disappear).
  - Step 8: the confirm button is disabled until **U3's** e-mail is typed into the field; after it is typed (case does not matter) 204, U3 disappears from the table.
  - Step 9: U3's login 401, key 401, U3's data is gone (cascade details in S-AUTH-09).
  - Step 10: 403 for REGULAR, 401 for anonymous; the (legacy) route `PATCH /api/v1/users/:userId/role` answers the same as the new one, if it is kept.
  - Step 11: the table narrows to U2's row.
  - Owner's decision G-3: the legacy route `PATCH /api/v1/users/:userId/role` and `POST /users/:id/reset-password-link` (6 tests): if nobody uses them, the scenario checks only `admin/users/:id/role`.
- **Replaces:** `server/test/access-management.e2e-spec.ts` "PATCH /users/:id/role" (6) and "PATCH /admin/users/:id/email" (7), `server/test/admin-panel.e2e-spec.ts` "GET users", "PATCH role" (≈ 10), `tests/e2e/admin-panel.spec.ts` (Users, Reset Password: 2), `client/.../components/admin-users-tab.test.tsx` (8), the admin-deletion block of `server/test/account-deletion.e2e-spec.ts` (5, together with S-AUTH-09).
- **What we lose:** repeating every role check for the legacy and the new routes (if G-3 is decided in favour of deletion, those tests go entirely).

### S-ADM-03. Unconfirmed registrations and the Auth tab (password-confirm mode)
- **Layer:** UI+API (run B, Mailpit)
- **Priority:** P1
- **Data/roles:** ADMIN, three unfinished registrations P1, P2, P3 (signup without confirmation; P1 registered before P2). The stand SMTP → Mailpit.
- **Steps:**
  1. UI (ADMIN): the Auth tab.
  2. UI: the "Pending Registrations" list.
  3. UI: "Resend" for P1; "Resend" for P1 once more; then P2, who has a single message.
  4. API: P3 presses "Resend" on the signup page itself (`POST /auth/resend-confirmation`) right after the admin Resend for P3.
  5. UI: P2 confirms the address from the message; in the admin panel "Resend" and "Revoke" for P2.
  6. UI: "Revoke" for P1, confirm.
  7. API: P1 tries to log in, then signs up again with the same e-mail.
  8. API: anonymous and REGULAR on `GET /admin/auth/pending-registrations`.
- **Checks:**
  - Step 1: the "Active Mode" card = "Email + password with confirmation (Mode 3)"; the SMTP card: Host, Port, From as on the stand; the block "Secrets (passwords, client secrets, SMTP credentials) are never shown here."; "Other modes" lists the other three with the field names, without values.
  - Step 2: the table contains P1, P2, P3 in "oldest first" order, with `registeredAt` and `tokenExpiresAt` (+24 h).
  - Step 3: the first Resend succeeds (a new message in Mailpit), the repeat is 429 `Retry-After` (a wait message in the UI); the cooldown is shared with the user resend.
  - Step 4: the user resend right after the admin one is 429 (a shared 60-second cooldown).
  - Step 5: Resend and Revoke for the confirmed P2 are **409**, P2 disappeared from the list.
  - Steps 6-7: Revoke 204, P1's account is deleted, the tokens are cleared by cascade, login 401, signing up again with the same address works.
  - Step 8: 401 and 403.
  - In modes A (`none`) and C the Auth tab shows its own mode and has no Pending block (run A, 1 short check).
- **Replaces:** `server/test/admin-auth.e2e-spec.ts` (9, of which 2 about the absence of secrets are in S-AUTH-07), the UI part of `PendingRegistrationsTable`.
- **What we lose:** nothing significant.

### S-ADM-04. Repos and Teams tabs: numbers, filter, sorting, repository deletion
- **Layer:** UI+API (any mode)
- **Priority:** P1
- **Data/roles:** ADMIN; U1 (repository `.../adm-a` with 2 logs of one session `s1`: `s1` uploaded twice with different types, plus a second session `s2`), U2 (repository `.../adm-b` without logs); team `AdmTeam-<runId>` with 2 members and 1 repository.
- **Steps:**
  1. UI: Repos, the `adm-a` row.
  2. UI: the "Filter by repository URL…" filter: type `adm-a`, then `zzz-nonexistent-repo-filter-xyz`.
  3. UI: click the "Repository" column header three times.
  4. UI: press "Remove" for `adm-b` (without logs).
  5. UI: "Remove" for `adm-a`: read the text, confirm.
  6. UI: the Teams tab: the `AdmTeam-...` row; the filter by name.
  7. API (U1): `GET /repositories`, `GET .../sessions` for the deleted repository.
- **Checks:**
  - Step 1: `adm-a` shows `sessionCount = 2` (two sessions, not 3 logs), a non-zero log size (`logSize`), `maxUploadBytes` equal to the size of the largest artisyn body (a number > 0; empty/a dash for `adm-b`), owner U1, "first seen".
  - Step 2: the filter narrows to one row; gibberish gives "No results.".
  - Step 3: the "Repository" header starts sorted ascending (arrow up), after a click descending, after the second click unsorted.
  - Step 4: the text "Remove this repo? It has no uploaded sessions and will be permanently deleted."; `adm-b` disappears.
  - Step 5: the text "Permanently delete this repo and all 2 session(s)? This cannot be undone." (the number matches `sessionCount`); after confirmation the repository disappears for the owner U1 too (in `GET /repositories` and in the UI), requests by its id give 404/403.
  - Step 6: Teams shows the owner, `memberCount = 2`, `repoCount = 1`, the filter narrows.
- **Replaces:** the `server/test/admin-panel.e2e-spec.ts` blocks "GET repos / teams / sessionCount and logSize / maxUploadBytes" (≈ 9), `tests/e2e/admin-panel.spec.ts` filter and sorting (2).
- **What we lose:** `DELETE /admin/repos/:id` for a repository linked to a team (in the UI "Remove" calls `removeTeamRepository`): the scenario does not click this branch; add a second click if the owner wants.

### S-ADM-05. System Info, logs archive and error log
- **Layer:** UI+API (any mode)
- **Priority:** P1
- **Data/roles:** ADMIN. On the server machine the test appends three lines in the pino log format to `server/logs/app-<today>.log`: `INFO` "all good", `ERROR` "E2E-first" (with details), `ERROR` "E2E-second" (later in time) (assumption: the test and the server are on the same machine; otherwise the lines come from a real error, for example a request to an invalid route that logs an ERROR).
- **Steps:**
  1. UI: the System Info tab, read the tiles.
  2. UI: the per-instance table and the block "Running without a supervisor — showing this process only".
  3. UI: the "Logs Archive" block, "Download ZIP".
  4. API: `GET /admin/logs-archive`.
  5. UI: the Error Logs tab.
  6. UI: click the "E2E-second" error, the details modal, "Copy".
  7. API: `GET /admin/error-logs`.
  8. API (REGULAR/anonymous): `GET /admin/system`, `/admin/logs-archive`, `/admin/error-logs`.
- **Checks:**
  - Step 1: the tiles "Node Instances", "Visible CPUs", "Database", "Memory", "Uptime", "Load Average", "Build", "Node / Env", "Event Loop", "DB Pool", "Disk", "Requests", "DB Space"; no `NaN`, `undefined`, `null` anywhere; "Database" shows availability (connected, ping > 0); "Build" shows "dev" on dev; "DB Space" contains "Logs table: N rows" and "Database total: X MB"; memory is not a dash for a live process.
  - Step 2: exactly one process row with a PID, the line "Running without a supervisor — showing this process only".
  - Steps 3-4: clicking "Download ZIP" starts the download of a file `logs-<ISO>.zip`; through the API the header is `Content-Disposition: attachment; filename="logs-…zip"`, the body starts with `PK` and unpacks, today's `app-*.log` is inside; the temporary file on the server is deleted.
  - Step 5: the table has exactly two ERROR entries (INFO filtered out), "E2E-second" above "E2E-first" (newest on top); the columns Timestamp, Source, Message with details.
  - Step 6: the details open, "Copy" puts "message + details" into the clipboard (the clipboard is replaced).
  - Step 7: `{ entries: [...] }` with at most 30 entries, sorted by time descending.
  - Step 8: 401/403.
  - The log contains no password, hash or token (a string like `token=` does not occur in `app-*.log` after S-AUTH-01/04: a grep over the run's log).
- **Replaces:** `server/test/system-info.e2e-spec.ts` (11), `server/test/admin-panel.e2e-spec.ts` "error-logs" (4), `tests/e2e/admin-panel.spec.ts` System Info and Error Logs (≈ 2), `client/.../components/AdminSystemTab.test.tsx` (10), `AdminErrorLogsTab.test.tsx` (7), `server/src/system-info/system-info.service.spec.ts` (7 of 12) and `request-metrics.middleware.spec.ts` (5 of 12) partly.
- **What we lose:** the behaviour with an unavailable DB (`connected=false`), without permission to read table sizes (DB Space hidden), the active-request counter not going negative, cluster mode (slots, worker memory) and "`memoryBytes` null shown as a dash". Keep these branches as units (`system-info.service.spec`, `request-metrics.middleware.spec`, `worker-slot-registry.spec`): a person cannot reproduce them on a stand.

### S-ADM-06. Data Retention: the retention period matches the consent text, a chart with an empty day
- **Layer:** UI+API (any mode)
- **Priority:** P1
- **Data/roles:** ADMIN; U1 with two sessions: one dated "3 days ago", the other "1 day ago" (an empty day between them); TEAMOWNER (a team owner) and REGULAR (without teams).
- **Steps:**
  1. API: U1 uploads two sessions with their own timestamps.
  2. UI (ADMIN): the Data Retention tab.
  3. API (ADMIN): `GET /admin/retention`.
  4. API (TEAMOWNER, REGULAR): the same route; anonymous.
  5. UI: open a new user's consent screen and read "purged after N days" (see S-AUTH-02).
- **Checks:**
  - Step 2: the "Retention Policy" header with the number of days is visible, a per-day chart with an **empty** column between the two days (the gap filled with zeros) and total sizes.
  - Step 3: `dailySeries` is ordered by UTC day and contains three consecutive days (with `sessionCount: 1, 0, 1`), the sizes sum the log sizes, `oldestSessionAt` and `youngestSessionAt` match the uploaded dates, `totalSessionCount` includes every non-deleted session.
  - Step 4: TEAMOWNER 200 (not an admin, but a team owner), REGULAR 403, anonymous 401.
  - Step 5: the number of days in the consent text equals `retentionDays` from step 3 (the same configured value for both screens).
- **Replaces:** the `server/test/admin-panel.e2e-spec.ts` blocks "retention" and "UTC day bucketing" (5), the `AdminDataRetentionTab` UI (1 in `admin-panel.spec`).
- **What we lose:** the background purge itself (`SessionRetentionService`: deleting expired sessions, batches, audit) is not checked in this group (the sessions and data group). Retention settings are only read here: **there is no editing**, the tab is read-only (the value comes from `SESSION_RETENTION_DAYS`).

### S-ADM-07. Upload queue: broken file, Reprocess, Clear, counters
- **Layer:** UI+API (any mode; to be agreed with the log-ingest group: the chunk-ingest and race scenarios in `upload-queue.e2e-spec.ts` belong to it)
- **Priority:** P1
- **Data/roles:** ADMIN, U1 with key K. The queue scheduler is running (1 s interval). Sessions: `ok-1`, `ok-2` (valid), `broken-1`, `broken-2` (unreadable NDJSON, > 10% broken lines), one chunked upload `chunky` (2 chunks of 2 declared, only the 1st uploaded).
- **Steps:**
  1. API (U1): `POST /api/v2/logs` for `ok-1`, `ok-2`, `broken-1`, `broken-2` and chunk 0 of 2 for `chunky`.
  2. UI (ADMIN): the Upload Queue tab: the statistics block: "Queue", "Utilisation", "Drain ETA", the header "Worker · last N min".
  3. UI: the list: rows grouped by session; open the details of `broken-1`; "Download file".
  4. API (U1): the next upload `POST /api/v2/logs` (any valid one).
  5. UI: "Reprocess failed (2)".
  6. UI: "Clear broken files (2)", confirm ("Delete").
  7. API (ADMIN): `GET /admin/upload-queue`, `.../stats`, `GET /admin/upload-queue/<id>/file`; a non-existent id; a non-admin.
- **Checks:**
  - Step 2: after the queue drains, the per-status counters: `failed = 2`, `partially_uploaded = 1`, `pending = 0`, `processing = 0` (always four statuses, zeros included), 3 files in total; the throughput metrics are numbers (not a dash) after two valid files drain, utilisation 0-100%.
  - Step 3: `broken-1` has status failed and the message "Malformed NDJSON: invalid JSON line N of M …"; `chunky` shows "1/2 chunks"; "Download file" returns a file with the same content.
  - Step 4: the response body contains `warnings` with two lines "Hook uploaded broken file: <name> — <reason>" (a warning to the hook about broken files).
  - Step 5: "Reprocess failed" resets failed to pending (the error is cleared), after 1-2 scheduler ticks they are failed again (the data is broken, so it fails again, but the file is in place), the button counter stays "(2)"; `pending` and `partially_uploaded` are untouched.
  - Step 6: "Clear broken files" deletes only the failed ones (2 rows and their files), `partially_uploaded` stays; the buttons show "(0)" and disappear/become disabled.
  - Step 7: the file of a deleted row 404, a non-existent id 404, a non-admin 403, anonymous 401.
  - The statistics arithmetic from the old tests (10 files in 5 s = 2 files/s, ETA 4000 ms) stays in the unit (`upload-queue-stats.service.spec`): it needs raw-row factories, not a live queue.
- **Replaces:** the `server/test/upload-queue.e2e-spec.ts` blocks "Admin upload-queue endpoints", "GET /admin/upload-queue", "file", "DELETE failed", "reprocess-failed", "stats" (≈ 17 of 36; the rest, about ingest and chunks, goes to the log-ingest group), `client/.../components/AdminUploadQueueTab.test.tsx` (24), `UploadQueueStatsPanel.test.tsx` (10), `server/src/admin/upload-queue-stats.service.spec.ts` (11, of which ≈ 5 about the p95/ETA/clamp-to-100% arithmetic are kept as pure maths). Closes F.3 #27 and #39.
- **What we lose:** `Lease-timeout reclaim`, `Overlap guard`, `Partial-upload expiry`, a staging-directory write failure: these are scheduler internals (the ingest group). The exact ETA and p95 from the old units, if we do not keep the unit.

~~S-ADM-08. Releases: signed link, forgery, expired, and the public installer~~: **dropped**, the release download feature was removed by 2026-10-20-github-release-pipeline. The public installer download (its old step 9) is S-REL-01 step 7 in `04-ingest-hook-installer-platform.md`.

---

## 7. Not covered by scenarios (deliberately)

| Area | What I suggest | Reason |
|---|---|---|
| Azure SSO (`azure-oauth`, `azure-callback.controller.spec`, `GET /auth/azure`) | Keep `azure-callback.controller.spec.ts` (a unit; forged state/nonce and a missing e-mail claim lead to `/#/login?oauthError=1`); S-AUTH-07 checks only 302/404 | Needs a real Microsoft Entra ID; it can be repeated by hand only in an environment with a tenant. There is no working e2e today either. Question to the owner: whether to build a stand with a fake OIDC provider (then "S-AUTH-10: SSO login and auto-acceptance of invitations" appears, F.1 #16). |
| Config validator at start-up (`auth-startup-validation.spec`, 21 tests) | Keep as a unit | It checks that the server refuses to start with an incomplete environment; a live run would need a server restart, which is forbidden in this repository. It is pure logic, cheap, and not distrusted. |
| Detecting request and container locality (`localhost.util.spec`, `container-gateway.util.spec`, part of `auto-identify.guard.spec`) | Keep as units | A "foreign address" and cgroup/podman/k8s cannot be reproduced from localhost tests; the only protection of `none` mode. |
| `PASSWORD_POLICY` boundaries for the three levels (`password-policy.spec`, 12) | Keep the unit (one file, a pure function) | The scenario sees only the stand's level; three runs for the length boundaries are not justified. Or accept the loss. |
| The row-by-row backoff schedule (`login-backoff.service.spec`, 14) | Either keep it, or accept S-AUTH-06 as the only protection | Owner's decision; if the unit is kept, the scenario can be shortened to steps 1-3 and 9. |
| Cluster mode, workers, `TRUST_PROXY`, the DB pool, `precompressed-static`, the release build | Not in this group (platform, installer) | Not reproducible in dev with a single process. |
| Races (double confirm, double reset, simultaneous identify, `FOR UPDATE` on deletion) | One representative each in the scenarios; drop the rest | This is protection against double clicks/parallel requests; invisible to a person, the loss is acceptable. |
| 401/403/404/400 on every route as a separate test | Drop as a class; keep representatives in S-ACC-01 and S-ADM-01 | Half of the old "tests" repeat the guard status codes on every endpoint (decision G-21: a parameterised guard test). |
| The legacy routes `PATCH /api/v1/users/:userId/role` and `POST /users/:id/reset-password-link` | If G-3 is decided as "unused", delete the routes and 6 tests | A duplicate of the client's `PATCH /admin/users/:id/role`. |
| The Model Pricing tab | Not in this group (cost) | Only the presence of the tab is checked here (S-ADM-01). |
| Dialog UI-state tests (`repository-view.test` outside restricted, `TeamMembersTab` outside the lock, `NotificationBell` error branches, `team-disclosure-modal` check-box reset) | Drop | The data is substituted by hand and never reaches the server; the meaning of the live path is covered by the scenarios. |
| The `MainNav.test.tsx` build label (short commit, tooltip with the full hash) | Hand over to the platform/UI-shell group | Not about authentication. |
| The Token Flow feature flag | Not in the group | See G-1. |

### What the owner must decide (summary)

1. ~~G-2~~ Decided: in `password-confirm` there must be no session before confirmation; the current `signup` issues one (a defect, see S-AUTH-01).
2. G-3: whether the legacy `PATCH /api/v1/users/:userId/role` is used.
3. Whether to make the separate run B (Mailpit, `NODE_ENV` not `test`, `PASSWORD_POLICY=long`) part of the regular cycle or only before a release.
4. Whether we keep the units: `login-backoff` (14), `password-policy` (12), `auth-startup-validation` (21), `localhost/container-gateway` (≈ 20), `azure-callback` (≈ 8), `system-info.service`/`request-metrics` (≈ 12), the `upload-queue-stats` arithmetic (≈ 5). My estimate: keep all of them (about 95 tests, pure functions) and do not count them as "distrusted".
5. Whether a stand with a fake OIDC for SSO is needed (S-AUTH-10).
