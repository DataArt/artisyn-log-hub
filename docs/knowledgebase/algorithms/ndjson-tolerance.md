---
reviewed: 2026-10-15
reviewer: ai
---

# NDJSON tolerance: how torn log lines are handled

## Purpose

A session's `.jsonl` log is appended by several hook processes without a lock, so a killed or
interleaved write can leave a broken line in it. One broken line must not lose the whole session.
Two rules handle it: the hook drops unparseable lines before upload (and logs each one), and the
server, for older hooks that upload as-is, accepts a body with up to 10% broken lines and rejects
a body that is mostly garbage.

## Code

- Implementation:
  - hook: `hook/.claude/telemetry_tool/ndjson-sanitize.js` (`sanitizeNdjson`);
  - server: `server/src/logs/ndjson-parser.ts` (`parseNdjsonLinesTolerant`,
    `MAX_DROPPED_LINE_RATIO = 0.1`).
- Callers behind "Where the result is visible" (not part of the rule): the hook's
  `send-logs-hook.js` and `prompt-upload-hook.js` (log the drops, skip an all-dropped upload)
  and the server's `upload-queue-scheduler.service.ts` (fails the queue row or logs the drops).
- Twins: none. The two are different rules for different stages, not copies; each test runs only
  the rows of its own `side`.
- Tests:
  - `hook/.claude/telemetry_tool/__tests__/ndjson-tolerance.algo.test.js` (`side: hook`);
  - `server/src/logs/ndjson-parser.algo.spec.ts` (`side: server`).

The header comment of `ndjson-sanitize.js` still calls the server "all-or-nothing"; that
predates the tolerant parser below and is out of date.

## Rules

A body is split into lines on `\n` only. A line is **blank** if it is empty after JavaScript
`trim()` (which also removes `\r`, so CRLF files work, plus no-break spaces and a BOM), **valid**
if its trimmed text parses as JSON (any JSON value, including a bare number or string), and
**malformed** otherwise.

**Hook (`sanitizeNdjson`)**, before every upload:

1. Lines are counted from 1; a final line without `\n` is still a line, and the empty rest after
   a trailing `\n` is not. `lines` is that count (`0` for an empty body).
2. Blank and valid lines are kept byte for byte, with their own `\n` (or without one, if they
   had none).
3. Every malformed line is dropped and reported with its line number, byte length, parser
   error and the first 120 characters (`SNIPPET_CHARS`) of its text.
4. If nothing was dropped the very same body is returned, unchanged. Blank lines always survive,
   so the body is empty only if every line was malformed (the caller decides what to do then).

**Server (`parseNdjsonLinesTolerant`)**, when the upload queue ingests a body:

5. Lines are numbered from 1 over `body.split('\n')`; `totalLines` is the number of pieces, so a
   trailing `\n` adds one (empty) piece.
6. Blank lines are skipped and do not count. Valid lines are kept, malformed lines are dropped.
   As on the hook, any JSON value is valid, a bare number or string included.
7. With `dropped` malformed and `nonBlank = kept + dropped`: if `dropped > nonBlank * 0.1`
   (strictly more than 10%), the whole body is rejected with
   `Malformed NDJSON: invalid JSON line <first bad line> of <totalLines> (<chars> chars): <error>`,
   where `<chars>` is the length of that line's trimmed text in UTF-16 code units and `<error>` is the parser's message
   without V8's own `(line N column M)` suffix, cut to 300 characters.
8. Otherwise, if no line was kept, the body is rejected with
   `Body contains no valid NDJSON lines`.
9. Otherwise the body is accepted with the kept lines (U+0000 characters are removed from every
   parsed string value and object key, since Postgres JSONB cannot store them). Strings and keys are
   cleaned at every depth (inside arrays and nested objects too). Keys that become equal after
   cleaning collapse into one, the later value winning. Known limitation, not pinned by a row: a
   key `__proto__` is lost (assigning it on the rebuilt object sets the prototype instead).
10. The ratio is a parameter: the upload queue uses `MAX_DROPPED_LINE_RATIO = 0.1`;
    `parseNdjsonLines` (the strict entry point, used by the export-import zip reader) uses `0`, so
    one malformed line rejects the body. With ratio `0` the parser stops at the first malformed
    line; the result is the same as reading on, because rule 7 already rejects.

Not pinned by the rows (reporting details that are only logged, plus the 300-character cut of
rule 7, which no realistic parser message reaches): the hook reports
for each dropped line its byte length before trimming and without its `\n` (so `\r` and spaces
count), the parser
error and a snippet of the first 120 UTF-16 units of the trimmed text passed through
`JSON.stringify` (the snippet cap is checked by step 3 of `tests/scenarios/hook/s-hook-02.spec.ts`); bytes that
are not valid UTF-8 are decoded only for parsing, the kept line keeps its original bytes (NT-46).
When
the server accepts a body with drops, the server writes a warning to its own log with the first 5 drops
(reasons cut to 120 characters, then `; ...` when there were more).

## Edge cases

- Hook: clean body returned unchanged: NT-01; no final newline: NT-02, NT-04, NT-17; blank
  lines: NT-05, and they count in line numbers: NT-18; bare JSON scalars: NT-06; everything
  dropped: NT-07; empty body: NT-08; two records spliced into one line: NT-09; CRLF: NT-19, NT-31;
  trailing no-break space: NT-32;
  multi-byte text: NT-25.
- Server: exactly 10% (accepted) vs just above (rejected) vs 20%: NT-10, NT-12, NT-11; blank
  lines do not count in the ratio (NT-13) but do in line numbers (NT-20); a single line: NT-14;
  only blank lines: NT-15; empty body: NT-22; `totalLines` with a trailing newline: NT-16;
  trailing no-break space: NT-33; U+0000: NT-34; strict mode (ratio 0): NT-23, NT-24, NT-26; 2 of 19: NT-27; BOM and no-break
  space: NT-28, NT-29, NT-30; 3 of 29: NT-40; U+0000 nested: NT-37; bare values: NT-38;
  non-ASCII `chars`: NT-39; error detail: NT-35, NT-36.

## Examples

Every row has `side` (`hook` or `server`) and the raw `body` as a JSON string (`\n` is a newline,
`\r` a carriage return, `\ufeff` a byte-order mark, `\u00a0` a no-break space). A hook row may give the body as
`bodyBase64` (raw bytes, for bytes that are not valid UTF-8) and then expects `bodyBase64` too.
A server row with
`"strict": true` goes through `parseNdjsonLines` (rule 10) and, when accepted, expects only
`kept`; a server row whose `expected` has `values` also compares the parsed lines, and one with
`errorNot` checks that this text is not in the error (NT-36 relies on Node's parser adding its
`(line N column M)` suffix, as current V8 does); other server rows use the tolerant parser with the default `0.1`.

- Hook rows expect `body` (the sanitized body as text), `dropped` (dropped line numbers),
  `lines` and `unchanged` (the very same body object was returned).
- Server rows expect either `accepted: true` with `kept` (number of kept lines), `dropped`
  (dropped line numbers) and `totalLines`, or `accepted: false` with a substring of `error`.

Rows (45): [`docs/algorithm-examples/ndjson-tolerance.json`](../../algorithm-examples/ndjson-tolerance.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Hook drops blank lines -> NT-05, NT-41. Earlier value kept on a key collision -> NT-42.
- Hook only accepts objects (`{...}`) -> NT-06.
- Hook appends a `\n` to a kept final line -> NT-17.
- Line numbers counted over non-blank lines only -> NT-18 (hook), NT-20 (server).
- No trimming before parsing -> NT-05, NT-15 (spaces-only lines become malformed), NT-28,
  NT-29, NT-30 (BOM and no-break space).
- Hook re-encodes the body even when nothing was dropped -> NT-01, NT-05 (`unchanged` false).
- Server `>=` instead of `>` -> NT-10; ratio raised (anything from 1/9 (about 0.1111) to below 0.2) or the
  allowance rounded to whole lines -> NT-12.
- Strict mode not strict (default ratio used for `0`) -> NT-26.
- Ratio of 10/99 or more (up to 1/9) -> NT-44, NT-27, NT-40 (NT-45 is the accepted side).
  Irreducible residual: a ratio strictly between 0.1 and 10/99 is told apart only by ever longer
  bodies, so no finite set of rows kills every such constant.
- U+0000 scrubbed in the raw text instead of the parsed values -> NT-43.
- Kept lines re-encoded from the decoded text -> NT-46.
- Trimming only the start -> NT-32, NT-33. U+0000 not removed (from values or keys) -> NT-34.
- `chars` counted before trimming -> NT-35; counted in bytes -> NT-39. V8 position suffix kept ->
  NT-36. U+0000 cleaned only at the top level -> NT-37. Server accepting only objects -> NT-38.
- Server counts blank lines into `nonBlank` -> NT-13 (accepted); blank lines counted as
  malformed -> NT-15 (reports a bad line instead of "no valid lines").
- Server reports the last instead of the first bad line -> NT-11 (line 10).
- Server returns an empty list instead of failing an all-blank or empty body -> NT-15, NT-22.
- Equivalent for every ratio the product passes (0 and 0.1): the `dropped > 0 &&` guard of
  rule 7 and the early stop of rule 10; they only matter for a negative ratio.

## Where the result is visible

- Hook: the local `hook.log` gets "dropped N malformed JSON line(s) of M before upload", then
  one detail line for each of the first 5 drops and "... and K more dropped line(s)"; the rest
  of the session uploads. When every line was dropped, nothing is uploaded and `hook.log` gets a
  `fail` entry instead.
- Server: a rejected body marks the upload-queue row `failed` with that error message (Admin ->
  Upload queue), which an older hook also shows as a warning on its next upload; an accepted one ingests the session minus the dropped lines and logs a warning
  in the server log only.
