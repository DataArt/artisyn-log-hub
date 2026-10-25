---
name: security-check
description: "Whole-repo security invariants audit: checks every invariant in this skill's numbered list (first: no GET endpoint mutates data under a cookie session) and reports OK or violations with file:line. Read-only, never fixes anything. Run when explicitly asked (/security-check)."
argument-hint: "[invariant number(s), e.g. 1 or 1,3 — default: all]"
---

You are auditing the **whole repository** against a fixed list of security invariants. Unlike
`post-impl-check-security-no-auto` (which looks only at one task's changed files), this check
always scans the full codebase, so it also catches regressions introduced outside any task.

Invariants to check: $ARGUMENTS (empty = all invariants below, in order).

## Rules

- **Read-only.** Never edit, fix, refactor or delete anything — not even an "obvious" one-line fix.
  Report only. Fixing a violation is a separate task the user decides on.
- Check each invariant independently; one invariant's failure does not stop the others.
- Every violation must cite `file:line` (repo-relative path, line of the offending decorator /
  statement) and one sentence on *why* it violates the invariant.
- A listed **allowed exception** is reported as an exception, not a violation — but verify it still
  matches its description (same route, same reason). An exception whose code changed so that the
  stated reason no longer holds IS a violation.
- When unsure whether a code path writes (e.g. it calls a service you have not opened), open the
  service method and follow it one level further before deciding. Do not guess from method names.

## Invariants

The list is extensible: add a new numbered section below, using the same four parts
(**Rule**, **Why**, **How to find candidates**, **Allowed exceptions**). Never renumber existing
invariants — reports and task notes refer to them by number.

### 1. No GET endpoint mutates data under a cookie session

**Rule.** A `GET` handler reachable with the browser session cookie (`connect.sid`, i.e. guarded by
`SessionAuthGuard` / `AdminGuard` / `AutoIdentifyGuard`, or unguarded) must not change server state:
no DB `insert`/`update`/`delete`/upsert, no `req.logIn`/session writes, no deletion or rewriting of
files or job rows the user cares about.

**Why.** CSRF protection is `SameSite=Lax` only (see `client/public/help/security-hardening.md`).
`Lax` still sends the session cookie on cross-site top-level `GET` navigations, so a mutating GET
can be triggered by any external page the logged-in user visits. A mutating GET found here is
converted to `POST`; if an old hook or installer version calls it, the old GET is kept and listed
as an exception.

**How to find candidates.**
1. Grep `@Get(` in `server/src` (skip `*.spec.ts`). Today that is ~79 handlers across ~21
   controllers.
2. For each handler, note the guards on the handler and its `@Controller` class. Handlers guarded
   only by `ApiKeyAuthGuard` (`X-Api-Key` header) are not reachable with the cookie — record them as
   "not cookie-authenticated" and move on.
3. Read the handler body and every service method it calls (one level deep, deeper when a callee
   name does not make it obvious). Flag: `.insert(`, `.update(`, `.delete(`, `onConflictDo*`,
   raw `INSERT`/`UPDATE`/`DELETE` SQL, `req.logIn`, `req.session[...] =`, `fs.writeFile*`,
   `fs.unlink`/`fs.rm` of anything that is not a temp file the same request created.
4. `.set(`/`.delete(` on an in-memory `Map`/`Set`, `createHmac(...).update(` and similar are not
   state changes — ignore them.

**Allowed exceptions** (agreed when preparing the open-source release):

| Endpoint | Where | Why it is allowed |
|---|---|---|
| `GET /static/artisyn-hooks-installer.tgz?v=` | `server/src/installer/installer.controller.ts` (`downloadInstaller`) | Public, no cookie needed; writes only the max-wins `latest-hook-version.json` cache; called by old hooks/installers, so it cannot become a POST. |
| `GET /api/v1/auth/azure` | `server/src/auth/auth.controller.ts` (`azure`) | Starts Azure OAuth: stores a fresh `state`/`nonce` in the caller's own session and redirects. |
| `GET /api/auth/callback` | `server/src/auth/azure/azure-callback.controller.ts` (`callback`) | OAuth redirect target (must be a GET); logs in / auto-provisions only after the `state` and `nonce` from the session match. |
| `GET /api/v1/auth/me` (Mode 1) | `server/src/auth/auth.controller.ts` (`me`, `AutoIdentifyGuard`) | Mode 1 auto-identify `req.logIn` — localhost-only, and Mode 1 has no auth model to protect. |
| `GET /api/v1/admin/logs-archive` | `server/src/admin/admin-panel.controller.ts` (`downloadLogsArchive`) | Creates and then deletes its own temp archive; no persistent state changes. |

Token-authorised flows (email confirmation, password reset) are SPA routes that `POST` a one-time
token — they are not GET mutations.

## Report format

One block per invariant checked:

```
### Invariant <N> — <title>: OK | <k> violation(s)
- VIOLATION <file>:<line> — <METHOD path> — <what it writes, one sentence>
- EXCEPTION <file>:<line> — <METHOD path> — <which allowed exception, still valid: yes/no>
- NOTE <file>:<line> — <anything checked and deliberately out of scope, e.g. API-key-only GET that writes>
Scanned: <number of candidates inspected>
```

End with a one-line summary: `security-check <YYYY-MM-DD>: <passed>/<checked> invariants OK, <n> violation(s)`.
If the caller asked for it, the dated summary is appended to the task's `requirements.md` Notes.
