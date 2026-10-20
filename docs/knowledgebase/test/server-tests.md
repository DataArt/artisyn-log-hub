---
type: Test Suite
title: Server Tests (Jest, algorithm tests only)
description: What is left of the server jest suite after the 2026-10-16 cut — only doc-driven algorithm tests (*.algo.spec.ts) plus the migration lock check; no global setup, no DB; helpers still used by the contract suite.
resource: server/package.json
tags: [testing, server, jest, algorithms]
timestamp: 2026-10-16T00:00:00Z
---

**Policy (2026-10-16): the server has no behaviour/integration jest tests any more.** All
`*.e2e-spec.ts` and every non-algorithm `*.spec.ts` were deleted. Server behaviour is covered by the
scenario suite ([scenarios.md](./scenarios.md)) and API-vs-DB agreement by the contract suite
([contract-tests.md](./contract-tests.md)). If a scenario does not reach some server code, either a
scenario is missing or the code is not needed — the target is **≥ 80 % coverage from scenarios**.

What stays in `npm run test`:

- **12 `*.algo.spec.ts`** next to the code — table tests that read their rows from the examples
  block of a doc in `docs/knowledgebase/algorithms/` (one jest test per doc row, ~565 in total).
  Change the doc row, not the test. See [../algorithms/README.md](../algorithms/README.md).
- `src/database/migration-lock-check.spec.ts` — the startup half of the migration immutability guard
  (see [../db-schema-code.md](../db-schema-code.md)).

**Do not add new `*.spec.ts` / `*.e2e-spec.ts`.** A new algorithm gets a doc + `*.algo.spec.ts`;
anything else gets a scenario or a contract registry row.

# How to run

From `server/`:

```sh
npm run test            # jest --runInBand
npm run test:contract   # the separate contract project (contract-tests.md)
```

Always via `npm run test` — never `npx jest` or bare `jest`.

# Runner & config

The `jest` block of `server/package.json`: `testRegex` `.*\.spec\.ts---
type: Test Suite
title: Server Tests (Jest, algorithm tests only)
description: What is left of the server jest suite after the 2026-10-16 cut — only doc-driven algorithm tests (*.algo.spec.ts) plus the migration lock check; no global setup, no DB; helpers still used by the contract suite.
resource: server/package.json
tags: [testing, server, jest, algorithms]
timestamp: 2026-10-16T00:00:00Z
---

**Policy (2026-10-16): the server has no behaviour/integration jest tests any more.** All
`*.e2e-spec.ts` and every non-algorithm `*.spec.ts` were deleted. Server behaviour is covered by the
scenario suite ([scenarios.md](./scenarios.md)) and API-vs-DB agreement by the contract suite
([contract-tests.md](./contract-tests.md)). If a scenario does not reach some server code, either a
scenario is missing or the code is not needed — the target is **≥ 80 % coverage from scenarios**.

What stays in `npm run test`:

- **12 `*.algo.spec.ts`** next to the code — table tests that read their rows from the examples
  block of a doc in `docs/knowledgebase/algorithms/` (one jest test per doc row, ~565 in total).
  Change the doc row, not the test. See [../algorithms/README.md](../algorithms/README.md).
- `src/database/migration-lock-check.spec.ts` — the startup half of the migration immutability guard
  (see [../db-schema-code.md](../db-schema-code.md)).

**Do not add new `*.spec.ts` / `*.e2e-spec.ts`.** A new algorithm gets a doc + `*.algo.spec.ts`;
anything else gets a scenario or a contract registry row.

# How to run

From `server/`:

```sh
npm run test            # jest --runInBand
npm run test:contract   # the separate contract project (contract-tests.md)
```

Always via `npm run test` — never `npx jest` or bare `jest`.

# Runner & config

, `ts-jest`,
`testEnvironment: node`, **no `globalSetup`** — the run needs no Postgres, no schema and no app
(~2 s), so `server-unit` is a `static` health check.

`jest.contract.config.js` runs the contract suite; `jest.stryker.config.js` is for mutation runs
over `src/**/*.spec.ts`.

`server/test/` now holds only the contract suite (`test/contract/`, which extends this config with
its own global setup) and the two helpers it imports (`helpers/create-app.helper.ts`,
`helpers/env-snapshot.helper.ts`). The former shared e2e setup (`test/setup/`) and its helpers were
deleted on 2026-10-16.
