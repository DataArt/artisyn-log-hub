I have the full context for the plan. The task folder has no `open_questions_ru.md`, and requirements.md lists no open questions.

## Requirements summary
A push to `release` (or a `workflow_dispatch` run, allowed only on `refs/heads/release`) cuts a semver release:
- **Version.** MAJOR.MINOR comes from a new root `package.json` `version` field (`"1.0.0"`). PATCH is the highest `vX.Y.N` tag on that line plus one. Going back to a lower line fails the run. A version-bump commit is never pushed back to the branch.
- **Checks first.** A ~20 s check job runs before anything is built: three typechecks, three algorithm-test suites (client, server, hook) and `test:scripts`. The same job is offered as a PR check and added to the `protect-main-release` ruleset.
- **Image.** Built natively per architecture (amd64 on `ubuntu-latest`, arm64 on `ubuntu-24.04-arm`). Build stages use `FROM --platform=$BUILDPLATFORM`. Per-arch images are pushed by digest, joined into a manifest list tagged `:sha-<commit>`, then:
  1. the git tag is created;
  2. a draft GitHub Release is created with the install kit (zip plus the same files loose, `SHA256SUMS`, attestations, VirusTotal scan, "Security scan" notes);
  3. the image is retagged `:X.Y.Z`, `:X.Y` and `:latest`;
  4. the release is published as immutable.
- **Resume.** The run checks HEAD's state first: a tag at HEAD with no release or a draft resumes without rebuilding; a tag pointing at another commit fails; an already published release fails with "nothing to release".
- **Install.** `install.sh` / `install.ps1` install or upgrade with one command. They check `docker info` before touching anything, take `VERSION`, `INSTALL_DIR` and `FORCE`, generate `.env` only on first install, refuse downgrades, and pull from GHCR.
- **Removal.** In-app release downloads go away (server module, client section, tests, docs). `releaseStamp`, `RELEASE_STAMP` and `.app-version` are replaced by `ARG VERSION` / `ARG GIT_COMMIT` writing `build-info.json` as `{version, gitCommit}`.
- **Local build.** `local-loghub` keeps building from the working tree, now with `VERSION=local` and the tag `ghcr.io/dataart/artisyn-log-hub:local`.
- **Docs.** A new KB article `release-pipeline.md` with the 4-step owner rollout checklist.

## Wireframes
- `wireframes/admin-system-tab-after.svg` shows Admin → System Info after the change:
  - **Build tile:** value = `build-info.json` `version` (e.g. `0.1.3`, or `local`), caption `git <short commit>`.
  - **Release tile** (`releaseStamp`, "build stamp (UTC)") is removed, leaving 7 secondary tiles: Build, Node/Env, Event Loop, DB Pool, Disk, Logs Archive, Requests.
  - **Release Downloads section** is removed; the page ends after Per-Instance Breakdown.
  - Every other card is unchanged.
- Code today: `client/src/viewer/pages/admin/tabs/AdminSystemTab.tsx:311-320` has the Build and Release tiles; `:429-430` renders `<ReleaseDownloadsSection />`.

## Knowledgebase
- **`docs/knowledgebase/ci-security-scans.md`**
  - Workflow conventions: Node 22 with `package-manager-cache: false`, `BUN_VERSION: 1.3.14` with `no-cache: true`, `--ignore-scripts` on every `npm ci` / `bun install`.
  - Secrets live only in jobs that download a secret-free build artifact. `VIRUS_TOTAL_KEY` goes to curl on stdin.
  - The workflow `name:` values must not be renamed. The "FR-27 repository settings" and "Owner rollout" sections are the pattern for the new rollout checklist.
  - To update: the workflow table, the VirusTotal rows, and the new release workflow.
- **`docs/knowledgebase/git-hooks.md:66-87`**: "CI scan and branch protection". `protect-main-release` requires `scan`; the new check name gets added here.
- **`docs/knowledgebase/algorithms/README.md`**
  - Doc format (Purpose, Code, Rules, Edge cases, Examples, Mutations, Where visible; `reviewed`/`reviewer` front matter).
  - Script-level table tests live in `scripts/__tests__/<name>.algo.test.js` and run under `npm run test:scripts`.
  - Its docs table has a `release-link-token` row to remove and gets a row for the FR-4 version doc if one is written.
- **`docs/knowledgebase/algorithms/security-scan-summary.md`** with **`scripts/__tests__/security-scan-summary.algo.test.js:12-37`**: the closest pattern for a `scripts/ci/*.js` algorithm. Doc rows `{input:{fn,args}, expected:{result}}` call exported functions by name.
- **`docs/knowledgebase/system-info-and-cluster.md:151-175, 337, 383`**: the Dockerfile `build-info.json`, `RELEASE_STAMP` and `.app-version` text and the `readBuildInfo` fallback, all to rewrite. Note on the client: `useBuildVersion.ts` declares its own two-field `{version, gitCommit}` type and needs no change.
- **`docs/knowledgebase/test/contract-tests.md:39,55`** and **`docs/knowledgebase/test/scenarios.md:71,139,165,221`**: they mention `RELEASES_DIR`, the release rows, `helpers/releases.ts` and S-REL-02. These are not in the FR-12 list but must be updated.
- Other KB files from the FR-12 inventory, all confirmed by grep: `release-link-token.md`, `api-reference.md`, `server-endpoint-map.md`, `static-asset-serving.md`, `client-component-map.md`.
- **Personal KB (gitignored):** `docs/kb-local/local-prod.md:27,48,64` mentions a `releases/` data directory, `--build-arg RELEASE_STAMP=` and `releaseStamp`. It should be updated for FR-15, and never linked from tracked files.

## Existing patterns
- **`.github/workflows/security-scans.yml`**
  - `:26-31`: `permissions: contents: read` at the top and a concurrency group.
  - `:50-53`: checkout pinned by SHA (`actions/checkout@3d3c42e…` v7.0.1) with `fetch-depth: 0` and `persist-credentials: false`.
  - `:110-113`: `actions/setup-node@949feb2…` (v7.1.0), node 22.
  - `:198-202`: `oven-sh/setup-bun@0c5077e…` (v2.2.0).
  - Artifact actions: upload `cf430e0…` (v7.0.2), download `9000827…` (v8.0.2).
  - `:684-850`: the actionlint 1.7.12 and zizmor 1.31.1 jobs (zizmor via `zizmorcore/zizmor-action@53290ba…`). Inline suppressions look like `# zizmor: ignore[adhoc-packages]`.
  - `:854-948`: the `dockerfile-lint` job. Its `COMPOSE_FILES` includes `release-template/docker-compose.yml`, and placeholders are filled only for `${VAR:?}` variables.
- **`.github/workflows/virustotal.yml:62-152`**: secret-free `build-kit` job, then a `vt-scan` job with a key-presence gate, then `node scripts/ci/virustotal-scan.js --out … --raw … <files>`. Reuse this split for release assets.
- **`.github/workflows/gitleaks.yml:216-244`**: the required `scan` job; sha256-verified binary download pattern.
- **`.github/workflows/security-report.yml:47-56`**: `GH_TOKEN: ${{ github.token }}` passed to a Node script. Pattern for `gh` / REST calls (release create, tag ref).
- **`Dockerfile`**
  - `:5,12,23`: build stages, now `FROM node:24.22.1-slim`, to get `--platform=$BUILDPLATFORM`.
  - `:36`: `.app-version` line, to remove.
  - `:47-48`: `ARG GIT_COMMIT` / `ARG RELEASE_STAMP` in the runtime stage.
  - `:54`: the `build-info.json` printf, to become `{"version","gitCommit"}`.
  - Building server-build on the build platform is safe: argon2 prebuilds ship every arch (`server/node_modules/argon2/prebuilds/linux-arm64/argon2.armv8.musl.node`, `linux-x64/argon2.musl.node`) and are copied in full at `:34`.
- **`scripts/release.js`**: helpers to move into `release-kit.js`:
  - `gitCommit()` `:53`, `hostArch()` `:49`, `applyPlaceholders()` `:125`;
  - `generateReleaseEnv()` `:172-182` (random `POSTGRES_PASSWORD` from 18 bytes hex, `SESSION_SECRET` from 32 bytes hex, appends `NODE_ENV=production`; `install.sh` / `install.ps1` must replicate it);
  - `releaseStamp()` / `RELEASE_STAMP_RE` `:45,63`, which move to big-prod `config.mjs`.
  - Everything sits behind `require.main === module`, so it can be required from tests.
- **`scripts/zip-dir.js`**: dependency-free STORED zip writer, used only by `release.js`. It can be kept for `release-kit.js` (FR-12 says remove "if nothing else uses it").
- **`scripts/local-loghub.js:15-17,38-52,33-36`**: imports from `./release`. `buildImage()` passes `RELEASE_STAMP`. `copyTemplates()` copies compose and `.env.example` verbatim, so it needs `{{VERSION}}=local` filled.
- **`scripts/ci/virustotal-scan.js`**
  - `:43-46`: an exact-name `SCOPES` map, to become pattern-matched.
  - `:156`: name check in `parseArgs`.
  - `:171-172`: usage text.
  - `:114`: the pass note is `` `0/${n} engines` ``, so the "Security scan" notes renderer gets `0/<n> engines`.
  - `:200`: exports only `verdictFromReport`.
  - No existing test file for this script, so the "build-script test rows" need a new or extended file.
- **`scripts/ci/scan-rows.js:56-77`**: `makeRow` / `writeRow` produce `<out>/row-<tool>-<scope>.json`; `ID_RE = /^[a-z0-9-]{1,40}$/` (`:40`). The new scopes `release-zip`, `install-sh` and `install-ps1` comply.
- **`scripts/__tests__/release.test.js`**: `node:test` with docker-free pure helpers and mocked timers. Delete it; the pattern carries over to `release-kit` rows.
- **`scripts/__tests__/big-prod-e2e-test.test.js:739-748`**: uses `releaseStamp` / `RELEASE_STAMP_RE` from `lib/config.mjs`, to rename to `runStamp` / `RUN_STAMP_RE`.
- **big-prod-e2e-test skill:**
  - `.claude/skills/big-prod-e2e-test/scripts/lib/config.mjs:19-23` requires `scripts/release.js`; `:186` uses `RELEASE_STAMP_RE`.
  - `lib/stand.mjs:48-52` passes `--build-arg RELEASE_STAMP`.
  - `run.mjs:14,222,225` call `releaseStamp()`.
- **`server/src/common/build-info.ts:4-42`**: `BuildInfo` with `releaseStamp`; fallback `{version:'dev',gitCommit:'unknown',releaseStamp:'dev'}`. It spreads the parsed JSON, so the plan should pick only `version` / `gitCommit` explicitly.
- **Server consumers of `readBuildInfo()`**: `server/src/health/health.controller.ts:26-28` (`GET /health/version`) and `server/src/system-info/system-info.service.ts:174`. The `system-info.types.ts:41-46` doc comment mentions `releaseStamp`.
- **`server/src/admin/admin-panel.controller.ts`**
  - `:21`: `getRequestBaseUrl` import, used only by the release link at `:184`, so remove it.
  - `:28-41`: release imports and DTO.
  - `:62`: `releasesService` injection.
  - `:147-188`: `GET admin/releases` and `POST admin/releases/download-link`. `BadRequestException` stays (used at `:262` and later).
- **Release module wiring:** `server/src/admin/admin.module.ts:7,26` and `server/src/app.module.ts:35,114` import `ReleasesModule`. `server/src/releases/` also holds `release-error-page.ts`, which is not in the FR-12 list but sits in the directory being removed.
- **`server/src/common/static-dir.ts:65-94`**: `resolveReleasesDir`, to remove.
- **`server/test/contract/registry/f01-infra.ts`**: `:8` `F01_RELEASE_ZIP`, `:24-30` `F01-health-version` (status-only today, could gain `bodyMatches`), `:60-66` and `:110-143` release rows.
- **Contract test files that are not in the FR-12 list:**
  - `server/test/contract/f01.contract-spec.ts:5,11-17`: a `beforeAll` writing into `RELEASES_DIR`.
  - `server/test/contract/setup/global-setup.ts:24,79`: `['RELEASES_DIR','releases']`.
- **`tests/scenarios/platform/s-plat-01.spec.ts`**
  - `:42-50`: step 2 asserts three fields including `releaseStamp`.
  - `:66`: step 3 checks headers on `/api/v1/releases/download`.
  - `:79,95-99`: step 4 checks the release HTML error page.
- **Scenario stand files that are not in the FR-12 list:**
  - `tests/scenarios/modes.ts:47-50,137`: `STAND_RELEASES_SUBDIR` / `RELEASES_DIR`.
  - `tests/scenarios/fixtures/index.ts:35`.
  - `tests/scenarios/README.md:56`.
  - `scripts/__tests__/scenarios-stand.test.js:88`.
- **Client:**
  - `client/src/models/admin.ts:190`: `build.releaseStamp`; `:205-225`: `ReleaseArch`, `ReleaseZip`, `ReleaseDownloadLink`.
  - `client/src/viewer/api.ts:60-61,1953-1979`: release imports and `fetchReleaseZips` / `createReleaseDownloadLink`.
- **`release-template/`**
  - `docker-compose.yml:25`: `image: artisyn-log-hub:latest`; `:47`: `RELEASE_LINK_SECRET`; `:59-61`: releases mount; `:55`: `127.0.0.1:5003:3000`, the URL `install.*` prints.
  - `.env.example:68`: `LOG_HUB_DATA_DIR=./loghub-db`; `:71,76`: `change-me` placeholders that `generateReleaseEnv` replaces; `:102-104`: `RELEASE_LINK_SECRET`.
  - `INSTALL.md` (161 lines) uses `{{VERSION}}`, `{{ARCH_*}}`, `{{IMAGE_FILE}}`, `{{OTHER_ZIP}}`, `{{DATE}}` and `docker load`. It needs a full rewrite.
- **`.gitignore:4-9`**: `/release`, the releases comment, `/releases/` and `/server/releases/`.
- **`package.json`**: no `version` field yet; `"release"` script to remove; `test:scripts` = `node --test scripts/__tests__/*.test.js client/scripts/__tests__/*.test.cjs`.
- **Installs the FR-5 job needs:**
  - root `npm ci`: `typecheck:tests` and `test:scripts`;
  - `server/` `npm ci`: typecheck and jest;
  - `client/` `bun install --frozen-lockfile`: typecheck, vitest, and also `typecheck:tests`, because `tests/` imports `client/src/...`;
  - `hook/` needs no install: `npm test` runs `node scripts/run-tests.js` and the devDependencies are only eslint.
  - Lockfiles: `package-lock.json`, `server/package-lock.json`, `client/bun.lock`, `hook/package-lock.json`.
- **Other docs and help files with release content:**
  - `README.md:26,30-45,96-106,130,215`;
  - `client/public/help/component-reference.md:75,87,103`;
  - `client/public/help/responsibility-matrix.md:33,44`;
  - `client/public/help/security-hardening.md:5-6,40,141,159,177-182,365,377,400`;
  - `server/README.md:121,156`; `server/.env.example:21`;
  - `.claude/skills/security-check/SKILL.md:69`.
- **Repository state:** no tags exist locally or on origin, so the first run computes `v1.0.0`. `origin/release` exists.

## Open gaps
1. **No pinned SHAs exist in the repo for the new actions**: `docker/setup-buildx-action`, `docker/login-action`, `docker/build-push-action` (or raw `docker buildx`), `actions/attest-build-provenance`, and optionally `docker/metadata-action`. They must be looked up and pinned with version comments.
2. **How FR-5 runs on both triggers is undecided.** Options: a separate workflow with `on: pull_request` + `workflow_call` that the release workflow calls, or a duplicated job. The required-check name in the ruleset is the job name; it must be stable and must not clash with `scan`.
3. **How the tag is created is undecided.** FR-3 allows `persist-credentials: true` in the job that pushes the tag. The alternative is a REST `git/refs` call with `contents: write`, which needs no persisted credentials.
4. **No existing pattern for push-by-digest, the manifest list, `imagetools create` retags or resume-from-`:sha-<commit>`.** It all needs designing, including how the resume branch reads the index digest from GHCR for attestation.
5. **The FR-4 version computation has no home yet.** It needs a new script (e.g. `scripts/ci/release-version.js`) plus either a new algorithm doc with `scripts/__tests__/*.algo.test.js` or plain rows in the build-script tests. The requirements allow either.
6. **No test file exists for `virustotal-scan.js`.** The new scope-pattern rows need a new or extended `scripts/__tests__` file. `scripts/ci/release-notes.js` is entirely new.
7. **Zip creation is undecided.** Either `release-kit.js` reuses `scripts/zip-dir.js` (keep it, update its header comment) or the workflow calls `zip`.
8. **`install.sh` / `install.ps1` have no precedent in the repo.** The `.env` secret generation must match `generateReleaseEnv` semantics in sh (e.g. `openssl rand -hex` or `/dev/urandom`) and in PowerShell.
9. **`RELEASES_DIR` cleanup is missing from the FR-12 inventory and the acceptance grep.** It appears in `modes.ts`, `fixtures/index.ts`, `tests/scenarios/README.md`, `scenarios-stand.test.js`, the contract global setup and `f01.contract-spec.ts`, and the KB `test/*.md` files. The plan should include it. Also missing from the inventory: `release-error-page.ts`, the `admin.module.ts` / `app.module.ts` imports, and the `getRequestBaseUrl` import.
10. **Two lint checks are unverified.**
    - Whether hadolint 2.15.1 flags `FROM --platform=$BUILDPLATFORM` under DL3029. Report-only either way.
    - Whether `docker compose config` accepts `image: ghcr.io/dataart/artisyn-log-hub:{{VERSION}}` (braces in a tag). The `dockerfile-lint` job only adds placeholders for `${VAR:?}`, so a placeholder or a substitution step may be needed.
11. **The FR-14 VirusTotal step on release assets will be slow.** Every asset is new to VirusTotal (lookup 404, then upload, then polls), with requests 16 s apart and up to 40 polls each. The worst case for 3 files is 3 × (2 + 40) = 126 requests × 16 s = 2,016 s (33.6 min), more than the 20-minute timeout used by existing VirusTotal jobs. The job timeout needs sizing.
12. **Image naming is fixed by hand.** GHCR requires a lowercase owner (`ghcr.io/dataart/...` while the repo is `DataArt/...`), so the image name is hardcoded rather than taken from `github.repository`.
13. **big-prod-e2e-test interaction with FR-15.** The skill checks that `artisyn-log-hub:latest` is untouched (`stand.mjs:25,45,65`). After FR-15, `local-loghub` tags `ghcr.io/dataart/artisyn-log-hub:local` instead of `artisyn-log-hub:latest`, so the plan should confirm nothing else relies on the old local `:latest` tag.
