# PoC — PowerShell tool commands: parse, format, FILES summary

Task: [2026-11-22-bash-tab-powershell](../../tasks/todo/2026-11-22-bash-tab-powershell/requirements.md)
(Shell tab: PowerShell calls get the full Bash-level view). Follows the Bash PoC
[2026-10-22-2035-bash-pretty-format](../2026-10-22-2035-bash-pretty-format/README.md).

## Questions

1. Does `tree-sitter-powershell` 0.26.6 parse the PowerShell commands Claude Code really runs, and
   is the fallback (raw text) rate "not worse than Bash" (FR-6)? Where it fails, can the gap be closed
   without forking the grammar?
2. Can a whitespace-only layout (statement per line, pipelines broken, blocks indented, here-strings
   folded) be built from the tree so the formatted text is **provably the same program** in both
   Windows PowerShell 5.1 and PowerShell 7?
3. What does the FILES analysis (FR-9) have to cover — cmdlets, parameters, abbreviations, redirect
   shapes, variable-built paths?
4. Do stored commands carry the hook's `__lhWrap` prefix (FR-6a), and can it be cut by syntax?
5. Do the commit / PR counters (FR-12) need more than lifting the `name === 'Bash'` gate?
6. Highlighting: do the grammar's `highlights.scm` plus our two captures compile and tag as FR-8 says?

## How to run

```sh
npm install --ignore-scripts          # tree-sitter-powershell 0.26.6 + web-tree-sitter 0.27.1 (the repo's pin)
# a corpus = JSON array of PowerShell command strings, e.g. exported from a Log Hub DB (query below)
node parse-stats.mjs  <corpus.json…> [--show N]   # plain grammar parse rate + error snippets
node verify.mjs       <corpus.json…> [--no-mask]  # format + lift + fold over the corpus, self-checks
powershell -NoProfile -File oracle.ps1 out-pairs.json        # oracle: Windows PowerShell 5.1
docker run --rm -v "<this dir>:/poc" -w /poc mcr.microsoft.com/powershell:latest \
  pwsh -NoProfile -File oracle.ps1 out-pairs.json            # oracle: PowerShell 7
node fallbacks.mjs    <corpus.json…>             # commands left raw → out-fallbacks.json (feed to oracle)
node samples.mjs      [<corpus.json…>]           # hand-written AC / PowerShell 7 samples → out-sample-pairs.json
node analyze-stats.mjs  <corpus.json…>           # what the FILES analysis has to cover
node analyze-verify.mjs <corpus.json…>           # prototype FILES analysis: AC example + coverage
node highlight-and-commits.mjs <corpus.json…>    # FR-8 captures + FR-12 commit count, regex vs tree
node commit-anchor.mjs                           # FR-12: today's regex anchor vs a PowerShell-aware one
node wrap-prefix.mjs                             # FR-6a: hook prefix (current + 2.28.0 fixture) parse + strip
node bash-baseline.mjs <bash-corpus.json>        # Bash baseline: tree-sitter-bash parse error rate
node tree.mjs '<command>'                        # dump a syntax tree (plain parse, no masks)
```

Corpus export (read-only), PowerShell or Bash:

```sql
select coalesce(json_agg(cmd),'[]') from (select distinct c->'input'->>'command' as cmd
from logs l, jsonb_array_elements(l.body) line,
 jsonb_array_elements(case when jsonb_typeof(line->'message'->'content')='array' then line->'message'->'content' else '[]'::jsonb end) c
where l.log_type in ('claude','claude-subagent') and c->>'type'='tool_use' and c->>'name'='PowerShell'
  and c->'input'->>'command' is not null) t;
```

Corpora and every `out-*` file are gitignored — they are real commands with local paths. Nothing is
ever executed; commands are only parsed (by tree-sitter and by PowerShell's own `Parser.ParseInput`).

## Approach

- `ps-format.mjs` — layout. Output = the original token sequence; only whitespace changes, only where
  PowerShell allows a newline: between statements (only where the source had `;` or a newline), after
  `{` / before `}` of a block whose body is a statement list (statement blocks of `if` / `foreach` /
  `while` / `for` / `do` / `try` / `catch` / `finally` / `function`, and `{ … }` script blocks passed as
  arguments), after `|` / `&&` / `||` of a pipeline longer than 80 columns. A statement that fits is
  copied; strings (and `$( … )` inside them) are never touched; when an `if` / `try` is expanded all its
  clause blocks expand. `liftCd` lifts a leading `Set-Location|cd|sl|chdir|Push-Location|pushd <literal>`;
  `foldHereStrings` folds here-string bodies over 8 lines.
- `ps-mask.mjs` — **same-length masks** for the grammar gaps found (G1–G10 below). Tried only when the
  plain parse has an ERROR (`parseSrc`); the masked text is parsed, but every consumer reads node text
  as a slice of the **original** command by index (same length → same indexes), so a mask never shows.
- `ps-split.mjs` — when even the masked tree has an ERROR: cut the command at its top-level `;`
  (PowerShell's own lexing: quotes, `$( )` in strings, here-strings, comments, backticks, brackets),
  format each piece alone, copy a piece that still fails verbatim.
- `ps-analyze.mjs` — FILES: cmdlet table (positional order, path parameters, value vs switch
  parameters, aliases, unambiguous abbreviations), `a, b` arrays, `Rename-Item` (`NewName` in the
  `Path` folder), redirects (real `redirection` nodes and unspaced `2>$null` / `*>file` tokens),
  `$null` / provider drives ignored, `$x = '<literal>'` substitution, `Set-Location` tracking, native
  commands → run labels like the Bash view.
- `oracle.ps1` — independent check with the real PowerShell parser: original and formatted text must
  give the same token list (ignoring NewLine / Semi / LineContinuation), and no new parse error.

## Result

Corpus: **1 060 distinct PowerShell commands** (1 044 + 18 from two real Log Hub installs, 2 shared;
1 301 PowerShell calls in the larger one). Bash baseline from the larger install: **28 272 distinct
Bash commands, 13 parse errors (0.05 %)**.

### 1. Parse rate and grammar gaps

| | plain grammar | + masks | + `;`-split |
|---|---|---|---|
| full tree, formatted | 1 032 | 1 053 | **1 058** |
| partly formatted (some pieces verbatim) | — | — | **2** |
| raw fallback | 28 (2.64 %) | 7 | **0** |

The 2 partly formatted commands are invalid PowerShell for PowerShell itself too (both oracles report a
parse error in the original). **No valid command falls back to raw: 0 % vs Bash 0.05 %.**

Grammar gaps (all valid PowerShell 5.1 and 7, confirmed by both oracles), with the mask that closes them:

| # | Shape | Example | Mask (same length) |
|---|---|---|---|
| G1 | numeric multiplier after an operator | `$s.Sum/1MB` | `MB` → `00` |
| G2 | bare word starting with `@` (not a splat) | `npm ls @nestjs/core` | `@` → `_` |
| G3 | bare word = variable + path | `$HOME\.claude\x`, `$d/rows` | `$` → `_` |
| G4 | `^{…}` in a bare word | `git rev-parse HEAD^{tree}` | braces → `_` |
| G5 | bare word starting with `.` after `,` | `-Force 1, .vscode` | `.` → `_` |
| G6 | PS 7 `??` / `??=` | `$env:PORT ?? 3000` | `??` → `-f` |
| G7 | PS 7 `?.` / `?[` | `$cfg?.server` | `?` → `_` |
| G8 | PS 7 ternary | `$c ? 'a' : 'b'` | `?`, `:` → `+` |
| G9 | hashtable then `,` in arguments | `Select-Object @{n='p';e={…}}, Length` | `,` → space |
| G10 | bash-style `\"` inside `"…"` (ssh / wsl / docker args) | `ssh h "x \"y\" z"` | `\"` → `` `" `` |

PowerShell 7-only syntax (G6–G8) never occurs at PowerShell level in the corpus (only inside JS strings
passed to `node -e`), but parses and formats in the samples. `&&` / `||` parse natively.

### 2. Layout is the same program

| Check | Result |
|---|---|
| exceptions | 0 |
| tree-sitter: formatted text re-parses without a new error | 1 060 / 1 060 |
| tree-sitter: same leaf token sequence | 1 059 / 1 060 (the other is a partly formatted invalid command) |
| **oracle Windows PowerShell 5.1: same tokens, no new error** | **1 060 / 1 060** |
| **oracle PowerShell 7.4.2 (docker): same tokens, no new error** | **1 060 / 1 060** |
| oracle on the 8 hand-written samples (AC shapes, `&&`/`||` breaks, ternary, `??`, `?.`) | 8 / 8 both; 5.1 reports the two PS 7-only samples as invalid input, as expected |
| idempotent `format(format(x)) === format(x)` | 1 060 / 1 060 |
| layout changed | 958 commands; 1 201 → 6 282 lines |
| working dir lifted | 80 |
| here-string folded (> 8 lines) | 1 (7 commands have here-strings) |
| time | 0.22 ms avg, 10 ms max per command (Node, after WASM init) |

Bugs the oracle caught while building it, now rules: a newline inside a string's `$( … )` changes the
string (strings are verbatim), and the text before the first / after the last child of a node must be
copied (quotes of `"…$x…"`).

### 3. FILES analysis

- Closed-list cmdlets used (commands): `Select-String` 180, `Get-ChildItem` 165, `Get-Content` 154,
  `Test-Path` 154, `Move-Item` 38, `Remove-Item` 36, `Get-Item` 25, `Copy-Item` 13, `New-Item` 12,
  `Set-Content` 8, `Out-File` 3, `Tee-Object` 2, `Add-Content` 1.
- File-touching commands outside the FR-9 list: `Invoke-WebRequest`/`iwr`/`irm` 79 calls (`-OutFile`
  in 1), `Get-FileHash` 7, `Expand-Archive` 3 → added to the table (`-OutFile` written; `Get-FileHash`
  read; `Expand-Archive` `-Path` read, `-DestinationPath` written). `Start-Process` (11) is a run;
  `Resolve-Path` / `Join-Path` / `Split-Path` touch no file.
- Parameters: always written in full in the corpus (no abbreviation seen); the abbreviation rule of
  FR-9 stays for correctness. Most used: `Select-String -Pattern/-Path`, `Get-ChildItem
  -Recurse/-Filter`, `Get-Content -Raw/-Tail/-TotalCount/-Encoding`, `Move-Item -Path/-Destination`,
  `Remove-Item -Force/-Recurse/-Confirm:$false`.
- Arguments arrive wrapped in a chain of single-child `*_expression` nodes — unwrap before reading.
  `a.txt, b.txt` arrives as sibling elements joined by anonymous `,` tokens, not as one node.
- Redirects: 94 real `redirection` nodes, but **64 unspaced `2>$null` / `*>$null` are plain
  `generic_token`s** — a text rule on the token is needed (also for highlighting); 67 redirect to
  `$null`, 66 `Out-Null`.
- Variable-built path arguments: 167 of ~1 100 (`$d`, `"$s\x"`, `$d/rows`); with `$x = '<literal>'`
  substitution (like the Bash view's `VAR=…`) they resolve where the variable is literal.
- Prototype coverage: 301 commands get a FILES entry, 99 a "changes" count, 888 a run label; 65 have an
  unresolved path. The FR-9 acceptance example gives exactly `a.json` read, `out/b.json` + `tmp/x`
  changed.

### 4. `__lhWrap` prefix

0 of 1 060 stored commands (and 0 of 1 301 calls) carry it: the transcript keeps the command the agent
typed; `updatedInput` is not written back (same finding as
[2026-10-28-1140-cli-tool-capture](../2026-10-28-1140-cli-tool-capture/README.md)). The prefix that the
current hook and the frozen 2.28.0 fixture build parses without an error, and is cut exactly by syntax:
leading `function __lhWrap {…}` + `if (Get-Command -Name '<t>' -CommandType Application …) { Set-Item
-LiteralPath 'function:<t>' … }` statements (`wrap-prefix.mjs`: both shapes stripped, typed command
recovered byte-for-byte, a plain command untouched).

### 5. Commit / PR counters

On the corpus today's shared regex already counts every PowerShell `git commit` the tree finds (10 = 10;
0 `gh pr create`), so on real data FR-12 is the `name === 'Bash'` gate. PowerShell spellings it misses:
`if ($?) { git commit }`, `(git commit) | …`, `git.exe commit`, `& "git.exe" commit`. A PowerShell anchor
`(?:^|[\n;&|{(])\s*(?:&\s*)?['"]?` + optional `.exe` + optional closing quote counts all of them and still
skips `"…git commit"` inside a string (`commit-anchor.mjs`).

### 6. Highlighting

The grammar's `highlights.scm` capture names are exactly `array assignvalue comment delimiter function
keyword number operator property string type variable`; with `(command_parameter) @flag` and
`(redirection) @redirect` appended the query compiles and tags `Set-Content` function, `-Path` flag,
`"x $a"` string, `$a` variable, `if` keyword, `> s.txt` redirect, `# done` comment. An unspaced
`2>$null` is a `generic_token` and gets no `redirect` capture unless a `#match?` capture is added.

### Not covered

Commands inside `node -e` / `bash -c` / `ssh "…"` strings are not analysed (as in the Bash view);
`switch`, `class`, `param()` blocks are copied verbatim.
