# Implementation Plan — SMTP Per Auth Mode (2026-10-26-smtp-warmup-unconfigured)

## TL;DR

- `MailService` (`server/src/mail/mail.service.ts`) builds a transporter only when SMTP applies to the mode.
  - `isConfigured()` becomes per-mode: Modes 2/3 → `SMTP_HOST` is not empty (the startup validator makes this always true in Mode 3), Modes 1/4 → false.
  - `onModuleInit` skips the check entirely when no transporter exists.
  - In Mode 3 a failed `verify()` **throws**, so startup aborts. This only happens outside `NODE_ENV=test`; under `test` it stays a warning so the Mailpit-less contract suite still runs.
- `validateMode2()` now validates the SMTP block (`SMTP_FROM`, `SMTP_PORT` and its range) when `SMTP_HOST` is set. This check is shared with Mode 3.
- API changes are additive only:
  - `GET /api/v1/auth/config` gains `passwordResetAvailable` (Modes 2/3).
  - `POST /api/v1/auth/forgot-password` in Mode 2 without SMTP returns `{email_delivery:'failed'}` and issues no token.
  - `GET /api/v1/admin/auth` omits `smtp` in Mode 2 without SMTP and drops its code defaults.
- Client:
  - The login page "Forgot password?" link has three states (active, disabled with the hint "SMTP server is not configured", hidden).
  - `/forgot-password` shows the same hint and disables its form.
  - **Mode 2 with SMTP now shows the link (hidden today).**
- `release-template/docker-compose.yml` starts forwarding `SMTP_*` and `ADMIN_CONTACT_EMAIL` into the container. Without this, the FR-8 docs would describe settings that never reach the app.
- Docs: the per-mode SMTP rule is rewritten in release-template (`INSTALL.md`, `LOCAL-BUNDLE.md`, `.env.example`), `server/.env.example`, help pages (`security-hardening.md`, `component-reference.md`), `README.md`, seven KB articles and two qaa-overview scenario design docs.
- **Behaviour change for developers:** a host dev server in the `server/.env.example` default (Mode 3) now needs Mailpit on `localhost:1025` to start.
- DB: none. New packages: none.

## Reference

Requirements: [requirements.md](requirements.md). Research archive: `research/findings-1.md`.

## Design Decisions

1. **Per-mode SMTP signal (FR-7).** `MailService.isConfigured()` returns `true` iff `AUTH_MODE` is `password` or `password-confirm` **and** `(SMTP_HOST ?? '').trim() !== ''`; anything else → `false`.
   - In Mode 3 outside `NODE_ENV=test` the startup validator guarantees `SMTP_HOST`, so this is always `true` there (FR-7).
   - Folding the host check in keeps the `NODE_ENV=test` edge case (validator skipped) consistent: change-password reports `'skipped'` rather than `'failed'`, and no admin card is built without a host.

   It is the only gate used by every send path (including change-password's `'skipped'` branch at `auth.service.ts:338-340`, code unchanged) and by the warm-up.
2. **No transporter from unset values (FR-6).**
   - The `transporter` field becomes `nodemailer.Transporter | null`. The constructor builds it only when `isConfigured()` is true.
   - Nodemailer's `localhost:587` fallback can no longer be reached.
   - `send()` returns `'failed'` without logging when `transporter` is `null` (a defensive path, since callers already gate on `isConfigured()`).
3. **Warm-up / fail-fast (FR-1–FR-4).** `onModuleInit` does the following:
   - no transporter → return with no log;
   - `verify()` succeeds → no log;
   - `verify()` fails:
     - in Mode 2, or in Mode 3 with `NODE_ENV === 'test'` → log the existing `SMTP connection warm-up failed (will retry lazily on first send): <err>` warning;
     - in Mode 3 otherwise → `throw new Error('SMTP relay <host>:<port> is unreachable; AUTH_MODE=password-confirm requires a working relay: <err>')`.

   The thrown error reaches `main.ts` (`app.listen` → `logFatalError` → `process.exit(1)`, `server/src/main.ts:126,152-154`). The cluster crash budget then stops the instance (`server/src/cluster/cluster-primary.ts:151-168`), with no new retry logic. The `NODE_ENV=test` exemption mirrors `server/src/app.module.ts:61`. It keeps the contract suite (Mode 3, `localhost:1025`, no Mailpit; `server/test/contract/setup/global-setup.ts:89-96`) working.
4. **Shared SMTP block check.** Extract Mode 3 steps 4–5 (`auth-startup-validation.ts`, the `requireNonEmpty` calls for `SMTP_HOST`/`SMTP_FROM`/`SMTP_PORT` and the 1–65535 range) into `validateSmtpBlock()`. Messages and order stay the same.
   - Mode 3 calls it unconditionally.
   - `validateMode2()` calls it after the `PUBLIC_BASE_URL` rule, only when `SMTP_HOST` trimmed is not empty. When `SMTP_HOST` is unset, other `SMTP_*` values are ignored.
   - `SMTP_USER`/`SMTP_PASSWORD`/`SMTP_SECURE` stay optional (`SMTP_SECURE` unset or empty → `false`).
5. **`passwordResetAvailable`.**
   - `AuthController.config()` injects `MailService` (already exported by `MailModule`, which `AuthModule` imports) and sets `passwordResetAvailable: this.mailService.isConfigured()` for `password`/`password-confirm` only.
   - The field is absent in `none`/`azure-oauth`.
6. **Forgot-password without SMTP.** `AuthService.forgotPassword()` returns `{ email_delivery: 'failed' }` as its first statement when `!mailService.isConfigured()`. This happens before the user lookup, so the answer stays enumeration-safe and no token is issued. The controller's rate-limit consumption is unchanged.
7. **Client link state.** Add a pure helper `forgotPasswordLinkState(config): 'active' | 'disabled' | 'hidden'`:
   - `passwordResetAvailable === true` → `active`;
   - `=== false` → `disabled`;
   - `undefined` (older server) → `active` for `password-confirm`, `hidden` for `password` (today's behaviour).

   `PasswordLoginForm` takes `forgotPassword: ForgotPasswordLinkState` instead of `showForgotPassword: boolean`.
8. **Disabled UI contract.**
   - The disabled link is the same `<button>` with `disabled`, plus `cursor-not-allowed opacity-60 no-underline` replacing the hover classes, and `aria-describedby="forgot-password-hint"`.
   - Below it sits `<p id="forgot-password-hint" className="self-end text-xs text-muted-foreground">SMTP server is not configured</p>`.
   - The hint string is one exported constant, `SMTP_NOT_CONFIGURED_HINT = 'SMTP server is not configured'`, in the helper file (Decision 7). Both pages use it.
9. **`/forgot-password` opened directly.**
   - When `useAuthConfig().data?.passwordResetAvailable === false`, the page renders the same hint (`role="note"`) above the input, and both the email input and the "Send reset link" button are `disabled`.
   - While the config is loading or errored, the form stays enabled (today's behaviour).
10. **Admin SMTP card (FR-6).** `AdminService.getAuthConfig()` sets `smtp` only when `this.mailService.isConfigured()`. The values are read with no defaults: `host: SMTP_HOST ?? ''`, `port: Number(SMTP_PORT)`, `from: SMTP_FROM ?? ''`. Whenever `SMTP_HOST` is set in Modes 2/3 the validator requires a valid `SMTP_PORT`, so `port` is a real number outside `NODE_ENV=test`; a `NaN` port (serialized `null`) under `NODE_ENV=test` with `SMTP_PORT` unset is an accepted test-only misconfiguration. The `AdminAuthConfig` shape is unchanged. `AdminAuthTab.tsx` already renders the card only `{data.smtp && …}`, so it needs no client change.
11. **Release compose forwarding.**
    - `release-template/docker-compose.yml` `environment:` gains the following, all empty by default:
      - `ADMIN_CONTACT_EMAIL: ${ADMIN_CONTACT_EMAIL:-}`
      - `SMTP_HOST: ${SMTP_HOST:-}`, `SMTP_PORT: ${SMTP_PORT:-}`, `SMTP_FROM: ${SMTP_FROM:-}`
      - `SMTP_USER: ${SMTP_USER:-}`, `SMTP_PASSWORD: ${SMTP_PASSWORD:-}`, `SMTP_SECURE: ${SMTP_SECURE:-}`
    - Empty values are the "unset" case under Decisions 1–4.
    - Comment line above the block: `# Outgoing mail — required for password-confirm, optional for password (see .env.example).`
12. **Per-mode doc wording (FR-8), used verbatim in spirit by every doc item:**
    - Modes 1/4 never use SMTP.
    - Mode 2: SMTP is optional. When `SMTP_HOST` is set, `SMTP_PORT`/`SMTP_FROM` are required; a relay that cannot be reached only logs a warning. When it is unset, password reset is unavailable and "Forgot password?" is disabled.
    - Mode 3: `SMTP_HOST`/`SMTP_PORT`/`SMTP_FROM` are required and the relay must be reachable at startup, or the app does not start.
    - `SMTP_USER`/`SMTP_PASSWORD` are optional; `SMTP_SECURE` is optional (unset = `false`).

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `server/src/mail/mail.service.ts` | Per-mode `isConfigured`, nullable transporter, warm-up/fail-fast | Decisions 1–3; rewrite constructor comment (no "best-effort" Mode 2 wording) |
| `server/src/auth/config/auth-startup-validation.ts` | `validateSmtpBlock()`; Mode 2 conditional SMTP check | Decision 4; rewrite Mode 2 comment |
| `server/src/auth/auth.controller.ts` | `passwordResetAvailable` in `config()` | Decision 5; inject `MailService` |
| `server/src/auth/auth.service.ts` | Early `failed` in `forgotPassword` | Decision 6 |
| `server/src/admin/admin.service.ts` | `smtp` only when configured, no defaults | Decision 10 |
| `client/src/models/auth.ts` | `AuthConfig.passwordResetAvailable?: boolean` | |
| `client/src/viewer/pages/login/forgot-password-link.ts` (new) | `forgotPasswordLinkState()`, `ForgotPasswordLinkState`, `SMTP_NOT_CONFIGURED_HINT` | Decisions 7–8 |
| `client/src/viewer/pages/login/LoginPage.tsx` | Three-state link in `PasswordLoginForm` | Decisions 7–8 |
| `client/src/viewer/pages/forgot-password/ForgotPasswordPage.tsx` | Hint + disabled form | Decision 9 |
| `release-template/docker-compose.yml` | Forward SMTP/admin-contact vars | Decision 11 |
| `release-template/.env.example` | Commented-out `SMTP_*` + `ADMIN_CONTACT_EMAIL` block | Decision 12 |
| `release-template/INSTALL.md`, `release-template/LOCAL-BUNDLE.md` | SMTP rows in "Settings" table | Decision 12 |
| `server/.env.example` | Rewrite comments (lines ~86–115), SMTP → `localhost:1025` | Decision 12; drop "fails silently" |
| `client/public/help/security-hardening.md` | "Password change" bullet (~101), §3.4 (~121–131), ~265, ~403 | Decision 12 |
| `client/public/help/component-reference.md` | Mail row (~77) | Decision 12 |
| `README.md` | Auth modes table (~131–137) | Decision 12 |
| `docs/knowledgebase/algorithms/auth-startup-config.md` | Mode 2 rule text, AS-07 note, rows AS-102–AS-107, mutations | Test coverage plan |
| `docs/knowledgebase/authorization-and-authentificaiton.md` | Lines ~26–40, ~143–145, ~284 | Per-mode SMTP + fail-fast |
| `docs/knowledgebase/deployment-auth-mode.md` | ~27–29 | Mode 3 reachability fail-fast |
| `docs/knowledgebase/api-reference.md` | ~167–173 (`/auth/config`), ~945–953 (`/admin/auth`), forgot-password Mode 2 note | |
| `docs/knowledgebase/server-endpoint-map.md` | ~60, ~75 `GET config` field list | |
| `docs/knowledgebase/client-component-map.md` | LoginPage (line 108), ForgotPasswordPage (124), useAuthConfig (66) entries; new helper | ui-components skill |
| `server/test/contract/registry/f01-infra.ts` | `F01-auth-config` body gains `passwordResetAvailable: true` | |
| `tests/scenarios/auth/s-auth-07.spec.ts` | Steps 1 and 3–4 | Test coverage plan |
| `tests/scenarios/tours/tour-01-anon.spec.ts` | New step: link state B/C | Test coverage plan |
| `docs/qaa-overview/scenarios/01-auth-access-admin.md`, `docs/qaa-overview/scenarios/06-ui-tab-walk.md` | Record the new scenario checks | Keep design docs in sync |

## API changes

- **`GET /api/v1/auth/config`** (public). Response, additive:
  `{ mode, azure?, adminContactEmail?, passwordResetAvailable?: boolean }`.
  `passwordResetAvailable` is present only in `password`/`password-confirm` and is set per Decision 5. The server's response type in `auth.controller.ts` gets the field. On the client, `AuthConfig` in `client/src/models/auth.ts` gets it too.
- **`POST /api/v1/auth/forgot-password`.** The shape is unchanged (`{ email_delivery: 'sent' | 'failed' }`). In Mode 2 without SMTP it always returns `failed`, with no token and no email (Decision 6). Mode 3 is unchanged.
- **`GET /api/v1/admin/auth`.** The shape is unchanged (`AdminAuthConfig`, `smtp?` already optional). `smtp` is present in Mode 3, and in Mode 2 only when `SMTP_HOST` is set (Decision 10).

## Test coverage plan

Following the CLAUDE.md test policy, there are only algorithm, contract and scenario tests.

- **Algorithm.** Extend the examples block of `docs/knowledgebase/algorithms/auth-startup-config.md`. The existing `server/src/auth/config/auth-startup-validation.algo.spec.ts` already knows every `SMTP_*` key, so the spec file needs no change. Rows (the SMTP block is the doc's shared values):
  - **AS-102:** `password` + `SMTP_HOST` only → fails `SMTP_FROM environment variable is required`.
  - **AS-103:** `password` + host + from → fails `SMTP_PORT environment variable is required`.
  - **AS-104:** `password` + full block with `SMTP_PORT=0` → fails `SMTP_PORT environment variable must be an integer between 1 and 65535`.
  - **AS-105:** `password` + full block → ok.
  - **AS-106:** `password`, `SMTP_HOST` unset, `SMTP_PORT=abc` → ok (ignored).
  - **AS-107:** `password`, `SMTP_HOST="   "`, `SMTP_PORT=abc` → ok (whitespace = unset).

  Also update the Rules text (Mode 2 step), the AS-07 note ("needs no SMTP" → "SMTP unset is allowed"), the edge-case index, and the Mutations list:
  - "Mode 2 SMTP block checked when `SMTP_HOST` is unset" → AS-106, AS-107;
  - "not checked when set" → AS-102–AS-104.
- **API contract.** `server/test/contract/registry/f01-infra.ts:41-47` `F01-auth-config` → `bodyMatches` gains `passwordResetAvailable: true` (the contract stand is Mode 3). No route is added.
- **Scenario.** These extend existing scenarios; no new file.
  - `tests/scenarios/auth/s-auth-07.spec.ts`:
    - Step 1 asserts `passwordResetAvailable`: absent in A, `true` in B, `false` in C.
    - Step 3–4 expects `smtp` to be `toBeUndefined()` in C. It stays `['from','host','port']` in B.
    - New step "forgot-password in mode C → `email_delivery: 'failed'`": a fresh anonymous context, `POST /api/v1/auth/forgot-password` with the member's email, then assert that no `password_reset_tokens` row exists for that user (via `db`).
  - `tests/scenarios/tours/tour-01-anon.spec.ts`, after the walk, step "forgot-password link state" in B/C:
    - `/login` "Forgot password?" is enabled in B; it is disabled in C with the text "SMTP server is not configured" visible.
    - `/forgot-password` in C shows the hint and has a disabled "Send reset link" button.
  - **Mode B "starts with Mailpit, no fail"** is covered by the existing stand start (`scripts/scenarios/stand.mjs` `waitForHealth`, mode B `NODE_ENV=production` + Mailpit) and `tests/scenarios/platform/stand-smoke.spec.ts`. `tests/scenarios/auth/s-auth-01.spec.ts` (signup email delivered) and `s-auth-04.spec.ts` (Mode 3 reset) must stay green. No new step.
  - **Not automated (manual acceptance checks; the stand cannot express them):**
    - "no SMTP log line" in A/C (the stand log is not exposed to fixtures);
    - Mode 2 with an unreachable relay (no stand runs Mode 2 with SMTP);
    - Mode 3 with an unreachable relay refusing to start.

    These are verified once by hand: start the dev server with the respective env and read the log. Record the result in the Notes section of `requirements.md`.

## Visual/UX notes

- **Login page:**
  - Active: as today.
  - Disabled: the same right-aligned text button, greyed (`opacity-60`, `cursor-not-allowed`, no underline on hover), with a one-line `text-xs text-muted-foreground` hint "SMTP server is not configured" directly under it, also right-aligned.
  - Hidden: nothing rendered (only for an old server in Mode 2).
- **`/forgot-password`, unavailable:** the intro paragraph stays. Above the email field sits a muted hint "SMTP server is not configured". The input and the "Send reset link" button are disabled, and "Back to log in" stays active.
- No new UI primitive. Per the `ui-components` skill, update `docs/knowledgebase/client-component-map.md` afterwards.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Server mail + startup validation | 6 | Foundation; every later chunk depends on `isConfigured()` |
| 2 | Server API surfaces | 4 | Needs chunk 1 |
| 3 | Client | 5 | Needs chunk 2's API field |
| 4 | Release template + setup docs | 8 | Wording per Decision 12; independent of client |
| 5 | KB docs | 6 | After behaviour is final |
| 6 | Tests | 8 | Last |

### Chunk 1 — Server mail + startup validation
- [ ] `server/src/mail/mail.service.ts`: make `isConfigured()` per-mode per Design Decision 1; rewrite its doc comment.
- [ ] `mail.service.ts`: make `transporter` nullable and build it only per Design Decision 2; `send()` returns `'failed'` without logging when it is `null`; rewrite the constructor comment (no Mode 2 "best-effort" wording).
- [ ] `mail.service.ts`: rewrite `onModuleInit` per Design Decision 3 (no transporter → silent return; Mode 3 outside `NODE_ENV=test` throws with `host:port` and cause; otherwise the existing warning); update its doc comment and the `connectionTimeout` comment (drop "best-effort").
- [ ] `server/src/auth/auth.service.ts:24`: reword the `NotificationDelivery` comment to `'skipped' = SMTP not configured for this mode (MailService.isConfigured() is false)`.
- [ ] `server/src/auth/config/auth-startup-validation.ts`: extract the Mode 3 SMTP host/from/port/range checks into `validateSmtpBlock()` with identical messages and order; `validateMode3()` calls it (Design Decision 4).
- [ ] `auth-startup-validation.ts`: `validateMode2()` calls `validateSmtpBlock()` after `validatePublicBaseUrl()` only when trimmed `SMTP_HOST` is non-empty; replace the Mode 2 comment block with the per-mode rule from Design Decision 12.

### Chunk 2 — Server API surfaces
- [ ] `server/src/auth/auth.controller.ts`: inject `MailService` into the constructor; add `passwordResetAvailable?: boolean` to the `config()` response type and set it to `mailService.isConfigured()` inside the `password`/`password-confirm` branch (Design Decision 5).
- [ ] `server/src/auth/auth.service.ts` `forgotPassword()`: as its first statement return `{ email_delivery: 'failed' }` when `!this.mailService.isConfigured()` (Design Decision 6).
- [ ] `server/src/admin/admin.service.ts` `getAuthConfig()`: set `smtp` only when `this.mailService.isConfigured()`, reading values without defaults per Design Decision 10.
- [ ] Run server `npm run typecheck` and `npm run lint` (from `server/`) and fix any errors at the root cause.

### Chunk 3 — Client
- [ ] `client/src/models/auth.ts`: add `passwordResetAvailable?: boolean` to `AuthConfig`.
- [ ] Create `client/src/viewer/pages/login/forgot-password-link.ts` exporting `ForgotPasswordLinkState`, `forgotPasswordLinkState(config)` (Design Decision 7) and `SMTP_NOT_CONFIGURED_HINT` (Design Decision 8).
- [ ] `client/src/viewer/pages/login/LoginPage.tsx`: replace `showForgotPassword: boolean` with `forgotPassword: ForgotPasswordLinkState`; render active/disabled+hint/hidden per Design Decision 8 and Visual/UX notes; both password-mode branches (~lines 288–293) pass `forgotPasswordLinkState(config)`.
- [ ] `client/src/viewer/pages/forgot-password/ForgotPasswordPage.tsx`: read `useAuthConfig()`; when `passwordResetAvailable === false` render the hint and disable the input and submit button per Design Decision 9.
- [ ] Run client `bun run typecheck` and `bun run lint` (from `client/`) and fix any errors at the root cause.

### Chunk 4 — Release template + setup docs
- [ ] `release-template/docker-compose.yml`: add the `ADMIN_CONTACT_EMAIL` and `SMTP_*` environment entries listed in Design Decision 11, after `ALLOWED_EMAIL_DOMAINS`, with the comment line from Design Decision 11.
- [ ] `release-template/.env.example`: add a commented-out `ADMIN_CONTACT_EMAIL` + `SMTP_HOST/PORT/FROM/USER/PASSWORD/SECURE` block with the per-mode rule (Design Decision 12).
- [ ] `release-template/INSTALL.md` (~253–257) and `release-template/LOCAL-BUNDLE.md` (~124–128): add SMTP and `ADMIN_CONTACT_EMAIL` rows to the "Settings" table stating required/optional per mode (Design Decision 12).
- [ ] `server/.env.example` (~86–115): rewrite the `ADMIN_CONTACT_EMAIL` and `SMTP_*` comments per Design Decision 12 (remove "fails silently"); set `SMTP_HOST=localhost`, `SMTP_PORT=1025`, and note that the Mode 3 dev default needs a running Mailpit.
- [ ] `client/public/help/security-hardening.md`: rewrite the "Password change" bullet (~101), §3.4 (~121–131) and the mentions at ~265 and ~403 per Design Decision 12; no "best-effort" for Mode 2 reset.
- [ ] `client/public/help/component-reference.md` Mail row (~77): per-mode SMTP rule per Design Decision 12.
- [ ] `README.md` auth modes table (~131–137): Mode 2 SMTP optional (reset unavailable without it); Mode 3 refuses to start without a reachable relay.
- [ ] Grep `client/public/help`, `release-template`, `README.md`, `server/.env.example`, `server/src/mail`, `server/src/auth` for "fails silently" and "best-effort" near SMTP/reset; fix any leftover.

### Chunk 5 — KB docs
- [ ] `docs/knowledgebase/authorization-and-authentificaiton.md`: rewrite ~26–40 (Mode 2 SMTP optional and conditionally validated, Mode 3 reachability fail-fast), ~143–145 (`isConfigured()` per mode), ~284 (no transporter from unset values).
- [ ] `docs/knowledgebase/deployment-auth-mode.md` (~27–29): add the Mode 3 relay-reachability fail-fast and Mode 2 optional SMTP.
- [ ] `docs/knowledgebase/api-reference.md`: `/auth/config` type (~167–173) gains `passwordResetAvailable?`; `/admin/auth` (~945–953) `smtp` presence rule; forgot-password Mode 2-without-SMTP `failed` note.
- [ ] `docs/knowledgebase/server-endpoint-map.md` (~60, ~75): add `passwordResetAvailable` to the `GET config` field list.
- [ ] `docs/knowledgebase/client-component-map.md`: update the `useAuthConfig.ts` (66), `LoginPage.tsx` (108) and `ForgotPasswordPage.tsx` (124) entries; add `forgot-password-link.ts`.
- [ ] `docs/knowledgebase/test/e2e-tests.md` and `docs/knowledgebase/test/overview.md`: note that a dev server in `AUTH_MODE=password-confirm` outside `NODE_ENV=test` refuses to start unless Mailpit (`localhost:1025`) is running.

### Chunk 6 — Tests
- [ ] `docs/knowledgebase/algorithms/auth-startup-config.md`: Rules Mode 2 step (`validateSmtpBlock` when `SMTP_HOST` set) and edge-case index entry; add rows AS-102–AS-107 per Test coverage plan; reword the AS-07 note; add the two Mutations entries.
- [ ] `server/test/contract/registry/f01-infra.ts` `F01-auth-config`: add `passwordResetAvailable: true` to `bodyMatches`.
- [ ] `tests/scenarios/auth/s-auth-07.spec.ts` step 1: assert `passwordResetAvailable` absent in A, `true` in B, `false` in C; step 3–4: `smtp` undefined in C.
- [ ] `s-auth-07.spec.ts`: add mode-C-only step — anonymous `POST /api/v1/auth/forgot-password` with the member's email returns `email_delivery: 'failed'` and leaves no `password_reset_tokens` row for that user.
- [ ] `tests/scenarios/tours/tour-01-anon.spec.ts`: add a B/C step after the walk checking the login link and `/forgot-password` state per Test coverage plan.
- [ ] Update `docs/qaa-overview/scenarios/01-auth-access-admin.md` (S-AUTH-07) and `06-ui-tab-walk.md` (tour 1) with the new checks.
- [ ] Run server `npm run test`, root `npm run typecheck:tests`, then `npm run test:scenarios -- --mode b --only scenarios,contract --grep "@S-AUTH-07|@TOUR-01"` and the same with `--mode c --only scenarios`.
- [ ] Manually verify on the dev server: `none`/`password` without `SMTP_HOST` → no SMTP log line; `password` + `SMTP_HOST=localhost SMTP_PORT=1 SMTP_FROM=x@y.test` → one warning, app starts; `password-confirm` with that relay → no start, log names `localhost:1`. Append observed lines to the Notes section of `requirements.md`.
