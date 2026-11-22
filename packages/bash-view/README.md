# @loghub/bash-view

Repo-local package with the Bash and PowerShell command analysis shared by the Log Hub client (the
shell command view) and the server (KB access extraction). The name stays `bash-view` to avoid
churn in every import. It is never published; both sides consume its TypeScript sources directly.
Algorithm docs: `docs/knowledgebase/algorithms/bash-command-view.md` and
`docs/knowledgebase/algorithms/powershell-command-view.md`.

| Module | Contents |
|---|---|
| `src/syntax.ts` | Structural types of a tree-sitter tree (`BashSyntaxNode`, `BashSyntaxTree`; grammar-agnostic aliases `ShellSyntaxNode`, `ShellParser`), `BashCapture`, the `BashParser` interface each side implements, `withTree` |
| `src/bash-analyze.ts` | `analyzeBash` — which files a command changes / reads / runs / deletes, plus `readAccess` (kind `read` / `grep` / `list` per read path, from the command base name, `readKindOf`); `analyzeWords` + `WordSink` (the tree-free rules for one external command, reused by PowerShell), `joinPath`, `relativeToWorkDir`, `literal`, `groupByDir`, `displayGroups`, `GROUP_BY_DIR_ABOVE` |
| `src/bash-format.ts` | `formatBash` (readable layout), `liftCd`, `foldHeredocs`, `HEREDOC_INLINE_MAX`, `WIDTH`, `IND` |
| `src/bash-highlight.ts` | `highlightBash`, `highlightWith` (any grammar, with a capture → kind map), `paintCaptures`, `bashHighlightQuery`, `HIGHLIGHT_CLASS`, the `HighlightKind` / `HighlightSegment` types |
| `src/bash-view.ts` | `buildBashView` — everything the Bash view shows for one command (`BashView`, `BashFiles`, `emptyBashFiles`) |
| `src/display-paths.ts` | `toRepoRelative` — the display-only repo-root prefix rule |
| `src/ps-mask.ts` | `maskForParse`, `PS_MASKS` — same-length masks that close `tree-sitter-powershell` grammar gaps |
| `src/ps-split.ts` | `topLevelSemicolons`, `topLevelPieces` — PowerShell-lexed top-level `;` cut (fallback ladder) |
| `src/ps-parse.ts` | `withPsTree` (plain parse, then masked), `textOf` |
| `src/ps-format.ts` | `formatPowerShell` (readable layout, `partial` fallback), `liftPowerShellCd`, `foldHereStrings`, `HERE_STRING_INLINE_MAX`, `psLiteral` |
| `src/ps-analyze.ts` | `analyzePowerShell` (same `BashAnalysis` shape), `PS_CMDLETS`, `PS_ALIASES`, `PS_NOT_RUNS` |
| `src/ps-wrap.ts` | `stripLhWrap` — cuts the hook's `__lhWrap` prefix off a stored command |
| `src/ps-highlight.ts` | `highlightPowerShell`, `powershellHighlightQuery`, `PS_CAPTURE_KIND` |
| `src/ps-view.ts` | `buildPowerShellView` — the `BashView` of a PowerShell command |
| `src/shell.ts` | `ShellKind`, `shellOfTool`, `ShellParsers`, `buildShellView`, `analyzeShellCommand` — one entry for both shells |

## The parser stays outside

The package never imports `web-tree-sitter`. Each side loads the runtime and the shell grammars
itself and passes a `BashParser` in:

- **Client** — `client/src/viewer/lib/bash-view/bash-parser.ts` (dynamic `import()` of
  `web-tree-sitter`) and `browser-parser.ts` (the WASM files as Vite `?url` assets), so neither
  WASM file lands in the main bundle.
- **Server** — its own loader with the WASM files from `dist/wasm/` (or the installed packages in
  dev and jest).

`web-tree-sitter`'s `Tree` and `Node` satisfy `BashSyntaxTree` / `BashSyntaxNode` structurally, so a
loader returns its trees unchanged.

## How it is wired

Exactly like `@loghub/pricing` (see `packages/pricing/README.md`):

- **Client** — an alias in `client/vite.config.ts` and `client/tsconfig.json` (`paths` and
  `include`); not a bun dependency.
- **Server** — a `file:../packages/bash-view` dependency in `server/package.json`; Node loads the
  `.ts` sources itself, jest transpiles them, ncc bundles them.

## Rules

- Pure TypeScript only: no dependencies, no Node or DOM APIs. Both a browser bundle and the
  server load it.
- Erasable syntax only (no `enum`, `namespace` or parameter properties).
- Relative imports end in `.ts`.
- Its type errors surface through `bun run typecheck` (client) and `npm run typecheck` (server).
  Its behaviour is covered by the algorithm tests of `bash-command-view.md` and `powershell-command-view.md` (client) and the
  server's KB access extraction table, which run through it.
