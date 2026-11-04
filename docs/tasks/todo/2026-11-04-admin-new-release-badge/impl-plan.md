# Implementation plan — Admin New Release Notification

## TL;DR

- **New build artifact `dist/build.origin.json`** (`{branch, version, builtAt, officialRelease}`), written by a new shared helper `scripts/build-origin.js` (local `npm run build`, `build:serial`, the scenario stand) and by a `printf` in the `Dockerfile` runtime stage; only `release.yml` passes `OFFICIAL_RELEASE=true` and `GIT_BRANCH`.
- **`GET /health/version` extended additively** with an optional `origin` object (key omitted when the file is absent); new reader `readBuildOrigin()` in `server/src/common/build-info.ts`.
- **New server module `server/src/log-hub-release/`**: a scheduler plus a service that calls `https://api.github.com/repos/DataArt/artisyn-log-hub/releases/latest`. It runs only on an official build with a strict `X.Y.Z` version, uses a DB cluster claim, makes at most one attempt per 24 h, logs failures at `warn`, and is gated by the new env `LOG_HUB_RELEASE_CHECK_ENABLED`.
- **New admin-only endpoint `GET /api/v1/admin/log-hub-release`** (`SessionAuthGuard` + `AdminGuard`; 403 for team owners and users). "Update available" is computed **at read time** against the running version.
- **DB: one new single-row table `log_hub_release_check`** (hand-written additive migration, next free number).
- **Client**:
  - The top-nav build label gets a `Tooltip` (new `BuildLabel` component).
  - An admin-only `useLogHubRelease` query drives a dot on the "Admin Panel" left-nav entry (collapsed and expanded) and a non-dismissable banner above the Admin tabs.
- **Tests**:
  - Contract rows in `f01-infra.ts`.
  - Steps in `s-plat-01` and `s-adm-01`.
  - The scenario stand writes an *official* `build.origin.json`, and the release state is seeded in the DB, so the stand never contacts GitHub.

## Reference

Requirements: [requirements.md](D:/_work/Artisyn-LogHub/_repo/docs/tasks/todo/2026-11-04-admin-new-release-badge/requirements.md)
Research archive: `research/findings-1.md` (audit only).

## Design Decisions

### DD-1 — `build.origin.json` contract

Shape `{ "branch": string, "version": string, "builtAt": string, "officialRelease": boolean }`:
- `builtAt` is ISO 8601 UTC, taken at write time.
- An unknown string value is `"unknown"`.

It lives at `dist/build.origin.json`, next to `index.js`. It is outside `dist/public/`, so it is never served. `build-info.json` is unchanged.

### DD-2 — Writers

| Build | Writer | branch | version | officialRelease |
|---|---|---|---|---|
| `release.yml` image | `Dockerfile` runtime stage | `GIT_BRANCH` build-arg = `${{ github.ref_name }}` (`release`) | `VERSION` build-arg | `true` (build-arg `OFFICIAL_RELEASE=true`) |
| local `docker build`, `local-loghub.js`, `local-release-bundle.js` | `Dockerfile` | default `unknown` | `VERSION` (their own value) | default `false` |
| local `npm run build` / `build:serial` | `scripts/build-origin.js` | `git rev-parse --abbrev-ref HEAD`, else `unknown` | root `package.json` `version` | `false` |
| scenario stand (`build-stand.mjs`) | `scripts/build-origin.js` | `scenario-stand` | root `package.json` `version` | `true` (see DD-11) |

In the Dockerfile, `OFFICIAL_RELEASE` is normalised: exactly `true` becomes `true`, anything else becomes `false`. This keeps the JSON valid.

The Docker build stages run `ncc` and `cp` directly and never run `scripts/build-assets.js` (`Dockerfile` L28-44). The runtime-stage `printf` is therefore the only writer of the image's file, and it writes unconditionally.

`scripts/build-origin.js` writes a file only from its own CLI entry, guarded by `require.main === module`. Importing it has no side effects.

### DD-3 — `readBuildOrigin(): BuildOrigin | null`

It goes in `server/src/common/build-info.ts` and reads `path.join(__dirname, 'build.origin.json')`.
- In the ncc bundle `__dirname` is `dist/`. In dev (`server/src/common/`) the file is absent, which gives `null`.
- It returns `null` when the file is missing, unparseable or not an object. It never throws, and it is not cached (same as `readBuildInfo`).
- `branch`, `version` and `builtAt` go through the existing `pickString`.
- `officialRelease` is `parsed.officialRelease === true`.

### DD-4 — "Running version" and eligibility

The running version is `origin.version`.

The deployment is **eligible** when all three hold:
- `origin !== null`
- `origin.officialRelease === true`
- `isValidSemver(origin.version)`

`readBuildInfo().version` is not used, because both values come from the same `VERSION` build-arg in a release image.

### DD-5 — Table `log_hub_release_check`

One row, `id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1)`. The other columns are all nullable:

| Column | Type | Note |
|---|---|---|
| `latest_tag` | `varchar(64)` | last *validated* tag, e.g. `v1.3.0` |
| `release_url` | `text` | its validated `html_url` |
| `fetched_at` | `timestamptz` | last success |
| `last_attempt_at` | `timestamptz` | the cluster claim |

A new table is used rather than an `ai_tool_version` row, because that table's `version_map` and history semantics do not fit.

### DD-6 — Claim and run

The service's `runCheck()`:
1. `INSERT INTO log_hub_release_check (id) VALUES (1) ON CONFLICT (id) DO NOTHING`.
2. Claim:
   ```sql
   UPDATE log_hub_release_check SET last_attempt_at = now()
    WHERE id = 1
      AND (last_attempt_at IS NULL OR last_attempt_at < now() - make_interval(hours => ${ATTEMPT_EVERY_HOURS}))
   RETURNING id
   ```
   There is no success-based clause and no 1 h retry, so there is exactly one attempt per 24 h whatever the outcome.
3. The winner fetches and validates the response per DD-7.
4. Only on success it runs `UPDATE … SET latest_tag, release_url, fetched_at = now()`.
5. Any failure (network, timeout, non-2xx, bad payload, persist error) logs **one** `logger.warn` line and returns `'failed'`. The stored values stay untouched.

### DD-7 — GitHub fetch and validation

- **Request.** `fetch(LOG_HUB_RELEASES_LATEST_URL, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })`.
- **Headers:**
  - `Accept: application/vnd.github+json`
  - `X-GitHub-Api-Version: 2022-11-28`
  - `User-Agent: artisyn-log-hub/<running version>`
- **Response:** `tag_name` must match `RELEASE_TAG_RE`. `html_url` must start with `RELEASE_URL_PREFIX`.
- Anything else is a failure. The server never stores or renders a link to another host.

### DD-8 — Read-time state (`getState()`)

`updateAvailable` is true only when all three hold:
- The deployment is eligible (DD-4).
- The row's `latest_tag` matches `RELEASE_TAG_RE`.
- `compareSemver(latest_tag.slice(1), origin.version) > 0`.

Because the comparison runs at read time, an upgraded server stops showing the dot at once (AC-7), even with an old row. A missing row, or a never-successful check, gives `updateAvailable: false` (FR-8).

The state is read from the DB on each request (one PK lookup). `getState()` is a pure `SELECT`: it never inserts or updates, so the contract row stays `noDb`. It is not affected by `LOG_HUB_RELEASE_CHECK_ENABLED`: the flag only stops the fetch.

### DD-9 — Scheduler

`LogHubReleaseScheduler` is a copy of `server/src/ai-tool-versions/ai-tool-versions.scheduler.ts:25-81`: bootstrap tick, `setInterval` registered in `SchedulerRegistry` as `SCHEDULER_NAME`, the `isTickRunning` guard, and `onModuleDestroy` awaiting the in-flight tick.

`onApplicationBootstrap` returns early, with no fetch and no DB write (AC-1), when either:
- `isCheckEnabled()` is false, or
- the deployment is not eligible (DD-4).

The tick interval is the constant `TICK_INTERVAL_MS`. The claim, not the tick, enforces the 24 h limit. No interval env var is added.

### DD-10 — Constants

All in `server/src/log-hub-release/log-hub-release.constants.ts`:

| Name | Value |
|---|---|
| `LOG_HUB_RELEASES_LATEST_URL` | `'https://api.github.com/repos/DataArt/artisyn-log-hub/releases/latest'` |
| `RELEASE_URL_PREFIX` | `'https://github.com/DataArt/artisyn-log-hub/releases/'` |
| `RELEASE_TAG_RE` | `/^v(0\|[1-9][0-9]*)\.(0\|[1-9][0-9]*)\.(0\|[1-9][0-9]*)$/` (same rule as `docs/knowledgebase/release-pipeline.md` L60) |
| `FETCH_TIMEOUT_MS` | `10_000` |
| `ATTEMPT_EVERY_HOURS` | `24` |
| `TICK_INTERVAL_MS` | `3_600_000` |
| `SCHEDULER_NAME` | `'log-hub-release-check'` |
| `isCheckEnabled()` | `process.env.LOG_HUB_RELEASE_CHECK_ENABLED !== 'false'` |

The `\|` in the table is only Markdown escaping. The literal regex is:

```ts
/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
```

`isValidSemver` and `compareSemver` are imported from `server/src/common/semver.ts`. Do not write a new copy.

### DD-11 — Scenario seam

- **The stand.** `build-stand.mjs` writes `build.origin.json` with `officialRelease: true` and `branch: 'scenario-stand'`, so the stand is an eligible deployment. Its scheduler is disabled by `LOG_HUB_RELEASE_CHECK_ENABLED=false` in `FAST_TICK_ENV`, so it never contacts GitHub.
- **The scenario.** It seeds or clears the `log_hub_release_check` row directly with `db.query`.
- **"Upgraded".** The step updates `latest_tag` to `v<origin.version>`, so the latest release equals the running version.

### DD-12 — Client query

`useLogHubRelease()` is a new file, `client/src/viewer/hooks/useLogHubRelease.ts`:
- Signature: `useLogHubRelease(isAdmin: boolean)`. Callers pass `user?.role === 'admin'`: `AppLeftNav` passes its existing `isAdmin` (L67), and `NewReleaseBanner` derives it from `useAuth()`.
- `queryKey: ['admin', 'log-hub-release']`
- `enabled: isAdmin`, so team owners never call the endpoint and never get a 403
- `staleTime: 3_600_000`, `refetchInterval: 3_600_000`, `retry: false`

On an error or no data, both the dot and the banner render nothing.

### DD-13 — Tooltip rows

The `BuildLabel` component renders rows from `buildTooltipRows(v)`:

| Row | Value |
|---|---|
| Branch | `origin.branch` |
| Version | `origin?.version ?? v.version` |
| Built | `new Date(origin.builtAt).toLocaleString()` |
| Official release | `Yes` / `No` |
| Commit | `v.gitCommit` |

- A row is dropped when its value is empty, `'unknown'`, or an invalid date.
- `Official release` is shown only when `origin` is present.
- The label text keeps today's logic (`MainNav.tsx:38-42`).

### Shared API shape

Response of `GET /api/v1/admin/log-hub-release`:

```ts
interface LogHubReleaseState {
  updateAvailable: boolean;
  currentVersion: string | null; // origin.version when eligible, else null
  latestVersion: string | null;  // e.g. "1.3.0" (tag without "v"), only when updateAvailable
  releaseUrl: string | null;     // html_url, only when updateAvailable
}
```

Response of `GET /health/version`:

```ts
{ version: string; gitCommit: string; origin?: BuildOrigin }
```

where `BuildOrigin = { branch: string; version: string; builtAt: string; officialRelease: boolean }`.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `scripts/build-origin.js` | new — `writeBuildOrigin(destDir, { branch?, officialRelease })` + CLI entry | CommonJS like `build-assets.js`; follow `nodejs-script` skill |
| `scripts/build-assets.js` | call `writeBuildOrigin(dist, { officialRelease: false })` after `copyMigrations()` | before `postclean()` |
| `package.json` (root) | new script `build:origin`; append `&& npm run build:origin` to `build:serial` before `build:postclean` | keeps serial = parallel output |
| `scripts/scenarios/build-stand.mjs` | step 7 writes stand's `build.origin.json` per DD-2/DD-11 | add `scripts/build-origin.js` and the root `package.json` (version source) to `BUILDER_FILES` so the stand hash changes |
| `Dockerfile` | runtime stage: `ARG GIT_BRANCH=unknown`, `ARG OFFICIAL_RELEASE=false`, `printf` `dist/build.origin.json` | per DD-2 |
| `.github/workflows/release.yml` | `build-args`: `GIT_BRANCH=${{ github.ref_name }}`, `OFFICIAL_RELEASE=true` | L126-128 |
| `server/src/common/build-info.ts` | `BuildOrigin` type + `readBuildOrigin()` | DD-3 |
| `server/src/health/health.controller.ts` | `getVersion()` adds `origin` when non-null | key omitted otherwise |
| `server/src/log-hub-release/log-hub-release.constants.ts` | new | DD-10 |
| `server/src/log-hub-release/log-hub-release.types.ts` | new — `LogHubReleaseState`, `RunCheckResult` | Shared API shape |
| `server/src/log-hub-release/log-hub-release.service.ts` | new — `runCheck()`, `getState()`, `isEligible()` | DD-4, 6, 7, 8 |
| `server/src/log-hub-release/log-hub-release.scheduler.ts` | new | DD-9 |
| `server/src/log-hub-release/log-hub-release.controller.ts` | new — `GET api/v1/admin/log-hub-release` | guards per API changes |
| `server/src/log-hub-release/log-hub-release.module.ts` | new | imports `DatabaseModule` |
| `server/src/app.module.ts` | register `LogHubReleaseModule` after `ModelPricingModule` (L113-114) | |
| `server/src/database/schema/index.ts` | `logHubReleaseCheck` table with doc comment | next to `aiToolVersion` (~L2109) |
| `server/drizzle/migrations/<NNNN>_log_hub_release_check.sql` + `meta/_journal.json` + `meta/migrations.lock.json` | new migration | Database changes |
| `server/.env.example` | document `LOG_HUB_RELEASE_CHECK_ENABLED` | next to L48-63 blocks |
| `server/test/contract/setup/global-setup.ts` | `process.env.LOG_HUB_RELEASE_CHECK_ENABLED = 'false'` | next to L76-77 |
| `tests/scenarios/modes.ts` | add `LOG_HUB_RELEASE_CHECK_ENABLED: 'false'` to `FAST_TICK_ENV` | L35-36 |
| `server/test/contract/registry/f01-infra.ts` | new rows + comment on `F01-health-version` | Test coverage plan |
| `client/src/models/admin.ts` | `LogHubReleaseState` client type | |
| `client/src/viewer/api.ts` | `fetchLogHubRelease()` | pattern `fetchSystemInfo` L2342 |
| `client/src/viewer/hooks/useLogHubRelease.ts` | new | DD-12 |
| `client/src/viewer/hooks/useBuildVersion.ts` | export `BuildVersion` / `BuildOrigin` types, `origin?` field | |
| `client/src/viewer/components/top-nav/BuildLabel.tsx` | new — label + Tooltip | DD-13 |
| `client/src/viewer/pages/main/MainNav.tsx` | replace inline label span (L64-71, L38-42) with `<BuildLabel />` | |
| `client/src/viewer/components/AppLeftNav.tsx` | dot on both Admin Panel buttons (L145-153, L322-338) | Visual/UX notes |
| `client/src/viewer/pages/admin/NewReleaseBanner.tsx` | new — banner | Visual/UX notes |
| `client/src/viewer/pages/admin/AdminPage.tsx` | render `<NewReleaseBanner />` above `<PageTabs>` | |
| `tests/scenarios/platform/s-plat-01.spec.ts` | step 2 updated | Test coverage plan |
| `tests/scenarios/auth/s-adm-01.spec.ts` | new route in step 2; new steps | Test coverage plan |
| `docs/knowledgebase/system-info-and-cluster.md` | new section "`log-hub-release` scheduler" + `build.origin.json` in §Dockerfile | incl. Outbound dependency bullet |
| `docs/knowledgebase/release-pipeline.md` | image-arg table (L25) + build-args (L101) | |
| `docs/knowledgebase/db-tables.md` | `log_hub_release_check` section | after §ai_tool_version |
| `docs/knowledgebase/server-endpoint-map.md` | row for new controller | guard `admin` |
| `docs/knowledgebase/db_state.sql` | regenerate | `db-state-update` skill |
| `user-docs/server-configuration.md`, `server/README.md` | add a `LOG_HUB_RELEASE_CHECK_ENABLED` row next to `AI_TOOL_VERSION_CHECK_ENABLED` | server-configuration L21 (shipped as in-app help); README L165 |
| `user-docs/security-hardening.md`, `release-template/INSTALL.md`, `release-template/.env.example`, `release-template/LOCAL-BUNDLE.md` | add `api.github.com` outbound call and the env flag to the outbound lists / air-gapped instructions | §4.4 table L268-280, env table L418-419, L440; INSTALL L269-272; .env.example L94-100; LOCAL-BUNDLE L135-136 |

## API changes

| Endpoint | Method | Auth | Request | Response |
|---|---|---|---|---|
| `/health/version` | GET | public | — | `{ version, gitCommit, origin? }` — `origin` only when `readBuildOrigin()` is non-null (additive; old clients ignore it, new clients handle its absence) |
| `/api/v1/admin/log-hub-release` | GET | `SessionAuthGuard` + `AdminGuard` (401 anon, 403 any non-admin incl. team owners) | — | `LogHubReleaseState` (Shared API shape) |

The controller is `@Controller('api/v1/admin/log-hub-release') @UseGuards(SessionAuthGuard, AdminGuard)` with a single `@Get()`. It uses the same guard imports as `server/src/admin/admin-panel.controller.ts:21-22`.

## Database changes

Migration `server/drizzle/migrations/<NNNN>_log_hub_release_check.sql`:
- **Number.** Use the next free number at implementation time. `0085_agent_meta_labels` is in the working tree now, so it is probably `0086`.
- **Style.** Hand-written, additive and re-runnable, with a header comment in the style of `0065_ai_tool_versions.sql`. No backfill.

```sql
CREATE TABLE IF NOT EXISTS log_hub_release_check (
  id              smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  latest_tag      varchar(64),
  release_url     text,
  fetched_at      timestamptz,
  last_attempt_at timestamptz
);
COMMENT ON TABLE log_hub_release_check IS '…';  -- plus one COMMENT per column (0084 convention)
```

Steps:
1. Add the SQL file.
2. Add the entry to `meta/_journal.json` (next `idx`, `tag` = file name).
3. Update `meta/migrations.lock.json` with `npm run migrations:lock` (from `server/`).
4. Add the Drizzle table `logHubReleaseCheck` in `schema/index.ts`.
5. Apply the migration to the local dev DB.
6. Run the `db-state-update` skill.

Follow the `migrations-data-integrity` skill. Backward compatibility: an older server ignores the new table.

## Test coverage plan

The CLAUDE.md test policy allows only three kinds of tests.

- **API contract** (`server/test/contract/registry/f01-infra.ts`):
  - `F01-admin-log-hub-release`: `GET /api/v1/admin/log-hub-release`, actor `admin`, `200`, `bodyMatches: { updateAvailable: false }`, `noDb: true`. The contract app runs unbundled, so there is no `build.origin.json` and the deployment is not eligible.
  - `F01-admin-log-hub-release-member`: actor `member`, `403`.
  - `F01-health-version` gets a comment: `origin` is optional and absent on the unbundled contract app. The row is otherwise unchanged.
- **Scenario `@S-PLAT-01`** (`tests/scenarios/platform/s-plat-01.spec.ts`), step 2. The stand now ships `build.origin.json` (DD-11), so keys are exactly `['gitCommit','origin','version']`. `origin` has:
  - string `branch` and `version`
  - a `builtAt` that parses as a date
  - `officialRelease === true`
- **Scenario `@S-ADM-01`** (`tests/scenarios/auth/s-adm-01.spec.ts`):
  - Step 2 adds `/api/v1/admin/log-hub-release` to `gets` (403 regular, 401 anon).
  - Step 3 also asserts a team owner gets 403 on it.
  - New step, after step 1, as REGULAR (AC-1b). Hovering the build label shows the Branch / Version / Built / Official release / Commit labels, and the tooltip text does not contain `undefined` or `null`.
  - New step, after step 4, as ADMIN (AC-4, AC-5, AC-7):
    1. Upsert the row with `latest_tag='v999.0.0'` and `release_url='https://github.com/DataArt/artisyn-log-hub/releases/tag/v999.0.0'`.
    2. Reload. The `admin-release-dot` is visible. The banner `admin-new-release-banner` shows `999.0.0`, and its link `href` equals the URL.
    3. Switch tabs. Dot and banner are still shown.
    4. AC-6: `page.context().clearCookies()`, then `teamOwner.signIn(page)` (`tests/scenarios/fixtures/index.ts:245`) and open `/#/admin`. No `admin-release-dot` and no banner.
    5. Clear cookies, run `admin.signIn(page)` again, update `latest_tag` to `v<origin.version>` and reload. Dot and banner are gone.
    6. Delete the row in the `finally` of the single `try` that wraps steps 1-5. The page ends signed in as ADMIN, which is the state the later steps 5-13 expect.
- **Algorithm:** none. No doc in `docs/knowledgebase/algorithms/` covers this, and the decision logic is reached by the scenario steps above.

What these tests do not reach:
- The GitHub fetch path (AC-2, AC-8) cannot run on the stand, which is offline by design.
- Its correctness rests on the copied claim pattern and on code review.
- Verify it manually once with the env flag on (Chunk 7).

## Visual/UX notes

Load the `ui-components` skill before writing UI.

- **Build label tooltip.**
  - Uses `Tooltip`/`TooltipTrigger asChild`/`TooltipContent variant="light" side="bottom"` (same as `MainNav.tsx:90-107`), inside a `TooltipProvider`.
  - The trigger is the existing `font-mono text-xs` span, with `data-testid="nav-build-label"` and `tabIndex={0}`.
  - The content is a two-column grid (`grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs`): label in `text-muted-foreground`, value in `font-mono`. `data-testid="nav-build-tooltip"`.
- **Left-nav dot.**
  - **Collapsed:** the button gets `relative`, and an absolutely positioned `<span data-testid="admin-release-dot" aria-hidden="true" className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-orange-500" />` goes inside it. The button `title` becomes `"Admin Panel — new Log Hub release available"` only when an update is available.
  - **Expanded:** the same `size-1.5 rounded-full bg-orange-500` dot goes after the label with `ml-auto`, matching the hook-repo dot style at `AppLeftNav.tsx:295-299`. Its `title` is `"New Log Hub release available"`.
  - Shown only when `isAdmin && data?.updateAvailable`.
- **Admin banner.**
  - A full-width strip above `<PageTabs>`: `mx-4 mt-3 flex items-center gap-2 rounded-md border border-orange-300 bg-orange-50 px-3 py-2 text-sm text-orange-900 dark:border-orange-800 dark:bg-orange-950/40 dark:text-orange-200`. It has a lucide `ArrowUpCircle` icon and `data-testid="admin-new-release-banner"`.
  - Text: `A newer Log Hub version is available: {latestVersion} (this server runs {currentVersion}).`
  - Then the link `View release` (`href={releaseUrl}`, `target="_blank"`, `rel="noopener noreferrer"`, `underline font-medium`).
  - It has no close button. It renders `null` unless `isAdmin && data?.updateAvailable`.
  - Wrapping the column: `AdminPage`'s outer div is `flex flex-col h-full overflow-hidden`, so the banner is `shrink-0` and `PageTabs` keeps `flex-1`/`h-full` behaviour. Change `PageTabs`' `className` (`AdminPage.tsx:42`) from `"flex flex-col h-full"` to `"flex flex-col flex-1 min-h-0"` so the tabs do not overflow.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Build origin file | 6 | no deps; build scripts + Docker + CI; placed first because Chunk 3's reader and the stand depend on the file |
| 2 | Schema & migration | 4 | before the service |
| 3 | Server service & scheduler | 6 | needs 1 (reader) and 2 (table) |
| 4 | Server API & env wiring | 6 | needs 3; the test-stand env flags live here so the scheduler is off before any test run |
| 5 | Client | 8 | needs 4 for the API shape |
| 6 | Docs | 7 | after behaviour is final; before tests because `build:help` output is part of the stand |
| 7 | Tests & verification | 6 | last |

### Chunk 1 — Build origin file
- [ ] Create `scripts/build-origin.js` (CommonJS, `nodejs-script` skill). It exports `writeBuildOrigin(destDir, { branch, officialRelease })` and writes `build.origin.json` per DD-1. It defaults the branch from `git rev-parse --abbrev-ref HEAD` (fallback `unknown`) and the version from the root `package.json`. As a CLI it writes `dist/` with `officialRelease: false`, but only under a `require.main === module` guard (DD-2).
- [ ] `scripts/build-assets.js`: call `writeBuildOrigin(path.join(ROOT,'dist'), { officialRelease: false })` after `copyMigrations()` and before `postclean()`.
- [ ] Root `package.json`: add `"build:origin": "node scripts/build-origin.js"` and insert `&& npm run build:origin` into `build:serial` before `&& npm run build:postclean`.
- [ ] `scripts/scenarios/build-stand.mjs`: add step 7, which calls `writeBuildOrigin(standDir, { branch: 'scenario-stand', officialRelease: true })`. Add `scripts/build-origin.js` and `package.json` to `BUILDER_FILES`. Follows DD-11.
- [ ] `Dockerfile` runtime stage:
  - Add `ARG GIT_BRANCH=unknown` and `ARG OFFICIAL_RELEASE=false`.
  - In the existing `RUN`, normalise the flag per DD-2.
  - `printf` `{"branch":"%s","version":"%s","builtAt":"%s","officialRelease":%s}` into `dist/build.origin.json`, with `builtAt` from `date -u +%Y-%m-%dT%H:%M:%SZ`.
- [ ] `.github/workflows/release.yml` "Build and push by digest" `build-args`: add `GIT_BRANCH=${{ github.ref_name }}` and `OFFICIAL_RELEASE=true`.

### Chunk 2 — Schema & migration
- [ ] Add `server/drizzle/migrations/<NNNN>_log_hub_release_check.sql` per Database changes: header comment, `CREATE TABLE IF NOT EXISTS`, and `COMMENT ON` for the table and every column.
- [ ] Add the journal entry in `server/drizzle/migrations/meta/_journal.json` and run `npm run migrations:lock` (from `server/`) to update `meta/migrations.lock.json`.
- [ ] Add `logHubReleaseCheck` (`pgTable('log_hub_release_check', …)`, columns per DD-5) to `server/src/database/schema/index.ts` after `aiToolVersionHistory`, with a doc comment.
- [ ] Apply the migration to the local dev DB, then run the `db-state-update` skill to regenerate `docs/knowledgebase/db_state.sql`.

### Chunk 3 — Server service & scheduler
- [ ] `server/src/common/build-info.ts`: export the `BuildOrigin` interface and `readBuildOrigin()` per DD-3, reusing `pickString`. Extend the file's doc comment.
- [ ] Create `server/src/log-hub-release/log-hub-release.constants.ts` with every constant and `isCheckEnabled()` from DD-10.
- [ ] Create `server/src/log-hub-release/log-hub-release.types.ts`: `LogHubReleaseState` (Shared API shape) and `RunCheckResult = 'fetched' | 'skipped' | 'failed'`.
- [ ] Create `log-hub-release.service.ts` (`@Injectable`, `@Inject(DRIZZLE) db`) with:
  - `isEligible(origin)` per DD-4
  - `runCheck()` per DD-6/DD-7, with a single `logger.warn` per failure
  - `getState()` per DD-8, which reads `readBuildOrigin()` and the row
  - the semver helpers come from `server/src/common/semver.ts`
- [ ] Create `log-hub-release.scheduler.ts` by copying `ai-tool-versions.scheduler.ts`. Change the bootstrap early return per DD-9 and use `TICK_INTERVAL_MS` and `SCHEDULER_NAME`.
- [ ] Create `log-hub-release.module.ts`: imports `DatabaseModule`; providers are the service and the scheduler; the controller is added in Chunk 4.

### Chunk 4 — Server API & env wiring
- [ ] Create `log-hub-release.controller.ts`: `@Controller('api/v1/admin/log-hub-release') @UseGuards(SessionAuthGuard, AdminGuard)`, with `@Get()` returning `service.getState()`. Register it in the module.
- [ ] `server/src/app.module.ts`: import `LogHubReleaseModule` and add it after `ModelPricingModule` (L113-114).
- [ ] `server/src/health/health.controller.ts` `getVersion()`: return `{ ...readBuildInfo(), ...(origin ? { origin } : {}) }` with `origin = readBuildOrigin()`. Widen the return type to `BuildInfo & { origin?: BuildOrigin }`.
- [ ] `server/.env.example`: document `LOG_HUB_RELEASE_CHECK_ENABLED`. Only `false` disables it; it is checked only on official releases; it makes one `api.github.com` call per 24 h; it does not hide an already stored result.
- [ ] `server/test/contract/setup/global-setup.ts`: add `process.env.LOG_HUB_RELEASE_CHECK_ENABLED = 'false'` next to `AI_TOOL_VERSION_CHECK_ENABLED`.
- [ ] `tests/scenarios/modes.ts`: add `LOG_HUB_RELEASE_CHECK_ENABLED: 'false'` to `FAST_TICK_ENV`.

### Chunk 5 — Client
- [ ] `client/src/viewer/hooks/useBuildVersion.ts`: export the `BuildOrigin` and `BuildVersion` interfaces and add an optional `origin?: BuildOrigin` (Shared API shape).
- [ ] Create `client/src/viewer/components/top-nav/BuildLabel.tsx`:
  - Use the label logic from `MainNav.tsx:38-42`.
  - Build the tooltip rows per DD-13 in an exported `buildTooltipRows()`.
  - Lay out and style per Visual/UX notes, with the `nav-build-label` / `nav-build-tooltip` test ids.
- [ ] `client/src/viewer/pages/main/MainNav.tsx`: replace the build-label span (L64-71) and the `buildLabel` computation (L38-42) with `<BuildLabel />`, and drop the unused imports.
- [ ] `client/src/models/admin.ts`: add the `LogHubReleaseState` interface (Shared API shape). `client/src/viewer/api.ts`: add `fetchLogHubRelease()`, which calls `GET /api/v1/admin/log-hub-release` following the `fetchSystemInfo` pattern.
- [ ] Create `client/src/viewer/hooks/useLogHubRelease.ts` per DD-12. It takes `isAdmin: boolean` for `enabled`.
- [ ] `client/src/viewer/components/AppLeftNav.tsx`: call `useLogHubRelease(isAdmin)` and render the release dot on the collapsed (L145-153) and expanded (L322-338) Admin Panel buttons per Visual/UX notes.
- [ ] Create `client/src/viewer/pages/admin/NewReleaseBanner.tsx` per Visual/UX notes. It uses `useAuth` + `useLogHubRelease` and renders `null` unless `updateAvailable`.
- [ ] `client/src/viewer/pages/admin/AdminPage.tsx`: render `<NewReleaseBanner />` as the first child of the flex column, above `<PageTabs>`, and change the `PageTabs` `className` per Visual/UX notes.

### Chunk 6 — Docs
- [ ] `docs/knowledgebase/system-info-and-cluster.md`:
  - Add a section "`log-hub-release` scheduler" covering DD-4/6/7/8/9, the env flag and an **Outbound dependency** bullet (`api.github.com`, 10 s timeout, one attempt per 24 h, silent `warn`).
  - In §Dockerfile, document `build.origin.json`, `GIT_BRANCH` and `OFFICIAL_RELEASE`.
- [ ] `docs/knowledgebase/release-pipeline.md`: add `GIT_BRANCH` and `OFFICIAL_RELEASE` to the image-arg table (L25) and to the build-job args (L101).
- [ ] `docs/knowledgebase/db-tables.md`: add a `log_hub_release_check` section after §ai_tool_version. `docs/knowledgebase/server-endpoint-map.md`: add a controller-index row for `log-hub-release/log-hub-release.controller.ts`, guard `admin`.
- [ ] `user-docs/security-hardening.md`: add the `api.github.com` row to the §4.4 outbound table (L268-280), `LOG_HUB_RELEASE_CHECK_ENABLED` to the env table (L418-419), and to the air-gapped sentence (L440).
- [ ] `release-template/INSTALL.md` (L269-272), `release-template/.env.example` (L94-100) and `release-template/LOCAL-BUNDLE.md` (L135-136): mention the third outbound call and the `LOG_HUB_RELEASE_CHECK_ENABLED=false` switch. Update "two outbound requests" to "three".
- [ ] Add a `LOG_HUB_RELEASE_CHECK_ENABLED` row next to `AI_TOOL_VERSION_CHECK_ENABLED` in the env tables of `user-docs/server-configuration.md` (L21) and `server/README.md` (L165). The row covers: only `false` disables it, official releases only, one `api.github.com` call per 24 h.
- [ ] Run `npm run build:help` and check that `client/public/help/*.md` regenerated cleanly from the edited `user-docs/`.

### Chunk 7 — Tests & verification
- [ ] `server/test/contract/registry/f01-infra.ts`: add the rows `F01-admin-log-hub-release` and `F01-admin-log-hub-release-member`, and the comment on `F01-health-version`, per Test coverage plan.
- [ ] `tests/scenarios/platform/s-plat-01.spec.ts` step 2: rename the step and assert the keys `['gitCommit','origin','version']` and the `origin` field checks, per Test coverage plan.
- [ ] `tests/scenarios/auth/s-adm-01.spec.ts`:
  - Add `/api/v1/admin/log-hub-release` to the `gets` in step 2.
  - Add the team-owner 403 assertion to step 3.
  - Add the REGULAR build-tooltip step after step 1, per Test coverage plan.
- [ ] `tests/scenarios/auth/s-adm-01.spec.ts`: after step 4, add one step that covers the ADMIN dot and banner, the team-owner check and the upgrade, all inside one `try/finally`. Seed with a `db.query` upsert on `log_hub_release_check` and delete the row in the `finally`. Follows the Test coverage plan.
- [ ] Iterate with `npm run test:scenarios -- --mode a --only scenarios,contract --grep "@S-ADM-01|@S-PLAT-01"` until green, then run the full `adlc-lh:check-health` final set.
- [ ] Manual check of the fetch path (AC-2, AC-8):
  1. Hand-write an official `dist/build.origin.json` (version `1.0.0`) on a local `npm run build`.
  2. Start `node dist/index.js`. The row gets `latest_tag`, and a restart within 24 h makes no second call.
  3. With the network blocked, a fresh row gives one `warn` and no dot.
