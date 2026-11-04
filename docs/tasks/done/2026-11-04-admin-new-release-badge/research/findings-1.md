# Research findings 1 — 2026-11-04

All paths below are relative to `D:/_work/Artisyn-LogHub/_repo`.

## Requirements summary
Every build writes `dist/build.origin.json` with `{branch, version, builtAt (ISO UTC), officialRelease}`. Only `release.yml` writes `officialRelease: true`; local `npm run build`, local `docker build` and the local test bundle write `false`. The public `GET /health/version` gains an optional `origin` object. `version` and `gitCommit` stay as they are, so older clients and servers keep working. The top-nav build label gets a tooltip built with the project `Tooltip` component: branch, version, build time in the viewer's local time, official yes/no, and commit. Without `origin` the tooltip must show no empty or "undefined" rows.

Only on an official build whose version is a strict `X.Y.Z`, a server-side scheduler calls `GET https://api.github.com/repos/DataArt/artisyn-log-hub/releases/latest` at most once per 24 h, whatever the outcome. It uses the DB-backed cluster claim and keeps the result in the DB. The tag must be a strict `vX.Y.Z`. The comparison uses `server/src/common/semver.ts` and the link is `html_url`. A failure logs one `warn` and keeps the previous result.

A new admin-only endpoint (403 for everyone else, team owners included) serves the state. An admin sees a dot on the "Admin Panel" entry in both the collapsed and the expanded left nav. A banner sits at the top of the Admin page above the tabs and is never dismissed. Nothing shows when the server is offline, the build is not official, or the server is up to date. A new env flag works like `AI_TOOL_VERSION_CHECK_ENABLED` (only the literal `false` disables it) and is set in the contract and scenario stands. The `api.github.com` dependency must be documented with the other outbound calls.

## Wireframes
None referenced. The task folder holds only `requirements.md`.

## Knowledgebase
- **`docs/knowledgebase/system-info-and-cluster.md`**
  - §ai-tool-versions scheduler (L214-253) and §model-pricing scheduler (L257-295) are the pattern to copy: seed row, conditional `UPDATE … RETURNING` claim, `SchedulerRegistry` interval, `isTickRunning` guard, env read at bootstrap.
  - §Dockerfile (L151-180) covers the `VERSION`/`GIT_COMMIT` args, `build-info.json`, `readBuildInfo()` and `/health/version`.
  - The requirements say the new outbound dependency is documented here (§"Outbound dependency" bullets).
- **`docs/knowledgebase/release-pipeline.md`**
  - The strict tag regex `^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$` (L60).
  - The `build` job passes build-args (L101). Publish step 9 is `gh release edit --draft=false --latest`, so `/releases/latest` returns the newest strict release.
  - The image-arg table (L25) needs the new args.
- **`docs/knowledgebase/claude-version-check.md`** — the precedent for a version check against a fetched release, where a deployment that cannot reach the source means "unchecked, no finding, never an error".
- **`docs/knowledgebase/server-endpoint-map.md`**
  - Guards legend: `admin` = `SessionAuthGuard` + `AdminGuard` (L38). `admin-or-team-owner` is a different guard; this task must not use it.
  - Controller index row for `admin/admin-panel.controller.ts` (L219) is to be updated.
- **`docs/knowledgebase/db-tables.md`** §ai_tool_version (L368-373) — add a section for the new table. The `db-state-update` skill applies after the migration.
- **`docs/knowledgebase/algorithms/`** — no doc covers semver comparison, so no existing algorithm table test applies (see Open gaps).

## Existing patterns
**Server: scheduler, storage and env flag**
- `server/src/ai-tool-versions/ai-tool-versions.scheduler.ts:40-81` — bootstrap tick, `setInterval` in `SchedulerRegistry`, `onModuleDestroy` awaits the in-flight tick. Copy as is.
- `server/src/ai-tool-versions/ai-tool-versions.service.ts:39-99` — `runCheck`: seed `INSERT … ON CONFLICT DO NOTHING`, claim, `fetch` with `AbortSignal.timeout`, persist.
  - It logs at **error** level. The requirements want one **warn** line.
- Same file, L143-152 — claim SQL with `STALE_AFTER_HOURS=24` and `RETRY_AFTER_HOURS=1`.
  - The requirements want one attempt per 24 h whatever the outcome. The claim therefore needs only `last_attempt_at < now() - 24h`, without the 1 h retry or a success-based staleness check.
- `server/src/ai-tool-versions/ai-tool-versions.constants.ts:17-48` — `FETCH_TIMEOUT_MS`, `getCheckIntervalMs()`, `isCheckEnabled()` (`!== 'false'`), `SCHEDULER_NAME`.
- `server/src/ai-tool-versions/ai-tool-versions.module.ts` — module shape. It is registered at `server/src/app.module.ts:113-114`, next to `AiToolVersionsModule` and `ModelPricingModule`.
- `server/src/database/schema/index.ts:2103-2120` — `aiToolVersion` table (`fetched_at`, `last_attempt_at`). Line 969 `modelPricingFetchState` (`last_result`, `last_error`) is the model for a fetch-state row.
- `server/drizzle/migrations/0065_ai_tool_versions.sql` — hand-written, additive, `IF NOT EXISTS` migration with a header comment. The latest migration is `0084_schema_comments.sql`, so the next is 0085. `meta/_journal.json` and `meta/migrations.lock.json` must be updated.

**Server: build info, routes and version comparison**
- `server/src/common/build-info.ts:27-52` — `readBuildInfo()` reads `path.join(__dirname,'public','static','build-info.json')`, takes only known fields and never throws. In the ncc bundle `__dirname` is `dist/`, so a `readBuildOrigin()` would read `path.join(__dirname,'build.origin.json')`.
- `server/src/health/health.controller.ts:25-29` — public `GET /health/version` returns `readBuildInfo()`. Add `origin` here.
- `server/src/admin/admin-panel.controller.ts:37-38` — `@Controller('api/v1/admin') @UseGuards(SessionAuthGuard, AdminGuard)`. Lines 57-60 show the `@Get('system')` one-liner pattern. The new admin-only GET can go here.
- `server/src/common/semver.ts` — `isValidSemver` (strict `^\d+\.\d+\.\d+$`), `compareSemver`, `compareVersions`.

**Env flag wiring**
- `server/.env.example:48-63` — env flag documentation blocks.
- `server/test/contract/setup/global-setup.ts:76-77` and `tests/scenarios/modes.ts:35-36` (`FAST_TICK_ENV`) — where the new `…_ENABLED=false` goes.
- `release-template/.env.example:94-100` and `release-template/INSTALL.md:269-272` — "outbound requests" comment and air-gapped instructions to extend.
- `release-template/LOCAL-BUNDLE.md:135-136` — same instructions in the local bundle guide.

**Build: where `build.origin.json` gets written**
- `Dockerfile:56-64` — runtime stage `ARG VERSION`, `ARG GIT_COMMIT`, then `printf … > dist/public/static/build-info.json`.
  - Add `ARG GIT_BRANCH=unknown` and `ARG OFFICIAL_RELEASE=false`, and print `dist/build.origin.json` with `builtAt` from `date -u +%Y-%m-%dT%H:%M:%SZ`.
  - `.git` is in `.dockerignore`.
  - The Docker server stage (L28-44) runs ncc and `cp` and does **not** use `scripts/build-assets.js`.
- `.github/workflows/release.yml:126-128` — `build-args:` block. Add `GIT_BRANCH=${{ github.ref_name }}` and `OFFICIAL_RELEASE=true`.
- `scripts/build-assets.js:74-81` — the single-process copy phase of local `npm run build`. Add a writer step here: branch from git, version from the root `package.json`, `officialRelease: false`.
  - `scripts/release-kit.js:55` `gitCommit()` is a shared git helper to reuse.
  - `build:serial` in `package.json:27` must stay byte-identical, so it needs a matching step.
- `scripts/scenarios/build-stand.mjs:146-190` — builds the scenario stand into `tmp/scenarios/stand/`. It writes neither `build-info.json` nor `build.origin.json`, so the stand's version is `'dev'`.
- `scripts/local-loghub.js` and `scripts/local-release-bundle.js` pass `VERSION=local…` and get the `false` default.

**Client**
- `client/src/viewer/hooks/useBuildVersion.ts:3-24` — the `BuildVersion` type and query (`staleTime: Infinity`, `retry: false`). Add an optional `origin?`.
- `client/src/viewer/pages/main/MainNav.tsx:38-42,64-71` — the build label uses the native `title={buildVersion?.gitCommit}`. Lines 90-107 show the `TooltipProvider`/`Tooltip`/`TooltipContent variant="light"` pattern in the same file.
- `client/src/viewer/ui/tooltip.tsx:34-40` — `variant: 'dark' | 'light'`.
- `client/src/viewer/components/AppLeftNav.tsx`:
  - L67: `isAdmin = user?.role === 'admin'`.
  - L145-153: collapsed "Admin Panel" icon button.
  - L322-338: expanded "Admin Panel" button.
  - L295-299: dot styling precedent (`size-1.5 rounded-full bg-orange-500`).
  - L58-65: react-query polling pattern.
- `client/src/viewer/pages/admin/AdminPage.tsx:20,36-44` — `isAdmin`. Put the banner above `<PageTabs>` inside the flex column. The file is 118 lines.
- `client/src/viewer/api.ts:2342-2346` — `fetchSystemInfo` is the `apiFetch` + `ApiError` admin fetcher pattern. Client types go in `client/src/models/admin.ts` (server and client types are kept separate by convention).
- `client/src/viewer/lib/semver.ts` — the client copy of semver, if the client ever needs to compare.

**Tests: the three allowed kinds**
- **Contract**
  - `server/test/contract/registry/f01-infra.ts:21-27` — `F01-health-version` (`anon`, `noDb`).
  - Same file L75-87 — `F01-admin-system` / `-member` show the pair to add for the new admin route: `admin` 200 plus `member` 403.
  - DB-backed rows can be modelled on `f22-pricing-tool-versions.ts:406-454` (read SQL against `ai_tool_version`, seeded by `server/test/contract/fixtures/world-v1.sql.ts:2702-2725`). Seed a row there if the endpoint reads the DB.
- **Scenario**
  - `tests/scenarios/platform/s-plat-01.spec.ts:42-51` step 2 asserts that the `/health/version` keys are **exactly** `['gitCommit','version']`. Adding `origin` breaks it, so this step must change.
  - `tests/scenarios/auth/s-adm-01.spec.ts`: step 2 (L108-133) lists the admin GET routes that return 403 for a regular user and 401 anonymously. Add the new route there.
  - Same scenario: steps 1, 3 and 4 (L99-151) cover regular user, team owner and admin in the UI. Steps for "no dot or banner for the team owner" and "dot and banner for the admin" fit here.
  - Helper: `tests/scenarios/helpers/db-seed.ts:35` `insertRow`.
- **Algorithm** — see Open gaps.

## Open gaps
1. **No way to put the stand into the "newer version" state.**
   - The stand has no `build.origin.json` and version `'dev'`, the check is disabled by env, and the server has no override for an outbound URL (only `PUBLIC_BASE_URL` and `DATABASE_URL` are read from env).
   - AC-4, AC-5 and AC-7 cannot be shown in a scenario without a seam. Options: an env path override for the origin file; a `GITHUB_RELEASES_URL`-style env pointing to a loopback stub (scenarios already spin up `createServer` in `hook-process.ts` and `s-site-01`); or computing the state at read time from a DB-seeded latest release plus the running version.
   - Whichever is chosen, the stand needs `officialRelease: true` and a strict `X.Y.Z` version, so `build-stand.mjs` or the stand env must supply them.
2. **The claim differs from the existing pattern.** The requirements want one attempt per 24 h whatever the outcome; the existing pattern retries after 1 h. Also undecided: a new table, or a row in `ai_tool_version` with something like `tool_name='log-hub'`. The plan must also decide the DB columns: latest tag, `html_url`, `fetched_at`, `last_attempt_at`.
3. **"Newer" depends on the running version, not only on what was fetched.** An upgraded server with a stale DB row must hide the dot at once (AC-7). So the comparison has to happen at read time against `readBuildInfo().version` or `origin.version`. The requirements leave open which of the two is the "running version" when they differ.
4. **No algorithm doc covers the version or tag comparison or the `build.origin.json` parse.** Per the test policy, an algorithm table test is allowed only together with a new doc in `docs/knowledgebase/algorithms/` and a rows file in `docs/algorithm-examples/`. The plan must decide whether the decision (official? strict version? strict tag? newer?) is worth that. Otherwise coverage comes from contract rows and scenario steps only.
5. **No GitHub API fetch exists yet.** Still to decide:
   - Headers: GitHub requires `User-Agent` (Node's `fetch` sends one); `Accept: application/vnd.github+json`.
   - Rate limits: 60 requests/h unauthenticated, which is fine at once a day.
   - Timeout: the existing fetches use 5 s and 15 s.
6. **Dot freshness on the client.** No existing hook polls an admin-only state. The plan must choose a query key and interval, and make sure it is only enabled when `role === 'admin'` so team owners never call the endpoint and get a 403.
7. **The build-time file writer is new code.** It must go into `scripts/build-assets.js` and `build:serial`, and possibly `build-stand.mjs`. `scripts/__tests__` only allows tests for build-script helpers, and the policy forbids adding one only for coverage.
8. **Docs that need updating.**
   - Required by the requirements: `docs/knowledgebase/system-info-and-cluster.md`.
   - Offline-first, user-facing docs that list every outbound call:
     - `user-docs/security-hardening.md` §4.4 table (L268-280), the env table (L418-419) and L440.
     - `release-template/INSTALL.md:269-272` ("two outbound requests a day").
     - `release-template/.env.example:94-100`.
     - `server/.env.example`.
   - Also `docs/knowledgebase/release-pipeline.md` (L25, L101).
