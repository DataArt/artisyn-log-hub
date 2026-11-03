---
reviewed: 2026-10-23
reviewer: ai
---

# Tool-call outcome and status

## Purpose

Every tool call in a session ends in one of four ways: it worked, it failed, it never ran
because the user or a rule said no (or the user interrupted it), or its result was never
recorded. The Logs view shows this as a status badge on every call row, and the Statistics tab
and the server's tool stats use the same rule to count failures, so a rejected call is never
counted as a failure and a successful Grep that quotes a rejection sentence is never counted as a
rejection.

## Code

- Implementation (client): `client/src/viewer/pages/repository/session-log/tool-outcome.ts`
  (`REJECTION_MARKERS`, `isRejectionText`, `classifyToolOutcome`, `outcomeToStatus`,
  `MAX_RESULT_TEXT_SCAN`). Used by `tool-calls.ts` (`buildAllToolCalls`, Logs) and
  `usage/session-usage-derive.ts` (Statistics).
- Twin (server): `server/src/logs/tool-stats.ts` (`classifyToolOutcome`, `isRejectionText`, its
  own copy of the marker list). `server/src/logs/claude-extractor.ts` fills `ToolResultInfo`
  (`denialKind` from the result line's `toolDenialKind`) and cuts the text to its own
  `MAX_RESULT_TEXT_SCAN` = 200 before the call. The server has no `status`: its test checks only
  `expected.outcome` and ignores `status`, `interrupted` and `denialKind`.
- Input producers: see "Input producers" below (outside the rules).
- Test: `client/src/viewer/pages/repository/session-log/tool-outcome.algo.test.ts` (vitest) and
  `server/src/logs/tool-stats.algo.spec.ts` (jest).

## Input and output

- Input `result`: `null` when the call has no `tool_result` in the log, else
  `{isError: boolean | null, text: string, interrupted?: boolean, denialKind?: string}`.
  `isError` is `tool_result.is_error` (`null` when the field is missing, which is the common
  success case).
- Output `outcome`: `success` | `failure` | `unresolved` (both twins).
- Output (client only) `status`: `success` | `error` | `rejected` | `missing`, plus
  `interrupted: true` and `denialKind` when they apply. `status` drives the badge.

## Input producers (outside the rules, not pinned by the rows)

Three producers build the `result` from a log line. They are not part of the rule and no row
runs them; their differences are known and accepted:

- **Logs** (`buildToolResultIndex` in `tool-calls.ts`): `isError` is `is_error === true`, so a
  missing field becomes `false`, not `null` (the outcome is the same: rule 5). The text joins
  the text blocks with `\n` and puts `[binary data, N bytes]` in place of a non-text block, a
  `data:` string or a string holding `\0`. `interrupted` is `toolUseResult.interrupted === true`;
  an empty `toolDenialKind` is dropped before the rule. The 200-character cut is rule S0.
- **Statistics** (`usage/session-usage-derive.ts`): keeps a missing `is_error` as `null`,
  concatenates only the `text` blocks with no separator, and stops after
  `MAX_RESULT_TEXT_SCAN` = 200 characters before calling `classifyToolOutcome`.
- **Server** (`claude-extractor.ts`): like Statistics (text blocks only, no separator, cut at its
  own `MAX_RESULT_TEXT_SCAN` = 200); a `null` `toolDenialKind` becomes absent.
- In all three, content that is neither a string nor an array becomes `''`.

Consequence: a rejection notice that starts after character 200 in only one of these texts
(for example after an image placeholder in Logs) can be "⊘ rejected" in Logs and a failure in
Statistics, or the reverse. The notices Claude Code writes are a single sentence-initial text
block, so this does not happen for them; aligning the producers is not worth the extra code.

## Rules

### Outcome (`classifyToolOutcome`, both twins)

1. `result` is `null` → `unresolved`.
2. `interrupted === true` → `unresolved`.
3. `denialKind` is a non-empty string → `unresolved`. Claude Code writes it for
   `user-rejected`, `permission-rule`, `automode-blocked` and `interrupted`; any non-empty value
   counts.
4. `isError === true`:
   - the text contains one of `REJECTION_MARKERS`, compared lower-case → `unresolved`;
   - otherwise → `failure`.
5. Anything else (`isError` `false` or `null`) → `success`. A rejection marker in a result that
   is not `is_error` is ordinary output and does **not** count.

`REJECTION_MARKERS` (lower-case, matched as substrings):

- `doesn't want to proceed with this tool use` and the same with a curly apostrophe `’`;
- `doesn't want to take this action` and the same with `’`;
- `requested permissions to use`;
- `operation rejected by user`;
- `request interrupted by user`.

A plain `permission denied` is deliberately not a marker: it is ordinary command output of a
failing Bash call. "Claude requested permissions to **write to** …" is not matched either; such
calls are recognised only through `denialKind`.

`isRejectionText` returns `false` for an empty text (no marker can match it anyway).

`classifyToolOutcome` itself never cuts: the rows' `expected.outcome` is computed on the full
text. Only `outcomeToStatus` cuts (rule S0); the other callers cut in their input producers (see
"Input producers").

### Status (`outcomeToStatus`, client only)

S0. Before rules 6-9, the outcome is computed by rules 1-5 on the first 200 characters of
    `text` (characters 1-200); a marker that is not complete within them does not match.

6. `result` is `null` → `status: 'missing'` (badge "output not captured").
7. Outcome `unresolved` → `status: 'rejected'` (badge "⊘ rejected"):
   - `interrupted: true` is added when `interrupted === true` **or** `denialKind ===
     'interrupted'` (badge "⏸ interrupted");
   - a non-empty `denialKind` is copied (it becomes the badge tooltip: `user-rejected` → "rejected
     by the user", `permission-rule` → "blocked by a permission rule", `automode-blocked` →
     "blocked by auto mode").
8. Outcome `failure` → `status: 'error'` (badge "✗ error").
9. Outcome `success` → `status: 'success'`.

## Edge cases

- No result at all: TO-01.
- `is_error` missing (null) on a normal result: TO-02.
- A plain failure: TO-03; command output "Permission denied" stays a failure: TO-08.
- Rejection sentence on an `is_error` result: TO-04; curly apostrophe: TO-07.
- Rejection sentence quoted in successful output: TO-05.
- Interrupted flag without a marker in the text: TO-06.
- Denial known only from `denialKind` (no marker matches): TO-09; the same text without
  `denialKind` is a failure: TO-12.
- `denialKind: interrupted` without the `interrupted` flag: TO-10.
- Empty `denialKind` counts as absent: TO-11; it is not copied onto a rejected call: TO-22.
- Mixed case in the notice ("[Request interrupted by user …]"): TO-13.
- One row per marker: TO-04, TO-07, TO-13 (request interrupted), TO-14, TO-15, TO-16, TO-17.
- `interrupted` / `denialKind` win over a non-error result: TO-18, TO-19.
- `interrupted: false` (what every producer passes on an ordinary call): TO-23 (error result),
  TO-24 (non-error result), TO-26 (a rejected call).
- An `is_error` result with empty text: TO-25.
- The 200-character cut in `outcomeToStatus`: a marker ending at character 200 (TO-20) and at
  201 (TO-21).

## Examples

`input.result` is passed to `classifyToolOutcome` (both twins) and, on the client, to
`outcomeToStatus`. `expected.outcome` is the outcome of both twins. `expected.status`,
`expected.interrupted` and `expected.denialKind` are the client's status fields; a key that is
not listed must be absent from the client's result.

Rows (26): [`docs/algorithm-examples/tool-call-outcome.json`](../../algorithm-examples/tool-call-outcome.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- A missing result classified as `failure` (the old Logs rule) -> TO-01.
- The marker checked regardless of `is_error` (the old rule) -> TO-05 (unresolved).
- `interrupted` ignored -> TO-06 (failure / error).
- `denialKind` ignored -> TO-09 (failure / error).
- A generic `permission denied` marker -> TO-08 (unresolved).
- Only straight-apostrophe markers -> TO-07 (failure).
- An empty `denialKind` treated as present -> TO-11 (unresolved).
- `interrupted` set only from the flag, not from `denialKind: 'interrupted'` -> TO-10 (no
  `interrupted`).
- A shortened marker `requested permissions to` -> TO-12 (unresolved).
- The server twin not updated to the `is_error` gate -> TO-05 on the server test.
- No lower-casing in `isRejectionText` -> TO-13 (failure / error).
- Any one marker deleted from either twin's list -> the row for that marker (TO-04, TO-07,
  TO-13, TO-14, TO-15, TO-16, TO-17) gives failure, on that twin's test.
- `interrupted` / `denialKind` checked only inside the `is_error` branch -> TO-18 / TO-19
  (success / success).
- No 200-character cut in `outcomeToStatus`, or a cut at 201 or more -> TO-21 (rejected); a cut
  at 199 or less -> TO-20 (error).
- `denialKind` copied when it is defined but empty -> TO-22 (an extra `denialKind: ''`).
- `interrupted` tested for presence (`!== undefined`, `in`, `!= null`) instead of `=== true`:
  in `classifyToolOutcome` (rule 2) -> TO-23 / TO-24 (unresolved / rejected), on both twins; in
  `outcomeToStatus` when it sets the `interrupted` key (rule 7) -> TO-26 (an extra
  `interrupted: true`).
- The empty-text guard in `isRejectionText` inverted -> TO-25 (unresolved / rejected).

## Where the result is visible

- Session pane → Logs tab: the status badge of every tool row, the ✗ / ⊘ marks of Files and Skills
  rows, the header of the tool-call modal, the Context Growth step modal and the Bash tab list and
  details ("✗ error", "⊘ rejected", "⏸ interrupted", "output not captured").
- Session pane → Statistics tab: tool failure counts and rates (rejected and missing calls are not
  failures).
- Server: `session_tool_stats` outcome counts (success / failure / unresolved).
