---
reviewed: no
reviewer: none
---

# OKF task context: the user's task text out of transcript traffic

## Purpose

The OKF Agents panel shows each agent's task head, and the facts route hands the local
KB-completeness skill the user's prompts so it can judge KB reads against the task. In a
transcript, `user`-role entries are mostly not the user: tool results, task notifications, local
command output, system reminders, CLI utilities such as `/clear`. This filter keeps only the real
task text — including a slash command, which is a task (`/adlc-lh:implement-deep <task>`) — and a
task is often just a one-line question, which stays as it is.

## Code

- Implementation: `server/src/logs/okf/okf-task-context.ts` (`cleanTaskText`,
  `filterUserPrompts`).
- Callers: `server/src/logs/okf/okf-usage.service.ts` (agent `taskHead` = `cleanTaskText` of the
  node log's `first_prompt`, cut to `TASK_HEAD_MAX_CHARS` = 200), `okf-facts.service.ts`
  (`prompts`, sub-agent `prompt`).
- Twins: none. The slash-command shape rule (whichever of `<command-message>` /
  `<command-name>` comes first decides) is the one documented in
  [../harness-usage-tab.md](../harness-usage-tab.md).
- Test: `server/src/logs/okf/okf-task-context.algo.spec.ts` (jest).

## Rules

**`cleanTaskText(raw)`** returns the task text or `null` (dropped):

1. Let `t` = `raw` without leading whitespace. If `t` starts with `<task-notification>`,
   `<local-command-stdout>`, `<local-command-caveat>`, `<bash-stdout>` or `<system-reminder>`
   → `null` (system traffic). Only the start counts: the same tag later in the text is kept.
2. If `t` starts with `<command-name>` → `null` (a CLI utility such as `/clear`, `/model`).
3. If `t` starts with `<command-message>` (a real slash command): `name` = the text of
   `<command-name>…</command-name>` with whitespace collapsed and leading `/` removed; empty →
   `null`. `args` = the text of `<command-args>…</command-args>` with every
   `<system-reminder>…</system-reminder>` block replaced by a space and whitespace collapsed.
   Result `/<name> <args>`, or `/<name>` when `args` is empty.
4. Otherwise every `<system-reminder>…</system-reminder>` block is replaced by a space, every run
   of whitespace becomes one space, the ends are trimmed; an empty result → `null`.

**`filterUserPrompts(entries, { isSubagentLog })`** returns the cleaned prompts in order. An entry
is a candidate only when `type` is `user`, it is not `isMeta`, it has no `toolUseResult`, its
`message.content` is a string (a block array is a tool result), and — in a root log — it is not
`isSidechain`. Each candidate goes through `cleanTaskText`; `null` results are left out.

## Edge cases

- Slash command kept with its arguments: TC-01; without arguments: TC-10; a command name without
  the leading `/`, and a system reminder inside the arguments: TC-10, TC-11.
- CLI utility (`<command-name>` first): TC-02.
- Dropped prefixes, one row each: `<task-notification>` TC-03, `<system-reminder>` TC-04,
  `<local-command-stdout>` TC-07, `<local-command-caveat>` TC-08, `<bash-stdout>` TC-09.
- One-line question kept unchanged: TC-05.
- Embedded system reminder stripped, whitespace collapsed: TC-06.
- Whitespace only: TC-12. A dropped tag that is not at the start: TC-13.
- Entry filter (meta, block-array tool result, `toolUseResult`, assistant, sidechain in a root log,
  `/clear`): TC-14. Sidechain lines kept in a sub-agent log: TC-15.

## Examples

A row has either `input.text` — the test runs `cleanTaskText(text)` and compares with
`expected.text` (`null` = dropped) — or `input.entries` (transcript entries) with optional
`input.subagent` (`isSubagentLog`, default false) — the test runs `filterUserPrompts` and compares
with `expected.prompts`.

```examples
[
  {
    "id": "TC-01",
    "input": {"text": "<command-message>adlc-lh:implement-deep</command-message>\n<command-name>/adlc-lh:implement-deep</command-name>\n<command-args>2026-10-27-okf-usage-tab</command-args>"},
    "expected": {"text": "/adlc-lh:implement-deep 2026-10-27-okf-usage-tab"},
    "note": "Rule 3: <command-message> first -> a real slash command; name adlc-lh:implement-deep (leading / removed), args 2026-10-27-okf-usage-tab -> '/<name> <args>'."
  },
  {
    "id": "TC-02",
    "input": {"text": "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"},
    "expected": {"text": null},
    "note": "Rule 2: <command-name> first -> CLI utility -> dropped."
  },
  {
    "id": "TC-03",
    "input": {"text": "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>"},
    "expected": {"text": null},
    "note": "Rule 1: starts with <task-notification> -> system traffic -> dropped."
  },
  {
    "id": "TC-04",
    "input": {"text": "<system-reminder>\nThe user opened tmp/x.md in the IDE.\n</system-reminder>"},
    "expected": {"text": null},
    "note": "Rule 1: starts with <system-reminder> -> dropped."
  },
  {
    "id": "TC-05",
    "input": {"text": "why is the Logs tab empty for session 42?"},
    "expected": {"text": "why is the Logs tab empty for session 42?"},
    "note": "Rule 4: plain text with nothing to strip and single spaces -> kept unchanged; a one-line question is the whole task."
  },
  {
    "id": "TC-06",
    "input": {"text": "fix the  login\n\n page <system-reminder>Todo list is empty</system-reminder> please"},
    "expected": {"text": "fix the login page please"},
    "note": "Rule 4: the reminder block becomes a space; the runs '  ', '\\n\\n ', '  ' collapse to one space each -> 'fix the login page please'."
  },
  {
    "id": "TC-07",
    "input": {"text": "<local-command-stdout>Set model to opus</local-command-stdout>"},
    "expected": {"text": null},
    "note": "Rule 1: <local-command-stdout> prefix -> dropped."
  },
  {
    "id": "TC-08",
    "input": {"text": "<local-command-caveat>Caveat: the messages below were generated by the user while running local commands.</local-command-caveat>"},
    "expected": {"text": null},
    "note": "Rule 1: <local-command-caveat> prefix -> dropped."
  },
  {
    "id": "TC-09",
    "input": {"text": "<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>"},
    "expected": {"text": null},
    "note": "Rule 1: <bash-stdout> prefix -> dropped."
  },
  {
    "id": "TC-10",
    "input": {"text": "<command-message>review</command-message>\n<command-name>review</command-name>\n<command-args></command-args>"},
    "expected": {"text": "/review"},
    "note": "Rule 3: name 'review' (no leading / to remove), empty args -> '/review' with no trailing space."
  },
  {
    "id": "TC-11",
    "input": {"text": "<command-message>plan</command-message>\n<command-name>/plan</command-name>\n<command-args>GH-46 <system-reminder>hidden</system-reminder>  tag search</command-args>"},
    "expected": {"text": "/plan GH-46 tag search"},
    "note": "Rule 3: the reminder inside the args becomes a space, 'GH-46   tag search' collapses to 'GH-46 tag search' -> '/plan GH-46 tag search'."
  },
  {
    "id": "TC-12",
    "input": {"text": "  \n\t "},
    "expected": {"text": null},
    "note": "Rule 4: only whitespace -> empty after trimming -> dropped."
  },
  {
    "id": "TC-13",
    "input": {"text": "see <task-notification> below"},
    "expected": {"text": "see <task-notification> below"},
    "note": "Rule 1 looks only at the start; here the tag is in the middle, so rule 4 keeps the text."
  },
  {
    "id": "TC-14",
    "input": {"entries": [
      {"type": "user", "message": {"content": "add the OKF tab"}},
      {"type": "user", "isMeta": true, "message": {"content": "Caveat: meta line"}},
      {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}},
      {"type": "user", "toolUseResult": {"stdout": "x"}, "message": {"content": "tool output as a string"}},
      {"type": "assistant", "message": {"content": "sure"}},
      {"type": "user", "isSidechain": true, "message": {"content": "sub-agent task"}},
      {"type": "user", "message": {"content": "<command-name>/clear</command-name>"}},
      {"type": "user", "message": {"content": "now the repo tab"}}
    ]},
    "expected": {"prompts": ["add the OKF tab", "now the repo tab"]},
    "note": "Entry filter: isMeta, a block-array content, a toolUseResult, an assistant entry and (root log) a sidechain entry are not candidates; '/clear' is a candidate but rule 2 drops it. Two prompts remain, in order."
  },
  {
    "id": "TC-15",
    "input": {"subagent": true, "entries": [
      {"type": "user", "isSidechain": true, "message": {"content": "Read docs/knowledgebase/index.md and report the db tables"}}
    ]},
    "expected": {"prompts": ["Read docs/knowledgebase/index.md and report the db tables"]},
    "note": "In a sub-agent log every line is a sidechain line, so isSidechain does not exclude it; rule 4 keeps the text."
  }
]
```

## Mutations

- `<command-message>` and `<command-name>` order ignored (both kept, or both dropped) -> TC-01,
  TC-02.
- Dropped prefixes matched anywhere instead of at the start -> TC-13; one prefix missing from the
  list -> TC-03, TC-04, TC-07, TC-08 or TC-09.
- Slash-command args kept raw (reminder or extra spaces left) -> TC-11; a trailing space for empty
  args -> TC-10.
- Whitespace not collapsed -> TC-06; whitespace-only kept as `''` -> TC-12.
- `isMeta`, `toolUseResult` or the sidechain check missing from the entry filter -> TC-14;
  sidechain excluded in a sub-agent log -> TC-15.

## Where the result is visible

- Session pane → **OKF** tab → Agents panel: each agent's task head (first 200 characters).
- `GET /api/v2/okf-usage/facts`: `prompts` and each agent's `prompt` (input of the local
  KB-completeness skill).
