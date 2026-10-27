# Azure SSO sign-in works again, also in the release install

- Sign-in with Microsoft (`AUTH_MODE=azure-oauth`) no longer fails after the Microsoft login page:
  the token exchange was rejected with a nonce mismatch.
- The release `docker-compose.yml` now passes the `AZURE_*` settings from `.env` to the app, so a
  release install can use Azure SSO; the settings are documented in `.env.example` and the README.
