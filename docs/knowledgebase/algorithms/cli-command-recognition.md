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
  (`recognizeCliCalls`, `tokenizeSimpleCommands`, `operationOfArgs`, `commandWordsOf`).
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

```examples
[
  {
    "id": "CR-01",
    "input": {"shell": "bash", "tools": ["zz"], "command": "zz build --fast"},
    "expected": {"calls": [{"tool": "zz", "operation": "build", "args": ["build", "--fast"]}]},
    "note": "Rule 4: command word zz = tool zz. Rule 5: first non-flag argument build; args as written."
  },
  {
    "id": "CR-02",
    "input": {"shell": "bash", "tools": ["zz"], "command": "ZZ_EXIT=3 zz run"},
    "expected": {"calls": [{"tool": "zz", "operation": "run", "args": ["run"]}]},
    "note": "Rule 2: the leading assignment is not the command word; zz is."
  },
  {
    "id": "CR-03",
    "input": {"shell": "bash", "tools": ["zz", "find"], "command": "zz list | grep foo | head -1"},
    "expected": {"calls": [{"tool": "zz", "operation": "list", "args": ["list"]}]},
    "note": "Rule 2: three commands in the pipeline (zz, grep, head); only zz is a recognised tool."
  },
  {
    "id": "CR-04",
    "input": {"shell": "bash", "tools": ["zz", "find"], "command": "cd src && zz test && find . -name '*.ts'"},
    "expected": {"calls": [
      {"tool": "zz", "operation": "test", "args": ["test"]},
      {"tool": "find", "operation": ".", "args": [".", "-name", "*.ts"]}
    ]},
    "note": "Rule 2: cd, zz, find in list order; cd is not a tool. Rule 5: find's first non-flag argument is '.'; the single quotes are removed from '*.ts'."
  },
  {
    "id": "CR-05",
    "input": {"shell": "bash", "tools": ["zz"], "command": "(cd app; zz status) && echo $(zz version)"},
    "expected": {"calls": [
      {"tool": "zz", "operation": "status", "args": ["status"]},
      {"tool": "zz", "operation": "version", "args": ["version"]}
    ]},
    "note": "Rule 2: commands inside the subshell (cd, zz status) and the substitution inside echo's argument (zz version) all count, in pre-order."
  },
  {
    "id": "CR-06",
    "input": {"shell": "bash", "tools": ["zz"], "command": "zz \"deploy prod\" --msg 'a b'"},
    "expected": {"calls": [{"tool": "zz", "operation": "deploy prod", "args": ["deploy prod", "--msg", "a b"]}]},
    "note": "Rule 2: literal quoted words lose their quotes and keep the space. Rule 5: the first non-flag argument is 'deploy prod'."
  },
  {
    "id": "CR-07",
    "input": {"shell": "bash", "tools": ["zz"], "command": "zz.exe sync"},
    "expected": {"calls": [{"tool": "zz", "operation": "sync", "args": ["sync"]}]},
    "note": "Rule 4: zz.exe without .exe is zz."
  },
  {
    "id": "CR-08",
    "input": {"shell": "bash", "tools": ["ZZ"], "command": "zz run"},
    "expected": {"calls": [{"tool": "ZZ", "operation": "run", "args": ["run"]}]},
    "note": "Rule 4: case-insensitive; the tool is returned as spelled in toolNames (ZZ)."
  },
  {
    "id": "CR-09",
    "input": {"shell": "bash", "tools": ["zz", "find"], "command": "/usr/bin/find . -name a && ./zz build"},
    "expected": {"calls": []},
    "note": "Rule 4: both command words carry a path -> not recognised."
  },
  {
    "id": "CR-10",
    "input": {"shell": "bash", "tools": ["zz"], "command": "zz --version"},
    "expected": {"calls": [{"tool": "zz", "operation": "(none)", "args": ["--version"]}]},
    "note": "Rule 5: the only argument starts with - -> (none)."
  },
  {
    "id": "CR-11",
    "input": {"shell": "bash", "tools": ["zz"], "command": "zz"},
    "expected": {"calls": [{"tool": "zz", "operation": "(none)", "args": []}]},
    "note": "Rule 5: no arguments -> (none), args []."
  },
  {
    "id": "CR-12",
    "input": {"shell": "bash", "tools": ["zz"], "command": "echo zz && which zz"},
    "expected": {"calls": []},
    "note": "Rule 4: zz appears only as an argument of echo and which -> no call."
  },
  {
    "id": "CR-13",
    "input": {"shell": "powershell", "tools": ["zz"], "command": "C:\\tools\\zz.exe run"},
    "expected": {"calls": []},
    "note": "Rule 4: the command word carries a path -> not recognised."
  },
  {
    "id": "CR-14",
    "input": {"shell": "powershell", "tools": ["zz"], "command": "zz build; Get-ChildItem | zz filter -x"},
    "expected": {"calls": [
      {"tool": "zz", "operation": "build", "args": ["build"]},
      {"tool": "zz", "operation": "filter", "args": ["filter", "-x"]}
    ]},
    "note": "Rule 3: split on ; and | -> zz build / Get-ChildItem / zz filter -x; two are zz."
  },
  {
    "id": "CR-15",
    "input": {"shell": "powershell", "tools": ["zz"], "command": "& zz.exe \"my arg\" -v"},
    "expected": {"calls": [{"tool": "zz", "operation": "my arg", "args": ["my arg", "-v"]}]},
    "note": "Rule 3: the call operator & is dropped and the double quotes kept the space. Rule 4: zz.exe -> zz."
  },
  {
    "id": "CR-16",
    "input": {"shell": "powershell", "tools": ["zz", "find"], "command": "zz check || find 'C:\\my dir'"},
    "expected": {"calls": [
      {"tool": "zz", "operation": "check", "args": ["check"]},
      {"tool": "find", "operation": "C:\\my dir", "args": ["C:\\my dir"]}
    ]},
    "note": "Rule 3: split on ||; the single-quoted path stays one word. A path as an argument is fine (rule 4 is about the command word)."
  },
  {
    "id": "CR-17",
    "noParser": true,
    "input": {"shell": "bash", "tools": ["zz"], "command": "FOO=1 zz run && zz stop"},
    "expected": {"calls": [
      {"tool": "zz", "operation": "run", "args": ["run"]},
      {"tool": "zz", "operation": "stop", "args": ["stop"]}
    ]},
    "note": "Rule 3: no parser -> the tokenizer splits on &&, drops FOO=1 -> zz run, zz stop."
  },
  {
    "id": "CR-18",
    "input": {"shell": "bash", "tools": [], "command": "zz run"},
    "expected": {"calls": []},
    "note": "Rule 1: no recognised tool names -> nothing."
  }
]
```

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
