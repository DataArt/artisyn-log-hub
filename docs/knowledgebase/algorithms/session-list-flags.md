---
reviewed: no
reviewer: none
---

# Session list flags: main model, main assistant, workflow

## Purpose

The repository session list (`GET /api/v1/repositories/:repoId/sessions`) shows each session's
model-based cost and a workflow marker. Deriving them from the raw `logs.body` jsonb at request
time made the list slow on heavy transcripts, so since migration 0080 they are computed once at
ingest and stored on `session_stats` (`main_model`, `has_main_assistant`, `has_workflow`). Since
migration 0081 (version 2) the line count of the same transcript is stored too
(`claude_line_count`), for the analytics timeline's log line count. The
stored values must equal what the old request-time SQL derived from the same body, or the list
would price sessions with a different model or show the workflow marker on the wrong rows.

## Code

- Implementation: `server/src/logs/session-list-flags.ts` (`computeSessionListFlags`,
  `SESSION_LIST_FLAGS_VERSION`). Called from `extractClaudeStats`
  (`server/src/logs/claude-extractor.ts`, `listFlags`, `null` for sub-agent logs) and written by
  `upsertSessionStatsRow` (`server/src/logs/session-stats-writer.ts`) only when `listFlags` is
  not null.
- Twins: the startup backfill SQL `server/src/database/backfill-session-list-flags.ts` (same
  rules in Postgres, for rows with `list_flags_version IS NULL`); the Workflow predicate is step 1
  of `extractWorkflows` (`server/src/logs/workflow-extractor.ts`).
- Test: `server/src/logs/session-list-flags.algo.spec.ts`.
- Storage: [../db-tables.md](../db-tables.md) § `session_stats`.

## Input and output

`input` is the transcript: the array of parsed lines of one `claude` log, in log order. `expected`
is the full result `{mainModel, hasWorkflow, hasMainAssistant, lineCount}`, compared with deep
equality.

## Rules

Values are read as Postgres `->>` reads them: a missing key or JSON `null` is "null", a string is
itself, any other value is its JSON text (number `5` and string `"5"` are equal).

1. **Assistant line:** a line whose `type` is `"assistant"`. Lines of any other type, and lines
   that are not objects, are skipped by every rule below.
2. **Main assistant line:** an assistant line whose `isSidechain` is not `"true"` (so boolean
   `true` and string `"true"` both mark a sidechain line; `false`, a missing key or anything else
   is main).
3. **Dedup:** each main assistant line gets the key `message.id`, or `uuid` when `message.id` is
   null; when both are null the key is the one shared null key. Per key only the **last** line in
   log order is kept.
4. **`hasMainAssistant`** = at least one line is kept.
5. **`mainModel`** = walk the kept lines in log order (by their own position) and take the first
   non-null `message.model`; null when there is none. A model on a dropped duplicate never counts.
6. **`hasWorkflow`** = some assistant line, **sidechain included**, has a `message.content` that is
   an array holding a block with `type === "tool_use"`, `name === "Workflow"` and an `id` that is a
   non-empty string.
7. **`lineCount`** = the number of lines in the transcript, every line counted (the stored body is
   exactly these lines, so it equals Postgres `jsonb_array_length(logs.body)`).

`SESSION_LIST_FLAGS_VERSION` (2; version 1 had no `lineCount`) is stored in `list_flags_version` beside the flags; it is bumped
whenever these rules change.

## Edge cases

- Empty transcript: SLF-01.
- First model kept across a model switch: SLF-02, SLF-03.
- Sidechain lines (boolean and string `"true"`) never count for the model or main assistant:
  SLF-04, SLF-05.
- Main assistant without a model: SLF-06; the kept duplicate has no model while the dropped one
  does: SLF-09.
- Duplicate `message.id`, last line wins: SLF-07; and the kept line's later position changes which
  model is first: SLF-08.
- Missing `message.id` falls back to `uuid`: SLF-10; both missing share one key: SLF-11.
- Numeric and string ids are the same key: SLF-12.
- Workflow block: valid in a main line (SLF-13), empty id (SLF-14), non-string id (SLF-15),
  in a sidechain line (counts, SLF-16), in a user line (does not count, SLF-17), non-array content
  (SLF-18).

## Examples

Every row lists the transcript lines; only the keys the rules read are given.

```examples
[
  {"id": "SLF-01", "input": [], "expected": {"mainModel": null, "hasWorkflow": false, "hasMainAssistant": false, "lineCount": 0}, "note": "no lines -> nothing kept (rule 4), no model (rule 5), no Workflow (rule 6)"},
  {"id": "SLF-02", "input": [{"type": "user", "uuid": "u1", "message": {"role": "user", "content": "hi"}}, {"type": "assistant", "uuid": "a1", "isSidechain": false, "message": {"id": "m1", "model": "claude-opus-5", "content": []}}], "expected": {"mainModel": "claude-opus-5", "hasWorkflow": false, "hasMainAssistant": true, "lineCount": 2}, "note": "user line skipped; one main line m1 kept -> hasMainAssistant; its model is the first"},
  {"id": "SLF-03", "input": [{"type": "assistant", "uuid": "a1", "message": {"id": "m1", "model": "claude-opus-5"}}, {"type": "assistant", "uuid": "a2", "message": {"id": "m2", "model": "claude-sonnet-5"}}], "expected": {"mainModel": "claude-opus-5", "hasWorkflow": false, "hasMainAssistant": true, "lineCount": 2}, "note": "model switch: kept m1 (pos 0) and m2 (pos 1); first non-null in log order = opus"},
  {"id": "SLF-04", "input": [{"type": "assistant", "uuid": "a1", "isSidechain": true, "message": {"id": "m1", "model": "claude-haiku-5"}}], "expected": {"mainModel": null, "hasWorkflow": false, "hasMainAssistant": false, "lineCount": 1}, "note": "only a sidechain line (boolean true) -> no main line kept, model null"},
  {"id": "SLF-05", "input": [{"type": "assistant", "uuid": "a1", "isSidechain": "true", "message": {"id": "m1", "model": "claude-haiku-5"}}, {"type": "assistant", "uuid": "a2", "isSidechain": "false", "message": {"id": "m2", "model": "claude-opus-5"}}], "expected": {"mainModel": "claude-opus-5", "hasWorkflow": false, "hasMainAssistant": true, "lineCount": 2}, "note": "string \"true\" is a sidechain (rule 2) -> m1 dropped; string \"false\" is main -> m2 kept, opus"},
  {"id": "SLF-06", "input": [{"type": "assistant", "uuid": "a1", "message": {"id": "m1", "content": []}}], "expected": {"mainModel": null, "hasWorkflow": false, "hasMainAssistant": true, "lineCount": 1}, "note": "main line kept (rule 4 true) but it has no model -> mainModel null"},
  {"id": "SLF-07", "input": [{"type": "assistant", "uuid": "a1", "message": {"id": "m1", "model": "claude-opus-5"}}, {"type": "assistant", "uuid": "a2", "message": {"id": "m1", "model": "claude-sonnet-5"}}], "expected": {"mainModel": "claude-sonnet-5", "hasWorkflow": false, "hasMainAssistant": true, "lineCount": 2}, "note": "both lines key m1 -> only the last (pos 1, sonnet) kept"},
  {"id": "SLF-08", "input": [{"type": "assistant", "uuid": "a1", "message": {"id": "m1", "model": "claude-opus-5"}}, {"type": "assistant", "uuid": "a2", "message": {"id": "m2", "model": "claude-sonnet-5"}}, {"type": "assistant", "uuid": "a3", "message": {"id": "m1", "model": "claude-opus-5"}}], "expected": {"mainModel": "claude-sonnet-5", "hasWorkflow": false, "hasMainAssistant": true, "lineCount": 3}, "note": "m1 kept at pos 2, m2 kept at pos 1 -> in log order m2 comes first -> sonnet"},
  {"id": "SLF-09", "input": [{"type": "assistant", "uuid": "a1", "message": {"id": "m1", "model": "claude-opus-5"}}, {"type": "assistant", "uuid": "a2", "message": {"id": "m1"}}], "expected": {"mainModel": null, "hasWorkflow": false, "hasMainAssistant": true, "lineCount": 2}, "note": "m1 keeps pos 1 (no model); the dropped pos 0 model does not count -> null, but a line is kept"},
  {"id": "SLF-10", "input": [{"type": "assistant", "uuid": "u1", "message": {"model": "claude-opus-5"}}, {"type": "assistant", "uuid": "u2", "message": {"model": "claude-sonnet-5"}}], "expected": {"mainModel": "claude-opus-5", "hasWorkflow": false, "hasMainAssistant": true, "lineCount": 2}, "note": "no message.id -> keys u1, u2 (distinct) -> both kept; first = opus"},
  {"id": "SLF-11", "input": [{"type": "assistant", "message": {"model": "claude-opus-5"}}, {"type": "assistant", "message": {"model": "claude-sonnet-5"}}], "expected": {"mainModel": "claude-sonnet-5", "hasWorkflow": false, "hasMainAssistant": true, "lineCount": 2}, "note": "no id and no uuid -> one shared null key -> last line (sonnet) kept"},
  {"id": "SLF-12", "input": [{"type": "assistant", "uuid": "a1", "message": {"id": 5, "model": "claude-opus-5"}}, {"type": "assistant", "uuid": "a2", "message": {"id": "5", "model": "claude-sonnet-5"}}], "expected": {"mainModel": "claude-sonnet-5", "hasWorkflow": false, "hasMainAssistant": true, "lineCount": 2}, "note": "number 5 reads as text \"5\" -> same key as \"5\" -> last line (sonnet) kept"},
  {"id": "SLF-13", "input": [{"type": "assistant", "uuid": "a1", "message": {"id": "m1", "model": "claude-opus-5", "content": [{"type": "text", "text": "starting"}, {"type": "tool_use", "id": "toolu_1", "name": "Workflow", "input": {}}]}}], "expected": {"mainModel": "claude-opus-5", "hasWorkflow": true, "hasMainAssistant": true, "lineCount": 1}, "note": "tool_use named Workflow with id \"toolu_1\" in an assistant line -> hasWorkflow"},
  {"id": "SLF-14", "input": [{"type": "assistant", "uuid": "a1", "message": {"id": "m1", "model": "claude-opus-5", "content": [{"type": "tool_use", "id": "", "name": "Workflow", "input": {}}]}}], "expected": {"mainModel": "claude-opus-5", "hasWorkflow": false, "hasMainAssistant": true, "lineCount": 1}, "note": "Workflow block with empty id -> not a valid block (rule 6)"},
  {"id": "SLF-15", "input": [{"type": "assistant", "uuid": "a1", "message": {"id": "m1", "model": "claude-opus-5", "content": [{"type": "tool_use", "id": 7, "name": "Workflow", "input": {}}]}}], "expected": {"mainModel": "claude-opus-5", "hasWorkflow": false, "hasMainAssistant": true, "lineCount": 1}, "note": "Workflow block id is a number, not a string -> not valid"},
  {"id": "SLF-16", "input": [{"type": "assistant", "uuid": "a1", "isSidechain": true, "message": {"id": "m1", "model": "claude-haiku-5", "content": [{"type": "tool_use", "id": "toolu_1", "name": "Workflow", "input": {}}]}}], "expected": {"mainModel": null, "hasWorkflow": true, "hasMainAssistant": false, "lineCount": 1}, "note": "sidechain line: excluded from main (null model, no kept line) but rule 6 includes sidechains -> hasWorkflow"},
  {"id": "SLF-17", "input": [{"type": "user", "uuid": "u1", "message": {"role": "user", "content": [{"type": "tool_use", "id": "toolu_1", "name": "Workflow", "input": {}}]}}], "expected": {"mainModel": null, "hasWorkflow": false, "hasMainAssistant": false, "lineCount": 1}, "note": "the Workflow block sits in a user line -> rule 1 skips it"},
  {"id": "SLF-18", "input": [{"type": "assistant", "uuid": "a1", "message": {"id": "m1", "model": "claude-opus-5", "content": "tool_use Workflow toolu_1"}}], "expected": {"mainModel": "claude-opus-5", "hasWorkflow": false, "hasMainAssistant": true, "lineCount": 1}, "note": "content is a string, not an array -> no block to inspect"}
]
```

## Mutations

- Keep the first line per dedup key instead of the last -> SLF-07.
- Order the kept lines by the key's first appearance instead of the kept line's position -> SLF-08.
- Take the model from any line of the key (not only the kept one) -> SLF-09.
- Treat only boolean `true` as a sidechain -> SLF-05.
- Dedup by `message.id` only, every id-less line sharing the null key -> SLF-10.
- Compare ids with strict JS equality (number `5` ≠ string `"5"`) -> SLF-12.
- Accept any truthy Workflow `id` -> SLF-15; any defined `id` -> SLF-14.
- Look for Workflow only in main lines -> SLF-16; in every line type -> SLF-17.

## Where the result is visible

- Sessions list (repository page, `GET /api/v1/repositories/:repoId/sessions`): the cost columns —
  the session's own tokens are priced with `main_model`, and a session without a main assistant line
  (`has_main_assistant` false) gets no cost row.
- The same list's workflow marker: API field `hasWorkflow` (`has_workflow`).
