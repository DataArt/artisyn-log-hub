# @loghub/recommendations

Repo-local package with the startup context recommendations shown in the session's System context
anatomy tab: a static catalog of what loads into a Claude Code session at start (tools, MCP
servers, skills, memory, instruction files, subagent types), who controls each group and how to
switch it off, plus the matcher that turns one session's startup facts into rows. It is never
published; the client consumes its TypeScript sources directly. Algorithm doc:
`docs/knowledgebase/algorithms/startup-recommendations.md`.

| Module | Contents |
|---|---|
| `src/types.ts` | The input/output contract: `Controller`, `StartupFacts`, `StartupMcpServer`, `MatchedItem`, `CatalogEntry`, `RecommendationRow` |
| `src/catalog.ts` | `CATALOG` (entries in display order, ids `startup.<slug>`), `CATALOG_VERSION`, the Claude Code docs links of each entry — the only file to edit when adding an entry |
| `src/match.ts` | `matchRecommendations(facts, catalog = CATALOG)` — one row per matched entry, catalog order |

## The input stays outside

The package never imports client types. The client builds `StartupFacts` from the anatomy, the
harness snapshot and the main log lines (`buildStartupFacts` in
`client/src/viewer/pages/repository/session-log/sysctx-anatomy/startup-facts.ts`) and passes them
in. A missing data source (old hook, old Claude Code) gives an empty or `null` facts field, so the
entry simply does not match.

## How it is wired

Like `@loghub/bash-view` on the client side (see `packages/pricing/README.md`):

- **Client** — an alias in `client/vite.config.ts` and `client/tsconfig.json` (`paths` and
  `include`); not a bun dependency.
- **Server** — not wired yet; a `file:../packages/recommendations` dependency is added once the
  server needs it.

## Rules

- Pure TypeScript only: no dependencies, no Node or DOM APIs.
- Erasable syntax only (no `enum`, `namespace` or parameter properties).
- Relative imports end in `.ts`.
- Entry ids are stable and never reused.
- Its type errors surface through `bun run typecheck` (client). Its behaviour is covered by the
  algorithm test of `startup-recommendations.md` (client).
