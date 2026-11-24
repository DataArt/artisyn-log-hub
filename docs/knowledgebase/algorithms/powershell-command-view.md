---
type: "Algorithm"
title: "PowerShell command view: parse masks, layout, file summary, highlighting"
description: "Claude Code's PowerShell tool commands get the same command view as Bash ones — formatted script, working dir, folded here-strings, FILES summary and colours — from the tree-sitter-powershell grammar, with same-length masks and a top-level ; split closing the grammar's gaps."
tags: [algorithm, powershell, shell-tab, okf]
generated: { by: "claude-code", at: "2026-11-22T00:00:00+04:00" }
reviewed: no
reviewer: none
---

# PowerShell command view: parse masks, layout, file summary, highlighting

## Purpose

On Windows Claude Code runs shell commands through its `PowerShell` tool. Those commands are as
long and dense as Bash ones (`Set-Location <abs>; Get-ChildItem … | Select-String …; git …`), so
the Shell tab and the tool-call view show them the way they show Bash: an indented script with a
WORKING DIR header, folded here-strings, a "which files did this touch" summary and syntax
colours, with the original text one click away ("Raw", "Copy original"). The result has exactly
the shape of the Bash view (`BashView`, `BashAnalysis`), so the UI, the "changes N" chip and the
OKF access extraction treat both shells the same. The Bash rules are in
[bash-command-view](bash-command-view.md); this doc only states what differs.

## Code

- Implementation: the repo-local package `@loghub/bash-view`, `packages/bash-view/src/`:
  - `ps-view.ts` (`buildPowerShellView`) — the composition the view rows run;
  - `ps-parse.ts` (`withPsTree`, `textOf`) — rule 1;
  - `ps-mask.ts` (`PS_MASKS`, `maskForParse`) — rule 1.2;
  - `ps-split.ts` (`topLevelSemicolons`, `topLevelPieces`) — rule 2;
  - `ps-format.ts` (`formatPowerShell`, `liftPowerShellCd`, `foldHereStrings`,
    `HERE_STRING_INLINE_MAX`, `psLiteral`) — rules 3–5;
  - `ps-wrap.ts` (`stripLhWrap`) — rule 6;
  - `ps-analyze.ts` (`analyzePowerShell`, `PS_CMDLETS`, `PS_ALIASES`, `PS_NOT_RUNS`) — rule 7;
    natives go to `analyzeWords` of `bash-analyze.ts`;
  - `display-paths.ts` (`toRepoRelative`) — rule 8, shared with Bash;
  - `ps-highlight.ts` (`powershellHighlightQuery`, `PS_CAPTURE_KIND`, `highlightPowerShell`) on
    `paintCaptures` / `highlightWith` of `bash-highlight.ts` — rule 9;
  - `shell.ts` (`ShellKind`, `shellOfTool`, `ShellParsers`, `buildShellView`,
    `analyzeShellCommand`) — the dispatch both shells share.
- Parser loaders (loading only, no rules): client
  `client/src/viewer/lib/bash-view/powershell-browser-parser.ts` (`getBrowserPowerShellParser`,
  `PS_HIGHLIGHT_QUERY`; reached only through `import()`, so a Bash-only session never fetches the
  1.1 MB grammar) on `bash-parser.ts` (`loadTreeSitterParser('powershell', assets)`); server
  `server/src/logs/okf/server-powershell-parser.ts` (`getServerPowerShellParser`) and
  `server-shell-parsers.ts` (`getServerShellParsers`), used by the OKF access extraction
  ([okf-access-extraction](okf-access-extraction.md)).
- Parser: `web-tree-sitter` 0.27.1 with the `tree-sitter-powershell` 0.26.6 grammar (only its
  `.wasm` and `queries/highlights.scm`). Nothing is executed. Structure always comes from the
  syntax tree; text patterns are used only on values the tree already isolated (masks, the `;`
  split of a command whose tree has an error, literal values, the redirect token, the wrap-prefix
  statements, the root match of `toRepoRelative`).
- Origin and evidence: the PoC
  [docs/pocs/2026-11-22-1443-powershell-format/](../../pocs/2026-11-22-1443-powershell-format/README.md)
  over 1 060 real distinct PowerShell commands: plain grammar 28 raw fallbacks (2.64 %), with the
  masks 7, with the `;` split **0** (2 partly formatted commands are invalid for PowerShell
  itself); Bash baseline 0.05 %. The formatted text gives the same token list and no new parse
  error in the real parsers of Windows PowerShell 5.1 and PowerShell 7.4 for 1 060 / 1 060
  commands, and formatting is idempotent.
- Twins: none (client and server run the same package).
- Test: `client/src/viewer/lib/bash-view/powershell-view.algo.test.ts` (vitest; WASM paths and the
  grammar's `highlights.scm` resolved with `createRequire`). The server side of `readAccess` is
  also exercised by the PowerShell rows of [okf-access-extraction](okf-access-extraction.md).

## Input and output

`buildPowerShellView(parser, command, root)` returns the `BashView` of the Bash doc: `{ok,
workDir, script, rawDisplay, folded, lineCount, rawLineCount, files: {changes, reads, runs,
inline, unresolved, deleted}, firstStatement}`. `analyzePowerShell(parser, src)` returns
`BashAnalysis` (`workDir`, `changes`, `reads`, `readAccess`, `runs`, `inline`, `unresolved`,
`deleted`, paths as written, relative to the analysis root). `root` is the session's repo root,
`''` when unknown.

## Rules

### 1. Parse with same-length masks (`withPsTree`)

1. The command is parsed as is. If the tree has no error it is used.
2. Else the command is parsed again after `maskForParse`: each mask below replaces text by text
   of **the same length**, in this order; a replacement of a different length is skipped. When
   no mask changed anything, or the masked tree also has an error, the plain tree is used.

   | id | gap | regex (JS, `g`) | replacement |
   |---|---|---|---|
   | `num-multiplier` | G1 `$s.Sum/1MB` | `(?<=\d)(?:KB\|MB\|GB\|TB\|PB)\b` (`i`) | zeros |
   | `at-word` | G2 `npm ls @nestjs/core` | `(?<=[\s,(])@(?=[\w.-]+[/@])` | `_` |
   | `var-path` | G3 `$HOME\.claude\x`, `$d/rows` | `(?<=[\s,(=])\$(?=[\w:]+[\\/][^\s;\|)]*)` | `_` |
   | `caret-brace` | G4 `HEAD^{tree}` | `\^\{(\w*)\}` | `^_` + word + `_` |
   | `comma-dot` | G5 `1, .vscode` | `(?<=,\s*)\.(?=\w)` | `_` |
   | `null-coalesce` | G6 `$a ?? 3000`, `??=` | `\?\?(?==?)` | `-f` |
   | `null-cond` | G7 `$cfg?.mode`, `?[` | `(?<=[\w}])\?(?=[.[])` | `_` |
   | `hash-comma` | G9 `@{…}, Length` | `(?<=\})(\s*),` | blanks + space |
   | `bs-quote` | G10 `"x \"y\""` | `\\"` | `` `" `` |
   | `ternary` | G8 `$c ? 'a' : 'b'` | `` \? ([^;\n?]*?) : `` | ` + a + ` |

3. Every module reads node text only as `src.slice(start, end)` of the **original** command
   (`textOf`), never the node's own text: offsets are identical, so masked characters never reach
   the script, FILES or the colours.

### 2. Fallback ladder (`formatPowerShell`, `analyzePowerShell`)

1. When the tree has an error even after masking, the command is cut at its **top-level `;`**,
   found by PowerShell's own lexing (`topLevelSemicolons`): `'…'` with `''`, `"…"` with backtick
   and `""` escapes and nested `$( … )` code, `@'…'@` / `@"…"@` here-strings, `#` and `<# #>`
   comments, backtick escapes, `()` `{}` `[]` depth. Each piece is trimmed (a trailing
   backtick-escaped blank is kept) and empty pieces dropped. Each piece is formatted alone (rules
   1 and 3); a piece that still has an error is copied verbatim; pieces are joined by newlines.
   The result is ok (`partial`).
2. No top-level `;`, or no piece that parses → **raw fallback**: `ok: false`, `script` = the
   (unwrapped, repo-relative) command, `folded` empty, empty FILES, `firstStatement` null. An
   empty command has no statement list and is a raw fallback too.
3. The analysis uses the same ladder: on a partial command the clean pieces are analysed in
   source order with **one shared state** (directory, variables, first workDir); each piece that
   still has an error, or the whole command when it has no `;`, adds 1 to `unresolved`.

### 3. Layout — only whitespace changes

`WIDTH` = 80, `IND` = two spaces (shared with Bash).

1. Statements of a statement list go one per line, but only where the source had a `;` or a
   newline between them (`empty_statement` nodes — the `;` — are dropped).
2. A node that fits `WIDTH` at its column (no newline, `col + length <= 80`) is copied as is.
3. A `pipeline` / `pipeline_chain` that does not fit breaks **after** every `|`, `&&` and `||`;
   continuation lines get the statement's indent + `IND`.
4. `{ BODY }` whose body is just a statement list (statement blocks of `if` / `foreach` / `for` /
   `while` / `do` / `try` / `catch` / `finally` / `function`, and script blocks passed as
   arguments) opens when its statement does not fit: `{` ends the line, the statements follow
   with `+IND` (rule 3.1), `}` on its own line.
5. Reached while expanding, `statement_block`, `else` / `elseif` clauses, `catch` clauses and
   `finally` expand even when they fit, so an expanded `if` / `try` is laid out as a whole.
6. Strings (`string_literal`, `expandable_string_literal`, here-string literals, verbatim string
   characters) and nodes with an error are always copied: a newline inside a string or its
   `$( … )` would change the value. Text before a node's first child and after its last child is
   copied (the quotes of `"…$x…"`).
7. **Token invariant**: removing blanks and `;` from the formatted script gives the same text as
   removing them from the command. The test checks it on every `ok` row.

### 4. Working dir (`liftPowerShellCd`)

1. The first statement is lifted into WORKING DIR when it is a single command named
   (case-insensitive) `Set-Location`, `cd`, `sl`, `chdir`, `Push-Location` or `pushd` with one
   literal argument, bare or after `-Path` / `-LiteralPath` (`-LP`, `-P`), and the first formatted
   line equals the statement's text. On a partial command the first piece is used.
2. Not lifted: `-` / `+` (location history), a non-literal argument (`$dir`), more arguments.

### 5. Here-string folding (`foldHereStrings`)

1. A here-string body (`@'…'@` or `@"…"@`) of more than `HERE_STRING_INLINE_MAX` = 8 lines is
   folded: the opener line and the closer line stay, the body becomes `# ▼ block <n>: <lines>
   lines, shown below`; `head` is the first line of the enclosing statement. Blocks are numbered
   in source order (on a partial command, piece by piece, continuing the numbering). 8 lines stay.

### 6. Hook wrap prefix (`stripLhWrap`)

1. Only when the stored command starts with `function __lhWrap` (word boundary): leading
   statements are dropped while each is a `function_statement` named `__lhWrap`, or an
   `if_statement` matching `^if\s*\(\s*Get-Command\s+-Name\s+'[^']+'\s+-CommandType\s+Application\b`
   that contains `Set-Item\s+-LiteralPath\s+'function:`; then a leading `;` and blanks. Works for
   the current hook and the 2.28.0 shape.
2. The formatted script, the preview, FILES and the OKF analysis use the unwrapped command;
   `rawDisplay` (Raw) keeps the stored text; "Copy original" copies the unwrapped command. Real
   transcripts keep the typed command (0 of 1 301 calls carried the prefix in the PoC), so the
   rule is defensive.

### 7. File summary (`analyzePowerShell`)

1. **Closed cmdlet table** `PS_CMDLETS` (canonical name → positional order, path parameters,
   read kind) and its aliases `PS_ALIASES`:

   | Cmdlet (aliases) | positional | paths | readAccess kind |
   |---|---|---|---|
   | Get-Content (`gc cat type`) | Path | read Path, LiteralPath | read |
   | Select-String (`sls`) | Pattern, Path | read Path, LiteralPath | grep, `pattern` |
   | Get-ChildItem (`gci ls dir`) | Path, Filter | read Path, LiteralPath | list |
   | Get-Item (`gi`), Test-Path | Path | read Path, LiteralPath | list |
   | Get-FileHash | Path | read Path, LiteralPath | read |
   | Set-Content (`sc`), Add-Content (`ac`) | Path, Value | write Path, LiteralPath | — |
   | Clear-Content (`clc`) | Path | write Path, LiteralPath | — |
   | Out-File | FilePath, Encoding | write FilePath, LiteralPath | — |
   | Tee-Object (`tee`) | FilePath | write FilePath, LiteralPath | — |
   | New-Item (`ni mkdir md`) | Path | write Path | — |
   | Remove-Item (`ri rm del erase rd rmdir`) | Path | write **and deleted** Path, LiteralPath | — |
   | Copy-Item (`cpi cp copy`) | Path, Destination | read Path, LiteralPath; write Destination | read |
   | Move-Item (`mi mv move`) | Path, Destination | write Path, LiteralPath, Destination | — |
   | Rename-Item (`rni ren`) | Path, NewName | write Path and `dirname(Path)/NewName` | — |
   | Expand-Archive | Path, DestinationPath | read Path, LiteralPath; write DestinationPath | read |
   | Invoke-WebRequest (`iwr irm curl wget invoke-restmethod`) | Uri | write OutFile; run label `Invoke-WebRequest` | — |

   The other value and switch parameters per cmdlet are in `PS_CMDLETS` (from the PoC
   `ps-analyze.mjs`). Common value parameters: `ErrorAction WarningAction InformationAction
   ErrorVariable WarningVariable InformationVariable OutVariable OutBuffer PipelineVariable
   Credential`; `WhatIf Confirm Verbose Debug Force` are switches. In a PowerShell call the
   Unix-like aliases (`rm cat ls cp mv tee mkdir curl`) are these cmdlets, never the Bash tables.
2. **Binding**: named parameters bind their next element; switches bind nothing (a `-X:value`
   switch consumes its `:value`); the remaining elements fill the positional parameters not bound
   by name, in order; extra positionals are ignored.
3. **Deleted and renamed**: `Remove-Item` paths are changes and `deleted` (rendered
   `<path> (deleted)`, same rule as Bash rule 5.10); `Rename-Item` writes Path and the new name in
   Path's folder.
4. **Names and parameters**: case-insensitive; a name with a `.exe` / `.cmd` / `.bat` / `.ps1`
   suffix or a path is reduced to its base name (a suffixed name is a program, never an alias); an
   abbreviated parameter resolves when it is a unique prefix among the cmdlet's parameters, else
   it is ignored; elements joined by `,` form one array argument (each element a path).
5. **Literal values and state**: a literal is a bare token not starting with `@`, `'…'` (`''` →
   `'`), `"…"` without `$` / backtick once variables are substituted, or an integer. `$name` /
   `${name}` are substituted from top-level `$name = <literal>` assignments; a non-literal
   assignment forgets the name; anything else is `unresolved` (counted, not listed). The
   `Set-Location` family outside a pipeline sets the directory for later relative paths, and the
   first one is the analysis root (`workDir`); a `-` / `+` / non-literal target clears it; inside
   a pipeline (also its script blocks) it does not carry out.
6. **Natives**: any other name not in `PS_NOT_RUNS` goes to the Bash word rules
   (`analyzeWords`, Bash rules 5.2–5.3 and 5.11) with its literal elements (a parameter as its
   text, `-x:v` glued): `git status`, `npm run build` run labels, `grep -n x f` reads, `node -e`
   inline notes. The call operator `&` takes the name from its command or string
   (`& "C:\tools\rg.exe"` → `rg`).
7. Commands inside script blocks (`ForEach-Object { … }`, `if` / `foreach` / `try` bodies) are
   analysed. `PS_NOT_RUNS` (`Write-Host`, `Write-Output`, `echo`, `Start-Sleep`, `Select-Object`,
   `Where-Object`, `ForEach-Object`, `Sort-Object`, `Measure-Object`, `Format-*`,
   `ConvertTo-Json`, `ConvertFrom-Json`, `Join-Path`, `Split-Path`, `Resolve-Path`,
   `Get-Location`, `Pop-Location`, `New-Object`, `Get-Command`, `exit`, `return`, `throw` and their
   aliases) produce nothing. Run labels of other non-table names use the lower-cased base name.
8. **Redirects and non-files**: `redirection` nodes with `>` / `>>` and bare tokens matching
   `^([0-9*]?>>?)(&[12])?(.*)$` (`2>$null`, `>out.txt`, `*>log.txt`) write their target; stream
   merges (`2>&1`) write nothing. `$null` and targets starting with `Env:` `HKLM:` `HKCU:`
   `Variable:` `Function:` `Alias:` `Cert:` `WSMan:` are never files — as a redirect target or a
   parameter value.
9. A read that is also a change is listed only under changes (as in Bash).
10. **readAccess** (for OKF): each read with its cmdlet's kind; `Get-Content -TotalCount N` /
    `-Head N` / `-First N` → `range {from: 1, to: N}`, `-Tail N` / `-Last N` → `range {from: -N,
    to: null}`; a piped `Select-Object -First` gives no range; `Select-String -Pattern` (or its
    first positional) is the `pattern`; natives give the Bash `readAccess`.

### 8. Repo-relative display

1. `toRepoRelative` exactly as Bash rule 6 (both separator spellings of a Windows root, msys
   form, case-insensitive), applied to `script`, `rawDisplay`, `workDir`, folded `head` / `body`,
   `changes`, `reads`, `deleted` and `firstStatement`, never to `runs` / `inline`.
2. Paths in FILES use `/`: the analysis joins with `/` (`joinPath`), so `out\b.json` shows as
   `out/b.json`; the script keeps the command's own `\`.
3. `firstStatement` is the first non-empty script line after the lift (before folding), trimmed.
4. `lineCount` counts the lines of the shown script; `rawLineCount` those of the stored command.

### 9. Highlighting (`highlightPowerShell`)

1. Query: `powershellHighlightQuery(scm)` = the grammar's `queries/highlights.scm` plus
   `(command_parameter) @flag`, `(redirection) @redirect` and
   `((generic_token) @redirect (#match? @redirect "^[0-9*]?>"))` (an unspaced `2>$null` is a
   bare token). Capture → kind (`PS_CAPTURE_KIND`): `keyword`, `operator` → keyword; `string` →
   string; `variable` → variable; `function` → command; `comment` → comment; `flag` → flag;
   `redirect` → redirect; `number`, `property`, `type`, `delimiter`, `array`, `assignvalue` stay
   plain. Painting (largest node first, inner captures win, merged neighbours) is Bash rule 7.3.
2. When the text has a syntax error and its masked copy (rule 1.2) parses clean, the captures are
   taken from the masked copy — offsets are identical; otherwise from the text itself.

## Edge cases

- Layout: pipeline over `WIDTH` PV-01, fitting PV-02; `;` and newline statements PV-03;
  `foreach` opened PV-04; `try` / `catch` / `finally` all expanded PV-05; `if` / `else` PV-06;
  fitting `if` kept on one line PV-10; `&&` / `||` chain PV-07; long string never broken PV-09;
  a pipeline holding a here-string breaks PV-25; a script block that fits its continuation line
  PV-47.
- Masks: G1 PV-11, G2 PV-12, G3 PV-13, G4 PV-14, G5 PV-15, G6–G8 (PowerShell 7 `??`, `?.`,
  ternary) PV-08, G9 PV-16, G10 PV-17; `$d/c.txt` substituted through the mask PV-41.
- Fallback: `;`-split partial with one verbatim piece PV-18; one state shared by the pieces PV-51; raw fallback PV-19; empty command
  PV-20.
- Lift: `Set-Location` of the root shown as `.` PV-21; `cd -Path '…'` PV-22; `cd -` PV-23;
  non-literal target PV-24; cwd tracking and a pipeline `Set-Location` not carried out PV-45.
- Here-strings: 9 lines folded PV-25, 8 lines stay PV-26.
- Wrap prefix: current hook PV-27, 2.28.0 hook PV-28, `__lhWrapper` not cut PV-29.
- FILES: the FR-9 acceptance example PV-30; every alias — readers PV-31, writers PV-32,
  Remove-Item PV-33, copy / move / rename PV-34, web PV-35; abbreviations (unique, ambiguous)
  PV-36; arrays and quoted paths with spaces PV-37; Windows root and separators PV-38; `$null`
  and provider drives PV-39; redirect tokens and nodes PV-40; variable substitution and
  forgetting PV-41; Rename-Item PV-42; natives and `.exe` PV-43; readAccess ranges / pattern /
  list PV-44; case-insensitive names, Copy-Item / Expand-Archive / Get-FileHash PV-46; script
  block analysed PV-47; switches, `-Confirm:$false`, `PS_NOT_RUNS`, a lower-cased run label PV-48;
  Out-File / Tee-Object / New-Item / Move-Item grouped PV-49; call operator `&` PV-50; a variable
  path unresolved PV-13.
- Highlighting: command / flag / string / variable / comment PH-01; keywords and both redirect
  shapes PH-02; captures from the masked copy PH-03; empty text PH-04.

## Examples

Two kinds of rows, as in the Bash doc.

- **View rows** have `input.command` and optional `input.root` (default `''`). The test runs
  `buildPowerShellView(parser, command, root)` and compares the listed keys of `expected`: `ok`,
  `workDir`, `script`, `rawDisplay`, `folded`, `lineCount`, `rawLineCount`, `firstStatement` from
  the view; `changes`, `reads`, `runs`, `inline`, `unresolved`, `deleted` from `view.files`;
  `changeGroups` / `readGroups` are `displayGroups('changes' | 'reads', list)`; `readAccess` is
  `analyzePowerShell(parser, stripLhWrap(parser, command)).readAccess`. Keys not listed are not
  checked. On every `ok` row the test also checks the token invariant (rule 3.7).
- **Highlight rows** have `input.highlight: true`. The test runs `highlightPowerShell(parser,
  command, powershellHighlightQuery(<grammar highlights.scm>))` and maps each segment to
  `[kind, text]`.

Commands are anonymised (`C:\work\acme-app`, `/work/acme-app`); the wrap-prefix rows carry the
prefix the current and the 2.28.0 hook build for `git` (session dir `C:\work\sess`).

Rows (55): [`docs/algorithm-examples/powershell-command-view.json`](../../algorithm-examples/powershell-command-view.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- No masks (rule 1.2) → PV-08, PV-11–PV-17 fall back or go partial; a mask that changes the
  length → offsets shift and PV-08 / PV-11 show masked characters; node text read from the tree
  instead of the source → PV-08 (`-f` instead of `??`), PV-14 (`HEAD^_tree_`).
- No `;` split → PV-18 raw; a broken piece not counted → PV-18 (`unresolved` 0); pieces not
  sharing one state → PV-51 (`$f` unresolved).
- Pipelines broken at `>= WIDTH` or never → PV-02 / PV-01; chain operators not broken → PV-07.
- A fitting `if` opened → PV-10; clauses expanded only when they do not fit → PV-05, PV-06.
- Strings broken → PV-09; token invariant violated → any `ok` row.
- `cd -` lifted → PV-23; non-literal lifted → PV-24; `-Path` form not lifted → PV-22.
- Here-strings folded at `>= 8` → PV-26; never → PV-25.
- Wrap prefix not cut → PV-27, PV-28 (script starts with `function __lhWrap`); cut without the
  word boundary → PV-29.
- Remove-Item paths not deleted → PV-30, PV-33; deleted paths dropped from changes → PV-30
  ("changes 1").
- An alias missing from `PS_ALIASES` → PV-31–PV-35; the Unix aliases sent to the Bash tables →
  PV-31 (`type c.txt` a run, not a read), PV-33 (`ri` / `del` runs).
- Ambiguous abbreviations resolved to the first match → PV-36 (`5` / b.txt binding); arrays not
  joined → PV-37, PV-15.
- `$null` / provider drives taken as files → PV-39; `2>&1` taken as a file → PV-40; unspaced
  redirect tokens ignored → PV-40.
- Variables not substituted → PV-41 (`out/b.json` unresolved); a non-literal assignment not
  forgetting → PV-41 (`out/e.txt` read).
- Rename-Item new name not in Path's folder → PV-42 (`new.md`).
- Natives not sent to `analyzeWords` → PV-43; `.exe` not stripped → PV-43 (`git.exe log`);
  `&` names not resolved → PV-50 (`unresolved` 1).
- `Set-Location` in a pipeline applied → PV-45 (`x/tsconfig.json`).
- `Get-Content` ranges swapped or missing, a piped `Select-Object -First` given a range → PV-44.
- Script blocks not analysed → PV-47, PV-04.
- `-Confirm:$false` value taken as a positional → PV-48.
- The `#match?` redirect capture missing → PH-02 (`2>$null` plain); highlighting the plain text
  when only the masked one parses → PH-03.

## Where the result is visible

Session pane → Shell tab (list preview, "changes N", the `pwsh` badge on mixed sessions) and its
details pane, the Logs tab's PowerShell tool-call modal and the Context Growth step modal: WORKING
DIR, FILES (Changes with `(deleted)` / Reads / Runs / Inline, "+ N not resolved"), the formatted
COMMAND with fold toggles and colours; server side, the OKF accesses of PowerShell calls.
