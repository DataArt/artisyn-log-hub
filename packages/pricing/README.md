# @loghub/pricing

Repo-local package with the LLM pricing math shared by the Log Hub server and client. It is
never published; both sides consume its TypeScript sources directly.

| Module | Contents |
|---|---|
| `src/cost.ts` | `computeCostBreakdown` — the cost formula (aggregate, and per call with prompt-length tiers), `pickCallRates`, `promptTokens`, `FAST_MODE_MULTIPLIER`, the `CallTokens` / `CostTokens` / `CostRates` / `CostTerms` / `CostBreakdown` types |
| `src/tiers.ts` | `PricingTier`, `validatePricingTiers` (its texts are shown as is in the admin dialog and in the API's 400), `normalizeTiers`, `tiersEqual`, `crossedTiers` (the tiers a call steps into when the prompt grows from the previous call's), `isValidRate`, `round6`, `MAX_RATE`, `MAX_PRICING_TIERS`, `MAX_TIER_THRESHOLD` |

The hook (`hook/`) does not use this package: it is plain CommonJS installed into user repos, so
it keeps its own copy (`computeLocalSessionCost`), checked against the same examples table
(`docs/knowledgebase/algorithms/cost-formula.md`).

## How it is wired

- **Server** — a `file:../packages/pricing` dependency in `server/package.json` (npm links it into
  `server/node_modules`).
  - tsc and nest treat it as an external library: it is not emitted into `server/dist`.
  - At runtime, Node 24 loads the `.ts` sources itself (type stripping). That is why the package is
    `"type": "module"` and its relative imports carry the `.ts` extension.
  - `server/tsconfig.json` sets `rewriteRelativeImportExtensions` so tsc accepts those imports.
  - jest transpiles the package to CommonJS with `server/jest-ts-cjs-transform.cjs`.
  - ncc bundles it into `dist/index.js`.
- **Client** — an alias in `client/vite.config.ts` and `client/tsconfig.json` (`paths`). It is not
  a bun dependency: bun cannot link a `file:` dependency on Windows. `server.fs.allow` lets the
  Vite dev server serve the files. Vitest uses the same alias.
- **Docker** — the client and server build stages `COPY packages/` next to their own folder.

## Rules

- Pure TypeScript only: no dependencies, no Node or DOM APIs. Both a browser bundle and the
  server load it.
- Erasable syntax only (no `enum`, `namespace` or parameter properties). Node's type stripping
  rejects anything else at runtime.
- Relative imports end in `.ts`.
- Its type errors surface through `bun run typecheck` (client, which includes `src/`) and
  `npm run typecheck` (server). Its behaviour is covered by the server and client algorithm tests
  of `cost-formula.md`, which run through it.
