---
reviewed: no
reviewer: none
---

# OTEL shared receiver routing

## Purpose

Since hook `2.30.0` one OTEL receiver per OS user serves every repo of that user. Each record
Claude Code exports must land in the right repo's OTEL directory — otherwise one repo's telemetry
would be uploaded under another repo's API key — and records of a session that has not registered
yet must wait briefly instead of being lost. The same rules decide which registrations are accepted
(the receiver spawns the registered uploader, so it must never run an arbitrary file) and what is
forwarded to a user's own collector in `proxy` mode.

## Code

- Implementation: `hook/.claude/telemetry_tool/otel-receiver.js` — `routeRecord`,
  `parseReposFile`, `normalizeSignals`, `validateRegisterPayload` (with `isAllowedUploader`),
  the pending spool (`addPending`, `takePending`, `pendingSpool`; constants `PENDING_TTL_MS` =
  300000, `PENDING_MAX_RECORDS` = 5000, `PENDING_NO_SESSION_KEY` = `"__none__"`),
  `forwardHeaders`, `forwardHealth` (`FORWARD_DEGRADED_WINDOW_MS` = 300000) and `forwardBackoffMs`
  (`FORWARD_BACKOFF_MIN_MS` = 1000, `FORWARD_BACKOFF_MAX_MS` = 60000).
- The spool functions are module-internal state; the table test reaches them through a test seam
  (exported spool helpers, reset between rows) — the spool rows need `addPending`, `takePending`
  and `pendingSpool`.
- Twins: none (the installer has no routing).
- Test: `hook/.claude/telemetry_tool/__tests__/otel-shared-routing.algo.test.js`.
- Design: [../otel-receiver.md](../otel-receiver.md) § "Per-record routing and the pending spool"
  and § "Forwarding to a foreign collector".

## Input and output

Every row has `input.kind`, which picks the function:

| `kind` | Call | Compared |
|---|---|---|
| `route` | `routeRecord({sessionId, signal, repoAttr, entry, repos: parseReposFile({repos})})`; missing fields are `null`, `repos` defaults to `[]` | `{action, via?, reason?, key?, repoKey?}` — `repoKey` is the decision's `target.repoKey` |
| `signals` | `normalizeSignals(value)` | the returned object |
| `spool` | an empty spool; for each `adds[]` item, `addPending(count records of session key, at)`; then `takePending(take, now)` | `{taken, remaining, expired, overflow}` — taken count, records left, spool's `expired` and `overflow` counters |
| `register` | `validateRegisterPayload(payload, null)`; with `createUploader: <name>` the test first makes a temp dir with an empty `send-logs-hook.js` (and a file `<name>`), sets `gitRoot` to it, `otelDir` under it and `uploader` to `<tmp>/<name>` | `{ok, reason}` on failure; on success `{ok, signals, contract, repoKeyLength, uploaderSet}` |
| `forwardHeaders` | `forwardHeaders(headers)` | the whole returned object, exactly |
| `forwardHealth` | `forwardHealth(stats, now)` | `{forward}` |
| `forwardBackoff` | `forwardBackoffMs(attempts)` | `{delayMs}` |

Repo keys in the rows are 16 lowercase hex characters (`aaaa…`, `bbbb…`); paths such as
`/repos/a` are absolute on every platform `path.isAbsolute` runs on.

## Rules

**Routing** (`routeRecord`), per record, first match wins:

1. The session id must match `^[A-Za-z0-9._-]{1,128}$`. No usable id → `pending` under the key
   `"__none__"` (it can only expire).
2. A live registry entry for the session → `route` with `via:'registry'` to that entry's repo when
   `entry.signals[signal] === true`, else `drop` with `reason:'dropped-signal'`. An `artisyn.repo`
   tag is not looked at: **register wins**.
3. Else an `artisyn.repo` resource tag (compared lowercased) equal to the `repoKey` of a
   `repos.json` entry → `route` with `via:'tag'` for `logs` and `metrics`, and for `spans` only when
   that entry has `traces: true`; any other signal → `drop`, `dropped-signal`.
4. Else → `pending` under the session id.

`parseReposFile` keeps only entries with a 16-hex `repoKey` (lowercased) and absolute `gitRoot` and
`otelDir`.

**Signals** (`normalizeSignals`): `logs` and `metrics` are on unless exactly `false`; `spans` is on
only when exactly `true`. A non-object value counts as `{}`.

**Pending spool**: records are kept in arrival order. Before each add and each take, records with
`now − at ≥ PENDING_TTL_MS` (300000 ms) are dropped from the front and counted in `expired`. On
add, when the spool already holds `PENDING_MAX_RECORDS` (5000), the oldest record is dropped for
each new one and counted in `overflow`. `takePending(sessionId, now)` removes and returns that
session's records; other sessions' records stay.

**Register validation** (`validateRegisterPayload`), first failure wins:

1. `sessionId` missing (`undefined`, `null`, `''`) → `sessionId missing`; failing the id pattern →
   `sessionId invalid`.
2. `gitRoot`, then `otelDir`: missing → `<field> missing`; not a non-empty absolute path string →
   `<field> invalid`.
3. `hookVersion` missing → `hookVersion missing`; not a non-empty string → `hookVersion invalid`.
4. `uploader` present → allowed only when it is an absolute path, its basename and its realpath's
   basename are `send-logs-hook.js`, it is an existing file, and its realpath lies inside the
   realpath of `gitRoot` (or of `<ownerHome>/.claude/plugins/`). Otherwise
   `uploader-not-allowed`.
5. Accepted: `contract` = the sent integer or `1`; `repoKey` = the sent value lowercased when it is
   16 hex, else recomputed from `gitRoot` (always 16 chars); `signals` normalized as above.

**Forward headers** (`forwardHeaders`): every incoming header, name lowercased, except `host`,
`connection`, `content-length`, `transfer-encoding` and any `x-artisyn-*`; string values and arrays
of strings are kept, anything else (e.g. `undefined`) is skipped. A non-object input → `{}`.

**Forward health** (`forwardHealth`): `off` unless `stats.enabled === true`; `degraded` when
`lastDropAt` or `lastRetryAt` (epoch ms or ISO) is less than `FORWARD_DEGRADED_WINDOW_MS`
(300000 ms) before `now`; else `ok`.

**Forward backoff** (`forwardBackoffMs`): before retry number `attempts` (1-based),
`min(FORWARD_BACKOFF_MIN_MS · 2^(attempts−1), FORWARD_BACKOFF_MAX_MS)` = `min(1000 · 2^(attempts−1), 60000)`.

## Edge cases

- No or invalid session id: SR-01, SR-02.
- Register wins over a conflicting tag: SR-05. Entry without `signals`: SR-12.
- Tag routing per signal and `traces`: SR-06, SR-07, SR-08; upper-case tag: SR-09; unknown tag and
  no tag: SR-10, SR-11.
- Signal defaults: SR-13, SR-14, SR-15.
- Spool TTL on both sides of the boundary: SR-17, SR-18; overflow: SR-19; other sessions kept:
  SR-20.
- Register field order and messages: SR-21, SR-22, SR-23; uploader rules: SR-24, SR-25, SR-26;
  defaults and recomputed `repoKey`: SR-27.
- Header filtering: SR-28, SR-29, SR-30.
- Health window on both sides, disabled and ISO timestamps: SR-31 … SR-36.
- Backoff growth and cap: SR-37 … SR-40.

## Examples

Rows (40): [`docs/algorithm-examples/otel-shared-routing.json`](../../algorithm-examples/otel-shared-routing.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- "The tag is checked before the registration" -> SR-05.
- "Tag routing forwards spans regardless of `traces`" -> SR-07.
- "Tag compared case-sensitively" -> SR-09.
- "`spans` defaults to on, like logs and metrics" -> SR-13.
- "TTL compared with `>` instead of `>=`" -> SR-18.
- "No spool cap" (5001 taken, overflow 0) -> SR-19; "take removes every session's records" ->
  SR-20.
- "Uploader checked by basename only, not existence" -> SR-24; "any file under gitRoot is allowed"
  -> SR-25.
- "`x-artisyn-*` forwarded upstream" (would leak the auth MAC) -> SR-28.
- "Degraded window inclusive at 5 min" -> SR-34.
- "No backoff cap" -> SR-40.

## Where the result is visible

Which repo's OTEL tabs show a session's data, and that no repo shows another's; the
`ingest repo=…`, `pending-overflow`, `pending-expire`, `forward …` lines in
`~/.artisyn/otel/receiver.log`; `400 {reason:'uploader-not-allowed'}` on register; the `forward`
field of `session-status` and of the session's `otel-status` (session OTEL tab status line).
