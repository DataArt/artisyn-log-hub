# 2026-10-20: GitHub Release Pipeline (release branch, Actions, GHCR)

**Status:** todo
**Priority:** high
**Type:** feature
**Module(s):** ci | release | server | client
**Owner:** denis.tsyplakov
**Created:** 2026-10-20

## Description

Set up the release pipeline on GitHub for the repository `DataArt/artisyn-log-hub`, which is
public (verified 2026-10-25). Being public is a precondition: the organisation is on the GitHub
Free plan (no rulesets for private repositories, and its 2,000 included Actions minutes are used
up by another repository), while for a public repository rulesets, the standard hosted runners
(including native arm64 `ubuntu-24.04-arm`), Actions storage and public GHCR packages are free.

State on 2026-10-25: the `release` branch exists, and the active ruleset `protect-main-release`
on `main` and `release` already blocks deletion and force-push, requires a pull request
(0 approvals, review threads resolved) and the status check `scan` (gitleaks); its only bypass
actor is the Admin repository role, in pull-request mode.

Organisation settings (checked by the owner): all actions and reusable workflows are allowed;
repository-level self-hosted runners are allowed (not to be used here, see FR-9).

How a release is built today: `node scripts/release.js` with `RELEASE_STAMP` (UTC
`YYYYMMDD-HHMMSS`) and `RELEASE_ARCHS` (`amd64,arm64`). For each architecture it runs
`docker buildx build --platform linux/<arch> --output type=docker,dest=<tar>` and packs a zip
with the image tar, `release-template/docker-compose.yml`, a generated `.env` with random
secrets, `.env.example` and `INSTALL.md`. The zips are also served from the app itself (Admin →
System → Release Downloads, signed download links).

### Owner decisions

- **Versioning:** semver tags `vMAJOR.MINOR.PATCH`, assigned automatically — no manual tagging
  in the normal flow.
- **What is released:** a push to `release` builds the Docker image for `linux/amd64` and
  `linux/arm64` and publishes it to GHCR; the GitHub Release carries a zip install kit
  (`docker-compose.yml`, README with install instructions, light automatic install scripts). The
  image is always pulled from GHCR — no zips with image tars.
- **Checks before the build:** only what runs in about 20 s; no e2e, no scenarios, cold lint left
  out (exact command set in FR-5). The typechecks matter most: neither build typechecks (see
  `CLAUDE.md`).
- **In-app release downloads are removed** together with everything that exists only for them.
- **Proof of a clean release:** only what is standard and cheap here (FR-14) — checksums,
  GitHub build-provenance attestations, an immutable release and a VirusTotal "Security scan"
  section in the release notes. This is the release part (FR-32/FR-33) that
  `2026-10-23-ci-cd-scans` deferred to this task.

## Functional Requirements

### Branch and trigger

- **FR-1 (release branch):** a `release` branch exists (done); a push to it is what cuts a
  release.
- **FR-2 (branch protection):** `release` and `main` are protected: no force-push, no deletion,
  changes only through a pull request with the FR-5 check required, push restricted to
  maintainers. The only maintainer is the owner (GitHub user `denistsyplakov`, Admin role); the
  same account approves outside-contributor runs (FR-9). The existing `protect-main-release`
  ruleset covers all of this except the FR-5 check: its status-check name is added to the
  ruleset's required checks next to `scan`, once the check has run at least once.
- **FR-3 (workflow trigger):** the release workflow in `.github/workflows/` runs on `push` to
  `release` and on `workflow_dispatch`. No workflow of this repository runs on
  `pull_request_target`; the FR-5 check may run on `pull_request` (hosted runners only). A
  `workflow_dispatch` run fails at once unless `github.ref` is `refs/heads/release`.

  The release workflow and the FR-5 check follow the conventions of
  `.github/workflows/security-scans.yml` and pass its actionlint and zizmor jobs: actions pinned
  by commit SHA with a version comment, `permissions: contents: read` at the top and write
  permissions per job only, `persist-credentials: false` on checkout except in the job that pushes
  the tag, `inputs.bump` passed through `env:` and validated against `patch|minor|major`, no
  dependency cache in publishing jobs, the same `BUN_VERSION` / Node versions.

### Version

- **FR-4 (automatic semver):** every release run computes the next version from the latest
  `v*` tag (none → `v0.1.0`): PATCH +1 by default; MINOR or MAJOR when the `workflow_dispatch`
  input `bump` says so, or when a commit since the last tag carries `[minor]` / `[major]` in its
  message. When these signals disagree, the `bump` input (if given) overrides commit-message
  tags; otherwise the highest of the `[minor]`/`[major]` tags found across commits since the last
  tag applies; default is PATCH. The workflow creates the tag itself; it never commits a version
  bump back to the protected branch, uses a concurrency group
  (`concurrency: { group: release, cancel-in-progress: false }`) to serialize release runs, and
  fails the run instead of overwriting if the computed tag already points at a different commit.
  If HEAD of `release` already carries a `v*` tag from an earlier, completed release, the run
  fails with "nothing to release".

  Order of a run: per-arch images pushed by digest → manifest list → git tag → draft GitHub
  Release with assets (FR-10, FR-14) → image tags `:<version>`, `:<major>.<minor>`, `:latest` →
  release published. Anything failing before the git tag leaves no tag, and a re-run recomputes
  the same version; a re-run on a commit whose tag already points at HEAD and whose release is
  still a draft resumes from the draft instead of failing.

  The version reaches the image as a new `ARG VERSION` (`--build-arg VERSION=<tag without v>`,
  `--build-arg GIT_COMMIT=${{ github.sha }}`), replacing the Dockerfile's current
  `RUN node -p "require('./server/package.json').version" > .app-version` mechanism
  (`server/package.json`'s own version field is left unused by the image) and replacing
  `RELEASE_STAMP` and the `BuildInfo.releaseStamp` field (removed, not kept as a secondary field).
  The Dockerfile keeps its `build-info.json` generation step (the only source of
  `readBuildInfo()` for `GET /health/version` and Admin → System), now writing
  `{"version":"$VERSION","gitCommit":"$GIT_COMMIT"}` from `ARG VERSION` / `ARG GIT_COMMIT` declared
  in the runtime stage.

### Checks and build

- **FR-5 (fast checks):** before the build, one job runs the three typechecks and the three
  algorithm-test suites (client, server, hook) plus the build-script tests, the same commands as
  the `static` group in `.claude/repo_config/repo-health-checks.json` minus lint. A failure stops
  the release. The same job is offered as a pull-request check for FR-2.
- **FR-6 (per-arch build):** `linux/amd64` builds on `ubuntu-latest` and `linux/arm64` on
  `ubuntu-24.04-arm`, both natively, then a manifest list joins them.
- **FR-7 (Dockerfile build platform):** the build stages of `Dockerfile` use
  `FROM --platform=$BUILDPLATFORM`, so the client, the hooks installer and the server bundle are
  built natively and only the runtime stage is per architecture.

### Publication

- **FR-8 (GHCR image):** the workflow publishes the multi-arch image
  `ghcr.io/dataart/artisyn-log-hub:<version>` plus `:<major>.<minor>` and `:latest`, with
  `GITHUB_TOKEN` (`permissions: packages: write`); `:latest` moves on every release. The GHCR
  package is public and linked to the repository; the owner switches it to public once after the
  first push (a `GITHUB_TOKEN` cannot change package visibility).
- **FR-9 (runner security):** only GitHub-hosted runners; no self-hosted runner for this public
  repository. Workflow runs from first-time / outside contributors need maintainer approval
  (repository Actions setting).
- **FR-10 (GitHub Release with install kit):** the workflow creates a GitHub Release for the tag
  with a zip install kit `artisyn-log-hub-<version>.zip` holding `README.md` (the install
  instructions, from `release-template/INSTALL.md`), `docker-compose.yml` pinned to
  `ghcr.io/dataart/artisyn-log-hub:<version>`, `.env.example`, `install.sh` (Linux/macOS) and
  `install.ps1` (Windows). The same files are also attached loose, because the FR-11 one-liner
  downloads them individually.

  The kit is assembled by a small script `scripts/release-kit.js` (replacing the kit part of
  `scripts/release.js`), which fills only `{{VERSION}}` and `{{GIT_COMMIT}}` in README.md and
  `docker-compose.yml`. `release-template/` is rewritten for the pull-based kit:
  `docker-compose.yml` uses `image: ghcr.io/dataart/artisyn-log-hub:{{VERSION}}` (still passing
  the `docker compose config` check of the `dockerfile-lint` job in `security-scans.yml`) and loses
  the `RELEASE_LINK_SECRET` line and the `releases` bind mount; INSTALL.md becomes one
  architecture-neutral guide without the tar / `docker load` / "release stamp" text and documents
  `install.sh` / `install.ps1`; `.env.example` and the INSTALL.md table lose `RELEASE_LINK_SECRET`.
  Release notes list the commits since the previous tag (for the first release, with no previous
  tag, all commits up to the tagged commit).
- **FR-11 (light automatic install):** one command installs or upgrades a server, e.g.
  `curl -fsSL https://github.com/DataArt/artisyn-log-hub/releases/latest/download/install.sh | sh`
  (and a PowerShell equivalent). The script checks that Docker and Compose are present, creates
  the install directory, downloads `docker-compose.yml` and `.env.example` (re-downloading and
  overwriting them on an upgrade too, so the compose file's image tag matches the requested
  version), generates `.env` with fresh random secrets on first install only (the secret
  generation that `scripts/release.js` does today), keeps an existing `.env` unchanged on upgrade,
  runs `docker compose pull && docker compose up -d`, and prints the install directory and the
  URL (`PUBLIC_BASE_URL` from `.env` when set, otherwise `http://localhost:5003`, the compose port
  binding). It accepts a version (`latest` by default) via a `VERSION` environment variable (e.g.
  `curl -fsSL .../install.sh | VERSION=v0.2.0 sh`; PowerShell:
  `$env:VERSION = 'v0.2.0'; irm .../install.ps1 | iex`), consistent across both scripts; with
  `VERSION` set, the files come from `releases/download/<VERSION>/`, not `latest/`. The install
  directory is `$INSTALL_DIR` if set, otherwise `$HOME/artisyn-log-hub` (Windows:
  `$env:USERPROFILE\artisyn-log-hub`); an upgrade is a re-run against the same directory.
  `LOG_HUB_DATA_DIR` stays the relative `./loghub-db` from `.env.example`, so the data lives under
  the install directory. A `VERSION` older than the one in the existing `docker-compose.yml` is
  refused ("downgrade not supported — DB migrations are forward-only") unless `FORCE=1` is set.
  On Docker/Compose missing, an unresolved version/tag, or a
  failed `docker compose pull`, the script exits non-zero with a clear message and does not
  delete or modify an existing `.env`; a missing `.env` during an "upgrade" run is treated as a
  fresh install rather than an error. `INSTALL.md` documents the same steps by hand.

- **FR-14 (release verification; implements `2026-10-23-ci-cd-scans` FR-32/FR-33):**
  - the GitHub Release also carries `SHA256SUMS` covering every attached file;
  - the image is built with buildx provenance and SBOM attestations (`provenance: mode=max`,
    `sbom: true`), and the workflow adds GitHub artifact attestations
    (`actions/attest-build-provenance`, `permissions: id-token: write, attestations: write`) for
    the image index digest and for every attached file, verifiable with `gh attestation verify`;
  - the release is created as a draft, the attached files (zip, `install.sh`, `install.ps1`) are
    scanned with `scripts/ci/virustotal-scan.js` (non-blocking, as ci-cd-scans FR-31: a detection
    or an API error is reported, never fails the run), then the release is published; immutable
    releases are enabled in the repository settings, so assets and the tag cannot change after
    publishing;
  - the release notes get a "Security scan" section: the image digest, per file its SHA-256 and
    VirusTotal result (`0/<engines>` + permalink), and the verification commands
    (`sha256sum -c SHA256SUMS`, `gh attestation verify`).

  The rest of ci-cd-scans FR-33 is dropped as over-engineering: no `security-scan-results.json` /
  `.md`, SARIF files or separate SBOM file attached, no Snyk Container totals in the release notes
  (that data stays in CI and the repository's Security tab; the SBOM travels as an image
  attestation).

### Removal of in-app release downloads

- **FR-12 (remove the feature):** remove release downloads from the app and everything that
  exists only for them. Inventory (2026-10-20, grep for `RELEASES_HOST_DIR`,
  `RELEASE_LINK_SECRET`, `release-token`, `ReleaseDownloads`, `/api/v1/releases/download`,
  `RELEASE_STAMP`):
  - `Dockerfile`: the `ARG RELEASE_STAMP` lines, the `releaseStamp` field of `build-info.json`
    and the `.app-version` line (the generation step itself stays, see FR-4);
  - other `releaseStamp` consumers: the Build-info row in `AdminSystemTab.tsx`,
    `build.releaseStamp` in `client/src/models/admin.ts`, step 2 of
    `tests/scenarios/platform/s-plat-01.spec.ts` (now asserts `{version, gitCommit}`) and the
    `GET /health/version` row in `server/test/contract/registry/f01-infra.ts`;
  - server: `server/src/releases/` (module, service, types, `release-download.controller.ts`,
    `release-token.ts` and its algorithm spec), the release-link endpoint in
    `admin/admin-panel.controller.ts` and `admin/dto/release-download-link.dto.ts`, the release
    parts of `common/static-dir.ts`, `common/build-info.ts` and `system-info/`;
    `RELEASES_HOST_DIR` and `RELEASE_LINK_SECRET` in `server/.env.example`, `server/README.md`
    and `known-secrets.ts` if listed;
  - client: `ReleaseDownloadsSection.tsx`, its use in `AdminSystemTab.tsx`, the API call in
    `viewer/api.ts`, the types in `models/admin.ts`, the section in
    `public/help/security-hardening.md`;
  - build and release: `scripts/release.js`, `scripts/zip-dir.js` if nothing else uses it,
    `scripts/__tests__/release.test.js`, the `release` npm script, `/release`, `/releases/` and
    `/server/releases/` in `.gitignore`, the releases bind mount in
    `release-template/docker-compose.yml`; `release-template/` becomes the FR-10 install kit;
  - tests: `tests/scenarios/platform/s-rel-02.spec.ts`, `tests/scenarios/helpers/releases.ts`,
    the release steps in `s-plat-01.spec.ts`, legacy `tests/e2e/admin-releases.spec.ts`, the
    release routes in `server/test/contract/registry/f01-infra.ts`;
  - docs: `docs/knowledgebase/algorithms/release-link-token.md` (and its row in
    `algorithms/README.md`), the release parts of `api-reference.md`, `server-endpoint-map.md`,
    `static-asset-serving.md`, `system-info-and-cluster.md`, `client-component-map.md`, and the
    `docs/qaa-overview` scenario docs 01, 04, 05 and `14-algorithm-units.md`;
  - tooling: `RELEASE_STAMP` in `.claude/skills/big-prod-e2e-test/` (and its
    `scripts/__tests__/big-prod-e2e-test.test.js` rows), the release section of
    `.claude/skills/security-check/SKILL.md`, and `.claude/skills/post-impl-check-release/` if it
    only checks the zip bundle.
- **FR-13 (backward compatibility):** the hook API and the installer endpoints are not touched.
  Removing `/api/v1/releases/download` breaks only old in-app links, which expire in 24 h anyway.

### Local build

- **FR-15 (local install stays):** `scripts/local-loghub.js` and its npm scripts
  `local-loghub:install` / `local-loghub:update` are kept. The owner uses them to run a server
  built from the current working tree, including code not yet committed to git, so they keep
  building the image locally and never pull from GHCR. After FR-12 they no longer import
  `scripts/release.js`: the helpers they need (git commit, host arch, `.env` secret generation)
  come from `scripts/release-kit.js`; the image is built with `--build-arg VERSION=local` (instead
  of `RELEASE_STAMP`) and `GIT_COMMIT`, tagged `ghcr.io/dataart/artisyn-log-hub:local`, and the
  install's `docker-compose.yml` is the FR-10 template with `{{VERSION}}` filled as `local`.

## Acceptance Criteria

- [ ] A force-push or a direct push by a non-maintainer to `release` is rejected, and a pull
      request into `release` cannot merge while the FR-5 check is failing (FR-1, FR-2).
- [ ] A push to `release` starts the release workflow; a pull request runs only the FR-5 check
      (FR-3, FR-5).
- [ ] Two pushes in a row produce `v0.1.0` then `v0.1.1`; a `workflow_dispatch` with
      `bump=minor` produces `v0.2.0`; no commit is pushed back to `release` (FR-4).
- [ ] `GET /health/version` of the released image reports the release version (FR-4).
- [ ] A type error or a failing algorithm test on `release` stops the run before any image is
      pushed (FR-5).
- [ ] `docker pull ghcr.io/dataart/artisyn-log-hub:<version>` works anonymously on an amd64 and
      an arm64 host and resolves to the right architecture (FR-6, FR-7, FR-8).
- [ ] The GitHub Release holds `artisyn-log-hub-<version>.zip` (README.md, `docker-compose.yml`,
      `.env.example`, `install.sh`, `install.ps1`), the same files loose, and no image tar (FR-10).
- [ ] `sha256sum -c SHA256SUMS` passes for the downloaded assets, and `gh attestation verify`
      succeeds for the zip and for `oci://ghcr.io/dataart/artisyn-log-hub:<version>` (FR-14).
- [ ] The release notes list the commits since the previous tag and hold the "Security scan"
      section: image digest, per-file SHA-256 and VirusTotal `0/<engines>` + permalink, the
      verification commands; the published release is immutable (FR-10, FR-14).
- [ ] `:<major>.<minor>` and `:latest` resolve to the same digest as `:<version>`; the GHCR
      package is public and linked to the repository (FR-8).
- [ ] A commit with `[minor]` in its message yields a MINOR bump; a run whose computed tag
      already points at another commit fails without pushing an image; a dispatch from a branch
      other than `release` fails at once (FR-3, FR-4).
- [ ] On a clean Linux host with Docker, the one-line `install.sh` starts the app and prints its
      URL; running it again with a newer version upgrades the app and keeps `.env` (FR-11).
- [ ] On Windows with Docker Desktop, `install.ps1` installs and upgrades the same way, and
      `VERSION=<tag>` installs that version; with Docker stopped, `install.sh` exits non-zero and
      leaves an existing `.env` byte-identical (FR-11).
- [ ] No workflow uses a self-hosted runner; outside-contributor runs wait for approval (FR-9).
- [ ] Nothing from the FR-12 inventory is left:
      `git grep -nE 'RELEASES_HOST_DIR|RELEASE_LINK_SECRET|release-token|ReleaseDownloads|/api/v1/releases/download|RELEASE_STAMP|releaseStamp' -- ':!docs/tasks/' ':!docs/changelog/'`
      returns nothing, and Admin → System shows no Release Downloads section (FR-12).
- [ ] Tests follow the repo test policy: the removed scenario, contract rows and algorithm doc go
      away with the feature; the version computation (FR-4), if written as a script, gets an
      algorithm doc with examples and its table test, or rows in the build-script tests;
      `scripts/release-kit.js` gets rows in the build-script tests (`npm run test:scripts`).
- [ ] With uncommitted changes in the working tree, `npm run local-loghub:update` rebuilds the
      image from them and restarts `../local-loghub`; its `GET /health/version` reports `local`
      and the existing `.env` is unchanged (FR-15).

## Open Questions

_None._

## Common sense considerations

- FR-4 bump signal: keep the owner's `[minor]` / `[major]` commit tags; no Conventional Commits /
  release-please.
- FR-4 bump precedence: the `workflow_dispatch` `bump` input, else the highest commit tag since
  the last tag, else PATCH.
- FR-4: runs are serialized by a concurrency group; a computed tag on another commit fails the
  run; an already-released HEAD fails with "nothing to release".
- FR-4: the git tag is created only after the images are pushed by digest; a re-run on a tagged
  HEAD with a draft release resumes from the draft.
- FR-4: `build-info.json` stays, now `{version, gitCommit}`; only `RELEASE_STAMP` /
  `releaseStamp` / `.app-version` go.
- FR-3: `workflow_dispatch` only on `release`; workflows follow `security-scans.yml` conventions
  and pass actionlint / zizmor.
- FR-6/FR-7: platform-independent stages are built once per arch job; the duplication is
  accepted (hosted minutes are free for a public repository).
- FR-8: `:latest` moves on every release, `0.x` included.
- FR-8: GHCR package visibility is set to public once by the owner after the first push (a
  `GITHUB_TOKEN` cannot change it); recorded in the KB rollout steps.
- FR-10: the kit is built by `scripts/release-kit.js`, filling only `{{VERSION}}` /
  `{{GIT_COMMIT}}`; `release-template/` is rewritten for pulling from GHCR.
- FR-11: the version is passed to `sh`, not `curl` (`curl … | VERSION=v0.2.0 sh`); pinned
  versions download from `releases/download/<VERSION>/`.
- FR-11: install dir `$INSTALL_DIR`, else `$HOME/artisyn-log-hub` (`$env:USERPROFILE\artisyn-log-hub`);
  data under it via `./loghub-db`.
- FR-11: the printed URL is `PUBLIC_BASE_URL`, else `http://localhost:5003`.
- FR-11: downgrades are refused unless `FORCE=1` (migrations are forward-only).
- FR-11: `docker-compose.yml` and `.env.example` are re-downloaded on every run; `.env` is
  generated only on first install and never touched otherwise, failures included.
- FR-11: a missing `.env` on upgrade means a fresh install; missing Docker/Compose, an unresolved
  version or a failed pull exit non-zero with a clear message.
- FR-14: VirusTotal on the release is non-blocking and reuses `scripts/ci/virustotal-scan.js`
  (ci-cd-scans FR-31).
- FR-12 acceptance uses a concrete `git grep` with `/api/v1/releases/download`, so CI tool
  download URLs and release asset URLs do not match.
- The first release's notes list all commits up to the tagged commit.

## Notes

- Local timing measurements behind the "about 20 s" FR-5 check budget: see `notes.md`.
