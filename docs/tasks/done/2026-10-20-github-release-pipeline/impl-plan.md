# Implementation plan — 2026-10-20 GitHub Release Pipeline

## TL;DR

- **New workflows:**
  - `.github/workflows/checks.yml` runs the FR-5 fast checks. It triggers on `pull_request` and `workflow_call`, and its job `fast-checks` is the new required check.
  - `.github/workflows/release.yml` triggers on `push: release` and `workflow_dispatch`. Its jobs are `plan` → `checks` → `build` (amd64 + arm64 matrix) → `manifest` → `kit` → `vt-scan` → `publish`.
- **New scripts:**
  - `scripts/ci/release-version.js`: version and run state (`planRun`, `nextVersion`, `parseLine`).
  - `scripts/release-kit.js`: the install kit, `SHA256SUMS` and the helpers moved over from `release.js`.
  - `scripts/ci/release-notes.js`: commit list plus the "Security scan" section.
  - `release-template/install.sh` and `release-template/install.ps1`.
- **Changed scripts:**
  - `scripts/release.js` is renamed to `scripts/local-release-bundle.js`, and the npm script `release` to `local-release-bundle`. It still builds the offline zip bundles, with an image tar, for manual tests (FR-17, Design Decision 25).
  - `scripts/ci/virustotal-scan.js` gets `scopeFor` with the release scopes.
  - `scripts/local-loghub.js` builds with `VERSION=local` and the tag `ghcr.io/dataart/artisyn-log-hub:local`.
  - The big-prod-e2e-test skill gets its own `runStamp`.
  - `.gitattributes` gets an LF rule for `install.sh`.
- **Tests:**
  - Two new algorithm docs: `release-version.md` and `release-assets.md`, the latter covering kit, notes and VirusTotal scopes. Each has a `scripts/__tests__/*.algo.test.js` table test.
  - Removed: `release-link-token.md` and its spec, S-REL-02, the legacy `admin-releases` e2e and the release contract rows.
  - Renamed and trimmed: `release.test.js` → `local-release-bundle.test.js`.
- **New external integrations:**
  - The workflow pushes `ghcr.io/dataart/artisyn-log-hub` with `GITHUB_TOKEN`, tagged `:sha-<commit>`, `:X.Y.Z`, `:X.Y` and `:latest`.
  - It creates the git tag through the REST API, creates and publishes the GitHub Release with `gh`, and adds `actions/attest-build-provenance` attestations.
  - It runs VirusTotal on the release assets.
  - New pinned actions: `docker/setup-buildx-action`, `docker/login-action`, `docker/build-push-action`, `actions/attest-build-provenance`.
- **Removed API:**
  - `GET /api/v1/admin/releases`
  - `POST /api/v1/admin/releases/download-link`
  - `GET /api/v1/releases/download`
  - the whole `server/src/releases/` module
- **Changed API:** `GET /health/version` returns `{version, gitCommit}`; `releaseStamp` is removed. `Dockerfile` gets `ARG VERSION` and `FROM --platform=$BUILDPLATFORM` on its build stages.
- **Version source:** the root `package.json` gets `"version": "1.0.0"`, and the `release` npm script is removed.
- **No DB changes. No new npm packages.**
- **Removed client feature:** Admin → System loses the Release tile and the Release Downloads section.
- **Docs and templates:**
  - `release-template/` is rewritten as a pull-based install kit. The compose image becomes `ghcr.io/dataart/artisyn-log-hub:{{VERSION}}`, and `INSTALL.md` is rewritten.
  - The `README.md` install section is rewritten.
  - The in-app help is updated.
  - A new KB article: `docs/knowledgebase/release-pipeline.md`.
- **Already done (2026-10-25, owner request):** the `post-impl-check-release` skill and its `task-checks-guide.md` entry are deleted.

## Reference

- Requirements: [requirements.md](requirements.md)
- Wireframe: [wireframes/admin-system-tab-after.svg](wireframes/admin-system-tab-after.svg)
- Research archive: `research/findings-1.md`. It is an audit trail only; this plan does not depend on it.

## Design Decisions

1. **The FR-5 check is a reusable workflow.**
   - `checks.yml` is `name: checks`, triggered `on: pull_request` (branches `main`, `release`, no path filter) and `on: workflow_call`.
   - Its single job id and `name` are `fast-checks`. That is the status-check name added to `protect-main-release` next to `scan`.
   - It sets its own top-level `env: BUN_VERSION: 1.3.14`, because a called workflow does not inherit the caller's `env`.
   - `release.yml` calls it as job `checks` (`uses: ./.github/workflows/checks.yml`).
   - It has no top-level `concurrency`.
2. **The `fast-checks` steps**, in order:
   - checkout with `persist-credentials: false`;
   - `actions/setup-node` with node 22 and `package-manager-cache: false`;
   - `oven-sh/setup-bun` with `bun-version: ${{ env.BUN_VERSION }}` (1.3.14) and `no-cache: true`;
   - `npm ci --ignore-scripts` at the root and in `server/`;
   - `bun install --frozen-lockfile --ignore-scripts` in `client/`;
   - then `bun run typecheck` and `bun run test` (client), `npm run typecheck` and `npm run test` (server), `npm run typecheck:tests` and `npm run test:scripts` (root), and `npm test` (hook, no install).
   - `mkdir -p tmp` comes first, because the server `tsBuildInfoFile` writes to `../tmp`.
   - `timeout-minutes: 15`.
3. **Constants** shared by the workflows, scripts and install scripts:

   | Name | Value |
   |---|---|
   | `IMAGE` | `ghcr.io/dataart/artisyn-log-hub` (hardcoded lowercase; never taken from `github.repository`) |
   | `RELEASES_URL` | `https://github.com/DataArt/artisyn-log-hub/releases` |
   | Strict tag regex | `^v(0\|[1-9][0-9]*)\.(0\|[1-9][0-9]*)\.(0\|[1-9][0-9]*)$` |
   | Line regex (root `package.json` `version`) | `^[0-9]+\.[0-9]+\.[0-9]+$` |
   | Zip name | `artisyn-log-hub-<version>.zip` |
   | Loose assets | `README.md`, `docker-compose.yml`, `env.example`, `install.sh`, `install.ps1`, `SHA256SUMS` (see DD 12 for `env.example`) |
   | Default install dir | `$HOME/artisyn-log-hub` / `$env:USERPROFILE\artisyn-log-hub` |
   | Default URL | `http://localhost:5003` |
   | `vt-scan` timeout | 40 min (worst case 3 files × 42 requests × 16 s = 2,016 s = 33.6 min) |
   | Commit-list cap in notes | 500 lines, then `…and <n> more` with a compare link |
   | `BUN_VERSION` | `1.3.14` |
   | Node (CI) | `22` |

4. **Action pins.**
   - Existing pins are reused verbatim from `.github/workflows/security-scans.yml`:
     - `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`
     - `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0`
     - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0`
     - `actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2`
     - `actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2`
   - New pins, resolved 2026-10-25 from the tags' commit objects:
     - `docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069 # v4.4.1`
     - `docker/login-action@81c6f93d4bc991e510b342a00b419b3bb4efc5c6 # v4.7.0`
     - `docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0`
     - `actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8 # v4.2.2`
5. **Run-state contract (`planRun`)**, evaluated in this order. Every row is table-tested in `algorithms/release-version.md`.

   | # | Condition | Result |
   |---|---|---|
   | 1 | root `package.json` `version` fails the line regex | `fail`: "root package.json version must be X.Y.Z, got …" |
   | 2 | a strict tag points at HEAD and its release is `published` | `fail`: "nothing to release: vX.Y.Z is already published" |
   | 3 | a strict tag points at HEAD (release `none` or `draft`) | `resume`, version = that tag (the highest one if several) |
   | 4 | line `X.Y` is lower than the line of the highest strict tag | `fail`: "version line X.Y is lower than vA.B.C — no going back" |
   | 5 | computed `vX.Y.(max PATCH on line + 1)`, or `vX.Y.0` when the line has no tags, already exists on another commit | `fail` without overwriting |
   | 6 | otherwise | `full` |

   - `previousTag` is the highest strict tag lower than the version by semver, or `''`.
   - Output: `{ mode, version, tag, line, previousTag, reason }`.
   - Tags are given as `{name, commit}` using the peeled commit. Non-strict `v*` tags are ignored.
6. **`release-version.js` CLI** reads:
   - root `package.json`;
   - `git for-each-ref refs/tags --format='%(refname:short) %(objectname) %(*objectname)'`, taking the peeled `*objectname` when present;
   - `git rev-parse HEAD`;
   - for a strict tag at HEAD, `gh release view <tag> --json isDraft`. Non-zero exit means `none`; `isDraft` true means `draft`, else `published`.

   It writes `mode`, `version`, `tag`, `line`, `previous_tag` to `$GITHUB_OUTPUT`. On `fail` it prints `::error::<reason>` and exits 1. All logic outside I/O lives in exported pure functions (`parseLine`, `nextVersion`, `planRun`).
7. **Job graph of `release.yml`.**
   - Top level:
     - `name: release`;
     - `on: push: branches: [release]` and `workflow_dispatch` (no inputs);
     - `permissions: contents: read`;
     - `concurrency: { group: release, cancel-in-progress: false }`;
     - `env: IMAGE: ghcr.io/dataart/artisyn-log-hub`.
   - **`plan`**
     - Permissions: `contents: write`, needed only to see draft releases.
     - First step fails unless `GITHUB_REF == refs/heads/release`.
     - Then checkout with `fetch-depth: 0` and `persist-credentials: false`, setup-node, then `release-version.js` with `GH_TOKEN: ${{ github.token }}`. Without the token, `gh` fails and a published release would read as `none`.
     - Job `outputs:` `mode`, `version`, `tag`, `line`, `previous_tag`, all mapped from the step id `version`.
   - **`checks`**: `needs: plan`; calls `checks.yml`.
   - **`build`**
     - `needs: [plan, checks]`, `if: needs.plan.outputs.mode == 'full'`.
     - Matrix `{arch: amd64, runner: ubuntu-latest}`, `{arch: arm64, runner: ubuntu-24.04-arm}`.
     - Permissions: `contents: read`, `packages: write`.
     - Steps: setup-buildx, then login to ghcr with `github.actor` / `GITHUB_TOKEN`, then `build-push-action`, then upload the digest as artifact `digest-<arch>`. `build-push-action` inputs:
       - `platforms: linux/<arch>`;
       - `build-args: VERSION=<version>` and `GIT_COMMIT=<github.sha>`;
       - `provenance: mode=max`, `sbom: true`, no cache inputs;
       - `outputs: type=image,name=IMAGE,push-by-digest=true,name-canonical=true,push=true`.
   - **`manifest`**
     - `needs: [plan, build]`, full mode only.
     - Downloads the `digest-*` artifacts.
     - Runs `docker buildx imagetools create -t IMAGE:sha-<github.sha> IMAGE@<d1> IMAGE@<d2>`.
   - **`kit`**
     - `needs: [plan, checks]`; secret-free, `contents: read`.
     - Checkout (`persist-credentials: false`), setup-node 22, no `npm ci` (the scripts use Node built-ins only).
     - Runs `node scripts/release-kit.js --version <version> --commit <sha> --out $RUNNER_TEMP/kit`.
     - Uploads artifact `release-kit`.
   - **`vt-scan`**
     - `needs: [kit]`, `timeout-minutes: 40`, `contents: read`.
     - Checkout (`persist-credentials: false`) and setup-node 22, so it can run `scripts/ci/virustotal-scan.js`.
     - Gated on whether `VIRUS_TOTAL_KEY` is present. Without the key it writes `skipped` rows for `release-zip`, `install-sh` and `install-ps1`.
     - Runs `virustotal-scan.js --out rows --raw raw <zip> <install.sh> <install.ps1>` with `continue-on-error: true`.
     - Uploads artifact `vt-rows`.
   - **`publish`**
     - `needs: [plan, checks, manifest, kit, vt-scan]`.
     - `if: always() && needs.plan.result == 'success' && needs.checks.result == 'success' && needs.kit.result == 'success' && (needs.plan.outputs.mode == 'resume' || needs.manifest.result == 'success')`.
     - Permissions: `contents: write`, `packages: write`, `id-token: write`, `attestations: write`.
     - Steps listed in DD 8.
8. **`publish` steps.**
   1. Checkout (`fetch-depth: 0`, `persist-credentials: false`), setup-node, setup-buildx, login to ghcr.
   2. Resolve the index digest: `docker buildx imagetools inspect IMAGE:sha-<sha> --format '{{json .Manifest}}' | jq -r .digest`. A missing index fails the step with "staging image :sha-<sha> not found".
   3. Attest the image with `attest-build-provenance` (`subject-name: IMAGE`, `subject-digest`, `push-to-registry: true`).
   4. Full mode only, and only if the tag is absent: create the tag with `gh api repos/$GITHUB_REPOSITORY/git/refs -f ref=refs/tags/<tag> -f sha=<sha>`. The tag goes through the REST API, so no checkout persists credentials.
   5. Download `release-kit`, then download `vt-rows` with `continue-on-error: true`, because a timed-out or failed `vt-scan` uploads nothing. `release-notes.js` treats a missing rows directory as "no rows". Attest every kit file (`subject-path`, multi-line list).
   6. Run `node scripts/ci/release-notes.js … --head <github.sha> --out $RUNNER_TEMP/notes.md`. The commit range ends at the commit SHA, not the tag name, because a tag created through the REST API in step 4 is not in the local clone.
   7. Create or complete the draft. If no release exists: `gh release create <tag> --draft --verify-tag --title <tag> --notes-file notes.md <files>`. Otherwise: `gh release upload <tag> <files> --clobber` and `gh release edit <tag> --notes-file notes.md`.
   8. Retag: `docker buildx imagetools create -t IMAGE:<version> -t IMAGE:<X.Y> -t IMAGE:latest IMAGE@<digest>`.
   9. Publish: `gh release edit <tag> --draft=false --latest`.

   Every `${{ }}` value reaches `run:` through `env:` (zizmor template-injection), and `GH_TOKEN: ${{ github.token }}` is set as in `security-report.yml:47-56`.
9. **Dockerfile.**
   - Stages `client-build`, `hooks-build` and `server-build` become `FROM --platform=$BUILDPLATFORM node:24.22.1-slim AS …`.
   - `server-build` drops the `.app-version` line.
   - The runtime stage declares `ARG VERSION=unknown` and `ARG GIT_COMMIT=unknown`, and writes `printf '{"version":"%s","gitCommit":"%s"}' "$VERSION" "$GIT_COMMIT" > dist/public/static/build-info.json` after `mkdir -p dist/public/static`.
   - argon2 musl prebuilds for both architectures are already copied by `prebuilds/*`, so `npm ci` on the build platform is safe.
   - If hadolint 2.15.1 reports DL3029 on these lines, add `# hadolint ignore=DL3029` above each one.
10. **`build-info.ts`.** `BuildInfo = { version: string; gitCommit: string }`. `readBuildInfo()` picks `version` and `gitCommit` explicitly from the parsed JSON (non-empty strings, else `'unknown'`), so an old three-field file never leaks `releaseStamp`. The fallback is `{version:'dev', gitCommit:'unknown'}`.
11. **`release-kit.js`** is CommonJS on Node built-ins only, and its CLI runs behind `require.main === module`.
    - **Exports:**
      - `IMAGE`;
      - `gitCommit`, `hostArch` and `applyPlaceholders`, moved verbatim from `scripts/release.js`;
      - `generateReleaseEnv`, moved verbatim from `scripts/release.js`;
      - `kitFiles(templates, {version, commit})`, which is pure. `templates` maps a template file name to its text. It returns `[{name, zipName, content}]`: the asset name, the name inside the zip, and the filled text. The CLI reads `release-template/` into the map.
      - `sha256sums(files)`, which takes `[{name, content}]` and returns `"<hex>  <name>\n"` lines, sorted by name.
    - **CLI:** `--version X.Y.Z --commit <sha> --out <dir>`. It validates the version against `^\d+\.\d+\.\d+$` and writes:
      - the loose files;
      - `artisyn-log-hub-<version>.zip`, packed with `scripts/zip-dir.js` (kept) from a temp dir in which `env.example` is named `.env.example`;
      - `SHA256SUMS` covering the zip and every loose file.
    - **Placeholders:** `{{VERSION}}` and `{{GIT_COMMIT}}` are filled in `README.md` (from `INSTALL.md`) and `docker-compose.yml` only. `install.sh`, `install.ps1` and `.env.example` are copied unchanged.
12. **`env.example` asset name.** The loose asset is `env.example`, without the leading dot, because GitHub renames release assets whose names start with `.`.
    - Inside the zip the file stays `.env.example`.
    - The install scripts download `env.example` and save it as `.env.example`.
    - Verify the published asset name on the first draft.
13. **`install.sh`** is POSIX `sh` (`#!/bin/sh`, `set -eu`); no bashisms, because it runs as `| sh`. Steps, in order:
    1. Check `command -v docker`, then `docker compose version`, then `docker info`. On any failure, print "Docker is not running" (or "Docker/Compose not found") and exit 1.
    2. Normalize `VERSION`: default `latest`; strip a leading `v`; a non-`latest` value must match `X.Y.Z`. The base URL is `RELEASES_URL/latest/download` or `RELEASES_URL/download/vX.Y.Z`.
    3. `curl -fsSL` `docker-compose.yml` and `env.example` into a `mktemp -d` directory. A 404 exits 1 with "release <VERSION> not found".
    4. Parse the new tag from the `image: IMAGE:` line, and the old tag from `$INSTALL_DIR/docker-compose.yml` if present. If the new tag is lower, compared field by field as integers, refuse with "downgrade not supported — DB migrations are forward-only" unless `FORCE=1`.
       - The downgrade check is skipped when the old file is missing, has no `image:` line, or has a tag that is not `X.Y.Z`. That covers old zip-bundle installs (`artisyn-log-hub:latest`) and `local`.
       - Parsing must never abort under `set -eu`: use `|| true` and empty-string checks.
       - When the new compose file has no `IMAGE:X.Y.Z` line, exit 1 with "unexpected docker-compose.yml".
    5. Create `$INSTALL_DIR`. Back up the existing compose file to `docker-compose.yml.prev`, then move the new files in (`.env.example` named with the dot).
    6. If `.env` is missing, generate it from `.env.example` with `umask 077`:
       - `POSTGRES_PASSWORD=` gets 18 random bytes as hex, `SESSION_SECRET=` gets 32 random bytes as hex (`od -An -tx1 -N<n> /dev/urandom | tr -d ' \n'`);
       - append a blank line and `NODE_ENV=production`;
       - write to a temp file, then `mv`.
       An existing `.env` is never opened for writing.
    7. Run `docker compose pull`. On failure, restore `docker-compose.yml.prev` and exit 1. Then run `docker compose up -d`.
    8. Print the install dir and the URL: `PUBLIC_BASE_URL` from `.env` when it is uncommented and non-empty, else `http://localhost:5003`.
14. **`install.ps1`** mirrors DD 13 step for step and must run on Windows PowerShell 5.1 and pwsh 7.
    - `$ErrorActionPreference = 'Stop'`.
    - Downloads with `Invoke-WebRequest -UseBasicParsing`.
    - Random bytes from `[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes()`, formatted as lowercase hex.
    - Compares versions with `[version]`.
    - Writes `.env` with `[IO.File]::WriteAllText(path, text, (New-Object Text.UTF8Encoding $false))`.
    - The install dir is `$env:INSTALL_DIR`, else `Join-Path $env:USERPROFILE 'artisyn-log-hub'`. `VERSION` and `FORCE` are read from `$env:`.
    - Errors use `Write-Error` and `exit 1`, not `throw`, so `irm | iex` gives a clean message.
15. **`release-notes.js`** CLI: `--version --tag --previous-tag --head <sha> --digest --sums <SHA256SUMS> --rows <dir> --repo <owner/name> --out <file>`.
    - The CLI collects commits with `git log --no-merges --format=%h%x09%s <prev>..<head>`, or `<head>` alone when there is no previous tag.
    - It reads every `row-virustotal-*.json` in `--rows`; a missing directory means no rows.
    - The pure `renderNotes({version, tag, previousTag, repo, commits, digest, sums, rows})` returns markdown with:
      - `## Changes`: up to 500 `- <subject> (<sha>)` lines, then `…and <n> more` linking `https://github.com/<repo>/compare/<prev>...<tag>`;
      - `## Security scan`: the image digest; a table `File | SHA-256 | VirusTotal`; the verification commands `sha256sum -c SHA256SUMS`, `gh attestation verify <file> -R <repo>` and `gh attestation verify oci://IMAGE:<version> -R <repo>`.
    - VirusTotal cell values:
      - a `pass` row shows `note` plus a `[permalink](link)`;
      - any other status shows `<status>: <note>`;
      - files with no scope show `not scanned`;
      - a scope whose row file is missing shows `no result`.
    - Scope-to-file map: `release-zip` → the zip, `install-sh` → `install.sh`, `install-ps1` → `install.ps1`. `parseSums(text)` is exported too.
16. **`virustotal-scan.js` scopes.** The exact-name `SCOPES` map is replaced by an exported `scopeFor(name)`:
    - `artisyn-hooks-installer.tgz` → `installer-tgz`
    - `hooks.tar.gz` → `hooks-tgz`
    - `/^artisyn-log-hub-\d+\.\d+\.\d+\.zip$/` → `release-zip`
    - `install.sh` → `install-sh`
    - `install.ps1` → `install-ps1`
    - anything else → `null`, which is a usage error

    The header comment and the usage text list the file names. `module.exports = { verdictFromReport, scopeFor }`.
17. **Local build (FR-15).**
    - `local-loghub.js` imports `gitCommit`, `hostArch`, `generateReleaseEnv`, `applyPlaceholders` and `IMAGE` from `./release-kit`.
    - It builds with `--build-arg VERSION=local --build-arg GIT_COMMIT=<commit> -t ghcr.io/dataart/artisyn-log-hub:local --load`.
    - `copyTemplates()` writes `docker-compose.yml` with `{{VERSION}}` → `local` and `{{GIT_COMMIT}}` → the commit, and copies `.env.example` verbatim.
    - The big-prod stand builds and checks its own tags (`stand.mjs`), so nothing depends on the old local `artisyn-log-hub:latest`.
18. **big-prod-e2e-test.**
    - `runStamp()` and `RUN_STAMP_RE = /^\d{8}-\d{6}$/` are defined inline in `scripts/lib/config.mjs`, with the same body as `releaseStamp()`; config no longer requires `scripts/release.js`.
    - `stand.mjs` passes `--build-arg VERSION=big-prod-<stamp>` and `--build-arg GIT_COMMIT=<commit>`.
    - `run.mjs` calls `runStamp()`.
    - The `preflight.mjs:31` comment points at `scripts/local-release-bundle.js` instead of `scripts/release.js`.
19. **Line endings.** Add `release-template/install.sh text eol=lf` to `.gitattributes`, so a Windows checkout never ships CRLF into `| sh`.
20. **The compose template passes the `dockerfile-lint` check unchanged.** `docker compose config --quiet` on `image: ghcr.io/dataart/artisyn-log-hub:{{VERSION}}` exits 0 (verified locally 2026-10-25), so `security-scans.yml` needs no change.
21. **`security-report.yml` and `security-summary.js` LABELS are not changed.** Release VirusTotal rows go only to `release-notes.js`, never to the PR summary.
22. **Leftovers grep (FR-12 acceptance, extended).** Run this command; it must return nothing:
    ```
    git grep -nE 'RELEASES_HOST_DIR|RELEASE_LINK_SECRET|release-token|ReleaseDownloads|/api/v1/releases/download|RELEASE_STAMP|releaseStamp|npm run release|docker load|/app/dist/releases|RELEASES_DIR|resolveReleasesDir|ReleasesModule|scripts/release\.js|\.app-version' -- ':!docs/tasks/' ':!docs/changelog/' ':!scripts/local-release-bundle.js' ':!scripts/__tests__/local-release-bundle.test.js' ':!release-template/LOCAL-BUNDLE.md'
    ```
25. **Local release bundle (FR-17).** `scripts/release.js` is renamed to `scripts/local-release-bundle.js`; it keeps its per-arch zip logic and `TARGETS`, and its output stays in `release/`.
    - **Shared helpers:** it imports `gitCommit`, `hostArch`, `applyPlaceholders` and `generateReleaseEnv` from `./release-kit`.
    - **Environment:** `RELEASE_STAMP` / `RELEASE_ARCHS` become `BUNDLE_STAMP` / `BUNDLE_ARCHS`, and `RELEASE_STAMP_RE` becomes `BUNDLE_STAMP_RE`. `releaseStamp` / `resolveReleaseStamp` become `bundleStamp` / `resolveBundleStamp`.
    - **Purpose:** hand the very latest working tree, including uncommitted changes, to a colleague for manual testing. The build context is the working tree (`.`), so it is never rebuilt from a git checkout.
    - **Commit marker:** `GIT_COMMIT` is `<HEAD>-dirty` when `git status --porcelain` is non-empty, else `<HEAD>`. The bundle notes show it.
    - **Build:** `--build-arg VERSION=local-<stamp>`, `GIT_COMMIT=<commit>` and `-t ghcr.io/dataart/artisyn-log-hub:local-<stamp>`. The tar comes from `--output type=docker,dest=…` as today, and the final host-arch `--load` uses the same tag.
    - **Bundle contents:**
      - `docker-compose.yml` from the FR-10 template, filled with `VERSION` = `local-<stamp>`;
      - the generated `.env`;
      - `.env.example`;
      - `INSTALL.md`, rendered from the new `release-template/LOCAL-BUNDLE.md`. That template is today's per-architecture `INSTALL.md` (the `docker load` steps, with the `{{ARCH_*}}`, `{{IMAGE_FILE}}`, `{{OTHER_*}}` and `{{DATE}}` placeholders), retitled "Local test bundle — not a published release".
    - **npm script:** `"local-release-bundle": "node scripts/local-release-bundle.js"` replaces `"release"`. `.gitignore` keeps `/release`.
    - `release-kit.js` must not ship `LOCAL-BUNDLE.md` in the published kit.
23. **Owner rollout checklist (FR-16)**, exactly these four numbered steps:
    1. after the first PR run of `checks.yml`, add the status check `fast-checks` to the `protect-main-release` ruleset next to `scan`;
    2. after the first release push, make the GHCR package `artisyn-log-hub` public and link it to the repository;
    3. enable immutable releases in the repository settings;
    4. set Actions → "Require approval for all outside collaborators" (first-time and outside contributors).
24. **Help wording (`client/public/help/`).**
    - **`responsibility-matrix.md`:**
      - row 33 becomes "Publishing releases (GHCR image, GitHub Release install kit)";
      - row 44 becomes "Initial installation from the GitHub Release (`install.sh` / `install.ps1`)";
      - the RACI letters are unchanged.
    - **`component-reference.md`:** delete the Releases rows (75, 103) and the `/app/dist/releases` mount row (87).
    - **`security-hardening.md`:**
      - delete the Release Downloads / `RELEASE_LINK_SECRET` passages (5–6, 40, 141, 159, 177–182, 365, 377, 400);
      - "INSTALL.md in the release bundle" becomes "the README.md of the GitHub Release install kit".

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `.github/workflows/checks.yml` | FR-5 check | new, DD 1–2 |
| `.github/workflows/release.yml` | release pipeline | new, DD 7–8 |
| `scripts/ci/release-version.js` | FR-4 version + run state | new, DD 5–6 |
| `scripts/release-kit.js` | kit builder + shared helpers | new, DD 11 |
| `scripts/ci/release-notes.js` | release notes renderer | new, DD 15 |
| `scripts/ci/virustotal-scan.js` | release scopes | DD 16 |
| `scripts/zip-dir.js` | kept | header comment: used by `release-kit.js` and `local-release-bundle.js` |
| `scripts/release.js` → `scripts/local-release-bundle.js` | rename + adapt | DD 25 |
| `scripts/__tests__/release.test.js` → `scripts/__tests__/local-release-bundle.test.js` | rename + adapt | DD 25 |
| `release-template/LOCAL-BUNDLE.md` | install notes of the local bundle | new, DD 25 |
| `scripts/local-loghub.js` | FR-15 | DD 17 |
| `.claude/skills/big-prod-e2e-test/scripts/lib/{config,stand,preflight}.mjs`, `scripts/run.mjs` | run stamp | DD 18 |
| `package.json` | `"version": "1.0.0"`, remove `release` script | FR-4, FR-12 |
| `Dockerfile` | build platform, `VERSION` arg | DD 9 |
| `.gitignore` | remove lines 5–9 (the releases comment, `/releases/`, `/server/releases/`); keep `/release` | FR-12, FR-17 |
| `.gitattributes` | LF for `install.sh` | DD 19 |
| `release-template/docker-compose.yml` | GHCR image, no `RELEASE_LINK_SECRET`, no releases mount | FR-10 |
| `release-template/.env.example` | drop `RELEASE_LINK_SECRET` block (lines 102–104) | FR-10 |
| `release-template/INSTALL.md` | full rewrite, architecture-neutral | FR-10, FR-11 |
| `release-template/install.sh`, `release-template/install.ps1` | installers | new, DD 13–14 |
| `server/src/releases/` (whole dir incl. `release-error-page.ts`, `release-token.algo.spec.ts`) | delete | FR-12 |
| `server/src/admin/dto/release-download-link.dto.ts` | delete | FR-12 |
| `server/src/admin/admin-panel.controller.ts` | remove release endpoints, imports, `releasesService`, `getRequestBaseUrl` import | lines 21, 28–41, 62, 147–188 |
| `server/src/admin/admin.module.ts`, `server/src/app.module.ts` | drop `ReleasesModule` | lines 7, 26 / 35, 114 |
| `server/src/common/static-dir.ts` | delete `resolveReleasesDir` | lines 65–94 |
| `server/src/common/build-info.ts` | two-field `BuildInfo` | DD 10 |
| `server/src/system-info/system-info.types.ts` | doc comment without `releaseStamp` | lines 41–46 |
| `server/.env.example`, `server/README.md` | drop `RELEASES_HOST_DIR` / `RELEASE_LINK_SECRET` | `.env.example:21`, `README.md:121,156` |
| `server/test/contract/registry/f01-infra.ts` | drop `F01_RELEASE_ZIP` and release rows | lines 8, 60–66, 110–143 |
| `server/test/contract/f01.contract-spec.ts` | drop the `RELEASES_DIR` `beforeAll` | lines 5, 11–17 |
| `server/test/contract/setup/global-setup.ts` | drop `['RELEASES_DIR','releases']` | lines 24, 79 |
| `client/src/viewer/pages/admin/tabs/AdminSystemTab.tsx` | drop Release tile and section | lines 11, 316–320, 430 |
| `client/src/viewer/pages/admin/tabs/ReleaseDownloadsSection.tsx` | delete | FR-12 |
| `client/src/models/admin.ts` | `build` = `{version, gitCommit}`; delete `ReleaseArch`/`ReleaseZip`/`ReleaseDownloadLink` | lines 190, 205–225 |
| `client/src/models/index.ts` | drop the three release type re-exports | lines 22–24 |
| `client/src/viewer/api.ts` | drop release imports and two functions | lines 60–61, 1953–1979 |
| `client/public/help/component-reference.md`, `responsibility-matrix.md`, `security-hardening.md` | help text | Design Decision 24 |
| `tests/scenarios/platform/s-rel-02.spec.ts`, `tests/scenarios/helpers/releases.ts`, `tests/e2e/admin-releases.spec.ts` | delete | FR-12 |
| `tests/scenarios/platform/s-plat-01.spec.ts` | steps 2–4 | Test coverage plan |
| `tests/scenarios/modes.ts`, `tests/scenarios/fixtures/index.ts`, `tests/scenarios/README.md`, `scripts/__tests__/scenarios-stand.test.js` | drop `RELEASES_DIR` / `STAND_RELEASES_SUBDIR` | `modes.ts:47-50,137`, `fixtures/index.ts:35`, `README.md:56`, `scenarios-stand.test.js:88` |
| `docs/knowledgebase/algorithms/release-version.md` | new algorithm doc | Test coverage plan |
| `scripts/__tests__/release-version.algo.test.js` | table test | new |
| `docs/knowledgebase/algorithms/release-assets.md` | new algorithm doc: kit, checksums, notes, VirusTotal scopes | Test coverage plan |
| `scripts/__tests__/release-assets.algo.test.js` | table test | new |
| `scripts/__tests__/big-prod-e2e-test.test.js` | rename to `runStamp` / `RUN_STAMP_RE` | lines 739–748 |
| `docs/knowledgebase/release-pipeline.md` | new KB article | FR-16 |
| `docs/knowledgebase/index.md`, `git-hooks.md`, `ci-security-scans.md`, `system-info-and-cluster.md`, `api-reference.md`, `server-endpoint-map.md`, `static-asset-serving.md`, `client-component-map.md`, `test/contract-tests.md`, `test/scenarios.md`, `algorithms/README.md` | KB updates | Implementation Chunks 8 |
| `docs/knowledgebase/algorithms/release-link-token.md` | delete | FR-12 |
| `docs/qaa-overview/scenarios/01-auth-access-admin.md`, `04-ingest-hook-installer-platform.md`, `05-api-db-contract.md`, `docs/qaa-overview/14-algorithm-units.md` | drop release scenarios, rows and units | FR-12 |
| `README.md` | install section rewritten | FR-12 |
| `.claude/skills/security-check/SKILL.md` | drop release section (line 69) | FR-12 |
| `docs/kb-local/local-prod.md` (gitignored) | FR-15 changes | lines 27, 48, 64; never linked from tracked files |

## API changes

| Endpoint | Method | Change |
|---|---|---|
| `/health/version` | GET | Response is `{ version: string; gitCommit: string }`. `releaseStamp` is removed. `version` is `X.Y.Z` in released images, `local` from local-loghub, `dev` in an unbundled dev server and `unknown` in a Docker build without `VERSION`. |
| `/api/v1/admin/releases` | GET | Removed (404). |
| `/api/v1/admin/releases/download-link` | POST | Removed (404). |
| `/api/v1/releases/download` | GET | Removed (404 JSON). Old links expire in 24 h anyway (FR-13). |

- Client type: `SystemInfo.build` in `client/src/models/admin.ts` becomes `{ version: string; gitCommit: string }`.
- Server: `BuildInfo` per DD 10.
- The hook API and the installer endpoints are unchanged (FR-13).

## Test coverage plan

Each item below is one of the three kinds the policy allows.

- **Algorithm:** a new doc `docs/knowledgebase/algorithms/release-version.md` for FR-4.
  - Sections follow `algorithms/README.md`: Purpose, Code, Rules, Edge cases, Examples, Mutations, Where visible, plus `reviewed: no` front matter.
  - Its `examples` rows use the `{input:{fn,args}, expected:{result}}` shape of `security-scan-summary.md` against `parseLine`, `nextVersion` and `planRun`. They cover:
    - every row of DD 5;
    - the acceptance sequence `v1.0.0 → v1.0.1 → v1.0.2 → v1.1.0 → v1.1.1`;
    - falling back to `1.0.0`;
    - non-strict tags (`v1.0`, `v1.0.0-rc1`, `v01.0.0`) being ignored;
    - semver ordering (`v1.0.10 > v1.0.9`);
    - `previousTag`.
  - The new table test `scripts/__tests__/release-version.algo.test.js` copies `security-scan-summary.algo.test.js`. It runs under `npm run test:scripts`.
  - The `release-version` row is added to `algorithms/README.md`. The `release-link-token` row, its doc and `release-token.algo.spec.ts` are deleted.
- **Algorithm:** a second new doc, `docs/knowledgebase/algorithms/release-assets.md`, covers the release-asset rules: kit filling, checksums, notes and VirusTotal scopes.
  - This is the test policy's algorithm kind. It satisfies the requirement's "build-script test rows" without adding a unit-test file.
  - Rows are `{input:{module, fn, args}, expected:{result}}`, where `module` is one of `release-kit`, `release-notes` or `virustotal-scan`. They cover:
    - `kitFiles`: placeholder filling; the `docker-compose.yml` image line equals `IMAGE:<version>`; `install.*` and `.env.example` unchanged; `env.example` ↔ `.env.example` names;
    - `sha256sums`: format and sorting;
    - `renderNotes`: pass, neutral, missing and unscanned rows; first release with no previous tag; the 500-line cap;
    - `parseSums`;
    - `scopeFor`: every name, plus an unknown one.
  - Table test: `scripts/__tests__/release-assets.algo.test.js`, which picks the module by `input.module`.
  - `generateReleaseEnv` is random. It moves verbatim and gets no rows.
- **Existing build-script tests (`npm run test:scripts`), updated only:**
  - `scripts/__tests__/release.test.js` is renamed to `local-release-bundle.test.js`. Its existing cases follow the DD 25 renames (`BUNDLE_STAMP`, `BUNDLE_ARCHS`, `bundleStamp`). Cases for helpers that moved to `release-kit.js` stay, and import from `../release-kit`. No new cases.
  - `big-prod-e2e-test.test.js` rows are renamed to `runStamp` / `RUN_STAMP_RE`.
  - `scenarios-stand.test.js` drops its `RELEASES_DIR` expectation.
- **API contract:**
  - In `server/test/contract/registry/f01-infra.ts` the rows `F01-admin-releases`, `F01-admin-release-link`, `F01-admin-release-link-unlisted` and any `/api/v1/releases/download` row go away with their routes, so the router meta-test stays green.
  - `F01-health-version` stays status-only, because the version value differs per stand.
- **Scenario:** `tests/scenarios/platform/s-plat-01.spec.ts` (`@S-PLAT-01`) is extended.
  - Step 2 asserts that the body has exactly the keys `version` and `gitCommit`, both non-empty strings, and no `releaseStamp`.
  - Step 3 drops the `/api/v1/releases/download` entry.
  - Step 4 drops the release HTML page check and its title.
  - `s-rel-02.spec.ts`, `helpers/releases.ts` and the legacy `tests/e2e/admin-releases.spec.ts` are deleted.
  - No scenario asserts the Admin → System Release tile. A grep on 2026-10-25 found `releaseStamp` only in `s-plat-01.spec.ts` step 2.
- **Not testable in CI here:**
  - The workflows are linted by actionlint and zizmor in `security-scans.yml`.
  - `install.sh` and `install.ps1` get manual checks in Chunk 3:
    - `install.sh`: `shellcheck -s sh` (via `docker run koalaman/shellcheck`), plus a run under `dash`;
    - `install.ps1`: a run under Windows PowerShell 5.1 and pwsh 7 against a local `INSTALL_DIR`.
  - The owner's first-release acceptance run covers the rest.
  - No new test kinds.

## Visual/UX notes

- Admin → System secondary strip, per the wireframe:
  - remove the `Release` `SecondaryTile`;
  - the order becomes Build, Node/Env, Event Loop, DB Pool, Disk, Logs Archive, Requests;
  - keep the grid classes;
  - update the strip comment ("7 tiles + the logs-archive tile") to match.
- The Build tile is unchanged: value `build.version`, caption `git <shortCommit>`.
- The page ends after Per-Instance Breakdown; `<ReleaseDownloadsSection />` and its import are removed.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Server: remove release feature + build info | 8 | contract registry/setup edits stay here so server typecheck stays green |
| 2 | Version source + Dockerfile | 5 | independent of chunk 1 |
| 3 | Install kit templates | 6 | read by chunk 4 `kitFiles` |
| 4 | Release scripts | 6 | needs chunks 2–3 |
| 5 | Script consumers + local release bundle | 7 | needs chunk 4 (`release-kit.js`) |
| 6 | Client + in-app help | 6 | needs chunk 1 (API gone) |
| 7 | Workflows | 7 | needs chunks 3–5 |
| 8 | Knowledge base | 7 | needs everything above |
| 9 | Other docs and skills | 5 | needs everything above |
| 10 | Tests: scenarios | 5 | needs chunks 1, 6 |
| 11 | Tests: algorithm docs + table tests | 6 | needs chunks 4, 5 |

### Chunk 1 — Server: remove release feature + build info
- [ ] Delete `server/src/releases/` entirely (module, service, types, controller, `release-token.ts`, `release-token.algo.spec.ts`, `release-error-page.ts`) and `server/src/admin/dto/release-download-link.dto.ts`.
- [ ] `server/src/admin/admin-panel.controller.ts`: remove the `GET admin/releases` and `POST admin/releases/download-link` handlers (147–188), the release imports and DTO (28–41), the `releasesService` injection (62) and the `getRequestBaseUrl` import (21); keep `BadRequestException`.
- [ ] Remove the `ReleasesModule` import/registration from `server/src/admin/admin.module.ts` (7, 26) and `server/src/app.module.ts` (35, 114).
- [ ] Delete `resolveReleasesDir` and its helpers from `server/src/common/static-dir.ts` (65–94).
- [ ] Rewrite `server/src/common/build-info.ts` per Design Decision 10; update the doc comment in `server/src/system-info/system-info.types.ts` (41–46) to the two-field shape.
- [ ] Remove the `RELEASES_HOST_DIR` / `RELEASE_LINK_SECRET` entries from `server/.env.example` (21) and `server/README.md` (121, 156).
- [ ] In `server/test/contract/registry/f01-infra.ts` delete `F01_RELEASE_ZIP` and the release rows (60–66, 110–143); in `f01.contract-spec.ts` delete the `RELEASES_DIR` `beforeAll` and import (5, 11–17); in `setup/global-setup.ts` drop the `RELEASES_DIR` entry (24, 79).
- [ ] Run `npm run typecheck` and `npm run lint` in `server/` and fix leftovers (grep `releases` under `server/src`).

### Chunk 2 — Version source + Dockerfile
- [ ] Root `package.json`: add `"version": "1.0.0"` after `"name"`, keep `"private": true`, replace the `"release"` script with `"local-release-bundle": "node scripts/local-release-bundle.js"`.
- [ ] `Dockerfile`: change the three build stages to `FROM --platform=$BUILDPLATFORM node:24.22.1-slim AS …` and remove the `.app-version` line from `server-build`, per Design Decision 9.
- [ ] `Dockerfile` runtime stage: replace `ARG RELEASE_STAMP` with `ARG VERSION=unknown`, keep `ARG GIT_COMMIT=unknown`, rewrite the `build-info.json` `RUN` to the two-field printf of Design Decision 9.
- [ ] Run hadolint 2.15.1 (`docker run --rm -i hadolint/hadolint:v2.15.1 < Dockerfile`); add `# hadolint ignore=DL3029` above each `FROM --platform` only if DL3029 is reported.
- [ ] `.gitignore`: remove lines 5–9 (the releases comment, `/releases/`, `/server/releases/`), keep `/release`; `.gitattributes`: add `release-template/install.sh text eol=lf`.

### Chunk 3 — Install kit templates
- [ ] `release-template/docker-compose.yml`: set `image: ghcr.io/dataart/artisyn-log-hub:{{VERSION}}`, delete the `RELEASE_LINK_SECRET` line (47) and the releases bind mount with its comment (59–61).
- [ ] `release-template/.env.example`: delete the `RELEASE_LINK_SECRET` block (102–104); keep `LOG_HUB_DATA_DIR=./loghub-db` and both `change-me` placeholders.
- [ ] Rewrite `release-template/INSTALL.md` as one architecture-neutral guide: one-liner install/upgrade (`install.sh`, `install.ps1`, `VERSION`, `INSTALL_DIR`, `FORCE`), manual steps mirroring Design Decision 13, `.env` table without `RELEASE_LINK_SECRET`, verification (`sha256sum -c`, `gh attestation verify`), upgrade from an old zip bundle; only `{{VERSION}}` / `{{GIT_COMMIT}}` placeholders (drop `{{DATE}}`, `{{IMAGE_FILE}}`, `{{ARCH*}}`, `{{OTHER_*}}`).
- [ ] Create `release-template/install.sh` per Design Decision 13 and constants in Design Decision 3.
- [ ] Create `release-template/install.ps1` per Design Decision 14 and constants in Design Decision 3.
- [ ] Manually check the install scripts per Test coverage plan ("Not testable in CI"): `docker run --rm -v "$PWD:/w" koalaman/shellcheck -s sh /w/release-template/install.sh`, parse `install.ps1` under `powershell.exe` 5.1 and `pwsh`; fix findings.

### Chunk 4 — Release scripts
- [ ] Create `scripts/ci/release-version.js`: pure `parseLine`, `nextVersion`, `planRun` per Design Decision 5, CLI per Design Decision 6, constants from Design Decision 3; header comment pointing at `docs/knowledgebase/algorithms/release-version.md`.
- [ ] Create `scripts/release-kit.js` per Design Decisions 11–12, moving `gitCommit`, `hostArch`, `applyPlaceholders`, `generateReleaseEnv` from `scripts/release.js` verbatim (keep their comments); header comment pointing at `algorithms/release-assets.md`.
- [ ] Rewrite the header comment of `scripts/zip-dir.js`: used by `scripts/release-kit.js` to pack the install kit (small text files, STORED entries).
- [ ] Create `scripts/ci/release-notes.js` per Design Decision 15 (pure `renderNotes`, `parseSums` exported; CLI behind `require.main === module`).
- [ ] `scripts/ci/virustotal-scan.js`: replace `SCOPES` with exported `scopeFor` per Design Decision 16; use it in `parseArgs` and `main`; update the header comment row list and the usage text.
- [ ] Run `node scripts/release-kit.js --version 0.0.1 --commit test --out tmp/kit-check`, check the files, the zip entries and `SHA256SUMS` against Design Decision 11, then delete `tmp/kit-check`.

### Chunk 5 — Script consumers + local release bundle
- [ ] `scripts/local-loghub.js`: switch imports to `./release-kit`, build and fill templates per Design Decision 17; update the header comment and the install/update messages (no "release stamp", print `version local`).
- [ ] Rename `scripts/release.js` to `scripts/local-release-bundle.js` and adapt it per Design Decision 25 (imports from `./release-kit`, `BUNDLE_*` names, `VERSION=local-<stamp>`, GHCR `local-<stamp>` tag, `LOCAL-BUNDLE.md`); update its header comment.
- [ ] Create `release-template/LOCAL-BUNDLE.md` from the current `release-template/INSTALL.md` per Design Decision 25 (before chunk 3's rewrite, take it from `git show HEAD:release-template/INSTALL.md`).
- [ ] Rename `scripts/__tests__/release.test.js` to `local-release-bundle.test.js` and adapt it per Test coverage plan; run `npm run local-release-bundle` with `BUNDLE_ARCHS=<host arch>` once and check the zip.
- [ ] `.claude/skills/big-prod-e2e-test/scripts/lib/config.mjs`: drop the `scripts/release.js` require (19–23), define `runStamp()` / `RUN_STAMP_RE` inline per Design Decision 18, use `RUN_STAMP_RE` at line 186.
- [ ] big-prod-e2e-test: in `scripts/lib/stand.mjs` (48–52) replace `--build-arg RELEASE_STAMP=…` with `VERSION=big-prod-<stamp>` and `GIT_COMMIT=<commit>`; `scripts/run.mjs` (14, 222, 225) calls `runStamp()`; the `scripts/lib/preflight.mjs:31` comment points at `scripts/local-release-bundle.js`.
- [ ] `scripts/__tests__/big-prod-e2e-test.test.js` (739–748): rename to `runStamp` / `RUN_STAMP_RE`; run `npm run test:scripts`.

### Chunk 6 — Client + in-app help
- [ ] `client/src/viewer/pages/admin/tabs/AdminSystemTab.tsx`: remove the `Release` `SecondaryTile` (316–320), the `ReleaseDownloadsSection` import (11) and render (430), and update the strip comment per Visual/UX notes.
- [ ] Delete `client/src/viewer/pages/admin/tabs/ReleaseDownloadsSection.tsx`.
- [ ] `client/src/models/admin.ts`: `build` becomes `{ version: string; gitCommit: string }` (190); delete `ReleaseArch`, `ReleaseZip`, `ReleaseDownloadLink` (205–225) and their re-exports in `client/src/models/index.ts` (22–24).
- [ ] `client/src/viewer/api.ts`: remove the release type imports (60–61) and `fetchReleaseZips` / `createReleaseDownloadLink` (1953–1979).
- [ ] Update `client/public/help/component-reference.md`, `responsibility-matrix.md` and `security-hardening.md` per Design Decision 24.
- [ ] Run `bun run typecheck` and `bun run lint` in `client/`.

### Chunk 7 — Workflows
- [ ] Create `.github/workflows/checks.yml` per Design Decisions 1–2 with the header comment style of `virustotal.yml` (purpose, triggers, required-check name).
- [ ] Create `.github/workflows/release.yml` top level (name, triggers, permissions, concurrency, `env: IMAGE`) and the `plan` and `checks` jobs per Design Decision 7.
- [ ] Add the `build` matrix job and the `manifest` job to `release.yml` per Design Decision 7, action pins per Design Decision 4.
- [ ] Add the `kit` and `vt-scan` jobs to `release.yml` per Design Decision 7, following the `build-kit` / `vt-scan` gate and `skipped`-row pattern of `virustotal.yml:62-152`.
- [ ] Add the `publish` job to `release.yml` per Design Decision 8, every expression passed via `env:`.
- [ ] Run actionlint 1.7.12 and zizmor 1.31.1 locally (or via `docker run`) over both new workflows; fix findings or add a justified inline `# zizmor: ignore[…]`.
- [ ] Confirm no workflow uses `pull_request_target` or `runs-on: self-hosted` (grep `.github/workflows/`).

### Chunk 8 — Knowledge base
- [ ] Create `docs/knowledgebase/release-pipeline.md` (OKF front matter like sibling articles): trigger, version rules and raising MAJOR.MINOR, run states (Design Decision 5) and full-run order (Design Decision 8), GHCR tags, install kit and scripts, verification commands, the local test bundle (`npm run local-release-bundle`, Design Decision 25), rollout checklist per Design Decision 23; add its line to `docs/knowledgebase/index.md`.
- [ ] `docs/knowledgebase/git-hooks.md` (66–87): list `fast-checks` (from `checks.yml`) next to `scan` as a required check of `protect-main-release`, added after its first PR run.
- [ ] `docs/knowledgebase/ci-security-scans.md`: add `checks.yml` and `release.yml` to the workflow table, add the release VirusTotal scopes `release-zip` / `install-sh` / `install-ps1`, and note that the release-verification part of `2026-10-23-ci-cd-scans` (FR-32/FR-33: checksums, attestations, VirusTotal on release assets) is implemented by `release.yml`, documented in `release-pipeline.md`.
- [ ] `docs/knowledgebase/system-info-and-cluster.md` (151–175, 337, 383): describe the `ARG VERSION` / `GIT_COMMIT` → `build-info.json` `{version, gitCommit}` flow and the new fallback; remove `RELEASE_STAMP` / `.app-version` / `releaseStamp`.
- [ ] Remove release-download content (routes, `releases/` module, Release Downloads section, `RELEASES_HOST_DIR`) from `api-reference.md`, `server-endpoint-map.md`, `static-asset-serving.md`, `client-component-map.md`.
- [ ] `docs/knowledgebase/test/contract-tests.md` (39, 55) and `test/scenarios.md` (71, 139, 165, 221): drop `RELEASES_DIR`, the release rows, `helpers/releases.ts` and S-REL-02.
- [ ] Delete `docs/knowledgebase/algorithms/release-link-token.md` and its row in `algorithms/README.md`.

### Chunk 9 — Other docs and skills
- [ ] Rewrite the install section of `README.md` (26, 30–45, 96–106, 130, 215) for the GHCR image and the `install.sh` / `install.ps1` one-liners (Design Decisions 3, 13); no `npm run release` or `docker load`; link to the latest release.
- [ ] Update `docs/qaa-overview/scenarios/01-auth-access-admin.md`, `04-ingest-hook-installer-platform.md`, `05-api-db-contract.md` and `docs/qaa-overview/14-algorithm-units.md`: remove S-REL-02, the release steps of S-PLAT-01, the release contract rows and the release-token unit.
- [ ] `.claude/skills/security-check/SKILL.md` (69): remove the release-download invariant/section.
- [ ] Update the personal `docs/kb-local/local-prod.md` (27, 48, 64): no `releases/` dir, `VERSION=local` build arg, image `ghcr.io/dataart/artisyn-log-hub:local`, `version` instead of `releaseStamp`; do not link it from tracked files.
- [ ] Update `docs/knowledgebase/algorithms/README.md` prose (not the docs table) if it mentions release tokens or `release.test.js`; grep `release` in it.

### Chunk 10 — Tests: scenarios
- [ ] Delete `tests/scenarios/platform/s-rel-02.spec.ts`, `tests/scenarios/helpers/releases.ts` and `tests/e2e/admin-releases.spec.ts`.
- [ ] `tests/scenarios/platform/s-plat-01.spec.ts`: step 2 per Test coverage plan (exact keys `version`, `gitCommit`); step 3 remove the `/api/v1/releases/download` entry; step 4 remove the release page check and "the release page is HTML" from its title.
- [ ] Remove `STAND_RELEASES_SUBDIR` / `RELEASES_DIR` from `tests/scenarios/modes.ts` (47–50, 137), `tests/scenarios/fixtures/index.ts` (35) and `tests/scenarios/README.md` (56).
- [ ] `scripts/__tests__/scenarios-stand.test.js` (88): drop the `RELEASES_DIR` expectation.
- [ ] Run `npm run typecheck:tests` and `npm run test:scenarios -- --mode a --only scenarios,contract --grep "@S-PLAT-01"`.

### Chunk 11 — Tests: algorithm docs + table tests
- [ ] Create `docs/knowledgebase/algorithms/release-version.md` with the sections and example rows listed in Test coverage plan (Algorithm, first item).
- [ ] Create `scripts/__tests__/release-version.algo.test.js` as a copy of `security-scan-summary.algo.test.js` loading `release-version` and requiring `../ci/release-version.js`.
- [ ] Create `docs/knowledgebase/algorithms/release-assets.md` with the rows listed in Test coverage plan (Algorithm, second item).
- [ ] Create `scripts/__tests__/release-assets.algo.test.js` (pattern of `security-scan-summary.algo.test.js`), mapping `input.module` to `../release-kit.js`, `../ci/release-notes.js` or `../ci/virustotal-scan.js`.
- [ ] Add rows for `release-version` and `release-assets` to the docs table of `docs/knowledgebase/algorithms/README.md` (runner `node --test` (`npm run test:scripts`)).
- [ ] Run `npm run test:scripts` and `npm test` in `hook/`; all green. Then run the grep of Design Decision 22, fix every hit, and run `npm run build` (background).
