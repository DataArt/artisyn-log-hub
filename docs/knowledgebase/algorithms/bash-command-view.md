---
reviewed: no
reviewer: none
---

# Bash command view: layout, file summary, repo-relative paths, highlighting

## Purpose

Claude Code's Bash tool commands are long one-liners (`cd <abs>; a && b; for …; done | tail`),
often with heredocs and inline `node -e` scripts. The Bash view shows each command as a short,
indented script with a working-dir header, a "which files did this touch" summary and syntax
colours, so a reader understands what the command did without decoding it — while the
original text stays one click away ("Raw", "Copy original").

## Code

- Implementation: the repo-local package `@loghub/bash-view`, all under `packages/bash-view/src/`
  (shared by the client and the server; see `packages/bash-view/README.md` and
  [../repo-local-packages.md](../repo-local-packages.md)):
  - `bash-view.ts` (`buildBashView`) — the composition the rows run;
  - `bash-format.ts` (`formatBash`, `liftCd`, `foldHeredocs`, `WIDTH`, `IND`,
    `HEREDOC_INLINE_MAX`);
  - `bash-analyze.ts` (`analyzeBash`, `readKindOf`, `literal`, `groupByDir`, `displayGroups`,
    `GROUP_BY_DIR_ABOVE`, the command tables `W_CMDS`, `R_CMDS`, `SCRIPT_CMDS`, `NOT_RUNS`,
    `SUBCOMMAND_TOOLS`, `RUN_SCRIPT_TOOLS`, `GREP_CMDS`, `LIST_CMDS`, `FOR_VALUES_MAX`);
  - `display-paths.ts` (`toRepoRelative`);
  - `bash-highlight.ts` (`highlightBash`, `bashHighlightQuery`, `HIGHLIGHT_CLASS`);
  - `syntax.ts` — structural types of the syntax tree (`BashSyntaxNode`, `BashSyntaxTree`,
    `BashCapture`), the `BashParser` interface each side implements, and `withTree`. The package
    never imports `web-tree-sitter`.
- Parser loaders (loading only, no rules): client
  `client/src/viewer/lib/bash-view/bash-parser.ts` (`loadBashParser`) and `browser-parser.ts`
  (`HIGHLIGHT_QUERY` = `bashHighlightQuery(<grammar highlights.scm>)`, browser WASM assets);
  server `server/src/logs/okf/server-bash-parser.ts` (`getServerBashParser`, WASM from
  `dist/wasm/` or `node_modules`), used by the OKF access extraction.
  - UI: `client/src/viewer/pages/repository/session-log/tool-call-view/BashFileSummary.tsx`
    shows the FILES lists through `displayGroups` (rule 5.7).
- Parser: `web-tree-sitter` 0.27.1 with the `tree-sitter-bash` 0.25.1 grammar. Nothing is
  executed. The structure — statements, chains, loops, commands, arguments, redirects, heredocs,
  subshells — always comes from the syntax tree. Text patterns are used only on single values the
  tree already isolated: the command tables and the base name of a command (`bash-analyze.ts`),
  removing backslash escapes from a word or a double-quoted string's text, the absolute-path and ignored-path checks, finding a
  heredoc body's text in the formatted script (`foldHeredocs`, `indexOf`), and the root match of
  `toRepoRelative` (a regular expression over the display text, rule 6).
- Origin: the PoC `docs/pocs/2026-10-22-2035-bash-pretty-format/bash-view.mjs` (checked on 880
  real commands).
- Twins: none (client and server run the same package).
- Test: `client/src/viewer/lib/bash-view/bash-view.algo.test.ts` (vitest; imports the package
  through the `@loghub/bash-view` alias; WASM paths and the grammar's `highlights.scm` resolved
  with `createRequire`). The server side of `readAccess` is also exercised by the Bash rows of
  [okf-access-extraction](okf-access-extraction.md), which run with the real server parser.

## Input and output

`buildBashView(parser, command, root)` returns `{ok, workDir, script, rawDisplay, folded,
lineCount, rawLineCount, files: {changes, reads, runs, inline, unresolved}, firstStatement}`.
`root` is the session's repo root (`ParsedSession.repoRoot`), `''` when unknown. `lineCount` and
`rawLineCount` are defined by rule 1.3 (the COMMAND header's "N lines (was M)").

## Rules

### 1. Parse

1. The command is parsed as bash. If the syntax tree has an error anywhere (`hasError`),
   `ok = false`: `script` = `rawDisplay` (the command made repo-relative, rule 6), `workDir`
   = null, no folds, empty file lists, `unresolved` = 0, `firstStatement` = null. The UI then
   shows the plain text with no toggle, no FILES and no colours. Steps 2–5 apply only when
   `ok = true`.
2. An empty command parses without error: `ok = true`, `script` = `''`, nothing found,
   `firstStatement` = null; highlighting returns no segments.
3. `rawLineCount` = the number of newlines in the original command + 1; `lineCount` = the number
   of newlines in the final `script` (after the lift and folding) + 1. When `ok = false` both are
   the command's count. (An empty text counts as 1 line.)

### 2. Layout (`formatBash`) — only whitespace changes

`WIDTH` = 80 columns, `IND` = 2 spaces. "Fits" always means: the node's source text has no
newline and the current indent plus that text is at most `WIDTH` characters.

1. Each top-level statement goes on its own line; `;` and newlines between statements become a
   line break, a trailing `&` stays on its statement's line as ` &`.
2. A `&&` / `||` chain (a `list`) or a `|` / `|&` chain (a `pipeline`) that fits stays on one
   line. A longer chain is broken after each operator: the operator ends the line and every
   following operand starts on a new line indented by one more `IND`; each operand is printed by
   these same rules. A list and a pipeline are separate chains: a pipeline inside a `&&` list is
   one operand of the list (and is broken on its own only if it does not fit at its indent). A
   chain with a comment inside is copied verbatim (a comment ends its line, so such a chain never
   fits). The grammar puts no other operator inside a chain; the code's "other operator → verbatim"
   guard is defensive and not reachable.
3. `for v in …; do … done` and `while …; do … done` / `until …; do … done` (`until` is a
   `while_statement` too): the header line ends with `; do`, the body statements are indented by
   `IND`, `done` closes on its own line — even when the whole loop would fit on one line. The
   `for … in` header is `for <var> in <words joined by one space>; do`; any other loop header is
   its source text from the keyword to the end of the condition, then `; do` — so `for v; do` (no
   `in`) has the header `for v; do`. When the `for`
   header (including the current indent) is longer than `WIDTH` and has more than 2 words, it
   becomes `for <var> in \` followed by one word per line indented by two `IND`, each ending in
   ` \`, the last one in `; do`; with 1 or 2 words it stays on one line however long. The header
   is rebuilt from the tree, not copied: extra spaces and `\`-newline continuations between
   `for`, the variable, `in` and the words are dropped (each word's own text is kept). Verbatim
   fallbacks: a `for` word that contains a newline, or a `while` / `until` header that contains a
   newline, makes the whole loop verbatim. `select v in …; do … done` is a `for_statement` too,
   but its keyword is `select`, not `for`, so it takes the other-loop header (the source from
   `select` to its last word, then `; do`) and is never split, however long. A C-style `for ((…))` is a different node
   (`c_style_for_statement`) and is copied verbatim (rule 2.6). The code also copies a loop
   verbatim when it has no `do … done` body or no header node; the grammar never produces such a
   loop without a syntax error, so these guards are defensive and not reachable.
4. `if c; then … [elif c; then …] [else …] fi` is laid out the same way: `if <c>; then`,
   `elif <c>; then`, `else` and `fi` on their own lines, bodies indented by `IND`. An `if` or
   `elif` condition that contains a newline makes the whole `if` verbatim (also when the `if`
   clause before an `elif` already fit). An empty `if` / `elif` condition would also give
   verbatim; the grammar requires a condition, so that guard is defensive and not reachable.
5. `{ … }` and `( … )` stay on one line when they fit; otherwise the brace or paren is on its own
   line, the body statements are on their own lines indented by `IND` (rule 2.1 inside), and the
   closing brace or paren is on its own line.
6. Everything else (simple commands, strings, `$(…)`, `case`, functions, C-style `for`, a
   statement with a heredoc) is copied verbatim; multi-line verbatim text is never re-indented.
   "A statement with a heredoc" is checked on each statement of a block (top level, and inside
   an opened loop, `if`, `{ … }` or `( … )`) and means a heredoc **anywhere** among its
   descendants: a loop, `if`, group or subshell with a heredoc somewhere in its body, or a
   statement with a heredoc inside `$(…)`, is copied verbatim as a whole, never opened — so no
   layout ever adds indentation or line breaks around a heredoc's body and terminator lines.
   No other statement can share a heredoc's lines: the grammar reads `;`, `&` or a further
   statement after a heredoc start on its line (`cat <<'EOF' > a.txt; echo ok`) as a syntax error,
   so the whole command is `ok = false` (rule 1.1), and it reads `&&` / `||` / `|` / `|&` there
   (`cat <<EOF && echo ok`) as part of the heredoc redirect — one statement, copied verbatim
   (its chained commands are still analysed, rule 5.5). A heredoc body folded out of such a
   statement keeps the whole first line, chained part included, as its `head` (rule 4.2).
7. **Token invariant (NFR-1):** the tokens of the formatted script, in order, are exactly those
   of the original command. A token is the text of a syntax-tree leaf, where a `heredoc_body`,
   `string_content` or `raw_string` node counts as one leaf; `;` and newline tokens and
   whitespace-only leaves are skipped (a `;` between statements becomes a line break). Only
   whitespace, line breaks, statement-separating `;` and the `\`-newline continuations that rule
   2.3 adds differ; a `\`-newline is not a leaf of the tree, so it is not a token.
8. A statement with redirects (`redirected_statement`, e.g. `for …; done > out.txt`) that fits
   stays on one line as written — even when it holds a loop or an `if`. Otherwise its body is
   laid out by these rules and the redirect text (from the end of the body to the end of the
   statement, as written) is appended to the body's last line; if that redirect text contains a
   newline (e.g. a `\`-newline before `>`), the whole statement is verbatim. A statement made
   only of redirects (`> empty.txt`, `< in.txt > out.txt`) is a `redirected_statement` with no
   body: when it fits it stays as written, otherwise it is copied verbatim — the same text, since
   it has no newline (a newline would end it).

### 3. Working dir (`liftCd`)

1. If the first top-level node is a plain command whose name is literally `cd` with exactly
   one argument, that argument is literal (rule 5, with no variables known) and its value is
   neither `''` nor starts with `-` (`cd -`, `cd -P` name no directory), and the statement's
   text is the formatted script's first line, that line is removed and the target becomes
   `workDir`.
2. `cd <dir> && …` is a chain, not a plain command, so it is **not** lifted and stays in the
   script. A leading comment is a top-level node too, so `# c` before the `cd` blocks the lift.
   `cd <dir> &` is a plain command, but its formatted line is `cd <dir> &` (rule 2.1), not the
   statement's text, so it is not lifted either.

### 4. Heredoc folding (`foldHeredocs`)

1. A heredoc body's lines are its text without the one trailing newline, split on newlines. A
   body with more than `HEREDOC_INLINE_MAX` = 8 lines is cut out of the script and replaced by
   the line `# ▼ block n: L lines, shown below`, numbered from 1 in source order. The marker
   replaces the **first** occurrence of the body text (with its trailing newline) in the script
   being built; bodies are handled in source order, so two identical bodies fold in order. A body
   whose text is not found in the script is not folded — a safeguard that is not reachable,
   because statements with heredocs are copied verbatim (rule 2.6) and the lift (rule 3) removes
   only a `cd` line.
2. `folded` lists `{n, head, body, lines}`: `head` is the first line of the statement that owns
   the heredoc, `body` the body without its trailing newline, `lines` its line count.
3. Bodies of 8 lines or fewer stay inline.

### 5. File summary (`analyzeBash`)

**Literal values.** A `word` or a `number` (backslash escapes removed: `\x` → `x`), a `'…'` raw
string (quotes removed, nothing unescaped), a `"…"` string whose parts are all literal (quotes
removed; in its text a backslash is dropped only before `$`, `` ` ``, `"`, `\` or a newline —
a backslash-newline disappears whole — and kept before anything else, as bash does: `"a\"b\x"` →
`a"b\x`), a `$VAR` / `${VAR}` (only the bare-name form) whose value is known, or a concatenation
of those. A concatenation is literal only when every part is: `$D/a.ts` with `D` unknown is not
literal, it does not become `/a.ts`. Anything else is not literal: as a path or a command name it
is not listed and increments `unresolved` instead.

**Paths.** Backslashes become `/`. A path starting with `/`, `X:/` or `~` is absolute and is never normalised (`/a/../b` stays as
written); any other path is joined to the current directory: the directory is split on `/` as it
is (a trailing slash leaves an empty last segment, so `cd /work/` then `a` gives `/work//a`), then
for each segment of the path `..` drops the last segment, `.` and empty segments are skipped and
anything else is appended; with no current directory it stays as written. A path whose literal
value (before the backslash conversion and the join) is `''`, `-`, a number `N` or `&N` is
ignored, and so is a path that starts with `/dev/` **after** the join (`/dev/null`, or
`../dev/null` from `/tmp`) — for every path, from a redirect or a command (so the option value in
`head -n 20` is not read). Through a redirect `&N` cannot arrive (after `>&` / `<&` the grammar
gives the target as the number `N`); it can only come from a command argument such as `\&1`.

1. **Redirects:** `>`, `>>`, `&>`, `&>>`, `>|`, `>&` → the target is a change; `<` → a read.
   `>& word` writes `word` like `&>` does; when the target is a number (`>&2`) it duplicates a
   descriptor and the path rule above ignores the number. Other operators (`<&`, the
   descriptor-closing `>&-` / `<&-`, which the grammar reads as single tokens with no target,
   heredocs, here-strings) add nothing. The code also skips a missing or file-descriptor target;
   a change or read operator always has a word or number target, so that guard is defensive and
   not reachable.
   Redirects are taken from three places of the tree: a `file_redirect` inside a command (one
   written before the command name, `> out.txt echo hi`), the redirects of a
   `redirected_statement`, and a `file_redirect` nested in a heredoc redirect
   (`cat <<'EOF' > out.txt`). As in bash, which opens the redirect targets before the command
   runs, a `redirected_statement`'s redirects are resolved **before** its body is walked, with
   the directory and variables of that moment: `cd /x > out.txt` writes `out.txt` in the
   directory before the `cd`, and in `f=a.txt; for f in b.txt; do :; done > "$f"` the target is
   `a.txt` (the loop has not set `f` yet, and after it `f` would be unknown).
   The grammar hangs the redirects on the whole body also when the body is a `&&` / `||` list or
   a pipeline (`cd sub && echo hi > a.txt`, `a | b > out`, `cd /x && cat <<EOF > a.txt`); bash
   binds them to the last command only. So the operands of such a list before its last one are
   walked first, in order with the same state; when the last operand is a pipeline, its elements
   before the last one are walked next, each as a pipeline element (rule 5.5); only then are the
   redirects resolved, and then the last command is walked (as a pipeline element when it is one,
   or when a `|` follows the heredoc start, rule 5.5). `cd sub && echo hi > a.txt` writes
   `sub/a.txt`.
2. **Commands.** The command name must be literal, else `unresolved` + 1 and none of the rules
   below apply — but the command's own redirects written before its name (rule 5.1) are still
   taken: they are files the shell opens whatever the command is (`> p.txt $C a.txt` changes
   `p.txt`). A command without a name exists only in a tree with an error (rule 1.1), so the
   code's guard for it is defensive and not reachable. The base of the name is the part after
   the last `/` or `\` (a backslash survives only in a quoted name, `'C:\bin\rm'`; unquoted
   backslashes are escapes). Positional = an argument whose
   literal value does not start with `-`, plus every non-literal argument.
   - `cd` → rule 5.5;
   - `rm mkdir touch tee chmod rmdir truncate` → every positional is a change;
   - `cat head tail less wc cut ls stat diff sort uniq file nl tac md5sum sha256sum` → every
     positional is a read;
   - `grep`, `rg` → every positional after the first (the pattern) is a read;
   - `sed`: the arguments are read in order; `-e <s>` / `--expression <s>` give a script `<s>`
     (not a path); `-f <f>` / `--file <f>` give a script file `<f>`, which is a read;
     `--expression=…` gives a script, `--file=<f>` a read of `<f>`; other arguments starting with
     `-` are flags. If none of these gave a script, the first remaining positional is the script.
     The other positionals are changes when a flag is `-i…` (also with a suffix glued on,
     `-i.bak`) or `--in-place[=…]`, else reads. A `-f` / `--file` with no argument after it
     gives the value `''`, which the path rule ignores — nothing is read and nothing is
     unresolved;
   - `mv` → every positional is a change; `cp` → all but the last are reads, the last is a change
     (no positional → nothing, not even `unresolved`);
   - `echo printf true false sleep break continue exit set test seq read return shift wait :` →
     nothing. (`export`, `local`, `declare`, `readonly`, `typeset` are `declaration_command`
     nodes and `[ … ]` / `[[ … ]]` are `test_command` nodes in the grammar, never a command
     name, so they are no runs without being listed; a declaration's assignments are rule 5.4);
   - any other command → a **run** label: `npm|pnpm|yarn|bun` with a first argument exactly `run`
     → `<tool> run <second argument>` (`?` when it is missing or not literal); else
     `npm npx pnpm yarn git docker bunx gh dotnet mvn gradle cargo go` with a literal first
     argument that does not start with `-` → `<tool> <arg>`; otherwise the bare base name — also
     when the first argument is the literal empty string (`git ''` → `git`). Labels are
     deduplicated.
3. **Inline scripts:** for `python python3 node bun deno bash sh zsh pwsh powershell ruby perl psql
   sqlite3 tsx ts-node` (also labelled as runs by 5.2), each heredoc of the statement the command
   reads it from adds
   `inline <cmd> script, N lines — not analysed` with N = the number of newlines in the body
   (it ends in one, so: split on newlines minus 1); the first `-e` / `-c` / `--eval` argument adds
   the same note with N = the line count of the argument right after it (split on newlines), or
   1 when that argument is missing or not literal. Nothing inside a script is analysed.
   A command reads the heredocs of a `redirected_statement` only when it is a simple command
   that is the statement's last command (rule 5.1: the one the redirects belong to), or a simple
   command that is a pipeline element after a `|` / `|&` that follows the heredoc start (it reads
   the heredoc command's output — `cat <<'EOF' | python3 -` notes an inline python3 script). The
   operands before the last one of a body list or pipeline, and the commands after a `&&` / `||`
   that follows the heredoc start, do not (`cat <<EOF > s.sh && bash s.sh` gives no inline note).
   When that last command or pipeline element is a compound statement — `{ … }`, `( … )`, a
   `for` / `select` / `while` / `until` loop, `if` or `case` (`{ node; } <<EOF`, `while read l;
   do …; done <<EOF`) — the heredoc is the stdin of the whole compound, consumed by whichever
   inner command reads stdin first (typically `read`, as data), so it is no command's script: no
   command inside gets an inline note from it. The commands inside are still walked for files and
   runs, and a heredoc of their own (`for …; do node <<EOF …`) is noted as usual.
   A note belongs to a script as written in the source: each script command adds its notes once,
   even when a loop body is walked once per `for` value (`for f in a b; do node -e 'x'; done` →
   one note). Notes are not deduplicated by text: two scripts with the same command and line
   count give two identical notes.
4. **Variables:** a statement `VAR=value` with a literal value stores it; `VAR=` stores `''`; a
   non-literal value forgets `VAR`. The assignments of a declaration command (`export X=…`,
   `local`, `declare -r`, …) are stored the same way, globally (`local` is not scoped to a
   function). (A prefix assignment `VAR=x cmd` is not stored.)
   `for v in <words>`: when there is at least one word and every word is literal and has no
   whitespace, the body is walked once per word (only the first `FOR_VALUES_MAX` = 30) with `v`
   set; otherwise (including `for v; do` with no words) once with `v` unknown. Nothing is
   expanded: a glob word such as `*.ts` is literal, so the body is walked with `v` = `*.ts`.
   `select v in <words>` is a `for_statement` in the grammar and is walked the same way.
   After the loop `v` is unknown, whatever it was before.
5. **Scope and `cd`.** Each element of a pipeline works on a copy of the variables and ignores
   `cd`; a subshell `( … )` and a statement followed by `&` (bash runs it in the background, in
   a subshell) work on a copy of the variables and the directory, so neither leaks to later
   statements. `cd` uses only its first positional (`cd src lib` goes to `src`; later positionals
   are ignored): a literal target other than `''` sets the
   current directory (joined as a path); a missing, empty or non-literal target resets it to
   none, so later relative paths stay as written (`cd -` has no positional: `-` starts with
   `-`). Any other target is taken as is, without the ignored-path rule (`cd /dev/x` sets
   `/dev/x`). `$(…)` and `<(…)` are not entered. Every other node (`if`, `while` / `until`,
   `case`, C-style `for`, `[ … ]` tests, `{ … }`, function definitions) is walked once, its
   children in source order with the same state; a function body is analysed where it is
   defined, never where it is called.
   **Commands chained after a heredoc start** (rule 2.6: the grammar puts them inside the heredoc
   redirect) are walked as bash runs them, after the statement's own command: after `&&` / `||`
   the rest of the line runs in the same state, as a list operand would (`cat <<EOF > a.txt && cd
   sub && rm b.txt` removes `sub/b.txt`). After `|` / `|&` the grammar gives the rest of the line
   as one statement, but `|` binds tighter than `&&` / `||`: when that statement is a `&&` / `||`
   list, its leftmost operand continues the pipeline and the other operands run after the whole
   pipeline, in the same state — `cat <<EOF | grep x > out.txt && rm y.txt` is `(cat | grep x >
   out.txt) && rm y.txt`. The heredoc command and every element of the continued pipeline are
   pipeline elements (copies, `cd` ignored). A rest that is a `redirected_statement` with a list
   body (`cat <<EOF | grep x && rm y > out.txt`) is taken as one pipeline element (rule 5.1 splits
   it inside that copy): its files are found, but a `cd` in its later operands is not applied to
   later statements — a known limit.
   The **analysis root** R is the first `cd` target applied (also one inside a subshell or a
   background statement — R is a display anchor, the directory the command works in, not shell
   state, so `(cd /w && …)` makes later `/w/…` paths short even though the outer directory is
   unchanged); a `cd` ignored inside a pipeline does not set it, and neither does a reset by
   `cd`, `cd ''` or `cd -`. Every
   listed path p is then shown relative to R: p = R → `.`; p starts with `R/` (with the `/`, so a
   sibling `R2/…` does not) → the rest;
   otherwise let k be the number of leading `/`-separated segments R and p share (the empty
   segment before a leading `/` counts); when k ≥ 2 and R has at most 2 segments after them, p
   becomes `../` repeated (segments of R − k) times plus the rest of p; else p stays as it is.
6. A path is listed once, in first-seen order (compared before relativisation); a read that is
   also a change is listed only under changes.
7. **Grouping** (`displayGroups`, the FILES block's condition): the `changes` and `reads` lists
   with more than `GROUP_BY_DIR_ABOVE` = 3 entries are grouped by the part up to the last `/`
   (`./` for bare names), groups and names in first-seen order (`groupByDir`). Runs and inline
   notes are never grouped; a list of 3 or fewer is flat.
8. `unresolved` is shown under FILES as "+ N not resolved (non-literal paths)".
9. **`readAccess`** (`analyzeBash` only; the Bash view ignores it): one `{path, kind}` per entry
   of `reads`, same order and same relativisation. `kind` comes from the base name of the
   **first** command that read the path (`readKindOf`): `grep rg ag egrep fgrep` → `grep`;
   `ls find tree dir` → `list`; anything else — the other read commands, `sed`, `cp` sources, a
   `<` redirect — → `read`. Only commands that produce reads under rule 5.2 reach it, so of those
   names only `grep`, `rg`, `git grep` (`grep`) and `ls` (`list`) occur today; `find`, `tree`,
   `egrep`, … are runs, not reads. The server's OKF extraction maps the kinds to its ops
   ([okf-access-extraction](okf-access-extraction.md)).

   Two optional fields, taken from the same first command, are set only when known:
   - **`range`** `{from, to}` (1-based, `to` inclusive, `to: null` = to the end, a negative
     `from` counts from the end) on a `read`:
     - `sed -n 'a,bp' f` (or `Np`, `a` = `b` = N; quiet via `-n` / `--quiet` / `--silent`, not
       with `-i`; the script is the first positional or the first `-e` / `--expression` value)
       → `{from: a, to: b}`;
     - `head -n N` / `-nN` / `--lines=N` / `--lines N` / `-N` → `{from: 1, to: N}`;
     - `tail -n N` (same spellings) → `{from: -N, to: null}`; `tail -n +N` → `{from: max(N, 1),
       to: null}`, and the `+N` is not a path;
     - a count that is not a plain number (`-n -5`, `-c 10`) or a sed script of any other shape
       gives no range.
   - **`pattern`** on a `grep`: the first `-e` / `--regexp` / `--regexp=` value, else the first
     positional; `-f` / `--file` (patterns from a file) leaves it unknown. The value flags `-A -B
     -C -m --max-count -g --glob -t --type -T --type-not --include --exclude` skip their value.
     The paths are the positionals after the pattern (all positionals when a flag gave it) and
     everything after `--`.
   - **`git grep <pattern> <paths…>`** reads its paths like `grep`, with the same pattern rule
     applied after the `grep` sub-command. Without paths it searches the whole tree and stays a
     `git grep` run, not a read.

### 6. Repo-relative display (`toRepoRelative`)

1. The root is matched in its forward-slash form, its backslash form and, for a drive root
   `X:/…`, the msys form `/x/…`, case-insensitively; a trailing slash on the root is ignored.
2. A match must not follow a word character, `.`, `~` or `-`.
3. `root/` or `root\` loses the prefix (`/work/acme-app/src` → `src`); a bare `root` followed by
   the end, whitespace, a quote, `;`, `)` or `&` becomes `.`; a root followed by anything else
   (`/work/acme-app2`) is left alone.
4. An empty root, or a root made only of slashes (nothing is left once trailing slashes are
   removed, e.g. `/`), returns the text unchanged.
5. `buildBashView` applies it to `script`, `rawDisplay`, `workDir`, the folded `head` / `body`,
   `changes`, `reads` and `firstStatement` — never to `runs` or `inline`. Copy actions always use
   the original command.
6. `firstStatement` is the first non-empty line of the script after the `cd` lift (before
   folding), trimmed: the Bash tab's list preview.

### 7. Highlighting (`highlightBash`)

1. The query is `bashHighlightQuery(scm)`: the grammar's own
   `tree-sitter-bash/queries/highlights.scm` plus `(file_redirect) @redirect`.
2. The grammar's captures: `@string` — `string`, `raw_string`, `heredoc_body`, `heredoc_start`;
   `@function` — `command_name` (and a function definition's name); `@property` —
   `variable_name`; `@keyword` — `case do done elif else esac export fi for function if in select
   then unset until while`; `@comment`; `@number` — `file_descriptor`, wherever it is (also the
   `3` of a heredoc redirect `3<<EOF`, which is not a `file_redirect`); `@embedded` —
   `command_substitution` `$(…)`, `process_substitution`, `expansion` `${…}` (not the
   `simple_expansion` `$x`); `@operator` — only the tokens `$`, `&&`, `>`, `>>`, `<`, `|` (so
   `||`, `;`, `&`, `>&`, `&>`, `|&`, `${` and `$(` are not captured); `@constant` — a named child
   of a command whose text starts with `-`. Capture → kind: `@keyword`, `@operator` → `keyword`;
   `@redirect`, `@number` → `redirect`; `@string` → `string`; `@property`, `@embedded` →
   `variable`; `@function` → `command`; `@constant` → `flag`; `@comment` → `comment`. Other
   captures stay plain. So `$x` is `$` (keyword) + `x` (variable), while `${x}` is all variable.
3. Overlapping captures are painted from the largest node to the smallest, so inner captures
   win. Captures of equal size keep the order the query returns them in (the sort is stable):
   tree-sitter lists a parent node before a child with the same range, so the child is painted
   last and wins — a quoted command name `"cat"` is a `command_name` holding a `string` of the
   same range, and it is all string. The result is sorted, non-overlapping segments with plain text left out; neighbouring
   characters of the same kind form one segment. A zero-length capture is dropped and a capture
   end past the text is clamped to the text length (defensive; not pinned by the rows).
4. The UI highlights the displayed (formatted) text, which is valid by the token invariant
   (rule 2.7). Fold markers are painted as comments and an expanded folded body as one string
   segment (presentation, not pinned by the rows).

## Edge cases

- Chain width: exactly 80 columns stays on one line BV-16; 81 breaks BV-01. Broken on `||`
  BV-32, on `|` BV-33. A chain with a comment is verbatim: BV-34. A trailing `&`: BV-31.
- `for` with literal words, a body read through `"$f"`: BV-02. `for` header at exactly 80
  columns stays BV-19; 81 breaks BV-20; over 80 with 4 words BV-14 (also more than 3 changes →
  one `./` group); over 80 with 2 words stays BV-21. C-style `for ((…))` verbatim: BV-30.
- `while` BV-28, `until` BV-29, `if`/`elif`/`else` BV-27.
- `{…}` over 80 BV-22, `(…)` over 80 BV-23 (a subshell that fits: BV-05).
- Redirected statement: fits → one line even with a loop BV-24; over 80 → loop opened, redirect
  on `done` BV-25; newline in the redirect text → verbatim BV-26.
- Plain `cd` lifted (root shown as `.`): BV-03. `cd … &&` not lifted: BV-11.
- `VAR=` substitution, a read that is also a change: BV-04. `VAR=` storing `''`, loop variable
  removed after the loop, pipeline variable copy: BV-38.
- `FOR_VALUES_MAX`: 30 values all walked BV-35, the 31st not BV-36 (number words are literal).
  Non-literal `for` words → one walk with the variable unknown: BV-37.
- `cd` inside a subshell does not leak: BV-05. Inside a pipeline it is ignored: BV-41. A missing
  or non-literal target resets the directory: BV-42.
- Analysis-root relativisation: 1 and 2 levels up, 3 levels up stays absolute, `~` and `X:`
  absolute, reads grouped BV-39; k = 2 common segments relativised vs k = 1 not BV-40.
- Redirects: `<`, `>>`, `&>`, `/dev/null`, `-`, `>&2` BV-43. A number option value ignored:
  BV-33.
- Heredoc into `node`: 9 lines folded BV-06; 8 lines stay BV-12. Repo-relative fold head and
  body: BV-53.
- `sed -i`, `cp`, `rm` flags, `tee` in a pipeline, grouping by directory: BV-07. Exactly 3 changes
  are not grouped: BV-15. `sed` without `-i` reads BV-44; `-e`, `-f`, `--expression=` BV-45.
- `grep` pattern skipped, `wc` without paths: BV-08. `mv`, `rg`, a command given by path, `cp`
  with two sources: BV-46. Run labels `npm run ?`, `git -C`, `bun run`, `npx`: BV-47.
- `node -e` noted, not analysed: BV-13. `-c`, `--eval`, a multi-line `-e` script: BV-48.
- Windows root with forward-slash and msys spellings: BV-09. Root differing only in case BV-49;
  backslash spelling in the command, backslashes in a path become `/` BV-50; root after a word
  character, `.`, `~`, `-` left alone BV-51; terminators `;` `)` `&` `'` BV-52.
- Root boundaries: a longer name, a quoted bare root, a trailing slash on the root: BV-18.
- Unparseable command: BV-10; with a root (made repo-relative) and line counts BV-67. Empty
  command: BV-54, BH-06. `lineCount` / `rawLineCount`: BV-55, BV-56, BV-66, BV-67.
- Nested chains (a pipeline broken inside a broken `&&` list): BV-63. Verbatim fallbacks for a
  newline in a `for` word, a `while` header, an `if` and an `elif` condition: BV-64. `for v; do`
  header: BV-59.
- `cd` not lifted: non-literal target BV-61, two arguments BV-62.
- p = R shown as `.`, trailing slash kept in the directory, absolute paths not normalised, `cp`
  with no positional: BV-55.
- Redirect before the command name, `&>>`, `>|`, a redirect inside a heredoc redirect: BV-56.
- `sed` long forms `--in-place[=…]`, `--expression`, `--file`, `--file=`: BV-57.
- Non-literal command name, a non-literal assignment forgets, a prefix assignment is not stored,
  `${VAR:-x}` not literal: BV-58. A `for` word with whitespace and `for v; do` with no words:
  BV-59. Backslash escape in a word, `-c` / `-e` with a missing or non-literal argument: BV-60.
- Run labels never made repo-relative: BV-65. Two identical folded heredocs: BV-66.
- One representative per command table (change, read, nothing, subcommand, `yarn run`): BV-68;
  script commands other than node/python3/bun (`bash`, `ruby`): BV-60.
- Highlighting: keywords, variable inside a string BH-01; redirect target and fd duplication
  BH-02; assignment, flag, raw string, comment BH-03; `$f` vs `${f}`, `||` not captured BH-04;
  `${…}` and `$(…)` BH-05; a file descriptor outside a `file_redirect` (`3<<EOF`) BH-07; equal-size
  captures, the inner one wins (`"cat"`) BH-08.
- Width at exactly 80 / 81 for a redirected statement, `{…}` and `(…)`: BV-69 / BV-70. The current
  indent counts toward `WIDTH` for a nested chain, redirected statement, subshell and `for`
  header: BV-71.
- Paths: `~` and `X:/` absolute while the directory is not R, `.` and empty segments skipped in
  a join, a sibling directory `R2/…` (the `/` boundary), `/dev/` tested after the join: BV-72.
- Redirect `>& file` is a change, `>&-` and `>&N` add nothing, `\&1` ignored, a quoted name with
  backslashes (`'C:\bin\rm'`), redirects of a command with a non-literal name: BV-73.
- `cd … &` not lifted and not applied (background copy), subshell and background variable copies,
  `export X=…` stored: BV-74. `cd -` / `cd ''` neither lifted nor setting R: BV-75.
- Leading comment blocks the lift; function body, `case`, `while`, `select`, a glob `for` word:
  BV-76. A root of only slashes: BV-77. Runs and inline notes never grouped: BV-01, BV-48.
  `firstStatement` repo-relative: BV-65.
- `cd ''` as the first statement not lifted, `sed -i.bak`, a concatenation with an unknown part,
  `git ''`, `sed -f` with no file: BV-78.
- Redirects resolved before the body (`done > "$f"`, `cd sub > out.txt`), double-quoted escapes:
  BV-79.
- A statement after a heredoc start on its line is a syntax error: BV-80. Statements of only
  redirects, fitting and over `WIDTH`: BV-81.
- Commands chained after a heredoc start: `&&` with a folded body (head keeps the chained part)
  BV-82; `| python3 -` gets the heredoc, `| … && …` split at the pipeline, `&&` operand gets no
  heredoc BV-83; `||` / `&&` in the same state, `|&` pipeline continued by a list, `cd` in it
  ignored, the redirects of a list body bound to its last command BV-84.
- Redirects of a list / pipeline body bound to the last command (no heredoc): BV-85.
- A heredoc nested in a `for` body, a `{ … }` group, or a `$(…)` inside a `&&` list makes the
  whole statement verbatim: BV-86.
- Heredocs on compound statements (group, `while`, `for`, subshell, `if`) give no inline note to
  inner commands; one note per script although its loop body is walked twice: BV-87. Two
  identical notes are both kept: BV-48.
- A `|&` chain broken over `WIDTH`; a `for` header with extra spaces and a `\`-newline rebuilt
  with single spaces: BV-88.
- Every entry of every command table: change and read tables BV-89, nothing and subcommand tables
  BV-90, script table BV-91; run-script tools `npm` BV-01, `pnpm` (with a non-literal script →
  `?`) BV-47, `yarn` BV-68, `bun` BV-47.
- R from a `cd` inside a subshell BV-05 and a background statement BV-74; `cd` with two
  positionals uses the first BV-62; a backslash-newline inside `"…"` disappears BV-60.
- `readAccess` (rule 5.9): one kind each (`sed -n` read, `grep -n` grep, `ls` list) BV-92;
  folders searched by `grep -rn` BV-93; a `<` redirect is `read`, the first command decides the
  kind BV-94; paths relative to the analysis root, `ls .`, a read that is also a change left out
  BV-95; `find` / `tree` / `egrep` are runs, no reads BV-96. `range`: `sed -n Np` / `head -n` / `tail -n` BV-97, `head -N` / `tail -n +N` / `--lines=` BV-98, no range for other sed scripts and non-numeric counts BV-99. `pattern`: `-e` and `rg` BV-100, value flags skipped BV-101, `git grep … -- paths` BV-102, `git grep` without paths and `grep -f` BV-103.

## Examples

Two kinds of rows.

- **View rows** have `input.command` and optional `input.root` (default `''`). The test runs
  `buildBashView(parser, command, root)` and compares the listed keys of `expected`:
  `ok`, `workDir`, `script`, `rawDisplay`, `folded`, `lineCount`, `rawLineCount` and
  `firstStatement` from the view;
  `changes`, `reads`, `runs`, `inline` and `unresolved` from `view.files`; `changeGroups` /
  `readGroups` / `runGroups` / `inlineGroups` are `displayGroups('changes' | 'reads' | 'runs' |
  'inline', list)` (rule 5.7: the groups, or `null` when flat); `readAccess` is
  `analyzeBash(parser, command).readAccess` (rule 5.9). Keys that are not listed are not checked. On every row with `ok: true` the test also
  checks the token invariant (rule 2.7) on `formatBash(parser, command).script`.
- **Highlight rows** have `input.highlight: true`. The test runs `highlightBash(parser, command,
  bashHighlightQuery(<grammar highlights.scm>))` (rule 7.1) and maps each segment to
  `[kind, text]`; `expected.highlights` is that list in order.

Commands are anonymised (`/work/acme-app`, `C:\work\acme-app`).

Rows (110): [`docs/algorithm-examples/bash-command-view.json`](../../algorithm-examples/bash-command-view.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Chains broken at `>= WIDTH` instead of `> WIDTH` -> BV-16; never broken -> BV-01, BV-32, BV-33.
- `for` header broken at `>= WIDTH` -> BV-19; never broken -> BV-20; broken with 2 words -> BV-21.
- A redirected statement always laid out (loop opened) -> BV-24; never -> BV-25.
- A `cd … &&` chain treated as a liftable `cd` -> BV-11 (workDir set).
- `cd` inside a subshell leaks to later statements -> BV-05 (`packages/build`); `cd` applied in a
  pipeline -> BV-41 (`README.md`); a non-literal `cd` ignored instead of resetting -> BV-42
  (`/tmp/a.txt`).
- `../` relativisation without the `k >= 2` check -> BV-40 (`../../etc/hosts`); without the
  2-levels limit -> BV-39 (`../../../other/y.txt`).
- Heredocs folded at `>= 8` lines -> BV-12; never folded -> BV-06.
- The `grep` pattern taken as a path -> BV-08 (`TODO` read).
- `sed`'s script argument taken as a path -> BV-07 (`s/a/b/` change); `-e` scripts taken as paths
  -> BV-45.
- Numbers not ignored as paths -> BV-33 (`20` read).
- `tail -n +N` count taken as a path -> BV-98 (`+40` read); `head -n` value taken as a path -> BV-97.
- The last `-e` taken as the pattern, or `-e` not making every positional a path -> BV-100 (`bar`, `docs/kb` dropped).
- Grep value flags not skipping their value -> BV-101 (`3` as the pattern).
- `FOR_VALUES_MAX` off by one or missing -> BV-36 (`f31.txt`).
- The loop variable kept after the loop -> BV-38; a pipeline element sharing the variables ->
  BV-38 (`out.txt` change).
- Reads not filtered by changes -> BV-04 and BV-07.
- Grouping at `>= 3` entries -> BV-15; reads never grouped -> BV-39, BV-46.
- Inline JS analysed for paths -> BV-13 (`x.txt` change).
- Only the forward-slash root matched -> BV-09 (msys `/c/…` kept); case-sensitive match -> BV-49.
- A root prefix replaced without a boundary -> BV-18 (`2` left from `/work/acme-app2`), BV-51.
- Highlight painted smallest-first (outer captures win) -> BH-01 (`"$f"` one string) and BH-02
  (`> out.log` one redirect).
- `@constant` not mapped to flag -> BH-02, BH-03; `@embedded` not mapped -> BH-04, BH-05.
- No `p = R -> .` case -> BV-55 (`''`); `cp` with no positional counted as unresolved -> BV-55.
- Redirects inside a heredoc redirect not looked at, or `&>>` / `>|` not change operators -> BV-56.
- `--expression` not consuming its argument -> BV-57 (`s/c/d/` change); `--in-place` only with or
  only without `=`, or `--file=` ignored -> BV-57.
- A non-literal command name not counted, a non-literal assignment not forgetting, any `${…}`
  with a variable treated as literal -> BV-58.
- Whitespace words walked, or a loop with no words skipped -> BV-59.
- Backslash escapes kept -> BV-60 (`my\ file.txt`); a missing `-c` argument counted as 0 lines ->
  BV-60.
- A nested chain operand indented by `IND` instead of `ind + IND` -> BV-63; the newline guards of
  `for` words, `while` headers or `if` / `elif` conditions removed -> BV-64.
- `cd` lifted with a non-literal target or with 2 arguments -> BV-61, BV-62.
- Runs made repo-relative -> BV-65; the raw command instead of `rawDisplay` when `ok = false` ->
  BV-67; `lineCount` taken from the raw command -> BV-55, BV-56, BV-63, BV-66.
- A folded body replaced at its last occurrence -> BV-66.
- Any single entry missing from `W_CMDS`, `R_CMDS` -> BV-89; from `NOT_RUNS`, `SUBCOMMAND_TOOLS`
  -> BV-90; from `SCRIPT_CMDS` (`python` and `python3` separately) -> BV-91; from
  `RUN_SCRIPT_TOOLS` -> BV-01 (`npm`), BV-47 (`pnpm`, `bun`), BV-68 (`yarn`). Checked for every
  entry of every table.
- Redirected statement or `{…}` / `(…)` fitting at `< WIDTH` -> BV-69; at `<= WIDTH + 1` -> BV-70;
  the current indent left out of "fits" (chain, redirected statement, group, `for` header) ->
  BV-71.
- `~` or `X:/` not absolute, `.` or empty segments kept in a join, `R/` matched without the `/`,
  `/dev/` tested before the join -> BV-72.
- `>&` not a change operator, `&N` not ignored, the base name split only on `/`, the redirects of
  a non-literal-named command dropped -> BV-73.
- A background statement or a subshell sharing the variables / directory, the lift without the
  first-line check -> BV-74; `cd ''` taken as a target or `cd -` lifted -> BV-75.
- `runs` or `inline` grouped -> BV-01, BV-48; `firstStatement` not made repo-relative -> BV-65;
  a root of only slashes matched as an empty root -> BV-77.
- `@number` not mapped to redirect -> BH-07; equal-size captures painted in reverse -> BH-08.
- `cd ''` lifted, `-i` matched only exactly, an unknown part of a concatenation skipped, `''` taken
  as a subcommand, a missing `sed -f` file counted as unresolved -> BV-78.
- A redirected statement's body walked before its redirects, or double-quoted text taken raw ->
  BV-79.
- A body-less redirected statement over `WIDTH` laid out through its (missing) body -> BV-81.
- Commands chained after a heredoc start not walked -> BV-82, BV-83, BV-84; the heredoc given to
  a `&&` operand -> BV-83 (`inline bash script`); the pipe tail's list walked as one pipeline
  element, or its `cd` applied -> BV-84 (`sub/x/c.txt`).
- A list / pipeline body's redirects resolved before its leading operands, or a leading pipeline
  element walked outside a pipeline copy -> BV-85.
- R not set by a `cd` inside a subshell -> BV-05 (`packages/api/README.md`); inside a background
  statement -> BV-74 (`/x/e.txt`); `cd` using its last positional -> BV-62 (`b.txt`).
- A heredoc looked for only among a statement's direct children -> BV-86 (loop and group opened,
  list broken).
- `|&` missing from the chain operators -> BV-88 (pipeline verbatim); the `for` header copied
  from the source -> BV-88.
- A non-literal `run` argument printed instead of `?` -> BV-47 (`pnpm run null`); a
  backslash-newline in `"…"` kept -> BV-60.
- `readAccess` kind taken from the last reader instead of the first -> BV-94 (`a.md` grep); a `<`
  redirect given the command's kind -> BV-94 (`list.txt` grep); `readAccess` not filtered by
  changes -> BV-95; not relativised like `reads` -> BV-95; `grep` / `ls` not mapped -> BV-92,
  BV-93.
- Inline notes deduplicated by text -> BV-48; a note per loop walk -> BV-87; the heredoc passed
  into a compound statement's commands (`{ … }`, `while`, `if`, or a `for` body, or a subshell)
  -> BV-87.

## Where the result is visible

Session pane → Logs tab → a Bash call's details (tool-call modal), the Context Growth step modal
and the Bash tab's details pane: WORKING DIR, FILES (Changes / Reads / Runs / Inline, "+ N not
resolved"), the formatted COMMAND with line numbers, fold toggles and colours, and the Bash tab
list's "changes N" chip and preview line (`firstStatement`).
