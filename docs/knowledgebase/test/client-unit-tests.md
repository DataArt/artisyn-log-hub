---
type: Test Suite
title: Client Unit Tests (Vitest)
description: What is left of the client vitest suite after the 2026-10-16 cut — only the doc-driven algorithm tests (*.algo.test.ts); runner config and the shared setup files.
resource: client/vite.config.ts
tags: [testing, client, vitest, algorithms]
timestamp: 2026-10-16T00:00:00Z
---

**Policy (2026-10-16): the client has no component or logic unit tests any more** — everything in
`src/viewer/__tests__/components/` and `src/viewer/__tests__/unit/` was deleted. User-visible client
behaviour is covered by the scenario suite and its screen tours ([scenarios.md](./scenarios.md)).
Client code a scenario does not reach is either a missing scenario or dead code — target
**≥ 80 % coverage from scenarios**.

What stays: **3 `*.algo.test.ts`** co-located with the code (`lib/format.algo.test.ts`,
`lib/change-surface-ui.algo.test.ts`, `pages/repository/analytics/cache-ratio-aggregate.algo.test.ts`).
Each loads the examples block of its doc in `docs/knowledgebase/algorithms/` through
`scripts/algo-docs/load-examples.cjs` and runs every row against the real code. Change the doc row,
not the test. **Do not add other client tests.**

# How to run

From `client/`:

```sh
bun run test         # vitest run
bun run typecheck    # the only type check for the client (vite build does not typecheck)
```

Do not use `npx vitest`.

# Runner & config

The `test` block of `client/vite.config.ts`: `globals: true`, `environment: 'node'`,
`setupFiles` `src/test/setup.ts` + `src/viewer/__tests__/setup-vitest.ts` (jest-dom matchers and
`setupBrowserGlobals()` from `__tests__/test-utils.ts`), `include` `src/**/*.{test,spec}.{ts,tsx}`,
`passWithNoTests: true`.

The tab ids in `src/viewer/tab-ids.ts` and the route constants in `src/app-routes.ts` are still the
addresses the screen tours use (`tests/scenarios/tours/tour-10-registry.spec.ts` checks the screen
registry against `APP_ROUTES`); their former vitest meta-tests are gone.
