---
type: "Reference"
title: "Deployment Auth Mode — running a shared instance on azure-oauth"
description: "Why a shared deployment that uses AUTH_MODE=azure-oauth (Mode 4) must not fall back to another mode, how the AZURE_* variables reach the container, how to verify the live mode, and the gitignored local SSO reference folder."
tags:
  - auth
  - azure
  - deployment
timestamp: "2026-10-14T18:00:00+04:00"
---

# Deployment Auth Mode — running a shared instance on `azure-oauth`

A shared, network-reachable deployment that signs users in with Azure Entra ID runs
`AUTH_MODE=azure-oauth` (Mode 4). How the Azure app registration, hosts and CI pipeline of a given
installation are set up is outside this repo; this article covers only what the app itself requires.
Local development may run any mode (see `authorization-and-authentificaiton.md`).

## Never switch a deployed instance to another mode to work around a login failure

A broken Azure sign-in is an Azure-side or config-side problem. Switching the instance to another
mode is not a smaller fix — it is a different product, and it does not actually restore access:

- **Mode 2/3 (`password`, `password-confirm`) can't let existing users in.**
  `users.password_hash` is `NULL` for every account auto-provisioned by an Azure login
  (`users.service.ts` → `create(email, null, role)`), so those users have no credentials to log in
  with. Recovery would require `forgot-password`, which needs SMTP; `docker-compose.prod.yml` sets no
  SMTP variables (Mode 4 never sends email), so the reset mail would not be delivered. Mode 3
  additionally refuses to start without `ADMIN_CONTACT_EMAIL`/`SMTP_HOST`/`SMTP_PORT`/`SMTP_FROM`.
- **Mode 1 (`none`) is unusable on any remote host.** `POST /api/v1/auth/identify` is gated to
  `127.0.0.1`/`::1` via `isLocalhostRequest()` (`server/src/auth/utils/localhost.util.ts`) and 403s
  every non-local caller — and if it *weren't* gated, it would mean anyone could sign in as anyone.

`users.email` is the identity key in every mode, so switching modes never needs a data migration —
which makes switching look cheap. It isn't; see above.

## How the variables reach the container

- `AUTH_MODE` reaches the container via `docker-compose.yml`'s `environment: AUTH_MODE: ${AUTH_MODE}`.
- `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` / `AZURE_REDIRECT_URI` /
  `AZURE_SCOPES` are passed through by the per-environment overlay (`docker-compose.dev.yml`,
  `docker-compose.prod.yml`). Supply them from the deploy pipeline's secret store, never from the
  repo. `AZURE_REDIRECT_URI` is `https://<public host>/api/auth/callback`.
- Compose `environment:` entries **override** `env_file: .env`, and an unset `${VAR}` resolves to an
  empty string rather than falling back — so a variable missing from the pipeline blanks out whatever
  the deploy host's own `.env` held. An empty `AZURE_SCOPES` is a hard startup failure by design
  (`validateMode4()` in `server/src/auth/config/auth-startup-validation.ts`), distinct from unset,
  which defaults to `openid profile email`.

## Local SSO reference folder

Each developer who works with Azure SSO keeps the real values of their App Registrations in a local
folder, `docs/login-sso-data/`. It is gitignored by `.gitignore` (`/docs/login-sso-data/`), it is
per-developer, and it is never committed. Do not add a `.gitkeep`, a README or any other tracked file
there, and do not paste its values into docs or issues.

What goes there:

- One `env.<environment>` file per Azure App Registration (for example `env.local`, `env.dev`,
  `env.prod`). It holds that registration's values under the names the server reads:
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_REDIRECT_URI`
  (`https://<public host>/api/auth/callback`), and optionally `AZURE_SCOPES` and `AZURE_AUTHORITY`,
  as listed in `server/.env.example` (the "Azure Entra ID (Mode 4 — azure-oauth)" block).
- Optional screenshots of the registration's *Authentication* and *API permissions* pages, for
  reference.

How the values are used:

- **Local Mode 4 run:** copy them into `server/.env.local`. That file is not committed and overrides
  `server/.env` (`server/src/app.module.ts` loads it with `override: true`). Also set
  `AUTH_MODE=azure-oauth`. A local-run file (`env.local`) can carry `AUTH_MODE=azure-oauth` and
  `SESSION_SECRET` as well, so it can be pasted into `server/.env.local` as is.
- **Deployed environment:** put them in the deploy pipeline's secret store, as described in
  [How the variables reach the container](#how-the-variables-reach-the-container).

Variable names in these files must be the ones the server reads (`AZURE_*`, `AUTH_MODE`,
`SESSION_SECRET`). The old OIDC names (`AUTH_ISSUER`, `AUTH_CLIENT_*`, `AUTH_SCOPE`/`AUTH_SCOPES`,
`AUTH_SESSION_*`) are not read.

## Verifying the live mode

`GET /api/v1/auth/config` is unauthenticated in every mode and reports the effective mode plus the
non-secret Azure config, so it shows what the running container actually has — no host shell needed:

```sh
curl -s https://<public host>/api/v1/auth/config
# {"mode":"azure-oauth","azure":{"authority":"…/<tenant id>/v2.0","clientId":"<client id>",
#  "redirectUri":"https://<public host>/api/auth/callback"}}
```

If `mode` is anything other than `azure-oauth` on an instance meant to use Azure SSO, that instance is
misconfigured.

## When Azure sign-in fails

Fix it in Azure or in the deploy config — never by changing the mode. Two field notes:

- `AADSTS50011 … redirect URI … does not match` can show up **intermittently**: rejected, then the
  identical `client_id` + `redirect_uri` pair accepted hours later with no deploy and no Portal edit.
  Before changing anything, confirm with the config endpoint above that the pair hasn't moved, and
  retry ~30 minutes later.
- The Azure Portal's *Authentication (Preview)* list is **not** authoritative about what is
  registered — a callback can be accepted by Entra while absent from that view. Read
  **Manage → Manifest** (`web.redirectUris` / `spa.redirectUris` / `publicClient.redirectUris`)
  instead. A URI registered under `spa.redirectUris` rather than `web.redirectUris` is the wrong
  platform for this app's confidential-client exchange (`@azure/msal-node` + `client_secret`) and a
  plausible source of that intermittency.

See `authorization-and-authentificaiton.md` for what the four `AUTH_MODE` values are and how per-mode
route gating works.
