# Notes

## 2026-11-05 — Raw idea (moved from requirements.md)

Raw idea (verbatim, translated from Russian), with the clarifications given while scratching:

> Auth mode 5: the admin creates users manually from the admin panel; the password is sent to the user
> by email (SMTP config is mandatory for this mode); the admin's email is set in the config; on the first
> start the admin's password is sent to them by email.
>
> I.e. a strictly manual access-management mode.
>
> Plus all the usual stuff — "I forgot my password", a reset link. We never send a password, only a
> reset link. Also a per-IP rate limit on sending. "Just send me a reset link" is the standard way for
> everything, including the initial admin bootstrap.

Original (Russian): «режим авторизации 5 когда админ заводит пользователей руками из админки; пароль
высылается почтой (smtp config must have); email админа прописывается в конфиге; пароль высылается ему
на почту при первом запуске» · «т.е. такой жестко ручной режим управления доступом» · «ну и вот это всё
обычное — я забыл пароль, ссылка на reset — пароль не посылаем, только ссылку на ресет; ещё rate limit на
посылку на IP; просто пошли мне ссылку на ресет — это стандартный способ для всего, в том числе
начального бутстрепа админа».

## 2026-11-16 — Manual check: strict-managed startup with an unreachable SMTP relay

Impl-plan Chunk 8 manual check. The server was started with `nest start` (`server/`), with
`AUTH_MODE=strict-managed`, `NODE_ENV=development`, a valid config (`PUBLIC_BASE_URL`,
`ADMIN_CONTACT_EMAIL=bootstrap-admin@example.com`, `SMTP_HOST=127.0.0.1`, `SMTP_FROM`,
`SESSION_SECRET`), `SMTP_PORT` set to a closed local port, no `CLUSTER_MODE`, and a fresh
`E2E_DB_SCHEMA` (`manual_sm_<timestamp>`) in the dev database. The schema was dropped afterwards
(`DROP SCHEMA ... CASCADE`).

1. **Fresh schema, no admin.** Exit code 1. Startup stopped in `initializeDatabase()` with the
   Design Decision 10 step 5 error: `Strict-managed bootstrap: the set-password email to
   b***@example.com could not be sent (connect ECONNREFUSED 127.0.0.1:<port>); AUTH_MODE=strict-managed
   refuses to start. Fix SMTP and restart.` After the run the schema had 0 `users` rows for
   `ADMIN_CONTACT_EMAIL` and 0 `password_reset_tokens` rows, so the insert was rolled back.
2. **Admin already present** (a `users` row with role `admin` was inserted by hand). Exit code 1.
   The bootstrap did nothing and sent no email. Nest started, and then `MailService.onModuleInit`
   stopped startup with `SMTP relay 127.0.0.1:<port> is unreachable; AUTH_MODE=strict-managed
   requires a working relay: Error: connect ECONNREFUSED 127.0.0.1:<port>`. The admin row was
   still there (1 row).
