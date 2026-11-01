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

```examples
[
  {"id": "SR-01", "input": {"kind": "route", "sessionId": null, "signal": "logs"}, "expected": {"action": "pending", "key": "__none__"}, "note": "Rule 1: no session id -> pending under __none__"},
  {"id": "SR-02", "input": {"kind": "route", "sessionId": "../x", "signal": "logs"}, "expected": {"action": "pending", "key": "__none__"}, "note": "Rule 1: '/' fails the id pattern -> __none__"},
  {"id": "SR-03", "input": {"kind": "route", "sessionId": "s1", "signal": "logs", "entry": {"sessionId": "s1", "gitRoot": "/repos/a", "otelDir": "/repos/a/otel", "repoKey": "aaaaaaaaaaaaaaaa", "signals": {"logs": true, "metrics": true, "spans": false}}}, "expected": {"action": "route", "via": "registry", "repoKey": "aaaaaaaaaaaaaaaa"}, "note": "Rule 2: entry, signals.logs true -> registry route to repo a"},
  {"id": "SR-04", "input": {"kind": "route", "sessionId": "s1", "signal": "spans", "entry": {"sessionId": "s1", "gitRoot": "/repos/a", "otelDir": "/repos/a/otel", "repoKey": "aaaaaaaaaaaaaaaa", "signals": {"logs": true, "metrics": true, "spans": false}}}, "expected": {"action": "drop", "reason": "dropped-signal", "repoKey": "aaaaaaaaaaaaaaaa"}, "note": "Rule 2: signals.spans false -> drop, counted for repo a"},
  {"id": "SR-05", "input": {"kind": "route", "sessionId": "s1", "signal": "logs", "repoAttr": "bbbbbbbbbbbbbbbb", "entry": {"sessionId": "s1", "gitRoot": "/repos/a", "otelDir": "/repos/a/otel", "repoKey": "aaaaaaaaaaaaaaaa", "signals": {"logs": true}}, "repos": [{"repoKey": "bbbbbbbbbbbbbbbb", "gitRoot": "/repos/b", "otelDir": "/repos/b/otel", "traces": true}]}, "expected": {"action": "route", "via": "registry", "repoKey": "aaaaaaaaaaaaaaaa"}, "note": "Rule 2 before rule 3: the tag names repo b, the registration repo a -> register wins"},
  {"id": "SR-06", "input": {"kind": "route", "sessionId": "s1", "signal": "metrics", "repoAttr": "aaaaaaaaaaaaaaaa", "repos": [{"repoKey": "aaaaaaaaaaaaaaaa", "gitRoot": "/repos/a", "otelDir": "/repos/a/otel", "traces": false}]}, "expected": {"action": "route", "via": "tag", "repoKey": "aaaaaaaaaaaaaaaa"}, "note": "Rule 3: no entry, tag matches repos.json, metrics always allowed"},
  {"id": "SR-07", "input": {"kind": "route", "sessionId": "s1", "signal": "spans", "repoAttr": "aaaaaaaaaaaaaaaa", "repos": [{"repoKey": "aaaaaaaaaaaaaaaa", "gitRoot": "/repos/a", "otelDir": "/repos/a/otel", "traces": false}]}, "expected": {"action": "drop", "reason": "dropped-signal", "repoKey": "aaaaaaaaaaaaaaaa"}, "note": "Rule 3: spans need traces:true; false -> drop"},
  {"id": "SR-08", "input": {"kind": "route", "sessionId": "s1", "signal": "spans", "repoAttr": "aaaaaaaaaaaaaaaa", "repos": [{"repoKey": "aaaaaaaaaaaaaaaa", "gitRoot": "/repos/a", "otelDir": "/repos/a/otel", "traces": true}]}, "expected": {"action": "route", "via": "tag", "repoKey": "aaaaaaaaaaaaaaaa"}, "note": "Rule 3: traces:true -> spans routed by tag"},
  {"id": "SR-09", "input": {"kind": "route", "sessionId": "s1", "signal": "logs", "repoAttr": "AAAAAAAAAAAAAAAA", "repos": [{"repoKey": "aaaaaaaaaaaaaaaa", "gitRoot": "/repos/a", "otelDir": "/repos/a/otel"}]}, "expected": {"action": "route", "via": "tag", "repoKey": "aaaaaaaaaaaaaaaa"}, "note": "Rule 3: the tag is compared lowercased"},
  {"id": "SR-10", "input": {"kind": "route", "sessionId": "s1", "signal": "logs", "repoAttr": "cccccccccccccccc", "repos": [{"repoKey": "aaaaaaaaaaaaaaaa", "gitRoot": "/repos/a", "otelDir": "/repos/a/otel"}]}, "expected": {"action": "pending", "key": "s1"}, "note": "Rule 4: tag names no listed repo -> pending under the session id"},
  {"id": "SR-11", "input": {"kind": "route", "sessionId": "s1", "signal": "logs"}, "expected": {"action": "pending", "key": "s1"}, "note": "Rule 4: no entry, no tag -> pending"},
  {"id": "SR-12", "input": {"kind": "route", "sessionId": "s1", "signal": "metrics", "entry": {"sessionId": "s1", "gitRoot": "/repos/a", "otelDir": "/repos/a/otel", "repoKey": "aaaaaaaaaaaaaaaa"}}, "expected": {"action": "drop", "reason": "dropped-signal", "repoKey": "aaaaaaaaaaaaaaaa"}, "note": "Rule 2: entry without signals -> signals[metrics] is not true -> drop"},
  {"id": "SR-13", "input": {"kind": "signals", "value": null}, "expected": {"logs": true, "metrics": true, "spans": false}, "note": "Signals: non-object = {} -> logs, metrics on; spans off"},
  {"id": "SR-14", "input": {"kind": "signals", "value": {"logs": false, "spans": true}}, "expected": {"logs": false, "metrics": true, "spans": true}, "note": "Signals: logs exactly false -> off; metrics absent -> on; spans true -> on"},
  {"id": "SR-15", "input": {"kind": "signals", "value": {"metrics": 0, "spans": "yes"}}, "expected": {"logs": true, "metrics": true, "spans": false}, "note": "Signals: 0 is not exactly false -> metrics on; 'yes' is not exactly true -> spans off"},
  {"id": "SR-16", "input": {"kind": "spool", "adds": [{"key": "s1", "count": 3, "at": 0}], "take": "s1", "now": 1000}, "expected": {"taken": 3, "remaining": 0, "expired": 0, "overflow": 0}, "note": "Spool: 3 records 1 s old, all within TTL -> all 3 taken"},
  {"id": "SR-17", "input": {"kind": "spool", "adds": [{"key": "s1", "count": 1, "at": 0}], "take": "s1", "now": 299999}, "expected": {"taken": 1, "remaining": 0, "expired": 0, "overflow": 0}, "note": "Spool: age 299999 < 300000 -> still taken"},
  {"id": "SR-18", "input": {"kind": "spool", "adds": [{"key": "s1", "count": 1, "at": 0}], "take": "s1", "now": 300000}, "expected": {"taken": 0, "remaining": 0, "expired": 1, "overflow": 0}, "note": "Spool: age 300000 >= TTL -> expired and counted, nothing taken"},
  {"id": "SR-19", "input": {"kind": "spool", "adds": [{"key": "s1", "count": 5001, "at": 0}], "take": "s1", "now": 1000}, "expected": {"taken": 5000, "remaining": 0, "expired": 0, "overflow": 1}, "note": "Spool: 5001st record on a full spool (5000) drops the oldest -> overflow 1, 5000 taken"},
  {"id": "SR-20", "input": {"kind": "spool", "adds": [{"key": "s1", "count": 2, "at": 0}, {"key": "s2", "count": 3, "at": 0}], "take": "s1", "now": 1000}, "expected": {"taken": 2, "remaining": 3, "expired": 0, "overflow": 0}, "note": "Spool: take s1 removes only its 2 records; s2's 3 stay"},
  {"id": "SR-21", "input": {"kind": "register", "payload": {"gitRoot": "/repos/a", "otelDir": "/repos/a/otel", "hookVersion": "2.30.0"}}, "expected": {"ok": false, "reason": "sessionId missing"}, "note": "Register rule 1: no sessionId"},
  {"id": "SR-22", "input": {"kind": "register", "payload": {"sessionId": "s1", "gitRoot": "repos/a", "otelDir": "/repos/a/otel", "hookVersion": "2.30.0"}}, "expected": {"ok": false, "reason": "gitRoot invalid"}, "note": "Register rule 2: relative gitRoot"},
  {"id": "SR-23", "input": {"kind": "register", "payload": {"sessionId": "s1", "gitRoot": "/repos/a", "otelDir": "/repos/a/otel"}}, "expected": {"ok": false, "reason": "hookVersion missing"}, "note": "Register rule 3: no hookVersion"},
  {"id": "SR-24", "input": {"kind": "register", "payload": {"sessionId": "s1", "gitRoot": "/repos/no-such-repo", "otelDir": "/repos/no-such-repo/otel", "hookVersion": "2.30.0", "uploader": "/repos/no-such-repo/send-logs-hook.js"}}, "expected": {"ok": false, "reason": "uploader-not-allowed"}, "note": "Register rule 4: the uploader file does not exist (no realpath)"},
  {"id": "SR-25", "input": {"kind": "register", "createUploader": "evil.js", "payload": {"sessionId": "s1", "hookVersion": "2.30.0"}}, "expected": {"ok": false, "reason": "uploader-not-allowed"}, "note": "Register rule 4: an existing file under gitRoot, but not named send-logs-hook.js"},
  {"id": "SR-26", "input": {"kind": "register", "createUploader": "send-logs-hook.js", "payload": {"sessionId": "s1", "hookVersion": "2.30.0"}}, "expected": {"ok": true, "uploaderSet": true}, "note": "Register rule 4: existing send-logs-hook.js inside gitRoot -> accepted"},
  {"id": "SR-27", "input": {"kind": "register", "payload": {"sessionId": "s1", "gitRoot": "/repos/a", "otelDir": "/repos/a/otel", "hookVersion": "2.30.0", "repoKey": "xyz", "extra": 1}}, "expected": {"ok": true, "contract": 1, "repoKeyLength": 16, "uploaderSet": false, "signals": {"logs": true, "metrics": true, "spans": false}}, "note": "Register rule 5: no contract -> 1; 'xyz' is not 16 hex -> recomputed 16 chars; default signals; unknown field ignored"},
  {"id": "SR-28", "input": {"kind": "forwardHeaders", "headers": {"Host": "127.0.0.1:30000", "Connection": "keep-alive", "Content-Length": "10", "Transfer-Encoding": "chunked", "X-Artisyn-Auth": "v1 n m", "Content-Type": "application/json", "Authorization": "Bearer t", "x-honeycomb-team": "k"}}, "expected": {"content-type": "application/json", "authorization": "Bearer t", "x-honeycomb-team": "k"}, "note": "Headers: host, connection, content-length, transfer-encoding, x-artisyn-* dropped; others lowercased and kept in order"},
  {"id": "SR-29", "input": {"kind": "forwardHeaders", "headers": {"x-multi": ["a", "b"], "x-none": null, "x-num": 5}}, "expected": {"x-multi": ["a", "b"]}, "note": "Headers: an array of strings is kept; null and a number are skipped"},
  {"id": "SR-30", "input": {"kind": "forwardHeaders", "headers": null}, "expected": {}, "note": "Headers: non-object input -> {}"},
  {"id": "SR-31", "input": {"kind": "forwardHealth", "stats": null, "now": 1000000}, "expected": {"forward": "off"}, "note": "Health: no stats -> off"},
  {"id": "SR-32", "input": {"kind": "forwardHealth", "stats": {"enabled": true, "lastDropAt": null, "lastRetryAt": null}, "now": 1000000}, "expected": {"forward": "ok"}, "note": "Health: enabled, no drop or retry -> ok"},
  {"id": "SR-33", "input": {"kind": "forwardHealth", "stats": {"enabled": true, "lastDropAt": 700001}, "now": 1000000}, "expected": {"forward": "degraded"}, "note": "Health: drop 299999 ms ago < 300000 -> degraded"},
  {"id": "SR-34", "input": {"kind": "forwardHealth", "stats": {"enabled": true, "lastRetryAt": 700000}, "now": 1000000}, "expected": {"forward": "ok"}, "note": "Health: retry exactly 300000 ms ago is outside the window -> ok"},
  {"id": "SR-35", "input": {"kind": "forwardHealth", "stats": {"enabled": false, "lastDropAt": 999999}, "now": 1000000}, "expected": {"forward": "off"}, "note": "Health: not enabled -> off, whatever the drops"},
  {"id": "SR-36", "input": {"kind": "forwardHealth", "stats": {"enabled": true, "lastDropAt": "2026-10-31T00:01:00.000Z"}, "now": "2026-10-31T00:05:00.000Z"}, "expected": {"forward": "degraded"}, "note": "Health: ISO timestamps, 240000 ms ago < 300000 -> degraded"},
  {"id": "SR-37", "input": {"kind": "forwardBackoff", "attempts": 1}, "expected": {"delayMs": 1000}, "note": "1000 * 2^0 = 1000"},
  {"id": "SR-38", "input": {"kind": "forwardBackoff", "attempts": 3}, "expected": {"delayMs": 4000}, "note": "1000 * 2^2 = 4000"},
  {"id": "SR-39", "input": {"kind": "forwardBackoff", "attempts": 6}, "expected": {"delayMs": 32000}, "note": "1000 * 2^5 = 32000 < 60000"},
  {"id": "SR-40", "input": {"kind": "forwardBackoff", "attempts": 7}, "expected": {"delayMs": 60000}, "note": "1000 * 2^6 = 64000 -> capped at 60000"}
]
```

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
