---
type: "Convention Guide"
title: "Server Conventions"
description: "Backend implementation patterns: DB query optimization, Argon2id password hashing, performance testing, and pino logging."
tags:
  - server
timestamp: "2026-07-20T16:28:47+04:00"
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
| `run.ts` | Entry point — auth setup, data seeding, orchestration, report saving |
| `runner.ts` | Executes scenarios with sliding-window parallelism; computes p50/p95/p99 stats |
| `scenarios.ts` | Defines all test scenarios (auth, logs, repos, teams, invitations, health) |
| `auth-client.ts` | Manages test user lifecycle and attaches auth headers to requests |
| `data.ts` | Generates synthetic artisyn/claude NDJSON payloads |
| `reporter.ts` | Saves JSON results and renders an HTML comparison report |
| `config.ts` | Loads config from `constants.json` with env-var overrides |
| `types.ts` | Shared TypeScript interfaces |

**Execution model:**

- Scenarios run **sequentially** one after another.
- Within each scenario, a **sliding-window concurrency** approach is used: up to `parallelRunsPerScenario` requests are in-flight simultaneously. Once the window is full, the runner waits for one to complete before dispatching the next.
- Each scenario runs `warmupIterations` sequential warm-up requests first (not timed), then `iterations` timed requests.

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

**Output:** JSON and HTML reports are written to `tmp/perftests/` (relative to repo root, gitignored). Each run saves a timestamped result file and optionally compares against a stored baseline; the HTML report renders a side-by-side table.

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
