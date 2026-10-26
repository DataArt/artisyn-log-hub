---
type: "Reference"
title: "Repo-Local Packages (packages/)"
description: "The packages/ folder convention for TypeScript code shared by server and client (today only @loghub/pricing): how the server consumes it (file: link, Node 24 type stripping, jest transform, ncc), how the client consumes it (Vite/tsconfig alias), Docker, the rules a package must follow, and how to add one."
tags:
  - server
  - client
  - build
  - pricing
timestamp: "2026-10-26T12:00:00+04:00"
---

# Repo-Local Packages (`packages/`)

`packages/<name>/` holds pure TypeScript shared by the server and the client, so a piece of logic
exists once instead of as hand-kept twins. The packages are never published; both sides consume
their `.ts` sources directly.

| Package | Contents | Details |
|---|---|---|
| `@loghub/pricing` (`packages/pricing/`) | The LLM cost formula (`src/cost.ts`: `computeCostBreakdown`, `pickCallRates`, `FAST_MODE_MULTIPLIER`, …) and pricing-tier validation (`src/tiers.ts`: `validatePricingTiers`, `normalizeTiers`, `MAX_*`, `PricingTier`, …) | [packages/pricing/README.md](../../packages/pricing/README.md), [algorithms/cost-formula.md](algorithms/cost-formula.md) |

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

## Docker

The `client-build` and `server-build` stages of the root `Dockerfile` both `COPY packages/
/app/packages/` before copying their own folder.

## Rules

- Pure TypeScript only: no dependencies, no Node or DOM APIs — it runs in the browser bundle and
  in the server.
- Erasable syntax only (no `enum`, `namespace`, parameter properties): Node's type stripping
  rejects anything else at runtime.
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
4. Docker: nothing to change — the whole `packages/` folder is copied.
5. Add a row to the table above.
