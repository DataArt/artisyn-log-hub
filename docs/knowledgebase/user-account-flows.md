---
type: "Reference"
title: "User Account Flows (invite, password reset, consent, admin account actions)"
description: "Account flows outside login itself: inviting someone before they sign up (force invite and auto-provisioning), self-service password reset (tokens, TTL, cooldown, enumeration safety), strict-managed set-password links (bootstrap admin, admin create user, resend link), the admin-generated reset link, the admin email rename, and the onboarding data-collection consent and new-user nudge."
tags:
  - auth
  - server
  - client
  - users
generated: { by: "human:denistsyplakov", at: "2026-11-19T00:00:00+04:00" }
---

# User Account Flows

Login, auth modes, rate limits and email delivery are described in
[authorization-and-authentificaiton.md](authorization-and-authentificaiton.md); password strength
rules are in [algorithms/password-policy.md](algorithms/password-policy.md). This article covers the
account flows around them.

## Signup

After `POST /api/v1/auth/signup` a session exists only in the `password` mode. In `password-confirm`
signup only creates the unconfirmed account and sends the confirmation email; the flow is signup →
confirm the email → log in. Details are in
[authorization-and-authentificaiton.md](authorization-and-authentificaiton.md#signup-and-the-session).
In `strict-managed` there is no signup at all (`signup` / `confirm-email` / `resend-confirmation` →
404, `#/signup` redirects to `#/login`); accounts come only from an admin — see
[Set-password links](#set-password-links-strict-managed).

## Invite before signup

A team member with invite permission (the team owner, an admin, or a member with `canInvite`)
invites by email through `POST /api/v1/teams/:teamId/invitations`
(`TeamsService.sendInvitation()` in `server/src/teams/teams.service.ts`).

- If the email belongs to an existing user, a normal invitation is created and the invitee accepts
  it.
- If no user has that email, the call answers `404` with `error: 'user_not_registered'`. The UI asks
  the inviter to confirm, then retries with `force`.
- A forced invite **auto-provisions** the user (`UsersService.findOrCreateAutoProvisioned()`) and
  adds the team membership at once, with no "Accept" step. The invitation row stays `pending` until
  the person first signs in, when `UsersService.acceptGrantedInvitations()` flips it to `accepted`.
- The disclosure acknowledgement is **not** stamped for an auto-provisioned member, because they
  have never read the access-mode disclosure. Until they acknowledge it at login, their sessions are
  invisible to the team owner and trainers in a `restricted` team.
- The person later signs in (or signs up) to the existing account; no second account is created.
- **Not in `strict-managed`.** There `sendInvitation()` ignores `force`, so an unknown email always
  answers `404 user_not_registered` and nothing is provisioned; the UI does not offer "invite
  anyway". Only an admin creates accounts in that mode.

## Password reset

Self-service reset exists in the password modes (`password`, `password-confirm`, `strict-managed`):
`POST /api/v1/auth/forgot-password` and `POST /api/v1/auth/reset-password` in
`server/src/auth/auth.controller.ts`, tokens in
`server/src/auth/password-reset-tokens.service.ts`.

- **No account enumeration.** An unknown email, a known one, one in its 60 s cooldown and one over
  the per-email rate limit all get the same `200 { email_delivery: 'sent' }`; the email is sent
  without awaiting it, so the response time does not tell either. Attempts are only logged (with
  the email masked).
- **Tokens** are 32 random bytes, base64url (`generateResetToken()`), single-use. The DB stores
  only `sha256(token)` hex (`hashResetToken()`; migration 0094 hashed older rows in place). The
  lifetime is stored per row (`expires_at`): `RESET_LINK_TTL_MS` = 1 hour for forgot-password and
  the admin-generated link, `SET_PASSWORD_LINK_TTL_MS` = 24 hours for strict-managed set-password
  links (`server/src/auth/password-link-ttl.ts`). `purpose` is `reset` (forgot) or `set`
  (admin-issued, strict-managed).
- A **password-less account** (admin-created, never set) gets "Set your Log Hub password" wording
  and a `purpose=set` link (`setPasswordOnRequestEmail`), still 1 hour.
- In `strict-managed` forgot-password also counts against the 20 requests / IP / hour limit
  (`EmailSendRateLimitService`), and works for every account, password-less ones included (it is
  not gated on `password_hash`) — except an import placeholder, which gets nothing.
- **Cooldown and re-issue.** `issueWithCooldown(userId, 'reset', ttl)` runs in one transaction that
  locks the user row. A request within 60 s of the user's previous link (any purpose) issues
  nothing (the caller still answers 200). Otherwise the user's earlier unused `reset` links are
  retired — an admin-issued `set` link survives — and a new one is issued.
- **Check, validate, consume.** `resetPassword()` first checks the token without using it
  (`check()`), then the confirmation match and `PASSWORD_POLICY` (see
  [algorithms/password-policy.md](algorithms/password-policy.md)), and only then consumes it, so a
  typo or a weak password never burns the link. Consume is atomic: the token is marked used with a
  conditional update, so two concurrent resets cannot both succeed. Unknown → `400`, expired →
  `410`, already used → `409`. After a successful reset every other outstanding token of the user
  is retired and **all the user's sessions are deleted**.
- There is **no auto-login** after a reset: the page says the password is set/changed and offers
  "Go to log in".
- The emailed link is built only from `PUBLIC_BASE_URL`, never from the request `Host` header (see
  [authorization-and-authentificaiton.md](authorization-and-authentificaiton.md) § "Email flows").

## Set-password links (strict-managed)

In `AUTH_MODE=strict-managed` every account is created without a password and gets an emailed
**set-password link**: the normal reset URL plus `&purpose=set`
(`<PUBLIC_BASE_URL>/#/reset-password?token=…&purpose=set`, built by
`buildResetUrl(token, logger, 'set')` in `server/src/auth/password-link-url.ts`), valid **24 hours**,
single-use, consumed by the same `POST /api/v1/auth/reset-password`. The forgot-password link keeps
no `purpose` and 1 hour. `ResetPasswordPage.tsx` reads `purpose`: `set` → title "Set your password",
button "Set password"; an invalid or expired link (either variant) shows `This link is invalid or
has expired. Request a new one with "Forgot password?" on the login page.` Email texts are pure
builders in `server/src/mail/password-link-emails.ts` (`bootstrapAdminEmail`, `setPasswordEmail`).
The first successful set stamps `email_confirmed_at`.

Three ways a link is issued:

- **Bootstrap admin** — on server start, `bootstrapStrictManagedAdmin()` creates the account for
  `ADMIN_CONTACT_EMAIL` and emails the link in one transaction; a failed send rolls back and aborts
  startup. An existing admin account is left alone (no email); an existing non-admin account
  has its password, confirmation, links and sessions cleared and is then promoted and emailed the
  link, so only the mailbox owner becomes the admin. Details:
  [authorization-and-authentificaiton.md](authorization-and-authentificaiton.md#strict-managed-mode-admin-provisioned-accounts).
- **Admin create user** — `POST /api/v1/admin/users` `{ email, role?: 'admin' | 'user' (default
  'user'), teamId?: number | null }` (`AdminService.createProvisionedUser()`). Order: domain
  allow-list (400 `email_domain_not_allowed`) → email limiter per admin (429) → existing email, any case (409
  `email_already_registered`, nothing sent) → team exists (400 `team_not_found`) → user + optional
  team membership in one transaction → token → email. `201 { id, email, role, teamId,
  email_delivery }`; a failed send keeps the account (`'failed'`, the admin resends). UI:
  `CreateUserModal.tsx` from the Admin Users tab.
- **Resend link** — `POST /api/v1/admin/users/:id/password-link`
  (`AdminService.sendPasswordLink()`): email limiter per admin → 404 `user_not_found` → 409
  `password_already_set` → 409 `not_a_provisioned_account` (import placeholder, or a stored
  address that is not a valid email) → `issueWithCooldown(id, 'set', 24 h)` (429 + `Retry-After`
  within 60 s of the previous `set` link; every earlier link stops working) → email →
  `200 { email_delivery }`. UI: `SendPasswordLinkButton.tsx`, shown only on rows whose Password
  column says "Not set" (`passwordSet === false && imported === false` on
  `GET /api/v1/admin/users`; placeholders show "Imported"). The button counts down from
  `passwordLinkSentAt` (newest still-working `set` link) + 60 s, so the cooldown starts at create and survives
  a reload.

## Admin-generated reset link

Not available in `strict-managed` (the route 404s there; the admin uses "Resend link" instead).
An admin can create a reset link for a user without email: route `POST :userId/reset-password-link`
on the admin-only `api/v1/users` controller (`server/src/admin/admin.controller.ts`,
`AuthService.adminGenerateResetLink()`), opened from the Admin Panel Users tab
(`client/src/viewer/pages/admin/tabs/ResetPasswordLinkModal.tsx`), where the admin copies it.

- The link uses the same token table and TTL (1 hour) as the self-service flow.
- It is built from the **request origin** (`getRequestBaseUrl(req)`), not `PUBLIC_BASE_URL`: it is
  returned in the response body to an authenticated admin and never leaves that admin's browser, so
  the origin they are using is the right one.
- Links are hash-routed: `<origin>/#/reset-password?token=…`.

## Admin email rename

Route `PATCH users/:id/email` on the `api/v1/admin` controller
(`server/src/admin/admin-panel.controller.ts` → `AdminService.renameUserEmail()` →
`UsersService.renameEmail()`), opened from
`client/src/viewer/pages/admin/tabs/RenameUserEmailModal.tsx`.

- Links already mailed to the old address stop working: the user's unused password-reset and
  email-confirmation tokens are retired (every mode), so whoever reads the old mailbox — e.g. a
  typo'd domain — cannot set the password of the corrected account. A "Forgot password?" racing
  the rename issues nothing: both take the user row lock, and issuance re-checks the email. In
  `strict-managed` the new address must also pass `ALLOWED_EMAIL_DOMAINS`, `email_confirmed_at`
  and `password_hash` are cleared (the person sets a password through "Resend link" or "Forgot
  password?"), and an admin cannot rename themselves (400 `cannot_rename_self`). Renaming to
  the same address changes nothing.
- The rename is a **same-row update** of `users.email`. Everything the user owns — sessions, repos,
  teams, API keys — hangs off the unchanged `users.id`, so nothing is reassigned.
- The new email is lower-cased. An email already used by another user is a `409`; an unknown user
  id is a `404`.
- An admin may rename their own email.

## Onboarding and data-collection consent

- Before the app renders, every signed-in user must accept a **non-closable data-collection
  notice** (`user-docs/data-collection-notice.md`, served from the generated `/help/data-collection-notice.md`). How the gate replaces the app shell is
  described in [client-routing-and-layout.md](client-routing-and-layout.md) § "The data-collection
  consent gate".
- Acceptance is one row in the generic per-user `user_settings` key/value store
  (`server/src/user-settings/`, routes `GET/PUT/DELETE /api/v1/user-settings[/:name]`), named
  `dataCollectionNotice` and holding the hash of the accepted notice text. Editing the notice asks
  every user again, once. The store only ever reads and writes the current session user's rows; the
  server does not know what consent means. See [db-tables.md](db-tables.md#user_settings).
- The notice shows the session retention window, which `GET /api/v1/sessions/retention-days`
  serves to any signed-in user (not only admins).
- **New-user nudge.** A user with no repositories and no teams is sent to the API Keys page once per
  browser session, so the first thing they see is how to connect the hook.
