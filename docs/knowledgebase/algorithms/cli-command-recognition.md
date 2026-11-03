---
reviewed: no
reviewer: none
---

# CLI command recognition: which monitored tools an agent's shell command runs

## Purpose

The Tools/MCP tab lists every call of a monitored CLI tool. When the hook's wrapper recorded the
call, the wrapper record is the source; when it did not (old hook, wrapper off, PowerShell
pre-flight failed, a tool added mid-session) the call is still recognised from the agent's
Bash / PowerShell command in the transcript, as a transcript-only call. The same recognition
lets the server match wrapper records to the `tool_use` that ran them
([tool-wrapper-matching](tool-wrapper-matching.md)). This algorithm finds the monitored tool
invocations in one shell command, with their operation and arguments.

## Code

- Implementation: `server/src/logs/tool-monitoring/cli-command-recognition.ts`
  (`recognizeCliCalls`, `tokenizeSimpleCommands`, `operationOfArgs`).
- Helpers it relies on: `@loghub/bash-view` (`withTree`, `literal`) over the server's
  tree-sitter-bash parser `server/src/logs/okf/server-bash-parser.ts` (`getServerBashParser`);
  `@loghub/tool-monitor` (`normalizeToolName`, see
  [tool-monitor-name-validation](tool-monitor-name-validation.md) rule 5).
- Caller: `server/src/logs/tool-monitoring/tool-usage-builder.ts` (`buildTreeToolUsage`).
- Twins: none (the hook's PowerShell `PreToolUse` uses a cheaper mention regex, not this rule).
- Test: `server/src/logs/tool-monitoring/cli-command-recognition.algo.spec.ts` (jest, with the
  real server parser).

## Input and output

`recognizeCliCalls(parser, command, shell, toolNames)` → `{ tool, operation, args }[]` in source
order. `shell` is `bash` or `powershell`; `toolNames` are the recognised tool names (enabled
monitored names ∪ tool names present in the tree's wrapper records); `tool` is returned as
spelled in `toolNames`.

## Rules

1. **Nothing to do.** An empty (whitespace-only) command or an empty `toolNames` → no calls.
2. **Simple commands, Bash.** With a parser the command is parsed with tree-sitter-bash and
   **every** `command` node counts, nested ones included — pipelines, `&&` / `||` / `;` lists,
   `( … )` subshells, `$( … )` substitutions — in tree pre-order (an outer command before the
   commands inside its arguments). The command word is the node's `name`; the arguments are its
   `argument` children, with quotes removed when the word is a literal (`"a b"` → `a b`), else
   the source text as written. Leading `NAME=value` assignments are not the command word.
3. **Simple commands, PowerShell — and Bash without a parser.** The command is split into simple
   commands on `;`, `|`, `||`, `&&` and newlines outside quotes; each is split into words on
   whitespace, honouring `'…'` and `"…"` quotes (removed). A leading call operator `&` and leading
   `NAME=value` words are dropped; the next word is the command word.
4. **Match.** A simple command is a call of tool *T* when its command word, compared
   case-insensitively and without one trailing `.exe` / `.cmd` / `.bat` / `.ps1`, equals *T*
   (same normalisation). A command word containing `/` or `\` (`./zz`, `/usr/bin/find`,
   `C:\tools\zz.exe`) is never recognised; nor are `npx zz`, aliases or functions, nor a tool
   name that appears only as an argument.
5. **Operation.** `operation` = the first argument that is not empty and does not start with `-`;
   with none → `(none)` (`NO_OPERATION`). `args` = all arguments, in order.

## Edge cases

- Plain call: CR-01. Leading env assignment: CR-02.
- Pipeline: CR-03. `&&` list with a `cd` first: CR-04. Subshell and command substitution: CR-05.
- Quoted arguments: CR-06. `.exe` suffix and case: CR-07, CR-08.
- Path command words not matched: CR-09 (Bash), CR-13 (PowerShell).
- `(none)` operation: CR-10, CR-11.
- Tool name only as an argument: CR-12.
- PowerShell `;` and `|`: CR-14; call operator `&` with a quoted argument: CR-15; `||`: CR-16.
- No parser (Bash falls back to the tokenizer): CR-17. Empty tool list: CR-18.

## Examples

`input.command` is the command text, `input.shell` the shell (`bash` or `powershell`),
`input.tools` the recognised tool names. A row with `noParser: true` passes `parser = null`;
otherwise the real server parser is used. `expected.calls` is the exact result, in order.

Rows (18): [`docs/algorithm-examples/cli-command-recognition.json`](../../algorithm-examples/cli-command-recognition.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Only top-level commands walked -> CR-05 (substitution / subshell calls missing).
- Quotes kept in arguments -> CR-06, CR-15, CR-16.
- `.exe` not stripped or case-sensitive match -> CR-07, CR-08.
- Basename of a path command word matched -> CR-09, CR-13.
- Operation = first argument even when it is a flag -> CR-10.
- Arguments searched for the tool name -> CR-12.
- PowerShell split only on `;` -> CR-14 (second call missing); not split on `||` -> CR-16.
- Leading call operator `&` kept as the command word -> CR-15.
- Env assignment taken as the command word -> CR-02, CR-17.

## Where the result is visible

- Repository → **Tools/MCP** tab: transcript-only CLI calls (hint `no wrapper`) in the tree and
  the calls table, with their operation and arguments.
- Indirectly every wrapper-matched call: matching needs the recognised calls
  ([tool-wrapper-matching](tool-wrapper-matching.md)).
- Storage: `session_tool_usage` rows with `channel = 'cli'`.
