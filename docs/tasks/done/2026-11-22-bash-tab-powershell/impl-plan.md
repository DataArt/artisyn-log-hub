# Implementation plan: Shell tab — PowerShell calls next to Bash, fully formatted

## TL;DR

- **New shared modules in `packages/bash-view/src/`** (package name unchanged): `ps-mask.ts`, `ps-split.ts`,
  `ps-parse.ts`, `ps-format.ts`, `ps-analyze.ts`, `ps-highlight.ts`, `ps-wrap.ts`, `ps-view.ts`, `shell.ts` —
  `buildPowerShellView`, `analyzePowerShell`, `highlightPowerShell`, `stripLhWrap`, `buildShellView`,
  `analyzeShellCommand`. Grammar gaps of `tree-sitter-powershell` are closed by same-length masks + a
  `;`-split fallback (PoC: 0 raw fallbacks on 1 060 real commands, proven same program by PowerShell
  5.1 and 7 parsers).
- **New dependency:** `tree-sitter-powershell` 0.26.6 (MIT, WASM 1.1 MB + `highlights.scm`) in `client/` and
  `server/`, installed like `tree-sitter-bash` (only `.wasm` / `.scm` used); shipped by `scripts/copy-wasm.js`
  and the Dockerfile; client loads it lazily, only when a PowerShell call is shown.
- **Bash side also changes (parity):** `BashAnalysis` / `BashFiles` gain `deleted: string[]` (rendered as
  "(deleted)"); `highlightBash` is refactored onto a shared `highlightWith(…, kindMap)`.
- **Server:** new `server-powershell-parser.ts`, `server-wasm-runtime.ts` (shared `Parser.init`, also used by
  `server-bash-parser.ts`) + `getServerShellParsers()`; new exports `shellInvocationsOf` / `countShellInvocations`
  in `claude-extractor.ts`; OKF extraction and facts take
  `ShellParsers` instead of one `BashParser`; commit / PR counters count PowerShell calls with a
  PowerShell-aware anchor (server and client twin); `PowerShell` joins `BUILTIN_TOOL_NAMES`.
- **Backfill (FR-15), no migration:** `OKF_EXTRACT_VERSION` 4 → 5 and a new background
  `ShellFiguresBackfillService` that re-extracts commit / PR counts and OKF rows only for session nodes
  with PowerShell calls (`session_tool_stats.tool_name = 'PowerShell'`).
- **Client UI:** tab label `Shell` (id `bash`, URL `bashCall` unchanged), new URL param `shell`
  (`bash` | `powershell`), shell filter + `bash` / `pwsh` badges on mixed sessions, `ToolCallView`
  `forceFallback` branch removed.
- **DB changes:** none. **API changes:** none (no route, hook or payload change).

## Reference

- Requirements: [requirements.md](requirements.md)
- PoC (all numbers below): [docs/pocs/2026-11-22-1443-powershell-format/](../../../pocs/2026-11-22-1443-powershell-format/README.md)
  — its `ps-format.mjs`, `ps-mask.mjs`, `ps-split.mjs`, `ps-analyze.mjs`, `wrap-prefix.mjs` are the reference
  implementations to port to TypeScript.
- Research archive: [research/findings-1.md](research/findings-1.md)

## Design Decisions

### Package and seams

- **DD-1 Package.** All PowerShell rules live in `@loghub/bash-view` next to the Bash ones (name kept to avoid
  churn in every import; README/KB say "Bash and PowerShell"). PowerShell modules never import
  `web-tree-sitter` and reuse the structural `BashParser` / `BashSyntaxNode` interface (`syntax.ts`), which is
  grammar-agnostic. Add aliases `export type ShellParser = BashParser; export type ShellSyntaxNode = BashSyntaxNode;`
  in `syntax.ts`; existing names are not renamed.
- **DD-2 Exported API of the new modules** (later chunks build against exactly this):

  | Module | Export | Signature / shape |
  |---|---|---|
  | `shell.ts` | `ShellKind` | `'bash' \| 'powershell'` |
  | `shell.ts` | `shellOfTool` | `(toolName: string) => ShellKind \| null` — `'Bash'`→`bash`, `'PowerShell'`→`powershell` |
  | `shell.ts` | `ShellParsers` | `{ bash: BashParser \| null; powershell: BashParser \| null }` |
  | `shell.ts` | `buildShellView` | `(shell, parser, command, root) => BashView` — dispatches to `buildBashView` / `buildPowerShellView` |
  | `shell.ts` | `analyzeShellCommand` | `(parsers: ShellParsers, toolName: string, command: string) => BashAnalysis \| null` — null when not a shell tool, its parser is null, the command is blank, or analysis throws |
  | `ps-parse.ts` | `withPsTree` | `<T>(parser, src, fn: (root: BashSyntaxNode, src: string) => T) => T` — DD-4 two-pass parse |
  | `ps-parse.ts` | `textOf` | `(src: string, n: BashSyntaxNode) => string` = `src.slice(n.startIndex, n.endIndex)` |
  | `ps-mask.ts` | `maskForParse`, `PS_MASKS` | `(src) => { text: string; used: string[] }`, `text.length === src.length` |
  | `ps-split.ts` | `topLevelSemicolons` | `(src) => number[]` |
  | `ps-format.ts` | `formatPowerShell` | `(parser, src) => { ok: boolean; partial: boolean; script: string }` |
  | `ps-format.ts` | `liftPowerShellCd` | `(parser, src, script) => LiftedCd` (type from `bash-format.ts`) |
  | `ps-format.ts` | `foldHereStrings`, `HERE_STRING_INLINE_MAX` (= 8) | `(parser, src, script) => FoldedScript` (type from `bash-format.ts`) |
  | `ps-analyze.ts` | `analyzePowerShell`, `PS_CMDLETS`, `PS_ALIASES`, `PS_NOT_RUNS` | `(parser, src) => BashAnalysis`; tables per DD-12 / DD-13 |
  | `ps-wrap.ts` | `stripLhWrap` | `(parser, command) => string` — the typed command, or `command` unchanged |
  | `ps-highlight.ts` | `powershellHighlightQuery`, `PS_CAPTURE_KIND`, `highlightPowerShell` | `(scm) => string`; `Record<string, HighlightKind>`; `(parser, text, query) => HighlightSegment[]` |
  | `ps-view.ts` | `buildPowerShellView` | `(parser, command, root) => BashView` |
  | `bash-highlight.ts` | `highlightWith` | `(parser, text, query, kindMap) => HighlightSegment[]`; `highlightBash` = `highlightWith(…, CAPTURE_KIND)` |
  | `bash-format.ts` | `WIDTH`, `IND` | now exported (80, two spaces), reused by `ps-format.ts` |
- **DD-3 `deleted`.** `BashAnalysis` and `BashFiles` gain `deleted: string[]` — paths of `changes` that the
  command removed: Bash `rm` / `rmdir` positionals, PowerShell `Remove-Item` and its aliases. `changes` still
  contains them, so "changes N" is unchanged. The FILES block renders a deleted path as `<path> (deleted)`.

### Parsing (PoC §1)

- **DD-4 Two-pass parse with same-length masks.** `withPsTree`: parse `src`; if the root has no error use it.
  Else parse `maskForParse(src).text`; use that tree if it has no error, else the plain tree. Every PowerShell
  module reads node text only through `textOf(src, node)` (never `node.text`), so masks never reach output.
  Masks (applied in this order, each replacement the same length, `PS_MASKS` in `ps-mask.ts`):

  | id | regex (JS, `g`) | replacement |
  |---|---|---|
  | `num-multiplier` | `(?<=\d)(?:KB\|MB\|GB\|TB\|PB)\b` (flag `i`) | zeros of the same length |
  | `at-word` | `(?<=[\s,(])@(?=[\w.-]+[/@])` | `_` |
  | `var-path` | `(?<=[\s,(=])\$(?=[\w:]+[\\/][^\s;\|)]*)` | `_` |
  | `caret-brace` | `\^\{(\w*)\}` | `^_` + group + `_` |
  | `comma-dot` | `(?<=,\s*)\.(?=\w)` | `_` |
  | `null-coalesce` | `\?\?(?==?)` | `-f` |
  | `null-cond` | `(?<=[\w}])\?(?=[.[])` | `_` |
  | `hash-comma` | `(?<=\})(\s*),` | group + space |
  | `bs-quote` | `\\"` | `` `" `` |
  | `ternary` | ` \? ([^;\n?]*?) : ` | `' + ' + group + ' + '` |

- **DD-5 Highlighting with masks.** `highlightPowerShell` parses `text` once; if it has an error and the masked
  text parses clean, it calls `parser.highlight(maskedText, query)` (offsets identical), else
  `parser.highlight(text, query)`; then `highlightWith(…, PS_CAPTURE_KIND)`.
- **DD-6 Capture map (FR-8)** `PS_CAPTURE_KIND`: `keyword`, `operator` → keyword; `string` → string;
  `variable` → variable; `function` → command; `comment` → comment; `flag` → flag; `redirect` → redirect;
  everything else (`number`, `property`, `type`, `delimiter`, `array`, `assignvalue`) plain.
  `powershellHighlightQuery(scm)` = `scm + '\n(command_parameter) @flag\n(redirection) @redirect\n((generic_token) @redirect (#match? @redirect "^[0-9*]?>"))\n'`
  (the last capture colours unspaced `2>$null`, which the grammar gives as a `generic_token`).

### Layout (PoC §2)

- **DD-7 Format rules** (`formatPowerShell`, port of PoC `ps-format.mjs`): output = original tokens, only
  whitespace changes; a newline only (a) between statements of a statement list where the source had `;` or a
  newline (`empty_statement` nodes dropped), (b) after `{` / before `}` of a `{ BODY }` whose BODY is
  `statement_list` / `script_block` / `script_block_body` holding only a statement list, (c) after `|`, `&&`,
  `||` of a pipeline (`pipeline` / `pipeline_chain`, `pipeline_chain_tail`) that does not fit `WIDTH`,
  continuation indented by `IND`. A node that fits `WIDTH` at its column is copied; string nodes
  (`string_literal`, `expandable_string_literal`, `expandable_here_string_literal`,
  `verbatim_string_characters`, `verbatim_here_string_characters`) and nodes with an error are always copied;
  `statement_block`, `else_clause`, `elseif_clause(s)`, `catch_clause(s)`, `finally_clause` reached while
  expanding are expanded even when they fit; text before the first and after the last child of a node is
  copied.
- **DD-8 Fallback ladder.** Whole (masked) tree clean → `{ ok: true, partial: false }`. Else cut at
  `topLevelSemicolons(src)` (PowerShell lexing: `'…'` with `''`, `"…"` with backtick / `""` escapes and nested
  `$( … )` code, here-strings, `#` / `<# #>` comments, backtick escapes, `()` `{}` `[]` depth); format each
  trimmed piece alone, copy a piece that still has an error verbatim, join with `\n` → `{ ok: true, partial:
  true }`; no `;` or no piece parses → `{ ok: false, script: src }`. `buildPowerShellView` treats `partial` as
  `ok`. `analyzePowerShell` applies the same ladder itself: on a partial command it walks the clean pieces in
  source order with **one shared state** (cwd, variable env, first `workDir`), so a `Set-Location` in one piece
  applies to relative paths of later pieces and the first one is `workDir`; each piece that still has an error
  adds 1 to `unresolved` and contributes nothing else.
- **DD-9 Working dir (FR-7).** `liftPowerShellCd`: first statement is a single command named (case-insensitive)
  `set-location`, `cd`, `sl`, `chdir`, `push-location` or `pushd` with one literal argument, or `-Path` /
  `-LiteralPath` + one literal; the first formatted line must equal the statement text; `-` / `+` are not lifted.
- **DD-10 Here-strings (FR-6).** `foldHereStrings` folds bodies of `verbatim_here_string_characters` /
  `expandable_here_string_literal` with more than `HERE_STRING_INLINE_MAX` = 8 lines: opener line kept,
  body replaced by `# ▼ block <n>: <lines> lines, shown below`, closer line kept; `FoldedHeredoc` entries
  as in Bash.
- **DD-11 Wrapper prefix (FR-6a).** Real stored commands never carry it (0 of 1 301 calls; the transcript
  keeps the typed command) — kept as a defensive rule. `stripLhWrap`: only when `command` starts with
  `function __lhWrap`; drop leading statements that are a `function_statement` named `__lhWrap` or an
  `if_statement` whose text matches `^if\s*\(\s*Get-Command\s+-Name\s+'[^']+'\s+-CommandType\s+Application\b`
  and contains `Set-Item\s+-LiteralPath\s+'function:`; return the rest without a leading `;` and spaces.
  Works for the current hook and the 2.28.0 shape (PoC `wrap-prefix.mjs`). `buildPowerShellView` strips
  first; Formatted, preview and FILES use the stripped text; Raw shows the stored text; "Copy original"
  copies the stripped text.

### FILES analysis (PoC §3, FR-9)

- **DD-12 Cmdlet table** `PS_CMDLETS` (canonical name → `pos` positional order, `read` / `write` / `del` path
  parameters, read `kind`, value parameters, switch parameters), port of PoC `ps-analyze.mjs` `CMDLETS`:

  | Cmdlet | positional | paths | kind |
  |---|---|---|---|
  | Get-Content | Path | read Path, LiteralPath | read |
  | Select-String | Pattern, Path | read Path, LiteralPath | grep (`pattern` = Pattern literal) |
  | Get-ChildItem | Path, Filter | read Path, LiteralPath | list |
  | Get-Item, Test-Path | Path | read Path, LiteralPath | list |
  | Get-FileHash | Path | read Path, LiteralPath | read |
  | Set-Content, Add-Content | Path, Value | write Path, LiteralPath | — |
  | Clear-Content | Path | write Path, LiteralPath | — |
  | Out-File | FilePath, Encoding | write FilePath, LiteralPath | — |
  | Tee-Object | FilePath | write FilePath, LiteralPath | — |
  | New-Item | Path | write Path | — |
  | Remove-Item | Path | write + deleted Path, LiteralPath | — |
  | Copy-Item | Path, Destination | read Path, LiteralPath; write Destination | read |
  | Move-Item | Path, Destination | write Path, LiteralPath, Destination | — |
  | Rename-Item | Path, NewName | write Path and `dirname(Path)/NewName` | — |
  | Expand-Archive | Path, DestinationPath | read Path, LiteralPath; write DestinationPath | read |
  | Invoke-WebRequest | Uri | write OutFile; also a run label `Invoke-WebRequest` | — |

  `PS_ALIASES`: `gc cat type`→Get-Content; `sls`→Select-String; `gci ls dir`→Get-ChildItem; `gi`→Get-Item;
  `sc`→Set-Content; `ac`→Add-Content; `clc`→Clear-Content; `tee`→Tee-Object; `ni mkdir md`→New-Item;
  `ri rm del erase rd rmdir`→Remove-Item; `cpi cp copy`→Copy-Item; `mi mv move`→Move-Item; `rni ren`→Rename-Item;
  `iwr invoke-restmethod irm curl wget`→Invoke-WebRequest. The per-cmdlet `values` / `switches` parameter lists
  are normative as written in `docs/pocs/2026-11-22-1443-powershell-format/ps-analyze.mjs`, constant `CMDLETS`
  (copy them verbatim, plus `Get-FileHash` / `Expand-Archive` / `Invoke-WebRequest` entries already there);
  read ranges for the OKF section rule: `Get-Content -TotalCount N` / `-Head N` / `-First N` → `range
  { from: 1, to: N }`, `-Tail N` / `-Last N` → `range { from: -N, to: null }` (Bash `head` / `tail` semantics);
  a piped `Select-Object -First` gives no range; common value parameters `ErrorAction WarningAction InformationAction ErrorVariable WarningVariable
  InformationVariable OutVariable OutBuffer PipelineVariable Credential`; `WhatIf Confirm Verbose Debug Force`
  are switches, `-Confirm:$false` consumes its `:value`.
- **DD-13 Analysis rules.** Names and parameters case-insensitive; a name with `.exe` / `.cmd` / `.bat` /
  `.ps1` suffix or a path is reduced to its base name; an abbreviated parameter resolves when it is a unique
  prefix among the cmdlet's parameters, else it is ignored; elements joined by anonymous `,` tokens form one
  array argument; argument nodes are unwrapped through single-child `*_expression` / `pipeline` /
  `pipeline_chain` chains; literal values: `generic_token` (not starting with `@`), `'…'` (`''` → `'`),
  `"…"` without `$` / backtick after substitution, integers; `$name` / `${name}` substituted from literal
  top-level assignments `$name = <literal>` (an `assignment_expression`; a non-literal assignment forgets the
  name); anything else → `unresolved`. Redirects: `redirection` nodes with `>` / `>>` (not `2>&1`-style merges)
  and `generic_token`s matching `^([0-9*]?>>?)(&[12])?(.*)$` write their target. Never a file: `$null`, and
  targets starting with `Env:` `HKLM:` `HKCU:` `Variable:` `Function:` `Alias:` `Cert:` `WSMan:` (case-
  insensitive). `Set-Location` family (DD-9 names) not inside a pipeline sets the cwd for later relative
  paths and the first one is `workDir`; a pipeline does not carry cwd changes out. Commands inside script
  blocks are analysed. Non-cmdlet names go to the Bash rules for natives (DD-14); names in `PS_NOT_RUNS`
  (`write-host write-output echo write-verbose write-warning write-error start-sleep sleep get-date out-null
  out-string out-host select-object select where-object where ? foreach-object foreach % sort-object sort
  group-object measure-object format-table ft format-list fl format-wide convertto-json convertfrom-json
  join-path split-path resolve-path get-location pwd pop-location popd new-object get-command gcm exit return
  throw`) produce nothing.
- **DD-14 Natives reuse the Bash tables.** Extract from `analyzeTree`'s `command` closure in
  `bash-analyze.ts` a node-free function `analyzeWords(base: string, args: (string | null)[], sink: WordSink)`
  covering `W_CMDS`, `R_CMDS`, grep / `git grep`, `sed`, `mv`, `cp`, run labels (`SUBCOMMAND_TOOLS`,
  `RUN_SCRIPT_TOOLS`, `NOT_RUNS`) and inline-script notes (`SCRIPT_CMDS`); `WordSink` = `{ read(p, kind?, meta?),
  write(p), del(p), run(label), script(command, lines) }`. Bash keeps identical behaviour (its rows must stay
  green); `analyzePowerShell` calls it for a non-cmdlet name with literal args (so `git status`, `npm run build`,
  `grep -n x f` work as in Bash). In a PowerShell call the Unix-like aliases (`rm cat ls cp mv`) are read by
  `PS_CMDLETS`, never by the Bash tables.

### Counters, OKF, backfill

- **DD-15 Commit / PR anchor (FR-12).** Server `tool-stats.ts` and client `session-usage-derive.ts`:
  `countCommits(command: string, shell: ShellKind = 'bash')`, `countPullRequests(command, shell = 'bash')`.
  For `powershell` the anchor is `(?:^|[\n;&|{(])\s*(?:&\s*)?['"]?` and the tool word allows `(?:\.exe)?['"]?`
  (`git`, `gh`); Bash keeps today's anchor, so Bash figures do not change. Callers count when
  `shellOfTool(name) !== null`, passing that shell. PoC: today's regex = tree on real data (10 = 10);
  the PowerShell anchor adds `{ git commit }`, `(git commit)`, `git.exe commit`, `& "git.exe" commit`.
- **DD-16 OKF with two parsers (FR-13).** `extractOkfDetail`, `extractOkfAccess`, `collectNodeFileFacts`
  and `accessesOfCall` take `parsers: ShellParsers` instead of `parser: BashParser | null`; their
  `case 'Bash'` becomes `case 'Bash': case 'PowerShell':` using `analyzeShellCommand(parsers, name, command)`
  (null → no accesses). A null PowerShell parser skips PowerShell calls only.
- **DD-17 Server parsers.** `server-powershell-parser.ts` mirrors `server-bash-parser.ts` (WASM
  `tree-sitter-powershell.wasm`, bundled `dist/wasm/` first, then `require.resolve`, grammar as bytes,
  cached `null` + one warning on failure). `Parser.init` is shared: move it into `server-wasm-runtime.ts`
  (`initTreeSitterRuntime(): Promise<void>`, cached) used by both. `getServerShellParsers(): Promise<ShellParsers>`
  in `server-shell-parsers.ts` — `Promise.all` of the two cached getters, itself cached per process.
- **DD-18 CLI recognition keeps its tokenizer for PowerShell** (`cli-command-recognition.ts`): it already
  recognises CLI tools in PowerShell commands (same figures for both shells); switching it to the grammar
  would change a documented algorithm without a functional gain. The stated reason goes into
  `cli-command-recognition.md`. `tool-usage-writer.ts` keeps passing only the Bash parser.
- **DD-19 Backfill (FR-15).** `OKF_EXTRACT_VERSION` = 5 (comment: "5: PowerShell calls — commit / PR counts
  and OKF accesses; v4 rows of a node without PowerShell calls equal v5 output, so only PowerShell nodes are
  re-extracted"). The documented reading of the marker changes accordingly, in the `okf-constants.ts` comment
  and the `okfExtractVersion` TS comment in `server/src/database/schema/index.ts` (~line 180; no DB `COMMENT`
  exists, so no migration): "NULL = no OKF analysis yet; a non-null version below the current one = rows of an
  older extractor, re-extracted only where that version's change applies". Constants in `okf-constants.ts`
  (not env-overridable): `SHELL_FIGURES_BACKFILL_INTERVAL_MS = 15_000` (same cadence as the tool-usage
  drain), `SHELL_FIGURES_BACKFILL_BATCH = 20`, `SHELL_FIGURES_BACKFILL_TICK = 'shell-figures-backfill-tick'`
  (the `SchedulerRegistry` interval name). New `ShellFiguresBackfillService`
  (`server/src/logs/okf/shell-figures-backfill.service.ts`, registered next to `ToolUsageRebuildService`):
  a pass on module init and then every `SHELL_FIGURES_BACKFILL_INTERVAL_MS` for the process lifetime (a pass
  that finds nothing costs one query over `sessions`), interval cleared on module destroy. Each pass runs in
  **one transaction**, so a crash mid-pass rolls the claim back: `SELECT s.id FROM sessions s WHERE NOT
  s.deleted AND COALESCE(s.okf_extract_version, 0) < 5 AND EXISTS (SELECT 1 FROM session_tool_stats t WHERE
  t.session_id = s.id AND t.tool_name = 'PowerShell') LIMIT 20 FOR UPDATE OF s SKIP LOCKED`, process the
  nodes (below), then `UPDATE sessions SET okf_extract_version = 5 WHERE id = ANY($claimed)` (the OKF writer
  also stamps it), commit. A node whose processing throws is logged and still stamped (no loop).
  Per pass: tree roots of the claimed ids via `topAncestorIdsSql(idsArray)` (`server/src/logs/session-tree.sql.ts:68`,
  CTE `top_ancestors(id, top_id)`); repo roots via `loadArtisynRootsBySessionIds(db, [...claimed, ...treeRoots])`
  (`server/src/logs/change-surface/changed-paths.sql.ts:93`), `rootsOf(node) = roots.get(node) ?? roots.get(treeRoot) ?? []`
  (the rule of the private `RepositoriesService.recomputeOkfAccess`). Per node, inside the pass transaction: load its
  `logs` rows with `log_type IN ('claude','claude-subagent')` ordered by `id` (`{ sessionId, logType, body }`);
  recount with `countShellInvocations(lines, isSubagentLog)`; `UPDATE session_stats SET commit_count = $commits,
  pr_count = $prs WHERE session_id = $node`; then `rebuildOkfAccessForNodes(db, bodyRows, rootsOf)`
  (`okf-access-writer.ts:183`), each node wrapped in try/catch.
  **Counting helpers** (in `claude-extractor.ts`, exported): `shellInvocationsOf(name: string, input:
  Record<string, unknown> | null): { commits: number; prs: number }` — 0/0 unless `shellOfTool(name)` is set and
  `input.command` is a string, else `countCommits` / `countPullRequests` with that shell; the extractor's block
  at ~line 1038 calls it per `tool_use` block (today's behaviour: every block counted, no dedupe).
  `countShellInvocations(lines: readonly object[], isSubagentLog: boolean)` applies the extractor's filter —
  only `type === 'assistant'` lines, skip `isSidechain === true` when `!isSubagentLog`, every `tool_use` block of
  `message.content`, no dedupe — and sums `shellInvocationsOf`, so backfill and ingest agree.
  Coverage: `session_tool_stats` is written inline by every ingest and by "recompute all sessions", so every
  stored node with a PowerShell call has its row; sessions stored before that table existed (none have
  PowerShell calls in practice) are reached only by the manual recompute. Nodes without PowerShell calls are
  never touched. No migration: `okf_extract_version` and the `session_tool_stats (session_id, tool_name)`
  unique index exist.
- **DD-20 `BUILTIN_TOOL_NAMES`** (`server/src/logs/builtin-tools.ts`) gets `'PowerShell'` after `'Bash'`
  (seeded with `onConflictDoNothing`, so existing repos get the row on their next harness sync; the client
  registry it once mirrored no longer exists — fix the comment).

### Client

- **DD-21 Lazy per-shell loading (NFR).** `client/src/viewer/lib/bash-view/bash-parser.ts` becomes
  grammar-agnostic: `loadTreeSitterParser(key: ShellKind, assets: { runtimeWasm: string; languageWasm: string }):
  Promise<BashParser>`, one cached promise per key (failure not cached), `Parser.init` once per page.
  `browser-parser.ts` keeps the Bash entry (`getBrowserBashParser`, `HIGHLIGHT_QUERY`); new
  `powershell-browser-parser.ts` exports `getBrowserPowerShellParser()` and `PS_HIGHLIGHT_QUERY`
  (`powershellHighlightQuery` of `tree-sitter-powershell/queries/highlights.scm?raw`). Each entry is
  reachable only via `import()`, so a Bash-only session never requests `tree-sitter-powershell-<hash>.wasm`.
- **DD-22 Hooks.** `useBashView(command: string, shell: ShellKind)` (the `forceFallback` parameter is
  removed) loads only that shell's parser and builds with `buildShellView`, highlighting with
  `highlightBash` / `highlightPowerShell`. `useBashViews(rows: ReadonlyArray<{ id: string; input:
  Record<string, unknown>; shell: ShellKind }>)` (`BashCallRow` satisfies it) loads only the parsers of shells
  present. `PowerShell` also gets `TOOL_DESCRIPTIONS` entry `'Execute PowerShell commands'` in
  `prompt-turn-helpers.tsx` (~line 85), next to `Bash`.
- **DD-23 Rows.** `BashCallRow` gains `shell: ShellKind`; the collector keeps calls with
  `shellOfTool(c.name) !== null` (same dedupe, sort and numbering). `collectBashCalls` keeps its name
  (all callers unchanged); `SessionDetailPane`'s count therefore covers both shells (FR-11).
- **DD-24 Filter URL contract (FR-4).** Hook `useShellFilterParam()` in `bash-tab/useShellFilterParam.ts`,
  same `replace: true` pattern as `useBashCallParam`: value `'bash' | 'powershell' | null`; unknown value or a
  shell without calls → All. Filter and badges render only when both shells have calls. Precedence on load:
  if `bashCall` names a row hidden by `shell`, drop `shell` and select it. Picking a filter that hides the
  selected row selects the first visible row and rewrites `bashCall`. Row numbers `n` never change.
- **DD-25 UI strings.** Tab label `Shell`; description (tooltip) `Bash / PowerShell — every shell command the
  session tree ran, with exit status.`; synonyms add `bash`, `powershell`, `pwsh`. Empty state `No shell
  commands in this session`. List `aria-label="Shell commands"`. Filter chips `All <n>` / `Bash <n>` /
  `PowerShell <n>` (`data-testid="shell-filter-<all|bash|powershell>"`); badge text `bash` / `pwsh`
  (`data-testid="shell-badge"`) before the preview. The count already flows `collectBashCalls` →
  `SessionDetailPane` (`bashCount`) → `SessionTabTrigger`, `nav-tree.ts`, `summary-cards.ts`; the Summary card
  title comes from the tab registry (`card('bash', …)`), so only the doc comments saying "Bash commands / calls"
  change to "shell commands" (`SessionTabTrigger.tsx:10`, `summary-cards.ts:43`, `SessionSummaryTab.tsx:84`,
  `nav-tree.ts:110`).
- **DD-26 FR-14 audit result.** After this plan the only `'Bash'` tool-name literals left are already
  shell-aware (`ToolCallView` `isShell`, `session-map.constants.ts`, `packages/recommendations/src/catalog.ts`)
  or a doc comment (`usage-analytics.types.ts`); the `Bash:` key of `TOOL_DESCRIPTIONS` gets a `PowerShell`
  sibling (DD-22); CLI recognition keeps its PowerShell tokenizer (DD-18).

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `packages/bash-view/src/syntax.ts` | `ShellParser`, `ShellSyntaxNode` aliases | DD-1 |
| `packages/bash-view/src/shell.ts` | new: `ShellKind`, `shellOfTool`, `ShellParsers`, `buildShellView`, `analyzeShellCommand` | DD-2 |
| `packages/bash-view/src/ps-mask.ts` | new: masks | DD-4 |
| `packages/bash-view/src/ps-split.ts` | new: top-level `;` lexer | DD-8 |
| `packages/bash-view/src/ps-parse.ts` | new: `withPsTree`, `textOf` | DD-4 |
| `packages/bash-view/src/ps-format.ts` | new: format, lift, here-string fold | DD-7–DD-10 |
| `packages/bash-view/src/ps-analyze.ts` | new: FILES analysis | DD-12–DD-14 |
| `packages/bash-view/src/ps-wrap.ts` | new: `stripLhWrap` | DD-11 |
| `packages/bash-view/src/ps-highlight.ts` | new: query, capture map, highlighter | DD-5, DD-6 |
| `packages/bash-view/src/ps-view.ts` | new: `buildPowerShellView` | DD-8, DD-11 |
| `packages/bash-view/src/bash-format.ts` | export `WIDTH`, `IND` | DD-2 |
| `packages/bash-view/src/bash-analyze.ts` | `deleted`; extract `analyzeWords` | DD-3, DD-14 |
| `packages/bash-view/src/bash-highlight.ts` | `highlightWith` | DD-2 |
| `packages/bash-view/src/bash-view.ts` | `files.deleted` | DD-3 |
| `packages/bash-view/src/index.ts` | re-export new modules | |
| `packages/bash-view/README.md` | module list, Bash + PowerShell | |
| `client/package.json`, `server/package.json` (+ lockfiles) | `tree-sitter-powershell` 0.26.6 exact | |
| `scripts/copy-wasm.js` | add `tree-sitter-powershell/tree-sitter-powershell.wasm` | also feeds the scenario stand |
| `Dockerfile` | copy the PowerShell WASM to `/app/dist/wasm/` | line 44 |
| `server/src/logs/okf/server-wasm-runtime.ts` | new: shared `Parser.init` | DD-17 |
| `server/src/logs/okf/server-bash-parser.ts` | use the shared runtime init | DD-17 |
| `server/src/logs/okf/server-powershell-parser.ts` | new | DD-17 |
| `server/src/logs/okf/server-shell-parsers.ts` | new: `getServerShellParsers` | DD-17 |
| `server/src/logs/okf/okf-access-extractor.ts` | `ShellParsers`, PowerShell case | DD-16 |
| `server/src/logs/okf/okf-facts.service.ts` | same | DD-16 |
| `server/src/logs/okf/okf-access-writer.ts` | pass `getServerShellParsers()` | DD-16 |
| `server/src/logs/okf/okf-constants.ts` | `OKF_EXTRACT_VERSION = 5` | DD-19 |
| `server/src/logs/okf/shell-figures-backfill.service.ts` | new backfill service | DD-19 |
| `server/src/logs/logs.module.ts` | register the backfill service | DD-19 |
| `server/src/logs/tool-stats.ts` | `shell` parameter, PowerShell anchor | DD-15 |
| `server/src/logs/claude-extractor.ts` | `countShellInvocations`, gate on `shellOfTool` | DD-15, DD-19 |
| `server/src/logs/builtin-tools.ts` | `'PowerShell'` | DD-20 |
| `client/src/viewer/lib/bash-view/bash-parser.ts` | `loadTreeSitterParser(key, assets)` | DD-21 |
| `client/src/viewer/lib/bash-view/browser-parser.ts` | use `loadTreeSitterParser('bash', …)` | DD-21 |
| `client/src/viewer/lib/bash-view/powershell-browser-parser.ts` | new PowerShell entry | DD-21 |
| `client/src/viewer/pages/repository/session-log/tool-call-view/useBashView.ts` | per-shell loading | DD-22 |
| `…/tool-call-view/ToolCallView.tsx` | drop `forceFallback` branch, shell to body | FR-10 |
| `…/tool-call-view/BashCommandView.tsx` | `shell` prop, stripped "Copy original" | DD-11 |
| `…/tool-call-view/BashFileSummary.tsx` | Changes list: `(deleted)` suffix for `files.deleted` (`PathList` gets an optional `deleted` set) | DD-3 |
| `docs/knowledgebase/algorithms/README.md`, `docs/knowledgebase/session-metrics-scope.md` | new doc row; counters count PowerShell | Chunk 9 |
| `…/bash-tab/collect-bash-calls.ts` | both shells, `shell` field | DD-23 |
| `…/bash-tab/useShellFilterParam.ts` | new URL param hook | DD-24 |
| `…/bash-tab/SessionBashTab.tsx` | filter state, selection rules, empty state | DD-24, DD-25 |
| `…/bash-tab/BashCallList.tsx` | filter chips, badges, aria-label | DD-25 |
| `client/src/viewer/tab-ids.ts` | label / description / synonyms | DD-25 |
| `client/src/viewer/pages/repository/SessionTabTrigger.tsx`, `…/session-log/summary/summary-cards.ts`, `…/session-log/summary/SessionSummaryTab.tsx`, `client/src/viewer/pages/map/nav-tree.ts` | doc comments only | DD-25 |
| `server/src/database/schema/index.ts` | `okfExtractVersion` TS comment | DD-19 |
| `…/session-log/log-parser.ts` | PowerShell one-line summary like Bash | FR-10 |
| `…/session-log/charts/context-usage/step-label.ts` | PowerShell step label like Bash | FR-10 |
| `…/session-log/prompt-turn-helpers.tsx` | PowerShell pill colour = Bash | FR-10 |
| `…/session-log/usage/session-usage-derive.ts` | twin counters + gate | DD-15 |
| `docs/knowledgebase/algorithms/powershell-command-view.md` | new algorithm doc | Tests |
| `docs/algorithm-examples/powershell-command-view.json` | new rows file | Tests |
| `client/src/viewer/lib/bash-view/powershell-view.algo.test.ts` | new table test | Tests |
| `docs/algorithm-examples/bash-command-view.json` | `deleted` rows | Tests |
| `docs/algorithm-examples/okf-access-extraction.json` | PowerShell rows | Tests |
| `server/src/logs/okf/okf-access-extractor.algo.spec.ts` | real PowerShell parser too | Tests |
| `tests/scenarios/view/s-sess-14.spec.ts` | mixed-session steps | Tests |
| `tests/scenarios/helpers/okf.ts` | `powershell` action | Tests |
| `tests/scenarios/view/s-sess-09.spec.ts` | PowerShell KB read step | Tests |
| `docs/knowledgebase/*` (see Chunk 9), `docs/knowledgebase/index.md` | KB updates | |
| `user-docs/session-log.md` | Shell tab | |
| `docs/qaa-overview/scenarios/03-session-view-reports-golden.md` | S-SESS-14 description | |
| `docs/tasks/todo/2026-11-22-bash-tab-powershell/wireframes/*.svg` | callouts state the decisions | Wireframes |

## Dependencies

- `tree-sitter-powershell` **0.26.6**, exact pin, in `client/package.json` and `server/package.json` next to
  `tree-sitter-bash`; MIT; only `tree-sitter-powershell.wasm` and `queries/highlights.scm` are used (its
  `install` script builds an unused native binding, same as `tree-sitter-bash`). Grammar ABI works with the
  pinned `web-tree-sitter` 0.27.1 (PoC). Passes the existing `dependency-review` licence scan (MIT allowed).

## Test coverage plan

All three kinds per the CLAUDE.md test policy, nothing else:

- **Algorithm — new doc** `docs/knowledgebase/algorithms/powershell-command-view.md` (sections like
  `bash-command-view.md`: Code / Input and output / Rules 1–9 = parse + masks, fallback ladder, layout, lift,
  here-string fold, wrapper prefix, FILES, display paths, highlight / Edge cases / Examples / Mutations /
  Where visible), rows file `docs/algorithm-examples/powershell-command-view.json`, run by a new table test
  `client/src/viewer/lib/bash-view/powershell-view.algo.test.ts` (same harness as `bash-view.algo.test.ts`).
  Rows cover: format of pipelines / blocks / `try-catch-finally` / `if-else` expansion, `&&` / `||` breaks,
  PS 7 ternary / `??` / `?.`, each mask G1–G10, `;`-split partial, raw fallback, strings never broken, lift,
  here-string fold, wrapper prefix (current + 2.28.0 shape), FILES (closed list, aliases, abbreviations,
  arrays, Windows paths, `$null` / providers, unspaced redirects, variable substitution, `Rename-Item`,
  natives via `analyzeWords`), highlight captures, and the FR-9 acceptance example.
- **Algorithm — existing docs:** `bash-command-view.json` gets `deleted` rows (`rm`, `rmdir`) and its doc the
  DD-3 rule; `okf-access-extraction.json` gets PowerShell rows (`Get-Content docs/…` read, `Select-String`
  grep, `Get-ChildItem` list, `Set-Content` write) run by `okf-access-extractor.algo.spec.ts` with the real
  server PowerShell parser. No algorithm doc covers the commit / PR counters, so FR-12 is a scenario step.
- **API contract:** none (no route changes).
- **Scenario:** `tests/scenarios/view/s-sess-14.spec.ts` (`@S-SESS-14`, modes a, c): the a3 PowerShell call
  becomes a real command (Chunk 11) — Shell tab label and count, mixed list order, `pwsh` badge, filter,
  URL precedence, formatted PowerShell view with WORKING DIR / FILES / "changes 2" / `(deleted)`, Logs and
  Context Growth reach the same view, PowerShell WASM requested only on this session, the session's Commits /
  Pull requests counters (client twin) and `/analytics/productivity` totals (server). OKF: a step in
  `tests/scenarios/view/s-sess-09.spec.ts` step 10 reads a KB article through PowerShell `Get-Content`.
  The backfill (FR-15) is reached by an S-SESS-14 step that makes the uploaded PowerShell node stale through
  the scenario DB pool (version 4, zeroed counts) and waits for the running service to restore it.

## Visual/UX notes

- Filter row above the list (only on mixed sessions): three chips, the active one filled, counts in
  tabular numerals; same chip component as other list filters (`ui-components` skill).
- Badge `bash` / `pwsh`: small monospace text badge, neutral colours, before the preview, after the
  sub-agent badge; absent on single-shell sessions; `ToolCallView` header keeps its own tool badge.
- PowerShell rows: same layout as Bash rows (number, time, `⏱`, "changes N", `✗`, agent badge, preview).
- FILES Changes list: deleted paths with a muted `(deleted)` suffix (both shells).

## Wireframes

- `shell-tab-mixed-session.svg` and `shell-tab-filter-and-states.svg`: replace the "open question" /
  "Draft" callouts with the decisions — URL param `shell=bash|powershell`, badge `bash` / `pwsh` only on mixed
  sessions, no badge on single-shell sessions (FR-3, FR-4). No layout change.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Shared package: PowerShell parse + layout | 7 | none before it |
| 2 | Shared package: analysis, highlight, view, shell dispatch | 8 | uses chunk 1 modules |
| 3 | Dependency and WASM shipping | 4 | package from 1–2; server / client need the files |
| 4 | Server: parsers and OKF extraction | 6 | needs 2 (`analyzeShellCommand`) and 3 (WASM) |
| 5 | Server: counters, backfill, built-in tools | 7 | needs 4 (`getServerShellParsers`) |
| 6 | Client: parser loading, rows and the shared tool view | 7 | needs 2 and 3 |
| 7 | Client: Shell tab list, filter, URL | 6 | needs 6 (`BashCallRow.shell`, `useBashViews` with shell) |
| 8 | Client: other PowerShell touch points | 5 | needs 2 (`shellOfTool`, `ShellKind`) |
| 9 | Docs: KB, user docs, wireframes | 7 | after code chunks |
| 10 | Tests: algorithm docs, rows and table tests | 7 | needs 1–5 |
| 11 | Tests: scenarios and verification | 7 | needs everything |

### Chunk 1 — Shared package: PowerShell parse + layout

- [ ] `packages/bash-view/src/syntax.ts`: add `ShellParser` / `ShellSyntaxNode` type aliases per DD-1.
- [ ] `packages/bash-view/src/bash-format.ts`: export the existing `WIDTH` and `IND` constants (DD-2); no behaviour change.
- [ ] Create `packages/bash-view/src/ps-mask.ts`: `PS_MASKS` (table in DD-4, in that order) and `maskForParse(src)` returning `{ text, used }`, skipping any replacement whose length differs; port of PoC `ps-mask.mjs`.
- [ ] Create `packages/bash-view/src/ps-split.ts`: `topLevelSemicolons(src)` per DD-8 lexing rules; port of PoC `ps-split.mjs`.
- [ ] Create `packages/bash-view/src/ps-parse.ts`: `withPsTree` (two-pass parse per DD-4, trees always deleted) and `textOf` (DD-2 signatures).
- [ ] Create `packages/bash-view/src/ps-format.ts`: `formatPowerShell` per DD-7 and DD-8 (port of PoC `ps-format.mjs` `makeFormatter`, chain ops always broken), `liftPowerShellCd` per DD-9, `foldHereStrings` + `HERE_STRING_INLINE_MAX` per DD-10; all text via `textOf`.
- [ ] Run the package checks: client `bun run typecheck` and server `npm run typecheck` (the package is compiled by both); fix errors at the root cause.

### Chunk 2 — Shared package: analysis, highlight, view, shell dispatch

- [ ] `packages/bash-view/src/bash-analyze.ts`: add `deleted: string[]` to `BashAnalysis` (DD-3, `rm`/`rmdir` positionals) and extract node-free `analyzeWords(base, args, sink)` with `WordSink` per DD-14; `analyzeTree` calls it, behaviour unchanged.
- [ ] Create `packages/bash-view/src/ps-analyze.ts`: `PS_CMDLETS`, `PS_ALIASES`, `PS_NOT_RUNS` and `analyzePowerShell(parser, src): BashAnalysis` per DD-12, DD-13, DD-14; port of PoC `ps-analyze.mjs` (`deleted` filled by `Remove-Item`).
- [ ] Create `packages/bash-view/src/ps-wrap.ts`: `stripLhWrap(parser, command)` per DD-11 (port of PoC `wrap-prefix.mjs` `stripWrap`).
- [ ] `packages/bash-view/src/bash-highlight.ts`: add `highlightWith(parser, text, query, kindMap)`; `highlightBash` delegates with `CAPTURE_KIND` (DD-2).
- [ ] Create `packages/bash-view/src/ps-highlight.ts`: `powershellHighlightQuery`, `PS_CAPTURE_KIND`, `highlightPowerShell` per DD-5 and DD-6.
- [ ] `packages/bash-view/src/bash-view.ts`: add `deleted` to `BashFiles` (repo-relative like `changes`). Create `ps-view.ts` `buildPowerShellView(parser, command, root)`: `stripLhWrap` first, then format / lift / fold / analyze (per piece when `partial`, DD-8), same `BashView` shape.
- [ ] Create `packages/bash-view/src/shell.ts` per DD-2 (`ShellKind`, `shellOfTool`, `ShellParsers`, `buildShellView`, `analyzeShellCommand`); re-export every new module from `index.ts`; update `packages/bash-view/README.md` module table.
- [ ] Run client `bun run typecheck`, server `npm run typecheck`, client `bun run test` and server `npm run test` (existing Bash rows must stay green).

### Chunk 3 — Dependency and WASM shipping

- [ ] Add `"tree-sitter-powershell": "0.26.6"` (exact) to `client/package.json` (install with `bun install` in `client/`) and to `server/package.json` (install with `npm install` in `server/`), next to `tree-sitter-bash`; commit-ready lockfiles.
- [ ] `scripts/copy-wasm.js`: add `'tree-sitter-powershell/tree-sitter-powershell.wasm'` to `WASM_FILES` (the build and `scripts/scenarios/build-stand.mjs` both use it).
- [ ] `Dockerfile` line 44: also copy `server/node_modules/tree-sitter-powershell/tree-sitter-powershell.wasm` into `/app/dist/wasm/`.
- [ ] Run `npm run build` (background) and confirm `dist/wasm/tree-sitter-powershell.wasm` exists (the hashed client asset appears only after Chunk 6).

### Chunk 4 — Server: parsers and OKF extraction

- [ ] Create `server/src/logs/okf/server-wasm-runtime.ts` with cached `initTreeSitterRuntime()` (resolves `web-tree-sitter.wasm` like `server-bash-parser.ts` `resolveWasm`); make `server-bash-parser.ts` use it (DD-17).
- [ ] Create `server/src/logs/okf/server-powershell-parser.ts` `getServerPowerShellParser(): Promise<BashParser | null>` mirroring `server-bash-parser.ts` (WASM `tree-sitter-powershell.wasm`, logger `OkfPowerShellParser`, warning text names PowerShell calls) (DD-17).
- [ ] Create `server/src/logs/okf/server-shell-parsers.ts` `getServerShellParsers(): Promise<ShellParsers>` resolving both getters (DD-17).
- [ ] `server/src/logs/okf/okf-access-extractor.ts`: replace `parser: BashParser | null` with `parsers: ShellParsers` in `accessesOfCall`, `extractOkfDetail`, `extractOkfAccess`; `case 'Bash': case 'PowerShell':` via `analyzeShellCommand` (DD-16); update the header comment.
- [ ] `server/src/logs/okf/okf-facts.service.ts`: same change in `collectNodeFileFacts` and its caller (`getServerShellParsers()` instead of `getServerBashParser()`); `okf-access-writer.ts` `rebuildSessionOkfAccess` passes `await getServerShellParsers()` (DD-16).
- [ ] Run server `npm run typecheck`, `npm run lint`, `npm run test` (the only other caller, `okf-access-extractor.algo.spec.ts`, is switched in Chunk 10; until then pass it `{ bash: parser, powershell: null }` so it compiles).

### Chunk 5 — Server: counters, backfill, built-in tools

- [ ] `server/src/logs/tool-stats.ts`: `countCommits(command, shell = 'bash')` and `countPullRequests(command, shell = 'bash')` with the PowerShell anchor and `.exe`/quote tolerance per DD-15; Bash pattern unchanged.
- [ ] `server/src/logs/claude-extractor.ts`: add exported `shellInvocationsOf(name, input)` and `countShellInvocations(lines, isSubagentLog)` exactly per DD-19 "Counting helpers"; the `name === 'Bash'` block (~line 1038) becomes a call to `shellInvocationsOf` per `tool_use` block.
- [ ] `server/src/logs/okf/okf-constants.ts`: `OKF_EXTRACT_VERSION = 5` and the three `SHELL_FIGURES_BACKFILL_*` constants with the version comment, all per DD-19; rewrite the `okfExtractVersion` TS comment in `server/src/database/schema/index.ts` (~line 180) to the DD-19 reading.
- [ ] Create `server/src/logs/okf/shell-figures-backfill.service.ts` per DD-19 (claim SQL, tree roots via `topAncestorIdsSql`, repo roots via `loadArtisynRootsBySessionIds`, one transaction per pass, `session_stats` update, `rebuildOkfAccessForNodes`, interval `SHELL_FIGURES_BACKFILL_TICK` for the process lifetime, cleared on destroy).
- [ ] Register `ShellFiguresBackfillService` in `server/src/logs/logs.module.ts` providers, next to `ToolUsageRebuildService`.
- [ ] `server/src/logs/builtin-tools.ts`: add `'PowerShell'` after `'Bash'`; replace the stale "mirror of registry.ts / drift test" comment with what is true now (DD-20).
- [ ] Run server `npm run typecheck`, `npm run lint`, `npm run test`.

### Chunk 6 — Client: parser loading, rows and the shared tool view

- [ ] `session-log/bash-tab/collect-bash-calls.ts`: keep calls with `shellOfTool(c.name) !== null`, add `shell: ShellKind` to `BashCallRow` (DD-23); update the module comment.
- [ ] `client/src/viewer/lib/bash-view/bash-parser.ts`: generalise to `loadTreeSitterParser(key: ShellKind, assets)` per DD-21 (per-key cache, shared `Parser.init`, grammar-neutral error text); `browser-parser.ts` calls it with `'bash'`.
- [ ] Create `client/src/viewer/lib/bash-view/powershell-browser-parser.ts` per DD-21 (`?raw` scm, `?url` WASMs, `PS_HIGHLIGHT_QUERY`, `getBrowserPowerShellParser`), never imported statically.
- [ ] `session-log/tool-call-view/useBashView.ts`: per-shell `loadParser(shell)`; `useBashView(command, shell)` and `useBashViews(rows with shell)` per DD-22, building with `buildShellView` and highlighting with `highlightBash` / `highlightPowerShell`.
- [ ] `session-log/tool-call-view/ToolCallView.tsx`: remove the `PowerShell` → `forceFallback` branch; render `BashCommandView` for `shellOfTool(call.name) !== null` with that shell (FR-10).
- [ ] `session-log/tool-call-view/BashCommandView.tsx`: take `shell`; "Copy original" copies `stripLhWrap` text for PowerShell (DD-11). `BashFileSummary.tsx`: `PathList` takes an optional `deleted` set and renders those Changes paths with a muted `(deleted)` suffix (DD-3).
- [ ] Run client `bun run typecheck`, `bun run lint`, `bun run test`.

### Chunk 7 — Client: Shell tab list, filter, URL

- [ ] Create `session-log/bash-tab/useShellFilterParam.ts` per DD-24 (param `shell`, `replace: true`, unknown → null).
- [ ] `session-log/bash-tab/SessionBashTab.tsx`: compute per-shell counts, `mixed` flag, apply the filter, the URL precedence and selection rules of DD-24, empty state text per DD-25.
- [ ] `session-log/bash-tab/BashCallList.tsx`: filter chips (only when mixed) and `bash` / `pwsh` badges per DD-25 and Visual/UX notes; preview / chip use each row's view regardless of shell; `aria-label="Shell commands"`.
- [ ] `client/src/viewer/tab-ids.ts`: `label: 'Shell'`, description and synonyms per DD-25 (id stays `bash`).
- [ ] Change the doc comments named in DD-25 (`SessionTabTrigger.tsx:10`, `summary-cards.ts:43`, `SessionSummaryTab.tsx:84`, `nav-tree.ts:110`) from "Bash commands / calls" to "shell commands"; no logic change there (FR-11 follows from the collector).
- [ ] Run client `bun run typecheck`, `bun run lint`; visual check of a mixed session in the dev app (Playwright MCP per `use-playwright`): filter, badges, reload keeps `shell`.

### Chunk 8 — Client: other PowerShell touch points

- [ ] `session-log/log-parser.ts` (~line 160): give `PowerShell` the same one-line summary as `Bash` (first command line, same 50-char cut, description first) (FR-10).
- [ ] `session-log/charts/context-usage/step-label.ts` (~line 17): `case 'PowerShell':` shares the `Bash` label (FR-10).
- [ ] `session-log/prompt-turn-helpers.tsx`: `getOtherToolStyle` (~line 67) gives `PowerShell` the Bash amber style (FR-10); `TOOL_DESCRIPTIONS` (~line 85) gets `PowerShell: 'Execute PowerShell commands'` (DD-22).
- [ ] `session-log/usage/session-usage-derive.ts`: twin `countCommits` / `countPullRequests` take `shell` with the DD-15 PowerShell anchor; the `name === 'Bash'` gate (~line 481) uses `shellOfTool`.
- [ ] Run client `bun run typecheck`, `bun run lint`, `bun run test`.

### Chunk 9 — Docs: KB, user docs, wireframes

- [ ] `docs/knowledgebase/session-log-view.md`: rewrite § "Bash tab" as "Shell tab" (both shells, filter, `shell` URL param, badges) and § "Shared tool view" (no `forceFallback`, PowerShell view, per-shell WASM loading).
- [ ] `docs/knowledgebase/algorithms/bash-command-view.md`: DD-3 `deleted` rule, `analyzeWords` extraction, link to the new PowerShell doc; `algorithms/cli-command-recognition.md`: DD-18 stated reason; `algorithms/okf-access-extraction.md`: PowerShell calls via `analyzeShellCommand`.
- [ ] `docs/knowledgebase/repo-local-packages.md` (package row, WASM shipping list) and `client-routing-and-layout.md` (lazy WASM chunk sizes incl. PowerShell 1.1 MB); `okf-usage.md`: `OKF_EXTRACT_VERSION` 5 and the backfill service.
- [ ] `docs/knowledgebase/twins-and-cross-cutting-rules.md` and `session-metrics-scope.md`: the counter twins' `shell` parameter, PowerShell anchor, PowerShell calls counted; add the new algorithm doc to `docs/knowledgebase/index.md` and to the Docs table of `docs/knowledgebase/algorithms/README.md`.
- [ ] `user-docs/session-log.md`: rename the tab to Shell in the tables and § "Bash" → § "Shell" (both shells, filter, badges, PowerShell formatted view); then run `npm run build:help`.
- [ ] `docs/qaa-overview/scenarios/03-session-view-reports-golden.md`: describe the new S-SESS-14 steps.
- [ ] Wireframes in the task folder: replace "open question" / "Draft" callouts per the Wireframes section.

### Chunk 10 — Tests: algorithm docs, rows and table tests

- [ ] Write `docs/knowledgebase/algorithms/powershell-command-view.md` (OKF v0.3 front matter, `type: "Algorithm"`, `reviewed: no`) per the Test coverage plan, stating DD-4 to DD-14 as rules, with the PoC as evidence.
- [ ] Create `docs/algorithm-examples/powershell-command-view.json` with view and highlight rows listed in the Test coverage plan; anonymised paths `C:\work\acme-app` / `/work/acme-app` like the Bash rows.
- [ ] Create `client/src/viewer/lib/bash-view/powershell-view.algo.test.ts` (copy the harness of `bash-view.algo.test.ts`, `createRequire` for `tree-sitter-powershell` WASM / scm, `buildPowerShellView` + `highlightPowerShell`).
- [ ] `docs/algorithm-examples/bash-command-view.json`: rows with an `expected.deleted` key (`rm a b`, `rmdir d`, `rm` inside a loop); `bash-view.algo.test.ts` adds `deleted: view.files.deleted` to its `actual` object (it compares only the keys a row lists, so existing rows are unaffected).
- [ ] `docs/algorithm-examples/okf-access-extraction.json`: PowerShell rows (read, grep, list, write, `Set-Location` + relative path, alias `cat`); `okf-access-extractor.algo.spec.ts` loads both server parsers and passes `ShellParsers`.
- [ ] `server/src/logs/okf/okf-access-extractor.algo.spec.ts`: its `noParser` rows pass `{ bash: null, powershell: null }`; add a row flag `noPowerShellParser` that passes `{ bash, powershell: null }` and a row proving PowerShell calls are then skipped.
- [ ] Run client `bun run test`, server `npm run test`, hook `npm test` untouched; all green.

### Chunk 11 — Tests: scenarios and verification

- [ ] `tests/scenarios/view/s-sess-14.spec.ts` fixture: a3's PowerShell call becomes `Set-Location <root>; Get-Content a.json | ConvertFrom-Json | Set-Content -Path out\b.json; Remove-Item tmp\x; git commit -m "x"; gh pr create --fill` with a description; update the step at ~line 230 (now formatted, toggle present).
- [ ] s-sess-14: rewrite the Shell tab steps (~lines 313–353): label `Shell`, count 6 (5 Bash + 1 PowerShell) in start order, `pwsh` badge, filter All 6 / Bash 5 / PowerShell 1, original numbers under the filter, reload keeps `shell`, URL precedence of DD-24, empty state text.
- [ ] s-sess-14: PowerShell view step — WORKING DIR repo root, FILES `a.json` read, `out/b.json` + `tmp/x (deleted)` changes, row "changes 2"; same view from Logs and Context Growth with `⏱`; `tree-sitter-powershell[^/]*\.wasm` requested here and not before (extend the ~line 180–209 request watcher).
- [ ] s-sess-14: counters step — Usage `Commits` 1 and `Pull requests` 1, `/analytics/productivity` totals (as `golden-load.spec.ts` reads them) include them; then backfill (FR-15): via the scenario `Pool` (`sessionRowId`) set the main node's `okf_extract_version = 4`, `session_stats.commit_count = pr_count = 0`, and poll (≤ 45 s) until the counts are 1 / 1 and the version 5 again.
- [ ] `tests/scenarios/helpers/okf.ts`: add `{ psRead: string; result?: string }` to `OkfAction`; `okfStep` emits a `PowerShell` call `Get-Content '<abs(psRead)>'`. `s-sess-09.spec.ts` step 10: add `{ psRead: 'docs/kb/a08.md' }`; expected opened set and hot-files poll become `[a06, a07, a08]`; title names a08.md read through PowerShell.
- [ ] Run `npm run test:scenarios -- --mode a --only scenarios --grep "@S-SESS-14"` and `--grep "@S-SESS-09"`, then `npm run typecheck:tests`.
- [ ] Final run per `adlc-lh:workcycle` (`finalRun: true`): fast set + `contract`, `scenarios-a`…`-d`, `e2e-fast`, `e2e-full`; check `dist/` has both grammar WASMs and no PoC files.
