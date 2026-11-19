# Setup where only the admin creates accounts

> "Nobody should be able to sign up on their own. I want to decide who gets an account, and I
> don't want to send anyone a password."

That is the `strict-managed` sign-in mode. This page installs a Log Hub server in that mode from
scratch, in about 20 minutes, and covers switching an existing server to it. How the mode behaves
in detail — links, limits, what is off — is in
[Strict managed](authentication-modes.md#strict-managed-admin-provisioned-users).

How it works, in short:

- there is no sign-up page; the **first admin** is the address you put in the configuration, and
  on its first start the server emails that address a link to set a password;
- the admin creates every other account in **Admin Panel → Users → + Create user**; each person
  gets an email with a link and chooses their own password;
- **no password is ever sent by email** — only one-time links: 24 hours for a link the admin sends,
  1 hour for "Forgot password?";
- every account must prove its mailbox (use a link mailed to it) before it can sign in.

## What you need

| | |
|---|---|
| A server | A Linux VM with Docker Engine and the Compose v2 plugin, as in [Install the server](install-server.md). |
| An address people open | For example `https://loghub.internal`. Every link in every email is built from it, so it must be the exact address people type into the browser. |
| An SMTP relay | Reachable from the VM **when the app starts** — without a working relay the app does not start in this mode. Port and sender address; a user and password only if your relay asks for them. |
| Your own mailbox | The address that becomes the first admin. You must be able to read its mail. |

## 1. Install the server

Run the one-command install on the VM:

```sh
curl -fsSL https://github.com/DataArt/artisyn-log-hub/releases/latest/download/install.sh | sh
cd ~/artisyn-log-hub
```

It creates `~/artisyn-log-hub` with `docker-compose.yml` and a `.env` that already holds a random
`POSTGRES_PASSWORD` and `SESSION_SECRET`. Other ways to install: [Install the server](install-server.md).

## 2. Write the `.env`

Edit `~/artisyn-log-hub/.env`. Keep the generated `POSTGRES_PASSWORD` and `SESSION_SECRET`, and
set the sign-in part. Behind a TLS reverse proxy (recommended):

```dotenv
LOG_HUB_DATA_DIR=./loghub-db
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<keep the generated value>
POSTGRES_DB=a-log
SESSION_SECRET=<keep the generated value>
NODE_ENV=production

AUTH_MODE=strict-managed
# The address people open; every emailed link is built from it.
PUBLIC_BASE_URL=https://loghub.internal
# One proxy in front of the app: its X-Forwarded-For and X-Forwarded-Proto are trusted.
TRUST_PROXY=1
PASSWORD_POLICY=long
# Optional: the admin can create accounts only for these domains.
ALLOWED_EMAIL_DOMAINS=example.com

# This address becomes the first admin and gets the first set-password email.
ADMIN_CONTACT_EMAIL=you@example.com

# Required: the relay must be reachable when the app starts.
SMTP_HOST=smtp.internal
SMTP_PORT=587
SMTP_FROM=loghub@example.com
#SMTP_USER=
#SMTP_PASSWORD=
#SMTP_SECURE=false
```

Inside a company network you can start on plain `http://` instead: set
`PUBLIC_BASE_URL=http://10.0.0.15:5003` (your VM's address), `COOKIE_SECURE=false`, drop
`TRUST_PROXY`, and open the port as in
[Quick setup for a small team](small-team-setup.md#4-open-the-port-plain-http-only). Passwords
then travel unencrypted on your network — add HTTPS later as in
[Add HTTPS](small-team-setup.md#5-add-https-recommended), and change `PUBLIC_BASE_URL` with it.

Notes on the values:

- `TRUST_PROXY=1` means "one proxy". Do not use `true`: it trusts any `X-Forwarded-For` a client
  sends, and the per-IP limits then count whatever IP a client claims.
- `PASSWORD_POLICY=long` asks for 14+ characters with a digit, punctuation, upper- and lowercase
  letters; `mid` is 10+ with a digit. The set-password page shows the rule before the first try.
- `ALLOWED_EMAIL_DOMAINS` is comma-separated, without `@`. It does not apply to
  `ADMIN_CONTACT_EMAIL`.
- Every variable is described in [Server settings](server-configuration.md) and
  [Security hardening](security-hardening.md#10-configuration-reference).

## 3. Start it and watch the first start

```sh
docker compose up -d
docker compose logs -f app
```

On the first start the server creates your admin account and emails it. Look for:

```text
Strict-managed bootstrap: created admin y***@example.com, set-password link emailed
```

Later starts print nothing like it and send no email. If the app stops instead, the log says why:

| The log says | Fix |
|---|---|
| `PUBLIC_BASE_URL environment variable is required for AUTH_MODE=strict-managed …` or `… must be an absolute http(s) URL` | Set `PUBLIC_BASE_URL` to the full address, with `https://` or `http://`. |
| `ADMIN_CONTACT_EMAIL environment variable is required …` / `… must be a valid email address` | Set `ADMIN_CONTACT_EMAIL` to your address. |
| `SMTP relay <host>:<port> is unreachable; AUTH_MODE=strict-managed requires a working relay` | Check `SMTP_HOST` / `SMTP_PORT` and that the VM can reach the relay (firewall, VPN). |
| `Strict-managed bootstrap: the set-password email to … could not be sent (…)` | The relay refused the email — check `SMTP_FROM`, `SMTP_USER` / `SMTP_PASSWORD`, `SMTP_SECURE`. Nothing was created; the next start tries again. |

After a fix, run `docker compose up -d` again.

How the first start works:

```text diagram=admin-managed-first-start
 Server start                    Database                 SMTP relay          You
     │ AUTH_MODE=strict-managed      │                         │                │
     │ check PUBLIC_BASE_URL,        │                         │                │
     │ ADMIN_CONTACT_EMAIL, SMTP     │                         │                │
     ├──────────────────────────────►│ an admin with that      │                │
     │                               │ address already?        │                │
     │◄──────────────────────────────┤ yes → done, no email    │                │
     │                               │ no → create the admin   │                │
     │                               │ account (or clear an    │                │
     │                               │ existing non-admin one),│                │
     │                               │ no password             │                │
     ├───────────────────────────────┼────────────────────────►│ set-password   │
     │                               │                         ├───────────────►│ email (24 h)
     │ email failed → undo, refuse to start                    │                │
```

## 4. Set your admin password

Open the email "Set your Log Hub administrator password" and its link. The page is titled "Set
your password" and shows the password rule. Choose a password; the page confirms it, and
**Go to log in** takes you to the login page.

- The link works once and for 24 hours. A password that breaks the rule does not use it up.
- Link lost or expired? Use **Forgot password?** on the login page with the same address — it
  sends a new link (valid 1 hour).
- Then open **Admin Panel → Users**: your account has the `admin` role. The **Auth** tab shows
  "Strict managed — admin-created accounts only (Mode 5)".

## 5. Create the accounts

In **Admin Panel → Users → + Create user** enter the person's email, the role (User or Admin) and,
optionally, a team they join right away. They get "Set your Log Hub password" with a 24-hour link.

```text diagram=small-team-admin-provisioned
 Admin              Log Hub                  SMTP relay             Teammate
   │ create user       │                         │                     │
   │ (email, role,     │                         │                     │
   │ team)             │                         │                     │
   ├──────────────────►│ check ALLOWED_EMAIL_DOMAINS                   │
   │                   │ create account, no password                   │
   │                   ├────────────────────────►│ set-password email  │
   │                   │                         ├────────────────────►│
   │                   │                         │ link = PUBLIC_BASE_URL/…
   │                   │                         │ (24 h, works once)  │
   │                   │◄──────────────────────────────────────────────┤ open the link,
   │                   │                         │                     │ set password
   │                   │◄──────────────────────────────────────────────┤ sign in
```

In the users list:

- the **Password** column shows `Not set` until the person has chosen a password, `Set` after,
  and `Imported` for a user a repository import created (a placeholder, not an account — create a
  real account for that email instead);
- **Resend link** (only for `Not set`) emails a new 24-hour link and makes the earlier ones stop
  working; it becomes available 60 seconds after the previous link and counts down;
- **Rename Email** fixes a mistyped address: links sent to the old address stop working and the
  password is cleared, so send a new link with **Resend link**. You cannot rename your own email in
  this mode — another admin does it;
- each admin can send at most 100 emails per hour this way.

Teams: an email without an account cannot be added to a team or invited ("create it in Admin
Panel → Users first"). Create the account, then add the person.

## 6. Connect the developer machines

Each person signs in, creates an API key and installs the hook in their repositories — the same
as in any other mode: [Quick setup for a small team](small-team-setup.md#7-connect-the-developer-machines)
and [Install the hook](../hook/INSTALL_HOOK.md). An account without a password cannot sign in, so
it cannot create an API key either.

## Switching an existing server to this mode

The email is the identity in every mode, so switching is a change of the `.env` and a restart, with
no data migration. Before you switch:

1. **Set `ADMIN_CONTACT_EMAIL` to an address you read.** If that address already belongs to an
   admin account, nothing changes for it. If it belongs to a non-admin account — for example one
   anybody could have signed up with in Mode 2 — that account's password, sessions and API keys
   are cleared, it becomes the admin, and the set-password email goes to the address. So only the
   mailbox owner gets the admin role.
2. **Tell your users.** In this mode every account must have proven its mailbox. Accounts that
   never used a link mailed to them — Mode 2 accounts, Mode 3 sign-ups that were never confirmed,
   Mode 1 and Entra ID accounts — are refused at sign-in with "This account has to verify its
   email first", and their open sessions end. Each person uses **Forgot password?** once: the
   link verifies the address and sets a new password. Hooks keep uploading with their existing
   API keys meanwhile.
3. Add the SMTP and `PUBLIC_BASE_URL` settings of step 2 and restart with
   `docker compose up -d`; watch the log as in step 3.

Switching back to Mode 2 or 3 later needs nothing special: accounts that set their password
through a link count as confirmed, so Mode 3 lets them in.

## If something goes wrong

| Symptom | What to do |
|---|---|
| A person never got the email | Check spam, then **Resend link** (after 60 seconds). If no email arrives at all, check the relay with the log: `docker compose logs app \| grep -i mail`. |
| "This link is invalid or has expired" | The link was used, replaced by a newer one, or is older than 24 hours (1 hour for "Forgot password?"). Use the newest email, ask the admin for **Resend link**, or use **Forgot password?**. |
| "Forgot password?" says the link was sent, but nothing arrives | Within 60 seconds of the previous link for that account nothing new is sent — use the earlier email. The page answers the same for every address on purpose. |
| "Too many requests from your network" on "Forgot password?" | 20 requests per IP per hour; wait the time shown. Behind a proxy, check that `TRUST_PROXY` is set, or every user shares the proxy's IP. |
| "This account has to verify its email first" | The account has not proven its mailbox yet (see Switching above): **Forgot password?**. |
| The admin cannot sign in at all | Use **Forgot password?** with `ADMIN_CONTACT_EMAIL`. If that mailbox is lost, another admin can help; there is no password in the configuration to fall back to. |

## Checklist

- [ ] `AUTH_MODE=strict-managed`, `PUBLIC_BASE_URL` (the exact address people open),
      `ADMIN_CONTACT_EMAIL` (a mailbox you read) and `SMTP_*` are set.
- [ ] Behind a proxy: `TRUST_PROXY=1` (or the proxy's IP), not `true`.
- [ ] The log shows "Strict-managed bootstrap: created admin …" on the first start.
- [ ] You set your password from the email and see the `admin` role in **Admin Panel → Users**.
- [ ] Each teammate's account is created in **+ Create user**; the **Password** column turns `Set`
      once they have chosen a password.
- [ ] When switching an existing server: users were told to use **Forgot password?** once.
