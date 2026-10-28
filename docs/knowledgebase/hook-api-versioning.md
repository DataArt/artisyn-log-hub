---
type: "Architecture Guide"
title: "Hook API Versioning (v2 logs upload, v1 removed)"
description: "Why log upload moved from POST /api/v1/logs to POST /api/v2/logs, the removal of v1 (old hooks get 404 and must upgrade), the hook-version compatibility matrix, and the hook-to-OTEL-receiver cross-version contract."
tags:
  - hooks
  - api
  - otel
timestamp: "2026-10-28T00:00:00+04:00"
---

# Hook API Versioning (v2 logs upload, v1 removed)

> **Current state (open-source readiness, 2026-10-14):** `POST /api/v2/logs` is the only log upload
> route. The synchronous `POST /api/v1/logs` was removed — `LogsController.postLogs`, its private
> `stripNullChars` copy and the `api/v1/logs` entry of `LOG_INGEST_ROUTES`
> (`server/src/common/body-limits.ts`). The route now answers Nest's default `404`, so a hook older
> than `1.7.0` stops uploading and must be upgraded. `LogsController` keeps only
> `POST /api/v1/log-echo`, which the hooks installer calls to check an API key. The sections below
> keep the history of the v1/v2 split for context.

The v2 route exists because of the async upload-processing queue: the server stages an uploaded log body to
disk and parses/upserts it later, off the request path, instead of doing so synchronously inside
the HTTP request. This changes the API contract for a broken upload (a malformed NDJSON body no
longer 400s immediately — it becomes a `failed` queue row surfaced on a *later* call instead), so
the new behavior lives on a brand-new route rather than being folded into the existing one. This
article documents why, and exactly which hook versions see which behavior.

---

## Why a new route instead of changing the existing one in place

An old, already-installed hook (`send-logs-hook.js` < `1.7.0`) has `POST /api/v1/logs` hardcoded
and never reads the response body on a `201` (`uploadFile()`'s success branch just does
`res.resume()`). If the async behavior had been grafted onto `/api/v1/logs` directly, an
un-upgraded hook would see a fast `201` for a file that actually failed to parse — a silent
regression (zero error signal), not just a missed feature.

Instead:

- **`POST /api/v1/logs`** (`LogsController`) was **frozen** — not modified by the queue work, keeping its
  synchronous parse-then-upsert behavior and empty `201` body for un-upgraded hooks. It has since
  been **removed** (see the note at the top) and returns `404`.
- **`POST /api/v2/logs`** (`server/src/logs/logs-v2.controller.ts`, `LogsV2Controller`) implements
  the new async stage → queue → background-process flow exclusively (no legacy branch inside it).
  Same query params (`sessionId`, `type`, `parentSessionId`, `workflowRunId`) and the same three
  structural `400` checks v1 had, but the NDJSON line-parsing moves out of the request path
  entirely: a bad line becomes a `status='failed'` `upload_queue` row instead of aborting the
  request. The `201` response body is `{ warnings: string[] }` — one message per outstanding
  `failed` row for the calling API key's user, from a *previous* upload's failure.

The URL itself is the version signal — no version-detection logic needed on either side. Hook
`1.7.0`+ simply builds its upload URL against `/api/v2/logs` instead of `/api/v1/logs`
(`uploadFile()`, one literal path change).

See `docs/knowledgebase/server-endpoint-map.md` and `docs/knowledgebase/api-reference.md` for the
full request/response shape of the v2 route, and `docs/knowledgebase/hook-system-overview.md` for
the general hook architecture (including the `broken-upload-file` recommendation rule this
mechanism feeds).

---

## Compatibility matrix

| Hook version | Route called | Success response | Broken-upload error visibility |
|---|---|---|---|
| `< 1.7.0` (any un-upgraded hook) | `POST /api/v1/logs` | none — the route was removed and answers `404` | Every upload fails: the hook logs a `fail` line per file and counts it in `failedCount`. Nothing is stored until the hook is upgraded |
| `>= 1.7.0` | `POST /api/v2/logs` | `201`, `{ warnings: string[] }` | No synchronous `400`. The bad file is staged, queued, and later marked `status='failed'` by the background scheduler; the *next* upload's response `warnings` array carries a message for it, which the hook turns into a `broken-upload-file` recommendation (`upsertRecommendation(cwd, { rule: 'broken-upload-file', ... })`) — surfaced via the existing `hook-status` → `HookStatePage.tsx` flow, the same mechanism `timeout-on-upload` already uses. Also visible directly in the Admin Panel's Upload Queue tab, and in the Error Logs tab via the scheduler's `Logger.error()` call on failure |
| `>= 2.22.0` | `POST /api/v2/logs` + `snapshotId` / `snapshotFull` on the root `artisyn` upload | `201`, `{ warnings, unknownSnapshotId? }` | As `>= 1.7.0`; an invalid id is ignored, never a `400` — see the harness snapshot section below |
| `>= 2.26.0` | `POST /api/v2/logs` + `okfSnapshotId` / `okfSnapshotFull` on the root `artisyn` upload | `201`, `{ warnings, unknownSnapshotId?, unknownOkfSnapshotId? }` | As `>= 1.7.0`; an invalid id is ignored, never a `400`; a server without OKF support ignores the params — see the OKF snapshot section below |
| `>= 2.27.0` | `POST /api/v2/logs` also with `type=tool-calls`; plus `GET /api/v2/tool-monitoring/config` | unchanged | As `>= 1.7.0`; a server without Tools/MCP support stores `tool-calls` as an inert generic log and answers the config route `404` (read as "no config") — see the CLI tool wrapper section below |

The route requires `ApiKeyAuthGuard` (the `X-API-Key` header) and accepts this body encoding
(`express.text()`, `Content-Type: application/x-ndjson`/`application/json`/`text/plain`, 2500MB
limit by default — overridable via `LOGS_MAX_BODY_MB`, see `server/src/common/logs-body-limit.ts`)
— `logs.module.ts`'s `configure()` registers that middleware for `LOG_INGEST_ROUTES`
(only `api/v2/logs`). Note that in practice the parser that consumes the hook's `application/x-ndjson`
body is the one `AppModule.configure()` applies to `forRoutes('*')`, which wins the race against
`LogsModule`'s — which is why the gzip sniffer below is registered in `AppModule`, not `LogsModule`.

The route additionally accepts a **gzip-compressed** request body, in either of its two
forms, and neither is a contract change (same URL, params, statuses, response shapes):

- with `Content-Encoding: gzip` — inflated by `body-parser` itself (its `inflate` option defaults to
  `true` and nothing here disables it), no server code involved;
- with that header stripped by an intermediary — detected by the `inflateSniffedGzip` middleware
  (`server/src/logs/gzip-sniff.middleware.ts`, registered in `AppModule.configure()` for
  `LOG_INGEST_ROUTES`, i.e. `POST api/v2/logs`) from the `1f 8b` magic bytes and inflated before the
  body parser sees it.

Two new failure responses come with it: `400 Malformed gzip request body` for a body
that starts with the gzip magic but fails to inflate (previously such a body produced a `201` over a
mangled string), and `413` when it inflates past `LOGS_MAX_BODY_MB` — matching what the
declared-`Content-Encoding` path already did, since `raw-body` counts decompressed bytes there. An
old hook that only ever sends plain bodies is completely unaffected: the middleware returns
immediately for a non-gzip body, having unshifted the two bytes it peeked.

### Per-route body limits

`server/src/common/body-limits.ts` splits the body-size limits three ways (an oversize body → `413`
from body-parser):

| Routes | Limit | Registered in |
|---|---|---|
| Log ingest — `LOG_INGEST_ROUTES` (`POST api/v2/logs` only; v1 was removed) | `getLogsBodyLimit()` (`LOGS_MAX_BODY_MB`, default 2500 MB) | `LogsModule.configure()` — json, `text({type:['application/x-ndjson','text/plain']})` and urlencoded |
| Hook JSON APIs — `HOOK_API_ROUTES` (`POST api/v2/turn-end-cost-advisor`, `POST api/v2/session-attribution`, `POST api/v1/log-echo`) | `HOOK_API_BODY_LIMIT` = 1,048,576 bytes | `AppModule.configure()` |
| Everything else | `GLOBAL_BODY_LIMIT` = 512,000 bytes | `AppModule.configure()` — the global json/urlencoded/text parsers `.exclude()` both lists above |

`PostTurnAnalysisController` exposes only `GET config`, so it has no entry. A hook that sends a
larger body to one of the hook JSON APIs gets a `413`. Before this split every route used
`getLogsBodyLimit()`. When a
new hook-called `POST` route is added, add it to `HOOK_API_ROUTES`, or it silently falls under the
500 KB global limit.

Every parser (and the gzip sniffer, session and passport) is wrapped in `throwMiddlewareErrors()`
(`server/src/common/middleware-errors.ts`). Without it a `next(err)` reaches
`@nestjs/serve-static`'s Express error handler, which rewrites any error on an `/api/*` route to
`404 Cannot POST …` — so a 413 or a malformed-body 400 arrived as 404. The wrapper throws inside
Nest's middleware proxy instead, and `HttpExceptionFilter` answers with the real status. A new
`next(err)`-style middleware on an `/api/*` route needs the same wrapper. The shared e2e app is
built with `Test.createTestingModule()`, which has no serve-static layer, so only the scenario
stand (a real `main.ts` bundle) exercises this.

### Uploads into another user's session

A session belongs to the user who owns any `logs` / `logs_otel` row with that `session_id`; with
no row, it has no owner yet. An upload by a *different* user into an owned session is not stored,
and the response stays a success so old hooks are not broken by a new status code:

- **`POST /api/v2/logs`** — the controller calls `findSessionOwnerId` before `saveRawUpload` (and
  before `saveChunk` on every chunk of a chunked upload). For a foreign session it stages nothing
  and returns `201 { warnings: [FOREIGN_SESSION_WARNING(sessionId), ...pending] }` (chunk path:
  `{ complete: true, warnings }`). The text, from `server/src/logs/upload-warnings.ts`, is
  `Upload for session <sessionId> was rejected: the session belongs to another user. The data was not stored.`
- **Race with the worker** — `LogsService.upsert()` re-checks inside its transaction under
  `pg_advisory_xact_lock(hashtextextended('session-owner:' || $sessionId, 0))` and returns
  `{ status: 'foreign-session' }` before any write. The queue worker then sets the row to
  `status = 'rejected_foreign_session'` with the warning in `errorMessage`, deletes the staged file
  and records a `failure` measurement.
- **Delivery** — `getPendingWarnings` returns such rows with `warning_delivered = false` and flips the
  flag in the same `UPDATE … RETURNING`, so each rejection reaches the hook exactly once (in the
  `warnings` of a later upload). `failed` rows keep their existing behaviour.
- The server logs `upload rejected: foreign session sessionId=<id> userId=<n> ownerId=<m>`. The
  admin Upload Queue tab shows the status as `Rejected: foreign session`; `clearFailed` /
  `reprocessFailed` stay limited to `failed` rows.

No hook change is needed: the contract is the existing `201 { warnings: string[] }` shape that any
hook `>= 1.7.0` already reads.

---

## Known limitation: a reverse proxy's own body-size cap is invisible to this app

`LOGS_MAX_BODY_MB`/`getLogsBodyLimit()` only govern the NestJS/Express layer. A reverse proxy
sitting in front of the app (e.g. nginx) enforces its own body-size cap independently, and that
cap is enforced *before* a request ever reaches this middleware — the app has no way to detect or
negotiate it. nginx's `client_max_body_size` defaults to **1MB**; a request over that gets nginx's
own `413 Request Entity Too Large` HTML error page (distinguishable in a client-side log from the
app's `413` by the `nginx/<version>` string in the response body — no Node/Express involvement at
all).

This was diagnosed from a real hook.log: a **1.2MB** upload was rejected with exactly that nginx
error page, on a deployment whose app-level limit was already far larger (the then-current 50MB).
Raising `LOGS_MAX_BODY_MB` alone does nothing for a deployment sitting behind such a proxy — the
proxy's own cap must be raised too, and that proxy is not part of this repo (no nginx config or
docker-compose service exists here; it is external infra managed separately from this codebase).

**Mitigation applied hook-side (`2.6.1`+):** since the app-level limit can't compensate for an
unknown, externally-managed proxy cap, `upload-logs.js`'s `CHUNK_SIZE_BYTES` was lowered from
10MB to **900KB** — comfortably under nginx's 1MB default with headroom for headers/query params.
Every upload (chunked or single-request) is capped at that size per HTTP request regardless
of the app-level `LOGS_MAX_BODY_MB` value, so a hook talking to a deployment behind a
default-configured nginx no longer 413s.

**Refined in `2.8.0`: `CHUNK_SIZE_BYTES` is now the budget for the *on-the-wire* body, not
for the payload.** Because bodies are gzipped (see the gzip section above), one sub-900KB request
now carries several MB of NDJSON — the proxy-safety property is unchanged while the request count
for a large transcript drops by roughly an order of magnitude. The chunk splitter therefore *plans*
slices by predicting how much uncompressed data compresses to under the budget, and re-compresses a
slice smaller when it overshoots (`planCompressedSlices()`); `totalSize` and the server-side
`upload_queue.size_bytes` keep counting uncompressed bytes, so nothing server-side changes meaning.

A proxy configured *even more* restrictively than the 1MB default is also handled now, which is the
part the paragraph above said the hook did not do: an `HTTP 413` on a chunk halves the in-call wire
budget (floored at 128KB), re-plans the whole file at the smaller budget and restarts from chunk 0
with a fresh `uploadId`, at most twice per call. The hook still cannot *discover* the limit in
advance — it fails one request and retries smaller, exactly as suggested here.

---

## Hook ↔ OTEL receiver (hook `2.3.0`+)

The same compatibility rule applies to a second, purely local interface: the hook talks to
`otel-receiver.js` over `POST http://127.0.0.1:<port>/artisyn/register`. Both sides ship in the same
plugin tarball, but they are **separate long-lived processes**: a receiver spawned at
`SessionStart` outlives the hook run that started it and keeps serving every later session of the
project until its idle timeout. So a session running hook `N` can perfectly well meet a receiver
still running version `N-1` (or, right after an upgrade, `N+1`), and neither side may assume
otherwise.

The contract is therefore deliberately one-directional and lossy-tolerant:

**Caller side (`otel-register.js`) — every outcome is non-fatal, and nothing is ever retried.**

| Receiver response | Hook behaviour |
|---|---|
| `200 {"ok":true,"receiverVersion":"<v>","port":<n>}` | Success. If `receiverVersion` parses and is **older** than the caller's own `version.json`, one `hook.log` `warn` line naming both versions — and nothing else. No takeover, no re-spawn, no kill. An unparseable or absent version produces no warning (an unrecognisable version must not manufacture a spurious one). |
| `409 owner-mismatch` | One `warn` line naming the port and the owning repo — see `docs/knowledgebase/otel-receiver.md` § "The `409 owner-mismatch` guard". |
| `404` | **Silent.** This is exactly what a pre-`2.3.0` receiver returns: it has no `/artisyn/register` route. Treating it as an error would make every upgrade-in-flight session log noise. |
| `ECONNREFUSED` / any socket error / any other status | Silent. "No receiver is running" is the normal case, and the spawn that follows the register call is what fixes it. |

The register POST is fire-and-forget on an `unref()`'d socket, so it can never delay or fail a hook
run regardless of what is (or isn't) listening.

**Receiver side — tolerant of unknown and missing fields.** Unknown body fields are ignored, so a
newer hook may add fields freely. Every field except `gitRoot` may be absent; only a missing
`gitRoot` (or a `sessionId` failing the `^[A-Za-z0-9._-]{1,128}$` allow-list) is a `400`. `gitRoot`
cannot be optional — it *is* the owner check.

Practical consequence for future changes: a new field in the register payload is always safe, and a
new *response* field is safe as long as `ok` / `receiverVersion` / `error` keep their meaning.
Removing or repurposing any of those three, or making a previously optional request field required,
is a breaking change and needs the same treatment `v1`/`v2` got above — a new route, not an
in-place edit.

---

## `perToolDetailSupported` — MCP per-tool detail capability flag (hook `2.7.0`+; moved to the snapshot root in `2.22.0`)

A third capability-versioning problem, distinct from both routes above: the hook's MCP reporting
(originally the standalone `mcp-config` synthetic event; since hook `2.22.0` the `mcpServers` array
of the `harness-snapshot` body — see `hook-system-overview.md`'s "Context injection" and the new
snapshot section below) gained per-server `connected`/`tools` fields and a top-level
`perToolDetailSupported: true` flag when the hook added a live `tools/list` probe of each
configured MCP server. **`2.22.0` moved `perToolDetailSupported` from the `mcp-config` event's own
top level to the `harness-snapshot` body's top level** (DD-1) — same name, same meaning, new home;
nothing below in this section changed because of that move except where the flag is read from. The
server needs to tell two zero-shaped outcomes apart that would otherwise look identical:

1. **Old hook** (`< 2.7.0`, or any pre-`2.22.0` hook that never sends a snapshot at all — see
   below) — never attempted the probe. Its MCP payload (the old `mcp-config` event, where one
   exists) simply has no `connected`/`tools`/`perToolDetailSupported` keys at all.
2. **Capable hook, zero result** — the probe ran but the server had 0 tools, or failed to connect
   (`connected: false, tools: []`). This is a real, known count, not missing data.

**The flag, not the version string, is the signal.** `perToolDetailSupported`'s *presence* — not
`hookVersion`, and not whether individual servers report `connected: true` — is what the server
checks. `extractHarnessMcpInventory()` (`artisyn-extractor.ts`) reads it off the loaded
`HarnessSnapshotBody` (DD-10; pre-`2.22.0`, it read the `mcp-config` event instead — same check,
different source object). Rationale: a hook could in principle ship the capability but have it
disabled/fail entirely for a given run, so gating on the hook version string would be one layer
removed from what actually happened on this specific upload.

**Storage and rendering consequence** (`repositories.harness_mcp_per_tool_supported`, "last
self-report wins" — see `db-tables.md`):

| Payload shape | Stored capability flag | Harness Usage report rendering |
|---|---|---|
| No `perToolDetailSupported` key (hook `< 2.7.0`) | Left unchanged (never overwritten with a guess) | Schema-size cell renders `-` (`schemaSizeReported: false`) — "not reported by this hook version", never `0` |
| `perToolDetailSupported: true`, server `connected: false` or 0 tools | `true` | Schema-size cell (if applicable) and per-tool child rows render as real zeros/absence, not `-` |
| `perToolDetailSupported: true`, server `connected: true`, N tools | `true` | Per-tool `tool`-kind child rows with real `schemaSizeTokens` values |

This is the same "distinguish absent-because-old from present-but-zero" shape `hook_version` /
`hook_last_activity` already solve for the Hook State Panel — `perToolDetailSupported` is a second,
independent instance of that pattern, scoped to one feature rather than the whole hook.

Within the `2.7.0`–`2.21.x` range, backward compatibility was automatic and required no
version-detection branching in application code: an old hook's `mcp-config` entries were simply
missing the new fields, which is `undefined` on the parsed object — exactly the same "old hook, new
field absent" shape every other additive event-field change in this hook uses. No new route was
needed for that change, unlike the `v1`/`v2` split above, because an old hook reading a `201` never
inspected `mcp-config`-specific response fields.

**`2.22.0` is a sharper line, by explicit exception (DD-17 in the sysctx-skill-source plan — see
the new section below).** A pre-`2.22.0` hook doesn't send a payload *missing the new field*; it
sends no `harness-snapshot`/`harness-snapshot-ref` line at all, because that whole event replaced
`mcp-config` (and three siblings) outright. Its uploads still succeed, but the session binds to no
snapshot, `harness_mcp_per_tool_supported` is never touched for it, and `perToolDetailSupported`'s
absence in that case is really "no snapshot was reported", not "the probe didn't run" — the two
read the same in storage (the column is left unchanged either way) but have different causes.

---

## `snapshotId` / `snapshotFull` / `unknownSnapshotId` — harness snapshot query params (hook `2.22.0`+)

The harness-snapshot flow (DD-1–DD-9 in
`docs/tasks/done/2026-10-16-sysctx-skill-source/impl-plan.md`; see `hook-system-overview.md`'s
"Context injection" for the full shape and per-run flow) adds a fourth query param pair to
`POST /api/v2/logs`, on top of the existing `type`/`sessionId`/`parentSessionId`/`workflowRunId`
and the hook-`1.8.0`+ chunk params — see `docs/knowledgebase/api-reference.md` for the full
`PostLogsQuery` shape:

| Query param | Sent when | Server behaviour |
|---|---|---|
| `snapshotId` | Every upload of the current session's own `artisyn` file, hook `2.22.0`+ | Format-validated against `^[0-9a-f]{64}$` (`SNAPSHOT_ID_RE`); an invalid value is **silently ignored, never a `400`** — same "never break an old or malformed caller" posture as every other query param on this route |
| `snapshotFull=1` | Only when the body's `harness-snapshot` line is the FULL snapshot (the id was unknown to the hook) — a ref-only upload omits it | Gates `upload_queue.harness_snapshot_id` (set only when `snapshotFull==='1'` **and** `snapshotId` is valid) and gates whether the server will even consider answering `unknownSnapshotId` (see below) |

**`unknownSnapshotId` — the response half of the same loop.** Returned, additively, on the
single-upload response and the chunk-complete response only (never on an intermediate chunk,
never on a foreign-session response) when **all four** hold:

1. `snapshotId` is present and format-valid;
2. `snapshotFull !== '1'` (this was a ref-only upload — the server never asks back for what the
   same request just sent in full);
3. no `harness_snapshots` row exists yet for (this API key's `userId`, that id);
4. no `upload_queue` row exists for (`userId`, that id,
   `status IN ('pending','processing','partially_uploaded')`) either — a full snapshot upload still
   in flight also counts as "known", so the hook isn't told to resend something already on its way.

This is `isHarnessSnapshotKnown()` in `server/src/logs/harness-snapshot.ts`, called synchronously
inside `LogsV2Controller.postLogs()`.

**Why this needs a response field at all, unlike the plain-additive fields above.** Every other
field in this document is either purely additive on the request (safe to ignore by an old hook)
or purely additive on the response (safe to ignore by an old hook that doesn't read it). This one
is different: the *hook* needs the server's answer to decide whether to resend a potentially large
body next time, and the server has no other channel to tell it "I don't actually have that id" —
so, symmetrically with `warnings` (the `broken-upload-file` channel above),
`unknownSnapshotId` rides the same `201` JSON the hook already parses. An old hook (pre-`2.22.0`)
never sends `snapshotId`, so condition 1 above never holds for it and it never receives the field
— the same "old hook, new field absent" shape, just gated on the hook choosing to ask rather than
on its version.

**Hook-side consumption (DD-7, DD-19) — self-healing, not a retry.** `upload-logs.js` parses
`unknownSnapshotId` off the `201` body the same way it already parses `warnings`. On the hook side:

- On success with the **full** snapshot sent: the id is added to `harness-state.json`'s
  `knownSnapshotIds` (capped at `HARNESS_KNOWN_SNAPSHOTS_MAX = 20`, most-recent-first) — `rememberSnapshot()`.
- If the response's `unknownSnapshotId` equals the id this upload just sent (ref-only case): the id
  is removed from `knownSnapshotIds` — `forgetSnapshot()` — so the **next** upload of that session
  (the next `Stop`, or the next `prompt-upload-hook.js` run) treats the id as unknown again and
  resends the full body with `snapshotFull=1`.
- `recordSessionSnapshot()` always records the id just sent against the session id in
  `sessionSnapshots`, regardless of outcome — this is what lets `prompt-upload-hook.js` send a
  ref-only upload without ever touching the catalog or the MCP probe (DD-19).

**DD-21's accepted race:** a purge (`deleteOrphanHarnessSnapshots`) can delete the
`harness_snapshots` row between the controller's "known" answer on one upload and the ingest of a
later ref-only upload that relied on it. That session is then bound to an id with no row behind it.
The *next* upload of that session self-heals: the controller (re-checking fresh) now reports the id
unknown, the hook resends the full snapshot, and ingest re-stores the row. A session that never
uploads again simply stays without a usable snapshot — accepted, not fixed, since nothing queries
it again either.

**Pre-`2.22.0` hooks and this whole mechanism:** they send none of `snapshotId`/`snapshotFull`,
so `unknownSnapshotId` is never computed for their uploads (step 1 above fails immediately) and
every other part of this section is a no-op for them — their uploads succeed exactly as before,
with no snapshot bound to the session (DD-17).

---

## `git.root` / `git.worktreeRoot` and `code-inventory` — additive optional fields (hook `2.16.0`+)

Change surface (see [`change-surface.md`](change-surface.md)) needed three new pieces of data from
the hook. **All three are purely additive and optional**, following the same "old hook, new field
absent" shape as `perToolDetailSupported` above — no new route, no version-detection branching in
application code, and an un-updated install keeps uploading exactly what it always did.

### 1. Two new keys on the existing `git` object

`telemetry-hook.js` (`prompt_start`) and `lifecycle-hook.js` (`SessionStart`) already upload
`{ repo, branch, user }`. They now also upload:

| Key | Source | Why |
|---|---|---|
| `git.root` | `getGitRoot()` — `git rev-parse --git-common-dir` | The repo root of the machine that ran the session. Without it the server cannot tell a repo-relative path from an absolute one, so **no** path can be normalised |
| `git.worktreeRoot` | `git rev-parse --show-toplevel` | `--git-common-dir` deliberately returns the **primary** checkout's root, so a session run inside a *linked worktree* would otherwise have every path classified out-of-repo |

**`ARTISYN_PROJECT_ROOT` override (hook `2.23.0`+).** When the env variable is set and the session
`cwd` is inside it, `getGitRoot()` returns that directory instead of the `--git-common-dir` root
(`project-root-override.js`, applied in `resolveRootFromCommonDir`). The Claude sandbox launcher sets
it to the sandbox's linked worktree, so a sandbox upload has **`git.root` equal to
`git.worktreeRoot`** (both the worktree). This is not a format change — same keys, same types — and
the server needs no branch: `resolveSessionRepoRoots()` simply sees one root instead of two, and
paths inside the worktree still normalise. Without the variable (every host session, including a
host session inside a linked worktree) the values are exactly as above. See
[`docker-dev-container.md`](docker-dev-container.md).

The server extracts both with `extractGitRoots(lines)` — a copy of `extractGitBranch`'s shape — into
`logs.git_repo_root` / `logs.git_worktree_root`, exactly as `git_branch` is stored today. Note the
pre-existing shape: the uploaded `repo` is `git.remote || git.root`, so before this change the root
was only ever visible for a repo with no remote.

**Old-hook behaviour:** both columns stay `NULL`, `resolveSessionRepoRoots()` returns no candidate
roots, no changed path can be normalised, and `session_stats.cs_computed_at` stays `NULL` — which
every surface renders as **"No change-surface data"**, never as `0`. That is the intended
degradation: an old install reports nothing rather than something wrong.

### 2. A new `code-inventory` NDJSON event, on its own throttle

`send-logs-hook.js` prepends `{ type: 'code-inventory', projectRoot, trackedFiles, trackedLines,
trackedBinaryFiles, commitSha, branch, capturedAt }` to an upload when its own window has elapsed.
It is deliberately **not** hung off `getHarnessPrefix()`'s fingerprint (CLAUDE.md / skills / agents /
MCP config), which on a working repo almost never changes: this is a **denominator**, and a stale
denominator silently skews every percentage computed from it. A plain time window is the right gate
for a measurement of something that changes with every commit — and, unlike the harness prefix,
there is no once-per-session rule, so a long session legitimately reports a fresh snapshot per
window.

`buildCodeInventory()` returns `null` — never a partial or zeroed record — when the repo cannot be
measured (no git, not a repository, or the common case of a repo with no commits). No event is then
emitted, the server has no snapshot, and the report renders `n/a · denominator unavailable` rather
than a codebase of zero files that would make every percentage `Infinity` or `0 %`.

**Old-hook behaviour:** no event, no `repo_code_inventory` row, `n/a` on the two report indicators.
Every other change-surface figure still works.

### 3. `edit_result` on `PostToolUse`, and one retired field

The same release fixed `lifecycle-hook.js`'s `PostToolUse` branch to read the real payload key
(`input.tool_response`; `input.tool_result` has never existed on a Claude Code payload, so the old
`tool_result` field shipped as `""` on every event this hook has ever written). It is **retired**
rather than repointed: the payload holds file contents, patch text and command output, and the
metric needs four derived numbers, not the bytes.

In its place, `Edit` / `Write` / `MultiEdit` calls — and only those — carry
`edit_result: { filePath, added, removed, changeKind }`, derived **on the machine**. `structuredPatch`,
`originalFile` and every non-edit tool's result are never uploaded. `null` for anything else and for
an edit whose payload carries no countable diff, in which case the field is simply absent and the
call stays *uncovered* server-side rather than being recorded as a confident zero-line change.

This is the **only** source of `+`/`−` and `changeKind` for workflow-agent transcripts, whose
`toolUseResult` is never usable. Hook records are an input to extraction, never a patch applied to
an already-computed row: an un-updated install just falls back to `modified` with uncovered lines,
which is why `change_kind` must never be presented as diff *coverage*.

---

## Telemetry tail sweep and the top-level `cwd` field (hook `2.21.0`+)

Hook `2.21.0` changes two things that cross a version boundary. Neither adds a route, and both
follow the "old side, new field absent" shape above.

### 1. Top-level `cwd` on `prompt_start` / `SessionStart` when not in git

`telemetry-hook.js` (`prompt_start`) and `lifecycle-hook.js` (`SessionStart`) add a top-level
`cwd` field **only when `git` is null** (the folder is not a git repository). With a git context
the payload is byte-for-byte what it was.

| Combination | Behaviour |
|---|---|
| New hook → old server | The extra field is ignored; the session lands with no repository, as before |
| Old hook → new server | No `cwd`; a raw local path in an old hook's `git.repo` (a repo without a remote uploads `git.remote \|\| git.root`) is still recognised by `isRawLocalPath()` |
| New hook → new server | `extractRepoUrls()` (`artisyn-extractor.ts`) takes `git.repo`, else a string `line.cwd`; ingest maps a raw local path to the per-user local identity |

Both inputs end up on the **same** repository row, so mixing old and new hooks in one folder does
not split it. The identity format and the backfill are in [repo-identity.md](repo-identity.md).

### 2. Receiver ↔ uploader: `send-logs-hook.js --otel-sweep`

The receiver now spawns `send-logs-hook.js --otel-sweep --cwd <owner gitRoot>` after 60 s of quiet
and once before idle exit (see [otel-receiver.md](otel-receiver.md) § "Telemetry tail sweep"). This
is a contract between two files of the **same** plugin directory: the receiver launches the
uploader that sits next to it (`path.join(__dirname, 'send-logs-hook.js')`), so a receiver can only
ever start an uploader of its own version. A receiver older than `2.21.0` never sweeps, and its
chunks are shipped by the next `Stop` exactly as before. If the uploader file is missing the
receiver logs `sweep-skip` and carries on.

The same release moves the receiver to a neutral cwd (`os.tmpdir()`, passed by the launcher and
also `chdir`-ed into by the receiver itself, so an old launcher still gets it), drops writes when
the project's otel directory has disappeared (`dir-gone`) instead of recreating it, and adds the
prune guard (chunks whose upload failed this run are never pruned). None of these changes the
upload wire format, so the server needs no version detection.

---

## Call identity on `PostToolUseFailure` / `PermissionDenied` (hook `2.24.0`+)

An additive-field release; no route, no wire-format change, and the server needs no version detection.

- `PostToolUseFailure` adds `tool_use_id` (`input.tool_use_id || null`).
- `PermissionDenied` (split out of the shared `PermissionRequest` branch) adds `tool_use_id` and
  `reason` (`input.reason || null`). Claude Code fires it only for auto-mode classifier denials.
- `PermissionRequest` is unchanged: Claude Code sends no `tool_use_id` for it.

| Combination | Behaviour |
|---|---|
| New hook → old server / old client | The extra fields are ignored |
| Old hook → new client | No `tool_use_id` / `reason`; the viewer attributes the event to its tool call by name + input, as before |
| New hook on an older Claude Code | The fields are present but `null`; same name + input fallback |
| New hook → new client | The viewer joins the event to the call with that `tool_use_id` |

Both server readers of artisyn `tool_use_id` (`extractEditResultRecords` in `artisyn-extractor.ts`
and `change-surface/changed-paths.sql.ts`) filter to `PostToolUse`, so the new ids on other events
are never mistaken for edit records.

## `okfSnapshotId` / `okfSnapshotFull` / `unknownOkfSnapshotId` — OKF snapshot (hook `2.26.0`+)

The OKF usage tabs ([okf-usage.md](okf-usage.md); plan `docs/tasks/todo/2026-10-27-okf-usage-tab/`,
DD-13–DD-22) add a second, independent snapshot loop beside the harness one, with the same shape:

- **Body.** On the current root session's own `artisyn` upload (the `getHarnessPrefix` gate;
  `send-logs-hook.js` `getOkfPrefix()`), the hook prepends an `okf-snapshot-ref` line always and a
  full `okf-snapshot` line when the id is not in `okf-state.json`. Never on
  `prompt-upload-hook.js`, never on sub-agent or `claude` uploads. Detection runs only here, at
  upload time. Shape and id: [algorithms/okf-snapshot.md](algorithms/okf-snapshot.md). Neither line
  carries a `timestamp`; `artisyn-extractor.ts` lists both as non-activity lines.
- **Query.** `okfSnapshotId=<64 hex>` with the ref, plus `okfSnapshotFull=1` when the full line is
  in the body (`upload-logs.js` appends both independently of `snapshotId` / `snapshotFull`).

| Query param | Server behaviour |
|---|---|
| `okfSnapshotId` | Validated against `^[0-9a-f]{64}$` (`OKF_SNAPSHOT_ID_RE`); invalid → **silently ignored, never a `400`** |
| `okfSnapshotFull=1` | With a valid id, sets `upload_queue.okf_snapshot_id` (an in-flight full body counts as known) and suppresses `unknownOkfSnapshotId` |

**`unknownOkfSnapshotId`** (response, additive, single-upload and chunk-complete responses only) =
the id when it is valid, the upload was ref-only, and `isOkfSnapshotKnown()`
(`server/src/logs/okf/okf-snapshot.ts`) finds neither an `okf_snapshots` row for (user, id) nor a
`pending` / `processing` / `partially_uploaded` queue row with it. The hook then removes the id
from `okf-state.json` (`forgetOkfSnapshot`) so the next upload resends the full body; after a
successful full upload it remembers the id (`rememberOkfSnapshot`, cap 20). The accepted purge race
of the harness loop (DD-21 above) applies unchanged: a swept row self-heals on the next upload.

**Binding.** Ingest stores a full body per owner (`ON CONFLICT DO NOTHING`; a body over 10 MB is
ignored) and binds the root `sessions.okf_snapshot_id` only while it is `NULL` — the first upload of
a session decides, never rebound.

**Config.** Hook `2.26.0` adds the top-level `okf` key (`{ "exclude": [globs] }`, see
[hook-installation.md](hook-installation.md)). An older hook ignores the key; a newer
`log-hub.json` with it is harmless to it.

| Combination | Behaviour |
|---|---|
| Hook `< 2.26.0` → any server | No OKF lines or params: `okf_snapshot_id` stays `NULL`. The server still extracts `session_okf_access` from the transcripts; the session OKF tab shows the "No KB snapshot" banner and `partial_data` |
| Hook `2.26.0` → server without OKF support | Unknown query params are ignored and the two line types are skipped like any unknown artisyn event; the upload returns `201` without `unknownOkfSnapshotId`, so the hook simply remembers the id after its full upload and sends refs from then on (no effect on such a server) |
| Hook `2.26.0` → server with OKF support | Full loop as above |
| OKF detection fails or exceeds `OKF_SNAPSHOT_MAX_FILES` on the hook | The upload goes out without OKF lines; an OKF failure never fails an upload |

## `GET /api/v2/tool-monitoring/config` and the `tool-calls` log kind — CLI tool wrapper (hook `2.27.0`+)

The Tools/MCP tab ([tool-monitoring.md](tool-monitoring.md); plan
`docs/tasks/todo/2026-06-19-mcp-invocation-log-tab/`, DD-3, DD-5, DD-6, DD-16) adds one hook-facing
route and one upload log kind. Both are purely additive: no existing route, query param or line type
changes.

**Config route.** `GET /api/v2/tool-monitoring/config?repoUrl=<remote>` (`ApiKeyAuthGuard`,
`tool-monitoring-hook.controller.ts`). `repoUrl` is normalised with `normalizeRepoUrl` like every other
`repoUrl`-taking hook route; a missing one is a `400`, a missing or bad key a `401`. The answer is the
key's user's merged personal ∪ team list (DD-2):

```json
{ "schemaVersion": 1, "paused": false, "tools": [{ "name": "find", "capture": "full" }] }
```

An unknown repository answers `{ "schemaVersion": 1, "paused": false, "tools": [] }`, never a 404.

- **Versioning rule (FR-6).** The hook acts only on the `schemaVersion: 1` fields and ignores unknown
  fields, so a later server adds fields **without** bumping the version. The version is bumped only
  for a breaking change; a hook that sees an unknown version reads the answer as "no config".
- **Hook side** (`tool-wrap-config.js` `fetchToolWrapConfig`): fetched synchronously at
  `SessionStart` with `toolWrapConfigTimeoutMs` (default 2000) and refreshed on `UserPromptSubmit`
  at most once a minute with that timeout capped at 1000 ms (`PROMPT_CONFIG_REFRESH_TIMEOUT_MS`) (`claimThrottleSlot(cwd, 'tool-wrap-config.json', 60000)`). A non-200 answer,
  a timeout or a bad body reads as "no config": the hook keeps `<workDir>/tool-wrap/config-cache.json`
  and, without a cache, wraps nothing.

**`tool-calls` log kind.** `POST /api/v2/logs?type=tool-calls&sessionId=<root session id>` with an
NDJSON body assembled by `tool-wrap-records.js` (upload, chunking, gzip and the `.claude-logs.sent`
manifest are the ordinary ones; the manifest key is `tool-calls/<sessionId>`). The server keeps one
log per `(session_id, log_type)`, so every upload re-sends the session's whole cumulative set
(capped at 50 MB: past the cap the oldest calls lose their text, `textDropped: true`, and keep their
meta). Line types (DD-6; the server parses tolerantly in `tool-calls-log.ts` and ignores unknown
fields and unknown line types):

| Line | Fields |
|---|---|
| `tool_call` | `type`, `schema: 1`, `callId`, `sessionId`, `tool`, `args[]`, `real`, `cwd`, `shell` (`bash`/`powershell`), `startedAt`, `endedAt`/`exitCode`/`durationMs` (null = killed), `bytes {stdin, stdout, stderr}`, `consumerClosed`, `truncated`, `capture` (`full`/`meta`), `stdin?`/`stdout?`/`stderr?`, `encoding` (`utf8`/`base64`), `textDropped?` |
| `tool_wrap_status` | `type`, `schema: 1`, `hookVersion`, `os`, `preflight {ok, reason, shells {bash, powershell}}`, `breaker {global, tools[]}`, `at` |

On ingest a `tool-calls` upload (like `claude` / `claude-subagent`) only marks the session tree stale
(`sessions.tool_usage_version = NULL`, `logs.service.ts` Step 3d); the background drain rebuilds the
tree's `session_tool_usage` rows and merges the status line into `repositories.tool_wrap_status`.

**PreToolUse.** Hook `2.27.0` also registers `PreToolUse` (matcher `PowerShell`,
`tool-wrap-powershell.js`). It answers only with `hookSpecificOutput.updatedInput` (or nothing) and
never with a permission decision — no server contract is involved.

| Combination | Behaviour |
|---|---|
| Hook `< 2.27.0` → any server | Never calls the config route and uploads no `tool-calls` log. The tab still shows every MCP call and transcript-only CLI calls (hint `no_wrapper`); a configured tool shows the hint `hook_too_old` while the owners' `repositories.tool_wrap_status` is `NULL` |
| Hook `2.27.0` → server without the route (`404`) | "No config": the cached list is used when one exists (e.g. a downgraded server), else nothing is wrapped and no `tool-calls` log is produced |
| Hook `2.27.0` with a cache → server unreachable / timeout | The cached list is used (fail open); the session is never delayed beyond `toolWrapConfigTimeoutMs` |
| `tool-calls` upload → server without Tools/MCP support | `type=tool-calls` is an unknown kind: stored as an inert generic `logs` row (`logs-v2.controller.ts`), nothing reads it. When that server is upgraded, migration `0076` leaves every session's `tool_usage_version` `NULL`, so the drain rebuilds every tree and picks the stored rows up |
| Hook `2.27.0` → server with Tools/MCP support | Full loop as above |
| Config answer with `schemaVersion` ≠ 1 | Read as "no config", like a non-200: the cached schema-1 list is used when one exists, else nothing is wrapped |


## v1 retirement (done, open-source readiness)

The two-route split was scaffolding for a safe rollout. It was retired in the open-source readiness
task:

- `LogsController.postLogs` and its private `stripNullChars` copy were deleted. The queue worker
  parses with `server/src/logs/ndjson-parser.ts`, and `LogsService.upsert()` stays because the
  worker calls it.
- `api/v1/logs` was dropped from `LOG_INGEST_ROUTES`, which `AppModule` (gzip sniffer, global-parser
  exclusion) and `LogsModule` (log body parsers) both read. `POST /api/v1/logs` now returns `404`.
- `LogsController` keeps `POST /api/v1/log-echo` (API-key check, called by
  `artisyn-hooks-installer/src/install.ts`).
- Tests upload through `POST /api/v2/logs`: Playwright seeding
  via `tests/e2e/helpers/seed.ts` + `waitForUploadQueueDrained()` (`tests/e2e/helpers/db.ts`), and the
  perf harness (`server/perf-tests/`) via v2 scenarios.
- The changelog's `Open-source readiness` entry tells operators that hooks older than `1.7.0` stop
  uploading and must be upgraded.
