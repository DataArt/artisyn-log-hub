---
type: "Reference"
title: "Repo-Local Packages (packages/)"
description: "The packages/ folder convention for TypeScript code shared by server and client (@loghub/pricing, @loghub/bash-view, @loghub/tool-monitor): how the server consumes it (file: link, Node 24 type stripping, jest transform, ncc), how the client consumes it (Vite/tsconfig alias), Docker, the rules a package must follow (including structural types for parser-backed packages), and how to add one."
tags:
  - server
  - client
  - build
  - pricing
timestamp: "2026-10-28T00:00:00+04:00"
---

# Repo-Local Packages (`packages/`)

`packages/<name>/` holds pure TypeScript shared by the server and the client, so a piece of logic
exists once instead of as hand-kept twins. The packages are never published; both sides consume
their `.ts` sources directly.

| Package | Contents | Details |
|---|---|---|
| `@loghub/pricing` (`packages/pricing/`) | The LLM cost formula (`src/cost.ts`: `computeCostBreakdown`, `pickCallRates`, `FAST_MODE_MULTIPLIER`, …) and pricing-tier validation (`src/tiers.ts`: `validatePricingTiers`, `normalizeTiers`, `MAX_*`, `PricingTier`, …) | [packages/pricing/README.md](../../packages/pricing/README.md), [algorithms/cost-formula.md](algorithms/cost-formula.md) |
| `@loghub/bash-view` (`packages/bash-view/`) | Bash command analysis and display shared by the client Bash view and the server OKF access extraction: `analyzeBash` (changes / reads / runs, `readAccess` kinds), `buildBashView`, `formatBash`, `highlightBash`, `toRepoRelative`, and the structural parser types of `src/syntax.ts` (`BashParser`, `BashSyntaxNode`, `BashSyntaxTree`, `withTree`). Each side brings its own `tree-sitter-bash` loader: client `client/src/viewer/lib/bash-view/bash-parser.ts` + `browser-parser.ts`, server `server/src/logs/okf/server-bash-parser.ts` | [packages/bash-view/README.md](../../packages/bash-view/README.md), [algorithms/bash-command-view.md](algorithms/bash-command-view.md), [algorithms/okf-access-extraction.md](algorithms/okf-access-extraction.md) |
| `@loghub/tool-monitor` (`packages/tool-monitor/`) | CLI tool monitoring rules: `TOOL_DENYLIST` (name + role), `validateToolName`, `normalizeToolName`, `denylistRole` and the constants `TOOL_NAME_MAX`, `CAPTURE_LIMIT_BYTES`, `STDIN_CAPTURE_LIMIT_BYTES`, `MAX_MONITORED_TOOLS`. The hook's plain-JS copy is `hook/.claude/telemetry_tool/tool-wrap-names.js` | [packages/tool-monitor/README.md](../../packages/tool-monitor/README.md), [algorithms/tool-monitor-name-validation.md](algorithms/tool-monitor-name-validation.md) |

The hook (`hook/`) does **not** use packages: it is plain CommonJS installed into user repos, so it
keeps its own copies (e.g. `computeLocalSessionCost`), held to the same algorithm doc tables.

## Package layout

- `package.json`: `"private": true`, `"type": "module"`, `exports` / `types` pointing at
  `./src/index.ts`, no dependencies.
- `tsconfig.json`: `module`/`moduleResolution` `nodenext`, `allowImportingTsExtensions`,
  `verbatimModuleSyntax`, `isolatedModules`, `noEmit`.
- `src/index.ts` re-exports the modules.

## Server

- A `file:../packages/<name>` dependency in `server/package.json`; npm links it into
  `server/node_modules`. tsc and nest treat it as an external library and do not emit it into
  `server/dist`.
- When the server runs from tsc output (`npm run start:dev`), Node 24 loads the package's `.ts`
  sources itself (type stripping) — the reason for `"type": "module"` and `.ts` relative imports.
- `server/tsconfig.json` sets `rewriteRelativeImportExtensions` so tsc accepts the `.ts` imports.
- jest: the package sources are ESM, which the CommonJS jest runtime cannot run, so
  `server/package.json`'s jest `transform` sends `packages/*/src/**/*.ts` through
  `server/jest-ts-cjs-transform.cjs` (`ts.transpileModule` to CommonJS, no type check).
- `npm run build`: ncc bundles the package into `dist/index.js`. Because the package widens the
  common root of the compiled `.ts`, ncc emits its `.d.ts` leftovers under `dist/server/` and
  `dist/packages/`; the postclean in `scripts/build-assets.js` removes them (with `dist/src`,
  `dist/test`).

## Client

- Not a bun dependency — bun fails to link a `file:` dependency on Windows. Instead an alias
  `@loghub/<name>` → `../packages/<name>/src/index.ts` in `client/vite.config.ts`
  (`resolve.alias`, also used by Vitest) and `client/tsconfig.json` (`paths`; its `include` also
  lists `../packages/<name>/src`).
- `server.fs.allow` in `client/vite.config.ts` adds `../packages` so the Vite dev server may serve
  files outside `client/`.
- **`@loghub/user-docs` is an alias, not a package.** It points at the repo-root `user-docs/`
  folder (the shared user documentation, see [user-docs-and-site.md](user-docs-and-site.md)) so
  the client can `import nav from '@loghub/user-docs/nav.json'` for the help menu. Wired the same
  way: `resolve.alias` `'@loghub/user-docs'` → `../user-docs` and `server.fs.allow` `../user-docs`
  in `client/vite.config.ts`; `paths` `"@loghub/user-docs/*": ["../user-docs/*"]` and `include`
  `"../user-docs/nav.json"` in `client/tsconfig.json` (`resolveJsonModule` is on). It has no
  `package.json`, no server side and no Docker `COPY packages/` entry — the client-build stage
  copies `user-docs/` itself. `tests/tsconfig.json` has no `paths`, so tests never import
  `help/articles/index.ts`; they read the nav through `tests/scenarios/helpers/help-nav.ts`.

## Docker

The `client-build` and `server-build` stages of the root `Dockerfile` both `COPY packages/
/app/packages/` before copying their own folder.

## Rules

- Pure TypeScript only: no dependencies, no Node or DOM APIs — it runs in the browser bundle and
  in the server.
- Erasable syntax only (no `enum`, `namespace`, parameter properties): Node's type stripping
  rejects anything else at runtime.
- **Parser-backed packages use structural types.** A package whose logic walks the output of a
  native/WASM runtime (`@loghub/bash-view` and `web-tree-sitter`) must not import that runtime —
  it would become a dependency, pull the WASM into whichever side imports the package and tie
  both sides to one loading mechanism. Instead the package declares the minimal structural
  interfaces it needs (`src/syntax.ts`: the node fields and methods it actually calls, a
  `BashParser` interface with `parse` / `highlight`) and takes the parser as a parameter. Each
  side loads the runtime its own way (client: dynamic `import()` and Vite `?url` WASM assets;
  server: the CJS export plus WASM files from `dist/wasm/` or `node_modules`) and passes an
  object that satisfies the interface; the runtime's real classes match it structurally, so no
  adapter is needed. When the package starts using a new node member, add it to the structural
  type — both typechecks then verify each loader still satisfies it.
- Relative imports end in `.ts`.
- Type errors surface through `bun run typecheck` (client) and `npm run typecheck` (server); there
  is no separate package check. Behaviour is tested through the server/client algorithm tests of
  the relevant `docs/knowledgebase/algorithms/` doc (test policy in `CLAUDE.md`).

## Adding a package

1. Create `packages/<name>/` with `package.json`, `tsconfig.json`, `src/index.ts` and a short
   `README.md`, copying `packages/pricing/`.
2. Server: add `"@loghub/<name>": "file:../packages/<name>"` to `server/package.json` and run
   `npm install` in `server/` (updates `package-lock.json`). The jest transform pattern already
   matches every `packages/*/src`.
3. Client: add the alias to `client/vite.config.ts` and `client/tsconfig.json` (`paths` and
   `include`). `server.fs.allow` already covers all of `packages/`.
4. Docker: nothing to change — the whole `packages/` folder is copied. (A runtime the package
   needs at run time — e.g. the `tree-sitter-bash` WASM files for `@loghub/bash-view` on the
   server — is a dependency of the consuming side, shipped by that side: `scripts/copy-wasm.js`
   copies them to `dist/wasm/`, and the Dockerfile and the scenario stand do the same.)
5. Add a row to the table above.
