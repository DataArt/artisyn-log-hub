# Authentication modes

`AUTH_MODE` selects how people sign in to the web app. There are four modes:

| Value | Mode | Use it for |
|---|---|---|
| `none` | Mode 1, no password | One user on their own machine. A caller types an email and is signed in as that user, without verification. Only local callers are accepted (localhost and, in a container, the container's default gateway). **Never** for a shared or network-reachable installation. |
| `password` | Mode 2, email and password | A small team on a trusted network. SMTP is optional; without it password reset is unavailable. |
| `password-confirm` | Mode 3, email, password and emailed confirmation | Anything reachable from the internet. An account is usable only after an emailed confirmation link. Needs SMTP: the app refuses to start without a reachable relay. |
| `azure-oauth` | Mode 4, Azure Entra ID sign-in | Organisations on Microsoft Entra ID, single tenant. No local passwords. Recommended for organisations that use Entra ID. |

- In every mode the first user to sign in becomes the admin — see
  [Check that you are the admin](install-server.md#check-that-you-are-the-admin).
- An unset `AUTH_MODE` means `password`. The release install sets `none`.
- An unrecognised value, or a mode whose required settings are missing, stops the server at
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
