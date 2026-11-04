# Quick setup for a small team

> "I have a small team of three people and a VM inside our company network (behind the VPN), and
> I want the whole team to use Log Hub. How do I install and set it up quickly?"

This page answers exactly that, in about 15 minutes. It assumes:

- one Linux VM in your company network with Docker Engine and the Compose v2 plugin, and normal
  outbound internet access;
- your teammates reach the VM from the office network or over the company VPN, by an internal IP
  or name (here `10.0.0.15` and `loghub.internal` — replace them with yours);
- the server is **not** reachable from the internet.

You will pick one of two sign-in modes:

| | Mode 2 — `password` | Mode 3 — `password-confirm` |
|---|---|---|
| Sign-in | email + password | email + password, account active only after an emailed link |
| Needs an SMTP relay | no (without it there is no "Forgot password?") | **yes**, reachable from the VM at startup |
| Good for | a few people who trust each other, no mail relay at hand | a team with an internal mail relay, or a server more people can reach |

If you are not sure, start with Mode 2. Switching later is one line in `.env` — the email is the
identity in every mode, so no data migration is needed
([Authentication modes](authentication-modes.md)).

## 1. Install the server on the VM

Run the one-command install:

```sh
curl -fsSL https://github.com/DataArt/artisyn-log-hub/releases/latest/download/install.sh | sh
cd ~/artisyn-log-hub
```

It creates `~/artisyn-log-hub` with `docker-compose.yml` and a `.env` that already holds a random
`POSTGRES_PASSWORD` and `SESSION_SECRET`, and starts the app in Mode 1 on `127.0.0.1:5003`.
Details: [Install the server](install-server.md).

## 2. Decide on `http` or `https`

Inside the company network plain `http://` works, and it is the quickest start. Know what it
means:

- **Passwords, session cookies, the hook's API key and the session transcripts** (prompts, code,
  tool output) travel unencrypted between the developer machine and the VM. The VPN encrypts only
  the tunnel to the company network; inside it, anyone on the network path to the VM can read
  them.
- The hook accepts a non-local `http://` server URL, and the installer is downloaded from that
  same URL — both without encryption ([accepted risks](security-hardening.md#112-hook-and-installer-developer-machines)).

**Recommended:** `http://` is fine to try things out; for daily use put a TLS-terminating reverse
proxy in front of the app (section 5) and give the team the `https://` address. The `.env`
examples below come in both variants — the differences are `PUBLIC_BASE_URL`, `TRUST_PROXY`
and `COOKIE_SECURE`.

| Setting | `http://` direct | `https://` behind a proxy |
|---|---|---|
| `PUBLIC_BASE_URL` | `http://10.0.0.15:5003` | `https://loghub.internal` |
| `COOKIE_SECURE` | `false` — otherwise the browser drops the session cookie and sign-in loops | ignored (follows the proxy) |
| `TRUST_PROXY` | `false` | `1` (one proxy hop) |
| `ports:` in `docker-compose.yml` | `"10.0.0.15:5003:3000"` | keep `"127.0.0.1:5003:3000"` when the proxy runs on the same VM |

`PUBLIC_BASE_URL` must be exactly the address your teammates type in the browser: it is used in
emailed links, and in production Modes 2 and 3 refuse to start without it.

## 3. Write the `.env`

Open `.env` in the install directory, keep your generated `POSTGRES_PASSWORD` and
`SESSION_SECRET` lines, and make the rest look like one of the examples below.

### Mode 2, plain `http://`

```dotenv
LOG_HUB_DATA_DIR=./loghub-db
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<keep the generated value>
POSTGRES_DB=a-log
SESSION_SECRET=<keep the generated value>
NODE_ENV=production

AUTH_MODE=password
PUBLIC_BASE_URL=http://10.0.0.15:5003
COOKIE_SECURE=false
TRUST_PROXY=false
PASSWORD_POLICY=long
```

### Mode 2, `https://` behind a reverse proxy, with an optional mail relay

```dotenv
LOG_HUB_DATA_DIR=./loghub-db
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<keep the generated value>
POSTGRES_DB=a-log
SESSION_SECRET=<keep the generated value>
NODE_ENV=production

AUTH_MODE=password
PUBLIC_BASE_URL=https://loghub.internal
TRUST_PROXY=1
PASSWORD_POLICY=long

# Optional in Mode 2: with SMTP_HOST set, "Forgot password?" works.
# Remove these lines to run without mail.
SMTP_HOST=smtp.internal
SMTP_PORT=587
SMTP_FROM=loghub@example.com
ADMIN_CONTACT_EMAIL=you@example.com
```

### Mode 3, plain `http://`

```dotenv
LOG_HUB_DATA_DIR=./loghub-db
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<keep the generated value>
POSTGRES_DB=a-log
SESSION_SECRET=<keep the generated value>
NODE_ENV=production

AUTH_MODE=password-confirm
PUBLIC_BASE_URL=http://10.0.0.15:5003
COOKIE_SECURE=false
TRUST_PROXY=false
PASSWORD_POLICY=long
ALLOWED_EMAIL_DOMAINS=example.com

# Required in Mode 3: the relay must be reachable when the app starts.
SMTP_HOST=smtp.internal
SMTP_PORT=587
SMTP_FROM=loghub@example.com
#SMTP_USER=
#SMTP_PASSWORD=
#SMTP_SECURE=false
ADMIN_CONTACT_EMAIL=you@example.com
```

### Mode 3, `https://` behind a reverse proxy

```dotenv
LOG_HUB_DATA_DIR=./loghub-db
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<keep the generated value>
POSTGRES_DB=a-log
SESSION_SECRET=<keep the generated value>
NODE_ENV=production

AUTH_MODE=password-confirm
PUBLIC_BASE_URL=https://loghub.internal
TRUST_PROXY=1
PASSWORD_POLICY=long
ALLOWED_EMAIL_DOMAINS=example.com

SMTP_HOST=smtp.internal
SMTP_PORT=587
SMTP_FROM=loghub@example.com
#SMTP_USER=
#SMTP_PASSWORD=
#SMTP_SECURE=false
ADMIN_CONTACT_EMAIL=you@example.com
```

Notes on the values:

- `ALLOWED_EMAIL_DOMAINS` is your company's mail domain(s), comma-separated, without `@`.
- `PASSWORD_POLICY=long` asks for 14+ characters with a digit, punctuation, upper- and lowercase
  letters; `mid` is 10+ with a digit.
- Every variable is described in [Server settings](server-configuration.md) and
  [Security Hardening & Configuration](security-hardening.md#10-configuration-reference).

## 4. Open the port (plain `http://` only)

The app is published on `127.0.0.1:5003`, so nobody else can reach it yet. In
`docker-compose.yml`, change the `ports:` line of the `app` service to the VM's internal
address:

```yaml
    ports:
      - "10.0.0.15:5003:3000"
```

Change `AUTH_MODE` **before** you widen this mapping — Mode 1 with an open port lets anyone in as
any user ([why](authentication-modes.md)). Do not publish the `db` service.

The installer replaces `docker-compose.yml` on every upgrade (the old one stays as
`docker-compose.yml.prev`), so re-apply this line after each upgrade.

Then start the app and watch it come up:

```sh
docker compose up -d
docker compose logs -f app
```

If it stops at startup, the log names the missing or wrong setting (for example no
`PUBLIC_BASE_URL`, or an SMTP relay it cannot reach in Mode 3).

## 5. Add HTTPS (recommended)

Skip this section if you stay on plain `http://`. Run a reverse proxy on the same VM, keep the
app on `127.0.0.1:5003`, and use the `https://` `.env` from section 3. You need a certificate for
`loghub.internal` — from your company's internal CA, or any certificate your machines trust.

A minimal nginx server block:

```nginx
server {
    listen 443 ssl;
    server_name loghub.internal;

    ssl_certificate     /etc/nginx/certs/loghub.internal.crt;
    ssl_certificate_key /etc/nginx/certs/loghub.internal.key;

    # Hook uploads come in chunks of ~900 KB; repository imports can be large.
    client_max_body_size 5g;

    location / {
        proxy_pass http://127.0.0.1:5003;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;
    }
}
```

Two things to check when the certificate comes from an **internal CA**:

- browsers on the developer machines must trust that CA (usually already done by your IT);
- the hook and its installer run on Node.js, which uses its own CA list. If `npx` or the hook
  fails with a certificate error, point Node at your CA in the developer's environment:
  `NODE_EXTRA_CA_CERTS=/path/to/company-ca.pem` (set it where Claude Code is started from, e.g.
  the shell profile, so the hook inherits it).

More on the proxy (HSTS, body limits, `TRUST_PROXY` values): [Security Hardening §4](security-hardening.md#4-network-exposure-and-tls).

## 6. Become the admin, then invite the team

1. **Before you tell anyone the address**, open it yourself and sign up. The first account
   becomes the admin; there is no setup token. In Mode 3, confirm the email first, then sign in.
2. Open **Admin Panel → Users** and check that your account has the `admin` role. If someone
   was faster, see [Check that you are the admin](install-server.md#check-that-you-are-the-admin).
3. Send the address to your teammates. Each one signs up with their work email (Mode 3: and
   confirms it).
4. Optional: create a team and add your repositories to it — see
   [Team repositories](session-list.md#team-repositories). Repositories are private to their
   owner until shared through a team.

Forgotten passwords:

- **Mode 3, or Mode 2 with SMTP** — "Forgot password?" on the login page sends a reset link.
- **Mode 2 without SMTP** — the button is disabled. You, as admin, open **Admin Panel → Users**,
  generate a password reset link for that user and send it to them yourself.

## 7. Connect the developer machines

Each teammate, on their own machine:

1. Signs in and opens **My API Keys → Install**. The **Full Auto Install** card generates a
   one-liner with your server address and a fresh API key already filled in, for example:

   ```sh
   npx "https://loghub.internal/static/artisyn-hooks-installer.tgz" install --server-url "https://loghub.internal" --api-key "<generated key>"
   ```

   The installer is downloaded from your Log Hub server. The developer machine needs Node.js,
   git and Claude Code.
2. Runs it in the root of each git repository they want to record. (The key ends up in shell
   history; on a shared machine use the plain install command from the same tab and put
   `serverUrl` and `apiKey` into `.artisyn/config/log-hub.local.json` by hand instead.)
3. Restarts Claude Code and runs a session, then opens Log Hub: the repository and the session
   appear on the Home page.

Details and troubleshooting: [Install the hook](../hook/INSTALL_HOOK.md) and
[Connecting a Repository](connect-repository.md).

If you later move from `http://` to `https://`, each teammate re-runs the Full Auto Install
one-liner copied from the new address: its `--server-url` points the hook at the new server, and
the installer asks to confirm the destination change.

## Checklist

- [ ] `AUTH_MODE` is `password` or `password-confirm` — never `none` on a shared server.
- [ ] `PUBLIC_BASE_URL` is the exact address the team opens.
- [ ] `http://`: `COOKIE_SECURE=false`, port published on the VM's internal address.
- [ ] `https://`: `TRUST_PROXY=1`, app port stays on `127.0.0.1`.
- [ ] You are the admin (Admin Panel → Users).
- [ ] `.env` is `chmod 600`, and `loghub-db/` plus `.env` are in your backups
  ([Backup and recovery](security-hardening.md#9-backup-and-recovery)).
- [ ] After every upgrade: the `ports:` line is re-applied.
