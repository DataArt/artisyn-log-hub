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
`JSON.stringify` (the snippet cap is tested in `__tests__/ndjson-sanitize.test.js`); bytes that
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

```examples
[
  {
    "id": "NT-01",
    "input": {"side": "hook", "body": "{\"a\":1}\n{\"b\":2}\n"},
    "expected": {"body": "{\"a\":1}\n{\"b\":2}\n", "dropped": [], "lines": 2, "unchanged": true},
    "note": "Rules 1 and 4: two valid lines, the trailing \\n opens no third line; nothing dropped, same body."
  },
  {
    "id": "NT-02",
    "input": {"side": "hook", "body": "{\"a\":1}\n{\"b\":2}"},
    "expected": {"body": "{\"a\":1}\n{\"b\":2}", "dropped": [], "lines": 2, "unchanged": true},
    "note": "Rule 1: the last line has no \\n but is still line 2; rule 2 does not add a newline."
  },
  {
    "id": "NT-03",
    "input": {"side":"hook","body":"{\"a\":1}\n{\"b\":\n{\"c\":3}\n"},
    "expected": {"body":"{\"a\":1}\n{\"c\":3}\n","dropped":[2],"lines":3,"unchanged":false},
    "note": "Rule 3: line 2 is a truncated record; lines 1 and 3 are kept with their newlines. S-HOOK-02 checks a torn line on a real hook run; this row pins the line number and the exact kept bytes."
  },
  {
    "id": "NT-04",
    "input": {"side":"hook","body":"{\"a\":1}\n{\"b\""},
    "expected": {"body":"{\"a\":1}\n","dropped":[2],"lines":2,"unchanged":false},
    "note": "Rule 3 on a final line without \\n; rule 2 keeps line 1 with its own \\n, nothing is invented. Beyond S-HOOK-02: the last line has no newline."
  },
  {
    "id": "NT-05",
    "input": {"side": "hook", "body": "{\"a\":1}\n\n   \n{\"b\":2}\n"},
    "expected": {"body": "{\"a\":1}\n\n   \n{\"b\":2}\n", "dropped": [], "lines": 4, "unchanged": true},
    "note": "Rule 2: lines 2 (empty) and 3 (spaces) are blank and kept as they are, not treated as corruption."
  },
  {
    "id": "NT-06",
    "input": {"side": "hook", "body": "42\n\"text\"\nnull\n"},
    "expected": {"body": "42\n\"text\"\nnull\n", "dropped": [], "lines": 3, "unchanged": true},
    "note": "Valid means 'parses as JSON': a number, a string and null all parse."
  },
  {
    "id": "NT-07",
    "input": {"side":"hook","body":"torn\n{\"x\":\n"},
    "expected": {"body":"","dropped":[1,2],"lines":2,"unchanged":false},
    "note": "Rules 3 and 4: both lines malformed, the body becomes empty. S-HOOK-02 checks that nothing is uploaded then; this row pins the empty result and both line numbers."
  },
  {
    "id": "NT-08",
    "input": {"side": "hook", "body": ""},
    "expected": {"body": "", "dropped": [], "lines": 0, "unchanged": true},
    "note": "Rule 1: an empty body has no lines; nothing dropped, same body."
  },
  {
    "id": "NT-09",
    "input": {"side": "hook", "body": "{\"a\":1}{\"b\":2}\n{\"c\":3}\n"},
    "expected": {"body": "{\"c\":3}\n", "dropped": [1], "lines": 2, "unchanged": false},
    "note": "Two records spliced into one line by interleaved appends do not parse as one JSON value: line 1 is dropped."
  },
  {
    "id": "NT-10",
    "input": {"side": "server", "body": "{}\n{}\n{}\n{}\nx\n{}\n{}\n{}\n{}\n{}"},
    "expected": {"accepted": true, "kept": 9, "dropped": [5], "totalLines": 10},
    "note": "Rule 7: 1 malformed of 10 non-blank; 1 > 10 * 0.1 = 1 is false (exactly 10% passes)."
  },
  {
    "id": "NT-11",
    "input": {"side":"server","body":"{}\nx\n{}\n{}\n{}\n{}\n{}\n{}\n{}\ny"},
    "expected": {"accepted":false,"error":"Malformed NDJSON: invalid JSON line 2 of 10 (1 chars): "},
    "note": "Rule 7: 2 malformed of 10; 2 > 1, rejected, naming the first bad line (2) of 10 pieces and its trimmed length, 1 character ('x')."
  },
  {
    "id": "NT-12",
    "input": {"side":"server","body":"{}\n{}\n{}\n{}\nx\n{}\n{}\n{}\n{}"},
    "expected": {"accepted":false,"error":"Malformed NDJSON: invalid JSON line 5 of 9"},
    "note": "Rule 7 just above 10%: 1 malformed of 9 non-blank; 1 > 9 * 0.1 = 0.9, rejected. A ratio of 1/9 (about 0.111) or more, or rounding nonBlank * 0.1 to 1, would accept it."
  },
  {
    "id": "NT-13",
    "input": {"side": "server", "body": "{}\nx\n{}\n{}\n{}\n{}\n{}\n{}\n{}\ny\n\n\n\n\n  \n\n\n\n\n"},
    "expected": {"accepted": false, "error": "Malformed NDJSON: invalid JSON line 2 of 20"},
    "note": "Rule 6: the body of NT-11 followed by 10 blank pieces (20 pieces in all). Blank lines do not count, so nonBlank = 10 and 2 > 1 rejects. Counting the blanks would give 2 > 20 * 0.1 = 2, false, and accept garbage padded with blank lines."
  },
  {
    "id": "NT-14",
    "input": {"side": "server", "body": "x"},
    "expected": {"accepted": false, "error": "Malformed NDJSON: invalid JSON line 1 of 1"},
    "note": "Rule 7: 1 malformed of 1; 1 > 0.1, rejected."
  },
  {
    "id": "NT-15",
    "input": {"side": "server", "body": "\n  \n"},
    "expected": {"accepted": false, "error": "Body contains no valid NDJSON lines"},
    "note": "Rules 6 and 8: only blank lines, nothing dropped, nothing kept."
  },
  {
    "id": "NT-16",
    "input": {"side": "server", "body": "{\"a\":1}\n{\"b\":2}\n"},
    "expected": {"accepted": true, "kept": 2, "dropped": [], "totalLines": 3},
    "note": "Rule 5: split on \\n gives 3 pieces (the last is empty and blank), so totalLines = 3 while the hook (NT-01) counts 2 lines."
  },
  {
    "id": "NT-17",
    "input": {"side":"hook","body":"x\n{\"a\":1}"},
    "expected": {"body":"{\"a\":1}","dropped":[1],"lines":2,"unchanged":false},
    "note": "Rules 2 and 3: line 1 is dropped; the kept final line has no newline and gets none (the rebuilt body is the original slices)."
  },
  {
    "id": "NT-18",
    "input": {"side":"hook","body":"{\"a\":1}\n\nbad\n{\"b\":2}\n"},
    "expected": {"body":"{\"a\":1}\n\n{\"b\":2}\n","dropped":[3],"lines":4,"unchanged":false},
    "note": "Rule 1 counts blank lines too: the bad line is line 3, not the 2nd non-blank line."
  },
  {
    "id": "NT-19",
    "input": {"side":"hook","body":"{\"a\":1}\r\n{\"b\":2}\r\n"},
    "expected": {"body":"{\"a\":1}\r\n{\"b\":2}\r\n","dropped":[],"lines":2,"unchanged":true},
    "note": "Regression row for CRLF logs written on Windows: each line ends in \\r before the \\n. The hook must keep the kept lines' own bytes, \\r included; rebuilding them as text plus \\n would lose the \\r."
  },
  {
    "id": "NT-20",
    "input": {"side":"server","body":"{}\n\nx\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}"},
    "expected": {"accepted":true,"kept":9,"dropped":[3],"totalLines":11},
    "note": "Rules 5 and 6: the blank line 2 is skipped but still numbered, so the bad line is line 3; 1 malformed of 10 non-blank is not > 1, accepted."
  },
  {
    "id": "NT-22",
    "input": {"side":"server","body":""},
    "expected": {"accepted":false,"error":"Body contains no valid NDJSON lines"},
    "note": "Rule 8: one empty piece (totalLines 1), blank, nothing kept."
  },
  {
    "id": "NT-23",
    "input": {"side":"server","body":"{}\nx\n{}","strict":true},
    "expected": {"accepted":false,"error":"Malformed NDJSON: invalid JSON line 2 of 3"},
    "note": "Rule 10, strict: line 1 is kept, line 2 is malformed and the parser stops there (nonBlank = 2); 1 > 2 * 0 = 0, rejected naming line 2 of 3. The minimal strict case; NT-26 is the one a non-strict mode would fail."
  },
  {
    "id": "NT-24",
    "input": {"side":"server","body":"{\"a\":1}\n{\"b\":2}\n","strict":true},
    "expected": {"accepted":true,"kept":2},
    "note": "Rule 10, strict: a clean body is accepted (0 dropped is not > 0) with both lines."
  },
  {
    "id": "NT-25",
    "input": {"side":"hook","body":"{\"t\":\"привет 🎉\"}\nbad\n{\"t\":\"ünïcödé\"}\n"},
    "expected": {"body":"{\"t\":\"привет 🎉\"}\n{\"t\":\"ünïcödé\"}\n","dropped":[2],"lines":3,"unchanged":false},
    "note": "Rule 2 keeps the original bytes: Cyrillic, an emoji and accented letters come back unchanged around the dropped line 2. Cutting the kept slices by UTF-16 positions instead of byte offsets would break them. Also checked end to end by S-HOOK-02; this row pins the byte slicing."
  },
  {
    "id": "NT-26",
    "input": {"side":"server","body":"{}\n{}\n{}\n{}\nx\n{}\n{}\n{}\n{}\n{}","strict":true},
    "expected": {"accepted":false,"error":"Malformed NDJSON: invalid JSON line 5 of 10"},
    "note": "Rule 10: the body NT-10 accepts at 10% is rejected in strict mode: 1 > 10 * 0 = 0."
  },
  {
    "id": "NT-27",
    "input": {"side":"server","body":"{}\n{}\nx\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\nx\n{}\n{}\n{}\n{}\n{}\n{}\n{}"},
    "expected": {"accepted":false,"error":"Malformed NDJSON: invalid JSON line 3 of 19"},
    "note": "Rule 7: 2 malformed of 19 non-blank; 2 > 19 * 0.1 = 1.9, rejected naming line 3. A ratio of 2/19 (about 0.105) or more would accept it."
  },
  {
    "id": "NT-28",
    "input": {"side":"hook","body":"\ufeff{\"a\":1}\n{\"b\":2}\n"},
    "expected": {"body":"\ufeff{\"a\":1}\n{\"b\":2}\n","dropped":[],"lines":2,"unchanged":true},
    "note": "Trimming (the definitions above): a leading byte-order mark is removed by trim() before parsing (JSON.parse alone rejects it), so line 1 is valid and the body is returned unchanged."
  },
  {
    "id": "NT-29",
    "input": {"side":"hook","body":"{\"a\":1}\n\u00a0{\"b\":2}\n"},
    "expected": {"body":"{\"a\":1}\n\u00a0{\"b\":2}\n","dropped":[],"lines":2,"unchanged":true},
    "note": "A leading no-break space is removed by trim() (JSON.parse alone rejects it): line 2 is valid."
  },
  {
    "id": "NT-30",
    "input": {"side":"server","body":"\ufeff{\"a\":1}\n\u00a0{\"b\":2}"},
    "expected": {"accepted":true,"kept":2,"dropped":[],"totalLines":2},
    "note": "Server, same trimming: the BOM and the no-break space are removed before parsing; both lines are kept."
  },
  {
    "id": "NT-31",
    "input": {"side":"hook","body":"{\"a\":1}\r\nbad\r\n"},
    "expected": {"body":"{\"a\":1}\r\n","dropped":[2],"lines":2,"unchanged":false},
    "note": "Rule 2 with CRLF and a drop: line 1 is kept with its own \\r\\n, the bad line 2 goes with its \\r\\n."
  },
  {
    "id": "NT-32",
    "input": {"side":"hook","body":"{\"a\":1}\u00a0\n"},
    "expected": {"body":"{\"a\":1}\u00a0\n","dropped":[],"lines":1,"unchanged":true},
    "note": "Trimming works on both ends: a trailing no-break space is removed before parsing (JSON.parse alone rejects it), so the line is valid. Trimming only the start would drop it."
  },
  {
    "id": "NT-33",
    "input": {"side":"server","body":"{\"a\":1}\u00a0"},
    "expected": {"accepted":true,"kept":1,"dropped":[],"totalLines":1},
    "note": "Server, same: the trailing no-break space is trimmed away and the line parses."
  },
  {
    "id": "NT-34",
    "input": {"side":"server","body":"{\"a\":\"x\\u0000y\",\"k\\u0000\":1}"},
    "expected": {"accepted":true,"kept":1,"dropped":[],"totalLines":1,"values":[{"a":"xy","k":1}]},
    "note": "Rule 9: the JSON text carries U+0000 (written as an escape) inside a string value and inside a key; both are removed after parsing: {\"a\": \"xy\", \"k\": 1}."
  },
  {
    "id": "NT-35",
    "input": {"side":"server","body":"{}\n  x \ny"},
    "expected": {"accepted":false,"error":"Malformed NDJSON: invalid JSON line 2 of 3 (1 chars): "},
    "note": "Rule 7: 2 malformed of 3; the first bad line is 2, and its trimmed text \"x\" has 1 character (the spaces around it do not count)."
  },
  {
    "id": "NT-36",
    "input": {"side":"server","body":"{x}"},
    "expected": {"accepted":false,"error":"Malformed NDJSON: invalid JSON line 1 of 1 (3 chars): Expected property name","errorNot":"(line 1 column"},
    "note": "Rule 7: the parser's message (\"Expected property name or '}' ...\") is kept, its own position suffix such as (line 1 column 2) is removed, so only the file-level line 1 of 1 remains."
  },
  {
    "id": "NT-37",
    "input": {"side":"server","body":"{\"o\":{\"a\":\"x\\u0000\"},\"l\":[\"y\\u0000\"]}"},
    "expected": {"accepted":true,"kept":1,"dropped":[],"totalLines":1,"values":[{"o":{"a":"x"},"l":["y"]}]},
    "note": "Rule 9 at every depth: U+0000 inside a nested object and inside an array is removed too."
  },
  {
    "id": "NT-38",
    "input": {"side":"server","body":"42\n\"s\\u0000\"\nnull"},
    "expected": {"accepted":true,"kept":3,"dropped":[],"totalLines":3,"values":[42,"s",null]},
    "note": "Rule 6: bare JSON values are valid on the server too; the string is cleaned of U+0000."
  },
  {
    "id": "NT-39",
    "input": {"side":"server","body":"привет"},
    "expected": {"accepted":false,"error":"Malformed NDJSON: invalid JSON line 1 of 1 (6 chars): "},
    "note": "Rule 7: <chars> counts UTF-16 units of the trimmed text: \"привет\" is 6 characters (12 bytes in UTF-8)."
  },
  {
    "id": "NT-40",
    "input": {"side":"server","body":"{}\n{}\n{}\n{}\nx\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\nx\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\nx\n{}\n{}\n{}\n{}"},
    "expected": {"accepted":false,"error":"Malformed NDJSON: invalid JSON line 5 of 29"},
    "note": "Rule 7: 3 malformed of 29; 3 > 29 * 0.1 = 2.9, rejected. A ratio of 3/29 (about 0.1034) or more would accept it."
  },
  {
    "id": "NT-41",
    "input": {"side":"hook","body":"bad\n\n"},
    "expected": {"body":"\n","dropped":[1],"lines":2,"unchanged":false},
    "note": "Rules 2-4: line 1 is dropped, the blank line 2 survives, so the body is a single newline, not empty."
  },
  {
    "id": "NT-42",
    "input": {"side":"server","body":"{\"a\\u0000\":1,\"a\":2}"},
    "expected": {"accepted":true,"kept":1,"dropped":[],"totalLines":1,"values":[{"a":2}]},
    "note": "Rule 9: the key \"a<NUL>\" becomes \"a\" and collides with the next key \"a\"; the later value, 2, wins."
  },
  {
    "id": "NT-43",
    "input": {"side":"server","body":"{\"a\":\"\\\\u0000\"}"},
    "expected": {"accepted":true,"kept":1,"dropped":[],"totalLines":1,"values":[{"a":"\\u0000"}]},
    "note": "Rule 9 works on parsed values, not on the raw text: here the text holds an escaped backslash, so the value is the six characters \\u0000 (no NUL) and stays as it is."
  },
  {
    "id": "NT-44",
    "input": {"side":"server","body":"{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\nx\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\nx\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\nx\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\nx\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\nx\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\nx\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\nx\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\nx\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\nx\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\nx"},
    "expected": {"accepted":false,"error":"Malformed NDJSON: invalid JSON line 10 of 99"},
    "note": "Rule 7: 10 malformed of 99; 10 > 99 * 0.1 = 9.9, rejected."
  },
  {
    "id": "NT-45",
    "input": {"side":"server","body":"{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\nx\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\nx\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\nx\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\nx\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\nx\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\nx\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\nx\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\nx\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\nx\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\nx\n{}"},
    "expected": {"accepted":true,"kept":90,"dropped":[10,20,30,40,50,60,70,80,90,99],"totalLines":100},
    "note": "Rule 7: 10 malformed of 100; 10 > 100 * 0.1 = 10 is false, accepted. With NT-44 it pins the ratio between 0.1 and 10/99 (about 0.101)."
  },
  {
    "id": "NT-46",
    "input": {"side":"hook","bodyBase64":"eyJhIjoi/yJ9CmJhZAo="},
    "expected": {"bodyBase64":"eyJhIjoi/yJ9Cg==","dropped":[2],"lines":2,"unchanged":false},
    "note": "Rule 2 keeps original bytes: line 1 holds the byte FF, which is not valid UTF-8; it parses (decoded as a replacement character) and is kept as the raw byte FF, not re-encoded. Line 2 is dropped."
  }
]
```

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
