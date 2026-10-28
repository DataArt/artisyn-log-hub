---
type: Test Suite
title: API vs DB contract suite (jest, world-v1)
description: npm run test:contract (server/) — a separate jest project that boots its own app in a fresh contract_<uuid> schema loaded with the deterministic world-v1 fixture, checks every route's answer against independent raw SQL via a data registry of 24 families (F01-F24) and one shared runCase, and a meta-test that fails when a router route has no registry row.
resource: server/test/contract/README.md
tags: [testing, server, jest, contract, database, registry]
timestamp: 2026-10-28T00:00:00Z
---

The contract suite proves "the API answer equals what is in the database" for every HTTP route,
with SQL written by hand and never borrowed from the application. Design:
`docs/qaa-overview/scenarios/05-api-db-contract.md`. The how-to (adding a family or a row, the
row format, ground rules) lives next to the code in
[`server/test/contract/README.md`](../../../server/test/contract/README.md).

# How to run

```sh
cd server && npm run test:contract       # jest -c jest.contract.config.js --runInBand
npm run test:scenarios -- --only contract   # the same, as the runner's `contract` step (repo root)
```

Needs only Postgres. Health check `contract` (`dir server`, group `app`, 600 s, `finalOnly`).

**Database URL precedence** (`setup/global-setup.ts`, read from the env snapshot taken before the
`AppModule` import): **`TEST_DATABASE_URL` → `DATABASE_URL` → `server/.env(.local)`**. A URL from the
caller's environment overrides whatever `server/.env` loads. A Claude sandbox sets
`TEST_DATABASE_URL` to its `log_hub_<name>_test` DB while `DATABASE_URL` stays its live dev DB, so the
`contract_<uuid>` schemas (and the stale `contract_%` cleanup) never touch the live DB or another
sandbox ([docker-dev-container.md](../docker-dev-container.md)). On the host neither is usually
set and `server/.env` applies.
The main `npm run test` never picks the suite up (`*.contract-spec.ts` is outside its `testRegex`).

# Pieces

| File | Role |
|---|---|
| `server/jest.contract.config.js` | jest project: main config + `testRegex: test/contract/.*\.contract-spec\.ts$` + own setup/teardown |
| `server/test/contract/setup/global-setup.ts` | `contract_<uuid>` schema (stale `contract_%` dropped), migrations, world-v1, app on a free port → `CONTRACT_BASE_URL`; temp `UPLOAD_QUEUE_DIR` / `EXPORT_IMPORT_DIR`; retention window 100 years so the January-2026 world is never purged; upload-queue worker, the two cleanup sweeps and the tool-usage rebuild drain parked (1 h ticks), so no background job writes inside a row's measured window |
| `server/test/contract/fixtures/world-v1.sql.ts` | raw-SQL world: 7 users (admin, owner, member, outsider, author, pending, manager), 4 API keys, teams T1 (transparent) / T2 (restricted), repos R1-R3 (+ per-user rows of R1), T1's team config of R1 in `team_repo_config` (link 1) and the owner's personal layer in `repo_config`, sessions s01-s10 with artisyn/claude bodies whose token sums match `session_stats`, pricing with past/current/future versions plus a fetched and an overridden model, failed queue rows, an open password-reset token, export/import jobs, the OKF snapshot s02 is bound to (bundle `docs/kb`, one gitignored file) with `session_okf_access` rows on the s02 -> s03 tree, Tools/MCP data (the owner's personal monitored-tools list of R1, T1's list of R1's URL, R1's `tool_wrap_status`, `session_tool_usage` rows on s01, s03, s06 and s08; every session still pending a rebuild); sequences at 1000 after load; `WORLD_V1_REFS` names for `@ref`. Reload = DELETEs in FK order (~75 ms), not TRUNCATE (~2.4 s) |
| `server/test/contract/oracle.ts` | `pg.Pool` with `search_path` = contract schema only; `q()`, whole-schema checksum, table snapshots |
| `server/test/contract/types.ts` | `ContractCase` (call row or `excluded` row), `ReadSpec`, `WriteSpec`, `FieldMap` |
| `server/test/contract/run-case.ts` | `runCase(row, ctx)`: world reset for write rows and for any row after one, real login per actor, call, status, read/write/noDb oracle, unchanged-schema guard for negative rows |
| `server/test/contract/registry/index.ts` | `FAMILIES` (F01-F24 files `registry/f<NN>-<family>.ts`), `casesOf`, `registryRoutes` |
| `server/test/contract/registry/oracle-sql.ts` | shared hand-written SQL: own / tree session cost, the listed root sessions of a repository, ISO timestamps in jsonb |
| `server/test/contract/f<NN>.contract-spec.ts` | one `it.each` per family (F09 also drops a staged queue file into the temp `UPLOAD_QUEUE_DIR`) |
| `server/test/contract/routes.contract-spec.ts` | meta-test: routes from Nest metadata and from the Express 5 router stack must agree; router ⊆ registry; registry ⊆ router; rows well-formed |

No file in `oracle.ts`, `fixtures/` or `registry/` imports from `server/src/**` (types excepted).

# Families

| # | File | Routes |
|---|---|---|
| F01 | `f01-infra.ts` | health, ping, auth config, log-echo, admin system/error-logs/logs-archive/auth, retention-days (no-DB contract) |
| F02 | `f02-account.ts` | signup, confirm/resend, login/logout, me, forgot/reset/change password, delete-account |
| F03 | `f03-auth-modes.ts` | identify, Azure login/callback — 404 in `password-confirm` |
| F04-F05 | `f04-api-keys.ts`, `f05-user-settings.ts` | API keys, user settings |
| F06-F09 | `f06`-`f09` | admin: users (incl. legacy `PATCH /api/v1/users/:userId/role`), pending registrations, repos/teams, upload queue |
| F10-F13 | `f10`-`f13` | teams: core, members, repositories, invitations |
| F14-F16 | `f14`-`f16` | repositories (card, settings incl. the `?teamId` team-view rows `F14-settings-team*` / `F14-put-team-settings-team*`, hook state), `POST /api/v2/logs` enqueue, post-turn gate + advisor/attribution submissions |
| F17-F18 | `f17`, `f18` | session lists/subsets (cost: golden + SQL formula), delete + retention |
| F19-F23 | `f19`-`f23` | change surface, analytics, reports (5 twins via `sameExpectedAs`), pricing + admin pricing + tool versions, export/import + recompute |
| F24 | `f24-tool-monitoring.ts` | Tools/MCP tab: hook monitored-tools config (API key), tab config GET/PUT (personal and team level), summary, calls, call detail |

The positive routes that need the outside world (Azure callback, OpenRouter import, the
multi-GB logs archive, the build-artifact installer tgz) have guard rows or an explicit
`excluded` row with a reason.

# Pinned discrepancies

Rows that fix today's behaviour although it disagrees with the design or with a sibling
endpoint — each marked `KNOWN DISCREPANCY` in its registry file:

- `GET /api/v1/teams/:teamId/repositories` — `sessionCount` counts logs, not sessions (F12).
- `GET .../sessions/branches` — branch `totalCost` leaves out sub-agent (child) session costs that
  the session list and the executive summary include (F17).
- `DELETE /api/v1/sessions/:sessionId` — keeps the soft-deleted session's request ids, tool
  stats, changed paths, harness usage, attribution (+ runs) and prompt watermark rows (F18).
