# Authentication modes

`AUTH_MODE` selects how people sign in to the web app. There are five modes:

| Value | Mode | Use it for |
|---|---|---|
| `none` | Mode 1, no password | One user on their own machine. A caller types an email and is signed in as that user, without verification. Only local callers are accepted (localhost and, in a container, the container's default gateway). **Never** for a shared or network-reachable installation. |
| `password` | Mode 2, email and password | A small team on a trusted network. SMTP is optional; without it password reset is unavailable. |
| `password-confirm` | Mode 3, email, password and emailed confirmation | Anything reachable from the internet. An account is usable only after an emailed confirmation link. Needs SMTP: the app refuses to start without a reachable relay. |
| `azure-oauth` | Mode 4, Microsoft Entra ID sign-in | Organizations on Microsoft Entra ID, single tenant. No local passwords. Recommended for organizations that use Entra ID. |
| `strict-managed` | Strict managed, admin-provisioned users | A team where only the admin decides who has an account. Email and password, **no self sign-up**: the admin creates each account and the person gets an emailed set-password link. Needs SMTP: the app refuses to start without a reachable relay. See [Strict managed](#strict-managed-admin-provisioned-users). |

- In Modes 1–4 the first user to sign in becomes the admin — see
  [Check that you are the admin](install-server.md#check-that-you-are-the-admin). In
  `strict-managed` the admin is the `ADMIN_CONTACT_EMAIL` account (below).
- An unset `AUTH_MODE` means `password`. The release install sets `none`.
- An unrecognized value, or a mode whose required settings are missing, stops the server at
  startup.
- Routes that belong to a different mode answer `404`.
- The user's email is the identity in every mode, so switching modes needs no data migration.

> **Important.** The release install ships with `AUTH_MODE=none` and publishes the app on
> `127.0.0.1:5003` only. That loopback-only port binding is the actual security boundary of
> Mode 1: with Docker's port forwarding every connection appears to come from the container
> gateway, which Mode 1 trusts. **Change `AUTH_MODE` in the same edit in which you widen the
> `ports:` mapping.**

The settings each mode needs are in
[Security Hardening & Configuration](security-hardening.md): Azure Entra ID (§3.2), passwords
and the sign-up domain allow-list (§3.3) and email (§3.4). The variables are listed in
[Server settings](server-configuration.md).

## Strict managed (admin-provisioned users)

`AUTH_MODE=strict-managed` is email and password sign-in in which nobody can create their own
account. The admin page shows it as "Strict managed (admin-provisioned users)".

**Required settings** — the server does not start without them:

| Variable | Value |
|---|---|
| `PUBLIC_BASE_URL` | The address people open, for example `https://loghub.internal`. Every way in is an emailed link built from it, so it is required in every environment, not only in production. |
| `ADMIN_CONTACT_EMAIL` | The email address of the first admin. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM` | The mail relay. It must be reachable when the app starts. `SMTP_USER`, `SMTP_PASSWORD` and `SMTP_SECURE` are optional, as in Mode 3. |

`ALLOWED_EMAIL_DOMAINS` is optional: when set, the admin can create accounts only for those
domains (the `ADMIN_CONTACT_EMAIL` account itself is not checked).

**The first admin.** On the first start the app creates an account for `ADMIN_CONTACT_EMAIL`
with the `admin` role and no password, and emails it a set-password link. If that email cannot be
sent, the app does not start and creates nothing — fix the SMTP settings and start it again.
Later starts send no email. If an account with that address already exists (for example after a
switch from another mode), it gets the `admin` role and no email is sent.

**The admin creates every other account.** In **Admin Panel → Users → + Create user** the admin
enters an email, a role (User or Admin) and optionally a team. The person gets an email with a
set-password link and sets a password on a page titled "Set your password". Until then the
**Password** column shows `Not set` and the admin can **Resend link**, which makes the earlier
link stop working. A second resend for the same person is possible after 60 seconds.

**Links:**

| Link | Valid for |
|---|---|
| Set-password link (first admin, created account, resend) | 24 hours, works once |
| "Forgot password?" reset link | 1 hour, works once |

A used or expired link shows "This link is invalid or has expired". The page then points to
"Forgot password?".

**"Forgot password?" works for every account**, including one whose owner has not set a password
yet — so a person whose set-password link expired can get a new one without the admin.

**What is off in this mode:**

- the sign-up page and its link on the login page (`#/signup` opens the login page);
- email confirmation and "resend confirmation";
- the admin's "Reset Password" link that the admin copies and sends by hand — use **Resend link**
  or "Forgot password?" instead;
- inviting an unknown email to a team ("invite anyway"): only the admin creates accounts, a team
  invitation goes to an existing account only.

An account without a password cannot sign in and so cannot create an API key for the hook.

**Email limit.** Each client IP can trigger at most **20 emails per hour** in total through
"Forgot password?", **+ Create user** and **Resend link**; above that the server answers `429`
with `Retry-After`. The limit is fixed (not configurable), counted in memory per worker process
and applies only in this mode. Behind a reverse proxy set `TRUST_PROXY` so the real client IP is
counted.

**Switching.** The email is the identity, so you can switch from another mode to
`strict-managed` and back without a data migration. Users who already have a password keep
signing in with it; new people get an account only from the admin. Accounts without a password (for
example those created by Entra ID sign-in in Mode 4) set one through "Forgot password?" or a
**Resend link** from the admin. Accounts that set
their password through a link count as confirmed, so a later switch to Mode 3 does not lock them
out.
