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

## 2026-11-19 — Final verification after merging main

`main` merged into the branch (conflicts only in KB front matter, `repo-health-checks.json`,
`preflight.mjs` and `tests/scenarios/README.md`). Fast set green; `contract` 606/606,
`e2e-fast` 27/27, `e2e-full` 82/82, `scenarios-a`/`-b`/`-c`/`-d` green. The 2026-11-16
`admin-panel.spec.ts:172` failure did not reproduce (spec repeated 3× green) — it was the
laptop's environment, so `docs/BLOCKED.md` was removed. Tours needed two registry updates for this
branch's own changes: the reset-password page's new invalid-link text and the renamed
`security-hardening.md` §3.3 heading.

## 2026-11-19 — Review on a Docker stand: security review + exploratory UI test

The branch image ran as a throw-away compose stand (`tmp/strict-managed-stand/`, port 5021,
Mailpit SMTP). One agent reviewed the related API code for security holes, another walked every
journey in the browser. All findings were accepted for fixing (impl-plan Chunk 11).

Security:

- S1 (High) — bootstrap promoted an existing non-admin account with `ADMIN_CONTACT_EMAIL` to admin
  silently, keeping its password and sessions: whoever had signed up with that address in an
  earlier mode became admin.
- S2 — unconfirmed sign-ups from Mode 3 could log in after the switch; the pending-registrations
  list that would show them 404s in strict-managed.
- S3 — any user could create placeholder accounts through a repository import and then claim them
  with "Forgot password?"; "Resend link" mailed placeholder / unvalidated addresses.
- S4 — renaming a user's email kept the links already sent to the old address valid.
- S5 — forgot-password revealed accounts: 429 on cooldown only for known emails, and the SMTP
  round-trip in the response time.
- S6 — the per-IP email budget was shared between anonymous forgot requests and admin actions
  (one proxy IP → anonymous flood blocks the admin); `TRUST_PROXY=true` lets clients spoof IPs.
- S7 — reset/set tokens stored in plaintext (now 24 h for set links).
- S8 — a successful reset did not sign out other sessions.
- S9 — anyone could cancel an admin's 24 h link via forgot-password. S10 — a failed policy check
  burned the link (same as U1).

UX / logic (U1–U16): a weak password burned the one-time link (U1); forgot-password enumeration
(U2, = S5); the Members tab offered "Add anyway" and looped on the server's 404 (U3); forgot
cancelled the admin link (U4, = S9); the email limit counted per worker (~80 instead of 20) (U5);
"Resend link" 429 right after create, cooldown lost on reload (U6, U11); forgot page said "sent"
on 429 and logged an uncaught error (U7); no confirmation after setting a password (U8); no login
hint about who creates accounts (U9); policy shown only after a failed submit (U10); confirm-email
page reachable (U12); raw "email must be an email" (U13); Auth tab label / fields (U14);
"Reset" wording for password-less accounts and admin-facing "ask an administrator" (U15); the
previous user's team queries refetched after switching identity (U16).

## 2026-11-19 — Second review round after the fixes

The stand was rebuilt from the fixed tree and both agents ran again. Security: S1–S10 closed;
follow-ups fixed — the bootstrap reset also deletes the account's API keys; the email rename runs
in one transaction under the user row lock and link issuance re-checks the email under the same
lock (no link to the old address in a race); renaming to the same address is a no-op; an admin
cannot rename themselves in strict-managed and a rename there also clears the password (so
"Resend link" works for the corrected address); the IP key of the email limiter is a sha256
(migration 0095 fixes the table comment); the dead `getLatestResetTokenForEmail` e2e helper is
gone. UX: every U-finding confirmed fixed; follow-ups fixed — rename dialog warning and success
notice, the Auth tab lists the active mode's required settings, the password rule in Change
password, a token-less reset link says it is invalid up front, the weak-password error replaces
the rule instead of repeating it, "works once" in the reset email, no WARN when `auth_sessions`
does not exist yet, the resend cooldown ignores links a rename retired. Not changed: the
data-collection notice text (it is hashed for consent, a wording change would ask every user to
accept it again). Verified by hand on a second throw-away stand: an attacker's pre-registered
`ADMIN_CONTACT_EMAIL` account loses its session and password on the switch, and an unverified
Mode 2 admin gets 403 `email_not_verified` until "Forgot password?".

Final run: fast set and build green; contract 607/607; e2e-fast 27/27; e2e-full 82/82;
scenarios a/b/c/d green. `S-HOOK-07` step 29 failed twice while a Docker image build ran in
parallel and passed alone: the test reads `receiver.log` right after the job file is rewritten,
before the receiver logs `job-retry` — a timing race in the test from hook 3.0.0 (main), not in
this branch.
