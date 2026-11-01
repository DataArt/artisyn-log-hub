---
type: "Convention Guide"
title: "Server Conventions"
description: "Backend implementation patterns: DB query optimization, Argon2id password hashing, performance testing, and pino logging."
tags:
  - server
timestamp: "2026-11-01T00:00:00+04:00"
---

- avoid n+1 pattern when quering DB
- try to do all possible aggregations and basic calculations in SQL queries, not in code.
- avoid mocks in tests if you need to work with DB - work with real DB
- use batch upserts: when inserting multiple rows of the same type (repositories, contexts, log_repositories, log_contexts), collect all values and issue a single `INSERT ... VALUES ([...array])` with `onConflictDoNothing()` rather than N individual inserts

## Password Hashing Strategy

### Overview

The application uses **Argon2id** for password and API key hashing via the `argon2` npm package.

### Implementation

**Module:** `server/src/utils/password-hash.ts`

**Functions:**
- `hashPassword(plaintext: string): Promise<string>` — Hashes with Argon2id and returns the encoded hash string
- `comparePassword(plaintext: string, stored: string): Promise<boolean>` — Calls `argon2.verify(stored, plaintext)` with constant-time comparison

**Used in:**
- `server/src/auth/auth.service.ts` — Password signup and login validation
- `server/src/api-keys/api-keys.service.ts` — API key creation and validation
- `server/src/database/seed.ts` — Debug user and API key creation

### Argon2id Parameters

| Parameter     | Value | Meaning                          |
|---------------|-------|----------------------------------|
| `type`        | argon2id | Balanced against GPU and side-channel attacks |
| `timeCost`    | 2     | Number of iterations             |
| `memoryCost`  | 19    | 2^19 KiB = 512 MiB per operation |
| `parallelism` | 1     | Single-threaded                  |

Expected performance: ~15-25 ms per hash on standard hardware.

### Security Trade-offs

Argon2id is a memory-hard KDF. It provides strong resistance to GPU/ASIC brute-force attacks via its memory requirement. This is a stronger choice than SHA-256 or bcrypt for password storage and is appropriate even for telemetry applications.

## Performance Testing Framework

**Location:** `server/perf-tests/`

**Language:** TypeScript. Source files are compiled with a dedicated `tsconfig.json` before execution; compiled output lands in `server/perf-tests/dist/`.

**Run command (from `server/`):**
```sh
npm run perf
```
This is equivalent to `tsc --project perf-tests/tsconfig.json && node perf-tests/dist/run.js`.

**Source files:**

| File | Purpose |
|---|---|
| `run.ts` | Entry point — auth setup, data seeding (normal + heavy), read-only target flow, orchestration, report saving, budget exit code |
| `runner.ts` | Executes scenarios with sliding-window parallelism and per-scenario overrides; per-request timeout; computes p50/p95/p99 stats |
| `scenarios.ts` | Defines all test scenarios (auth, logs, repos, teams, invitations, health) |
| `auth-client.ts` | Manages test user lifecycle and attaches auth headers to requests |
| `data.ts` | Generates synthetic artisyn/claude NDJSON payloads, incl. `makeHeavyClaudeNdjson()` (~5 MB transcripts) |
| `reporter.ts` | Saves JSON results and renders an HTML comparison report |
| `config.ts` | Loads config from `constants.json` with env-var overrides (incl. the `PERF_*` read-only target vars) |
| `budgets.json` / `budgets.ts` | Absolute p95 budgets per scenario; `loadBudgets()`, `evaluateBudgets()`, `printBudgetReport()` |
| `types.ts` | Shared TypeScript interfaces |

**Execution model:**

- Scenarios run **sequentially** one after another.
- Within each scenario, a **sliding-window concurrency** approach is used: up to `parallelRunsPerScenario` requests are in-flight simultaneously. Once the window is full, the runner waits for one to complete before dispatching the next.
- Each scenario runs `warmupIterations` sequential warm-up requests first (not timed), then `iterations` timed requests.
- **Per-scenario overrides:** a `Scenario` may set its own `iterations`, `warmupIterations` and `parallel`, which win over
  the global config (e.g. every `*-heavy` scenario runs 20 timed / 2 warm-up requests, one at a time).
- **Per-request timeout:** every timed request is capped at `requestTimeoutMs` (30 000 ms): a request that takes
  longer counts as an error instead of hanging the run, and `AuthClient.fetch` adds an
  `AbortSignal.timeout(requestTimeoutMs)` when the caller passed no signal.

**Heavy seed:** besides the normal seed, a run seeds one extra repository (`perf-heavy-repo-<uuid>`) with 12 sessions,
each an artisyn log plus a ~5 MB claude transcript (`makeHeavyClaudeNdjson`: turns with `message.id` / `model` /
`usage`, Write tool_use blocks with ~4 KB of content, tool_result blocks, some sidechain lines; the padding is random
text so the jsonb does not compress — each body is above Postgres' default 4 MB `work_mem`, the shape that made the
old per-line list query slow; 30 x 1 MB of compressible text let it pass); every 5th carries a `Workflow` tool_use and one
`claude-subagent` child. Every read endpoint of a repository and of one session runs against that repository too, as
a `-heavy` twin of the regular scenario (`repos:sessions-heavy`, `repos:analytics-timeline-heavy`,
`repos:session-logs-heavy`, … — `repoReadScenarios()` / `sessionReadScenarios()` in `scenarios.ts` build both
variants from one list, the session ones on the first heavy session, which has the Workflow call and the sub-agent).
A new read endpoint goes into those lists, so a query that scans stored transcripts fails its budget here, not on a
real instance. A failed heavy upload aborts the run
(non-zero exit), so a budget can never pass because its scenario silently did not run. Its ids go to the
`IdCollector` and are cleaned up like the rest.

**Budgets:** `server/perf-tests/budgets.json` maps a scenario name to an absolute `p95Ms` budget
(`repos:sessions` and every `*-heavy` scenario: 500 ms — `repos:hook-state` has no heavy twin, the heavy repo has no
hook state). After the baseline comparison the run prints a budget report:
each budget is **pass**, **fail** (p95 above the budget, or any error) or **skipped** (scenario not run). Any fail sets
`process.exitCode = 1` (after cleanup), so `npm run perf` exits non-zero. Budgets are independent of the
baseline-relative 20 % rule below.

**Cleanup:** a run deletes everything it created, in the `finally` block of `main()` in `run.ts`, so it also
runs after a failed scenario. Created ids are recorded during the run in an `IdCollector` (`types.ts`): session
UUIDs from the log uploads, newly created repository ids, and whether the test user was signed up by this run.
`auth.teardown()` removes the run's API key, then `cleanupDb()` (direct SQL, needs `DATABASE_URL`) waits for the
upload queue to finish the run's staged uploads, then deletes their `upload_queue` rows, `logs`, `sessions`, the
recorded repositories, and the test user only if this run created it. The shared `contexts` deduplication table is
not cleaned, because its rows can be shared with real data.

**Defaults (`constants.json`):**

| Parameter | Default |
|---|---|
| `parallelRunsPerScenario` | 5 |
| `iterations` | 100 |
| `warmupIterations` | 100 |
| `baseUrl` | `http://localhost:3000` |

All defaults can be overridden via environment variables: `PERF_BASE_URL`, `PERF_ITERATIONS`, `PERF_WARMUP`, `PERF_PARALLEL`, `PERF_OUTPUT_DIR`.

**Read-only target mode** (measure an existing instance without changing it):

| Variable | Meaning |
|---|---|
| `PERF_EMAIL` / `PERF_PASSWORD` | Sign in (login, or identify in auth mode `none`) as this existing user instead of the test user; never signs up |
| `PERF_REPO_ID` | Repository to measure; implies read-only mode. The run first GETs its session list and aborts (non-zero exit, naming the repo id and `PERF_EMAIL`) when it fails or is empty; the newest session becomes the seed session |
| `PERF_READONLY=1` | Read-only mode without a fixed repository |

In read-only mode the run needs no `DATABASE_URL`, creates no API key, seeds nothing (no normal or heavy seed, so
`repos:sessions-heavy` is reported as skipped), runs no scenario marked `writes: true` (every POST/PUT/PATCH/DELETE
scenario except `auth:login`, announced in one "Skipping … — read-only mode" line) and skips `cleanupDb`. The
banner prints `Mode: read-only (target repo N)`. Example:
`PERF_BASE_URL=http://localhost:5003 PERF_EMAIL=<owner> PERF_REPO_ID=1 npm run perf`.

**Output:** JSON and HTML reports are written to `tmp/perftests/` (relative to repo root, gitignored). Each run saves a timestamped result file and optionally compares against a stored baseline; the HTML report renders a side-by-side table. A run in read-only mode or with `PERF_BASE_URL` set writes to its own per-target sub-folder `tmp/perftests/targets/<host>_<port>-repo<id|seed>/`, so a remote target's baseline never mixes with the local one.

**Performance regression gate:** After any server code change, run `npm run perf` and confirm that no metric degrades by more than 20% relative to the previous baseline. Stop and ask the user if degradation exceeds this threshold.

## Server-Side Rolling Logs

**Location:** `server/logs/` (gitignored)

There are two independent, parallel rotating pino loggers, each with its own `DailyRotateStream`-style class. Both are self-contained by design (the day-tag/instance-suffix logic is intentionally duplicated rather than shared).

### App logger — `server/src/common/app-logger.ts`

The server uses **pino** with a custom `DailyRotateStream` class for file output (not `pino-roll` — pino-roll transport workers do not work inside ncc bundles). The `AppLogger` class implements NestJS's `LoggerService` interface and is passed to `NestFactory.create()` in `main.ts` so all NestJS internal log calls go through it.

**Behaviour:**

- A new log file is created every day: `app-YYYY-MM-DD.log`
- Colourised output is written to stdout simultaneously via `pino-pretty`
- Both streams capture all levels (`trace` and above)
- No automatic file retention/deletion is configured in code — old files accumulate unless pruned externally

### SQL logger — `server/src/common/sql-logger.ts`

A second, independent pino-based rotating logger for SQL query logging, used via `logSqlQuery(sql, durationMs, error?)`. It writes to its own daily file (`sql-YYYY-MM-DD.log`) using the same `DailyRotateStream`-style pattern as `app-logger.ts` (duplicated on purpose, not shared).

**Behaviour:**

- Every SQL query is logged at `info` level ("SQL query")
- Queries slower than `SLOW_QUERY_THRESHOLD_MS` (100 ms) are logged at `warn` level ("Slow query (>100ms)")
- Query errors are logged at `error` level ("SQL error"), including the error message
- Each entry includes `endpoint` and `callUuid` (from `requestContextStorage`) when available, plus `sql`, `durationMs`, and `error` (when present)
- A query whose SQL text is prefixed with `NO_LOG_MARKER` (`/* no-log */`) skips its `info`-level entry — for high-frequency polling queries (e.g. the upload queue scheduler's per-tick checks) that would otherwise flood the log. `warn`/`error` entries for the same query are unaffected.

### Per-worker filename suffix

Both loggers append an instance suffix to the filename when running as a cluster worker. `computeInstanceSuffix()` (defined identically in both `app-logger.ts:28` and `sql-logger.ts`) reads `process.env.NODE_APP_INSTANCE` — the 0-based worker slot index (`0`, `1`, `2`, …) the cluster primary sets on each `cluster.fork()` — and appends `-i<N>` to the filename so each worker rotates to its own file instead of interleaving into a shared one:

- `app-2026-01-01-i0.log`, `app-2026-01-01-i1.log`, … (app logger)
- `sql-2026-01-01-i0.log`, `sql-2026-01-01-i1.log`, … (SQL logger)

The suffix is empty (`''`) when `NODE_APP_INSTANCE` is unset, which is the case in local dev (single process, no cluster primary) and for the cluster primary itself — so those filenames are unchanged (`app-YYYY-MM-DD.log`).

The slot index is **stable across a worker restart**: the cluster primary re-forks a dead worker into the same slot, so the replacement keeps writing to the same `-i<N>` file instead of starting a new file series (see `system-info-and-cluster.md`).

**Tail the current log (PowerShell from repo root):**
```powershell
Get-ChildItem server/logs | Sort-Object LastWriteTime -Descending | Select-Object -First 1 | Get-Content -Wait
```
