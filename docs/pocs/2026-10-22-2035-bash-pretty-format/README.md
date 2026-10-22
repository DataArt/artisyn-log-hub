# PoC — readable Bash tool commands

Task: [2026-10-22-context-growth-item-modal](../../tasks/todo/2026-10-22-context-growth-item-modal/requirements.md)
(the same view is reused in the session Logs tab's tool details).

## Question

Claude Code's Bash tool commands are long one-liners (`cd <abs>; a; b; for …; done; … | tail`) with
heredocs and inline `python -` / `node -e` scripts. Can we render them as an indented script plus a
"which files did this touch" summary — driven **only by the bash syntax**, so it does not depend on
how a particular model happens to lay out its commands — and does it hold up on real data?

## How to run

```sh
npm install
node format.mjs [out.md]       # 10 samples (samples.json) → before/after markdown
node verify.mjs [corpus.json]  # robustness run over a corpus (JSON array of command strings)
```

`samples.json` (10 commands of one session) and `corpus.json` (880 distinct Bash commands from all
sessions in the maintainer's local Log Hub) are gitignored — real commands with local paths — as is
every generated examples file. To rerun elsewhere, put any JSON array of commands (or
`[{ id, command }]` for `samples.json`) in their place. Nothing is ever executed — commands are only
parsed.

## Approach (`bash-view.mjs`)

Parser: `web-tree-sitter` + `tree-sitter-bash` (full syntax tree; MIT; ~210 KB + ~1.36 MB WASM, to be
lazy-loaded in the client).

1. **Format** — output = the original token sequence; only whitespace changes, and only where the
   grammar allows a newline:
   - between statements (`;` / newline → newline; `&` kept);
   - after `&&` `||` `|` `|&` of a `list` / `pipeline`, when the one-line form exceeds 80 columns
     (continuation indented, operator at the end of the line — no backslashes needed);
   - `for … in …; do` / `while …; do` / `if …; then` bodies, `{ … }`, `( … )` indented; a long
     `for` word list one word per line with `\`;
   - every other node (commands, strings, `$(…)`, `case`, functions, heredocs and anything on
     their lines) is copied verbatim; multi-line verbatim text is never re-indented.
   - parse error → the command is shown unchanged.
2. **Touched files** (`analyze`) — from syntax-tree nodes only:
   - redirections (`file_redirect`): `>` `>>` `&>` → changes, `<` → reads;
   - `command` nodes: name + literal arguments against a small command table — `cat`/`head`/
     `tail`/`ls`/`wc`/`sed -n`/`grep` → reads; `sed -i`/`rm`/`mv`/`cp` dest/`mkdir`/`touch`/`tee`
     → changes; everything else → **Runs** (`npm run x`, `git x`, `docker x`, …);
   - literal `VAR=…` assignments and `for x in <literal words>` values are substituted; `cd` is
     tracked (not inside pipelines; subshells get a copy); arguments that are not literal are
     skipped (counted as unresolved);
   - `python`/`node`/`bash -c`/… inline scripts and heredocs are reported as "inline script, N
     lines — not analysed": nothing is guessed from non-bash code.
3. **Presentation** (`format.mjs`) — leading `cd <literal>` lifted into a header; heredoc bodies
   over 8 lines folded into collapsible blocks; file lists over 3 entries grouped by directory.

## Result

Output for the 10 samples:
[bash-format-examples.md](../../tasks/todo/2026-10-22-context-growth-item-modal/bash-format-examples.md).

`node verify.mjs` over **880 real commands** (63 under 100 chars … 37 over 3000 chars):

| Check | Result |
|---|---|
| exceptions | 0 |
| not parseable (fallback to raw) | 0 |
| formatted output parses | 880 / 880 |
| same token sequence as the input (tree-sitter) | 880 / 880 |
| independent oracle — `shfmt --minify` of input and output equal (layout-normalized) | 880 / 880 |
| every reported path occurs in the input (directly or as loop/variable pieces) | 880 / 880 |
| idempotent `format(format(x)) === format(x)` | 873 / 880 — the 7 others are still the same program; tree-sitter-bash mis-reads *our* multi-line output (e.g. a newline after `cut -d= -f1`), never the input. Not relevant in the product (each command is formatted once, from the original). |
| time | 0.14 ms avg, 7 ms max per command (Node, after WASM init) |

798 of 880 commands change layout (7 406 → 10 511 lines); 611 get a non-empty file summary. Lines
over 120 chars remain where a single command is long by itself (verbatim by design) — the UI
soft-wraps them.

Known limits (by design, "small steps"): commands inside `$(…)`, `bash -c '…'`, `docker exec … sh -c`
and inline scripts are not analysed or re-formatted; `case` and functions are verbatim.

`@wasm-fmt/shfmt` is only a dev dependency of `verify.mjs` (the independent oracle), not part of the
proposed implementation.
