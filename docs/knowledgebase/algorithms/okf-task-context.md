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

Rows (15): [`docs/algorithm-examples/okf-task-context.json`](../../algorithm-examples/okf-task-context.json) — test data for the table test; the rules above are enough to understand the algorithm.

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
