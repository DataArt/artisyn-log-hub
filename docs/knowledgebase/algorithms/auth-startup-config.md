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
- Twins: none.
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

```examples
[
  {
    "id": "AS-01",
    "input": {"env": {}},
    "expected": {"ok": true, "AUTH_MODE": "password", "PASSWORD_POLICY": "long"},
    "note": "Rule 1: empty mode becomes password; its PUBLIC_BASE_URL rule passes outside production. Rule 3: empty policy becomes long."
  },
  {
    "id": "AS-02",
    "input": {"env": {"AUTH_MODE": "  "}},
    "expected": {"ok": true, "AUTH_MODE": "password", "PASSWORD_POLICY": "long"},
    "note": "Rule 1: whitespace-only is empty, so password."
  },
  {
    "id": "AS-03",
    "input": {"env": {"AUTH_MODE": "Password"}},
    "expected": {"ok": false, "error": "AUTH_MODE environment variable has an unrecognized value \"Password\""},
    "note": "Rule 1: the list is case-sensitive; 'Password' is not 'password'."
  },
  {
    "id": "AS-04",
    "input": {"env": {"AUTH_MODE": "sso", "PASSWORD_POLICY": "strict"}},
    "expected": {"ok": false, "error": "AUTH_MODE environment variable has an unrecognized value \"sso\""},
    "note": "Order: rule 1 fails before rule 3 is reached, so the mode is reported, not the policy."
  },
  {
    "id": "AS-05",
    "input": {"env": {"AUTH_MODE": "none"}},
    "expected": {"ok": true, "AUTH_MODE": "none", "PASSWORD_POLICY": "long"},
    "note": "Rule 2, none: nothing to check; rule 3 still defaults the policy."
  },
  {
    "id": "AS-06",
    "input": {"env": {"AUTH_MODE": "password", "NODE_ENV": "production"}},
    "expected": {"ok": false, "error": "PUBLIC_BASE_URL environment variable is required in production"},
    "note": "PUBLIC_BASE_URL rule: empty is refused in production."
  },
  {
    "id": "AS-07",
    "input": {"env": {"AUTH_MODE": "password", "NODE_ENV": "production", "PUBLIC_BASE_URL": "https://hub.arrakis.test"}},
    "expected": {"ok": true, "AUTH_MODE": "password", "PASSWORD_POLICY": "long"},
    "note": "PUBLIC_BASE_URL rule: set to an absolute https URL passes in production; in password mode SMTP unset is allowed."
  },
  {
    "id": "AS-08",
    "input": {"env": {"AUTH_MODE": "password", "PUBLIC_BASE_URL": "ftp://hub.arrakis.test"}},
    "expected": {"ok": false, "error": "PUBLIC_BASE_URL environment variable must be an absolute http(s) URL"},
    "note": "PUBLIC_BASE_URL rule: a set value must be http or https, even outside production."
  },
  {
    "id": "AS-09",
    "input": {"env": {"AUTH_MODE": "password-confirm", "ADMIN_CONTACT_EMAIL": "admin@arrakis.test", "SMTP_HOST": "smtp.arrakis.test", "SMTP_PORT": "587", "SMTP_FROM": "hub@arrakis.test"}},
    "expected": {"ok": true, "AUTH_MODE": "password-confirm", "PASSWORD_POLICY": "long"},
    "note": "Rule 2, password-confirm: every step passes (no PUBLIC_BASE_URL needed outside production, no domain list)."
  },
  {
    "id": "AS-10",
    "input": {"env": {"AUTH_MODE": "password-confirm", "SMTP_HOST": "smtp.arrakis.test", "SMTP_PORT": "587", "SMTP_FROM": "hub@arrakis.test"}},
    "expected": {"ok": false, "error": "ADMIN_CONTACT_EMAIL environment variable is required for AUTH_MODE=password-confirm"},
    "note": "Step 3: admin e-mail empty."
  },
  {
    "id": "AS-11",
    "input": {"env": {"AUTH_MODE": "password-confirm", "ADMIN_CONTACT_EMAIL": "admin-at-arrakis", "SMTP_HOST": "smtp.arrakis.test", "SMTP_PORT": "587", "SMTP_FROM": "hub@arrakis.test"}},
    "expected": {"ok": false, "error": "ADMIN_CONTACT_EMAIL environment variable must be a valid email address"},
    "note": "Step 3: 'admin-at-arrakis' has no @, so it is not an e-mail address."
  },
  {
    "id": "AS-12",
    "input": {"env": {"AUTH_MODE": "password-confirm", "ADMIN_CONTACT_EMAIL": "admin@arrakis.test", "SMTP_HOST": "smtp.arrakis.test", "SMTP_PORT": "0", "SMTP_FROM": "hub@arrakis.test"}},
    "expected": {"ok": false, "error": "SMTP_PORT environment variable must be an integer between 1 and 65535"},
    "note": "Step 5: 0 < 1."
  },
  {
    "id": "AS-13",
    "input": {"env": {"AUTH_MODE": "password-confirm", "ADMIN_CONTACT_EMAIL": "admin@arrakis.test", "SMTP_HOST": "smtp.arrakis.test", "SMTP_PORT": "1", "SMTP_FROM": "hub@arrakis.test"}},
    "expected": {"ok": true, "AUTH_MODE": "password-confirm", "PASSWORD_POLICY": "long"},
    "note": "Step 5: 1 is the lowest allowed port."
  },
  {
    "id": "AS-14",
    "input": {"env": {"AUTH_MODE": "password-confirm", "ADMIN_CONTACT_EMAIL": "admin@arrakis.test", "SMTP_HOST": "smtp.arrakis.test", "SMTP_PORT": "65535", "SMTP_FROM": "hub@arrakis.test"}},
    "expected": {"ok": true, "AUTH_MODE": "password-confirm", "PASSWORD_POLICY": "long"},
    "note": "Step 5: 65535 is the highest allowed port."
  },
  {
    "id": "AS-15",
    "input": {"env": {"AUTH_MODE": "password-confirm", "ADMIN_CONTACT_EMAIL": "admin@arrakis.test", "SMTP_HOST": "smtp.arrakis.test", "SMTP_PORT": "65536", "SMTP_FROM": "hub@arrakis.test"}},
    "expected": {"ok": false, "error": "SMTP_PORT environment variable must be an integer between 1 and 65535"},
    "note": "Step 5: 65536 > 65535."
  },
  {
    "id": "AS-16",
    "input": {"env": {"AUTH_MODE": "password-confirm", "ADMIN_CONTACT_EMAIL": "admin@arrakis.test", "SMTP_HOST": "smtp.arrakis.test", "SMTP_PORT": "25.5", "SMTP_FROM": "hub@arrakis.test"}},
    "expected": {"ok": false, "error": "SMTP_PORT environment variable must be an integer between 1 and 65535"},
    "note": "Step 5: 25.5 is in range but not an integer."
  },
  {
    "id": "AS-17",
    "input": {"env": {"AUTH_MODE": "password-confirm", "ADMIN_CONTACT_EMAIL": "admin@arrakis.test", "SMTP_PORT": "587", "SMTP_FROM": "hub@arrakis.test"}},
    "expected": {"ok": false, "error": "SMTP_HOST environment variable is required"},
    "note": "Step 4: SMTP_HOST empty."
  },
  {
    "id": "AS-18",
    "input": {"env": {"AUTH_MODE": "password-confirm", "ALLOWED_EMAIL_DOMAINS": "arrakis.test, Caladan.Test", "ADMIN_CONTACT_EMAIL": "admin@arrakis.test", "SMTP_HOST": "smtp.arrakis.test", "SMTP_PORT": "587", "SMTP_FROM": "hub@arrakis.test"}},
    "expected": {"ok": true, "AUTH_MODE": "password-confirm", "PASSWORD_POLICY": "long"},
    "note": "Step 2: entries are trimmed and lowercased ('caladan.test'), both are label.label domains."
  },
  {
    "id": "AS-19",
    "input": {"env": {"AUTH_MODE": "password-confirm", "ALLOWED_EMAIL_DOMAINS": "arrakis.test,@caladan.test", "SMTP_HOST": "smtp.arrakis.test", "SMTP_PORT": "587", "SMTP_FROM": "hub@arrakis.test"}},
    "expected": {"ok": false, "error": "ALLOWED_EMAIL_DOMAINS entries must be domains without \"@\""},
    "note": "Step 2 runs before step 3: the '@' entry is reported although ADMIN_CONTACT_EMAIL is also missing."
  },
  {
    "id": "AS-20",
    "input": {"env": {"AUTH_MODE": "none", "PASSWORD_POLICY": "   "}},
    "expected": {"ok": true, "AUTH_MODE": "none", "PASSWORD_POLICY": "long"},
    "note": "Rule 3: whitespace-only is empty, so long."
  },
  {
    "id": "AS-21",
    "input": {"env": {"AUTH_MODE": "none", "PASSWORD_POLICY": "mid"}},
    "expected": {"ok": true, "AUTH_MODE": "none", "PASSWORD_POLICY": "mid"},
    "note": "Rule 3: a valid value is kept as is."
  },
  {
    "id": "AS-22",
    "input": {"env": {"AUTH_MODE": "none", "PASSWORD_POLICY": "Long"}},
    "expected": {"ok": false, "error": "PASSWORD_POLICY environment variable must be one of any, mid, long, got: Long"},
    "note": "Rule 3: the list is case-sensitive."
  },
  {
    "id": "AS-23",
    "input": {"env": {"AUTH_MODE": "azure-oauth", "AZURE_TENANT_ID": "11111111-2222-3333-4444-555555555555", "AZURE_CLIENT_ID": "client", "AZURE_CLIENT_SECRET": "secret", "AZURE_REDIRECT_URI": "https://hub.arrakis.test/api/v1/auth/azure/callback", "AZURE_AUTHORITY": "https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555"}},
    "expected": {"ok": true, "AUTH_MODE": "azure-oauth", "PASSWORD_POLICY": "long"},
    "note": "Rule 2, azure-oauth: GUID tenant, authority path contains it, all three values set, absolute redirect, scopes unset."
  },
  {
    "id": "AS-24",
    "input": {"env": {"AUTH_MODE": "azure-oauth", "AZURE_TENANT_ID": "common", "AZURE_CLIENT_ID": "client", "AZURE_CLIENT_SECRET": "secret", "AZURE_REDIRECT_URI": "https://hub.arrakis.test/cb"}},
    "expected": {"ok": false, "error": "AZURE_TENANT_ID must be a tenant GUID"},
    "note": "Step 1: 'common' is a multi-tenant alias, not a GUID."
  },
  {
    "id": "AS-25",
    "input": {"env": {"AUTH_MODE": "azure-oauth", "AZURE_TENANT_ID": "11111111-2222-3333-4444-555555555555", "AZURE_AUTHORITY": "https://login.microsoftonline.com/99999999-2222-3333-4444-555555555555", "AZURE_CLIENT_ID": "client", "AZURE_CLIENT_SECRET": "secret", "AZURE_REDIRECT_URI": "https://hub.arrakis.test/cb"}},
    "expected": {"ok": false, "error": "AZURE_AUTHORITY must point at tenant 11111111-2222-3333-4444-555555555555"},
    "note": "Step 2: no path segment of the authority equals the tenant GUID."
  },
  {
    "id": "AS-26",
    "input": {"env": {"AUTH_MODE": "azure-oauth", "AZURE_TENANT_ID": "11111111-2222-3333-4444-555555555555", "AZURE_CLIENT_ID": "client", "AZURE_CLIENT_SECRET": "secret", "AZURE_REDIRECT_URI": "/api/v1/auth/azure/callback"}},
    "expected": {"ok": false, "error": "AZURE_REDIRECT_URI environment variable must be an absolute URL"},
    "note": "Step 4: a path without scheme and host is not an absolute URL."
  },
  {
    "id": "AS-27",
    "input": {"env": {"AUTH_MODE": "azure-oauth", "AZURE_TENANT_ID": "11111111-2222-3333-4444-555555555555", "AZURE_CLIENT_ID": "client", "AZURE_CLIENT_SECRET": "secret", "AZURE_REDIRECT_URI": "https://hub.arrakis.test/cb", "AZURE_SCOPES": ""}},
    "expected": {"ok": false, "error": "AZURE_SCOPES environment variable must not be set to an empty string"},
    "note": "Step 5: set but empty is refused (unset, as in AS-23, is fine)."
  },
  {
    "id": "AS-28",
    "input": {"env": {"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"11111111-2222-3333-4444-555555555555","AZURE_CLIENT_SECRET":"secret","AZURE_REDIRECT_URI":"https://hub.arrakis.test/cb"}},
    "expected": {"ok":false,"error":"AZURE_CLIENT_ID environment variable is required when AUTH_MODE requires it"},
    "note": "Azure step 3: client id empty; the generic \"required\" message names the variable."
  },
  {
    "id": "AS-29",
    "input": {"env": {"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"11111111-2222-3333-4444-555555555555","AZURE_CLIENT_ID":"client","AZURE_REDIRECT_URI":"https://hub.arrakis.test/cb"}},
    "expected": {"ok":false,"error":"AZURE_CLIENT_SECRET environment variable is required"},
    "note": "Azure step 3: client secret empty."
  },
  {
    "id": "AS-30",
    "input": {"env": {"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"11111111-2222-3333-4444-555555555555","AZURE_CLIENT_ID":"client","AZURE_CLIENT_SECRET":"secret"}},
    "expected": {"ok":false,"error":"AZURE_REDIRECT_URI environment variable is required"},
    "note": "Azure step 3: redirect URI empty (checked before step 4 parses it)."
  },
  {
    "id": "AS-31",
    "input": {"env": {"AUTH_MODE":"azure-oauth","AZURE_CLIENT_ID":"client","AZURE_CLIENT_SECRET":"secret","AZURE_REDIRECT_URI":"https://hub.arrakis.test/cb"}},
    "expected": {"ok":false,"error":"AZURE_TENANT_ID environment variable is required"},
    "note": "Azure step 1: the tenant must be set before its GUID shape is checked."
  },
  {
    "id": "AS-32",
    "input": {"env":{"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE","AZURE_CLIENT_ID":"client","AZURE_CLIENT_SECRET":"secret","AZURE_REDIRECT_URI":"https://hub.arrakis.test/cb"}},
    "expected": {"ok":true,"AUTH_MODE":"azure-oauth","PASSWORD_POLICY":"long"},
    "note": "Azure step 1: the GUID check ignores case; the tenant written in upper-case hex letters passes."
  },
  {
    "id": "AS-33",
    "input": {"env":{"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","AZURE_CLIENT_ID":"client","AZURE_CLIENT_SECRET":"secret","AZURE_REDIRECT_URI":"https://hub.arrakis.test/cb","AZURE_AUTHORITY":"https://login.microsoftonline.com/AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE/v2.0"}},
    "expected": {"ok":true,"AUTH_MODE":"azure-oauth","PASSWORD_POLICY":"long"},
    "note": "Azure step 2 ignores case: the authority segment is the tenant in upper case while AZURE_TENANT_ID is lower case."
  },
  {
    "id": "AS-34",
    "input": {"env": {"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"11111111-2222-3333-4444-555555555555","AZURE_CLIENT_ID":"client","AZURE_CLIENT_SECRET":"secret","AZURE_REDIRECT_URI":"https://hub.arrakis.test/cb","AZURE_AUTHORITY":"https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555-suffix"}},
    "expected": {"ok":false,"error":"AZURE_AUTHORITY must point at tenant 11111111-2222-3333-4444-555555555555"},
    "note": "Azure step 2 compares whole path segments: \"<guid>-suffix\" contains the GUID but is not equal to it."
  },
  {
    "id": "AS-35",
    "input": {"env": {"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"11111111-2222-3333-4444-555555555555","AZURE_CLIENT_ID":"client","AZURE_CLIENT_SECRET":"secret","AZURE_REDIRECT_URI":"https://hub.arrakis.test/cb","AZURE_AUTHORITY":"https://login.microsoftonline.com/common?tenant=11111111-2222-3333-4444-555555555555"}},
    "expected": {"ok":false,"error":"AZURE_AUTHORITY must point at tenant 11111111-2222-3333-4444-555555555555"},
    "note": "Azure step 2 looks at the URL path only; the GUID in the query string does not count (path segments: \"\", \"common\")."
  },
  {
    "id": "AS-36",
    "input": {"env": {"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"11111111-2222-3333-4444-555555555555","AZURE_CLIENT_ID":"client","AZURE_CLIENT_SECRET":"secret","AZURE_REDIRECT_URI":"https://hub.arrakis.test/cb","AZURE_AUTHORITY":"login.microsoftonline.com/11111111-2222-3333-4444-555555555555"}},
    "expected": {"ok":true,"AUTH_MODE":"azure-oauth","PASSWORD_POLICY":"long"},
    "note": "Azure step 2: not a URL, so the raw text is split on \"/\"; the second piece equals the tenant."
  },
  {
    "id": "AS-37",
    "input": {"env": {"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"arrakis.onmicrosoft.com","AZURE_CLIENT_ID":"client","AZURE_CLIENT_SECRET":"secret","AZURE_REDIRECT_URI":"https://hub.arrakis.test/cb"}},
    "expected": {"ok":false,"error":"AZURE_TENANT_ID must be a tenant GUID"},
    "note": "Azure step 1: a tenant domain is not a GUID."
  },
  {
    "id": "AS-38",
    "input": {"env": {"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"11111111-2222-3333-4444-555555555555","AZURE_CLIENT_ID":"client","AZURE_CLIENT_SECRET":"secret","AZURE_REDIRECT_URI":"https://hub.arrakis.test/cb","AZURE_SCOPES":"  "}},
    "expected": {"ok":true,"AUTH_MODE":"azure-oauth","PASSWORD_POLICY":"long"},
    "note": "Azure step 5 refuses exactly \"\" only; spaces are passed on as a scope list."
  },
  {
    "id": "AS-39",
    "input": {"env": {"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"11111111-2222-3333-4444-555555555555","AZURE_CLIENT_ID":"client","AZURE_CLIENT_SECRET":"secret","AZURE_REDIRECT_URI":"urn:arrakis:callback"}},
    "expected": {"ok":true,"AUTH_MODE":"azure-oauth","PASSWORD_POLICY":"long"},
    "note": "Azure step 4 only needs an absolute URL of any scheme; urn: parses."
  },
  {
    "id": "AS-40",
    "input": {"env": {"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"11111111-2222-3333-4444-555555555555","AZURE_CLIENT_ID":"client","AZURE_CLIENT_SECRET":"secret","AZURE_REDIRECT_URI":"https://hub.arrakis.test/cb","NODE_ENV":"production"}},
    "expected": {"ok":true,"AUTH_MODE":"azure-oauth","PASSWORD_POLICY":"long"},
    "note": "The PUBLIC_BASE_URL rule belongs to password and password-confirm only; azure-oauth starts in production without it."
  },
  {
    "id": "AS-41",
    "input": {"env": {"AUTH_MODE":"none","NODE_ENV":"production"}},
    "expected": {"ok":true,"AUTH_MODE":"none","PASSWORD_POLICY":"long"},
    "note": "Mode none checks nothing, not even PUBLIC_BASE_URL in production."
  },
  {
    "id": "AS-42",
    "input": {"env": {"AUTH_MODE":" none"}},
    "expected": {"ok":false,"error":"AUTH_MODE environment variable has an unrecognized value \" none\""},
    "note": "Rule 1: a non-empty mode is not trimmed, so \" none\" is not \"none\"."
  },
  {
    "id": "AS-43",
    "input": {"env": {"AUTH_MODE":"none","PASSWORD_POLICY":"mid "}},
    "expected": {"ok":false,"error":"PASSWORD_POLICY environment variable must be one of any, mid, long, got: mid "},
    "note": "Rule 3: a non-empty policy is not trimmed."
  },
  {
    "id": "AS-44",
    "input": {"env": {"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"admin@arrakis.test","SMTP_HOST":"smtp.arrakis.test","SMTP_PORT":"587"}},
    "expected": {"ok":false,"error":"SMTP_FROM environment variable is required"},
    "note": "Step 4: SMTP_FROM empty."
  },
  {
    "id": "AS-45",
    "input": {"env": {"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"admin@arrakis.test","SMTP_HOST":"smtp.arrakis.test","SMTP_FROM":"hub@arrakis.test"}},
    "expected": {"ok":false,"error":"SMTP_PORT environment variable is required"},
    "note": "Step 4: SMTP_PORT empty is reported as required, before the range check."
  },
  {
    "id": "AS-46",
    "input": {"env": {"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"admin@arrakis.test","SMTP_HOST":"smtp.arrakis.test","SMTP_PORT":"-1","SMTP_FROM":"hub@arrakis.test"}},
    "expected": {"ok":false,"error":"SMTP_PORT environment variable must be an integer between 1 and 65535"},
    "note": "Step 5: -1 < 1."
  },
  {
    "id": "AS-47",
    "input": {"env": {"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"admin@arrakis.test","SMTP_HOST":"smtp.arrakis.test","SMTP_PORT":" 587 ","SMTP_FROM":"hub@arrakis.test"}},
    "expected": {"ok":true,"AUTH_MODE":"password-confirm","PASSWORD_POLICY":"long"},
    "note": "Step 5 reads the port with Number(), which ignores surrounding spaces: 587."
  },
  {
    "id": "AS-48",
    "input": {"env": {"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"admin@arrakis.test","SMTP_HOST":"smtp.arrakis.test","SMTP_PORT":"smtp","SMTP_FROM":"hub@arrakis.test"}},
    "expected": {"ok":false,"error":"SMTP_PORT environment variable must be an integer between 1 and 65535"},
    "note": "Step 5: Number(\"smtp\") is NaN, not an integer."
  },
  {
    "id": "AS-49",
    "input": {"env": {"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"admin@arrakis","SMTP_HOST":"smtp.arrakis.test","SMTP_PORT":"587","SMTP_FROM":"hub@arrakis.test"}},
    "expected": {"ok":false,"error":"ADMIN_CONTACT_EMAIL environment variable must be a valid email address"},
    "note": "Step 3: the e-mail check needs a top-level domain; \"arrakis\" has none."
  },
  {
    "id": "AS-50",
    "input": {"env": {"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"   ","SMTP_HOST":"smtp.arrakis.test","SMTP_PORT":"587","SMTP_FROM":"hub@arrakis.test"}},
    "expected": {"ok":false,"error":"ADMIN_CONTACT_EMAIL environment variable is required for AUTH_MODE=password-confirm"},
    "note": "Step 3: spaces only is empty."
  },
  {
    "id": "AS-51",
    "input": {"env": {"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"admin@arrakis.test","SMTP_HOST":"smtp.arrakis.test","SMTP_PORT":"587","SMTP_FROM":"hub@arrakis.test","ALLOWED_EMAIL_DOMAINS":"arrakis.test,,caladan.test"}},
    "expected": {"ok":false,"error":"ALLOWED_EMAIL_DOMAINS contains an empty entry"},
    "note": "Step 2: the entry between the two commas is empty."
  },
  {
    "id": "AS-52",
    "input": {"env": {"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"admin@arrakis.test","SMTP_HOST":"smtp.arrakis.test","SMTP_PORT":"587","SMTP_FROM":"hub@arrakis.test","ALLOWED_EMAIL_DOMAINS":"arra kis.test"}},
    "expected": {"ok":false,"error":"ALLOWED_EMAIL_DOMAINS entries must not contain whitespace"},
    "note": "Step 2: trimming leaves the inner space."
  },
  {
    "id": "AS-53",
    "input": {"env": {"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"admin@arrakis.test","SMTP_HOST":"smtp.arrakis.test","SMTP_PORT":"587","SMTP_FROM":"hub@arrakis.test","ALLOWED_EMAIL_DOMAINS":"arrakis"}},
    "expected": {"ok":false,"error":"ALLOWED_EMAIL_DOMAINS entry is not a valid domain"},
    "note": "Step 2: one label only; a domain needs at least two."
  },
  {
    "id": "AS-54",
    "input": {"env": {"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"admin@arrakis.test","SMTP_PORT":"587","SMTP_FROM":"hub@arrakis.test","NODE_ENV":"production"}},
    "expected": {"ok":false,"error":"PUBLIC_BASE_URL environment variable is required in production"},
    "note": "Order inside password-confirm: the PUBLIC_BASE_URL rule (step 1) fails before the missing SMTP_HOST (step 4) is reached."
  },
  {
    "id": "AS-55",
    "input": {"env": {"AUTH_MODE":"password","PUBLIC_BASE_URL":"/hub"}},
    "expected": {"ok":false,"error":"PUBLIC_BASE_URL environment variable must be an absolute http(s) URL"},
    "note": "PUBLIC_BASE_URL rule: a relative path is not an absolute URL."
  },
  {
    "id": "AS-56",
    "input": {"env": {"AUTH_MODE": "password", "ALLOWED_EMAIL_DOMAINS": "user@arrakis.test,,"}},
    "expected": {"ok": true, "AUTH_MODE": "password", "PASSWORD_POLICY": "long"},
    "note": "The domain list is a password-confirm step only; mode password does not read it, so a malformed list does not stop it."
  },
  {
    "id": "AS-57",
    "input": {"env":{"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"  aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee  ","AZURE_CLIENT_ID":"client","AZURE_CLIENT_SECRET":"secret","AZURE_REDIRECT_URI":"https://hub.arrakis.test/cb"}},
    "expected": {"ok":true,"AUTH_MODE":"azure-oauth","PASSWORD_POLICY":"long"},
    "note": "Azure step 1 trims the tenant before the GUID check."
  },
  {
    "id": "AS-58",
    "input": {"env":{"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":" admin@arrakis.test","SMTP_HOST":"smtp.arrakis.test","SMTP_PORT":"587","SMTP_FROM":"hub@arrakis.test"}},
    "expected": {"ok":false,"error":"ADMIN_CONTACT_EMAIL environment variable must be a valid email address, got:  admin@arrakis.test"},
    "note": "Step 3: the address is checked untrimmed, and a leading space makes it invalid."
  },
  {
    "id": "AS-59",
    "input": {"env":{"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"admin@arrakis.test","SMTP_HOST":"   ","SMTP_PORT":"587","SMTP_FROM":"hub@arrakis.test"}},
    "expected": {"ok":false,"error":"SMTP_HOST environment variable is required when AUTH_MODE requires it"},
    "note": "Step 4: spaces only counts as empty."
  },
  {
    "id": "AS-60",
    "input": {"env":{"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"admin@arrakis.test","SMTP_HOST":"smtp.arrakis.test","SMTP_PORT":"587","SMTP_FROM":"hub@arrakis.test","ALLOWED_EMAIL_DOMAINS":"   "}},
    "expected": {"ok":true,"AUTH_MODE":"password-confirm","PASSWORD_POLICY":"long"},
    "note": "Step 2: an empty (spaces-only) list means no restriction and is not checked."
  },
  {
    "id": "AS-61",
    "input": {"env":{"AUTH_MODE":"password","NODE_ENV":"production","PUBLIC_BASE_URL":"   "}},
    "expected": {"ok":false,"error":"PUBLIC_BASE_URL environment variable is required in production"},
    "note": "PUBLIC_BASE_URL rule: spaces only counts as empty, which production refuses."
  },
  {
    "id": "AS-62",
    "input": {"env":{"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","AZURE_CLIENT_ID":"client","AZURE_CLIENT_SECRET":"secret","AZURE_REDIRECT_URI":"https://hub.arrakis.test/cb","AZURE_AUTHORITY":"   "}},
    "expected": {"ok":true,"AUTH_MODE":"azure-oauth","PASSWORD_POLICY":"long"},
    "note": "Azure step 2: a spaces-only authority counts as not set."
  },
  {
    "id": "AS-63",
    "input": {"env":{"AUTH_MODE":"password-confirm","SMTP_PORT":"587","SMTP_FROM":"hub@arrakis.test"}},
    "expected": {"ok":false,"error":"ADMIN_CONTACT_EMAIL environment variable is required for AUTH_MODE=password-confirm"},
    "note": "Order: step 3 (admin e-mail) fails before step 4 (SMTP_HOST)."
  },
  {
    "id": "AS-64",
    "input": {"env":{"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"admin@arrakis.test","SMTP_HOST":"smtp.arrakis.test"}},
    "expected": {"ok":false,"error":"SMTP_FROM environment variable is required"},
    "note": "Order inside step 4: SMTP_HOST, SMTP_FROM, SMTP_PORT; SMTP_FROM is the first missing one."
  },
  {
    "id": "AS-65",
    "input": {"env":{"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"admin@arrakis.test","SMTP_HOST":"smtp.arrakis.test","SMTP_PORT":"587","SMTP_FROM":"hub@arrakis.test","PUBLIC_BASE_URL":"ftp://hub.arrakis.test","ALLOWED_EMAIL_DOMAINS":"@bad"}},
    "expected": {"ok":false,"error":"PUBLIC_BASE_URL environment variable must be an absolute http(s) URL"},
    "note": "Order: the PUBLIC_BASE_URL rule (step 1) fails before the domain list (step 2)."
  },
  {
    "id": "AS-66",
    "input": {"env":{"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"common","AZURE_CLIENT_SECRET":"secret","AZURE_REDIRECT_URI":"https://hub.arrakis.test/cb"}},
    "expected": {"ok":false,"error":"AZURE_TENANT_ID must be a tenant GUID"},
    "note": "Order: azure step 1 (tenant) fails before step 3 (client id)."
  },
  {
    "id": "AS-67",
    "input": {"env":{"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","AZURE_CLIENT_ID":"client","AZURE_CLIENT_SECRET":"secret","AZURE_REDIRECT_URI":"/cb","AZURE_SCOPES":""}},
    "expected": {"ok":false,"error":"AZURE_REDIRECT_URI environment variable must be an absolute URL, got: /cb"},
    "note": "Order: azure step 4 (redirect) fails before step 5 (scopes)."
  },
  {
    "id": "AS-68",
    "input": {"env":{"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"admin@arrakis.test","SMTP_HOST":"smtp.arrakis.test","SMTP_PORT":"587","SMTP_FROM":"hub@arrakis.test","ALLOWED_EMAIL_DOMAINS":"arrakis.test,a@b c"}},
    "expected": {"ok":false,"error":"ALLOWED_EMAIL_DOMAINS entries must be domains without \"@\", got: a@b c"},
    "note": "Step 2 checks one entry in the order empty, @, whitespace, pattern: \"a@b c\" has both @ and a space, and @ is reported."
  },
  {
    "id": "AS-69",
    "input": {"env":{"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"admin@arrakis.test","SMTP_HOST":"smtp.arrakis.test","SMTP_PORT":"587","SMTP_FROM":"hub@arrakis.test","ALLOWED_EMAIL_DOMAINS":"-.test"}},
    "expected": {"ok":true,"AUTH_MODE":"password-confirm","PASSWORD_POLICY":"long"},
    "note": "Step 2: the label pattern allows a label of hyphens only, so \"-.test\" passes (two labels)."
  },
  {
    "id": "AS-70",
    "input": {"env":{"AUTH_MODE":"password","NODE_ENV":"Production"}},
    "expected": {"ok":true,"AUTH_MODE":"password","PASSWORD_POLICY":"long"},
    "note": "PUBLIC_BASE_URL rule: only NODE_ENV exactly \"production\" counts; \"Production\" is not production, so no base URL is needed."
  },
  {
    "id": "AS-71",
    "input": {"env":{"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"admin@arrakis.test","SMTP_PORT":"587"}},
    "expected": {"ok":false,"error":"SMTP_HOST environment variable is required"},
    "note": "Order inside step 4: SMTP_HOST is checked before SMTP_FROM."
  },
  {
    "id": "AS-72",
    "input": {"env":{"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"11111111-2222-3333-4444-555555555555","AZURE_REDIRECT_URI":"https://hub.arrakis.test/cb"}},
    "expected": {"ok":false,"error":"AZURE_CLIENT_ID environment variable is required"},
    "note": "Order inside azure step 3: client id before secret."
  },
  {
    "id": "AS-73",
    "input": {"env":{"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"11111111-2222-3333-4444-555555555555","AZURE_CLIENT_ID":"client"}},
    "expected": {"ok":false,"error":"AZURE_CLIENT_SECRET environment variable is required"},
    "note": "Order inside azure step 3: secret before redirect URI."
  },
  {
    "id": "AS-74",
    "input": {"env":{"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"11111111-2222-3333-4444-555555555555","AZURE_CLIENT_SECRET":"secret","AZURE_REDIRECT_URI":"https://hub.arrakis.test/cb","AZURE_AUTHORITY":"https://login.microsoftonline.com/common"}},
    "expected": {"ok":false,"error":"AZURE_AUTHORITY must point at tenant 11111111-2222-3333-4444-555555555555"},
    "note": "Order: azure step 2 (authority) fails before step 3 (client id)."
  },
  {
    "id": "AS-75",
    "input": {"env":{"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"admin@arrakis.test","SMTP_HOST":"smtp.arrakis.test","SMTP_PORT":"587","SMTP_FROM":"hub@arrakis.test","ALLOWED_EMAIL_DOMAINS":"a@b.test,,"}},
    "expected": {"ok":false,"error":"ALLOWED_EMAIL_DOMAINS entries must be domains without \"@\", got: a@b.test"},
    "note": "Step 2 goes entry by entry: the first entry already fails on \"@\", before the empty entries after it are reached."
  },
  {
    "id": "AS-76",
    "input": {"env":{"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"11111111-2222-3333-4444-5555555555550","AZURE_CLIENT_ID":"client","AZURE_CLIENT_SECRET":"secret","AZURE_REDIRECT_URI":"https://hub.arrakis.test/cb"}},
    "expected": {"ok":false,"error":"AZURE_TENANT_ID must be a tenant GUID"},
    "note": "Azure step 1: the whole value must be the GUID; one extra character fails."
  },
  {
    "id": "AS-77",
    "input": {"env":{"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"admin@arrakis.test","SMTP_HOST":"smtp.arrakis.test","SMTP_PORT":"587","SMTP_FROM":"hub@arrakis.test","ALLOWED_EMAIL_DOMAINS":"arr_akis.test"}},
    "expected": {"ok":false,"error":"ALLOWED_EMAIL_DOMAINS entry is not a valid domain, got: arr_akis.test"},
    "note": "Step 2: \"_\" is not a label character."
  },
  {
    "id": "AS-78",
    "input": {"env":{"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"admin@arrakis.test","SMTP_HOST":"smtp.arrakis.test","SMTP_PORT":"587","SMTP_FROM":"hub@arrakis.test","ALLOWED_EMAIL_DOMAINS":"arrakis..test"}},
    "expected": {"ok":false,"error":"ALLOWED_EMAIL_DOMAINS entry is not a valid domain, got: arrakis..test"},
    "note": "Step 2: an empty label between two dots is not allowed."
  },
  {
    "id": "AS-79",
    "input": {"env":{"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"admin@arrakis.test","SMTP_HOST":"smtp.arrakis.test","SMTP_PORT":"587","SMTP_FROM":"hub@arrakis.test","ALLOWED_EMAIL_DOMAINS":"arrakis.test."}},
    "expected": {"ok":false,"error":"ALLOWED_EMAIL_DOMAINS entry is not a valid domain, got: arrakis.test."},
    "note": "Step 2: a trailing dot leaves an empty last label."
  },
  {
    "id": "AS-80",
    "input": {"env":{"AUTH_MODE":"password","NODE_ENV":"production","PUBLIC_BASE_URL":"http://hub.arrakis.test"}},
    "expected": {"ok":true,"AUTH_MODE":"password","PASSWORD_POLICY":"long"},
    "note": "PUBLIC_BASE_URL rule: plain http is an accepted scheme too."
  },
  {
    "id": "AS-81",
    "input": {"env":{"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"x11111111-2222-3333-4444-555555555555","AZURE_CLIENT_ID":"client","AZURE_CLIENT_SECRET":"secret","AZURE_REDIRECT_URI":"https://hub.arrakis.test/cb"}},
    "expected": {"ok":false,"error":"AZURE_TENANT_ID must be a tenant GUID"},
    "note": "Azure step 1: one extra character before the GUID fails too (the whole value must match)."
  },
  {
    "id": "AS-82",
    "input": {"env":{"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"  11111111-2222-3333-4444-555555555555  ","AZURE_CLIENT_ID":"client","AZURE_CLIENT_SECRET":"secret","AZURE_REDIRECT_URI":"https://hub.arrakis.test/cb","AZURE_AUTHORITY":"https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555"}},
    "expected": {"ok":true,"AUTH_MODE":"azure-oauth","PASSWORD_POLICY":"long"},
    "note": "Azure step 2 compares the authority with the trimmed tenant, so the padded tenant still matches its authority segment."
  },
  {
    "id": "AS-83",
    "input": {"env":{"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"admin@arrakis.test","SMTP_HOST":"smtp.arrakis.test","SMTP_PORT":"0x19","SMTP_FROM":"hub@arrakis.test"}},
    "expected": {"ok":true,"AUTH_MODE":"password-confirm","PASSWORD_POLICY":"long"},
    "note": "Step 5: Number(\"0x19\") is 25, an integer in range, so the hex form passes."
  },
  {
    "id": "AS-84",
    "input": {"env":{"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"11111111-2222-3333-4444-555555555555","AZURE_CLIENT_ID":"client","AZURE_CLIENT_SECRET":"secret","AZURE_REDIRECT_URI":"https://hub.arrakis.test/cb","AZURE_AUTHORITY":"https://login.microsoftonline.com/common?x=/11111111-2222-3333-4444-555555555555"}},
    "expected": {"ok":false,"error":"AZURE_AUTHORITY must point at tenant 11111111-2222-3333-4444-555555555555"},
    "note": "Azure step 2: the authority parses as a URL, so only its path (/common) is split; the GUID after \"?x=/\" is in the query and does not count."
  },
  {
    "id": "AS-85",
    "input": {"env":{"AUTH_MODE":"password","PUBLIC_BASE_URL":"ftp://hub.arrakis.test","PASSWORD_POLICY":"bad"}},
    "expected": {"ok":false,"error":"PUBLIC_BASE_URL environment variable must be an absolute http(s) URL"},
    "note": "Order: rule 2 (the mode's checks) runs before rule 3 (policy), so the PUBLIC_BASE_URL failure is reported, not the policy."
  },
  {
    "id": "AS-86",
    "input": {"env":{"AUTH_MODE":"password","PUBLIC_BASE_URL":" ftp://hub.arrakis.test "}},
    "expected": {"ok":false,"error":"must be an absolute http(s) URL, got: ftp://hub.arrakis.test"},
    "note": "PUBLIC_BASE_URL rule: the value is trimmed before the check and reported trimmed (\"got: ftp://...\", one space)."
  },
  {
    "id": "AS-87",
    "input": {"env":{"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"admin@arrakis.test","SMTP_HOST":"smtp.arrakis.test","SMTP_PORT":"587","SMTP_FROM":"hub@arrakis.test","ALLOWED_EMAIL_DOMAINS":" Bad@Arrakis.Test "}},
    "expected": {"ok":false,"error":"entries must be domains without \"@\", got: bad@arrakis.test"},
    "note": "Step 2 reports the entry trimmed and lowercased."
  },
  {
    "id": "AS-88",
    "input": {"env":{"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"admin@arrakis.test","SMTP_HOST":"smtp.arrakis.test","SMTP_PORT":"587","SMTP_FROM":"hub@arrakis.test","ALLOWED_EMAIL_DOMAINS":"a.test,,"}},
    "expected": {"ok":false,"error":"contains an empty entry, got: a.test,,"},
    "note": "Step 2: the empty-entry message reports the whole value, not the entry."
  },
  {
    "id": "AS-89",
    "input": {"env":{"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"  11111111-2222-3333-4444-555555555555  ","AZURE_CLIENT_ID":"client","AZURE_CLIENT_SECRET":"secret","AZURE_REDIRECT_URI":"https://hub.arrakis.test/cb","AZURE_AUTHORITY":"https://login.microsoftonline.com/common"}},
    "expected": {"ok":false,"error":"AZURE_AUTHORITY must point at tenant 11111111-2222-3333-4444-555555555555"},
    "note": "Azure step 2 names the trimmed tenant in its message (\"tenant 1111...\", one space)."
  },
  {
    "id": "AS-90",
    "input": {"env":{"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"11111111-2222-3333-4444-55555555555","AZURE_CLIENT_ID":"client","AZURE_CLIENT_SECRET":"secret","AZURE_REDIRECT_URI":"https://hub.arrakis.test/cb"}},
    "expected": {"ok":false,"error":"AZURE_TENANT_ID must be a tenant GUID"},
    "note": "Azure step 1: the last group has 11 hex digits instead of 12."
  },
  {
    "id": "AS-91",
    "input": {"env":{"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"11111111-2222-3333-4444-555555555555","AZURE_CLIENT_ID":"client","AZURE_CLIENT_SECRET":"secret","AZURE_REDIRECT_URI":"https://hub.arrakis.test/cb","AZURE_AUTHORITY":"https://login.microsoftonline.com/x/11111111-2222-3333-4444-555555555555/v2.0"}},
    "expected": {"ok":true,"AUTH_MODE":"azure-oauth","PASSWORD_POLICY":"long"},
    "note": "Azure step 2: any path piece may be the tenant, not only the first one; here it is the second."
  },
  {
    "id": "AS-92",
    "input": {"env":{"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"admin@arrakis.test","SMTP_HOST":"smtp.arrakis.test","SMTP_PORT":"587","SMTP_FROM":"hub@arrakis.test","ALLOWED_EMAIL_DOMAINS":".arrakis.test"}},
    "expected": {"ok":false,"error":"ALLOWED_EMAIL_DOMAINS entry is not a valid domain, got: .arrakis.test"},
    "note": "Step 2: a leading dot leaves an empty first label."
  },
  {
    "id": "AS-93",
    "input": {"env":{"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"admin@arrakis.test","SMTP_HOST":"smtp.arrakis.test","SMTP_PORT":" 0 ","SMTP_FROM":"hub@arrakis.test"}},
    "expected": {"ok":false,"error":"must be an integer between 1 and 65535, got:  0 "},
    "note": "Step 5: Number(\" 0 \") is 0, out of range; the message reports the value untrimmed (\"got:\", then \" 0 \")."
  },
  {
    "id": "AS-94",
    "input": {"env":{"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"11111111-2222-3333-4444-555555555555","AZURE_CLIENT_ID":"client","AZURE_CLIENT_SECRET":"secret","AZURE_REDIRECT_URI":" /cb "}},
    "expected": {"ok":false,"error":"must be an absolute URL, got:  /cb "},
    "note": "Azure step 4: \" /cb \" is no absolute URL; the message reports it untrimmed."
  },
  {
    "id": "AS-95",
    "input": {"env":{"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"gggggggg-2222-3333-4444-555555555555","AZURE_CLIENT_ID":"client","AZURE_CLIENT_SECRET":"secret","AZURE_REDIRECT_URI":"https://hub.arrakis.test/cb"}},
    "expected": {"ok":false,"error":"AZURE_TENANT_ID must be a tenant GUID"},
    "note": "Azure step 1: the shape is 8-4-4-4-12, but g is not a hex digit."
  },
  {
    "id": "AS-96",
    "input": {"env":{"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"11111111-222-3333-4444-555555555555","AZURE_CLIENT_ID":"client","AZURE_CLIENT_SECRET":"secret","AZURE_REDIRECT_URI":"https://hub.arrakis.test/cb"}},
    "expected": {"ok":false,"error":"AZURE_TENANT_ID must be a tenant GUID"},
    "note": "Azure step 1: the second group has 3 digits instead of 4."
  },
  {
    "id": "AS-97",
    "input": {"env":{"AUTH_MODE":"none","PASSWORD_POLICY":"any"}},
    "expected": {"ok":true,"AUTH_MODE":"none","PASSWORD_POLICY":"any"},
    "note": "Rule 3: any is in the list and kept as is."
  },
  {
    "id": "AS-98",
    "input": {"env":{"AUTH_MODE":"none","PASSWORD_POLICY":"long"}},
    "expected": {"ok":true,"AUTH_MODE":"none","PASSWORD_POLICY":"long"},
    "note": "Rule 3: long set explicitly is accepted (not only as the default)."
  },
  {
    "id": "AS-99",
    "input": {"env":{"AUTH_MODE":"azure-oauth","AZURE_TENANT_ID":"AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE","AZURE_CLIENT_ID":"client","AZURE_CLIENT_SECRET":"secret","AZURE_REDIRECT_URI":"https://hub.arrakis.test/cb","AZURE_AUTHORITY":"https://login.microsoftonline.com/AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"}},
    "expected": {"ok":true,"AUTH_MODE":"azure-oauth","PASSWORD_POLICY":"long"},
    "note": "Azure step 2 ignores case on both sides: an upper-case tenant and the same upper-case segment match."
  },
  {
    "id": "AS-100",
    "input": {"env":{"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"Admin <admin@arrakis.test>","SMTP_HOST":"smtp.arrakis.test","SMTP_PORT":"587","SMTP_FROM":"hub@arrakis.test"}},
    "expected": {"ok":false,"error":"ADMIN_CONTACT_EMAIL environment variable must be a valid email address"},
    "note": "Step 3: a display name is not allowed."
  },
  {
    "id": "AS-101",
    "input": {"env":{"AUTH_MODE":"password-confirm","ADMIN_CONTACT_EMAIL":"a@b@arrakis.test","SMTP_HOST":"smtp.arrakis.test","SMTP_PORT":"587","SMTP_FROM":"hub@arrakis.test"}},
    "expected": {"ok":false,"error":"ADMIN_CONTACT_EMAIL environment variable must be a valid email address"},
    "note": "Step 3: two @ are not allowed."
  },
  {
    "id": "AS-102",
    "input": {"env":{"AUTH_MODE":"password","SMTP_HOST":"smtp.arrakis.test"}},
    "expected": {"ok":false,"error":"SMTP_FROM environment variable is required"},
    "note": "Mode password, step 2: SMTP_HOST is set, so the SMTP block is checked and SMTP_FROM is missing."
  },
  {
    "id": "AS-103",
    "input": {"env":{"AUTH_MODE":"password","SMTP_HOST":"smtp.arrakis.test","SMTP_FROM":"hub@arrakis.test"}},
    "expected": {"ok":false,"error":"SMTP_PORT environment variable is required"},
    "note": "Mode password, step 2: with host and from set, the missing SMTP_PORT is reported."
  },
  {
    "id": "AS-104",
    "input": {"env":{"AUTH_MODE":"password","SMTP_HOST":"smtp.arrakis.test","SMTP_PORT":"0","SMTP_FROM":"hub@arrakis.test"}},
    "expected": {"ok":false,"error":"SMTP_PORT environment variable must be an integer between 1 and 65535"},
    "note": "Mode password, step 2: the port range check applies too; 0 < 1."
  },
  {
    "id": "AS-105",
    "input": {"env":{"AUTH_MODE":"password","SMTP_HOST":"smtp.arrakis.test","SMTP_PORT":"587","SMTP_FROM":"hub@arrakis.test"}},
    "expected": {"ok":true,"AUTH_MODE":"password","PASSWORD_POLICY":"long"},
    "note": "Mode password, step 2: a full SMTP block passes."
  },
  {
    "id": "AS-106",
    "input": {"env":{"AUTH_MODE":"password","SMTP_PORT":"abc"}},
    "expected": {"ok":true,"AUTH_MODE":"password","PASSWORD_POLICY":"long"},
    "note": "Mode password, step 2: SMTP_HOST unset, so the SMTP block is not checked and the bad SMTP_PORT is ignored."
  },
  {
    "id": "AS-107",
    "input": {"env":{"AUTH_MODE":"password","SMTP_HOST":"   ","SMTP_PORT":"abc"}},
    "expected": {"ok":true,"AUTH_MODE":"password","PASSWORD_POLICY":"long"},
    "note": "Mode password, step 2: a spaces-only SMTP_HOST counts as unset, so the bad SMTP_PORT is ignored."
  }
]
```

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
