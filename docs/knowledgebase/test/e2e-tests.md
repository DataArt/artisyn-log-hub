---
type: Test Suite
title: Legacy E2E Tests (Playwright, tests/e2e)
description: The remaining Playwright specs in tests/e2e that drive the running dev app (UI + API + dev DB) and are not yet replaced by scenarios; storageState auth reuse, self-owned seed data, @core/extended split. New browser tests go to the scenario suite instead.
resource: playwright.config.ts
tags: [testing, e2e, playwright, browser, integration, legacy]
timestamp: 2026-10-16T00:00:00Z
---

**This is the legacy browser suite.** User flows now live in the scenario suite
([scenarios.md](./scenarios.md)), which builds its own isolated stand per auth mode. Specs in
`tests/e2e/` were deleted as soon as a green scenario listed them in its `Replaces:` comment; what
remains covers screens and depth no scenario owns yet. **Do not add new specs here** — write a
scenario. When the last spec goes, `tests/e2e/`, `playwright.config.ts`, the `test:e2e` scripts and
the `e2e-fast`/`e2e-full` health checks go with it.

As of 2026-10-16: **12 spec files, 90 tests** in the full suite, 27 tagged `@core`.

| Spec | Covers |
|---|---|
| `admin-model-pricing.spec.ts` | admin Model Pricing tab |
| `admin-panel.spec.ts` | admin panel tabs, System Info |
| `admin-releases.spec.ts` | admin Releases tab |
| `api-keys.spec.ts` | API keys page, "Give Me String" install flow |
| `change-surface-tab.spec.ts` | session Change surface tab |
| `harness-usage-tab.spec.ts`, `harness-usage.spec.ts` | Harness usage tab and analytics |
| `help-modal.spec.ts` | help modal |
| `repo-file-categories.spec.ts` | repo settings → File Categories |
| `repo-panel.spec.ts` | repository view routes, left nav, back/forward, favorites, URL-driven session pane |
| `reports-tab.spec.ts` | Reports tab, PDF export text |
| `session-log-view.spec.ts` | session log view, workflow agent visibility, Charts sub-tabs |

# How to run

From the repo root (see [overview.md](./overview.md) for the full command table):

```sh
npm run test:e2e        # playwright test --project=core     (fast @core loop, < 3 min)
npm run test:e2e:full   # playwright test --project=extended (all tests)
```

The suite does **not** start anything: it drives the dev backend on `:3000` (`npm run start:dev`
from `server/`) through the Vite client on `:5173` (`bun run dev` from `client/`), and its DB helper
talks to the same dev database. Do not use `npx playwright test`. Do not run it together with the
server tests, the contract suite or `npm run build` (all in the `app` health-check group).

Not to be confused with the server suite's `*.e2e-spec.ts` files: those are Jest + supertest API
tests in `server/test/` ([server-tests.md](./server-tests.md)).

# Config & projects (`playwright.config.ts`)

- `testDir: './tests/e2e'`, `fullyParallel: true`, `workers: process.env.CI ? 2 : 4`.
- Projects: `setup` (runs `tests/e2e/global.setup.ts`, authenticates each role and writes
  storageState); `core` (`dependencies: ['setup']`, `grep: /@core/`); `extended` (everything).
- `globalSetup` → `tests/e2e/global-setup.ts` (run lock, run id, sweep, detected `AUTH_MODE`,
  "Skipped scenarios" summary from `helpers/skipped-scenarios.ts`); `globalTeardown` →
  `tests/e2e/global-teardown.ts` (sweep, release the lock).
- The scenario suite has its own config, `playwright.scenarios.config.ts`; the two never share
  projects.

# Run isolation

- **FS run lock** (`helpers/run-lock.ts`): an atomic `fs.mkdir` mutex serialises whole runs and
  steals a stale lock after 15 minutes.
- **Per-run UUID** written to a gitignored run-id file and read by workers.
- **Backstop sweep** (`helpers/sweep.ts`): `sweepE2eRepos()` deletes every repo whose URL starts
  with `E2E_REPO_PREFIX`; `sweepE2eApiKeys()` deletes each e2e role's own keys named with
  `E2E_API_KEY_PREFIX`. Both clean up after killed runs.

# Auth reuse

Roles live in `helpers/credentials.ts` (`ROLES`, `storageStatePath(role)`). The `setup` project
signs each role in once (`helpers/auth.ts`: `ensureUser`, `establishSession`, `identifyUser` for
auth mode `none`) and saves `tests/e2e/.auth/<role>.json`. Specs use
`test.use({ storageState: storageStatePath('primary') })`. Real login/signup UI flows are covered by
the `tests/scenarios/auth/` scenarios, not here.

# Self-owned seed data

Every spec seeds its **own** repo through `helpers/seed.ts` → `seedRepoWithSessions(request, {
role, specSlug, sessions })`, which ensures the role user and an API key, uploads NDJSON to
`POST /api/v2/logs` with run-time-relative timestamps, waits for the upload queue
(`waitForUploadQueueDrained` in `helpers/db.ts`) and returns `{ repoId, repoUrl, apiKey, apiKeyId,
sessionIds, cleanup }`. Repo URLs are unique per run, spec and worker (`helpers/repo-url.ts`).

- **Every spec calls `cleanup()` in `afterAll`.** It deletes the seeded API key and the repo
  (admin `DELETE /api/v1/admin/repos/:id` hard-deletes the whole session family).
- Rows ingest derives elsewhere are yours to delete (e.g. `deleteModelPricing(model)` for a
  made-up model id).
- `purgeSessions: true` soft-deletes each session; use it only with run-unique session ids.

# Helpers (`tests/e2e/helpers/`)

| File | Exports |
|---|---|
| `credentials.ts` | `ROLES`, `E2E_REPO_PREFIX`, `E2E_API_KEY_PREFIX`, `BASE_URL`, `storageStatePath(role)` |
| `auth.ts` | `login`, `establishSession`, `identifyUser`, `ensureUser` |
| `auth-mode.ts` | `detectAuthMode`, `authMode`, `isNoAuthMode` |
| `seed.ts` | `seedRepoWithSessions(...)` → seeded repo + `cleanup()` |
| `db.ts` | raw-SQL helpers: `insertUnpricedModel`, `deleteModelPricing`, `waitForUploadQueueDrained`, token and user helpers |
| `notice-hash.ts` | data-collection notice hash and consent setting |
| `pdf-text.ts` | `extractPdfText`, `countMatches` (report PDF checks) |
| `mailpit.ts` | `isMailpitReachable` (used by the global setup probe) |
| `skipped-scenarios.ts` | the "Skipped scenarios" summary lines |
| `sweep.ts`, `run-lock.ts`, `repo-url.ts` | run isolation (above) |

# `@core` tagging

Put `@core` in a test title to include it in the fast loop: one happy path per remaining screen.
Depth variants stay untagged and run in `extended`.
