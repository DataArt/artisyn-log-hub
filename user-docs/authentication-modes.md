# Authentication modes

`AUTH_MODE` selects how people sign in to the web app. There are five modes:

| Value | Mode | Use it for |
|---|---|---|
| `none` | Mode 1, no password | One user on their own machine. A caller types an email and is signed in as that user, without verification. Only local callers are accepted (localhost and, in a container, the container's default gateway, plus any address listed in `AUTH_NONE_TRUSTED_PEERS` — the installer adds the one a runtime such as Rancher Desktop uses). **Never** for a shared or network-reachable installation. |
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
account. The admin page shows it as "Strict managed — admin-created accounts only (Mode 5)".
To install a server in this mode step by step, see
[Setup where only the admin creates accounts](admin-managed-setup.md).

**Required settings** — the server does not start without them:

| Variable | Value |
|---|---|
| `PUBLIC_BASE_URL` | The address people open, for example `https://loghub.internal`. Every way in is an emailed link built from it, so it is required in every environment, not only in production. |
| `ADMIN_CONTACT_EMAIL` | The email address of the first admin. The login page names it as the person who creates accounts. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM` | The mail relay. It must be reachable when the app starts. `SMTP_USER`, `SMTP_PASSWORD` and `SMTP_SECURE` are optional, as in Mode 3. |

`ALLOWED_EMAIL_DOMAINS` is optional: when set, the admin can create accounts, and rename an
account's email, only for those domains (the `ADMIN_CONTACT_EMAIL` account itself is not checked).

**The first admin.** On the first start the app creates an account for `ADMIN_CONTACT_EMAIL`
with the `admin` role and no password, and emails it a set-password link. If that email cannot be
sent, the app does not start and changes nothing — fix the SMTP settings and start it again.
Later starts send no email. If that address already has an **admin** account, nothing happens.
If it has a non-admin account (for example a sign-up from another mode, which anyone could have
made with that address), the account becomes the admin only through the mailbox: its password,
sessions and API keys are cleared and the same set-password email is sent.

**The admin creates every other account.** In **Admin Panel → Users → + Create user** the admin
enters an email, a role (User or Admin) and optionally a team. The person gets an email with a
set-password link and sets a password on a page titled "Set your password"; the page shows the
password rules before the first try, and a password that breaks them does not use the link up.
Until the password is set the **Password** column shows `Not set` and the admin can
**Resend link**, which makes the earlier links stop working. **Resend link** becomes available 60
seconds after the previous link (from **+ Create user** or a resend); the button counts down, also
after a page reload. Users created by a repository import show `Imported`: they are placeholders,
not accounts, and get no link — create a real account for that email instead.

**Links:**

| Link | Valid for |
|---|---|
| Set-password link (first admin, created account, resend) | 24 hours, works once |
| "Forgot password?" link | 1 hour, works once |

A used or expired link shows "This link is invalid or has expired". The page then points to
"Forgot password?". Using any link makes the account's other outstanding links stop working and
signs the account out everywhere. Renaming an account's email (**Admin Panel → Users**) makes the
links already sent to the old address stop working and clears the password: the person sets a new
one through **Resend link** or "Forgot password?" at the new address. An admin cannot change
their own email in this mode — another admin does it.

**"Forgot password?" works for every account**, including one whose owner has not set a password
yet (that person gets a "Set your Log Hub password" email) — so a person whose set-password link
expired can get a new one without the admin. It answers the same for every address and never
cancels a link the admin sent. Within 60 seconds of the previous link for the same account (from
"Forgot password?" or from the admin) it sends nothing new — the earlier email is the one to use.

**Every account must prove its email.** An account signs in only after it has used a link mailed
to it. An account that never did — for example a sign-up left unconfirmed in Mode 3, or one from
Mode 2 — is refused with "This account has to verify its email first" (its old sessions end
too); "Forgot password?" sends it a link that verifies it.

**What is off in this mode:**

- the sign-up page and its link on the login page (`#/signup` and confirmation links open the
  login page);
- email confirmation and "resend confirmation";
- the admin's "Reset Password" link that the admin copies and sends by hand — use **Resend link**
  or "Forgot password?" instead;
- adding an email without an account to a team ("add them anyway"), on both the **Members** and
  the **Invitations** tab: only the admin creates accounts, a team invitation goes to an existing
  account only.

An account without a password cannot sign in and so cannot create an API key for the hook.

**Email limits.** "Forgot password?" accepts at most **20 requests per client IP per hour**; each
admin can send at most **100 emails per hour** through **+ Create user** and **Resend link**. Above
that the server answers `429` with `Retry-After`. The limits are fixed (not configurable), shared
by all worker processes and apply only in this mode. Behind a reverse proxy set `TRUST_PROXY` to
the number of proxies (for example `1`) or to their addresses, so the real client IP is counted —
`true` trusts any `X-Forwarded-For` value a client sends.

**Switching.** The email is the identity, so you can switch from another mode to
`strict-managed` and back without a data migration. Users who already have a password and a
confirmed email keep signing in with it; others first verify their email through "Forgot
password?" (see above). New people get an account only from the admin. Accounts without a
password (for example those created by Entra ID sign-in in Mode 4) set one through "Forgot
password?" or a **Resend link** from the admin. Accounts that set their password through a link
count as confirmed, so a later switch to Mode 3 does not lock them out.
