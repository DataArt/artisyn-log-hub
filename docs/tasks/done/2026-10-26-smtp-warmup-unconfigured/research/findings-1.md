I've gathered the context. Before planning, note that FR-4's fail-fast in Mode 3 would break the contract suite, the dev server and one existing scenario step unless the plan handles them (Open gaps 1–3).

## Requirements summary
How SMTP behaves is decided by the auth mode.
- **Modes 1/4 (`none`, `azure-oauth`):** no transporter, no `verify()`, no log line.
- **Mode 2 (`password`):** if `SMTP_HOST` is empty, it behaves like Modes 1/4. If it is set, the warm-up runs as today (failure is a warning and the app still starts), and `SMTP_PORT`/`SMTP_FROM` become required in `validateMode2()`.
- **Mode 3 (`password-confirm`):** the current presence checks stay, and a failed `verify()` stops startup with an error naming `host:port` and the cause.
- `MailService.isConfigured()` becomes the single signal: Mode 3 → true, Mode 2 → non-empty `SMTP_HOST`, Modes 1/4 → false. Every send path and the warm-up check it.
- `GET /api/v1/auth/config` gets an additive `passwordResetAvailable` (Modes 2/3 only). When it is false, the login page and `/forgot-password` show "Forgot password?" disabled with the hint "SMTP server is not configured".
- `forgot-password` in Mode 2 without SMTP issues no token and returns `email_delivery:'failed'`.
- The SMTP defaults in `AdminService.getAuthConfig()` are removed, and the admin SMTP card shows only when SMTP is configured.
- Docs are updated per FR-8, plus the KB, algorithm doc rows, the contract row and scenario steps.

## Wireframes
None referenced. There is no `open_questions_ru.md` in the task folder (only `requirements.md`).

## Knowledgebase
- `docs/knowledgebase/algorithms/auth-startup-config.md`
  - Doc-driven table: the "Rules" steps are at lines 34–83 (Mode 2 is just the `PUBLIC_BASE_URL` rule, line 42).
  - Edge-case index is at lines 85–109, the examples block at lines 111+, and a "mutations → rows" list near the end.
  - The last row id is **AS-101**, so new Mode 2 SMTP rows start at AS-102.
  - Rows reuse the shared values `SMTP_HOST=smtp.arrakis.test`, `SMTP_PORT=587`, `SMTP_FROM=hub@arrakis.test`.
  - AS-07's note says "password mode needs no SMTP" and must be reworded.
  - Line 26: the check is skipped when `NODE_ENV=test`.
- `docs/knowledgebase/authorization-and-authentificaiton.md`
  - Lines 26–40 hold the startup validation text, including the "Mode 2 also requires no email config … best-effort" paragraph (lines 35–40), which must be rewritten.
  - Lines 143–145: password-changed notification `'skipped'` when `SMTP_HOST` is empty.
  - Line 284: "MailService … no code-level defaults".
  - Lines 300–303: local Mailpit recipe (`docker run … axllent/mailpit`, 1025/8025).
- `docs/knowledgebase/deployment-auth-mode.md:27-29` — Mode 3 refuses to start without the SMTP vars; extend with the reachability fail-fast.
- `docs/knowledgebase/api-reference.md`
  - Lines 167–173: `GET /auth/config` response type. Add `passwordResetAvailable?: boolean` (Modes 2/3).
  - Lines 945–953: `GET /admin/auth` `smtp?` — now present only in Mode 3, or in Mode 2 when SMTP is configured.
- `docs/knowledgebase/server-endpoint-map.md:60,75` — the `GET config` field list must gain `passwordResetAvailable` (rule in `.claude/rules/server.md`).
- `docs/knowledgebase/test/scenarios.md` and `tests/scenarios/README.md:69` — stand modes table (B = Mode 3 + Mailpit, `NODE_ENV=production`).
- `docs/knowledgebase/docker-dev-container.md:28,408` — sandboxes run Mailpit on `127.0.0.1:1025`, so a Mode 3 dev default pointing at `localhost:1025` works inside them.

## Existing patterns
**Server**
- `server/src/mail/mail.service.ts:14-38` — the constructor always builds the transporter from unset values (the bug). `:54-62` — `onModuleInit` warm-up with `logger.warn`. `:71-73` — `isConfigured()` today checks `SMTP_HOST` only. `:105-120` — `send()` catches errors and returns `'failed'`.
- `server/src/auth/auth.service.ts:338-340` — `isConfigured() ? send : 'skipped'`, the gating pattern to reuse. `:185-214` — `forgotPassword` issues the token before sending; it needs an early `isConfigured()` return of `{email_delivery:'failed'}` before `issueWithCooldown`.
- `server/src/auth/auth.service.ts:66-80` (signup confirm), `:150-175` (`resendConfirmation`) and `server/src/admin/admin.service.ts:200` (admin resend) — Mode 3-only send paths, always configured under the new rule.
- `server/src/auth/auth.controller.ts:58-80` — `config()` builds the response per mode and is where `passwordResetAvailable` goes. The controller does not inject `MailService` today: inject it, or compute the value from `ConfigService` the same way. `:209-221` — `forgot-password` route.
- `server/src/admin/admin.service.ts:119-130` — `getAuthConfig()` with the `SMTP_HOST ''` / `SMTP_PORT '0'` / `SMTP_FROM ''` defaults to remove (FR-6). `AdminAuthConfig` is at `:42-51`.
- `server/src/auth/config/auth-startup-validation.ts`
  - `:120-129` — `validateMode2()` plus a comment to rewrite.
  - `:148-157` — Mode 3 SMTP checks to factor into a shared helper for Mode 2-when-`SMTP_HOST`-set.
  - `:24-31` — `requireNonEmpty` message format.
- `server/src/auth/config/auth-startup-validation.algo.spec.ts:9-25` — `AUTH_KEYS` already includes `SMTP_HOST`/`PORT`/`FROM`, so new doc rows need no spec change.
- `server/src/app.module.ts:60-62` — the validator is skipped when `NODE_ENV==='test'`; the same guard is a candidate for the Mode 3 fail-fast (see gaps).
- Startup failure path:
  - `server/src/main.ts:126,152-154`: an `onModuleInit` throw happens inside `app.listen()`, then `logFatalError` and `process.exit(1)`.
  - `server/src/cluster/cluster-primary.ts:151-168`: once the crash budget is spent, `giveUp`, and when all slots stop, `exit(1)`.

**Client**
- `client/src/models/auth.ts:24-28` — `AuthConfig`; add `passwordResetAvailable?: boolean`.
- `client/src/viewer/pages/login/LoginPage.tsx:116-120,200-208` — `PasswordLoginForm({showForgotPassword})`. `:288-293` — **Mode 2 currently passes `showForgotPassword={false}`** (the link is hidden in Mode 2 today, unchanged since the initial release); Mode 3 passes `true`.
- `client/src/viewer/hooks/useAuthConfig.ts` — query with `staleTime: Infinity`; reuse it in `ForgotPasswordPage`.
- `client/src/viewer/pages/forgot-password/ForgotPasswordPage.tsx:16-87` — does not read the config today; it needs `useAuthConfig()` and the hint.
- `client/src/viewer/pages/admin/tabs/AdminAuthTab.tsx:17-22,58` — `{data.smtp && <Card label="SMTP">}`, so it works automatically once the server omits `smtp`. `MODE_FIELD_NAMES.password` is `[]` and could list the optional SMTP fields.
- `client/src/models/admin.ts:48` — `smtp?` type.

**Tests**
- Contract: `server/test/contract/registry/f01-infra.ts:41-47` (`F01-auth-config`, `bodyMatches {mode:'password-confirm'}`) gets `passwordResetAvailable: true`. `:100-106` is `F01-admin-auth`.
- `server/test/contract/setup/global-setup.ts:89-96` — the contract suite runs Mode 3 with `SMTP_HOST ??= 'localhost'`, `SMTP_PORT ??= '1025'`.
- `server/test/contract/README.md:23` — the contract suite "needs neither the dev server nor Mailpit"; jest runs with `NODE_ENV=test`.
- `server/test/contract/registry/f02-account.ts:210-236` — `forgot-password` rows (Mode 3, unaffected).
- Scenario stand modes: `tests/scenarios/modes.ts:22-26`
  - A = `none`/test
  - B = `password-confirm`/**production**/Mailpit
  - C = `password`/test with no SMTP
  - `standEnv` sets SMTP only for B (`:132-143`).
- Scenarios to extend:
  - `tests/scenarios/auth/s-auth-07.spec.ts` (@mode-a/b/c), step 1 (`:93-108`): assert `passwordResetAvailable` (B true, C false, A absent).
  - Same file, **step 3–4 (`:152-164`) currently expects `smtp` keys `['from','host','port']` in mode C**. It will fail once the SMTP card or field is omitted in Mode 2 without SMTP; change it to `toBeUndefined()` for C.
  - Mode-C UI step (disabled "Forgot password?" plus hint on `/login` and `/forgot-password`): candidates are `tests/scenarios/tours/tour-01-anon.spec.ts` (@mode-a/b/c, walks `auth.login.password` and `auth.forgot-password` rows, `tests/scenarios/tours/screen-registry.ts:156-190`) or S-AUTH-07.
  - Mode B "starts with Mailpit, no warning" is covered implicitly by `tests/scenarios/platform/stand-smoke.spec.ts` (@mode-a/b/c). `tests/scenarios/auth/s-auth-01.spec.ts` (signup confirmation delivered via Mailpit) and `tests/scenarios/auth/s-auth-04.spec.ts` (B, clicks "Forgot password?" at `:53`) must keep working.
- `scripts/scenarios/stand.mjs:157-173,233-250` — the stand's `waitForHealth` fails with the tail of `stand.log` if the process exits, so a Mode 3 fail-fast surfaces there. `scripts/scenarios/preflight.mjs:56-66,103` already requires Mailpit for mode B.
- Scenario design doc: `docs/qaa-overview/scenarios/01-auth-access-admin.md` (S-AUTH-07 / TOUR steps are cited from it).

**Docs to edit (FR-8)**
- `server/.env.example:86-115` — `AUTH_MODE=password-confirm` dev default; the comment says "fails silently" (`:92`); SMTP is `smtp.example.com:25` (switch to `localhost:1025`).
- `release-template/.env.example:31-47` — no SMTP block yet.
- `release-template/INSTALL.md:253-257` and `release-template/LOCAL-BUNDLE.md:124-128` — Settings table, no SMTP rows.
- `client/public/help/security-hardening.md:101-102` ("Password change" bullet), `:121-131` (§3.4 "best-effort"), `:265`, `:403`.
- `client/public/help/component-reference.md:77` (Mail row).
- `README.md:131-137` (modes table).

## Open gaps
1. **Mode 3 fail-fast vs. contract suite and dev server.** The contract suite runs Mode 3 against `localhost:1025` with no Mailpit (`NODE_ENV=test`). The dev server (`server/.env.example` Mode 3, `NODE_ENV` ≠ test) would also refuse to start without Mailpit. The plan must decide whether the fail-fast is skipped under `NODE_ENV==='test'` (like `app.module.ts:60`), and whether host dev now requires Mailpit (sandboxes have it).
2. **`release-template/docker-compose.yml:31-52` does not forward any `SMTP_*` or `ADMIN_CONTACT_EMAIL` to the container.** Documenting SMTP rows in INSTALL.md / LOCAL-BUNDLE.md / `.env.example` is ineffective unless compose gains `SMTP_HOST: ${SMTP_HOST:-}` etc. Empty values are safe under the new `isConfigured()` (trim → empty), and `SMTP_SECURE` empty → `false`. FR-8 does not list this file.
3. **Mode 2 login currently hides "Forgot password?"** (`showForgotPassword={false}`). Showing it when `passwordResetAvailable` is true is a visible change in Mode 2; this matches the acceptance criteria but is not called out as a change.
4. **No scenario can read the stand log.** `stand.logFile` is not exposed to fixtures (`tests/scenarios/fixtures/index.ts:29-35`), so "no SMTP log line" (modes A/C) and "no warning" (B) cannot be asserted without new plumbing. The Mode 2 "SMTP set but unreachable → one warning, app starts" and "Mode 3 unreachable → no start" criteria have no scenario stand that fits (no mode runs Mode 2 with SMTP, and a refused start cannot be tested in-suite). These may stay manual checks or need a decision.
5. **`isConfigured()` reading `AUTH_MODE`.** Mode 3 → true relies on the startup validator having run; under `NODE_ENV=test` (contract) the validator is skipped, though the contract env sets SMTP anyway.
6. **Additive field and old clients.** When `passwordResetAvailable` is absent, the client must keep today's behaviour (Mode 2 hidden, Mode 3 shown). The disabled-state UI component (link-style button with a hint, `disabled` + `aria-disabled`) has no existing pattern; the `ui-components` skill applies.
7. **Algorithm doc: no "ignored when `SMTP_HOST` unset" rows yet.** New Mode 2 rows are needed: host set without port/from fails; a bad port fails; host unset with garbage `SMTP_PORT` passes; spaces-only host counts as unset. The "Rules" text and mutation list need matching entries.
