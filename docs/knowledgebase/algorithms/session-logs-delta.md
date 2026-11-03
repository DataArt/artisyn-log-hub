---
reviewed: no
reviewer: none
---

# Session logs delta: cursor, row classification, growth check

## Purpose

The Session Map tab polls `GET /api/v1/repositories/:repoId/sessions/:sessionId/logs/delta`
every few seconds while a session is live. Each poll must return only the transcript lines the
client does not hold yet, and a poll where nothing moved must not read any `logs.body`. When a
log was rewritten instead of appended to, the client must reload instead of silently showing a
broken transcript. These rules decide what the client holds (the cursor), which log rows have
to be read, and whether a changed row only grew.

## Code

- Implementation: `server/src/logs/session-logs-delta.ts` (`encodeDeltaCursor`,
  `decodeDeltaCursor`, `classifyDeltaRows`, `checkGrowth`, `DELTA_CURSOR_MAX_CHARS`). The SQL
  around them (tree metadata, slices, fingerprints) is in
  `server/src/logs/session-logs-delta.service.ts`.
- Twins: none. The fingerprint `left(md5((body -> (n-1))::text), 12)` is computed in SQL by the
  service, never in TypeScript.
- Test: `server/src/logs/session-logs-delta.algo.spec.ts`.

## Input and output

A **cursor row** is `{sid, t, ut, n, fp}`:

- `sid` — internal `sessions.id` (a number);
- `t` — log type code: `a` artisyn, `c` claude, `s` claude-subagent;
- `ut` — `logs.updated_at` as epoch microseconds in base 36, compared for equality only;
- `n` — the number of lines the client holds;
- `fp` — the 12-hex-character fingerprint of line `n-1`, `''` when `n = 0`.

A **current row** is `{sid, t, ut}`: the metadata of one log row of the session tree, never its
body.

## Rules

### Cursor codec

1. `encodeDeltaCursor(rows)` = `base64url(JSON.stringify({v: 1, r: [[sid, t, ut, n, fp], …]}))`,
   with `sid` written in base 36. When the result is longer than `DELTA_CURSOR_MAX_CHARS`
   (12 000) it is `''` instead.
2. `decodeDeltaCursor(raw)` reverses rule 1. The result is the **empty cursor** (`[]`, which
   makes the server answer a full snapshot) when any of these holds:
   - `raw` is missing or `''`;
   - `raw` is longer than `DELTA_CURSOR_MAX_CHARS` or has a character outside base64url
     (`A-Z a-z 0-9 _ -`);
   - the decoded text is not JSON, or not an object;
   - `v` is not `1`, or `r` is not an array;
   - **any** entry is bad: not an array of exactly 5, `sid` not a base-36 string, `t` not one of
     `a c s`, `ut` not a base-36 string, `n` not a non-negative safe integer, `fp` longer than 12
     or not lowercase hex, or `n = 0` and `fp ≠ ''` (or `n > 0` and `fp = ''`).

   A decode never fails the request.

### Row classification

`classifyDeltaRows(cursor, current, tree)` puts every row into exactly one bucket. The key of a
row is `sid:t`.

1. Walk the cursor rows in order; a key seen before is skipped (a duplicated entry counts once).
2. A cursor row is **stale** when its `sid` is not in `tree`, or there is no current row with its
   key.
3. Otherwise it is **unchanged** when the current `ut` equals the cursor `ut`, and **changed**
   when it differs.
4. A current row whose key is not in the cursor is **new**.

Only `changed` and `new` rows ever have their body read, so a poll where every row is unchanged
reads no `logs.body`. Any stale row makes the server answer `reload`.

### Growth check

`checkGrowth(prevN, prevFp, newLen, fpAtPrevN)` runs after reading a changed row; `fpAtPrevN` is
the fingerprint of line `prevN-1` of the current body.

1. `newLen < prevN` → `stale` (the body shrank).
2. `fpAtPrevN ≠ prevFp` → `stale` (the line the client holds last was replaced).
3. Otherwise → `append`: the server returns `body[prevN:]`, which is empty when
   `newLen = prevN`.

## Edge cases

- Encode / decode round trip of every type code: SLD-01; `sid` in base 36: SLD-02.
- Empty cursor on: bad base64url (SLD-03), not JSON (SLD-04), unknown `v` (SLD-05), `r` not an
  array (SLD-06), one bad entry among good ones (SLD-07), `n = 0` with a fingerprint (SLD-08),
  an over-long input (SLD-09), `''` (SLD-10).
- An encoded cursor over the limit is `''`; under it, it is not: SLD-11, SLD-12.
- Classification: unchanged SLD-13, changed SLD-14, new SLD-15, stale because the `sid` left the
  tree although a current row is still there SLD-16, stale because the row is gone SLD-17, a
  duplicated cursor entry SLD-18.
- All unchanged → `changed` and `new` empty (the empty-poll no-body guarantee): SLD-19.
- Growth: grown SLD-20, same length and fingerprint (no lines) SLD-21, shorter SLD-22, last line
  replaced SLD-23.

## Examples

Each row's `input.op` picks the call:

- `roundtrip` — `input.rows` (cursor rows) are encoded and the result decoded; `expected.rows`
  is the decoded list.
- `decode` — the raw string is `input.raw`; or `input.json` (any JSON) which the test turns into
  `base64url(JSON.stringify(json))`; or `input.repeat` = `{char, count}`, the character repeated
  `count` times. `expected.rows` is the decoded list.
- `encode` — `input.count` copies of `input.row`, the k-th (1-based) with `sid = k`, are
  encoded; `expected.empty` says whether the cursor is `''`.
- `classify` — `input.cursor` (cursor rows), `input.current` (current rows), `input.tree` (sids);
  `expected` lists each bucket as `sid:t` keys in result order.
- `growth` — `input` = `{prevN, prevFp, newLen, fpAtPrevN}`; `expected.growth` is the verdict.

Rows (23): [`docs/algorithm-examples/session-logs-delta.json`](../../algorithm-examples/session-logs-delta.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- "One bad entry is dropped instead of emptying the cursor" -> SLD-07.
- "Unknown version decoded anyway" -> SLD-05.
- "Classification by key only, ignoring whether the sid is still in the tree" -> SLD-16.
- "A cursor row without a current row ignored instead of stale" -> SLD-17.
- "Duplicated cursor entries counted twice" -> SLD-18.
- "Growth checks only the length" -> SLD-23; "checks `newLen ≤ prevN` as stale" -> SLD-21.

## Where the result is visible

API `GET …/sessions/:sessionId/logs/delta`: `cursor`, `reload`, `rootArtisynLines`,
`rootClaudeLines`, `subagentAppends`, `newSubagents`. On screen: the Session Map tab grows
without a reload while the session is live, and reloads its data after `reload: true`.
