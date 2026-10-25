---
type: Test Suite
title: Scenario suite (isolated stand, Playwright)
description: npm run test:scenarios — builds an isolated stand into tmp/scenarios/stand, runs it per auth mode (A none, B password-confirm, C password) on its own port and scn_* schema, drives it with Playwright through shared fixtures and helpers, and proves the dev DB and server/src/public/static stayed untouched.
resource: scripts/scenarios/run.mjs
tags: [testing, scenarios, playwright, stand, e2e, fixtures]
timestamp: 2026-10-15T00:00:00Z
---

The scenario suite replaces the dev-server e2e suite ([e2e-tests.md](./e2e-tests.md)) step by
step. Unlike that suite it never drives the running dev app: it builds the app from the working
tree, starts its own server process per auth mode and throws the stand away afterwards.
Contributor-facing instructions (prerequisites, variables, every suite's command) are in
[`tests/scenarios/README.md`](../../../tests/scenarios/README.md).

# How to run

```sh
docker compose -f tests/scenarios/docker-compose.yml up -d   # Postgres 16 :5432 (postgres/pw) + Mailpit :1025/:8025
npm run test:scenarios                                       # all modes
npm run test:scenarios -- --mode b --grep S-AUTH-01 --skip-build
```

Flags (`scripts/scenarios/run.mjs` `parseArgs`): `--mode a,b,c`, `--grep <re>`, `--skip-build`,
`--only <steps>`. Steps: `scenarios` and `contract` (both by default); `corpus` is planned and
asking for it is a usage error (exit 2). `contract` runs `npm run test:contract` in `server/` after
the modes with the runner's `DATABASE_URL` ([contract-tests.md](./contract-tests.md)); `--only
contract` skips the stand build and the Mailpit/browser preflight. Around the contract step
`server/src/public/static` is compared by content only (`contentDrift`): booting `AppModule`
from `server/src` rewrites `installer-version.json` with identical bytes, as `npm run test` does. Exit codes: 0 green, 1 a pass
or step failed or dev state changed, 2 usage or preflight error.

**Runner database URL** (`run.mjs` `resolveRunnerDatabaseUrl`): **`TEST_DATABASE_URL` →
`DATABASE_URL` → `postgresql://postgres:pw@localhost:5432/postgres`**. The resolved URL is what the
preflight checks, what the fingerprint reads, what the stands use for their `scn_*` schemas and
what the `contract` step receives as `DATABASE_URL`; every "`DATABASE_URL`" below means this
resolved value. A Claude sandbox sets `TEST_DATABASE_URL` to its `log_hub_<name>_test` DB, so the
fingerprint never sees the live sandbox backend's hook uploads and stale-schema cleanup in one
sandbox never touches another ([docker-dev-container.md](../docker-dev-container.md)). On the host
neither variable is usually set.

Health checks: `scenarios-a`, `scenarios-b`, `scenarios-c` in
`.claude/repo_config/repo-health-checks.json` (`npm run test:scenarios -- --mode <x> --only
scenarios`, for mode A `--only scenarios,corpus`, group `app`, 600 s, `finalOnly`). The `corpus`
step (Playwright project `corpus`, `tests/scenarios/corpus/corpus.spec.ts`, S-CORPUS-01…05) replays
the session corpus of `tests/corpus/` (see its README; the sets are gitignored and recorded
locally with `npm run corpus:bootstrap`, without one the step's tests skip) and always runs on the mode-A stand: in the
`mode-a` pass when both are selected, otherwise in a pass of its own (`standPasses` in `run.mjs`). They are in the `app` group not because of the dev
server, but because the stand build rewrites `artisyn-hooks-installer/` in place like
`npm run build`.

# Pipeline

| Step | Code | What happens |
|---|---|---|
| Preflight | `scripts/scenarios/preflight.mjs` | `DATABASE_URL` reachable; Mailpit answers (mode B only); Playwright Chromium installed; no `tmp/scenarios/.env.local`. Any failure → readable message, exit 2 |
| Fingerprint | `run.mjs` `dbFingerprint` / `dirFingerprint` | tables + `count(*)` of the `public` schema in `DATABASE_URL`; content hash + mtimes of `server/src/public/static` |
| Build | `scripts/scenarios/build-stand.mjs` | skipped when the input hash is unchanged or with `--skip-build` |
| Per mode | `stand.mjs` `startStand` → Playwright `--project mode-<x>` → `stopStand` | mode B runs twice on two fresh stands: `--grep-invert @backoff`, then `--grep @backoff` (skipped when empty) |
| Fingerprint again | `run.mjs` `diffFingerprints` | any difference fails the run |

## Stand layout (`build-stand.mjs`)

| Path | Content |
|---|---|
| `tmp/scenarios/stand/index.js` | ncc bundle of `server/src/main.ts` (`-s`; the map's `sources` are rebased onto `server/src` by `rebaseSourceMapSources`, so stand coverage remaps) |
| `tmp/scenarios/stand/public/` | `vite build --outDir` of `client/` + precompress |
| `tmp/scenarios/stand/public/static/` | installer tarballs + `installer-version.json` (`build-hooks-installer.js --static-dir`) |
| `tmp/scenarios/stand/drizzle/migrations/` | copy of `server/drizzle/migrations` |
| `tmp/scenarios/stand/prebuilds/` | argon2 prebuilds (`scripts/copy-native.js <dir>`) |
| `tmp/scenarios/run-<runId>/<mode>/` | working dir of the stand process: `stand.log`, `UPLOAD_QUEUE_DIR`, `EXPORT_IMPORT_DIR` |
| `tmp/coverage/scenarios-<runId>/<mode>/` | with `SCENARIOS_COVERAGE=1` only: raw V8 profiles in `v8/`, `c8 report` output in `report/` |

The input hash covers every file `git ls-files -co --exclude-standard` lists under `client/`,
`server/src`, `server/drizzle`, `hook/`, `artisyn-hooks-installer/`, plus the builder scripts.

## Stand lifecycle (`stand.mjs`)

- Schema `scn_<mode>_<8 hex>`: `CREATE SCHEMA`, then the stand migrates it itself
  (`initializeDatabase` with `E2E_DB_SCHEMA`); `stopStand` kills the process tree and runs
  `DROP SCHEMA … CASCADE`.
- `pg_namespace` has no creation time, so labels go to `tmp/scenarios/schemas.json`; schemas
  labelled more than 6 hours ago are dropped on the next start (orphans of a killed run).
- Free port from `net.createServer().listen(0)`; `STAND_URL = http://127.0.0.1:<port>`; ready when
  `GET /health` answers.
- Environment: only OS essentials are inherited; everything app-related comes from
  `standEnv()` in `tests/scenarios/modes.ts`. No `.env` file is ever read (the bundle would load
  `.env.local` from `tmp/scenarios/`, hence the preflight check). `CLUSTER_MODE` is never set.
- Coverage (`SCENARIOS_COVERAGE=1` or `startStand({ coverage: true })`): the stand gets
  `NODE_V8_COVERAGE` and the `scripts/scenarios/coverage-flush.cjs` preload. V8 writes the profile
  only on a normal exit and `stopStand` hard-kills the tree, so `stopStand` first creates the flush
  file; the preload answers with `v8.takeCoverage()`. No IPC channel: the server treats a process
  with `process.send` as a cluster worker. `run.mjs` then runs `reportStandCoverage()`
  (`c8 report`, `server/src/**`) and prints the `coverage-final.json` path.

## Coverage and mutation baselines (`coverage-compare.mjs`)

`scripts/scenarios/coverage-compare.mjs` merges every istanbul `coverage-final.json` under a
directory (jest, vitest, c8, the stand report) by line and groups it by `server/src/*`,
`client/src/viewer/*` and `hook/.claude/telemetry_tool`. `--save-baseline` writes
`coverage-baseline.json` into the task folder (`docs/tasks/todo/2026-10-14-qaa-test-suite-cleanup/`),
`--compare` writes `tmp/coverage/compare.md`. `--kind mutation` does the same for a Stryker JSON
report (`server/stryker.config.json`, units only via `server/jest.stryker.config.js`) into
`mutation-baseline.json` / `tmp/stryker/compare.md`, and `--compare` exits 1 when a module scores
below the baseline. The exact commands of the old-suite baseline are in the task's
`requirements.md` Notes; the old Playwright e2e suite is not part of it.

# Modes (`tests/scenarios/modes.ts`)

One table shared by the runner and the fixtures. The module uses erasable TypeScript only and
imports nothing, because the `.mjs` scripts load it through Node 24 type stripping.

| Mode | `AUTH_MODE` | `NODE_ENV` | Extra |
|---|---|---|---|
| A | `none` | `test` | — |
| B | `password-confirm` | `production` | `PASSWORD_POLICY=long`, per-run `SESSION_SECRET`, SMTP → Mailpit, `SMTP_FROM=noreply@arrakis.test`, `ADMIN_CONTACT_EMAIL` |
| C | `password` | `test` | — |

All modes: fast-tick env (`FAST_TICK_ENV`),
`AUTH_RATE_LIMIT_POINTS=1000`, `LOGS_MAX_BODY_MB=2`, `COOKIE_SECURE=false`,
`PUBLIC_BASE_URL=<STAND_URL>`. With `NODE_ENV=test` (A, C) startup validation and login backoff
are off, so those behaviours are only observable in mode B.

A scenario declares its modes with title tags `@mode-a` / `@mode-b` / `@mode-c`; the Playwright
projects `mode-*` in `playwright.scenarios.config.ts` grep for them (`workers: 1`, no `webServer`,
reports in `tmp/scenarios/report/<pass>/`). The scenario id (`@S-AUTH-01`) is the first word of the
title. Tests that enter wrong passwords carry `@backoff` so mode B runs them on their own stand.
The backoff also counts per source IP and every request comes from 127.0.0.1, so a scenario
outside `@backoff` that still needs a wrong-password login (S-AUTH-04/05) sends it through
`helpers/loopback-client.ts` from a loopback address of its own, and the `users` fixture logs in
through `loginPastBackoff`, which waits out a `Retry-After` instead of failing.

# Fixtures (`tests/scenarios/fixtures/index.ts`)

Every spec imports `test`/`expect` from here.

| Fixture | Scope | Value |
|---|---|---|
| `stand` | worker | `{ url, mode, authMode, schema, runDir }` from `STAND_URL` / `STAND_MODE` / `STAND_SCHEMA` / `STAND_RUN_DIR` (the stand's working dir) |
| `db` | worker | `pg.Pool` on `DATABASE_URL` with `search_path` = the stand schema |
| `api` | test | anonymous `APIRequestContext` on the stand |
| `users` | test | `users.user(role, { label, email, acceptNotice })` → a fresh `<role>-<runId>@arrakis.test` user (`email` registers an exact address instead, e.g. one invited before its first login) with its own logged-in `api` context and `signIn(page)`. A: identify; B: signup + Mailpit confirmation + login; C: signup + login. The role is aligned with a direct `UPDATE` (the first user of a schema is admin); the data-collection notice is accepted by default. The fixture module also exports `loginPastBackoff(ctx, email, password)` |

# Helpers (`tests/scenarios/helpers/`)

| Helper | Purpose |
|---|---|
| `auth-mode.ts` | `standMode()` from `STAND_MODE`; `detectAuthMode(url)` asks `GET /api/v1/auth/config` |
| `mailpit.ts` | Mailpit HTTP API (`MAILPIT_URL`): latest message to an address, `listEmailsTo(email, { atLeast })` (all messages, newest first, after a settle wait so «no letter» can be asserted), token and link extraction |
| `loopback-client.ts` | `loopbackClient(standUrl)`: JSON requests bound to a random `127.a.b.c` source address, so mode-B login-backoff checks get an IP counter of their own (all of 127/8 is loopback on Windows and Linux; macOS needs an `lo0` alias) |
| `ui-auth.ts` | the login form and account menu as a person uses them: `submitLoginForm`, `loginViaUi` (waits out a «Too many attempts» banner), `openUserMenu`, `navigateInApp` (hash change without a reload) |
| `notice-hash.ts` | Node twin of the client's notice hash, to accept the data-collection notice |
| `pdf-text.ts` | text of a downloaded report PDF |
| `api-key.ts` | `createApiKey` through `POST /api/v1/api-keys` (plaintext key returned once) |
| `queue.ts` | `waitForQueueIdle(db, userId, { timeoutMs, allowFailed })`: polls `upload_queue` every 100 ms until nothing is `pending`/`processing`; throws on `failed`/`rejected_foreign_session` unless allowed |
| `time-shift.ts` | `shiftSessionTree(db, rootSessionId, deltaDays)`: collects the session tree by `parent_session_id` and, in one transaction, moves every `timestamp`/`timestamptz` column of every table that has a `session_id` column (plus `sessions`) `deltaDays` days into the past. Tables come from `information_schema`, never a hard-coded list; an integer `session_id` is matched on `sessions.id`, a text one on the string id. `{ excludeTables }` leaves tables alone — e.g. `upload_queue`, whose aged `partially_uploaded` rows the partial-upload sweep would expire on its own |
| `db-seed.ts` | direct inserts for state no endpoint produces: `insertRow`, `sessionRowId`, `seedSessionAttribution` (unconditional replace, watermark need not grow), `seedSessionAttributionRun`. Seed through the public API whenever an endpoint exists (including `POST /api/v2/session-attribution`) and use this only otherwise |
| `golden.ts` | the golden sessions of `tests/golden/`: `uploadGolden(api, apiKey, fixtureId, { runId, base, queue })` sends every root and sub-agent through `POST /api/v2/logs` and waits for the queue; `loadExpected(fixtureId)` / `loadRepoGoldExpected()` read the typed `expected.json` literals; `shiftGoldenTime(iso, deltaDays)` moves a fixture-relative time onto the loaded copy |
| `prompt-session.ts` | the smallest session with a known first prompt, for visibility checks rather than numbers: `uploadPromptSession(api, apiKey, { sessionId, prompt, repoUrl, branch?, at?, turns?, context?, reads? }, { db, userId })` (artisyn + claude log through `POST /api/v2/logs`, then `waitForQueueIdle`; `turns` repeats the prompt pair, so a re-upload with more turns is a strictly longer log; `context` puts hook context pairs on the first `prompt_start`, which become session and repository contexts; `reads` — repo-relative paths the first turn reads with the `Read` tool (`tool_use` under a fixed working directory sent as `git.root`, plus its `tool_result`), so `session_file_stats` gets one file per path in the category the config picks); `uploadSubagent(api, apiKey, { sessionId, parentSessionId, prompt }, queue)` adds a `claude-subagent` transcript with usage under a root; `postSessionLog(api, session, type, headers)` returns the raw response for refused uploads; `ownRepoId(api, repoUrl)`; `rangeAround(at)` → `startDate=…&endDate=…` for analytics and report routes |
| `teams.ts` | team set-up through the public API: `createTeam`, `invite`, `inviteAndAccept` (accepts with the acknowledged access mode), `setMemberRoles`, `addTeamRepo` (returns the `team_repositories` link id), `unlinkTeamRepo` / `removeTeamRepo` (by link id), `deleteTeam`; `browserAs(browser, standUrl, user, path)` opens a second browser signed in as another user; `skipNewUserNudge(pageOrContext)` stops `useNewUserNudge` from sending a brand-new user from `/#/main` to `/#/api-keys` |
| `zip.ts` | dependency-free zip: `buildZip(entries)` (stored entries, accepted by the server's `yauzl`), `readZip(buffer)` (stored or deflate, via the central directory — to look inside a downloaded export), `buildExportZip({ sourceRepoUrl, sessions, formatVersion? })` — an archive in the export layout (`meta.json`, `sessions/<id>/session.json`, `claude.jsonl`, `artisyn.jsonl`) from prompt sessions with any author e-mail, e.g. one unknown to the stand |
| `session-view.ts` | the session detail pane for the S-SESS scenarios: `uploadGoldenRepo(api, db, owner, fixtures)` (golden fixtures into one repository, with `rootId(fixture)` / `agentId(fixture, key)`), `openSession(page, user, repoId, sessionId, { tab, teamId })`, label-based readers `summaryTile`, `infoValue`, `infoTableValue`, `usageCounter`, `toolRow`, `logTurns` (top-level Logs turns), `turnMetric(turn, 'In' \| 'cache_ratio' \| 'Cost' …)`, `rootLineCounts(fixture)`, and display formats `usd4` / `pct1` / `hms` / `int` that print an `expected.json` literal the way the UI does |
| `reports.ts` | REPO-GOLD and the Analytics / Reports screens for the S-COST, S-ANLT and S-REPT scenarios: `uploadRepoGold(api, db, owner, fixtures?)` (default all nine fixtures; returns `totals`, `expected` by root key, `sid(key)` / `keyOf(sessionId)`, `at(iso)` / `day(fixtureDay)` onto the loaded copy and the API `range` A..A+13d), `repoGet(user, repoId, route, params)` (asserts 200), `openReport(page, user, repoId, reportId, { startDate, endDate, branches, groupBy })` and `openAnalytics(page, user, repoId, { from, to, view, layout, groupBy })` deep links, `downloadPdfText(page)`, readers `kpiTile`, `kpiRowValues`, `reportSection`. Specs that use the screens pin the browser to UTC (`test.use({ timezoneId: 'UTC' })`) so the UI range equals the API range. Analytics remounts only when its view (`av`) changes, so a second `openAnalytics` with the same view keeps the old layout/grouping — switch those with the controls instead |
| `ingest.ts` | raw uploads for the S-INGEST scenarios: `postLogs(api, key, params, body, headers)` sends exactly the given bytes to `POST /api/v2/logs` (plain, gzip with or without `Content-Encoding`, chunk params), `ndjson(rows)`, and DB readers `logRowCount`, `sessionRowCount`, `queueRowCount`, `storedBody(db, sessionId, type)` (the stored jsonb lines) and `processedSizes(db, sessionId)` (`upload_queue_measurements.size_bytes` of successful runs — the decompressed size the server counted) |
| `export-import.ts` | repository export/import jobs through the API: `exportRepo(api, repoId, body)` → `{ jobId, zip }` (start, poll, download), `startExport` / `stageImport` (raw responses for refusal checks), `importZip(api, repoId, zip)` (stage, confirm, poll to `done`), `stageBootstrap` / `confirmBootstrap` / `bootstrapImport` (the no-target-repo import), `waitForJob(api, statusPath)` |
| `hook-process.ts` | the hook as child processes, for the S-HOOK scenarios (ported from `hook/.claude/telemetry_tool/__tests__/test-helpers.js`): `tempDirs()` (every sandbox under `os.tmpdir()`, never in this repo — a non-git cwd under the repo would resolve its git root), `copyToolDir`, `makeFakeGitRepo({ remote, branch, userName })`, `makeFakeHome`, `writeConfig` / `writeStandConfig` (the `ARTISYN` config: `serverUrl` in `log-hub.json`, the key only in `log-hub.local.json`, OTEL and prompt uploads off by default — `QUIET_HOOK_CONFIG`), `runScript` / `runHook` / `runPromptUpload` / `runNodeScript` (exit code, stdout, elapsed ms), `startFakeLogHub` (records method, path, query, headers, raw body; answers 201 `{warnings: []}`, a scripted status, `hang` or `drop`), readers `readHookLog`, `readManifest`, `readRecommendations`; the OTEL receiver: `freeLoopbackPort`, `spawnReceiver`, `startReceiver`, `waitForExit`, `stopReceiver`, `rawRequest` (one fresh connection per request); `writeFakeMcpServer`, `writeFakeClaude(behavior)` + `pathWith(dir)`; the built plugin: `installBuiltPlugin(standUrl, repo)` (the plugin archive from the stand's own installer tarball), `runPluginEvent` (every command `hooks/hooks.json` registers for an event); `[win]` process probes; `normalizePath` (DD SC6: `realpathSync.native` + forward slashes) |
| `installer.ts` | the hooks installer CLI for the S-INST scenarios: `unpackInstaller(standUrl, dirs)` unpacks the stand's own `GET /static/artisyn-hooks-installer.tgz` (what `npx <server>/static/…tgz` runs), `runInstaller(cli, cwd, args, { home, fakeClaudeDir, stdin, env })` runs `node package/dist/index.js` with a fake HOME, a PATH stripped of every real `claude` (optionally a fake one first), `CLAUDECODE` blanked and stdin a pipe (never a TTY); `patchedPluginArchive(cli, dirs, { entry: content })` → a modified `hooks.tar.gz` for `ARTISYN_HOOKS_ARCHIVE_PATH`; `treeHashes(root)`, `filesContaining(root, needle)`, `fakeClaudeCalls(callsLog)`, `readJson`, `writeClaudeSettings`, `USER_SETTINGS` (the design's user `.claude/settings.json`) |

The first four were copied from `tests/e2e/helpers/` without the hard-coded dev-server URL.

# Golden sessions (`tests/golden/`)

Nine hand-checked fixtures (ten roots, one repository REPO-GOLD) with their numbers as literals in
`gs-NN-*/expected.json` and the repository totals in `repo-gold.expected.json`
(`tests/golden/README.md`). Two checks guard them:

- `tests/golden/check-arithmetic.mjs` — no app involved: re-parses the transcripts (tokens per
  transcript, sidechain and duplicate `message.id` lines excluded), prices them from the rates of
  the plan's DD D3 and re-derives every cost, ratio, change-surface concentration and REPO-GOLD
  total; `scripts/__tests__/golden-arithmetic.test.js` runs it under `npm run test:scripts`.
- `tests/scenarios/view/golden-load.spec.ts` (`@mode-a`) — uploads all fixtures into one repo and
  compares the API (session list, timeline, `/logs` sub-agent stats, change surface, Executive
  Summary, branches, token/tool/productivity analytics, cache-read-ratio report, work time per
  day) with those literals. A disagreement that is a code bug keeps the correct literal and its
  test is marked `test.fail` with a pointer to the task Notes.

The session-view scenarios (`tests/scenarios/view/s-sess-*.spec.ts`) load single fixtures into a
repository of their own (`helpers/session-view.ts`) and compare the UI tabs with the same literals:
S-SESS-01 (GS-01: Summary, Info, Statistics, Logs), S-SESS-03 (GS-07 hidden lines, turn tokens,
cost tooltip, tool modal; GS-01 files), S-SESS-04 (GS-02 nesting and tree cost), S-SESS-09 (GS-08
Windows change surface and its three warnings; GS-09 path normalisation), S-SESS-12 (Raw Logs
owner-only, a restricted-team manager refused). S-SESS-14 (`s-sess-14.spec.ts`, modes A and C)
builds its own session instead of a golden fixture: the Context Growth step modal, the Bash view,
call statuses in Logs (a failed Edit in Files, an orphan Agent call) and the Bash tab with its
`bashCall` URL param.

The cost, analytics and report scenarios (`tests/scenarios/view/s-cost-*.spec.ts`,
`s-anlt-01.spec.ts`, `s-rept-0[12].spec.ts`, helpers in `helpers/reports.ts`) load several
fixtures — or all of REPO-GOLD — into one repository and compare every surface with the same
literals: S-COST-01 (one cost per session in the list, timeline, active sessions, Executive Summary
and the session pane), S-COST-02 (GS-04: 5m/1h cache writes, fast mode, web search in the turn
tooltip, Info, Statistics and Call Tree), S-COST-03 (the public `GET /api/v1/model-pricing` rates —
the only place a test reads the price table — first-model pricing of GS-06a, the unpriced GS-06b
and the W2 Executive Summary), S-ANLT-01 (timeline, branch grouping and filters, merged work time
per day, the Cost and Work Time views), S-REPT-01 (Executive Summary tiles, weeks, model mix,
top 5, branch filter, previous period, PDF) and S-REPT-02 (Cache Read Ratio: ratio of sums for
both scopes, branch groups, causes and the personal threshold).

The ingest and platform scenarios (`tests/scenarios/ingest/s-ingest-0[1-4].spec.ts`,
`tests/scenarios/platform/s-plat-01.spec.ts`; modes A and C) talk to the
upload route byte by byte: S-INGEST-01 (key created, working, expired, revoked; one 401 body for
every reason; `POST /api/v1/logs` → 404), S-INGEST-02 (first upload: ssh/https normalised into
one repository, branch, user, contexts, re-uploads without duplicates; the session list only shows
sessions that have a `claude` log), S-INGEST-03 (structural 400s, malformed NDJSON as a `failed`
queue row, NUL, the four gzip shapes, 413 for oversize and gzip bombs under `LOGS_MAX_BODY_MB=2`),
S-INGEST-04 (6000-line Cyrillic/emoji transcript in three v2 chunks: retry, out of order, every
parameter refusal, a foreign uploadId, byte-exact assembly, last writer wins, the Logs tab),
S-PLAT-01 (`/health`, `/health/version`, the strict CSP / `X-Frame-Options` / `nosniff` on API,
SPA, `/static` and `/assets` responses, error bodies without stacks or paths, no CORS).

The hook scenarios (`tests/scenarios/hook/s-hook-0[1247].spec.ts`, `s-hook-09.spec.ts`, helper
`helpers/hook-process.ts`) run the real hook scripts as child processes in throwaway projects under
`os.tmpdir()`. S-HOOK-01, -04 and -07 never reach the stand (fake log hub, closed ports, the OTEL
receiver itself), so they run in mode A only; S-HOOK-02 and -09 upload to the stand and run in A and
C. S-HOOK-01 (a Stop run: v2 route, key header, current-session-first order, `parentSessionId` /
`workflowRunId`, `journal.jsonl`, hook-status and harness only on the current artisyn body, the
manifest skip/prune, SessionEnd, the upload lock), S-HOOK-02 (torn NDJSON repaired byte for byte,
dropped-line diagnostics, nothing secret in hook.log, telemetry or bodies, `edit_result` without
content, the stand ingests the repaired files), S-HOOK-04 (closed, silent, 500 and 401 servers,
early exits of every hook, the prompt hook's background upload and its throttle and watchdog,
`callLlmAsync` with a broken/hanging/missing `claude`, two Stops at once), S-HOOK-07 (the receiver:
argv, Origin/Referer 403, 415, OPTIONS 405, path-trick session ids, owner 409 on register and
shutdown, the 413 wire cap, gzip/br, loopback-only binding, idle exit, 20 concurrent writes) and
S-HOOK-09 (the BUILT plugin unpacked from the stand's installer tarball, run per `hooks.json` in
session order: repository, branch, user, cost, Logs, sub-agent, harness elements, the Installed
Hooks page up to date and outdated, the `?v=` max-wins baseline, `broken-upload-file` appearing and
clearing, public model pricing). The `?v=` downloads write `latest-hook-version.json` into
`tmp/scenarios/stand/public/static`; S-HOOK-09 deletes it before and after, so every other scenario
sees the bundled `installer-version.json` as the latest version. The `[win]` killProcessTree check
of S-HOOK-04 is a separate test pinned with `test.fail`: it found a product bug (task Notes).

S-COMPAT-01 (`tests/scenarios/hook/s-compat-01.spec.ts`, A and C) runs two real historical hooks,
frozen once into `tests/fixtures/legacy-hooks/<ver>/` by `scripts/scenarios/freeze-legacy-hook.mjs
--commit <sha> [--label <ver>]` (read-only `git archive` of `hook/.claude/telemetry_tool/` at the
commit, without `__tests__`/`.env*`, plus `FROZEN.json` `{ commit, version }`; an existing
directory is never overwritten without `--force`). Commits come from
`git log --format=%h -- hook/.claude/telemetry_tool/version.json`; the last commit of a version
is the parent of the bump past it. 1.6.2 (`4d4e6d9^`, the last before 1.7.0) knows only
`POST /api/v1/logs`: every upload is a 404, the hook exits 0 and counts every file as failed
(fail-open), nothing reaches the server. 2.6.1 (`577386b^`, the last before 2.8.0) uploads by v2:
sub-agents under their parents and the workflow run, an «outdated» hook state, and its 900 KB
chunk form resumed from `.claude-logs.pending` after a failed chunk (a recording proxy in front of
the stand injects the failure). A frozen hook runs from a throwaway copy and is never edited.

The installer scenarios (`tests/scenarios/installer/s-inst-0[124].spec.ts`, mode A — the CLI does
not depend on the auth mode) run the CLI from the stand's own installer tarball (`helpers/installer.ts`)
against throwaway git projects with a fake `claude` and a fake log hub. S-INST-01 (early exits, the
`.claude/` prompt, the exact plugin tree and the manifests the build script defines —
`scripts/build-hooks-installer.js` is `require`d for `MARKETPLACE_NAME`, `PLUGIN_NAME`,
`HOOK_JS_FILES`, `buildPluginJson`, `buildMarketplaceJson` and the `INSTALL_HOOK.md` event parser —
the user's settings byte for byte, the nine OTEL env keys in the gitignored
`.claude/settings.local.json` and none in `.claude/settings.json` (step 6), a drifted recorded port
repointing both local endpoints with the «rewrote stale Artisyn OTEL endpoints» Note (6b), a legacy
layout with the keys in `settings.json` moved to `settings.local.json` with the «moved the Artisyn
OTEL env keys» Note (6c), two `claude plugin` calls, the receiver smoke test, the installed Stop
command uploading with the configured key); a second test runs the real `claude plugin validate` on
the installed marketplace and plugin and is skipped when no `claude` is on PATH. S-INST-02 (the key
only in `log-hub.local.json`, 0o600 on POSIX, git status and `.gitignore` entries — neither
`.claude/settings.local.json` nor its `.bak` shows up — destination-change warning, key
replacement, a tracked local config aborts); its step 9 (atomic writes under a concurrent reader) is
a separate test pinned with `test.fail` on Windows — it found a product bug (task Notes). S-INST-04
(uninstall removes only its own files and keys — the OTEL keys from `settings.local.json` too —
keeps a user hook sharing the installer's matcher group, leaves a foreign OTEL collector alone: a
non-loopback logs endpoint in `settings.json` (no local shadow written, step 3), a loopback one on a
non-Artisyn port in `settings.local.json` (3b), all nine keys committed on the user's own collector
(`settings.json` env identical after install and uninstall, no local OTEL key, 3c) — and survives a
locked plugin file — PowerShell `FileShare.None` on Windows, a 0o500 directory on POSIX).

Each root's `artisyn.jsonl` carries the hook's `SessionStart`/`SessionEnd` lifecycle lines at the
transcript's first and last timestamp. Without them the session's end time is its last
`prompt_start`, and the work-time report (which clamps each session's work interval to that end)
would drop the last turn.

# Screen tours (`tests/scenarios/tours/`)

Every screen, tab and guard state of the web client is a row of
`tests/scenarios/tours/screen-registry.ts` (`ScreenRow`: `id`, `route` pattern from
`client/src/app-routes.ts`, optional `query`/`tab`, `role`, `modes`, `title`, `docRef` and an anchor —
`expectText` / `expectTestId` / `expectSelector` / `expectUrl`, with `{param}` placeholders). The
module imports nothing (Node type stripping loads it for the doc audit, block J); `docRef` points at
a help article heading the audit compares the screen with.

Nine browser stories walk the rows by role (`tour-01-anon` … `tour-09-help-consent`, title tag
`@TOUR-NN`; `tour-01` runs in A, B and C, the rest in A) through `tour-kit.ts`: `TourWalker.screen()`
opens a row in its own `test.step`, checks the anchor and the active tab trigger, then the four
health checks of every screen — no error screen text, no `pageerror`, no `console.error` outside the
allowlist, no `/api/*` answer ≥ 400 outside the row's `expectedNetwork` (judged after the page's API
requests settle). Failures are collected and reported together by `finish()`, which also fails when a
row of the story was never walked. `expectTabsOnScreen()` compares the rendered
`tab-<group>-<id>` triggers with the registry (the runtime layer of the meta-test).

`tour-10-registry` needs no browser: it imports `APP_ROUTES`, the `tab-ids.ts` constants,
`VIEW_OPTIONS`, `ALL_REPORTS` and `helpNav` from `client/src` and fails on any route / tab / view /
report / article without a row (or a row without its screen), on help files that differ from
`helpNav`, on params a story does not provide, and on `docRef` files or headings that do not exist.

Facts the tours pin (code wins over the 06 design): mode A auto-identifies any local cookie-less
browser as user #1, so the anonymous story reaches the identify form through «Edit email»; a
restricted team's owner may read a member's raw logs (a manager may not); someone else's team page
stays on «Loading team…»; a restricted member's repository view gets a 403 on its settings; there is
no Token Flow tab any more.

# Checks of the runner itself

`scripts/__tests__/scenarios-stand.test.js` and `scenarios-run.test.js` (part of
`npm run test:scripts`) cover the pure logic: schema names, mode env, input hash, orphan schema
labels, argument parsing, mode-B passes and fingerprint diffs, source-map rebasing.
`scripts/__tests__/coverage-compare.test.js` covers the coverage merge and the mutation scores. The smoke scenario
`tests/scenarios/platform/stand-smoke.spec.ts` (`@mode-a @mode-b @mode-c`) checks `/health`, the
reported auth mode, the SPA and the fixtures end to end.
