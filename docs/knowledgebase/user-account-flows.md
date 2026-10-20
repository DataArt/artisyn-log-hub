---
type: "Reference"
title: "User Account Flows (invite, password reset, consent, admin account actions)"
description: "Account flows outside login itself: inviting someone before they sign up (force invite and auto-provisioning), self-service password reset (tokens, TTL, cooldown, enumeration safety), the admin-generated reset link, the admin email rename, and the onboarding data-collection consent and new-user nudge."
tags:
  - auth
  - server
  - client
  - users
timestamp: "2026-10-14T00:00:00+04:00"
---

# User Account Flows

Login, auth modes, rate limits and email delivery are described in
[authorization-and-authentificaiton.md](authorization-and-authentificaiton.md); password strength
rules are in [password-requirements.md](password-requirements.md). This article covers the
account flows around them.

## Signup

After `POST /api/v1/auth/signup` a session exists only in the `password` mode. In `password-confirm`
signup only creates the unconfirmed account and sends the confirmation email; the flow is signup →
confirm the email → log in. Details are in
[authorization-and-authentificaiton.md](authorization-and-authentificaiton.md#signup-and-the-session).

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

## Password reset

Self-service reset exists in the password modes (`password`, `password-confirm`):
`POST /api/v1/auth/forgot-password` and `POST /api/v1/auth/reset-password` in
`server/src/auth/auth.controller.ts`, tokens in
`server/src/auth/password-reset-tokens.service.ts`.

- **No account enumeration.** An unknown email gets the same `200 { email_delivery: 'sent' }` as a
  known one; the attempt is only logged (with the email masked). Requests over the per-email rate
  limit get that same answer without issuing a token.
- **Tokens** are 32 random bytes, base64url, valid for 1 hour, single-use.
- **Cooldown and re-issue.** `issueWithCooldown()` runs in one transaction that locks the user row.
  A request within 60 s of the previous token is refused with `429` and a retry-after value.
  Otherwise the user's earlier unused tokens are retired and a new one is issued, so only the newest
  link works.
- **Consume** is atomic: the token is marked used with a conditional update, so two concurrent
  resets cannot both succeed. Unknown → `400`, expired → `410`, already used → `409`. After a
  successful reset every other outstanding token of the user is retired too.
- The new password must match its confirmation and pass `PASSWORD_POLICY` (see
  [password-requirements.md](password-requirements.md)).
- There is **no auto-login** after a reset: the user signs in with the new password.
- The emailed link is built only from `PUBLIC_BASE_URL`, never from the request `Host` header (see
  [authorization-and-authentificaiton.md](authorization-and-authentificaiton.md) § "Email flows").

## Admin-generated reset link

An admin can create a reset link for a user without email: route `POST :userId/reset-password-link`
on the admin-only `api/v1/users` controller (`server/src/admin/admin.controller.ts`,
`AuthService.adminGenerateResetLink()`), opened from the Admin Panel Users tab
(`client/src/viewer/pages/admin/tabs/ResetPasswordLinkModal.tsx`), where the admin copies it.

- The link uses the same token table and TTL as the self-service flow.
- It is built from the **request origin** (`getRequestBaseUrl(req)`), not `PUBLIC_BASE_URL`: it is
  returned in the response body to an authenticated admin and never leaves that admin's browser, so
  the origin they are using is the right one.
- Links are hash-routed: `<origin>/#/reset-password?token=…`.

## Admin email rename

Route `PATCH users/:id/email` on the `api/v1/admin` controller
(`server/src/admin/admin-panel.controller.ts`,
`UsersService.renameEmail()`), opened from
`client/src/viewer/pages/admin/tabs/RenameUserEmailModal.tsx`.

- The rename is a **same-row update** of `users.email`. Everything the user owns — sessions, repos,
  teams, API keys — hangs off the unchanged `users.id`, so nothing is reassigned.
- The new email is lower-cased. An email already used by another user is a `409`; an unknown user
  id is a `404`.
- An admin may rename their own email.

## Onboarding and data-collection consent

- Before the app renders, every signed-in user must accept a **non-closable data-collection
  notice** (`client/public/help/data-collection-notice.md`). How the gate replaces the app shell is
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
