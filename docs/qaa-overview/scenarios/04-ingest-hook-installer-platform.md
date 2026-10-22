# Scenarios: log ingest, hook, installer, platform

Group: INGEST (log ingest v1/v2), HOOK (the Claude Code hook and the OTEL receiver), COMPAT (hook backward compatibility), INST (installer), REL (build and releases), PLAT (health, headers, static files, cluster, server logs).

## 0. Scope and assumptions

**What we cover.** 28 scenarios instead of about 860 existing tests of this group (an approximate count, by `grep` of `it(`/`test(` lines; an `it.each` counted as one). Each scenario is a long story of 5-15 steps that a person can repeat by hand (`curl`, a terminal, clicks). The written description of a scenario is the source of truth; the test code must follow it, not the other way round.

**What we do NOT cover here** (it belongs to other groups; the "Replaces" column does not list these files): `claude-extractor.spec.ts` (106) and `tool-stats.spec.ts` (88) are token/cost/tool formulas, the Cost/Analytics group; `post-turn-analysis-*`, `session-attribution-state` are the Advisor/Attribution group; `session-retention` (server retention) is the Sessions group; `user-settings`, `model-pricing` are the User/Cost groups. The hook side of OTEL retention (`otelRetentionDays`) is covered here (S-HOOK-08).

### A single runner

Everything runs under the Playwright test runner (it supports non-browser tests through the `request` fixture and plain Node code with `child_process`). Three kinds of environment:

| Environment | What it is | Where it is needed |
|---|---|---|
| **ENV-A** "shared dev server" | The already running application `http://localhost:5173` (vite -> NestJS), prod-like settings, a shared DB. The test creates everything with a unique prefix (as `E2E_REPO_PREFIX`, `E2E_API_KEY_PREFIX` do now) and cleans up after itself | almost all API/UI scenarios |
| **ENV-B** "configured server" | Its own server process on a free port, started by the test itself (Playwright `globalSetup`/a fixture), with test settings: `LOGS_MAX_BODY_MB=2`, `UPLOAD_QUEUE_INTERVAL_MS=50`, `UPLOAD_QUEUE_LEASE_TIMEOUT_MS=150`, `UPLOAD_QUEUE_PARTIAL_UPLOAD_SWEEP_INTERVAL_MS=200`, `RELEASES_DIR=<temp>`, a real file logger (`logs/`), a separate DB schema `test_e2e_*` (as `server/test/setup/global-setup.ts` does) | S-INGEST-03/06, S-REL-02, S-PLAT-03 |
| **ENV-C** "built bundle" | `npm run build`, then `node dist/index.js` (the ncc bundle) on a free port, with `CLUSTER_MODE=primary` if needed | S-REL-01, S-PLAT-02, S-PLAT-03 |

CLAUDE.md forbids stopping/restarting the dev server; ENV-B/ENV-C are separate processes on other ports and do not touch the dev server. A limitation: the scenarios on ENV-B/ENV-C and the server tests use one DB, so **do not run them at the same time** as other DB scenarios (a separate schema removes data collisions, but not the load; Playwright workers for this group = 1).

### Shared fixtures (shared code, not scenarios)

- **fake-log-hub**: a small Node `http` server that records every request (method, path, query, headers, body in bytes, size) and answers per the scenario (201 `{warnings:[]}`, `{complete:false}`, 400, 401, 413, 415, 500, silence, a dropped connection). Every "hook" and "installer" scenario needs it.
- **temp-project**: `git init` in a temp directory, `git config user.*`, one commit, fake `HOME`/`USERPROFILE` (the hook reads `~/.claude/projects/<slug>/`), a `.claude/` directory.
- **run-hook(script, stdinJson, env)**: runs `node <script>.js` as a child process with JSON on stdin (`{session_id, cwd, hook_event_name, ...}`), measuring the time and the exit code.
- **fake-claude**: a `claude` script (with a shebang on POSIX, `claude.cmd` on Windows) at the start of `PATH` that writes its arguments to a file. The installer calls `execFileSync('claude', ..., {shell:true})`, so the substitution works on both OSes.
- The hook scripts are taken from the source `hook/.claude/telemetry_tool/` (copied into a temp directory, as `test-helpers.js` does) **or** from the built plugin (after installation). Scenarios S-INST-01 and S-HOOK-09 run exactly the built and installed plugin, to catch packaging errors.

### OS notes

- **Windows-only logic** in the product: (1) a hidden launch without a window (`windowsHide`, formerly VBS through `wscript`): on Windows we check that there are no `artisyn-hidden-launch-*` files in `%TEMP%` and that the child `git` calls do not flash a window (`no-visible-window.test.js` reads the sources; it is a static check, keep it as one grep step); (2) `killProcessTree` for `cmd.exe` wrappers; (3) PowerShell/file locks on deletion (`deleteDirWithRetryWarning`); (4) the paths `X:\`, `/mnt/x/`, `/x/` in the guardrail; (5) the `.cmd` shim for MCP. On Linux these steps are marked `test.skip(process.platform !== 'win32')`, and their Linux counterparts (chmod 0o600, `/proc/<pid>/environ`, `ps eww`, directory permissions instead of a file lock) run only on POSIX.
- The suite is run by hand (`npm run test:scenarios`). The Windows-specific steps (marked `[win]`) run when it is run on Windows, the POSIX steps when it is run on Linux or macOS. The S-REL-01 step "docker build" is not run: only the `npm run build` artifacts are checked.
- A short `TEMP` on Windows (an 8.3 profile name like `ABCDEF~1` instead of the full user name) breaks the worktree tests: in the `temp-project` fixture call `fs.realpathSync.native` (8.3 names -> long names) before `git worktree add`.

---

## 1. Scenario table

| ID | Title | Layer | Priority | ~Old tests replaced |
|---|---|---|---|---|
| S-INGEST-01 | API key life: created, works, expired, revoked (v1 and v2) | API | P0 | 6 |
| S-INGEST-02 | First session upload over v1: repository, branch, user, context, repeats without duplicates | UI+API | P0 | 25 |
| S-INGEST-03 | Hostile and huge bodies: empty, broken, NUL bytes, gzip in four forms, the size limit | API | P0 | 35 |
| S-INGEST-04 | A large session over v2 in chunks: a repeated chunk, foreign parameters, byte-exact assembly | API | P0 | 19 |
| S-INGEST-05 | A broken file over v2: a warning in the next upload and the admin's work with the queue | UI+API | P1 | 31 |
| S-INGEST-06 | The queue survives failures: lease, a stuck processing, abandoned chunks, a write error, a "torn" file | API | P1 | 24 |
| S-INGEST-07 | OTEL chunks on the server: idempotency, accumulation, invisibility in the UI | API | P2 | 16 |
| S-HOOK-01 | A full Stop run: what exactly goes to the server, in what order, and what is not sent again | hook (child processes) | P0 | 40 |
| S-HOOK-02 | A broken line and privacy: the hook repairs NDJSON and does not expose secrets | hook (child processes) | P0 | 22 |
| S-HOOK-03 | A large file: chunks, gzip, resuming after a drop, the server refusing gzip, 413 | hook (child processes) | P1 | 35 |
| S-HOOK-04 | The hook never blocks Claude: the server is down, hangs, answers 500; the background upload does not slow the prompt | hook (child processes) | P0 | 39 |
| ~~S-HOOK-05~~ | **Dropped: the guardrail was removed in 2.19.0.** ~~Guardrail: reading outside the project is forbidden, inside is allowed, switches, fail-open~~ | hook (child processes) | — | 0 |
| S-HOOK-06 | Two-level config, a subfolder and a worktree: where telemetry is written, what the server sees | hook (child processes) | P1 | 72 |
| S-HOOK-07 | The OTEL receiver as a local attack surface: a browser, a foreign project, `../evil`, a huge body | hook (child processes) | P0 | 66 |
| S-HOOK-08 | OTEL end to end: SessionStart, receiving, uploading and deleting chunks, disabling, restart | hook (child processes) | P1 | 34 |
| S-HOOK-09 | The main end-to-end scenario: an installed hook, a real server, the session is visible in the UI | UI+API | P0 | 50 |
| S-COMPAT-01 | Old hooks (before 1.7.0 and 1.7-2.7) against the new server | API | P0 | 4 |
| S-COMPAT-02 | The new hook against "non-native" servers and the old OTEL receiver | hook (child processes) | P1 | 6 |
| S-INST-01 | A clean install into a project with user settings, and the installed hook working | installer (CLI) | P0 | 14 |
| S-INST-02 | Secrets: the key only in the local config, 0o600, a tracked file blocks, a server change warns | installer (CLI) | P0 | 14 |
| S-INST-03 | Reinstall, upgrade and migration from the old format are idempotent | installer (CLI) | P1 | 18 |
| S-INST-04 | Uninstall cuts out only its own parts and does not break anything else | installer (CLI) | P0 | 8 |
| S-INST-05 | OTEL port: allocation, pinning, `--otel-port`, stopping the old receiver, a foreign owner | installer (CLI) | P1 | 24 |
| S-REL-01 | Build artifacts: a clean dist, consistent versions, the installer downloads and remembers the version | installer (CLI) | P1 | 56 |
| S-REL-02 | A signed release link: from the admin panel to an anonymous download and every refusal | UI+API | P0 | 40 |
| S-PLAT-01 | Health, build version and security headers everywhere | API | P0 | 9 |
| S-PLAT-02 | Static files of the built application: br/gzip/identity, Vary, cache, SPA fallback | API | P1 | 36 |
| S-PLAT-03 | The server through an operator's eyes: cluster, System Info, a worker restart, file logs, Error Logs, archive | UI+API | P1 | 110 |

Total: P0: 16, P1: 11, P2: 1. Replaces about 860 tests.

---

## 2. INGEST

### S-INGEST-01. API key life: created, works, expired, revoked (v1 and v2)
- **Layer:** API
- **Priority:** P0 (foreign/expired keys must not write logs)
- **Data/environment:** ENV-A. A logged-in user (the admin from `ROLES.primary`) and a second plain user. Session `sess-key-<run>`, body `{"type":"prompt_start","session_id":"sess-key-<run>","git":{"repo":"https://git.example.com/e2e/<run>/keys.git","branch":"main"}}\n`.
- **Steps:**
  1. Without the `X-API-Key` header: `POST /api/v1/logs?sessionId=sess-key-1&type=artisyn` -> 401. The same for `POST /api/v2/logs` and `POST /api/v1/log-echo`.
  2. The header `X-API-Key: abc` (shorter than 6 characters) and `X-API-Key: zzzzzz-wrong-key` -> 401, no `logs` row in the DB.
  3. Under the user session: `POST /api/v1/api-keys {name:"e2e-key-ok"}` -> 201, the response holds the plain key exactly once; `GET /api/v1/api-keys` shows the key without the plain part.
  4. `POST /api/v1/log-echo` with this key -> 200 `OK` (this is exactly what the installer calls on `upgrade`).
  5. `POST /api/v1/logs` with the key -> 201; `POST /api/v2/logs` -> 201 `{warnings:[]}`.
  6. Create a second key with `expires_at` 2 seconds ahead (`PATCH /api/v1/api-keys/:id {expires_at:<now+2s>}` is fine to speed things up), wait, repeat `POST /api/v1/logs` -> 401, while the first key keeps working.
  7. `DELETE /api/v1/api-keys/:id` for the first key -> 204; the same `POST /api/v1/logs` -> 401 for both v1 and v2.
  8. User A's key on team (session) endpoints, for example `GET /api/v1/repositories`, -> 401: the key only grants the right to write logs.
- **Check:** 401 with no detail in the body (the same for "no key", "wrong", "expired", "revoked"; the reason cannot be told apart); after steps 1-2 and 7-8 the DB has no new `logs` row; after step 5 exactly one `logs` row and one `sessions` row, the repository belongs to the key's owner (`repositories.user_id`); the plain key is never returned again (`GET /api-keys` does not contain the key string); after a deletion the other keys are not affected.
- **Replaces:** the `log auth guard` block of `server/test/logs.e2e-spec.ts` (3 tests), 3 tests of the 401 status from `upload-queue.e2e-spec.ts` over v2 (without a key). It closes gaps F.1 #1 (revocation/expiry) and #11 (a key on team endpoints). `api-keys.e2e-spec.ts` (21) belongs to the AUTH/API-KEYS group and is not replaced here.
- **What we lose:** the exact validation of the key DTO (the `expires_at` format, an empty name) stays in the API-KEYS group; the comparison on slug collisions (two keys with the same 6-character prefix) does not matter to the user.

### S-INGEST-02. First session upload over v1: repository, branch, user, context, repeats without duplicates
- **Layer:** UI+API
- **Priority:** P0
- **Data/environment:** ENV-A, the key from S-INGEST-01. Three NDJSON files of session `sess-x-<run>` and repository `https://git.example.com/e2e/<run>/shop.git`: `artisyn` (`prompt_start` events with `git:{repo:"git@git.example.com:e2e/<run>/shop.git", branch:"feature/cart", user:"Jane Dev"}`, `context:{project:"shop", lab:"team-a", count:3, tags:["a","b"]}`, start 10:00:00Z, end 10:04:00Z), `claude` (a transcript with one assistant reply and usage), and a second session with `repo` only in the last lines.
- **Steps:**
  1. `POST /api/v1/logs?sessionId=sess-x&type=artisyn` with the body of the first file -> 201, an empty response body.
  2. `GET /api/v1/repositories` (under the key owner's session): exactly one repository for `shop` (the ssh URL and the https URL are normalized into one), `GET /api/v1/repositories/:id/sessions`: one session `sess-x`, `userEmail` equals the key owner's e-mail (the server does not use the `git.user` field), branch `feature/cart` in `GET .../sessions/branches`.
  3. Open `#/repos/:id` in the browser: the session is visible in the list, the branch is shown, the session time is 4 minutes.
  4. Repeat step 1 with a body where the same repository is written as an https URL: still one repository, one link, one `sessions` row; `created_at` did not change, `updated_at` grew (an upsert, not a duplicate).
  5. `POST ...&type=claude`: `GET .../sessions/:sid/logs` holds the messages and tokens; the `claude` type does not overwrite the data of the `artisyn` artifact (the branch and the time stayed).
  6. The second session: the first upload without `git.repo`, the second (a late chunk) with `repo` -> the repository is linked after the second upload (a regression of the chunked upload).
  7. Garbage: `git.repo:"   "`, `git.repo: 42`, `context:{"":"x"}`, `context:"str"` -> 201, no new repositories or contexts.
  8. Context: `count:3` and `tags:["a","b"]` are stored as strings; `GET /api/v1/repositories/:id/contexts` holds `project=shop`, `lab=team-a`.
  9. An upload with another key (user B) of the same repository URL -> B gets their own repository (owner isolation), A's data did not mix.
- **Check:** the number of rows in `repositories`, `sessions`, `log_repositories` after each step (1/1/1, and then it does not grow); the branch and the time are extracted only from the `artisyn` log; `userEmail` = the key owner; ssh/https normalized into one record (closes F.2 #23); empty/wrong values are ignored without 4xx/5xx; the UI shows the repository, the branch, the duration.
- **Replaces:** the `artisyn log extraction` block of `logs.e2e-spec.ts` (17 tests: upsert, one session row, the repo links on the second write, a late chunk, no duplicates, context, coercion, empty fields, owner), the repo/branch/time part of `artisyn-extractor.spec.ts` (~8). `repo-url-normalizer.spec.ts` belongs to the REPOS group and is not replaced here.
- **What we lose:** the edge cases of URL normalization (the `.git` suffix, the port, case) stay with the REPOS group; the `hook-status` extraction is covered in S-HOOK-09; the harness inventory (the `harness element inventory` block, 1 big test) is the Harness group.

### S-INGEST-03. Hostile and huge bodies: empty, broken, NUL bytes, gzip in four forms, the size limit
- **Layer:** API
- **Priority:** P0 (a 500 on garbage, and data loss through gzip/limits)
- **Data/environment:** ENV-B (`LOGS_MAX_BODY_MB=2`), the owner's key. The helper `zlib.gzipSync`.
- **Steps:**
  1. Structural 400s on both routes `/api/v1/logs` and `/api/v2/logs`: no `sessionId`, no `type`, an empty body, a body of spaces -> 400 and nothing in the DB.
  2. v1: the body `{"a":1}\nNOT-JSON\n` -> 400 `Malformed NDJSON`, no `logs`, no `sessions`, no `upload_queue`. v1: a body of only empty lines -> 400 `no valid NDJSON lines`.
  3. NUL: the line `{"text":"a\u0000b"}` with a real U+0000 character in the value (after JSON decoding) -> 201 (not 500), the stored text is `ab`. The line with double escaping `{"text":"literal \\u0000 here"}` -> 201, and `literal \u0000 here` is stored as text.
  4. A 150 KB body (`>100 KB`, the old express.json limit) -> 201.
  5. Four kinds of gzip for the same body `T` (over v1 and over v2): (a) plain; (b) `Content-Encoding: gzip`; (c) gzip without the header (a proxy stripped it, `Content-Length` = the compressed length); (d) a body that starts with the magic bytes `1f 8b` but is broken -> 400 `Malformed gzip request body`, nothing is created. For (a)-(c) the stored content (`GET .../logs`) is byte-for-byte identical.
  6. Limit: a 3 MB plain body -> 413. A gzip whose compressed length is > 2 MB -> 413. A small gzip (a few KB) that inflates to 3 MB (a 1000:1 gzip bomb) -> **413, not 400** (otherwise the hook would disable compression forever as "unsupported").
  7. A body just under the limit (1.9 MB) -> 201.
  8. For v2 the same through chunks: a gzip chunk whose inflated size matches `totalSize` (the size in the DB = uncompressed).
  9. After all steps: the server is alive (`GET /health` 200), `logs` has exactly one row per valid upload.
- **Check:** the exact codes 400/201/413 and no 500; no side rows in `logs`, `sessions`, `upload_queue` on 4xx; byte-for-byte equality between the plain and the compressed variants; the difference between a real NUL and a literal `\u0000` in the chat text; `size_bytes` in the queue equals the length of the uncompressed body.
- **Replaces:** `logs.e2e-spec.ts` (~11: 400 on sessionId/type/empty, >100 KB, 413, NUL x2, limit), `logs-gzip.e2e-spec.ts` (all 13), `gzip-sniff.middleware.spec.ts` (6), part of `ndjson-parser.spec.ts` (~4: a bad line and "no valid lines").
- **What we lose:** the "up to 10% broken lines" tolerance of `ndjson-parser` (dropping truncated tails) is covered in S-INGEST-06 (the torn file) and S-HOOK-02 (the hook cleans up itself); the exact edges of the 10% threshold are not checked (the owner's decision: keep it as a small unit test, see section 4).

### S-INGEST-04. A large session over v2 in chunks: a repeated chunk, foreign parameters, byte-exact assembly
- **Layer:** API
- **Priority:** P0 (data loss/corruption)
- **Data/environment:** ENV-B (the queue ticks every 50 ms). A ~2.5 MB transcript file of 6000 NDJSON lines with Cyrillic and emoji (multi-byte characters on the chunk boundaries). Cut by a helper on `\n` into 3 parts `c0`, `c1`, `c2`. `uploadId = u-<run>`.
- **Steps:**
  1. Chunk 0: `POST /api/v2/logs?sessionId=S&type=claude&uploadId=u&chunkIndex=0&totalChunks=3&totalSize=<N>` -> 201 `{complete:false}`. `GET /api/v1/admin/upload-queue` shows a `partially_uploaded` row with `chunksReceived=1`, `totalChunks=3`.
  2. The same chunk 0 again (the hook retried the request) -> 201 `{complete:false}`, `chunksReceived` is still 1.
  3. Chunk 2 before chunk 1 -> 201 (allowed), `chunksReceived=2`; then chunk 1 -> 201 `{complete:true, warnings:[]}`.
  4. Parameter errors (each with a new `uploadId`): only `uploadId` without `chunkIndex`/`totalChunks` -> 400; `chunkIndex=abc` -> 400; `chunkIndex=3` with `totalChunks=3` -> 400; `totalChunks=0` -> 400; chunk 0 without `totalSize` -> 400; `chunkIndex=1` with an unknown `uploadId` -> 400 `Unknown uploadId`; chunk 1 with `totalChunks=4` when 3 were recorded -> 400 `mismatch`.
  5. Another user (key B) sends chunk 1 with user A's `uploadId` -> 400 `Unknown uploadId` (isolation by user).
  6. Wait for the assembly (poll `GET /api/v1/admin/upload-queue` until the row disappears): `logs` has exactly one row, `size_bytes = N`; `GET .../sessions/:sid/logs` returns all 6000 lines; the log body downloaded through `GET /api/v1/admin/upload-queue/:id/file` at an intermediate step equals the concatenation of the chunks (byte for byte, SHA-256).
  7. A single chunk (`totalChunks=1`): chunk 0 of 1 is assembled at once, `complete:true` (closes F.2 #18).
  8. Repeating the whole upload with a new `uploadId` and the same `sessionId/type` -> the result is "last writer wins", with no duplicate `sessions`.
  9. The session is visible in the UI at `#/repos/:id/sessions/S` (the Logs tab shows the first and the last messages; Cyrillic and emoji are not damaged).
- **Check:** `complete` only on the last missing chunk; idempotency of a repeat; the exact 400 texts; the SHA-256 of the assembled body equals the SHA-256 of the source file; multi-byte characters at the joins are intact; uploadId isolation between users; the correct text in the UI.
- **Replaces:** the `chunked uploads` (5), `async staging` (3), v1-unmodified (1) blocks of `upload-queue.e2e-spec.ts`, the `compressed chunked uploads` block of `logs-gzip.e2e-spec.ts` (2), `upload-queue.service.spec.ts` (8, chunk assembly and stage); it closes F.2 #18 (a single chunk).
- **What we lose:** the unit-level FS mocking (`rename` errors) is partly in S-INGEST-06 (a staging write failure); the exact names of the temp files `.chunkN` are internal.

### S-INGEST-05. A broken file over v2: a warning in the next upload and the admin's work with the queue
- **Layer:** UI+API
- **Priority:** P1
- **Data/environment:** ENV-B, an admin and a plain user (UI), the owner's key. Seed: 4 queue rows with different statuses (pending, processing, failed x2), through real requests + a reverse edit of `upload_queue.status` in the DB for pending/processing (faster than waiting).
- **Steps:**
  1. `POST /api/v2/logs` with the body `{"ok":1}\nBROKEN-LINE\n{"ok":2}\n` for session `bad-1` -> 201 `{warnings:[]}` (v2 does not fail synchronously).
  2. After ~1 s the scheduler marks the row `failed`; `GET /api/v1/admin/upload-queue` shows `status=failed`, a non-empty `errorMessage`, `sessionId=bad-1`, `logType`, `repoUrl`; the DB has no `logs` for `bad-1`.
  3. A valid file `good-1` next to it in the same queue drains (the queue did not stall).
  4. The next upload (any) with the same key -> 201 `{warnings:["…bad-1…"]}`, exactly one warning, containing the `sessionId`.
  5. The admin in the UI: Admin Panel -> Upload Queue: sees the counters 1 failed (after the edit up to `4/1/0/2`, 7 in total, the arithmetic from F.3 #39); the statistics block shows "files/s", "MB/s", "p95", "ETA", and a dash instead of NaN when there are no measurements.
  6. Click the file link of the failed row -> the attachment downloads; the body equals the uploaded one (byte for byte); for a row whose file was already deleted from disk -> 404.
  7. Click "Reprocess failed": failed -> pending, `errorMessage` is cleared, pending/processing are untouched; it becomes failed again (the file is still broken) and the counter grew.
  8. Click "Clear broken files" (with confirmation): the failed rows and their staged files are deleted, pending/processing stayed.
  9. The warning from step 4 is gone: the next upload -> `{warnings:[]}`.
  10. A plain user: `GET /api/v1/admin/upload-queue`, `/stats`, `/:id/file`, `POST /reprocess-failed`, `DELETE /failed` -> 403; without a session -> 401; the Admin Panel link is not visible in the UI.
  11. The Error Logs tab: an ERROR-level line with `bad-1` at the top (if the ENV-B server writes to a file, see S-PLAT-03; in this scenario it is checked only when the logger writes to a file).
- **Check:** the moment the error becomes visible (the next upload, not the current one); the content of `errorMessage`; the arithmetic of the counters and the throughput (in the statistics a failed attempt counts in `failureCount` and `activeMs`, but not in the successful throughput); the 401/403 rights on 5 admin endpoints; the UI buttons really call the API.
- **Replaces:** the `Failure handling` (2 of 3; the torn file is in S-INGEST-06) and `Admin upload-queue endpoints` (17 tests) blocks of `upload-queue.e2e-spec.ts`, `upload-queue-stats.service.spec.ts` (11, the arithmetic of pg rows; the edge values are reduced to 2-3 numeric steps), `AdminUploadQueueTab.test.tsx` and `UploadQueueStatsPanel.test.tsx` (the client components group, ~6); it closes F.3 #27 and #39.
- **What we lose:** utilization clamped to 100%, p95 with two measurements, ETA at zero throughput: this is pure arithmetic (keep one unit test or accept the loss, see section 4); the "Copy" click on an error is the ADMIN UI group.

### S-INGEST-06. The queue survives failures: lease, a stuck processing, abandoned chunks, a write error, a "torn" file
- **Layer:** API
- **Priority:** P1
- **Data/environment:** ENV-B with `UPLOAD_QUEUE_LEASE_TIMEOUT_MS=150`, a 50 ms interval, `UPLOAD_QUEUE_PARTIAL_UPLOAD_SWEEP_INTERVAL_MS=200`; direct DB access for edits of `upload_queue` (as `helpers/db.ts` does) and access to the `UPLOAD_QUEUE_DIR` directory.
- **Steps:**
  1. Lease: insert a row with `status='processing'`, a `lease_expires_at` in the past and an existing staged file of valid NDJSON -> within a couple of ticks the row returns to `pending` and drains (`logs` appears).
  2. A fresh lease: a `processing` row with `lease_expires_at` a minute ahead -> it is **not** picked up again (a double-processing regression): after 1 s it is still `processing`, `logs` did not appear.
  3. Overlap: upload 5 files in a row; record that at no moment does the DB have two `processing` rows at once (polling every 10 ms).
  4. Abandoned chunks: a `partially_uploaded` row with `updated_at` older than the TTL (a DB edit to -25 hours) and a fresh live row with chunks -> the old one disappears together with its `.chunkN` files, the live one stays.
  5. Self-healing: put a `<uploadId>.raw` and a row that refers to an already assembled part file -> within a tick the data reached `logs` (F.2 #20).
  6. A staging write error: make `UPLOAD_QUEUE_DIR` not writable (POSIX `chmod 0500`; on Windows, replace the path with a file instead of a directory) -> `POST /api/v2/logs` -> 500, no row in `upload_queue`; restore the rights, and the next upload gives 201.
  7. A torn file from an old hook: an NDJSON of 200 lines whose last line is cut in the middle of the JSON (one broken line of 200, < 10%) -> the row drains, the broken line is dropped, 199 lines are in `logs`, **not** `failed`. A file with 30% broken lines -> `failed` (the threshold edge).
  8. An `upsert` failure: an upload where the server cannot write `logs` (for example, a `session_id` longer than allowed / a constraint violation) -> the row stays `failed` with an `errorMessage` and is visible in the admin panel (F.2 #18).
  9. Result: `upload_queue` has no `processing` rows, no row is lost; the server answered 201 to every valid request.
- **Check:** the queue heals itself without intervention; no double processing; the TTL applies exactly to `partially_uploaded`; a 500 on a write failure leaves no "ghost" rows; the edge of dropping broken lines (a torn file versus real garbage).
- **Replaces:** the `Partial-upload expiry` (1), `Lease-timeout reclaim` (2), `Overlap guard` (1), `Staging directory write failure` (1), `torn file` (1), `multiple pending, one fails` (1) blocks of `upload-queue.e2e-spec.ts`, `upload-queue-scheduler.service.spec.ts` (19, mocks; one end-to-end scenario instead of a mock grid), part of `ndjson-parser.spec.ts` (~4).
- **What we lose:** the exact tick budget (`UPLOAD_QUEUE_TICK_BUDGET_MS`) and the age-based cleanup of measurements (`MEASUREMENT_RETENTION`), both internal optimizations (the loss does not matter); the race timings of the overlap guard under real load are unstable, so step 3 checks the invariant, not the timing.
- **A note on stability:** steps 1-3 depend on timers. Poll with a 5 s timeout rather than a fixed `sleep`.

### S-INGEST-07. OTEL chunks on the server: idempotency, accumulation, invisibility in the UI
- **Layer:** API
- **Priority:** P2 (end-to-end behaviour of the OTEL branch; the data only complements the cost)
- **Data/environment:** ENV-A or ENV-B. Two valid OTLP lines (the line format from the KB: `{"signal":"logs","receivedAt":..,"record":{...api_request: cost_usd 0.05...}}` and the same for metrics), a claude log of the same session, `service.version` 2.1.280 / 2.1.290.
- **Steps:**
  1. Upload a `type=claude-otel` chunk `…/otel/S/1700000000000-1.jsonl` (v2). A `logs` row with `log_type=claude-otel` and a `sessions` row for S appear.
  2. Upload the same chunk again -> the cost is not doubled, one chunk row (idempotency).
  3. Upload a second (different) chunk -> the cost adds up instead of being overwritten.
  4. Two concurrent requests with different chunks of one session (`Promise.all`) -> both are counted, no lost update.
  5. `claude_version_otel`: a chunk with version 2.1.280 sets it; a chunk with a lower one does not lower it; a higher one, 2.1.290, raises it.
  6. A session that has **only** OTEL data does not appear in `GET /api/v1/repositories/:id/sessions` and `/sessions/ids`, and `GET .../sessions/:sid/logs` for it -> 404.
  7. A mixed session (claude + otel) is returned and shown the same as without the otel row (list, details, export, cost): compare the JSON before and after steps 1-3 by keys, except `telemetry_cost`.
  8. A repeated upload of the `claude` log and `recompute-all-sessions` do not wipe the accumulated `telemetry_cost`.
- **Check:** the cost numbers after 1/2/3/4 (0.05 / 0.05 / 0.10 / 0.20); `claude_version_otel` is monotonic; the otel-only session is invisible; parity of the mixed session.
- **Replaces:** `logs-otel.e2e-spec.ts` (16 tests, except `0054 backfill idempotency`; see owner question G-4 in section 4).
- **What we lose:** `0054 backfill idempotency` (a one-off migration; whether it is needed after the migration squash is the owner's decision); the audit on session deletion (`delete-time audit`) moves to the deletion scenario of the Sessions group.

---

## 3. HOOK

### S-HOOK-01. A full Stop run: what exactly goes to the server, in what order, and what is not sent again
- **Layer:** hook (child processes)
- **Priority:** P0
- **Data/environment:** temp-project + a fake HOME + fake-log-hub (always 201 `{warnings:[]}`). Config `.artisyn/config/log-hub.json {serverUrl:<fake>}` and `log-hub.local.json {apiKey:"k-test-123456"}`. Session `cur` (the current one) and session `old` (backlog, not active): each has an artifact file `.artisyn/ai_work_dir/telemetry/<id>.jsonl` and a transcript `~/.claude/projects/<slug>/<id>.jsonl`; `cur` has a sub-agent `subagents/agent-a1.jsonl` with `agent-a1.meta.json {parentAgentId:"p9"}`, a deep `agent-b2.jsonl` without meta, a workflow agent `subagents/workflows/wf_abc/agent-w1.jsonl` and `journal.jsonl` in the same folder.
- **Steps:**
  1. `run-hook(send-logs-hook, {session_id:"cur", cwd:<repo>, hook_event_name:"Stop"})` -> code 0.
  2. From the fake-log-hub record: every request is `POST /api/v2/logs`, the header `X-API-Key: k-test-123456`, the query has `type` and `sessionId`; no request to `/api/v1/logs`.
  3. The list of uploaded files: `claude`/`claude-subagent` for `cur` **before** any `old` file; the `cur` artifact is the **last** request of the whole run; for sub-agent `a1` `parentSessionId=agent-p9`, for `b2` (no meta) `parentSessionId=cur`, for the workflow agent `workflowRunId=wf_abc`; `journal.jsonl` is not uploaded as a session; plain sub-agents have no `workflowRunId`.
  4. The body of the `cur` artifact: the first line is `hook-status` with `hookVersion`, `logTail`, `nonUploadableLogs:[]`, `recommendations`; the `old` artifact has no `hook-status`; the harness events (`system-context`, `skill-definitions`, `agent-definitions`, `mcp-config`) are only in the body of `cur`.
  5. A repeated `Stop` without changes: only the `cur` artifact (its size on disk does not reflect the body) + the changed `cur` transcript are uploaded; `old` and unchanged files are not uploaded (the `.claude-logs.sent` manifest, by size).
  6. Append a line to the `old` transcript and `Stop`: exactly that file is uploaded.
  7. `SessionEnd` for `cur` -> only the `cur` artifact and the `cur` transcript are uploaded (not `old`), the manifest did not change (no write caused by SessionEnd), the `.upload.lock` lock is released.
  8. Delete the `old` transcript from disk, `Stop` -> its entry is removed from the manifest (prune); entries of an unresolved namespace are kept.
  9. A `.upload.lock` lock file with a fresh `startedAt` -> `Stop` writes `skipped: upload lock held` to `hook.log`, no HTTP requests, code 0; a lock older than `2 * sendLogsOnPromptTimeoutMs` is ignored and overwritten.
  10. `SessionEnd` waits for a held lock (up to 20 s), while `Stop` waits only 2 s (a timing check: `Stop` returned in under 4 s; for `SessionEnd` the lock is released after 1.5 s -> the upload happened).
  11. `hook.log` has an `activate` line for each run and a final line with the counters `uploaded N KB … in K requests`.
- **Check:** the v2 route; the key in the header; the order; `parentSessionId`/`workflowRunId`; `journal.jsonl`; hook-status only on the current artifact; the manifest (what is skipped and what is not); SessionEnd does not write the manifest; the lock and the wait timeout; exit codes 0.
- **Replaces:** `send-logs-hook.test.js`, ~35 of 55 (parentSessionId x4, workflowRunId x2, journal, the v2 route, the order, current/backlog, manifest x4, SessionEnd x4, lock x4, hook-status, worktree, one log line per run x4), `manifest-bounded.test.js` (5), the `session-files` within them.
- **What we lose:** the `hook-status` and `broken-upload-file` recommendations in detail go to S-HOOK-04 and S-HOOK-09; the MCP probe to S-HOOK-09; the otel part of `send-logs-hook.test.js` (10) to S-HOOK-08.

### S-HOOK-02. A broken line and privacy: the hook repairs NDJSON and does not expose secrets
- **Layer:** hook (child processes)
- **Priority:** P0 (privacy, the all-or-nothing ingest)
- **Data/environment:** as in S-HOOK-01; fake-log-hub records the bodies. Secret markers: `apiKey:"KEY-SECRET-777"`, no query parameter is used in the server URL, `PROMPT-SECRET` in the prompt text, `RESPONSE-SECRET` in `tool_response`.
- **Steps:**
  1. Make an artifact `.jsonl` of 5 lines where the 3rd is cut in the middle (`{"event":"prompt_start","pro`), and a backlog session transcript with a broken last line.
  2. `Stop`. On fake-log-hub the artifact body holds the 4 valid lines **byte for byte** as on disk (plus `hook-status`), the broken line is absent; the body is exactly the same buffer (no re-encoding: check a line with `\r\n`, Unicode and empty lines).
  3. `hook.log` has, for each dropped line, the line number, the length in bytes and the reason; the fragment of the cut line is limited to 120 characters.
  4. A file where **all** lines are broken -> it is not uploaded (no request), there is a `hook.log` record, code 0.
  5. The server accepts such a body (connect the real ENV-A server instead of the fake): the session is visible (the all-or-nothing ingest does not trigger).
  6. Log privacy: neither `hook.log` nor `receiver.log` contain `KEY-SECRET-777` or the request's query string; `hook.log` does not contain `PROMPT-SECRET`.
  7. `hook-status.logTail` in the body on the server is the last ≤50 lines of `hook.log` and does not contain the key.
  8. `PostToolUse` for Edit with `tool_response` `{structuredPatch:[...], originalFile:"RESPONSE-SECRET...", filePath}`: in the `.jsonl` the `edit_result` event has exactly four fields `{filePath, added, removed, changeKind}`; the string `RESPONSE-SECRET` is not in the file. For Bash, `tool_response.stdout` is not written. (`tool_input` is written as is, deliberately, see section 4.)
  9. Rights: `log-hub.local.json` is not copied into the telemetry and does not get into the upload body (a grep for `KEY-SECRET-777` over all request bodies of fake-log-hub = 0).
- **Check:** byte identity of the healthy lines; diagnosability (a log with the line number); no key and no tool response in the logs, the telemetry and the bodies; the server accepts the repaired file.
- **Replaces:** `ndjson-sanitize.test.js` (15), the part of `edit-result-counts.test.js` about the 4 fields and no content (~4), `hook-log.test.js` (5, line format and truncation), the parts of `upload-logs.test.js` about the key leaking into `hook.log` (2). It closes F.1 #6.
- **What we lose:** `edit-result-counts`: 16 cases of line-count parity with the server formula on the shared fixture `patch-line-counts.json`; the scenario checks 3 cases (Edit, Write, MultiEdit); the other 13 are pure diff arithmetic, and the parity with the server is worth keeping as one small test on the fixture (the owner's decision G-12 about `tool-stats`).

### S-HOOK-03. A large file: chunks, gzip, resuming after a drop, the server refusing gzip, 413
- **Layer:** hook (child processes)
- **Priority:** P1
- **Data/environment:** fake-log-hub with programmable answers; a `cur` transcript of ~6 MB (Cyrillic, emoji, a 300 KB long line without `\n`). A remote (non-loopback) address for gzip: a network interface of the machine (`os.networkInterfaces()`, not `internal`); if there is none, the gzip steps are marked `skip`; the loopback address is used for "no compression".
- **Steps:**
  1. Loopback: `Stop`. The `POST /api/v2/logs` requests go **without** `Content-Encoding`; a file body >900 KB is cut into pieces on `\n`, each with `uploadId`, `chunkIndex` 0..N-1, `totalChunks`, and chunk 0 has `totalSize` = the file size in bytes; the joined bodies = the source file byte for byte (Cyrillic and emoji are not cut in the middle).
  2. Remote address: the same requests with `Content-Encoding: gzip`, `Content-Length` = the length of the compressed body, each request < 900 KB on the wire, noticeably fewer chunks; inflating the join = the source file; `totalSize` in uncompressed bytes.
  3. A file ≤ 900 KB: one request without chunk parameters; if gzip does not shrink the body, it goes plain.
  4. A drop: fake-log-hub drops the connection after the 3rd chunk; the hook's exit code is 0; `.claude-logs.pending` has the entry `{version:2, entries:{...nextChunkIndex:3, slices:[…]}}`; the `.claude-logs.sent` manifest has no entry for the file.
  5. A repeated `Stop`: continues from `chunkIndex=3` with the same `uploadId`, repeating the same slice boundaries; after `complete:true` the `pending` entry is deleted and the manifest is written.
  6. A damaged/old format of `.claude-logs.pending` (for example, the string `abc 3`): ignored, the upload starts from chunk 0.
  7. The server answers 400 `Unknown uploadId` to a resumed chunk -> the hook resets the entry, starts from `chunkIndex=0` with a new `uploadId`; the other files of the run are not interrupted.
  8. The server answers 415 to a gzip body -> the same piece is sent plain at once, and the **next** files in this process go plain without another refusal (` [gzip fallback]` in `hook.log`). A 400 answer with a foreign body (not one of the server's validation messages) is treated the same; 401/403/404/429 are not.
  9. The server answers 413 to a chunk -> the wire budget is halved (not below 128 KB), the file is re-planned from `chunkIndex=0` with a new `uploadId`, at most 2 times per call.
  10. A `gzip-stat.json` file with a `ratio` outside [1,100] or garbage -> the default 8.0 is used, the upload does not fail.
- **Check:** byte identity of the join; boundaries on `\n` and on UTF-8 characters; the chunk parameters; the resume behaviour (the same `uploadId`, `nextChunkIndex`); the three ways of degrading (415/400/413); no manifest before success.
- **Replaces:** `upload-logs.test.js` (18), `upload-gzip.test.js` (17).
- **What we lose:** the internal slice planners (`planCompressedSlices`, `alignSliceBoundary`) as functions; what matters is how they work through the observable requests; artificial corner cases such as "4 halving attempts before an identity slice" (accepted as a loss: rare).

### S-HOOK-04. The hook never blocks Claude: the server is down, hangs, answers 500; the background upload does not slow the prompt
- **Layer:** hook (child processes)
- **Priority:** P0 (a blocking hook = the developer's work stops)
- **Data/environment:** temp-project, the config points to: (a) a closed port, (b) a fake-log-hub that accepts the connection and stays silent, (c) a fake-log-hub that answers 500, (d) 401. `sendLogsTimeoutMs=1500` to speed things up. Budgets: the prompt hook <1 s, the Stop hook < `timeout × number of requests + 2 s`.
- **Steps:**
  1. Server (a) is closed: `Stop` -> code 0, `hook.log` has `fail`/`error` lines with `ECONNREFUSED`, time < 3 s; the telemetry and the manifest are not damaged, `hook-status` is not lost (it goes out on the next successful run).
  2. Server (b) is silent: `Stop` -> code 0, it finishes after about `sendLogsTimeoutMs` (±1 s), `hook.log` has `timeout after 1500ms`, `hook-recommendations.json` has exactly one recommendation `timeout-on-upload` (even with 3 files timing out); the next `Stop` on a healthy server deletes it.
  3. Server (c) answers 500 to everything: code 0, the files did not get into the manifest, a retry on the next `Stop`.
  4. Server (d) 401: code 0, a clear line in `hook.log` (without the key), the requests do not loop.
  5. A config without `serverUrl`/`apiKey`: code 0, one line `exit: serverUrl or apiKey not configured`, no HTTP.
  6. Not a git repository, an empty stdin, a stdin that is not JSON, an unknown `hook_event_name`: all hooks (`telemetry-hook`, `lifecycle-hook`, `send-logs-hook`, `guardrail-hook`, `post-turn-analysis-hook`) -> code 0 and an empty stdout (except guardrail-deny), one diagnostic line.
  7. The prompt hook: `telemetry-hook` with `sendLogsOnPromptEnabled=true` and the slow server (b) returns in < 1 s (it does not wait for the upload itself), the background `prompt-upload-hook` starts as a separate process; a second prompt within 60 s does not start a second background upload (throttle); with `sendLogsOnPromptEnabled=false` the background process does not start.
  8. The background `prompt-upload-hook` hangs on server (b) -> it is force-terminated at about `sendLogsOnPromptTimeoutMs` with code 1 (the only allowed non-zero code); the network is unreachable -> code 0 + `error` in the log; a fresh lock -> skip without HTTP; a lock older than `2×timeout` is taken over.
  9. The background upload sends only the two files of the current session and does **not** write `.claude-logs.sent`.
  10. A session spawned by the hook itself (`ARTISYN_HOOK_SERVICE=guardrail`) -> `post-turn-analysis-hook` exits at once and does not wait for the worker; the `claude -p` wrapper with a fake `claude`: a failure, a hang, garbage on stdout, a missing binary do not bring down the calling hook.
  11. Two `Stop` runs at once on one project: one uploads, the second exits on the lock; both code 0, no double upload of one file (per the fake-log-hub record).
- **Check:** all exit codes 0 (except the watchdog = 1), the timings, the `timeout-on-upload` recommendations (created/deduplicated/cleared), no HTTP on skips, the 60 s throttle, no manifest write by the background process.
- **Replaces:** `telemetry-hook.test.js` (4 of its 6 tests on prompt-upload), `prompt-upload-hook.test.js` (11), `recommendations.test.js` (9), `claude-invoke-async.test.js` (7), `send-logs-hook.test.js`: timeout, locks, early exits (~10), `post-turn-analysis-hook.test.js` (6, the "does not wait for the worker" part). It closes F.1 #15.
- **What we lose:** the exact budget sizes in `post-turn-analysis`; `hook-service-telemetry` is covered in S-HOOK-06; the parameterization of NaN values of `SEND_LOGS_TIMEOUT_MS` (we check one case).
- **OS:** the `[win]` step with `killProcessTree` (after a timeout there are no hanging `cmd.exe`/`node` processes by `CommandLine`) is Windows only.

### S-HOOK-05. Guardrail: reading outside the project is forbidden, inside is allowed, switches, fail-open

> **Dropped: the guardrail was removed in 2.19.0.** The scenario is not implemented and is not part of the P0 set (the impl-plan of task `2026-10-14-qaa-test-suite-cleanup`, DD SC2); the text below is kept for history.

- **Layer:** hook (child processes)
- **Priority:** P0 (developer safety)
- **Data/environment:** temp-project `P`, an external directory `O` with the file `secret.txt`, a linked worktree `W` of the project, `fake-claude` (for the LLM level).
- **Steps:**
  1. With no config at all: `run-hook(guardrail-hook, {tool_name:"Read", tool_input:{file_path:<O>/secret.txt}, cwd:P})` -> exit 0, stdout JSON `hookSpecificOutput.permissionDecision:"deny"` with a `permissionDecisionReason` that holds the reason. The session telemetry file has a `guardrail_block` event with the code `outside_project`.
  2. Reading `<P>/src/a.js` -> exit 0, an empty stdout (allowed).
  3. `Write`, `Edit` outside the project -> deny; `Glob` with a `path` outside the project -> deny.
  4. From the subfolder `P/src` (cwd is the subfolder) and from worktree `W`: the boundaries are computed from the root of the main repository (access to `<P>/x` is allowed, to `<O>` it is not).
  5. `guardrailProhibitedFiles:["config/prod.env"]`: reading `<P>/config/prod.env` -> deny `prohibited_file`, from worktree `W` too (the path is relative to the main repository).
  6. `guardrailEnabled:false` -> reading `<O>/secret.txt` is allowed (stdout empty), no `guardrail_block` event. `guardrailBlockOutsideProject:false` (with `guardrailEnabled` true) -> outside the project is allowed, but a prohibited file is still blocked.
  7. A non-numeric/negative `guardrailLlmTimeoutMs` -> one `[warn]` and the default 10000.
  8. Paths of different forms (on Windows `[win]`): `C:\…`, `/mnt/c/…`, `/c/…` for one file inside/outside the project give the same decision.
  9. The LLM level is off (`guardrailLlmEnabled:false`): `Bash` with `cat <O>/secret.txt` -> allowed (not checked), code 0.
  10. The LLM level is on with a `fake-claude` that answers `{"paths":[<O>/secret.txt]}` (pass 1) and then a deny verdict -> deny with the code `llm_outside_project`; `fake-claude` hangs longer than `guardrailLlmTimeoutMs` -> the command is **allowed** (fail-open), exit 0; `fake-claude` prints garbage -> allowed.
  11. A broken `log-hub.json` (invalid JSON) -> the defaults stay (blocking outside the project works) + a `[warn]` line in `hook.log`.
- **Check:** the exact deny JSON; an empty stdout when allowed; the reason codes in the telemetry; the repository root (subfolder and worktree); the behaviour with every switch; fail-open on the LLM.
- **Replaces:** `guardrail-hook.test.js` (6), the manual script `hook/test-guardrail-access.js`. It closes F.1 #14.
- **What we lose:** the Bash command parser through the LLM is tested only through `fake-claude` with canned answers (the quality of a real LLM is not checked); `guardrailBlockNetwork` (one more deny branch `llm_network_access`; add it as step 10b if it matters).

### S-HOOK-06. Two-level config, a subfolder and a worktree: where telemetry is written, what the server sees
- **Layer:** hook (child processes)
- **Priority:** P1
- **Data/environment:** temp-project with a commit, branch `feature/x`, `git config user.name "Jane Dev"`, `remote origin git@git.example.com:org/shop.git`; a linked worktree `W` on branch `wt-branch`; fake-log-hub.
- **Steps:**
  1. Base `log-hub.json {serverUrl:A, context:[{key:"Project",value:"shop"},{key:"project",value:"shop2"}], telemetryDir:""}`; `log-hub.local.json {apiKey:"k1"}`. `telemetry-hook` with `UserPromptSubmit` and the prompt `fix login`: the file `.artisyn/ai_work_dir/telemetry/<sid>.jsonl` holds `prompt_start` with `prompt`, `git:{repo,branch:"feature/x",user:"Jane Dev"}`, `context:{project:"shop2"}` (the keys in lower case, the last one wins), `session_id`.
  2. Local overrides base per key, entirely: `local {serverUrl:B}` -> the upload goes to B; the `context` array in local replaces the base one entirely (they are not merged); `null` in local = "no value" -> it is taken from base.
  3. Broken JSON in `log-hub.local.json` -> defaults for its keys + one `[warn]` in `hook.log`, work continues on the base values; a wrong type of one key (`sendLogsTimeoutMs:"abc"`) -> the default 10000 only for it and a `[warn]` with the file and key name.
  4. A relative `telemetryDir:"custom/tele"`: the files appear in `<repo>/custom/tele`; an absolute path too.
  5. A run from the subfolder `P/src/deep`: the config, the telemetry and `hook.log` are still at the repository root (`P/.artisyn/...`), not in the subfolder.
  6. A run from worktree `W`: the config, the telemetry and `hook.log` stay at the main repository; `git.branch` in the event is `wt-branch`; in the `SessionStart` event `git.root` (the main root) and `git.worktreeRoot` (the root of W) differ.
  7. The `lifecycle-hook` events in sequence: `SessionStart`, `PostToolUse` (Edit with `tool_response` -> `edit_result{added:2,removed:1,changeKind:"edit"}`), `PermissionRequest`, `SubagentStart/Stop`, `PreCompact/PostCompact`, `StopFailure`, `SessionEnd` -> one `type:"artisyn"` line each with the right `hook_event_name`, in order; no `tool_result` field (retired).
  8. `ARTISYN_HOOK_SERVICE=hook-test` in the environment: `telemetry-hook` and `lifecycle-hook` -> code 0, **no** `.jsonl` file is created (the hook's own session writes no log and is not uploaded); an empty string/spaces in the variable = "no marker" (telemetry is written).
  9. Parallel writes: 6 `telemetry-hook` processes with 50 records each into one `<sid>.jsonl` -> exactly 300 valid JSON lines, none cut; no `.lock` file is left.
  10. A code base snapshot: `Stop` with a history of ≥1 commit -> the artifact body has a `code-inventory` event with `trackedFiles`, `trackedLines`, binary files without lines, gitignored files not counted; a second `Stop` within 6 hours does not add the event; a repository without commits -> no event at all (not zeros).
- **Check:** the config layers and their priorities; the warnings in `hook.log`; the repository root for a subfolder and a worktree; the exact event fields; no writes by the hook's own session; file integrity under a race; the correct inventory denominator.
- **Replaces:** `env-context.test.js` (36), `git-context.test.js` (11), `hook-service-telemetry.test.js` (5), `write-telemetry-lock.test.js` (3), the non-OTEL part of `lifecycle-hook.test.js` (~3), `code-inventory.test.js` (10), the rest of `edit-result-counts.test.js` (~4).
- **What we lose:** the detailed table of defaults/coercion for 30 config keys (3 typical errors are checked); 6x150 parallel writes are reduced to 6x50 (faster, same meaning).
- **OS:** on WSL/DrvFs and network drives file locking behaves differently and is not checked (a manual run is needed).

### S-HOOK-07. The OTEL receiver as a local attack surface: a browser, a foreign project, `../evil`, a huge body
- **Layer:** hook (child processes)
- **Priority:** P0 (irreversible: the records would go out under the user's real API key)
- **Data/environment:** the real `otel-receiver.js` as a child process: `--dir <tmp>/otel --owner '{"gitRoot":"<P>","repo":"git@x:o/a.git"}' --port <free> --maxBodyBytes 20000 --idleTimeoutMs 3000`. A Node HTTP client.
- **Steps:**
  1. A start without `--dir` or without `--owner` -> the process exits with code 1 and a message, the port is not listened on. A start on a busy port -> code 0 (the normal path of a second session), the first receiver keeps working.
  2. A correct `POST /v1/logs` with `Content-Type: application/json`, an OTLP body with two records for `session.id` `s1` and `s2` -> 200; `<dir>/s1/…jsonl` and `<dir>/s2/…jsonl` each get one line: `signal:"logs"`, `receivedAt`, `record.timeUnixNano` kept as in the request (not replaced with the receive time). Metrics `POST /v1/metrics` -> a file with `signal:"metrics"`.
  3. Browser requests: any request with `Origin: https://evil.example` -> 403; with `Referer: https://evil.example/` -> 403; `Content-Type: text/plain` -> 415 (a CORS simple request); in none of these cases is anything written (the directory has no new files).
  4. A preflight `OPTIONS /v1/logs` -> not 2xx, no `Access-Control-Allow-*` headers.
  5. Dangerous `session.id` values in the records: `../evil`, `/etc/passwd`, `C:\\win`, `a/b`, `%2e%2e%2fevil`, a 129-character string, an empty one -> the records are dropped, nothing is created outside `<dir>` (check that `<tmp>/evil*` is absent), `receiver.log` has a summary line; the request as a whole gives 200 (valid records in the same request are kept).
  6. `POST /artisyn/register` with `{sessionId:"s1", gitRoot:"<P>", repo:…}` -> 200 `{ok:true,receiverVersion,port}`; with `gitRoot:"<another>"` -> **409** `{ok:false,error:"owner-mismatch",ownerRepo}` and nothing is written; without `gitRoot` -> 400; `sessionId:"../x"` -> 400.
  7. `POST /artisyn/shutdown`: the owner -> the receiver exits; a foreign `gitRoot` -> 409 and it stays alive; GET -> 405.
  8. A body larger than `--maxBodyBytes` (on the wire, before inflating) -> 413 and nothing is written; a gzip body that inflates to an allowed size -> 200; `Content-Encoding: br` -> 415; a broken gzip -> 400; invalid JSON -> 400, nothing is written.
  9. An unknown path -> 404; `GET /v1/logs` -> 405.
  10. Loopback-only binding: a request to `<the machine's non-loopback IP>:<port>` is rejected (connection refused); it listens on `127.0.0.1`.
  11. The idle timer: 3 s without requests -> the process exited with code 0; a request, even a rejected one (403), extends the timer.
  12. 20 concurrent requests for one session -> 20 files (one file per request, atomic `.tmp`->rename), no `.tmp` left after completion.
- **Check:** the codes 403/415/409/413/400/404/405; no writes on a refusal; `timeUnixNano` kept; no writes outside the directory; the loopback binding; the idle exit.
- **Replaces:** `otel-receiver.test.js` (45; the reviewer counted about 31 duplicates, one representative per class stays) and `otel-register.test.js` (21, the client side, partly in S-COMPAT-02). It closes "no test that a browser cannot write"; only the loopback binding and the 20 concurrent requests were not covered before.
- **What we lose:** the full list of dangerous `session.id` variants (6 of the 6 variants the reviewer proposed to squeeze to 3); parsing `parseArgs` one by one (`--idleTimeoutMs` as env/argv and so on): we keep one of the channels (argv) and one env; the rest is a loss without consequences.

### S-HOOK-08. OTEL end to end: SessionStart, receiving, uploading and deleting chunks, disabling, restart
- **Layer:** hook (child processes)
- **Priority:** P1
- **Data/environment:** temp-project with `otelReceiverPort=<P>`, `.claude/settings.json` with `env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:<P>/v1/logs`, fake-log-hub, a fake HOME.
- **Steps:**
  1. `lifecycle-hook` with `SessionStart` -> within 2 s port `<P>` is listening; the receiver process is a separate one (the hook's parent already exited with code 0); `receiver.log` has `start`.
  2. A second `SessionStart` of another session: the new process gets EADDRINUSE and exits 0 (`addr-in-use` in `receiver.log`), there is one receiver.
  3. An OTLP request from "Claude" with two sessions -> files `otel/<sid>/<epoch>-<seq>.jsonl`.
  4. `Stop`: fake-log-hub receives `POST /api/v2/logs?type=claude-otel&sessionId=<sid>` for each chunk **without** context prepends; after success the local chunks are **deleted** and the manifest has no entries for them; a chunk written between the stat and the upload is uploaded by the next `Stop`; zero-size files and `.tmp` files from a killed receiver are not uploaded and are cleaned up by `otelRetentionDays` (backdate mtime by 8 days).
  5. A file already uploaded by an old hook and still on disk is deleted without an upload when the size in the manifest matches.
  6. The hook on a 409: start a receiver with another owner on `<P>`, `SessionStart` -> `hook.log` has exactly one `warn` with the port, the owner's repository name and a hint about `--otel-port`; code 0; nothing is retried or taken over.
  7. An endpoint mismatch: `.claude/settings.json` points to `<P+1>`, the receiver is on `<P>` -> `SessionStart` prints JSON with a `systemMessage` to stdout (the user sees a warning in Claude) and a `warn` to `hook.log`; when they match, stdout is empty. No endpoint at all -> a "missing" warning.
  8. `otelEnabled:false`: `SessionStart` creates no processes and makes no network calls, `Stop` does not upload or clean up the otel directory, no throttle file is created.
  9. Re-arm: kill the receiver, `UserPromptSubmit` -> it is started again; a second prompt within 60 s does not try again; `Stop` also tries to re-arm.
  10. Restart (the installer side, `stopReceiverAndWait`): send `POST /artisyn/shutdown` as the owner -> a stop with waiting; a receiver that ignores shutdown is killed after the grace period; a foreign owner (409) is not killed.
  11. A `2.3.0+` hook against an "old" receiver without `/artisyn/register` (a fake that answers 404 on this path): register is silently ignored, not a single line in `hook.log`; a receiver with an older `receiverVersion` -> one `warn`, no restart.
- **Check:** the receiver life cycle, the "register then spawn" order, the chunk deletion and cleanup, disabling, the messages to the user, the throttle, stopping without killing someone else's receiver.
- **Replaces:** the OTEL part of `lifecycle-hook.test.js` (5), `otel-endpoint-check.test.js` (9), `otel-restart.test.js` (7; currently **not included** in the hook's `npm test`, a duplicate in the installer), the rest of `otel-register.test.js` (~8), the re-arm of `telemetry-hook.test.js` (3), the otel part of `send-logs-hook.test.js` (~10).
- **What we lose:** the detailed table of `resolveOtelPort` values (the priority endpoint → config → fallback 25317): we check 2 of the 3 branches; the installer version of `otel-restart.ts` itself is in S-INST-05.
- **OS:** the processes start detached; on Windows `[win]` there is no console window, and `spawn-hidden` creates no `artisyn-hidden-launch-*` in `%TEMP%` (a directory check before/after).

### S-HOOK-09. The main end-to-end scenario: an installed hook, a real server, the session is visible in the UI
- **Layer:** UI+API
- **Priority:** P0 (the only scenario that checks the whole chain from the developer to the browser)
- **Data/environment:** ENV-A. Through S-INST-01 the **built** plugin is installed into temp-project (git remote `git@git.example.com:e2e/<run>/chain.git`, branch `feature/chain`, git user "Jane Dev"); `serverUrl` is the real server, the key is created through the API; a fake `claude` for activation; the project has a `CLAUDE.md`, a skill `.claude/skills/hello/SKILL.md`, an agent `.claude/agents/rev.md`, and a `.mcp.json` with a stdio server `fake-mcp.js` (it answers `initialize`/`tools/list`).
- **Steps:**
  1. Run the hooks of the installed plugin (`${CLAUDE_PLUGIN_ROOT}/scripts/*.js` from `.artisyn/marketplace/plugins/log-hub-hooks/hooks/hooks.json`, exactly as written there: `command:"node"`, `args`) in the sequence of a real session: `SessionStart` -> `UserPromptSubmit` ("fix the login bug") -> `PreToolUse` Read inside the project (allowed) -> `PostToolUse` Edit -> `Stop`.
  2. The transcript `~/.claude/projects/<slug>/<sid>.jsonl` (seeded from a prepared real session: 2 user messages, 2 assistant replies with `usage`, one tool_use/Edit) and a sub-agent `agent-a1.jsonl` with `parentAgentId`.
  3. After `Stop` (we wait ≤10 s) `GET /api/v1/repositories` holds the `chain` repository; `GET .../sessions` the session with the key owner's `userEmail` and branch `feature/chain`.
  4. Browser: `#/repos/:id` -> the session is in the list; open it -> the Summary tab shows the tokens and the cost (checked against `GET .../sessions/:sid/logs`), Logs shows the prompt "fix the login bug", the tree has the sub-agent as a descendant; the Harness usage tab shows the skill `hello`, the agent `rev`, the MCP server `fake-mcp` and its tool exactly once.
  5. A second `Stop` without changes: no duplicates in Harness (harness events are sent once per session), the server's upload counter for the `claude` transcript did not grow.
  6. The "Installed Hooks" page (`#/repos/:id/hook-state`, the left menu): the hook version = the version from the plugin's `version.json`, no issues badge (the version is not below the baseline).
  7. Downgrade the hook: rewrite `scripts/version.json` to `0.0.1` and `Stop` -> the page shows "Hook outdated", version `0.0.1`, issue count 1 (+1 for a recommendation, if there is one), the recommendations and the log tail (`logTail`), the `[error]/[fail]/[warn]` lines are highlighted; the "Copy upgrade cmd" button gives a command like `npx <origin>/static/artisyn-hooks-installer.tgz upgrade` with `?v=<latest>`.
  8. Baseline: download `GET /static/artisyn-hooks-installer.tgz?v=9.9.9`, then `?v=1.0.0` -> the baseline stays 9.9.9 (the maximum wins); `?v=<script>` and `?v=abc` do not break the download (200, the same tgz), the baseline does not change.
  9. An upload without `hook-status` (an old hook or a manual `curl` of an artifact without the event) does not erase the previously known hook state; a `hook-status` with a broken `timestamp` does not give `Invalid Date`.
  10. User B (an outsider) does not see the repository or its `hook-state` (403/empty).
  11. The `broken-upload-file` recommendation: mix a broken file into the upload (v2) and run two `Stop`s: in the second run `hook-recommendations.json` has `broken-upload-file`, and it appears in the UI; after the queue is cleaned (S-INGEST-05) and one more `Stop`, it disappears (closes "no e2e for clearing recommendations").
  12. `GET /api/v1/model-pricing` without a session -> 200 and a non-empty table (the hook needs it before the first upload).
- **Check:** the end-to-end values: repository, user, branch, tokens, the sub-agent tree, harness without duplicates, the hook status; version consistency; the baseline by maximum; the built (not the source) plugin works; pricing is public.
- **Replaces:** `hook-state.e2e-spec.ts` (11), `E2E/hook-state.spec.ts` (2), `logs-hook-status.e2e-spec.ts` (5), `hook-state.service.spec.ts` (2), `send-logs-hook.test.js` harness/MCP-probe/context-prepends (~15), `skill-catalog.test.js` (12, through the result in the UI), `no-visible-window.test.js` and `spawn-hidden.test.js` (7, as a static check of the sources for `windowsHide:true` and the absence of `.vbs`/`wscript`; 1 grep step stays), the `?v=` part of `installer.e2e-spec.ts` (4), `model-pricing.e2e-spec.ts` (1, public access), part of `HookStatePage.test.tsx`. It closes "sanitize reaches the server" (S-HOOK-02 step 5) and "recommendations disappear in the UI".
- **What we lose:** the skills priority project > user > plugin and the exclusion of disabled plugins (`skill-catalog` 12): we keep only the fact "the project skill is visible"; the detailed MCP probe with a `.cmd` shim on Windows and several servers (4 tests) is a `[win]` step outside this scenario (a manual run or a separate Windows job).

---

## 4. COMPAT (hook backward compatibility)

> The rule from CLAUDE.md: some users do not update the hook for a long time, so the hook API must not break. Right now no test checks this directly: the repository has no old hooks. These two scenarios introduce **frozen clients**: small scripts `legacy-hook-<version>.js` (~40-80 lines that reproduce the wire behaviour of the old version: URL, query, headers, behaviour on a response) and **recorded reference requests** (HAR-like JSON captured from the real hook of the matching version). They live in `tests/fixtures/legacy-hooks/` and are never updated.

### S-COMPAT-01. Old hooks (before 1.7.0 and 1.7-2.7) against the new server
- **Layer:** API
- **Priority:** P0
- **Data/environment:** ENV-A. Frozen clients: `legacy-1.6.0` (only `POST /api/v1/logs`, in one request, `Content-Type: application/x-ndjson`, does not read the body on 201, writes a 400 answer to its log); `legacy-1.8.0` (v2, chunks of 10 MB slices without gzip, a flat `.claude-logs.pending` record in the positional format, `Content-Length` strictly in bytes); `legacy-2.7.0` (v2 + 900 KB chunks without gzip, without `workflowRunId`/`parentSessionId` in the old versions).
- **Steps:**
  1. `legacy-1.6.0` uploads `artisyn` and `claude` with `parentSessionId`/`workflowRunId` as query parameters: both 201 with an **empty** body; the sessions, the repository, the branch are in the DB; no `upload_queue` rows.
  2. `legacy-1.6.0` sends a body with a broken line: a **synchronous 400** `Malformed NDJSON` (the v1 contract is frozen; hook 1.6 treats such an upload as failed, as before), nothing in the DB.
  3. `legacy-1.6.0` sends `artisyn` with `git.user` and without the fields added later (`hook-status`, `git.root`, `git.worktreeRoot`, `code-inventory`, harness events): the ingest goes through; there is no `hook-state` for the repository (404 "No hook state reported yet"), `GET .../sessions` has the row, without `worktreeRoot`.
  4. `legacy-1.8.0`: chunks `uploadId/chunkIndex/totalChunks/totalSize` -> `{complete:false}` ... `{complete:true, warnings:[]}`; the hook reads only `complete`; extra response fields (`warnings`) do not break the client (the client parses JSON and ignores unknown keys).
  5. `legacy-1.8.0` resends a chunk after a "process" restart (the positional `.pending` -> the same resume logic) -> accepted idempotently.
  6. `legacy-2.7.0` uploads `claude-subagent` with `parentSessionId` and `workflowRunId`: the links in the session tree; for an old `agent-*` without meta the parent is the root session.
  7. An old hook does not send `perToolDetailSupported` in `mcp-config`: the server does not erase the previously known MCP tools (the `hook-api-versioning.md` contract); a new hook sends it, and the tools appear.
  8. A hook version in `hook-status` below the baseline -> "outdated" in the UI, without changing the ingest itself.
  9. Each upload is checked against a reference snapshot of the responses (status, Content-Type header, body shape): the response shapes of v1 (`201`, empty) and v2 (`{warnings:[]}` / `{complete}`) must match the snapshot byte for byte.
- **Check:** v1 is frozen (201 empty, a synchronous 400); v2 accepts the old chunk shape; unknown/missing fields of an old hook do not break the ingest; `warnings` do not break a client that does not read them; the response shape snapshots.
- **Replaces:** "v1 unmodified" of `upload-queue.e2e-spec.ts` (1), the empty-response checks of `logs.e2e-spec.ts` (2), the "compatibility with an old hook" part of `artisyn-extractor.spec.ts` (~3). This is **new** coverage: before, compatibility was guaranteed by nothing but the KB table.
- **What we lose:** nothing existing; the risk is that the frozen clients must be built once from the hook's git history (tags `1.6.0`, `1.8.0`, `2.7.0`) and checked against the KB.

### S-COMPAT-02. The new hook against "non-native" servers and the old OTEL receiver
- **Layer:** hook (child processes)
- **Priority:** P1
- **Data/environment:** fake-log-hub in these modes: (a) an "old server" without the `/api/v2/logs` route (404 with HTML), (b) a reverse proxy: 413 HTML `nginx/1.24` on a request >1 MB, (c) a server answering 201 without a body, (d) 201 with invalid JSON, (e) 201 `{warnings:"not an array"}`, (f) 200 instead of 201; a fake "old" OTEL receiver (without `/artisyn/register`, answering 404 / answering 200 `{ok:true}` without `receiverVersion`).
- **Steps:**
  1. Mode (a): `Stop` -> code 0, a clear line `fail … 404` in `hook.log`, the manifest is not updated, a retry on the next `Stop`. **We record the fact:** hook 2.x does not fall back to `/api/v1/logs`, that is, the new hook against a server without v2 uploads nothing (owner question G-3).
  2. Mode (b): 900 KB chunks go through (under the 1 MB nginx limit); tighten it artificially to 500 KB -> 413 HTML -> the budget is halved and the file finishes uploading; in `hook.log` the nginx answer is distinguishable by `nginx/` from the application's JSON 413.
  3. Modes (c), (d), (e), (f): the hook treats them as "no warnings", does not fail, the file counts as uploaded (201) or not (200, per the current code; pin it).
  4. An old receiver (404 on register): silence; a receiver without `receiverVersion`: silence; older than its own version: one `warn` and no restart.
  5. A hook `>= 2.0` started with the old form of the command line: the receiver is started with `ARTISYN_OTEL_*` only through env (as the VBS launch did before 2.6.0) -> the receiver reads the parameters from env (argv first, env as a fallback) and starts.
  6. A receiver with an unknown flag `--future-flag x` -> ignored, it does not fail (a new hook starts an old receiver).
- **Check:** the hook does not fail on any "non-native" answer; no fallbacks (recorded as the behaviour); the compatibility of starting the receiver by env/argv.
- **Replaces:** `otel-register.test.js` (~6, the table of register responses), the 413/415 part of `upload-gzip.test.js` (counted in S-HOOK-03).
- **What we lose:** nothing significant. The main result is an explicit owner decision on step 1.

---

## 5. INSTALLER

> Shared environment: `fake-claude` in PATH, fake-log-hub for `upgrade` (the `GET/POST /api/v1/log-echo` check), `node artisyn-hooks-installer/dist/index.js` (in scenario S-REL-01 the same thing runs from the downloaded `.tgz` through `npm exec`). The installer tests are currently **not included** in `repo-health-checks.json` (question G-6): the scenarios must be hooked into the runner, or they will not run. There are almost no POSIX runs today (one `t.skip`): the `0o600` step in S-INST-02 is checked only when run on POSIX.

### S-INST-01. A clean install into a project with user settings, and the installed hook working
- **Layer:** installer (CLI)
- **Priority:** P0
- **Data/environment:** temp-project (`git init`, one commit), `.claude/settings.json` with user content: `{"permissions":{"allow":["Bash(git status)"]},"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"my-own-guard.sh"}]}]},"customKey":{"a":[1,2]}}`; `fake-claude`; a fake-log-hub that answers `log-echo`.
- **Steps:**
  1. In an empty directory without `.git`: `install` -> exit 1 `.git directory not found`. A wrong subcommand -> exit 1 + usage. Without the hooks archive -> exit 1.
  2. A directory with `.git` but without `.claude/`, non-TTY, the answer "n"/EOF: exit 1 `Aborted`; with the default answer, `.claude/` is created.
  3. `install --server-url http://127.0.0.1:<port>/ --api-key k-test-123456` (the trailing slash is stripped).
  4. What appeared: `.artisyn/marketplace/plugins/log-hub-hooks/` with `hooks/hooks.json`, `scripts/*.js` (all from the list, each exactly once), `scripts/version.json` and `.claude-plugin/plugin.json` with the same version; `.artisyn/config/log-hub.json` with the template's `serverUrl: ""`, **without** `apiKey` and **without** `otelReceiverPort`; `.artisyn/config/log-hub.local.json` with `apiKey`, `serverUrl` without the slash and `otelReceiverPort` in [25000, 65535] (installer `1.0.75`+); `.artisyn/config/.gitignore`; `.artisyn/config/otel-port.json`.
  5. Every `guardrail*` key in `log-hub.json` equals `false` (the installer turns them off by default); on a reinstall with an already existing `guardrail*` key the values do not change and no others are added. A legacy `otelReceiverPort` seeded into `log-hub.json` is removed by the reinstall; the port stays in `log-hub.local.json`.
  6. `.claude/settings.json` (before/after): the user's `permissions`, `hooks.PreToolUse[0]` and `customKey` are the same **byte for byte**; added are `enabledPlugins["log-hub-hooks@artisyn"]=true`, `extraKnownMarketplaces.artisyn.source.path="./.artisyn/marketplace"` and exactly 9 OTEL `env` keys (values: `CLAUDE_CODE_ENABLE_TELEMETRY:"1"`, `OTEL_EXPORTER_OTLP_PROTOCOL:"http/json"`, `…_LOGS_ENDPOINT:"http://127.0.0.1:<port>/v1/logs"`, `OTEL_METRIC_EXPORT_INTERVAL:"10000"` and so on); `.claude/settings.json.bak` is created with the previous content.
  7. `fake-claude` is called exactly twice and in order: `plugin marketplace add <abs>/.artisyn/marketplace`, then `plugin install log-hub-hooks@artisyn --scope project`. Without `claude` in PATH, install still exits 0 and prints the two manual commands.
  8. The receiver smoke test ran (a success line in stdout); when `otel-receiver.js` is replaced with a broken one, a warn with a command to reproduce, exit 0, the port is not recomputed.
  9. In stdout: "effective telemetry destination" with the URL; "fully configured and ready to use" with both flags, and with `--server-url` without a key, a hint about `log-hub.local.json` and that file holding `serverUrl` + `otelReceiverPort` (no `apiKey`); with no flags, "Next step: add your API key". The installer asks for no extra input when both flags are given.
  10. **Activation:** take the `Stop` command of `hooks.json` from the installed plugin (`node ${CLAUDE_PLUGIN_ROOT}/scripts/send-logs-hook.js`), substitute the plugin root, run it with stdin `{"session_id":"s1","cwd":<repo>,"hook_event_name":"Stop"}` -> fake-log-hub receives a request with the key `k-test-123456` from `log-hub.local.json` at the address from `log-hub.local.json`; code 0.
  11. The event order in `hooks.json` matches `hook/INSTALL_HOOK.md` (no documentation drift).
- **Check:** the exact set of artifacts and values; **nothing of the user's is overwritten**; two `claude` calls in the right order; the installed hook really works with this configuration.
- **Replaces:** the `happy path`, `guardrail defaults`, `settings.json merge`, early `exits 1` (4) blocks of `install.test.ts`, part of `CLI flags` (summary messages, 8), `runClaudePluginActivation` (5), a piece of `.claude/settings.json invalid JSON` (see S-INST-03). The part of `build-hooks-installer.test.js` about `hooks.json` drift versus `INSTALL_HOOK.md` (3). It closes F.1 #13 (other people's hooks untouched) for installation.
- **What we lose:** flag variations (`--server-url` without a value / empty: 4 exit 1 tests; we keep one check of `--api-key` without a value); the `.bak` content is checked once.

### S-INST-02. Secrets: the key only in the local config, 0o600, a tracked file blocks, a server change warns
- **Layer:** installer (CLI)
- **Priority:** P0
- **Data/environment:** temp-project, as in S-INST-01; on POSIX.
- **Steps:**
  1. `install --server-url http://a:3000 --api-key SECRET-KEY-1`. The output has a warning "the key is visible in the shell history".
  2. `grep SECRET-KEY-1` over the whole project tree (except `log-hub.local.json`): 0 matches; in particular, not in `log-hub.json`, `.claude/settings.json`, `.claude/settings.json.bak`, `otel-port.json`, stdout.
  3. POSIX: `fs.statSync('.artisyn/config/log-hub.local.json').mode & 0o777 === 0o600` (closes F.1 #5). Windows: the check is skipped (`chmod` is not called), but the file is in `.gitignore`.
  4. `git status --porcelain`: `log-hub.local.json` and `otel-port.json` are **not** in the list of new files (ignored), `log-hub.json` is in the list.
  5. If the root `.gitignore` already ignores `log-hub.local.json`, `.artisyn/config/.gitignore` has no duplicate entry; if `.artisyn/config/.gitignore` already exists, the entry is appended without a duplicate.
  6. `git add -f .artisyn/config/log-hub.local.json && git commit`, then `install` once more -> **abort** with the hint `git rm --cached .artisyn/config/log-hub.local.json`, the files are not changed (hashes before/after).
  7. A reinstall with `--server-url http://b:3000` (without `--api-key`): stdout has `telemetry destination: http://a:3000 -> http://b:3000`, on non-TTY the installation continues; the key is kept (SECRET-KEY-1), `serverUrl` = b in `log-hub.local.json` (the tracked `log-hub.json` keeps `""`). A repeat with the same address (+ a slash) gives no warning.
  8. A reinstall where `--api-key SECRET-KEY-2` replaces the previous key; a missing flag keeps the previous value; foreign keys in both JSON files (`{"myKey":1}`) survive the reinstall.
  9. The write is atomic: a parallel reader (polling the file in a loop during the installation) never sees truncated/invalid JSON.
  10. An `apiKey` entry written into `log-hub.json` by hand (a user mistake): `install` neither moves nor erases it, but the hook will prefer `local` (S-HOOK-06 step 2); here we check that the installer does not print the key.
- **Check:** the key in only one file; the permissions; the git status; blocking when tracked; the server change warning; atomic writes; no leak to stdout.
- **Replaces:** the secrets and `config gitignore protection` (4) blocks of `install.test.ts`, the reinstall part of `CLI flags` (4: A then B, C wins, trailing slash, warning), `atomic config write under concurrent read` (1), the shell-history warning (1), `--server-url` repoints (2). It closes F.1 #5.
- **What we lose:** the `install.test.ts` checks of hint texts across flag combinations: one per branch is kept.
- **OS:** on Windows step 3 is skipped (the ACL policy is not checked); step 9 may be unstable on network drives; on Linux it is fine.

### S-INST-03. Reinstall, upgrade and migration from the old format are idempotent
- **Layer:** installer (CLI)
- **Priority:** P1
- **Data/environment:** (a) the project after S-INST-01; (b) an "old" project: `.claude/telemetry_tool/.env` (`SERVER_URL`, `API_KEY`, `CTX_PROJECT=shop`, `CTX_LAB=a`), `.env.local`, `.claude/telemetry_tool/version.json`, `.claude/settings.json` with the installer's hook entries **and** a user entry in the same `matcher` group; `<repo>/.ai_work_dir/telemetry/x.jsonl`; `.claude/settings.local.json` with an installer hook; fake-log-hub (200 on `log-echo`).
- **Steps:**
  1. (a) `install` a second time with the same flags: all files match the first installation byte for byte, except `settings.json.bak` (expected); the port is the same.
  2. (a) `upgrade` (no flags): prints `Previous version:` / `New version:`, `serverUrl` and `apiKey` are kept, the plugin tree is overwritten, `fake-claude` is called twice; `upgrade` with `--server-url` or `--api-key` -> exit 1 without file changes; `upgrade` with `--otel-port` -> exit 1.
  3. (a) `upgrade` with the server **unreachable** (fake-log-hub stopped) -> exit 1, the files are not changed (hashes); a 401 answer on `log-echo` -> exit 1 with a clear text.
  4. Before installation/without `install`: `upgrade` -> exit 1 "not installed, run install"; outside git, exit 1.
  5. (b) `install` over the old one: `.env`/`.env.local` -> `log-hub.json` / `log-hub.local.json` (the values), `CTX_*` are collected into `context:[{key:"project",value:"shop"},…]`; in `settings.json` **only** the installer's entries are removed, the user entry in the same group is intact byte for byte; `.claude/telemetry_tool/` is removed; `.ai_work_dir` is moved into `.artisyn/ai_work_dir/` with its content and `.gitignore` kept; if the new location already has a file, it is not overwritten.
  6. (b) The hook entries in `.claude/settings.local.json` and in the user's `~/.claude/settings.json` (in the fake HOME) are **not changed**, and a warning is printed: "found in … — remove them or events will be recorded twice".
  7. (b) A repeated `install`: nothing changes (migration idempotency).
  8. (b) `upgrade` instead of `install` on an old project performs the same migration and does not fail on a missing `version.json`; if the old `.env` has no `serverUrl`/`apiKey` -> exit 1 without changes.
  9. A malformed `.claude/settings.json` (invalid JSON): `install`/`upgrade` -> exit 1 `Error: .claude/settings.json is not valid JSON — fix it and re-run`, the file is the same byte for byte, no `.bak` is created; on a normal changing run the `.bak` equals the content before the write.
  10. Conflicts: a different `extraKnownMarketplaces.artisyn.source.path` -> rewritten with a warning; a user registration of the `artisyn` marketplace in `~/.claude/settings.json` -> a collision message, left untouched; `enabledPlugins[...] === false` -> enabled with a notice.
- **Check:** byte-for-byte idempotency; the configuration kept on upgrade; no partial changes on a refusal; a lossless migration; care for other people's hooks.
- **Replaces:** the `migration` (2), `legacy .ai_work_dir` (3), `mixed hooks & duplicate warnings` (3), `conflicting pre-existing state` (3), `.claude/settings.json invalid JSON` (2), `upgrade subcommand` (8) blocks of `install.test.ts`. It closes F.1 #13 for migration.
- **What we lose:** this is the part with the most "historical load"; if the public release has no users of the pre-plugin format (question G-5), steps 5-8 can be **dropped entirely** (saving ~11 tests and the maintenance of the migration code).

### S-INST-04. Uninstall cuts out only its own parts and does not break anything else
- **Layer:** installer (CLI)
- **Priority:** P0 (do not spoil the user's settings)
- **Data/environment:** the project after S-INST-01; `.claude/settings.json` additionally has: a user `env.MY_VAR="1"`, a user hook, `permissions`; a second variant: the user redirected `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` to their own collector `https://collector.corp:4318/v1/logs`.
- **Steps:**
  1. `uninstall`: the directories `.artisyn/marketplace/` and `.artisyn/config/` (including `otel-port.json`) are deleted; `enabledPlugins["log-hub-hooks@artisyn"]` and `extraKnownMarketplaces.artisyn` are removed.
  2. In `.claude/settings.json` the user's `permissions`, hook, `customKey`, `env.MY_VAR` are the same byte for byte; the nine OTEL keys are removed while the endpoint points to `http://127.0.0.1|localhost:<port>/v1/logs`; no empty `env` is left (if `MY_VAR` was there, `env` stays with it alone).
  3. The variant with a foreign collector: `env` is not touched at all, stdout has a `Note:` line with a hint to remove `OTEL_*` by hand.
  4. File locking: on POSIX make the directory `.artisyn/marketplace/plugins/log-hub-hooks/scripts` undeletable (`chmod 0500` on the parent); on Windows `[win]` keep a file open -> the settings are still cleaned, a warning with the path of the leftover is printed; release the lock, and a repeated `uninstall` (or `install`/`upgrade`) removes the leftover.
  5. A repeated `uninstall` on an already clean project: exit 0, nothing changed, no exceptions.
  6. After `uninstall` the hook scripts can no longer run (the plugin directory is deleted), and no `claude plugin` commands are called (no `fake-claude` calls).
  7. A user hook with the same `matcher`/group as the installer's hook (from the S-INST-03 migration) stays after `uninstall`.
- **Check:** the exact set of what is removed; byte-level preservation of everything else; the conditional removal of OTEL; repeatability; handling of locks.
- **Replaces:** the `uninstall subcommand` (2) block of `install.test.ts`, the `uninstall` part of `OTEL port` (2). It closes F.1 #13.
- **What we lose:** nothing significant; the `Windows lock` is one `[win]` step (in the tests it went through a PowerShell lock).
- **OS:** on Linux step 4 works through permissions; not as root (under root `chmod` does not block, so the test is skipped after a `whoami` check).

### S-INST-05. OTEL port: allocation, pinning, `--otel-port`, stopping the old receiver, a foreign owner
- **Layer:** installer (CLI)
- **Priority:** P1
- **Data/environment:** temp-project; two parallel temp-projects; busy ports (test servers); the real `otel-receiver.js` as the "old receiver".
- **Steps:**
  1. `install`: the port ∈ [25000, 65535], the same in `otel-port.json`, `log-hub.local.json:otelReceiverPort` and in both endpoints of `.claude/settings.local.json`. Two projects in a row get **different** ports.
  2. A repeated `install`/`upgrade`: the same port (stability), even if `log-hub.local.json` was edited by hand to another one (it is aligned to `otel-port.json`).
  3. `install --otel-port 31447`: the port is pinned in the store, `log-hub.local.json` and the endpoints; a repeated `install --otel-port 31448` moves the store but does **not** rewrite the user's existing endpoints (a known discrepancy, G-7; the test pins it and must be revised when it is fixed).
  4. Wrong `--otel-port` values `0`, `-1`, `65536`, `70000`, `3.5`, `31447abc`, empty: exit 1, the files are not touched.
  5. Occupy the chosen candidate (bind) and/or put a server on it that does not answer the HTTP echo: the candidate is skipped (two checks: a bind probe and a loopback HTTP round trip); the probe step (prime step 7919) walks all 40536 ports without repeats (the property `gcd(7919, 40536)=1` is checked as a constant).
  6. An upgrade of a project from before 2.3.0 (without `otel-port.json`) allocates a port and adds all 9 `env` keys.
  7. If the user had their own `OTEL_*` keys in `env`, they are kept, only the missing ones are added, and a `Note:` lists the kept ones.
  8. Stopping the old receiver: start a real `otel-receiver.js` for this project on the chosen port; `install` -> the receiver is stopped **before** unpacking (the port is free, the process has exited), the installation continues. A receiver of an old version without `/artisyn/shutdown` (404) -> `console.warn`, the installation continues, `process.exit` is not called. A foreign owner (another `gitRoot`, a 409 answer) -> **not killed** (the PID is alive), the installation continues with a warning. A receiver that ignores shutdown is killed after the grace period.
  9. `findPidOnPort`: finds the PID for a real listener, `null` for a free port (on Windows through `netstat`/PowerShell, on POSIX `lsof`/`/proc`; without `lsof` the step is skipped after an availability check).
  10. The smoke test after installation really runs the **shipped** `otel-receiver.js` (replacing the file with a deliberately broken one gives a warning, not a failure).
- **Check:** the range, the consistency of the store, the config and the endpoints; validation; safe behaviour with a foreign owner; port stability.
- **Replaces:** the `OTEL port allocation, env block and uninstall` block of `install.test.ts` (11 of 14, the rest is in S-INST-04), the `OTEL receiver stop-before-install` block (3), `OTEL port allocation internals` (5), `otel-restart.ts: stopReceiverAndWait / findPidOnPort` (4), `hook/…/otel-restart.test.js` (7, a duplicate not included in `npm test`; decision G-5). It closes F.3 #37.
- **What we lose:** the math tests of `PROBE_STEP`/"wraps modulo": the property "walks all ports" is checked as a constant; the exact random choice is not checked.
- **OS:** `findPidOnPort` and `stopReceiverAndWait` are implemented differently on Windows and POSIX; steps 8-9 are checked on the OS where the suite runs.

---

## 6. REL (build and releases)

### S-REL-01. Build artifacts: a clean dist, consistent versions, the installer downloads and remembers the version
- **Layer:** installer (CLI)
- **Priority:** P1
- **Data/environment:** ENV-C (after `npm run build`; it runs in the background, not as a blocking call, as CLAUDE.md requires); access to `dist/`, `server/src/public/static/`. Docker is not needed.
- **Steps:**
  1. Versions: `hook/.claude/telemetry_tool/version.json` = `plugin.json.version` = the version inside the installer `.tgz` (unpack it) = `server/src/public/static/installer-version.json`; `artisyn-hooks-installer/package.json.bundledHookVersion` = the hook version; on a mismatch the build must fail (swap one version in a temp copy by hand -> `findVersionMismatch` reports it).
  2. Auto-bump: change the hook version in a temp copy and run the installer build step -> the installer version gets `+patch` and `bundledHookVersion` is updated (otherwise `npx` serves a stale cache); a repeated run without changes -> no changes.
  3. The `.tgz` contents: every script from `HOOK_JS_FILES` is present exactly once; both OTEL parts (`otel-receiver.js`, `otel-register.js`) are there; no `__tests__`, `.env`, `.local.json`, `node_modules`; all names in the tar are ≤100 bytes (the ustar limit).
  4. The transparent code rule: the plugin has no `.exe`, `.node`, `.wasm`, `.vbs`, minified files (a line longer than 2000 characters without line breaks is suspicious), not a single mention of `wscript` in the scripts.
  5. `dist/`: no `src/`, `test/`, `.spec`, temp files, no release `*.zip` files (`dist/public` and `dist/releases` must not hold real zips in the build), no `.env` with secrets (only the `.env.defaults` copy); `public/static` holds `artisyn-hooks-installer.tgz`, `hooks.tar.gz`, `installer-version.json`, `build-info.json`.
  6. The release stamp: `RELEASE_STAMP=20260918-142233 node -e "require('./scripts/release.js')"` exports `resolveReleaseStamp()` -> it returns the stamp as is; `RELEASE_STAMP=2026-09-18` -> an exception (not a regeneration); without the variable -> 15 characters `YYYYMMDD-HHMMSS` in UTC (checked against `new Date().toISOString()`), with the same result in a `TZ=Asia/Tokyo` environment; the names `artisyn-log-hub-<stamp>-amd64.zip` match the server's regular expression; `RELEASE_ARCHS=riscv` -> an error; the `package.json` files are not changed after `require`.
  7. Downloading the installer (ENV-A or ENV-C): `curl -o a.tgz $BASE/static/artisyn-hooks-installer.tgz` without a session -> 200, the bytes = the file in `static/` (SHA-256); `?v=1.5.0`, then `?v=1.0.0` -> the `latest-hook-version.json` baseline stays 1.5.0 (no rollback possible), `?v=<script>alert(1)</script>` and `?v=abc` -> 200 and the baseline is not changed; the "closed" `GET /api/v1/admin/releases` without a session -> 401.
  8. An `npm exec` run of the downloaded `.tgz`: `npx --yes <abs>/a.tgz --help` prints the usage with `install`, `upgrade`, `uninstall`, `--otel-port` (a check that the package works, not only the scripts).
  9. `GET /health/version` of the built bundle: `{version, gitCommit, releaseStamp}`; without `build-info.json` (delete it in a temp copy) -> `{version:'dev', gitCommit:'unknown', releaseStamp:'dev'}`, not 500; with an old file without `releaseStamp` -> `'unknown'`.
  10. Resolving the static directory in three layouts (dev, ncc bundle, tsc-watch): `/static/artisyn-hooks-installer.tgz` is served, not 404, in each (the "installer 404" regression).
- **Check:** version consistency; the contents and cleanliness of the artifacts; the release stamp; the download and the baseline; the build-info fallback.
- **Replaces:** `scripts/__tests__/build-hooks-installer.test.js` (17), `scripts/__tests__/release.test.js` (14), `installer.e2e-spec.ts` (7), `static-dir.spec.ts` (13), `build-info.spec.ts` (5), the part of `admin-releases.spec.ts` about the installer without login (1). Part of the tar/version checks is already caught at the `npm run build` stage and can stay as a check inside the build itself.
- **What we lose:** the unit variations of `resolveStaticDir` per layout (we keep three); all the variants of "almost release" files (riscv, a crooked stamp) are in S-REL-02.
- **Not covered:** `docker buildx` itself and the release bundle (`INSTALL.md`, `.env` with secrets) need Docker; a question to the owner (section 4).

### S-REL-02. A signed release link: from the admin panel to an anonymous download and every refusal
- **Layer:** UI+API
- **Priority:** P0 (security: serving bundles of hundreds of megabytes)
- **Data/environment:** ENV-B with `RELEASES_DIR=<tmp>`; zips in the directory: `artisyn-log-hub-20260101-000000-amd64.zip` (an old stamp), `artisyn-log-hub-20260918-142233-amd64.zip` (1 KB, known content), `…-arm64.zip`, garbage `artisyn-log-hub-20260918-142233-riscv.zip`, `artisyn-log-hub-bad-stamp-amd64.zip`, `notes.txt`; the test knows `SESSION_SECRET`; an admin and a plain user.
- **Steps:**
  1. The admin in the UI: Admin Panel -> System Info -> Release Downloads: **only** the newest stamp per architecture (`amd64`, `arm64`) is visible, without the old one, riscv, the crooked stamp and `notes.txt`; each row has a "Generate link" button. An empty/missing `RELEASES_DIR` -> an empty list without an error.
  2. Click "Generate link" for amd64: a link like `<origin>/api/v1/releases/download?file=…&exp=…&sig=…` is shown with an expiry "expires … UTC" exactly 24 hours ahead (tolerance ±1 min). The link is copied to the clipboard (or there is a Copy button).
  3. Anonymously (`curl`, no cookie): download by the link -> 200, `Content-Type: application/zip`, `Content-Disposition: attachment; filename="artisyn-log-hub-20260918-142233-amd64.zip"`, the SHA-256 of the body = the SHA-256 of the file.
  4. Tampering: change one character of `sig` -> **403 HTML** "Invalid download link", the body has no bytes of the file; change `exp` to +1 hour with the old `sig` -> 403; a repeated parameter `?file=a&file=b`, `file[x]=1` -> 403; `file=../../etc/passwd`, `file=..%2f..%2fsecret.zip`, a name that does not match the pattern -> 403, and the response has no file system paths.
  5. Expiry: compute a valid signature yourself (`HMAC-SHA256(secret, "<file>:<exp>")` base64url) for an `exp` in the past -> **410 HTML** "Link expired"; a negative/non-numeric `exp` -> 403 (not 500).
  6. Delete the file from disk and use a live link -> **404 HTML** "File no longer available", no 500.
  7. A new version is released (a new stamp `20260919-…` is added to the directory): a previously issued link to 20260918 **keeps working** until the file is deleted; but `POST /api/v1/admin/releases/download-link` for the outdated name -> 400 (minting only from the current list); for a name that exists nowhere, 400; for `notes.txt`/`not-a-zip`, 400 (DTO validation).
  8. Rights: a plain user's `GET /api/v1/admin/releases` and `POST …/download-link` -> 403; without a session -> 401; while the public link works without login (the link itself is the authorization).
  9. The `/static` regression: `GET /static/<zip-name>`, `GET /<zip-name>` anonymously and as a plain user -> do **not** serve the zip bytes (404/SPA page), checked by the body, not by the status.
  10. The signature is bound to the secret: the server restarted with another `SESSION_SECRET` (ENV-B allows it) -> the earlier link -> 403.
  11. Generating a link behind a proxy: a request with `X-Forwarded-Proto: https`, `X-Forwarded-Host: logs.example.com` with `TRUST_PROXY=1` -> `url` starts with `https://logs.example.com`; without `TRUST_PROXY` the headers are ignored.
- **Check:** the list holds only the newest; 24 h; an anonymous byte-exact download; three kinds of refusal (403/410/404) as HTML without leaking a path or content; the check order "pattern -> signature -> expiry" (403 before 410); `/static` does not serve zips; rights.
- **Replaces:** `releases.e2e-spec.ts` (17), `release-token.spec.ts` (7 of 11; the end-to-end cases remain), `releases.service.spec.ts` (3 of 10), `admin-releases.spec.ts` (1), `ReleaseDownloadsSection.test.tsx` (2). It closes F.1 #12.
- **What we lose:** the unit edge cases of comparing signatures of different lengths (`timingSafeEqual`) are covered by step 4; the 11 variants of "almost release" files are squeezed to 3; the correctness of the `base64url` format is checked indirectly.
- **Careful:** `admin-releases.spec.ts` currently writes into `server/releases` and leaves garbage on failure; in ENV-B everything is in `<tmp>` and is cleaned up in `afterAll`.

---

## 7. PLATFORM

### S-PLAT-01. Health, build version and security headers everywhere
- **Layer:** API
- **Priority:** P0
- **Data/environment:** ENV-A (and ENV-C for the static files/SPA). For the step about an unreachable DB, a temporary Postgres container that can be paused (`docker pause`); otherwise the step is skipped.
- **Steps:**
  1. `curl -i $BASE/health` -> 200, the body has `status:"ok"` and `info.database.status:"up"`; no authentication.
  2. `GET /health/version` without a session -> `{version, gitCommit, releaseStamp}`; the values are not empty.
  3. For each of `GET /health`, `GET /api/v1/repositories` (401), `GET /api/v1/nonexistent` (404), `GET /` (the SPA, 200 on ENV-C, 200/404 on ENV-A through vite), `POST /api/v1/logs` without a key (401), `GET /static/artisyn-hooks-installer.tgz` (200), `GET /api/v1/releases/download` without parameters (403 HTML), a static file from `/assets/…` (ENV-C): the headers are **strictly** `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and `Content-Security-Policy` equals the exact string `default-src 'self';script-src 'self' 'wasm-unsafe-eval';style-src 'self' 'unsafe-inline';img-src 'self' data:;font-src 'self' data:;connect-src 'self';object-src 'none';base-uri 'self';form-action 'self';frame-ancestors 'none'`. The CSP has no `upgrade-insecure-requests` and no `unsafe-inline` in `script-src`.
  4. Error responses are uniformly JSON for `/api` (except the HTML page of the release download), without a stack and without file system paths (`/home`, `C:\`, `node_modules` do not appear in a 404/500 body).
  5. The DB is unreachable (`docker pause` for 5 s, if Docker is available): `GET /health` -> **not 200** (503) and `info.database.status` is not `up`; after `unpause` it is 200 again without a server restart.
  6. Boundary: `Referrer`/`Origin` are not required; `OPTIONS` on `/api/v1/logs` does not open CORS (no `Access-Control-Allow-Origin: *`).
- **Check:** strict equality of the CSP (a substring check is not enough); the same headers on 200/401/403/404; health reflects the DB (closes F.3 #32); the version is public.
- **Replaces:** `security-headers.e2e-spec.ts` (4), `app.e2e-spec.ts` (1), `http-exception.filter.spec.ts` (4, through step 4). `build-info.spec.ts` is in S-REL-01.
- **What we lose:** the choice of CSP directives as config (a CSP change requires editing one line of the test; a deliberate lock).

### S-PLAT-02. Static files of the built application: br/gzip/identity, Vary, cache, SPA fallback
- **Layer:** API
- **Priority:** P1
- **Data/environment:** ENV-C (the built bundle, a free port); the files `dist/public/assets/index-<hash>.js` and `.css` and their `.br`/`.gz`.
- **Steps:**
  1. `curl -sI -H "Accept-Encoding: br" /assets/index-<hash>.js` -> `Content-Encoding: br`, `Content-Type: application/javascript`, `Vary: Accept-Encoding`, `Cache-Control: public, max-age=31536000, immutable`, `Content-Length` = the size of the `.br` file on disk.
  2. The same with `Accept-Encoding: gzip` -> `gzip`; `br, gzip` -> `br`; `br;q=0, gzip` -> `gzip`; `identity` or no header -> no `Content-Encoding`, but `Vary: Accept-Encoding` **is** there (as caches require).
  3. Decompression: the `curl --compressed` body for br and gzip equals the source file (SHA-256), `Content-Type` is not `application/octet-stream`.
  4. `/index.html`, `/favicon.svg`, `/help/*.md`: **no** `immutable` (the cache revalidates); for `.html` and `.md` precompression works with the matching `Accept-Encoding`.
  5. SPA fallback: `GET /repos/123/sessions/abc` (a deep link) -> 200 `index.html`, without `immutable`, with the security headers (S-PLAT-01).
  6. `Range: bytes=0-99` on a `.js` -> a response **without** `Content-Encoding` (the identity file), 206.
  7. `HEAD` works the same as GET for the headers; `POST /assets/index.js` is not intercepted.
  8. `/api/*`, `/health`, `/static/*` do not get `Vary: Accept-Encoding` and are not replaced with `.br`: `/static/hooks.tar.gz` is served as is (no false `hooks.tar` entry in the manifest), `/static/artisyn-hooks-installer.tgz` the same bytes.
  9. No directory leak: `/assets/`, `/assets/../index.js`, `/..%2f..%2fpackage.json` -> 404/SPA, not a directory listing and not a file outside the root.
  10. The build part: on a temp copy of the `client/dist` directory run `node client/scripts/precompress.cjs <copy>`: for a file ≥1 KB `.br` and `.gz` are created if the gain is ≥10% (the edge inclusive); already compressed files (`.png`, `.woff2`, `.tgz`) are not touched; a repeated run does not create `.br.br`/`.gz.gz`; a missing directory -> an error; a `.br` exists only for existing sources (after a rebuild, old `.br` files do not outlive their file).
  11. There are exactly as many files in `dist/public/assets` as the manifest lists: the number of `.br`/`.gz` variants matches (no "orphans").
- **Check:** negotiation by `Accept-Encoding` (including `q=0`), `Vary` always, the cache policy only for `/assets/`, the SPA fallback, Range, path traversal; the compression round trip.
- **Replaces:** `precompressed-static.spec.ts` (26), `precompress.test.cjs` (10). It closes "`precompressed-static.spec` runs on a mini Express, not on the real application".
- **What we lose:** the `CONTENT_TYPES` map versus `mime-types` (parity tests for every extension): we check 3 extensions (`.js`, `.css`, `.html`); the rest is a minor loss.

### S-PLAT-03. The server through an operator's eyes: cluster, System Info, a worker restart, file logs, Error Logs, archive
- **Layer:** UI+API
- **Priority:** P1
- **Data/environment:** ENV-C with `CLUSTER_MODE=primary`, `LOGS_DIR`/the working directory in a temp folder (so that `logs/` is clean), an admin and a plain user, the owner's key, a free port. The test runs alone (many processes + a shared DB). On Windows processes are killed with `taskkill /F /PID`, on POSIX with `kill -9`.
- **Steps:**
  1. Start: the server comes up; `GET /health` 200; within ≤15 s `GET /api/v1/admin/system` (admin) returns `supervisor.clustered=true`, `instances.expected = computeInstanceCount(cpus.visible)` = `instances.actual` = the number of rows in `supervisor.processes`, each with `status:"online"`, `pid > 0`, `instance` 0..N-1, `memoryBytes` > 0 after ≥10 s (the worker's first report); a process has no `cpuPercent` field.
  2. The other System Info fields: `db.connected=true`, `db.pingMs ≥ 0`, `dbSpace.available=true` and positive `logsTableBytes`, `databaseTotalBytes`; `memory`, `loadAverage` of 3 numbers, `uptime.processSeconds > 0`, `uptime.containerSeconds=null` (not in Docker), `build.releaseStamp` not empty, `node.version`; `disk.logsDirBytes ≥ 0`. Without a session 401, a plain user 403.
  3. UI Admin Panel -> System Info: the instance tiles (`N / N`), the process table with PID and memory, a dash for a slot without a report; the DB Space block is visible; for a user without the right to see table sizes the block is hidden (mocking the rights is out of scope; we check through the API answer `dbSpace.available=false` if the DB role is restricted; otherwise the step is skipped).
  4. Send several `POST /api/v1/logs` and `POST /api/v2/logs` to the server: the requests are spread across the workers (files `app-<day>-i0.log`, `app-<day>-i1.log` … appear in `logs/`); the console output has the `[iN]` prefix.
  5. Kill the worker of slot 0 (the `pid` from step 1): within 5 s `supervisor.processes[0]` -> `restarts=1`, `lastRestartAt` is not null, a new `pid`, `status` `online`; the slot stayed **the same** (`instance=0`), **no** new series of log files is created (it writes to the same `-i0`); the API work was not interrupted (requests to another worker go through, `GET /health` 200).
  6. Kill the same slot twice more quickly (<10 s of uptime): restarts with delays of 1 s then 2 s (a timing measurement), `restarts=3`; the **full** budget (10 fast crashes, delays 1/2/4/8/16/30 s, >150 s in total, `status:"stopped"`) is not run at the scenario level; see "Not covered".
  7. File logs: produce an error: `POST /api/v2/logs` with broken NDJSON -> later the scheduler writes an `ERROR` line to `logs/app-<day>[-iN].log`; the file has a fixed-width format (`logback-formatter`), a multi-line message (a stack) is **not split** (one record = one block), each record has a timestamp; the SQL logs are in `sql-<day>.log`; the logs (application, SQL, console) contain **no** `X-API-Key` value and no NDJSON body with `PROMPT-SECRET` (grep = 0).
  8. Admin Panel -> Error Logs: the first line is the ERROR about this failure (newest on top), `INFO` lines are not shown, a click on a line opens the details, Copy puts "message + details" on the clipboard; at most 30 records; if `logs/` does not exist yet, an empty list without an error.
  9. Admin Panel -> System Info -> "Logs Archive": the download returned a real `.zip` (`Content-Disposition: attachment`, the `PK` signature) with the current `app-*.log` and `sql-*.log` files inside, including `-iN`; a plain user -> 403; without a session -> 401. The temp zip on disk is deleted after the response.
  10. Graceful shutdown: send `SIGTERM` (POSIX; on Windows `[win]`, `taskkill` without `/F`, the behaviour differs and is checked by a manual run) to the main process -> all workers have exited, the primary exits with code 0 within ≤8 s, `logs/` has no cut-off last record; the port is released; the DB has no stuck `processing` rows of the queue.
  11. Single-process mode (ENV-A/B, without `CLUSTER_MODE`): `supervisor.clustered=false`, one row `status:"online (single process)"`, `instance=null`.
  12. Pool size configuration: `instances × DB_POOL_MAX` does not exceed the DB's `max_connections` (we read `SHOW max_connections` and `pg_stat_activity` at step 1: active connections ≤ the expected `poolMax × instances`); `TRUST_PROXY` is step 11 of S-REL-02.
- **Check:** the cluster really starts, the workers are kept alive, the slot is kept on a crash, the logs are not split and hold no secrets, Error Logs and the archive are correct, admin rights, a graceful stop.
- **Replaces:** `cluster-messages.spec.ts` (12), `worker-slot-registry.spec.ts` (25; the behaviour "the slot is kept, a restart with a delay" is steps 5-6, the pure backoff logic remains debatable, see below), `worker-stats-reporter.spec.ts` (13), `system-info.service.spec.ts` (12), `request-metrics.middleware.spec.ts` (12), `system-info.e2e-spec.ts` (11), `instance-count.spec.ts` (3), `trust-proxy.spec.ts` (5), `app-logger.spec.ts` (8), `sql-logger.spec.ts` (10), `logback-formatter.spec.ts` (4), `AdminSystemTab.test.tsx`/`AdminErrorLogsTab.test.tsx` (~6, the client components group), the Error Logs and Logs Archive parts of `admin-panel.e2e-spec.ts` (~4). It closes F.3 "the cluster has no e2e".
- **What we lose:** the exact backoff schedule `1/2/4/8/16/30 s` and the stop threshold after 10 fast crashes (the pure arithmetic of `WorkerSlotRegistry`): **we recommend keeping one small unit file with ~6 cases** (the owner's decision, section 4); an unreachable DB in System Info (`connected=false`, `memoryBytes null`) and the active request counter not going negative are low-value edge cases, and the loss is acceptable; log rotation at the day change (`DailyRotateStream` switches the file at midnight) is not checked, only the name format.
- **OS:** on Windows `cluster.schedulingPolicy` differs (no round-robin), so spreading the requests across the workers is not guaranteed; step 4 on Windows is relaxed to "at least one `-iN` file"; processes are killed with `taskkill`; `SIGTERM` is not equivalent.

---

## 8. Not covered by scenarios (deliberately)

- **Format variations and thresholds** inside pure functions: all the branches of `env-context` over 30 config keys (3 typical errors are kept), the values of `ndjson-parser` at the threshold of 10% broken lines (one point each at 0.5% and 30%), `PROBE_STEP`/the modular port walk, `CONTENT_TYPES` for rare extensions, `alignSliceBoundary` on a body without `\n`. The reason: parity with the product is reached without them; the loss is a regression only in rare corner cases.
- **The full worker crash budget** (10 fast crashes and the slot stop, >150 s) and the 1/2/4/8/16/30 s schedule: too long for a scenario. The recommendation is to keep `worker-slot-registry.spec.ts` squeezed to ~6 tests as the only "pure policy with time" exception, or to accept the loss.
- **The Docker build and the release bundle** (all of `scripts/release.js`: `docker buildx`, `.env` with secrets, zips): needs Docker and many minutes; only the pure functions (stamp, names) are checked in S-REL-01 and the server side of serving in S-REL-02.
- **The real LLM level of the guardrail** (Haiku verdicts) and the quality of `post-turn-analysis`: only the contracts with `fake-claude` are checked; model quality is not a test.
- **Real Claude Code as a process** (a real `claude plugin install`, `hooks.json` triggered by Claude itself): the test run replaces Claude with calls of the scripts with the same stdin. A manual smoke check before a release is needed (once per version).
- **Windows specifics as a whole** (VBS/EDR, `wscript`, PowerShell locks, the MCP `.cmd` shim, the `netstat` PID lookup, `taskkill`): marked `[win]`; without a separate Windows job they stay a manual check.
- **WSL/DrvFs/network drives** (non-atomic `O_APPEND`, the file locking of 2.17.4): reproducible only on a real file system.
- **Server session retention** (`SessionRetentionService`) and **user-settings**, `model-pricing` (except its being public), `ai-tool-versions`: other groups.
- **An unreachable DB in `System Info`** (`connected=false`) and **DB roles without the right to see table sizes**: they need a special DB; the loss is acceptable.
- **Real proxy infrastructure** (nginx/`client_max_body_size`, a TLS terminator): emulated with a fake server (S-COMPAT-02); a real proxy is outside the repository.
- **`otel-receiver` as a separate package under load** (thousands of requests/s), performance (`npm run perf`): stays a separate perf suite.

## 9. Questions for the owner and recommended decisions

1. **ENV-B/ENV-C.** Do you agree that the runner itself starts a separate server on a free port (test settings, a separate DB schema, `workers=1` for these scenarios)? Without it S-INGEST-03/05/06, S-REL-02, S-PLAT-03 are impossible: the dev server has `LOGS_MAX_BODY_MB=2500`, a 3-minute lease, and file logs cannot be mixed in.
2. **Frozen old hooks** (S-COMPAT): are you ready to build `legacy-hook-<version>.js` once from the git tags and commit the response snapshots? Without it backward compatibility (a CLAUDE.md requirement) stays unprovable.
3. **The new hook against a server without `/api/v2/logs`** does not fall back to v1 (S-COMPAT-02 step 1). Is this intended (v2 is the minimum server version), or is a fallback to `/api/v1/logs` on 404 needed?
4. **`0054 backfill idempotency`** (in `logs-otel.e2e-spec.ts`) and the migration backfills: delete them after the migration squash (I recommend deleting).
5. **Migration from the old pre-plugin format** (steps 5-8 of S-INST-03, 11 tests plus the code): are there users it will work for? If the project is released as open source from scratch, I recommend deleting the migration and its tests. Also: delete the duplicate `otel-restart.test.js` in `hook/` (7) and keep the installer version in S-INST-05.
6. **Hook the run of these scenarios into `repo-health-checks.json`** (hook/installer do not run in the work cycle today).
7. **`tool_input` is written to the telemetry in full** (including the `content` of Write and the `new_string` of Edit; only `tool_response` is excluded). Transcripts are uploaded in full anyway, so there is no leak beyond the transcript, but "the file content does not get into the telemetry" (the catalog's wording) is true only for `tool_response`. Accept it as is and fix the wording? S-HOOK-02 step 8 pins this boundary.
8. **`--otel-port` on a reinstall** keeps the old endpoints (a known discrepancy, G-7). S-INST-05 step 3 pins the current behaviour; should it be fixed (then the step's expectation changes)?
9. **Should 2-3 small unit files be kept** for the pure logic that scenarios cannot cover sensibly: `worker-slot-registry` (~6), the `patch-line-counts.json` hook↔server parity (16 cases, one fixture), the `ndjson-parser` threshold (3)? I recommend yes: ~25 tests in total instead of ~860.
10. **The server-side `git.user`**: the hook writes it, and the server ignores it (the user = the key owner). A feature or a leftover? S-INGEST-02 pins the current behaviour.
11. **A Docker check of the release** (`docker buildx`): is a manual check needed that builds the image and checks the `build-info.json` inside?
