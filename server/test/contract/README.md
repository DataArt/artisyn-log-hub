# API <-> DB contract suite

Every HTTP route of the server has at least one row in a data registry that says: who calls it,
on which fixture, which independent SQL proves the answer, and how each response field maps onto
a column. One shared routine (`run-case.ts`) calls the route and compares the answer with what a
separate `pg` client reads from the same schema. A meta-test fails as soon as a route exists in
the router but not in the registry, or the other way round.

Design: `docs/qaa-overview/scenarios/05-api-db-contract.md`.

## Running

```sh
cd server
npm run test:contract        # jest -c jest.contract.config.js --runInBand
```

Needs Postgres. The database URL is, in this order: `TEST_DATABASE_URL` from the caller's
environment, then `DATABASE_URL` from the caller's environment
(`npm run test:scenarios -- --only contract` from the repo root passes the runner's), then
`DATABASE_URL` from `server/.env`. A Claude sandbox sets `TEST_DATABASE_URL` to its own test DB so
contract schemas never land in its live dev DB (`docs/knowledgebase/docker-dev-container.md`). It needs
neither the dev server nor Mailpit. The main `npm run test` never picks these specs up: their
names end in `.contract-spec.ts`, which the main jest `testRegex` does not match.

It shares Postgres with the server tests and the e2e suites, so it runs serially with them
(health check `contract`, group `app`).

## Layout

| Path | What it is |
|---|---|
| `../../jest.contract.config.js` | the jest project: `testRegex: test/contract/.*\.contract-spec\.ts$`, own global setup/teardown |
| `setup/global-setup.ts` | fresh `contract_<uuid>` schema, migrations, world-v1, one app on a free port (`CONTRACT_BASE_URL`); temp dirs for releases / upload queue / export-import |
| `setup/global-teardown.ts` | closes the app, removes the temp dirs, drops the schema |
| `fixtures/world-v1.sql.ts` | the deterministic world: raw SQL, explicit ids, fixed dates, sequences moved to 1000; `WORLD_V1` (ids) and `WORLD_V1_REFS` (`@ref` names) |
| `oracle.ts` | the independent SQL oracle: `pg.Pool` with `search_path` = the contract schema only, `q(sql, args)`, schema checksums, table snapshots |
| `types.ts` | the registry row format (`ContractCase`, `ReadSpec`, `WriteSpec`, `FieldMap`) |
| `run-case.ts` | `runCase(row, ctx)`, `ContractContext` (one real login per actor), `callable()`, `resetWorld()` |
| `registry/index.ts` | collects the families: `FAMILIES`, `casesOf()`, `registryRoutes()` |
| `registry/f<NN>-<family>.ts` | one family's rows (F01-F23) |
| `registry/oracle-sql.ts` | shared hand-written SQL: session cost (own / with sub-agents), the listed root sessions of a repository, ISO timestamps for jsonb |
| `f<NN>.contract-spec.ts` | one `it.each` per family |
| `routes.contract-spec.ts` | the meta-test: router (Nest metadata and the Express 5 stack) vs registry |

## Ground rules

- **No imports from `src/**`** in `oracle.ts`, `fixtures/**` and `registry/**` (types excepted).
  The oracle is raw SQL written by hand, never drizzle and never service code — otherwise the
  test and the code can agree on the same mistake.
- **Write the SQL differently from the app.** Plain `count(*)` sub-queries, one `SELECT` per
  metric, no copy of the service's CTE. Copying the service's SQL turns the row into a tautology.
- **World data only through `world-v1.sql.ts`.** A row never seeds data through the API. When a
  family needs more data, extend the world (new ids below 1000, keep existing ids stable) and
  re-run the whole suite: other rows may count the same tables.
- **Ids above 1000 are the API's.** After loading, every sequence is at 1000, so anything a call
  creates is easy to tell from the world.
- **Every row sees world-v1.** A write row reloads the world before it runs, and the row after a
  write row (in any spec file) reloads it again, so no row ever depends on the order of others.
  A reload is ~75 ms (DELETEs in foreign-key order).
- **No background job writes during a run.** The global setup parks the upload-queue worker and
  the export/import and advisor-orphan sweeps. `POST /api/v2/logs` is therefore checked as what
  the request itself writes (one `pending` queue row); what the worker makes of it is the ingest
  scenarios' business.
- **A disagreement with the design is pinned, not hidden.** When the code's answer differs from
  05 or from a sibling endpoint and the fix is out of scope, the row fixes today's behaviour with
  a `KNOWN DISCREPANCY` comment (list: docs/knowledgebase/test/contract-tests.md).

## Adding a family or a registry row

### A row

1. Open the family file `registry/f<NN>-<family>.ts` and append a `ContractCase`:

   ```ts
   {
     id: 'F04-list',                          // unique; the test title
     route: 'GET /api/v1/api-keys',           // METHOD + path exactly as the router declares it
     actor: 'owner',                          // admin | owner | member | outsider | author | manager
                                              // | ownerKey | memberKey | authorKey | anon
     expect: { status: 200, minRows: 2 },     // minRows: the fixture really exercises the route
     read: {
       sql: `SELECT id, name, slug, created_at, expires_at
               FROM api_keys WHERE user_id = $1 ORDER BY id`,
       args: ['@owner.id'],                   // @refs: see WORLD_V1_REFS
       shape: 'array',                        // array | object | map
       fields: {                              // response key -> column
         id: 'id', name: 'name', slug: 'slug',
         created_at: { col: 'created_at', as: 'iso' },
         expires_at: { col: 'expires_at', as: 'iso?' },
       },
       strict: true,                          // no extra keys (catches a leaked key_hash)
     },
   }
   ```

2. Pick exactly one oracle:
   - `read` — the answer equals the SQL (`shape`, `fields`, optional `path`, `sortBy`, `ignore`).
     `path` may index arrays (`'1.costBreakdown'`, `'sections.0.rows'`). A plain-value array
     (`string[]`) uses `scalar: '<col>'` (+ `unordered: true` when the endpoint has no ORDER BY).
     A golden constant is a read whose SQL is a `VALUES` list (05 §2.2: answer, golden and SQL
     formula must all agree — see F17/F21);
   - `write` — `watch` tables are snapshotted before and after; `delta.inserted` / `updated` /
     `deleted` must account for every change in them, and every other table must stay unchanged.
     `where`/`check` SQL may use `@ref` (world value) and `$field` (top-level response field);
     `argon2verify(col, $field)` checks a hash. A write row reloads world-v1 first. Extras:
     `after: ['<boolean SQL>']` for values that cannot be spelled out (a fresh hash, a `now()`
     stamp — write a `$` inside a string literal as `_` in LIKE or `chr(36)`); `keys` gives the
     row identity of a watched table without a primary key (`repo_config`, otherwise an UPDATE
     reads as delete + insert); `derived: [...]` names tables the call recomputes (per-session
     stats) — they may change, all other unwatched tables may not;
   - `noDb` — a file/env/static route: the whole schema is unchanged;
   - nothing — only for negative rows (status >= 400), which always get the unchanged-schema check;
   - `sameExpectedAs: '<id>'` — a report twin compared answer-to-answer with another row.

   Row-level extras: `expect.bodyMatches` (top-level keys deep-equal, for golden values and error
   codes), `expect.bodyText` (a file download, byte for byte), `freshSession: true` (the row ends
   or opens a session — logout, login, delete-account — so the actor logs in afresh and the agent
   is dropped afterwards), `settle: { until: '<boolean SQL>' }` (wait for a background job the
   call started, e.g. an export, before the "after" snapshot).
3. A route that cannot have a contract check at all is still listed, explicitly:
   `{ id: 'F03-azure-callback', route: 'GET /api/auth/callback', kind: 'excluded', reason: 'needs real Azure' }`.
4. Run `npm run test:contract`. A failing row prints its id, route, actor and every
   response-vs-SQL difference.

Add rows per role only where access or data differ (05 §2.6): an outsider's 403, a manager's
masked `firstPrompt`, a member's view of a team repository.

### A family

1. Create `registry/f<NN>-<family>.ts`:

   ```ts
   import type { ContractFamily } from '../types';

   export const f04ApiKeys: ContractFamily = {
     id: 'F04',
     name: 'api-keys',
     cases: [ /* rows */ ],
   };
   ```

2. Register it in `registry/index.ts` (import + an entry in `FAMILIES`, in F-number order).
3. Create its spec `f<NN>.contract-spec.ts`:

   ```ts
   import { closeOracle } from './oracle';
   import { casesOf } from './registry';
   import { ContractContext, callable, runCase } from './run-case';

   describe('contract F04 api-keys', () => {
     const ctx = new ContractContext();
     afterAll(() => closeOracle());
     it.each(callable(casesOf('F04')))('$id', (c) => runCase(c, ctx));
   });
   ```

4. Run `npm run test:contract`: the family passes and the meta-test no longer lists its routes.

## The meta-test

`routes.contract-spec.ts` boots a private copy of the app in its worker and lists the routes
twice — from Nest metadata (`DiscoveryService` + `MetadataScanner`) and from the Express 5 router
stack — then checks: both lists agree; every router route has a registry row; every registry row
names a live route; every row is well-formed. The number of routes is never hard-coded. The only
non-controller route it ignores is the `ServeStaticModule` SPA fallback (`NON_CONTROLLER_ROUTES`).
