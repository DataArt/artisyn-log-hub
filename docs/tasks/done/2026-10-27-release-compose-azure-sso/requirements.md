# 2026-10-27: Release Compose Supports Azure SSO

**Status:** todo
**Priority:** high
**Type:** feature
**Module(s):** release-template
**Owner:** denis.tsyplakov
**Created:** 2026-10-27
**Tracker:** GH-37 https://github.com/DataArt/artisyn-log-hub/issues/37

## Description

Release docker-compose (release-template/) must support AUTH_MODE=azure-oauth (DataArt SSO via
Azure Entra ID): pass AZURE_TENANT_ID/AZURE_CLIENT_ID/AZURE_CLIENT_SECRET/AZURE_REDIRECT_URI/
AZURE_SCOPES/AZURE_AUTHORITY into the app container, document them in .env.example and release
README; keep backward compatibility for existing .env files. Verify the container starts in
azure-oauth mode and /api/v1/auth/config reports it.

Today the release `docker-compose.yml` lists every app variable explicitly under `environment:` and
has no `env_file:`, so `AZURE_*` values put into `.env` never reach the container and
`AUTH_MODE=azure-oauth` fails startup validation (`validateMode4()`). An Azure App Registration
already exists; only the release packaging is missing.

## Functional Requirements

- The release `docker-compose.yml` passes `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
  `AZURE_CLIENT_SECRET`, `AZURE_REDIRECT_URI`, `AZURE_SCOPES` and `AZURE_AUTHORITY` to the `app`
  service.
- An unset `AZURE_SCOPES` / `AZURE_AUTHORITY` must stay unset in the container (not an empty
  string) so the server defaults apply — `AZURE_SCOPES=""` is a hard startup failure.
- An existing `.env` without any `AZURE_*` lines keeps working unchanged in modes none/password/
  password-confirm.
- `.env.example` documents the Azure block (commented out) and the redirect URI shape
  (`<base url>/api/auth/callback`, e.g. `http://localhost:5003/api/auth/callback`).
- The release install docs mention how to switch an install to `azure-oauth`.
- The Azure callback passes the session's expected `nonce` to `acquireTokenByCode`: msal-node 7
  rejects every ID token that carries a nonce when none is supplied (`nonce_mismatch`), so Mode 4
  sign-in could never complete.

## Acceptance Criteria

- [x] With `AUTH_MODE=azure-oauth` and the four required `AZURE_*` values in `.env`, the release
      stack starts and `GET /api/v1/auth/config` returns `"mode":"azure-oauth"` with the configured
      client id and redirect URI.
- [x] With the default installer `.env` (no `AZURE_*`), the stack starts in `none` mode as before.
- [x] `AZURE_SCOPES` left unset does not break startup.
- [x] `.env.example` and the release docs describe the Azure settings.
- [x] A real Microsoft sign-in on the release-compose stand ends logged in (no `nonce_mismatch`).

## Notes

<!-- Append timestamped notes here as work progresses -->

**2026-10-27:** Verified on an isolated compose project built from `release-template/` with the
`local-20261026-220722` image and the local App Registration (port 3000, matching its registered
redirect URI): `/api/v1/auth/config` reports `azure-oauth`, the container gets
`AZURE_SCOPES=openid profile email` when `.env` omits it, and "Sign in with Microsoft" reaches the
tenant's sign-in page with no AADSTS error. A `.env` without `AZURE_*` still starts in `none`.
The interactive Microsoft login itself (credentials + MFA) is left to a human.

**2026-10-27:** The human login failed with "Sign in with Microsoft failed": the server log showed
`Azure token exchange failed … nonce_mismatch` (MSAL `ClientAuthError`). msal-node 7.1.0 (in the
lockfile since the initial public release) rejects an ID token nonce unless the expected nonce is
passed to `acquireTokenByCode`; the callback did not pass it. Fixed in `azure-auth.service.ts` /
`azure-callback.controller.ts`; re-test on an image built from the working tree.
