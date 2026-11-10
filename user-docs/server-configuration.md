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
| `LOG_RETENTION_DAYS` | `5` | Days of server app logs (`logs/app-*.log`) kept, today included. `0` = no age limit. |
| `SQL_LOG_RETENTION_DAYS` | `3` | Days of server SQL logs (`logs/sql-*.log`) kept, today included. `0` = no age limit. |
| `LOG_RETENTION_MAX_MB` | `100` | Cap on the total size of those log files; the oldest are deleted first, today's never. `0` = no cap. Checked at startup and hourly. |
| `AI_TOOL_VERSION_CHECK_ENABLED` | on | `false` turns off the outbound npm version check. |
| `LOG_HUB_RELEASE_CHECK_ENABLED` | on | New Log Hub release check for the admin badge: one `api.github.com` call per 24 h, official release images only. Only `false` turns it off (air-gapped installs). |
| `MODEL_PRICING_FETCH_ENABLED` | on | `false` turns off the outbound pricing-page fetch. |
| `BUDGET_CHECK_INTERVAL_MS` | `300000` | How often the budget threshold job runs, in milliseconds (5 minutes). |
| `BUDGET_CHECK_ENABLED` | on | `false` turns off the budget threshold job: no new budget notices or emails. |

Mode-specific settings (SMTP for Modes 2/3, `AZURE_*` for Mode 4) are described in
[Security Hardening & Configuration](security-hardening.md) §3.2–§3.4.

## Budget threshold job

A background job checks every [budget](budgets.md) every `BUDGET_CHECK_INTERVAL_MS`: it computes
the spend of the budget's current period and raises a notice for each newly crossed threshold.
It runs inside the server, never while sessions are uploaded, so it does not slow down uploads
or the session list. With several server workers each one runs it; a notice is still written
and emailed only once.

Notices always appear in the app (the bell and the banner). **Emails** are sent only when the
mail service is configured — the same SMTP settings that Modes 2/3 use for sign-up and password
reset (`SMTP_HOST` and the rest, see the link above); there is no separate mail setup for
budgets. The mail service is used only in Modes 2/3 (`AUTH_MODE` `password` or
`password-confirm`) with `SMTP_HOST` set. In Mode 1 (`none`), Mode 4 (Entra ID) and Mode 2
without SMTP, notices are in-app only and the budget event log records *Email skipped*. The link in the email is built from
`PUBLIC_BASE_URL`; without it the email is sent without a link.

With `BUDGET_CHECK_ENABLED=false` budgets, the Spend tab, the Budget burn view and the Budget
report still work; only the notices stop.
