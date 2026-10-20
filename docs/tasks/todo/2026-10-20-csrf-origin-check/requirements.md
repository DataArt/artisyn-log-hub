# 2026-10-20: CSRF Origin Check for Cookie-Session Routes

**Status:** todo
**Priority:** low
**Type:** feature
**Module(s):** server
**Owner:** denis.tsyplakov
**Created:** 2026-10-20

## Description

Low priority. CSRF hardening for cookie-session routes.

Today:
- the session cookie is `SameSite=Lax` (`server/src/app.module.ts`, session middleware, ~line 219);
- `express.json` + `express.urlencoded` + `express.text` (`application/x-ndjson`) parsers run on
  every route (`app.module.ts` ~258-269);
- there is no `Origin` / `Sec-Fetch-Site` check anywhere in `server/src`.

No GET mutates data (invariant 1 of the `security-check` skill), so `Lax` already covers the
cross-site case. Remaining gaps:
- **same-site sibling subdomains**: with the server on `loghub.company.com`, a page on any
  `*.company.com` is "same-site" for `Lax`, so the browser sends the session cookie with its
  POST/PUT/DELETE;
- **simple form posts**: the global `urlencoded` parser lets a plain HTML form send a body the
  server parses, without a CORS preflight.

Proposed fix: one global middleware for POST/PUT/PATCH/DELETE on cookie-authenticated requests
(not `X-API-Key` requests from the hook): allow when `Sec-Fetch-Site` is `same-origin` or `none`;
when the header is absent, require `Origin` equal to `PUBLIC_BASE_URL` (or the request host
outside production); otherwise 403. Remove `express.urlencoded` from the global chain: the client
sends JSON only and the Azure callback is a GET. Estimate: about half a day.

## Functional Requirements

- FR-1: A state-changing request (POST, PUT, PATCH, DELETE) authenticated by the session cookie
  is rejected with 403 when `Sec-Fetch-Site` is `same-site` or `cross-site`.
- FR-2: When `Sec-Fetch-Site` is absent, such a request is accepted only if `Origin` is absent
  or equals the public base URL (`PUBLIC_BASE_URL`; outside production, the request's own
  origin); a different `Origin` gets 403.
- FR-3: Requests authenticated by `X-API-Key` (hook ingest and hook APIs) are not affected.
- FR-4: GET, HEAD and OPTIONS are not affected.
- FR-5: `express.urlencoded` is no longer applied to the global route chain.

## Acceptance Criteria

- [ ] A logged-in POST with `Sec-Fetch-Site: cross-site` or `same-site` gets 403 and changes
      nothing (FR-1).
- [ ] A logged-in POST with a foreign `Origin` and no `Sec-Fetch-Site` gets 403; the same request
      from the app's own origin succeeds (FR-2).
- [ ] The hook upload (`POST /api/v2/logs` with `X-API-Key`) and the hook APIs work unchanged,
      with or without an `Origin` header (FR-3).
- [ ] A `application/x-www-form-urlencoded` body to a global route is no longer parsed (FR-5),
      and the web client keeps working end to end (login, settings, admin actions).
- [ ] Tests follow the repo test policy: a step in an existing auth scenario under
      `tests/scenarios/auth/` (foreign Origin -> 403, same origin -> OK); a contract registry row
      only if a route changes.

## Notes
