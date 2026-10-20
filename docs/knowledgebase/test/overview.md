---
type: Test Strategy
title: Test Strategy Overview
description: The test suites of this repo — scenarios on an isolated stand, API vs DB contracts, doc-driven algorithm units (the only unit tests left, since 2026-10-16), the legacy tests/e2e remainder — the canonical commands and health checks, the shared-DB rule, the 80 % scenario-coverage target and where a new test belongs.
tags: [testing, strategy, overview]
timestamp: 2026-10-16T00:00:00Z
---

The repo's tests are organised around **user scenarios on an isolated stand**. The scenario suite
covers user-visible behaviour end to end; contracts pin API rows against SQL; algorithms a person
can check on paper get doc-driven table tests. **Those are the only unit tests**: on 2026-10-16 every
other server, client, hook and installer unit / `*.e2e-spec.ts` test was deleted. Target:
**≥ 80 % coverage from scenarios** — code a scenario does not reach is a missing scenario or dead
code. Start here, then open the suite you need:

| Suite | Runner | Where | KB |
|---|---|---|---|
| **Scenarios** (P0 user scenarios, screen tours, corpus) | Playwright on its own stand, auth modes A/B/C | `tests/scenarios/`, `tests/golden/`, `tests/corpus/` | [scenarios.md](./scenarios.md) |
| **API vs DB contracts** | Jest, own app and `contract_*` schema | `server/test/contract/` | [contract-tests.md](./contract-tests.md) |
| **Algorithm units** (doc examples = test rows) | jest / vitest / `node --test` | `*.algo.spec.ts`, `*.algo.test.ts` next to the code | [../algorithms/README.md](../algorithms/README.md) |
| Server jest runner (algorithm tests + migration lock check, no DB) | Jest | `server/src/**` | [server-tests.md](./server-tests.md) |
| Client vitest runner (algorithm tests) | Vitest | `client/src/**` | [client-unit-tests.md](./client-unit-tests.md) |
| Hook `node:test` runner (algorithm tests) | `node --test` | `hook/.claude/telemetry_tool/__tests__/` | below |
| **Legacy e2e** (specs not yet replaced by scenarios) | Playwright against the running dev app | `tests/e2e/` | [e2e-tests.md](./e2e-tests.md) |
| Manual pre-prod run | `/big-prod-e2e-test` skill | `.claude/skills/big-prod-e2e-test/` | [big-prod-e2e-test.md](./big-prod-e2e-test.md) |

Never add another unit, component or `*.e2e-spec.ts` test in any package (CLAUDE.md → "Test
policy"); `tests/e2e/` is legacy and takes no new specs either.

For contributors, [tests/README.md](../../../tests/README.md) and
[tests/scenarios/README.md](../../../tests/scenarios/README.md) are the public, self-contained guides:
environment (Postgres, Mailpit, `bun`, ports), the `AUTH_MODE` matrix, and how to run each suite.

# Canonical commands

These are the ONLY approved commands. The source of truth is
`.claude/repo_config/repo-health-checks.json`; [CLAUDE.md → "Test & build commands (canonical)"](../../../CLAUDE.md)
and this table mirror it.

| Purpose | Command | Run from | Health check |
|---|---|---|---|
| Build (all packages → `dist/`) | `npm run build` | repo root | `build` |
| Client lint | `bun run lint` | `client/` | `client-lint` |
| Client typecheck (tsc) | `bun run typecheck` | `client/` | `client-typecheck` |
| Client algorithm tests (Vitest) | `bun run test` | `client/` | `client-unit` |
| Server lint | `npm run lint` | `server/` | `server-lint` |
| Server typecheck (tsc) | `npm run typecheck` | `server/` | `server-typecheck` |
| Server algorithm tests (Jest, no DB) | `npm run test` | `server/` | `server-unit` |
| API vs DB contracts | `npm run test:contract` | `server/` | `contract` |
| Build-script tests (`node --test`) | `npm run test:scripts` | repo root | `scripts-unit` |
| Tests typecheck (tsc over `tests/`) | `npm run typecheck:tests` | repo root | `tests-typecheck` |
| Hook algorithm tests | `npm test` | `hook/` | `hook-tests` |
| Scenarios, mode A (`none`) + corpus | `npm run test:scenarios -- --mode a --only scenarios,corpus` | repo root | `scenarios-a` |
| Scenarios, mode B (`password-confirm`) | `npm run test:scenarios -- --mode b --only scenarios` | repo root | `scenarios-b` |
| Scenarios, mode C (`password`) | `npm run test:scenarios -- --mode c --only scenarios` | repo root | `scenarios-c` |
| Legacy e2e, fast `@core` loop | `npm run test:e2e` | repo root | `e2e-fast` |
| Legacy e2e, full | `npm run test:e2e:full` | repo root | `e2e-full` (final only) |

- **Fast set vs full set.** Every iteration (`finalRun: false`) runs the fast set: all `static`
  checks plus `build`. `contract`, `scenarios-a/b/c`, `e2e-fast` and `e2e-full` are
  `finalOnly` and run only in the final verification. While iterating, run just the touched
  scenario: `npm run test:scenarios -- --mode <a|b|c> --only scenarios --grep "<@S-TAG>"`.
- Never use `npx vitest`, `npx playwright test`, bare `jest`/`npx jest` or `ng lint`. The root
  `package.json` has no `lint`/`test` scripts — use the per-package commands above.
- Manual pipelines, not health checks: `npm run corpus:generate` (monthly corpus refresh, see
  [scenarios.md](./scenarios.md)) and `npm run corpus:bootstrap` (records and approves a local set;
  `tests/corpus/sets/` is gitignored and the corpus tests skip without a set).

# Shared resources

- The **contract suite**, the **scenario stand** and the **legacy e2e** use the same Postgres
  server. Contracts and scenarios each work in their own throwaway schema (`contract_*`, `scn_*`);
  the legacy e2e drives the dev app and the dev DB. They and the build are in the `app`
  health-check group, which runs them one at a time.
- `npm run build` rewrites `server/src/public/static/*`; the watched dev backend reloads on that,
  which drops the backend mid-run of a legacy e2e suite. The scenario stand is built into
  `tmp/scenarios/stand/` and never touches `server/src/public/static` or the dev DB (the runner
  fails the run if either changed).
- The `static` group (lint, typecheck, the server jest run, vitest, script and hook tests) needs no DB and no
  dev app and runs alongside the `app` group.

# The hook algorithm tests

The hook (`hook/`) is a standalone, dependency-free Node package. `npm test` (from `hook/`) runs
`node scripts/run-tests.js`, which collects `hook/.claude/telemetry_tool/__tests__/*.test.js` and
hands them to `node --test` (a glob given straight to `node --test` needs Node ≥ 21; the hook
supports Node ≥ 18.19). Only the three `*.algo.test.js` files remain (`cost-formula`, `work-time`,
`ndjson-tolerance`); doc rows marked server-only are skipped there by design.
`__tests__/test-helpers.js` stays because `tests/scenarios/helpers/hook-process.ts` uses it.

Hook and installer behaviour seen by a user (upload, state, compatibility with old hook versions,
install / upgrade / uninstall) is covered by `tests/scenarios/hook/` and
`tests/scenarios/installer/`. The installer package has no test suite of its own any more.

# Which suite should a test go in?

Only three kinds of tests exist (CLAUDE.md → "Test policy"); do not multiply them:

| You changed… | Test | Where |
|---|---|---|
| An algorithm that has a doc in `docs/knowledgebase/algorithms/` | Rows in that doc's examples block (the `*.algo.*` test reads them); a new test file only with a new doc | [../algorithms/README.md](../algorithms/README.md) |
| A route (new or changed response) | A contract registry row | [contract-tests.md](./contract-tests.md) |
| Behaviour (UI, API flow, hook, installer, schedulers, error paths) | A **step in an existing scenario**; a new scenario file only for a genuinely new feature (screen tours and golden sessions are scenarios too) | [scenarios.md](./scenarios.md) |

Anything a scenario cannot reach is a missing step or code that is not needed — never a unit test.

Do not add new specs to `tests/e2e/`: write a scenario instead.

# Related

- [../task-checks-guide.md](../task-checks-guide.md) — where tests fit in the task lifecycle and post-implementation checks
- [../api-reference.md](../api-reference.md) — endpoints exercised by the server, contract and scenario suites
- `docs/qaa-overview/13-new-test-suite.md` — design of the scenario-based suite
