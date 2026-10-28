# @loghub/bash-view

Repo-local package with the Bash command analysis shared by the Log Hub client (the Bash command
view) and the server (KB access extraction). It is never published; both sides consume its
TypeScript sources directly. Algorithm doc: `docs/knowledgebase/algorithms/bash-command-view.md`.

| Module | Contents |
|---|---|
| `src/syntax.ts` | Structural types of the `tree-sitter-bash` tree (`BashSyntaxNode`, `BashSyntaxTree`), `BashCapture`, the `BashParser` interface each side implements, `withTree` |
| `src/bash-analyze.ts` | `analyzeBash` — which files a command changes / reads / runs, plus `readAccess` (kind `read` / `grep` / `list` per read path, from the command base name, `readKindOf`); `literal`, `groupByDir`, `displayGroups`, `GROUP_BY_DIR_ABOVE` |
| `src/bash-format.ts` | `formatBash` (readable layout), `liftCd`, `foldHeredocs`, `HEREDOC_INLINE_MAX` |
| `src/bash-highlight.ts` | `highlightBash`, `bashHighlightQuery`, `HIGHLIGHT_CLASS`, the `HighlightKind` / `HighlightSegment` types |
| `src/bash-view.ts` | `buildBashView` — everything the Bash view shows for one command (`BashView`, `BashFiles`) |
| `src/display-paths.ts` | `toRepoRelative` — the display-only repo-root prefix rule |

## The parser stays outside

The package never imports `web-tree-sitter`. Each side loads the runtime and the bash grammar
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
  Its behaviour is covered by the algorithm tests of `bash-command-view.md` (client) and the
  server's KB access extraction table, which run through it.
