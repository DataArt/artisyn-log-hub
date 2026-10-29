# Server settings

The server is configured with environment variables. In a release install they live in the
`.env` file of the install directory; restart the app (`docker compose up -d`) after a change.

The main settings are below. The full list, with the security relevance of each variable, is in
[Security Hardening & Configuration — Configuration reference](security-hardening.md#10-configuration-reference).

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | **Required.** PostgreSQL connection string. |
| `PORT` | `3000` | HTTP listen port. |
| `AUTH_MODE` | `password` | See [Authentication modes](authentication-modes.md). The release install sets `none`; the example configuration of a source checkout sets `password-confirm`. |
| `PASSWORD_POLICY` | `long` | Password strength in Modes 2/3: `any`, `mid` or `long`. |
| `SESSION_SECRET` | generated | Optional. Generated and stored in the database when unset. |
| `PUBLIC_BASE_URL` | — | Externally reachable URL, used for the links in emails. Required in production for Modes 2/3. |
| `ALLOWED_EMAIL_DOMAINS` | any | Mode 3 sign-up allow-list, comma-separated domains. |
| `COOKIE_SECURE` | `true` | Set `false` when served over plain HTTP. |
| `TRUST_PROXY` | `false` | Set when running behind a reverse proxy. When enabled it overrides `COOKIE_SECURE`. |
| `SESSION_RETENTION_DAYS` | `30` | Sessions older than this are deleted. |
| `AI_TOOL_VERSION_CHECK_ENABLED` | on | `false` turns off the outbound npm version check. |
| `MODEL_PRICING_FETCH_ENABLED` | on | `false` turns off the outbound pricing-page fetch. |

Mode-specific settings (SMTP for Modes 2/3, `AZURE_*` for Mode 4) are described in
[Security Hardening & Configuration](security-hardening.md) §3.2–§3.4.
