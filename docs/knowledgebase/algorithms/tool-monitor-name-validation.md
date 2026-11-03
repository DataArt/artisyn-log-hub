---
reviewed: no
reviewer: none
---

# Tool monitor name validation: which CLI tool names may be monitored

## Purpose

The Tools/MCP tab lets a user name CLI tools that the hook wraps (a shim on the agent's `PATH`).
A name must be a bare executable name — never a path or shell syntax — and must never be the
agent's own shell, a tool the wrapper itself runs, agent infrastructure, a process-control
command or a shell builtin: wrapping any of those would break the agent's session or loop the
wrapper into itself. This rule decides, for a typed name, whether it is accepted and, if not,
why.

## Code

- Implementation: `packages/tool-monitor/src/index.ts` (`@loghub/tool-monitor`:
  `validateToolName`, `denylistRole`, `normalizeToolName`, `TOOL_DENYLIST`, `TOOL_NAME_MAX`),
  used by the server (`server/src/logs/tool-monitoring/tool-monitor-config.service.ts`, the
  config PUT) and the client (the repository settings' "Monitored Tools" tab).
- Twins: the hook's plain-JS copy `hook/.claude/telemetry_tool/tool-wrap-names.js` (same
  functions, same messages); the hook drops any name that fails, whatever the server sent.
- Test: `server/src/logs/tool-monitoring/tool-monitor-name-validation.algo.spec.ts` (jest, the
  shared package) and the hook's `hook/.claude/telemetry_tool/__tests__/tool-wrap-names.algo.test.js`
  (`node --test`, the twin). Both run every row.

## Rules

1. **Order.** The checks run in this order and the first failing one is the result: empty →
   too long → bad characters → denylisted. A name that passes all four is accepted
   (`{ ok: true }`). The name is **not** trimmed first.
2. **Empty.** A name of length 0 → `empty`, message `Tool name is required`.
3. **Too long.** More than `TOOL_NAME_MAX` = 64 characters (UTF-16 length) → `too_long`, message
   `Tool name must be at most 64 characters`. Exactly 64 is allowed.
4. **Bad characters.** The name must match `^[A-Za-z0-9._-]+$` (ASCII letters, digits, `.`, `_`,
   `-`) and must not be `.` or `..`. Anything else — a path separator `/` or `\`, a drive colon,
   whitespace (also leading or trailing), shell metacharacters `; | & $ ( ) < > [ ] * ? ' "`,
   non-ASCII letters — → `bad_chars`, message
   `Tool name may contain only letters, digits, ".", "_" and "-" (no paths)`.
5. **Denylist.** The comparison key is the name in lower case with one trailing `.exe`, `.cmd`,
   `.bat` or `.ps1` removed (`normalizeToolName`). If the key is on the denylist → `denylisted`,
   message `` `<name as typed>` <role text> ``:

   | Role | Names | Role text |
   |---|---|---|
   | `shell` | `bash sh zsh dash fish ksh powershell pwsh cmd wsl` | is the agent's shell and cannot be monitored |
   | `wrapper` | `node tee env cygpath cat printf mkdir date command` | is used by the wrapper itself and cannot be monitored |
   | `agent` | `claude git npx npm` | is agent infrastructure and cannot be monitored |
   | `process` | `sudo su doas runas exec nohup timeout xargs time` | is a process-control command and cannot be monitored |
   | `builtin` | `cd echo export source . set alias exit eval trap read test [ true false type which where` | is a shell builtin and cannot be monitored |

   `.` and `[` are on the list but never reach this step: rule 4 rejects them first.
6. Only an exact key match counts: a name that merely contains a denylisted name (`bash2`,
   `git-lfs`) is accepted. A suffix other than the four above stays part of the key (`node.js`
   is accepted).

## Edge cases

- Boundary 64 / 65 characters: NV-02, NV-03.
- Empty: NV-04. Leading / trailing whitespace is not trimmed: NV-11.
- Path separators and a Windows path: NV-05, NV-06. Shell metacharacters: NV-07, NV-08, NV-09.
  Non-ASCII: NV-12. `.` / `..`: NV-10.
- Every denylist role: shell NV-13, NV-14; wrapper NV-16, NV-17; agent NV-18, NV-19; process
  NV-20, NV-21; builtin NV-22, NV-23.
- Case and executable suffix: NV-14 (`PowerShell.exe`), NV-19 (`NPX.cmd`), NV-23 (`Which.BAT`),
  NV-24 (`Git.PS1`); a suffix on an allowed name stays allowed: NV-25.
- `[` is denylisted but rejected as bad characters first: NV-15.
- Near-misses accepted: NV-26 (`bash2`), NV-27 (`node.js`), NV-28 (`git-lfs`).
- An over-long name that would also be bad and denylisted reports `too_long`: NV-29.

## Examples

`input.name` is the typed name. A row may instead give `input.repeat` and `input.times`: the name
is `input.repeat` repeated `input.times` times (so a 64-character name stays readable).
`expected` lists `ok` and, for a rejected name, `code`; denylisted rows also list `message`
(exact). `expected.role` is `denylistRole(name)` — the role from rule 5, `null` when the key is
not on the list (computed independently of the other checks). The test compares
`{ ...validateToolName(name), role: denylistRole(name) }` against `expected` as a subset match.

Rows (29): [`docs/algorithm-examples/tool-monitor-name-validation.json`](../../algorithm-examples/tool-monitor-name-validation.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- `>=` instead of `>` for the length limit -> NV-02.
- Name trimmed before checking -> NV-11 (would be accepted).
- Denylist compared case-sensitively -> NV-14, NV-19, NV-23.
- Executable suffix not stripped -> NV-14, NV-19, NV-24; any suffix stripped (`node.js` -> `node`)
  -> NV-27.
- Substring / prefix denylist match -> NV-26, NV-28.
- Denylist checked before the character rule -> NV-15 (`denylisted` instead of `bad_chars`).
- Length checked after characters -> NV-29.
- `..` allowed because it matches the pattern -> NV-10.
- Message quoting the normalised key instead of the typed name -> NV-14, NV-19.

## Where the result is visible

- Repository → **Settings** → "Monitored Tools" tab: the inline error under the name
  field (message text) and the disabled Add button.
- API: `PUT /api/v1/repositories/:repoId/tool-monitoring/config` answers 400 with the message for a
  rejected name; `GET /api/v2/tool-monitoring/config` (hook) never returns one (DD-2).
- Hook: a rejected name gets no shim and is never wrapped (safe behaviour).
