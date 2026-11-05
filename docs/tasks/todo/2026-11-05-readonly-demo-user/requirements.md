# 2026-11-05: Read-Only Demo User

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** server | client
**Owner:** denis.tsyplakov
**Created:** 2026-11-05

## Description

Raw idea (verbatim, Russian):

> read only демо режим -
> выставляем демо инстанс наружу, наполняем данными делаем демо пользователя - как нормльный но read only
> не может создвать ключи не может НИЧЕГО менять - конект к базе ему дается с read-only праваами и в самих endpoints проверяется
> в задачу - только создание такого пользователя.
> ему можно задавать простой пароль

Context: we want to expose a demo Log Hub instance to the outside world, pre-filled with data, and
let visitors log in as a demo user. The demo user sees the app like a normal user but is strictly
read-only: cannot create keys and cannot change anything. Read-only is enforced twice — the demo
user's requests run over a database connection with read-only privileges, and the endpoints
themselves check the read-only flag.

Scope of this task: **only the creation of such a user** (the read-only user kind and its
enforcement). Exposing the instance and filling it with demo data are out of scope.

## Functional Requirements

- FR-1: It is possible to create a read-only (demo) user. Apart from being read-only, it behaves
  like a normal user — sees the same pages and data a normal user would.
- FR-2: The read-only user cannot create keys (API/hook keys or any other credentials).
- FR-3: The read-only user cannot change anything: every mutating endpoint (create / update /
  delete / settings / identity changes) rejects its requests.
- FR-4: Enforcement at the endpoint level — mutating endpoints check whether the caller is
  read-only and refuse the request.
- FR-5: Enforcement at the DB level — requests of the read-only user are served over a database
  connection whose DB role has read-only privileges, so a missed endpoint check still cannot write.
- FR-6: The read-only user can be given a simple password (no complexity rules forced on it).

## Non-Functional Requirements

- Security: the instance is exposed publicly, so the read-only guarantee must hold even if an
  endpoint check is missing (defence in depth via the read-only DB connection).
- Backward compatibility: existing users, auth modes and the hook API are unaffected.

## Acceptance Criteria

- [ ] AC-1 (FR-1): A read-only user can be created and can log in; after login it sees the same
      pages/data a normal user with the same visibility would.
- [ ] AC-2 (FR-2): Any attempt by the read-only user to create a key is rejected (UI and direct API
      call), and no key appears in the DB.
- [ ] AC-3 (FR-3, FR-4): Calling each mutating endpoint as the read-only user returns an
      authorization error and leaves the data unchanged.
- [ ] AC-4 (FR-5): With the endpoint check bypassed, a write attempted on the read-only user's DB
      connection fails with a DB permission error.
- [ ] AC-5 (FR-6): The read-only user can be given a simple password (e.g. `demo`) and log in
      with it.

## Open Questions

- How is the read-only user created — CLI/script, admin UI, env config at startup?
- Which auth modes must support it (password mode only, or also `none`/other modes)?
- What should the UI do for a read-only user — hide/disable mutating controls, or only rely on
  server rejection?
- Do side-effect writes made on read (e.g. last-login timestamps, sessions/auth tokens, audit
  logs) need a separate path, given the read-only DB connection?

## Notes

<!-- Append timestamped notes here as work progresses -->
