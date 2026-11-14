---
reviewed: 2026-10-15
reviewer: ai
---

# Auth startup config: when the server refuses to start

## Purpose

Checks the authentication environment once, at startup, before anything is served. A missing or
malformed setting for the chosen `AUTH_MODE` stops the server with a message naming the variable,
instead of starting a server whose sign-up, e-mail links or SSO break later in front of users.
It also fills in the two documented defaults (`AUTH_MODE`, `PASSWORD_POLICY`).

## Code

- Implementation: `server/src/auth/config/auth-startup-validation.ts`
  (`validateAuthStartupConfig`), with `parseAllowedEmailDomains`
  (`server/src/auth/config/allowed-email-domains.ts`), `isAbsoluteHttpUrl`
  (`server/src/common/public-base-url.ts`) and `isProduction` (`server/src/common/runtime-env.ts`).
- Twins: Work Hub's Rust port `work-hub/server/src/auth/startup.rs`
  (`validate_auth_startup_config`). Work Hub reads `WORK_HUB_ENV` where Log Hub reads `NODE_ENV`:
  the table test maps the rows' `NODE_ENV` (default `test`) to it, and only the exact value
  `production` means production. A real Work Hub refuses any `WORK_HUB_ENV` other than
  `production`, `development` or `test` before this validation runs. It runs every row in
  `work-hub/server/tests/algo.rs` (`cargo test --test algo`, i.e. `npm run test:algo` from
  `work-hub/`).
- Test: `server/src/auth/config/auth-startup-validation.algo.spec.ts`.

## Rules

The server runs this check at startup unless `NODE_ENV` is `test` (`app.module.ts`; the e2e
suites start one shared server in every mode). All values are read from the environment. "Empty" means unset, `""` or only whitespace. A
non-empty value is used as it is, without trimming, unless a step says otherwise. The checks run
in this order and the **first** failure stops the server with a thrown `Error` whose message is
given below (`<v>` is the offending value as it was read, untrimmed, except for
`PUBLIC_BASE_URL`, which is reported trimmed). "Must be set" fails with
`<NAME> environment variable is required when AUTH_MODE requires it`.

1. `AUTH_MODE` empty: it becomes `password` and is written back (installs that predate
   `AUTH_MODE`). Otherwise it must be exactly one of `none`, `password`, `password-confirm`,
   `azure-oauth` (case matters, no trimming), else
   `AUTH_MODE environment variable has an unrecognized value "<v>"; must be one of none, password,
   password-confirm, azure-oauth`.
2. Per mode:
   - `none`: nothing to check.
   - `password`, in order:
     1. the `PUBLIC_BASE_URL` rule (below);
     2. only when `SMTP_HOST` is not empty: the SMTP block, i.e. `password-confirm` steps 4 and 5
        (same messages, same order). When `SMTP_HOST` is empty, every other `SMTP_*` value is
        ignored (SMTP is optional in this mode; password reset is then unavailable).
   - `password-confirm`, in order:
     1. the `PUBLIC_BASE_URL` rule;
     2. `ALLOWED_EMAIL_DOMAINS`, if not empty, is split on `,`; each entry, trimmed and
        lowercased, is checked in this order and the first bad entry in list order fails:
        empty -> `ALLOWED_EMAIL_DOMAINS contains an empty entry, got: <whole value>`; contains
        `@` -> `ALLOWED_EMAIL_DOMAINS entries must be domains without "@", got: <entry>`;
        contains whitespace -> `ALLOWED_EMAIL_DOMAINS entries must not contain whitespace, got:
        <entry>`; not two or more dot-separated labels of `a-z`, `0-9`, `-` (a label may be
        all hyphens) -> `ALLOWED_EMAIL_DOMAINS entry is not a valid domain, got: <entry>`;
     3. `ADMIN_CONTACT_EMAIL` not empty, else
        `ADMIN_CONTACT_EMAIL environment variable is required for AUTH_MODE=password-confirm`;
        then, untrimmed, a valid address by class-validator `isEmail` defaults (one `@`, a
        top-level domain of letters is required, no spaces anywhere, no display name), else
        `ADMIN_CONTACT_EMAIL environment variable must be a valid email address, got: <v>`;
     4. `SMTP_HOST`, `SMTP_FROM`, `SMTP_PORT` must be set, in that order;
     5. `Number(SMTP_PORT)` (which ignores surrounding spaces and also reads hex `0x19`, binary
        `0b11001`, octal `0o31` and exponents `1e3`; `Infinity` is not an integer) is an integer from 1 to 65535,
        else `SMTP_PORT environment variable must be an integer between 1 and 65535, got: <v>`.
   - `azure-oauth`, in order:
     1. `AZURE_TENANT_ID` must be set; trimmed, it must be a GUID (`8-4-4-4-12` hex digits, any
        case), else `AZURE_TENANT_ID must be a tenant GUID; multi-tenant values
        (common/organizations/consumers/domain) are not supported`;
     2. `AZURE_AUTHORITY`, if not empty: trimmed; if it parses as a URL its path (as the URL parser
        normalizes it), otherwise the raw text, is split on `/`, and one piece must equal the tenant ignoring case (a piece
        that only contains the GUID does not count; the query string is never looked at), else
        `AZURE_AUTHORITY must point at tenant <tenant>` (the trimmed tenant);
     3. `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_REDIRECT_URI` must be set, in that
        order;
     4. `AZURE_REDIRECT_URI` parses as an absolute URL of any scheme (the URL parser ignores
        surrounding spaces), else
        `AZURE_REDIRECT_URI environment variable must be an absolute URL, got: <v>`;
     5. `AZURE_SCOPES` set to exactly `""` fails with
        `AZURE_SCOPES environment variable must not be set to an empty string` (unset is fine: a
        default list is used; spaces are passed on as they are).
   - The `PUBLIC_BASE_URL` rule (modes `password` and `password-confirm` only): if empty, it
     fails only when `NODE_ENV` is exactly `production`, with `PUBLIC_BASE_URL environment
     variable is required in production for AUTH_MODE=password and password-confirm (emailed links
     are built from it)`; if set, trimmed, it must be an absolute `http:` or `https:` URL, else
     `PUBLIC_BASE_URL environment variable must be an absolute http(s) URL, got: <v>`.
3. `PASSWORD_POLICY` empty: it becomes `long` and is written back. Otherwise it must be exactly
   one of `any`, `mid`, `long` (no trimming), else
   `PASSWORD_POLICY environment variable must be one of any, mid, long, got: <v>`.

## Edge cases

- `AUTH_MODE` unset, empty, wrong case, padded: AS-01, AS-02, AS-03, AS-42.
- First failure wins: AS-04 (mode before policy), AS-19 (domains before e-mail), AS-54
  (`PUBLIC_BASE_URL` before SMTP).
- `PUBLIC_BASE_URL` empty in production vs development, malformed, relative: AS-06, AS-07, AS-08,
  AS-55; not needed by `none` and `azure-oauth` even in production: AS-41, AS-40.
- `SMTP_PORT` boundaries 0/1/65535/65536, negative, a fraction, text, padded, missing: AS-12..AS-16,
  AS-46, AS-48, AS-47, AS-45. Other SMTP values missing: AS-17, AS-44.
- Mode `password` SMTP block: checked when `SMTP_HOST` is set (missing `SMTP_FROM`, missing
  `SMTP_PORT`, port 0, full block): AS-102..AS-105; ignored when `SMTP_HOST` is unset or
  spaces only: AS-106, AS-107.
- Admin e-mail missing, spaces, no `@`, no top-level domain, leading space: AS-10, AS-50,
  AS-11, AS-49, AS-58.
- Spaces-only values: `AUTH_MODE` (AS-02), policy (AS-20), `SMTP_HOST` (AS-59), domain list
  (AS-60), `PUBLIC_BASE_URL` in production (AS-61), `AZURE_AUTHORITY` (AS-62), tenant padded
  (AS-57), `AZURE_SCOPES` (AS-38).
- More order rows: AS-63 (e-mail before SMTP), AS-64 (`SMTP_FROM` before `SMTP_PORT`), AS-65
  (`PUBLIC_BASE_URL` before domains), AS-66 (tenant before client id), AS-67 (redirect before
  scopes), AS-68 (inside one domain entry).
- Production is exactly `production`: AS-70. A hyphens-only domain label passes: AS-69.
- Domain list: valid, `@`, empty entry, inner space, one label: AS-18, AS-19, AS-51..AS-53;
  ignored outside password-confirm: AS-56.
- Policy empty, whitespace, valid, wrong case, padded: AS-01, AS-20, AS-21, AS-22, AS-43.
- Azure: each required value missing (AS-28..AS-31); tenant alias or domain (AS-24, AS-37); GUID
  case (AS-32, AS-33); authority on another tenant, GUID only inside a segment or in the query,
  not a URL (AS-25, AS-34, AS-35, AS-36); relative or non-http redirect (AS-26, AS-39); scopes
  empty vs spaces (AS-27, AS-38).

## Examples

`input.env` lists the variables that are set; every other auth variable (`AUTH_MODE`,
`PASSWORD_POLICY`, `PUBLIC_BASE_URL`, `ALLOWED_EMAIL_DOMAINS`, `ADMIN_CONTACT_EMAIL`, `SMTP_*`,
`AZURE_*`) is unset, and `NODE_ENV` is `test` unless the row sets it. A passing row expects
`{"ok": true}` plus the values of `AUTH_MODE` and `PASSWORD_POLICY` after the call (the
defaults are written back). A failing row expects `{"ok": false}` and a substring of the error
message.

Shared values in the rows: SMTP block `SMTP_HOST=smtp.arrakis.test`, `SMTP_PORT=587`,
`SMTP_FROM=hub@arrakis.test`, `ADMIN_CONTACT_EMAIL=admin@arrakis.test`; Azure block with tenant
`11111111-2222-3333-4444-555555555555`, or `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee` where a row
needs hex letters (AS-32, AS-33, AS-57, AS-62, AS-66, AS-67).

Rows (107): [`docs/algorithm-examples/auth-startup-config.json`](../../algorithm-examples/auth-startup-config.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Unset `AUTH_MODE` refused instead of defaulted -> AS-01.
- Case-insensitive mode or policy match -> AS-03, AS-22.
- Policy checked before mode -> AS-04.
- `PUBLIC_BASE_URL` required outside production too -> AS-09; not required in production ->
  AS-06; any scheme accepted -> AS-08.
- Port range `< 1` written `<= 1`, or `> 65535` written `>= 65535` -> AS-13, AS-14; integer
  check dropped -> AS-16.
- Domain list checked after the admin e-mail -> AS-19 (reports the e-mail instead).
- Whitespace-only policy treated as a value -> AS-20.
- Tenant aliases accepted -> AS-24; authority not compared with the tenant -> AS-25.
- `AZURE_SCOPES` empty string allowed -> AS-27; spaces refused too -> AS-38.
- Any required Azure value not checked -> AS-28..AS-31; `SMTP_FROM` / `SMTP_PORT` not checked ->
  AS-44 / AS-45.
- GUID pattern without `i` -> AS-32; authority compared case-sensitively -> AS-33; authority
  checked with `includes` -> AS-34, AS-35; no fallback for a non-URL authority -> AS-36.
- Redirect URI required to be http(s) -> AS-39.
- `PUBLIC_BASE_URL` rule applied to every mode -> AS-40, AS-41.
- Mode or policy trimmed before the list check -> AS-42, AS-43.
- `parseInt` instead of `Number` for the port -> AS-16 (`25`), AS-48 unchanged; `Number`
  replaced by a strict digits check -> AS-47.
- E-mail check without a top-level domain requirement -> AS-49; spaces-only e-mail treated as
  set -> AS-50.
- Domain list: empty entries skipped -> AS-51; inner whitespace allowed -> AS-52; one label
  allowed -> AS-53.
- SMTP checked before `PUBLIC_BASE_URL` -> AS-54.
- Tenant not trimmed -> AS-57; e-mail trimmed before the check -> AS-58; a spaces-only value
  taken as set -> AS-59, AS-61, AS-62; spaces-only domain list checked -> AS-60.
- Pairs of checks swapped: e-mail and SMTP -> AS-63; `SMTP_HOST` and `SMTP_FROM` -> AS-71;
  `SMTP_FROM` and `SMTP_PORT` -> AS-64; `PUBLIC_BASE_URL` and domains -> AS-65; tenant and client
  id -> AS-66; authority and client id -> AS-74; client id and secret -> AS-72; secret and
  redirect -> AS-73; redirect and scopes -> AS-67. Checks inside a domain entry reordered ->
  AS-68; the list checked kind by kind instead of entry by entry -> AS-75.
- GUID character class loosened -> AS-95; group lengths loosened in the middle -> AS-96.
- Policy list missing `any` or `long` -> AS-97, AS-98.
- GUID pattern without the end anchor -> AS-76; without the start anchor -> AS-81.
- Authority checked only at its first path piece -> AS-91; case folded on one side only -> AS-99.
- E-mail check accepting a display name or two @ -> AS-100, AS-101. Domain labels allowed to be empty at
  the start -> AS-92. Port or redirect reported trimmed -> AS-93, AS-94.
- Authority compared with the untrimmed tenant -> AS-82; message with the untrimmed tenant ->
  AS-89. Authority always split as raw text -> AS-84. Policy checked before the mode's checks ->
  AS-85. `PUBLIC_BASE_URL` reported untrimmed -> AS-86; domain entry reported raw -> AS-87; the
  empty-entry message without the whole value -> AS-88. GUID group lengths loosened -> AS-90. Port read with `parseInt` -> AS-83 (0). Domain labels allowing `_`, empty labels or a trailing
  dot -> AS-77, AS-78, AS-79. `PUBLIC_BASE_URL` limited to https -> AS-80.
- Domain labels required to start with a letter or digit -> AS-69.
- Production detected case-insensitively -> AS-70.
- Mode `password` SMTP block checked when `SMTP_HOST` is unset -> AS-106, AS-107 (a spaces-only
  host taken as set -> AS-107).
- Mode `password` SMTP block not checked when `SMTP_HOST` is set -> AS-102..AS-104.

## Where the result is visible

Safe behaviour: the server process exits at startup and the log shows the message of the
first failed check (outside `NODE_ENV=test`, where the check is skipped); the defaults are visible in `GET /api/v1/auth/config` (`mode`).
