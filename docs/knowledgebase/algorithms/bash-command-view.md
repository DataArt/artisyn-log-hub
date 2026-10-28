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
   names only `grep`, `rg` (`grep`) and `ls` (`list`) occur today; `find`, `tree`, `egrep`, … are
   runs, not reads. The server's OKF extraction maps the kinds to its ops
   ([okf-access-extraction](okf-access-extraction.md)).

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
  BV-95; `find` / `tree` / `egrep` are runs, no reads BV-96.

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

```examples
[
  {
    "id": "BV-01",
    "input": {"command": "npm run lint && npm run build && npm run test:unit && npm run e2e -- --ci --xyzwv"},
    "expected": {
      "ok": true, "workDir": null,
      "script": "npm run lint &&\n  npm run build &&\n  npm run test:unit &&\n  npm run e2e -- --ci --xyzwv",
      "changes": [], "reads": [], "runs": ["npm run lint", "npm run build", "npm run test:unit", "npm run e2e"],
      "runGroups": null,
      "firstStatement": "npm run lint &&"
    },
    "note": "Rule 2.2: the chain is 81 characters > WIDTH 80, so it breaks after each &&, the operator ends the line and operands 2-4 get IND (2 spaces). Rule 5.2: npm with 'run x' -> 'npm run x' four times. Rule 5.7: 4 runs > 3, but runs are never grouped -> null (grouping them would give one './' group). Rule 6.6: first line of the script."
  },
  {
    "id": "BV-16",
    "input": {"command": "npm run lint && npm run build && npm run test:unit && npm run e2e -- --ci --xyzw"},
    "expected": {"ok": true, "script": "npm run lint && npm run build && npm run test:unit && npm run e2e -- --ci --xyzw"},
    "note": "Rule 2.2: the same chain one character shorter is exactly 80 characters <= WIDTH, so it stays on one line. Breaking at >= 80 would split it."
  },
  {
    "id": "BV-02",
    "input": {"command": "for f in src/a.ts src/b.ts; do wc -l \"$f\"; done"},
    "expected": {
      "ok": true, "workDir": null,
      "script": "for f in src/a.ts src/b.ts; do\n  wc -l \"$f\"\ndone",
      "changes": [], "reads": ["src/a.ts", "src/b.ts"], "runs": [], "changeGroups": null
    },
    "note": "Rule 2.3: loops are always opened: header '; do', body indented by IND, 'done' alone. Rule 5.4: both words literal, the body is walked with f = src/a.ts then src/b.ts; '\"$f\"' is a string whose only part is a known $f. Rule 5.2: wc reads its positionals (-l is a flag). No runs (wc is a read command). 0 changes -> flat (rule 5.7)."
  },
  {
    "id": "BV-03",
    "input": {"command": "cd /work/acme-app; git status --short; cat package.json", "root": "/work/acme-app"},
    "expected": {
      "ok": true, "workDir": ".",
      "script": "git status --short\ncat package.json",
      "changes": [], "reads": ["package.json"], "runs": ["git status"],
      "firstStatement": "git status --short"
    },
    "note": "Rule 2.1: three statements, three lines. Rule 3.1: the first statement is the plain command 'cd /work/acme-app' and the first line, so it is lifted; workDir = the root, which rule 6.3 shows as '.' (bare root at the end). Rule 5.5: cat package.json -> /work/acme-app/package.json, shown relative to the analysis root -> 'package.json'. Rule 5.2: git + 'status' -> 'git status'. Rule 6.6: first line after the lift."
  },
  {
    "id": "BV-04",
    "input": {"command": "OUT=dist/report.txt; npm run report > \"$OUT\"; cat \"$OUT\""},
    "expected": {
      "ok": true,
      "script": "OUT=dist/report.txt\nnpm run report > \"$OUT\"\ncat \"$OUT\"",
      "changes": ["dist/report.txt"], "reads": [], "runs": ["npm run report"]
    },
    "note": "Rule 5.4: OUT = dist/report.txt (literal). Rule 5.1: '> \"$OUT\"' -> change dist/report.txt. Rule 5.2: cat \"$OUT\" reads dist/report.txt, but rule 5.6 lists a read that is also a change only under changes -> reads empty. npm run report -> 'npm run report'."
  },
  {
    "id": "BV-05",
    "input": {"command": "(cd packages/api && npm test); rm -rf ../build; cat packages/api/README.md"},
    "expected": {
      "ok": true, "workDir": null,
      "script": "(cd packages/api && npm test)\nrm -rf ../build\ncat packages/api/README.md",
      "changes": ["../build"], "reads": ["README.md"], "runs": ["npm test"]
    },
    "note": "Rule 2.5: the subshell fits in 80 columns, one line. Rule 3.1: the first statement is a subshell, not a plain cd -> no lift. Rule 5.5: the cd inside ( ) sets the analysis root R = packages/api but changes only the copy's directory, so 'rm -rf ../build' runs with no current directory -> '../build' as written. Relative to R: segments R = [packages, api], p = [.., build], k = 0 < 2 -> unchanged '../build'. 'cat packages/api/README.md' also runs with no directory -> p = packages/api/README.md, which starts with 'R/' -> 'README.md'. A leaking cd would give packages/api + ../build = packages/build (k = 1 -> 'packages/build'); R not taken from a subshell cd would leave 'packages/api/README.md'. npm test -> 'npm test'."
  },
  {
    "id": "BV-06",
    "input": {"command": "node <<'EOF'\nconst a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\nconst f = 6;\nconst g = 7;\nconst h = 8;\nconsole.log(a + h);\nEOF"},
    "expected": {
      "ok": true,
      "script": "node <<'EOF'\n# ▼ block 1: 9 lines, shown below\nEOF",
      "folded": [{"n": 1, "head": "node <<'EOF'", "body": "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\nconst f = 6;\nconst g = 7;\nconst h = 8;\nconsole.log(a + h);", "lines": 9}],
      "changes": [], "reads": [], "runs": ["node"], "inline": ["inline node script, 9 lines — not analysed"],
      "firstStatement": "node <<'EOF'"
    },
    "note": "Rule 2.6: a statement with a heredoc is copied verbatim. Rule 4.1: the body has 9 lines > 8 -> replaced by the marker of block 1; rule 4.2: head = first line of the statement. Rule 5.2: node is not in any table -> run 'node'. Rule 5.3: node is a script command fed a heredoc with 9 newlines -> one inline note, 9 lines; the JS is not analysed, so no files."
  },
  {
    "id": "BV-12",
    "input": {"command": "cat > notes.txt <<'EOF'\n1\n2\n3\n4\n5\n6\n7\n8\nEOF"},
    "expected": {
      "ok": true,
      "script": "cat > notes.txt <<'EOF'\n1\n2\n3\n4\n5\n6\n7\n8\nEOF",
      "folded": [], "changes": ["notes.txt"], "reads": [], "runs": [], "inline": []
    },
    "note": "Rule 4.3: the body has exactly 8 lines, not more than 8 -> stays inline, script verbatim. Rule 5.1: '> notes.txt' -> change. cat has no positional -> no read; cat is not a script command -> no inline note. Folding at >= 8 would fold it."
  },
  {
    "id": "BV-07",
    "input": {"command": "sed -i 's/a/b/' src/x.ts; cp src/x.ts dist/x.ts; rm -f tmp/x.log; echo done | tee build.log"},
    "expected": {
      "ok": true,
      "script": "sed -i 's/a/b/' src/x.ts\ncp src/x.ts dist/x.ts\nrm -f tmp/x.log\necho done | tee build.log",
      "changes": ["src/x.ts", "dist/x.ts", "tmp/x.log", "build.log"], "reads": [], "runs": [],
      "changeGroups": [
        {"dir": "src/", "names": ["x.ts"]},
        {"dir": "dist/", "names": ["x.ts"]},
        {"dir": "tmp/", "names": ["x.log"]},
        {"dir": "./", "names": ["build.log"]}
      ]
    },
    "note": "Rule 5.2: sed -i with no -e/-f -> the first positional 's/a/b/' is the script -> change src/x.ts; cp reads src/x.ts and changes dist/x.ts; rm -f -> change tmp/x.log (-f is a flag); echo is ignored; tee in the pipeline -> change build.log. Rule 5.6: the read src/x.ts is also a change -> reads empty. Rule 5.7: 4 changes > 3 -> groups by directory in first-seen order, bare build.log under './'."
  },
  {
    "id": "BV-15",
    "input": {"command": "mkdir -p out; touch out/a.txt out/b.txt"},
    "expected": {"ok": true, "changes": ["out", "out/a.txt", "out/b.txt"], "changeGroups": null},
    "note": "Rule 5.2: mkdir -p out -> change out; touch -> two changes. Rule 5.7: exactly 3 entries, not more than GROUP_BY_DIR_ABOVE 3 -> flat (null). Grouping at >= 3 would group them."
  },
  {
    "id": "BV-08",
    "input": {"command": "grep -rn \"TODO\" src lib | wc -l"},
    "expected": {"ok": true, "script": "grep -rn \"TODO\" src lib | wc -l", "changes": [], "reads": ["src", "lib"], "runs": []},
    "note": "Rule 2.2: a 31-character pipeline stays on one line. Rule 5.2: grep's positionals are TODO, src, lib; the first is the pattern -> reads src, lib. wc -l has no positional. Neither is a run. Treating the pattern as a path would add a read 'TODO'."
  },
  {
    "id": "BV-09",
    "input": {"command": "cat C:/work/acme-app/package.json && ls /c/work/acme-app/src", "root": "C:\\work\\acme-app"},
    "expected": {"ok": true, "workDir": null, "script": "cat package.json && ls src", "reads": ["package.json", "src"], "runs": []},
    "note": "Rule 6.1: root C:\\work\\acme-app matches as C:/work/acme-app, C:\\work\\acme-app and msys /c/work/acme-app. Rule 6.3: 'root/' loses the prefix in both spellings -> 'cat package.json && ls src'. Rule 5.2: cat and ls read their (absolute) arguments, which rule 6.5 relativises the same way."
  },
  {
    "id": "BV-10",
    "input": {"command": "for x in; do"},
    "expected": {"ok": false, "workDir": null, "script": "for x in; do", "folded": [], "changes": [], "reads": [], "runs": [], "inline": [], "unresolved": 0, "firstStatement": null},
    "note": "Rule 1.1: a for loop with no body and no 'done' is a syntax error -> ok false, script = the raw command (no root, so unchanged), no files, unresolved 0, no first statement."
  },
  {
    "id": "BV-11",
    "input": {"command": "cd /work/acme-app && npm test", "root": "/work/acme-app"},
    "expected": {"ok": true, "workDir": null, "script": "cd . && npm test", "runs": ["npm test"]},
    "note": "Rule 3.2: the first statement is the chain 'cd … && npm test', not a plain cd -> nothing lifted, workDir null. Rule 6.3: the bare root followed by a space becomes '.'. Rule 5.2: cd is not a run; npm test -> 'npm test'."
  },
  {
    "id": "BV-13",
    "input": {"command": "node -e \"require('fs').writeFileSync('x.txt', '1')\" && git add -A"},
    "expected": {"ok": true, "changes": [], "reads": [], "runs": ["node", "git add"], "inline": ["inline node script, 1 lines — not analysed"]},
    "note": "Rule 5.3: node with -e -> the argument right after it is a 1-line script -> one inline note; x.txt inside the JS is not a change. Rule 5.2: node -> run 'node'; git with first argument 'add' -> 'git add'."
  },
  {
    "id": "BV-14",
    "input": {"command": "for f in alpha-module-one.ts beta-module-two.ts gamma-module-three.ts delta-four.ts; do touch \"$f\"; done"},
    "expected": {
      "ok": true,
      "script": "for f in \\\n    alpha-module-one.ts \\\n    beta-module-two.ts \\\n    gamma-module-three.ts \\\n    delta-four.ts; do\n  touch \"$f\"\ndone",
      "changes": ["alpha-module-one.ts", "beta-module-two.ts", "gamma-module-three.ts", "delta-four.ts"],
      "changeGroups": [{"dir": "./", "names": ["alpha-module-one.ts", "beta-module-two.ts", "gamma-module-three.ts", "delta-four.ts"]}]
    },
    "note": "Rule 2.3: the one-line header 'for f in <4 words>; do' is 87 characters > 80 with 4 > 2 words -> 'for f in \\' then one word per line at 4 spaces, ' \\' after each but the last, '; do' after the last. Rule 5.4: touch \"$f\" walked once per word -> 4 changes. Rule 5.7: 4 > 3, all bare names -> one './' group."
  },
  {
    "id": "BV-18",
    "input": {"command": "ls /work/acme-app2 /work/acme-app/src \"/work/acme-app\"", "root": "/work/acme-app/"},
    "expected": {"ok": true, "script": "ls /work/acme-app2 src \".\"", "reads": ["/work/acme-app2", "src", "."]},
    "note": "Rule 6.1: the trailing slash of the root is ignored. Rule 6.3: '/work/acme-app2' is the root followed by '2' -> left alone; '/work/acme-app/src' -> 'src'; the root before a quote -> '.'. Rule 5.2: ls reads all three, relativised the same way."
  },
  {
    "id": "BV-19",
    "input": {"command": "for f in alpha-module-one.ts beta-module-two.ts gamma-module-three-extra1.ts; do touch \"$f\"; done"},
    "expected": {
      "ok": true,
      "script": "for f in alpha-module-one.ts beta-module-two.ts gamma-module-three-extra1.ts; do\n  touch \"$f\"\ndone",
      "changes": ["alpha-module-one.ts", "beta-module-two.ts", "gamma-module-three-extra1.ts"], "changeGroups": null
    },
    "note": "Rule 2.3: header 'for f in ' (9) + 19 + 1 + 18 + 1 + 28 + '; do' (4) = 80 characters, not > WIDTH -> stays on one line although it has 3 words. Rule 5.4: 3 changes; rule 5.7: 3 -> flat. Breaking at >= 80 would split it."
  },
  {
    "id": "BV-20",
    "input": {"command": "for f in alpha-module-one.ts beta-module-two.ts gamma-module-three-extra12.ts; do touch \"$f\"; done"},
    "expected": {
      "ok": true,
      "script": "for f in \\\n    alpha-module-one.ts \\\n    beta-module-two.ts \\\n    gamma-module-three-extra12.ts; do\n  touch \"$f\"\ndone"
    },
    "note": "Rule 2.3: the third word is one character longer -> header 81 > 80 with 3 > 2 words -> 'for f in \\', each word on its own line at 2 x IND = 4 spaces, ' \\' after the first two, '; do' after the last."
  },
  {
    "id": "BV-21",
    "input": {"command": "for f in alpha-module-one-with-a-long-name.ts beta-module-two-with-a-longer-name.ts; do touch \"$f\"; done"},
    "expected": {
      "ok": true,
      "script": "for f in alpha-module-one-with-a-long-name.ts beta-module-two-with-a-longer-name.ts; do\n  touch \"$f\"\ndone"
    },
    "note": "Rule 2.3: header 9 + 36 + 1 + 37 + 4 = 87 > 80, but only 2 words (not more than 2) -> stays on one line. Breaking with >= 2 words would split it."
  },
  {
    "id": "BV-22",
    "input": {"command": "{ npm run build:all-packages; npm run test:all-packages; npm run lint:all-packages; }"},
    "expected": {
      "ok": true,
      "script": "{\n  npm run build:all-packages\n  npm run test:all-packages\n  npm run lint:all-packages\n}",
      "runs": ["npm run build:all-packages", "npm run test:all-packages", "npm run lint:all-packages"]
    },
    "note": "Rule 2.5: the group is 85 characters > 80 -> '{' alone, the three statements on their own lines (rule 2.1) at IND, '}' alone. Rule 5.2: three 'npm run x' labels."
  },
  {
    "id": "BV-23",
    "input": {"command": "(cd packages/api && npm run build:all-targets; npm run test:all-targets -- --ci --bail)"},
    "expected": {
      "ok": true, "workDir": null,
      "script": "(\n  cd packages/api && npm run build:all-targets\n  npm run test:all-targets -- --ci --bail\n)",
      "runs": ["npm run build:all-targets", "npm run test:all-targets"]
    },
    "note": "Rule 2.5: the subshell is 87 characters > 80 -> '(' alone, body at IND: the list 'cd packages/api && npm run build:all-targets' is 2 + 44 = 46 <= 80 -> one line (rule 2.2); the second statement on its own line; ')' alone. Rule 3.1: first statement is a subshell -> no lift. Rule 5.2: two run labels; cd is not a run."
  },
  {
    "id": "BV-24",
    "input": {"command": "for f in a.txt b.txt; do cat \"$f\"; done > all.txt"},
    "expected": {
      "ok": true,
      "script": "for f in a.txt b.txt; do cat \"$f\"; done > all.txt",
      "changes": ["all.txt"], "reads": ["a.txt", "b.txt"]
    },
    "note": "Rule 2.8: a redirected statement of 49 characters fits -> copied on one line as written, even though it holds a loop (compare BV-02). Rule 5.4: cat walked with a.txt and b.txt -> reads; rule 5.1: '> all.txt' -> change."
  },
  {
    "id": "BV-25",
    "input": {"command": "for f in src/alpha.ts src/beta.ts src/gamma.ts; do cat \"$f\"; done > dist/all-sources-combined.txt"},
    "expected": {
      "ok": true,
      "script": "for f in src/alpha.ts src/beta.ts src/gamma.ts; do\n  cat \"$f\"\ndone > dist/all-sources-combined.txt",
      "changes": ["dist/all-sources-combined.txt"], "reads": ["src/alpha.ts", "src/beta.ts", "src/gamma.ts"], "readGroups": null
    },
    "note": "Rule 2.8: 97 characters > 80 -> the body (the loop) is laid out by rule 2.3 (its header is 46 + '; do' = 50 characters, one line) and the redirect text ' > dist/all-sources-combined.txt' is appended to the last line 'done'. Rule 5.4/5.1: 3 reads, 1 change; rule 5.7: 3 reads -> flat."
  },
  {
    "id": "BV-26",
    "input": {"command": "for f in a.txt b.txt; do cat \"$f\"; done \\\n  > all.txt"},
    "expected": {
      "ok": true,
      "script": "for f in a.txt b.txt; do cat \"$f\"; done \\\n  > all.txt",
      "changes": ["all.txt"]
    },
    "note": "Rule 2.8: the statement has a newline, so it does not fit; the redirect text after the loop (' \\', newline, '  > all.txt') contains a newline -> the whole statement verbatim. Rule 5.1: change all.txt."
  },
  {
    "id": "BV-27",
    "input": {"command": "if [ -f a.txt ]; then cat a.txt; elif [ -f b.txt ]; then cat b.txt; else touch c.txt; fi"},
    "expected": {
      "ok": true,
      "script": "if [ -f a.txt ]; then\n  cat a.txt\nelif [ -f b.txt ]; then\n  cat b.txt\nelse\n  touch c.txt\nfi",
      "changes": ["c.txt"], "reads": ["a.txt", "b.txt"], "runs": []
    },
    "note": "Rule 2.4: 'if <c>; then', body at IND, 'elif <c>; then', body, 'else', body, 'fi' each on their own lines. Rule 5.2: the [ … ] tests are not commands (no reads from them); cat reads a.txt and b.txt, touch changes c.txt."
  },
  {
    "id": "BV-28",
    "input": {"command": "while true; do sleep 1; done"},
    "expected": {"ok": true, "script": "while true; do\n  sleep 1\ndone", "runs": []},
    "note": "Rule 2.3: a while loop is always opened; the header is the source from 'while' to the end of the condition 'true', then '; do'. Rule 5.2: true and sleep are in the nothing list -> no runs."
  },
  {
    "id": "BV-29",
    "input": {"command": "until npm test; do sleep 5; done"},
    "expected": {"ok": true, "script": "until npm test; do\n  sleep 5\ndone", "runs": ["npm test"]},
    "note": "Rule 2.3: until is laid out like while: 'until npm test; do', body at IND, 'done'. Rule 5.2: npm test -> 'npm test'; sleep -> nothing."
  },
  {
    "id": "BV-30",
    "input": {"command": "for ((i=0; i<3; i++)); do echo $i; done"},
    "expected": {"ok": true, "script": "for ((i=0; i<3; i++)); do echo $i; done", "changes": [], "reads": [], "runs": []},
    "note": "Rules 2.3/2.6: a C-style for is not a for … in loop -> copied verbatim on one line. Rule 5.2: echo -> nothing."
  },
  {
    "id": "BV-31",
    "input": {"command": "npm run dev & sleep 5; curl -s localhost:5173"},
    "expected": {
      "ok": true,
      "script": "npm run dev &\nsleep 5\ncurl -s localhost:5173",
      "runs": ["npm run dev", "curl"], "reads": [], "firstStatement": "npm run dev &"
    },
    "note": "Rule 2.1: three statements; the first is followed by '&', which stays on its line as ' &'. Rule 5.2: 'npm run dev'; sleep -> nothing; curl is in no table and not a subcommand tool -> bare 'curl' (its argument is not a path). Rule 6.6: first line."
  },
  {
    "id": "BV-32",
    "input": {"command": "npm run build:all-packages-in-the-monorepo || echo \"build failed, see build.log for details\""},
    "expected": {
      "ok": true,
      "script": "npm run build:all-packages-in-the-monorepo ||\n  echo \"build failed, see build.log for details\"",
      "runs": ["npm run build:all-packages-in-the-monorepo"], "reads": [], "changes": []
    },
    "note": "Rule 2.2: a || list of 92 characters > 80 -> broken after '||', the second operand at IND. Rule 5.2: echo -> nothing (build.log in its text is not a path)."
  },
  {
    "id": "BV-33",
    "input": {"command": "git log --oneline --decorate --graph --all --since=2026-01-01 | grep -v Merge | head -n 20"},
    "expected": {
      "ok": true,
      "script": "git log --oneline --decorate --graph --all --since=2026-01-01 |\n  grep -v Merge |\n  head -n 20",
      "runs": ["git log"], "reads": []
    },
    "note": "Rule 2.2: a pipeline of 90 characters > 80 -> broken after each '|', operands 2-3 at IND. Rule 5.2: git + 'log' -> 'git log'; grep's only positional 'Merge' is the pattern -> no read; head's positional '20' (the -n value) is a number -> ignored (rule 5 paths). Listing numbers would add a read '20'."
  },
  {
    "id": "BV-34",
    "input": {"command": "npm run a && # c\nnpm run b"},
    "expected": {"ok": true, "script": "npm run a && # c\nnpm run b", "runs": ["npm run a", "npm run b"]},
    "note": "Rule 2.2: the list has a newline (so it does not fit) and holds a comment -> copied verbatim. Rule 5.2: two 'npm run x' labels."
  },
  {
    "id": "BV-35",
    "input": {"command": "for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do touch \"f$i.txt\"; done"},
    "expected": {
      "ok": true,
      "changes": ["f1.txt", "f2.txt", "f3.txt", "f4.txt", "f5.txt", "f6.txt", "f7.txt", "f8.txt", "f9.txt", "f10.txt", "f11.txt", "f12.txt", "f13.txt", "f14.txt", "f15.txt", "f16.txt", "f17.txt", "f18.txt", "f19.txt", "f20.txt", "f21.txt", "f22.txt", "f23.txt", "f24.txt", "f25.txt", "f26.txt", "f27.txt", "f28.txt", "f29.txt", "f30.txt"],
      "unresolved": 0
    },
    "note": "Rule 5 literals: the words 1…30 are numbers, which are literal. Rule 5.4: 30 values, not more than FOR_VALUES_MAX 30 -> the body is walked 30 times; '\"f$i.txt\"' is 'f' + the known $i + '.txt' -> 30 changes f1.txt … f30.txt in order."
  },
  {
    "id": "BV-36",
    "input": {"command": "for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31; do touch \"f$i.txt\"; done"},
    "expected": {
      "ok": true,
      "changes": ["f1.txt", "f2.txt", "f3.txt", "f4.txt", "f5.txt", "f6.txt", "f7.txt", "f8.txt", "f9.txt", "f10.txt", "f11.txt", "f12.txt", "f13.txt", "f14.txt", "f15.txt", "f16.txt", "f17.txt", "f18.txt", "f19.txt", "f20.txt", "f21.txt", "f22.txt", "f23.txt", "f24.txt", "f25.txt", "f26.txt", "f27.txt", "f28.txt", "f29.txt", "f30.txt"],
      "unresolved": 0
    },
    "note": "Rule 5.4: 31 literal values, only the first FOR_VALUES_MAX = 30 are walked -> the same 30 changes, no f31.txt, and nothing unresolved. A limit of > 30 (or none) would add f31.txt."
  },
  {
    "id": "BV-37",
    "input": {"command": "for f in $(ls src); do rm \"$f\"; done"},
    "expected": {"ok": true, "changes": [], "reads": [], "runs": [], "unresolved": 1},
    "note": "Rule 5.4: the word $(ls src) is not literal -> the body is walked once with f unknown -> rm \"$f\" has one non-literal positional -> unresolved 1. Rule 5.5: $(…) is not entered -> ls src is neither a read nor a run."
  },
  {
    "id": "BV-38",
    "input": {"command": "f=keep.txt; for f in a.txt; do cat \"$f\"; done; rm \"$f\"; P=; ls \"${P}lib\"; X=out.txt | true; touch \"$X\""},
    "expected": {"ok": true, "changes": [], "reads": ["a.txt", "lib"], "runs": [], "unresolved": 2},
    "note": "Rule 5.4: f = keep.txt, then the loop walks cat with f = a.txt -> read a.txt; after the loop f is unknown -> rm \"$f\" unresolved (1). P= stores '' -> \"${P}lib\" = 'lib' -> read lib. Rule 5.5: X=out.txt is a pipeline element, so it sets X only in its copy -> touch \"$X\" unresolved (2). true -> nothing. Keeping f after the loop would add a change keep.txt or a.txt."
  },
  {
    "id": "BV-39",
    "input": {"command": "cd /work/acme-app/packages/api; cat ../shared/x.ts ../../README.md ../../../other/y.txt ~/.npmrc C:/tmp/z.txt"},
    "expected": {
      "ok": true, "workDir": "/work/acme-app/packages/api",
      "script": "cat ../shared/x.ts ../../README.md ../../../other/y.txt ~/.npmrc C:/tmp/z.txt",
      "reads": ["../shared/x.ts", "../../README.md", "/work/other/y.txt", "~/.npmrc", "C:/tmp/z.txt"],
      "readGroups": [
        {"dir": "../shared/", "names": ["x.ts"]},
        {"dir": "../../", "names": ["README.md"]},
        {"dir": "/work/other/", "names": ["y.txt"]},
        {"dir": "~/", "names": [".npmrc"]},
        {"dir": "C:/tmp/", "names": ["z.txt"]}
      ]
    },
    "note": "Rule 3.1: plain cd lifted (no root -> shown as written). Rule 5.5: cwd = R = /work/acme-app/packages/api, segments ['', work, acme-app, packages, api] (5). ../shared/x.ts -> /work/acme-app/packages/shared/x.ts: k = 4, 5 - 4 = 1 -> '../shared/x.ts'. ../../README.md -> /work/acme-app/README.md: k = 3, 2 up -> '../../README.md'. ../../../other/y.txt -> /work/other/y.txt: k = 2, 3 up > 2 -> stays absolute. Rule 5 paths: ~/.npmrc and C:/tmp/z.txt are absolute (not joined), k = 0 -> as written. Rule 5.7: 5 reads > 3 -> grouped by the part up to the last '/'."
  },
  {
    "id": "BV-40",
    "input": {"command": "cd /work/acme-app; cat ../x.txt /etc/hosts"},
    "expected": {"ok": true, "workDir": "/work/acme-app", "reads": ["../x.txt", "/etc/hosts"]},
    "note": "Rule 5.5: R = /work/acme-app, segments ['', work, acme-app]. ../x.txt -> /work/x.txt, segments ['', work, x.txt]: k = 2 >= 2, 3 - 2 = 1 -> '../x.txt'. /etc/hosts: segments ['', etc, hosts], k = 1 < 2 -> stays '/etc/hosts' (k >= 1 would give '../../etc/hosts'; k >= 3 would keep '/work/x.txt')."
  },
  {
    "id": "BV-41",
    "input": {"command": "cd src | true; cat ../README.md"},
    "expected": {"ok": true, "workDir": null, "script": "cd src | true\ncat ../README.md", "reads": ["../README.md"]},
    "note": "Rule 3.1: the first statement is a pipeline -> no lift. Rule 5.5: cd inside a pipeline is ignored -> no current directory and no analysis root -> '../README.md' stays as written. A cd applied in the pipeline would give src + ../README.md = 'README.md'."
  },
  {
    "id": "BV-42",
    "input": {"command": "cd /work/acme-app; cd /tmp; cd \"$D\"; cat a.txt; cd /tmp; cd; cat b.txt"},
    "expected": {"ok": true, "workDir": "/work/acme-app", "reads": ["a.txt", "b.txt"], "unresolved": 0},
    "note": "Rule 3.1: the first cd is lifted. Rule 5.5: R = /work/acme-app; cd /tmp sets /tmp; cd \"$D\" has a non-literal target -> no current directory -> cat a.txt reads 'a.txt' (k = 0 against R -> as written). cd /tmp, then cd with no target -> none again -> 'b.txt'. A cd target is not a path, so nothing is unresolved. Ignoring the bad cd would give '/tmp/a.txt' (k = 1 -> absolute)."
  },
  {
    "id": "BV-43",
    "input": {"command": "sort < in.txt >> out.txt 2>/dev/null; npm test &> test.log; cat - > /dev/null; echo hi >&2"},
    "expected": {"ok": true, "changes": ["out.txt", "test.log"], "reads": ["in.txt"], "runs": ["npm test"], "unresolved": 0},
    "note": "Rule 5.1: '< in.txt' read; '>> out.txt' change; '2>/dev/null' target under /dev/ ignored; '&> test.log' change; '> /dev/null' ignored; '>&' in '>&2' is a change operator, but its target is the number 2, which the path rule ignores -> nothing. Rule 5.2: sort and cat are read commands; cat's '-' is ignored; echo -> nothing; npm test -> 'npm test'."
  },
  {
    "id": "BV-44",
    "input": {"command": "sed -n '1,20p' src/app.ts"},
    "expected": {"ok": true, "changes": [], "reads": ["src/app.ts"], "runs": []},
    "note": "Rule 5.2 sed: no -e/-f -> the first positional '1,20p' is the script; no -i -> src/app.ts is a read."
  },
  {
    "id": "BV-45",
    "input": {"command": "sed -i -e 's/a/b/' -e 's/c/d/' src/x.ts; sed -i -f fix.sed src/y.ts; sed --expression='s/e/f/' src/z.ts"},
    "expected": {"ok": true, "changes": ["src/x.ts", "src/y.ts"], "reads": ["fix.sed", "src/z.ts"], "runs": []},
    "note": "Rule 5.2 sed: (1) each -e takes the next argument as the script -> only src/x.ts remains, -i -> change. (2) -f fix.sed -> read fix.sed; src/y.ts remains, -i -> change. (3) --expression=… gives the script -> src/z.ts remains, no -i -> read. Taking the -e scripts as paths would add changes 's/a/b/' and 's/c/d/'."
  },
  {
    "id": "BV-46",
    "input": {"command": "mv old.txt new.txt; rg -n \"foo\" src docs; /usr/bin/rm -f tmp.txt; cp a.txt b.txt out"},
    "expected": {
      "ok": true,
      "changes": ["old.txt", "new.txt", "tmp.txt", "out"], "reads": ["src", "docs", "a.txt", "b.txt"], "runs": [],
      "changeGroups": [{"dir": "./", "names": ["old.txt", "new.txt", "tmp.txt", "out"]}],
      "readGroups": [{"dir": "./", "names": ["src", "docs", "a.txt", "b.txt"]}]
    },
    "note": "Rule 5.2: mv -> both positionals are changes; rg -> 'foo' is the pattern, src and docs are reads; /usr/bin/rm has base name rm -> change tmp.txt; cp -> a.txt, b.txt reads, the last 'out' a change. Rule 5.7: 4 changes and 4 reads, all bare -> one './' group each. ('cp: the last positional is also a read' cannot be seen: rule 5.6 hides a read that is a change.)"
  },
  {
    "id": "BV-47",
    "input": {"command": "npm run; git -C ../other status; bun run build; npx tsc --noEmit; pnpm run \"$X\""},
    "expected": {"ok": true, "runs": ["npm run ?", "git", "bun run build", "npx tsc", "pnpm run ?"], "inline": [], "reads": [], "unresolved": 0},
    "note": "Rule 5.2: npm + 'run' with no second argument -> 'npm run ?'; git's first argument '-C' starts with '-' -> bare 'git' (its arguments are not paths); bun + 'run build' -> 'bun run build'; npx + 'tsc' -> 'npx tsc'; pnpm + 'run' with a non-literal second argument \"$X\" -> 'pnpm run ?' (arguments of a run are not paths, so unresolved stays 0). Rule 5.3: bun is a script command but has no -e/-c/--eval and no heredoc -> no inline note. Printing a non-literal argument as is would give 'pnpm run null'; dropping pnpm from the run-script tools would give 'pnpm run'."
  },
  {
    "id": "BV-48",
    "input": {"command": "python3 -c 'print(1)'; node --eval \"console.log(2)\"; node -e 'const a = 1;\nconsole.log(a);\nprocess.exit(0);'; perl -e 'print 3'; perl -e 'print 4'"},
    "expected": {
      "ok": true, "runs": ["python3", "node", "perl"],
      "inline": ["inline python3 script, 1 lines — not analysed", "inline node script, 1 lines — not analysed", "inline node script, 3 lines — not analysed", "inline perl script, 1 lines — not analysed", "inline perl script, 1 lines — not analysed"],
      "inlineGroups": null
    },
    "note": "Rule 5.3: python3 -c 'print(1)' -> 1 line; node --eval \"…\" -> 1 line; node -e with a raw string holding two newlines -> 3 lines; perl -e 'print 3' and perl -e 'print 4' -> 1 line each: two scripts, two identical notes (notes are not deduplicated by text; deduplicating would leave one perl note). Rule 5.2: runs python3, node (deduplicated), perl (deduplicated). Rule 5.7: 5 inline notes > 3, but inline notes are never grouped -> null."
  },
  {
    "id": "BV-49",
    "input": {"command": "cat /work/acme-app/src/a.ts", "root": "/Work/Acme-App"},
    "expected": {"ok": true, "script": "cat src/a.ts", "reads": ["src/a.ts"]},
    "note": "Rule 6.1: the root matches case-insensitively, so '/work/acme-app/' loses its prefix in the script and in the read."
  },
  {
    "id": "BV-50",
    "input": {"command": "cat 'C:\\work\\acme-app\\src\\a.ts'", "root": "C:/work/acme-app"},
    "expected": {"ok": true, "script": "cat 'src\\a.ts'", "reads": ["src/a.ts"]},
    "note": "Rule 6.1/6.3: the backslash spelling 'C:\\work\\acme-app' followed by '\\' loses the prefix in the script -> 'src\\a.ts'. Rule 5 paths: the raw string's backslashes become '/' -> C:/work/acme-app/src/a.ts (absolute), which rule 6.5 shows as 'src/a.ts'."
  },
  {
    "id": "BV-51",
    "input": {"command": "ls x/work/acme-app ./work/acme-app ~/work/acme-app x-/work/acme-app", "root": "/work/acme-app"},
    "expected": {
      "ok": true,
      "script": "ls x/work/acme-app ./work/acme-app ~/work/acme-app x-/work/acme-app",
      "reads": ["x/work/acme-app", "./work/acme-app", "~/work/acme-app", "x-/work/acme-app"]
    },
    "note": "Rule 6.2: each occurrence of the root follows 'x' (a word character), '.', '~' or '-' -> none is replaced. Rule 5 paths: the relative ones stay as written (no current directory), ~/… is absolute."
  },
  {
    "id": "BV-52",
    "input": {"command": "ls /work/acme-app; (ls /work/acme-app); ls /work/acme-app& ls '/work/acme-app'", "root": "/work/acme-app"},
    "expected": {
      "ok": true,
      "rawDisplay": "ls .; (ls .); ls .& ls '.'",
      "script": "ls .\n(ls .)\nls . &\nls '.'",
      "reads": ["."]
    },
    "note": "Rule 6.3: in the raw text the bare root is followed by ';', ')', '&' and a quote -> '.' each time. Rule 2.1: four statements, the third with ' &'; in the script the roots are followed by a newline (whitespace), ')', a space and a quote -> '.'. Rule 5.6: the same path four times -> one read, shown as '.'."
  },
  {
    "id": "BV-53",
    "input": {"command": "cat > /work/acme-app/notes.md <<'EOF'\nsee /work/acme-app/src/a.ts\n2\n3\n4\n5\n6\n7\n8\n9\nEOF", "root": "/work/acme-app"},
    "expected": {
      "ok": true,
      "script": "cat > notes.md <<'EOF'\n# ▼ block 1: 9 lines, shown below\nEOF",
      "folded": [{"n": 1, "head": "cat > notes.md <<'EOF'", "body": "see src/a.ts\n2\n3\n4\n5\n6\n7\n8\n9", "lines": 9}],
      "changes": ["notes.md"], "inline": []
    },
    "note": "Rule 4.1: 9 body lines > 8 -> folded as block 1. Rule 6.5: the head, the body and the script are made repo-relative -> 'cat > notes.md <<'EOF'' and 'see src/a.ts'. Rule 5.1: '> /work/acme-app/notes.md' -> change, shown as 'notes.md'. cat is not a script command -> no inline note."
  },
  {
    "id": "BV-54",
    "input": {"command": ""},
    "expected": {
      "ok": true, "workDir": null, "script": "", "rawDisplay": "", "folded": [], "firstStatement": null,
      "changes": [], "reads": [], "runs": [], "inline": [], "unresolved": 0
    },
    "note": "Rule 1.2: an empty command parses without error -> ok, empty script, nothing found; there is no non-empty line -> firstStatement null."
  },
  {
    "id": "BV-55",
    "input": {"command": "cd /work/acme-app; ls /work/acme-app; (cd /tmp/; cat a.txt /a/../b.txt); cp"},
    "expected": {
      "ok": true, "workDir": "/work/acme-app",
      "script": "ls /work/acme-app\n(cd /tmp/; cat a.txt /a/../b.txt)\ncp",
      "lineCount": 3, "rawLineCount": 1,
      "changes": [], "reads": [".", "/tmp//a.txt", "/a/../b.txt"], "runs": [], "unresolved": 0, "readGroups": null
    },
    "note": "Rule 3.1: the plain 'cd /work/acme-app' is lifted (no root -> shown as written); the three other statements are lines 1-3 (the subshell fits, rule 2.5) -> lineCount 3; the command is one line -> rawLineCount 1 (rule 1.3). Rule 5.5: cwd = R = /work/acme-app; 'ls /work/acme-app' reads p = R -> '.'. In the subshell cd /tmp/ sets cwd '/tmp/' (absolute, kept with its trailing slash); 'a.txt' joined -> segments ['', tmp, '', a.txt] -> '/tmp//a.txt' (empty segments are skipped only in the joined path p, not in cwd); '/a/../b.txt' is absolute -> never normalised. Both share k = 1 segment with R -> stay absolute. 'cp' with no positional: no read, no change, nothing unresolved, and not a run. 3 reads -> flat (rule 5.7). Dropping the 'p = R' case would give '' (k = 3, 0 levels up)."
  },
  {
    "id": "BV-56",
    "input": {"command": "> pre.txt echo hi; npm test &>> test.log; echo x >| forced.txt; cat <<'EOF' > out.txt\nhi\nEOF"},
    "expected": {
      "ok": true,
      "script": "> pre.txt echo hi\nnpm test &>> test.log\necho x >| forced.txt\ncat <<'EOF' > out.txt\nhi\nEOF",
      "lineCount": 6, "rawLineCount": 3, "firstStatement": "> pre.txt echo hi",
      "changes": ["pre.txt", "test.log", "forced.txt", "out.txt"], "reads": [], "runs": ["npm test"], "inline": [],
      "changeGroups": [{"dir": "./", "names": ["pre.txt", "test.log", "forced.txt", "out.txt"]}]
    },
    "note": "Rule 2.1: four statements; the heredoc statement is verbatim (rule 2.6) with its 1-line body -> 3 + 3 = 6 script lines; the command has 3 lines (rule 1.3). Rule 5.1, where redirects are found: '> pre.txt' written before the command name is inside the command -> change; '&>>' and '>|' are change operators -> test.log, forced.txt; '> out.txt' written after the heredoc start sits inside the heredoc redirect -> change. echo -> nothing; cat has no positional; cat is not a script command -> no inline note. 4 changes > 3, all bare -> one './' group."
  },
  {
    "id": "BV-57",
    "input": {"command": "sed --in-place=.bak --expression 's/a/b/' --expression 's/c/d/' src/x.ts; sed --in-place --file fix.sed src/y.ts; sed --file=more.sed -n src/z.ts"},
    "expected": {"ok": true, "changes": ["src/x.ts", "src/y.ts"], "reads": ["fix.sed", "more.sed", "src/z.ts"], "runs": [], "unresolved": 0},
    "note": "Rule 5.2 sed, long forms: (1) '--in-place=.bak' is in-place; each '--expression' takes the next argument ('s/a/b/', 's/c/d/') as a script -> only src/x.ts remains -> change. (2) bare '--in-place' is in-place; '--file fix.sed' -> read fix.sed -> src/y.ts change. (3) '--file=more.sed' -> read more.sed, '-n' a flag, no in-place -> src/z.ts read. Not consuming the '--expression' arguments would leave 's/c/d/' as a positional after the script 's/a/b/' -> a change 's/c/d/'."
  },
  {
    "id": "BV-58",
    "input": {"command": "$CMD a.txt; D=src; D=$(pwd); cat \"$D/a.ts\"; E=lib; E=docs cat \"$E/b.ts\"; cat \"${E:-x}/c.ts\""},
    "expected": {"ok": true, "changes": [], "reads": ["lib/b.ts"], "runs": [], "unresolved": 3},
    "note": "Rule 5.2: the command name $CMD is not literal -> unresolved 1, its argument a.txt is not looked at, no run. Rule 5.4: D=src stored, then D=$(pwd) is not literal -> D forgotten -> cat \"$D/a.ts\" unresolved 2. E=lib stored; the prefix assignment E=docs in 'E=docs cat …' is not stored -> \"$E/b.ts\" = lib/b.ts read. Rule 5 literals: '${E:-x}' is not the bare-name form -> not literal -> unresolved 3."
  },
  {
    "id": "BV-59",
    "input": {"command": "f=x.txt; for f in \"a b.txt\" c.txt; do cat \"$f\"; done; for g; do rm \"$g\"; done"},
    "expected": {
      "ok": true,
      "script": "f=x.txt\nfor f in \"a b.txt\" c.txt; do\n  cat \"$f\"\ndone\nfor g; do\n  rm \"$g\"\ndone",
      "changes": [], "reads": [], "unresolved": 2
    },
    "note": "Rule 2.3: the 'for … in' header is 'for f in' + the words + '; do'; 'for g; do' has no 'in', so its header is the source from 'for' to the variable, then '; do'. Rule 5.4: the word 'a b.txt' contains a space -> the body is walked once with f unknown (the earlier f=x.txt is dropped) -> cat \"$f\" unresolved 1, c.txt is not read. 'for g' has no words -> walked once with g unknown -> rm \"$g\" unresolved 2. Keeping f would read x.txt; skipping a loop with no words would leave unresolved 1."
  },
  {
    "id": "BV-60",
    "input": {"command": "cat my\\ file.txt; bash -c; ruby -e \"$S\"; cat \"a\\\nb.txt\""},
    "expected": {
      "ok": true, "reads": ["my file.txt", "ab.txt"], "runs": ["bash", "ruby"], "unresolved": 0,
      "inline": ["inline bash script, 1 lines — not analysed", "inline ruby script, 1 lines — not analysed"]
    },
    "note": "Rule 5 literals: the word 'my\\ file.txt' loses its backslash escape -> read 'my file.txt'. In the double-quoted \"a\\<newline>b.txt\" the backslash-newline disappears whole -> read 'ab.txt' (keeping the newline would read 'a<newline>b.txt'). Rule 5.2: bash and ruby are in no table -> bare run labels. Rule 5.3: bash -c has no argument after it, ruby -e has a non-literal one -> each counts as 1 line. Arguments of a run are not paths -> \"$S\" adds nothing to unresolved."
  },
  {
    "id": "BV-61",
    "input": {"command": "cd \"$D\"; ls"},
    "expected": {"ok": true, "workDir": null, "script": "cd \"$D\"\nls", "firstStatement": "cd \"$D\"", "reads": [], "runs": []},
    "note": "Rule 3.1: the cd target is not literal -> not lifted, the line stays and is the first statement. Rule 5.2: ls has no positional; it is a read command, not a run."
  },
  {
    "id": "BV-62",
    "input": {"command": "cd src lib; cat a.txt ../lib/b.txt"},
    "expected": {"ok": true, "workDir": null, "script": "cd src lib\ncat a.txt ../lib/b.txt", "reads": ["a.txt", "lib/b.txt"]},
    "note": "Rule 3.1: cd with 2 arguments (not exactly one) -> not lifted. Rule 5.5: the analysis cd uses its first positional -> cwd = R = src; a.txt -> src/a.txt, which starts with 'R/' -> 'a.txt'; ../lib/b.txt -> [src] pop, + lib, b.txt -> lib/b.txt: segments [lib, b.txt] vs R [src], k = 0 -> as is 'lib/b.txt'. Using the last positional (cwd = R = lib) would give 'b.txt' for the second read."
  },
  {
    "id": "BV-63",
    "input": {"command": "npm run build && git log --oneline --decorate --graph --all --since=2026-01-01 | grep -v Merge | head -n 20 && echo ok"},
    "expected": {
      "ok": true,
      "script": "npm run build &&\n  git log --oneline --decorate --graph --all --since=2026-01-01 |\n    grep -v Merge |\n    head -n 20 &&\n  echo ok",
      "lineCount": 5, "runs": ["npm run build", "git log"], "reads": []
    },
    "note": "Rule 2.2: the && list is 118 characters > 80 -> broken after each &&, operands 2 and 3 at IND. Operand 2 is the pipeline of BV-33 (90 characters); at indent 2 it is 92 > 80 -> broken on its own: its first element on the operand's line, the others at 2 + IND = 4 spaces. The list's '&&' after the pipeline ends the pipeline's last line. Rule 5.2: 'npm run build', 'git log'; grep's only positional is its pattern; head's '20' is a number."
  },
  {
    "id": "BV-64",
    "input": {"command": "for f in 'a\nb'; do echo \"$f\"; done\nwhile true &&\n  true; do sleep 1; done\nif true &&\n  true; then echo; fi\nif true; then echo; elif true &&\n  true; then echo; fi"},
    "expected": {
      "ok": true,
      "script": "for f in 'a\nb'; do echo \"$f\"; done\nwhile true &&\n  true; do sleep 1; done\nif true &&\n  true; then echo; fi\nif true; then echo; elif true &&\n  true; then echo; fi",
      "changes": [], "reads": [], "runs": []
    },
    "note": "Rule 2.3: a for word with a newline, and a while header with a newline -> each whole loop verbatim. Rule 2.4: a newline in the if condition, and in an elif condition (after an if clause that fits) -> each whole if verbatim. The four statements are on lines of their own already -> script = command. Rule 5.2: echo, true, sleep -> nothing."
  },
  {
    "id": "BV-65",
    "input": {"command": "npx /work/acme-app/x; cat /work/acme-app/y", "root": "/work/acme-app"},
    "expected": {"ok": true, "rawDisplay": "npx x; cat y", "script": "npx x\ncat y", "firstStatement": "npx x", "runs": ["npx /work/acme-app/x"], "reads": ["y"]},
    "note": "Rule 5.2: npx + the literal first argument '/work/acme-app/x' -> run label 'npx /work/acme-app/x'. Rule 6.5: runs are never made repo-relative, while the script, the raw text, the first statement ('npx /work/acme-app/x' -> 'npx x', rule 6.6) and the read are ('root/' loses the prefix, rule 6.3)."
  },
  {
    "id": "BV-66",
    "input": {"command": "cat > a.txt <<'EOF'\n1\n2\n3\n4\n5\n6\n7\n8\n9\nEOF\ncat > b.txt <<'EOF'\n1\n2\n3\n4\n5\n6\n7\n8\n9\nEOF"},
    "expected": {
      "ok": true,
      "script": "cat > a.txt <<'EOF'\n# ▼ block 1: 9 lines, shown below\nEOF\ncat > b.txt <<'EOF'\n# ▼ block 2: 9 lines, shown below\nEOF",
      "folded": [
        {"n": 1, "head": "cat > a.txt <<'EOF'", "body": "1\n2\n3\n4\n5\n6\n7\n8\n9", "lines": 9},
        {"n": 2, "head": "cat > b.txt <<'EOF'", "body": "1\n2\n3\n4\n5\n6\n7\n8\n9", "lines": 9}
      ],
      "lineCount": 6, "rawLineCount": 22, "changes": ["a.txt", "b.txt"]
    },
    "note": "Rule 4.1: two identical 9-line bodies, handled in source order: the first replaces the first occurrence (under a.txt) with block 1, the second then replaces the remaining one with block 2; heads by rule 4.2. Rule 1.3: script 3 + 3 = 6 lines; command 2 x (1 + 9 + 1) = 22 lines. Rule 5.1: two changes. Replacing the last occurrence would put block 1 under b.txt."
  },
  {
    "id": "BV-67",
    "input": {"command": "cat /work/acme-app/a.txt\nfor x in; do", "root": "/work/acme-app"},
    "expected": {"ok": false, "workDir": null, "script": "cat a.txt\nfor x in; do", "rawDisplay": "cat a.txt\nfor x in; do", "lineCount": 2, "rawLineCount": 2, "reads": [], "unresolved": 0},
    "note": "Rule 1.1: the unfinished for loop is a syntax error -> ok false; script = rawDisplay = the command made repo-relative ('root/' loses the prefix); no files. Rule 1.3: both counts are the command's 2 lines."
  },
  {
    "id": "BV-68",
    "input": {"command": "chmod 755 run.sh; rmdir old; truncate -s 0 log.txt; tail -n 5 app.log; diff a.txt b.txt; cut -d, -f1 data.csv; printf x; test -f cfg.txt; docker build .; yarn run lint"},
    "expected": {
      "ok": true,
      "changes": ["run.sh", "old", "log.txt"], "changeGroups": null,
      "reads": ["app.log", "a.txt", "b.txt", "data.csv"], "readGroups": [{"dir": "./", "names": ["app.log", "a.txt", "b.txt", "data.csv"]}],
      "runs": ["docker build", "yarn run lint"], "unresolved": 0
    },
    "note": "Rule 5.2, one representative per table: chmod, rmdir, truncate are change commands (755 and 0 are numbers -> ignored; -s a flag); tail, diff, cut are read commands (5 a number; -d, and -f1 flags); printf and test are in the nothing list (x and cfg.txt not read, no run); docker + 'build' -> 'docker build'; yarn + 'run lint' -> 'yarn run lint'. 3 changes flat, 4 reads -> one './' group."
  },
  {
    "id": "BV-69",
    "input": {"command": "for f in a.txt b.txt; do cat \"$f\"; done > dist/all-sources-all-sources-all-s.txt; { npm run build:packages; npm run test:packages; npm run lint:workspace-works; }; (cd packages/api && npm run build:all; npm run test:everything-everythi -- --ci)"},
    "expected": {
      "ok": true,
      "script": "for f in a.txt b.txt; do cat \"$f\"; done > dist/all-sources-all-sources-all-s.txt\n{ npm run build:packages; npm run test:packages; npm run lint:workspace-works; }\n(cd packages/api && npm run build:all; npm run test:everything-everythi -- --ci)"
    },
    "note": "Rule 2.1: three top-level statements, each on its own line at indent 0. Rule 2.8: the redirected statement is 'for f in a.txt b.txt; do cat \"$f\"; done' (39) + ' > ' (3) + 'dist/all-sources-all-sources-all-s.txt' (38) = 80 <= WIDTH -> one line as written. Rule 2.5: the group '{ … }' is 2 + 22 + 2 + 21 + 2 + 28 + 3 = 80 and the subshell '(…)' is 1 + 36 + 2 + 40 + 1 = 80 characters -> each stays on one line. Breaking at >= 80 would open all three."
  },
  {
    "id": "BV-70",
    "input": {"command": "for f in a.txt b.txt; do cat \"$f\"; done > dist/all-sources-all-sources-all-so.txt; { npm run build:packages; npm run test:packages; npm run lint:workspace-worksp; }; (cd packages/api && npm run build:all; npm run test:everything-everythin -- --ci)"},
    "expected": {
      "ok": true,
      "script": "for f in a.txt b.txt; do\n  cat \"$f\"\ndone > dist/all-sources-all-sources-all-so.txt\n{\n  npm run build:packages\n  npm run test:packages\n  npm run lint:workspace-worksp\n}\n(\n  cd packages/api && npm run build:all\n  npm run test:everything-everythin -- --ci\n)"
    },
    "note": "BV-69 with each statement one character longer (81 > WIDTH). Rule 2.8: the body (the loop) is laid out by rule 2.3 ('for f in a.txt b.txt; do', body at IND, 'done') and the redirect text ' > dist/…-so.txt' is appended to 'done'. Rule 2.5: '{' alone, the three statements at IND, '}' alone; '(' alone, the list 'cd packages/api && npm run build:all' (2 + 36 = 38 <= 80, one line, rule 2.2) and the second statement at IND, ')' alone. Breaking only above 81 would keep all three on one line."
  },
  {
    "id": "BV-71",
    "input": {"command": "{ npm run build:all-packages && npm run test:all-packages-all-packages-all-packag; for g in c.txt d.txt; do cat \"$g\"; done > out/combined-combined-combined-co.txt; (cd packages/web && npm run build:all; npm run test:everything-everything-ever); for h in alpha.ts beta.ts gamma-module-gamma-module-gamma-module-gamma-m.ts; do touch \"$h\"; done; }"},
    "expected": {
      "ok": true,
      "script": "{\n  npm run build:all-packages &&\n    npm run test:all-packages-all-packages-all-packag\n  for g in c.txt d.txt; do\n    cat \"$g\"\n  done > out/combined-combined-combined-co.txt\n  (\n    cd packages/web && npm run build:all\n    npm run test:everything-everything-ever\n  )\n  for h in \\\n      alpha.ts \\\n      beta.ts \\\n      gamma-module-gamma-module-gamma-module-gamma-m.ts; do\n    touch \"$h\"\n  done\n}"
    },
    "note": "Rule 2 'fits' counts the current indent. The group is far over 80 -> '{', body at IND = 2, '}'. Each body element is 79 characters, so it would fit at indent 0 but 2 + 79 = 81 > 80 at indent 2: the && list (26 + 4 + 49 = 79) breaks after '&&', its second operand at 2 + IND = 4 (rule 2.2); the redirected loop (39 + 3 + 37 = 79) opens its loop at indent 2 with the body at 4 and the redirect on 'done' (rule 2.8); the subshell (1 + 36 + 2 + 39 + 1 = 79) opens with '(' and ')' at 2 and its statements at 4 (rule 2.5); the for header 'for h in alpha.ts beta.ts gamma-…-m.ts; do' is 79, with the indent 81 > 80 and 3 > 2 words -> 'for h in \\' and one word per line at 2 + 2 x IND = 6 (rule 2.3), body at 4. Measuring without the indent would keep all four on one line."
  },
  {
    "id": "BV-72",
    "input": {"command": "cd /work/acme-app; cat /work/acme-app2/x.txt; cd /tmp; cat ~/.npmrc C:/x.txt ./y.txt a//b.txt ../dev/null"},
    "expected": {
      "ok": true, "workDir": "/work/acme-app",
      "script": "cat /work/acme-app2/x.txt\ncd /tmp\ncat ~/.npmrc C:/x.txt ./y.txt a//b.txt ../dev/null",
      "reads": ["../acme-app2/x.txt", "~/.npmrc", "C:/x.txt", "/tmp/y.txt", "/tmp/a/b.txt"], "unresolved": 0,
      "readGroups": [
        {"dir": "../acme-app2/", "names": ["x.txt"]},
        {"dir": "~/", "names": [".npmrc"]},
        {"dir": "C:/", "names": ["x.txt"]},
        {"dir": "/tmp/", "names": ["y.txt"]},
        {"dir": "/tmp/a/", "names": ["b.txt"]}
      ]
    },
    "note": "Rule 3.1: plain cd lifted (no root -> shown as written). Rule 5.5: R = /work/acme-app. /work/acme-app2/x.txt does not start with 'R/' (the '/' boundary): segments ['', work, acme-app2, x.txt] vs ['', work, acme-app], k = 2, 1 level up -> '../acme-app2/x.txt'. Then cwd = /tmp (not R). Rule 5 paths: ~/.npmrc and C:/x.txt are absolute -> not joined to /tmp, k = 0 -> as written; ./y.txt joined: '.' skipped -> /tmp/y.txt; a//b.txt: the empty segment skipped -> /tmp/a/b.txt (both k = 1 -> absolute); ../dev/null joins to /dev/null -> ignored. Rule 5.7: 5 reads -> grouped. Without the '/' boundary: '/x.txt'; '~' or 'X:/' not absolute: '/tmp/~/.npmrc', '/tmp/C:/x.txt'; '.' or '' kept: '/tmp/./y.txt', '/tmp/a//b.txt'; /dev/ tested before the join: '/dev/null' read."
  },
  {
    "id": "BV-73",
    "input": {"command": "npm test >& test.log; cmd 2>&-; echo x >&2; cat \\&1; 'C:\\bin\\rm' x; > p.txt $C a.txt"},
    "expected": {"ok": true, "changes": ["test.log", "x", "p.txt"], "reads": [], "runs": ["npm test", "cmd"], "unresolved": 1},
    "note": "Rule 5.1: '>& test.log' writes test.log -> change; '2>&-' closes descriptor 2 (the operator '>&-' is not a change operator) -> nothing; '>&2' targets the number 2 -> ignored. Rule 5 literals/paths: '\\&1' is the word '&1' -> ignored as &N, so cat reads nothing. Rule 5.2: the quoted name 'C:\\bin\\rm' keeps its backslashes, its base after the last '\\' is rm -> change x. '> p.txt $C a.txt': the name $C is not literal -> unresolved 1 and a.txt is not looked at, but the redirect before the name is still a change p.txt. Runs: 'npm test', bare 'cmd'; echo nothing."
  },
  {
    "id": "BV-74",
    "input": {"command": "cd /x & cat ../a.txt /x/e.txt; (Y=b.txt); cat \"$Y\"; Z=c.txt & cat \"$Z\"; export X=d.txt; cat \"$X\""},
    "expected": {
      "ok": true, "workDir": null,
      "script": "cd /x &\ncat ../a.txt /x/e.txt\n(Y=b.txt)\ncat \"$Y\"\nZ=c.txt &\ncat \"$Z\"\nexport X=d.txt\ncat \"$X\"",
      "firstStatement": "cd /x &", "reads": ["../a.txt", "e.txt", "d.txt"], "runs": [], "unresolved": 2
    },
    "note": "Rule 2.1: the '&' stays on its line -> first line 'cd /x &'. Rule 3.2: that line is not the statement's text 'cd /x' -> not lifted. Rule 5.5: 'cd /x &' runs in the background -> on a copy: R = /x but the directory stays none -> '../a.txt' as written (k = 0 against R), while the absolute /x/e.txt starts with 'R/' -> 'e.txt' (R not taken from a background cd would leave '/x/e.txt'). '(Y=b.txt)' sets Y only in the subshell's copy -> cat \"$Y\" unresolved 1; 'Z=c.txt &' likewise -> unresolved 2. Rule 5.4: 'export X=d.txt' stores X -> read d.txt. Applying the background cd would give '/a.txt'; a shared subshell or background copy would read b.txt or c.txt; lifting without the first-line check would give workDir '/x'."
  },
  {
    "id": "BV-75",
    "input": {"command": "cd -; cat a.txt; cd ''; cd /work; cat b.txt"},
    "expected": {"ok": true, "workDir": null, "script": "cd -\ncat a.txt\ncd ''\ncd /work\ncat b.txt", "reads": ["a.txt", "b.txt"], "unresolved": 0},
    "note": "Rule 3.1: the target '-' starts with '-' -> not lifted. Rule 5.5: 'cd -' has no positional -> directory none, R not set -> 'a.txt' as written. cd '' is an empty target -> none again, R still not set. cd /work -> directory and R = /work -> b.txt = /work/b.txt = 'R/b.txt' -> 'b.txt'. Taking '' as a target would set R = '' (no relativisation) -> '/work/b.txt'; lifting '-' would give workDir '-'."
  },
  {
    "id": "BV-76",
    "input": {"command": "# setup\ncd /w; f() { cat a.txt; }; case $x in a) rm b.txt;; esac; while read l; do cat d.txt; done; select s in e.txt; do cat \"$s\"; done; for g in *.ts; do rm \"$g\"; done"},
    "expected": {
      "ok": true, "workDir": null,
      "script": "# setup\ncd /w\nf() { cat a.txt; }\ncase $x in a) rm b.txt;; esac\nwhile read l; do\n  cat d.txt\ndone\nselect s in e.txt; do\n  cat \"$s\"\ndone\nfor g in *.ts; do\n  rm \"$g\"\ndone",
      "lineCount": 13, "firstStatement": "# setup",
      "changes": ["b.txt", "*.ts"], "reads": ["a.txt", "d.txt", "e.txt"], "runs": [], "unresolved": 0
    },
    "note": "Rule 3.2: the first top-level node is the comment -> no lift. Rule 2.6: the function definition and the case are copied verbatim; rule 2.3: while opened; select takes the other-loop header 'select s in e.txt; do'; 'for g in *.ts; do'. 13 lines. Rule 5.5: cwd = R = /w; the function body is analysed where defined -> read a.txt; the case item -> change b.txt; while: read is in the nothing list, cat -> read d.txt. Rule 5.4: select walks its body with s = e.txt -> read e.txt; '*.ts' is a literal word -> rm \"$g\" changes '*.ts'. All under R -> shown without '/w/'."
  },
  {
    "id": "BV-77",
    "input": {"command": "cat /etc/x", "root": "/"},
    "expected": {"ok": true, "script": "cat /etc/x", "rawDisplay": "cat /etc/x", "reads": ["/etc/x"]},
    "note": "Rule 6.4: the root '/' is only slashes -> empty once the trailing slash is removed -> the text is unchanged everywhere. Matching an empty root would cut the '/' after the space -> 'cat etc/x'."
  },
  {
    "id": "BV-78",
    "input": {"command": "cd ''; sed -i.bak 's/a/b/' f.txt; cat $D/a.ts; git ''; sed -f"},
    "expected": {
      "ok": true, "workDir": null,
      "script": "cd ''\nsed -i.bak 's/a/b/' f.txt\ncat $D/a.ts\ngit ''\nsed -f",
      "changes": ["f.txt"], "reads": [], "runs": ["git"], "unresolved": 1
    },
    "note": "Rule 3.1: the first statement is a plain cd with one literal argument, but its value is '' -> not lifted, the line stays (rule 2.1: five statements, five lines). Rule 5.5: cd '' -> no directory, R not set. Rule 5.2 sed: '-i.bak' starts with -i -> in place; no -e/-f -> 's/a/b/' is the script -> change f.txt. Rule 5 literals: '$D/a.ts' is a concatenation of the unknown $D and '/a.ts' -> not literal -> cat's positional unresolved (1). git '' -> first argument '' -> bare 'git'. 'sed -f' with nothing after it -> the script file is '' -> ignored, no read and nothing unresolved; no positional left. Lifting '' would give workDir '' and drop the line; '-i' matched only exactly would read f.txt; skipping the unknown part would read '/a.ts' with unresolved 0; '' as a subcommand would give 'git '; a missing -f file counted as non-literal would give unresolved 2."
  },
  {
    "id": "BV-79",
    "input": {"command": "cd /w; f=a.txt; for f in b.txt; do :; done > \"$f\"; cd sub > out.txt; cat c.txt; git \"a\\\"b\\$c\\`d\\\\e\\x\""},
    "expected": {
      "ok": true, "workDir": "/w",
      "script": "f=a.txt\nfor f in b.txt; do :; done > \"$f\"\ncd sub > out.txt\ncat c.txt\ngit \"a\\\"b\\$c\\`d\\\\e\\x\"",
      "changes": ["a.txt", "out.txt"], "reads": ["sub/c.txt"], "runs": ["git a\"b$c`d\\e\\x"], "unresolved": 0
    },
    "note": "Rule 3.1: 'cd /w' lifted. Rule 2.8: the redirected loop fits -> one line as written. Rule 5.1: a redirected statement's redirects are resolved before its body: '> \"$f\"' uses f = a.txt (from f=a.txt; the loop has not run yet) -> /w/a.txt -> 'a.txt'; then the loop walks with f = b.txt and ':' does nothing. 'cd sub > out.txt': the redirect is resolved with the directory /w -> /w/out.txt -> 'out.txt'; then cd sets /w/sub, so cat c.txt reads /w/sub/c.txt -> 'sub/c.txt' (R = /w). Rule 5 literals: in the double-quoted string the backslash is dropped before '\"', '$', '`' and '\\', kept before 'x' -> git's first argument is a\"b$c`d\\e\\x (one backslash before e and one before x) -> label 'git a\"b$c`d\\e\\x'. Walking the body first would give unresolved 1 for \"$f\" (f unknown after the loop) and 'sub/out.txt'; taking the string text raw would keep every backslash in the label."
  },
  {
    "id": "BV-80",
    "input": {"command": "cat <<'EOF' > a.txt; echo ok\nhi\nEOF"},
    "expected": {"ok": false, "script": "cat <<'EOF' > a.txt; echo ok\nhi\nEOF", "changes": [], "runs": [], "unresolved": 0},
    "note": "Rules 2.6/1.1: a statement after a heredoc start on the same line is a syntax error in the grammar -> ok false, script = the command, no files. This is why no two statements ever share a heredoc's lines in the layout. A grammar that accepted it would make this row fail, and rule 2.6 would need a layout for it."
  },
  {
    "id": "BV-81",
    "input": {"command": "> e.txt; < in.txt > out/a-rather-long-directory-name/and-an-even-longer-file-name-for-width.txt"},
    "expected": {
      "ok": true,
      "script": "> e.txt\n< in.txt > out/a-rather-long-directory-name/and-an-even-longer-file-name-for-width.txt",
      "changes": ["e.txt", "out/a-rather-long-directory-name/and-an-even-longer-file-name-for-width.txt"], "reads": ["in.txt"], "runs": [], "unresolved": 0
    },
    "note": "Rule 2.8: two redirected statements with no body. '> e.txt' fits -> as written. The second is 9 + 2 + 75 = 86 characters > 80 -> copied verbatim, which is the same one line. Rule 5.1: '>' -> changes e.txt and the long path; '<' -> read in.txt; no command -> no run."
  },
  {
    "id": "BV-82",
    "input": {"command": "cat <<EOF > a.txt && rm b.txt\n1\n2\n3\n4\n5\n6\n7\n8\n9\nEOF"},
    "expected": {
      "ok": true, "workDir": null,
      "script": "cat <<EOF > a.txt && rm b.txt\n# ▼ block 1: 9 lines, shown below\nEOF",
      "folded": [{"n": 1, "head": "cat <<EOF > a.txt && rm b.txt", "body": "1\n2\n3\n4\n5\n6\n7\n8\n9", "lines": 9}],
      "lineCount": 3, "rawLineCount": 11,
      "changes": ["a.txt", "b.txt"], "reads": [], "runs": [], "inline": [], "unresolved": 0
    },
    "note": "Rule 2.6: '&& rm b.txt' after the heredoc start is part of the one heredoc statement -> copied verbatim. Rule 4.1/4.2: the body has 9 lines > 8 -> folded as block 1, head = the statement's first line with the chained part; script = 3 lines (rule 1.3), the command 11. Rule 5.1: '> a.txt' inside the heredoc redirect -> change. Rule 5.5 (chained after a heredoc start): '&& rm b.txt' runs after cat in the same state -> rm's positional b.txt is a change. cat has no positional and is not a script command; rm is a change command, not a run. Not walking the chained part loses b.txt."
  },
  {
    "id": "BV-83",
    "input": {"command": "cat <<'EOF' | python3 -\nprint(1)\nEOF\ncat <<EOF | grep x > out.txt && rm y.txt\nhi\nEOF\ncat <<EOF > s.sh && bash s.sh\necho\nEOF"},
    "expected": {
      "ok": true,
      "script": "cat <<'EOF' | python3 -\nprint(1)\nEOF\ncat <<EOF | grep x > out.txt && rm y.txt\nhi\nEOF\ncat <<EOF > s.sh && bash s.sh\necho\nEOF",
      "changes": ["out.txt", "y.txt", "s.sh"], "reads": [], "runs": ["python3", "bash"],
      "inline": ["inline python3 script, 1 lines — not analysed"], "unresolved": 0, "changeGroups": null
    },
    "note": "Rule 2.1/2.6: three heredoc statements, each verbatim, bodies of 1 line stay inline -> script = the command. Rule 5.5 (chained after a heredoc start): 1) '| python3 -' is the next element of cat's pipeline -> python3 is a run (rule 5.2; '-' is ignored as a path); rule 5.3: it is a script command after '|' of the heredoc command -> it gets the statement's heredoc 'print(1)\\n' (1 newline) -> one inline note, 1 line. 2) '| grep x > out.txt && rm y.txt' is (cat | grep x > out.txt) && rm y.txt: grep's pattern x is skipped, its '> out.txt' is a change, then rm y.txt is a change. 3) '&& bash s.sh': '> s.sh' is a change; bash -> run 'bash'; after '&&' the heredoc is not fed to bash and bash has no -c -> no inline note. 3 changes -> not grouped. Not walking the chained parts gives only s.sh, no runs, no inline note; feeding the heredoc to an '&&' operand gives a second note 'inline bash script, 1 lines'."
  },
  {
    "id": "BV-84",
    "input": {"command": "cd /w && cat <<EOF > a.txt || cd sub && rm b.txt\nhi\nEOF\ncat <<EOF |& cd x | tee c.txt && cd deep && rm d.txt\nhi\nEOF\nrm e.txt"},
    "expected": {
      "ok": true, "workDir": null,
      "changes": ["a.txt", "sub/b.txt", "sub/c.txt", "sub/deep/d.txt", "sub/deep/e.txt"], "reads": [], "runs": [], "unresolved": 0,
      "changeGroups": [{"dir": "./", "names": ["a.txt"]}, {"dir": "sub/", "names": ["b.txt", "c.txt"]}, {"dir": "sub/deep/", "names": ["d.txt", "e.txt"]}]
    },
    "note": "Rule 3.2: the first statement is a chain (here a heredoc statement), no lift -> workDir null. Rule 5.1: the grammar hangs the heredoc redirect on the list 'cd /w && cat', but it belongs to cat: 'cd /w' runs first -> directory /w, R = /w; then '> a.txt' -> /w/a.txt. Rule 5.5: '|| cd sub && rm b.txt' runs in the same state -> cd sets /w/sub, rm b.txt -> /w/sub/b.txt. Second statement: '|& cd x | tee c.txt && cd deep && rm d.txt' is (cat |& cd x | tee c.txt) && cd deep && rm d.txt: cd x is a pipeline element -> ignored; tee c.txt -> /w/sub/c.txt; after the pipeline, in the same state, cd deep -> /w/sub/deep and rm d.txt -> /w/sub/deep/d.txt. rm e.txt -> /w/sub/deep/e.txt (the directory holds into the next statement). Relative to R = /w -> a.txt, sub/b.txt, sub/c.txt, sub/deep/d.txt, sub/deep/e.txt; 5 changes > 3 -> grouped './', 'sub/', 'sub/deep/'. Not walking the chained parts loses b.txt, c.txt, d.txt and makes e.txt /w/e.txt -> 'e.txt'; applying 'cd x' gives sub/x/c.txt; walking the whole '&&' list after '|&' as one pipeline element ignores 'cd deep' -> sub/d.txt, sub/e.txt."
  },
  {
    "id": "BV-85",
    "input": {"command": "cd /w; cd sub && echo hi > a.txt; cd /v && cd /w/sub2 | cat > b.txt"},
    "expected": {
      "ok": true, "workDir": "/w",
      "script": "cd sub && echo hi > a.txt\ncd /v && cd /w/sub2 | cat > b.txt",
      "changes": ["sub/a.txt", "/v/b.txt"], "reads": [], "runs": [], "unresolved": 0
    },
    "note": "Rule 3.1: 'cd /w' lifted -> workDir /w, R = /w. Rule 2.8: both redirected statements fit -> one line each. Rule 5.1: the grammar hangs '> a.txt' on the list 'cd sub && echo hi', bash on echo only: 'cd sub' runs first -> /w/sub, then '> a.txt' -> /w/sub/a.txt -> 'sub/a.txt'. '> b.txt' belongs to cat, the last element of the pipeline after 'cd /v': cd /v runs first -> /v; 'cd /w/sub2' is a pipeline element -> ignored (rule 5.5); b.txt -> /v/b.txt; R = /w and /v share k = 1 segment (< 2) -> stays '/v/b.txt'. echo and cat -> nothing. Resolving the redirects before the whole list gives 'a.txt' and 'sub/b.txt'; applying 'cd /w/sub2' gives 'sub2/b.txt'."
  },
  {
    "id": "BV-86",
    "input": {"command": "for f in a; do cat <<EOF\nx\nEOF\ndone\n{ cat <<EOF\ny\nEOF\n}\necho \"$(cat <<EOF\nz\nEOF\n)\" && echo ok"},
    "expected": {
      "ok": true,
      "script": "for f in a; do cat <<EOF\nx\nEOF\ndone\n{ cat <<EOF\ny\nEOF\n}\necho \"$(cat <<EOF\nz\nEOF\n)\" && echo ok",
      "lineCount": 12, "rawLineCount": 12, "folded": [],
      "changes": [], "reads": [], "runs": [], "inline": [], "unresolved": 0
    },
    "note": "Rule 2.6: three top-level statements, each with a heredoc somewhere among its descendants: inside the for body, inside the { … } group, inside the $(…) of the && list's first operand. Each is copied verbatim as a whole -> script = command, 12 lines both (rule 1.3); 1-line bodies stay inline (rule 4.3). Checking only a direct heredoc of the statement would open the loop ('for f in a; do', '  cat <<EOF', …, 'done'), open the group ('{', '  cat <<EOF', …, '}') and break the list after '&&' (it has a newline, so it does not fit). Rule 5.2: cat (no positional) and echo -> nothing; $(…) is not entered (rule 5.5)."
  },
  {
    "id": "BV-87",
    "input": {"command": "{ node; } <<EOF\nx\nEOF\nwhile read l; do python3; done <<EOF\ny\nEOF\nfor f in a b; do perl; done <<EOF\nz\nEOF\n(ruby) <<EOF\nw\nEOF\nif true; then deno; fi <<EOF\nv\nEOF\nfor f in a b; do node -e 'x'; done\nbash <<EOF\nu\nEOF"},
    "expected": {
      "ok": true,
      "script": "{ node; } <<EOF\nx\nEOF\nwhile read l; do python3; done <<EOF\ny\nEOF\nfor f in a b; do perl; done <<EOF\nz\nEOF\n(ruby) <<EOF\nw\nEOF\nif true; then deno; fi <<EOF\nv\nEOF\nfor f in a b; do\n  node -e 'x'\ndone\nbash <<EOF\nu\nEOF",
      "changes": [], "reads": [], "runs": ["node", "python3", "perl", "ruby", "deno", "bash"],
      "inline": ["inline node script, 1 lines — not analysed", "inline bash script, 1 lines — not analysed"], "unresolved": 0
    },
    "note": "Rule 2.6: the five heredoc statements are verbatim; the for loop without a heredoc is opened (rule 2.3). Rule 5.3: the heredocs of the group, the while loop, the for loop, the subshell and the if are each the stdin of a compound statement -> no inner command gets a note from them, though node, python3, perl, ruby, deno are still runs (rule 5.2; read and true -> nothing). The second for loop is walked twice (a, b) but its 'node -e' is one script in the source -> one note, 1 line. 'bash <<EOF' is a simple command with the heredoc 'u\\n' (1 newline) -> one note. Runs deduplicated, in first-seen order. Passing the heredoc into compounds gives notes for node, python3, deno (and perl, ruby if loops and subshells also pass it); a note per loop walk gives two node notes."
  },
  {
    "id": "BV-88",
    "input": {"command": "npm run build:all-packages-in-the-monorepo |& tee build-output.log |& grep -i error\nfor  f  in   a.txt \\\n    b.txt; do cat \"$f\"; done"},
    "expected": {
      "ok": true,
      "script": "npm run build:all-packages-in-the-monorepo |&\n  tee build-output.log |&\n  grep -i error\nfor f in a.txt b.txt; do\n  cat \"$f\"\ndone",
      "changes": ["build-output.log"], "reads": ["a.txt", "b.txt"], "runs": ["npm run build:all-packages-in-the-monorepo"]
    },
    "note": "Rule 2.2: the |& pipeline is 42 + 4 + 20 + 4 + 13 = 83 characters > 80 -> broken after each '|&', operands 2-3 at IND. Rule 2.3: the for header is rebuilt from the tree: the extra spaces after 'for', 'f' and 'in' and the '\\'-newline between the words are dropped -> 'for f in a.txt b.txt; do'; body at IND, 'done'. Rule 5.2: tee -> change build-output.log; grep's only positional 'error' is the pattern; npm run -> label. Rule 5.4: cat walked with a.txt, b.txt -> reads. Without '|&' among the chain operators the pipeline is copied verbatim on one line; copying the header source keeps 'for  f  in   a.txt \\' and the continuation line."
  },
  {
    "id": "BV-89",
    "input": {"command": "rm w1; mkdir w2; touch w3; tee w4; chmod w5; rmdir w6; truncate w7; cat r1; head r2; tail r3; less r4; wc r5; cut r6; ls r7; stat r8; diff r9; sort r10; uniq r11; file r12; nl r13; tac r14; md5sum r15; sha256sum r16"},
    "expected": {
      "ok": true,
      "changes": ["w1", "w2", "w3", "w4", "w5", "w6", "w7"],
      "reads": ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15", "r16"],
      "runs": [], "unresolved": 0
    },
    "note": "Rule 5.2, the whole change table (rm mkdir touch tee chmod rmdir truncate: each positional a change, w1…w7) and the whole read table (cat … sha256sum, 16 commands: each positional a read, r1…r16), one command each, in order. An entry missing from either table makes that command a run with its file missing."
  },
  {
    "id": "BV-90",
    "input": {"command": "echo; printf x; true; false; sleep 1; break; continue; exit; set; test; seq 3; read; return; shift; wait; :; npm ci; npx tsc; pnpm i; yarn add; git diff; docker ps; bunx vite; gh pr; dotnet build; mvn test; gradle build; cargo test; go vet"},
    "expected": {
      "ok": true, "changes": [], "reads": [],
      "runs": ["npm ci", "npx tsc", "pnpm i", "yarn add", "git diff", "docker ps", "bunx vite", "gh pr", "dotnet build", "mvn test", "gradle build", "cargo test", "go vet"],
      "unresolved": 0
    },
    "note": "Rule 5.2, the whole nothing table (echo printf true false sleep break continue exit set test seq read return shift wait :, 16 commands) -> no run, no file. The whole subcommand table (npm npx pnpm yarn git docker bunx gh dotnet mvn gradle cargo go, 13 tools), each with a literal first argument not starting with '-' -> '<tool> <arg>', in order. A nothing-table entry missing adds its bare name as a run; a subcommand-tool entry missing gives the bare tool name."
  },
  {
    "id": "BV-91",
    "input": {"command": "python -c x; python3 -c x; node -e x; bun -e x; deno -e x; bash -c x; sh -c x; zsh -c x; pwsh -c x; powershell -c x; ruby -e x; perl -e x; psql -c x; sqlite3 -c x; tsx -e x; ts-node -e x"},
    "expected": {
      "ok": true,
      "runs": ["python", "python3", "node", "bun", "deno", "bash", "sh", "zsh", "pwsh", "powershell", "ruby", "perl", "psql", "sqlite3", "tsx", "ts-node"],
      "inline": ["inline python script, 1 lines — not analysed", "inline python3 script, 1 lines — not analysed", "inline node script, 1 lines — not analysed", "inline bun script, 1 lines — not analysed", "inline deno script, 1 lines — not analysed", "inline bash script, 1 lines — not analysed", "inline sh script, 1 lines — not analysed", "inline zsh script, 1 lines — not analysed", "inline pwsh script, 1 lines — not analysed", "inline powershell script, 1 lines — not analysed", "inline ruby script, 1 lines — not analysed", "inline perl script, 1 lines — not analysed", "inline psql script, 1 lines — not analysed", "inline sqlite3 script, 1 lines — not analysed", "inline tsx script, 1 lines — not analysed", "inline ts-node script, 1 lines — not analysed"],
      "unresolved": 0
    },
    "note": "Rule 5.3, the whole script table (16 commands), each with -c or -e and the 1-line literal argument x -> one note each, 1 line, in order. Rule 5.2: none is in another table; bun's first argument is '-e', not 'run', and bun is not a subcommand tool -> bare names. An entry missing from the script table drops its note."
  },
  {
    "id": "BV-92",
    "input": {"command": "sed -n 10,40p docs/kb/a.md; grep -n okf docs/kb/b.md; ls docs/kb"},
    "expected": {
      "ok": true, "changes": [], "reads": ["docs/kb/a.md", "docs/kb/b.md", "docs/kb"], "runs": [],
      "readAccess": [{"path": "docs/kb/a.md", "kind": "read"}, {"path": "docs/kb/b.md", "kind": "grep"}, {"path": "docs/kb", "kind": "list"}]
    },
    "note": "Rule 5.2: sed's first positional 10,40p is the script, a.md a read; grep skips the pattern okf; ls reads its positional. Rule 5.9: kinds by base name -> sed read, grep grep, ls list, in reads order."
  },
  {
    "id": "BV-93",
    "input": {"command": "grep -rn TODO docs/kb src && cat docs/kb/a.md"},
    "expected": {
      "ok": true, "reads": ["docs/kb", "src", "docs/kb/a.md"],
      "readAccess": [{"path": "docs/kb", "kind": "grep"}, {"path": "src", "kind": "grep"}, {"path": "docs/kb/a.md", "kind": "read"}]
    },
    "note": "Rule 5.2: grep -rn: flags skipped, TODO is the pattern, both folders are reads. Rule 5.9: grep -> grep for both, cat -> read. The folder/file decision is the server's (okf-access-extraction rule 4), not this rule's."
  },
  {
    "id": "BV-94",
    "input": {"command": "grep -c x < list.txt; cat a.md; grep x a.md"},
    "expected": {
      "ok": true, "reads": ["list.txt", "a.md"],
      "readAccess": [{"path": "list.txt", "kind": "read"}, {"path": "a.md", "kind": "read"}]
    },
    "note": "Rule 5.1: '< list.txt' is a read through a redirect -> kind read, although the command is grep (grep itself has no path after its pattern). Rule 5.6/5.9: a.md is listed once; its first reader is cat -> read; the later grep does not change it."
  },
  {
    "id": "BV-95",
    "input": {"command": "cd /work/acme-app/docs/kb && cat index.md && ls . && cat a.md > a.md"},
    "expected": {
      "ok": true, "workDir": null, "changes": ["a.md"], "reads": ["index.md", "."],
      "readAccess": [{"path": "index.md", "kind": "read"}, {"path": ".", "kind": "list"}]
    },
    "note": "Rule 3.2: cd ... && is not lifted (view workDir null), but rule 5.5 makes /work/acme-app/docs/kb the analysis root R. ls . reads R itself -> '.', kind list. Rule 5.1: '> a.md' is a change, so the cat read of a.md is listed only under changes (rule 5.6) and has no readAccess entry."
  },
  {
    "id": "BV-96",
    "input": {"command": "find docs -name '*.md'; tree docs; egrep x docs/a.md"},
    "expected": {"ok": true, "changes": [], "reads": [], "runs": ["find", "tree", "egrep"], "readAccess": []},
    "note": "Rule 5.2: find, tree and egrep are in no read table, so they are runs and read nothing; rule 5.9's list/grep names for them never apply -> readAccess empty."
  },
  {
    "id": "BH-01",
    "input": {"command": "for f in *.ts; do echo \"$f\"; done", "highlight": true},
    "expected": {"highlights": [["keyword", "for"], ["variable", "f"], ["keyword", "in"], ["keyword", "do"], ["command", "echo"], ["string", "\""], ["keyword", "$"], ["variable", "f"], ["string", "\""], ["keyword", "done"]]},
    "note": "Rule 7.2: for/in/do/done are @keyword; the loop variable and the f of $f are variable_name -> @property -> variable; echo is the command_name -> command; the string \"$f\" is @string, but its inner $ (@operator -> keyword) and f (variable) are smaller nodes and win (rule 7.3), leaving the two quotes as string. *.ts is a plain word."
  },
  {
    "id": "BH-02",
    "input": {"command": "rm -rf dist > out.log 2>&1", "highlight": true},
    "expected": {"highlights": [["command", "rm"], ["flag", "-rf"], ["keyword", ">"], ["redirect", " out.log"], ["redirect", "2>&1"]]},
    "note": "Rule 7.2: rm -> command; -rf starts with '-' -> @constant -> flag; dist is plain. The file_redirect '> out.log' is @redirect, and its '>' is @operator, a smaller node -> keyword, leaving ' out.log' as redirect. '2>&1' is another file_redirect -> redirect ('>&' is not an @operator; its 2 is @number, also redirect). The space between the two redirects is plain, so they are two segments."
  },
  {
    "id": "BH-03",
    "input": {"command": "X=1 node -e 'x' # note", "highlight": true},
    "expected": {"highlights": [["variable", "X"], ["command", "node"], ["flag", "-e"], ["string", "'x'"], ["comment", "# note"]]},
    "note": "Rule 7.2: X is a variable_name -> variable ('=1' is plain); node -> command; -e -> flag; 'x' is a raw_string -> string; '# note' -> comment."
  },
  {
    "id": "BH-04",
    "input": {"command": "rm $f ${f} || ls", "highlight": true},
    "expected": {"highlights": [["command", "rm"], ["keyword", "$"], ["variable", "f"], ["variable", "${f}"], ["command", "ls"]]},
    "note": "Rule 7.2: $f is a simple_expansion (not captured): its '$' token is @operator -> keyword, f is variable_name -> variable. ${f} is an expansion -> @embedded -> variable over all 4 characters ('${' is not an @operator; the inner f is variable too). The space between them is plain, so two segments. '||' is not an @operator -> plain. rm and ls -> command."
  },
  {
    "id": "BH-05",
    "input": {"command": "echo \"${HOME}\" $(pwd)", "highlight": true},
    "expected": {"highlights": [["command", "echo"], ["string", "\""], ["variable", "${HOME}"], ["string", "\""], ["variable", "$("], ["command", "pwd"], ["variable", ")"]]},
    "note": "Rule 7.2/7.3: the string \"${HOME}\" is @string, the smaller expansion ${HOME} inside is @embedded -> variable (HOME variable too), leaving the quotes as string. $(pwd) is a command_substitution -> @embedded -> variable; the inner command_name pwd is smaller -> command, leaving '$(' and ')' as variable."
  },
  {
    "id": "BH-06",
    "input": {"command": "", "highlight": true},
    "expected": {"highlights": []},
    "note": "Rule 1.2: an empty command has no segments."
  },
  {
    "id": "BH-07",
    "input": {"command": "cat 3<<EOF\nx\nEOF", "highlight": true},
    "expected": {"highlights": [["command", "cat"], ["redirect", "3"], ["string", "EOF"], ["string", "x\n"]]},
    "note": "Rule 7.2: cat -> command. The heredoc redirect is not a file_redirect, so only its file_descriptor 3 is coloured: @number -> redirect. '<<' is not an @operator -> plain. The heredoc_start EOF and the heredoc_body 'x\\n' are @string; the newline between them and the closing EOF (heredoc_end) are plain, so two string segments."
  },
  {
    "id": "BH-08",
    "input": {"command": "\"cat\" x", "highlight": true},
    "expected": {"highlights": [["string", "\"cat\""]]},
    "note": "Rule 7.3: the command_name (@function) and the string inside it (@string) cover the same 5 characters; the parent is listed first, the stable sort keeps that order, so the string is painted last and wins. x is plain. Reversing equal-size captures would give command."
  }
]
```

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
